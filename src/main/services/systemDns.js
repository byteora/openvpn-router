import { platform } from '../platform/index.js'
import { logger } from './logger.js'

const LOCAL_RESOLVER = '127.0.0.1'

/**
 * Points the system's DNS at our local resolver so domain rules can be matched
 * at query time, and restores the previous configuration on exit. All
 * OS-specific work is delegated to the platform backend.
 */
class SystemDns {
  constructor() {
    this.state = null // opaque platform state for restore()
  }

  async apply() {
    if (this.state) return
    const res = await platform.setDns([LOCAL_RESOLVER])
    if (!res.ok) {
      logger.error('sysdns', `failed to set system DNS: ${res.detail || ''}`)
      return
    }
    this.state = res.state
    logger.info('sysdns', `system DNS -> ${LOCAL_RESOLVER} ${res.detail || ''}`)
  }

  async restore() {
    if (!this.state) return
    await platform.restoreDns(this.state)
    logger.info('sysdns', 'system DNS restored')
    this.state = null
  }

  async flush() {
    await platform.flushDns()
  }

  isActive() {
    return !!this.state
  }
}

export const systemDns = new SystemDns()
