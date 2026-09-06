import type { Message } from '../../shared/types'

/** Main-process journal: no tokens, rows, filters, or model-generated summaries. */
export interface DataPlatOperation {
  key: string
  conversationId: string
  serverId: string
  identity: string
  toolName: string
  executionId: string
  planId: string
  createdAt: string
}

export function parseDataPlatOperations(value: unknown): DataPlatOperation[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid data-plat journal')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid data-plat operation')
    const raw = item as Record<string, unknown>
    const fields = [
      'key',
      'conversationId',
      'serverId',
      'identity',
      'toolName',
      'executionId',
      'planId',
      'createdAt',
    ] as const
    for (const field of fields) {
      if (typeof raw[field] !== 'string' || raw[field].length > 256)
        throw new Error('Invalid data-plat operation field')
    }
    if (
      !/^qry_[A-Za-z0-9_-]{8,60}$/.test(String(raw.executionId)) ||
      !Number.isFinite(Date.parse(String(raw.createdAt)))
    ) {
      throw new Error('Invalid data-plat execution reference')
    }
    return Object.fromEntries(fields.map((field) => [field, raw[field]])) as unknown as DataPlatOperation
  })
}

export const DATA_PLAT_TOOLS = new Set([
  'catalog_search',
  'dataset_get_context',
  'metric_explain',
  'access_explain',
  'query_plan',
  'query_run',
  'query_status',
  'query_cancel',
  'report_list',
  'report_explain',
  'report_plan',
  'report_run',
])

export function hasDataPlatHistory(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.governedData === true ||
      message.toolExecutions?.some((tool) => DATA_PLAT_TOOLS.has(tool.toolName)) ||
      message.agentTrace?.some((item) => item.type === 'tool_call' && DATA_PLAT_TOOLS.has(item.toolName)),
  )
}

/** Never replay old assistant text, tool rows, reasoning, attachments, or opaque provider handles. */
export function dataPlatUserHistory(messages: readonly Message[]): Message[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      id: message.id,
      role: 'user',
      content: message.content,
      attachments: message.attachments,
      createdAt: message.createdAt,
    }))
}
