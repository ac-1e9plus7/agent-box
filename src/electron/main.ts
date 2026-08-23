import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { ChatGateway } from './api/gateway'
import { registerIpcHandlers } from './ipc/register-ipc'
import { McpManager } from './mcp/mcp-manager'
import { AppRepository } from './storage/app-repository'
import { languageFromSystemLocale, setLanguage, t } from '../shared/i18n'

let mainWindow: BrowserWindow | undefined
let repository: AppRepository | undefined
let gateway: ChatGateway | undefined
let mcpManager: McpManager | undefined
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
    title: 'AgentBox',
    icon: join(__dirname, '../../build/icon.png'),
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
  const systemLanguage = languageFromSystemLocale(app.getLocale())
  setLanguage(systemLanguage)
  repository = new AppRepository(app.getPath('userData'), systemLanguage)
  await repository.initialize()
  setLanguage(repository.getSettings().language)
  mcpManager = new McpManager(repository)
  gateway = new ChatGateway(repository, mcpManager)
  openMainWindow()
}

function openMainWindow(): void {
  if (!repository || !gateway || !mcpManager) throw new Error('Application services are unavailable')
  const window = createWindow()
  mainWindow = window
  unregisterIpc = registerIpcHandlers(window, repository, gateway, mcpManager)
  window.on('closed', () => {
    gateway?.cancelAll()
    void mcpManager?.closeAll().catch(() => {})
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

function migrateLegacyUserDataDirectory(): void {
  try {
    const currentPath = app.getPath('userData')
    const currentVaultFile = join(currentPath, 'vault', 'user-data.v1.enc')
    const currentLocalState = join(currentPath, 'Local State')

    if (existsSync(currentVaultFile)) return

    const parentDir = dirname(currentPath)
    const legacyCandidates = ['chatbox-lite', 'ChatBox Lite', 'ChatBoxLite', 'chatbox']
    for (const legacyName of legacyCandidates) {
      const legacyPath = join(parentDir, legacyName)
      if (legacyPath.toLowerCase() === currentPath.toLowerCase()) continue

      const legacyVaultFile = join(legacyPath, 'vault', 'user-data.v1.enc')
      const legacyKeyFile = join(legacyPath, 'vault', 'master-key.bin')
      const legacyLocalState = join(legacyPath, 'Local State')

      if (existsSync(legacyVaultFile) && existsSync(legacyKeyFile)) {
        mkdirSync(join(currentPath, 'vault'), { recursive: true })

        // Copy Local State before safeStorage initializes so DPAPI/OSCrypt key matches
        if (existsSync(legacyLocalState)) {
          copyFileSync(legacyLocalState, currentLocalState)
        }

        copyFileSync(legacyKeyFile, join(currentPath, 'vault', 'master-key.bin'))
        copyFileSync(legacyVaultFile, join(currentPath, 'vault', 'user-data.v1.enc'))
        break
      }
    }
  } catch {
    // Non-fatal migration attempt
  }
}

async function handleStartupFailure(error: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : t("未知错误")
  const normalizedErrorMessage = errorMessage.toLowerCase()
  const isDecryptionError = [t("解密"), 'decrypt', 'safeStorage', t("系统密钥")]
    .some((marker) => normalizedErrorMessage.includes(marker.toLowerCase()))

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: t("AgentBox - 数据加载提示"),
    message: isDecryptionError
      ? t("无法解密现有的本地数据（可能是系统凭据发生变化、数据文件损坏或迁移密钥不匹配）。")
      : t("应用启动遇到问题：{value0}", { value0: errorMessage }),
    detail: isDecryptionError
      ? t("您可以选择【重置并创建新数据】（现有文件将被安全备份为 .bak，应用将以初始状态启动），或选择【退出应用】以便稍后手动排查。")
      : t("您可以选择重置本地数据并重新启动，或退出应用。"),
    buttons: [t("重置并创建新数据（推荐）"), t("退出应用")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })

  if (choice === 0) {
    try {
      const currentPath = app.getPath('userData')
      const vaultPath = join(currentPath, 'vault')
      if (existsSync(vaultPath)) {
        const backupPath = join(
          currentPath,
          `vault.corrupted.${Date.now()}.bak`,
        )
        renameSync(vaultPath, backupPath)
      }
      await start()
      return
    } catch (resetError) {
      dialog.showErrorBox(
        t("重置数据失败"),
        t("无法重置本地数据：{value0}", { value0: resetError instanceof Error ? resetError.message : String(resetError) }),
      )
    }
  }

  app.quit()
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
    app.setAppUserModelId('com.agentbox.desktop')
    try {
      migrateLegacyUserDataDirectory()
      await start()
    } catch (error) {
      await handleStartupFailure(error)
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
