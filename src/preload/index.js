import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getState: () => ipcRenderer.invoke('app:getState'),
  getLogs: () => ipcRenderer.invoke('app:getLogs'),

  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  detectOpenvpn: () => ipcRenderer.invoke('settings:detectOpenvpn'),
  pickOpenvpn: () => ipcRenderer.invoke('settings:pickOpenvpn'),

  pickConfig: () => ipcRenderer.invoke('vpn:pickConfig'),
  addVpn: (vpn) => ipcRenderer.invoke('vpn:add', vpn),
  updateVpn: (id, patch) => ipcRenderer.invoke('vpn:update', { id, patch }),
  removeVpn: (id) => ipcRenderer.invoke('vpn:remove', id),
  connectVpn: (id) => ipcRenderer.invoke('vpn:connect', id),
  disconnectVpn: (id) => ipcRenderer.invoke('vpn:disconnect', id),

  addGlobalRule: (rule) => ipcRenderer.invoke('rule:addGlobal', rule),
  updateGlobalRule: (id, patch) => ipcRenderer.invoke('rule:updateGlobal', { id, patch }),
  removeGlobalRule: (id) => ipcRenderer.invoke('rule:removeGlobal', id),

  addVpnRule: (vpnId, rule) => ipcRenderer.invoke('rule:addVpn', { vpnId, rule }),
  updateVpnRule: (vpnId, ruleId, patch) => ipcRenderer.invoke('rule:updateVpn', { vpnId, ruleId, patch }),
  removeVpnRule: (vpnId, ruleId) => ipcRenderer.invoke('rule:removeVpn', { vpnId, ruleId }),

  reconcile: () => ipcRenderer.invoke('router:reconcile'),

  onVpnStatus: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('vpn:status', handler)
    return () => ipcRenderer.removeListener('vpn:status', handler)
  },
  onLog: (cb) => {
    const handler = (_e, entry) => cb(entry)
    ipcRenderer.on('log:entry', handler)
    return () => ipcRenderer.removeListener('log:entry', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
