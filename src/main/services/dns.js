import dns from 'dns'
import { logger } from './logger.js'

/**
 * Resolves domain rules to IPv4 addresses so they can be programmed into the
 * Windows routing table. Results are cached with a short TTL; rotating-IP /
 * CDN domains are an inherent limitation of route-table based split tunneling.
 */
class DnsResolver {
  constructor() {
    this.resolver = new dns.Resolver()
    this.cache = new Map() // domain -> { ips, expires }
    this.ttl = 5 * 60 * 1000
  }

  setServer(server) {
    try {
      this.resolver.setServers([server])
    } catch (err) {
      logger.warn('dns', `invalid DNS server "${server}": ${err.message}`)
    }
  }

  async resolve(domain) {
    const now = Date.now()
    const cached = this.cache.get(domain)
    if (cached && cached.expires > now) return cached.ips

    const ips = await new Promise((resolve) => {
      this.resolver.resolve4(domain, (err, addrs) => {
        if (err || !addrs || addrs.length === 0) {
          logger.warn('dns', `resolve ${domain} failed: ${err ? err.message : 'no records'}`)
          resolve([])
        } else {
          resolve(addrs)
        }
      })
    })

    this.cache.set(domain, { ips, expires: now + this.ttl })
    return ips
  }

  clear() {
    this.cache.clear()
  }
}

export const dnsResolver = new DnsResolver()
