import { describe, expect, it } from 'vitest'
import { interruptionFromStreamEvent, isAgentContinuationCommand, resolveNaturalAgentResumeMessageId } from '../src/renderer/src/agent-continuation'

describe('Agent interruption continuation', () => {
  it.each([
    'go',
    'Go on!',
    'continue',
    'retry please',
    'try again',
    '继续',
    '请继续执行',
    '再次尝试',
    '从中断处继续。',
  ])('recognizes short natural continuation command: %s', (command) => {
    expect(isAgentContinuationCommand(command)).toBe(true)
  })

  it.each([
    'go to the src directory and inspect files',
    '继续解释为什么这个算法是正确的，并给出证明',
    '重新生成一份完全不同的方案',
    '',
  ])('does not treat a new substantive instruction as implicit resume: %s', (command) => {
    expect(isAgentContinuationCommand(command)).toBe(false)
  })

  it('classifies API limits and resumable terminal states', () => {
    expect(interruptionFromStreamEvent({
      type: 'error',
      requestId: 'request',
      error: { message: 'Rate limit exceeded', status: 429, retryAfterSeconds: 5 },
    }, true, '2026-08-23T00:00:00.000Z')).toMatchObject({
      reason: 'rate_limit',
      retryAfterSeconds: 5,
    })
    expect(interruptionFromStreamEvent({
      type: 'done',
      requestId: 'request',
      finishReason: 'tool_turn_limit',
    }, true)).toMatchObject({ reason: 'tool_turn_limit' })
    expect(interruptionFromStreamEvent({
      type: 'done',
      requestId: 'request',
      finishReason: 'stop',
    }, true)).toBeUndefined()
    expect(interruptionFromStreamEvent({
      type: 'error',
      requestId: 'request',
      error: { message: 'network disconnected', code: 'network_error' },
    }, false)).toBeUndefined()
  })

  it('only resumes from the immediately preceding interrupted assistant message', () => {
    const timestamp = '2026-08-23T00:00:00.000Z'
    const interrupted = {
      id: 'assistant-checkpoint',
      role: 'assistant' as const,
      content: 'partial',
      interruption: { reason: 'network' as const, message: 'disconnected', occurredAt: timestamp },
      createdAt: timestamp,
    }
    expect(resolveNaturalAgentResumeMessageId([interrupted], '继续')).toBe('assistant-checkpoint')
    expect(resolveNaturalAgentResumeMessageId([interrupted], '继续', true)).toBeUndefined()
    expect(resolveNaturalAgentResumeMessageId([
      interrupted,
      { id: 'user-new', role: 'user', content: 'new task', createdAt: timestamp },
    ], '继续')).toBeUndefined()
  })
})
