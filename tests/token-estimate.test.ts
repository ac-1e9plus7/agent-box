import { describe, expect, it } from 'vitest'
import {
  PER_MESSAGE_OVERHEAD,
  REQUEST_OVERHEAD,
  RESERVED_SAFETY_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
} from '../src/shared/token-estimate'

describe('shared token estimate', () => {
  it('counts CJK and wide characters as ~1 token each', () => {
    expect(estimateTextTokens('测试文本')).toBe(4)
    expect(estimateTextTokens('你好')).toBe(2)
  })

  it('pools basic Latin characters at ~4 per token', () => {
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcdefgh')).toBe(2)
  })

  it('mixes CJK and Latin in the same text', () => {
    // 4 CJK chars (4) + 8 Latin chars (2) = 6
    expect(estimateTextTokens('测试文本abcdefgh')).toBe(6)
  })

  it('adds per-message overhead and ignores reasoning', () => {
    expect(estimateMessageTokens({ content: 'abcd' })).toBe(PER_MESSAGE_OVERHEAD + 1)
    // A full Message may carry reasoning/usage, but only content is estimated.
    expect(
      estimateMessageTokens({ content: 'abcd', reasoning: 'x'.repeat(10_000) } as never),
    ).toBe(PER_MESSAGE_OVERHEAD + 1)
  })

  it('exposes the constants shared by main and renderer', () => {
    expect(PER_MESSAGE_OVERHEAD).toBe(8)
    expect(REQUEST_OVERHEAD).toBe(64)
    expect(RESERVED_SAFETY_TOKENS).toBe(128)
  })
})
