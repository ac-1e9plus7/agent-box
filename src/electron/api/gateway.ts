import { ProxyAgent } from 'undici'
import type {
  ApiFormat,
  ChatError,
  ChatRequest,
  McpToolDefinition,
  Message,
  ProviderTestResult,
  RemoteModel,
  Skill,
  StreamEvent,
  ToolCallExecution,
  WebCitation,
} from '../../shared/types'
import { McpManager } from '../mcp/mcp-manager'
import { retrieveRelevantTools } from '../mcp/tool-retriever'
import { AppRepository, type StoredProvider } from '../storage/app-repository'
import {
  ContextWindowError,
  prepareMessagesForContext,
  resolveContextManagementMode,
} from './context-window'
import { toRemoteModel } from './model-catalog'
import {
  parseAnthropicEvent,
  parseChatCompletionEvent,
  parseResponsesEvent,
  type ProtocolErrorData,
} from './protocol-adapters'
import { buildRequestBody, RequestAdapterError } from './request-adapters'
import {
  buildProviderHeaders,
  providerHasUsableAuthentication,
} from './provider-policy'
import { parseSse } from './sse'
import {
  createCitationEmissionState,
  takeChangedWebCitations,
  type CitationEmissionState,
} from '../storage/web-metadata-schema'

type StreamEmitter = (event: StreamEvent) => void

const MODEL_DISCOVERY_TIMEOUT_MS = 30_000
const MAX_MODEL_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 32 * 1024

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export class ChatGateway {
  private readonly controllers = new Map<string, AbortController>()
  private proxyAgent: ProxyAgent | undefined
  private proxyUrl: string | undefined

  constructor(
    private readonly repository: AppRepository,
    private readonly mcpManager?: McpManager,
  ) {}

  /**
   * Returns a cached undici `ProxyAgent` for the configured custom proxy, or
   * `undefined` to connect directly. The agent is recreated when the stored
   * URL changes; the previous one is closed best-effort to release sockets.
   * Reads settings live so proxy changes take effect on the next request.
   */
  private resolveDispatcher(): ProxyAgent | undefined {
    const { proxy } = this.repository.getSettings()
    if (proxy.mode !== 'custom' || !proxy.url) {
      if (this.proxyAgent) {
        void this.proxyAgent.close().catch(() => undefined)
        this.proxyAgent = undefined
        this.proxyUrl = undefined
      }
      return undefined
    }
    if (this.proxyUrl !== proxy.url) {
      if (this.proxyAgent) {
        void this.proxyAgent.close().catch(() => undefined)
      }
      this.proxyAgent = new ProxyAgent(proxy.url)
      this.proxyUrl = proxy.url
    }
    return this.proxyAgent
  }

  /**
   * Merges a custom proxy `dispatcher` into fetch options. The standard
   * `RequestInit` type does not declare `dispatcher`, but Node's undici-based
   * `fetch` honors it at runtime; attaching it here keeps the call sites typed
   * while routing through the configured proxy.
   */
  private withProxy(options: RequestInit): RequestInit {
    const dispatcher = this.resolveDispatcher()
    if (!dispatcher) return options
    const merged: RequestInit = { ...options }
    ;(merged as RequestInit & { dispatcher?: ProxyAgent }).dispatcher = dispatcher
    return merged
  }

  async stream(
    requestId: string,
    request: ChatRequest,
    emit: StreamEmitter,
  ): Promise<void> {
    if (this.controllers.has(requestId)) throw new Error('Duplicate request id')
    const controller = new AbortController()
    let requestSecret: string | undefined
    this.controllers.set(requestId, controller)
    emit({ type: 'start', requestId })

    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const resetStallTimer = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(
        () => controller.abort(new GatewayError('请求流已停滞超过 120 秒，自动中断。', 'request_timeout')),
        120_000,
      )
    }

    try {
      resetStallTimer()
      const requestMessages = validateChatRequest(request)
      const model = this.repository.getModel(request.modelId)
      if (!model) throw new GatewayError('所选模型不存在。', 'model_not_found')
      const provider = this.repository.getStoredProvider(model.providerId)
      if (!provider) throw new GatewayError('模型供应商不存在。', 'provider_not_found')
      if (!providerHasUsableAuthentication(provider)) {
        throw new GatewayError('请先为该供应商配置 API Key。', 'missing_api_key')
      }
      requestSecret = provider.apiKey

      const format = model.apiFormat ?? provider.apiFormat
      const maxOutputTokens = Math.min(
        request.maxOutputTokens ?? model.maxOutputTokens,
        model.maxOutputTokens,
      )
      const settings = this.repository.getSettings()
      const isAgentMode = Boolean(request.agentMode)
      let allMcpTools: McpToolDefinition[] = []
      let effectiveMcpTools: McpToolDefinition[] = []
      if (isAgentMode && this.mcpManager && settings.mcpEnabled !== false) {
        allMcpTools = await this.mcpManager.listAllTools(request.mcpServerIds)
        if (allMcpTools.length > 0) {
          const lastUserMessage = requestMessages.filter((m) => m.role === 'user').at(-1)?.content || ''
          effectiveMcpTools = retrieveRelevantTools(lastUserMessage, allMcpTools, {
            mode: settings.mcpToolRetrievalMode,
            maxTools: 8,
          })
        }
      }

      let effectiveSystemPrompt = settings.systemPrompt
      if (isAgentMode) {
        const allSkills = this.repository.listSkills()
        const activeSkills = request.skillIds?.length
          ? allSkills.filter((skill) => request.skillIds!.includes(skill.id) && skill.enabled)
          : allSkills.filter((skill) => skill.enabled)
        effectiveSystemPrompt = buildAgentSystemPrompt(activeSkills, settings.systemPrompt, effectiveMcpTools)
      }
      const messages = addConfiguredSystemPrompt(
        requestMessages,
        effectiveSystemPrompt,
      )
      const prepared = prepareMessagesForContext(
        messages,
        model.contextWindow,
        maxOutputTokens,
        resolveContextManagementMode(
          settings.contextManagementMode,
          request.allowContextTrimming,
        ),
      )

      const MAX_AGENT_TOOL_TURNS = 6
      let currentTurnMessages = prepared.messages
      let turn = 0

      while (turn < MAX_AGENT_TOOL_TURNS) {
        turn++
        resetStallTimer()

        const response = await fetch(
          endpointFor(provider.baseUrl, format),
          this.withProxy({
            method: 'POST',
            headers: buildProviderHeaders(provider, format),
            body: JSON.stringify(
              buildRequestBody(
                format,
                provider,
                model,
                currentTurnMessages,
                request,
                maxOutputTokens,
                effectiveMcpTools.length > 0 ? effectiveMcpTools : undefined,
              ),
            ),
            signal: controller.signal,
            redirect: 'error',
          }),
        )

        if (!response.ok) throw await httpError(response)
        if (!response.body) throw new GatewayError('供应商没有返回响应流。', 'empty_response')

        const wrappedBody = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            const reader = response.body!.getReader()
            try {
              while (true) {
                const { value, done } = await reader.read()
                resetStallTimer()
                if (done) {
                  ctrl.close()
                  break
                }
                ctrl.enqueue(value)
              }
            } catch (e) {
              ctrl.error(e)
            } finally {
              reader.releaseLock()
            }
          },
          cancel(reason) {
            response.body!.cancel(reason).catch(() => {})
          },
        })

        const streamResult = await consumeStream(
          format,
          wrappedBody,
          requestId,
          emit,
          allMcpTools,
        )

        if (streamResult.toolCalls.length > 0 && this.mcpManager && isAgentMode) {
          const toolExecutions: ToolCallExecution[] = []

          for (const rawCall of streamResult.toolCalls) {
            let parsedArgs: Record<string, unknown> = {}
            try {
              parsedArgs = JSON.parse(rawCall.argumentsText || '{}')
            } catch {
              parsedArgs = {}
            }

            emit({
              type: 'tool-call-complete',
              requestId,
              callId: rawCall.id,
              toolName: rawCall.name,
              args: parsedArgs,
            })

            const toolDef = allMcpTools.find((t) => t.name === rawCall.name)
            const serverId = toolDef?.serverId || ''
            const serverName = toolDef?.serverName || ''

            const execResult = await this.mcpManager.executeTool(serverId, rawCall.name, parsedArgs)

            emit({
              type: 'tool-result',
              requestId,
              callId: rawCall.id,
              toolName: rawCall.name,
              result: execResult.result,
              isError: execResult.isError,
            })

            toolExecutions.push({
              id: rawCall.id,
              toolName: rawCall.name,
              serverId,
              serverName: execResult.serverName || serverName,
              args: parsedArgs,
              result: execResult.result,
              isError: execResult.isError,
              status: execResult.isError ? 'error' : 'complete',
            })
          }

          const assistantMsg: Message = {
            id: `assistant-turn-${turn}-${Date.now()}`,
            role: 'assistant',
            content: streamResult.text,
            toolExecutions,
            createdAt: new Date().toISOString(),
          }
          currentTurnMessages = [...currentTurnMessages, assistantMsg]
          continue
        }

        if (!streamResult.completed) {
          emit({ type: 'done', requestId, finishReason: streamResult.finishReason })
        }
        break
      }
    } catch (error) {
      if (isAbortError(error)) {
        emit({ type: 'done', requestId, finishReason: 'cancelled' })
      } else {
        const chatError = toChatError(error)
        chatError.message = redactSecret(chatError.message, requestSecret, this.proxyUrl)
        emit({ type: 'error', requestId, error: chatError })
      }
    } finally {
      clearTimeout(stallTimer)
      this.controllers.delete(requestId)
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  async discoverModels(providerId: string): Promise<RemoteModel[]> {
    const provider = this.requireProviderWithKey(providerId)
    try {
      return await this.discoverModelsFromProvider(provider)
    } catch (error) {
      throw redactError(error, provider.apiKey, this.proxyUrl)
    }
  }

  private async discoverModelsFromProvider(provider: StoredProvider): Promise<RemoteModel[]> {
    if (!providerHasUsableAuthentication(provider)) {
      throw new GatewayError('请先配置 API Key。', 'missing_api_key')
    }
    let response: Response
    try {
      response = await fetch(
        endpointFor(provider.baseUrl, 'models'),
        this.withProxy({
          headers: buildProviderHeaders(
            provider,
            provider.kind === 'cliproxy'
              ? 'openai-chat-completions'
              : provider.apiFormat,
            false,
          ),
          redirect: 'error',
          signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
        }),
      )
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new GatewayError('获取模型列表超时。', 'request_timeout')
      }
      throw error
    }
    if (!response.ok) throw await httpError(response)
    const responseBody = await readResponseTextLimited(response, MAX_MODEL_RESPONSE_BYTES)
    if (responseBody.truncated) {
      throw new GatewayError('供应商返回的模型列表超过 32 MiB 限制。', 'response_too_large')
    }
    let payload: unknown
    try {
      payload = JSON.parse(responseBody.text)
    } catch {
      throw new GatewayError('供应商返回了无效的模型列表。', 'invalid_model_list')
    }
    const entries = extractModelArray(payload)
    return entries.map(toRemoteModel).filter((model): model is RemoteModel => Boolean(model))
  }

  async testProvider(provider: StoredProvider): Promise<ProviderTestResult> {
    const startedAt = performance.now()
    try {
      await this.discoverModelsFromProvider(provider)
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - startedAt),
        message: '连接成功',
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - startedAt),
        message: redactSecret(
          error instanceof Error ? error.message : '连接失败',
          provider.apiKey,
          this.proxyUrl,
        ),
      }
    }
  }

  private requireProviderWithKey(providerId: string): StoredProvider {
    const provider = this.repository.getStoredProvider(providerId)
    if (!provider) throw new GatewayError('供应商不存在。', 'provider_not_found')
    if (!providerHasUsableAuthentication(provider)) {
      throw new GatewayError('请先配置 API Key。', 'missing_api_key')
    }
    return provider
  }
}

function buildAgentSystemPrompt(
  skills: Skill[],
  userSystemPrompt: string,
  mcpTools?: McpToolDefinition[],
): string {
  const activeSkills = skills.filter((skill) => skill.enabled)
  const parts: string[] = []

  parts.push(
    '【Agent 智能体模式已启用】\n' +
    '你当前处于自主 Agent 专家模式。请以严谨、结构化、以目标为导向的方式执行任务：\n' +
    '1. 深入分析用户真实意图与关键要求。\n' +
    '2. 面对复杂问题时，按逻辑拆解为明确的步骤并逐步分析与推理。\n' +
    '3. 若需脚本辅助执行、数据计算、逻辑推演或算法验证，优先使用 Python 3 脚本。\n' +
    '4. 严格遵循并调用下方已激活的专业领域技能（Skills）及其配套脚本与参考规范。\n' +
    '5. 当需要调用外部环境、文件读写、数据库或网络工具时，可主动发起 MCP 工具调用。'
  )

  if (mcpTools && mcpTools.length > 0) {
    parts.push(
      '=== 当前已就绪的 MCP 工具 (Active MCP Tools) ===\n' +
      mcpTools
        .map((tool) => `- \`${tool.name}\` (来源: ${tool.serverName}): ${tool.description || '无描述'}`)
        .join('\n')
    )
  }

  if (activeSkills.length > 0) {
    parts.push(
      '=== 当前已激活的专业技能 (Active Skills) ===\n' +
      activeSkills
        .map((skill, index) => {
          const files = skill.files && skill.files.length > 0
            ? skill.files
            : [{ path: skill.entryFile || 'SKILL.md', content: skill.systemPrompt || '', kind: 'markdown' as const }]

          const entryDoc = files.find((f) => f.path === (skill.entryFile || 'SKILL.md'))?.content
            || skill.systemPrompt
            || files[0]?.content
            || ''

          const pythonScripts = files.filter((f) => f.kind === 'python')
          const shellScripts = files.filter((f) => f.kind === 'shell')
          const otherDocs = files.filter((f) => f.kind === 'markdown' && f.path !== (skill.entryFile || 'SKILL.md'))

          const skillSections: string[] = [
            `[技能 ${index + 1}: ${skill.name}] (标识: ${skill.id}, 版本: ${skill.version ?? '1.0.0'})\n描述: ${skill.description}\n\n## 操作规范与核心指令:\n${entryDoc.trim()}`
          ]

          if (pythonScripts.length > 0) {
            const pySection = pythonScripts.map((s) => `### Python 3 脚本: \`${s.path}\`\n\`\`\`python\n${s.content.trim()}\n\`\`\``).join('\n\n')
            skillSections.push(`## 附带 Python 3 执行/工具脚本:\n${pySection}`)
          }

          if (shellScripts.length > 0) {
            const shSection = shellScripts.map((s) => `### Shell 脚本: \`${s.path}\`\n\`\`\`bash\n${s.content.trim()}\n\`\`\``).join('\n\n')
            skillSections.push(`## 附带 Shell 脚本:\n${shSection}`)
          }

          if (otherDocs.length > 0) {
            const docSection = otherDocs.map((d) => `### 参考文档: \`${d.path}\`\n${d.content.trim()}`).join('\n\n')
            skillSections.push(`## 附带参考文档:\n${docSection}`)
          }

          return skillSections.join('\n\n')
        })
        .join('\n\n----------------------------------------\n\n'),
    )
  }

  if (userSystemPrompt.trim()) {
    parts.push(`=== 用户全局系统指令 ===\n${userSystemPrompt.trim()}`)
  }

  return parts.join('\n\n')
}

function addConfiguredSystemPrompt(messages: Message[], systemPrompt: string): Message[] {
  const trimmedPrompt = systemPrompt.trim()
  if (!trimmedPrompt) return structuredClone(messages)
  if (
    messages.some(
      (message) => message.role === 'system' && message.content.trim() === trimmedPrompt,
    )
  ) {
    return structuredClone(messages)
  }
  return [
    {
      id: 'configured-system-prompt',
      role: 'system',
      content: trimmedPrompt,
      createdAt: new Date(0).toISOString(),
    },
    ...structuredClone(messages),
  ]
}

function validateChatRequest(request: ChatRequest): Message[] {
  if (
    typeof request.conversationId !== 'string' ||
    !request.conversationId ||
    request.conversationId.length > 500 ||
    typeof request.modelId !== 'string' ||
    !request.modelId ||
    request.modelId.length > 500
  ) {
    throw new GatewayError('会话 ID 无效。', 'invalid_request')
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 2_000) {
    throw new GatewayError('消息列表为空或过长。', 'invalid_request')
  }
  if (typeof request.reasoningEnabled !== 'boolean') {
    throw new GatewayError('思考模式配置无效。', 'invalid_request')
  }
  if (request.agentMode !== undefined && typeof request.agentMode !== 'boolean') {
    throw new GatewayError('Agent 模式配置无效。', 'invalid_request')
  }
  if (
    request.skillIds !== undefined &&
    (!Array.isArray(request.skillIds) ||
      request.skillIds.some((id) => typeof id !== 'string' || id.length > 100))
  ) {
    throw new GatewayError('技能列表配置无效。', 'invalid_request')
  }
  if (
    request.webSearchMode !== undefined &&
    !['off', 'auto', 'native'].includes(String(request.webSearchMode))
  ) {
    throw new GatewayError('网页搜索模式无效。', 'invalid_request')
  }
  if (
    request.allowContextTrimming !== undefined &&
    typeof request.allowContextTrimming !== 'boolean'
  ) {
    throw new GatewayError('上下文裁剪选项无效。', 'invalid_request')
  }
  if (
    request.reasoningEffort !== undefined &&
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      String(request.reasoningEffort),
    )
  ) {
    throw new GatewayError('思考强度配置无效。', 'invalid_request')
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isInteger(request.maxOutputTokens) ||
      request.maxOutputTokens <= 0 ||
      request.maxOutputTokens > 10_000_000)
  ) {
    throw new GatewayError('最大输出长度配置无效。', 'invalid_request')
  }
  let totalCharacters = 0
  const sanitizedMessages: Message[] = []
  for (const message of request.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== 'string' ||
      message.id.length > 500 ||
      !['system', 'user', 'assistant'].includes(String(message.role)) ||
      typeof message.content !== 'string' ||
      message.content.length > 2_000_000
    ) {
      throw new GatewayError('消息格式无效。', 'invalid_request')
    }
    totalCharacters += message.content.length
    sanitizedMessages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt:
        typeof message.createdAt === 'string' && message.createdAt.length <= 100
          ? message.createdAt
          : new Date(0).toISOString(),
    })
  }
  if (totalCharacters > 10_000_000) {
    throw new GatewayError('消息内容总长度超过限制。', 'invalid_request')
  }
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)
  ) {
    throw new GatewayError('temperature 必须在 0 到 2 之间。', 'invalid_request')
  }
  return sanitizedMessages
}

function endpointFor(baseUrl: string, format: ApiFormat | 'models'): string {
  const path =
    format === 'openai-chat-completions'
      ? 'chat/completions'
      : format === 'openai-responses'
        ? 'responses'
        : format === 'anthropic-messages'
          ? 'messages'
          : 'models'
  return new URL(path, `${baseUrl.replace(/\/$/, '')}/`).toString()
}

interface AccumulatedToolCall {
  index: number
  id: string
  name: string
  argumentsText: string
}

interface StreamConsumptionResult {
  completed: boolean
  text: string
  finishReason?: string
  toolCalls: AccumulatedToolCall[]
}

async function consumeStream(
  format: ApiFormat,
  stream: ReadableStream<Uint8Array>,
  requestId: string,
  emit: StreamEmitter,
  allMcpTools?: McpToolDefinition[],
): Promise<StreamConsumptionResult> {
  let completed = false
  let finishReason: string | undefined
  let text = ''
  const citationState = createCitationEmissionState()
  const toolCallsMap = new Map<number | string, AccumulatedToolCall>()

  const handleToolDelta = (delta: { index?: number; id?: string; name?: string; argumentsDelta?: string }) => {
    const key = delta.index ?? (delta.id || 0)
    let tc = toolCallsMap.get(key)
    if (!tc) {
      const id = delta.id || `call_${Date.now().toString(36)}_${toolCallsMap.size}`
      const name = delta.name || ''
      tc = {
        index: typeof delta.index === 'number' ? delta.index : 0,
        id,
        name,
        argumentsText: '',
      }
      toolCallsMap.set(key, tc)
      const toolDef = allMcpTools?.find((t) => t.name === name)
      emit({
        type: 'tool-call-start',
        requestId,
        callId: id,
        toolName: name,
        serverName: toolDef?.serverName,
      })
    } else {
      if (delta.id && !tc.id) tc.id = delta.id
      if (delta.name && !tc.name) {
        tc.name = delta.name
        const toolDef = allMcpTools?.find((t) => t.name === delta.name)
        emit({
          type: 'tool-call-start',
          requestId,
          callId: tc.id,
          toolName: tc.name,
          serverName: toolDef?.serverName,
        })
      }
    }

    if (delta.argumentsDelta) {
      tc.argumentsText += delta.argumentsDelta
      emit({
        type: 'tool-call-args',
        requestId,
        callId: tc.id,
        delta: delta.argumentsDelta,
      })
    }
  }

  for await (const message of parseSse(stream)) {
    if (message.data === '[DONE]') {
      if (!completed && toolCallsMap.size === 0) emit({ type: 'done', requestId, finishReason })
      return { completed: true, text, finishReason, toolCalls: Array.from(toolCallsMap.values()) }
    }

    let payload: unknown
    try {
      payload = JSON.parse(message.data)
    } catch {
      continue
    }

    if (format === 'openai-chat-completions') {
      const parsed = parseChatCompletionEvent(payload)
      if (parsed.error) throw toGatewayError(parsed.error)
      if (parsed.text) {
        text += parsed.text
        emit({ type: 'text-delta', requestId, delta: parsed.text })
      }
      if (parsed.reasoning) {
        emit({ type: 'reasoning-delta', requestId, delta: parsed.reasoning })
      }
      if (parsed.toolCallDelta) {
        handleToolDelta(parsed.toolCallDelta)
      }
      emitNewCitations(
        parsed.citations,
        citationState,
        requestId,
        emit,
      )
      if (parsed.usage) emit({ type: 'usage', requestId, usage: parsed.usage })
      finishReason = parsed.finishReason ?? finishReason
      continue
    }

    if (format === 'openai-responses') {
      const parsed = parseResponsesEvent(payload, message.event)
      if (parsed.error) throw toGatewayError(parsed.error)
      if (parsed.text) {
        text += parsed.text
        emit({ type: 'text-delta', requestId, delta: parsed.text })
      }
      if (parsed.reasoning) {
        emit({ type: 'reasoning-delta', requestId, delta: parsed.reasoning })
      }
      if (parsed.toolCallDelta) {
        handleToolDelta(parsed.toolCallDelta)
      }
      emitNewCitations(
        parsed.citations,
        citationState,
        requestId,
        emit,
      )
      if (parsed.usage) emit({ type: 'usage', requestId, usage: parsed.usage })
      if (parsed.completed) {
        completed = true
        finishReason = parsed.finishReason
        if (toolCallsMap.size === 0) emit({ type: 'done', requestId, finishReason })
      }
      continue
    }

    const parsed = parseAnthropicEvent(payload, message.event)
    if (parsed.error) throw toGatewayError(parsed.error)
    if (parsed.text) {
      text += parsed.text
      emit({ type: 'text-delta', requestId, delta: parsed.text })
    }
    if (parsed.reasoning) {
      emit({ type: 'reasoning-delta', requestId, delta: parsed.reasoning })
    }
    if (parsed.toolCallDelta) {
      handleToolDelta(parsed.toolCallDelta)
    }
    emitNewCitations(
      parsed.citations,
      citationState,
      requestId,
      emit,
    )
    if (parsed.usage) emit({ type: 'usage', requestId, usage: parsed.usage })
    finishReason = parsed.finishReason ?? finishReason
    if (parsed.completed) {
      completed = true
      if (toolCallsMap.size === 0) emit({ type: 'done', requestId, finishReason })
    }
  }
  return { completed, text, finishReason, toolCalls: Array.from(toolCallsMap.values()) }
}

function emitNewCitations(
  citations: WebCitation[] | undefined,
  state: CitationEmissionState,
  requestId: string,
  emit: StreamEmitter,
): void {
  for (const citation of takeChangedWebCitations(citations, state)) {
    emit({
      type: 'citation',
      requestId,
      citation,
    })
  }
}

function toGatewayError(error: ProtocolErrorData): GatewayError {
  return new GatewayError(error.message, error.code, error.status)
}

async function httpError(response: Response): Promise<GatewayError> {
  const retryAfter = Number(response.headers.get('retry-after'))
  let message = `${response.status} ${response.statusText}`.trim()
  let code: string | undefined
  try {
    const body = await readResponseTextLimited(response, MAX_ERROR_RESPONSE_BYTES)
    const value = JSON.parse(body.text) as unknown
    if (isRecord(value)) {
      const error = isRecord(value.error) ? value.error : value
      const metadata = isRecord(error.metadata) ? error.metadata : undefined
      if (typeof error.message === 'string') message = error.message
      code =
        typeof error.error_type === 'string'
          ? error.error_type
          : typeof metadata?.error_type === 'string'
            ? metadata.error_type
          : typeof error.code === 'string'
            ? error.code
            : undefined
    }
  } catch {
    // Keep the status message for non-JSON responses.
  }
  return new GatewayError(
    message,
    code,
    response.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  )
}

async function readResponseTextLimited(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytesRead = 0
  let truncated = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const remaining = maximumBytes - bytesRead
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true })
        truncated = true
        await reader.cancel('response size limit exceeded')
        break
      }
      bytesRead += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { text, truncated }
  } finally {
    reader.releaseLock()
  }
}

function toChatError(error: unknown): ChatError {
  if (error instanceof GatewayError) {
    return removeUndefined({
      message: error.message,
      code: error.code,
      status: error.status,
      retryAfterSeconds: error.retryAfterSeconds,
    }) as ChatError
  }
  if (error instanceof RequestAdapterError) {
    return { message: error.message, code: error.code }
  }
  if (error instanceof ContextWindowError) {
    return { message: error.message, code: error.code }
  }
  return {
    message: error instanceof Error ? error.message : '发生未知错误。',
    code: 'unknown_error',
  }
}

function redactError(error: unknown, secret?: string, proxyUrl?: string): Error {
  if (error instanceof GatewayError) {
    return new GatewayError(
      redactSecret(error.message, secret, proxyUrl),
      error.code,
      error.status,
      error.retryAfterSeconds,
    )
  }
  return new Error(
    redactSecret(error instanceof Error ? error.message : '发生未知错误。', secret, proxyUrl),
  )
}

function redactSecret(message: string, secret?: string, proxyUrl?: string): string {
  let redacted = message
  if (secret) {
    redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl)
      if (parsed.username) redacted = redacted.replaceAll(parsed.username, '[REDACTED]')
      if (parsed.password) redacted = redacted.replaceAll(parsed.password, '[REDACTED]')
    } catch {}
  }
  return redacted
}

function extractModelArray(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new GatewayError('供应商返回了无法识别的模型列表。', 'invalid_model_list')
  }
  if (value.data.length > 20_000) {
    throw new GatewayError('供应商返回的模型数量超过限制。', 'response_too_large')
  }
  return value.data
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export {
  buildAgentSystemPrompt,
  addConfiguredSystemPrompt,
  validateChatRequest,
  endpointFor,
  httpError,
  readResponseTextLimited,
  toChatError,
  redactError,
  redactSecret,
  extractModelArray,
}

