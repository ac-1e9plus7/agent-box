import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type {
  AgentboxAPI,
  AppSettings,
  BrowserEvent,
  ChatRequest,
  Conversation,
  ExportBackupInput,
  ModelInput,
  ProviderInput,
  SkillInput,
  StreamEvent,
  ToolApprovalDecision,
} from '../shared/types'

const streamListeners = new Set<(event: StreamEvent) => void>()
const browserListeners = new Set<(event: BrowserEvent) => void>()

ipcRenderer.on(IPC_CHANNELS.chatEvent, (_event, streamEvent: StreamEvent) => {
  for (const listener of streamListeners) {
    try {
      listener(streamEvent)
    } catch (error) {
      console.error('Chat stream listener failed', error)
    }
  }
})

ipcRenderer.on(IPC_CHANNELS.browserEvent, (_event, browserEvent: BrowserEvent) => {
  for (const listener of browserListeners) {
    try {
      listener(browserEvent)
    } catch (error) {
      console.error('Browser event listener failed', error)
    }
  }
})

const agentboxApi: AgentboxAPI = {
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.providersList),
    upsert: (input: ProviderInput) => ipcRenderer.invoke(IPC_CHANNELS.providersUpsert, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.providersRemove, id),
    test: (input: ProviderInput) => ipcRenderer.invoke(IPC_CHANNELS.providersTest, input),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),
    upsert: (input: ModelInput) => ipcRenderer.invoke(IPC_CHANNELS.modelsUpsert, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsRemove, id),
    discover: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsDiscover, providerId),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.skillsList),
    upsert: (input: SkillInput) => ipcRenderer.invoke(IPC_CHANNELS.skillsUpsert, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.skillsRemove, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.skillsToggle, id, enabled),
    resetDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.skillsResetDefaults),
  },
  mcp: {
    listServers: () => ipcRenderer.invoke(IPC_CHANNELS.mcpListServers),
    upsertServer: (input) => ipcRenderer.invoke(IPC_CHANNELS.mcpUpsertServer, input),
    removeServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.mcpRemoveServer, id),
    toggleServer: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.mcpToggleServer, id, enabled),
    testServer: (input) => ipcRenderer.invoke(IPC_CHANNELS.mcpTestServer, input),
    listTools: (serverId?: string) => ipcRenderer.invoke(IPC_CHANNELS.mcpListTools, serverId),
  },
  terminal: {
    testShell: (config) => ipcRenderer.invoke(IPC_CHANNELS.terminalTestShell, config),
  },
  workspace: {
    getDefaultDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGetDefaultDirectory),
    selectDirectory: (initialPath?: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSelectDirectory, initialPath),
  },
  runtimes: {
    test: (kind, settings, workingDirectory?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimeTest, kind, settings, workingDirectory),
    listCondaEnvironments: (condaExecutable: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.runtimeListCondaEnvironments, condaExecutable),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.conversationsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationsGet, id),
    save: (conversation: Conversation) => ipcRenderer.invoke(IPC_CHANNELS.conversationsSave, conversation),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationsRemove, id),
  },
  data: {
    exportBackup: (input: ExportBackupInput) => ipcRenderer.invoke(IPC_CHANNELS.dataExportBackup, input),
    clearConversations: () => ipcRenderer.invoke(IPC_CHANNELS.dataClearConversations),
  },
  chat: {
    stream: (request: ChatRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatStart, request),
    cancel: (requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.chatCancel, requestId),
    resolveToolApproval: (requestId: string, callId: string, decision: ToolApprovalDecision) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatResolveToolApproval, requestId, callId, decision),
    onEvent: (listener: (event: StreamEvent) => void) => {
      streamListeners.add(listener)
      return () => streamListeners.delete(listener)
    },
  },
  browser: {
    ensure: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.browserEnsure, conversationId),
    navigate: (conversationId: string, url: string, tabId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, conversationId, url, tabId),
    command: (conversationId, command, tabId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserCommand, conversationId, command, tabId),
    newTab: (conversationId: string, url?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserNewTab, conversationId, url),
    switchTab: (conversationId: string, tabId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserSwitchTab, conversationId, tabId),
    closeTab: (conversationId: string, tabId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserCloseTab, conversationId, tabId),
    setViewState: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserSetViewState, input),
    close: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.browserClose, conversationId),
    onEvent: (listener: (event: BrowserEvent) => void) => {
      browserListeners.add(listener)
      return () => browserListeners.delete(listener)
    },
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
  },
}

if (!process.contextIsolated) {
  throw new Error('AgentBox requires Electron context isolation.')
}

contextBridge.exposeInMainWorld('agentbox', deepFreeze(agentboxApi))

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}
