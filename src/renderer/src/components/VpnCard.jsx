import React, { useState } from 'react'
import RuleEditor from './RuleEditor.jsx'

function bytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`
}

export default function VpnCard({ vpn, status, api, refresh }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({
    name: vpn.name,
    configPath: vpn.configPath,
    username: vpn.username || '',
    password: vpn.password || '',
    defaultPolicy: vpn.defaultPolicy || 'direct'
  })

  const st = status || { state: 'disconnected' }
  const connected = st.state === 'connected'
  const busy = st.state === 'connecting' || st.state === 'disconnecting'

  const pickConfig = async () => {
    const p = await api.pickConfig()
    if (p) setForm({ ...form, configPath: p })
  }

  const save = async () => {
    await api.updateVpn(vpn.id, form)
    setEditing(false)
    refresh()
  }

  const toggleConnect = async () => {
    if (connected || busy) await api.disconnectVpn(vpn.id)
    else await api.connectVpn(vpn.id)
    refresh()
  }

  return (
    <div className="card">
      <div className="vpn-card-head">
        <div className="vpn-title">
          <h3>{vpn.name}</h3>
          <span className={`status-pill status-${st.state}`}>{st.state}</span>
          {vpn.defaultPolicy === 'proxy' && <span className="tag proxy">default: proxy</span>}
        </div>
        <div className="flex">
          <button className={`btn btn-sm ${connected ? 'btn-danger' : 'btn-primary'}`} onClick={toggleConnect}>
            {connected || busy ? 'Disconnect' : 'Connect'}
          </button>
          <button className="btn btn-sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide' : 'Rules & Settings'}
          </button>
        </div>
      </div>

      <div className="vpn-meta">
        <span>
          <b>Config:</b> {vpn.configPath ? vpn.configPath.split(/[\\/]/).pop() : '— not set —'}
        </span>
        {connected && (
          <>
            <span>
              <b>Tunnel IP:</b> {st.localIp || '…'}
            </span>
            <span>
              <b>Gateway:</b> {st.gateway || '…'}
            </span>
            <span>
              <b>Server:</b> {st.serverIp || '…'}
            </span>
            <span>
              <b>↓</b> {bytes(st.bytesIn)} <b>↑</b> {bytes(st.bytesOut)}
            </span>
          </>
        )}
        {st.state === 'error' && <span style={{ color: 'var(--red)' }}>{st.message}</span>}
      </div>

      {expanded && (
        <>
          <div className="divider" />
          {!editing ? (
            <div className="flex" style={{ justifyContent: 'space-between' }}>
              <div className="muted">
                Baseline for this VPN:&nbsp;<b>{vpn.defaultPolicy}</b>
              </div>
              <div className="flex">
                <button className="btn btn-sm" onClick={() => setEditing(true)}>
                  Edit settings
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => api.removeVpn(vpn.id).then(refresh)}>
                  Remove VPN
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="row">
                <div className="field">
                  <label>Name</label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="field">
                  <label>Default policy</label>
                  <select
                    value={form.defaultPolicy}
                    onChange={(e) => setForm({ ...form, defaultPolicy: e.target.value })}
                  >
                    <option value="direct">direct (only listed rules use this VPN)</option>
                    <option value="proxy">proxy (mark as candidate default exit)</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Config file (.ovpn)</label>
                <div className="flex">
                  <input
                    type="text"
                    style={{ flex: 1 }}
                    value={form.configPath}
                    onChange={(e) => setForm({ ...form, configPath: e.target.value })}
                  />
                  <button className="btn btn-sm" onClick={pickConfig}>
                    Browse…
                  </button>
                </div>
              </div>
              <div className="row">
                <div className="field">
                  <label>Username (optional)</label>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Password (optional)</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex">
                <button className="btn btn-primary btn-sm" onClick={save}>
                  Save
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="rules-head" style={{ marginTop: 18 }}>
            <h4>Per-VPN rules</h4>
            <span className="muted" style={{ fontSize: 12 }}>
              proxy = force through this VPN · direct = force direct
            </span>
          </div>
          <RuleEditor
            rules={vpn.rules || []}
            vpns={[]}
            scope="vpn"
            onAdd={(rule) => api.addVpnRule(vpn.id, rule).then(refresh)}
            onUpdate={(ruleId, patch) => api.updateVpnRule(vpn.id, ruleId, patch).then(refresh)}
            onRemove={(ruleId) => api.removeVpnRule(vpn.id, ruleId).then(refresh)}
          />
        </>
      )}
    </div>
  )
}
