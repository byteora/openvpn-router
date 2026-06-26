import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { getStore } from './services/store.js'
import { vpnManager } from './services/vpnManager.js'
import { orchestrator } from './services/router.js'
import { dnsRouter } from './services/dnsRouter.js'
import { logger } from './services/logger.js'
import { platform } from './platform/index.js'

export function registerIpc(getWindow) {
  const store = getStore()

  const send = (channel, payload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // ---- live event forwarding ------------------------------------------------
  vpnManager.on('status', (vpnId, status) => send('vpn:status', { vpnId, status }))
  logger.on('log', (entry) => send('log:entry', entry))

  const snapshot = () => ({
    ...store.getState(),
    statuses: vpnManager.getAllStatuses(),
    dns: dnsRouter.getStatus(),
    platform: { name: platform.name, displayName: platform.displayName }
  })

  ipcMain.handle('app:getState', () => snapshot())
  ipcMain.handle('app:getLogs', () => logger.history())

  // ---- settings -------------------------------------------------------------
  ipcMain.handle('settings:update', (_e, patch) => {
    const s = store.updateSettings(patch)
    orchestrator.onRulesChanged()
    return s
  })

  ipcMain.handle('settings:detectOpenvpn', async () => {
    const found = await platform.locateOpenvpn()
    if (found) store.updateSettings({ openvpnPath: found })
    return found
  })

  ipcMain.handle('settings:pickOpenvpn', async () => {
    const win = getWindow()
    const filters =
      process.platform === 'win32'
        ? [
            { name: 'OpenVPN binary', extensions: ['exe'] },
            { name: 'All files', extensions: ['*'] }
          ]
        : [{ name: 'All files', extensions: ['*'] }]
    const res = await dialog.showOpenDialog(win, {
      title: 'Select the openvpn binary',
      filters,
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths.length) return null
    store.updateSettings({ openvpnPath: res.filePaths[0] })
    return res.filePaths[0]
  })

  // ---- vpns -----------------------------------------------------------------
  ipcMain.handle('vpn:pickConfig', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win, {
      title: 'Select an OpenVPN config (.ovpn)',
      filters: [
        { name: 'OpenVPN config', extensions: ['ovpn', 'conf'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  ipcMain.handle('vpn:add', (_e, vpn) => {
    if (vpn.configPath && !vpn.name) {
      vpn.name = path.basename(vpn.configPath).replace(/\.(ovpn|conf)$/i, '')
    }
    return store.addVpn(vpn)
  })

  ipcMain.handle('vpn:update', (_e, { id, patch }) => {
    const v = store.updateVpn(id, patch)
    orchestrator.onRulesChanged()
    return v
  })

  ipcMain.handle('vpn:remove', (_e, id) => {
    if (vpnManager.isConnected(id)) vpnManager.disconnect(id)
    store.removeVpn(id)
    orchestrator.schedule()
    return snapshot()
  })

  ipcMain.handle('vpn:connect', async (_e, id) => {
    const vpn = store.getVpn(id)
    if (!vpn) throw new Error('VPN not found')
    await vpnManager.connect(vpn, store.getState().settings)
    return vpnManager.getStatus(id)
  })

  ipcMain.handle('vpn:disconnect', (_e, id) => {
    vpnManager.disconnect(id)
    return vpnManager.getStatus(id)
  })

  // ---- rules ----------------------------------------------------------------
  ipcMain.handle('rule:addGlobal', (_e, rule) => {
    const r = store.addGlobalRule(rule)
    orchestrator.onRulesChanged()
    return r
  })
  ipcMain.handle('rule:updateGlobal', (_e, { id, patch }) => {
    const r = store.updateGlobalRule(id, patch)
    orchestrator.onRulesChanged()
    return r
  })
  ipcMain.handle('rule:removeGlobal', (_e, id) => {
    store.removeGlobalRule(id)
    orchestrator.onRulesChanged()
    return true
  })

  ipcMain.handle('rule:addVpn', (_e, { vpnId, rule }) => {
    const r = store.addVpnRule(vpnId, rule)
    orchestrator.onRulesChanged()
    return r
  })
  ipcMain.handle('rule:updateVpn', (_e, { vpnId, ruleId, patch }) => {
    const r = store.updateVpnRule(vpnId, ruleId, patch)
    orchestrator.onRulesChanged()
    return r
  })
  ipcMain.handle('rule:removeVpn', (_e, { vpnId, ruleId }) => {
    store.removeVpnRule(vpnId, ruleId)
    orchestrator.onRulesChanged()
    return true
  })

  // ---- routing --------------------------------------------------------------
  ipcMain.handle('router:reconcile', async () => {
    await orchestrator.reconcile()
    return true
  })

  ipcMain.handle('config:reveal', () => {
    const file = path.join(getStore().file)
    return fs.existsSync(file) ? file : null
  })
}
