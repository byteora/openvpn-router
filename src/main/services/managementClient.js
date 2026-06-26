import net from 'net'
import { EventEmitter } from 'events'
import { logger } from './logger.js'

/**
 * Speaks the OpenVPN "management interface" protocol over a TCP socket.
 * Emits:
 *   state     { name, description, localIp, remoteIp }
 *   pushReply { routeGateway, ifconfigLocal, ifconfigRemote, redirectGateway }
 *   bytecount { in, out }
 *   log       "<text>"
 *   fatal     "<text>"
 *   close
 */
export class ManagementClient extends EventEmitter {
  constructor(port, host = '127.0.0.1') {
    super()
    this.port = port
    this.host = host
    this.socket = null
    this.buffer = ''
    this.connected = false
  }

  connect(retries = 40) {
    return new Promise((resolve, reject) => {
      const attempt = (left) => {
        const socket = net.createConnection({ port: this.port, host: this.host })
        socket.setEncoding('utf-8')

        socket.once('connect', () => {
          this.socket = socket
          this.connected = true
          socket.on('data', (chunk) => this._onData(chunk))
          socket.on('close', () => {
            this.connected = false
            this.emit('close')
          })
          socket.on('error', (err) => logger.warn('mgmt', `socket error: ${err.message}`))
          // subscribe to async notifications ("log on all" replays history so
          // we still capture PUSH_REPLY/route-gateway even if we attach late)
          this.send('state on')
          this.send('log on all')
          this.send('bytecount 2')
          resolve()
        })

        socket.once('error', (err) => {
          if (left > 0) {
            setTimeout(() => attempt(left - 1), 250)
          } else {
            reject(new Error(`management connect failed: ${err.message}`))
          }
        })
      }
      attempt(retries)
    })
  }

  send(cmd) {
    if (this.socket && this.connected) {
      this.socket.write(cmd + '\n')
    }
  }

  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      this._handleLine(line)
    }
  }

  _handleLine(line) {
    if (!line) return

    if (line.startsWith('>STATE:')) {
      this._handleState(line.slice('>STATE:'.length))
    } else if (line.startsWith('>BYTECOUNT:')) {
      const [bin, bout] = line.slice('>BYTECOUNT:'.length).split(',')
      this.emit('bytecount', { in: Number(bin) || 0, out: Number(bout) || 0 })
    } else if (line.startsWith('>LOG:')) {
      const text = line.slice('>LOG:'.length)
      this.emit('log', text)
      this._maybeParsePush(text)
    } else if (line.startsWith('>FATAL:')) {
      this.emit('fatal', line.slice('>FATAL:'.length))
    } else if (line.startsWith('>HOLD:')) {
      this.send('hold release')
    } else if (line.startsWith('>PASSWORD:')) {
      // handled via auth-user-pass file; surface for visibility
      this.emit('log', line)
    } else if (line.startsWith('SUCCESS:') || line.startsWith('ERROR:')) {
      this.emit('log', line)
    }
  }

  _handleState(payload) {
    // time,name,description,localIp,remoteIp,...
    const f = payload.split(',')
    this.emit('state', {
      name: f[1] || '',
      description: f[2] || '',
      localIp: f[3] || '',
      remoteIp: f[4] || ''
    })
  }

  _maybeParsePush(text) {
    if (!text.includes('PUSH_REPLY') && !text.includes('PUSH: Received')) return
    const result = {
      routeGateway: null,
      ifconfigLocal: null,
      ifconfigRemote: null,
      redirectGateway: false
    }
    const gw = text.match(/route-gateway\s+([0-9.]+)/)
    if (gw) result.routeGateway = gw[1]
    const ic = text.match(/ifconfig\s+([0-9.]+)\s+([0-9.]+)/)
    if (ic) {
      result.ifconfigLocal = ic[1]
      result.ifconfigRemote = ic[2]
    }
    if (text.includes('redirect-gateway')) result.redirectGateway = true
    this.emit('pushReply', result)
  }

  disconnect() {
    if (this.socket && this.connected) {
      this.send('signal SIGTERM')
      setTimeout(() => {
        try {
          this.socket.end()
        } catch {
          /* ignore */
        }
      }, 300)
    }
  }
}
