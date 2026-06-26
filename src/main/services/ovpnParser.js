/**
 * Minimal .ovpn parser. We only need a few facts to drive routing:
 *  - remote host(s): so we can pin a host route to the VPN server over the
 *    physical gateway when this VPN becomes the default exit.
 *  - dev type (tun/tap)
 *  - whether the config expects interactive credentials (auth-user-pass)
 */
export function parseOvpn(content) {
  const remotes = []
  let dev = 'tun'
  let proto = 'udp'
  let needsAuth = false
  let port = null

  const lines = content.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const parts = line.split(/\s+/)
    const directive = parts[0].toLowerCase()

    if (directive === 'remote' && parts[1]) {
      remotes.push({ host: parts[1], port: parts[2] ? Number(parts[2]) : null })
    } else if (directive === 'dev' && parts[1]) {
      dev = parts[1].startsWith('tap') ? 'tap' : 'tun'
    } else if (directive === 'proto' && parts[1]) {
      proto = parts[1].toLowerCase()
    } else if (directive === 'port' && parts[1]) {
      port = Number(parts[1])
    } else if (directive === 'auth-user-pass') {
      // bare directive (no file) means OpenVPN will prompt interactively
      if (!parts[1]) needsAuth = true
    }
  }

  if (port && remotes.length) {
    remotes.forEach((r) => {
      if (!r.port) r.port = port
    })
  }

  return { remotes, dev, proto, needsAuth }
}
