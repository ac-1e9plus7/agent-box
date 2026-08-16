import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const {
  AppRepository,
  normalizeBaseUrl,
  sanitizeHeaders,
  sanitizeProviderRouting,
} = await import('../src/electron/storage/app-repository')

describe('Header sanitization and injection prevention (sanitizeHeaders)', () => {
  it('accepts safe custom HTTP headers', () => {
    const headers = {
      'X-Title': 'AgentBox',
      'HTTP-Referer': 'https://agentbox.desktop',
      'OpenAI-Beta': 'assistants=v2',
    }
    expect(sanitizeHeaders(headers)).toEqual(headers)
  })

  it.each([
    'authorization',
    'AUTHORIZATION',
    'Authorization',
    'proxy-authorization',
    'x-api-key',
    'X-API-KEY',
    'cookie',
    'set-cookie',
    'host',
    'content-length',
  ])('rejects forbidden sensitive header %s', (forbiddenName) => {
    expect(() => sanitizeHeaders({ [forbiddenName]: 'value' })).toThrow(
      `不允许使用请求头：${forbiddenName}`,
    )
  })

  it('rejects header names with invalid characters or spaces', () => {
    expect(() => sanitizeHeaders({ 'Bad Header Name': 'value' })).toThrow('不允许使用请求头')
    expect(() => sanitizeHeaders({ 'Header:Colons': 'value' })).toThrow('不允许使用请求头')
  })

  it('rejects CRLF in header values to prevent HTTP response splitting', () => {
    expect(() => sanitizeHeaders({ 'X-Test': 'line1\r\nInjected: header' })).toThrow(
      '请求头 X-Test 的值无效',
    )
    expect(() => sanitizeHeaders({ 'X-Test': 'line1\nline2' })).toThrow(
      '请求头 X-Test 的值无效',
    )
  })

  it('limits custom header count and value length', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`X-Header-${i}`, 'val']),
    )
    expect(() => sanitizeHeaders(tooMany)).toThrow('Too many custom headers')

    expect(() =>
      sanitizeHeaders({ 'X-Long': 'v'.repeat(4_097) }),
    ).toThrow('请求头 X-Long 的值无效')
  })
})

describe('Base URL normalization and security policy (normalizeBaseUrl)', () => {
  it('accepts HTTPS URLs and loopback HTTP URLs, stripping trailing slash and query/hash', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1/?query=1#frag')).toBe(
      'http://127.0.0.1:8080/v1',
    )
    expect(normalizeBaseUrl('http://localhost:8317/v1/')).toBe('http://localhost:8317/v1')
    expect(normalizeBaseUrl('http://[::1]:9000/')).toBe('http://[::1]:9000')
  })

  it('strips embedded credentials from the Base URL', () => {
    expect(normalizeBaseUrl('https://user:password@openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1',
    )
  })

  it('rejects remote plain HTTP endpoints', () => {
    expect(() => normalizeBaseUrl('http://api.example.com/v1')).toThrow(
      '远程供应商地址必须使用 HTTPS；HTTP 仅允许本机回环地址。',
    )
  })

  it('rejects unsupported protocol schemes', () => {
    expect(() => normalizeBaseUrl('ftp://127.0.0.1:8080')).toThrow(
      '供应商地址必须使用 http 或 https。',
    )
    expect(() => normalizeBaseUrl('file:///C:/path')).toThrow(
      '供应商地址必须使用 http 或 https。',
    )
  })
})

describe('Provider routing sanitization (sanitizeProviderRouting)', () => {
  it('validates provider routing rules with allowed slugs and sort options', () => {
    const valid = sanitizeProviderRouting({
      order: ['anthropic', 'openai'],
      only: ['google'],
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
      zdr: true,
      sort: 'latency',
    })
    expect(valid).toEqual({
      order: ['anthropic', 'openai'],
      only: ['google'],
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
      zdr: true,
      sort: 'latency',
    })
  })

  it('rejects invalid provider slugs or unknown enum values', () => {
    expect(() =>
      sanitizeProviderRouting({ order: ['bad slug with spaces!'] }),
    ).toThrow('Invalid provider order')
    expect(() =>
      sanitizeProviderRouting({ dataCollection: 'invalid-option' as never }),
    ).toThrow('Invalid provider data-collection setting')
    expect(() =>
      sanitizeProviderRouting({ sort: 'fastest' as never }),
    ).toThrow('Invalid provider sort setting')
  })
})

describe('AppRepository business constraints and relational integrity', () => {
  let dir: string
  let repo: InstanceType<typeof AppRepository>
  const timestamp = '2026-08-15T00:00:00.000Z'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentbox-repo-test-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    repo = new AppRepository(dir)
    await repo.initialize()
  })

  it('prevents removing a provider if it is still referenced by models', async () => {
    const provider = await repo.upsertProvider({
      name: 'Custom Provider',
      kind: 'custom',
      baseUrl: 'https://custom.api/v1',
      apiFormat: 'openai-chat-completions',
    })

    const model = await repo.upsertModel({
      name: 'Custom Model',
      providerId: provider.id,
      remoteId: 'custom/model-1',
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      supportsReasoning: false,
      defaultReasoningEnabled: false,
      defaultReasoningEffort: 'medium',
    })

    // Attempting to remove provider should throw
    await expect(repo.removeProvider(provider.id)).rejects.toThrow(
      '该供应商仍被模型使用，请先删除或迁移相关模型。',
    )

    // Once model is removed, provider removal succeeds
    await repo.removeModel(model.id)
    await expect(repo.removeProvider(provider.id)).resolves.toBeUndefined()
  })

  it('prevents removing a model if it is still referenced by conversations', async () => {
    const defaultModel = repo.listModels()[0]!
    const conversation = {
      id: 'conv-test-1',
      title: 'Active Conversation',
      modelId: defaultModel.id,
      messages: [
        { id: 'm1', role: 'user' as const, content: 'hi', createdAt: timestamp },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await repo.saveConversation(conversation)

    await expect(repo.removeModel(defaultModel.id)).rejects.toThrow(
      '该模型仍被会话使用，请先删除会话或切换模型。',
    )

    // Remove conversation then model
    await repo.removeConversation(conversation.id)
    // Add another model first so defaultModelId has a fallback
    const provider = repo.listProviders()[0]!
    const fallbackModel = await repo.upsertModel({
      name: 'Fallback Model',
      providerId: provider.id,
      remoteId: 'fallback/model',
      contextWindow: 64_000,
      maxOutputTokens: 2048,
      supportsReasoning: false,
      defaultReasoningEnabled: false,
      defaultReasoningEffort: 'medium',
    })

    await repo.removeModel(defaultModel.id)
    expect(repo.getSettings().defaultModelId).toBe(fallbackModel.id)
  })

  it('retains API Key on provider update when baseUrl and kind are unchanged, clears when requested', async () => {
    const created = await repo.upsertProvider({
      name: 'Keyed Provider',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiFormat: 'openai-chat-completions',
      apiKey: 'sk-secret-key-12345',
    })
    expect(created.hasApiKey).toBe(true)

    // Update name without supplying apiKey: retains key
    const updated = await repo.upsertProvider({
      id: created.id,
      name: 'Renamed Keyed Provider',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiFormat: 'openai-chat-completions',
    })
    expect(updated.hasApiKey).toBe(true)
    expect(repo.getStoredProvider(created.id)?.apiKey).toBe('sk-secret-key-12345')

    // Update with clearApiKey: clears key
    const cleared = await repo.upsertProvider({
      id: created.id,
      name: 'Renamed Keyed Provider',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiFormat: 'openai-chat-completions',
      clearApiKey: true,
    })
    expect(cleared.hasApiKey).toBe(false)
    expect(repo.getStoredProvider(created.id)?.apiKey).toBeUndefined()
  })

  it('enforces total conversation character limits (50M)', async () => {
    const hugeMessage = {
      id: 'huge',
      role: 'user' as const,
      content: 'a'.repeat(2_000_001), // over 2M single message limit
      createdAt: timestamp,
    }
    await expect(
      repo.saveConversation({
        id: 'bad-conv',
        title: 'Bad',
        modelId: 'openrouter-auto',
        messages: [hugeMessage],
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).rejects.toThrow('Invalid message content')
  })

  it('validates and stores message attachments', async () => {
    const validConv = {
      id: 'conv-with-att',
      title: 'With Attachments',
      modelId: 'openrouter-auto',
      messages: [
        {
          id: 'msg-1',
          role: 'user' as const,
          content: 'Here is an attachment',
          attachments: [
            {
              id: 'att-1',
              name: 'test.png',
              mimeType: 'image/png',
              size: 1024,
              data: 'data:image/png;base64,123456',
              type: 'image' as const,
            },
          ],
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const saved = await repo.saveConversation(validConv)
    expect(saved.messages[0]?.attachments).toHaveLength(1)
    expect(saved.messages[0]?.attachments?.[0]?.name).toBe('test.png')

    // Rejects invalid attachment type
    await expect(
      repo.saveConversation({
        ...validConv,
        messages: [
          {
            id: 'msg-2',
            role: 'user',
            content: 'Bad att',
            createdAt: timestamp,
            attachments: [
              {
                id: 'att-2',
                name: 'bad.bin',
                mimeType: 'application/octet-stream',
                size: 10,
                data: 'xxx',
                type: 'unknown' as never,
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('Invalid attachment type')
  })
})
