import { describe, expect, it } from 'vitest'
import type { ChatRequest, Message, ModelConfig } from '../src/shared/types'
import {
  buildProviderPromptCacheKey,
  findLatestNativeContinuation,
  isProviderContextCompatibilityError,
  resolveProviderContextStrategies,
} from '../src/electron/api/provider-context-optimization'
import { buildRequestBody } from '../src/electron/api/request-adapters'
import { parseResponsesEvent } from '../src/electron/api/protocol-adapters'
import { applyStreamEvent } from '../src/renderer/src/hooks/useChatStream'
import { toStoredConversation, toUiConversation } from '../src/renderer/src/hooks/useConversation'
import type { Conversation } from '../src/renderer/src/types'

const timestamp = '2026-08-29T00:00:00.000Z'
const model: ModelConfig = {
  id: 'model',
  name: 'Model',
  providerId: 'provider',
  remoteId: 'gpt-test',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsReasoning: true,
  defaultReasoningEnabled: true,
  defaultReasoningEffort: 'medium',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const request: ChatRequest = {
  conversationId: 'conversation-secret-id',
  modelId: model.id,
  messages: [],
  reasoningEnabled: false,
  agentMode: true,
}

function systemAndUser(): Message[] {
  return [
    { id: 'system', role: 'system', content: 'System instructions', createdAt: timestamp },
    { id: 'user', role: 'user', content: 'Question', createdAt: timestamp },
  ]
}

describe('provider context optimization', () => {
  it('selects provider-aware strategies and deterministic non-identifying cache keys', () => {
    expect(resolveProviderContextStrategies('off', 'openai-responses', 'openai')).toEqual(['stateless'])
    expect(resolveProviderContextStrategies('auto', 'openai-responses', 'openai')).toEqual([
      'native-continuation',
      'prefix-cache',
      'stateless',
    ])
    expect(resolveProviderContextStrategies('auto', 'anthropic-messages', 'anthropic')).toEqual([
      'prefix-cache',
      'stateless',
    ])
    expect(resolveProviderContextStrategies('auto', 'openai-responses', 'custom')).toEqual(['stateless'])

    const key = buildProviderPromptCacheKey('conversation-secret-id', 'provider-secret-id', 'gpt-test')
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(key).not.toContain('conversation-secret-id')
    expect(key).toBe(buildProviderPromptCacheKey('conversation-secret-id', 'provider-secret-id', 'gpt-test'))
  })

  it('adds prefix-cache controls without changing stateless request bodies', () => {
    const messages = systemAndUser()
    const stateless = buildRequestBody(
      'openai-chat-completions',
      { kind: 'openai' },
      model,
      messages,
      { ...request, messages },
      4_096,
      undefined,
      { strategy: 'stateless', promptCacheKey: 'cache-key' },
    )
    expect(stateless).not.toHaveProperty('prompt_cache_key')

    const cached = buildRequestBody(
      'openai-chat-completions',
      { kind: 'openai' },
      model,
      messages,
      { ...request, messages },
      4_096,
      undefined,
      { strategy: 'prefix-cache', promptCacheKey: 'cache-key' },
    )
    expect(cached.prompt_cache_key).toBe('cache-key')

    const anthropic = buildRequestBody(
      'anthropic-messages',
      { kind: 'anthropic' },
      model,
      messages,
      { ...request, messages },
      4_096,
      undefined,
      { strategy: 'prefix-cache' },
    )
    expect(anthropic.system).toEqual([
      { type: 'text', text: 'System instructions', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('continues a Responses tool turn using only tool outputs', () => {
    const anchor: Message = {
      id: 'assistant-tool-turn',
      role: 'assistant',
      content: '',
      modelId: model.id,
      providerContinuation: { format: 'openai-responses', responseId: 'resp_tool_1', turn: 1 },
      agentTrace: [
        {
          type: 'tool_call',
          turn: 1,
          callId: 'call_1',
          toolName: 'lookup',
          modelToolName: 'lookup',
          args: { q: 'x' },
        },
        { type: 'tool_result', turn: 1, callId: 'call_1', toolName: 'lookup', result: 'result' },
      ],
      createdAt: timestamp,
    }
    const messages = [...systemAndUser(), anchor]
    const continuation = findLatestNativeContinuation(messages, model.id)
    expect(continuation).toMatchObject({ responseId: 'resp_tool_1', messageId: anchor.id, turn: 1 })

    const body = buildRequestBody(
      'openai-responses',
      { kind: 'openai' },
      model,
      messages,
      { ...request, messages },
      4_096,
      undefined,
      { strategy: 'native-continuation', promptCacheKey: 'cache-key', nativeContinuation: continuation },
    )
    expect(body.previous_response_id).toBe('resp_tool_1')
    expect(body.prompt_cache_key).toBe('cache-key')
    expect(body.store).toBe(true)
    expect(body.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'result' }])
  })

  it('continues a Responses conversation with only messages after the anchor', () => {
    const anchor: Message = {
      id: 'assistant-final',
      role: 'assistant',
      content: 'Prior answer',
      modelId: model.id,
      providerContinuation: { format: 'openai-responses', responseId: 'resp_final_1', turn: 2 },
      createdAt: timestamp,
    }
    const followUp: Message = { id: 'follow-up', role: 'user', content: 'Next question', createdAt: timestamp }
    const messages = [...systemAndUser(), anchor, followUp]
    const continuation = findLatestNativeContinuation(messages, model.id)
    const body = buildRequestBody(
      'openai-responses',
      { kind: 'openai' },
      model,
      messages,
      { ...request, messages },
      4_096,
      undefined,
      { strategy: 'native-continuation', nativeContinuation: continuation },
    )
    expect(body.previous_response_id).toBe('resp_final_1')
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next question' }] },
    ])
  })

  it('falls back only for strategy-specific compatibility errors', () => {
    expect(
      isProviderContextCompatibilityError(
        { status: 400, message: 'Unknown parameter: previous_response_id' },
        'native-continuation',
      ),
    ).toBe(true)
    expect(
      isProviderContextCompatibilityError({ status: 400, message: 'cache_control is not supported' }, 'prefix-cache'),
    ).toBe(true)
    expect(isProviderContextCompatibilityError({ status: 429, message: 'rate limited' }, 'prefix-cache')).toBe(false)
    expect(isProviderContextCompatibilityError({ status: 400, message: 'invalid tool schema' }, 'prefix-cache')).toBe(
      false,
    )
  })

  it('parses and retains a bounded Responses continuation handle in renderer state', () => {
    expect(parseResponsesEvent({ type: 'response.created', response: { id: 'resp_created_1' } })).toMatchObject({
      responseId: 'resp_created_1',
    })
    expect(
      parseResponsesEvent({ type: 'response.created', response: { id: 'bad response id' } }).responseId,
    ).toBeUndefined()

    const conversation: Conversation = {
      id: 'conversation',
      title: 'Conversation',
      modelId: model.id,
      messages: [
        {
          id: 'assistant',
          role: 'assistant',
          content: '',
          modelId: model.id,
          status: 'streaming',
          createdAt: timestamp,
        },
      ],
      currentLeafId: 'assistant',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const updated = applyStreamEvent(
      conversation,
      { requestId: 'request', conversationId: conversation.id, assistantMessageId: 'assistant', agentMode: true },
      {
        type: 'provider-continuation',
        requestId: 'request',
        continuation: { format: 'openai-responses', responseId: 'resp_saved_1', turn: 2 },
      },
    )
    expect(updated.messages[0]?.providerContinuation).toEqual({
      format: 'openai-responses',
      responseId: 'resp_saved_1',
      turn: 2,
    })

    const stored = toStoredConversation(updated)
    expect(stored.messages[0]?.modelId).toBe(model.id)
    expect(toUiConversation(stored).messages[0]?.modelId).toBe(model.id)
  })
})
