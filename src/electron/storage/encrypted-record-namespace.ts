import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAGIC = Buffer.from('ABRN', 'ascii')
const FORMAT_VERSION = 1
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + AUTH_TAG_BYTES
const MAX_ENCRYPTED_RECORD_BYTES = 32 * 1024 * 1024
const SAFE_HANDLE = /^scope-[0-9a-f]{64}$/
const SAFE_RECORD_HANDLE = /^record-[0-9a-f]{64}$/

export class EncryptedRecordNamespaceError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_key' | 'invalid_record' | 'authentication_failed' | 'destroyed' | 'io',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EncryptedRecordNamespaceError'
  }
}

/**
 * Encrypted record-per-file storage inside the Vault directory. Logical keys
 * never appear in filenames; HMAC handles identify scopes and records.
 */
export class EncryptedRecordNamespace {
  private destroyed = false

  constructor(
    private readonly directory: string,
    private readonly namespaceName: string,
    private readonly dataKey: Buffer,
    private readonly nameKey: Buffer,
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespaceName)) {
      throw new EncryptedRecordNamespaceError('Invalid encrypted record namespace.', 'invalid_key')
    }
    if (dataKey.length !== 32 || nameKey.length !== 32) {
      throw new EncryptedRecordNamespaceError('Invalid encrypted record namespace key length.', 'invalid_key')
    }
  }

  async initialize(): Promise<void> {
    this.assertActive()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }

  encryptedSize(plaintextBytes: number): number {
    if (!Number.isInteger(plaintextBytes) || plaintextBytes < 0) {
      throw new EncryptedRecordNamespaceError('Invalid encrypted record size.', 'invalid_record')
    }
    return HEADER_BYTES + plaintextBytes
  }

  scopeHandle(logicalScope: string): string {
    this.assertLogicalKey('scope', logicalScope, 512)
    return `scope-${this.digest(`scope\0${logicalScope}`)}`
  }

  async listScopeHandles(): Promise<string[]> {
    this.assertActive()
    try {
      const entries = await readdir(this.directory, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() && SAFE_HANDLE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw this.ioError('Unable to list encrypted record scopes.', error)
    }
  }

  recordFileHandle(logicalRecord: string): string {
    return this.recordHandle(logicalRecord)
  }

  async listRecordHandles(scopeHandle: string): Promise<string[]> {
    this.assertActive()
    this.assertScopeHandle(scopeHandle)
    try {
      const entries = await readdir(join(this.directory, scopeHandle), { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.enc'))
        .map((entry) => entry.name.slice(0, -4))
        .filter((name) => SAFE_RECORD_HANDLE.test(name))
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw this.ioError('Unable to list encrypted records.', error)
    }
  }

  readRecord(logicalScope: string, logicalRecord: string): Promise<Buffer | undefined> {
    return this.readRecordFromScopeHandle(this.scopeHandle(logicalScope), logicalRecord)
  }

  async readRecordFromScopeHandle(scopeHandle: string, logicalRecord: string): Promise<Buffer | undefined> {
    this.assertActive()
    this.assertScopeHandle(scopeHandle)
    const recordHandle = this.recordHandle(logicalRecord)
    const path = this.recordPath(scopeHandle, recordHandle)
    let encrypted: Buffer
    try {
      const file = await stat(path)
      if (!file.isFile() || file.size > MAX_ENCRYPTED_RECORD_BYTES) {
        throw new EncryptedRecordNamespaceError('Encrypted record exceeds its size limit.', 'invalid_record')
      }
      encrypted = await readFile(path)
      if (encrypted.byteLength > MAX_ENCRYPTED_RECORD_BYTES) {
        throw new EncryptedRecordNamespaceError('Encrypted record exceeds its size limit.', 'invalid_record')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw this.ioError('Unable to read an encrypted record.', error)
    }
    return this.decrypt(encrypted, scopeHandle, recordHandle)
  }

  async writeRecord(logicalScope: string, logicalRecord: string, plaintext: Uint8Array): Promise<void> {
    this.assertActive()
    if (this.encryptedSize(plaintext.byteLength) > MAX_ENCRYPTED_RECORD_BYTES) {
      throw new EncryptedRecordNamespaceError('Encrypted record exceeds its size limit.', 'invalid_record')
    }
    const scopeHandle = this.scopeHandle(logicalScope)
    const recordHandle = this.recordHandle(logicalRecord)
    const scopeDirectory = join(this.directory, scopeHandle)
    await mkdir(scopeDirectory, { recursive: true, mode: 0o700 })
    const encrypted = this.encrypt(Buffer.from(plaintext), scopeHandle, recordHandle)
    const path = this.recordPath(scopeHandle, recordHandle)
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, path)
    } catch (error) {
      throw this.ioError('Unable to write an encrypted record.', error)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async deleteRecord(logicalScope: string, logicalRecord: string): Promise<void> {
    this.assertActive()
    const scopeHandle = this.scopeHandle(logicalScope)
    const recordHandle = this.recordHandle(logicalRecord)
    try {
      await rm(this.recordPath(scopeHandle, recordHandle), { force: true })
    } catch (error) {
      throw this.ioError('Unable to delete an encrypted record.', error)
    }
  }

  async deleteRecordHandle(scopeHandle: string, recordHandle: string): Promise<void> {
    this.assertActive()
    this.assertScopeHandle(scopeHandle)
    if (!SAFE_RECORD_HANDLE.test(recordHandle)) {
      throw new EncryptedRecordNamespaceError('Invalid encrypted record handle.', 'invalid_key')
    }
    try {
      await rm(this.recordPath(scopeHandle, recordHandle), { force: true })
    } catch (error) {
      throw this.ioError('Unable to delete an encrypted record.', error)
    }
  }

  deleteScope(logicalScope: string): Promise<void> {
    return this.deleteScopeHandle(this.scopeHandle(logicalScope))
  }

  async deleteScopeHandle(scopeHandle: string): Promise<void> {
    this.assertActive()
    this.assertScopeHandle(scopeHandle)
    try {
      await rm(join(this.directory, scopeHandle), { recursive: true, force: true })
    } catch (error) {
      throw this.ioError('Unable to delete an encrypted record scope.', error)
    }
  }

  async clear(): Promise<void> {
    this.assertActive()
    try {
      await rm(this.directory, { recursive: true, force: true })
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw this.ioError('Unable to clear the encrypted record namespace.', error)
    }
  }

  async cleanupTemporaryFiles(): Promise<void> {
    this.assertActive()
    const scopes = await this.listScopeHandles()
    for (const scope of scopes) {
      const scopeDirectory = join(this.directory, scope)
      const entries = await readdir(scopeDirectory, { withFileTypes: true }).catch(() => [])
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
          .map((entry) => rm(join(scopeDirectory, entry.name), { force: true })),
      )
    }
  }

  async quarantineScopeHandle(scopeHandle: string): Promise<void> {
    this.assertActive()
    this.assertScopeHandle(scopeHandle)
    const source = join(this.directory, scopeHandle)
    const target = join(this.directory, `corrupt-${Date.now()}-${scopeHandle}`)
    try {
      await rename(source, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw this.ioError('Unable to quarantine an encrypted record scope.', error)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.dataKey.fill(0)
    this.nameKey.fill(0)
  }

  private recordHandle(logicalRecord: string): string {
    this.assertLogicalKey('record', logicalRecord, 1_024)
    return `record-${this.digest(`record\0${logicalRecord}`)}`
  }

  private digest(value: string): string {
    this.assertActive()
    return createHmac('sha256', this.nameKey).update(value, 'utf8').digest('hex')
  }

  private recordPath(scopeHandle: string, recordHandle: string): string {
    return join(this.directory, scopeHandle, `${recordHandle}.enc`)
  }

  private encrypt(plaintext: Buffer, scopeHandle: string, recordHandle: string): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.dataKey, iv, { authTagLength: AUTH_TAG_BYTES })
    cipher.setAAD(this.aad(scopeHandle, recordHandle))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), iv, authTag, ciphertext])
  }

  private decrypt(encrypted: Buffer, scopeHandle: string, recordHandle: string): Buffer {
    if (encrypted.length < HEADER_BYTES || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new EncryptedRecordNamespaceError('Invalid encrypted record envelope.', 'invalid_record')
    }
    if (encrypted[MAGIC.length] !== FORMAT_VERSION) {
      throw new EncryptedRecordNamespaceError('Unsupported encrypted record version.', 'invalid_record')
    }
    const ivStart = MAGIC.length + 1
    const tagStart = ivStart + IV_BYTES
    const ciphertextStart = tagStart + AUTH_TAG_BYTES
    const iv = encrypted.subarray(ivStart, tagStart)
    const authTag = encrypted.subarray(tagStart, ciphertextStart)
    const ciphertext = encrypted.subarray(ciphertextStart)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.dataKey, iv, { authTagLength: AUTH_TAG_BYTES })
      decipher.setAAD(this.aad(scopeHandle, recordHandle))
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch (error) {
      throw new EncryptedRecordNamespaceError('Encrypted record authentication failed.', 'authentication_failed', {
        cause: error,
      })
    }
  }

  private aad(scopeHandle: string, recordHandle: string): Buffer {
    return Buffer.from(`agentbox:record:v1\0${this.namespaceName}\0${scopeHandle}\0${recordHandle}`, 'utf8')
  }

  private assertScopeHandle(value: string): void {
    if (!SAFE_HANDLE.test(value)) {
      throw new EncryptedRecordNamespaceError('Invalid encrypted record scope handle.', 'invalid_key')
    }
  }

  private assertLogicalKey(field: string, value: string, maximum: number): void {
    if (typeof value !== 'string' || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
      throw new EncryptedRecordNamespaceError(`Invalid encrypted record ${field} key.`, 'invalid_key')
    }
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new EncryptedRecordNamespaceError('Encrypted record namespace has been destroyed.', 'destroyed')
    }
  }

  private ioError(message: string, error: unknown): EncryptedRecordNamespaceError {
    return error instanceof EncryptedRecordNamespaceError
      ? error
      : new EncryptedRecordNamespaceError(message, 'io', { cause: error })
  }
}
