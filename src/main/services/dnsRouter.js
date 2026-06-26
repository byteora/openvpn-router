import dgram from 'dgram'
import { getStore } from './store.js'
import { vpnManager } from './vpnManager.js'
import { routeManager } from './routeManager.js'
import { platform } from '../platform/index.js'
import { decideExit } from './domainMatch.js'
import { parseQuestion, extractARecords, buildEmptyResponse, rewriteAnswerTtl, QTYPE } from './dnsMessage.js'
import { logger } from './logger.js'

const LISTEN_PORT = 53
const LISTEN_ADDR = '127.0.0.1'
const UPSTREAM_PORT = 53
const ROUTE_TTL_MS = 10 * 60 * 1000
const ROUTE_METRIC = 3
const HTTPS_QTYPE = 65 // SVCB/HTTPS records can carry IP hints that bypass routing
// TTL we hand to clients. Short, so the OS/browser re-queries us frequently and
// rule changes take effect quickly (instead of being pinned by a cached answer).
const CLIENT_TTL = 5

/**
 * Local DNS server implementing DNS-driven policy routing.
 *
 * For every query it: decides the routing exit for the domain (per-VPN rules >
 * global rules > default policy), forwards the query upstream, and — before
 * returning the answer — installs precise host routes for the resolved IPs via
 * the chosen exit. This means the very first connection an app makes already
 * takes the correct path (no mid-connection switch, accurate for CDNs).
 */
class DnsRouter {
  constructor() {
    this.server = null
    this.running = false
    this.stats = { queries: 0, routed: 0, lastDomain: '' }
    this._resetPending = new Set()
    this._resetTimer = null
  }

  /**
   * Batch + debounce TCP-connection resets. When a route for an IP is newly
   * installed or its exit changes, existing keep-alive connections (e.g. a
   * browser's) are still pinned to the old path; resetting them makes apps
   * reconnect over the new route. Done off the DNS reply path so it never adds
   * latency.
   */
  _queueReset(ips) {
    if (!ips || !ips.length) return
    for (const ip of ips) this._resetPending.add(ip)
    if (this._resetTimer) return
    this._resetTimer = setTimeout(async () => {
      this._resetTimer = null
      const list = Array.from(this._resetPending)
      this._resetPending.clear()
      try {
        const n = await platform.resetConnections(list)
        if (n > 0) logger.info('dns', `reset ${n} existing connection(s) to apply new route`)
      } catch (e) {
        logger.warn('dns', `connection reset failed: ${e.message}`)
      }
    }, 400)
  }

  getStatus() {
    return { running: this.running, ...this.stats }
  }

  start() {
    if (this.running) return
    const server = dgram.createSocket('udp4')
    this.server = server

    server.on('error', (err) => {
      logger.error('dns', `server error: ${err.message}`)
      if (err.code === 'EADDRINUSE') {
        logger.error('dns', `port ${LISTEN_PORT} is in use — stop any other local DNS/resolver and reconnect`)
      }
      this.running = false
    })

    server.on('message', (msg, rinfo) => {
      this._handleQuery(msg, rinfo).catch((e) => logger.warn('dns', `query error: ${e.message}`))
    })

    server.bind(LISTEN_PORT, LISTEN_ADDR, () => {
      this.running = true
      logger.info('dns', `local DNS resolver listening on ${LISTEN_ADDR}:${LISTEN_PORT}`)
    })
  }

  stop() {
    if (this.server) {
      try {
        this.server.close()
      } catch {
        /* ignore */
      }
      this.server = null
    }
    this.running = false
  }

  _upstream() {
    return getStore().getState().settings.dnsServer || '1.1.1.1'
  }

  _forward(query) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4')
      const timer = setTimeout(() => {
        try {
          client.close()
        } catch {
          /* ignore */
        }
        reject(new Error('upstream timeout'))
      }, 4000)

      client.on('message', (resp) => {
        clearTimeout(timer)
        try {
          client.close()
        } catch {
          /* ignore */
        }
        resolve(resp)
      })
      client.on('error', (err) => {
        clearTimeout(timer)
        try {
          client.close()
        } catch {
          /* ignore */
        }
        reject(err)
      })
      client.send(query, UPSTREAM_PORT, this._upstream())
    })
  }

  _effectiveExit(domain) {
    const state = getStore().getState()
    const isConnected = (id) => vpnManager.isConnected(id)

    const decision = decideExit(domain, state, isConnected)
    if (decision) return decision.exit

    const { defaultPolicy, defaultProxyVpnId } = state.settings
    if (defaultPolicy === 'proxy' && defaultProxyVpnId && isConnected(defaultProxyVpnId)) {
      return defaultProxyVpnId
    }
    return 'direct'
  }

  _defaultProxyActive() {
    const { settings } = getStore().getState()
    return (
      settings.defaultPolicy === 'proxy' &&
      settings.defaultProxyVpnId &&
      vpnManager.isConnected(settings.defaultProxyVpnId)
    )
  }

  async _installRoutes(ips, exit) {
    const touched = [] // IPs whose route was newly added or changed exit
    let installed = 0

    let gateway = null
    let ifIndex = null
    if (exit === 'direct') {
      // Only needed to carve a hole out of a proxy-all default.
      if (!this._defaultProxyActive()) return { installed: 0, touched }
      const phys = await routeManager.refreshPhysicalGateway()
      if (!phys || !phys.gateway) return { installed: 0, touched }
      gateway = phys.gateway
      ifIndex = phys.ifIndex
    } else {
      const st = vpnManager.getStatus(exit)
      if (!st || st.state !== 'connected' || !st.gateway) return { installed: 0, touched }
      gateway = st.gateway
      ifIndex = st.ifIndex
    }

    for (const ip of ips) {
      const r = await routeManager.addDynamic(ip, gateway, ifIndex, ROUTE_METRIC, ROUTE_TTL_MS)
      if (r === 'added' || r === 'changed') {
        installed++
        touched.push(ip)
      }
    }
    return { installed, touched }
  }

  async _handleQuery(msg, rinfo) {
    const q = parseQuestion(msg)
    this.stats.queries++

    const reply = (buf) => this.server && this.server.send(buf, rinfo.port, rinfo.address)

    if (!q || !q.name) {
      // can't inspect — just proxy it through
      try {
        reply(await this._forward(msg))
      } catch {
        /* ignore */
      }
      return
    }

    const exit = this._effectiveExit(q.name)
    const proxied = exit !== 'direct'

    // Suppress AAAA / HTTPS for proxied domains so the client uses our IPv4
    // routing path instead of leaking over IPv6 or SVCB ip hints.
    if (proxied && (q.qtype === QTYPE.AAAA || q.qtype === HTTPS_QTYPE)) {
      reply(buildEmptyResponse(msg))
      return
    }

    let response
    try {
      response = await this._forward(msg)
    } catch (err) {
      logger.warn('dns', `upstream failed for ${q.name}: ${err.message}`)
      return
    }

    if (q.qtype === QTYPE.A) {
      const ips = extractARecords(response)
      if (ips.length) {
        const { installed, touched } = await this._installRoutes(ips, exit)
        if (installed > 0) {
          this.stats.routed++
          this.stats.lastDomain = q.name
          logger.info('dns', `${q.name} -> ${exit === 'direct' ? 'DIRECT' : 'VPN ' + this._vpnName(exit)} (${ips.join(', ')})`)
        }
        // Force apps to drop stale keep-alive connections onto the new path.
        this._queueReset(touched)
      }
    }

    // Hand clients a short TTL so they keep asking us; this is what makes
    // rule changes apply quickly without stale cached answers.
    rewriteAnswerTtl(response, CLIENT_TTL)
    reply(response)
  }

  _vpnName(id) {
    const v = getStore().getVpn(id)
    return v ? v.name : id
  }
}

export const dnsRouter = new DnsRouter()
