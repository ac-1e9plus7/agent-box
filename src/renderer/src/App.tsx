import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppSettings,
  Conversation as StoredConversation,
  Message,
  MessageAttachment,
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
import { projectContext } from './context-projection'
import { runStreamWithReplay } from './stream-helper'
import {
  cleanGeneratedTitle,
  cleanManualTitle,
  firstUserQuestion,
  TITLE_SYSTEM_PROMPT
} from './title'

const emptySettings: AppSettings = {
  theme: 'system',
  sendShortcut: 'enter',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  contextManagementMode: 'manual',
  systemPrompt: '',
  proxy: { mode: 'off', url: '' }
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
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
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
  const autoRenamingRef = useRef<Set<string>>(new Set())
  const manualRenamedRef = useRef<Set<string>>(new Set())

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
  const activeModel = models.find((model) => model.id === activeModelId)
  const activeProvider = providers.find((provider) => provider.id === activeModel?.providerId)
  const webSearchAvailable = isWebSearchAvailable(activeModel, activeProvider)
  const contextProjection = useMemo(() => activeModel ? projectContext(
    activeConversation?.messages ?? [],
    draft,
    settings,
    activeModel,
    attachments
  ) : undefined, [activeConversation?.messages, activeModel, attachments, draft, settings])

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
      setAttachments([])
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

  const maybeGenerateTitle = useCallback(async (conversation: Conversation): Promise<void> => {
    const modelId = settings.titleGenerationModelId || conversation.modelId
    const model = models.find((item) => item.id === modelId)
    if (!model) return
    const rawQuestion = firstUserQuestion(conversation.messages)
    if (!rawQuestion) return
    const question = rawQuestion.length > 2000 ? rawQuestion.slice(0, 2000) + '\n...' : rawQuestion
    // Guard against duplicate generation or overwriting manual renames.
    if (autoRenamingRef.current.has(conversation.id) || manualRenamedRef.current.has(conversation.id)) return
    autoRenamingRef.current.add(conversation.id)

    let unsubscribe: (() => void) | undefined
    let collected = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
    }

    const processEvent = (event: StreamEvent): void => {
      if (event.type === 'text-delta') {
        collected += event.delta
        return
      }
      if (event.type === 'done') {
        finish()
        const title = cleanGeneratedTitle(collected)
        if (!title) return
        const current = conversationsRef.current.find((item) => item.id === conversation.id)
        // Only overwrite if the user has not manually renamed it in the meantime.
        if (current && !manualRenamedRef.current.has(conversation.id)) {
          const renamed = { ...current, title, updatedAt: new Date().toISOString() }
          replaceConversations((items) => items.map((item) => (item.id === renamed.id ? renamed : item)))
          void persistConversation(renamed)
        }
        return
      }
      if (event.type === 'error') {
        finish()
      }
    }

    try {
      const result = await runStreamWithReplay(
        window.chatbox.chat.stream,
        window.chatbox.chat.onEvent,
        {
          conversationId: conversation.id,
          modelId: model.id,
          messages: [
            { id: 'title-system', role: 'system', content: TITLE_SYSTEM_PROMPT, createdAt: new Date(0).toISOString() },
            { id: 'title-user', role: 'user', content: question, createdAt: new Date(0).toISOString() },
          ],
          reasoningEnabled: false,
          webSearchMode: 'off',
          maxOutputTokens: 32,
        },
        processEvent
      )
      
      unsubscribe = result.unsubscribe
      // Safety net: give up after 20s regardless of stream state.
      window.setTimeout(() => finish(), 20_000)
    } catch {
      finish()
    }
  }, [models, persistConversation, replaceConversations, settings.titleGenerationModelId])

  const renameConversation = useCallback((conversationId: string, rawTitle: string): void => {
    const title = cleanManualTitle(rawTitle)
    if (!title) return
    const current = conversationsRef.current.find((item) => item.id === conversationId)
    if (!current || current.title === title) return
    // A manual rename marks the conversation so auto-generation won't override it.
    manualRenamedRef.current.add(conversationId)
    const renamed = { ...current, title, updatedAt: new Date().toISOString() }
    replaceConversations((items) => items.map((item) => (item.id === renamed.id ? renamed : item)))
    void persistConversation(renamed)
  }, [persistConversation, replaceConversations])

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

    // After the first successful user+assistant turn, ask the current model for a concise generated title
    // unless the user has already manually renamed it.
    if (
      event.type === 'done' &&
      event.finishReason !== 'cancelled' &&
      completedConversation &&
      !manualRenamedRef.current.has(completedConversation.id) &&
      !autoRenamingRef.current.has(completedConversation.id) &&
      completedConversation.messages.filter((message) => message.role !== 'system').length === 2
    ) {
      void maybeGenerateTitle(completedConversation)
    }
  }, [maybeGenerateTitle, persistConversation, replaceConversations, showToast])

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
    setAttachments([])
    setMobileSidebarOpen(false)
  }

  const handleDeleteConversation = async (conversationId: string): Promise<void> => {
    if (activeStreamRef.current?.conversationId === conversationId) {
      await window.chatbox.chat.cancel(activeStreamRef.current.requestId).catch(() => undefined)
      activeStreamRef.current = null
      setStreaming(false)
    }
    autoRenamingRef.current.delete(conversationId)
    manualRenamedRef.current.delete(conversationId)
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

  const guardWebSearchAvailable = useCallback((): boolean => {
    if (webSearchMode === 'off' || webSearchAvailable) return true
    setWebSearchMode('off')
    if (activeConversation) {
      const nextConversation = { ...activeConversation, webSearchMode: 'off' as const, updatedAt: new Date().toISOString() }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      void persistConversation(nextConversation)
    }
    showToast('当前模型或 API 格式不支持联网搜索，已切换为关闭。')
    return false
  }, [activeConversation, persistConversation, replaceConversations, showToast, webSearchAvailable, webSearchMode])

  const guardProviderKey = useCallback((): boolean => {
    if (!activeProvider || (!activeProvider.hasApiKey && !activeProvider.apiKeyOptional)) {
      setSettingsSection('providers')
      setSettingsOpen(true)
      showToast('请先为当前服务商配置 API 密钥。')
      return false
    }
    return true
  }, [activeProvider, showToast])

  const handleSend = async (allowContextTrimming = false): Promise<void> => {
    const content = draft.trim()
    const currentAttachments = [...attachments]
    if ((!content && currentAttachments.length === 0) || streaming || !activeModel) return
    if (contextProjection?.blocked && (!allowContextTrimming || !contextProjection.canTrimOnce)) {
      showToast(contextProjection.message)
      return
    }
    if (!guardWebSearchAvailable()) return
    if (!guardProviderKey()) return

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
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
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
    const fallbackTitle = content || (currentAttachments[0] ? `[文件] ${currentAttachments[0].name}` : '新对话')
    const nextConversation: Conversation = {
      ...conversation,
      title: conversation.messages.length === 0 ? makeTitle(fallbackTitle) : conversation.title,
      modelId: activeModel.id,
      reasoningEnabled,
      webSearchMode,
      messages: [...conversation.messages, userMessage, assistantMessage],
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    setDraft('')
    setAttachments([])
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
      setAttachments(currentAttachments)
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

  const handleRegenerate = async (allowContextTrimming = false): Promise<void> => {
    if (streaming || !activeModel || !activeConversation) return
    const messages = activeConversation.messages
    let lastAssistantIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') {
        lastAssistantIndex = index
        break
      }
    }
    if (lastAssistantIndex < 0) return
    const history = messages.slice(0, lastAssistantIndex)
    if (!history.some((message) => message.role === 'user')) return

    const projection = projectContext(history, '', settings, activeModel)
    if (projection.blocked && (!allowContextTrimming || !projection.canTrimOnce)) {
      showToast(projection.message)
      return
    }
    if (!guardWebSearchAvailable()) return
    if (!guardProviderKey()) return

    const timestamp = new Date().toISOString()
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
      ...activeConversation,
      modelId: activeModel.id,
      reasoningEnabled,
      webSearchMode,
      messages: [...history, assistantMessage],
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    setStreaming(true)
    activeStreamRef.current = {
      requestId: '',
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id
    }

    const requestMessages: Message[] = history.map(({ status: _status, modelId: _modelId, error: _error, ...message }) => message)

    const persisted = await persistConversation({
      ...nextConversation,
      messages: history
    })
    if (!persisted) {
      replaceConversations((current) => current.map((item) => (
        item.id === activeConversation.id ? activeConversation : item
      )))
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

  const handleEditMessage = async (messageId: string, nextContent: string, regenerate: boolean): Promise<boolean> => {
    const content = nextContent.trim()
    if (streaming || !activeModel || !activeConversation) return false
    const messages = activeConversation.messages
    const targetIndex = messages.findIndex((message) => message.id === messageId && message.role === 'user')
    if (targetIndex < 0) return false
    const targetMessage = messages[targetIndex]
    if (!content && !targetMessage?.attachments?.length) return false

    if (!regenerate) {
      const timestamp = new Date().toISOString()
      const nextConversation: Conversation = {
        ...activeConversation,
        messages: messages.map((message) => message.id === messageId ? { ...message, content } : message),
        updatedAt: timestamp
      }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      void persistConversation(nextConversation)
      return true
    }

    const editedHistory = messages.slice(0, targetIndex + 1).map((message, index) => (
      index === targetIndex ? { ...message, content } : message
    ))
    if (!editedHistory.some((message) => message.role === 'user')) return false

    const projection = projectContext(editedHistory, '', settings, activeModel)
    if (projection.blocked) {
      showToast(projection.message)
      return false
    }
    if (!guardWebSearchAvailable()) return false
    if (!guardProviderKey()) return false

    const timestamp = new Date().toISOString()
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
      ...activeConversation,
      modelId: activeModel.id,
      reasoningEnabled,
      webSearchMode,
      messages: [...editedHistory, assistantMessage],
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    setStreaming(true)
    activeStreamRef.current = {
      requestId: '',
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id
    }

    const requestMessages: Message[] = editedHistory.map(({ status: _status, modelId: _modelId, error: _error, ...message }) => message)

    const persisted = await persistConversation({
      ...nextConversation,
      messages: editedHistory
    })
    if (!persisted) {
      replaceConversations((current) => current.map((item) => (
        item.id === activeConversation.id ? activeConversation : item
      )))
      setStreaming(false)
      activeStreamRef.current = null
      return false
    }

    try {
      const { requestId } = await window.chatbox.chat.stream({
        conversationId: nextConversation.id,
        modelId: activeModel.id,
        messages: requestMessages,
        reasoningEnabled,
        webSearchMode,
        reasoningEffort: activeModel.defaultReasoningEffort ?? settings.defaultReasoningEffort,
        maxOutputTokens: activeModel.maxOutputTokens
      })
      if (activeStreamRef.current?.assistantMessageId === assistantMessage.id) {
        activeStreamRef.current.requestId = requestId
      }
      return true
    } catch (error) {
      const requestId = activeStreamRef.current?.requestId ?? ''
      finishStream({
        type: 'error',
        requestId,
        error: { message: normalizeError(error) }
      })
      return false
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
    const nextTitleGenerationModelId = payload.preferences.titleGenerationModelId
      ? (modelIdMap.get(payload.preferences.titleGenerationModelId) ?? (savedModels.some((model) => model.id === payload.preferences.titleGenerationModelId) ? payload.preferences.titleGenerationModelId : undefined))
      : undefined
    const savedSettings = await window.chatbox.settings.update({
      ...payload.preferences,
      defaultModelId: nextDefaultModelId,
      titleGenerationModelId: nextTitleGenerationModelId
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

  const handleClearAllData = async (): Promise<void> => {
    if (activeStreamRef.current) {
      await window.chatbox.chat.cancel(activeStreamRef.current.requestId).catch(() => undefined)
      activeStreamRef.current = null
      setStreaming(false)
    }
    await window.chatbox.data.clearConversations()
    conversationsRef.current = []
    setConversations([])
    setActiveConversationId('')
    const fallbackModel = models.find((model) => model.id === settings.defaultModelId) ?? models[0]
    setActiveModelId(fallbackModel?.id ?? '')
    setReasoningEnabled(Boolean(fallbackModel?.supportsReasoning && (
      fallbackModel.defaultReasoningEnabled || settings.defaultReasoningEnabled
    )))
    setWebSearchMode(effectiveWebSearchMode(
      fallbackModel,
      providers.find((provider) => provider.id === fallbackModel?.providerId),
      fallbackModel?.defaultWebSearchMode,
    ))
    setDraft('')
    showToast('已清除全部会话数据。')
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
        onRenameConversation={renameConversation}
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
          onRenameConversation={(title) => activeConversation && renameConversation(activeConversation.id, title)}
          onRestoreSidebar={() => setSidebarCollapsed(false)}
          onToggleReasoning={handleToggleReasoning}
        />

        <section className="chat-stage">
          <ChatContent
            messages={visibleMessages}
            models={models}
            streaming={streaming}
            suggestions={promptSuggestions}
            onEditMessage={(messageId, content, regenerate) => handleEditMessage(messageId, content, regenerate)}
            onRegenerate={() => void handleRegenerate()}
            onSuggestion={setDraft}
          />
          <Composer
            activeModel={activeModel}
            attachments={attachments}
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
            onAttachmentsChange={setAttachments}
            onDraftChange={setDraft}
            onOpenContextSettings={() => openSettings('general')}
            onOpenModelSettings={() => openSettings('models')}
            onSend={() => void handleSend()}
            onSendWithTrim={() => void handleSend(true)}
            onShowToast={showToast}
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
        onClearData={handleClearAllData}
        onDiscoverModels={discoverModels}
        onSave={saveSettings}
        onTestProvider={testProvider}
      />

      {toast && <div className="toast" role="status"><Icon name="info" size={16} /><span>{toast}</span></div>}
    </div>
  )
}
