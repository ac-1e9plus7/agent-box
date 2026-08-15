import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppSettings,
  Conversation as StoredConversation,
  Message,
  ModelInput,
  ProviderInput,
  StreamEvent,
  WebCitation
} from '../../shared/types'
import { ChatContent } from './components/ChatContent'
import { Composer } from './components/Composer'
import { Icon } from './components/Icon'
import { SettingsDialog } from './components/SettingsDialog'
import type { SettingsSavePayload } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { promptSuggestions } from './defaults'
import type {
  ChatMessage,
  Conversation,
  ModelConfig,
  ProviderConfig,
  SettingsSection,
  WebSearchMode
} from './types'
import { effectiveWebSearchMode, isWebSearchAvailable } from './web-search'

const emptySettings: AppSettings = {
  theme: 'system',
  sendShortcut: 'enter',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  contextManagementMode: 'manual',
  systemPrompt: ''
}

interface ActiveStream {
  requestId: string
  conversationId: string
  assistantMessageId: string
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function toUiConversation(conversation: StoredConversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      modelId: message.role === 'assistant' ? conversation.modelId : undefined,
      status: 'complete'
    }))
  }
}

function toStoredConversation(conversation: Conversation): StoredConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    modelId: conversation.modelId,
    reasoningEnabled: conversation.reasoningEnabled,
    webSearchMode: conversation.webSearchMode ?? 'off',
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map(({
      status: _status,
      modelId: _modelId,
      error: _error,
      ...message
    }) => message)
  }
}

function makeTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized || '新对话'
}

const MESSAGE_OVERHEAD = 8
const REQUEST_OVERHEAD = 64
const CONTEXT_SAFETY_TOKENS = 128

interface ContextProjection {
  estimatedInputTokens: number
  inputBudget: number
  blocked: boolean
  canTrimOnce: boolean
  trimTurnCount: number
  tone: 'ok' | 'warning' | 'error'
  message: string
}

function estimateTextTokens(text: string): number {
  let wideCharacters = 0
  let otherCharacters = 0
  for (const character of text) {
    if (/[^\u0000-\u024f]/u.test(character)) wideCharacters += 1
    else otherCharacters += character.length
  }
  return wideCharacters + Math.ceil(otherCharacters / 4)
}

function estimateMessageTokens(content: string): number {
  return MESSAGE_OVERHEAD + estimateTextTokens(content)
}

function projectContext(
  messages: ChatMessage[],
  pendingContent: string,
  settings: AppSettings,
  model: ModelConfig
): ContextProjection {
  const inputBudget = model.contextWindow - model.maxOutputTokens - CONTEXT_SAFETY_TOKENS
  const configuredSystemPrompt = settings.systemPrompt.trim()
  const systemMessages = messages.filter((message) => message.role === 'system')
  const hasConfiguredPrompt = systemMessages.some((message) => message.content.trim() === configuredSystemPrompt)
  const systemCost = systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message.content), 0)
    + (configuredSystemPrompt && !hasConfiguredPrompt ? estimateMessageTokens(configuredSystemPrompt) : 0)

  const turns: ChatMessage[][] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') turns.push([message])
    else if (turns.length > 0) turns.at(-1)?.push(message)
  }
  if (pendingContent.trim()) {
    turns.push([{
      id: 'context-preview',
      role: 'user',
      content: pendingContent.trim(),
      createdAt: new Date(0).toISOString()
    }])
  }

  const turnCosts = turns.map((turn) => turn.reduce(
    (sum, message) => sum + estimateMessageTokens(message.content),
    0
  ))
  const estimatedInputTokens = REQUEST_OVERHEAD + systemCost + turnCosts.reduce((sum, cost) => sum + cost, 0)
  const latestTurnCost = turnCosts.at(-1) ?? 0
  const minimumRequired = REQUEST_OVERHEAD + systemCost + latestTurnCost
  const irreducibleOverflow = inputBudget <= REQUEST_OVERHEAD || minimumRequired > inputBudget

  if (irreducibleOverflow) {
    return {
      estimatedInputTokens,
      inputBudget: Math.max(inputBudget, 0),
      blocked: true,
      canTrimOnce: false,
      trimTurnCount: 0,
      tone: 'error',
      message: '系统提示词与最新问题已超过可用上下文。请缩短内容，或提高模型上下文窗口。'
    }
  }

  if (estimatedInputTokens <= inputBudget) {
    return { estimatedInputTokens, inputBudget, blocked: false, canTrimOnce: false, trimTurnCount: 0, tone: 'ok', message: '' }
  }

  if (settings.contextManagementMode === 'manual') {
    const overflow = estimatedInputTokens - inputBudget
    return {
      estimatedInputTokens,
      inputBudget,
      blocked: true,
      canTrimOnce: true,
      trimTurnCount: 0,
      tone: 'error',
      message: `已超出可用上下文约 ${overflow.toLocaleString('zh-CN')} tokens。手动模式不会自动删除历史；你可仅为本次请求按完整轮次裁剪。`
    }
  }

  let retainedTokens = estimatedInputTokens
  let trimTurnCount = 0
  while (retainedTokens > inputBudget && trimTurnCount < Math.max(turnCosts.length - 1, 0)) {
    retainedTokens -= turnCosts[trimTurnCount] ?? 0
    trimTurnCount += 1
  }
  return {
    estimatedInputTokens,
    inputBudget,
    blocked: false,
    canTrimOnce: false,
    trimTurnCount,
    tone: 'warning',
    message: `发送时将从最早记录开始，自动裁剪约 ${trimTurnCount} 个完整对话轮次；最新问题会保留。`
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请稍后重试。'
}

function mergeCitation(
  citations: WebCitation[] | undefined,
  citation: WebCitation
): WebCitation[] {
  const existing = citations ?? []
  const index = existing.findIndex((item) => item.url === citation.url)
  if (index < 0) return [...existing, citation]
  return existing.map((item, itemIndex) => itemIndex === index ? {
    url: citation.url,
    title: citation.title ?? item.title,
    content: citation.content ?? item.content,
    startIndex: citation.startIndex ?? item.startIndex,
    endIndex: citation.endIndex ?? item.endIndex
  } : item)
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(emptySettings)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [activeModelId, setActiveModelId] = useState('')
  const [reasoningEnabled, setReasoningEnabled] = useState(false)
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>('off')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [loading, setLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState('')
  const [toast, setToast] = useState('')
  const [streaming, setStreaming] = useState(false)

  const conversationsRef = useRef<Conversation[]>([])
  const activeStreamRef = useRef<ActiveStream | null>(null)
  const toastTimerRef = useRef<number | undefined>(undefined)

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
  const activeModel = models.find((model) => model.id === activeModelId)
  const activeProvider = providers.find((provider) => provider.id === activeModel?.providerId)
  const webSearchAvailable = isWebSearchAvailable(activeModel, activeProvider)
  const contextProjection = useMemo(() => activeModel ? projectContext(
    activeConversation?.messages ?? [],
    draft,
    settings,
    activeModel
  ) : undefined, [activeConversation?.messages, activeModel, draft, settings])

  const showToast = useCallback((message: string): void => {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => setToast(''), 4200)
  }, [])

  const replaceConversations = useCallback((updater: (current: Conversation[]) => Conversation[]): Conversation[] => {
    const next = updater(conversationsRef.current)
    conversationsRef.current = next
    setConversations(next)
    return next
  }, [])

  const persistConversation = useCallback(async (conversation: Conversation): Promise<boolean> => {
    try {
      const saved = await window.chatbox.conversations.save(toStoredConversation(conversation))
      replaceConversations((current) => current.map((item) => (
        item.id === saved.id ? { ...toUiConversation(saved), messages: item.messages } : item
      )))
      return true
    } catch (error) {
      showToast(`保存会话失败：${normalizeError(error)}`)
      return false
    }
  }, [replaceConversations, showToast])

  const createConversation = useCallback(async (
    modelId?: string,
    modeOverrides?: Pick<Conversation, 'reasoningEnabled' | 'webSearchMode'>
  ): Promise<Conversation | undefined> => {
    const resolvedModel = models.find((model) => model.id === modelId)
      ?? models.find((model) => model.id === settings.defaultModelId)
      ?? models[0]
    if (!resolvedModel) {
      setSettingsSection('models')
      setSettingsOpen(true)
      showToast('请先添加一个模型。')
      return undefined
    }

    const now = new Date().toISOString()
    const resolvedProvider = providers.find((provider) => provider.id === resolvedModel.providerId)
    const conversation: Conversation = {
      id: createId('conversation'),
      title: '新对话',
      modelId: resolvedModel.id,
      reasoningEnabled: resolvedModel.supportsReasoning && (
        modeOverrides?.reasoningEnabled ?? (
          resolvedModel.defaultReasoningEnabled || settings.defaultReasoningEnabled
        )
      ),
      webSearchMode: effectiveWebSearchMode(
        resolvedModel,
        resolvedProvider,
        modeOverrides?.webSearchMode ?? resolvedModel.defaultWebSearchMode
      ),
      messages: [],
      createdAt: now,
      updatedAt: now
    }

    try {
      const saved = toUiConversation(await window.chatbox.conversations.save(toStoredConversation(conversation)))
      replaceConversations((current) => [saved, ...current])
      setActiveConversationId(saved.id)
      setActiveModelId(saved.modelId)
      setReasoningEnabled(Boolean(saved.reasoningEnabled))
      setWebSearchMode(saved.webSearchMode ?? 'off')
      setDraft('')
      setMobileSidebarOpen(false)
      return saved
    } catch (error) {
      showToast(`无法新建会话：${normalizeError(error)}`)
      return undefined
    }
  }, [models, providers, replaceConversations, settings.defaultModelId, settings.defaultReasoningEnabled, showToast])

  const bootstrap = useCallback(async (): Promise<void> => {
    setLoading(true)
    setBootstrapError('')
    try {
      if (!window.chatbox) throw new Error('安全桥接未加载，请重新启动应用。')
      const [nextSettings, providerViews, modelViews, conversationViews] = await Promise.all([
        window.chatbox.settings.get(),
        window.chatbox.providers.list(),
        window.chatbox.models.list(),
        window.chatbox.conversations.list()
      ])
      const uiProviders: ProviderConfig[] = providerViews.map((provider) => ({
        ...provider,
        isBuiltIn: provider.id === 'openrouter'
      }))
      const uiConversations = conversationViews.map(toUiConversation)
      setSettings(nextSettings)
      setProviders(uiProviders)
      setModels(modelViews)
      conversationsRef.current = uiConversations
      setConversations(uiConversations)

      const initialConversation = uiConversations[0]
      const initialModel = modelViews.find((model) => model.id === initialConversation?.modelId)
        ?? modelViews.find((model) => model.id === nextSettings.defaultModelId)
        ?? modelViews[0]
      const initialProvider = uiProviders.find((provider) => provider.id === initialModel?.providerId)
      setActiveConversationId(initialConversation?.id ?? '')
      setActiveModelId(initialModel?.id ?? '')
      setReasoningEnabled(
        initialConversation?.reasoningEnabled
          ?? Boolean(initialModel?.supportsReasoning && (
            initialModel.defaultReasoningEnabled || nextSettings.defaultReasoningEnabled
          ))
      )
      setWebSearchMode(effectiveWebSearchMode(
        initialModel,
        initialProvider,
        initialConversation ? initialConversation.webSearchMode ?? 'off' : initialModel?.defaultWebSearchMode
      ))
    } catch (error) {
      setBootstrapError(normalizeError(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  useEffect(() => () => {
    window.clearTimeout(toastTimerRef.current)
  }, [])

  const finishStream = useCallback((event: Extract<StreamEvent, { type: 'done' | 'error' }>): void => {
    const activeStream = activeStreamRef.current
    if (!activeStream || event.requestId !== activeStream.requestId) return

    const next = replaceConversations((current) => current.map((conversation) => {
      if (conversation.id !== activeStream.conversationId) return conversation
      return {
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: conversation.messages.map((message) => (
          message.id === activeStream.assistantMessageId
            ? {
              ...message,
              status: event.type === 'error' ? 'error' : 'complete',
              error: event.type === 'error' ? event.error.message : undefined
            }
            : message
        ))
      }
    }))
    const completedConversation = next.find((conversation) => conversation.id === activeStream.conversationId)
    if (completedConversation) void persistConversation(completedConversation)
    if (event.type === 'error') showToast(event.error.message)
    activeStreamRef.current = null
    setStreaming(false)
  }, [persistConversation, replaceConversations, showToast])

  useEffect(() => window.chatbox.chat.onEvent((event) => {
    const activeStream = activeStreamRef.current
    if (!activeStream) return
    if (!activeStream.requestId && event.type === 'start') activeStream.requestId = event.requestId
    if (event.requestId !== activeStream.requestId) return

    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
      replaceConversations((current) => current.map((conversation) => {
        if (conversation.id !== activeStream.conversationId) return conversation
        return {
          ...conversation,
          messages: conversation.messages.map((message) => {
            if (message.id !== activeStream.assistantMessageId) return message
            return event.type === 'text-delta'
              ? { ...message, content: message.content + event.delta }
              : { ...message, reasoning: (message.reasoning ?? '') + event.delta }
          })
        }
      }))
      return
    }
    if (event.type === 'citation') {
      replaceConversations((current) => current.map((conversation) => {
        if (conversation.id !== activeStream.conversationId) return conversation
        return {
          ...conversation,
          messages: conversation.messages.map((message) => message.id === activeStream.assistantMessageId
            ? { ...message, citations: mergeCitation(message.citations, event.citation) }
            : message)
        }
      }))
      return
    }
    if (event.type === 'usage') {
      replaceConversations((current) => current.map((conversation) => {
        if (conversation.id !== activeStream.conversationId) return conversation
        return {
          ...conversation,
          messages: conversation.messages.map((message) => message.id === activeStream.assistantMessageId
            ? { ...message, usage: { ...message.usage, ...event.usage } }
            : message)
        }
      }))
      return
    }
    if (event.type === 'done' || event.type === 'error') finishStream(event)
  }), [finishStream, replaceConversations])

  const handleSelectConversation = (conversationId: string): void => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId)
    if (!conversation) return
    setActiveConversationId(conversation.id)
    setActiveModelId(conversation.modelId)
    setReasoningEnabled(Boolean(conversation.reasoningEnabled))
    const model = models.find((item) => item.id === conversation.modelId)
    const provider = providers.find((item) => item.id === model?.providerId)
    setWebSearchMode(effectiveWebSearchMode(model, provider, conversation.webSearchMode ?? 'off'))
    setMobileSidebarOpen(false)
  }

  const handleDeleteConversation = async (conversationId: string): Promise<void> => {
    if (activeStreamRef.current?.conversationId === conversationId) {
      await window.chatbox.chat.cancel(activeStreamRef.current.requestId).catch(() => undefined)
      activeStreamRef.current = null
      setStreaming(false)
    }
    try {
      await window.chatbox.conversations.remove(conversationId)
      const next = replaceConversations((current) => current.filter((conversation) => conversation.id !== conversationId))
      if (activeConversationId === conversationId) {
        const nextConversation = next[0]
        setActiveConversationId(nextConversation?.id ?? '')
        const nextModelId = nextConversation?.modelId ?? settings.defaultModelId ?? models[0]?.id ?? ''
        const nextModel = models.find((model) => model.id === nextModelId)
        const nextProvider = providers.find((provider) => provider.id === nextModel?.providerId)
        setActiveModelId(nextModelId)
        setReasoningEnabled(Boolean(nextConversation?.reasoningEnabled ?? settings.defaultReasoningEnabled))
        setWebSearchMode(effectiveWebSearchMode(
          nextModel,
          nextProvider,
          nextConversation ? nextConversation.webSearchMode ?? 'off' : nextModel?.defaultWebSearchMode
        ))
      }
    } catch (error) {
      showToast(`删除失败：${normalizeError(error)}`)
    }
  }

  const handleModelChange = async (modelId: string): Promise<void> => {
    const model = models.find((item) => item.id === modelId)
    if (!model) return
    const provider = providers.find((item) => item.id === model.providerId)
    const nextWebSearchMode = effectiveWebSearchMode(model, provider, webSearchMode)
    setActiveModelId(modelId)
    setReasoningEnabled(model.supportsReasoning && model.defaultReasoningEnabled)
    setWebSearchMode(nextWebSearchMode)
    setSettings((current) => ({ ...current, defaultModelId: modelId }))
    void window.chatbox.settings.update({ defaultModelId: modelId }).catch((error) => showToast(normalizeError(error)))

    if (activeConversation) {
      const nextConversation: Conversation = {
        ...activeConversation,
        modelId,
        reasoningEnabled: model.supportsReasoning && model.defaultReasoningEnabled,
        webSearchMode: nextWebSearchMode,
        updatedAt: new Date().toISOString()
      }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      await persistConversation(nextConversation)
    }
  }

  const handleToggleReasoning = (): void => {
    if (!activeModel?.supportsReasoning) return
    const nextEnabled = !reasoningEnabled
    setReasoningEnabled(nextEnabled)
    if (activeConversation) {
      const nextConversation = {
        ...activeConversation,
        reasoningEnabled: nextEnabled,
        updatedAt: new Date().toISOString()
      }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      void persistConversation(nextConversation)
    }
  }

  const handleWebSearchModeChange = (mode: WebSearchMode): void => {
    if (mode !== 'off' && !webSearchAvailable) {
      showToast('联网搜索仅支持 OpenRouter 连接。')
      return
    }
    setWebSearchMode(mode)
    if (activeConversation) {
      const nextConversation: Conversation = {
        ...activeConversation,
        webSearchMode: mode,
        updatedAt: new Date().toISOString()
      }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      void persistConversation(nextConversation)
    }
  }

  const handleSend = async (allowContextTrimming = false): Promise<void> => {
    const content = draft.trim()
    if (!content || streaming || !activeModel) return
    if (contextProjection?.blocked && (!allowContextTrimming || !contextProjection.canTrimOnce)) {
      showToast(contextProjection.message)
      return
    }
    if (webSearchMode !== 'off' && !webSearchAvailable) {
      setWebSearchMode('off')
      if (activeConversation) {
        const nextConversation = { ...activeConversation, webSearchMode: 'off' as const, updatedAt: new Date().toISOString() }
        replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
        void persistConversation(nextConversation)
      }
      showToast('当前模型或 API 格式不支持联网搜索，已切换为关闭。')
      return
    }
    if (!activeProvider || (!activeProvider.hasApiKey && !activeProvider.apiKeyOptional)) {
      setSettingsSection('providers')
      setSettingsOpen(true)
      showToast('请先为当前服务商配置 API 密钥。')
      return
    }

    const conversation = activeConversation ?? await createConversation(activeModel.id, {
      reasoningEnabled,
      webSearchMode
    })
    if (!conversation) return
    const timestamp = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content,
      createdAt: timestamp,
      status: 'complete'
    }
    const assistantMessage: ChatMessage = {
      id: createId('message'),
      role: 'assistant',
      content: '',
      reasoning: '',
      createdAt: timestamp,
      modelId: activeModel.id,
      status: 'streaming'
    }
    const nextConversation: Conversation = {
      ...conversation,
      title: conversation.messages.length === 0 ? makeTitle(content) : conversation.title,
      modelId: activeModel.id,
      reasoningEnabled,
      webSearchMode,
      messages: [...conversation.messages, userMessage, assistantMessage],
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    setDraft('')
    setStreaming(true)
    activeStreamRef.current = {
      requestId: '',
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id
    }

    const requestMessages: Message[] = nextConversation.messages
      .filter((message) => message.id !== assistantMessage.id)
      .map(({ status: _status, modelId: _modelId, error: _error, ...message }) => message)

    const persisted = await persistConversation({
      ...nextConversation,
      messages: nextConversation.messages.filter((message) => message.id !== assistantMessage.id)
    })
    if (!persisted) {
      replaceConversations((current) => current.map((item) => (
        item.id === conversation.id ? conversation : item
      )))
      setDraft(content)
      setStreaming(false)
      activeStreamRef.current = null
      return
    }

    try {
      const { requestId } = await window.chatbox.chat.stream({
        conversationId: nextConversation.id,
        modelId: activeModel.id,
        messages: requestMessages,
        reasoningEnabled,
        webSearchMode,
        reasoningEffort: activeModel.defaultReasoningEffort ?? settings.defaultReasoningEffort,
        maxOutputTokens: activeModel.maxOutputTokens,
        allowContextTrimming: allowContextTrimming || undefined
      })
      if (activeStreamRef.current?.assistantMessageId === assistantMessage.id) {
        activeStreamRef.current.requestId = requestId
      }
    } catch (error) {
      const requestId = activeStreamRef.current?.requestId ?? ''
      finishStream({
        type: 'error',
        requestId,
        error: { message: normalizeError(error) }
      })
    }
  }

  const handleStop = async (): Promise<void> => {
    const activeStream = activeStreamRef.current
    if (!activeStream?.requestId) return
    try {
      await window.chatbox.chat.cancel(activeStream.requestId)
      finishStream({ type: 'done', requestId: activeStream.requestId, finishReason: 'cancelled' })
    } catch (error) {
      showToast(`无法停止生成：${normalizeError(error)}`)
    }
  }

  const saveSettings = async (payload: SettingsSavePayload): Promise<void> => {
    const existingProviderIds = new Set(providers.map((provider) => provider.id))
    const providerIdMap = new Map<string, string>()
    const savedProviders: ProviderConfig[] = []

    for (const provider of payload.providers) {
      const apiKey = payload.apiKeyInputs[provider.id]?.trim()
      const clearApiKey = payload.clearApiKeyIds.includes(provider.id)
      const input: ProviderInput = {
        ...(existingProviderIds.has(provider.id) ? { id: provider.id } : {}),
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiFormat: provider.apiFormat,
        defaultHeaders: provider.defaultHeaders,
        ...(apiKey && !clearApiKey ? { apiKey } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {})
      }
      const saved = await window.chatbox.providers.upsert(input)
      providerIdMap.set(provider.id, saved.id)
      savedProviders.push({ ...saved, isBuiltIn: saved.id === 'openrouter' })
    }

    const existingModelIds = new Set(models.map((model) => model.id))
    const modelIdMap = new Map<string, string>()
    const savedModels: ModelConfig[] = []
    for (const model of payload.models) {
      const modelProvider = payload.providers.find((provider) => provider.id === model.providerId)
      const input: ModelInput = {
        ...(existingModelIds.has(model.id) ? { id: model.id } : {}),
        name: model.name,
        providerId: providerIdMap.get(model.providerId) ?? model.providerId,
        remoteId: model.remoteId,
        apiFormat: model.apiFormat,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        supportsReasoning: model.supportsReasoning,
        defaultReasoningEnabled: model.defaultReasoningEnabled,
        defaultReasoningEffort: model.defaultReasoningEffort,
        defaultWebSearchMode: effectiveWebSearchMode(model, modelProvider, model.defaultWebSearchMode),
        anthropicThinkingMode: model.anthropicThinkingMode,
        providerRouting: model.providerRouting
      }
      const saved = await window.chatbox.models.upsert(input)
      modelIdMap.set(model.id, saved.id)
      savedModels.push(saved)
    }

    const fallbackModelId = savedModels[0]?.id
    const updatedConversations = conversationsRef.current.map((conversation) => {
      const mappedModelId = modelIdMap.get(conversation.modelId) ?? fallbackModelId
      if (!mappedModelId) return conversation
      const mappedModel = savedModels.find((model) => model.id === mappedModelId)
      const mappedProvider = savedProviders.find((provider) => provider.id === mappedModel?.providerId)
      const nextWebSearchMode = effectiveWebSearchMode(
        mappedModel,
        mappedProvider,
        conversation.webSearchMode ?? 'off'
      )
      const changed = mappedModelId !== conversation.modelId || nextWebSearchMode !== (conversation.webSearchMode ?? 'off')
      return changed
        ? { ...conversation, modelId: mappedModelId, webSearchMode: nextWebSearchMode, updatedAt: new Date().toISOString() }
        : conversation
    })
    await Promise.all(updatedConversations.map((conversation) => (
      conversation.modelId ? window.chatbox.conversations.save(toStoredConversation(conversation)) : Promise.resolve()
    )))

    const keptModelIds = new Set(payload.models.filter((model) => existingModelIds.has(model.id)).map((model) => model.id))
    for (const model of models) {
      if (!keptModelIds.has(model.id)) await window.chatbox.models.remove(model.id)
    }
    const keptProviderIds = new Set(payload.providers.filter((provider) => existingProviderIds.has(provider.id)).map((provider) => provider.id))
    for (const provider of providers) {
      if (!keptProviderIds.has(provider.id)) await window.chatbox.providers.remove(provider.id)
    }

    const nextDefaultModelId = modelIdMap.get(payload.preferences.defaultModelId ?? '')
      ?? (savedModels.some((model) => model.id === payload.preferences.defaultModelId) ? payload.preferences.defaultModelId : fallbackModelId)
    const savedSettings = await window.chatbox.settings.update({
      ...payload.preferences,
      defaultModelId: nextDefaultModelId
    })
    setProviders(savedProviders)
    setModels(savedModels)
    setSettings(savedSettings)
    conversationsRef.current = updatedConversations
    setConversations(updatedConversations)

    const nextActiveModel = modelIdMap.get(activeModelId)
      ?? (savedModels.some((model) => model.id === activeModelId) ? activeModelId : fallbackModelId)
    setActiveModelId(nextActiveModel ?? '')
    const nextActiveModelConfig = savedModels.find((model) => model.id === nextActiveModel)
    const nextActiveProvider = savedProviders.find((provider) => provider.id === nextActiveModelConfig?.providerId)
    const nextActiveConversation = updatedConversations.find((conversation) => conversation.id === activeConversationId)
    setWebSearchMode(effectiveWebSearchMode(
      nextActiveModelConfig,
      nextActiveProvider,
      nextActiveConversation ? nextActiveConversation.webSearchMode ?? 'off' : nextActiveModelConfig?.defaultWebSearchMode
    ))
    showToast('设置已保存。')
  }

  const testProvider = async (
    provider: ProviderConfig,
    apiKeyInput: string,
    clearApiKey: boolean
  ): Promise<boolean> => {
    try {
      const isPersisted = providers.some((item) => item.id === provider.id)
      const result = await window.chatbox.providers.test({
        ...(isPersisted ? { id: provider.id } : {}),
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiFormat: provider.apiFormat,
        defaultHeaders: provider.defaultHeaders,
        ...(apiKeyInput.trim() && !clearApiKey ? { apiKey: apiKeyInput.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {})
      })
      showToast(result.message)
      return result.ok
    } catch (error) {
      showToast(normalizeError(error))
      return false
    }
  }

  const openSettings = (section: SettingsSection): void => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }

  const discoverModels = async (providerId: string) => {
    try {
      const discovered = await window.chatbox.models.discover(providerId)
      showToast(`已获取 ${discovered.length} 个模型。`)
      return discovered
    } catch (error) {
      const message = normalizeError(error)
      showToast(message)
      throw new Error(message)
    }
  }

  const visibleMessages = useMemo(
    () => (activeConversation?.messages ?? []).filter((message) => message.role !== 'system'),
    [activeConversation?.messages]
  )

  if (loading) {
    return (
      <main className="app-loading">
        <span className="loading-mark"><Icon name="app" size={34} /></span>
        <h1>ChatBox Lite</h1>
        <div className="loading-line"><i /></div>
        <p>正在解锁本地数据…</p>
      </main>
    )
  }

  if (bootstrapError) {
    return (
      <main className="fatal-state">
        <span><Icon name="lock" size={30} /></span>
        <h1>无法打开本地数据</h1>
        <p>{bootstrapError}</p>
        <button onClick={() => void bootstrap()}><Icon name="refresh" size={16} /> 重试</button>
      </main>
    )
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        activeConversationId={activeConversationId}
        collapsed={sidebarCollapsed}
        conversations={conversations}
        mobileOpen={mobileSidebarOpen}
        query={query}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onCollapse={() => setSidebarCollapsed(true)}
        onDeleteConversation={(id) => void handleDeleteConversation(id)}
        onNewConversation={() => void createConversation(activeModelId)}
        onOpenSettings={() => openSettings('general')}
        onQueryChange={setQuery}
        onSelectConversation={handleSelectConversation}
      />

      <main className="chat-workspace">
        <Topbar
          activeModel={activeModel}
          activeTitle={activeConversation?.title ?? '新对话'}
          models={models}
          providers={providers}
          reasoningEnabled={reasoningEnabled}
          sidebarCollapsed={sidebarCollapsed}
          onModelChange={(modelId) => void handleModelChange(modelId)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          onOpenSettings={() => openSettings('models')}
          onRestoreSidebar={() => setSidebarCollapsed(false)}
          onToggleReasoning={handleToggleReasoning}
        />

        <section className="chat-stage">
          <ChatContent
            messages={visibleMessages}
            models={models}
            suggestions={promptSuggestions}
            onSuggestion={setDraft}
          />
          <Composer
            activeModel={activeModel}
            contextLimit={contextProjection?.inputBudget ?? 0}
            contextCanTrimOnce={contextProjection?.canTrimOnce ?? false}
            contextMessage={contextProjection?.message ?? ''}
            contextMode={settings.contextManagementMode}
            contextTone={contextProjection?.tone ?? 'ok'}
            contextTokens={contextProjection?.estimatedInputTokens ?? 0}
            disabled={!activeModel}
            draft={draft}
            reasoningEnabled={reasoningEnabled}
            webSearchAvailable={webSearchAvailable}
            webSearchMode={webSearchMode}
            sendBlocked={contextProjection?.blocked ?? false}
            sendOnEnter={settings.sendShortcut === 'enter'}
            streaming={streaming}
            onDraftChange={setDraft}
            onOpenContextSettings={() => openSettings('general')}
            onOpenModelSettings={() => openSettings('models')}
            onSend={() => void handleSend()}
            onSendWithTrim={() => void handleSend(true)}
            onStop={() => void handleStop()}
            onToggleReasoning={handleToggleReasoning}
            onWebSearchModeChange={handleWebSearchModeChange}
          />
        </section>
      </main>

      <SettingsDialog
        initialSection={settingsSection}
        models={models}
        open={settingsOpen}
        preferences={settings}
        providers={providers}
        onClose={() => setSettingsOpen(false)}
        onDiscoverModels={discoverModels}
        onSave={saveSettings}
        onTestProvider={testProvider}
      />

      {toast && <div className="toast" role="status"><Icon name="info" size={16} /><span>{toast}</span></div>}
    </div>
  )
}
