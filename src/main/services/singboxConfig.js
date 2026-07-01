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

/** Tunnel is usable for routing when its utun exists — including during a soft
 *  reconnect (ping-restart / persist-tun) where state is `connecting` but the
 *  interface is still up. Dropping it from config on that transient state
 *  restarts sing-box and black-holes all traffic for seconds. */
export function isTunnelUsable(status) {
  return !!(
    status &&
    status.ifIndex &&
    (status.state === 'connected' || status.state === 'connecting')
  )
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
  const isConnected = (id) => isTunnelUsable(statuses[id])
  const physIf = physical && physical.ifIndex ? physical.ifIndex : null

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
  // Dedicated outbound for sing-box's OWN upstream DNS, hard-bound to the
  // physical NIC. Without this the upstream query relies on auto_detect_interface
  // and can be re-captured by our own tun's port-53 `hijack-dns` rule, forming a
  // resolution loop that intermittently times out ("lookup …: context deadline
  // exceeded") and breaks all name resolution. IP_BOUND_IF to en0 forces the
  // query straight out the real interface (en0 keeps the system default route),
  // bypassing the tun entirely. (A direct outbound WITH bind_interface is not
  // "empty", so a detour to it is valid.)
  const DNS_OUT_TAG = 'dns-out'
  if (physIf) outbounds.push({ type: 'direct', tag: DNS_OUT_TAG, bind_interface: physIf })
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
    // `warn`, not `info`: at info sing-box logs ~4 lines per connection, which
    // under normal browsing is a flood that hammers the in-app log + IPC and can
    // eventually crash the renderer. Warnings/errors are still surfaced.
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        // Bind the upstream resolver to the physical NIC (see DNS_OUT_TAG above)
        // so its queries never re-enter our tun and loop through hijack-dns.
        // Falls back to auto_detect_interface when the physical NIC is unknown.
        { type: 'udp', tag: 'upstream', server: upstreamDns, ...(physIf ? { detour: DNS_OUT_TAG } : {}) },
        { type: 'fakeip', tag: 'fakeip', inet4_range: FAKEIP_RANGE }
      ],
      rules: [
        // Drop HTTPS/SVCB (64/65): their ipv4hint/ipv6hint can carry real IPs
        // that let clients bypass fake-IP and skip policy routing.
        { query_type: [64, 65], action: 'predefined', rcode: 'NOERROR' },
        // Answer AAAA with an immediate empty NOERROR: fake-IP only has a v4
        // range, so sending AAAA to it makes IPv6-heavy sites (e.g. Apple) hang
        // waiting on a v6 answer that never usefully comes. Empty-fast forces
        // clients onto the A (fake-IP) path.
        { query_type: 'AAAA', action: 'predefined', rcode: 'NOERROR' },
        { query_type: 'A', server: 'fakeip' }
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
