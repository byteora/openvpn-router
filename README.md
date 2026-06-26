# OpenVPN Router

A **Windows + macOS** desktop OpenVPN client with **policy-based (domain / IP) split
routing** across **multiple** VPN connections. Built with Electron + React.

Decide, per domain or IP, whether traffic goes **direct** or through a **specific VPN** —
with a global default plus global and per-VPN rule sets.

## Features

- **Multiple VPNs** — import any number of `.ovpn` profiles and connect them independently.
- **Default policy** — unmatched traffic goes *direct* or *proxied through a chosen VPN* (proxy-all).
- **Global rules** & **per-VPN rules** — route traffic *direct* or *through a specific VPN*.
- **Domain matching** — `domain` (exact), `domain-suffix`, `domain-wildcard` (`*.example.com`),
  `domain-keyword`, `domain-regex`, plus `ip` / CIDR.
- **DNS-driven precise routing** — domains are matched at lookup time and the exact resolved IP is
  routed before the answer is returned (accurate for CDNs, applies instantly).
- **Live status** — tunnel IP, gateway, server IP, throughput, and DNS-router state.
- **Logs** — OpenVPN output and every routing decision.

## How routing is decided

For each domain/IP, the first matching decision wins, in this priority:

1. **Per-VPN rules** (in VPN order) — `proxy` = force through *that* VPN, `direct` = force direct.
2. **Global rules** — `proxy` (through a chosen VPN) or `direct`.
3. **Default policy** — `direct`, or `proxy` through the default VPN.

### Enforcement — two layers

**1. DNS-driven routing (for domain rules).** While any VPN is connected the app runs a local DNS
server on `127.0.0.1:53` and points the system DNS at it. For every lookup it matches the domain
against the rules (exact/suffix/wildcard/keyword/regex), forwards the query to the upstream DNS, and
— *before* returning the answer — installs a precise `/32` route for the resolved IP via the chosen
exit. So the very first connection already takes the correct path; this is accurate even for CDN
domains and avoids the mid-connection breakage of pre-resolved routes. `AAAA`/`HTTPS` records are
suppressed for proxied domains to prevent IPv6 / SVCB-hint leaks.

**2. Static routing table (for IP/CIDR rules + proxy-all).** IP/CIDR rules become host/CIDR routes.
"Proxy-all" installs a split default (`0.0.0.0/1` + `128.0.0.0/1`) through the default VPN while
pinning each VPN's server IP to the physical gateway. VPNs run with `--route-nopull` so the app
fully owns the routing table.

### Cross-platform

OS-specific operations (route table, system DNS, elevation, binary discovery) live behind a small
platform abstraction in `src/main/platform/` with `windows.js` (`route`, `netsh` / PowerShell,
UAC) and `darwin.js` (`route`, `networksetup`, `osascript`) backends. Everything else — VPN
management, the DNS server, rule matching, UI — is shared.

> Example: in **VPN A**, keep the baseline *direct* and add a per-VPN rule
> `domain-suffix example.com → proxy`. Any lookup of `*.example.com` is routed through VPN A the
> instant it's resolved; everything else on A stays direct.

When all VPNs disconnect, the local DNS server stops, the original system DNS is restored, and all
managed routes are removed.

## Requirements

- **Windows 10/11** or **macOS**
- **OpenVPN** installed (the `openvpn` binary), and set its path in *Settings* if not
  auto-detected:
  - Windows: typically `C:\Program Files\OpenVPN\bin\openvpn.exe`
  - macOS: `brew install openvpn` → `/opt/homebrew/sbin/openvpn` (Apple Silicon) or
    `/usr/local/sbin/openvpn` (Intel)
- **Elevated privileges** — editing the routing table and system DNS requires them:
  - Windows: run as **Administrator** (packaged build prompts via UAC)
  - macOS: run with **root** (`sudo` in dev; packaged `.app` prompts for an admin password)

## Develop / Run

```bash
npm install

# Windows: run the terminal as Administrator, then:
npm run dev

# macOS:
sudo npm run dev

npm run build    # produce out/ bundles
npm run preview  # run the built app
npm run dist     # package an installer (NSIS on Windows, DMG on macOS)
```

## Notes & limitations

- Domain rules only apply to apps that use the **system DNS**. Apps using DoH/DoT or hard-coded IPs
  bypass the resolver — cover those with `ip` / CIDR rules.
- Port `53` on `127.0.0.1` must be free (stop any other local resolver, e.g. Acrylic/dnscrypt).
- IPv4 only for managed routes; `AAAA`/`HTTPS` are suppressed for proxied domains.
- Dynamic domain routes carry a TTL and are refreshed as the domain is queried again.
- Credentials (optional username/password) are written to a temporary auth file while a VPN
  is connected and removed on disconnect.
- Gateway/interface discovery is best-effort via the OpenVPN management interface and may need
  tuning for unusual server `topology` setups.
- **macOS**: DNS is steered on the *primary network service* via `networksetup`; on unusual
  multi-interface setups verify the right service is selected. Binding `127.0.0.1:53` and editing
  routes/DNS requires root.

## Project layout

```
src/
  main/                 Electron main process
    index.js            app lifecycle, window, elevation check, auto-connect
    ipc.js              IPC handlers (renderer <-> services)
    platform/           OS abstraction
      index.js          backend selector (by process.platform)
      common.js         exec helper + IPv4 math
      windows.js        route / netsh / PowerShell / UAC backend
      darwin.js         route / networksetup / osascript backend
    services/
      store.js          persistent config + data model
      ovpnParser.js     minimal .ovpn parsing
      managementClient.js  OpenVPN management-interface protocol client
      vpnManager.js     per-VPN process lifecycle + status
      routeManager.js   routing table (static + dynamic routes), via platform
      dnsRouter.js      local DNS server: match rule, resolve, route, reply
      dnsMessage.js     minimal DNS wire-format parser
      domainMatch.js    domain matching (wildcard/suffix/...) + exit decision
      systemDns.js      system DNS hijack/restore, via platform
      ruleEngine.js     IP/CIDR rules -> static route set
      router.js         orchestrator (static reconcile + DNS lifecycle)
      logger.js         in-memory log bus
  preload/index.js      contextBridge API
  renderer/             React UI (VPNs, Global Routing, Settings, Logs)
```
