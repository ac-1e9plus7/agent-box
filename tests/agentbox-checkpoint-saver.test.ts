import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBoxCheckpointSaver } from '../src/electron/storage/agentbox-checkpoint-saver'
import {
  DEFAULT_CHECKPOINT_REPOSITORY_LIMITS,
  EncryptedCheckpointRepository,
  type CheckpointRepositoryLimits,
} from '../src/electron/storage/checkpoint-repository'
import { EncryptedRecordNamespace } from '../src/electron/storage/encrypted-record-namespace'

const temporaryDirectories: string[] = []

async function createSaver(limitPatch: Partial<CheckpointRepositoryLimits> = {}): Promise<{
  records: EncryptedRecordNamespace
  repository: EncryptedCheckpointRepository
  saver: AgentBoxCheckpointSaver
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agentbox-checkpoints-'))
  temporaryDirectories.push(directory)
  const records = new EncryptedRecordNamespace(
    join(directory, 'records'),
    'agent-checkpoints-v1',
    randomBytes(32),
    randomBytes(32),
  )
  const repository = new EncryptedCheckpointRepository(records, {
    ...DEFAULT_CHECKPOINT_REPOSITORY_LIMITS,
    ...limitPatch,
  })
  await repository.initialize()
  return { records, repository, saver: new AgentBoxCheckpointSaver(repository) }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  )
})

const CounterState = Annotation.Root({ count: Annotation<number>() })

function createCounterGraph(checkpointer: MemorySaver | AgentBoxCheckpointSaver) {
  return new StateGraph(CounterState)
    .addNode('increment', (state) => ({ count: state.count + 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile({ checkpointer })
}

describe('AgentBox checkpoint saver', () => {
  it('matches MemorySaver for graph state, parents and latest lookup', async () => {
    const { saver } = await createSaver()
    const memory = new MemorySaver()
    const encryptedGraph = createCounterGraph(saver)
    const memoryGraph = createCounterGraph(memory)
    const config = { configurable: { thread_id: 'thread-1' } }

    expect(await encryptedGraph.invoke({ count: 2 }, config)).toEqual(await memoryGraph.invoke({ count: 2 }, config))
    const encryptedTuples = []
    for await (const tuple of saver.list(config)) encryptedTuples.push(tuple)
    const memoryTuples = []
    for await (const tuple of memory.list(config)) memoryTuples.push(tuple)

    expect(encryptedTuples.map((tuple) => tuple.metadata?.step)).toEqual(
      memoryTuples.map((tuple) => tuple.metadata?.step),
    )
    expect(encryptedTuples.map((tuple) => tuple.checkpoint.channel_values)).toEqual(
      memoryTuples.map((tuple) => tuple.checkpoint.channel_values),
    )
    expect(encryptedTuples[0]?.parentConfig?.configurable?.checkpoint_id).toBe(
      encryptedTuples[1]?.config.configurable?.checkpoint_id,
    )
    await expect(saver.get(config)).resolves.toEqual(encryptedTuples[0]?.checkpoint)
  })

  it('supports before, metadata filters and list limits', async () => {
    const { saver } = await createSaver()
    const graph = createCounterGraph(saver)
    const config = { configurable: { thread_id: 'thread-list' } }
    await graph.invoke({ count: 0 }, config)
    const all = []
    for await (const tuple of saver.list(config)) all.push(tuple)
    expect(all.length).toBeGreaterThanOrEqual(3)

    const limited = []
    for await (const tuple of saver.list(config, { limit: 1 })) limited.push(tuple)
    expect(limited).toHaveLength(1)

    const before = []
    for await (const tuple of saver.list(config, { before: all[0]!.config })) before.push(tuple)
    expect(before.map((tuple) => tuple.config.configurable?.checkpoint_id)).not.toContain(
      all[0]!.config.configurable?.checkpoint_id,
    )

    const filtered = []
    for await (const tuple of saver.list(config, { filter: { source: 'input' } })) filtered.push(tuple)
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.metadata?.source).toBe('input')
  })

  it('stores regular pending writes idempotently and replaces special writes', async () => {
    const { saver } = await createSaver()
    const graph = createCounterGraph(saver)
    const config = { configurable: { thread_id: 'thread-writes' } }
    await graph.invoke({ count: 0 }, config)
    const latest = await saver.getTuple(config)
    expect(latest).toBeDefined()
    await saver.putWrites(latest!.config, [['result', 'first']], 'task-1')
    await saver.putWrites(latest!.config, [['result', 'ignored']], 'task-1')
    await saver.putWrites(latest!.config, [['__error__', 'old error']], 'task-1')
    await saver.putWrites(latest!.config, [['__error__', 'new error']], 'task-1')

    const restored = await saver.getTuple(latest!.config)
    expect(restored?.pendingWrites).toContainEqual(['task-1', 'result', 'first'])
    expect(restored?.pendingWrites).not.toContainEqual(['task-1', 'result', 'ignored'])
    expect(restored?.pendingWrites).toContainEqual(['task-1', '__error__', 'new error'])
  })

  it('deletes complete threads and enforces whole-thread count quotas', async () => {
    const { repository, saver } = await createSaver({ maxThreads: 1 })
    await repository.setThreadDescriptor('evictable', {
      lifecycle: 'abandoned',
      hasTraceFallback: true,
    })
    await createCounterGraph(saver).invoke({ count: 0 }, { configurable: { thread_id: 'active' } })
    await expect(repository.getThreadDescriptor('evictable')).resolves.toBeUndefined()
    await saver.deleteThread('active')
    await saver.deleteThread('active')
    await expect(saver.getTuple({ configurable: { thread_id: 'active' } })).resolves.toBeUndefined()
  })

  it('rejects an oversized checkpoint before persisting it', async () => {
    const { saver } = await createSaver({ maxCheckpointBytes: 128 })
    const graph = new StateGraph(Annotation.Root({ value: Annotation<string>() }))
      .addNode('finish', (state) => ({ value: state.value }))
      .addEdge(START, 'finish')
      .addEdge('finish', END)
      .compile({ checkpointer: saver })
    await expect(
      graph.invoke({ value: 'x'.repeat(2_000) }, { configurable: { thread_id: 'oversized' } }),
    ).rejects.toMatchObject({ name: 'CheckpointQuotaError' })
  })

  it('externalizes message history into snapshot and delta artifacts before checkpoint serialization', async () => {
    const { repository, saver } = await createSaver()
    const MessageState = Annotation.Root({ messages: Annotation<Array<{ id: string; content: string }>>() })
    const graph = new StateGraph(MessageState)
      .addNode('append', (state) => ({
        messages: [...state.messages, { id: 'assistant-1', content: 'result'.repeat(10_000) }],
      }))
      .addEdge(START, 'append')
      .addEdge('append', END)
      .compile({ checkpointer: saver })
    const initialMessages = [{ id: 'user-1', content: 'prompt'.repeat(100_000) }]

    const output = await graph.invoke(
      { messages: initialMessages },
      { configurable: { thread_id: 'message-artifacts' } },
    )
    expect(output.messages).toHaveLength(2)
    const records = await repository.listCheckpoints({ threadId: 'message-artifacts' })
    expect(records.length).toBeGreaterThanOrEqual(3)
    expect(records.every((record) => record.checkpoint.data.byteLength < 100_000)).toBe(true)
    for (const record of records) {
      const pending = await repository.getPendingWrites(record.threadId, record.namespace, record.checkpointId)
      expect(pending.writes.every((write) => write.value.data.byteLength < 100_000)).toBe(true)
    }
    const restored = await saver.getTuple({ configurable: { thread_id: 'message-artifacts' } })
    expect(restored?.checkpoint.channel_values.messages).toEqual(output.messages)
  })

  it('quarantines corrupt manifests and removes encrypted orphan records during startup recovery', async () => {
    const { records, repository } = await createSaver()
    await records.writeRecord('corrupt-thread', 'manifest', Buffer.from('{invalid-json'))
    await repository.initialize()
    await expect(repository.getThreadDescriptor('corrupt-thread')).resolves.toBeUndefined()

    await repository.setThreadDescriptor('orphan-thread', {
      lifecycle: 'abandoned',
      hasTraceFallback: false,
    })
    await records.writeRecord('orphan-thread', 'unreferenced-record', Buffer.from('encrypted orphan'))
    await expect(records.readRecord('orphan-thread', 'unreferenced-record')).resolves.toBeDefined()
    await repository.initialize()
    await expect(records.readRecord('orphan-thread', 'unreferenced-record')).resolves.toBeUndefined()
  })

  it('reclassifies process-local active threads during startup recovery', async () => {
    const { repository } = await createSaver()
    await repository.setThreadDescriptor('active-without-trace', {
      lifecycle: 'active',
      hasTraceFallback: false,
    })
    await repository.setThreadDescriptor('active-with-trace', {
      lifecycle: 'active',
      hasTraceFallback: true,
    })

    await repository.initialize()
    await expect(repository.getThreadDescriptor('active-without-trace')).resolves.toMatchObject({
      lifecycle: 'abandoned',
    })
    await expect(repository.getThreadDescriptor('active-with-trace')).resolves.toMatchObject({
      lifecycle: 'interrupted',
    })
  })
})
