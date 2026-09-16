import type { ApiFormat, McpToolDefinition, StreamEvent, WebCitation } from '../../shared/types'
import {
  parseAnthropicEvent,
  parseChatCompletionEvent,
  parseResponsesEvent,
  type ProtocolErrorData,
} from './protocol-adapters'
import { parseSse } from './sse'
import {
  createCitationEmissionState,
  takeChangedWebCitations,
  type CitationEmissionState,
} from '../storage/web-metadata-schema'
import { GatewayError } from './gateway-error'
import { cloneJsonRecord } from './gateway-json'
import { ProviderStreamBudget } from './provider-stream-budget'
import { t } from '../../shared/i18n'

type StreamEmitter = (event: StreamEvent) => void

export interface AccumulatedToolCall {
  index: number
  id: string
  name: string
  argumentsText: string
  started: boolean
}

export interface StreamConsumptionResult {
  completed: boolean
  text: string
  finishReason?: string
  toolCalls: AccumulatedToolCall[]
  anthropicThinkingBlocks: Array<{ blockIndex: number; thinking: string; signature?: string }>
  responseOutputItems: Record<string, unknown>[]
  responseId?: string
}

export async function consumeStream(
  format: ApiFormat,
  stream: ReadableStream<Uint8Array>,
  requestId: string,
  emit: StreamEmitter,
  effectiveMcpTools: McpToolDefinition[] = [],
  turn = 1,
  captureContinuation = false,
  citationState = createCitationEmissionState(),
  budget = new ProviderStreamBudget(),
): Promise<StreamConsumptionResult> {
  let completed = false
  let finishReason: string | undefined
  let text = ''
  const toolCallsMap = new Map<number | string, AccumulatedToolCall>()
  const anthropicThinking = new Map<number, { blockIndex: number; thinking: string; signature: string }>()
  const responseOutputItems: Record<string, unknown>[] = []
  let responseId: string | undefined
  let continuationEmitted = false

  const emitContinuation = () => {
    if (!responseId || continuationEmitted) return
    continuationEmitted = true
    emit({
      type: 'provider-continuation',
      requestId,
      continuation: { format: 'openai-responses', responseId, turn },
    })
  }

  const handleToolDelta = (delta: {
    index?: number
    id?: string
    itemId?: string
    name?: string
    argumentsDelta?: string
  }) => {
    const key = delta.index ?? delta.itemId ?? delta.id ?? 0
    let tc = toolCallsMap.get(key)
    if (!tc) {
      budget.add('toolCalls', 1)
      const id = delta.id || `call_${Date.now().toString(36)}_${toolCallsMap.size}`
      const name = delta.name || ''
      tc = {
        index: typeof delta.index === 'number' ? delta.index : 0,
        id,
        name,
        argumentsText: '',
        started: false,
      }
      toolCallsMap.set(key, tc)
    } else {
      if (delta.id && tc.id.startsWith('call_')) tc.id = delta.id
      if (delta.name && !tc.name) tc.name = delta.name
    }

    if (!tc.started && tc.name) {
      tc.started = true
      const toolDef = effectiveMcpTools.find((tool) => (tool.modelName || tool.name) === tc.name)
      emit({
        type: 'tool-call-start',
        requestId,
        callId: tc.id,
        toolName: toolDef?.name || tc.name,
        modelToolName: tc.name,
        serverName: toolDef?.serverName,
        turn,
      })
    }

    if (delta.argumentsDelta) {
      budget.add('toolArguments', delta.argumentsDelta.length)
      if (tc.argumentsText.length + delta.argumentsDelta.length > 200_000) {
        throw new GatewayError(t('The provider response exceeded the request size limit.'), 'response_size_limit')
      }
      tc.argumentsText += delta.argumentsDelta
      emit({
        type: 'tool-call-args',
        requestId,
        callId: tc.id,
        delta: delta.argumentsDelta,
        turn,
      })
    }
  }

  for await (const message of parseSse(stream)) {
    if (message.data === '[DONE]') {
      if (format === 'openai-responses' && captureContinuation) emitContinuation()
      if (!completed && toolCallsMap.size === 0) emit({ type: 'done', requestId, finishReason })
      return {
        completed: true,
        text,
        finishReason,
        toolCalls: Array.from(toolCallsMap.values()),
        anthropicThinkingBlocks: Array.from(anthropicThinking.values()),
        responseOutputItems,
        responseId,
      }
    }

    let payload: unknown
    try {
      payload = JSON.parse(message.data)
    } catch {
      continue
    }

    if (format === 'openai-chat-completions') {
      const parsed = parseChatCompletionEvent(payload)
      if (parsed.error) throw toGatewayError(parsed.error)
      if (parsed.text) {
        budget.add('text', parsed.text.length)
        text += parsed.text
        emit({ type: 'text-delta', requestId, delta: parsed.text, turn })
      }
      if (parsed.reasoning) {
        budget.add('reasoning', parsed.reasoning.length)
        emit({ type: 'reasoning-delta', requestId, delta: parsed.reasoning, turn })
      }
      for (const delta of parsed.toolCallDeltas || []) handleToolDelta(delta)
      emitNewCitations(parsed.citations, citationState, requestId, emit)
      if (parsed.usage) emit({ type: 'usage', requestId, turn, usage: parsed.usage })
      finishReason = parsed.finishReason ?? finishReason
      continue
    }

    if (format === 'openai-responses') {
      const parsed = parseResponsesEvent(payload, message.event)
      if (parsed.error) throw toGatewayError(parsed.error)
      if (captureContinuation) responseId = parsed.responseId ?? responseId
      if (parsed.text) {
        budget.add('text', parsed.text.length)
        text += parsed.text
        emit({ type: 'text-delta', requestId, delta: parsed.text, turn })
      }
      if (parsed.reasoning) {
        budget.add('reasoning', parsed.reasoning.length)
        emit({ type: 'reasoning-delta', requestId, delta: parsed.reasoning, turn })
      }
      for (const delta of parsed.toolCallDeltas || []) handleToolDelta(delta)
      if (parsed.responseOutputItem) {
        const item = cloneJsonRecord(parsed.responseOutputItem, 500_000)
        budget.add('providerItems', 1)
        budget.add('providerItemCharacters', JSON.stringify(item).length)
        responseOutputItems.push(item)
        emit({ type: 'agent-provider-item', requestId, turn, format: 'openai-responses', item })
      }
      emitNewCitations(parsed.citations, citationState, requestId, emit)
      if (parsed.usage) emit({ type: 'usage', requestId, turn, usage: parsed.usage })
      if (parsed.completed) {
        completed = true
        finishReason = parsed.finishReason
        emitContinuation()
        if (toolCallsMap.size === 0) emit({ type: 'done', requestId, finishReason })
        break
      }
      continue
    }

    const parsed = parseAnthropicEvent(payload, message.event)
    if (parsed.error) throw toGatewayError(parsed.error)
    if (parsed.text) {
      budget.add('text', parsed.text.length)
      text += parsed.text
      emit({ type: 'text-delta', requestId, delta: parsed.text, turn })
    }
    if (parsed.anthropicThinkingDelta) {
      const delta = parsed.anthropicThinkingDelta
      if (!anthropicThinking.has(delta.index)) budget.add('thinkingBlocks', 1)
      budget.add('reasoning', delta.thinkingDelta?.length ?? 0)
      budget.add('signatures', delta.signatureDelta?.length ?? 0)
      const block = anthropicThinking.get(delta.index) || { blockIndex: delta.index, thinking: '', signature: '' }
      block.thinking += delta.thinkingDelta || ''
      block.signature += delta.signatureDelta || ''
      anthropicThinking.set(delta.index, block)
      emit({
        type: 'reasoning-delta',
        requestId,
        delta: delta.thinkingDelta || '',
        signatureDelta: delta.signatureDelta,
        thinkingBlockIndex: delta.index,
        turn,
      })
    } else if (parsed.reasoning) {
      budget.add('reasoning', parsed.reasoning.length)
      emit({ type: 'reasoning-delta', requestId, delta: parsed.reasoning, turn })
    }
    for (const delta of parsed.toolCallDeltas || []) handleToolDelta(delta)
    emitNewCitations(parsed.citations, citationState, requestId, emit)
    if (parsed.usage) emit({ type: 'usage', requestId, turn, usage: parsed.usage })
    finishReason = parsed.finishReason ?? finishReason
    if (parsed.completed) {
      completed = true
      if (toolCallsMap.size === 0) emit({ type: 'done', requestId, finishReason })
      break
    }
  }
  return {
    completed,
    text,
    finishReason,
    toolCalls: Array.from(toolCallsMap.values()),
    anthropicThinkingBlocks: Array.from(anthropicThinking.values()),
    responseOutputItems,
    responseId,
  }
}

function emitNewCitations(
  citations: WebCitation[] | undefined,
  state: CitationEmissionState,
  requestId: string,
  emit: StreamEmitter,
): void {
  for (const citation of takeChangedWebCitations(citations, state)) {
    emit({
      type: 'citation',
      requestId,
      citation,
    })
  }
}

function toGatewayError(error: ProtocolErrorData): GatewayError {
  return new GatewayError(error.message, error.code, error.status)
}
