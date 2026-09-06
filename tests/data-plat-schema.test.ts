import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { validateToolArguments } from '../src/electron/mcp/tool-policy'
import type { McpToolDefinition, McpToolParameterSchema } from '../src/shared/types'

const contracts = JSON.parse(
  readFileSync(new URL('./fixtures/data-plat/agent-tools.json', import.meta.url), 'utf8'),
) as { name: string; inputSchema: McpToolParameterSchema }[]
const samples: Record<string, Record<string, unknown>> = {
  catalog_search: {},
  dataset_get_context: { datasetId: 1 },
  metric_explain: { datasetId: 1, metricId: 2 },
  access_explain: { resource: { type: 'DATASET', id: 1 } },
  query_plan: { query: { datasetId: 1, select: [{ type: 'METRIC', id: 2 }] } },
  query_run: { planId: 'plan-test', planHash: 'hash-test' },
  query_status: { executionId: 'qry_12345678' },
  query_cancel: { executionId: 'qry_12345678' },
  report_list: {},
  report_explain: { reportId: 1 },
  report_plan: { reportId: 1 },
  report_run: { reportId: 1, planId: 'plan-test', planHash: 'hash-test' },
}

describe('locked data-plat input contracts', () => {
  it.each(contracts)('validates real $name parameters and rejects unknown fields', (contract) => {
    const tool: McpToolDefinition = { ...contract, serverId: 'data-plat-fixture', serverName: 'Data platform' }
    expect(validateToolArguments(tool, samples[contract.name])).toMatchObject({ ok: true })
    expect(validateToolArguments(tool, { ...samples[contract.name], forged: 'unknown' })).toMatchObject({ ok: false })
  })
  it('preserves draft-07/default support while failing an unsupported dialect', () => {
    const tool: McpToolDefinition = {
      name: 'legacy',
      serverId: 'legacy',
      serverName: 'legacy',
      inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
    }
    expect(validateToolArguments(tool, { value: 1 }).ok).toBe(true)
    expect(validateToolArguments(tool, { value: '1' }).ok).toBe(false)
    tool.inputSchema.$schema = 'http://json-schema.org/draft-07/schema#'
    expect(validateToolArguments(tool, { value: 1 }).ok).toBe(true)
    tool.inputSchema.$schema = 'https://example.invalid/unsupported-schema'
    expect(validateToolArguments(tool, { value: 1 }).ok).toBe(false)
  })
})
