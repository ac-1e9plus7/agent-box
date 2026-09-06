import { describe, expect, it } from 'vitest'
import { executeCode } from '../src/electron/api/code-executor'
import { defaultDeveloperRuntimeSettings } from '../src/electron/storage/settings-schema'

const executable = process.env.AGENTBOX_TEST_PYTHON
describe.skipIf(!executable)('explicit live Python runtime', () => {
  const settings = defaultDeveloperRuntimeSettings()
  settings.python = { ...settings.python, mode: 'custom', executable: executable || '' }

  it('executes a data calculation with structured input', async () => {
    const result = await executeCode({
      language: 'python',
      code: 'print(sum(input_data["values"]))',
      input: { values: [12.5, 7.5] },
      runtimeSettings: settings,
    })
    expect(result.isError, result.result).toBe(false)
    expect(result.result).toBe('20.0')
  })

  it('rejects filesystem access and module escape', async () => {
    for (const code of ['open("private.txt", "w")', 'import os\nprint(os.environ)']) {
      const result = await executeCode({ language: 'python', code, runtimeSettings: settings })
      expect(result.isError).toBe(true)
    }
  })

  it('terminates runaway Python within its execution budget', async () => {
    const result = await executeCode({
      language: 'python',
      code: 'while True: pass',
      timeoutMs: 500,
      runtimeSettings: settings,
    })
    expect(result.isError).toBe(true)
    expect(result.result).toMatch(/exceeded|终止|超过/i)
  })
})
