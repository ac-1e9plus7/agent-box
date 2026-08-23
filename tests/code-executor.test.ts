import { describe, expect, it } from 'vitest'
import { executeCode } from '../src/electron/api/code-executor'

describe('isolated code executor', () => {
  it('runs JavaScript with structured input and captures console output', async () => {
    const result = await executeCode({
      language: 'javascript',
      code: 'console.log(input.values.reduce((sum, value) => sum + value, 0))',
      input: { values: [10, 20, 12] },
    })

    expect(result).toEqual({ result: '42', isError: false, truncated: false })
  })

  it('does not expose Node process, require, or network globals', async () => {
    const result = await executeCode({
      language: 'javascript',
      code: 'console.log(typeof process, typeof require, typeof fetch, typeof WebSocket)',
    })

    expect(result.isError).toBe(false)
    expect(result.result).toBe('undefined undefined undefined undefined')
  })

  it('terminates runaway JavaScript', async () => {
    const result = await executeCode({
      language: 'javascript',
      code: 'while (true) {}',
      timeoutMs: 500,
    })

    expect(result.isError).toBe(true)
    expect(result.result).toMatch(/timed out|超过|终止/i)
  })
})
