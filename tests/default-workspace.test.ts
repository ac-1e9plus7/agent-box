import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENTBOX_WORKSPACE_NAME,
  defaultAgentBoxWorkspacePath,
  ensureDefaultAgentBoxWorkspace,
} from '../src/electron/api/default-workspace'

describe('application-adjacent default workspace', () => {
  let executableDirectory: string

  beforeEach(async () => {
    executableDirectory = await mkdtemp(join(tmpdir(), 'agentbox-default-workspace-'))
  })

  afterEach(async () => {
    await rm(executableDirectory, { recursive: true, force: true })
  })

  it('creates and reuses the hidden workspace beside the executable', async () => {
    const executablePath = join(executableDirectory, 'AgentBox.exe')
    const expected = join(executableDirectory, DEFAULT_AGENTBOX_WORKSPACE_NAME)

    expect(defaultAgentBoxWorkspacePath(executablePath)).toBe(expected)
    await expect(ensureDefaultAgentBoxWorkspace(executablePath)).resolves.toBe(expected)
    expect((await stat(expected)).isDirectory()).toBe(true)
    await expect(ensureDefaultAgentBoxWorkspace(executablePath)).resolves.toBe(expected)
  })

  it('rejects a non-directory occupying the default workspace path', async () => {
    const executablePath = join(executableDirectory, 'AgentBox.exe')
    await writeFile(join(executableDirectory, DEFAULT_AGENTBOX_WORKSPACE_NAME), 'not a directory')

    await expect(ensureDefaultAgentBoxWorkspace(executablePath)).rejects.toThrow()
  })
})
