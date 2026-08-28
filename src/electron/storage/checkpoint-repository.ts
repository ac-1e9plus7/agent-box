import { Buffer } from 'node:buffer'
import { EncryptedRecordNamespaceError, type EncryptedRecordNamespace } from './encrypted-record-namespace'

const MANIFEST_RECORD = 'manifest'
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024

export interface CheckpointRepositoryLimits {
  maxThreads: number
  maxNamespacesPerThread: number
  maxCheckpointsPerThread: number
  maxPendingWritesPerCheckpoint: number
  maxCheckpointBytes: number
  maxMetadataBytes: number
  maxPendingWriteBytes: number
  maxPendingWritesBytesPerCheckpoint: number
  maxSnapshotBytes: number
  maxArtifactBytes: number
  maxThreadBytes: number
  maxTotalBytes: number
}

export const DEFAULT_CHECKPOINT_REPOSITORY_LIMITS: CheckpointRepositoryLimits = {
  maxThreads: 256,
  maxNamespacesPerThread: 8,
  maxCheckpointsPerThread: 512,
  maxPendingWritesPerCheckpoint: 1_024,
  maxCheckpointBytes: 2 * 1024 * 1024,
  maxMetadataBytes: 256 * 1024,
  maxPendingWriteBytes: 1024 * 1024,
  maxPendingWritesBytesPerCheckpoint: 8 * 1024 * 1024,
  maxSnapshotBytes: 24 * 1024 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxThreadBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
}

export type CheckpointThreadLifecycle = 'active' | 'interrupted' | 'completed' | 'abandoned'

export interface CheckpointThreadDescriptor {
  conversationId?: string
  responseMessageId?: string
  runtimeVersion?: string
  contextDigest?: string
  lifecycle: CheckpointThreadLifecycle
  hasTraceFallback: boolean
}

export interface SerializedCheckpointPayload {
  type: string
  data: Uint8Array
}

export interface StoredCheckpointRecord {
  threadId: string
  namespace: string
  checkpointId: string
  parentCheckpointId?: string
  timestamp: string
  checkpoint: SerializedCheckpointPayload
  metadata: SerializedCheckpointPayload
}

export interface IndexedPendingWrite {
  taskId: string
  index: number
  channel: string
  value: SerializedCheckpointPayload
}

export interface StoredPendingWritesRecord {
  threadId: string
  namespace: string
  checkpointId: string
  writes: IndexedPendingWrite[]
}

export interface CheckpointListQuery {
  threadId?: string
  namespace?: string
  checkpointId?: string
  beforeCheckpointId?: string
}

export class CheckpointRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'not_found' | 'quota' | 'corrupt' | 'io',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = code === 'quota' ? 'CheckpointQuotaError' : 'CheckpointRepositoryError'
  }
}

interface ManifestCheckpoint {
  namespace: string
  checkpointId: string
  committed: boolean
  parentCheckpointId?: string
  timestamp: string
  checkpointBytes: number
  metadataBytes: number
  recordBytes: number
  pendingWriteCount: number
  pendingWriteBytes: number
  pendingRecordBytes: number
}

interface ManifestArtifact {
  id: string
  bytes: number
}

interface ThreadManifestV1 {
  schemaVersion: 1
  threadId: string
  descriptor: CheckpointThreadDescriptor
  checkpoints: ManifestCheckpoint[]
  snapshotBytes: number
  artifacts: ManifestArtifact[]
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
  totalBytes: number
}

interface SerializedPayloadJson {
  type: string
  data: string
}

interface CheckpointRecordFileV1 {
  schemaVersion: 1
  checkpoint: SerializedPayloadJson
  metadata: SerializedPayloadJson
}

interface PendingWritesFileV1 {
  schemaVersion: 1
  writes: Array<{
    taskId: string
    index: number
    channel: string
    value: SerializedPayloadJson
  }>
}

/** Encrypted, quota-bound raw repository used by the LangGraph saver adapter. */
export class EncryptedCheckpointRepository {
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly records: EncryptedRecordNamespace,
    private readonly limits: CheckpointRepositoryLimits = DEFAULT_CHECKPOINT_REPOSITORY_LIMITS,
  ) {}

  async initialize(): Promise<void> {
    await this.records.initialize()
    await this.records.cleanupTemporaryFiles()
    const scopeHandles = await this.records.listScopeHandles()
    for (const scopeHandle of scopeHandles) {
      try {
        const raw = await this.records.readRecordFromScopeHandle(scopeHandle, MANIFEST_RECORD)
        if (!raw) {
          await this.records.quarantineScopeHandle(scopeHandle)
          continue
        }
        const manifest = this.parseManifest(raw)
        if (manifest.descriptor.lifecycle === 'active') {
          manifest.descriptor.lifecycle = manifest.descriptor.hasTraceFallback ? 'interrupted' : 'abandoned'
          manifest.updatedAt = new Date().toISOString()
          await this.saveManifest(manifest)
        }
        const expected = new Set<string>([this.records.recordFileHandle(MANIFEST_RECORD)])
        for (const checkpoint of manifest.checkpoints) {
          if (checkpoint.committed) {
            expected.add(
              this.records.recordFileHandle(this.checkpointRecordKey(checkpoint.namespace, checkpoint.checkpointId)),
            )
          }
          if (checkpoint.pendingWriteCount > 0) {
            expected.add(
              this.records.recordFileHandle(this.writesRecordKey(checkpoint.namespace, checkpoint.checkpointId)),
            )
          }
        }
        if (manifest.snapshotBytes > 0) expected.add(this.records.recordFileHandle('snapshot'))
        for (const artifact of manifest.artifacts) {
          expected.add(this.records.recordFileHandle(`artifact:${artifact.id}`))
        }
        const actual = await this.records.listRecordHandles(scopeHandle)
        await Promise.all(
          actual
            .filter((recordHandle) => !expected.has(recordHandle))
            .map((recordHandle) => this.records.deleteRecordHandle(scopeHandle, recordHandle)),
        )
      } catch {
        await this.records.quarantineScopeHandle(scopeHandle).catch(() => undefined)
      }
    }
  }

  async getCheckpoint(
    threadId: string,
    namespace: string,
    checkpointId?: string,
  ): Promise<StoredCheckpointRecord | undefined> {
    try {
      await this.operationQueue
      this.assertIdentifier('thread_id', threadId, 256)
      this.assertIdentifier('checkpoint_ns', namespace, 512, true)
      if (checkpointId !== undefined) this.assertIdentifier('checkpoint_id', checkpointId, 256)
      const manifest = await this.loadManifest(threadId)
      if (!manifest) return undefined
      const candidates = manifest.checkpoints
        .filter(
          (item) =>
            item.committed && item.namespace === namespace && (!checkpointId || item.checkpointId === checkpointId),
        )
        .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))
      const target = candidates[0]
      if (!target) return undefined
      return await this.loadCheckpointRecord(manifest.threadId, target)
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  async listCheckpoints(query: CheckpointListQuery = {}): Promise<StoredCheckpointRecord[]> {
    try {
      await this.operationQueue
      if (query.threadId !== undefined) this.assertIdentifier('thread_id', query.threadId, 256)
      if (query.namespace !== undefined) this.assertIdentifier('checkpoint_ns', query.namespace, 512, true)
      if (query.checkpointId !== undefined) this.assertIdentifier('checkpoint_id', query.checkpointId, 256)
      if (query.beforeCheckpointId !== undefined) {
        this.assertIdentifier('checkpoint_id', query.beforeCheckpointId, 256)
      }
      const manifests = query.threadId
        ? [await this.loadManifest(query.threadId)].filter((item): item is ThreadManifestV1 => Boolean(item))
        : await this.loadAllManifests()
      const output: StoredCheckpointRecord[] = []
      for (const manifest of manifests) {
        const candidates = manifest.checkpoints
          .filter(
            (item) =>
              item.committed &&
              (query.namespace === undefined || item.namespace === query.namespace) &&
              (query.checkpointId === undefined || item.checkpointId === query.checkpointId) &&
              (query.beforeCheckpointId === undefined || item.checkpointId < query.beforeCheckpointId),
          )
          .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))
        for (const item of candidates) output.push(await this.loadCheckpointRecord(manifest.threadId, item))
      }
      return output.sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  putCheckpoint(record: StoredCheckpointRecord): Promise<void> {
    this.validateCheckpointRecord(record)
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const manifest = (await this.loadManifest(record.threadId)) ?? this.createManifest(record.threadId, now)
      const checkpointFile = this.serializeCheckpointFile(record)
      this.assertByteLimit(
        'Serialized checkpoint payload exceeds its limit.',
        record.checkpoint.data,
        this.limits.maxCheckpointBytes,
      )
      this.assertByteLimit(
        'Serialized checkpoint metadata exceeds its limit.',
        record.metadata.data,
        this.limits.maxMetadataBytes,
      )

      const old = manifest.checkpoints.find(
        (item) => item.namespace === record.namespace && item.checkpointId === record.checkpointId,
      )
      const namespaces = new Set(manifest.checkpoints.map((item) => item.namespace))
      namespaces.add(record.namespace)
      if (namespaces.size > this.limits.maxNamespacesPerThread) {
        throw new CheckpointRepositoryError('Checkpoint namespace limit exceeded.', 'quota')
      }
      if (!old && manifest.checkpoints.length >= this.limits.maxCheckpointsPerThread) {
        throw new CheckpointRepositoryError('Checkpoint count limit exceeded.', 'quota')
      }

      const nextEntry: ManifestCheckpoint = {
        namespace: record.namespace,
        checkpointId: record.checkpointId,
        committed: true,
        parentCheckpointId: record.parentCheckpointId,
        timestamp: record.timestamp,
        checkpointBytes: record.checkpoint.data.byteLength,
        metadataBytes: record.metadata.data.byteLength,
        recordBytes: checkpointFile.byteLength,
        pendingWriteCount: old?.pendingWriteCount ?? 0,
        pendingWriteBytes: old?.pendingWriteBytes ?? 0,
        pendingRecordBytes: old?.pendingRecordBytes ?? 0,
      }
      manifest.checkpoints = old
        ? manifest.checkpoints.map((item) => (item === old ? nextEntry : item))
        : [...manifest.checkpoints, nextEntry]
      manifest.updatedAt = now
      manifest.lastAccessedAt = now
      this.recalculateManifestUsage(manifest)
      await this.ensureQuota(manifest)

      await this.records.writeRecord(
        record.threadId,
        this.checkpointRecordKey(record.namespace, record.checkpointId),
        checkpointFile,
      )
      await this.saveManifest(manifest)
    })
  }

  putPendingWrites(
    threadId: string,
    namespace: string,
    checkpointId: string,
    writes: IndexedPendingWrite[],
  ): Promise<void> {
    this.assertIdentifier('thread_id', threadId, 256)
    this.assertIdentifier('checkpoint_ns', namespace, 512, true)
    this.assertIdentifier('checkpoint_id', checkpointId, 256)
    for (const write of writes) this.validatePendingWrite(write)
    return this.enqueue(async () => {
      const manifest = await this.loadManifest(threadId)
      if (!manifest) throw new CheckpointRepositoryError('Checkpoint thread was not found.', 'not_found')
      let checkpoint = manifest.checkpoints.find(
        (item) => item.namespace === namespace && item.checkpointId === checkpointId,
      )
      if (!checkpoint) {
        const namespaces = new Set(manifest.checkpoints.map((item) => item.namespace))
        namespaces.add(namespace)
        if (namespaces.size > this.limits.maxNamespacesPerThread) {
          throw new CheckpointRepositoryError('Checkpoint namespace limit exceeded.', 'quota')
        }
        if (manifest.checkpoints.length >= this.limits.maxCheckpointsPerThread) {
          throw new CheckpointRepositoryError('Checkpoint count limit exceeded.', 'quota')
        }
        checkpoint = {
          namespace,
          checkpointId,
          committed: false,
          timestamp: new Date().toISOString(),
          checkpointBytes: 0,
          metadataBytes: 0,
          recordBytes: 0,
          pendingWriteCount: 0,
          pendingWriteBytes: 0,
          pendingRecordBytes: 0,
        }
        manifest.checkpoints.push(checkpoint)
      }
      const existing = await this.loadPendingWritesFile(threadId, namespace, checkpointId)
      const byKey = new Map(existing.writes.map((item) => [this.writeKey(item.taskId, item.index), item]))
      for (const write of writes) {
        const key = this.writeKey(write.taskId, write.index)
        if (write.index >= 0 && byKey.has(key)) continue
        byKey.set(key, {
          taskId: write.taskId,
          index: write.index,
          channel: write.channel,
          value: this.payloadToJson(write.value),
        })
      }
      const next: PendingWritesFileV1 = {
        schemaVersion: 1,
        writes: [...byKey.values()].sort(
          (left, right) => left.taskId.localeCompare(right.taskId) || left.index - right.index,
        ),
      }
      if (next.writes.length > this.limits.maxPendingWritesPerCheckpoint) {
        throw new CheckpointRepositoryError('Pending-write count limit exceeded.', 'quota')
      }
      const totalWriteBytes = next.writes.reduce((sum, item) => sum + Buffer.byteLength(item.value.data, 'base64'), 0)
      if (totalWriteBytes > this.limits.maxPendingWritesBytesPerCheckpoint) {
        throw new CheckpointRepositoryError('Pending-write byte limit exceeded.', 'quota')
      }
      const serialized = Buffer.from(JSON.stringify(next), 'utf8')
      checkpoint.pendingWriteCount = next.writes.length
      checkpoint.pendingWriteBytes = totalWriteBytes
      checkpoint.pendingRecordBytes = serialized.byteLength
      manifest.updatedAt = new Date().toISOString()
      manifest.lastAccessedAt = manifest.updatedAt
      this.recalculateManifestUsage(manifest)
      await this.ensureQuota(manifest)
      await this.records.writeRecord(threadId, this.writesRecordKey(namespace, checkpointId), serialized)
      await this.saveManifest(manifest)
    })
  }

  async getPendingWrites(
    threadId: string,
    namespace: string,
    checkpointId: string,
  ): Promise<StoredPendingWritesRecord> {
    try {
      await this.operationQueue
      const stored = await this.loadPendingWritesFile(threadId, namespace, checkpointId)
      return {
        threadId,
        namespace,
        checkpointId,
        writes: stored.writes.map((item) => ({
          taskId: item.taskId,
          index: item.index,
          channel: item.channel,
          value: this.payloadFromJson(item.value),
        })),
      }
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  putSnapshot(threadId: string, data: Uint8Array): Promise<void> {
    this.assertIdentifier('thread_id', threadId, 256)
    this.assertByteLimit('Run snapshot exceeds its limit.', data, this.limits.maxSnapshotBytes)
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const manifest = (await this.loadManifest(threadId)) ?? this.createManifest(threadId, now)
      manifest.snapshotBytes = data.byteLength
      manifest.updatedAt = now
      manifest.lastAccessedAt = now
      this.recalculateManifestUsage(manifest)
      await this.ensureQuota(manifest)
      await this.records.writeRecord(threadId, 'snapshot', data)
      await this.saveManifest(manifest)
    })
  }

  async readSnapshot(threadId: string): Promise<Buffer | undefined> {
    try {
      return await this.records.readRecord(threadId, 'snapshot')
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  putArtifact(threadId: string, artifactId: string, data: Uint8Array): Promise<void> {
    this.assertIdentifier('thread_id', threadId, 256)
    this.assertIdentifier('artifact_id', artifactId, 256)
    this.assertByteLimit('Run artifact exceeds its limit.', data, this.limits.maxArtifactBytes)
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const manifest = (await this.loadManifest(threadId)) ?? this.createManifest(threadId, now)
      const existing = manifest.artifacts.find((item) => item.id === artifactId)
      manifest.artifacts = existing
        ? manifest.artifacts.map((item) => (item === existing ? { id: artifactId, bytes: data.byteLength } : item))
        : [...manifest.artifacts, { id: artifactId, bytes: data.byteLength }]
      manifest.updatedAt = now
      manifest.lastAccessedAt = now
      this.recalculateManifestUsage(manifest)
      await this.ensureQuota(manifest)
      await this.records.writeRecord(threadId, `artifact:${artifactId}`, data)
      await this.saveManifest(manifest)
    })
  }

  async readArtifact(threadId: string, artifactId: string): Promise<Buffer | undefined> {
    this.assertIdentifier('thread_id', threadId, 256)
    this.assertIdentifier('artifact_id', artifactId, 256)
    try {
      return await this.records.readRecord(threadId, `artifact:${artifactId}`)
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  setThreadDescriptor(threadId: string, patch: Partial<CheckpointThreadDescriptor>): Promise<void> {
    this.assertIdentifier('thread_id', threadId, 256)
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const manifest = (await this.loadManifest(threadId)) ?? this.createManifest(threadId, now)
      manifest.descriptor = this.validateDescriptor({ ...manifest.descriptor, ...patch })
      manifest.updatedAt = now
      manifest.lastAccessedAt = now
      this.recalculateManifestUsage(manifest)
      await this.ensureQuota(manifest)
      await this.saveManifest(manifest)
    })
  }

  async getThreadDescriptor(threadId: string): Promise<CheckpointThreadDescriptor | undefined> {
    try {
      await this.operationQueue
      const manifest = await this.loadManifest(threadId)
      return manifest ? structuredClone(manifest.descriptor) : undefined
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  deleteThread(threadId: string): Promise<void> {
    this.assertIdentifier('thread_id', threadId, 256)
    return this.enqueue(() => this.records.deleteScope(threadId))
  }

  deleteThreadsForConversation(conversationId: string): Promise<void> {
    this.assertIdentifier('conversation_id', conversationId, 256)
    return this.enqueue(async () => {
      const manifests = await this.loadAllManifests()
      await Promise.all(
        manifests
          .filter((manifest) => manifest.descriptor.conversationId === conversationId)
          .map((manifest) => this.records.deleteScope(manifest.threadId)),
      )
    })
  }

  clear(): Promise<void> {
    return this.enqueue(() => this.records.clear())
  }

  private async ensureQuota(candidate: ThreadManifestV1): Promise<void> {
    if (candidate.totalBytes > this.limits.maxThreadBytes) {
      throw new CheckpointRepositoryError('Checkpoint thread byte limit exceeded.', 'quota')
    }
    let manifests = await this.loadAllManifests()
    const exists = manifests.some((item) => item.threadId === candidate.threadId)
    if (!exists && manifests.length >= this.limits.maxThreads) {
      manifests = await this.evictInactiveThreads(manifests, candidate.threadId, 0, true)
    }
    const currentTotal = manifests.reduce(
      (sum, item) => sum + (item.threadId === candidate.threadId ? 0 : item.totalBytes),
      0,
    )
    const overflow = currentTotal + candidate.totalBytes - this.limits.maxTotalBytes
    if (overflow > 0) {
      manifests = await this.evictInactiveThreads(manifests, candidate.threadId, overflow, false)
    }
    const projected =
      manifests.reduce((sum, item) => sum + (item.threadId === candidate.threadId ? 0 : item.totalBytes), 0) +
      candidate.totalBytes
    if (projected > this.limits.maxTotalBytes) {
      throw new CheckpointRepositoryError('Global checkpoint byte limit exceeded.', 'quota')
    }
    const projectedThreads = manifests.filter((item) => item.threadId !== candidate.threadId).length + 1
    if (projectedThreads > this.limits.maxThreads) {
      throw new CheckpointRepositoryError('Checkpoint thread limit exceeded.', 'quota')
    }
  }

  private async evictInactiveThreads(
    manifests: ThreadManifestV1[],
    protectedThreadId: string,
    requiredBytes: number,
    requireThreadSlot: boolean,
  ): Promise<ThreadManifestV1[]> {
    const rank: Record<CheckpointThreadLifecycle, number> = {
      abandoned: 0,
      completed: 1,
      interrupted: 2,
      active: 3,
    }
    const candidates = manifests
      .filter(
        (manifest) =>
          manifest.threadId !== protectedThreadId &&
          manifest.descriptor.lifecycle !== 'active' &&
          (manifest.descriptor.lifecycle !== 'interrupted' || manifest.descriptor.hasTraceFallback),
      )
      .sort(
        (left, right) =>
          rank[left.descriptor.lifecycle] - rank[right.descriptor.lifecycle] ||
          left.lastAccessedAt.localeCompare(right.lastAccessedAt),
      )
    let freedBytes = 0
    let freedThreads = 0
    const deleted = new Set<string>()
    for (const candidate of candidates) {
      if ((!requireThreadSlot || freedThreads >= 1) && freedBytes >= requiredBytes) break
      await this.records.deleteScope(candidate.threadId)
      deleted.add(candidate.threadId)
      freedBytes += candidate.totalBytes
      freedThreads += 1
    }
    return manifests.filter((manifest) => !deleted.has(manifest.threadId))
  }

  private async loadCheckpointRecord(threadId: string, entry: ManifestCheckpoint): Promise<StoredCheckpointRecord> {
    const raw = await this.records.readRecord(threadId, this.checkpointRecordKey(entry.namespace, entry.checkpointId))
    if (!raw) throw new CheckpointRepositoryError('Checkpoint payload is missing.', 'corrupt')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      throw new CheckpointRepositoryError('Checkpoint payload is invalid.', 'corrupt', { cause: error })
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.checkpoint) || !isRecord(parsed.metadata)) {
      throw new CheckpointRepositoryError('Checkpoint payload has an invalid shape.', 'corrupt')
    }
    return {
      threadId,
      namespace: entry.namespace,
      checkpointId: entry.checkpointId,
      parentCheckpointId: entry.parentCheckpointId,
      timestamp: entry.timestamp,
      checkpoint: this.payloadFromJson(parsed.checkpoint as unknown as SerializedPayloadJson),
      metadata: this.payloadFromJson(parsed.metadata as unknown as SerializedPayloadJson),
    }
  }

  private async loadPendingWritesFile(
    threadId: string,
    namespace: string,
    checkpointId: string,
  ): Promise<PendingWritesFileV1> {
    const raw = await this.records.readRecord(threadId, this.writesRecordKey(namespace, checkpointId))
    if (!raw) return { schemaVersion: 1, writes: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      throw new CheckpointRepositoryError('Pending-write payload is invalid.', 'corrupt', { cause: error })
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.writes)) {
      throw new CheckpointRepositoryError('Pending-write payload has an invalid shape.', 'corrupt')
    }
    if (raw.byteLength > this.limits.maxPendingWritesBytesPerCheckpoint * 2) {
      throw new CheckpointRepositoryError('Pending-write payload exceeds its limit.', 'corrupt')
    }
    const writes = parsed.writes.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.taskId !== 'string' ||
        !Number.isInteger(value.index) ||
        typeof value.channel !== 'string' ||
        !isRecord(value.value)
      ) {
        throw new CheckpointRepositoryError('Pending-write entry has an invalid shape.', 'corrupt')
      }
      this.assertIdentifier('task_id', value.taskId, 256)
      this.assertIdentifier('channel', value.channel, 256)
      const payload = value.value as unknown as SerializedPayloadJson
      this.payloadFromJson(payload)
      return { taskId: value.taskId, index: Number(value.index), channel: value.channel, value: payload }
    })
    return { schemaVersion: 1, writes }
  }

  private serializeCheckpointFile(record: StoredCheckpointRecord): Buffer {
    const value: CheckpointRecordFileV1 = {
      schemaVersion: 1,
      checkpoint: this.payloadToJson(record.checkpoint),
      metadata: this.payloadToJson(record.metadata),
    }
    return Buffer.from(JSON.stringify(value), 'utf8')
  }

  private payloadToJson(payload: SerializedCheckpointPayload): SerializedPayloadJson {
    this.assertIdentifier('serializer_type', payload.type, 128)
    return { type: payload.type, data: Buffer.from(payload.data).toString('base64') }
  }

  private payloadFromJson(value: SerializedPayloadJson): SerializedCheckpointPayload {
    if (!isRecord(value) || typeof value.type !== 'string' || typeof value.data !== 'string') {
      throw new CheckpointRepositoryError('Serialized checkpoint value is invalid.', 'corrupt')
    }
    this.assertIdentifier('serializer_type', value.type, 128)
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
      throw new CheckpointRepositoryError('Serialized checkpoint value is not valid Base64.', 'corrupt')
    }
    return { type: value.type, data: Buffer.from(value.data, 'base64') }
  }

  private async loadAllManifests(): Promise<ThreadManifestV1[]> {
    const handles = await this.records.listScopeHandles()
    const manifests: ThreadManifestV1[] = []
    for (const handle of handles) {
      const raw = await this.records.readRecordFromScopeHandle(handle, MANIFEST_RECORD)
      if (!raw) continue
      manifests.push(this.parseManifest(raw))
    }
    return manifests
  }

  private async loadManifest(threadId: string): Promise<ThreadManifestV1 | undefined> {
    const raw = await this.records.readRecord(threadId, MANIFEST_RECORD)
    return raw ? this.parseManifest(raw) : undefined
  }

  private parseManifest(raw: Buffer): ThreadManifestV1 {
    if (raw.byteLength > MANIFEST_MAX_BYTES) {
      throw new CheckpointRepositoryError('Checkpoint manifest exceeds its limit.', 'corrupt')
    }
    let value: unknown
    try {
      value = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      throw new CheckpointRepositoryError('Checkpoint manifest is invalid.', 'corrupt', { cause: error })
    }
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.threadId !== 'string' ||
      !isRecord(value.descriptor) ||
      !Array.isArray(value.checkpoints) ||
      !Array.isArray(value.artifacts) ||
      !Number.isInteger(value.snapshotBytes) ||
      typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string' ||
      typeof value.lastAccessedAt !== 'string' ||
      !Number.isInteger(value.totalBytes)
    ) {
      throw new CheckpointRepositoryError('Checkpoint manifest has an invalid shape.', 'corrupt')
    }
    if (
      Number(value.snapshotBytes) < 0 ||
      Number(value.snapshotBytes) > this.limits.maxSnapshotBytes ||
      Number(value.totalBytes) < 0 ||
      value.checkpoints.length > this.limits.maxCheckpointsPerThread ||
      value.artifacts.length > this.limits.maxCheckpointsPerThread * 2
    ) {
      throw new CheckpointRepositoryError('Checkpoint manifest exceeds its limits.', 'corrupt')
    }
    this.assertIdentifier('thread_id', value.threadId, 256)
    const checkpoints = value.checkpoints.map((item) => this.parseManifestCheckpoint(item))
    if (new Set(checkpoints.map((item) => item.namespace)).size > this.limits.maxNamespacesPerThread) {
      throw new CheckpointRepositoryError('Checkpoint manifest namespace count is invalid.', 'corrupt')
    }
    const artifacts = value.artifacts.map((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || !Number.isInteger(item.bytes) || Number(item.bytes) < 0) {
        throw new CheckpointRepositoryError('Checkpoint artifact manifest is invalid.', 'corrupt')
      }
      this.assertIdentifier('artifact_id', item.id, 256)
      return { id: item.id, bytes: Number(item.bytes) }
    })
    return {
      schemaVersion: 1,
      threadId: value.threadId,
      descriptor: this.validateDescriptor(value.descriptor),
      checkpoints,
      snapshotBytes: Number(value.snapshotBytes),
      artifacts,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      lastAccessedAt: value.lastAccessedAt,
      totalBytes: Number(value.totalBytes),
    }
  }

  private parseManifestCheckpoint(value: unknown): ManifestCheckpoint {
    if (
      !isRecord(value) ||
      typeof value.namespace !== 'string' ||
      typeof value.checkpointId !== 'string' ||
      typeof value.committed !== 'boolean' ||
      typeof value.timestamp !== 'string' ||
      !Number.isInteger(value.checkpointBytes) ||
      !Number.isInteger(value.metadataBytes) ||
      !Number.isInteger(value.recordBytes) ||
      !Number.isInteger(value.pendingWriteCount) ||
      !Number.isInteger(value.pendingWriteBytes) ||
      !Number.isInteger(value.pendingRecordBytes)
    ) {
      throw new CheckpointRepositoryError('Checkpoint manifest entry is invalid.', 'corrupt')
    }
    this.assertIdentifier('checkpoint_ns', value.namespace, 512, true)
    this.assertIdentifier('checkpoint_id', value.checkpointId, 256)
    if (
      Number(value.checkpointBytes) < 0 ||
      Number(value.checkpointBytes) > this.limits.maxCheckpointBytes ||
      Number(value.metadataBytes) < 0 ||
      Number(value.metadataBytes) > this.limits.maxMetadataBytes ||
      Number(value.recordBytes) < 0 ||
      Number(value.pendingWriteCount) < 0 ||
      Number(value.pendingWriteCount) > this.limits.maxPendingWritesPerCheckpoint ||
      Number(value.pendingWriteBytes) < 0 ||
      Number(value.pendingWriteBytes) > this.limits.maxPendingWritesBytesPerCheckpoint ||
      Number(value.pendingRecordBytes) < 0
    ) {
      throw new CheckpointRepositoryError('Checkpoint manifest entry exceeds its limits.', 'corrupt')
    }
    if (value.parentCheckpointId !== undefined) {
      this.assertIdentifier('checkpoint_id', String(value.parentCheckpointId), 256)
    }
    return {
      namespace: value.namespace,
      checkpointId: value.checkpointId,
      committed: value.committed,
      parentCheckpointId: typeof value.parentCheckpointId === 'string' ? value.parentCheckpointId : undefined,
      timestamp: value.timestamp,
      checkpointBytes: Number(value.checkpointBytes),
      metadataBytes: Number(value.metadataBytes),
      recordBytes: Number(value.recordBytes),
      pendingWriteCount: Number(value.pendingWriteCount),
      pendingWriteBytes: Number(value.pendingWriteBytes),
      pendingRecordBytes: Number(value.pendingRecordBytes),
    }
  }

  private validateDescriptor(value: unknown): CheckpointThreadDescriptor {
    if (!isRecord(value) || !['active', 'interrupted', 'completed', 'abandoned'].includes(String(value.lifecycle))) {
      throw new CheckpointRepositoryError('Checkpoint thread descriptor is invalid.', 'invalid')
    }
    for (const [field, maximum] of [
      ['conversationId', 256],
      ['responseMessageId', 256],
      ['runtimeVersion', 128],
      ['contextDigest', 128],
    ] as const) {
      const item = value[field]
      if (item !== undefined) this.assertIdentifier(field, String(item), maximum)
    }
    if (typeof value.hasTraceFallback !== 'boolean') {
      throw new CheckpointRepositoryError('Checkpoint trace-fallback flag is invalid.', 'invalid')
    }
    return {
      conversationId: typeof value.conversationId === 'string' ? value.conversationId : undefined,
      responseMessageId: typeof value.responseMessageId === 'string' ? value.responseMessageId : undefined,
      runtimeVersion: typeof value.runtimeVersion === 'string' ? value.runtimeVersion : undefined,
      contextDigest: typeof value.contextDigest === 'string' ? value.contextDigest : undefined,
      lifecycle: value.lifecycle as CheckpointThreadLifecycle,
      hasTraceFallback: value.hasTraceFallback,
    }
  }

  private validateCheckpointRecord(record: StoredCheckpointRecord): void {
    this.assertIdentifier('thread_id', record.threadId, 256)
    this.assertIdentifier('checkpoint_ns', record.namespace, 512, true)
    this.assertIdentifier('checkpoint_id', record.checkpointId, 256)
    if (record.parentCheckpointId !== undefined) {
      this.assertIdentifier('checkpoint_id', record.parentCheckpointId, 256)
    }
    if (!Number.isFinite(Date.parse(record.timestamp))) {
      throw new CheckpointRepositoryError('Checkpoint timestamp is invalid.', 'invalid')
    }
    this.assertIdentifier('serializer_type', record.checkpoint.type, 128)
    this.assertIdentifier('serializer_type', record.metadata.type, 128)
  }

  private validatePendingWrite(write: IndexedPendingWrite): void {
    this.assertIdentifier('task_id', write.taskId, 256)
    this.assertIdentifier('channel', write.channel, 256)
    this.assertIdentifier('serializer_type', write.value.type, 128)
    if (!Number.isInteger(write.index))
      throw new CheckpointRepositoryError('Pending-write index is invalid.', 'invalid')
    this.assertByteLimit('Pending-write value exceeds its limit.', write.value.data, this.limits.maxPendingWriteBytes)
  }

  private createManifest(threadId: string, timestamp: string): ThreadManifestV1 {
    return {
      schemaVersion: 1,
      threadId,
      descriptor: { lifecycle: 'active', hasTraceFallback: false },
      checkpoints: [],
      snapshotBytes: 0,
      artifacts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      totalBytes: 0,
    }
  }

  private async saveManifest(manifest: ThreadManifestV1): Promise<void> {
    this.recalculateManifestUsage(manifest)
    const raw = Buffer.from(JSON.stringify(manifest), 'utf8')
    if (raw.byteLength > MANIFEST_MAX_BYTES) {
      throw new CheckpointRepositoryError('Checkpoint manifest exceeds its limit.', 'quota')
    }
    await this.records.writeRecord(manifest.threadId, MANIFEST_RECORD, raw)
  }

  private recalculateManifestUsage(manifest: ThreadManifestV1): void {
    const payloadBytes = manifest.checkpoints.reduce(
      (sum, item) =>
        sum +
        (item.recordBytes > 0 ? this.records.encryptedSize(item.recordBytes) : 0) +
        (item.pendingRecordBytes > 0 ? this.records.encryptedSize(item.pendingRecordBytes) : 0),
      (manifest.snapshotBytes > 0 ? this.records.encryptedSize(manifest.snapshotBytes) : 0) +
        manifest.artifacts.reduce((sum, item) => sum + this.records.encryptedSize(item.bytes), 0),
    )
    // Count the manifest itself approximately, then saveManifest performs the
    // exact hard cap before writing it.
    manifest.totalBytes =
      payloadBytes +
      this.records.encryptedSize(Buffer.byteLength(JSON.stringify({ ...manifest, totalBytes: 0 }), 'utf8'))
  }

  private checkpointRecordKey(namespace: string, checkpointId: string): string {
    return `checkpoint:${namespace}:${checkpointId}`
  }

  private writesRecordKey(namespace: string, checkpointId: string): string {
    return `writes:${namespace}:${checkpointId}`
  }

  private writeKey(taskId: string, index: number): string {
    return `${taskId}\0${index}`
  }

  private assertIdentifier(field: string, value: string, maximum: number, allowEmpty = false): void {
    if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > maximum || /[\0\r\n]/.test(value)) {
      throw new CheckpointRepositoryError(`Invalid checkpoint ${field}.`, 'invalid')
    }
  }

  private assertByteLimit(message: string, value: Uint8Array, maximum: number): void {
    if (value.byteLength > maximum) throw new CheckpointRepositoryError(message, 'quota')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let output!: T
    const queued = this.operationQueue.then(async () => {
      try {
        output = await operation()
      } catch (error) {
        throw this.normalizeError(error)
      }
    })
    this.operationQueue = queued.catch(() => undefined)
    return queued.then(() => output)
  }

  private normalizeError(error: unknown): CheckpointRepositoryError {
    if (error instanceof CheckpointRepositoryError) return error
    if (error instanceof EncryptedRecordNamespaceError) {
      const code =
        error.code === 'authentication_failed' || error.code === 'invalid_record'
          ? 'corrupt'
          : error.code === 'invalid_key'
            ? 'invalid'
            : 'io'
      return new CheckpointRepositoryError(error.message, code, { cause: error })
    }
    return new CheckpointRepositoryError('Encrypted checkpoint repository operation failed.', 'io', {
      cause: error,
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
