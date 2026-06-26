import { app } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { logger } from './logger.js'

/**
 * Persistent JSON configuration store.
 *
 * Data model
 * ----------
 * settings:
 *   openvpnPath   - path to the openvpn.exe binary (or "openvpn" if on PATH)
 *   dnsServer     - resolver used to turn domain rules into IP routes
 *   defaultPolicy - "direct" | "proxy"   (what to do with unmatched traffic)
 *   defaultProxyVpnId - which VPN carries traffic when defaultPolicy === "proxy"
 *
 * vpns[]:
 *   id, name, configPath, autoConnect
 *   username, password        - optional inline credentials for auth-user-pass
 *   defaultPolicy             - "direct" | "proxy" (this VPN's own baseline)
 *   rules[]                   - per-VPN rules (see Rule)
 *
 * globalRules[]:
 *   Rule with optional vpnId target (required when action === "proxy")
 *
 * Rule:
 *   id, type: "domain" | "ip", value, action: "direct" | "proxy"
 *   (per-VPN rules with action "proxy" implicitly target their own VPN)
 */

const DEFAULTS = {
  settings: {
    openvpnPath: 'openvpn',
    dnsServer: '1.1.1.1',
    defaultPolicy: 'direct',
    defaultProxyVpnId: null
  },
  vpns: [],
  globalRules: []
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json')
    this.data = this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        return this._migrate(raw)
      }
    } catch (err) {
      logger.error('store', `Failed to read config, using defaults: ${err.message}`)
    }
    return structuredClone(DEFAULTS)
  }

  _migrate(raw) {
    const data = structuredClone(DEFAULTS)
    Object.assign(data.settings, raw.settings || {})
    data.globalRules = Array.isArray(raw.globalRules) ? raw.globalRules : []
    data.vpns = Array.isArray(raw.vpns)
      ? raw.vpns.map((v) => ({
          id: v.id || randomUUID(),
          name: v.name || 'VPN',
          configPath: v.configPath || '',
          autoConnect: !!v.autoConnect,
          username: v.username || '',
          password: v.password || '',
          defaultPolicy: v.defaultPolicy === 'proxy' ? 'proxy' : 'direct',
          rules: Array.isArray(v.rules) ? v.rules : []
        }))
      : []
    return data
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      logger.error('store', `Failed to write config: ${err.message}`)
    }
  }

  getState() {
    return structuredClone(this.data)
  }

  // ---- settings -------------------------------------------------------------
  updateSettings(patch) {
    Object.assign(this.data.settings, patch)
    this.save()
    return this.data.settings
  }

  // ---- vpns -----------------------------------------------------------------
  addVpn(vpn) {
    const entry = {
      id: randomUUID(),
      name: vpn.name || 'New VPN',
      configPath: vpn.configPath || '',
      autoConnect: !!vpn.autoConnect,
      username: vpn.username || '',
      password: vpn.password || '',
      defaultPolicy: vpn.defaultPolicy === 'proxy' ? 'proxy' : 'direct',
      rules: []
    }
    this.data.vpns.push(entry)
    this.save()
    return entry
  }

  updateVpn(id, patch) {
    const vpn = this.data.vpns.find((v) => v.id === id)
    if (!vpn) return null
    const { id: _ignore, rules, ...rest } = patch
    Object.assign(vpn, rest)
    this.save()
    return vpn
  }

  removeVpn(id) {
    this.data.vpns = this.data.vpns.filter((v) => v.id !== id)
    if (this.data.settings.defaultProxyVpnId === id) {
      this.data.settings.defaultProxyVpnId = null
      if (this.data.settings.defaultPolicy === 'proxy') this.data.settings.defaultPolicy = 'direct'
    }
    this.data.globalRules = this.data.globalRules.filter((r) => r.vpnId !== id)
    this.save()
  }

  getVpn(id) {
    return this.data.vpns.find((v) => v.id === id) || null
  }

  // ---- rules ----------------------------------------------------------------
  _normalizeRule(rule) {
    const types = ['domain', 'domain-wildcard', 'domain-suffix', 'domain-keyword', 'domain-regex', 'ip']
    return {
      id: rule.id || randomUUID(),
      type: types.includes(rule.type) ? rule.type : 'domain',
      value: (rule.value || '').trim(),
      action: rule.action === 'proxy' ? 'proxy' : 'direct',
      vpnId: rule.vpnId || null,
      enabled: rule.enabled !== false
    }
  }

  addGlobalRule(rule) {
    const r = this._normalizeRule(rule)
    this.data.globalRules.push(r)
    this.save()
    return r
  }

  updateGlobalRule(id, patch) {
    const idx = this.data.globalRules.findIndex((r) => r.id === id)
    if (idx === -1) return null
    this.data.globalRules[idx] = this._normalizeRule({ ...this.data.globalRules[idx], ...patch, id })
    this.save()
    return this.data.globalRules[idx]
  }

  removeGlobalRule(id) {
    this.data.globalRules = this.data.globalRules.filter((r) => r.id !== id)
    this.save()
  }

  addVpnRule(vpnId, rule) {
    const vpn = this.getVpn(vpnId)
    if (!vpn) return null
    const r = this._normalizeRule({ ...rule, vpnId })
    vpn.rules.push(r)
    this.save()
    return r
  }

  updateVpnRule(vpnId, ruleId, patch) {
    const vpn = this.getVpn(vpnId)
    if (!vpn) return null
    const idx = vpn.rules.findIndex((r) => r.id === ruleId)
    if (idx === -1) return null
    vpn.rules[idx] = this._normalizeRule({ ...vpn.rules[idx], ...patch, id: ruleId, vpnId })
    this.save()
    return vpn.rules[idx]
  }

  removeVpnRule(vpnId, ruleId) {
    const vpn = this.getVpn(vpnId)
    if (!vpn) return
    vpn.rules = vpn.rules.filter((r) => r.id !== ruleId)
    this.save()
  }
}

let instance = null
export function getStore() {
  if (!instance) instance = new Store()
  return instance
}
