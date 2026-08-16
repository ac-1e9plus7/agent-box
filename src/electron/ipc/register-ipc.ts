import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type {
  AppSettings,
  ChatRequest,
  Conversation,
  ModelInput,
  ProviderInput,
  StreamEvent,
} from '../../shared/types'
import { ChatGateway } from '../api/gateway'
import { AppRepository } from '../storage/app-repository'

export function registerIpcHandlers(
  window: BrowserWindow,
  repository: AppRepository,
  gateway: ChatGateway,
): () => void {
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
      proxy: { ...settings.proxy, url: maskProxyUrl(settings.proxy.url) }
    }
  })
  register(IPC_CHANNELS.settingsUpdate, (_event, patch: Partial<AppSettings>) => {
    assertRecord(patch, '设置')
    const current = repository.getSettings()
    if (patch.proxy !== undefined && patch.proxy.url !== undefined) {
      patch.proxy.url = unmaskProxyUrl(patch.proxy.url, current.proxy.url)
    }
    return repository.updateSettings(patch).then((settings) => ({
      ...settings,
      proxy: { ...settings.proxy, url: maskProxyUrl(settings.proxy.url) },
    }))
  })

  register(IPC_CHANNELS.providersList, () => repository.listProviders())
  register(IPC_CHANNELS.providersUpsert, (_event, input: ProviderInput) => {
    assertRecord(input, '供应商配置')
    return repository.upsertProvider(input)
  })
  register(IPC_CHANNELS.providersRemove, (_event, id: string) => {
    assertId(id)
    return repository.removeProvider(id)
  })
  register(IPC_CHANNELS.providersTest, (_event, input: ProviderInput) => {
    assertRecord(input, '供应商配置')
    return gateway.testProvider(repository.buildProviderCandidate(input))
  })

  register(IPC_CHANNELS.modelsList, () => repository.listModels())
  register(IPC_CHANNELS.modelsUpsert, (_event, input: ModelInput) => {
    assertRecord(input, '模型配置')
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

  register(IPC_CHANNELS.conversationsList, () => repository.listConversations())
  register(IPC_CHANNELS.conversationsGet, (_event, id: string) => {
    assertId(id)
    return repository.getConversation(id)
  })
  register(IPC_CHANNELS.conversationsSave, (_event, conversation: Conversation) => {
    assertRecord(conversation, '会话')
    return repository.saveConversation(conversation)
  })
  register(IPC_CHANNELS.conversationsRemove, (_event, id: string) => {
    assertId(id)
    return repository.removeConversation(id)
  })

  register(IPC_CHANNELS.dataClearConversations, () => {
    gateway.cancelAll()
    return repository.clearConversations()
  })

  register(IPC_CHANNELS.chatStart, (event, request: ChatRequest) => {
    assertRecord(request, '聊天请求')
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

  register(IPC_CHANNELS.appGetInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }))

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.chatEvent) ipcMain.removeHandler(channel)
    }
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('拒绝来自未知渲染进程的 IPC 请求。')
  }
  const frameUrl = event.senderFrame?.url
  if (!frameUrl || !isTrustedMainPage(frameUrl)) {
    throw new Error('拒绝来自未知页面的 IPC 请求。')
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
    throw new Error('ID 无效。')
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}无效。`)
  }
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

export {
  maskProxyUrl,
  unmaskProxyUrl,
  isTrustedMainPage,
}

