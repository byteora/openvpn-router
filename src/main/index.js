import { app, BrowserWindow, shell, dialog } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { registerIpc } from './ipc.js'
import { orchestrator } from './services/router.js'
import { vpnManager } from './services/vpnManager.js'
import { getStore } from './services/store.js'
import { logger } from './services/logger.js'
import { platform, isSupportedPlatform } from './platform/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow = null

/**
 * This app requires elevated rights (it edits the routing table and configures
 * system DNS). If not elevated we either relaunch ourselves with an OS auth
 * prompt (packaged build) or instruct the user to use an elevated shell (dev),
 * then quit this instance.
 *
 * @returns {Promise<boolean>} true if we may continue, false if we are quitting
 */
async function ensureElevated() {
  if (!isSupportedPlatform) {
    logger.warn('app', `platform "${process.platform}" is not officially supported`)
  }
  if (await platform.isElevated()) return true

  if (app.isPackaged && platform.relaunchElevated()) {
    app.exit(0)
    return false
  }

  dialog.showErrorBox('Elevated privileges required', platform.elevationInstructions())
  app.exit(1)
  return false
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  if (!(await ensureElevated())) return

  getStore()
  orchestrator.init()
  registerIpc(() => mainWindow)
  createWindow()
  logger.info('app', `Running elevated on ${platform.displayName}.`)

  // make sure we have a usable openvpn binary; auto-detect if not
  const store = getStore()
  const currentPath = store.getState().settings.openvpnPath
  if (!(await platform.isRunnable(currentPath))) {
    const found = await platform.locateOpenvpn()
    if (found) {
      store.updateSettings({ openvpnPath: found })
      logger.info('app', `auto-detected OpenVPN binary at ${found}`)
    } else {
      logger.warn('app', `OpenVPN binary "${currentPath}" not found — set it in Settings`)
    }
  }

  // auto-connect flagged VPNs
  for (const vpn of store.getState().vpns) {
    if (vpn.autoConnect) {
      vpnManager.connect(vpn, store.getState().settings).catch((e) => logger.error('app', e.message))
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let cleaningUp = false
app.on('before-quit', async (event) => {
  if (cleaningUp) return
  event.preventDefault()
  cleaningUp = true
  logger.info('app', 'shutting down: disconnecting VPNs and clearing routes')
  try {
    await orchestrator.shutdown()
  } catch {
    /* ignore */
  }
  setTimeout(() => app.exit(0), 1500)
})
