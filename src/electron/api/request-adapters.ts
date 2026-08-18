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
    if (message.role === 'assistant' && message.toolExecutions?.length) {
      const toolCalls = message.toolExecutions.map((exec) => ({
        id: exec.id,
        type: 'function',
        function: {
          name: exec.toolName,
          arguments: JSON.stringify(exec.args),
        },
      }))
      result.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: toolCalls,
      })
      for (const exec of message.toolExecutions) {
        result.push({
          role: 'tool',
          tool_call_id: exec.id,
          content: exec.result ?? '',
        })
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
  const input = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'assistant') {
        return {
          type: 'message',
          id: toResponsesMessageId(message.id),
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: message.content, annotations: [] }],
        }
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
      return {
        type: 'message',
        role: 'user',
        content: contentList,
      }
    })
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
        '网页搜索仅支持 OpenRouter 连接；请关闭网页搜索或切换服务商。',
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
          name: tool.name,
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
        '网页搜索仅支持 OpenRouter 连接；请关闭网页搜索或切换服务商。',
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
        name: tool.name,
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
        '网页搜索仅支持 OpenRouter 连接；请关闭网页搜索或切换服务商。',
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
        name: tool.name,
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
      'Anthropic 思考模式要求最大输出长度大于 1024 token。',
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
    if (message.role === 'assistant' && message.toolExecutions?.length) {
      const contentBlocks: Array<Record<string, unknown>> = []
      if (message.content) {
        contentBlocks.push({ type: 'text', text: message.content })
      }
      for (const exec of message.toolExecutions) {
        contentBlocks.push({
          type: 'tool_use',
          id: exec.id,
          name: exec.toolName,
          input: exec.args,
        })
      }
      const toolResults: Array<Record<string, unknown>> = message.toolExecutions.map((exec) => ({
        type: 'tool_result',
        tool_use_id: exec.id,
        content: exec.result ?? '',
        is_error: exec.isError,
      }))
      conversation.push({ role: 'assistant', content: contentBlocks })
      conversation.push({ role: 'user', content: toolResults })
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

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>
}
