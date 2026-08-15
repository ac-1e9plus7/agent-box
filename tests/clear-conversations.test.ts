import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Provide a functional, test-only safeStorage stand-in (base64 envelope) so the
// encrypted store can round-trip without an OS keyring. No real secrets.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { AppRepository } = await import('../src/electron/storage/app-repository')
const timestamp = '2026-08-15T00:00:00.000Z'

function makeConversation(id: string, modelId: string) {
  return {
    id,
    title: id,
    modelId,
    messages: [
      { id: 'u', role: 'user' as const, content: 'hi', createdAt: timestamp },
      { id: 'a', role: 'assistant' as const, content: 'hello', createdAt: timestamp },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

describe('clearConversations data wipe', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chatbox-clear-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  let repository: InstanceType<typeof AppRepository>

  beforeEach(async () => {
    repository = new AppRepository(dir)
    await repository.initialize()
  })

  it('removes all conversations while keeping providers, models and settings', async () => {
    const beforeProviders = repository.listProviders()
    const beforeModels = repository.listModels()
    const beforeSettings = repository.getSettings()

    await repository.saveConversation(makeConversation('c1', 'openrouter-auto'))
    await repository.saveConversation(makeConversation('c2', 'openrouter-auto'))
    expect(repository.listConversations()).toHaveLength(2)

    await repository.clearConversations()

    expect(repository.listConversations()).toEqual([])
    // Provider/model configuration is retained verbatim.
    expect(repository.listProviders()).toEqual(beforeProviders)
    expect(repository.listModels()).toEqual(beforeModels)
    expect(repository.getSettings()).toEqual(beforeSettings)
  })

  it('persists the cleared state across a fresh repository instance', async () => {
    await repository.saveConversation(makeConversation('c1', 'openrouter-auto'))
    await repository.clearConversations()

    const reopened = new AppRepository(dir)
    await reopened.initialize()
    expect(reopened.listConversations()).toEqual([])
    expect(reopened.listProviders().length).toBeGreaterThan(0)
    expect(reopened.listModels().length).toBeGreaterThan(0)
    reopened.destroy()
  })

  it('stays a no-op-safe operation when there is nothing to clear', async () => {
    await repository.clearConversations()
    expect(repository.listConversations()).toEqual([])
    expect(repository.listProviders().length).toBeGreaterThan(0)
  })
})
