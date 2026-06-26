import React, { useEffect, useState, useCallback } from 'react'
import VpnCard from './components/VpnCard.jsx'
import RuleEditor from './components/RuleEditor.jsx'

const api = window.api

function useAppState() {
  const [state, setState] = useState(null)
  const refresh = useCallback(async () => {
    const s = await api.getState()
    setState(s)
  }, [])

  useEffect(() => {
    refresh()
    const off = api.onVpnStatus(() => refresh())
    return off
  }, [refresh])

  return [state, refresh]
}

function VpnsPage({ state, refresh }) {
  const statuses = state.statuses || {}

  const addVpn = async () => {
    const path = await api.pickConfig()
    if (!path) return
    await api.addVpn({ configPath: path })
    refresh()
  }
  const addBlank = async () => {
    await api.addVpn({ name: 'New VPN' })
    refresh()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>VPN Connections</h1>
          <div className="subtitle">Import .ovpn profiles, connect, and define per-VPN routing rules.</div>
        </div>
        <div className="flex">
          <button className="btn" onClick={addBlank}>
            + Empty
          </button>
          <button className="btn btn-primary" onClick={addVpn}>
            + Import .ovpn
          </button>
        </div>
      </div>

      {state.vpns.length === 0 && <div className="empty">No VPNs yet. Import an .ovpn file to get started.</div>}

      {state.vpns.map((vpn) => (
        <VpnCard key={vpn.id} vpn={vpn} status={statuses[vpn.id]} api={api} refresh={refresh} />
      ))}
    </div>
  )
}

function GlobalPage({ state, refresh }) {
  const { settings } = state
  const connectedVpns = state.vpns.filter((v) => (state.statuses[v.id] || {}).state === 'connected')

  const setDefault = async (patch) => {
    await api.updateSettings(patch)
    refresh()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Global Routing</h1>
          <div className="subtitle">Default behaviour for traffic that no rule matches, plus global rules.</div>
        </div>
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>Default policy</h4>
        <div className="row">
          <div className="field">
            <label>Unmatched traffic should</label>
            <select value={settings.defaultPolicy} onChange={(e) => setDefault({ defaultPolicy: e.target.value })}>
              <option value="direct">go direct (no VPN)</option>
              <option value="proxy">go through a VPN (proxy all)</option>
            </select>
          </div>
          <div className="field">
            <label>Default VPN (when proxy all)</label>
            <select
              value={settings.defaultProxyVpnId || ''}
              onChange={(e) => setDefault({ defaultProxyVpnId: e.target.value || null })}
              disabled={settings.defaultPolicy !== 'proxy'}
            >
              <option value="">select…</option>
              {state.vpns.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {(state.statuses[v.id] || {}).state === 'connected' ? '' : ' (offline)'}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Proxy-all installs a split-default route (0.0.0.0/1 + 128.0.0.0/1) through the selected VPN. Rules below
          carve exceptions out of this.
        </div>
      </div>

      <div className="card">
        <div className="rules-head">
          <h4>Global rules</h4>
          <span className="muted" style={{ fontSize: 12 }}>
            evaluated after per-VPN rules · first match wins
          </span>
        </div>
        {connectedVpns.length === 0 && settings.defaultPolicy === 'direct' && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Tip: "proxy" rules need a connected target VPN to take effect.
          </div>
        )}
        <RuleEditor
          rules={state.globalRules}
          vpns={state.vpns}
          scope="global"
          onAdd={(rule) => api.addGlobalRule(rule).then(refresh)}
          onUpdate={(id, patch) => api.updateGlobalRule(id, patch).then(refresh)}
          onRemove={(id) => api.removeGlobalRule(id).then(refresh)}
        />
      </div>
    </div>
  )
}

function SettingsPage({ state, refresh }) {
  const isMac = state.platform && state.platform.name === 'darwin'
  const [form, setForm] = useState({
    openvpnPath: state.settings.openvpnPath,
    dnsServer: state.settings.dnsServer
  })

  const save = async () => {
    await api.updateSettings(form)
    refresh()
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="subtitle">Binary paths and DNS used for domain rule resolution.</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>OpenVPN binary path</label>
          <div className="flex">
            <input
              type="text"
              style={{ flex: 1 }}
              value={form.openvpnPath}
              placeholder={isMac ? '/opt/homebrew/sbin/openvpn' : 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe'}
              onChange={(e) => setForm({ ...form, openvpnPath: e.target.value })}
            />
            <button
              className="btn btn-sm"
              onClick={async () => {
                const p = await api.pickOpenvpn()
                if (p) {
                  setForm({ ...form, openvpnPath: p })
                  refresh()
                }
              }}
            >
              Browse…
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                const p = await api.detectOpenvpn()
                if (p) {
                  setForm({ ...form, openvpnPath: p })
                  refresh()
                } else {
                  alert('openvpn.exe not found automatically. Use Browse to locate it.')
                }
              }}
            >
              Auto-detect
            </button>
          </div>
        </div>
        <div className="field">
          <label>Upstream DNS server (the local resolver forwards queries here)</label>
          <input type="text" value={form.dnsServer} onChange={(e) => setForm({ ...form, dnsServer: e.target.value })} />
        </div>
        <button className="btn btn-primary btn-sm" onClick={save}>
          Save settings
        </button>
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>How routing works</h4>
        <p className="muted" style={{ lineHeight: 1.6, fontSize: 13 }}>
          Rules are resolved in priority order: <b>per-VPN rules → global rules → default policy</b>.
          <br />
          <br />
          While a VPN is connected the app runs a <b>local DNS server</b> and points your system DNS at it. When an
          app looks up a domain, the rule is matched at that moment (supporting <b>exact / suffix / wildcard /
          keyword / regex</b>); if it should be proxied, a precise host route for the resolved IP is installed via
          the chosen VPN <i>before</i> the answer is returned — so the first connection already takes the right path
          (accurate for CDNs, no mid-connection break).
          <br />
          <br />
          <b>IP / CIDR</b> rules are programmed directly into the routing table. The DNS server (and your original
          DNS) are restored automatically when all VPNs disconnect.
        </p>
      </div>
    </div>
  )
}

function LogsPage() {
  const [logs, setLogs] = useState([])
  useEffect(() => {
    api.getLogs().then(setLogs)
    const off = api.onLog((entry) => setLogs((prev) => [...prev.slice(-1999), entry]))
    return off
  }, [])

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Logs</h1>
          <div className="subtitle">OpenVPN output, routing actions, and diagnostics.</div>
        </div>
      </div>
      <div className="log-view">
        {logs.map((l, i) => (
          <div className={`log-line log-${l.level}`} key={i}>
            <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span>{' '}
            <span className="log-scope">[{l.scope}]</span> {l.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const [state, refresh] = useAppState()
  const [page, setPage] = useState('vpns')

  if (!state) return <div style={{ padding: 40 }}>Loading…</div>

  const connectedCount = Object.values(state.statuses || {}).filter((s) => s.state === 'connected').length

  const nav = [
    { id: 'vpns', label: 'VPNs', icon: '🔌' },
    { id: 'global', label: 'Global Routing', icon: '🧭' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
    { id: 'logs', label: 'Logs', icon: '📜' }
  ]

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          OpenVPN Router
        </div>
        {nav.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id ? 'active' : ''}`}
            onClick={() => setPage(n.id)}
          >
            <span>{n.icon}</span>
            {n.label}
          </button>
        ))}
        <div className="nav-spacer" />
        <button className="btn btn-sm" style={{ margin: '0 8px 6px' }} onClick={() => api.reconcile()}>
          ↻ Reconcile now
        </button>
        <button
          className="btn btn-sm"
          style={{ margin: '0 8px 10px' }}
          title="Reset system DNS back to normal if it got stuck on the local resolver"
          onClick={() => api.restoreDns()}
        >
          ⛑ Restore system DNS
        </button>
        <div className="sidebar-foot">
          {connectedCount} VPN{connectedCount === 1 ? '' : 's'} connected
          <br />
          Default: {state.settings.defaultPolicy}
          <br />
          DNS router:{' '}
          <span style={{ color: state.dns && state.dns.running ? 'var(--green)' : 'var(--text-dim)' }}>
            {state.dns && state.dns.running ? `on (${state.dns.routed} routed)` : 'off'}
          </span>
        </div>
      </aside>

      <main className="main">
        {page === 'vpns' && <VpnsPage state={state} refresh={refresh} />}
        {page === 'global' && <GlobalPage state={state} refresh={refresh} />}
        {page === 'settings' && <SettingsPage state={state} refresh={refresh} />}
        {page === 'logs' && <LogsPage />}
      </main>
    </div>
  )
}
