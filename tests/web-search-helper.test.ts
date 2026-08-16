import { describe, expect, it } from 'vitest'
import {
  effectiveWebSearchMode,
  isWebSearchAvailable,
  WEB_SEARCH_MODE_LABELS,
} from '../src/renderer/src/web-search'
import type { ModelConfig, ProviderConfig } from '../src/renderer/src/types'

const timestamp = '2026-01-01T00:00:00.000Z'

const openRouterModel: ModelConfig = {
  id: 'm1',
  name: 'OpenRouter Auto',
  providerId: 'p1',
  remoteId: 'openrouter/auto',
  contextWindow: 128_000,
  maxOutputTokens: 8192,
  supportsReasoning: false,
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  createdAt: timestamp,
  updatedAt: timestamp,
}

const openRouterProvider: ProviderConfig = {
  id: 'p1',
  name: 'OpenRouter',
  kind: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiFormat: 'openai-chat-completions',
  hasApiKey: true,
  apiKeyOptional: false,
  defaultHeaders: {},
  createdAt: timestamp,
  updatedAt: timestamp,
}

describe('Renderer web search availability and mode resolution', () => {
  it('exposes Chinese labels for search modes', () => {
    expect(WEB_SEARCH_MODE_LABELS.off).toBe('关闭')
    expect(WEB_SEARCH_MODE_LABELS.auto).toBe('自动搜索')
    expect(WEB_SEARCH_MODE_LABELS.native).toBe('原生优先')
  })

  it('enables web search only for OpenRouter provider with supported API formats', () => {
    expect(isWebSearchAvailable(openRouterModel, openRouterProvider)).toBe(true)

    // OpenAI provider
    expect(
      isWebSearchAvailable(openRouterModel, {
        ...openRouterProvider,
        kind: 'openai',
      }),
    ).toBe(false)

    // Custom provider
    expect(
      isWebSearchAvailable(openRouterModel, {
        ...openRouterProvider,
        kind: 'custom',
      }),
    ).toBe(false)

    // Missing model or provider
    expect(isWebSearchAvailable(undefined, openRouterProvider)).toBe(false)
    expect(isWebSearchAvailable(openRouterModel, undefined)).toBe(false)
  })

  it('resolves effective search mode to off when provider does not support search', () => {
    const customProvider: ProviderConfig = {
      ...openRouterProvider,
      kind: 'custom',
    }
    expect(effectiveWebSearchMode(openRouterModel, customProvider, 'auto')).toBe('off')
    expect(effectiveWebSearchMode(openRouterModel, customProvider, 'native')).toBe('off')
  })

  it('resolves effective search mode according to user selection when supported', () => {
    expect(effectiveWebSearchMode(openRouterModel, openRouterProvider, 'native')).toBe(
      'native',
    )
    expect(effectiveWebSearchMode(openRouterModel, openRouterProvider, 'auto')).toBe(
      'auto',
    )
    expect(effectiveWebSearchMode(openRouterModel, openRouterProvider, undefined)).toBe(
      'off',
    )
  })
})
