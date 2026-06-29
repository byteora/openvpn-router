import { EventEmitter } from 'events'

const MAX_LINES = 2000

class Logger extends EventEmitter {
  constructor() {
    super()
    this.lines = []
  }

  _push(level, scope, message) {
    const entry = {
      ts: Date.now(),
      level,
      scope,
      message: typeof message === 'string' ? message : JSON.stringify(message)
    }
    this.lines.push(entry)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    // eslint-disable-next-line no-console
    console.log(`[${level}] (${scope}) ${entry.message}`)
    this.emit('log', entry)
    return entry
  }

  info(scope, message) {
    return this._push('info', scope, message)
  }

  warn(scope, message) {
    return this._push('warn', scope, message)
  }

  error(scope, message) {
    return this._push('error', scope, message)
  }

  history() {
    return this.lines.slice()
  }

  clear() {
    this.lines = []
  }
}

export const logger = new Logger()
