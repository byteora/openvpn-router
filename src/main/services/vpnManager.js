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

    // A packaged build launched via the GUI / `launchctl asuser` runs with a
    // minimal PATH (no Homebrew), so a bare "openvpn" can't be found and spawn
    // fails with ENOENT. Resolve it to a concrete path up front (locateOpenvpn
    // scans known install dirs via fs, independent of PATH).
    let bin = settings.openvpnPath
    if (!bin || !bin.includes('/') || !fs.existsSync(bin)) {
      const found = await platform.locateOpenvpn()
      if (found) bin = found
    }
    if (!bin || (bin.includes('/') && !fs.existsSync(bin))) {
      const msg = `openvpn binary not found (configured: "${settings.openvpnPath}") — set its full path in Settings`
      this._update(vpn.id, { state: 'error', message: msg })
      logger.error('vpn', `${vpn.name}: ${msg}`)
      this._cleanup(vpn.id)
      return
    }

    logger.info('vpn', `${vpn.name}: launching ${bin} (mgmt :${port})`)

    // Augment PATH so any child lookups still work even in a stripped GUI env.
    const env = {
      ...process.env,
      PATH: `${process.env.PATH || ''}:/opt/homebrew/sbin:/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin`
    }
    const proc = spawn(bin, args, { cwd, windowsHide: true, env })
    conn.proc = proc

    // Authoritatively map THIS process to the tun interface it opens, by parsing
    // its own log. Reverse-resolving by tunnel IP is ambiguous when two VPNs
    // share OpenVPN's default 10.8.0.0/24 (same local IP/gateway) — the lookup
    // would bind the second VPN to the first VPN's utun, sending its traffic out
    // the wrong exit. The binary prints e.g. "Opened utun device utun6".
    const onOpenvpnLine = (line) => {
      if (conn.ifAuthoritative) return
      const m =
        line.match(/Opened utun device\s+(\S+)/i) ||
        line.match(/device\s+\[(\S+)\]\s+opened/i) ||
        line.match(/TUN\/TAP device\s+(\S+)\s+opened/i)
      if (m && m[1]) {
        conn.ifAuthoritative = true
        if (conn.status.ifIndex !== m[1]) {
          logger.info('vpn', `${vpn.name}: tunnel interface ${m[1]}`)
          this._update(vpn.id, { ifIndex: m[1] })
        }
      }
    }
    const onOutput = (text, level) => {
      const t = text.toString()
      logger[level]('openvpn', `${vpn.name}: ${t.trim()}`)
      for (const line of t.split(/\r?\n/)) onOpenvpnLine(line)
    }
    proc.stdout.on('data', (d) => onOutput(d, 'info'))
    proc.stderr.on('data', (d) => onOutput(d, 'warn'))
    // A stdio stream emitting 'error' with no listener (e.g. EPIPE) would throw
    // and crash the whole app — swallow it; 'exit'/'error' on proc handle the
    // real lifecycle.
    proc.stdout.on('error', () => {})
    proc.stderr.on('error', () => {})

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
    // The interface parsed from the process log is authoritative; don't clobber
    // it with the ambiguous tunnel-IP reverse lookup (see onOpenvpnLine).
    if (!conn || conn.ifAuthoritative || conn.status.ifIndex) return
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
    // The process is gone, so its tunnel is down: scrub any IPv6 default route
    // left bound to this utun so it can't become a black hole for v6 traffic.
    const ifName = conn.status && conn.status.ifIndex
    if (ifName && typeof platform.removeInterfaceV6Default === 'function') {
      Promise.resolve(platform.removeInterfaceV6Default(ifName))
        .then((removed) => {
          if (removed) logger.info('vpn', `cleared stale IPv6 default route on ${ifName}`)
        })
        .catch(() => {})
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
