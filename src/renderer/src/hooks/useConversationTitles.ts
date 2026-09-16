import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { ChatRequest } from '../../../shared/types'
import type { Conversation, ModelConfig } from '../types'
import { cleanGeneratedTitle, cleanManualTitle, firstUserQuestion, TITLE_SYSTEM_PROMPT } from '../title'
import { runStreamWithReplay } from '../stream-helper'
import type { ConversationUpdater, PersistConversation } from './useConversation'

interface TitleRequest {
  requestId?: string
  unsubscribe?: () => void
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
  cancelled: boolean
}

function finishTitle(request: TitleRequest, cancelled = false): void {
  request.settled = true
  request.cancelled ||= cancelled
  clearTimeout(request.timer)
  request.unsubscribe?.()
  if (cancelled && request.requestId) void window.agentbox.chat.cancel(request.requestId).catch(() => undefined)
}

export function useConversationTitles({
  conversationsRef,
  models,
  persistConversation,
  replaceConversations,
  titleModelId,
}: {
  conversationsRef: RefObject<Conversation[]>
  models: ModelConfig[]
  persistConversation: PersistConversation
  replaceConversations: ConversationUpdater
  titleModelId?: string
}) {
  const attempted = useRef(new Set<string>())
  const manual = useRef(new Set<string>())
  const requests = useRef(new Map<string, TitleRequest>())

  const cancelAllTitles = useCallback(() => {
    for (const request of requests.current.values()) finishTitle(request, true)
    requests.current.clear()
  }, [])
  useEffect(() => cancelAllTitles, [cancelAllTitles])

  const forgetTitleGeneration = useCallback((id: string) => {
    const request = requests.current.get(id)
    if (request) finishTitle(request, true)
    requests.current.delete(id)
    attempted.current.delete(id)
    manual.current.delete(id)
  }, [])

  const maybeGenerateTitle = useCallback(
    async (conversation: Conversation): Promise<void> => {
      const model = models.find((item) => item.id === (titleModelId || conversation.modelId))
      const question = firstUserQuestion(conversation.messages).slice(0, 2_000)
      if (!model || !question || attempted.current.has(conversation.id) || manual.current.has(conversation.id)) return
      attempted.current.add(conversation.id)
      const request: TitleRequest = { settled: false, cancelled: false }
      requests.current.set(conversation.id, request)
      request.timer = setTimeout(() => finishTitle(request, true), 20_000)
      let collected = ''
      try {
        const result = await runStreamWithReplay<ChatRequest>(
          (input) => window.agentbox.chat.stream(input),
          (listener) => window.agentbox.chat.onEvent(listener),
          {
            conversationId: conversation.id,
            modelId: model.id,
            messages: [
              {
                id: 'title-system',
                role: 'system',
                content: TITLE_SYSTEM_PROMPT,
                createdAt: new Date(0).toISOString(),
              },
              { id: 'title-user', role: 'user', content: question, createdAt: new Date(0).toISOString() },
            ],
            reasoningEnabled: false,
            webSearchMode: 'off',
            maxOutputTokens: 32,
          },
          (event) => {
            if (request.settled) return
            if (event.type === 'text-delta') {
              collected = (collected + event.delta).slice(0, 4_000)
              return
            }
            if (event.type !== 'done' && event.type !== 'error') return
            finishTitle(request)
            requests.current.delete(conversation.id)
            if (event.type !== 'done' || event.finishReason === 'cancelled') return
            const title = cleanGeneratedTitle(collected)
            const current = conversationsRef.current.find((item) => item.id === conversation.id)
            if (!title || !current || manual.current.has(conversation.id)) return
            const renamed = { ...current, title, updatedAt: new Date().toISOString() }
            replaceConversations((items) => items.map((item) => (item.id === renamed.id ? renamed : item)))
            void persistConversation(renamed)
          },
        )
        request.requestId = result.requestId
        request.unsubscribe = result.unsubscribe
        if (request.settled) finishTitle(request, request.cancelled)
      } catch {
        finishTitle(request)
        requests.current.delete(conversation.id)
      }
    },
    [conversationsRef, models, persistConversation, replaceConversations, titleModelId],
  )

  const renameConversation = useCallback(
    (id: string, rawTitle: string) => {
      const title = cleanManualTitle(rawTitle)
      const current = conversationsRef.current.find((item) => item.id === id)
      if (!title || !current || current.title === title) return
      manual.current.add(id)
      const pending = requests.current.get(id)
      if (pending) finishTitle(pending, true)
      requests.current.delete(id)
      const renamed = { ...current, title, updatedAt: new Date().toISOString() }
      replaceConversations((items) => items.map((item) => (item.id === id ? renamed : item)))
      void persistConversation(renamed)
    },
    [conversationsRef, persistConversation, replaceConversations],
  )

  return { maybeGenerateTitle, renameConversation, forgetTitleGeneration, cancelAllTitles }
}
