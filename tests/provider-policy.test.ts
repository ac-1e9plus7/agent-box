import { describe, expect, it } from 'vitest'
import {
  buildProviderHeaders,
  isApiKeyOptional,
  isLoopbackUrl,
  providerHasUsableAuthentication,
} from '../src/electron/api/provider-policy'

describe('CLIProxyAPI authentication policy', () => {
  it.each([
    'http://127.0.0.1:8317/v1',
    'http://127.0.0.2:8317/v1',
    'http://localhost:8317/v1',
    'http://[::1]:8317/v1',
  ])('recognizes %s as loopback', (baseUrl) => {
    expect(isLoopbackUrl(baseUrl)).toBe(true)
    expect(isApiKeyOptional({ kind: 'cliproxy', baseUrl })).toBe(true)
  })

  it('requires credentials for remote CLIProxyAPI and every custom endpoint', () => {
    expect(
      providerHasUsableAuthentication({
        kind: 'cliproxy',
        baseUrl: 'https://proxy.example.com/v1',
      }),
    ).toBe(false)
    expect(
      providerHasUsableAuthentication({
        kind: 'custom',
        baseUrl: 'http://127.0.0.1:9000/v1',
      }),
    ).toBe(false)
    expect(
      providerHasUsableAuthentication({
        kind: 'cliproxy',
        baseUrl: 'https://proxy.example.com/v1',
        apiKey: 'secret',
      }),
    ).toBe(true)
  })

  it('never emits empty authentication headers for a keyless loopback proxy', () => {
    const openAiHeaders = buildProviderHeaders(
      { kind: 'cliproxy', baseUrl: 'http://127.0.0.1:8317/v1' },
      'openai-chat-completions',
    )
    expect(openAiHeaders).not.toHaveProperty('Authorization')
    expect(openAiHeaders).not.toHaveProperty('x-api-key')

    const anthropicHeaders = buildProviderHeaders(
      { kind: 'cliproxy', baseUrl: 'http://127.0.0.1:8317/v1' },
      'anthropic-messages',
    )
    expect(anthropicHeaders).toMatchObject({ 'anthropic-version': '2023-06-01' })
    expect(anthropicHeaders).not.toHaveProperty('Authorization')
    expect(anthropicHeaders).not.toHaveProperty('x-api-key')
  })

  it('uses Bearer for OpenAI and x-api-key for Anthropic CLIProxy requests', () => {
    const provider = {
      kind: 'cliproxy' as const,
      baseUrl: 'http://127.0.0.1:8317/v1',
      apiKey: 'proxy-secret',
    }
    expect(
      buildProviderHeaders(provider, 'openai-chat-completions').Authorization,
    ).toBe('Bearer proxy-secret')
    expect(buildProviderHeaders(provider, 'anthropic-messages')).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'proxy-secret',
    })
  })

  it('keeps OpenRouter Anthropic requests on Bearer authentication', () => {
    const headers = buildProviderHeaders(
      {
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'router-secret',
      },
      'anthropic-messages',
    )
    expect(headers.Authorization).toBe('Bearer router-secret')
    expect(headers).not.toHaveProperty('x-api-key')
  })
})
