import { describe, expect, it } from 'vitest'
import { createOpenRouterAutoModel } from '../src/electron/storage/default-models'

describe('new-vault model defaults', () => {
  it('seeds OpenRouter Auto with a 1M context window and 128K output limit', () => {
    const timestamp = '2026-08-15T00:00:00.000Z'

    expect(createOpenRouterAutoModel(timestamp)).toMatchObject({
      id: 'openrouter-auto',
      providerId: 'openrouter',
      remoteId: 'openrouter/auto',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      defaultWebSearchMode: 'off',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  })

  it('applies secure-by-default routing: deny data collection and require ZDR', () => {
    const model = createOpenRouterAutoModel('2026-08-15T00:00:00.000Z')
    expect(model.providerRouting).toEqual({ dataCollection: 'deny', zdr: true })
  })
})
