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
    this._lastExit = new Map() // domain -> last logged exit (dedupe decision logs)
    this._ipOwner = new Map() // ip -> { exit, domain } (detect shared-CDN conflicts)
    this._conflictWarnedAt = new Map() // "ip|exitA|exitB" -> ts (rate-limit warnings)
  }

  /**
   * Warn when two domains with DIFFERENT exits resolve to the SAME IP. At the IP
   * layer a /32 can only point to one tunnel, so such rules can't both hold —
   * the route thrashes and one domain silently egresses the wrong VPN. This is
   * common with CDNs (Cloudflare/Akamai) that share IPs across many hostnames.
   */
  _checkConflict(ip, exit, domain) {
    const prev = this._ipOwner.get(ip)
    if (prev && prev.exit !== exit && prev.domain !== domain) {
      const key = `${ip}|${[prev.exit, exit].sort().join('|')}`
      const now = Date.now()
      const last = this._conflictWarnedAt.get(key) || 0
      if (now - last > 60000) {
        this._conflictWarnedAt.set(key, now)
        logger.warn(
          'dns',
          `route conflict on ${ip}: "${prev.domain}" wants ${this._exitLabel(prev.exit)} but ` +
            `"${domain}" wants ${this._exitLabel(exit)} — same IP can't split across VPNs ` +
            `(shared CDN IP); route will flap. Put these domains on the same VPN.`
        )
      }
    }
    this._ipOwner.set(ip, { exit, domain })
  }

  /** Human-readable label for a routing exit ("DIRECT" or "VPN <name>"). */
  _exitLabel(exit) {
    return exit === 'direct' ? 'DIRECT' : `VPN ${this._vpnName(exit)}`
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

  /**
   * Start the resolver. Resolves true once it is actually listening, false if
   * binding fails (e.g. port 53 busy). The caller must NOT hijack system DNS
   * unless this resolves true — otherwise the system would point at a dead
   * resolver and lose all name resolution.
   */
  start() {
    if (this.running) return Promise.resolve(true)
    if (this._starting) return this._starting

    this._starting = new Promise((resolve) => {
      const server = dgram.createSocket('udp4')
      this.server = server
      let settled = false
      const settle = (ok) => {
        if (settled) return
        settled = true
        this._starting = null
        resolve(ok)
      }

      server.on('error', (err) => {
        logger.error('dns', `server error: ${err.message}`)
        if (err.code === 'EADDRINUSE') {
          logger.error('dns', `port ${LISTEN_PORT} is in use — stop any other local DNS/resolver (e.g. Acrylic/dnscrypt) and reconnect`)
        }
        this.running = false
        try {
          server.close()
        } catch {
          /* ignore */
        }
        this.server = null
        settle(false)
      })

      server.on('message', (msg, rinfo) => {
        this._handleQuery(msg, rinfo).catch((e) => logger.warn('dns', `query error: ${e.message}`))
      })

      server.bind(LISTEN_PORT, LISTEN_ADDR, () => {
        this.running = true
        logger.info('dns', `local DNS resolver listening on ${LISTEN_ADDR}:${LISTEN_PORT}`)
        settle(true)
      })
    })
    return this._starting
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
    this._starting = null
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
      // macOS binds tunnel routes by interface to avoid the shared-gateway
      // (10.8.0.1) collision between VPNs; make sure we actually have one even if
      // the connect-time interface resolution hasn't landed yet.
      if (!ifIndex && st.localIp) {
        ifIndex = await routeManager.interfaceIndexForIp(st.localIp)
      }
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

    // Log the routing decision for every domain (incl. direct), deduped so it
    // only prints when a domain's exit actually changes — short TTLs make
    // clients re-query constantly, which would otherwise flood the log.
    if (q.qtype === QTYPE.A || q.qtype === QTYPE.AAAA || q.qtype === HTTPS_QTYPE) {
      if (this._lastExit.get(q.name) !== exit) {
        if (this._lastExit.size > 2000) this._lastExit.clear()
        this._lastExit.set(q.name, exit)
        logger.info('dns', `decision: ${q.name} -> ${this._exitLabel(exit)}`)
      }
    }

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
        if (proxied) for (const ip of ips) this._checkConflict(ip, exit, q.name)
        const { installed, touched } = await this._installRoutes(ips, exit)
        if (installed > 0) {
          this.stats.routed++
          this.stats.lastDomain = q.name
          logger.info('dns', `routed: ${q.name} -> ${this._exitLabel(exit)} (${ips.join(', ')})`)
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
