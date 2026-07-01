import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { platform } from '../platform/index.js'
import { buildSingboxConfig, isTunnelUsable } from './singboxConfig.js'
import { logger } from './logger.js'

/**
 * Runs sing-box as the fake-IP routing engine. We manage the OpenVPN tunnels
 * ourselves (vpnManager); sing-box owns DNS + the routing table (its own tun)
 * and dials each policy decision out the right tunnel via `bind_interface`.
 *
 * Config changes (VPN connect/disconnect, rule edits) are applied by rewriting
 * the config file and restarting the process. sing-box has no reliable hot
 * reload, and a restart is fast and atomic (it cleans up and re-installs its
 * own routes), so we never leave the table half-applied.
 */
class SingboxManager {
  constructor() {
    this.proc = null
    this.binPath = null
    this.starting = null
    this.lastConfigJson = null
    this.running = false
  }

  _configFile() {
    return path.join(app.getPath('userData'), 'singbox-config.json')
  }

  async isAvailable() {
    if (!this.binPath) this.binPath = await platform.locateSingbox()
    return !!this.binPath
  }

  getStatus() {
    return { running: this.running }
  }

  /**
   * Reconcile sing-box to the desired state. If no VPN is connected, stop it.
   * Otherwise (re)write the config and (re)start only when it actually changed.
   */
  async apply(state, statuses, physical) {
    const anyConnected = Object.values(statuses).some((s) => isTunnelUsable(s))
    if (!anyConnected) {
      await this.stop()
      return { ok: true, running: false }
    }

    if (!(await this.isAvailable())) {
      logger.error('singbox', 'sing-box binary not found; cannot start routing engine')
      return { ok: false, running: false, error: 'sing-box not found' }
    }

    const config = buildSingboxConfig(state, statuses, physical)
    const json = JSON.stringify(config, null, 2)
    if (this.running && json === this.lastConfigJson) {
      return { ok: true, running: true, unchanged: true }
    }

    try {
      fs.mkdirSync(path.dirname(this._configFile()), { recursive: true })
      fs.writeFileSync(this._configFile(), json, 'utf-8')
    } catch (err) {
      logger.error('singbox', `failed to write config: ${err.message}`)
      return { ok: false, running: this.running, error: err.message }
    }

    await this.stop()
    this.lastConfigJson = json
    return this._start()
  }

  _start() {
    if (this.starting) return this.starting
    this.starting = new Promise((resolve) => {
      const env = {
        ...process.env,
        PATH: `${process.env.PATH || ''}:/opt/homebrew/sbin:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin`
      }
      const proc = spawn(this.binPath, ['run', '-c', this._configFile()], { windowsHide: true, env })
      this.proc = proc
      this.running = true
      logger.info('singbox', `routing engine starting (${this.binPath})`)

      const onLine = (text, level) => {
        const t = text.toString().trim()
        if (t) logger[level]('singbox', t)
      }
      proc.stdout.on('data', (d) => onLine(d, 'info'))
      proc.stderr.on('data', (d) => onLine(d, 'info')) // sing-box logs to stderr
      // A stdio stream emitting 'error' with no listener (e.g. EPIPE if the pipe
      // breaks) would throw and crash the whole app. Swallow it.
      proc.stdout.on('error', () => {})
      proc.stderr.on('error', () => {})

      proc.on('error', (err) => {
        logger.error('singbox', `spawn failed: ${err.message}`)
        this.running = false
        this.proc = null
      })
      proc.on('exit', (code, signal) => {
        logger.info('singbox', `routing engine exited (code ${code}${signal ? `, ${signal}` : ''})`)
        this.running = false
        this.proc = null
      })

      // Give it a moment to bind the tun / fail fast on a bad config.
      setTimeout(() => {
        this.starting = null
        resolve({ ok: this.running, running: this.running })
      }, 600)
    })
    return this.starting
  }

  async stop() {
    const proc = this.proc
    if (!proc) {
      this.running = false
      return
    }
    this.proc = null
    this.running = false
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      proc.once('exit', finish)
      try {
        proc.kill('SIGTERM') // lets sing-box tear down its tun + routes cleanly
      } catch {
        finish()
        return
      }
      // Hard cap: if it doesn't exit, force-kill so we never hang shutdown.
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish()
      }, 3000)
    })
    this.lastConfigJson = null
  }

  /** Best-effort synchronous kill for crash/signal cleanup. */
  stopSync() {
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.proc = null
      this.running = false
    }
  }
}

export const singboxManager = new SingboxManager()
