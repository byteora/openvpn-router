import { getStore } from './store.js'
import { vpnManager } from './vpnManager.js'
import { routeManager } from './routeManager.js'
import { dnsResolver } from './dns.js'
import { dnsRouter } from './dnsRouter.js'
import { systemDns } from './systemDns.js'
import { singboxManager } from './singboxManager.js'
import { SINGBOX_DNS_ADDRESS, isTunnelUsable } from './singboxConfig.js'
import { computeDesiredRoutes } from './ruleEngine.js'
import { platform } from '../platform/index.js'
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
    // utun interfaces we've installed an interface-scoped default route for
    // (sing-box engine only).
    this._scopedIfaces = new Set()
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
        // Ignore connected↔connecting flips during ping-restart soft reconnects:
        // persist-tun keeps the same utun, so sing-box config doesn't need to
        // change and restarting it would black-hole all traffic for seconds.
        if (isTunnelUsable(s)) {
          return `${id}:up:${s.ifIndex}:${s.gateway || ''}:${s.serverIp || ''}`
        }
        return `${id}:down:${s.state}`
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
      const anyConnected = Object.values(statuses).some((s) => isTunnelUsable(s))

      if (state.settings.routingEngine === 'singbox') {
        await this._reconcileSingbox(state, statuses)
      } else {
        await this._reconcileBuiltin(state, statuses, physical, anyConnected)
      }
    } finally {
      this.pending = false
    }
  }

  /**
   * sing-box engine: it owns DNS + the routing table (its own tun), so make sure
   * the builtin engine is fully torn down first, then hand the current state to
   * sing-box. interface info (utunX) must be resolved for a VPN to be usable.
   */
  async _reconcileSingbox(state, statuses) {
    // Ensure the legacy local resolver / static routes aren't fighting sing-box.
    dnsRouter.stop()
    await routeManager.clearAll()

    const physical = { ifIndex: await this._physicalInterface() }
    const res = await singboxManager.apply(state, statuses, physical)
    if (res && res.error) {
      logger.error('router', `sing-box engine error: ${res.error}; routing not active`)
      await systemDns.restore()
      return
    }
    if (res && res.running) {
      // Each VPN tunnel needs an interface-scoped default route so sing-box's
      // bind_interface (IP_BOUND_IF) can reach arbitrary public IPs through a
      // route-nopull tunnel that otherwise only carries its own /24.
      await this._syncScopedDefaults(statuses)
      // Force the OS resolver's queries INTO sing-box's tun (macOS auto_route
      // doesn't capture mDNSResponder's scoped DNS), so fake-IP engages and
      // domain rules apply. Then drop any pre-existing cached real IPs.
      await systemDns.apply(SINGBOX_DNS_ADDRESS)
      if (!res.unchanged) await systemDns.flush()
    } else {
      await this._clearScopedDefaults()
      await systemDns.restore()
    }
  }

  /**
   * Reconcile interface-scoped default routes against the set of connected VPN
   * tunnels. macOS only applies these to sockets bound to the interface, so each
   * VPN owns its own default without colliding with the system default or with
   * each other.
   */
  async _syncScopedDefaults(statuses) {
    if (typeof platform.addScopedDefault !== 'function') return
    const want = new Set()
    for (const s of Object.values(statuses)) {
      if (isTunnelUsable(s) && /^(utun|tun|ppp|ipsec)\d*$/i.test(s.ifIndex)) {
        want.add(s.ifIndex)
      }
    }
    for (const ifName of want) {
      if (this._scopedIfaces.has(ifName)) continue
      const r = await platform.addScopedDefault(ifName)
      if (r && r.ok) {
        this._scopedIfaces.add(ifName)
        logger.info('router', `scoped default route added via ${ifName}`)
      } else {
        logger.warn('router', `failed to add scoped default via ${ifName}: ${r && r.detail}`)
      }
    }
    for (const ifName of [...this._scopedIfaces]) {
      if (want.has(ifName)) continue
      await platform.removeScopedDefault(ifName)
      this._scopedIfaces.delete(ifName)
    }
  }

  async _clearScopedDefaults() {
    if (typeof platform.removeScopedDefault !== 'function') {
      this._scopedIfaces.clear()
      return
    }
    for (const ifName of [...this._scopedIfaces]) {
      await platform.removeScopedDefault(ifName)
      this._scopedIfaces.delete(ifName)
    }
  }

  async _physicalInterface() {
    if (typeof platform.physicalInterface === 'function') return platform.physicalInterface()
    const def = await routeManager.refreshPhysicalGateway()
    return def ? def.ifIndex : null
  }

  async _reconcileBuiltin(state, statuses, physical, anyConnected) {
    // If we just switched away from sing-box, make sure it's stopped and its
    // scoped default routes are removed.
    await singboxManager.stop()
    await this._clearScopedDefaults()

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

    // bring up DNS-driven domain routing — only hijack system DNS once the
    // local resolver is actually listening, so we never point the system at a
    // dead resolver (which would break all name resolution).
    const dnsUp = await dnsRouter.start()
    if (dnsUp) {
      await systemDns.apply()
    } else {
      await systemDns.restore()
      logger.warn('router', 'local DNS resolver not available; domain rules disabled (IP/CIDR rules still active)')
    }
  }

  async shutdown() {
    dnsRouter.stop()
    try {
      await singboxManager.stop()
    } catch {
      /* ignore */
    }
    try {
      await this._clearScopedDefaults()
    } catch {
      /* ignore */
    }
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
