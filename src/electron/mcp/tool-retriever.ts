import type { McpToolDefinition, McpToolRetrievalMode } from '../../shared/types'

export interface ToolRetrievalOptions {
  mode?: McpToolRetrievalMode
  maxTools?: number
  minScore?: number
}

/** BM25 retrieval over tool names, descriptions, server metadata and parameter schemas. */
export function retrieveRelevantTools(
  query: string,
  tools: McpToolDefinition[],
  options: ToolRetrievalOptions = {},
): McpToolDefinition[] {
  const mode = options.mode ?? 'auto'
  const maxTools = Math.max(1, options.maxTools ?? 6)
  if (mode === 'all') return tools

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0 || tools.length === 0) return []
  const documents = tools.map(toolDocument)
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1)
    }
  }

  const scored = tools.map((tool, index) => ({
    tool,
    score: bm25Score(
      tool,
      documents[index] || [],
      queryTerms,
      documentFrequency,
      documents.length,
      averageLength,
      query,
    ),
  }))
  scored.sort((left, right) => right.score - left.score || (left.tool.modelName || left.tool.name).localeCompare(right.tool.modelName || right.tool.name))
  const minScore = options.minScore ?? 0.75
  return scored.filter((item) => item.score >= minScore).slice(0, maxTools).map((item) => item.tool)
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []
  const terms: string[] = []
  for (const word of words) {
    if (word.length >= 2) terms.push(word)
    if (/[\u4e00-\u9fa5]/.test(word) && word.length >= 2) {
      for (let index = 0; index < word.length - 1; index += 1) terms.push(word.slice(index, index + 2))
    }
  }
  return terms
}

function toolDocument(tool: McpToolDefinition): string[] {
  const properties = tool.inputSchema.properties || {}
  const propertyText = Object.entries(properties).map(([name, schema]) => {
    const description = typeof schema === 'object' && schema !== null && 'description' in schema
      ? String((schema as Record<string, unknown>).description)
      : ''
    return `${name} ${description}`
  }).join(' ')
  return tokenize(`${tool.name} ${tool.name} ${tool.serverName} ${tool.description || ''} ${propertyText}`)
}

function bm25Score(
  tool: McpToolDefinition,
  document: string[],
  queryTerms: string[],
  frequencies: Map<string, number>,
  totalDocuments: number,
  averageLength: number,
  rawQuery: string,
): number {
  const counts = new Map<string, number>()
  for (const term of document) counts.set(term, (counts.get(term) || 0) + 1)
  const k1 = 1.5
  const b = 0.75
  let score = 0
  for (const term of new Set(queryTerms)) {
    const tf = counts.get(term) || 0
    if (!tf) continue
    const df = frequencies.get(term) || 0
    const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5))
    const denominator = tf + k1 * (1 - b + b * (document.length / Math.max(1, averageLength)))
    score += idf * ((tf * (k1 + 1)) / denominator)
  }
  const normalizedQuery = rawQuery.toLowerCase()
  if (normalizedQuery.includes(tool.name.toLowerCase())) score += 8
  for (const part of tool.name.toLowerCase().split(/[-_.]/).filter((item) => item.length >= 2)) {
    if (normalizedQuery.includes(part)) score += 1.5
  }
  return score
}
