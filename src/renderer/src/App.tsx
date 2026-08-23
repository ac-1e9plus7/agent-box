import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppSettings,
  ChatRequest,
  ExportBackupInput,
  ExportBackupResult,
  McpServerConfig,
  McpServerInput,
  McpServerTestResult,
  McpToolDefinition,
  Message,
  MessageAttachment,
  ModelInput,
  ProviderInput,
  Skill,
  SkillInput,
  StreamEvent,
} from '../../shared/types'
import { ChatContent } from './components/ChatContent'
import { Composer } from './components/Composer'
import { Icon } from './components/Icon'
import { NewConversationDialog } from './components/NewConversationDialog'
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
import {
  getActiveMessageChain,
  getAncestorsForRegeneration,
} from '../../shared/conversation-tree'
import { effectiveWebSearchMode, isWebSearchAvailable } from './web-search'
import { projectContext } from './context-projection'
import { runStreamWithReplay } from './stream-helper'
import { DEFAULT_AGENT_TOOL_TURN_LIMIT } from '../../shared/agent-limits'
import { interruptionFromStreamEvent, resolveNaturalAgentResumeMessageId } from './agent-continuation'
import {
  cleanGeneratedTitle,
  cleanManualTitle,
  firstUserQuestion,
  TITLE_SYSTEM_PROMPT
} from './title'
import { languageFromSystemLocale, setLanguage } from '../../shared/i18n'
import { t } from "../../shared/i18n"
import {
  toStoredConversation,
  toUiConversation,
  useConversation,
  useNewConversationShortcut,
} from './hooks/useConversation'
import { useChatStream } from './hooks/useChatStream'
import type { StreamRegistration } from './hooks/useChatStream'

const emptySettings: AppSettings = {
  language: languageFromSystemLocale(navigator.language),
  theme: 'system',
  sendShortcut: 'enter',
  userNickname: '',
  userAvatar: '',
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  defaultAgentMode: false,
  agentToolTurnLimit: DEFAULT_AGENT_TOOL_TURN_LIMIT,
  mcpEnabled: true,
  mcpToolRetrievalMode: 'auto',
  mcpToolApprovalPolicy: 'sensitive',
  toolApprovalTimeoutMode: 'five-minutes',
  contextManagementMode: 'manual',
  systemPrompt: '',
  proxy: { mode: 'off', url: '' },
  integratedTerminalShell: { mode: 'auto', executable: '', args: [] },
  defaultWorkingDirectory: '',
  developerRuntimes: {
    jdk: { mode: 'auto', home: '' },
    go: { mode: 'auto', executable: '', root: '' },
    php: { mode: 'auto', executable: '' },
    python: { mode: 'auto', executable: '', environment: '', condaExecutable: 'conda' }
  }
}

interface SendOptions {
  content?: string
  preserveComposer?: boolean
  resumeFromMessageId?: string
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function makeTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized || t("新对话")
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : t("发生未知错误，请稍后重试。")
}


export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(emptySettings)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([])
  const [mcpTools, setMcpTools] = useState<McpToolDefinition[]>([])
  const [activeModelId, setActiveModelId] = useState('')
  const [agentMode, setAgentMode] = useState(false)
  const [reasoningEnabled, setReasoningEnabled] = useState(false)
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>('off')
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [query, setQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [newConversationOpen, setNewConversationOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState('')
  const [toast, setToast] = useState('')

  const toastTimerRef = useRef<number | undefined>(undefined)
  const autoRenamingRef = useRef<Set<string>>(new Set())
  const manualRenamedRef = useRef<Set<string>>(new Set())

  const activeModel = models.find((model) => model.id === activeModelId)
  const activeProvider = providers.find((provider) => provider.id === activeModel?.providerId)
  const webSearchAvailable = isWebSearchAvailable(activeModel, activeProvider)

  useEffect(() => {
    document.documentElement.lang = settings.language
  }, [settings.language])

  const showToast = useCallback((message: string): void => {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => setToast(''), 4200)
  }, [])

  const handleMissingConversationModel = useCallback((): void => {
      setNewConversationOpen(false)
      setSettingsSection('models')
      setSettingsOpen(true)
      showToast(t("请先添加一个模型。"))
  }, [showToast])

  const {
    activeConversation,
    activeConversationId,
    clearConversationState,
    conversations,
    conversationsRef,
    createConversation,
    creatingConversation,
    deleteActiveMessageBranch,
    hydrateConversations,
    persistConversation,
    replaceConversations,
    setActiveConversationId,
    switchActiveBranch,
  } = useConversation({
    models,
    onMissingModel: handleMissingConversationModel,
    providers,
    settings,
    showToast,
  })

  const visibleMessages = useMemo(
    () => (activeConversation ? getActiveMessageChain(activeConversation) : []).filter((message) => message.role !== 'system'),
    [activeConversation]
  )

  const contextProjection = useMemo(() => activeModel ? projectContext(
    visibleMessages,
    draft,
    settings,
    activeModel,
    attachments
  ) : undefined, [activeModel, attachments, draft, settings, visibleMessages])

  const openNewConversationDialog = useCallback((): void => {
    setNewConversationOpen(true)
    setMobileSidebarOpen(false)
  }, [])

  const handleNewConversationInWorkspace = useCallback(async (workingDirectory: string): Promise<void> => {
    const preserveComposer = !activeConversation
    const created = await createConversation({
      modelId: activeModelId,
      workingDirectory,
    })
    if (!created) return
    setActiveModelId(created.modelId)
    setAgentMode(Boolean(created.agentMode))
    setReasoningEnabled(Boolean(created.reasoningEnabled))
    setWebSearchMode(created.webSearchMode ?? 'off')
    if (!preserveComposer) {
      setDraft('')
      setAttachments([])
    }
    setQuery('')
    setMobileSidebarOpen(false)
    setNewConversationOpen(false)
  }, [activeConversation, activeModelId, createConversation])

  const handleChooseNewConversationDirectory = useCallback(async (): Promise<void> => {
    try {
      const selected = await window.agentbox.workspace.selectDirectory(
        activeConversation?.workingDirectory || settings.defaultWorkingDirectory || undefined,
      )
      if (selected) await handleNewConversationInWorkspace(selected)
    } catch (error) {
      showToast(t("无法选择工作目录：{value0}", { value0: normalizeError(error) }))
    }
  }, [activeConversation?.workingDirectory, handleNewConversationInWorkspace, settings.defaultWorkingDirectory, showToast])

  const bootstrap = useCallback(async (): Promise<void> => {
    setLoading(true)
    setBootstrapError('')
    try {
      if (!window.agentbox) throw new Error(t("安全桥接未加载，请重新启动应用。"))
      const [
        nextSettings,
        providerViews,
        modelViews,
        conversationViews,
        initialSkills,
        initialMcpServers,
        initialMcpTools,
      ] = await Promise.all([
        window.agentbox.settings.get(),
        window.agentbox.providers.list(),
        window.agentbox.models.list(),
        window.agentbox.conversations.list(),
        window.agentbox.skills.list(),
        window.agentbox.mcp.listServers(),
        window.agentbox.mcp.listTools()
      ])
      const uiProviders: ProviderConfig[] = providerViews.map((provider) => ({
        ...provider,
        isBuiltIn: provider.id === 'openrouter'
      }))
      const uiConversations = conversationViews.map(toUiConversation)
      setSettings(nextSettings)
      setLanguage(nextSettings.language)
      setProviders(uiProviders)
      setModels(modelViews)
      setSkills(initialSkills)
      setMcpServers(initialMcpServers)
      setMcpTools(initialMcpTools)

      const initialConversation = uiConversations[0]
      const initialModel = modelViews.find((model) => model.id === initialConversation?.modelId)
        ?? modelViews.find((model) => model.id === nextSettings.defaultModelId)
        ?? modelViews[0]
      const initialProvider = uiProviders.find((provider) => provider.id === initialModel?.providerId)
      hydrateConversations(uiConversations, initialConversation?.id)
      setActiveModelId(initialModel?.id ?? '')
      setAgentMode(initialConversation?.agentMode ?? nextSettings.defaultAgentMode ?? false)
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
  }, [hydrateConversations])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useNewConversationShortcut({
    enabled: !loading && !settingsOpen,
    onOpen: openNewConversationDialog,
  })

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
        window.agentbox.chat.stream,
        window.agentbox.chat.onEvent,
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

  const {
    cancelAllStreams,
    cancelConversationStream,
    discardStream,
    launchPreparedStream,
    prepareStream,
    resolveToolApproval,
    stopStream,
    streamingConversationIds,
  } = useChatStream({
    maybeGenerateTitle,
    persistConversation,
    replaceConversations,
    showToast,
  })

  const isCurrentStreaming = Boolean(
    activeConversationId && streamingConversationIds.has(activeConversationId),
  )


  const handleSelectConversation = (conversationId: string): void => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId)
    if (!conversation) return
    setActiveConversationId(conversation.id)
    setActiveModelId(conversation.modelId)
    setAgentMode(conversation.agentMode ?? settings.defaultAgentMode ?? false)
    setReasoningEnabled(Boolean(conversation.reasoningEnabled))
    const model = models.find((item) => item.id === conversation.modelId)
    const provider = providers.find((item) => item.id === model?.providerId)
    setWebSearchMode(effectiveWebSearchMode(model, provider, conversation.webSearchMode ?? 'off'))
    setAttachments([])
    setMobileSidebarOpen(false)
  }

  const handleDeleteConversation = async (conversationId: string): Promise<void> => {
    await cancelConversationStream(conversationId)
    autoRenamingRef.current.delete(conversationId)
    manualRenamedRef.current.delete(conversationId)
    try {
      await window.agentbox.conversations.remove(conversationId)
      const next = replaceConversations((current) => current.filter((conversation) => conversation.id !== conversationId))
      if (activeConversationId === conversationId) {
        const nextConversation = next[0]
        setActiveConversationId(nextConversation?.id ?? '')
        const nextModelId = nextConversation?.modelId ?? settings.defaultModelId ?? models[0]?.id ?? ''
        const nextModel = models.find((model) => model.id === nextModelId)
        const nextProvider = providers.find((provider) => provider.id === nextModel?.providerId)
        setActiveModelId(nextModelId)
        setAgentMode(nextConversation?.agentMode ?? settings.defaultAgentMode ?? false)
        setReasoningEnabled(Boolean(nextConversation?.reasoningEnabled ?? settings.defaultReasoningEnabled))
        setWebSearchMode(effectiveWebSearchMode(
          nextModel,
          nextProvider,
          nextConversation ? nextConversation.webSearchMode ?? 'off' : nextModel?.defaultWebSearchMode
        ))
      }
    } catch (error) {
      showToast(t("删除失败：{value0}", { value0: normalizeError(error) }))
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
    void window.agentbox.settings.update({ defaultModelId: modelId }).catch((error) => showToast(normalizeError(error)))

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

  const handleToggleAgentMode = (): void => {
    const nextMode = !agentMode
    setAgentMode(nextMode)
    if (activeConversation) {
      const nextConversation: Conversation = {
        ...activeConversation,
        agentMode: nextMode,
        updatedAt: new Date().toISOString()
      }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      void persistConversation(nextConversation)
    }
  }

  const handleMcpServerSelectionChange = useCallback((serverIds: string[]): void => {
    if (!activeConversation) return
    const nextConversation: Conversation = {
      ...activeConversation,
      mcpServerIds: serverIds,
      updatedAt: new Date().toISOString()
    }
    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    void persistConversation(nextConversation)
  }, [activeConversation, persistConversation, replaceConversations])

  const handleSkillSelectionChange = useCallback((skillIds: string[]): void => {
    if (!activeConversation) return
    const nextConversation: Conversation = {
      ...activeConversation,
      skillIds: skillIds.length > 0 ? skillIds : undefined,
      updatedAt: new Date().toISOString()
    }
    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    void persistConversation(nextConversation)
  }, [activeConversation, persistConversation, replaceConversations])

  const handleChangeWorkingDirectory = useCallback(async (): Promise<Conversation | undefined> => {
    if (!activeConversation) return undefined
    try {
      const selected = await window.agentbox.workspace.selectDirectory(
        activeConversation.workingDirectory || settings.defaultWorkingDirectory || undefined,
      )
      if (!selected) return undefined
      const nextConversation: Conversation = {
        ...activeConversation,
        workingDirectory: selected,
        updatedAt: new Date().toISOString(),
      }
      replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
      return await persistConversation(nextConversation) ? nextConversation : undefined
    } catch (error) {
      showToast(t("无法选择工作目录：{value0}", { value0: normalizeError(error) }))
      return undefined
    }
  }, [activeConversation, persistConversation, replaceConversations, settings.defaultWorkingDirectory, showToast])

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

  const handleUpsertSkill = useCallback(async (input: SkillInput): Promise<Skill> => {
    const saved = await window.agentbox.skills.upsert(input)
    setSkills((prev) => {
      const exists = prev.some((s) => s.id === saved.id)
      return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved]
    })
    return saved
  }, [])

  const handleRemoveSkill = useCallback(async (id: string): Promise<void> => {
    await window.agentbox.skills.remove(id)
    setSkills((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const handleToggleSkill = useCallback(async (id: string, enabled: boolean): Promise<Skill> => {
    const updated = await window.agentbox.skills.toggle(id, enabled)
    setSkills((prev) => prev.map((s) => (s.id === id ? updated : s)))
    return updated
  }, [])

  const handleResetDefaultSkills = useCallback(async (): Promise<Skill[]> => {
    const reset = await window.agentbox.skills.resetDefaults()
    setSkills(reset)
    return reset
  }, [])

  const handleUpsertMcpServer = useCallback(async (input: McpServerInput): Promise<McpServerConfig> => {
    const saved = await window.agentbox.mcp.upsertServer(input)
    const [servers, tools] = await Promise.all([
      window.agentbox.mcp.listServers(),
      window.agentbox.mcp.listTools()
    ])
    setMcpServers(servers)
    setMcpTools(tools)
    return saved
  }, [])

  const handleRemoveMcpServer = useCallback(async (id: string): Promise<void> => {
    await window.agentbox.mcp.removeServer(id)
    const [servers, tools] = await Promise.all([
      window.agentbox.mcp.listServers(),
      window.agentbox.mcp.listTools()
    ])
    setMcpServers(servers)
    setMcpTools(tools)
  }, [])

  const handleToggleMcpServer = useCallback(async (id: string, enabled: boolean): Promise<McpServerConfig> => {
    const updated = await window.agentbox.mcp.toggleServer(id, enabled)
    const [servers, tools] = await Promise.all([
      window.agentbox.mcp.listServers(),
      window.agentbox.mcp.listTools()
    ])
    setMcpServers(servers)
    setMcpTools(tools)
    return updated
  }, [])

  const handleTestMcpServer = useCallback(async (input: McpServerInput): Promise<McpServerTestResult> => {
    return window.agentbox.mcp.testServer(input)
  }, [])

  const handleListMcpTools = useCallback(async (serverId?: string): Promise<McpToolDefinition[]> => {
    const tools = await window.agentbox.mcp.listTools(serverId)
    setMcpTools(tools)
    return tools
  }, [])

  const handleTestTerminalShell = useCallback((config: AppSettings['integratedTerminalShell']) => (
    window.agentbox.terminal.testShell(config)
  ), [])

  const handleSelectDirectory = useCallback((initialPath?: string) => (
    window.agentbox.workspace.selectDirectory(initialPath)
  ), [])

  const handleTestRuntime = useCallback((kind: Parameters<typeof window.agentbox.runtimes.test>[0], runtimes: AppSettings['developerRuntimes'], workingDirectory?: string) => (
    window.agentbox.runtimes.test(kind, runtimes, workingDirectory)
  ), [])

  const handleListCondaEnvironments = useCallback((condaExecutable: string) => (
    window.agentbox.runtimes.listCondaEnvironments(condaExecutable)
  ), [])


  const handleWebSearchModeChange = (mode: WebSearchMode): void => {
    if (mode !== 'off' && !webSearchAvailable) {
      showToast(t("联网搜索仅支持 OpenRouter 连接。"))
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
    showToast(t("当前模型或 API 格式不支持联网搜索，已切换为关闭。"))
    return false
  }, [activeConversation, persistConversation, replaceConversations, showToast, webSearchAvailable, webSearchMode])

  const guardProviderKey = useCallback((): boolean => {
    if (!activeProvider || (!activeProvider.hasApiKey && !activeProvider.apiKeyOptional)) {
      setSettingsSection('providers')
      setSettingsOpen(true)
      showToast(t("请先为当前服务商配置 API 密钥。"))
      return false
    }
    return true
  }, [activeProvider, showToast])

  const buildChatRequest = useCallback((
    conversation: Conversation,
    messages: Message[],
    options?: Pick<ChatRequest, 'allowContextTrimming' | 'resumeFromMessageId'>,
  ): ChatRequest => {
    if (!activeModel) throw new Error(t("当前模型不可用。"))
    return {
      conversationId: conversation.id,
      modelId: activeModel.id,
      messages,
      agentMode: conversation.agentMode ?? agentMode,
      skillIds: conversation.skillIds,
      mcpServerIds: conversation.mcpServerIds,
      workingDirectory: conversation.workingDirectory,
      resumeFromMessageId: options?.resumeFromMessageId,
      reasoningEnabled,
      webSearchMode,
      reasoningEffort: activeModel.defaultReasoningEffort ?? settings.defaultReasoningEffort,
      maxOutputTokens: activeModel.maxOutputTokens,
      allowContextTrimming: options?.allowContextTrimming,
    }
  }, [activeModel, agentMode, reasoningEnabled, settings.defaultReasoningEffort, webSearchMode])

  const handleSend = async (allowContextTrimming = false, options?: SendOptions): Promise<void> => {
    const usesExplicitContent = options?.content !== undefined
    const content = (options?.content ?? draft).trim()
    const currentAttachments = usesExplicitContent ? [] : [...attachments]
    if ((!content && currentAttachments.length === 0) || !activeModel) return

    if (activeConversation && streamingConversationIds.has(activeConversation.id)) return
    if (!activeConversation) {
      openNewConversationDialog()
      showToast(t("请先为新对话选择工作目录。"))
      return
    }
    if (!activeConversation.workingDirectory) {
      const assignedConversation = await handleChangeWorkingDirectory()
      if (assignedConversation) showToast(t("工作目录已设置，请再次发送。"))
      return
    }

    const conversation = activeConversation

    if (streamingConversationIds.has(conversation.id)) return

    const activeChain = getActiveMessageChain(conversation)
    const lastActiveMessage = activeChain[activeChain.length - 1]
    const explicitResumeMessage = options?.resumeFromMessageId
      ? lastActiveMessage?.role === 'assistant'
        && lastActiveMessage.id === options.resumeFromMessageId
        && Boolean(lastActiveMessage.interruption)
        ? lastActiveMessage
        : undefined
      : undefined
    if (options?.resumeFromMessageId && !explicitResumeMessage) {
      showToast(t("只能从当前分支最后一条中断的 Agent 回复继续。"))
      return
    }
    const resumeFromMessageId = explicitResumeMessage?.id
      ?? resolveNaturalAgentResumeMessageId(activeChain, content, currentAttachments.length > 0)
    const sendProjection = usesExplicitContent
      ? projectContext(visibleMessages, content, settings, activeModel, currentAttachments)
      : contextProjection
    if (sendProjection?.blocked && (!allowContextTrimming || !sendProjection.canTrimOnce)) {
      showToast(sendProjection.message)
      return
    }
    if (!guardWebSearchAvailable()) return
    if (!guardProviderKey()) return

    const timestamp = new Date().toISOString()

    const userMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content,
      parentMessageId: lastActiveMessage ? lastActiveMessage.id : null,
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      createdAt: timestamp,
      status: 'complete'
    }
    const assistantMessage: ChatMessage = {
      id: createId('message'),
      role: 'assistant',
      content: '',
      reasoning: '',
      parentMessageId: userMessage.id,
      createdAt: timestamp,
      modelId: activeModel.id,
      status: 'streaming'
    }
    const fallbackTitle = content || (currentAttachments[0] ? t("[文件] {value0}", { value0: currentAttachments[0].name }) : t("新对话"))
    const nextConversation: Conversation = {
      ...conversation,
      title: conversation.messages.length === 0 ? makeTitle(fallbackTitle) : conversation.title,
      modelId: activeModel.id,
      reasoningEnabled,
      agentMode: resumeFromMessageId ? true : conversation.agentMode ?? agentMode,
      webSearchMode,
      messages: [...conversation.messages, userMessage, assistantMessage],
      currentLeafId: assistantMessage.id,
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    if (!options?.preserveComposer) {
      setDraft('')
      setAttachments([])
    }
    if (resumeFromMessageId) setAgentMode(true)
    const streamRegistration: StreamRegistration = {
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id,
      agentMode: Boolean(nextConversation.agentMode),
    }
    prepareStream(streamRegistration)

    const requestMessages: Message[] = [...activeChain, userMessage].map(
      ({ status: _status, modelId: _modelId, error: _error, ...message }) => message
    )

    const persisted = await persistConversation({
      ...nextConversation,
      messages: nextConversation.messages.filter((message) => message.id !== assistantMessage.id)
    })
    if (!persisted) {
      replaceConversations((current) => current.map((item) => (
        item.id === conversation.id ? conversation : item
      )))
      if (!options?.preserveComposer) {
        setDraft(content)
        setAttachments(currentAttachments)
      }
      discardStream(nextConversation.id)
      return
    }

    await launchPreparedStream(
      streamRegistration,
      buildChatRequest(nextConversation, requestMessages, {
        resumeFromMessageId,
        allowContextTrimming: allowContextTrimming || undefined,
      }),
    )
  }

  const handleResumeAgentExecution = async (assistantMessageId: string): Promise<void> => {
    await handleSend(false, {
      content: t("继续之前中断的工作"),
      preserveComposer: true,
      resumeFromMessageId: assistantMessageId,
    })
  }

  const handleStop = async (conversationId?: string): Promise<void> => {
    const targetConvId = conversationId ?? activeConversationId
    await stopStream(targetConvId)
  }

  const handleToolApproval = useCallback(async (callId: string, approved: boolean): Promise<void> => {
    await resolveToolApproval(activeConversationId, callId, approved)
  }, [activeConversationId, resolveToolApproval])

  const handleRegenerate = async (targetAssistantId?: string, allowContextTrimming = false): Promise<void> => {
    if (!activeModel || !activeConversation || streamingConversationIds.has(activeConversation.id)) return
    const activeChain = getActiveMessageChain(activeConversation)

    let targetMsg: ChatMessage | undefined
    if (targetAssistantId) {
      targetMsg = activeConversation.messages.find(
        (message) => message.id === targetAssistantId && message.role === 'assistant'
      )
    }
    if (!targetMsg) {
      for (let index = activeChain.length - 1; index >= 0; index -= 1) {
        if (activeChain[index]?.role === 'assistant') {
          targetMsg = activeChain[index]
          break
        }
      }
    }
    if (!targetMsg) return

    const { ancestors, parentUserMessage } = getAncestorsForRegeneration(
      activeConversation.messages,
      targetMsg.id
    )
    if (!parentUserMessage || ancestors.length === 0) return

    const projection = projectContext(ancestors, '', settings, activeModel)
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
      parentMessageId: targetMsg.parentMessageId,
      createdAt: timestamp,
      modelId: activeModel.id,
      status: 'streaming'
    }
    const nextConversation: Conversation = {
      ...activeConversation,
      modelId: activeModel.id,
      reasoningEnabled,
      webSearchMode,
      messages: [...activeConversation.messages, assistantMessage],
      currentLeafId: assistantMessage.id,
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    const streamRegistration: StreamRegistration = {
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id,
      agentMode: Boolean(nextConversation.agentMode ?? agentMode),
    }
    prepareStream(streamRegistration)

    const requestMessages: Message[] = ancestors.map(
      ({ status: _status, modelId: _modelId, error: _error, ...message }) => message
    )

    const persisted = await persistConversation({
      ...nextConversation,
      messages: nextConversation.messages.filter((message) => message.id !== assistantMessage.id)
    })
    if (!persisted) {
      replaceConversations((current) => current.map((item) => (
        item.id === activeConversation.id ? activeConversation : item
      )))
      discardStream(nextConversation.id)
      return
    }

    await launchPreparedStream(
      streamRegistration,
      buildChatRequest(nextConversation, requestMessages, {
        allowContextTrimming: allowContextTrimming || undefined,
      }),
    )
  }

  const handleSwitchVersion = useCallback((targetMessageId: string): void => {
    if (!activeConversation || streamingConversationIds.has(activeConversation.id)) return
    switchActiveBranch(targetMessageId)
  }, [activeConversation, streamingConversationIds, switchActiveBranch])

  const handleDeleteMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!activeConversation) return
    await cancelConversationStream(activeConversation.id)
    deleteActiveMessageBranch(messageId)
  }, [activeConversation, cancelConversationStream, deleteActiveMessageBranch])

  const handleEditMessage = async (messageId: string, nextContent: string, regenerate: boolean): Promise<boolean> => {
    const content = nextContent.trim()
    if (!activeModel || !activeConversation || streamingConversationIds.has(activeConversation.id)) return false
    const messages = activeConversation.messages
    const targetUserMsg = messages.find((message) => message.id === messageId && message.role === 'user')
    if (!targetUserMsg) return false
    if (!content && !targetUserMsg.attachments?.length) return false

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

    let ancestors: ChatMessage[] = []
    if (targetUserMsg.parentMessageId) {
      const { ancestors: anc } = getAncestorsForRegeneration(messages, targetUserMsg.id)
      ancestors = anc
    }

    const timestamp = new Date().toISOString()
    const newUserMessage: ChatMessage = {
      id: createId('message'),
      role: 'user',
      content,
      parentMessageId: targetUserMsg.parentMessageId,
      attachments: targetUserMsg.attachments,
      createdAt: timestamp,
      status: 'complete'
    }

    const historyForPrompt = [...ancestors, newUserMessage]
    const projection = projectContext(historyForPrompt, '', settings, activeModel)
    if (projection.blocked) {
      showToast(projection.message)
      return false
    }
    if (!guardWebSearchAvailable()) return false
    if (!guardProviderKey()) return false

    const assistantMessage: ChatMessage = {
      id: createId('message'),
      role: 'assistant',
      content: '',
      reasoning: '',
      parentMessageId: newUserMessage.id,
      createdAt: timestamp,
      modelId: activeModel.id,
      status: 'streaming'
    }

    const nextConversation: Conversation = {
      ...activeConversation,
      modelId: activeModel.id,
      reasoningEnabled,
      webSearchMode,
      messages: [...messages, newUserMessage, assistantMessage],
      currentLeafId: assistantMessage.id,
      updatedAt: timestamp
    }

    replaceConversations((current) => current.map((item) => item.id === nextConversation.id ? nextConversation : item))
    const streamRegistration: StreamRegistration = {
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id,
      agentMode: Boolean(nextConversation.agentMode ?? agentMode),
    }
    prepareStream(streamRegistration)

    const requestMessages: Message[] = historyForPrompt.map(
      ({ status: _status, modelId: _modelId, error: _error, ...message }) => message
    )

    const persisted = await persistConversation({
      ...nextConversation,
      messages: nextConversation.messages.filter((message) => message.id !== assistantMessage.id)
    })
    if (!persisted) {
      replaceConversations((current) => current.map((item) => (
        item.id === activeConversation.id ? activeConversation : item
      )))
      discardStream(nextConversation.id)
      return false
    }

    return launchPreparedStream(
      streamRegistration,
      buildChatRequest(nextConversation, requestMessages),
    )
  }

  const saveSettings = async (payload: SettingsSavePayload): Promise<void> => {
    const languageChanged = payload.preferences.language !== settings.language
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
      const saved = await window.agentbox.providers.upsert(input)
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
      const saved = await window.agentbox.models.upsert(input)
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
      conversation.modelId ? window.agentbox.conversations.save(toStoredConversation(conversation)) : Promise.resolve()
    )))

    const keptModelIds = new Set(payload.models.filter((model) => existingModelIds.has(model.id)).map((model) => model.id))
    for (const model of models) {
      if (!keptModelIds.has(model.id)) await window.agentbox.models.remove(model.id)
    }
    const keptProviderIds = new Set(payload.providers.filter((provider) => existingProviderIds.has(provider.id)).map((provider) => provider.id))
    for (const provider of providers) {
      if (!keptProviderIds.has(provider.id)) await window.agentbox.providers.remove(provider.id)
    }

    const nextDefaultModelId = modelIdMap.get(payload.preferences.defaultModelId ?? '')
      ?? (savedModels.some((model) => model.id === payload.preferences.defaultModelId) ? payload.preferences.defaultModelId : fallbackModelId)
    const nextTitleGenerationModelId = payload.preferences.titleGenerationModelId
      ? (modelIdMap.get(payload.preferences.titleGenerationModelId) ?? (savedModels.some((model) => model.id === payload.preferences.titleGenerationModelId) ? payload.preferences.titleGenerationModelId : undefined))
      : undefined
    const savedSettings = await window.agentbox.settings.update({
      ...payload.preferences,
      defaultModelId: nextDefaultModelId,
      titleGenerationModelId: nextTitleGenerationModelId
    })
    setLanguage(savedSettings.language)
    setProviders(savedProviders)
    setModels(savedModels)
    setSettings(savedSettings)
    hydrateConversations(updatedConversations, activeConversationId)

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
    showToast(t("设置已保存。"))
    if (languageChanged) window.setTimeout(() => window.location.reload(), 150)
  }

  const testProvider = async (
    provider: ProviderConfig,
    apiKeyInput: string,
    clearApiKey: boolean
  ): Promise<boolean> => {
    try {
      const isPersisted = providers.some((item) => item.id === provider.id)
      const result = await window.agentbox.providers.test({
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
    await cancelAllStreams()
    await window.agentbox.data.clearConversations()
    clearConversationState()
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
    showToast(t("已清除全部会话数据。"))
  }

  const handleExportBackup = async (input: ExportBackupInput): Promise<ExportBackupResult> => {
    const result = await window.agentbox.data.exportBackup(input)
    if (!result.canceled) {
      showToast(t(
        result.mode === 'deep' ? 'backup.exported.deep' : 'backup.exported.shallow',
        { count: result.conversationCount },
      ))
    }
    return result
  }

  const discoverModels = async (providerId: string) => {
    try {
      const discovered = await window.agentbox.models.discover(providerId)
      showToast(t("已获取 {value0} 个模型。", { value0: discovered.length }))
      return discovered
    } catch (error) {
      const message = normalizeError(error)
      showToast(message)
      throw new Error(message)
    }
  }

  if (loading) {
    return (
      <main className="app-loading">
        <span className="loading-mark"><Icon name="app" size={34} /></span>
        <h1>AgentBox</h1>
        <div className="loading-line"><i /></div>
        <p>{t("正在解锁本地数据…")}</p>
      </main>
    )
  }

  if (bootstrapError) {
    return (
      <main className="fatal-state">
        <span><Icon name="lock" size={30} /></span>
        <h1>{t("无法打开本地数据")}</h1>
        <p>{bootstrapError}</p>
        <button onClick={() => void bootstrap()}><Icon name="refresh" size={16} />{t("重试")}</button>
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
        userAvatar={settings.userAvatar}
        userNickname={settings.userNickname}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onCollapse={() => setSidebarCollapsed(true)}
        onDeleteConversation={(id) => void handleDeleteConversation(id)}
        onNewConversation={openNewConversationDialog}
        onNewConversationInWorkspace={(workingDirectory) => void handleNewConversationInWorkspace(workingDirectory)}
        onOpenSettings={() => openSettings('general')}
        onRenameConversation={renameConversation}
        onQueryChange={setQuery}
        onSelectConversation={handleSelectConversation}
      />

      <main className="chat-workspace">
        <Topbar
          activeModel={activeModel}
          activeTitle={activeConversation?.title ?? t("新对话")}
          agentMode={agentMode}
          enabledSkillsCount={skills.filter((skill) => skill.enabled).length}
          selectedSkillsCount={activeConversation?.skillIds?.length ?? 0}
          workingDirectory={activeConversation?.workingDirectory}
          models={models}
          providers={providers}
          reasoningEnabled={reasoningEnabled}
          sidebarCollapsed={sidebarCollapsed}
          onModelChange={(modelId) => void handleModelChange(modelId)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          onOpenSettings={() => openSettings('models')}
          onOpenSkillsSettings={() => openSettings('skills')}
          onRenameConversation={(title) => activeConversation && renameConversation(activeConversation.id, title)}
          onRestoreSidebar={() => setSidebarCollapsed(false)}
          onToggleAgentMode={handleToggleAgentMode}
          onToggleReasoning={handleToggleReasoning}
          onChangeWorkingDirectory={activeConversation
            ? () => void handleChangeWorkingDirectory()
            : openNewConversationDialog}
        />

        <section className="chat-stage">
          <ChatContent
            messages={visibleMessages}
            allMessages={activeConversation?.messages}
            models={models}
            streaming={isCurrentStreaming}
            suggestions={promptSuggestions}
            userAvatar={settings.userAvatar}
            userNickname={settings.userNickname}
            onDeleteMessage={(messageId) => void handleDeleteMessage(messageId)}
            onEditMessage={(messageId, content, regenerate) => handleEditMessage(messageId, content, regenerate)}
            onRegenerate={(targetAssistantId) => void handleRegenerate(targetAssistantId)}
            onResumeAgent={(assistantMessageId) => void handleResumeAgentExecution(assistantMessageId)}
            onSwitchVersion={handleSwitchVersion}
            onSuggestion={setDraft}
            onResolveToolApproval={(callId, approved) => void handleToolApproval(callId, approved)}
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
            agentMode={agentMode}
            skills={skills}
            selectedSkillIds={activeConversation?.skillIds}
            mcpToolsCount={mcpTools.length}
            mcpServers={mcpServers}
            selectedMcpServerIds={activeConversation?.mcpServerIds}
            onOpenMcpSettings={() => openSettings('mcp')}
            onOpenSkillsSettings={() => openSettings('skills')}
            onMcpServerSelectionChange={handleMcpServerSelectionChange}
            onSkillSelectionChange={handleSkillSelectionChange}
            reasoningEnabled={reasoningEnabled}
            webSearchAvailable={webSearchAvailable}
            webSearchMode={webSearchMode}
            sendBlocked={contextProjection?.blocked ?? false}
            sendOnEnter={settings.sendShortcut === 'enter'}
            streaming={isCurrentStreaming}
            onAttachmentsChange={setAttachments}
            onDraftChange={setDraft}
            onOpenContextSettings={() => openSettings('general')}
            onOpenModelSettings={() => openSettings('models')}
            onSend={() => void handleSend()}
            onSendWithTrim={() => void handleSend(true)}
            onShowToast={showToast}
            onStop={() => void handleStop(activeConversationId)}
            onToggleAgentMode={handleToggleAgentMode}
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
        skills={skills}
        mcpServers={mcpServers}
        onUpsertMcpServer={handleUpsertMcpServer}
        onRemoveMcpServer={handleRemoveMcpServer}
        onToggleMcpServer={handleToggleMcpServer}
        onTestMcpServer={handleTestMcpServer}
        onListMcpTools={handleListMcpTools}
        onTestTerminalShell={handleTestTerminalShell}
        onSelectDirectory={handleSelectDirectory}
        onTestRuntime={handleTestRuntime}
        onListCondaEnvironments={handleListCondaEnvironments}
        onClose={() => setSettingsOpen(false)}
        onClearData={handleClearAllData}
        onExportBackup={handleExportBackup}
        onDiscoverModels={discoverModels}
        onSave={saveSettings}
        onTestProvider={testProvider}
        onUpsertSkill={handleUpsertSkill}
        onRemoveSkill={handleRemoveSkill}
        onToggleSkill={handleToggleSkill}
        onResetDefaultSkills={handleResetDefaultSkills}
      />

      {newConversationOpen && (
        <NewConversationDialog
          busy={creatingConversation}
          conversations={conversations}
          currentDirectory={activeConversation?.workingDirectory}
          defaultDirectory={settings.defaultWorkingDirectory}
          onCancel={() => setNewConversationOpen(false)}
          onChooseDirectory={() => void handleChooseNewConversationDirectory()}
          onSelectWorkspace={(workingDirectory) => void handleNewConversationInWorkspace(workingDirectory)}
        />
      )}

      {toast && <div className="toast" role="status"><Icon name="info" size={16} /><span>{toast}</span></div>}
    </div>
  )
}
