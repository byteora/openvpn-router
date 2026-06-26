import fs from 'fs'
import { app } from 'electron'
import { run, runSync } from './common.js'

/**
 * macOS backend.
 *
 * Routing is done with /sbin/route (BSD style); host routes for resolved domain
 * IPs go through the VPN's gateway, and a split default (0/1 + 128/1) overrides
 * the system default without removing it. System DNS is steered via
 * `networksetup` on the primary network service.
 *
 * macOS interface handles are interface names (e.g. "en0", "utun4"), not the
 * numeric indices Windows uses; the rest of the app treats `ifIndex` as an
 * opaque handle, so strings are fine here.
 */

const OPENVPN_PATHS = [
  '/opt/homebrew/sbin/openvpn',
  '/usr/local/sbin/openvpn',
  '/opt/homebrew/bin/openvpn',
  '/usr/local/bin/openvpn',
  '/usr/sbin/openvpn',
  '/usr/bin/openvpn'
]

async function which(cmd) {
  const res = await run('/usr/bin/which', [cmd])
  if (res.ok && res.stdout.trim()) return res.stdout.trim().split(/\r?\n/)[0].trim()
  return null
}

/** Map network-service name -> BSD device (e.g. "Wi-Fi" -> "en0"). */
async function serviceDeviceMap() {
  const res = await run('/usr/sbin/networksetup', ['-listnetworkserviceorder'])
  const map = [] // [{ service, device }]
  if (!res.ok) return map
  // Blocks look like:
  //   (1) Wi-Fi
  //   (Hardware Port: Wi-Fi, Device: en0)
  const lines = res.stdout.split(/\r?\n/)
  let pendingService = null
  for (const line of lines) {
    const svc = line.match(/^\(\d+\)\s+(.+?)\s*$/)
    if (svc) {
      pendingService = svc[1]
      continue
    }
    const dev = line.match(/Device:\s*([^)]+)\)/)
    if (dev && pendingService) {
      map.push({ service: pendingService, device: dev[1].trim() })
      pendingService = null
    }
  }
  return map
}

export const darwinPlatform = {
  name: 'darwin',
  displayName: 'macOS',

  // ---- elevation ------------------------------------------------------------
  async isElevated() {
    return typeof process.getuid === 'function' && process.getuid() === 0
  },

  relaunchElevated() {
    // Relaunch the packaged .app as root via a GUI auth prompt.
    if (!app.isPackaged) return false
    const exe = process.execPath.replace(/"/g, '\\"')
    const script = `do shell script "\\"${exe}\\" > /dev/null 2>&1 &" with administrator privileges`
    try {
      run('/usr/bin/osascript', ['-e', script])
      return true
    } catch {
      return false
    }
  },

  elevationInstructions() {
    return 'OpenVPN Router needs root to configure routes and DNS.\n\nQuit, then start it from a terminal with:\n\n    sudo npm run dev'
  },

  // ---- openvpn discovery ----------------------------------------------------
  async isRunnable(openvpnPath) {
    if (!openvpnPath) return false
    if (openvpnPath.includes('/')) return fs.existsSync(openvpnPath)
    return !!(await which(openvpnPath))
  },

  async locateOpenvpn() {
    const onPath = await which('openvpn')
    if (onPath && fs.existsSync(onPath)) return onPath
    for (const p of OPENVPN_PATHS) {
      if (fs.existsSync(p)) return p
    }
    return null
  },

  openvpnExtraArgs() {
    return []
  },

  // ---- routing --------------------------------------------------------------
  async getDefaultRoute() {
    const res = await run('/sbin/route', ['-n', 'get', 'default'])
    if (!res.ok) return null
    const gw = res.stdout.match(/gateway:\s*([0-9.]+)/)
    const iface = res.stdout.match(/interface:\s*(\S+)/)
    if (gw) return { gateway: gw[1], ifIndex: iface ? iface[1] : null }
    return null
  },

  async interfaceForIp(ip) {
    if (!ip) return null
    const res = await run('/sbin/ifconfig', [])
    if (!res.ok) return null
    // Walk interface blocks; a block header starts at column 0 with "<name>:".
    let current = null
    for (const line of res.stdout.split(/\r?\n/)) {
      const head = line.match(/^([a-z0-9]+):\s/i)
      if (head) {
        current = head[1]
        continue
      }
      if (current && line.includes(`inet ${ip} `)) return current
    }
    return null
  },

  async routeAdd({ dest, prefixLen, gateway, metric }) {
    const target = prefixLen >= 32 ? dest : `${dest}/${prefixLen}`
    const args = prefixLen >= 32 ? ['-n', 'add', '-host', dest, gateway] : ['-n', 'add', '-net', target, gateway]
    let res = await run('/sbin/route', args)
    if (!res.ok && /File exists/i.test(res.stderr + res.stdout)) {
      await this.routeDelete({ dest, prefixLen })
      res = await run('/sbin/route', args)
    }
    void metric
    return { ok: res.ok, detail: (res.stderr || res.stdout).trim() }
  },

  async routeDelete({ dest, prefixLen }) {
    const args = prefixLen >= 32 ? ['-n', 'delete', '-host', dest] : ['-n', 'delete', '-net', `${dest}/${prefixLen}`]
    const res = await run('/sbin/route', args)
    return res.ok
  },

  // ---- system DNS -----------------------------------------------------------
  async _primaryService() {
    const def = await this.getDefaultRoute()
    const device = def && def.ifIndex
    const map = await serviceDeviceMap()
    if (device) {
      const hit = map.find((m) => m.device === device)
      if (hit) return hit.service
    }
    return map.length ? map[0].service : null
  },

  async setDns(servers) {
    const service = await this._primaryService()
    if (!service) return { ok: false, detail: 'primary network service unknown' }

    const prev = await run('/usr/sbin/networksetup', ['-getdnsservers', service])
    // networksetup prints "There aren't any DNS Servers set on <svc>." when empty.
    // Never record our own loopback resolver as "previous".
    const previous = /(\d+\.\d+\.\d+\.\d+)/.test(prev.stdout)
      ? prev.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) && !s.startsWith('127.'))
      : []

    const set = await run('/usr/sbin/networksetup', ['-setdnsservers', service, ...servers])
    if (!set.ok) return { ok: false, detail: set.stderr.trim() }

    await this.flushDns()
    return { ok: true, state: { service, previous }, detail: `${service} (was: ${previous.join(',') || 'dhcp'})` }
  },

  /** Reset every network service whose DNS still contains a loopback address. */
  async _clearLoopbackDns(sync = false) {
    const exec = sync ? runSync : run
    const list = await serviceDeviceMap()
    for (const { service } of list) {
      const res = await exec('/usr/sbin/networksetup', ['-getdnsservers', service])
      const out = (res.stdout || '').toString()
      if (/127\./.test(out)) {
        await exec('/usr/sbin/networksetup', ['-setdnsservers', service, 'empty'])
      }
    }
  },

  async restoreDns(state) {
    if (state) {
      const { service, previous } = state
      if (previous && previous.length) {
        await run('/usr/sbin/networksetup', ['-setdnsservers', service, ...previous])
      } else {
        await run('/usr/sbin/networksetup', ['-setdnsservers', service, 'empty'])
      }
    }
    await this._clearLoopbackDns(false)
    await this.flushDns()
    return true
  },

  /** Synchronous DNS restore for crash/signal cleanup. */
  restoreDnsSync(state) {
    if (state) {
      const { service, previous } = state
      if (previous && previous.length) {
        runSync('/usr/sbin/networksetup', ['-setdnsservers', service, ...previous])
      } else {
        runSync('/usr/sbin/networksetup', ['-setdnsservers', service, 'empty'])
      }
    }
    // Best-effort sync leftover scan (serviceDeviceMap is async; skip in sync
    // path and rely on next-launch recover() for any stragglers).
    runSync('/usr/bin/dscacheutil', ['-flushcache'])
    runSync('/usr/bin/killall', ['-HUP', 'mDNSResponder'])
    return true
  },

  async flushDns() {
    await run('/usr/bin/dscacheutil', ['-flushcache'])
    await run('/usr/bin/killall', ['-HUP', 'mDNSResponder'])
  },

  // ---- connection reset -----------------------------------------------------
  /**
   * macOS has no reliable userland API to reset an individual established TCP
   * connection (pf state-killing only works when pf is enabled and tracking the
   * flow). Best-effort no-op: clients fall back to short DNS TTLs + natural
   * connection turnover. Returns 0.
   */
  async resetConnections() {
    return 0
  }
}
