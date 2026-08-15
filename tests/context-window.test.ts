import { describe, expect, it } from 'vitest'
import {
  estimateMessageTokens,
  estimateTextTokens,
  prepareMessagesForContext,
  resolveContextManagementMode,
} from '../src/electron/api/context-window'
import type { Message } from '../src/shared/types'

const message = (
  id: string,
  role: Message['role'],
  content: string,
  reasoning?: string,
): Message => ({
  id,
  role,
  content,
  reasoning,
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('context-window', () => {
  it('uses a conservative estimate for CJK text', () => {
    expect(estimateTextTokens('测试文本')).toBe(4)
    expect(estimateTextTokens('abcd')).toBe(1)
  })

  it('does not count reasoning that is not sent on the wire', () => {
    const withoutReasoning = message('a', 'assistant', 'answer')
    const withReasoning = message('a', 'assistant', 'answer', 'x'.repeat(10_000))
    expect(estimateMessageTokens(withReasoning)).toBe(
      estimateMessageTokens(withoutReasoning),
    )
  })

  it('drops oldest complete turns and retains system plus latest user', () => {
    const messages = [
      message('system', 'system', 's'),
      message('old-user', 'user', 'a'.repeat(400)),
      message('old-assistant', 'assistant', 'b'.repeat(400)),
      message('latest-user', 'user', 'latest'),
    ]
    const result = prepareMessagesForContext(messages, 500, 100, 'auto')
    expect(result.messages.map(({ id }) => id)).toEqual(['system', 'latest-user'])
    expect(result.removedMessageCount).toBe(2)
  })

  it('keeps a complete previous turn when space permits', () => {
    const messages = [
      message('system', 'system', 's'),
      message('old-user', 'user', 'a'.repeat(400)),
      message('old-assistant', 'assistant', 'b'.repeat(400)),
      message('latest-user', 'user', 'latest'),
    ]
    const result = prepareMessagesForContext(messages, 650, 100, 'auto')
    expect(result.messages).toEqual(messages)
    expect(result.removedMessageCount).toBe(0)
  })

  it('fails rather than removing required system or latest-user content', () => {
    const messages = [
      message('system', 'system', 's'.repeat(1_000)),
      message('latest-user', 'user', 'u'.repeat(1_000)),
    ]
    expect(() => prepareMessagesForContext(messages, 600, 100, 'auto')).toThrow(
      '系统提示词与最后一条用户消息',
    )
  })

  it('manual mode never silently removes history', () => {
    const messages = [
      message('old-user', 'user', 'a'.repeat(400)),
      message('old-assistant', 'assistant', 'b'.repeat(400)),
      message('latest-user', 'user', 'latest'),
    ]
    expect(() => prepareMessagesForContext(messages, 500, 100, 'manual')).toThrow(
      '启用“自动裁剪”',
    )
  })

  it('manual mode returns the complete history when it fits', () => {
    const messages = [
      message('old-user', 'user', 'short question'),
      message('old-assistant', 'assistant', 'short answer'),
      message('latest-user', 'user', 'follow-up'),
    ]
    const result = prepareMessagesForContext(messages, 1_000, 100, 'manual')
    expect(result.messages).toEqual(messages)
    expect(result.removedMessageCount).toBe(0)
  })

  it('defaults to the safe manual policy', () => {
    const messages = [
      message('old-user', 'user', 'a'.repeat(400)),
      message('old-assistant', 'assistant', 'b'.repeat(400)),
      message('latest-user', 'user', 'latest'),
    ]
    expect(() => prepareMessagesForContext(messages, 500, 100)).toThrow(
      '当前对话估算需要',
    )
  })

  it('allows a one-request trimming override without changing the configured mode', () => {
    expect(resolveContextManagementMode('manual', true)).toBe('auto')
    expect(resolveContextManagementMode('manual', false)).toBe('manual')
    expect(resolveContextManagementMode('auto', undefined)).toBe('auto')
  })
})
