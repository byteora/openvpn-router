import { getStore } from './store.js'
import { vpnManager } from './vpnManager.js'
import { routeManager } from './routeManager.js'
import { dnsResolver } from './dns.js'
import { dnsRouter } from './dnsRouter.js'
import { systemDns } from './systemDns.js'
import { computeDesiredRoutes } from './ruleEngine.js'
import { logger } from './logger.js'

/**
 * Central coordinator.
 *
 * Two layers of routing:
 *  1. Static routes (this reconcile loop): IP/CIDR rules, the proxy-all split
 *     default, and VPN-server pins. Diffed against the table via routeManager.
 *  2. Dynamic routes (the local DNS server): domain rules — including wildcard /
 *     suffix / keyword / regex — matched at query time, with precise host
 *     routes installed for the exact resolved IPs before the answer is returned.
 *
 * When any VPN is connected the system DNS is pointed at our local resolver so
 * domain rules take effect; it is restored when everything disconnects.
 */
class RoutingOrchestrator {
  constructor() {
    this.pending = false
    this.timer = null
    this.lastTopo = null
  }

  init() {
    const store = getStore()
    dnsResolver.setServer(store.getState().settings.dnsServer)

    vpnManager.on('connected', () => this.schedule())
    vpnManager.on('disconnected', () => {
      this.lastTopo = null
      this.schedule()
    })
    // Only react to routing-relevant changes (gateway / ifIndex / serverIp /
    // state) — NOT byte-count ticks (every 2s) which would spin reconcile.
    vpnManager.on('status', () => {
      const sig = this._topologySignature()
      if (sig !== this.lastTopo) {
        this.lastTopo = sig
        this.schedule()
      }
    })
  }

  _topologySignature() {
    const statuses = vpnManager.getAllStatuses()
    return Object.keys(statuses)
      .sort()
      .map((id) => {
        const s = statuses[id]
        return `${id}:${s.state}:${s.gateway || ''}:${s.ifIndex || ''}:${s.serverIp || ''}`
      })
      .join('|')
  }

  /** Debounced reconcile so bursts of events collapse into one pass. */
  schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.reconcile().catch((e) => logger.error('router', e.message)), 400)
  }

  /**
   * Called when rules/settings change: domain decisions may now differ, so drop
   * cached dynamic routes and flush the OS DNS cache. New queries re-create the
   * correct routes immediately.
   */
  async onRulesChanged() {
    // Snapshot the IPs we're about to stop routing so we can reset their
    // keep-alive connections — otherwise an app keeps using the old path until
    // the connection naturally closes (e.g. removing a rule would still show
    // the VPN IP). New queries re-create the correct routes immediately.
    const affected = routeManager.dynamicDests()
    const removed = await routeManager.clearDynamic()
    await systemDns.flush()
    if (removed) logger.info('router', `rules changed: cleared ${removed} dynamic route(s)`)
    if (affected.length) dnsRouter._queueReset(affected)
    this.schedule()
  }

  async reconcile() {
    if (this.pending) {
      this.schedule()
      return
    }
    this.pending = true
    try {
      const store = getStore()
      const state = store.getState()
      dnsResolver.setServer(state.settings.dnsServer)

      const statuses = vpnManager.getAllStatuses()
      const physical = await routeManager.refreshPhysicalGateway()

      const anyConnected = Object.values(statuses).some((s) => s.state === 'connected')

      if (!anyConnected) {
        // tear everything down
        dnsRouter.stop()
        await systemDns.restore()
        const removed = await routeManager.clearAll()
        if (removed > 0) logger.info('router', `no VPN connected; cleared ${removed} managed route(s)`)
        return
      }

      // static routes (IP/CIDR rules + proxy-all split + server pins)
      const desired = await computeDesiredRoutes(state, statuses, physical)
      const { added, removed } = await routeManager.apply(desired)
      if (added || removed) {
        logger.info('router', `static routes updated (+${added}/-${removed}), ${desired.length} active`)
      }

      // bring up DNS-driven domain routing
      dnsRouter.start()
      await systemDns.apply()
    } finally {
      this.pending = false
    }
  }

  async shutdown() {
    dnsRouter.stop()
    try {
      await systemDns.restore()
    } catch {
      /* ignore */
    }
    vpnManager.disconnectAll()
    await routeManager.clearAll()
  }
}

export const orchestrator = new RoutingOrchestrator()
