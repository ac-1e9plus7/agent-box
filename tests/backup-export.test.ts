import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextWriter, Uint8ArrayReader, ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/types'
import {
  createBackupArchive,
  createBackupFileName,
  normalizeExportBackupInput,
  type BackupManifest,
} from '../src/electron/backup/backup-export'

describe('conversation backup export', () => {
  let temporaryDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentbox-backup-'))
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('creates a shallow plaintext ZIP with lossless JSON, readable Markdown and metadata', async () => {
    const outputPath = join(temporaryDirectory, 'shallow.zip')
    const conversations = [sampleConversation('conversation-one')]
    await writeFile(outputPath, 'previous backup', 'utf8')

    const result = await createBackupArchive({
      outputPath,
      input: { mode: 'shallow' },
      conversations,
      appInfo: { name: 'AgentBox', version: 'test', platform: process.platform },
      createdAt: new Date('2026-08-23T10:00:00.000Z'),
    })

    expect(result).toMatchObject({
      canceled: false,
      encrypted: false,
      mode: 'shallow',
      conversationCount: 1,
      workspaceCount: 0,
    })
    expect(result.bytesWritten).toBeGreaterThan(0)
    expect(
      (await readdir(temporaryDirectory)).filter((name) => name.includes('.partial') || name.includes('.replaced')),
    ).toEqual([])

    const { entries, close } = await openArchive(outputPath)
    try {
      expect(entries.map((entry) => entry.filename)).toEqual([
        'manifest.json',
        'README.txt',
        'conversations/index.json',
        'conversations/conversation-0001.json',
        'conversations/conversation-0001.md',
      ])
      expect(entries.every((entry) => !entry.encrypted)).toBe(true)

      const manifest = JSON.parse(await readEntryText(entries, 'manifest.json')) as BackupManifest
      expect(manifest).toMatchObject({
        format: 'agentbox-backup',
        formatVersion: 1,
        mode: 'shallow',
        encryption: { enabled: false, method: 'none' },
        conversations: { count: 1, includesAllBranches: true },
        workspaces: { included: false, count: 0 },
      })
      expect(manifest.omitted.join(' ')).toContain('API keys')

      const exported = JSON.parse(await readEntryText(entries, 'conversations/conversation-0001.json')) as Conversation
      expect(exported).toEqual(conversations[0])
      const markdown = await readEntryText(entries, 'conversations/conversation-0001.md')
      expect(markdown).toContain('# Backup test')
      expect(markdown).toContain('全部分支')
      expect(markdown).toContain('Hello from the backup test')
      expect(markdown).toContain('附件原始数据保存在对应的完整 JSON 文件中')
    } finally {
      await close()
    }
  })

  it('encrypts every file entry with AES-256 and requires the correct password', async () => {
    const outputPath = join(temporaryDirectory, 'encrypted.zip')
    await createBackupArchive({
      outputPath,
      input: { mode: 'shallow', password: 'correct horse battery staple' },
      conversations: [sampleConversation('encrypted-conversation')],
      appInfo: { name: 'AgentBox', version: 'test', platform: process.platform },
    })

    const { entries, close } = await openArchive(outputPath)
    try {
      expect(entries.filter((entry) => !entry.directory).every((entry) => entry.encrypted)).toBe(true)
      await expect(readEntryText(entries, 'manifest.json', 'wrong password')).rejects.toThrow()

      const manifest = JSON.parse(
        await readEntryText(entries, 'manifest.json', 'correct horse battery staple'),
      ) as BackupManifest
      expect(manifest.encryption).toEqual({
        enabled: true,
        method: 'WinZip AES-256 (AE-2)',
        filenameVisibility: 'ZIP entry names are not encrypted',
      })
      const manifestEntry = entries.find((entry) => entry.filename === 'manifest.json')
      expect(manifestEntry?.extraFieldAES?.strength).toBe(3)
    } finally {
      await close()
    }
  })

  it('deep mode deduplicates workspaces and preserves nested files and empty directories', async () => {
    const workspace = join(temporaryDirectory, 'workspace')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'empty'), { recursive: true })
    await writeFile(join(workspace, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
    await writeFile(join(workspace, 'README.md'), '# Workspace\n', 'utf8')

    const first = { ...sampleConversation('first'), workingDirectory: workspace }
    const second = { ...sampleConversation('second'), workingDirectory: workspace }
    const outputPath = join(workspace, 'deep-backup.zip')
    const result = await createBackupArchive({
      outputPath,
      input: { mode: 'deep' },
      conversations: [first, second],
      appInfo: { name: 'AgentBox', version: 'test', platform: process.platform },
    })

    expect(result.workspaceCount).toBe(1)
    const { entries, close } = await openArchive(outputPath)
    try {
      const filenames = entries.map((entry) => entry.filename)
      expect(filenames).toContain('workspaces/workspace-0001/')
      expect(filenames).toContain('workspaces/workspace-0001/empty/')
      expect(filenames).toContain('workspaces/workspace-0001/README.md')
      expect(filenames).toContain('workspaces/workspace-0001/src/index.ts')
      expect(filenames).not.toContain('workspaces/workspace-0001/deep-backup.zip')
      expect(await readEntryText(entries, 'workspaces/workspace-0001/src/index.ts')).toBe('export const answer = 42\n')

      const manifest = JSON.parse(await readEntryText(entries, 'manifest.json')) as BackupManifest
      expect(manifest.workspaces).toMatchObject({
        included: true,
        count: 1,
        referencedConversationCount: 2,
      })
      expect(manifest.workspaces.items[0]).toMatchObject({
        resolvedPath: await realpath(workspace),
        conversationIds: ['first', 'second'],
        fileCount: 2,
        directoryCount: 3,
        totalBytes: Buffer.byteLength('export const answer = 42\n# Workspace\n'),
      })
    } finally {
      await close()
    }
  })

  it('excludes protected application data nested beneath a deep-backup workspace', async () => {
    const workspace = join(temporaryDirectory, 'workspace')
    const applicationData = join(workspace, 'agentbox-user-data')
    const outputPath = join(temporaryDirectory, 'protected-data.zip')
    await mkdir(join(applicationData, 'vault'), { recursive: true })
    await writeFile(join(workspace, 'README.md'), '# Workspace\n', 'utf8')
    await writeFile(join(applicationData, 'vault', 'master-key.bin'), 'sensitive', 'utf8')

    await createBackupArchive({
      outputPath,
      input: { mode: 'deep' },
      conversations: [{ ...sampleConversation('protected'), workingDirectory: workspace }],
      appInfo: { name: 'AgentBox', version: 'test', platform: process.platform },
      protectedPaths: [applicationData],
    })

    const { entries, close } = await openArchive(outputPath)
    try {
      const filenames = entries.map((entry) => entry.filename)
      expect(filenames).toContain('workspaces/workspace-0001/README.md')
      expect(filenames.some((filename) => filename.includes('agentbox-user-data'))).toBe(false)
    } finally {
      await close()
    }
  })

  it('rejects an application-data directory as a deep-backup workspace', async () => {
    const applicationData = join(temporaryDirectory, 'agentbox-user-data')
    const outputPath = join(temporaryDirectory, 'application-data.zip')
    await mkdir(applicationData)

    await expect(
      createBackupArchive({
        outputPath,
        input: { mode: 'deep' },
        conversations: [{ ...sampleConversation('protected-root'), workingDirectory: applicationData }],
        appInfo: { name: 'AgentBox', version: 'test', platform: process.platform },
        protectedPaths: [applicationData],
      }),
    ).rejects.toThrow()
    expect(await readdir(temporaryDirectory)).not.toContain('application-data.zip')
  })

  it('fails before writing an archive when a deep-backup workspace is unavailable', async () => {
    const outputPath = join(temporaryDirectory, 'missing.zip')
    const conversation = {
      ...sampleConversation('missing'),
      workingDirectory: join(temporaryDirectory, 'does-not-exist'),
    }

    await expect(
      createBackupArchive({
        outputPath,
        input: { mode: 'deep' },
        conversations: [conversation],
        appInfo: { name: 'AgentBox', version: 'test', platform: process.platform },
      }),
    ).rejects.toThrow('无法读取会话“Backup test”的工作目录')

    expect(await readdir(temporaryDirectory)).not.toContain('missing.zip')
  })

  it('validates modes and password bounds and creates filesystem-safe default names', () => {
    expect(() => normalizeExportBackupInput({ mode: 'shallow', password: 'x'.repeat(257) })).toThrow(
      '不能超过 256 个字符',
    )
    expect(() => normalizeExportBackupInput({ mode: 'invalid' } as never)).toThrow('备份模式无效')
    expect(createBackupFileName('deep', new Date('2026-08-23T10:11:12.345Z'))).toBe(
      'AgentBox-backup-deep-2026-08-23_10-11-12-345.zip',
    )
  })
})

function sampleConversation(id: string): Conversation {
  return {
    id,
    title: 'Backup test',
    modelId: 'test-model',
    reasoningEnabled: true,
    agentMode: true,
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: 'Hello from the backup test',
        attachments: [
          {
            id: `${id}-attachment`,
            name: 'note.txt',
            mimeType: 'text/plain',
            size: 4,
            data: 'note',
            type: 'text',
          },
        ],
        createdAt: '2026-08-23T09:00:00.000Z',
      },
      {
        id: `${id}-assistant`,
        parentMessageId: `${id}-user`,
        role: 'assistant',
        content: 'The exported response',
        reasoning: 'A concise saved reasoning summary.',
        createdAt: '2026-08-23T09:00:01.000Z',
      },
    ],
    currentLeafId: `${id}-assistant`,
    createdAt: '2026-08-23T09:00:00.000Z',
    updatedAt: '2026-08-23T09:00:01.000Z',
  }
}

async function openArchive(path: string): Promise<{
  entries: Entry[]
  close: () => Promise<void>
}> {
  const archive = await readFile(path)
  const bytes = new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength)
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  const entries = await reader.getEntries()
  return { entries, close: () => reader.close() }
}

async function readEntryText(entries: Entry[], filename: string, password?: string): Promise<string> {
  const entry = entries.find(
    (candidate): candidate is FileEntry => candidate.filename === filename && !candidate.directory,
  )
  if (!entry) throw new Error(`Missing ZIP entry: ${filename}`)
  return entry.getData(new TextWriter(), {
    ...(password ? { password } : {}),
    useWebWorkers: false,
  })
}
