import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentInterruption,
  AgentTraceItem,
  ChatRequest,
  StreamEvent,
  ToolCallExecution,
  WebCitation,
} from '../../../shared/types'
import type { ChatMessage, Conversation } from '../types'
import { interruptionFromStreamEvent } from '../agent-continuation'
import { t } from '../../../shared/i18n'
import type { ConversationUpdater, PersistConversation } from './useConversation'

interface ActiveStream {
  requestId: string
  conversationId: string
  assistantMessageId: string
  agentMode: boolean
}

export interface StreamRegistration {
  agentMode: boolean
  assistantMessageId: string
  conversationId: string
}

interface UseChatStreamOptions {
  maybeGenerateTitle: (conversation: Conversation) => void | Promise<void>
  persistConversation: PersistConversation
  replaceConversations: ConversationUpdater
  showToast: (message: string) => void
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : t("发生未知错误，请稍后重试。")
}

function appendAssistantTrace(
  trace: AgentTraceItem[] | undefined,
  turn: number,
  delta: string,
): AgentTraceItem[] {
  const next = [...(trace || [])]
  const last = next.at(-1)
  if (last?.type === 'assistant_text' && last.turn === turn) {
    next[next.length - 1] = { ...last, text: last.text + delta }
  } else {
    next.push({ type: 'assistant_text', turn, text: delta })
  }
  return next
}

function appendToolCallTrace(
  trace: AgentTraceItem[] | undefined,
  turn: number,
  callId: string,
  toolName: string,
  modelToolName: string,
  serverName: string | undefined,
  args: Record<string, unknown>,
): AgentTraceItem[] {
  const next = [...(trace || [])]
  const item: AgentTraceItem = {
    type: 'tool_call',
    turn,
    callId,
    toolName,
    modelToolName,
    serverName,
    args,
  }
  const index = next.findIndex((entry) => entry.type === 'tool_call' && entry.callId === callId)
  if (index >= 0) next[index] = { ...(next[index] as Extract<AgentTraceItem, { type: 'tool_call' }>), ...item }
  else next.push(item)
  return next
}

function appendThinkingTrace(
  trace: AgentTraceItem[] | undefined,
  turn: number,
  blockIndex: number,
  thinkingDelta: string,
  signatureDelta?: string,
): AgentTraceItem[] {
  const next = [...(trace || [])]
  const index = next.findIndex((entry) => (
    entry.type === 'assistant_thinking' && entry.turn === turn && entry.blockIndex === blockIndex
  ))
  if (index >= 0) {
    const current = next[index] as Extract<AgentTraceItem, { type: 'assistant_thinking' }>
    next[index] = {
      ...current,
      thinking: current.thinking + thinkingDelta,
      signature: `${current.signature || ''}${signatureDelta || ''}` || undefined,
    }
  } else {
    next.push({
      type: 'assistant_thinking',
      turn,
      blockIndex,
      thinking: thinkingDelta,
      signature: signatureDelta,
    })
  }
  return next
}

function appendProviderItemTrace(
  trace: AgentTraceItem[] | undefined,
  turn: number,
  item: Record<string, unknown>,
): AgentTraceItem[] {
  const next = [...(trace || [])]
  const itemId = typeof item.id === 'string' ? item.id : undefined
  const index = itemId
    ? next.findIndex((entry) => entry.type === 'provider_item' && entry.item.id === itemId)
    : -1
  const traceItem: AgentTraceItem = { type: 'provider_item', turn, format: 'openai-responses', item }
  if (index >= 0) next[index] = traceItem
  else next.push(traceItem)
  return next
}

function appendToolResultTrace(
  trace: AgentTraceItem[] | undefined,
  turn: number,
  callId: string,
  toolName: string,
  event: Extract<StreamEvent, { type: 'tool-result' }>,
): AgentTraceItem[] {
  const next = [...(trace || [])]
  const item: AgentTraceItem = {
    type: 'tool_result',
    turn,
    callId,
    toolName,
    result: event.result,
    resultContent: event.resultContent,
    structuredResult: event.structuredResult,
    resultTruncated: event.resultTruncated,
    isError: event.isError,
  }
  const index = next.findIndex((entry) => entry.type === 'tool_result' && entry.callId === callId)
  if (index >= 0) next[index] = item
  else next.push(item)
  return next
}

function mergeCitation(
  citations: WebCitation[] | undefined,
  citation: WebCitation,
): WebCitation[] {
  const existing = citations ?? []
  const index = existing.findIndex((item) => item.url === citation.url)
  if (index < 0) return [...existing, citation]
  return existing.map((item, itemIndex) => itemIndex === index ? {
    url: citation.url,
    title: citation.title ?? item.title,
    content: citation.content ?? item.content,
    startIndex: citation.startIndex ?? item.startIndex,
    endIndex: citation.endIndex ?? item.endIndex,
  } : item)
}

function checkpointInterruptedMessage(
  message: ChatMessage,
  interruption: AgentInterruption,
): ChatMessage {
  const pendingExecutions = (message.toolExecutions ?? []).filter((execution) => (
    execution.status === 'calling'
    || execution.status === 'awaiting-approval'
    || execution.status === 'executing'
  ))
  if (pendingExecutions.length === 0) {
    return { ...message, interruption, status: 'error', error: interruption.message }
  }

  const trace = [...(message.agentTrace ?? [])]
  const interruptedResult = t("Agent 执行在工具完成前中断：{value0}", { value0: interruption.message })
  for (const execution of pendingExecutions) {
    const hasCall = trace.some((item) => item.type === 'tool_call' && item.callId === execution.id)
    const hasResult = trace.some((item) => item.type === 'tool_result' && item.callId === execution.id)
    if (hasCall && !hasResult) {
      trace.push({
        type: 'tool_result',
        turn: execution.turn ?? 1,
        callId: execution.id,
        toolName: execution.toolName,
        result: interruptedResult,
        isError: true,
      })
    }
  }
  return {
    ...message,
    agentTrace: trace.length > 0 ? trace : undefined,
    toolExecutions: (message.toolExecutions ?? []).map((execution) => pendingExecutions.some((item) => item.id === execution.id)
      ? { ...execution, result: interruptedResult, isError: true, status: 'error' as const }
      : execution),
    interruption,
    status: 'error',
    error: interruption.message,
  }
}

export function applyStreamEvent(
  conversation: Conversation,
  activeStream: ActiveStream,
  event: StreamEvent,
): Conversation {
  if (conversation.id !== activeStream.conversationId) return conversation

  return {
    ...conversation,
    messages: conversation.messages.map((message) => {
      if (message.id !== activeStream.assistantMessageId) return message

      if (event.type === 'skill-activated') {
        const currentActivations = message.skillActivations ?? []
        const existingIndex = currentActivations.findIndex((item) => item.id === event.skill.id)
        const nextActivations = [...currentActivations]
        if (existingIndex >= 0) nextActivations[existingIndex] = event.skill
        else nextActivations.push(event.skill)
        return { ...message, skillActivations: nextActivations }
      }

      if (event.type === 'agent-provider-item') {
        return { ...message, agentTrace: appendProviderItemTrace(message.agentTrace, event.turn, event.item) }
      }

      if (event.type === 'text-delta') {
        return {
          ...message,
          content: message.content + event.delta,
          agentTrace: appendAssistantTrace(message.agentTrace, event.turn ?? 1, event.delta),
        }
      }

      if (event.type === 'reasoning-delta') {
        return {
          ...message,
          reasoning: (message.reasoning ?? '') + event.delta,
          agentTrace: event.thinkingBlockIndex === undefined
            ? message.agentTrace
            : appendThinkingTrace(
              message.agentTrace,
              event.turn ?? 1,
              event.thinkingBlockIndex,
              event.delta,
              event.signatureDelta,
            ),
        }
      }

      if (event.type === 'tool-call-start') {
        const existing = message.toolExecutions ?? []
        if (existing.some((execution) => execution.id === event.callId)) return message
        const newExecution: ToolCallExecution = {
          id: event.callId,
          toolName: event.toolName,
          modelToolName: event.modelToolName,
          serverName: event.serverName,
          turn: event.turn,
          args: {},
          status: 'calling',
        }
        return { ...message, toolExecutions: [...existing, newExecution] }
      }

      if (event.type === 'tool-approval-required') {
        const existing = message.toolExecutions ?? []
        const nextExecution: ToolCallExecution = {
          id: event.callId,
          toolName: event.toolName,
          modelToolName: event.modelToolName,
          serverName: event.serverName,
          turn: event.turn,
          args: event.args,
          riskLevel: event.riskLevel,
          approvalReason: event.reason,
          status: 'awaiting-approval',
        }
        return {
          ...message,
          toolExecutions: existing.some((execution) => execution.id === event.callId)
            ? existing.map((execution) => execution.id === event.callId ? { ...execution, ...nextExecution } : execution)
            : [...existing, nextExecution],
          agentTrace: appendToolCallTrace(message.agentTrace, event.turn, event.callId, event.toolName, event.modelToolName, event.serverName, event.args),
        }
      }

      if (event.type === 'tool-call-complete') {
        const existing = message.toolExecutions ?? []
        const modelToolName = event.modelToolName
          || existing.find((execution) => execution.id === event.callId)?.modelToolName
          || event.toolName
        return {
          ...message,
          toolExecutions: existing.map((execution) => execution.id === event.callId
            ? { ...execution, toolName: event.toolName, modelToolName, turn: event.turn ?? execution.turn, args: event.args, status: 'executing' as const }
            : execution),
          agentTrace: appendToolCallTrace(message.agentTrace, event.turn ?? 1, event.callId, event.toolName, modelToolName, undefined, event.args),
        }
      }

      if (event.type === 'tool-result') {
        const existing = message.toolExecutions ?? []
        const execution = existing.find((item) => item.id === event.callId)
        return {
          ...message,
          toolExecutions: existing.map((item) => item.id === event.callId
            ? {
              ...item,
              result: event.result,
              resultContent: event.resultContent,
              structuredResult: event.structuredResult,
              resultTruncated: event.resultTruncated,
              isError: event.isError,
              turn: event.turn ?? item.turn,
              status: event.denied ? 'denied' as const : event.isError ? 'error' as const : 'complete' as const,
            }
            : item),
          agentTrace: appendToolResultTrace(message.agentTrace, event.turn ?? execution?.turn ?? 1, event.callId, event.toolName, event),
        }
      }

      if (event.type === 'citation') {
        return { ...message, citations: mergeCitation(message.citations, event.citation) }
      }

      if (event.type === 'usage') {
        return { ...message, usage: { ...message.usage, ...event.usage } }
      }

      return message
    }),
  }
}

export function useChatStream({
  maybeGenerateTitle,
  persistConversation,
  replaceConversations,
  showToast,
}: UseChatStreamOptions) {
  const [streamingConversationIds, setStreamingConversationIds] = useState<Set<string>>(new Set())
  const activeStreamsRef = useRef<Map<string, ActiveStream>>(new Map())

  const discardStream = useCallback((conversationId: string): void => {
    activeStreamsRef.current.delete(conversationId)
    setStreamingConversationIds((current) => {
      if (!current.has(conversationId)) return current
      const next = new Set(current)
      next.delete(conversationId)
      return next
    })
  }, [])

  const prepareStream = useCallback((registration: StreamRegistration): void => {
    activeStreamsRef.current.set(registration.conversationId, {
      ...registration,
      requestId: '',
    })
    setStreamingConversationIds((current) => new Set(current).add(registration.conversationId))
  }, [])

  const finalizeStream = useCallback((
    activeStream: ActiveStream,
    event: Extract<StreamEvent, { type: 'done' | 'error' }>,
  ): void => {
    const targetConvId = activeStream.conversationId
    const targetAssistantId = activeStream.assistantMessageId
    const next = replaceConversations((current) => current.map((conversation) => {
      if (conversation.id !== targetConvId) return conversation
      const interruption = interruptionFromStreamEvent(event, activeStream.agentMode)
      return {
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: conversation.messages.map((message) => (
          message.id === targetAssistantId
            ? interruption
              ? checkpointInterruptedMessage(message, interruption)
              : {
                ...message,
                interruption: undefined,
                status: event.type === 'error' ? 'error' : 'complete',
                error: event.type === 'error' ? event.error.message : undefined,
              }
            : message
        )),
      }
    }))
    const completedConversation = next.find((conversation) => conversation.id === targetConvId)
    const completedAssistant = completedConversation?.messages.find((message) => message.id === targetAssistantId)
    if (completedConversation) void persistConversation(completedConversation)
    if (event.type === 'error') showToast(event.error.message)
    else if (completedAssistant?.interruption) showToast(completedAssistant.interruption.message)
    discardStream(targetConvId)

    if (
      event.type === 'done'
      && event.finishReason !== 'cancelled'
      && !completedAssistant?.interruption
      && completedConversation
      && completedConversation.messages.filter((message) => message.role !== 'system').length === 2
    ) {
      void maybeGenerateTitle(completedConversation)
    }
  }, [discardStream, maybeGenerateTitle, persistConversation, replaceConversations, showToast])

  const finishStream = useCallback((event: Extract<StreamEvent, { type: 'done' | 'error' }>): void => {
    for (const stream of activeStreamsRef.current.values()) {
      if (stream.requestId === event.requestId) {
        finalizeStream(stream, event)
        return
      }
    }
  }, [finalizeStream])

  const launchPreparedStream = useCallback(async (
    registration: StreamRegistration,
    request: ChatRequest,
  ): Promise<boolean> => {
    try {
      const { requestId } = await window.agentbox.chat.stream(request)
      const stream = activeStreamsRef.current.get(registration.conversationId)
      if (stream && stream.assistantMessageId === registration.assistantMessageId) {
        stream.requestId = requestId
      }
      return true
    } catch (error) {
      const stream = activeStreamsRef.current.get(registration.conversationId)
      if (stream && stream.assistantMessageId === registration.assistantMessageId) {
        finalizeStream(stream, {
          type: 'error',
          requestId: stream.requestId,
          error: { message: normalizeError(error) },
        })
      }
      return false
    }
  }, [finalizeStream])

  const cancelConversationStream = useCallback(async (conversationId: string): Promise<void> => {
    const stream = activeStreamsRef.current.get(conversationId)
    if (!stream) return
    if (stream.requestId) await window.agentbox.chat.cancel(stream.requestId).catch(() => undefined)
    discardStream(conversationId)
  }, [discardStream])

  const cancelAllStreams = useCallback(async (): Promise<void> => {
    const streams = [...activeStreamsRef.current.values()]
    await Promise.all(streams.map((stream) => stream.requestId
      ? window.agentbox.chat.cancel(stream.requestId).catch(() => undefined)
      : Promise.resolve()))
    activeStreamsRef.current.clear()
    setStreamingConversationIds(new Set())
  }, [])

  const stopStream = useCallback(async (conversationId: string): Promise<void> => {
    const stream = activeStreamsRef.current.get(conversationId)
    if (!stream?.requestId) return
    try {
      await window.agentbox.chat.cancel(stream.requestId)
      finalizeStream(stream, { type: 'done', requestId: stream.requestId, finishReason: 'cancelled' })
    } catch (error) {
      showToast(t("无法停止生成：{value0}", { value0: normalizeError(error) }))
    }
  }, [finalizeStream, showToast])

  const resolveToolApproval = useCallback(async (
    conversationId: string,
    callId: string,
    approved: boolean,
  ): Promise<void> => {
    const stream = activeStreamsRef.current.get(conversationId)
    if (!stream?.requestId) {
      showToast(t("该工具审批请求已结束。"))
      return
    }
    try {
      await window.agentbox.chat.resolveToolApproval(stream.requestId, callId, approved)
    } catch (error) {
      showToast(t("无法提交工具审批：{value0}", { value0: normalizeError(error) }))
    }
  }, [showToast])

  useEffect(() => window.agentbox.chat.onEvent((event) => {
    if (event.type === 'start') {
      for (const stream of activeStreamsRef.current.values()) {
        if (!stream.requestId) {
          stream.requestId = event.requestId
          break
        }
      }
    }

    let activeStream: ActiveStream | undefined
    for (const stream of activeStreamsRef.current.values()) {
      if (stream.requestId === event.requestId) {
        activeStream = stream
        break
      }
    }
    if (!activeStream) return

    if (event.type === 'done' || event.type === 'error') {
      finishStream(event)
      return
    }
    if (event.type === 'start' || event.type === 'tool-call-args') return

    replaceConversations((current) => current.map((conversation) => (
      applyStreamEvent(conversation, activeStream!, event)
    )))
  }), [finishStream, replaceConversations])

  return {
    cancelAllStreams,
    cancelConversationStream,
    discardStream,
    launchPreparedStream,
    prepareStream,
    resolveToolApproval,
    stopStream,
    streamingConversationIds,
  }
}
