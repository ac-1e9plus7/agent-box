import { describe, expect, it } from 'vitest'
import {
  citationCharacterCount,
  createCitationEmissionState,
  normalizeCitationUrl,
  parseOptionalWebSearchMode,
  parseStoredCitations,
  parseStoredTokenUsage,
  takeChangedWebCitations,
} from '../src/electron/storage/web-metadata-schema'

describe('web-search storage schema', () => {
  it('keeps legacy vault fields optional and validates explicit modes', () => {
    expect(parseOptionalWebSearchMode(undefined)).toBeUndefined()
    expect(parseOptionalWebSearchMode('off')).toBe('off')
    expect(parseOptionalWebSearchMode('auto')).toBe('auto')
    expect(parseOptionalWebSearchMode('native')).toBe('native')
    expect(() => parseOptionalWebSearchMode('always')).toThrow(
      'Invalid web search mode',
    )
  })

  it('whitelists citation fields, normalizes URLs, and accounts for stored text', () => {
    const citations = parseStoredCitations([
      {
        url: 'HTTPS://Example.COM:443/source',
        title: 'Source',
        content: 'Excerpt',
        startIndex: 1,
        endIndex: 8,
        unknown: 'discarded',
      },
    ])

    expect(citations).toEqual([
      {
        url: 'https://example.com/source',
        title: 'Source',
        content: 'Excerpt',
        startIndex: 1,
        endIndex: 8,
      },
    ])
    expect(citationCharacterCount(citations)).toBe(
      'https://example.com/source'.length + 'Source'.length + 'Excerpt'.length,
    )
  })

  it.each([
    'javascript:alert(1)',
    'file:///C:/secret.txt',
    'data:text/plain,hello',
    'https://user:password@example.com/private',
  ])('rejects unsafe citation URL %s', (url) => {
    expect(() => normalizeCitationUrl(url)).toThrow('Invalid citation URL')
  })

  it('limits citation count, field sizes, and invalid ranges', () => {
    expect(() =>
      parseStoredCitations(
        Array.from({ length: 101 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
      ),
    ).toThrow('Invalid message citations')
    expect(() =>
      parseStoredCitations([
        { url: 'https://example.com', content: 'x'.repeat(100_001) },
      ]),
    ).toThrow('Invalid citation content')
    expect(() =>
      parseStoredCitations([
        { url: 'https://example.com', title: 'x'.repeat(2_001) },
      ]),
    ).toThrow('Invalid citation title')
    expect(() =>
      parseStoredCitations([
        { url: `https://example.com/${'x'.repeat(4_096)}` },
      ]),
    ).toThrow('Invalid citation URL')
    expect(() =>
      parseStoredCitations([
        { url: 'https://example.com', startIndex: 10, endIndex: 9 },
      ]),
    ).toThrow('Invalid citation range')
  })

  it('validates and whitelists persisted token usage including web searches', () => {
    expect(
      parseStoredTokenUsage({
        inputTokens: 12,
        outputTokens: 5,
        reasoningTokens: 2,
        webSearchRequests: 1,
        totalTokens: 17,
        unknown: 999,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      reasoningTokens: 2,
      webSearchRequests: 1,
      totalTokens: 17,
    })
    expect(parseStoredTokenUsage(undefined)).toBeUndefined()
    expect(() => parseStoredTokenUsage({ webSearchRequests: -1 })).toThrow(
      'Invalid web search request usage',
    )
    expect(() =>
      parseStoredTokenUsage({ webSearchRequests: 1_000_000_000_001 }),
    ).toThrow('Invalid web search request usage')
  })

  it('deduplicates stream citations by normalized URL and drops unsafe values', () => {
    const state = createCitationEmissionState()
    expect(
      takeChangedWebCitations(
        [
          { url: 'HTTPS://EXAMPLE.COM:443/result', title: 'First' },
          { url: 'https://example.com/result', title: 'First' },
          { url: 'javascript:alert(1)', title: 'Unsafe' },
          { url: 'https://example.com/other', title: 'Other' },
        ],
        state,
      ),
    ).toEqual([
      { url: 'https://example.com/result', title: 'First' },
      { url: 'https://example.com/other', title: 'Other' },
    ])
    expect(
      takeChangedWebCitations(
        [{ url: 'https://example.com/result', title: 'First' }],
        state,
      ),
    ).toEqual([])
    expect(
      takeChangedWebCitations(
        [
          {
            url: 'https://example.com/result',
            title: 'First',
            content: 'Later terminal excerpt',
          },
        ],
        state,
      ),
    ).toEqual([
      {
        url: 'https://example.com/result',
        title: 'First',
        content: 'Later terminal excerpt',
      },
    ])
    expect(
      takeChangedWebCitations([{ url: 'https://example.com/result' }], state),
    ).toEqual([])
  })

  it('bounds unique citations accepted from one untrusted stream', () => {
    const state = createCitationEmissionState()
    expect(
      takeChangedWebCitations(
        Array.from({ length: 101 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
        state,
      ),
    ).toHaveLength(100)
    expect(state.byUrl.size).toBe(100)
  })
})
