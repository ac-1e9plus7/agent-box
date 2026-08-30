import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type {
  AppSettings,
  BrowserCommand,
  ChatRequest,
  Conversation,
  DeveloperRuntimeKind,
  DeveloperRuntimeSettings,
  ExportBackupInput,
  IntegratedTerminalShellConfig,
  McpServerInput,
  ModelInput,
  ProviderInput,
  StreamEvent,
  ToolApprovalDecision,
} from '../../shared/types'
import { ChatGateway } from '../api/gateway'
import { McpManager } from '../mcp/mcp-manager'
import { AppRepository } from '../storage/app-repository'
import { testIntegratedTerminalShell } from '../api/terminal-shell'
import { listCondaEnvironments, testDeveloperRuntime } from '../api/runtime-environments'
import { normalizeDeveloperRuntimes, normalizeIntegratedTerminalShell } from '../storage/settings-schema'
import { createBackupArchive, createBackupFileName, normalizeExportBackupInput } from '../backup/backup-export'
import { setLanguage } from '../../shared/i18n'
import { t } from '../../shared/i18n'
import { BrowserManager } from '../browser/browser-manager'
import { ensureDefaultAgentBoxWorkspace } from '../api/default-workspace'

export function registerIpcHandlers(
  window: BrowserWindow,
  repository: AppRepository,
  gateway: ChatGateway,
  mcpManager: McpManager,
  browserManager: BrowserManager,
): () => void {
  let backupExportInProgress = false
  const register = <Arguments extends unknown[], Result>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: Arguments) => Result,
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, window)
      return handler(event, ...(args as Arguments))
    })
  }

  register(IPC_CHANNELS.settingsGet, () => {
    const settings = repository.getSettings()
    return {
      ...settings,
      proxy: { ...settings.proxy, url: maskProxyUrl(settings.proxy.url) },
    }
  })
  register(IPC_CHANNELS.settingsUpdate, (_event, patch: Partial<AppSettings>) => {
    assertRecord(patch, t('Settings'))
    const current = repository.getSettings()
    if (patch.proxy !== undefined && patch.proxy.url !== undefined) {
      patch.proxy.url = unmaskProxyUrl(patch.proxy.url, current.proxy.url)
    }
    return repository.updateSettings(patch).then(async (settings) => {
      setLanguage(settings.language)
      await browserManager.onSettingsChanged(current, settings)
      return {
        ...settings,
        proxy: { ...settings.proxy, url: maskProxyUrl(settings.proxy.url) },
      }
    })
  })

  register(IPC_CHANNELS.providersList, () => repository.listProviders())
  register(IPC_CHANNELS.providersUpsert, (_event, input: ProviderInput) => {
    assertRecord(input, t('Provider configuration'))
    return repository.upsertProvider(input)
  })
  register(IPC_CHANNELS.providersRemove, (_event, id: string) => {
    assertId(id)
    return repository.removeProvider(id)
  })
  register(IPC_CHANNELS.providersTest, (_event, input: ProviderInput) => {
    assertRecord(input, t('Provider configuration'))
    return gateway.testProvider(repository.buildProviderCandidate(input))
  })

  register(IPC_CHANNELS.modelsList, () => repository.listModels())
  register(IPC_CHANNELS.modelsUpsert, (_event, input: ModelInput) => {
    assertRecord(input, t('Model configuration'))
    return repository.upsertModel(input)
  })
  register(IPC_CHANNELS.modelsRemove, (_event, id: string) => {
    assertId(id)
    return repository.removeModel(id)
  })
  register(IPC_CHANNELS.modelsDiscover, (_event, providerId: string) => {
    assertId(providerId)
    return gateway.discoverModels(providerId)
  })

  register(IPC_CHANNELS.skillsList, () => repository.listSkills())
  register(IPC_CHANNELS.skillsUpsert, (_event, input: Parameters<typeof repository.upsertSkill>[0]) => {
    assertRecord(input, t('Skill configuration'))
    return repository.upsertSkill(input)
  })
  register(IPC_CHANNELS.skillsRemove, (_event, id: string) => {
    assertId(id)
    return repository.removeSkill(id)
  })
  register(IPC_CHANNELS.skillsToggle, (_event, id: string, enabled: boolean) => {
    assertId(id)
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled state')
    return repository.toggleSkill(id, enabled)
  })
  register(IPC_CHANNELS.skillsResetDefaults, () => repository.resetDefaultSkills())

  register(IPC_CHANNELS.mcpListServers, () => repository.listMcpServerViews())
  register(IPC_CHANNELS.mcpUpsertServer, (_event, input: McpServerInput) => {
    assertRecord(input, t('MCP server configuration'))
    return repository.upsertMcpServer(input).then((server) => repository.toMcpServerView(server))
  })
  register(IPC_CHANNELS.mcpRemoveServer, (_event, id: string) => {
    assertId(id)
    return repository.removeMcpServer(id)
  })
  register(IPC_CHANNELS.mcpToggleServer, (_event, id: string, enabled: boolean) => {
    assertId(id)
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled state')
    return repository.toggleMcpServer(id, enabled).then((server) => repository.toMcpServerView(server))
  })
  register(IPC_CHANNELS.mcpTestServer, (_event, input: McpServerInput) => {
    assertRecord(input, t('MCP server configuration'))
    return mcpManager.testServer(repository.buildMcpServerCandidate(input))
  })
  register(IPC_CHANNELS.mcpListTools, (_event, serverId?: string) => {
    if (serverId !== undefined) assertId(serverId)
    return mcpManager.listAllTools(serverId ? [serverId] : undefined)
  })

  register(IPC_CHANNELS.terminalTestShell, (_event, input: IntegratedTerminalShellConfig) => {
    assertRecord(input, t('Terminal shell configuration'))
    return testIntegratedTerminalShell(normalizeIntegratedTerminalShell(input))
  })

  register(IPC_CHANNELS.workspaceGetDefaultDirectory, async () => {
    try {
      return await ensureDefaultAgentBoxWorkspace(app.getPath('exe'))
    } catch (error) {
      throw new Error(
        t('Could not prepare the default working directory: {value0}', {
          value0: error instanceof Error ? error.message : String(error),
        }),
        { cause: error },
      )
    }
  })

  register(IPC_CHANNELS.workspaceSelectDirectory, async (_event, initialPath?: string) => {
    if (initialPath !== undefined && typeof initialPath !== 'string')
      throw new Error(t('The working directory is invalid.'))
    const result = await dialog.showOpenDialog(window, {
      title: t('Choose conversation working directory'),
      defaultPath: initialPath && isAbsolute(initialPath) ? initialPath : app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return undefined
    return resolve(result.filePaths[0])
  })

  register(
    IPC_CHANNELS.runtimeTest,
    (_event, kind: DeveloperRuntimeKind, settings: DeveloperRuntimeSettings, workingDirectory?: string) => {
      if (!['jdk', 'go', 'php', 'python'].includes(String(kind))) throw new Error(t('Invalid runtime type.'))
      if (workingDirectory !== undefined && (typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory))) {
        throw new Error(t('The working directory is invalid.'))
      }
      return testDeveloperRuntime(kind, normalizeDeveloperRuntimes(settings), workingDirectory)
    },
  )

  register(IPC_CHANNELS.runtimeListCondaEnvironments, (_event, condaExecutable: string) => {
    if (typeof condaExecutable !== 'string') throw new Error(t('The Conda executable is invalid.'))
    return listCondaEnvironments(condaExecutable)
  })

  register(IPC_CHANNELS.conversationsList, () => repository.listConversations())
  register(IPC_CHANNELS.conversationsGet, (_event, id: string) => {
    assertId(id)
    return repository.getConversation(id)
  })
  register(IPC_CHANNELS.conversationsSave, (_event, conversation: Conversation) => {
    assertRecord(conversation, t('conversation'))
    return repository.saveConversation(conversation)
  })
  register(IPC_CHANNELS.conversationsRemove, async (_event, id: string) => {
    assertId(id)
    await browserManager.close(id)
    return repository.removeConversation(id)
  })

  register(IPC_CHANNELS.dataExportBackup, async (_event, input: ExportBackupInput) => {
    assertRecord(input, t('Backup options'))
    const normalizedInput = normalizeExportBackupInput(input)
    if (backupExportInProgress) throw new Error(t('A backup export is already in progress. Wait for it to finish.'))

    backupExportInProgress = true
    try {
      const conversations = repository.listConversations()
      const result = await dialog.showSaveDialog(window, {
        title: normalizedInput.mode === 'deep' ? t('Export AgentBox deep backup') : t('Export AgentBox shallow backup'),
        buttonLabel: t('Export backup'),
        defaultPath: join(app.getPath('documents'), createBackupFileName(normalizedInput.mode)),
        filters: [{ name: t('ZIP backup'), extensions: ['zip'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      if (result.canceled || !result.filePath) {
        return {
          canceled: true,
          mode: normalizedInput.mode,
          encrypted: Boolean(normalizedInput.password),
          conversationCount: conversations.length,
          workspaceCount: 0,
        }
      }

      return await createBackupArchive({
        outputPath: resolve(result.filePath),
        input: normalizedInput,
        conversations,
        appInfo: {
          name: app.getName(),
          version: app.getVersion(),
          platform: process.platform,
        },
        protectedPaths: [app.getPath('userData')],
      })
    } finally {
      backupExportInProgress = false
    }
  })

  register(IPC_CHANNELS.dataClearConversations, async () => {
    gateway.cancelAll()
    await browserManager.closeAll()
    return repository.clearConversations()
  })

  register(IPC_CHANNELS.chatStart, (event, request: ChatRequest) => {
    assertRecord(request, t('chat request'))
    const requestId = randomUUID()
    const sender = event.sender
    const emit = (streamEvent: StreamEvent): void => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.chatEvent, streamEvent)
    }
    void gateway.stream(requestId, request, emit)
    return { requestId }
  })
  register(IPC_CHANNELS.chatCancel, (_event, requestId: string) => {
    assertId(requestId)
    gateway.cancel(requestId)
  })
  register(
    IPC_CHANNELS.chatResolveToolApproval,
    (_event, requestId: string, callId: string, decision: ToolApprovalDecision) => {
      assertId(requestId)
      assertId(callId)
      if (!isRecord(decision) || !['deny', 'allow-once', 'allow-browser-origin'].includes(String(decision.decision))) {
        throw new Error('Invalid tool approval decision')
      }
      gateway.resolveToolApproval(requestId, callId, decision)
    },
  )

  const unsubscribeBrowserState = browserManager.onEvent((browserEvent) => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.browserEvent, browserEvent)
  })
  register(IPC_CHANNELS.browserEnsure, (_event, conversationId: string) => {
    assertId(conversationId)
    return browserManager.ensure(conversationId)
  })
  register(IPC_CHANNELS.browserNavigate, (_event, conversationId: string, url: string, tabId?: string) => {
    assertId(conversationId)
    if (typeof url !== 'string') throw new Error(t('The browser URL is invalid.'))
    if (tabId !== undefined) assertId(tabId)
    return browserManager.navigate(conversationId, url, { tabId })
  })
  register(IPC_CHANNELS.browserCommand, (_event, conversationId: string, command: BrowserCommand, tabId?: string) => {
    assertId(conversationId)
    if (tabId !== undefined) assertId(tabId)
    if (!['back', 'forward', 'reload', 'stop'].includes(String(command))) {
      throw new Error(t('The browser command is invalid.'))
    }
    return browserManager.command(conversationId, command, tabId)
  })
  register(IPC_CHANNELS.browserNewTab, (_event, conversationId: string, url?: string) => {
    assertId(conversationId)
    if (url !== undefined && typeof url !== 'string') throw new Error(t('The browser URL is invalid.'))
    return browserManager.newTab(conversationId, url)
  })
  register(IPC_CHANNELS.browserSwitchTab, (_event, conversationId: string, tabId: string) => {
    assertId(conversationId)
    assertId(tabId)
    return browserManager.switchTab(conversationId, tabId)
  })
  register(IPC_CHANNELS.browserCloseTab, (_event, conversationId: string, tabId: string) => {
    assertId(conversationId)
    assertId(tabId)
    return browserManager.requestCloseTab(conversationId, tabId)
  })
  register(IPC_CHANNELS.browserSetViewState, (_event, input: unknown) => {
    assertRecord(input, t('Browser view state'))
    assertId(input.conversationId)
    if (typeof input.visible !== 'boolean' || !isRecord(input.bounds)) {
      throw new Error(t('The browser view state is invalid.'))
    }
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (typeof input.bounds[field] !== 'number' || !Number.isFinite(input.bounds[field])) {
        throw new Error(t('The browser view bounds are invalid.'))
      }
    }
    return browserManager.setViewState({
      conversationId: input.conversationId,
      visible: input.visible,
      bounds: {
        x: Number(input.bounds.x),
        y: Number(input.bounds.y),
        width: Number(input.bounds.width),
        height: Number(input.bounds.height),
      },
    })
  })
  register(IPC_CHANNELS.browserClose, (_event, conversationId: string) => {
    assertId(conversationId)
    return browserManager.requestClose(conversationId)
  })
  register(IPC_CHANNELS.browserCancelPendingClose, (_event, conversationId: string) => {
    assertId(conversationId)
    return browserManager.cancelPendingClose(conversationId)
  })

  register(IPC_CHANNELS.appGetInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }))

  return () => {
    unsubscribeBrowserState()
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.chatEvent && channel !== IPC_CHANNELS.browserEvent) ipcMain.removeHandler(channel)
    }
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error(t('Deny IPC requests from unknown rendering processes.'))
  }
  const frameUrl = event.senderFrame?.url
  if (!frameUrl || !isTrustedMainPage(frameUrl)) {
    throw new Error(t('Deny IPC requests from unknown pages.'))
  }
}

function isTrustedMainPage(value: string): boolean {
  try {
    const actual = new URL(value)
    if (process.env.ELECTRON_RENDERER_URL) {
      const expected = new URL(process.env.ELECTRON_RENDERER_URL)
      return actual.origin === expected.origin && actual.pathname === expected.pathname
    }
    actual.hash = ''
    actual.search = ''
    const expected = pathToFileURL(join(__dirname, '../renderer/index.html'))
    return actual.href === expected.href
  } catch {
    return false
  }
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error(t('Invalid ID.'))
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(t('{value0} is invalid.', { value0: label }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskProxyUrl(url: string): string {
  if (!url) return url
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      if (parsed.username) parsed.username = '***'
      if (parsed.password) parsed.password = '***'
      return parsed.toString()
    }
  } catch {}
  return url
}

function unmaskProxyUrl(newUrl: string, oldUrl: string): string {
  if (newUrl === maskProxyUrl(oldUrl)) return oldUrl
  return newUrl
}

export { maskProxyUrl, unmaskProxyUrl, isTrustedMainPage }
