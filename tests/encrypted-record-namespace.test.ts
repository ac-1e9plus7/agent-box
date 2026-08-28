import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EncryptedRecordNamespace,
  EncryptedRecordNamespaceError,
} from '../src/electron/storage/encrypted-record-namespace'

const temporaryDirectories: string[] = []

async function createNamespace(): Promise<{ directory: string; namespace: EncryptedRecordNamespace }> {
  const directory = await mkdtemp(join(tmpdir(), 'agentbox-records-'))
  temporaryDirectories.push(directory)
  const namespace = new EncryptedRecordNamespace(
    join(directory, 'records'),
    'agent-checkpoints-v1',
    randomBytes(32),
    randomBytes(32),
  )
  await namespace.initialize()
  return { directory, namespace }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  )
})

describe('encrypted record namespace', () => {
  it('stores only authenticated ciphertext under HMAC-derived names', async () => {
    const { directory, namespace } = await createNamespace()
    await namespace.writeRecord('thread-secret-id', 'checkpoint-secret-id', Buffer.from('sensitive payload'))

    const scopeNames = await readdir(join(directory, 'records'))
    expect(scopeNames).toHaveLength(1)
    expect(scopeNames[0]).toMatch(/^scope-[0-9a-f]{64}$/)
    expect(scopeNames[0]).not.toContain('thread-secret-id')
    const files = await readdir(join(directory, 'records', scopeNames[0]!))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^record-[0-9a-f]{64}\.enc$/)
    const encrypted = await readFile(join(directory, 'records', scopeNames[0]!, files[0]!))
    expect(encrypted.includes(Buffer.from('sensitive payload'))).toBe(false)
    await expect(namespace.readRecord('thread-secret-id', 'checkpoint-secret-id')).resolves.toEqual(
      Buffer.from('sensitive payload'),
    )
  })

  it('detects ciphertext tampering', async () => {
    const { directory, namespace } = await createNamespace()
    await namespace.writeRecord('thread-a', 'record-a', Buffer.from('payload'))
    const scope = namespace.scopeHandle('thread-a')
    const files = await readdir(join(directory, 'records', scope))
    const path = join(directory, 'records', scope, files[0]!)
    const encrypted = await readFile(path)
    encrypted[encrypted.length - 1] = encrypted.at(-1)! ^ 0xff
    await writeFile(path, encrypted)

    await expect(namespace.readRecord('thread-a', 'record-a')).rejects.toMatchObject({
      code: 'authentication_failed',
    } satisfies Partial<EncryptedRecordNamespaceError>)
  })

  it('deletes scopes idempotently and rejects use after key destruction', async () => {
    const { namespace } = await createNamespace()
    await namespace.writeRecord('thread-a', 'record-a', Buffer.from('payload'))
    await namespace.deleteScope('thread-a')
    await namespace.deleteScope('thread-a')
    await expect(namespace.readRecord('thread-a', 'record-a')).resolves.toBeUndefined()
    namespace.destroy()
    expect(() => namespace.scopeHandle('thread-a')).toThrow('destroyed')
  })
})
