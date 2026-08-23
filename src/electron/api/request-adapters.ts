import type {
  ApiFormat,
  ChatRequest,
  McpToolDefinition,
  Message,
  ModelConfig,
  ProviderKind,
  ProviderRouting,
  ReasoningEffort,
  WebSearchMode,
} from '../../shared/types'
import { t } from "../../shared/i18n"

export class RequestAdapterError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RequestAdapterError'
  }
}

export function buildRequestBody(
  format: ApiFormat,
  provider: { kind: ProviderKind },
  model: ModelConfig,
  messages: Message[],
  request: ChatRequest,
  maxOutputTokens: number,
  mcpTools?: McpToolDefinition[],
): Record<string, unknown> {
  const effort = request.reasoningEffort ?? model.defaultReasoningEffort
  const routing =
    provider.kind === 'openrouter' ? toWireRouting(model.providerRouting) : undefined
  const webSearchMode = resolveWebSearchMode(request, model)

  if (format === 'openai-chat-completions') {
    const body: Record<string, unknown> = {
      model: model.remoteId,
      messages: toOpenAiMessages(messages),
      stream: true,
      max_tokens: maxOutputTokens,
    }
    if (provider.kind !== 'custom') body.stream_options = { include_usage: true }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (routing) body.provider = routing
    applyOpenAiReasoning(body, provider.kind, request.reasoningEnabled, effort)
    applyOpenAiTools(body, provider.kind, webSearchMode, mcpTools)
    return body
  }

  if (format === 'openai-responses') {
    const { instructions, input } = toResponsesInput(messages)
    const body: Record<string, unknown> = {
      model: model.remoteId,
      input,
      stream: true,
      max_output_tokens: maxOutputTokens,
    }
    if (instructions) body.instructions = instructions
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (routing) body.provider = routing
    if (request.reasoningEnabled) {
      body.reasoning =
        provider.kind === 'openrouter'
          ? { enabled: true, effort, exclude: false }
          : { effort }
    }
    else if (provider.kind === 'openrouter' || provider.kind === 'cliproxy') {
      body.reasoning = { effort: 'none' }
    }
    applyResponsesTools(body, provider.kind, webSearchMode, mcpTools)
    return body
  }

  const { system, conversation } = toAnthropicMessages(messages)
  const body: Record<string, unknown> = {
    model: model.remoteId,
    messages: conversation,
    stream: true,
    max_tokens: maxOutputTokens,
  }
  if (system) body.system = system
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (routing) body.provider = routing
  if (!request.reasoningEnabled) {
    body.thinking = { type: 'disabled' }
  } else if ((model.anthropicThinkingMode ?? 'adaptive') === 'adaptive') {
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort: effort === 'minimal' ? 'low' : effort }
  } else {
    body.thinking = {
      type: 'enabled',
      budget_tokens: reasoningBudget(effort, maxOutputTokens),
    }
  }
  applyAnthropicTools(body, provider.kind, webSearchMode, mcpTools)
  return body
}

export function resolveWebSearchMode(
  request: Pick<ChatRequest, 'webSearchMode'>,
  model: Pick<ModelConfig, 'defaultWebSearchMode'>,
): WebSearchMode {
  return request.webSearchMode ?? model.defaultWebSearchMode ?? 'off'
}

export function toOpenAiMessages(messages: Message[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'system') {
      result.push({ role: 'system', content: message.content })
      continue
    }
    if (message.role === 'assistant' && hasAgentHistory(message)) {
      for (const group of agentTurnGroups(message)) {
        if (group.calls.length > 0) {
          result.push({
            role: 'assistant',
            content: group.text || null,
            tool_calls: group.calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.modelToolName, arguments: JSON.stringify(call.args) },
            })),
          })
          for (const call of group.calls) {
            const toolResult = group.results.get(call.id)
            result.push({ role: 'tool', tool_call_id: call.id, content: toolResult?.result ?? '' })
          }
        } else if (group.text) {
          result.push({ role: 'assistant', content: group.text })
        }
      }
      continue
    }
    if (!message.attachments?.length) {
      result.push({ role: message.role, content: message.content })
      continue
    }
    const parts: Array<Record<string, unknown>> = []
    if (message.content) {
      parts.push({ type: 'text', text: message.content })
    }
    for (const att of message.attachments) {
      if (att.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: att.data },
        })
      } else if (att.type === 'text') {
        parts.push({
          type: 'text',
          text: `\n[Attached File: ${att.name}]\n\`\`\`\n${att.data}\n\`\`\``,
        })
      } else if (att.type === 'document') {
        parts.push({
          type: 'text',
          text: `\n[Attached Document: ${att.name}]`,
        })
      }
    }
    result.push({
      role: message.role,
      content: parts.length > 0 ? parts : message.content,
    })
  }
  return result
}

export function toResponsesInput(messages: Message[]): {
  instructions: string
  input: Array<Record<string, unknown>>
} {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const input: Array<Record<string, unknown>> = []
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'assistant') {
      if (hasAgentHistory(message)) {
        for (const group of agentTurnGroups(message)) {
          for (const item of group.providerItems) input.push(structuredClone(item))
          if (group.text) input.push(toResponsesAssistantMessage(`${message.id}-${group.turn}`, group.text))
          for (const call of group.calls) {
            input.push({
              type: 'function_call',
              call_id: call.id,
              name: call.modelToolName,
              arguments: JSON.stringify(call.args),
            })
            const result = group.results.get(call.id)
            input.push({
              type: 'function_call_output',
              call_id: call.id,
              output: toResponsesToolOutput(result),
            })
          }
        }
      } else {
        input.push(toResponsesAssistantMessage(message.id, message.content))
      }
      continue
    }
      const contentList: Array<Record<string, unknown>> = []
      if (message.content) {
        contentList.push({ type: 'input_text', text: message.content })
      }
      if (message.attachments?.length) {
        for (const att of message.attachments) {
          if (att.type === 'image') {
            contentList.push({ type: 'input_image', image_url: att.data })
          } else if (att.type === 'text') {
            contentList.push({
              type: 'input_text',
              text: `\n[Attached File: ${att.name}]\n\`\`\`\n${att.data}\n\`\`\``,
            })
          } else if (att.type === 'document') {
            contentList.push({
              type: 'input_text',
              text: `\n[Attached Document: ${att.name}]`,
            })
          }
        }
      }
      if (contentList.length === 0) {
        contentList.push({ type: 'input_text', text: message.content })
      }
      input.push({
        type: 'message',
        role: 'user',
        content: contentList,
      })
  }
  return { instructions, input }
}

export function toWireRouting(
  routing?: ProviderRouting,
): Record<string, unknown> | undefined {
  if (!routing) return undefined
  return removeUndefined({
    order: routing.order,
    only: routing.only,
    allow_fallbacks: routing.allowFallbacks,
    require_parameters: routing.requireParameters,
    data_collection: routing.dataCollection,
    zdr: routing.zdr,
    sort: routing.sort,
  })
}

function applyOpenAiReasoning(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  enabled: boolean,
  effort: Exclude<ReasoningEffort, 'none'>,
): void {
  if (providerKind === 'openrouter') {
    body.reasoning = enabled
      ? { enabled: true, effort, exclude: false }
      : { effort: 'none' }
  } else if (providerKind === 'cliproxy') {
    body.reasoning_effort = enabled ? effort : 'none'
  } else if (enabled) {
    body.reasoning_effort = effort
  }
}

function applyOpenAiTools(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  webSearchMode: WebSearchMode,
  mcpTools?: McpToolDefinition[],
): void {
  const tools: Array<Record<string, unknown>> = []
  if (webSearchMode !== 'off') {
    if (providerKind !== 'openrouter') {
      throw new RequestAdapterError(
        t("网页搜索仅支持 OpenRouter 连接；请关闭网页搜索或切换服务商。"),
        'web_search_not_supported',
      )
    }
    tools.push({
      type: 'openrouter:web_search',
      parameters: {
        engine: webSearchMode,
        max_results: 5,
        max_uses: 2,
        max_total_results: 8,
      },
    })
    body.max_tool_calls = 2
  }
  if (mcpTools?.length) {
    for (const tool of mcpTools) {
      tools.push({
        type: 'function',
        function: {
          name: tool.modelName || tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })
    }
  }
  if (tools.length > 0) {
    body.tools = tools
  }
}

function applyResponsesTools(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  webSearchMode: WebSearchMode,
  mcpTools?: McpToolDefinition[],
): void {
  const tools: Array<Record<string, unknown>> = []
  if (webSearchMode !== 'off') {
    if (providerKind !== 'openrouter') {
      throw new RequestAdapterError(
        t("网页搜索仅支持 OpenRouter 连接；请关闭网页搜索或切换服务商。"),
        'web_search_not_supported',
      )
    }
    tools.push({
      type: 'openrouter:web_search',
      parameters: {
        engine: webSearchMode,
        max_results: 5,
        max_uses: 2,
        max_total_results: 8,
      },
    })
    body.max_tool_calls = 2
  }
  if (mcpTools?.length) {
    for (const tool of mcpTools) {
      tools.push({
        type: 'function',
        name: tool.modelName || tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })
    }
  }
  if (tools.length > 0) {
    body.tools = tools
  }
}

function applyAnthropicTools(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  webSearchMode: WebSearchMode,
  mcpTools?: McpToolDefinition[],
): void {
  const tools: Array<Record<string, unknown>> = []
  if (webSearchMode !== 'off') {
    if (providerKind !== 'openrouter') {
      throw new RequestAdapterError(
        t("网页搜索仅支持 OpenRouter 连接；请关闭网页搜索或切换服务商。"),
        'web_search_not_supported',
      )
    }
    tools.push({
      type: 'openrouter:web_search',
      parameters: {
        engine: webSearchMode,
        max_results: 5,
        max_uses: 2,
        max_total_results: 8,
      },
    })
    body.max_tool_calls = 2
  }
  if (mcpTools?.length) {
    for (const tool of mcpTools) {
      tools.push({
        name: tool.modelName || tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })
    }
  }
  if (tools.length > 0) {
    body.tools = tools
  }
}

function reasoningBudget(
  effort: Exclude<ReasoningEffort, 'none'>,
  maxOutputTokens: number,
): number {
  if (maxOutputTokens <= 1_024) {
    throw new RequestAdapterError(
      t("Anthropic 思考模式要求最大输出长度大于 1024 token。"),
      'invalid_reasoning_budget',
    )
  }
  const ratios: Record<Exclude<ReasoningEffort, 'none'>, number> = {
    minimal: 0.1,
    low: 0.2,
    medium: 0.5,
    high: 0.8,
    xhigh: 0.95,
    max: 0.95,
  }
  return Math.min(
    maxOutputTokens - 1,
    Math.max(1_024, Math.floor(maxOutputTokens * ratios[effort])),
  )
}

export function toAnthropicContentBlocks(message: Message): string | Array<Record<string, unknown>> {
  if (!message.attachments?.length) return message.content
  const blocks: Array<Record<string, unknown>> = []
  if (message.content) {
    blocks.push({ type: 'text', text: message.content })
  }
  for (const att of message.attachments) {
    if (att.type === 'image') {
      const match = att.data.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/)
      if (match && match[1] && match[2]) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2],
          },
        })
      }
    } else if (att.type === 'document') {
      const match = att.data.match(/^data:(application\/pdf);base64,(.+)$/)
      if (match && match[1] && match[2]) {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: match[2],
          },
        })
      } else {
        blocks.push({
          type: 'text',
          text: `\n[Attached Document: ${att.name}]`,
        })
      }
    } else if (att.type === 'text') {
      blocks.push({
        type: 'text',
        text: `\n[Attached File: ${att.name}]\n\`\`\`\n${att.data}\n\`\`\``,
      })
    }
  }
  if (blocks.length === 0) return message.content
  return blocks
}

export function toAnthropicMessages(messages: Message[]): {
  system: string
  conversation: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const conversation: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant' && hasAgentHistory(message)) {
      for (const group of agentTurnGroups(message)) {
        const contentBlocks: Array<Record<string, unknown>> = []
        for (const block of group.thinking.sort((left, right) => left.blockIndex - right.blockIndex)) {
          if (block.signature) {
            contentBlocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
          }
        }
        if (group.text) contentBlocks.push({ type: 'text', text: group.text })
        for (const call of group.calls) {
          contentBlocks.push({ type: 'tool_use', id: call.id, name: call.modelToolName, input: call.args })
        }
        if (contentBlocks.length) conversation.push({ role: 'assistant', content: contentBlocks })
        if (group.calls.length) {
          conversation.push({
            role: 'user',
            content: group.calls.map((call) => {
              const result = group.results.get(call.id)
              return {
                type: 'tool_result',
                tool_use_id: call.id,
                content: toAnthropicToolResultContent(result),
                is_error: result?.isError,
              }
            }),
          })
        }
      }
      continue
    }
    const formattedContent = toAnthropicContentBlocks(message)
    const previous = conversation.at(-1)
    if (previous?.role === message.role) {
      if (typeof previous.content === 'string' && typeof formattedContent === 'string') {
        previous.content += `\n\n${formattedContent}`
      } else {
        const prevBlocks: Array<Record<string, unknown>> = typeof previous.content === 'string'
          ? [{ type: 'text', text: previous.content }]
          : previous.content
        const nextBlocks: Array<Record<string, unknown>> = typeof formattedContent === 'string'
          ? [{ type: 'text', text: formattedContent }]
          : formattedContent
        previous.content = [...prevBlocks, ...nextBlocks]
      }
    } else {
      conversation.push({ role: message.role, content: formattedContent })
    }
  }
  return { system, conversation }
}

function toResponsesMessageId(id: string): string {
  const safeId = id.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 120)
  return safeId.startsWith('msg_') ? safeId : `msg_${safeId || 'local'}`
}

interface AgentTurnCall {
  id: string
  toolName: string
  modelToolName: string
  args: Record<string, unknown>
}

interface AgentTurnResult {
  result: string
  resultContent?: import('../../shared/types').McpToolResultContent[]
  structuredResult?: Record<string, unknown>
  isError?: boolean
}

interface AgentTurnGroup {
  turn: number
  text: string
  thinking: Array<{ blockIndex: number; thinking: string; signature?: string }>
  providerItems: Record<string, unknown>[]
  calls: AgentTurnCall[]
  results: Map<string, AgentTurnResult>
}

function hasAgentHistory(message: Message): boolean {
  return Boolean(message.agentTrace?.length || message.toolExecutions?.length)
}

function agentTurnGroups(message: Message): AgentTurnGroup[] {
  const groups = new Map<number, AgentTurnGroup>()
  const getGroup = (turn: number): AgentTurnGroup => {
    let group = groups.get(turn)
    if (!group) {
      group = { turn, text: '', thinking: [], providerItems: [], calls: [], results: new Map() }
      groups.set(turn, group)
    }
    return group
  }

  if (message.agentTrace?.length) {
    for (const item of message.agentTrace) {
      const group = getGroup(item.turn)
      if (item.type === 'assistant_text') group.text += item.text
      else if (item.type === 'assistant_thinking') {
        const existing = group.thinking.find((block) => block.blockIndex === item.blockIndex)
        if (existing) {
          existing.thinking += item.thinking
          existing.signature = `${existing.signature || ''}${item.signature || ''}` || undefined
        } else {
          group.thinking.push({ blockIndex: item.blockIndex, thinking: item.thinking, signature: item.signature })
        }
      } else if (item.type === 'tool_call') {
        group.calls.push({
          id: item.callId,
          toolName: item.toolName,
          modelToolName: item.modelToolName,
          args: item.args,
        })
      } else if (item.type === 'provider_item') {
        group.providerItems.push(item.item)
      } else {
        group.results.set(item.callId, {
          result: item.result,
          resultContent: item.resultContent,
          structuredResult: item.structuredResult,
          isError: item.isError,
        })
      }
    }
    return Array.from(groups.values()).sort((left, right) => left.turn - right.turn)
  }

  for (const execution of message.toolExecutions || []) {
    const group = getGroup(execution.turn || 1)
    group.calls.push({
      id: execution.id,
      toolName: execution.toolName,
      modelToolName: execution.modelToolName || execution.toolName,
      args: execution.args,
    })
    group.results.set(execution.id, {
      result: execution.result || '',
      resultContent: execution.resultContent,
      structuredResult: execution.structuredResult,
      isError: execution.isError,
    })
  }
  if (message.content) {
    const lastTurn = Math.max(0, ...groups.keys()) + 1
    getGroup(lastTurn).text = message.content
  }
  return Array.from(groups.values()).sort((left, right) => left.turn - right.turn)
}

function toResponsesAssistantMessage(id: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    id: toResponsesMessageId(id),
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

function toResponsesToolOutput(result?: AgentTurnResult): string | Array<Record<string, unknown>> {
  if (!result?.resultContent?.some((item) => item.type === 'image' && item.data)) {
    return result?.result || ''
  }
  const content: Array<Record<string, unknown>> = []
  for (const item of result.resultContent) {
    if (item.type === 'text') content.push({ type: 'input_text', text: item.text })
    else if (item.type === 'image' && item.data) {
      content.push({ type: 'input_image', image_url: `data:${item.mimeType};base64,${item.data}` })
    } else if (item.type === 'resource' && item.text) {
      content.push({ type: 'input_text', text: item.text })
    }
  }
  if (result.structuredResult) content.push({ type: 'input_text', text: JSON.stringify(result.structuredResult) })
  return content.length ? content : result.result
}

function toAnthropicToolResultContent(result?: AgentTurnResult): string | Array<Record<string, unknown>> {
  if (!result?.resultContent?.some((item) => item.type === 'image' && item.data)) {
    return result?.result || ''
  }
  const content: Array<Record<string, unknown>> = []
  for (const item of result.resultContent) {
    if (item.type === 'text') content.push({ type: 'text', text: item.text })
    else if (item.type === 'image' && item.data) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: item.mimeType, data: item.data },
      })
    } else if (item.type === 'resource' && item.text) content.push({ type: 'text', text: item.text })
  }
  if (result.structuredResult) content.push({ type: 'text', text: JSON.stringify(result.structuredResult) })
  return content.length ? content : result.result
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>
}
