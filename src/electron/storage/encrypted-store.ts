import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { t } from "../../shared/i18n"

const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const VAULT_VERSION = 1
const PRIMARY_AAD = Buffer.from('agentbox:vault:v1', 'utf8')
const LEGACY_AAD = Buffer.from('chatbox-lite:vault:v1', 'utf8')
const LEGACY_APP_DIR_NAMES = ['ChatBox Lite', 'chatbox-lite', 'ChatBoxLite', 'chatbox']

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
 * 4. Automatically detects and smoothly migrates legacy ChatBox Lite vaults.
 *
 * This store owns files only under `<userData>/vault`. Workspace/project
 * directories are external execution scopes; their contents must never be
 * imported, rewritten, or encrypted by this class.
 */
export class EncryptedStore<T extends object> {
  private readonly userDataDirectory: string
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
    this.userDataDirectory = userDataDirectory
    this.directory = join(userDataDirectory, 'vault')
    this.keyPath = join(this.directory, 'master-key.bin')
    this.vaultPath = join(this.directory, 'user-data.v1.enc')
  }

  async initialize(): Promise<void> {
    this.assertSecureStorageAvailable()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })

    let existingState: T | undefined
    let existingStateNeedsPersist = false
    const envelopeBuffer = await this.readIfPresent(this.vaultPath)
    if (envelopeBuffer) {
      try {
        this.masterKey = await this.loadOrCreateMasterKey()
        const envelope = JSON.parse(envelopeBuffer.toString('utf8')) as EncryptedEnvelope
        const decryptedState = this.decrypt(envelope)
        existingState = this.validateState(decryptedState)
        existingStateNeedsPersist = JSON.stringify(decryptedState) !== JSON.stringify(existingState)
      } catch {
        // Will attempt legacy migration if available before throwing
      }
    }

    const isStateEmptyOrDefault = (state?: T): boolean => {
      if (!state) return true
      const s = state as Record<string, unknown>
      const conversations = Array.isArray(s.conversations) ? s.conversations : []
      const models = Array.isArray(s.models) ? s.models : []
      const providers = Array.isArray(s.providers) ? s.providers : []
      const hasCustomData =
        conversations.length > 0 ||
        models.length > 1 ||
        providers.some((p: any) => Boolean(p.apiKeyEncrypted || p.apiKey || p.id !== 'openrouter')) ||
        providers.length > 1
      return !hasCustomData
    }

    if (isStateEmptyOrDefault(existingState)) {
      const migratedState = await this.tryMigrateFromLegacyDirectories()
      if (migratedState) {
        this.state = migratedState
        if (!this.masterKey) {
          this.masterKey = await this.loadOrCreateMasterKey()
        }
        await this.persist(this.state)
        return
      }
    }

    if (existingState) {
      this.state = existingState
      if (existingStateNeedsPersist) await this.persist(existingState)
      return
    }

    if (envelopeBuffer && !this.state) {
      throw new EncryptedStoreError(
        t("无法解密本地数据。系统密钥可能已变化，或数据文件已经损坏。"),
      )
    }

    this.masterKey = await this.loadOrCreateMasterKey()
    this.state = this.createDefaultState()
    await this.persist(this.state)
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
        t("操作系统安全存储当前不可用；为避免明文保存，应用不会加载用户数据。"),
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
        t("当前 Linux 环境没有可用的系统密钥环；已拒绝 Electron 的 basic_text 明文后端。"),
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
        throw new EncryptedStoreError(t("无法使用系统安全存储解锁本地数据密钥。"), {
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
    cipher.setAAD(PRIMARY_AAD)
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

  private decryptWithKey(envelope: EncryptedEnvelope, masterKey: Buffer): unknown {
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

    const tryDecryptWithAad = (aad: Buffer): unknown | undefined => {
      try {
        const decipher = createDecipheriv('aes-256-gcm', masterKey, iv, {
          authTagLength: AUTH_TAG_BYTES,
        })
        decipher.setAAD(aad)
        decipher.setAuthTag(authTag)
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        try {
          return JSON.parse(plaintext.toString('utf8'))
        } finally {
          plaintext.fill(0)
        }
      } catch {
        return undefined
      }
    }

    const primaryResult = tryDecryptWithAad(PRIMARY_AAD)
    if (primaryResult !== undefined) return primaryResult

    const legacyResult = tryDecryptWithAad(LEGACY_AAD)
    if (legacyResult !== undefined) return legacyResult

    throw new Error('Unsupported encrypted envelope or authentication failed')
  }

  private decrypt(envelope: EncryptedEnvelope): unknown {
    const masterKey = this.requireMasterKey()
    return this.decryptWithKey(envelope, masterKey)
  }

  private async tryMigrateFromLegacyDirectories(): Promise<T | undefined> {
    const parentDir = dirname(this.userDataDirectory)
    if (!parentDir || parentDir === this.userDataDirectory) return undefined

    for (const dirName of LEGACY_APP_DIR_NAMES) {
      const legacyUserDir = join(parentDir, dirName)
      if (legacyUserDir.toLowerCase() === this.userDataDirectory.toLowerCase()) continue

      const legacyVaultDir = join(legacyUserDir, 'vault')
      const legacyKeyPath = join(legacyVaultDir, 'master-key.bin')
      const legacyVaultPath = join(legacyVaultDir, 'user-data.v1.enc')

      try {
        const wrappedKeyBuffer = await this.readIfPresent(legacyKeyPath)
        const vaultBuffer = await this.readIfPresent(legacyVaultPath)
        if (!wrappedKeyBuffer || !vaultBuffer) continue

        const keyBase64 = safeStorage.decryptString(wrappedKeyBuffer)
        const legacyMasterKey = Buffer.from(keyBase64, 'base64')
        if (legacyMasterKey.length !== KEY_BYTES) {
          legacyMasterKey.fill(0)
          continue
        }

        try {
          const envelope = JSON.parse(vaultBuffer.toString('utf8')) as EncryptedEnvelope
          const decryptedJson = this.decryptWithKey(envelope, legacyMasterKey)
          if (!decryptedJson) continue

          return this.validateState(decryptedJson)
        } finally {
          legacyMasterKey.fill(0)
        }
      } catch {
        continue
      }
    }

    return undefined
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
    if (!this.masterKey) throw new EncryptedStoreError(t("EncryptedStore 尚未初始化。"))
    return this.masterKey
  }

  private requireState(): T {
    if (!this.state) throw new EncryptedStoreError(t("EncryptedStore 尚未初始化。"))
    return this.state
  }
}
