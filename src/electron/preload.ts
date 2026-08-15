import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type {
  AppSettings,
  ChatboxAPI,
  ChatRequest,
  Conversation,
  ModelInput,
  ProviderInput,
  StreamEvent,
} from '../shared/types'

const streamListeners = new Set<(event: StreamEvent) => void>()

ipcRenderer.on(IPC_CHANNELS.chatEvent, (_event, streamEvent: StreamEvent) => {
  for (const listener of streamListeners) {
    try {
      listener(streamEvent)
    } catch (error) {
      console.error('Chat stream listener failed', error)
    }
  }
})

const chatboxApi: ChatboxAPI = {
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.providersList),
    upsert: (input: ProviderInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersUpsert, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.providersRemove, id),
    test: (input: ProviderInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersTest, input),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),
    upsert: (input: ModelInput) => ipcRenderer.invoke(IPC_CHANNELS.modelsUpsert, input),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsRemove, id),
    discover: (providerId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelsDiscover, providerId),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.conversationsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationsGet, id),
    save: (conversation: Conversation) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversationsSave, conversation),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationsRemove, id),
  },
  chat: {
    stream: (request: ChatRequest) => ipcRenderer.invoke(IPC_CHANNELS.chatStart, request),
    cancel: (requestId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancel, requestId),
    onEvent: (listener: (event: StreamEvent) => void) => {
      streamListeners.add(listener)
      return () => streamListeners.delete(listener)
    },
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
  },
}

if (!process.contextIsolated) {
  throw new Error('ChatBox Lite requires Electron context isolation.')
}

contextBridge.exposeInMainWorld('chatbox', deepFreeze(chatboxApi))

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}
