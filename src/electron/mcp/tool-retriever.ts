import type { McpToolDefinition, McpToolRetrievalMode } from '../../shared/types'

export interface ToolRetrievalOptions {
  mode?: McpToolRetrievalMode
  maxTools?: number
}

/**
 * Pure tool retrieval algorithm using keyword overlap, name matching and TF-IDF/BM25 scoring.
 */
export function retrieveRelevantTools(
  query: string,
  tools: McpToolDefinition[],
  options: ToolRetrievalOptions = {},
): McpToolDefinition[] {
  const mode = options.mode ?? 'auto'
  const maxTools = options.maxTools ?? 6

  if (tools.length <= maxTools || mode === 'all') {
    return tools
  }

  const queryTerms = extractQueryTerms(query)
  if (queryTerms.length === 0) {
    return tools.slice(0, maxTools)
  }

  const scored = tools.map((tool) => ({
    tool,
    score: scoreTool(tool, queryTerms, query),
  }))

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score)

  const top = scored.slice(0, maxTools).map((item) => item.tool)
  return top
}

function extractQueryTerms(text: string): string[] {
  const normalized = text.toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) || []
  const terms = new Set<string>()

  for (const w of words) {
    if (w.length >= 2) terms.add(w)
    if (/[\u4e00-\u9fa5]/.test(w) && w.length >= 4) {
      for (let i = 0; i < w.length - 1; i++) {
        terms.add(w.slice(i, i + 2))
      }
    }
  }

  return Array.from(terms)
}

function scoreTool(tool: McpToolDefinition, terms: string[], rawQuery: string): number {
  let score = 0
  const name = tool.name.toLowerCase()
  const desc = (tool.description || '').toLowerCase()
  const rawQueryLower = rawQuery.toLowerCase()

  // 1. Direct tool name in query
  if (rawQueryLower.includes(name)) {
    score += 15.0
  }
  const nameParts = name.split(/[-_.]/).filter(Boolean)
  for (const part of nameParts) {
    if (part.length >= 2 && rawQueryLower.includes(part)) {
      score += 4.0
    }
  }

  // 2. Terms in name / description
  for (const term of terms) {
    if (name.includes(term)) {
      score += 5.0
    }
    if (desc.includes(term)) {
      score += 2.0
    }
  }

  // 3. Terms in parameter properties
  if (tool.inputSchema?.properties && typeof tool.inputSchema.properties === 'object') {
    const props = Object.entries(tool.inputSchema.properties)
    for (const [propName, propVal] of props) {
      const pName = propName.toLowerCase()
      const pDesc = typeof propVal === 'object' && propVal !== null && 'description' in propVal
        ? String((propVal as Record<string, unknown>).description).toLowerCase()
        : ''

      for (const term of terms) {
        if (pName.includes(term)) score += 1.5
        if (pDesc.includes(term)) score += 1.0
      }
    }
  }

  return score
}
