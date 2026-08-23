import type { Message, Skill } from '../../shared/types'
import { tokenize } from '../mcp/tool-retriever'

const GENERIC_TERMS = new Set([
  '一个', '一下', '这个', '那个', '什么', '怎么', '如何', '为什么', '是否', '可以',
  '帮我', '请帮', '需要', '使用', '进行', '内容', '任务', '问题', '分析',
])

/**
 * Builds a bounded routing query from recent user context and attachment metadata.
 * Text attachments contribute a short excerpt; binary/data-URL payloads never do.
 */
export function buildSkillRetrievalQuery(messages: Message[]): string {
  return messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .flatMap((message) => {
      const attachmentText = (message.attachments ?? []).flatMap((attachment) => {
        const metadata = `${attachment.name} ${attachment.mimeType}`
        if (attachment.type !== 'text' || attachment.data.startsWith('data:')) return [metadata]
        return [metadata, attachment.data.slice(0, 2_000)]
      })
      return [message.content, ...attachmentText]
    })
    .filter(Boolean)
    .join('\n')
}

/** Finds direct `$id`, `@id`, exact id, or full-name mentions before fuzzy routing. */
export function retrieveExplicitlyMentionedSkills(query: string, skills: Skill[]): Skill[] {
  const normalizedQuery = query.toLowerCase()
  return skills.filter((skill) => {
    const id = skill.id.toLowerCase()
    const name = skill.name.toLowerCase()
    return normalizedQuery.includes(`$${id}`)
      || normalizedQuery.includes(`@${id}`)
      || normalizedQuery.includes(name)
      || containsDelimitedIdentifier(normalizedQuery, id)
  })
}

export function retrieveRelevantSkills(query: string, skills: Skill[], maxSkills = 2): Skill[] {
  const normalizedQuery = query.toLowerCase()
  const explicitIds = new Set(retrieveExplicitlyMentionedSkills(query, skills).map((skill) => skill.id))
  const queryTerms = Array.from(new Set(tokenize(query))).filter((term) => !GENERIC_TERMS.has(term))
  if (queryTerms.length === 0 && explicitIds.size === 0) return []

  return skills
    .map((skill) => {
      const searchable = skillSearchDocument(skill)
      let score = explicitIds.has(skill.id) ? 100 : 0

      for (const term of queryTerms) {
        if (!searchable.includes(term)) continue
        if (/^[a-z0-9_]+$/i.test(term)) score += term.length >= 3 ? 3 : 1
        else score += term.length >= 4 ? 3 : 2
      }

      // Descriptions are concise trigger metadata; matching a complete phrase
      // should outweigh incidental body-word overlap.
      for (const phrase of splitTriggerPhrases(skill.description)) {
        if (normalizedQuery.includes(phrase)) score += 8
      }

      return { skill, score }
    })
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, Math.max(1, maxSkills))
    .map((item) => item.skill)
}

function skillSearchDocument(skill: Skill): string {
  const fileText = skill.files
    .slice(0, 20)
    .map((file) => `${file.path} ${file.content.slice(0, 4_000)}`)
    .join(' ')
  return `${skill.id} ${skill.name} ${skill.description} ${fileText} ${skill.systemPrompt || ''}`.toLowerCase()
}

function splitTriggerPhrases(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[，。；、,;/|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 20)
}

function containsDelimitedIdentifier(query: string, id: string): boolean {
  let startIndex = query.indexOf(id)
  while (startIndex >= 0) {
    const before = query[startIndex - 1]
    const after = query[startIndex + id.length]
    const boundary = (value: string | undefined) => !value || !/[a-z0-9_-]/i.test(value)
    if (boundary(before) && boundary(after)) return true
    startIndex = query.indexOf(id, startIndex + id.length)
  }
  return false
}
