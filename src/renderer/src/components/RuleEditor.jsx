import React, { useState } from 'react'

const emptyDraft = { type: 'domain-suffix', value: '', action: 'proxy', vpnId: '' }

const TYPE_OPTIONS = [
  { value: 'domain', label: 'domain (exact)' },
  { value: 'domain-suffix', label: 'domain-suffix' },
  { value: 'domain-wildcard', label: 'wildcard (*)' },
  { value: 'domain-keyword', label: 'keyword' },
  { value: 'domain-regex', label: 'regex' },
  { value: 'ip', label: 'ip / cidr' }
]

function placeholderFor(type) {
  switch (type) {
    case 'ip':
      return '1.2.3.4 or 10.0.0.0/24'
    case 'domain-wildcard':
      return '*.example.com'
    case 'domain-keyword':
      return 'google'
    case 'domain-regex':
      return '.*\\.example\\.(com|net)$'
    case 'domain-suffix':
      return 'example.com (matches sub.example.com)'
    default:
      return 'www.example.com'
  }
}

export default function RuleEditor({ rules, vpns, scope, onAdd, onUpdate, onRemove }) {
  const [draft, setDraft] = useState(emptyDraft)
  const isGlobal = scope === 'global'

  const connectedVpns = vpns
  const submit = () => {
    if (!draft.value.trim()) return
    const rule = {
      type: draft.type,
      value: draft.value.trim(),
      action: draft.action
    }
    if (isGlobal && draft.action === 'proxy') {
      if (!draft.vpnId) return
      rule.vpnId = draft.vpnId
    }
    onAdd(rule)
    setDraft({ ...emptyDraft, type: draft.type, action: draft.action, vpnId: draft.vpnId })
  }

  const vpnName = (id) => {
    const v = vpns.find((x) => x.id === id)
    return v ? v.name : '—'
  }

  return (
    <div className="rules">
      <div className="rule-row header">
        <div>Type</div>
        <div>Domain / IP / CIDR</div>
        <div>Action</div>
        <div>{isGlobal ? 'Via VPN' : 'Enabled'}</div>
        <div></div>
      </div>

      {rules.length === 0 && <div className="empty">No rules yet</div>}

      {rules.map((r) => (
        <div className="rule-row" key={r.id}>
          <span className="tag">{r.type}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.value}>
            {r.value}
          </span>
          <span>
            <select value={r.action} onChange={(e) => onUpdate(r.id, { action: e.target.value })}>
              <option value="proxy">proxy</option>
              <option value="direct">direct</option>
            </select>
          </span>
          <span>
            {isGlobal && r.action === 'proxy' ? (
              <select value={r.vpnId || ''} onChange={(e) => onUpdate(r.id, { vpnId: e.target.value })}>
                <option value="">select…</option>
                {connectedVpns.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            ) : isGlobal ? (
              <span className="muted">—</span>
            ) : (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={r.enabled !== false}
                  onChange={(e) => onUpdate(r.id, { enabled: e.target.checked })}
                />
                on
              </label>
            )}
          </span>
          <button className="btn-ghost" title="Delete" onClick={() => onRemove(r.id)}>
            ✕
          </button>
        </div>
      ))}

      <div className="rule-row" style={{ marginTop: 8 }}>
        <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder={placeholderFor(draft.type)}
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
          <option value="proxy">proxy</option>
          <option value="direct">direct</option>
        </select>
        {isGlobal && draft.action === 'proxy' ? (
          <select value={draft.vpnId} onChange={(e) => setDraft({ ...draft, vpnId: e.target.value })}>
            <option value="">via VPN…</option>
            {connectedVpns.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            {isGlobal ? '—' : 'this VPN'}
          </span>
        )}
        <button className="btn btn-primary btn-sm" onClick={submit}>
          +
        </button>
      </div>
    </div>
  )
}
