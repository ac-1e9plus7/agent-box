import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 512 * 1024
const MAX_RESULT_CHARACTERS = 96_000
const DEFAULT_READ_LINES = 400
const MAX_READ_LINES = 2_000

export interface WorkspaceFileResult {
  isError?: boolean
  result: string
  truncated?: boolean
}

export interface ReadWorkspaceFileInput {
  maxLines?: number
  path: string
  startLine?: number
}

export interface WriteWorkspaceFileInput {
  content: string
  createParentDirectories?: boolean
  mode?: 'create' | 'overwrite' | 'append'
  path: string
}

export async function readWorkspaceFile(
  workingDirectory: string | undefined,
  input: ReadWorkspaceFileInput,
  signal?: AbortSignal,
): Promise<WorkspaceFileResult> {
  try {
    throwIfAborted(signal)
    const target = await resolveWorkspaceFilePath(workingDirectory, input.path)
    const stat = await lstat(target.absolutePath)
    if (!stat.isFile()) throw new Error('目标不是普通文件。')
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`文件超过 ${formatBytes(MAX_READ_BYTES)} 读取上限，请使用终端工具按需处理。`)
    }

    const buffer = await readFile(target.absolutePath)
    throwIfAborted(signal)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new Error('文件不是有效的 UTF-8 文本。')
    }

    const startLine = normalizeInteger(input.startLine, 1, Number.MAX_SAFE_INTEGER, 1, 'start_line')
    const maxLines = normalizeInteger(input.maxLines, 1, MAX_READ_LINES, DEFAULT_READ_LINES, 'max_lines')
    const lines = content.split(/\r?\n/)
    if (startLine > lines.length) {
      throw new Error(`start_line 超出文件范围；文件共 ${lines.length} 行。`)
    }
    const endLine = Math.min(lines.length, startLine + maxLines - 1)
    const rawSelected = lines.slice(startLine - 1, endLine).join('\n')
    const selected = rawSelected.slice(0, MAX_RESULT_CHARACTERS)
    const characterTruncated = selected.length < rawSelected.length
    const truncated = endLine < lines.length || characterTruncated
    return {
      result: [
        `[文件: ${target.relativePath} · 行 ${startLine}-${endLine}/${lines.length}]`,
        selected,
        endLine < lines.length ? `[尚有 ${lines.length - endLine} 行未读取；请从 start_line=${endLine + 1} 继续。]` : '',
        characterTruncated ? '[本段包含超长文本，已按工具结果大小上限截断；请缩小读取行数或使用终端按需处理。]' : '',
      ].filter(Boolean).join('\n'),
      truncated,
    }
  } catch (error) {
    rethrowIfAborted(error, signal)
    return { result: workspaceFileError(error), isError: true }
  }
}

export async function writeWorkspaceFile(
  workingDirectory: string | undefined,
  input: WriteWorkspaceFileInput,
  signal?: AbortSignal,
): Promise<WorkspaceFileResult> {
  try {
    throwIfAborted(signal)
    if (typeof input.content !== 'string') throw new Error('content 必须是字符串。')
    const contentBytes = Buffer.byteLength(input.content, 'utf8')
    if (contentBytes > MAX_WRITE_BYTES) {
      throw new Error(`写入内容超过 ${formatBytes(MAX_WRITE_BYTES)} 上限，请拆分后重试。`)
    }
    const mode = input.mode ?? 'overwrite'
    if (!['create', 'overwrite', 'append'].includes(mode)) throw new Error('不支持的写入模式。')

    const target = await resolveWorkspaceFilePath(workingDirectory, input.path)
    const createParents = input.createParentDirectories !== false
    if (createParents) {
      await mkdir(dirname(target.absolutePath), { recursive: true })
      await assertPathHasNoSymlinks(target.rootPath, target.segments.slice(0, -1))
    }
    await assertPathHasNoSymlinks(target.rootPath, target.segments)
    throwIfAborted(signal)

    await writeFile(target.absolutePath, input.content, {
      encoding: 'utf8',
      flag: mode === 'create' ? 'wx' : mode === 'append' ? 'a' : 'w',
    })
    throwIfAborted(signal)
    const action = mode === 'append' ? '已追加' : mode === 'create' ? '已创建' : '已写入'
    return {
      result: `${action} ${target.relativePath}（${formatBytes(contentBytes)}，UTF-8）。`,
    }
  } catch (error) {
    rethrowIfAborted(error, signal)
    return { result: workspaceFileError(error), isError: true }
  }
}

async function resolveWorkspaceFilePath(
  workingDirectory: string | undefined,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string; rootPath: string; segments: string[] }> {
  if (!workingDirectory || !isAbsolute(workingDirectory)) throw new Error('当前会话没有有效工作目录。')
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath.length > 4_096 || /[\r\n\0]/.test(requestedPath)) {
    throw new Error('文件路径无效。')
  }
  const trimmed = requestedPath.trim()
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || /^[/\\]{2}/.test(trimmed)) {
    throw new Error('文件路径必须是相对于工作目录的路径。')
  }
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error('文件路径不能离开工作目录。')
  }

  const rootPath = await realpath(workingDirectory)
  const rootStat = await lstat(rootPath)
  if (!rootStat.isDirectory()) throw new Error('当前工作目录不可用。')
  const absolutePath = resolve(rootPath, segments.join(sep))
  const relativePath = relative(rootPath, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('文件路径不能离开工作目录。')
  }
  await assertPathHasNoSymlinks(rootPath, segments)
  return { absolutePath, relativePath, rootPath, segments }
}

async function assertPathHasNoSymlinks(rootPath: string, segments: string[]): Promise<void> {
  let current = rootPath
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error('为防止越过工作目录，不允许通过符号链接读写文件。')
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('文件路径中的父级不是目录。')
    } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }
  }
}

function normalizeInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum}-${maximum} 之间的整数。`)
  }
  return value
}

function workspaceFileError(error: unknown): string {
  if (isNodeError(error) && error.code === 'ENOENT') return '文件或父目录不存在。'
  if (isNodeError(error) && error.code === 'EEXIST') return '文件已存在；如需替换，请使用 overwrite 模式。'
  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) return '没有权限读写该文件。'
  return error instanceof Error ? error.message : '文件操作失败。'
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`
}
