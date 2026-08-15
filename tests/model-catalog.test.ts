import { describe, expect, it } from 'vitest'
import { toRemoteModel } from '../src/electron/api/model-catalog'

describe('CLIProxyAPI model catalog normalization', () => {
  it('reads the unified OpenAI-style model metadata', () => {
    expect(
      toRemoteModel({
        id: 'claude-sonnet',
        display_name: 'Claude Sonnet via CLI',
        context_length: 200_000,
        max_completion_tokens: 64_000,
      }),
    ).toMatchObject({
      id: 'claude-sonnet',
      name: 'Claude Sonnet via CLI',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    })
  })

  it('supports alternate context and output metadata names', () => {
    expect(
      toRemoteModel({
        id: 'model-alias',
        max_input_tokens: 120_000,
        max_tokens: 16_000,
      }),
    ).toMatchObject({
      contextWindow: 120_000,
      maxOutputTokens: 16_000,
    })
  })

  it('prefers top-provider output metadata when present', () => {
    expect(
      toRemoteModel({
        id: 'openrouter-model',
        max_completion_tokens: 8_000,
        top_provider: { max_completion_tokens: 12_000 },
      })?.maxOutputTokens,
    ).toBe(12_000)
  })
})
