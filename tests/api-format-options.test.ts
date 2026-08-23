import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEW_PROVIDER_API_FORMAT,
  LEGACY_CHAT_COMPLETIONS_HINT,
  providerApiFormatOptionLabel,
} from '../src/renderer/src/api-format-options'

describe('provider API format options', () => {
  it('defaults newly added providers to Responses', () => {
    expect(DEFAULT_NEW_PROVIDER_API_FORMAT).toBe('openai-responses')
  })

  it('marks Chat Completions as a supported but discouraged legacy format', () => {
    expect(providerApiFormatOptionLabel('openai-chat-completions')).toContain('旧版，不推荐')
    expect(LEGACY_CHAT_COMPLETIONS_HINT).toContain('仍受支持')
    expect(LEGACY_CHAT_COMPLETIONS_HINT).toContain('/v1/responses')
  })

  it('keeps the recommended Responses label concise', () => {
    expect(providerApiFormatOptionLabel('openai-responses')).toBe('OpenAI Responses')
  })
})
