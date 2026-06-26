import { execFile } from 'child_process'

/** Run a command, never rejecting; returns { ok, stdout, stderr, error }. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout ? stdout.toString() : '',
        stderr: stderr ? stderr.toString() : '',
        error: err
      })
    })
  })
}

/** Convert an IPv4 prefix length (0-32) into a dotted netmask. */
export function prefixToMask(prefix) {
  const p = Math.max(0, Math.min(32, Number(prefix)))
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
  return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.')
}

/** Network (masked) address for ip/prefix, or null when ip is malformed. */
export function networkAddress(ip, prefix) {
  const parts = String(ip).split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null
  const int = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  const p = Math.max(0, Math.min(32, Number(prefix)))
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
  const net = (int & mask) >>> 0
  return [(net >>> 24) & 0xff, (net >>> 16) & 0xff, (net >>> 8) & 0xff, net & 0xff].join('.')
}
