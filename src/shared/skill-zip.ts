import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import type { Skill, SkillFile, SkillFileKind, SkillInput } from './types'

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

export function serializeSkillFrontmatter(skill: {
  name: string
  description: string
  version?: string
  author?: string
  icon?: string
}, body: string): string {
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
  const files = skill.files && skill.files.length > 0
    ? skill.files
    : [
        {
          path: skill.entryFile || 'SKILL.md',
          content: skill.systemPrompt || `# ${skill.name}\n\n${skill.description}`,
          kind: 'markdown' as SkillFileKind
        }
      ]

  const hasEntryFile = files.some((f) => f.path === (skill.entryFile || 'SKILL.md'))

  for (const file of files) {
    let content = file.content
    if (file.path === (skill.entryFile || 'SKILL.md') && !content.startsWith('---')) {
      content = serializeSkillFrontmatter(skill, content)
    }
    entries[file.path] = strToU8(content)
  }

  if (!hasEntryFile) {
    const entryContent = serializeSkillFrontmatter(skill, skill.systemPrompt || `# ${skill.name}\n\n${skill.description}`)
    entries['SKILL.md'] = strToU8(entryContent)
  }

  return zipSync(entries, { level: 6 })
}

export async function parseSkillFromZip(zipData: Uint8Array | ArrayBuffer): Promise<SkillInput> {
  const u8Array = zipData instanceof Uint8Array ? zipData : new Uint8Array(zipData)
  const unzipped = unzipSync(u8Array)

  const files: SkillFile[] = []
  let entryFile = 'SKILL.md'
  let parsedName = ''
  let parsedDesc = ''
  let parsedAuthor = ''
  let parsedVersion = '1.0.0'
  let parsedIcon = ''
  let manifestFound = false

  const pathList = Object.keys(unzipped).filter((path) => {
    return !path.endsWith('/') && !path.startsWith('__MACOSX/') && !path.includes('/.DS_Store')
  })

  if (pathList.length === 0) {
    throw new Error('压缩包为空或不包含有效文件')
  }

  // Check if all paths share a common root directory (e.g. "my-skill/SKILL.md")
  const pathParts = pathList.map((p) => p.split('/'))
  let rootDir = ''
  if (pathParts.every((parts) => parts.length > 1 && parts[0] === pathParts[0]?.[0])) {
    rootDir = `${pathParts[0]?.[0]}/`
  }

  for (const rawPath of pathList) {
    const relativePath = rootDir && rawPath.startsWith(rootDir) ? rawPath.slice(rootDir.length) : rawPath
    if (!relativePath) continue

    const contentBytes = unzipped[rawPath]
    if (!contentBytes) continue

    const textContent = strFromU8(contentBytes)
    const kind = inferFileKind(relativePath)

    // Check for JSON/YAML manifest
    if (relativePath.toLowerCase() === 'skill.json' || relativePath.toLowerCase() === 'manifest.json') {
      try {
        const json = JSON.parse(textContent)
        if (json && typeof json === 'object') {
          if (json.name) parsedName = String(json.name)
          if (json.description) parsedDesc = String(json.description)
          if (json.author) parsedAuthor = String(json.author)
          if (json.version) parsedVersion = String(json.version)
          if (json.icon) parsedIcon = String(json.icon)
          if (json.entryFile) entryFile = String(json.entryFile)
          manifestFound = true
        }
      } catch {
        // ignore parse error and proceed
      }
    }

    files.push({
      path: relativePath,
      content: textContent,
      kind
    })
  }

  // Find entry markdown file
  let entryFileObj = files.find((f) => f.path === entryFile)
    ?? files.find((f) => f.path.toLowerCase() === 'skill.md')
    ?? files.find((f) => f.path.toLowerCase() === 'readme.md')
    ?? files.find((f) => f.kind === 'markdown')
    ?? files[0]

  if (entryFileObj) {
    entryFile = entryFileObj.path
    if (entryFileObj.kind === 'markdown') {
      const { metadata, body } = parseSkillFrontmatter(entryFileObj.content)
      if (!manifestFound) {
        if (metadata.name) parsedName = metadata.name
        if (metadata.description) parsedDesc = metadata.description
        if (metadata.author) parsedAuthor = metadata.author
        if (metadata.version) parsedVersion = metadata.version
        if (metadata.icon) parsedIcon = metadata.icon
      }

      // If no name extracted yet, inspect markdown H1 header
      if (!parsedName) {
        const h1Match = body.match(/^#\s+(.+)$/m)
        if (h1Match && h1Match[1]) {
          parsedName = h1Match[1].trim()
        }
      }

      // If no description yet, inspect first paragraph
      if (!parsedDesc) {
        const cleanLines = body
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !l.startsWith('---'))
        if (cleanLines.length > 0 && cleanLines[0]) {
          parsedDesc = cleanLines[0].slice(0, 300)
        }
      }
    }
  }

  if (!parsedName) {
    parsedName = rootDir ? rootDir.replace(/\/$/, '') : '自定义技能'
  }
  if (!parsedDesc) {
    parsedDesc = '由外部 Zip 压缩包导入的技能扩展。'
  }

  // Auto assign icon based on python / markdown composition
  if (!parsedIcon) {
    const hasPython = files.some((f) => f.kind === 'python')
    parsedIcon = hasPython ? 'code' : 'tool'
  }

  return {
    name: parsedName,
    description: parsedDesc,
    icon: parsedIcon,
    entryFile,
    files,
    author: parsedAuthor || undefined,
    version: parsedVersion || '1.0.0',
    enabled: true
  }
}
