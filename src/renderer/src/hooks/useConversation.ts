import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, Conversation as StoredConversation } from '../../../shared/types'
import { deleteMessageNode, ensureMessageTree, switchBranch } from '../../../shared/conversation-tree'
import type { Conversation, ModelConfig, ProviderConfig } from '../types'
import { effectiveWebSearchMode } from '../web-search'
import { t } from '../../../shared/i18n'

export interface CreateConversationOptions {
  modeOverrides?: Pick<Conversation, 'reasoningEnabled' | 'webSearchMode' | 'agentMode'>
  modelId?: string
  workingDirectory: string
}

interface UseConversationOptions {
  models: ModelConfig[]
  onMissingModel: () => void
  providers: ProviderConfig[]
  settings: AppSettings
  showToast: (message: string) => void
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : t("An unknown error occurred. Try again later.")
}

export function toUiConversation(conversation: StoredConversation): Conversation {
  const normalizedMessages = ensureMessageTree(conversation.messages)
  return {
    ...conversation,
    currentLeafId: conversation.currentLeafId ?? normalizedMessages.at(-1)?.id,
    messages: normalizedMessages.map((message) => ({
      ...message,
      modelId: message.role === 'assistant' ? conversation.modelId : undefined,
      error: message.interruption?.message,
      status: message.interruption ? 'error' : 'complete',
    })),
  }
}

export function toStoredConversation(conversation: Conversation): StoredConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    modelId: conversation.modelId,
    reasoningEnabled: conversation.reasoningEnabled,
    agentMode: conversation.agentMode,
    skillIds: conversation.skillIds,
    mcpServerIds: conversation.mcpServerIds,
    workingDirectory: conversation.workingDirectory,
    webSearchMode: conversation.webSearchMode ?? 'off',
    currentLeafId: conversation.currentLeafId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map(({
      status: _status,
      modelId: _modelId,
      error: _error,
      ...message
    }) => message),
  }
}

export function useConversation({
  models,
  onMissingModel,
  providers,
  settings,
  showToast,
}: UseConversationOptions) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [creatingConversation, setCreatingConversation] = useState(false)
  const conversationsRef = useRef<Conversation[]>([])
  const creatingConversationRef = useRef(false)

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)

  const replaceConversations = useCallback((updater: (current: Conversation[]) => Conversation[]): Conversation[] => {
    const next = updater(conversationsRef.current)
    conversationsRef.current = next
    setConversations(next)
    return next
  }, [])

  const hydrateConversations = useCallback((next: Conversation[], activeId?: string): void => {
    conversationsRef.current = next
    setConversations(next)
    setActiveConversationId(activeId ?? next[0]?.id ?? '')
  }, [])

  const persistConversation = useCallback(async (conversation: Conversation): Promise<boolean> => {
    try {
      const saved = await window.agentbox.conversations.save(toStoredConversation(conversation))
      replaceConversations((current) => current.map((item) => (
        item.id === saved.id ? { ...toUiConversation(saved), messages: item.messages } : item
      )))
      return true
    } catch (error) {
      showToast(t("Failed to save the conversation: {value0}", { value0: normalizeError(error) }))
      return false
    }
  }, [replaceConversations, showToast])

  const createConversation = useCallback(async ({
    modeOverrides,
    modelId,
    workingDirectory,
  }: CreateConversationOptions): Promise<Conversation | undefined> => {
    const resolvedWorkingDirectory = workingDirectory.trim()
    if (!resolvedWorkingDirectory) {
      showToast(t("Choose a working directory before creating a conversation."))
      return undefined
    }
    if (creatingConversationRef.current) return undefined

    const resolvedModel = models.find((model) => model.id === modelId)
      ?? models.find((model) => model.id === settings.defaultModelId)
      ?? models[0]
    if (!resolvedModel) {
      onMissingModel()
      return undefined
    }

    creatingConversationRef.current = true
    setCreatingConversation(true)
    const now = new Date().toISOString()
    const resolvedProvider = providers.find((provider) => provider.id === resolvedModel.providerId)
    const conversation: Conversation = {
      id: `conversation-${crypto.randomUUID()}`,
      title: t("conversation.newPlaceholder"),
      modelId: resolvedModel.id,
      reasoningEnabled: resolvedModel.supportsReasoning && (
        modeOverrides?.reasoningEnabled ?? (
          resolvedModel.defaultReasoningEnabled || settings.defaultReasoningEnabled
        )
      ),
      agentMode: modeOverrides?.agentMode ?? settings.defaultAgentMode ?? false,
      workingDirectory: resolvedWorkingDirectory,
      webSearchMode: effectiveWebSearchMode(
        resolvedModel,
        resolvedProvider,
        modeOverrides?.webSearchMode ?? resolvedModel.defaultWebSearchMode,
      ),
      messages: [],
      createdAt: now,
      updatedAt: now,
    }

    try {
      const saved = toUiConversation(await window.agentbox.conversations.save(toStoredConversation(conversation)))
      replaceConversations((current) => [saved, ...current])
      setActiveConversationId(saved.id)
      return saved
    } catch (error) {
      showToast(t("Could not create the conversation: {value0}", { value0: normalizeError(error) }))
      return undefined
    } finally {
      creatingConversationRef.current = false
      setCreatingConversation(false)
    }
  }, [models, onMissingModel, providers, replaceConversations, settings.defaultAgentMode, settings.defaultModelId, settings.defaultReasoningEnabled, showToast])

  const switchActiveBranch = useCallback((targetMessageId: string): Conversation | undefined => {
    const current = conversationsRef.current.find((conversation) => conversation.id === activeConversationId)
    if (!current) return undefined
    const next = switchBranch(current, targetMessageId)
    replaceConversations((items) => items.map((item) => item.id === next.id ? next : item))
    void persistConversation(next)
    return next
  }, [activeConversationId, persistConversation, replaceConversations])

  const deleteActiveMessageBranch = useCallback((messageId: string): Conversation | undefined => {
    const current = conversationsRef.current.find((conversation) => conversation.id === activeConversationId)
    if (!current) return undefined
    const next = deleteMessageNode(current, messageId)
    replaceConversations((items) => items.map((item) => item.id === next.id ? next : item))
    void persistConversation(next)
    return next
  }, [activeConversationId, persistConversation, replaceConversations])

  const clearConversationState = useCallback((): void => {
    hydrateConversations([], '')
  }, [hydrateConversations])

  return {
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
  }
}

export function useNewConversationShortcut({
  enabled,
  onOpen,
}: {
  enabled: boolean
  onOpen: () => void
}): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        enabled
        && !event.altKey
        && (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === 'n'
      ) {
        event.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, onOpen])
}

export type ConversationUpdater = (updater: (current: Conversation[]) => Conversation[]) => Conversation[]
export type PersistConversation = (conversation: Conversation) => Promise<boolean>
