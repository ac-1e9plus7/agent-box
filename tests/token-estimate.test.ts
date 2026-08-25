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
    expect(estimateMessageTokens({ content: 'abcd', reasoning: 'x'.repeat(10_000) } as never)).toBe(
      PER_MESSAGE_OVERHEAD + 1,
    )
  })

  it('exposes the constants shared by main and renderer', () => {
    expect(PER_MESSAGE_OVERHEAD).toBe(8)
    expect(REQUEST_OVERHEAD).toBe(64)
    expect(RESERVED_SAFETY_TOKENS).toBe(128)
  })

  it('estimates token costs for image, text, and document attachments', () => {
    const withImage = estimateMessageTokens({
      content: 'hello',
      attachments: [
        {
          id: '1',
          name: 'pic.png',
          mimeType: 'image/png',
          size: 1000,
          data: 'data:image/png;base64,123',
          type: 'image',
        },
      ],
    })
    expect(withImage).toBe(PER_MESSAGE_OVERHEAD + estimateTextTokens('hello') + 1000)

    const withText = estimateMessageTokens({
      content: '',
      attachments: [
        { id: '2', name: 'code.ts', mimeType: 'text/typescript', size: 50, data: 'const x = 1;', type: 'text' },
      ],
    })
    expect(withText).toBe(PER_MESSAGE_OVERHEAD + 0 + estimateTextTokens('const x = 1;') + 16)
  })

  it('includes tool calls, tool results, and provider continuation items', () => {
    const plain = estimateMessageTokens({ content: 'done' })
    const withTrace = estimateMessageTokens({
      content: 'done',
      agentTrace: [
        { type: 'assistant_text', turn: 1, text: 'done' },
        {
          type: 'provider_item',
          turn: 1,
          format: 'openai-responses',
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
        },
        {
          type: 'tool_call',
          turn: 1,
          callId: 'call-1',
          toolName: 'read_file',
          modelToolName: 'mcp_a_read_file',
          args: { path: 'README.md' },
        },
        { type: 'tool_result', turn: 1, callId: 'call-1', toolName: 'read_file', result: 'file contents' },
      ],
    })
    expect(withTrace).toBeGreaterThan(plain)
  })
})
