import { strToU8, zipSync } from 'fflate'
import { Uint8ArrayReader, ZipReader, type FileEntry } from '@zip.js/zip.js'
import type { Skill, SkillFile, SkillFileKind, SkillInput } from './types'
import { t } from './i18n'

export const MAX_SKILL_ZIP_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_SKILL_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_SKILL_ZIP_FILE_BYTES = 2 * 1024 * 1024
const MAX_SKILL_FILE_CHARACTERS = 500_000
const MAX_SKILL_ZIP_SCANNED_ENTRIES = 128
const MAX_SKILL_ZIP_FILES = 51
const MAX_SKILL_FILES = 50
const STANDARD_SKILL_MANIFEST_FILENAMES = new Set(['skill.json', 'manifest.json'])
const GENERATED_SKILL_MANIFEST_FORMAT = 'agentbox-skill-manifest-v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function inferFileKind(path: string): SkillFileKind {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.py') || lower.endsWith('.py3')) return 'python'
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'shell'
  return 'other'
}

export function parseSkillFrontmatter(content: string): {
  metadata: Record<string, string>
  body: string
} {
  const normalized = content.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { metadata: {}, body: normalized }
  }

  const rawYaml = match[1] ?? ''
  const body = match[2] ?? ''
  const metadata: Record<string, string> = {}

  for (const line of rawYaml.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim()
      let value = trimmed.slice(colonIndex + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      metadata[key] = value
    }
  }

  return { metadata, body }
}

export function serializeSkillFrontmatter(
  skill: {
    name: string
    description: string
    version?: string
    author?: string
    icon?: string
  },
  body: string,
): string {
  const lines = ['---']
  lines.push(`name: ${JSON.stringify(skill.name)}`)
  lines.push(`description: ${JSON.stringify(skill.description)}`)
  if (skill.version) lines.push(`version: ${JSON.stringify(skill.version)}`)
  if (skill.author) lines.push(`author: ${JSON.stringify(skill.author)}`)
  if (skill.icon) lines.push(`icon: ${JSON.stringify(skill.icon)}`)
  lines.push('---', '')
  lines.push(body.trim())
  return lines.join('\n')
}

export async function exportSkillToZip(skill: Skill): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  const files =
    skill.files && skill.files.length > 0
      ? skill.files
      : [
          {
            path: skill.entryFile || 'SKILL.md',
            content: skill.systemPrompt || `# ${skill.name}\n\n${skill.description}`,
            kind: 'markdown' as SkillFileKind,
          },
        ]

  const entryFile = skill.entryFile || 'SKILL.md'
  const hasEntryFile = files.some((file) => file.path === entryFile)

  for (const file of files) {
    let content = file.content
    if (file.path === entryFile && !content.startsWith('---')) {
      content = serializeSkillFrontmatter(skill, content)
    }
    entries[file.path] = strToU8(content)
  }

  if (!hasEntryFile) {
    const entryContent = serializeSkillFrontmatter(
      skill,
      skill.systemPrompt || `# ${skill.name}\n\n${skill.description}`,
    )
    entries['SKILL.md'] = strToU8(entryContent)
  }

  const manifestPath = nextGeneratedManifestPath(entries)
  entries[manifestPath] = strToU8(
    JSON.stringify({
      format: GENERATED_SKILL_MANIFEST_FORMAT,
      name: skill.name,
      description: skill.description,
      icon: skill.icon,
      author: skill.author,
      version: skill.version,
      entryFile,
    }),
  )

  return zipSync(entries, { level: 6 })
}

export async function parseSkillFromZip(zipData: Uint8Array | ArrayBuffer): Promise<SkillInput> {
  const bytes = zipData instanceof Uint8Array ? zipData : new Uint8Array(zipData)
  if (bytes.byteLength > MAX_SKILL_ZIP_COMPRESSED_BYTES) {
    throw new Error(
      t('The skill archive exceeds the maximum compressed size of {value0} MiB.', {
        value0: MAX_SKILL_ZIP_COMPRESSED_BYTES / 1024 / 1024,
      }),
    )
  }

  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    const filesToRead: FileEntry[] = []
    let scannedEntries = 0
    for await (const entry of reader.getEntriesGenerator()) {
      scannedEntries += 1
      if (scannedEntries > MAX_SKILL_ZIP_SCANNED_ENTRIES) {
        throw new Error(t('The skill archive contains too many entries.'))
      }
      if (entry.directory || shouldIgnoreArchivePath(entry.filename)) continue
      filesToRead.push(entry)
      if (filesToRead.length > MAX_SKILL_ZIP_FILES) {
        throw new Error(t('The skill archive contains more files than the limit.'))
      }
    }
    if (filesToRead.length === 0) {
      throw new Error(t('The archive is empty or contains no valid files.'))
    }

    const archivePaths = filesToRead.map((entry) => normalizeArchivePath(entry.filename))
    const rootDir = resolveArchiveRoot(archivePaths)
    const files: SkillFile[] = []
    let entryFile = 'SKILL.md'
    let parsedName = ''
    let parsedDesc = ''
    let parsedAuthor = ''
    let parsedVersion = '1.0.0'
    let parsedIcon = ''
    let manifestFound = false
    const total = { bytes: 0 }

    for (const [index, archiveEntry] of filesToRead.entries()) {
      const archivePath = archivePaths[index]
      if (!archivePath) continue
      const relativePath = rootDir && archivePath.startsWith(rootDir) ? archivePath.slice(rootDir.length) : archivePath
      if (!relativePath) continue
      const textContent = await readZipText(archiveEntry, total)
      if (textContent.length > MAX_SKILL_FILE_CHARACTERS) {
        throw new Error(
          t('A Skill archive text file cannot exceed {value0} characters.', { value0: MAX_SKILL_FILE_CHARACTERS }),
        )
      }

      const manifest = parseSkillManifest(textContent)
      const isStandardManifest =
        STANDARD_SKILL_MANIFEST_FILENAMES.has(relativePath.toLowerCase()) && manifest?.hasMetadata === true
      const isGeneratedManifest = manifest?.format === GENERATED_SKILL_MANIFEST_FORMAT
      if (isStandardManifest || isGeneratedManifest) {
        if (manifest) {
          parsedName = manifest.name || parsedName
          parsedDesc = manifest.description || parsedDesc
          parsedAuthor = manifest.author || parsedAuthor
          parsedVersion = manifest.version || parsedVersion
          parsedIcon = manifest.icon || parsedIcon
          entryFile = manifest.entryFile || entryFile
          manifestFound = true
        }
        continue
      }

      files.push({
        path: relativePath,
        content: textContent,
        kind: inferFileKind(relativePath),
      })
      if (files.length > MAX_SKILL_FILES) {
        throw new Error(t('The skill archive contains more files than the limit.'))
      }
    }

    const entryFileObj =
      files.find((file) => file.path === entryFile) ??
      files.find((file) => file.path.toLowerCase() === 'skill.md') ??
      files.find((file) => file.path.toLowerCase() === 'readme.md') ??
      files.find((file) => file.kind === 'markdown')

    if (!entryFileObj || entryFileObj.kind !== 'markdown') {
      throw new Error(t('The skill archive must contain a Markdown entry document.'))
    }

    entryFile = entryFileObj.path
    const { metadata, body } = parseSkillFrontmatter(entryFileObj.content)
    if (!manifestFound) {
      if (metadata.name) parsedName = metadata.name
      if (metadata.description) parsedDesc = metadata.description
      if (metadata.author) parsedAuthor = metadata.author
      if (metadata.version) parsedVersion = metadata.version
      if (metadata.icon) parsedIcon = metadata.icon
    }

    if (!parsedName) {
      const h1Match = body.match(/^#\s+(.+)$/m)
      if (h1Match?.[1]) parsedName = h1Match[1].trim()
    }
    if (!parsedDesc) {
      const firstParagraph = body
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#') && !line.startsWith('---'))
      if (firstParagraph) parsedDesc = firstParagraph.slice(0, 300)
    }

    if (!parsedName) parsedName = rootDir ? rootDir.replace(/\/$/, '') : t('Custom skills')
    if (!parsedDesc) parsedDesc = t('A skill imported from an external ZIP archive.')
    if (!parsedIcon) parsedIcon = files.some((file) => file.kind === 'python') ? 'code' : 'tool'

    return {
      name: parsedName,
      description: parsedDesc,
      icon: parsedIcon,
      entryFile,
      files,
      author: parsedAuthor || undefined,
      version: parsedVersion || '1.0.0',
      enabled: true,
    }
  } finally {
    await reader.close()
  }
}

function shouldIgnoreArchivePath(path: string): boolean {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment === '__MACOSX' || segment === '.DS_Store')
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:($|\/)/.test(normalized)) {
    throw new Error(t('The skill archive contains an invalid file path.'))
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(t('The skill archive contains an invalid file path.'))
  }
  return segments.join('/')
}

function resolveArchiveRoot(paths: string[]): string {
  const pathParts = paths.map((path) => path.split('/'))
  if (pathParts.every((parts) => parts.length > 1 && parts[0] === pathParts[0]?.[0])) {
    return `${pathParts[0]?.[0]}/`
  }
  return ''
}

function nextGeneratedManifestPath(entries: Record<string, Uint8Array>): string {
  const baseName = 'agentbox-skill-manifest'
  let suffix = 0
  while (true) {
    const path = `${baseName}${suffix === 0 ? '' : `-${suffix}`}.json`
    if (!entries[path]) return path
    suffix += 1
  }
}

function parseSkillManifest(content: string): {
  format: string
  hasMetadata: boolean
  name: string
  description: string
  author: string
  version: string
  icon: string
  entryFile: string
} | null {
  try {
    const value: unknown = JSON.parse(content)
    if (!isRecord(value)) return null
    const metadataKeys = ['name', 'description', 'author', 'version', 'icon', 'entryFile'] as const
    return {
      format: typeof value.format === 'string' ? value.format : '',
      hasMetadata: metadataKeys.some((key) => value[key] !== undefined),
      name: typeof value.name === 'string' ? value.name : '',
      description: typeof value.description === 'string' ? value.description : '',
      author: typeof value.author === 'string' ? value.author : '',
      version: typeof value.version === 'string' ? value.version : '',
      icon: typeof value.icon === 'string' ? value.icon : '',
      entryFile: typeof value.entryFile === 'string' ? value.entryFile : '',
    }
  } catch {
    return null
  }
}

async function readZipText(entry: FileEntry, total: { bytes: number }): Promise<string> {
  if (entry.uncompressedSize !== undefined && entry.uncompressedSize > MAX_SKILL_ZIP_FILE_BYTES) {
    throw new Error(
      t('A skill archive file exceeds the maximum uncompressed size of {value0} MiB.', {
        value0: MAX_SKILL_ZIP_FILE_BYTES / 1024 / 1024,
      }),
    )
  }
  if (entry.uncompressedSize !== undefined && total.bytes + entry.uncompressedSize > MAX_SKILL_ZIP_UNCOMPRESSED_BYTES) {
    throw new Error(
      t('The skill archive exceeds the maximum uncompressed size of {value0} MiB.', {
        value0: MAX_SKILL_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024,
      }),
    )
  }

  const chunks: Uint8Array[] = []
  let entryBytes = 0
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const nextEntryBytes = entryBytes + chunk.byteLength
      const nextTotalBytes = total.bytes + chunk.byteLength
      if (nextEntryBytes > MAX_SKILL_ZIP_FILE_BYTES) {
        throw new Error(
          t('A skill archive file exceeds the maximum uncompressed size of {value0} MiB.', {
            value0: MAX_SKILL_ZIP_FILE_BYTES / 1024 / 1024,
          }),
        )
      }
      if (nextTotalBytes > MAX_SKILL_ZIP_UNCOMPRESSED_BYTES) {
        throw new Error(
          t('The skill archive exceeds the maximum uncompressed size of {value0} MiB.', {
            value0: MAX_SKILL_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024,
          }),
        )
      }
      entryBytes = nextEntryBytes
      total.bytes = nextTotalBytes
      chunks.push(chunk.slice())
    },
  })
  await entry.getData(writable, { useWebWorkers: false })

  const content = new Uint8Array(entryBytes)
  let offset = 0
  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error(t('The skill archive contains a file that is not valid UTF-8 text.'))
  }
}
