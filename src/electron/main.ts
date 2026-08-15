import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { ChatGateway } from './api/gateway'
import { registerIpcHandlers } from './ipc/register-ipc'
import { AppRepository } from './storage/app-repository'

let mainWindow: BrowserWindow | undefined
let repository: AppRepository | undefined
let gateway: ChatGateway | undefined
let unregisterIpc: (() => void) | undefined

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f8',
    title: 'ChatBox Lite',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

async function start(): Promise<void> {
  configureSessionSecurity()
  repository = new AppRepository(app.getPath('userData'))
  await repository.initialize()
  gateway = new ChatGateway(repository)
  openMainWindow()
}

function openMainWindow(): void {
  if (!repository || !gateway) throw new Error('Application services are unavailable')
  const window = createWindow()
  mainWindow = window
  unregisterIpc = registerIpcHandlers(window, repository, gateway)
  window.on('closed', () => {
    gateway?.cancelAll()
    unregisterIpc?.()
    unregisterIpc = undefined
    if (mainWindow === window) mainWindow = undefined
  })
}

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.chatboxlite.desktop')
    try {
      await start()
    } catch (error) {
      const message = error instanceof Error ? error.message : '应用初始化失败。'
      dialog.showErrorBox('ChatBox Lite 无法启动', message)
      app.quit()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && repository && gateway) {
        openMainWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  gateway?.cancelAll()
  unregisterIpc?.()
  repository?.destroy()
})
