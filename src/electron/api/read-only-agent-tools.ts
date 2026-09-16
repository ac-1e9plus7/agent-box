import type { McpToolDefinition, Skill } from '../../shared/types'
import {
  DYNAMIC_TOOL_SEARCH_SERVER_ID,
  SKILL_RESOURCE_READER_SERVER_ID,
  TOOL_RESULT_READER_SERVER_ID,
} from '../../shared/builtin-agent-tools'
import { t } from '../../shared/i18n'
import {
  formatFullToolResult,
  readTextChunk,
  searchAdditionalTools,
  type FullToolResultStore,
} from './agent-token-optimization'

interface ReadOnlyToolContext {
  fullToolResults: FullToolResultStore
  toolResultMaxCharacters: number
  toolResultCompactionEnabled: boolean
  activeSkills: Skill[]
  authorizedAgentTools: McpToolDefinition[]
  effectiveAgentTools: McpToolDefinition[]
  dynamicToolLimit: number
}

interface ReadOnlyToolResult {
  result: string
  isError: boolean
  approvalReason: string
  loadedTools?: McpToolDefinition[]
}

/** Receives only the already validated, request-authorized in-memory catalog. */
export function executeReadOnlyAgentTool(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  context: ReadOnlyToolContext,
): ReadOnlyToolResult | undefined {
  if (tool.serverId === TOOL_RESULT_READER_SERVER_ID) {
    const callId = typeof args.call_id === 'string' ? args.call_id : ''
    const stored = context.fullToolResults.get(callId)
    return {
      result: stored
        ? readChunk(formatFullToolResult(stored), args, Math.max(256, context.toolResultMaxCharacters - 512), {
            call_id: callId,
          })
        : t('No complete tool result is available for call ID {value0}.', { value0: callId || t('(empty)') }),
      isError: !stored,
      approvalReason: t('Read a previously completed local tool result without executing the tool again.'),
    }
  }
  if (tool.serverId === DYNAMIC_TOOL_SEARCH_SERVER_ID) {
    const query = typeof args.query === 'string' ? args.query : ''
    const limit = typeof args.max_tools === 'number' ? args.max_tools : context.dynamicToolLimit
    const loadedTools = searchAdditionalTools(
      query,
      context.authorizedAgentTools,
      context.effectiveAgentTools,
      Math.min(limit, context.dynamicToolLimit),
    )
    return {
      result: loadedTools.length
        ? t('The following authorized tools are now exposed for the next model turn:\n{value0}', {
            value0: loadedTools
              .map((item) => `- ${item.modelName || item.name} (${item.serverName}): ${item.description || item.name}`)
              .join('\n'),
          })
        : t('No additional authorized tools matched this search.'),
      isError: false,
      approvalReason: t('Search the request-authorized local tool catalog without executing a matched tool.'),
      loadedTools,
    }
  }
  if (tool.serverId === SKILL_RESOURCE_READER_SERVER_ID) {
    const skill = context.activeSkills.find((item) => item.id === args.skill_id)
    const resource = skill?.files.find(
      (file) =>
        file.path === args.path && file.path !== skill.entryFile && ['markdown', 'python', 'shell'].includes(file.kind),
    )
    return {
      result:
        skill && resource
          ? readChunk(
              resource.content,
              args,
              context.toolResultCompactionEnabled ? Math.max(256, context.toolResultMaxCharacters - 512) : 32_000,
              {
                skill_id: skill.id,
                path: resource.path,
                kind: resource.kind,
                scripts_are_reference_only: resource.kind === 'python' || resource.kind === 'shell',
              },
            )
          : t('The requested active Skill resource was not found or is not readable.'),
      isError: !skill || !resource,
      approvalReason: t('Read a local active Skill reference resource without executing scripts.'),
    }
  }
  return undefined
}

function readChunk(
  text: string,
  args: Record<string, unknown>,
  budget: number,
  metadata: Record<string, unknown>,
): string {
  const chunk = readTextChunk(
    text,
    typeof args.offset === 'number' ? args.offset : 0,
    Math.min(typeof args.max_characters === 'number' ? args.max_characters : 8_000, budget),
  )
  return `${JSON.stringify({ ...metadata, offset: chunk.offset, next_offset: chunk.nextOffset, total_characters: chunk.totalCharacters, has_more: chunk.hasMore })}\n${chunk.text}`
}
