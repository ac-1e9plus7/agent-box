import { describe, expect, it } from 'vitest'
import { normalizeMessageContent } from '../src/shared/message-content'

describe('normalizeMessageContent', () => {
  it('normalizes CRLF and CR line endings without trimming source text', () => {
    expect(normalizeMessageContent('\r\n  first\rsecond  \r\n')).toBe('\n  first\nsecond  \n')
  })

  it('preserves literal markup and existing LF line endings', () => {
    const content = '  # literal heading\n<br>\nlast line  '
    expect(normalizeMessageContent(content)).toBe(content)
  })
})
