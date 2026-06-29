import { platform } from '../platform/index.js'
import { logger } from './logger.js'

/**
 * Programs the OS routing table to implement policy routing. All OS-specific
 * commands live in the platform backend; this class only manages reconciliation
 * and the dynamic-route TTL cache.
 *
 * Route shape: { dest, prefixLen, gateway, ifIndex, metric }
 *  - prefixLen: 0-32 (32 = host route)
 *  - ifIndex:   opaque interface handle (number on Windows, name on macOS)
 *
 * Concepts:
 *  - "direct" traffic uses the physical default gateway.
 *  - "proxy via VPN X" traffic is sent to VPN X's tunnel gateway/interface.
 *  - A split default (0.0.0.0/1 + 128.0.0.0/1) forces ALL traffic through a VPN
 *    without destroying the OS default route.
 */
export class RouteManager {
  constructor() {
    this.installed = new Map() // "dest/prefixLen" -> route (static, reconciled)
    this.dynamic = new Map() // "dest/prefixLen" -> route + { expires } (per-DNS-hit)
    this.physical = null // { gateway, ifIndex }
    this.physicalAt = 0
    this._sweeper = setInterval(() => this._sweep().catch(() => {}), 30000)
  }

  async refreshPhysicalGateway(maxAgeMs = 15000) {
    if (this.physical && Date.now() - this.physicalAt < maxAgeMs) return this.physical
    const def = await platform.getDefaultRoute()
    if (def && def.gateway) {
      const changed = !this.physical || this.physical.gateway !== def.gateway || this.physical.ifIndex !== def.ifIndex
      this.physical = def
      this.physicalAt = Date.now()
      if (changed) logger.info('route', `physical gateway ${def.gateway} (if ${def.ifIndex})`)
      return this.physical
    }
    logger.warn('route', 'could not determine physical default gateway')
    return this.physical
  }

  /** Resolve the platform interface handle that owns a given tunnel local IP. */
  async interfaceIndexForIp(ip) {
    return platform.interfaceForIp(ip)
  }

  key(dest, prefixLen) {
    return `${dest}/${prefixLen}`
  }

  async _routeAdd(route, quiet = false) {
    const res = await platform.routeAdd(route)
    if (!res.ok) {
      logger.warn('route', `add ${route.dest}/${route.prefixLen} via ${route.gateway} failed: ${res.detail || ''}`)
    } else if (!quiet) {
      const target = route.ifIndex ? `if ${route.ifIndex}` : `via ${route.gateway}`
      logger.info(
        'route',
        `+ ${route.dest}/${route.prefixLen} -> ${route.note || target} (${target})`
      )
    }
    return res.ok
  }

  async _routeDelete(dest, prefixLen) {
    return platform.routeDelete({ dest, prefixLen })
  }

  /**
   * Reconcile the desired set of static routes against what is installed.
   * desired: array of { dest, prefixLen, gateway, ifIndex, metric }
   */
  async apply(desired) {
    const desiredMap = new Map()
    for (const r of desired) desiredMap.set(this.key(r.dest, r.prefixLen), r)

    let added = 0
    let removed = 0

    for (const [k, cur] of this.installed) {
      const want = desiredMap.get(k)
      if (!want || want.gateway !== cur.gateway || want.ifIndex !== cur.ifIndex || want.metric !== cur.metric) {
        await this._routeDelete(cur.dest, cur.prefixLen)
        this.installed.delete(k)
        removed++
      }
    }

    for (const [k, want] of desiredMap) {
      if (!this.installed.has(k)) {
        const ok = await this._routeAdd(want)
        if (ok) {
          this.installed.set(k, want)
          added++
        }
      }
    }

    return { added, removed }
  }

  /**
   * Install (or refresh) a dynamic host route for a resolved domain IP.
   * Skips IPs already covered by an identical static route.
   *
   * @returns {'unchanged'|'added'|'changed'|'failed'}
   */
  async addDynamic(dest, gateway, ifIndex, metric, ttlMs) {
    const prefixLen = 32
    const k = this.key(dest, prefixLen)
    const expires = Date.now() + ttlMs
    const existing = this.dynamic.get(k)
    if (existing && existing.gateway === gateway && existing.ifIndex === ifIndex) {
      existing.expires = expires
      return 'unchanged'
    }
    const staticRoute = this.installed.get(k)
    if (staticRoute && staticRoute.gateway === gateway && staticRoute.ifIndex === ifIndex) {
      return 'unchanged'
    }
    const wasExisting = !!existing
    const route = { dest, prefixLen, gateway, ifIndex, metric }
    const ok = await this._routeAdd(route, true)
    if (!ok) return 'failed'
    this.dynamic.set(k, { ...route, expires })
    return wasExisting ? 'changed' : 'added'
  }

  /** Current dynamic-route destination IPs (snapshot). */
  dynamicDests() {
    return Array.from(this.dynamic.values()).map((r) => r.dest)
  }

  async _sweep() {
    const now = Date.now()
    for (const [k, r] of this.dynamic) {
      if (r.expires <= now) {
        await this._routeDelete(r.dest, r.prefixLen)
        this.dynamic.delete(k)
      }
    }
  }

  /** Drop all dynamic routes (e.g. when rules change). Returns count removed. */
  async clearDynamic() {
    let removed = 0
    for (const [, r] of this.dynamic) {
      await this._routeDelete(r.dest, r.prefixLen)
      removed++
    }
    this.dynamic.clear()
    return removed
  }

  /** Remove every route this manager created (static + dynamic). */
  async clearAll() {
    let removed = 0
    for (const [, cur] of this.installed) {
      await this._routeDelete(cur.dest, cur.prefixLen)
      removed++
    }
    this.installed.clear()
    removed += await this.clearDynamic()
    return removed
  }
}

export const routeManager = new RouteManager()
