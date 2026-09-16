import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type {
  McpServerConfig,
  McpToolDefinition,
  McpToolParameterSchema,
  McpToolResultContent,
} from '../../shared/types'
import { t } from '../../shared/i18n'

const MAX_TOOL_LIST_PAGES = 64
const MAX_TOOLS_PER_SERVER = 2_000
const MAX_TOOL_RESULT_CHARACTERS = 100_000
const MAX_TOOL_RESULT_CONTENT_ITEMS = 100
const MAX_BINARY_RESULT_CHARACTERS = 2 * 1024 * 1024
const MAX_BINARY_RESULT_TOTAL_CHARACTERS = 2 * 1024 * 1024

export interface McpConnectionInfo {
  protocolVersion?: string
  capabilities: Record<string, unknown>
  serverInfo: { name: string; version?: string }
  transport: 'stdio' | 'streamable-http' | 'sse'
}

export interface McpToolExecutionResult {
  result: string
  content?: McpToolResultContent[]
  structuredContent?: Record<string, unknown>
  isError: boolean
  truncated?: boolean
}

type McpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class McpClient {
  private client: Client | undefined
  private transport: Transport | undefined
  private connectionInfo: McpConnectionInfo | undefined
  private connectionPromise: Promise<McpConnectionInfo> | undefined
  private generation = 0
  private readonly connections = new Set<() => Promise<void>>()
  private readonly connectionControllers = new Set<AbortController>()

  constructor(
    readonly serverConfig: McpServerConfig,
    private readonly fetchFn: McpFetch = globalThis.fetch,
    private readonly onToolsChanged?: () => void,
  ) {}

  get isConnected(): boolean {
    return Boolean(this.client && this.transport)
  }

  get serverInfo(): { name: string; version?: string } | undefined {
    return this.connectionInfo?.serverInfo
  }

  async connect(): Promise<McpConnectionInfo> {
    if (this.connectionInfo && this.client && this.transport) return this.connectionInfo
    if (this.connectionPromise) return this.connectionPromise
    const pending = this.connectOnce(this.generation)
    this.connectionPromise = pending
    try {
      return await pending
    } finally {
      if (this.connectionPromise === pending) this.connectionPromise = undefined
    }
  }

  private async connectOnce(generation: number): Promise<McpConnectionInfo> {
    const controller = new AbortController()
    this.connectionControllers.add(controller)
    const timer = setTimeout(() => controller.abort(new DOMException('Connection timed out', 'TimeoutError')), 30_000)
    const fetchFn: McpFetch = (input, init) =>
      this.fetchFn(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      })
    try {
      if (this.serverConfig.transport === 'stdio') {
        return await this.connectTransport(
          new StdioClientTransport({
            command: this.serverConfig.command || '',
            args: this.serverConfig.args || [],
            env: { ...getDefaultEnvironment(), ...(this.serverConfig.env || {}) },
            stderr: 'pipe',
            maxBufferSize: 10 * 1024 * 1024,
          }),
          'stdio',
          generation,
          controller.signal,
        )
      }

      const url = new URL(this.serverConfig.url || '')
      const requestInit: RequestInit = { headers: { ...(this.serverConfig.headers || {}) } }
      if (this.serverConfig.transport === 'sse') {
        return await this.connectTransport(
          new SSEClientTransport(url, {
            requestInit,
            eventSourceInit: { fetch: fetchFn },
            fetch: fetchFn,
          }),
          'sse',
          generation,
          controller.signal,
        )
      }

      try {
        return await this.connectTransport(
          new StreamableHTTPClientTransport(url, {
            requestInit,
            fetch: fetchFn,
            reconnectionOptions: {
              initialReconnectionDelay: 500,
              maxReconnectionDelay: 10_000,
              reconnectionDelayGrowFactor: 1.8,
              maxRetries: 3,
            },
          }),
          'streamable-http',
          generation,
          controller.signal,
        )
      } catch (streamableError) {
        if (generation !== this.generation || controller.signal.aborted) throw safeMcpFailure(streamableError)
        try {
          return await this.connectTransport(
            new SSEClientTransport(url, {
              requestInit,
              eventSourceInit: { fetch: fetchFn },
              fetch: fetchFn,
            }),
            'sse',
            generation,
            controller.signal,
          )
        } catch (sseError) {
          throw safeMcpFailure(sseError)
        }
      }
    } finally {
      clearTimeout(timer)
      if (!this.isConnected || generation !== this.generation) {
        controller.abort()
        this.connectionControllers.delete(controller)
      }
    }
  }

  private async connectTransport(
    transport: Transport,
    transportKind: McpConnectionInfo['transport'],
    generation: number,
    signal: AbortSignal,
  ): Promise<McpConnectionInfo> {
    const client = new Client({ name: 'AgentBox', version: '1.0.0' }, { capabilities: {} })
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        await client.close().catch(() => undefined)
        await transport.close().catch(() => undefined)
        this.connections.delete(close)
      })())
    this.connections.add(close)
    // Consume stderr so verbose servers cannot deadlock on a full pipe. Never log it.
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => undefined)
    client.onerror = (error) => console.warn('MCP transport:', safeMcpError(error))
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined
        this.transport = undefined
        this.connectionInfo = undefined
      }
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onToolsChanged?.())

    try {
      await client.connect(transport, { timeout: 30_000, signal })
      if (generation !== this.generation) throw new Error(t('The MCP client is not connected.'))
    } catch (error) {
      await close()
      throw safeMcpFailure(error)
    }
    const server = client.getServerVersion()
    const capabilities = client.getServerCapabilities() || {}
    this.client = client
    this.transport = transport
    this.connectionInfo = {
      protocolVersion:
        'protocolVersion' in transport
          ? String((transport as { protocolVersion?: string }).protocolVersion || '') || undefined
          : undefined,
      capabilities: capabilities,
      serverInfo: { name: server?.name || this.serverConfig.name, version: server?.version },
      transport: transportKind,
    }
    return this.connectionInfo
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    await this.ensureConnected(signal)
    const client = this.requireClient()
    const collected: McpToolDefinition[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const response = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000, signal })
      for (const raw of response.tools) {
        if (collected.length >= MAX_TOOLS_PER_SERVER) {
          throw new Error(t('MCP server {value0} returned too many tools.', { value0: this.serverConfig.name }))
        }
        collected.push({
          name: raw.name,
          modelName: createModelToolName(this.serverConfig.id, raw.name),
          description: limitString(raw.description, 8_000),
          inputSchema: sanitizeObjectSchema(raw.inputSchema),
          outputSchema: raw.outputSchema ? sanitizeObjectSchema(raw.outputSchema) : undefined,
          annotations: raw.annotations,
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
        })
      }
      cursor = response.nextCursor
      if (!cursor) return collected
    }

    throw new Error(
      t('Tool pagination for MCP server {value0} exceeds the {value1}-page limit.', {
        value0: this.serverConfig.name,
        value1: MAX_TOOL_LIST_PAGES,
      }),
    )
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<McpToolExecutionResult> {
    await this.ensureConnected(signal)
    try {
      const response = await this.requireClient().callTool({ name, arguments: args }, undefined, {
        timeout: 60_000,
        signal,
      })
      return normalizeToolResult(response)
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      return { result: safeMcpError(error), isError: true }
    }
  }

  async ping(): Promise<boolean> {
    try {
      if (!this.client) await this.connect()
      await this.requireClient().ping({ timeout: 5_000 })
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    this.generation += 1
    for (const controller of this.connectionControllers) controller.abort()
    this.connectionControllers.clear()
    this.connectionPromise = undefined
    this.client = undefined
    this.transport = undefined
    this.connectionInfo = undefined
    await Promise.all([...this.connections].map((close) => close()))
  }

  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.client) return
    if (!signal) {
      await this.connect()
      return
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      void this.connect().then(
        () => {
          signal.removeEventListener('abort', abort)
          resolve()
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error instanceof Error ? error : safeMcpFailure(error))
        },
      )
    })
    signal.throwIfAborted()
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(t('The MCP client is not connected.'))
    return this.client
  }
}

export function createModelToolName(serverId: string, toolName: string): string {
  const safeName = toolName.replace(/[^0-9A-Za-z_-]/g, '_') || 'tool'
  const prefix = `mcp_${fnv1a(serverId)}_${fnv1a(toolName)}_`
  return `${prefix}${safeName}`.slice(0, 64)
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function sanitizeObjectSchema(value: Record<string, unknown>): McpToolParameterSchema {
  return {
    ...structuredClone(value),
    type: 'object',
    properties: isRecord(value.properties) ? structuredClone(value.properties) : {},
    required: Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === 'string').slice(0, 200)
      : undefined,
  }
}

export function normalizeToolResult(value: unknown): McpToolExecutionResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    const fallback = limitString(JSON.stringify(value), MAX_TOOL_RESULT_CHARACTERS) || ''
    return { result: fallback, isError: false, truncated: fallback.length >= MAX_TOOL_RESULT_CHARACTERS }
  }

  let truncated = value.content.length > MAX_TOOL_RESULT_CONTENT_ITEMS
  let remainingTextCharacters = MAX_TOOL_RESULT_CHARACTERS
  let remainingBinaryCharacters = MAX_BINARY_RESULT_TOTAL_CHARACTERS
  const content: McpToolResultContent[] = []
  const textParts: string[] = []
  for (const raw of value.content.slice(0, MAX_TOOL_RESULT_CONTENT_ITEMS)) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue
    if (raw.type === 'text' && typeof raw.text === 'string') {
      const text = takeBoundedText(raw.text, remainingTextCharacters)
      truncated ||= text.length < raw.text.length
      remainingTextCharacters -= text.length
      if (text) {
        content.push({ type: 'text', text })
        textParts.push(text)
      }
    } else if ((raw.type === 'image' || raw.type === 'audio') && typeof raw.mimeType === 'string') {
      const mimeType = limitString(raw.mimeType, 255) || ''
      truncated ||= mimeType.length < raw.mimeType.length
      const data = takeBoundedBinary(raw.data, remainingBinaryCharacters)
      truncated ||= typeof raw.data === 'string' && !data
      if (data) remainingBinaryCharacters -= data.length
      content.push({ type: raw.type, data, mimeType })
      textParts.push(`[${raw.type === 'image' ? 'Image' : 'Audio'}: ${mimeType}]`)
    } else if (raw.type === 'resource' && isRecord(raw.resource) && typeof raw.resource.uri === 'string') {
      const uri = takeBoundedText(raw.resource.uri, Math.min(4_096, remainingTextCharacters))
      remainingTextCharacters -= uri.length
      truncated ||= uri.length < raw.resource.uri.length
      if (!uri) continue
      const textSource = typeof raw.resource.text === 'string' ? raw.resource.text : undefined
      const text = textSource === undefined ? undefined : takeBoundedText(textSource, remainingTextCharacters)
      truncated ||= textSource !== undefined && text?.length !== textSource.length
      if (text) remainingTextCharacters -= text.length
      const blob = takeBoundedBinary(raw.resource.blob, remainingBinaryCharacters)
      truncated ||= typeof raw.resource.blob === 'string' && !blob
      if (blob) remainingBinaryCharacters -= blob.length
      content.push({
        type: 'resource',
        uri,
        mimeType: typeof raw.resource.mimeType === 'string' ? limitString(raw.resource.mimeType, 255) : undefined,
        text,
        blob,
      })
      textParts.push(text || `[Resource: ${uri}]`)
    } else if (raw.type === 'resource_link' && typeof raw.uri === 'string' && typeof raw.name === 'string') {
      const uri = takeBoundedText(raw.uri, Math.min(4_096, remainingTextCharacters))
      remainingTextCharacters -= uri.length
      truncated ||= uri.length < raw.uri.length
      const name = takeBoundedText(raw.name, Math.min(4_096, remainingTextCharacters))
      remainingTextCharacters -= name.length
      truncated ||= name.length < raw.name.length
      const description =
        typeof raw.description === 'string'
          ? takeBoundedText(raw.description, Math.min(4_000, remainingTextCharacters))
          : undefined
      if (description) remainingTextCharacters -= description.length
      truncated ||= typeof raw.description === 'string' && description?.length !== raw.description.length
      if (!uri || !name) continue
      content.push({
        type: 'resource_link',
        uri,
        name,
        description,
        mimeType: typeof raw.mimeType === 'string' ? limitString(raw.mimeType, 255) : undefined,
      })
      textParts.push(`[Resource link: ${name} (${uri})]`)
    }
  }

  const limitedStructured = isRecord(value.structuredContent)
    ? limitStructuredContent(value.structuredContent, remainingTextCharacters)
    : undefined
  const structuredContent = limitedStructured?.value
  truncated ||= limitedStructured?.truncated === true
  if (structuredContent) {
    textParts.push(JSON.stringify(structuredContent))
  }
  const joined = textParts.join('\n')
  const result =
    joined.length > MAX_TOOL_RESULT_CHARACTERS
      ? t('{value0}\n[Results truncated]', { value0: joined.slice(0, MAX_TOOL_RESULT_CHARACTERS) })
      : joined
  truncated ||= result.length < joined.length
  return {
    result,
    content: content.length ? content : undefined,
    structuredContent,
    isError: Boolean(value.isError),
    truncated,
  }
}

function takeBoundedText(value: string, remainingCharacters: number): string {
  return value.slice(0, Math.max(0, remainingCharacters))
}

function takeBoundedBinary(value: unknown, remainingCharacters: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length > MAX_BINARY_RESULT_CHARACTERS || value.length > remainingCharacters) return undefined
  return value
}

function limitStructuredContent(
  value: Record<string, unknown>,
  maxCharacters: number,
): { value?: Record<string, unknown>; truncated: boolean } {
  if (maxCharacters <= 0) return { truncated: true }
  try {
    const json = JSON.stringify(value)
    if (json.length <= maxCharacters) {
      return { value: JSON.parse(json) as Record<string, unknown>, truncated: false }
    }
    let preview = json.slice(0, maxCharacters)
    let replacement: Record<string, unknown> = { truncated: true, preview }
    let serialized = JSON.stringify(replacement)
    while (serialized.length > maxCharacters && preview.length > 0) {
      preview = preview.slice(0, Math.max(0, preview.length - (serialized.length - maxCharacters)))
      replacement = { truncated: true, preview }
      serialized = JSON.stringify(replacement)
    }
    return { value: replacement, truncated: true }
  } catch {
    return { truncated: true }
  }
}

function limitString(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  return value.length > max ? value.slice(0, max) : value
}

export function safeMcpError(value: unknown): string {
  // Only allow known diagnostic codes. Upstream text/cause may echo credentials.
  const code = value instanceof Error && 'code' in value ? String(value.code) : ''
  const allowed = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'EACCES'].includes(code) ? code : undefined
  const message = t('MCP request failed. Check the server configuration and connection.')
  return allowed ? `${message} (${allowed})` : message
}

function safeMcpFailure(value: unknown): Error {
  // Deliberately do not retain a raw cause that could expose authentication data.
  return new Error(safeMcpError(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
