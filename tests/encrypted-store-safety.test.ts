import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockEncryptionAvailable = true
let mockStorageBackend: string | undefined = undefined

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mockEncryptionAvailable,
    getSelectedStorageBackend: () => mockStorageBackend,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { EncryptedStore, EncryptedStoreError } = await import('../src/electron/storage/encrypted-store')

interface TestState {
  count: number
  text: string
}

const defaultState = (): TestState => ({ count: 0, text: 'initial' })
const validateState = (value: unknown): TestState => {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TestState).count === 'number' &&
    typeof (value as TestState).text === 'string'
  ) {
    return value as TestState
  }
  throw new Error('Invalid state structure')
}

describe('EncryptedStore safety and encryption integrity', () => {
  let tempDir: string

  beforeEach(() => {
    mockEncryptionAvailable = true
    mockStorageBackend = undefined
    tempDir = mkdtempSync(join(tmpdir(), 'agentbox-store-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('refuses initialization when OS safeStorage is unavailable', async () => {
    mockEncryptionAvailable = false
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    await expect(store.initialize()).rejects.toThrow(EncryptedStoreError)
    await expect(store.initialize()).rejects.toThrow(
      '操作系统安全存储当前不可用；为避免明文保存，应用不会加载用户数据。',
    )
  })

  it('refuses initialization on Linux when backend is basic_text', async () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockStorageBackend = 'basic_text'
      const store = new EncryptedStore(tempDir, defaultState, validateState)
      await expect(store.initialize()).rejects.toThrow('已拒绝 Electron 的 basic_text 明文后端。')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('throws when read or mutate is called before initialize', async () => {
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    expect(() => store.read()).toThrow('EncryptedStore 尚未初始化。')
    await expect(store.mutate((draft) => draft.count++)).rejects.toThrow('EncryptedStore 尚未初始化。')
  })

  it('initializes default state and persists mutations with AES-256-GCM', async () => {
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    await store.initialize()
    expect(store.read()).toEqual({ count: 0, text: 'initial' })

    await store.mutate((draft) => {
      draft.count = 42
      draft.text = 'updated'
    })
    expect(store.read()).toEqual({ count: 42, text: 'updated' })

    // Read the vault file directly on disk and verify it is valid encrypted JSON envelope
    const vaultPath = join(tempDir, 'vault', 'user-data.v1.enc')
    const raw = JSON.parse(readFileSync(vaultPath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.algorithm).toBe('aes-256-gcm')
    expect(typeof raw.iv).toBe('string')
    expect(typeof raw.authTag).toBe('string')
    expect(typeof raw.ciphertext).toBe('string')
    // Ciphertext must NOT contain plaintext strings
    expect(raw.ciphertext).not.toContain('updated')

    // Reopening with a new store instance decrypts correctly
    const store2 = new EncryptedStore(tempDir, defaultState, validateState)
    await store2.initialize()
    expect(store2.read()).toEqual({ count: 42, text: 'updated' })
    store.destroy()
    store2.destroy()
  })

  it('detects and rejects tampered ciphertext or modified auth tags', async () => {
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    await store.initialize()
    await store.mutate((draft) => {
      draft.text = 'secret data'
    })
    store.destroy()

    const vaultPath = join(tempDir, 'vault', 'user-data.v1.enc')
    const envelope = JSON.parse(readFileSync(vaultPath, 'utf8'))

    // Tamper with ciphertext by corrupting a byte
    const cipherBuf = Buffer.from(envelope.ciphertext, 'base64')
    cipherBuf[0] = cipherBuf[0]! ^ 0xff
    envelope.ciphertext = cipherBuf.toString('base64')
    writeFileSync(vaultPath, JSON.stringify(envelope), 'utf8')

    const tamperedStore = new EncryptedStore(tempDir, defaultState, validateState)
    await expect(tamperedStore.initialize()).rejects.toThrow(EncryptedStoreError)
    await expect(tamperedStore.initialize()).rejects.toThrow('无法解密本地数据')
  })

  it('rejects an encrypted envelope with unsupported version or algorithm', async () => {
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    await store.initialize()
    store.destroy()

    const vaultPath = join(tempDir, 'vault', 'user-data.v1.enc')
    const envelope = JSON.parse(readFileSync(vaultPath, 'utf8'))
    envelope.version = 2
    writeFileSync(vaultPath, JSON.stringify(envelope), 'utf8')

    const store2 = new EncryptedStore(tempDir, defaultState, validateState)
    await expect(store2.initialize()).rejects.toThrow('无法解密本地数据')
  })

  it('serializes concurrent mutations in order without race conditions', async () => {
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    await store.initialize()

    // Dispatch 20 concurrent mutations
    const promises = Array.from({ length: 20 }, (_, index) =>
      store.mutate((draft) => {
        draft.count += 1
        draft.text = `step-${index}`
      }),
    )

    await Promise.all(promises)
    expect(store.read().count).toBe(20)

    // Reopening reads the final state correctly
    const store2 = new EncryptedStore(tempDir, defaultState, validateState)
    await store2.initialize()
    expect(store2.read().count).toBe(20)
    store.destroy()
    store2.destroy()
  })

  it('clears master key from memory on destroy', async () => {
    const store = new EncryptedStore(tempDir, defaultState, validateState)
    await store.initialize()
    expect(store.read().count).toBe(0)
    store.destroy()
    expect(() => store.read()).toThrow('EncryptedStore 尚未初始化。')
  })
})
