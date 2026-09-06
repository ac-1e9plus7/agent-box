import { afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}))
const { AppRepository } = await import('../src/electron/storage/app-repository')

describe('data-plat encrypted configuration and operation journal', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn()
  })
  it('roundtrips credentials only inside the vault, preserves masks, and clears journal with history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-plat-vault-'))
    let repo = new AppRepository(directory)
    cleanup.push(() => {
      repo.destroy()
      rmSync(directory, { recursive: true, force: true })
    })
    await repo.initialize()
    const saved = await repo.upsertMcpServer({
      name: 'Data',
      transport: 'http',
      url: 'http://localhost:8081/mcp',
      dataPlat: { apiBaseUrl: 'http://localhost:8080', agentId: 'AgentBox', loginToken: 'synthetic-private-login' },
    })
    const view = repo.toMcpServerView(saved)
    expect(JSON.stringify(view)).not.toContain('synthetic-private-login')
    await repo.upsertMcpServer(view)
    expect(repo.getMcpServer(saved.id)?.dataPlat?.loginToken).toBe('synthetic-private-login')
    const timestamp = new Date().toISOString()
    const conversation = await repo.saveConversation({
      id: 'c',
      modelId: repo.listModels()[0]!.id,
      title: 'Data',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [{ id: 'derived', role: 'assistant', content: 'summary', governedData: true, createdAt: timestamp }],
    })
    await repo.saveConversation({
      ...conversation,
      messages: conversation.messages.map((message) => ({ ...message, governedData: false })),
    })
    expect(repo.getConversation('c')?.messages[0]?.governedData).toBe(true)
    await repo.recordDataPlatOperation({
      key: 'k',
      identity: 'i',
      conversationId: 'c',
      serverId: saved.id,
      executionId: 'qry_12345678',
      planId: 'p',
      toolName: 'query_run',
      createdAt: new Date().toISOString(),
    })
    expect(readFileSync(join(directory, 'vault/user-data.v1.enc'), 'utf8')).not.toContain('synthetic-private-login')
    repo.destroy()
    repo = new AppRepository(directory)
    await repo.initialize()
    expect(repo.getConversation('c')?.messages[0]?.governedData).toBe(true)
    expect(repo.listDataPlatOperations('c')).toHaveLength(1)
    await expect(repo.recordDataPlatOperation(repo.listDataPlatOperations('c')[0]!)).rejects.toThrow('already recorded')
    await repo.clearConversations()
    expect(repo.listDataPlatOperations('c')).toEqual([])
    await repo.upsertMcpServer({ ...view, dataPlat: null })
    expect(repo.getMcpServer(saved.id)?.dataPlat).toBeUndefined()
  })
  it('rejects insecure remote API endpoints and invalid identity configuration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-plat-config-'))
    const repo = new AppRepository(directory)
    cleanup.push(() => {
      repo.destroy()
      rmSync(directory, { recursive: true, force: true })
    })
    await repo.initialize()
    const input = {
      name: 'Data',
      transport: 'http' as const,
      url: 'http://localhost:8081/mcp',
      dataPlat: { apiBaseUrl: 'http://remote.example', agentId: 'agentbox', loginToken: 'fixture' },
    }
    await expect(repo.upsertMcpServer(input)).rejects.toThrow()
    await expect(
      repo.upsertMcpServer({ ...input, dataPlat: { ...input.dataPlat, apiBaseUrl: 'https://user:pass@example.com' } }),
    ).rejects.toThrow()
    await expect(repo.upsertMcpServer({ ...input, transport: 'stdio', command: 'node' })).rejects.toThrow()
  })
})
