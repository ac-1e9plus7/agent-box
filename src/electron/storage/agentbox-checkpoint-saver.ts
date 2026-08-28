import { Buffer } from 'node:buffer'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint'
import {
  EncryptedCheckpointRepository,
  type CheckpointThreadDescriptor,
  type StoredCheckpointRecord,
} from './checkpoint-repository'

const MESSAGE_REFERENCE_KEY = '__agentbox_message_reference_v1'

interface MessageReference {
  [MESSAGE_REFERENCE_KEY]: { kind: 'snapshot' | 'artifact'; id: string }
}

interface MessageArtifactSnapshot {
  schemaVersion: 1
  kind: 'snapshot'
  messages: unknown[]
}

interface MessageArtifactDelta {
  schemaVersion: 1
  kind: 'delta'
  parent: { kind: 'snapshot' | 'artifact'; id: string }
  removedIds: string[]
  upserts: unknown[]
}

export class AgentBoxCheckpointSaver extends BaseCheckpointSaver<number> {
  constructor(
    private readonly repository: EncryptedCheckpointRepository,
    serde?: SerializerProtocol,
  ) {
    super(serde)
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = optionalConfigString(config, 'thread_id', 256)
    if (threadId === undefined) return undefined
    const namespace = optionalConfigString(config, 'checkpoint_ns', 512, true) ?? ''
    const checkpointId = optionalConfigString(config, 'checkpoint_id', 256)
    const stored = await this.repository.getCheckpoint(threadId, namespace, checkpointId)
    return stored ? this.toCheckpointTuple(stored) : undefined
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const threadId = optionalConfigString(config, 'thread_id', 256)
    const namespace = optionalConfigString(config, 'checkpoint_ns', 512, true)
    const checkpointId = optionalConfigString(config, 'checkpoint_id', 256)
    const beforeCheckpointId = options.before ? optionalConfigString(options.before, 'checkpoint_id', 256) : undefined
    const limit = options.limit
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error('Checkpoint list limit must be a non-negative integer.')
    }
    if (limit === 0) return

    const records = await this.repository.listCheckpoints({
      threadId,
      namespace,
      checkpointId,
      beforeCheckpointId,
    })
    let yielded = 0
    for (const stored of records) {
      const tuple = await this.toCheckpointTuple(stored)
      if (options.filter && !metadataMatches(tuple.metadata, options.filter)) continue
      yield tuple
      yielded += 1
      if (limit !== undefined && yielded >= limit) return
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = requiredConfigString(config, 'thread_id', 256)
    const namespace = optionalConfigString(config, 'checkpoint_ns', 512, true) ?? ''
    const parentCheckpointId = optionalConfigString(config, 'checkpoint_id', 256)
    validateCheckpoint(checkpoint)
    validateChannelVersions(newVersions)
    const prepared = await this.externalizeCheckpointMessages(threadId, parentCheckpointId, copyCheckpoint(checkpoint))
    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ])
    await this.repository.putCheckpoint({
      threadId,
      namespace,
      checkpointId: prepared.id,
      parentCheckpointId,
      timestamp: prepared.ts,
      checkpoint: { type: checkpointType, data: checkpointBytes },
      metadata: { type: metadataType, data: metadataBytes },
    })
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: namespace,
        checkpoint_id: prepared.id,
      },
    }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requiredConfigString(config, 'thread_id', 256)
    const namespace = optionalConfigString(config, 'checkpoint_ns', 512, true) ?? ''
    const checkpointId = requiredConfigString(config, 'checkpoint_id', 256)
    assertIdentifier('task_id', taskId, 256)
    const serialized = await Promise.all(
      writes.map(async ([channel, value], inputIndex) => {
        assertIdentifier('channel', channel, 256)
        const externalized = await this.externalizePendingWriteMessages(
          threadId,
          checkpointId,
          taskId,
          inputIndex,
          channel,
          value,
        )
        const [type, data] = await this.serde.dumpsTyped(externalized)
        return {
          taskId,
          index: WRITES_IDX_MAP[channel] ?? inputIndex,
          channel,
          value: { type, data },
        }
      }),
    )
    await this.repository.putPendingWrites(threadId, namespace, checkpointId, serialized)
  }

  deleteThread(threadId: string): Promise<void> {
    assertIdentifier('thread_id', threadId, 256)
    return this.repository.deleteThread(threadId)
  }

  setThreadDescriptor(threadId: string, patch: Partial<CheckpointThreadDescriptor>): Promise<void> {
    return this.repository.setThreadDescriptor(threadId, patch)
  }

  getThreadDescriptor(threadId: string): Promise<CheckpointThreadDescriptor | undefined> {
    return this.repository.getThreadDescriptor(threadId)
  }

  deleteThreadsForConversation(conversationId: string): Promise<void> {
    return this.repository.deleteThreadsForConversation(conversationId)
  }

  clear(): Promise<void> {
    return this.repository.clear()
  }

  private async toCheckpointTuple(stored: StoredCheckpointRecord): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(stored.checkpoint.type, stored.checkpoint.data)) as unknown
    const metadata = (await this.serde.loadsTyped(stored.metadata.type, stored.metadata.data)) as unknown
    validateCheckpoint(checkpoint)
    await this.expandCheckpointMessages(stored.threadId, checkpoint)
    validateMetadata(metadata)
    const pending = await this.repository.getPendingWrites(stored.threadId, stored.namespace, stored.checkpointId)
    const pendingWrites: CheckpointPendingWrite[] = []
    for (const write of pending.writes) {
      const serializedValue = (await this.serde.loadsTyped(write.value.type, write.value.data)) as unknown
      const value = await this.expandPendingWriteMessages(stored.threadId, serializedValue)
      pendingWrites.push([write.taskId, write.channel, value])
    }
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: stored.threadId,
          checkpoint_ns: stored.namespace,
          checkpoint_id: stored.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    }
    if (stored.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: stored.threadId,
          checkpoint_ns: stored.namespace,
          checkpoint_id: stored.parentCheckpointId,
        },
      }
    }
    return tuple
  }

  private async externalizeCheckpointMessages(
    threadId: string,
    parentCheckpointId: string | undefined,
    checkpoint: Checkpoint,
  ): Promise<Checkpoint> {
    const parentReference = parentCheckpointId
      ? await this.loadStoredCheckpointMessageReference(threadId, parentCheckpointId)
      : undefined
    const directMessages = checkpoint.channel_values.messages
    if (isMessageArray(directMessages)) {
      checkpoint.channel_values.messages = await this.storeMessages(
        threadId,
        checkpoint.id,
        directMessages,
        parentReference,
      )
    }
    const startValue = checkpoint.channel_values.__start__
    if (isRecord(startValue) && isMessageArray(startValue.messages)) {
      checkpoint.channel_values.__start__ = {
        ...startValue,
        messages: await this.storeMessages(threadId, checkpoint.id, startValue.messages, parentReference),
      }
    }
    return checkpoint
  }

  private async externalizePendingWriteMessages(
    threadId: string,
    checkpointId: string,
    taskId: string,
    inputIndex: number,
    channel: string,
    value: unknown,
  ): Promise<unknown> {
    if (channel === 'messages' && isMessageArray(value)) {
      const parentReference = await this.loadStoredCheckpointMessageReference(threadId, checkpointId)
      return this.storeMessages(threadId, `${checkpointId}:write:${taskId}:${inputIndex}`, value, parentReference)
    }
    if (!isRecord(value) || !isMessageArray(value.messages)) return value
    const reference = await this.storeMessages(
      threadId,
      `${checkpointId}:write:${taskId}:${inputIndex}`,
      value.messages,
      undefined,
    )
    return { ...value, messages: reference }
  }

  private async storeMessages(
    threadId: string,
    artifactId: string,
    messages: unknown[],
    parentReference: MessageReference[typeof MESSAGE_REFERENCE_KEY] | undefined,
  ): Promise<MessageReference> {
    if (!parentReference) {
      const snapshot: MessageArtifactSnapshot = { schemaVersion: 1, kind: 'snapshot', messages }
      await this.repository.putSnapshot(threadId, Buffer.from(JSON.stringify(snapshot), 'utf8'))
      return messageReference('snapshot', 'snapshot')
    }
    const parentMessages = await this.loadMessages(threadId, parentReference)
    const delta = createMessageDelta(parentMessages, messages, parentReference)
    if (!delta) {
      const snapshot: MessageArtifactSnapshot = { schemaVersion: 1, kind: 'snapshot', messages }
      const fallbackId = `messages:${artifactId}`
      await this.repository.putArtifact(threadId, fallbackId, Buffer.from(JSON.stringify(snapshot), 'utf8'))
      return messageReference('artifact', fallbackId)
    }
    const id = `messages:${artifactId}`
    await this.repository.putArtifact(threadId, id, Buffer.from(JSON.stringify(delta), 'utf8'))
    return messageReference('artifact', id)
  }

  private async loadStoredCheckpointMessageReference(
    threadId: string,
    checkpointId: string,
  ): Promise<MessageReference[typeof MESSAGE_REFERENCE_KEY] | undefined> {
    const stored = await this.repository.getCheckpoint(threadId, '', checkpointId)
    if (!stored) return undefined
    const checkpoint = (await this.serde.loadsTyped(stored.checkpoint.type, stored.checkpoint.data)) as unknown
    if (!isRecord(checkpoint) || !isRecord(checkpoint.channel_values)) return undefined
    const direct = parseMessageReference(checkpoint.channel_values.messages)
    if (direct) return direct
    const startValue = checkpoint.channel_values.__start__
    return isRecord(startValue) ? parseMessageReference(startValue.messages) : undefined
  }

  private async expandCheckpointMessages(threadId: string, checkpoint: Checkpoint): Promise<void> {
    const direct = parseMessageReference(checkpoint.channel_values.messages)
    if (direct) checkpoint.channel_values.messages = await this.loadMessages(threadId, direct)
    const startValue = checkpoint.channel_values.__start__
    if (isRecord(startValue)) {
      const reference = parseMessageReference(startValue.messages)
      if (reference)
        checkpoint.channel_values.__start__ = { ...startValue, messages: await this.loadMessages(threadId, reference) }
    }
  }

  private async expandPendingWriteMessages(threadId: string, value: unknown): Promise<unknown> {
    const directReference = parseMessageReference(value)
    if (directReference) return this.loadMessages(threadId, directReference)
    if (!isRecord(value)) return value
    const reference = parseMessageReference(value.messages)
    if (reference) value.messages = await this.loadMessages(threadId, reference)
    return value
  }

  private async loadMessages(
    threadId: string,
    reference: MessageReference[typeof MESSAGE_REFERENCE_KEY],
    visited = new Set<string>(),
  ): Promise<unknown[]> {
    const visitKey = `${reference.kind}:${reference.id}`
    if (visited.has(visitKey) || visited.size >= 512) throw new Error('Checkpoint message artifact chain is invalid.')
    visited.add(visitKey)
    const raw =
      reference.kind === 'snapshot'
        ? await this.repository.readSnapshot(threadId)
        : await this.repository.readArtifact(threadId, reference.id)
    if (!raw) throw new Error('Checkpoint message artifact is missing.')
    let value: unknown
    try {
      value = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      throw new Error('Checkpoint message artifact is invalid.', { cause: error })
    }
    if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('Checkpoint message artifact shape is invalid.')
    if (value.kind === 'snapshot' && isMessageArray(value.messages)) return value.messages
    if (
      value.kind === 'delta' &&
      isRecord(value.parent) &&
      (value.parent.kind === 'snapshot' || value.parent.kind === 'artifact') &&
      typeof value.parent.id === 'string' &&
      Array.isArray(value.removedIds) &&
      value.removedIds.every((item) => typeof item === 'string') &&
      isMessageArray(value.upserts)
    ) {
      const parent = await this.loadMessages(threadId, { kind: value.parent.kind, id: value.parent.id }, visited)
      return applyMessageDelta(parent, value.removedIds, value.upserts)
    }
    throw new Error('Checkpoint message artifact shape is invalid.')
  }
}

function messageReference(kind: 'snapshot' | 'artifact', id: string): MessageReference {
  return { [MESSAGE_REFERENCE_KEY]: { kind, id } }
}

function parseMessageReference(value: unknown): MessageReference[typeof MESSAGE_REFERENCE_KEY] | undefined {
  if (!isRecord(value)) return undefined
  const reference = value[MESSAGE_REFERENCE_KEY]
  if (
    !isRecord(reference) ||
    (reference.kind !== 'snapshot' && reference.kind !== 'artifact') ||
    typeof reference.id !== 'string' ||
    !reference.id
  ) {
    return undefined
  }
  return { kind: reference.kind, id: reference.id }
}

function createMessageDelta(
  parent: unknown[],
  next: unknown[],
  parentReference: MessageReference[typeof MESSAGE_REFERENCE_KEY],
): MessageArtifactDelta | undefined {
  const parentIds = parent.map(messageId)
  const nextIds = next.map(messageId)
  if (parentIds.some((id) => id === undefined) || nextIds.some((id) => id === undefined)) return undefined
  const nextIdSet = new Set(nextIds as string[])
  const removedIds = (parentIds as string[]).filter((id) => !nextIdSet.has(id))
  const parentById = new Map((parentIds as string[]).map((id, index) => [id, parent[index]]))
  const upserts = next.filter((message, index) => {
    const id = nextIds[index] as string
    const previous = parentById.get(id)
    return previous === undefined || JSON.stringify(previous) !== JSON.stringify(message)
  })
  const materialized = applyMessageDelta(parent, removedIds, upserts)
  if (JSON.stringify(materialized) !== JSON.stringify(next)) return undefined
  return { schemaVersion: 1, kind: 'delta', parent: parentReference, removedIds, upserts }
}

function applyMessageDelta(parent: unknown[], removedIds: string[], upserts: unknown[]): unknown[] {
  const removed = new Set(removedIds)
  const replacements = new Map(upserts.map((item) => [messageId(item), item]))
  const output = parent
    .filter((item) => {
      const id = messageId(item)
      return id !== undefined && !removed.has(id)
    })
    .map((item) => replacements.get(messageId(item)) ?? item)
  const existing = new Set(output.map(messageId))
  for (const item of upserts) {
    const id = messageId(item)
    if (id !== undefined && !existing.has(id)) {
      output.push(item)
      existing.add(id)
    }
  }
  return output
}

function messageId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' && value.id ? value.id : undefined
}

function isMessageArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((item) => messageId(item) !== undefined)
}

function metadataMatches(metadata: CheckpointMetadata | undefined, filter: Record<string, unknown>): boolean {
  if (!metadata) return false
  const record = metadata as Record<string, unknown>
  return Object.entries(filter).every(([key, value]) => record[key] === value)
}

function validateCheckpoint(value: unknown): asserts value is Checkpoint {
  if (
    !isRecord(value) ||
    value.v !== 4 ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 256 ||
    typeof value.ts !== 'string' ||
    !Number.isFinite(Date.parse(value.ts)) ||
    !isRecord(value.channel_values) ||
    !isRecord(value.channel_versions) ||
    !isRecord(value.versions_seen)
  ) {
    throw new Error('Invalid LangGraph checkpoint.')
  }
  validateChannelVersions(value.channel_versions as ChannelVersions)
  for (const seen of Object.values(value.versions_seen)) {
    if (!isRecord(seen)) throw new Error('Invalid LangGraph checkpoint versions_seen value.')
    validateChannelVersions(seen as ChannelVersions)
  }
}

function validateMetadata(value: unknown): asserts value is CheckpointMetadata {
  if (
    !isRecord(value) ||
    !['input', 'loop', 'update', 'fork'].includes(String(value.source)) ||
    !Number.isInteger(value.step) ||
    !isRecord(value.parents)
  ) {
    throw new Error('Invalid LangGraph checkpoint metadata.')
  }
}

function validateChannelVersions(value: ChannelVersions): void {
  if (!isRecord(value)) throw new Error('Invalid LangGraph channel versions.')
  for (const [channel, version] of Object.entries(value)) {
    assertIdentifier('channel', channel, 512)
    if (typeof version !== 'number' && typeof version !== 'string') {
      throw new Error('Invalid LangGraph channel version.')
    }
    if (typeof version === 'number' && !Number.isFinite(version)) {
      throw new Error('Invalid LangGraph numeric channel version.')
    }
    if (typeof version === 'string' && (!version || version.length > 256)) {
      throw new Error('Invalid LangGraph string channel version.')
    }
  }
}

function requiredConfigString(config: RunnableConfig, field: string, maximum: number): string {
  const value = optionalConfigString(config, field, maximum)
  if (value === undefined) throw new Error(`Checkpoint config is missing ${field}.`)
  return value
}

function optionalConfigString(
  config: RunnableConfig,
  field: string,
  maximum: number,
  allowEmpty = false,
): string | undefined {
  const configurable = config.configurable as Record<string, unknown> | undefined
  const value = configurable?.[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Checkpoint config ${field} must be a string.`)
  assertIdentifier(field, value, maximum, allowEmpty)
  return value
}

function assertIdentifier(field: string, value: string, maximum: number, allowEmpty = false): void {
  if ((!allowEmpty && !value) || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid checkpoint ${field}.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
