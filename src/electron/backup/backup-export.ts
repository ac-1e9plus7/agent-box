import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readlink, realpath, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import { TextReader, ZipWriter } from '@zip.js/zip.js'
import type {
  AppInfo,
  BackupMode,
  Conversation,
  ExportBackupInput,
  ExportBackupResult,
  Message,
} from '../../shared/types'
import { t } from '../../shared/i18n'

const BACKUP_FORMAT = 'agentbox-backup'
const BACKUP_FORMAT_VERSION = 1
const MAX_BACKUP_PASSWORD_LENGTH = 256
const ARCHIVE_COMPRESSION_LEVEL = 6

type WorkspaceEntryKind = 'directory' | 'file' | 'symlink'

interface WorkspaceEntry {
  sourcePath: string
  archivePath: string
  kind: WorkspaceEntryKind
  size: number
  mode: number
  modifiedAt: Date
  linkTarget?: string
}

interface WorkspaceBackup {
  archivePath: string
  resolvedPath: string
  sourcePaths: string[]
  conversationIds: string[]
  entries: WorkspaceEntry[]
  fileCount: number
  directoryCount: number
  symlinkCount: number
  totalBytes: number
}

interface ConversationBackupIndexItem {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workingDirectory?: string
  jsonPath: string
  markdownPath: string
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: typeof BACKUP_FORMAT_VERSION
  createdAt: string
  mode: BackupMode
  app: AppInfo
  encryption: {
    enabled: boolean
    method: 'none' | 'WinZip AES-256 (AE-2)'
    filenameVisibility: 'ZIP entry names are not encrypted'
  }
  conversations: {
    count: number
    indexPath: 'conversations/index.json'
    representation: 'One lossless JSON file and one readable Markdown file per conversation'
    includesAllBranches: true
    attachments: 'Embedded in the lossless JSON files'
  }
  workspaces: {
    included: boolean
    count: number
    referencedConversationCount: number
    items: Array<{
      archivePath: string
      resolvedPath: string
      sourcePaths: string[]
      conversationIds: string[]
      fileCount: number
      directoryCount: number
      symlinkCount: number
      totalBytes: number
    }>
  }
  omitted: string[]
  warnings: string[]
}

export interface CreateBackupArchiveOptions {
  outputPath: string
  input: ExportBackupInput
  conversations: Conversation[]
  appInfo: AppInfo
  /** Application-managed roots that deep workspace traversal must not archive. */
  protectedPaths?: string[]
  createdAt?: Date
}

export async function createBackupArchive(options: CreateBackupArchiveOptions): Promise<ExportBackupResult> {
  const input = normalizeExportBackupInput(options.input)
  if (!isAbsolute(options.outputPath)) throw new Error(t('The backup file path is invalid.'))

  const outputPath = resolve(options.outputPath)
  const createdAt = options.createdAt ?? new Date()
  const conversations = structuredClone(options.conversations)
  const conversationIndex = buildConversationIndex(conversations)
  const warnings: string[] = []
  const workspaces =
    input.mode === 'deep'
      ? await collectWorkspaces(conversations, outputPath, options.protectedPaths ?? [], warnings)
      : []
  const manifest = buildManifest({
    appInfo: options.appInfo,
    conversationIndex,
    conversations,
    createdAt,
    encrypted: Boolean(input.password),
    mode: input.mode,
    warnings,
    workspaces,
  })

  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.partial`)
  const outputStream = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  const outputWriter = {
    writable: Writable.toWeb(outputStream) as WritableStream<Uint8Array>,
    size: 0,
  }
  const zipWriter = new ZipWriter(outputWriter, {
    ...(input.password ? { password: input.password, encryptionStrength: 3 as const } : {}),
    level: ARCHIVE_COMPRESSION_LEVEL,
    useWebWorkers: false,
  })

  try {
    await addTextEntry(zipWriter, 'manifest.json', JSON.stringify(manifest, null, 2), createdAt)
    await addTextEntry(zipWriter, 'README.txt', createBackupReadme(manifest), createdAt)
    await addTextEntry(
      zipWriter,
      'conversations/index.json',
      JSON.stringify(
        {
          format: 'agentbox-conversation-index',
          formatVersion: 1,
          createdAt: createdAt.toISOString(),
          conversations: conversationIndex,
        },
        null,
        2,
      ),
      createdAt,
    )

    for (const [index, conversation] of conversations.entries()) {
      const indexItem = conversationIndex[index]
      if (!indexItem) continue
      await addTextEntry(
        zipWriter,
        indexItem.jsonPath,
        JSON.stringify(conversation, null, 2),
        parseArchiveDate(conversation.updatedAt, createdAt),
      )
      await addTextEntry(
        zipWriter,
        indexItem.markdownPath,
        conversationToMarkdown(conversation),
        parseArchiveDate(conversation.updatedAt, createdAt),
      )
    }

    for (const workspace of workspaces) {
      for (const entry of workspace.entries) {
        if (entry.kind === 'directory') {
          await zipWriter.add(entry.archivePath, undefined, {
            directory: true,
            lastModDate: entry.modifiedAt,
            unixMode: entry.mode,
          })
          continue
        }
        if (entry.kind === 'symlink') {
          await zipWriter.add(entry.archivePath, new TextReader(entry.linkTarget ?? ''), {
            lastModDate: entry.modifiedAt,
            unixMode: 0o120777,
          })
          continue
        }
        const nodeStream = createReadStream(entry.sourcePath)
        const reader = {
          readable: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
          size: entry.size,
        }
        await zipWriter.add(entry.archivePath, reader, {
          lastModDate: entry.modifiedAt,
          unixMode: entry.mode,
        })
      }
    }

    await zipWriter.close()
    await finished(outputStream)
    const outputStats = await stat(temporaryPath)
    await replaceFile(temporaryPath, outputPath)
    return {
      canceled: false,
      filePath: outputPath,
      mode: input.mode,
      encrypted: Boolean(input.password),
      conversationCount: conversations.length,
      workspaceCount: workspaces.length,
      bytesWritten: outputStats.size,
    }
  } catch (error) {
    outputStream.destroy()
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new Error(t('Could not create the backup. The incomplete ZIP file was not retained.'), { cause: error })
  }
}

export function normalizeExportBackupInput(input: ExportBackupInput): ExportBackupInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(t('Invalid backup option.'))
  }
  if (input.mode !== 'shallow' && input.mode !== 'deep') {
    throw new Error(t('Backup mode is invalid.'))
  }
  if (input.password !== undefined && typeof input.password !== 'string') {
    throw new Error(t('The backup password is invalid.'))
  }
  if ((input.password?.length ?? 0) > MAX_BACKUP_PASSWORD_LENGTH) {
    throw new Error(t('The backup password cannot exceed {value0} characters.', { value0: MAX_BACKUP_PASSWORD_LENGTH }))
  }
  return {
    mode: input.mode,
    ...(input.password ? { password: input.password } : {}),
  }
}

export function createBackupFileName(mode: BackupMode, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `AgentBox-backup-${mode}-${timestamp}.zip`
}

function buildConversationIndex(conversations: Conversation[]): ConversationBackupIndexItem[] {
  return conversations.map((conversation, index) => {
    const prefix = `conversation-${String(index + 1).padStart(4, '0')}`
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      workingDirectory: conversation.workingDirectory,
      jsonPath: `conversations/${prefix}.json`,
      markdownPath: `conversations/${prefix}.md`,
    }
  })
}

async function collectWorkspaces(
  conversations: Conversation[],
  outputPath: string,
  protectedPaths: string[],
  warnings: string[],
): Promise<WorkspaceBackup[]> {
  const workspaces = new Map<string, WorkspaceBackup>()
  const excludedPaths = new Set([pathComparisonKey(outputPath)])
  const canonicalOutputParent = await realpath(dirname(outputPath)).catch(() => undefined)
  if (canonicalOutputParent) {
    excludedPaths.add(pathComparisonKey(join(canonicalOutputParent, basename(outputPath))))
  }
  const canonicalExistingOutput = await realpath(outputPath).catch(() => undefined)
  if (canonicalExistingOutput) excludedPaths.add(pathComparisonKey(canonicalExistingOutput))
  const protectedRoots = await normalizeProtectedPaths(protectedPaths)

  for (const conversation of conversations) {
    const sourcePath = conversation.workingDirectory?.trim()
    if (!sourcePath) continue
    if (!isAbsolute(sourcePath)) {
      throw new Error(
        t('The working directory for conversation “{value0}” is not a valid absolute path.', {
          value0: conversation.title,
        }),
      )
    }

    let resolvedPath: string
    try {
      resolvedPath = await realpath(sourcePath)
      const workspaceStats = await lstat(resolvedPath)
      if (!workspaceStats.isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw new Error(
        t('Could not read the working directory for conversation “{value0}”: {value1}', {
          value0: conversation.title,
          value1: sourcePath,
        }),
        {
          cause: error,
        },
      )
    }

    if (protectedRoots.some((protectedRoot) => isSameOrDescendantPath(resolvedPath, protectedRoot))) {
      throw new Error(
        t(
          'A conversation working directory overlaps AgentBox application data and cannot be included in a deep backup.',
        ),
      )
    }
    for (const protectedRoot of protectedRoots) {
      if (isSameOrDescendantPath(protectedRoot, resolvedPath)) {
        excludedPaths.add(pathComparisonKey(protectedRoot))
      }
    }

    const key = pathComparisonKey(resolvedPath)
    const existing = workspaces.get(key)
    if (existing) {
      if (!existing.sourcePaths.includes(sourcePath)) existing.sourcePaths.push(sourcePath)
      if (!existing.conversationIds.includes(conversation.id)) {
        existing.conversationIds.push(conversation.id)
      }
      continue
    }

    workspaces.set(key, {
      archivePath: '',
      resolvedPath,
      sourcePaths: [sourcePath],
      conversationIds: [conversation.id],
      entries: [],
      fileCount: 0,
      directoryCount: 0,
      symlinkCount: 0,
      totalBytes: 0,
    })
  }

  const collected = [...workspaces.values()]
  for (const [index, workspace] of collected.entries()) {
    workspace.archivePath = `workspaces/workspace-${String(index + 1).padStart(4, '0')}/`
    workspace.entries = await walkWorkspace(workspace.resolvedPath, workspace.archivePath, excludedPaths, warnings)
    for (const entry of workspace.entries) {
      if (entry.kind === 'file') {
        workspace.fileCount += 1
        workspace.totalBytes += entry.size
      } else if (entry.kind === 'directory') {
        workspace.directoryCount += 1
      } else {
        workspace.symlinkCount += 1
      }
    }
  }
  return collected
}

async function normalizeProtectedPaths(paths: string[]): Promise<string[]> {
  const roots = await Promise.all(
    paths
      .filter((path) => typeof path === 'string' && path.trim())
      .map(async (path) => realpath(path).catch(() => resolve(path))),
  )
  return [...new Set(roots.map(pathComparisonKey))]
}

function isSameOrDescendantPath(path: string, ancestor: string): boolean {
  const normalizedPath = pathComparisonKey(path)
  const normalizedAncestor = pathComparisonKey(ancestor)
  if (normalizedPath === normalizedAncestor) return true
  const ancestorPrefix = normalizedAncestor.endsWith(sep) ? normalizedAncestor : `${normalizedAncestor}${sep}`
  return normalizedPath.startsWith(ancestorPrefix)
}

async function walkWorkspace(
  rootPath: string,
  archiveRoot: string,
  excludedPaths: Set<string>,
  warnings: string[],
): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = []

  const visit = async (sourceDirectory: string, archiveSegments: string[]): Promise<void> => {
    const directoryStats = await lstat(sourceDirectory)
    entries.push({
      sourcePath: sourceDirectory,
      archivePath: `${archiveRoot}${archiveSegments.map(encodeArchiveSegment).join('/')}${archiveSegments.length ? '/' : ''}`,
      kind: 'directory',
      size: 0,
      mode: directoryStats.mode,
      modifiedAt: normalizeArchiveDate(directoryStats.mtime),
    })

    const directoryEntries = await readdir(sourceDirectory, { withFileTypes: true })
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name))
    for (const directoryEntry of directoryEntries) {
      const sourcePath = join(sourceDirectory, directoryEntry.name)
      if (excludedPaths.has(pathComparisonKey(sourcePath))) continue
      const archivePath = `${archiveRoot}${[...archiveSegments, directoryEntry.name]
        .map(encodeArchiveSegment)
        .join('/')}`
      const entryStats = await lstat(sourcePath)

      if (entryStats.isSymbolicLink()) {
        entries.push({
          sourcePath,
          archivePath,
          kind: 'symlink',
          size: entryStats.size,
          mode: entryStats.mode,
          modifiedAt: normalizeArchiveDate(entryStats.mtime),
          linkTarget: await readlink(sourcePath),
        })
      } else if (entryStats.isDirectory()) {
        await visit(sourcePath, [...archiveSegments, directoryEntry.name])
      } else if (entryStats.isFile()) {
        entries.push({
          sourcePath,
          archivePath,
          kind: 'file',
          size: entryStats.size,
          mode: entryStats.mode,
          modifiedAt: normalizeArchiveDate(entryStats.mtime),
        })
      } else {
        warnings.push(t('Skipped a special file that could not be added to the ZIP: {value0}', { value0: sourcePath }))
      }
    }
  }

  await visit(rootPath, [])
  return entries
}

function buildManifest(input: {
  appInfo: AppInfo
  conversationIndex: ConversationBackupIndexItem[]
  conversations: Conversation[]
  createdAt: Date
  encrypted: boolean
  mode: BackupMode
  warnings: string[]
  workspaces: WorkspaceBackup[]
}): BackupManifest {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: input.createdAt.toISOString(),
    mode: input.mode,
    app: input.appInfo,
    encryption: {
      enabled: input.encrypted,
      method: input.encrypted ? 'WinZip AES-256 (AE-2)' : 'none',
      filenameVisibility: 'ZIP entry names are not encrypted',
    },
    conversations: {
      count: input.conversationIndex.length,
      indexPath: 'conversations/index.json',
      representation: 'One lossless JSON file and one readable Markdown file per conversation',
      includesAllBranches: true,
      attachments: 'Embedded in the lossless JSON files',
    },
    workspaces: {
      included: input.mode === 'deep',
      count: input.workspaces.length,
      referencedConversationCount: input.conversations.filter((item) => item.workingDirectory?.trim()).length,
      items: input.workspaces.map((workspace) => ({
        archivePath: workspace.archivePath,
        resolvedPath: workspace.resolvedPath,
        sourcePaths: workspace.sourcePaths,
        conversationIds: workspace.conversationIds,
        fileCount: workspace.fileCount,
        directoryCount: workspace.directoryCount,
        symlinkCount: workspace.symlinkCount,
        totalBytes: workspace.totalBytes,
      })),
    },
    omitted: [
      'Provider API keys and authentication credentials',
      'Vault master key and encrypted vault files',
      'Provider, model, MCP server, skill and application settings',
    ],
    warnings: input.warnings,
  }
}

function createBackupReadme(manifest: BackupManifest): string {
  const protection = manifest.encryption.enabled
    ? t('File contents are encrypted using WinZip AES-256 (AE-2). The ZIP standard does not encrypt entry names.')
    : t('This backup is not password-protected; every file in the archive is plaintext.')
  const workspaceSummary = manifest.workspaces.included
    ? t('The deep backup includes {value0} unique conversation working directories.', {
        value0: manifest.workspaces.count,
      })
    : t('A shallow backup does not include conversation working directories.')
  return [
    t('AgentBox conversation backup'),
    '=================',
    '',
    t('Exported at: {value0}', { value0: manifest.createdAt }),
    t('Backup mode: {value0}', { value0: t(manifest.mode === 'deep' ? 'Deep backup' : 'Shallow backup') }),
    t('Conversation count: {value0}', { value0: manifest.conversations.count }),
    protection,
    workspaceSummary,
    '',
    t('Content description'),
    '--------',
    t('- manifest.json: Machine-readable backup format, schema, version, item counts, and working-directory mappings.'),
    t('- conversations/index.json: Conversation index.'),
    t(
      '- conversations/*.json: Complete, lossless conversation data, including all branches, attachments, and Agent records.',
    ),
    t('- conversations/*.md: Human-readable conversation transcripts.'),
    t(
      '- workspaces/*: Included only in deep backups. Symbolic links are stored as link entries and are not followed outside the working directory.',
    ),
    '',
    t('Security notes'),
    '--------',
    t(
      '- The export package does not contain API keys, authentication credentials, vault master keys, or app configurations.',
    ),
    t(
      '- JSON, Markdown, and workspace files are stored as plaintext inside the ZIP. They are encrypted only when an export password is set.',
    ),
    t(
      '- Treat unencrypted backups as sensitive data and store the export password securely. AgentBox does not save or recover export passwords.',
    ),
    '',
  ].join('\n')
}

function conversationToMarkdown(conversation: Conversation): string {
  const lines = [
    `# ${conversation.title || t('Untitled conversation')}`,
    '',
    t('- Conversation ID: {value0}', { value0: conversation.id }),
    t('- Model ID: {value0}', { value0: conversation.modelId }),
    t('- Created at: {value0}', { value0: conversation.createdAt }),
    t('- Updated at: {value0}', { value0: conversation.updatedAt }),
    t('- Working directory: {value0}', { value0: conversation.workingDirectory || t('None') }),
    t('- Messages: {value0}', { value0: conversation.messages.length }),
    t(
      '- Branches: Messages from every branch of the conversation tree are listed below in storage order. Parent message IDs preserve the branch structure.',
    ),
    '',
    '---',
    '',
  ]

  for (const message of conversation.messages) {
    lines.push(...messageToMarkdown(message))
  }
  return `${lines.join('\n')}\n`
}

function messageToMarkdown(message: Message): string[] {
  const roleLabel = message.role === 'user' ? t('User') : message.role === 'assistant' ? t('Assistant') : t('System')
  const lines = [
    `## ${roleLabel} · ${message.createdAt}`,
    '',
    t('- Message ID: {value0}', { value0: message.id }),
    t('- Parent message ID: {value0}', { value0: message.parentMessageId ?? t('None') }),
    ...(message.modelId ? [t('- Model ID: {value0}', { value0: message.modelId })] : []),
    '',
    message.content || t('(no content)'),
    '',
  ]

  if (message.reasoning) {
    lines.push(t('### Reasoning'), '', message.reasoning, '')
  }
  if (message.attachments?.length) {
    lines.push(t('### Attachments'), '')
    for (const attachment of message.attachments) {
      lines.push(
        t('- {name} ({mimeType}, {size} bytes)', {
          name: escapeMarkdownText(attachment.name),
          mimeType: attachment.mimeType,
          size: attachment.size,
        }),
      )
    }
    lines.push('', t('Raw attachment data is stored in the corresponding full JSON file.'), '')
  }
  if (message.citations?.length) {
    lines.push(t('### Sources'), '')
    for (const citation of message.citations) {
      lines.push(
        t('- {title}: {url}', {
          title: escapeMarkdownText(citation.title || citation.url),
          url: citation.url,
        }),
      )
    }
    lines.push('')
  }
  if (message.toolExecutions?.length) {
    lines.push(t('### Agent tool records ({value0} items)', { value0: message.toolExecutions.length }), '')
    for (const execution of message.toolExecutions) {
      lines.push(
        t('- {toolName}: {status}', {
          toolName: escapeMarkdownText(execution.toolName),
          status: execution.status,
        }),
      )
    }
    lines.push('', t('Full parameters, results, and the Agent trace are stored in the corresponding JSON file.'), '')
  }
  lines.push('---', '')
  return lines
}

async function addTextEntry(
  zipWriter: ZipWriter<unknown>,
  path: string,
  content: string,
  lastModDate: Date,
): Promise<void> {
  await zipWriter.add(path, new TextReader(content), { lastModDate })
}

function encodeArchiveSegment(segment: string): string {
  return segment
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\r?\n/g, ' ')
}

function parseArchiveDate(value: string, fallback: Date): Date {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? normalizeArchiveDate(fallback) : normalizeArchiveDate(parsed)
}

function normalizeArchiveDate(value: Date): Date {
  const timestamp = value.getTime()
  if (Number.isNaN(timestamp)) return new Date('1980-01-01T00:00:00.000Z')
  const minimum = new Date('1980-01-01T00:00:00.000Z').getTime()
  const maximum = new Date('2107-12-31T23:59:58.000Z').getTime()
  return new Date(Math.min(maximum, Math.max(minimum, timestamp)))
}

function pathComparisonKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

async function replaceFile(temporaryPath: string, outputPath: string): Promise<void> {
  const displacedPath = `${outputPath}.${process.pid}.${randomUUID()}.replaced`
  let displaced = false
  try {
    const existing = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing?.isDirectory())
      throw new Error(t('The selected backup path is a directory and cannot be written to a ZIP file.'))
    if (existing) {
      await rename(outputPath, displacedPath)
      displaced = true
    }
    await rename(temporaryPath, outputPath)
    if (displaced) await rm(displacedPath, { force: true }).catch(() => undefined)
  } catch (error) {
    if (displaced) {
      await rename(displacedPath, outputPath).catch(() => undefined)
    }
    throw error
  }
}
