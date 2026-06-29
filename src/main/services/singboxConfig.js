/**
 * Builds a sing-box (>= 1.12 schema) configuration that implements policy
 * routing across multiple OpenVPN tunnels — including the case our IP-routing
 * engine cannot handle: two domains that share the same CDN IPs but must take
 * different VPNs.
 *
 * How it works
 * ------------
 *  - A `tun` inbound captures all traffic and `auto_route` steers the system
 *    into it.
 *  - DNS uses a `fakeip` server: every domain gets a unique synthetic IP, so a
 *    destination is now 1:1 with a hostname (no more shared-CDN-IP collisions).
 *  - Route rules match by domain (recovered from the fake IP) or by real IP/CIDR
 *    and select an outbound.
 *  - Each connected VPN is a `direct` outbound pinned to that tunnel's interface
 *    via `bind_interface` (utunX). `bind_interface` forces egress out that exact
 *    interface regardless of the routing table — the key primitive that lets two
 *    connections to the same IP leave through different tunnels. "direct" traffic
 *    and the OpenVPN-to-server packets use a `direct` outbound pinned to the
 *    physical interface.
 *
 * The generated config is validated with `sing-box check` before use.
 */

const FAKEIP_RANGE = '198.18.0.0/15'
const TUN_ADDRESS = '172.19.0.1/30'

/**
 * The tun's own address. We point the system DNS here so the OS resolver's
 * queries are forced INTO the tun (where `hijack-dns` captures them into
 * fake-IP). On macOS `auto_route` alone doesn't capture mDNSResponder's
 * scoped DNS, so without this fake-IP never engages and rules don't apply.
 */
export const SINGBOX_DNS_ADDRESS = '172.19.0.1'

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** Convert our `domain-wildcard` glob (e.g. *.example.com) to a sing-box regex. */
function wildcardToRegex(glob) {
  return '^' + escapeRegex(glob).replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
}

const DIRECT_TAG = 'direct'
function vpnTag(id) {
  return `vpn-${id}`
}

/** Turn one rule into a sing-box route-rule matcher fragment (no action yet). */
function matcherFor(rule) {
  const v = (rule.value || '').trim()
  if (!v) return null
  switch (rule.type) {
    case 'domain':
      return { domain: [v.toLowerCase().replace(/\.$/, '')] }
    case 'domain-suffix':
      return { domain_suffix: [v.toLowerCase().replace(/\.$/, '')] }
    case 'domain-keyword':
      return { domain_keyword: [v.toLowerCase()] }
    case 'domain-wildcard':
      return { domain_regex: [wildcardToRegex(v.toLowerCase().replace(/\.$/, ''))] }
    case 'domain-regex':
      return { domain_regex: [v] }
    case 'ip':
      return { ip_cidr: [v.includes('/') ? v : `${v}/32`] }
    default:
      return null
  }
}

/**
 * @param {object} state      store state ({ settings, vpns, globalRules })
 * @param {object} statuses   vpnId -> status ({ state, ifIndex, serverIp, ... })
 * @param {object} physical   { gateway, ifIndex } of the physical default route
 * @returns {object} sing-box config
 */
export function buildSingboxConfig(state, statuses, physical) {
  const { settings, vpns, globalRules } = state
  const isConnected = (id) => statuses[id] && statuses[id].state === 'connected' && statuses[id].ifIndex
  void physical

  // ---- outbounds ------------------------------------------------------------
  // "direct" must NOT hard-bind to the physical interface: auto_route moves the
  // default route onto sing-box's own tun, so binding to en0 (which then has no
  // default route) makes every direct dial fail with "network is unreachable".
  // `route.auto_detect_interface` lets sing-box pick the real underlying default
  // interface for direct traffic. Each VPN outbound DOES bind to its utun — that
  // explicit bind is what forces traffic out a specific tunnel.
  const outbounds = [{ type: 'direct', tag: DIRECT_TAG }]
  for (const vpn of vpns) {
    if (!isConnected(vpn.id)) continue
    outbounds.push({ type: 'direct', tag: vpnTag(vpn.id), bind_interface: statuses[vpn.id].ifIndex })
  }
  const connectedTag = (id) => (isConnected(id) ? vpnTag(id) : null)

  // ---- route rules (first match wins): per-VPN rules, then global rules -----
  const ruleList = []
  const pushRule = (rule, outbound) => {
    if (rule.enabled === false) return
    const m = matcherFor(rule)
    if (!m || !outbound) return
    ruleList.push({ ...m, action: 'route', outbound })
  }

  for (const vpn of vpns) {
    for (const rule of vpn.rules || []) {
      if (rule.action === 'proxy') {
        const tag = connectedTag(vpn.id)
        if (tag) pushRule(rule, tag) // skip if that VPN isn't up
      } else {
        pushRule(rule, DIRECT_TAG)
      }
    }
  }
  for (const rule of globalRules || []) {
    if (rule.action === 'proxy') {
      const tag = connectedTag(rule.vpnId)
      if (tag) pushRule(rule, tag)
    } else {
      pushRule(rule, DIRECT_TAG)
    }
  }

  // Default policy: unmatched traffic goes direct, or through the chosen VPN.
  const finalOutbound =
    settings.defaultPolicy === 'proxy' && connectedTag(settings.defaultProxyVpnId)
      ? connectedTag(settings.defaultProxyVpnId)
      : DIRECT_TAG

  // Keep every VPN's server reachable over the physical link (so OpenVPN's own
  // packets to its server don't get pulled into a tunnel). Highest priority.
  const serverIps = []
  for (const id of Object.keys(statuses)) {
    const s = statuses[id]
    if (s && s.state === 'connected' && s.serverIp) serverIps.push(`${s.serverIp}/32`)
  }

  // Hijack DNS by PORT (53) *before* sniff: matching by `protocol: dns` depends
  // on payload sniffing, which can miss UDP/53 and let queries flow straight to
  // the upstream (returning real IPs, so fake-IP never engages and everything
  // falls through to `direct`). Port-based hijack is deterministic. After that,
  // sniff recovers SNI/host for any non-fake-IP traffic.
  const routeRules = [
    { port: 53, action: 'hijack-dns' },
    { action: 'sniff' }
  ]
  if (serverIps.length) routeRules.push({ ip_cidr: serverIps, action: 'route', outbound: DIRECT_TAG })
  routeRules.push(...ruleList)

  const upstreamDns = settings.dnsServer || '1.1.1.1'

  return {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        // No `detour`: sing-box dials this itself and `auto_detect_interface`
        // binds it to the real default interface (bypassing its own tun, so no
        // loop). Pointing detour at the bare `direct` outbound is rejected
        // ("detour to an empty direct outbound makes no sense").
        { type: 'udp', tag: 'upstream', server: upstreamDns },
        { type: 'fakeip', tag: 'fakeip', inet4_range: FAKEIP_RANGE }
      ],
      rules: [
        // Drop HTTPS/SVCB (64/65): their ipv4hint/ipv6hint can carry real IPs
        // that let clients bypass fake-IP and skip policy routing.
        { query_type: [64, 65], action: 'predefined', rcode: 'NOERROR' },
        { query_type: ['A', 'AAAA'], server: 'fakeip' }
      ],
      // resolve real IPs (for fakeip reverse + outbound dialing) over physical
      strategy: 'ipv4_only',
      independent_cache: true
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: [TUN_ADDRESS],
        auto_route: true,
        strict_route: false,
        stack: 'system',
        mtu: 1500
      }
    ],
    outbounds,
    route: {
      rules: routeRules,
      final: finalOutbound,
      auto_detect_interface: true,
      default_domain_resolver: 'upstream'
    }
  }
}
