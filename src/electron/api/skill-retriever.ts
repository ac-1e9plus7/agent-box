import type { Skill } from '../../shared/types'
import { tokenize } from '../mcp/tool-retriever'

export function retrieveRelevantSkills(query: string, skills: Skill[], maxSkills = 2): Skill[] {
  const queryTerms = new Set(tokenize(query))
  if (queryTerms.size === 0) return []
  return skills
    .map((skill) => {
      const entry = skill.files.find((file) => file.path === skill.entryFile)?.content || skill.systemPrompt || ''
      const searchable = `${skill.id} ${skill.name} ${skill.description} ${entry.slice(0, 4_000)}`.toLowerCase()
      let score = 0
      if (query.toLowerCase().includes(skill.name.toLowerCase()) || query.toLowerCase().includes(skill.id.toLowerCase())) score += 20
      for (const term of queryTerms) if (searchable.includes(term)) score += term.length >= 4 ? 2 : 1
      return { skill, score }
    })
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, Math.max(1, maxSkills))
    .map((item) => item.skill)
}
