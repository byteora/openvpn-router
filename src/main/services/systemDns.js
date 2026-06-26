import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { platform } from '../platform/index.js'
import { logger } from './logger.js'

const LOCAL_RESOLVER = '127.0.0.1'

/**
 * Points the system's DNS at our local resolver so domain rules can be matched
 * at query time, and restores the previous configuration on exit.
 *
 * Crash safety: because hijacking DNS would break all name resolution if the
 * app died without restoring, the hijack state is persisted to a marker file.
 * On the next launch `recover()` restores it, and `restoreSync()` provides a
 * best-effort synchronous restore for crash/signal handlers.
 */
class SystemDns {
  constructor() {
    this.state = null // opaque platform state for restore()
  }

  _markerFile() {
    return path.join(app.getPath('userData'), 'dns-hijack.json')
  }

  _writeMarker(state) {
    try {
      fs.writeFileSync(this._markerFile(), JSON.stringify({ platform: process.platform, state }), 'utf-8')
    } catch (err) {
      logger.warn('sysdns', `could not persist hijack marker: ${err.message}`)
    }
  }

  _clearMarker() {
    try {
      fs.rmSync(this._markerFile(), { force: true })
    } catch {
      /* ignore */
    }
  }

  _readMarker() {
    try {
      if (!fs.existsSync(this._markerFile())) return null
      return JSON.parse(fs.readFileSync(this._markerFile(), 'utf-8'))
    } catch {
      return null
    }
  }

  async apply() {
    if (this.state) return
    const res = await platform.setDns([LOCAL_RESOLVER])
    if (!res.ok) {
      logger.error('sysdns', `failed to set system DNS: ${res.detail || ''}`)
      return
    }
    this.state = res.state
    this._writeMarker(res.state)
    logger.info('sysdns', `system DNS -> ${LOCAL_RESOLVER} ${res.detail || ''}`)
  }

  async restore() {
    if (!this.state) return
    await platform.restoreDns(this.state)
    this._clearMarker()
    logger.info('sysdns', 'system DNS restored')
    this.state = null
  }

  /** Synchronous restore for crash/signal cleanup. Safe to call repeatedly. */
  restoreSync() {
    const state = this.state || (this._readMarker() || {}).state
    if (!state) return
    try {
      platform.restoreDnsSync(state)
    } catch {
      /* ignore */
    }
    this._clearMarker()
    this.state = null
  }

  /**
   * On startup: restore DNS if a previous run left it hijacked (crash, force
   * kill, power loss). Uses the saved marker when available, but ALSO always
   * runs the platform catch-all scan that resets any interface still pointing
   * at our loopback resolver — so recovery works even if the marker was lost or
   * poisoned.
   */
  async recover() {
    const marker = this._readMarker()
    const state = marker && marker.platform === process.platform ? marker.state : null
    if (marker) logger.warn('sysdns', 'detected leftover DNS hijack from a previous run; restoring')
    try {
      // restoreDns(null) still performs the loopback catch-all scan.
      await platform.restoreDns(state)
    } catch {
      /* ignore */
    }
    this._clearMarker()
  }

  async flush() {
    await platform.flushDns()
  }

  isActive() {
    return !!this.state
  }
}

export const systemDns = new SystemDns()
