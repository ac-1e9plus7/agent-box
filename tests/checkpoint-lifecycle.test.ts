import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../src/shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { AppRepository } = await import('../src/electron/storage/app-repository')
const { agentCheckpointThreadId } = await import('../src/electron/storage/checkpoint-identity')

const temporaryDirectories: string[] = []

async function createRepository(): Promise<InstanceType<typeof AppRepository>> {
  const directory = await mkdtemp(join(tmpdir(), 'agentbox-checkpoint-lifecycle-'))
  temporaryDirectories.push(directory)
  const repository = new AppRepository(directory)
  await repository.initialize()
  return repository
}

function conversation(id: string, assistantId = 'assistant-1'): Conversation {
  const timestamp = '2026-01-01T00:00:00.000Z'
  return {
    id,
    title: 'Checkpoint lifecycle',
    modelId: 'openrouter-auto',
    messages: [
      { id: 'user-1', role: 'user', content: 'hello', parentMessageId: null, createdAt: timestamp },
      {
        id: assistantId,
        role: 'assistant',
        content: 'partial',
        parentMessageId: 'user-1',
        interruption: { reason: 'network', message: 'disconnected', occurredAt: timestamp },
        createdAt: timestamp,
      },
    ],
    currentLeafId: assistantId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  )
})

describe('Agent checkpoint lifecycle', () => {
  it('removes a checkpoint thread before committing a branch deletion', async () => {
    const repository = await createRepository()
    const stored = await repository.saveConversation(conversation('conversation-branch'))
    const threadId = agentCheckpointThreadId(stored.id, 'assistant-1')
    await repository.getAgentCheckpointSaver().setThreadDescriptor(threadId, {
      conversationId: stored.id,
      responseMessageId: 'assistant-1',
      lifecycle: 'interrupted',
      hasTraceFallback: true,
    })

    await repository.saveConversation({
      ...stored,
      messages: stored.messages.filter((message) => message.id !== 'assistant-1'),
      currentLeafId: 'user-1',
    })
    await expect(repository.getAgentCheckpointSaver().getThreadDescriptor(threadId)).resolves.toBeUndefined()
    repository.destroy()
  })

  it('removes every checkpoint thread when a conversation is deleted', async () => {
    const repository = await createRepository()
    const stored = await repository.saveConversation(conversation('conversation-delete'))
    const threadId = agentCheckpointThreadId(stored.id, 'assistant-1')
    await repository.getAgentCheckpointSaver().setThreadDescriptor(threadId, {
      conversationId: stored.id,
      responseMessageId: 'assistant-1',
      lifecycle: 'interrupted',
      hasTraceFallback: true,
    })

    await repository.removeConversation(stored.id)
    await expect(repository.getAgentCheckpointSaver().getThreadDescriptor(threadId)).resolves.toBeUndefined()
    repository.destroy()
  })

  it('clears the checkpoint namespace before clearing conversations', async () => {
    const repository = await createRepository()
    const stored = await repository.saveConversation(conversation('conversation-clear'))
    const threadId = agentCheckpointThreadId(stored.id, 'assistant-1')
    await repository.getAgentCheckpointSaver().setThreadDescriptor(threadId, {
      conversationId: stored.id,
      responseMessageId: 'assistant-1',
      lifecycle: 'interrupted',
      hasTraceFallback: true,
    })

    await repository.clearConversations()
    expect(repository.listConversations()).toEqual([])
    await expect(repository.getAgentCheckpointSaver().getThreadDescriptor(threadId)).resolves.toBeUndefined()
    repository.destroy()
  })
})
