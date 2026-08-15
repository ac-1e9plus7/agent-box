import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'

const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const VAULT_VERSION = 1
const AAD = Buffer.from('chatbox-lite:vault:v1', 'utf8')

interface EncryptedEnvelope {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  authTag: string
  ciphertext: string
}

export class EncryptedStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EncryptedStoreError'
  }
}

/**
 * An encrypted JSON store using envelope encryption:
 *
 * 1. A random 256-bit data key is protected by Electron safeStorage.
 * 2. The complete JSON payload is encrypted with AES-256-GCM.
 * 3. No plaintext fallback is used when the OS key store is unavailable.
 */
export class EncryptedStore<T extends object> {
  private readonly directory: string
  private readonly keyPath: string
  private readonly vaultPath: string
  private masterKey?: Buffer
  private state?: T
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    userDataDirectory: string,
    private readonly createDefaultState: () => T,
    private readonly validateState: (value: unknown) => T,
  ) {
    this.directory = join(userDataDirectory, 'vault')
    this.keyPath = join(this.directory, 'master-key.bin')
    this.vaultPath = join(this.directory, 'user-data.v1.enc')
  }

  async initialize(): Promise<void> {
    this.assertSecureStorageAvailable()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.masterKey = await this.loadOrCreateMasterKey()

    const envelopeBuffer = await this.readIfPresent(this.vaultPath)
    if (!envelopeBuffer) {
      this.state = this.createDefaultState()
      await this.persist(this.state)
      return
    }

    try {
      const envelope = JSON.parse(envelopeBuffer.toString('utf8')) as EncryptedEnvelope
      this.state = this.validateState(this.decrypt(envelope))
    } catch (error) {
      throw new EncryptedStoreError(
        '无法解密本地数据。系统密钥可能已变化，或数据文件已经损坏。',
        { cause: error },
      )
    }
  }

  read(): T {
    return structuredClone(this.requireState())
  }

  async mutate<R>(mutator: (draft: T) => R): Promise<R> {
    this.requireMasterKey()
    this.requireState()

    let output!: R
    const operation = this.operationQueue.then(async () => {
      const draft = structuredClone(this.requireState())
      output = mutator(draft)
      const validated = this.validateState(draft)
      await this.persist(validated)
      this.state = validated
    })

    this.operationQueue = operation.catch(() => undefined)
    await operation
    return output
  }

  destroy(): void {
    this.masterKey?.fill(0)
    this.masterKey = undefined
    this.state = undefined
  }

  private assertSecureStorageAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptedStoreError(
        '操作系统安全存储当前不可用；为避免明文保存，应用不会加载用户数据。',
      )
    }

    const safeStorageWithBackend = safeStorage as typeof safeStorage & {
      getSelectedStorageBackend?: () => string
    }
    const backend =
      process.platform === 'linux'
        ? safeStorageWithBackend.getSelectedStorageBackend?.()
        : undefined
    if (process.platform === 'linux' && backend === 'basic_text') {
      throw new EncryptedStoreError(
        '当前 Linux 环境没有可用的系统密钥环；已拒绝 Electron 的 basic_text 明文后端。',
      )
    }
  }

  private async loadOrCreateMasterKey(): Promise<Buffer> {
    const wrappedKey = await this.readIfPresent(this.keyPath)
    if (wrappedKey) {
      try {
        const key = safeStorage.decryptString(wrappedKey)
        const decoded = Buffer.from(key, 'base64')
        if (decoded.length !== KEY_BYTES) {
          decoded.fill(0)
          throw new Error('Unexpected data-key length')
        }
        return decoded
      } catch (error) {
        throw new EncryptedStoreError('无法使用系统安全存储解锁本地数据密钥。', {
          cause: error,
        })
      }
    }

    const key = randomBytes(KEY_BYTES)
    const wrapped = safeStorage.encryptString(key.toString('base64'))
    await this.writeFileAtomic(this.keyPath, wrapped)
    return key
  }

  private encrypt(value: T): EncryptedEnvelope {
    const masterKey = this.requireMasterKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    })
    cipher.setAAD(AAD)
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')

    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const authTag = cipher.getAuthTag()
      return {
        version: VAULT_VERSION,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }
    } finally {
      plaintext.fill(0)
    }
  }

  private decrypt(envelope: EncryptedEnvelope): unknown {
    const masterKey = this.requireMasterKey()
    if (
      envelope.version !== VAULT_VERSION ||
      envelope.algorithm !== 'aes-256-gcm' ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.authTag !== 'string' ||
      typeof envelope.ciphertext !== 'string'
    ) {
      throw new Error('Unsupported encrypted envelope')
    }

    const iv = Buffer.from(envelope.iv, 'base64')
    const authTag = Buffer.from(envelope.authTag, 'base64')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('Invalid encrypted envelope')
    }

    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    })
    decipher.setAAD(AAD)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    try {
      return JSON.parse(plaintext.toString('utf8'))
    } finally {
      plaintext.fill(0)
    }
  }

  private async persist(value: T): Promise<void> {
    const envelope = this.encrypt(value)
    await this.writeFileAtomic(
      this.vaultPath,
      Buffer.from(JSON.stringify(envelope), 'utf8'),
    )
  }

  private async writeFileAtomic(path: string, data: Buffer): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, path)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async readIfPresent(path: string): Promise<Buffer | undefined> {
    try {
      return await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new EncryptedStoreError('EncryptedStore 尚未初始化。')
    return this.masterKey
  }

  private requireState(): T {
    if (!this.state) throw new EncryptedStoreError('EncryptedStore 尚未初始化。')
    return this.state
  }
}
