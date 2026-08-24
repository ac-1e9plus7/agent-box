import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { t } from "../../shared/i18n"

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
    if (!stat.isFile()) throw new Error(t("The target is not a regular file."))
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(t("The file exceeds the {value0} read limit. Use the terminal tool to process only the portions you need.", { value0: formatBytes(MAX_READ_BYTES) }))
    }

    const buffer = await readFile(target.absolutePath)
    throwIfAborted(signal)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new Error(t("The file is not valid UTF-8."))
    }

    const startLine = normalizeInteger(input.startLine, 1, Number.MAX_SAFE_INTEGER, 1, 'start_line')
    const maxLines = normalizeInteger(input.maxLines, 1, MAX_READ_LINES, DEFAULT_READ_LINES, 'max_lines')
    const lines = content.split(/\r?\n/)
    if (startLine > lines.length) {
      throw new Error(t("start_line is outside the file; the file has {value0} lines.", { value0: lines.length }))
    }
    const endLine = Math.min(lines.length, startLine + maxLines - 1)
    const rawSelected = lines.slice(startLine - 1, endLine).join('\n')
    const selected = rawSelected.slice(0, MAX_RESULT_CHARACTERS)
    const characterTruncated = selected.length < rawSelected.length
    const truncated = endLine < lines.length || characterTruncated
    return {
      result: [
        t("[File: {value0} · Lines {value1}–{value2} of {value3}]", { value0: target.relativePath, value1: startLine, value2: endLine, value3: lines.length }),
        selected,
        endLine < lines.length ? t("[There are {value0} unread lines; continue with start_line={value1}.]", { value0: lines.length - endLine, value1: endLine + 1 }) : '',
        characterTruncated ? t("[This section contains very long text and was truncated at the tool-result size limit. Read a smaller range or process it with the terminal as needed.]") : '',
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
    if (typeof input.content !== 'string') throw new Error(t("content must be a string."))
    const contentBytes = Buffer.byteLength(input.content, 'utf8')
    if (contentBytes > MAX_WRITE_BYTES) {
      throw new Error(t("Content exceeds the {value0} write limit. Split it and try again.", { value0: formatBytes(MAX_WRITE_BYTES) }))
    }
    const mode = input.mode ?? 'overwrite'
    if (!['create', 'overwrite', 'append'].includes(mode)) throw new Error(t("Unsupported write mode."))

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
    return {
      result: t(
        mode === 'append'
          ? "Appended to {path} ({size}, UTF-8)."
          : mode === 'create'
            ? "Created {path} ({size}, UTF-8)."
            : "Wrote {path} ({size}, UTF-8).",
        { path: target.relativePath, size: formatBytes(contentBytes) },
      ),
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
  if (!workingDirectory || !isAbsolute(workingDirectory)) throw new Error(t("The current conversation has no valid working directory."))
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath.length > 4_096 || /[\r\n\0]/.test(requestedPath)) {
    throw new Error(t("The file path is invalid."))
  }
  const trimmed = requestedPath.trim()
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || /^[/\\]{2}/.test(trimmed)) {
    throw new Error(t("The file path must be relative to the working directory."))
  }
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(t("The file path must stay within the working directory."))
  }

  const rootPath = await realpath(workingDirectory)
  const rootStat = await lstat(rootPath)
  if (!rootStat.isDirectory()) throw new Error(t("The current working directory is unavailable."))
  const absolutePath = resolve(rootPath, segments.join(sep))
  const relativePath = relative(rootPath, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(t("The file path must stay within the working directory."))
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
      if (stat.isSymbolicLink()) throw new Error(t("To prevent access outside the working directory, file operations through symbolic links are not allowed."))
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(t("A parent path component is not a directory."))
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
    throw new Error(t("{value0} must be an integer between {value1}-{value2}.", { value0: label, value1: minimum, value2: maximum }))
  }
  return value
}

function workspaceFileError(error: unknown): string {
  if (isNodeError(error) && error.code === 'ENOENT') return t("The file or its parent directory does not exist.")
  if (isNodeError(error) && error.code === 'EEXIST') return t("The file already exists; use overwrite mode to replace it.")
  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) return t("You do not have permission to read or write this file.")
  return error instanceof Error ? error.message : t("File operation failed.")
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
