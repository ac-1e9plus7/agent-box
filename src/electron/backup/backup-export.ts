import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
import { t } from "../../shared/i18n"

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
  createdAt?: Date
}

export async function createBackupArchive(
  options: CreateBackupArchiveOptions,
): Promise<ExportBackupResult> {
  const input = normalizeExportBackupInput(options.input)
  if (!isAbsolute(options.outputPath)) throw new Error(t("备份文件路径无效。"))

  const outputPath = resolve(options.outputPath)
  const createdAt = options.createdAt ?? new Date()
  const conversations = structuredClone(options.conversations)
  const conversationIndex = buildConversationIndex(conversations)
  const warnings: string[] = []
  const workspaces = input.mode === 'deep'
    ? await collectWorkspaces(conversations, outputPath, warnings)
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
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.partial`,
  )
  const outputStream = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  const outputWriter = {
    writable: Writable.toWeb(outputStream) as WritableStream<Uint8Array>,
    size: 0,
  }
  const zipWriter = new ZipWriter(outputWriter, {
    ...(input.password
      ? { password: input.password, encryptionStrength: 3 as const }
      : {}),
    level: ARCHIVE_COMPRESSION_LEVEL,
    useWebWorkers: false,
  })

  try {
    await addTextEntry(zipWriter, 'manifest.json', JSON.stringify(manifest, null, 2), createdAt)
    await addTextEntry(zipWriter, 'README.txt', createBackupReadme(manifest), createdAt)
    await addTextEntry(
      zipWriter,
      'conversations/index.json',
      JSON.stringify({
        format: 'agentbox-conversation-index',
        formatVersion: 1,
        createdAt: createdAt.toISOString(),
        conversations: conversationIndex,
      }, null, 2),
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
    throw new Error(t("创建备份失败，未保留不完整的 ZIP 文件。"), { cause: error })
  }
}

export function normalizeExportBackupInput(input: ExportBackupInput): ExportBackupInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(t("备份选项无效。"))
  }
  if (input.mode !== 'shallow' && input.mode !== 'deep') {
    throw new Error(t("备份模式无效。"))
  }
  if (input.password !== undefined && typeof input.password !== 'string') {
    throw new Error(t("备份密码无效。"))
  }
  if ((input.password?.length ?? 0) > MAX_BACKUP_PASSWORD_LENGTH) {
    throw new Error(t("备份密码不能超过 {value0} 个字符。", { value0: MAX_BACKUP_PASSWORD_LENGTH }))
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

  for (const conversation of conversations) {
    const sourcePath = conversation.workingDirectory?.trim()
    if (!sourcePath) continue
    if (!isAbsolute(sourcePath)) {
      throw new Error(t("会话“{value0}”的工作目录不是有效绝对路径。", { value0: conversation.title }))
    }

    let resolvedPath: string
    try {
      resolvedPath = await realpath(sourcePath)
      const workspaceStats = await lstat(resolvedPath)
      if (!workspaceStats.isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw new Error(t("无法读取会话“{value0}”的工作目录：{value1}", { value0: conversation.title, value1: sourcePath }), {
        cause: error,
      })
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
    workspace.entries = await walkWorkspace(
      workspace.resolvedPath,
      workspace.archivePath,
      excludedPaths,
      warnings,
    )
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
        warnings.push(t("已跳过无法写入 ZIP 的特殊文件：{value0}", { value0: sourcePath }))
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
    ? t("文件内容使用 WinZip AES-256（AE-2）加密。ZIP 标准不会加密条目名称。")
    : t("本备份未设置密码，包内所有文件均为明文。")
  const workspaceSummary = manifest.workspaces.included
    ? t("深备份包含 {value0} 个去重后的会话工作目录。", { value0: manifest.workspaces.count })
    : t("浅备份不包含会话工作目录。")
  return [
    t("AgentBox 会话备份"),
    '=================',
    '',
    t("导出时间：{value0}", { value0: manifest.createdAt }),
    t("备份模式：{value0}", { value0: t(manifest.mode === 'deep' ? 'backup.mode.deep' : 'backup.mode.shallow') }),
    t("会话数量：{value0}", { value0: manifest.conversations.count }),
    protection,
    workspaceSummary,
    '',
    t("内容说明"),
    '--------',
    t("- manifest.json：机器可读的备份格式、模式、版本、内容计数和工作目录映射。"),
    t("- conversations/index.json：会话索引。"),
    t("- conversations/*.json：完整、无损的会话数据，包含所有分支、附件和 Agent 记录。"),
    t("- conversations/*.md：便于直接阅读的会话文本。"),
    t("- workspaces/*：仅深备份包含；符号链接以链接条目保存，不跟随到工作目录之外。"),
    '',
    t("安全说明"),
    '--------',
    t("- 导出包不包含 API 密钥、认证凭据、Vault 主密钥或应用配置。"),
    t("- JSON、Markdown 和工作目录文件在 ZIP 内都是原始明文；是否加密由导出时是否设置密码决定。"),
    t("- 请把未加密备份视为敏感数据，并妥善保管密码。AgentBox 不会保存或恢复导出密码。"),
    '',
  ].join('\n')
}

function conversationToMarkdown(conversation: Conversation): string {
  const lines = [
    `# ${conversation.title || t("未命名会话")}`,
    '',
    t("- 会话 ID：{value0}", { value0: conversation.id }),
    t("- 模型 ID：{value0}", { value0: conversation.modelId }),
    t("- 创建时间：{value0}", { value0: conversation.createdAt }),
    t("- 更新时间：{value0}", { value0: conversation.updatedAt }),
    t("- 工作目录：{value0}", { value0: conversation.workingDirectory || t('common.none') }),
    t("- 消息数量：{value0}", { value0: conversation.messages.length }),
    t("- 分支说明：下方按存储顺序列出会话树中的全部分支消息；父消息 ID 用于还原分支。"),
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
  const roleLabel = message.role === 'user'
    ? t("用户")
    : message.role === 'assistant'
      ? t("助手")
      : t("系统")
  const lines = [
    `## ${roleLabel} · ${message.createdAt}`,
    '',
    t("- 消息 ID：{value0}", { value0: message.id }),
    t("- 父消息 ID：{value0}", { value0: message.parentMessageId ?? t('common.none') }),
    ...(message.modelId ? [t("- 模型 ID：{value0}", { value0: message.modelId })] : []),
    '',
    message.content || t("（无正文）"),
    '',
  ]

  if (message.reasoning) {
    lines.push(t("### 思考内容"), '', message.reasoning, '')
  }
  if (message.attachments?.length) {
    lines.push(t("### 附件"), '')
    for (const attachment of message.attachments) {
      lines.push(t('backup.attachmentItem', {
        name: escapeMarkdownText(attachment.name),
        mimeType: attachment.mimeType,
        size: attachment.size,
      }))
    }
    lines.push('', t("附件原始数据保存在对应的完整 JSON 文件中。"), '')
  }
  if (message.citations?.length) {
    lines.push(t("### 来源"), '')
    for (const citation of message.citations) {
      lines.push(t('backup.citationItem', {
        title: escapeMarkdownText(citation.title || citation.url),
        url: citation.url,
      }))
    }
    lines.push('')
  }
  if (message.toolExecutions?.length) {
    lines.push(t("### Agent 工具记录（{value0} 项）", { value0: message.toolExecutions.length }), '')
    for (const execution of message.toolExecutions) {
      lines.push(t('backup.toolExecutionItem', {
        toolName: escapeMarkdownText(execution.toolName),
        status: execution.status,
      }))
    }
    lines.push('', t("完整参数、结果与 Agent trace 保存在对应的完整 JSON 文件中。"), '')
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
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function replaceFile(temporaryPath: string, outputPath: string): Promise<void> {
  const displacedPath = `${outputPath}.${process.pid}.${randomUUID()}.replaced`
  let displaced = false
  try {
    const existing = await lstat(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing?.isDirectory()) throw new Error(t("所选备份路径是目录，无法写入 ZIP 文件。"))
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
