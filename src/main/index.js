import { app, BrowserWindow, shell, dialog } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { registerIpc } from './ipc.js'
import { orchestrator } from './services/router.js'
import { vpnManager } from './services/vpnManager.js'
import { systemDns } from './services/systemDns.js'
import { singboxManager } from './services/singboxManager.js'
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

// Single instance: a second copy would fight over UDP port 53 and crash. Focus
// the existing window instead.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  if (!gotLock) return
  logger.clear()

  if (!(await ensureElevated())) return

  // Self-heal: if a previous run crashed while DNS was hijacked, restore it now
  // so the user is never stuck without name resolution.
  await systemDns.recover()

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
  app.quit()
})

/**
 * Best-effort SYNCHRONOUS cleanup for crash / signal paths, where the event
 * loop is dying and async work would never finish. The critical action is
 * restoring system DNS (otherwise the machine is left without name resolution).
 */
let emergencyDone = false
function emergencyCleanupSync() {
  if (emergencyDone) return
  emergencyDone = true
  try {
    singboxManager.stopSync()
  } catch {
    /* ignore */
  }
  try {
    systemDns.restoreSync()
  } catch {
    /* ignore */
  }
  try {
    vpnManager.disconnectAllSync()
  } catch {
    /* ignore */
  }
}

// Graceful async shutdown on a normal quit (window close / Cmd+Q / app.quit()).
let cleaningUp = false
app.on('before-quit', async (event) => {
  if (cleaningUp) return
  cleaningUp = true
  event.preventDefault()
  logger.info('app', 'shutting down: disconnecting VPNs, restoring DNS, clearing routes')
  const done = () => {
    emergencyCleanupSync() // safety net in case async restore raced
    app.exit(0)
  }
  // Hard cap so a hung command can never block quitting.
  const guard = setTimeout(done, 4000)
  try {
    await orchestrator.shutdown()
  } catch {
    /* ignore */
  }
  clearTimeout(guard)
  done()
})

// Last-resort sync cleanup whatever the exit path.
app.on('will-quit', () => emergencyCleanupSync())

// OS signals (e.g. Ctrl+C in `sudo npm run dev`, or system shutdown).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    emergencyCleanupSync()
    process.exit(0)
  })
}

// Crashes: restore DNS before dying so we don't strand the network.
process.on('uncaughtException', (err) => {
  try {
    logger.error('app', `uncaught exception: ${err && err.stack ? err.stack : err}`)
  } catch {
    /* ignore */
  }
  emergencyCleanupSync()
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  try {
    logger.error('app', `unhandled rejection: ${reason}`)
  } catch {
    /* ignore */
  }
})
