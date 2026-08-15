import { describe, expect, it } from 'vitest'
import {
  parseAnthropicEvent,
  parseChatCompletionEvent,
  parseResponsesEvent,
  parseUsage,
} from '../src/electron/api/protocol-adapters'
import {
  buildRequestBody,
  RequestAdapterError,
  resolveWebSearchMode,
} from '../src/electron/api/request-adapters'
import type { ChatRequest, Message, ModelConfig } from '../src/shared/types'

const timestamp = '2026-01-01T00:00:00.000Z'
const messages: Message[] = [
  { id: 'system', role: 'system', content: 'Be concise.', createdAt: timestamp },
  { id: 'user', role: 'user', content: 'Question', createdAt: timestamp },
  { id: 'answer-1', role: 'assistant', content: 'Answer', createdAt: timestamp },
]
const model: ModelConfig = {
  id: 'model',
  name: 'Model',
  providerId: 'provider',
  remoteId: 'vendor/model',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsReasoning: true,
  defaultReasoningEnabled: true,
  defaultReasoningEffort: 'medium',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const request: ChatRequest = {
  conversationId: 'conversation',
  modelId: model.id,
  messages,
  reasoningEnabled: true,
  reasoningEffort: 'minimal',
}

describe('OpenAI Chat Completions adapter', () => {
  it('parses text, reasoning, usage and finish reason', () => {
    expect(
      parseChatCompletionEvent({
        choices: [
          {
            delta: { content: 'hello', reasoning: 'think' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          total_tokens: 16,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }),
    ).toMatchObject({
      text: 'hello',
      reasoning: 'think',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 6, reasoningTokens: 2, totalTokens: 16 },
    })
  })

  it('parses normalized reasoning details and mid-stream errors', () => {
    expect(
      parseChatCompletionEvent({
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: 'reasoning.summary', summary: 'summary' },
                { type: 'reasoning.text', text: ' detail' },
              ],
            },
          },
        ],
      }).reasoning,
    ).toBe('summary detail')
    expect(
      parseChatCompletionEvent({
        error: {
          message: 'rate limited',
          metadata: { error_type: 'rate_limit_exceeded' },
        },
      }).error,
    ).toMatchObject({ message: 'rate limited', code: 'rate_limit_exceeded' })
  })

  it('surfaces refusal deltas and Chat-style reasoning usage details', () => {
    expect(
      parseChatCompletionEvent({
        choices: [{ delta: { refusal: 'I cannot help with that.' } }],
        usage: {
          completion_tokens: 7,
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }),
    ).toMatchObject({
      text: 'I cannot help with that.',
      usage: { outputTokens: 7, reasoningTokens: 4 },
    })
  })

  it('safely extracts beta structured text deltas without displaying tool results', () => {
    expect(
      parseChatCompletionEvent({
        choices: [
          {
            delta: {
              content: [
                { type: 'text', text: 'First' },
                { type: 'server_tool_use', input: { query: 'private query' } },
                {
                  type: 'web_search_tool_result',
                  content: [
                    {
                      type: 'web_search_result',
                      content: 'Untrusted page text',
                    },
                  ],
                },
                { type: 'text', text: ' answer' },
                { type: 'unknown', content: 'must not be rendered' },
              ],
            },
          },
        ],
      }).text,
    ).toBe('First answer')
    expect(
      parseChatCompletionEvent({
        choices: [{ delta: { content: [{ type: 'unknown', text: 'hidden' }] } }],
      }).text,
    ).toBeUndefined()
  })

  it('parses Gemini reasoning_details with google-gemini-v1 format and thoughts usage', () => {
    // OpenRouter surfaces Gemini thinking via reasoning_details chunks using
    // type "reasoning.text" (with a "text" field) and "google-gemini-v1" format.
    expect(
      parseChatCompletionEvent({
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  type: 'reasoning.text',
                  text: 'Let me break this down. ',
                  signature: null,
                  id: 'g-think-1',
                  format: 'google-gemini-v1',
                  index: 0,
                },
              ],
            },
          },
        ],
      }).reasoning,
    ).toBe('Let me break this down. ')
    // Gemini's thoughtsTokenCount is normalized by OpenRouter into
    // completion_tokens_details.reasoning_tokens.
    expect(
      parseChatCompletionEvent({
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 18 },
        },
      }).usage,
    ).toMatchObject({ reasoningTokens: 18, outputTokens: 50 })
  })

  it('ignores reasoning_details entries without text or summary content', () => {
    expect(
      parseChatCompletionEvent({
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: 'reasoning.text', signature: 'abc', format: 'google-gemini-v1' },
                { type: 'reasoning.text', text: 'visible' },
              ],
            },
          },
        ],
      }).reasoning,
    ).toBe('visible')
  })

  it('parses nested citations from both streaming deltas and completed messages', () => {
    const annotation = {
      type: 'url_citation',
      url_citation: {
        url: 'https://example.com/search-result',
        title: 'Search result',
        content: 'Relevant excerpt',
        start_index: 3,
        end_index: 18,
      },
    }
    expect(
      parseChatCompletionEvent({ choices: [{ delta: { annotations: [annotation] } }] })
        .citations,
    ).toEqual([
      {
        url: 'https://example.com/search-result',
        title: 'Search result',
        content: 'Relevant excerpt',
        startIndex: 3,
        endIndex: 18,
      },
    ])
    expect(
      parseChatCompletionEvent({ choices: [{ message: { annotations: [annotation] } }] })
        .citations,
    ).toHaveLength(1)
  })

  it('parses billed web-search requests from server-tool usage', () => {
    expect(
      parseUsage({
        prompt_tokens: 10,
        completion_tokens: 7,
        server_tool_use: { web_search_requests: 2 },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      webSearchRequests: 2,
    })
    expect(
      parseUsage({
        input_tokens: -1,
        output_tokens: 1.5,
        total_tokens: 1_000_000_000_001,
        server_tool_use: { web_search_requests: -2 },
      }),
    ).toBeUndefined()
  })
})

describe('OpenAI Responses adapter', () => {
  it.each([
    ['response.content_part.delta', 'legacy'],
    ['response.output_text.delta', 'current'],
  ])('parses %s text events', (type, delta) => {
    expect(parseResponsesEvent({ type, delta }).text).toBe(delta)
  })

  it.each([
    'response.reasoning.delta',
    'response.reasoning_summary_text.delta',
    'response.reasoning_text.delta',
  ])('parses %s reasoning events', (type) => {
    expect(parseResponsesEvent({ type, delta: { text: 'thought' } }).reasoning).toBe(
      'thought',
    )
  })

  it('parses Gemini reasoning via reasoning_summary_text and reasoning_text events', () => {
    // Gemini through OpenRouter Responses format streams thinking as summary
    // and text reasoning events.
    expect(
      parseResponsesEvent({
        type: 'response.reasoning_summary_text.delta',
        delta: { text: 'Summarizing my approach.' },
      }).reasoning,
    ).toBe('Summarizing my approach.')
    expect(
      parseResponsesEvent({
        type: 'response.reasoning_text.delta',
        delta: { text: 'Detailed thought.' },
      }).reasoning,
    ).toBe('Detailed thought.')
  })

  it('treats any response.reasoning* delta as reasoning but skips empty terminal events', () => {
    // Future-proof: any reasoning-part variant carrying a text delta is shown.
    expect(
      parseResponsesEvent({
        type: 'response.reasoning_summary_part.delta',
        delta: { text: 'part thought' },
      }).reasoning,
    ).toBe('part thought')
    // A terminal reasoning.done without a text delta must not emit reasoning.
    expect(
      parseResponsesEvent({ type: 'response.reasoning.done', delta: {} }).reasoning,
    ).toBeUndefined()
  })

  it('parses response.done and response.completed usage', () => {
    expect(
      parseResponsesEvent({
        type: 'response.done',
        response: {
          status: 'completed',
          usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        },
      }),
    ).toMatchObject({
      completed: true,
      finishReason: 'completed',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    })
    expect(
      parseResponsesEvent({
        type: 'response.completed',
        response: { status: 'completed', usage: { output_tokens: 4 } },
      }).completed,
    ).toBe(true)
  })

  it('parses failed responses', () => {
    expect(
      parseResponsesEvent({
        type: 'response.failed',
        error_type: 'authentication',
        response: { error: { message: 'bad key' } },
      }).error,
    ).toMatchObject({ message: 'bad key', code: 'authentication' })
  })

  it('treats incomplete and refusal events as visible terminal output', () => {
    expect(
      parseResponsesEvent({
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      }),
    ).toMatchObject({ completed: true, finishReason: 'max_output_tokens' })
    expect(
      parseResponsesEvent({
        type: 'response.refusal.delta',
        delta: 'Request refused.',
      }).text,
    ).toBe('Request refused.')
  })

  it('parses annotation events and citations repeated in the completed response', () => {
    expect(
      parseResponsesEvent({
        type: 'response.output_text.annotation.added',
        annotation: {
          type: 'url_citation',
          url: 'https://example.com/live',
          title: 'Live source',
          start_index: 0,
          end_index: 9,
        },
      }).citations,
    ).toEqual([
      {
        url: 'https://example.com/live',
        title: 'Live source',
        startIndex: 0,
        endIndex: 9,
      },
    ])

    expect(
      parseResponsesEvent({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Grounded answer',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://example.com/final',
                      content: 'Final excerpt',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }).citations,
    ).toEqual([
      {
        url: 'https://example.com/final',
        content: 'Final excerpt',
      },
    ])
  })
})

describe('Anthropic Messages adapter', () => {
  it('parses text and thinking deltas', () => {
    expect(
      parseAnthropicEvent({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'answer' },
      }).text,
    ).toBe('answer')
    expect(
      parseAnthropicEvent({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'analysis' },
      }).reasoning,
    ).toBe('analysis')
  })

  it('parses usage, stop reason, completion, and errors', () => {
    expect(
      parseAnthropicEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 3 } },
      }),
    ).toMatchObject({
      finishReason: 'end_turn',
      usage: { outputTokens: 8, reasoningTokens: 3 },
    })
    expect(parseAnthropicEvent({ type: 'message_stop' }).completed).toBe(true)
    expect(
      parseAnthropicEvent({
        type: 'error',
        error: { message: 'overloaded', error_type: 'provider_overloaded' },
      }).error,
    ).toMatchObject({ message: 'overloaded', code: 'provider_overloaded' })
  })

  it('parses citations from Anthropic text blocks and citation deltas', () => {
    expect(
      parseAnthropicEvent({
        type: 'content_block_start',
        content_block: {
          type: 'text',
          text: 'Grounded',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com/anthropic',
              title: 'Anthropic source',
              cited_text: 'Quoted source',
            },
          ],
        },
      }),
    ).toMatchObject({
      text: 'Grounded',
      citations: [
        {
          url: 'https://example.com/anthropic',
          title: 'Anthropic source',
          content: 'Quoted source',
        },
      ],
    })
    expect(
      parseAnthropicEvent({
        type: 'content_block_delta',
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'url_citation',
            url: 'https://example.com/anthropic-delta',
          },
        },
      }).citations,
    ).toHaveLength(1)

    expect(
      parseAnthropicEvent({
        type: 'content_block_start',
        content_block: {
          type: 'text',
          text: '',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://example.com/null-title',
              title: null,
              cited_text: 'Citation with no title',
            },
          ],
        },
      }).citations,
    ).toEqual([
      {
        url: 'https://example.com/null-title',
        content: 'Citation with no title',
      },
    ])
  })
})

describe('request body adapters', () => {
  it('makes OpenRouter reasoning visible for Chat and Responses requests', () => {
    for (const format of ['openai-chat-completions', 'openai-responses'] as const) {
      const body = buildRequestBody(
        format,
        { kind: 'openrouter' },
        model,
        messages,
        request,
        4_096,
      )
      expect(body.reasoning).toEqual({
        enabled: true,
        effort: 'minimal',
        exclude: false,
      })

      const disabledBody = buildRequestBody(
        format,
        { kind: 'openrouter' },
        model,
        messages,
        { ...request, reasoningEnabled: false },
        4_096,
      )
      expect(disabledBody.reasoning).toEqual({ effort: 'none' })
    }
  })

  it('serializes every message supplied by the context policy', () => {
    const body = buildRequestBody(
      'openai-chat-completions',
      { kind: 'openrouter' },
      model,
      messages,
      request,
      4_096,
    )
    expect(body.messages).toEqual(
      messages.map(({ role, content }) => ({ role, content })),
    )
  })

  it('replays Responses assistant messages with the required output-item shape', () => {
    const body = buildRequestBody(
      'openai-responses',
      { kind: 'openrouter' },
      model,
      messages,
      request,
      4_096,
    )
    expect(body.instructions).toBe('Be concise.')
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Question' }],
      },
      {
        type: 'message',
        id: 'msg_answer-1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Answer', annotations: [] }],
      },
    ])
  })

  it('uses adaptive Anthropic thinking and maps unsupported minimal effort to low', () => {
    const body = buildRequestBody(
      'anthropic-messages',
      { kind: 'anthropic' },
      { ...model, anthropicThinkingMode: 'adaptive' },
      messages,
      request,
      4_096,
    )
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'low' })
  })

  it('uses the Anthropic Messages protocol disabled thinking mode when reasoning is off', () => {
    const body = buildRequestBody(
      'anthropic-messages',
      { kind: 'anthropic' },
      model,
      messages,
      { ...request, reasoningEnabled: false },
      4_096,
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('output_config')
  })

  it('serializes OpenRouter provider routing with wire-format field names', () => {
    const body = buildRequestBody(
      'openai-chat-completions',
      { kind: 'openrouter' },
      {
        ...model,
        providerRouting: {
          order: ['anthropic'],
          allowFallbacks: false,
          requireParameters: true,
          dataCollection: 'deny',
          zdr: true,
          sort: 'latency',
        },
      },
      messages,
      request,
      4_096,
    )
    expect(body.provider).toEqual({
      order: ['anthropic'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      zdr: true,
      sort: 'latency',
    })
  })

  it('explicitly disables CLIProxy reasoning for Chat and Responses formats', () => {
    const noReasoningRequest = { ...request, reasoningEnabled: false }
    const chatBody = buildRequestBody(
      'openai-chat-completions',
      { kind: 'cliproxy' },
      model,
      messages,
      noReasoningRequest,
      4_096,
    )
    expect(chatBody.reasoning_effort).toBe('none')

    const responsesBody = buildRequestBody(
      'openai-responses',
      { kind: 'cliproxy' },
      model,
      messages,
      noReasoningRequest,
      4_096,
    )
    expect(responsesBody.reasoning).toEqual({ effort: 'none' })
  })

  it('uses the bounded OpenRouter web-search server tool for all three API formats', () => {
    const tool = {
      type: 'openrouter:web_search',
      parameters: {
        engine: 'native',
        max_results: 5,
        max_uses: 2,
        max_total_results: 8,
      },
    }
    for (const format of [
      'openai-chat-completions',
      'openai-responses',
      'anthropic-messages',
    ] as const) {
      const body = buildRequestBody(
        format,
        { kind: 'openrouter' },
        model,
        messages,
        { ...request, webSearchMode: 'native' },
        4_096,
      )
      expect(body.tools).toEqual([tool])
      expect(body.max_tool_calls).toBe(2)
    }
  })

  it.each([
    'openai-chat-completions',
    'openai-responses',
    'anthropic-messages',
  ] as const)('rejects %s web search on a non-OpenRouter provider', (format) => {
    try {
      buildRequestBody(
        format,
        { kind: 'custom' },
        model,
        messages,
        { ...request, webSearchMode: 'auto' },
        4_096,
      )
      throw new Error('Expected adapter rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(RequestAdapterError)
      expect(error).toMatchObject({ code: 'web_search_not_supported' })
      expect((error as Error).message).toContain('OpenRouter')
    }
  })

  it('defaults old models and requests to web search off', () => {
    expect(resolveWebSearchMode({}, {})).toBe('off')
    expect(resolveWebSearchMode({}, { defaultWebSearchMode: 'auto' })).toBe('auto')
    expect(
      resolveWebSearchMode(
        { webSearchMode: 'off' },
        { defaultWebSearchMode: 'native' },
      ),
    ).toBe('off')
  })
})
