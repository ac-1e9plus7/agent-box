import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkspaceFile, writeWorkspaceFile } from '../src/electron/api/workspace-files'

describe('workspace-native file tools', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agentbox-workspace-files-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('writes multiline code exactly without shell escaping and reads it back', async () => {
    const content = [
      'export function greeting(name: string): string {',
      '  const template = `hello ${name}`',
      '  return `${template} — 你好 "AgentBox"`',
      '}',
      '',
    ].join('\n')

    const written = await writeWorkspaceFile(workspace, {
      path: 'src/generated/greeting.ts',
      content,
      mode: 'create',
    })
    expect(written.isError).not.toBe(true)
    expect(await readFile(join(workspace, 'src', 'generated', 'greeting.ts'), 'utf8')).toBe(content)

    const read = await readWorkspaceFile(workspace, {
      path: 'src/generated/greeting.ts',
      maxLines: 20,
    })
    expect(read.isError).not.toBe(true)
    expect(read.result).toContain('const template = `hello ${name}`')
    expect(read.result).toContain('你好 "AgentBox"')
  })

  it('supports append mode and paginated reads', async () => {
    await writeWorkspaceFile(workspace, { path: 'notes.txt', content: 'one\ntwo\nthree', mode: 'overwrite' })
    await writeWorkspaceFile(workspace, { path: 'notes.txt', content: '\nfour', mode: 'append' })

    const read = await readWorkspaceFile(workspace, { path: 'notes.txt', startLine: 2, maxLines: 2 })
    expect(read.result).toContain('[文件: notes.txt · 行 2-3/4]')
    expect(read.result).toContain('two\nthree')
    expect(read.truncated).toBe(true)
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour')
  })

  it('rejects absolute paths and directory traversal', async () => {
    const traversal = await writeWorkspaceFile(workspace, {
      path: '../outside.txt',
      content: 'blocked',
    })
    const absolute = await readWorkspaceFile(workspace, {
      path: join(workspace, 'secret.txt'),
    })

    expect(traversal).toMatchObject({ isError: true })
    expect(traversal.result).toContain('不能离开工作目录')
    expect(absolute).toMatchObject({ isError: true })
    expect(absolute.result).toContain('相对于工作目录')
  })
})
