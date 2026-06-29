import { dnsResolver } from './dns.js'
import { networkAddress } from '../platform/common.js'
import { logger } from './logger.js'

const HOST_PREFIX = 32

/** Turn a single rule into a list of { dest, prefixLen } destinations. */
async function ruleDestinations(rule) {
  const value = (rule.value || '').trim()
  if (!value) return []

  if (rule.type === 'ip') {
    if (value.includes('/')) {
      const [ip, prefixStr] = value.split('/')
      const prefix = Number(prefixStr)
      const net = networkAddress(ip, prefix)
      if (!net) return []
      return [{ dest: net, prefixLen: Math.max(0, Math.min(32, prefix)) }]
    }
    return [{ dest: value, prefixLen: HOST_PREFIX }]
  }

  // domain
  const ips = await dnsResolver.resolve(value)
  return ips.map((ip) => ({ dest: ip, prefixLen: HOST_PREFIX }))
}

/**
 * Resolve the ordered rule set into a map of destination -> exit decision.
 * First match wins. exit is either "direct" or a connected vpnId.
 *
 * Priority: per-VPN rules (in VPN order) > global rules.
 */
async function buildExitMap({ vpns, globalRules }, isConnected) {
  const exitMap = new Map() // "dest/prefixLen" -> { dest, prefixLen, exit }

  const consider = async (rule, exit) => {
    if (rule.enabled === false) return
    // Domain rules are resolved + routed live by the local DNS server; the
    // static reconcile only handles IP/CIDR rules.
    if (rule.type !== 'ip') return
    const dests = await ruleDestinations(rule)
    for (const d of dests) {
      const key = `${d.dest}/${d.prefixLen}`
      if (!exitMap.has(key)) exitMap.set(key, { dest: d.dest, prefixLen: d.prefixLen, exit })
    }
  }

  for (const vpn of vpns) {
    for (const rule of vpn.rules || []) {
      let exit
      if (rule.action === 'proxy') {
        if (!isConnected(vpn.id)) continue
        exit = vpn.id
      } else {
        exit = 'direct'
      }
      await consider(rule, exit)
    }
  }

  for (const rule of globalRules || []) {
    let exit
    if (rule.action === 'proxy') {
      if (!rule.vpnId || !isConnected(rule.vpnId)) continue
      exit = rule.vpnId
    } else {
      exit = 'direct'
    }
    await consider(rule, exit)
  }

  return exitMap
}

/**
 * Compute the full desired static route table.
 *
 * @param state     store state ({ settings, vpns, globalRules })
 * @param statuses  map vpnId -> status (with gateway/ifIndex/serverIp)
 * @param physical  { gateway, ifIndex }
 */
export async function computeDesiredRoutes(state, statuses, physical) {
  const { settings, vpns, globalRules } = state
  const isConnected = (id) => statuses[id] && statuses[id].state === 'connected'
  const vpnGw = (id) => {
    const s = statuses[id]
    return { gateway: s.gateway || '0.0.0.0', ifIndex: s.ifIndex || null }
  }
  const vpnName = (id) => {
    const v = vpns.find((x) => x.id === id)
    return v ? v.name : id
  }

  const desired = []
  const exitMap = await buildExitMap({ vpns, globalRules }, isConnected)

  const defaultProxy =
    settings.defaultPolicy === 'proxy' &&
    settings.defaultProxyVpnId &&
    isConnected(settings.defaultProxyVpnId)

  if (settings.defaultPolicy === 'proxy' && !defaultProxy) {
    logger.warn('rules', 'default policy is "proxy" but its VPN is not connected; falling back to direct')
  }

  if (defaultProxy) {
    if (!physical || !physical.gateway) {
      logger.warn('rules', 'cannot enable proxy-all: physical gateway unknown')
    } else {
      // keep every VPN server reachable over the physical link
      for (const id of Object.keys(statuses)) {
        const s = statuses[id]
        if (s.state === 'connected' && s.serverIp) {
          desired.push({ dest: s.serverIp, prefixLen: 32, gateway: physical.gateway, ifIndex: physical.ifIndex, metric: 1, note: `pin ${vpnName(id)} server (DIRECT)` })
        }
      }
      // split default through the chosen VPN (overrides 0.0.0.0/0 without removing it)
      const gw = vpnGw(settings.defaultProxyVpnId)
      const allNote = `proxy-all via VPN ${vpnName(settings.defaultProxyVpnId)}`
      desired.push({ dest: '0.0.0.0', prefixLen: 1, gateway: gw.gateway, ifIndex: gw.ifIndex, metric: 5, note: allNote })
      desired.push({ dest: '128.0.0.0', prefixLen: 1, gateway: gw.gateway, ifIndex: gw.ifIndex, metric: 5, note: allNote })
    }
  }

  for (const { dest, prefixLen, exit } of exitMap.values()) {
    if (exit === 'direct') {
      if (defaultProxy && physical && physical.gateway) {
        desired.push({ dest, prefixLen, gateway: physical.gateway, ifIndex: physical.ifIndex, metric: 3, note: 'DIRECT' })
      }
    } else {
      if (defaultProxy && exit === settings.defaultProxyVpnId) continue
      const gw = vpnGw(exit)
      desired.push({ dest, prefixLen, gateway: gw.gateway, ifIndex: gw.ifIndex, metric: 3, note: `VPN ${vpnName(exit)}` })
    }
  }

  return desired
}
