import { describe, expect, it } from 'vitest'
import {
  addConfiguredSystemPrompt,
  extractModelArray,
  GatewayError,
  httpError,
  readResponseTextLimited,
  redactError,
  redactSecret,
  validateChatRequest,
} from '../src/electron/api/gateway'
import type { ChatRequest, Message } from '../src/shared/types'

describe('Gateway credential and proxy redaction', () => {
  it('redacts secret API keys from error messages', () => {
    const key = 'sk-or-v1-abcdef1234567890abcdef'
    const message = `Upstream error with Authorization: Bearer ${key} failed.`
    expect(redactSecret(message, key)).toBe('Upstream error with Authorization: Bearer [REDACTED] failed.')
  })

  it('redacts proxy username and password from error messages', () => {
    const proxyUrl = 'https://proxy_user:proxy_secret_pass@proxy.example.com:8443'
    const message = 'Connect tunnel failed for user proxy_user with pass proxy_secret_pass'
    expect(redactSecret(message, undefined, proxyUrl)).toBe(
      'Connect tunnel failed for user [REDACTED] with pass [REDACTED]',
    )
  })

  it('redacts both API key and proxy credentials simultaneously', () => {
    const key = 'my-secret-api-key'
    const proxyUrl = 'https://corp_user:corp_pass@proxy.internal:443'
    const message = 'Failed: key my-secret-api-key using user corp_user pass corp_pass'
    expect(redactSecret(message, key, proxyUrl)).toBe('Failed: key [REDACTED] using user [REDACTED] pass [REDACTED]')
  })

  it('handles clean messages, missing secrets, and non-credential proxies', () => {
    expect(redactSecret('Ordinary error message')).toBe('Ordinary error message')
    expect(redactSecret('Ordinary error message', undefined, 'http://127.0.0.1:7890')).toBe('Ordinary error message')
    expect(redactSecret('Ordinary error message', undefined, 'invalid url')).toBe('Ordinary error message')
  })

  it('redactError preserves GatewayError metadata while masking message content', () => {
    const key = 'super-secret'
    const original = new GatewayError(`Invalid token ${key}`, 'auth_failed', 401, 15)
    const redacted = redactError(original, key)
    expect(redacted).toBeInstanceOf(GatewayError)
    expect(redacted.message).toBe('Invalid token [REDACTED]')
    expect((redacted as GatewayError).code).toBe('auth_failed')
    expect((redacted as GatewayError).status).toBe(401)
    expect((redacted as GatewayError).retryAfterSeconds).toBe(15)
  })
})

describe('Gateway chat request validation (validateChatRequest)', () => {
  const validRequest: ChatRequest = {
    conversationId: 'conv-123',
    modelId: 'model-abc',
    messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' }],
    reasoningEnabled: true,
    reasoningEffort: 'medium',
    webSearchMode: 'auto',
    temperature: 0.7,
    maxOutputTokens: 2048,
  }

  it('accepts a well-formed chat request and returns sanitized messages', () => {
    const result = validateChatRequest(validRequest)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'm1',
      role: 'user',
      content: 'hello',
    })
  })

  it('rejects invalid conversation ID or model ID', () => {
    expect(() => validateChatRequest({ ...validRequest, conversationId: '' })).toThrow('会话 ID 无效。')
    expect(() => validateChatRequest({ ...validRequest, conversationId: 'x'.repeat(501) })).toThrow('会话 ID 无效。')
    expect(() => validateChatRequest({ ...validRequest, modelId: '' })).toThrow('会话 ID 无效。')
  })

  it('rejects empty or overly long message arrays', () => {
    expect(() => validateChatRequest({ ...validRequest, messages: [] })).toThrow('消息列表为空或过长。')
    const tooManyMessages: Message[] = Array.from({ length: 2001 }, (_, i) => ({
      id: `m-${i}`,
      role: 'user' as const,
      content: 'hi',
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    expect(() => validateChatRequest({ ...validRequest, messages: tooManyMessages })).toThrow('消息列表为空或过长。')
  })

  it('rejects invalid message roles and oversized messages', () => {
    expect(() =>
      validateChatRequest({
        ...validRequest,
        messages: [
          {
            id: 'm1',
            role: 'tool' as never,
            content: 'bad role',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ).toThrow('消息格式无效。')

    const hugeContent = 'x'.repeat(2_000_001)
    expect(() =>
      validateChatRequest({
        ...validRequest,
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: hugeContent,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ).toThrow('消息格式无效。')
  })

  it('validates provider continuation handles and preserves assistant model provenance', () => {
    const result = validateChatRequest({
      ...validRequest,
      messages: [
        {
          id: 'assistant-continuation',
          role: 'assistant',
          content: 'answer',
          modelId: 'model-abc',
          providerContinuation: { format: 'openai-responses', responseId: 'resp_valid_1', turn: 1 },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    expect(result[0]).toMatchObject({
      modelId: 'model-abc',
      providerContinuation: { format: 'openai-responses', responseId: 'resp_valid_1', turn: 1 },
    })

    expect(() =>
      validateChatRequest({
        ...validRequest,
        messages: [
          {
            id: 'assistant-continuation',
            role: 'assistant',
            content: 'answer',
            providerContinuation: { format: 'openai-responses', responseId: 'bad response id', turn: 1 },
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ).toThrow('服务方续接状态无效。')
  })

  it('rejects invalid temperature, maxOutputTokens, reasoningEffort, and webSearchMode', () => {
    expect(() => validateChatRequest({ ...validRequest, temperature: -0.1 })).toThrow(
      'temperature 必须在 0 到 2 之间。',
    )
    expect(() => validateChatRequest({ ...validRequest, temperature: 2.1 })).toThrow('temperature 必须在 0 到 2 之间。')
    expect(() => validateChatRequest({ ...validRequest, maxOutputTokens: -10 })).toThrow('最大输出长度配置无效。')
    expect(() => validateChatRequest({ ...validRequest, reasoningEffort: 'extreme' as never })).toThrow(
      '思考强度配置无效。',
    )
    expect(() => validateChatRequest({ ...validRequest, webSearchMode: 'always' as never })).toThrow(
      '网页搜索模式无效。',
    )
  })
})

describe('Gateway HTTP error parsing (httpError)', () => {
  it('parses status text when body is not JSON', async () => {
    const response = new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      statusText: 'Bad Gateway',
    })
    const error = await httpError(response)
    expect(error.status).toBe(502)
    expect(error.message).toBe('502 Bad Gateway')
  })

  it('parses standard OpenAI error responses', async () => {
    const body = JSON.stringify({
      error: { message: 'Incorrect API key provided', code: 'invalid_api_key' },
    })
    const response = new Response(body, {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    const error = await httpError(response)
    expect(error.status).toBe(401)
    expect(error.message).toBe('Incorrect API key provided')
    expect(error.code).toBe('invalid_api_key')
  })

  it('parses OpenRouter error_type metadata and Retry-After header', async () => {
    const body = JSON.stringify({
      error: {
        message: 'Rate limit exceeded',
        metadata: { error_type: 'rate_limit_exceeded' },
      },
    })
    const response = new Response(body, {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '45',
      },
    })
    const error = await httpError(response)
    expect(error.status).toBe(429)
    expect(error.message).toBe('Rate limit exceeded')
    expect(error.code).toBe('rate_limit_exceeded')
    expect(error.retryAfterSeconds).toBe(45)
  })
})

describe('Gateway response limiting and model array extraction', () => {
  it('reads response within size limit', async () => {
    const response = new Response('small payload')
    const result = await readResponseTextLimited(response, 1024)
    expect(result.text).toBe('small payload')
    expect(result.truncated).toBe(false)
  })

  it('truncates and stops reader when payload exceeds limit', async () => {
    const response = new Response('abcdefghijklmnopqrstuvwxyz')
    const result = await readResponseTextLimited(response, 10)
    expect(result.text.length).toBeLessThanOrEqual(10)
    expect(result.truncated).toBe(true)
  })

  it('extracts models array from valid payload and rejects invalid data', () => {
    expect(extractModelArray({ data: [{ id: 'm1' }, { id: 'm2' }] })).toEqual([{ id: 'm1' }, { id: 'm2' }])
    expect(() => extractModelArray({ models: [] })).toThrow('供应商返回了无法识别的模型列表。')
    expect(() => extractModelArray({ data: Array.from({ length: 20_001 }, () => ({})) })).toThrow(
      '供应商返回的模型数量超过限制。',
    )
  })
})

describe('Gateway system prompt composition (addConfiguredSystemPrompt)', () => {
  const messages: Message[] = [{ id: 'u1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' }]

  it('prepends configured system prompt to head of messages', () => {
    const result = addConfiguredSystemPrompt(messages, 'You are a helpful assistant.')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 'configured-system-prompt',
      role: 'system',
      content: 'You are a helpful assistant.',
    })
    expect(result[1]?.id).toBe('u1')
  })

  it('does not duplicate prompt when identical system message exists', () => {
    const withSystem: Message[] = [
      {
        id: 's1',
        role: 'system',
        content: 'You are a helpful assistant.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      ...messages,
    ]
    const result = addConfiguredSystemPrompt(withSystem, 'You are a helpful assistant.')
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('s1')
  })

  it('leaves messages unchanged when prompt is empty or whitespace', () => {
    expect(addConfiguredSystemPrompt(messages, '')).toEqual(messages)
    expect(addConfiguredSystemPrompt(messages, '   ')).toEqual(messages)
  })
})
