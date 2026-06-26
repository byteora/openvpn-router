import fs from 'fs'
import path from 'path'
import { run, prefixToMask } from './common.js'

function ps(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

const OPENVPN_DIRS = [
  'C:\\Program Files\\OpenVPN\\bin',
  'C:\\Program Files (x86)\\OpenVPN\\bin',
  'C:\\Program Files\\OpenVPN Connect',
  'D:\\OpenVPN\\bin',
  'D:\\OpenVPNGui\\bin'
]

async function where(cmd) {
  const res = await run('where.exe', [cmd])
  if (!res.ok || !res.stdout) return null
  const first = res.stdout.split(/\r?\n/).find((l) => l.trim())
  return first ? first.trim() : null
}

export const windowsPlatform = {
  name: 'win32',
  displayName: 'Windows',

  // ---- elevation ------------------------------------------------------------
  async isElevated() {
    const res = await run('net', ['session'])
    return res.ok
  },

  relaunchElevated() {
    const exe = process.execPath
    const args = process.argv.slice(1)
    const argList = args.length
      ? ` -ArgumentList @(${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})`
      : ''
    try {
      run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${exe.replace(/'/g, "''")}'${argList} -Verb RunAs`
      ])
      return true
    } catch {
      return false
    }
  },

  elevationInstructions() {
    return 'OpenVPN Router must run as Administrator.\n\nClose this window, open PowerShell "Run as administrator", then run:\n\n    npm run dev'
  },

  // ---- openvpn discovery ----------------------------------------------------
  async isRunnable(openvpnPath) {
    if (!openvpnPath) return false
    if (openvpnPath.includes('\\') || openvpnPath.includes('/')) return fs.existsSync(openvpnPath)
    return !!(await where(openvpnPath))
  },

  async locateOpenvpn() {
    const onPath = await where('openvpn')
    if (onPath && fs.existsSync(onPath)) return onPath
    for (const dir of OPENVPN_DIRS) {
      const candidate = path.join(dir, 'openvpn.exe')
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  },

  openvpnExtraArgs() {
    return []
  },

  // ---- routing --------------------------------------------------------------
  async getDefaultRoute() {
    const res = await ps(
      "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | " +
        'Sort-Object RouteMetric,ifMetric | Select-Object -First 1 NextHop,InterfaceIndex | ConvertTo-Json -Compress'
    )
    if (res.ok && res.stdout.trim()) {
      try {
        const obj = JSON.parse(res.stdout.trim())
        if (obj && obj.NextHop && obj.NextHop !== '0.0.0.0') {
          return { gateway: obj.NextHop, ifIndex: Number(obj.InterfaceIndex) }
        }
      } catch {
        /* ignore */
      }
    }
    return null
  },

  async interfaceForIp(ip) {
    if (!ip) return null
    const res = await ps(
      `Get-NetIPAddress -IPAddress '${ip}' -ErrorAction SilentlyContinue | ` +
        'Select-Object -First 1 -ExpandProperty InterfaceIndex'
    )
    if (res.ok && res.stdout.trim()) {
      const idx = Number(res.stdout.trim())
      if (!Number.isNaN(idx)) return idx
    }
    return null
  },

  async routeAdd({ dest, prefixLen, gateway, ifIndex, metric }) {
    const mask = prefixToMask(prefixLen)
    const args = ['add', dest, 'mask', mask, gateway, 'metric', String(metric || 1)]
    if (ifIndex) args.push('if', String(ifIndex))
    let res = await run('route', args)
    if (!res.ok) {
      // "route add" fails if a route to this dest already exists; replace it
      await this.routeDelete({ dest, prefixLen })
      res = await run('route', args)
    }
    return { ok: res.ok, detail: (res.stderr || res.stdout).trim() }
  },

  async routeDelete({ dest, prefixLen }) {
    const mask = prefixToMask(prefixLen)
    const res = await run('route', ['delete', dest, 'mask', mask])
    return res.ok
  },

  // ---- system DNS -----------------------------------------------------------
  async setDns(servers) {
    const def = await this.getDefaultRoute()
    if (!def || !def.ifIndex) return { ok: false, detail: 'default interface unknown' }
    const ifIndex = def.ifIndex

    const prevRes = await ps(
      `(Get-DnsClientServerAddress -InterfaceIndex ${ifIndex} -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses -join ','`
    )
    const previous = prevRes.stdout.trim() ? prevRes.stdout.trim().split(',').map((s) => s.trim()).filter(Boolean) : []

    const set = await ps(
      `Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ServerAddresses ${servers.map((s) => `'${s}'`).join(',')}`
    )
    if (!set.ok) return { ok: false, detail: set.stderr.trim() }

    await this.flushDns()
    return { ok: true, state: { ifIndex, previous }, detail: `if ${ifIndex} (was: ${previous.join(',') || 'dhcp'})` }
  },

  async restoreDns(state) {
    if (!state) return false
    const { ifIndex, previous } = state
    if (previous && previous.length) {
      await ps(`Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ServerAddresses ${previous.map((s) => `'${s}'`).join(',')}`)
    } else {
      await ps(`Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ResetServerAddresses`)
    }
    await this.flushDns()
    return true
  },

  async flushDns() {
    await run('ipconfig', ['/flushdns'])
  },

  // ---- connection reset -----------------------------------------------------
  /**
   * Forcibly reset established TCP connections whose remote IP is in `ips`, so
   * apps (browsers) immediately re-establish them and pick up the new route
   * instead of reusing a keep-alive connection on the old path.
   *
   * Uses iphlpapi SetTcpEntry with MIB_TCP_STATE_DELETE_TCB (12). IPv4 only;
   * requires elevation (which we have).
   */
  async resetConnections(ips) {
    const list = (ips || []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
    if (!list.length) return 0
    const ipArray = list.map((ip) => `'${ip}'`).join(',')
    const script = [
      `$ips=@(${ipArray})`,
      "$ErrorActionPreference='SilentlyContinue'",
      "Add-Type -Namespace OvpnR -Name Tcp -MemberDefinition '[DllImport(\"iphlpapi.dll\")] public static extern uint SetTcpEntry(byte[] r);'",
      'function A($s){$b=[System.Net.IPAddress]::Parse($s).GetAddressBytes();return [System.BitConverter]::ToUInt32($b,0)}',
      'function P($p){$hi=($p -shr 8) -band 0xFF;$lo=$p -band 0xFF;return [uint32](($lo -shl 8) -bor $hi)}',
      '$n=0',
      '$c=Get-NetTCPConnection -State Established | Where-Object {$ips -contains $_.RemoteAddress}',
      'foreach($x in $c){',
      '$row=New-Object byte[] 20',
      '[BitConverter]::GetBytes([uint32]12).CopyTo($row,0)',
      '[BitConverter]::GetBytes([uint32](A $x.LocalAddress)).CopyTo($row,4)',
      '[BitConverter]::GetBytes([uint32](P $x.LocalPort)).CopyTo($row,8)',
      '[BitConverter]::GetBytes([uint32](A $x.RemoteAddress)).CopyTo($row,12)',
      '[BitConverter]::GetBytes([uint32](P $x.RemotePort)).CopyTo($row,16)',
      'if([OvpnR.Tcp]::SetTcpEntry($row) -eq 0){$n++}',
      '}',
      'Write-Output $n'
    ].join('; ')
    const res = await ps(script)
    const n = parseInt((res.stdout || '').trim(), 10)
    return Number.isNaN(n) ? 0 : n
  }
}
