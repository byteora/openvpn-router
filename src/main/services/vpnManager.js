import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ManagementClient } from './managementClient.js'
import { parseOvpn } from './ovpnParser.js'
import { routeManager } from './routeManager.js'
import { platform } from '../platform/index.js'
import { logger } from './logger.js'

function randomPort() {
  return 10000 + Math.floor(Math.random() * 40000)
}

/**
 * Owns the lifecycle of each OpenVPN process and exposes a normalized
 * connection status (including the tunnel gateway / interface index that the
 * route manager needs to build policy routes).
 */
export class VpnManager extends EventEmitter {
  constructor() {
    super()
    this.connections = new Map() // vpnId -> connection
  }

  _emptyStatus() {
    return {
      state: 'disconnected',
      message: '',
      localIp: null,
      gateway: null,
      ifIndex: null,
      serverIp: null,
      bytesIn: 0,
      bytesOut: 0,
      since: null
    }
  }

  getStatus(vpnId) {
    const conn = this.connections.get(vpnId)
    return conn ? { ...conn.status } : this._emptyStatus()
  }

  getAllStatuses() {
    const out = {}
    for (const [id, conn] of this.connections) out[id] = { ...conn.status }
    return out
  }

  isConnected(vpnId) {
    const conn = this.connections.get(vpnId)
    return !!conn && conn.status.state === 'connected'
  }

  _update(vpnId, patch) {
    const conn = this.connections.get(vpnId)
    if (!conn) return
    Object.assign(conn.status, patch)
    this.emit('status', vpnId, { ...conn.status })
  }

  async connect(vpn, settings) {
    const existing = this.connections.get(vpn.id)
    if (existing) {
      if (existing.status.state === 'connected' || existing.status.state === 'connecting') {
        logger.warn('vpn', `${vpn.name} already has an active connection`)
        return
      }
      // an old instance is still tearing down; wait for it to fully exit
      logger.info('vpn', `${vpn.name}: waiting for previous instance to exit`)
      await Promise.race([
        existing.closePromise,
        new Promise((r) => setTimeout(r, 4000))
      ]).catch(() => {})
    }
    if (!vpn.configPath || !fs.existsSync(vpn.configPath)) {
      throw new Error(`Config file not found: ${vpn.configPath}`)
    }

    const content = fs.readFileSync(vpn.configPath, 'utf-8')
    const parsed = parseOvpn(content)
    const port = randomPort()
    const cwd = path.dirname(vpn.configPath)

    const args = [
      '--config',
      vpn.configPath,
      '--management',
      '127.0.0.1',
      String(port),
      '--auth-nocache',
      // we own the routing table, so don't let the server install routes
      '--route-nopull',
      ...platform.openvpnExtraArgs()
    ]

    let authFile = null
    if (vpn.username && vpn.password) {
      authFile = path.join(os.tmpdir(), `ovpnr-${vpn.id}-${Date.now()}.txt`)
      fs.writeFileSync(authFile, `${vpn.username}\n${vpn.password}\n`, { mode: 0o600 })
      args.push('--auth-user-pass', authFile)
    }

    let resolveClose
    const closePromise = new Promise((r) => {
      resolveClose = r
    })
    const conn = {
      proc: null,
      mgmt: null,
      authFile,
      parsed,
      closePromise,
      resolveClose,
      status: { ...this._emptyStatus(), state: 'connecting', message: 'starting openvpn' }
    }
    this.connections.set(vpn.id, conn)
    this.emit('status', vpn.id, { ...conn.status })

    logger.info('vpn', `${vpn.name}: launching ${settings.openvpnPath} (mgmt :${port})`)

    const proc = spawn(settings.openvpnPath, args, { cwd, windowsHide: true })
    conn.proc = proc

    proc.stdout.on('data', (d) => logger.info('openvpn', `${vpn.name}: ${d.toString().trim()}`))
    proc.stderr.on('data', (d) => logger.warn('openvpn', `${vpn.name}: ${d.toString().trim()}`))

    proc.on('error', (err) => {
      this._update(vpn.id, { state: 'error', message: `spawn failed: ${err.message}` })
      logger.error('vpn', `${vpn.name}: spawn failed: ${err.message}`)
      this._cleanup(vpn.id)
    })

    proc.on('exit', (code) => {
      logger.info('vpn', `${vpn.name}: process exited (code ${code})`)
      const c = this.connections.get(vpn.id)
      if (c && c.status.state !== 'error') this._update(vpn.id, { state: 'disconnected', message: '' })
      this._cleanup(vpn.id)
      this.emit('disconnected', vpn.id)
    })

    // management interface
    const mgmt = new ManagementClient(port)
    conn.mgmt = mgmt
    try {
      await mgmt.connect()
    } catch (err) {
      this._update(vpn.id, { state: 'error', message: err.message })
      this.disconnect(vpn.id)
      return
    }

    mgmt.on('state', async (st) => {
      const map = { CONNECTING: 'connecting', WAIT: 'connecting', AUTH: 'connecting', GET_CONFIG: 'connecting', ASSIGN_IP: 'connecting', RECONNECTING: 'connecting' }
      if (st.name === 'CONNECTED') {
        this._update(vpn.id, {
          state: 'connected',
          message: 'connected',
          localIp: st.localIp || conn.status.localIp,
          serverIp: st.remoteIp || conn.status.serverIp,
          since: conn.status.since || Date.now()
        })
        await this._resolveInterface(vpn.id)
        this.emit('connected', vpn.id)
      } else if (st.name === 'EXITING') {
        this._update(vpn.id, { state: 'disconnected', message: '' })
      } else if (map[st.name]) {
        this._update(vpn.id, { state: 'connecting', message: st.name.toLowerCase() })
      }
    })

    mgmt.on('pushReply', async (push) => {
      const patch = {}
      if (push.routeGateway) patch.gateway = push.routeGateway
      if (push.ifconfigLocal) patch.localIp = push.ifconfigLocal
      if (Object.keys(patch).length) this._update(vpn.id, patch)
      // remember the ptp peer as a fallback gateway for tun
      if (!conn.status.gateway && push.ifconfigRemote) this._update(vpn.id, { gateway: push.ifconfigRemote })
      await this._resolveInterface(vpn.id)
    })

    mgmt.on('bytecount', (bc) => this._update(vpn.id, { bytesIn: bc.in, bytesOut: bc.out }))
    mgmt.on('fatal', (text) => {
      this._update(vpn.id, { state: 'error', message: text })
      logger.error('vpn', `${vpn.name}: FATAL ${text}`)
    })
  }

  async _resolveInterface(vpnId) {
    const conn = this.connections.get(vpnId)
    if (!conn || conn.status.ifIndex) return
    if (!conn.status.localIp) return
    const idx = await routeManager.interfaceIndexForIp(conn.status.localIp)
    if (idx) this._update(vpnId, { ifIndex: idx })
  }

  disconnect(vpnId) {
    const conn = this.connections.get(vpnId)
    if (!conn) return
    this._update(vpnId, { state: 'disconnecting', message: '' })
    if (conn.mgmt) conn.mgmt.disconnect()
    setTimeout(() => {
      const c = this.connections.get(vpnId)
      if (c && c.proc && !c.proc.killed) {
        try {
          c.proc.kill()
        } catch {
          /* ignore */
        }
      }
    }, 1200)
  }

  _cleanup(vpnId) {
    const conn = this.connections.get(vpnId)
    if (!conn) return
    if (conn.authFile) {
      try {
        fs.unlinkSync(conn.authFile)
      } catch {
        /* ignore */
      }
    }
    this.connections.delete(vpnId)
    if (conn.resolveClose) conn.resolveClose()
  }

  disconnectAll() {
    for (const id of Array.from(this.connections.keys())) this.disconnect(id)
  }

  /** Best-effort synchronous kill of all OpenVPN processes (crash/signal path). */
  disconnectAllSync() {
    for (const [, conn] of this.connections) {
      try {
        if (conn.proc && !conn.proc.killed) conn.proc.kill()
      } catch {
        /* ignore */
      }
    }
  }
}

export const vpnManager = new VpnManager()
