/**
 * Domain rule matching (with wildcard/suffix/keyword/regex) and exit decision.
 * Used by the local DNS server to decide, at query time, how a domain should
 * be routed.
 */

const DOMAIN_TYPES = ['domain', 'domain-wildcard', 'domain-suffix', 'domain-keyword', 'domain-regex']

export function isDomainRule(rule) {
  return DOMAIN_TYPES.includes(rule.type)
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$', 'i')
}

export function matchDomain(domain, rule) {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '')
  const v = String(rule.value || '').toLowerCase().trim().replace(/\.$/, '')
  if (!d || !v) return false

  switch (rule.type) {
    case 'domain':
      return d === v
    case 'domain-suffix':
      return d === v || d.endsWith('.' + v)
    case 'domain-keyword':
      return d.includes(v)
    case 'domain-wildcard':
      try {
        return globToRegex(v).test(d)
      } catch {
        return false
      }
    case 'domain-regex':
      try {
        return new RegExp(rule.value, 'i').test(d)
      } catch {
        return false
      }
    default:
      return false
  }
}

/**
 * Decide the routing exit for a domain.
 *
 * @returns {{ exit: 'direct' | string, ruleId: string } | null}
 *          exit is "direct" or a vpnId; null means "no rule matched"
 *          (caller falls back to the default policy).
 *
 * Priority: per-VPN domain rules (in VPN order) > global domain rules.
 */
export function decideExit(domain, state, isConnected) {
  const { vpns, globalRules } = state

  for (const vpn of vpns) {
    for (const rule of vpn.rules || []) {
      if (rule.enabled === false || !isDomainRule(rule)) continue
      if (!matchDomain(domain, rule)) continue
      if (rule.action === 'proxy') {
        if (isConnected(vpn.id)) return { exit: vpn.id, ruleId: rule.id }
        continue // can't proxy through a disconnected VPN; keep looking
      }
      return { exit: 'direct', ruleId: rule.id }
    }
  }

  for (const rule of globalRules || []) {
    if (rule.enabled === false || !isDomainRule(rule)) continue
    if (!matchDomain(domain, rule)) continue
    if (rule.action === 'proxy') {
      if (rule.vpnId && isConnected(rule.vpnId)) return { exit: rule.vpnId, ruleId: rule.id }
      continue
    }
    return { exit: 'direct', ruleId: rule.id }
  }

  return null
}
