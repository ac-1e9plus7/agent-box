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
import { t } from "../../shared/i18n"

const MAX_TOOL_LIST_PAGES = 64
const MAX_TOOLS_PER_SERVER = 2_000
const MAX_TOOL_RESULT_CHARACTERS = 100_000
const MAX_BINARY_RESULT_CHARACTERS = 2 * 1024 * 1024

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

    if (this.serverConfig.transport === 'stdio') {
      return this.connectTransport(
        new StdioClientTransport({
          command: this.serverConfig.command || '',
          args: this.serverConfig.args || [],
          env: { ...getDefaultEnvironment(), ...(this.serverConfig.env || {}) },
          stderr: 'pipe',
          maxBufferSize: 10 * 1024 * 1024,
        }),
        'stdio',
      )
    }

    const url = new URL(this.serverConfig.url || '')
    const requestInit: RequestInit = { headers: { ...(this.serverConfig.headers || {}) } }
    if (this.serverConfig.transport === 'sse') {
      return this.connectTransport(
        new SSEClientTransport(url, {
          requestInit,
          eventSourceInit: { fetch: this.fetchFn as typeof fetch },
          fetch: this.fetchFn,
        }),
        'sse',
      )
    }

    try {
      return await this.connectTransport(
        new StreamableHTTPClientTransport(url, {
          requestInit,
          fetch: this.fetchFn,
          reconnectionOptions: {
            initialReconnectionDelay: 500,
            maxReconnectionDelay: 10_000,
            reconnectionDelayGrowFactor: 1.8,
            maxRetries: 3,
          },
        }),
        'streamable-http',
      )
    } catch (streamableError) {
      await this.close().catch(() => undefined)
      try {
        return await this.connectTransport(
          new SSEClientTransport(url, {
            requestInit,
            eventSourceInit: { fetch: this.fetchFn as typeof fetch },
            fetch: this.fetchFn,
          }),
          'sse',
        )
      } catch (sseError) {
        throw new Error(
          t("MCP remote connection failed (Streamable HTTP: {value0}; legacy HTTP+SSE: {value1})", { value0: errorMessage(streamableError), value1: errorMessage(sseError) }),
        )
      }
    }
  }

  private async connectTransport(
    transport: Transport,
    transportKind: McpConnectionInfo['transport'],
  ): Promise<McpConnectionInfo> {
    const client = new Client({ name: 'AgentBox', version: '1.0.0' }, { capabilities: {} })
    client.onerror = (error) => console.warn(`MCP client error (${this.serverConfig.name}):`, error)
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined
        this.transport = undefined
        this.connectionInfo = undefined
      }
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onToolsChanged?.())

    await client.connect(transport)
    const server = client.getServerVersion()
    const capabilities = client.getServerCapabilities() || {}
    this.client = client
    this.transport = transport
    this.connectionInfo = {
      protocolVersion: 'protocolVersion' in transport
        ? String((transport as { protocolVersion?: string }).protocolVersion || '') || undefined
        : undefined,
      capabilities: capabilities as Record<string, unknown>,
      serverInfo: { name: server?.name || this.serverConfig.name, version: server?.version },
      transport: transportKind,
    }
    return this.connectionInfo
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.client) await this.connect()
    const client = this.requireClient()
    const collected: McpToolDefinition[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const response = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 })
      for (const raw of response.tools) {
        if (collected.length >= MAX_TOOLS_PER_SERVER) {
          throw new Error(t("MCP server {value0} returned too many tools.", { value0: this.serverConfig.name }))
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

    throw new Error(t("Tool pagination for MCP server {value0} exceeds the {value1}-page limit.", { value0: this.serverConfig.name, value1: MAX_TOOL_LIST_PAGES }))
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<McpToolExecutionResult> {
    if (!this.client) await this.connect()
    try {
      const response = await this.requireClient().callTool(
        { name, arguments: args },
        undefined,
        { timeout: 60_000, signal },
      )
      return normalizeToolResult(response)
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      return { result: `Tool execution error: ${errorMessage(error)}`, isError: true }
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
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    this.connectionInfo = undefined
    if (client) await client.close().catch(() => undefined)
    else if (transport) await transport.close().catch(() => undefined)
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(t("The MCP client is not connected."))
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

function normalizeToolResult(value: unknown): McpToolExecutionResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    const fallback = limitString(JSON.stringify(value), MAX_TOOL_RESULT_CHARACTERS) || ''
    return { result: fallback, isError: false, truncated: fallback.length >= MAX_TOOL_RESULT_CHARACTERS }
  }

  let truncated = false
  const content: McpToolResultContent[] = []
  const textParts: string[] = []
  for (const raw of value.content.slice(0, 100)) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue
    if (raw.type === 'text' && typeof raw.text === 'string') {
      const text = limitString(raw.text, MAX_TOOL_RESULT_CHARACTERS) || ''
      truncated ||= text.length < raw.text.length
      content.push({ type: 'text', text })
      textParts.push(text)
    } else if ((raw.type === 'image' || raw.type === 'audio') && typeof raw.mimeType === 'string') {
      const data = typeof raw.data === 'string' && raw.data.length <= MAX_BINARY_RESULT_CHARACTERS
        ? raw.data
        : undefined
      truncated ||= typeof raw.data === 'string' && !data
      content.push({ type: raw.type, data, mimeType: raw.mimeType })
      textParts.push(`[${raw.type === 'image' ? 'Image' : 'Audio'}: ${raw.mimeType}]`)
    } else if (raw.type === 'resource' && isRecord(raw.resource) && typeof raw.resource.uri === 'string') {
      const text = limitString(
        typeof raw.resource.text === 'string' ? raw.resource.text : undefined,
        MAX_TOOL_RESULT_CHARACTERS,
      )
      const blob = typeof raw.resource.blob === 'string' && raw.resource.blob.length <= MAX_BINARY_RESULT_CHARACTERS
        ? raw.resource.blob
        : undefined
      truncated ||= typeof raw.resource.blob === 'string' && !blob
      content.push({
        type: 'resource',
        uri: raw.resource.uri,
        mimeType: typeof raw.resource.mimeType === 'string' ? raw.resource.mimeType : undefined,
        text,
        blob,
      })
      textParts.push(text || `[Resource: ${raw.resource.uri}]`)
    } else if (raw.type === 'resource_link' && typeof raw.uri === 'string' && typeof raw.name === 'string') {
      content.push({
        type: 'resource_link',
        uri: raw.uri,
        name: raw.name,
        description: limitString(typeof raw.description === 'string' ? raw.description : undefined, 4_000),
        mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
      })
      textParts.push(`[Resource link: ${raw.name} (${raw.uri})]`)
    }
  }

  const structuredContent = isRecord(value.structuredContent)
    ? limitStructuredContent(value.structuredContent)
    : undefined
  if (structuredContent) textParts.push(JSON.stringify(structuredContent))
  const joined = textParts.join('\n')
  const result = joined.length > MAX_TOOL_RESULT_CHARACTERS
    ? t("{value0}\n[Results truncated]", { value0: joined.slice(0, MAX_TOOL_RESULT_CHARACTERS) })
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

function limitStructuredContent(value: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const json = JSON.stringify(value)
    if (json.length > MAX_TOOL_RESULT_CHARACTERS) {
      return { truncated: true, preview: json.slice(0, MAX_TOOL_RESULT_CHARACTERS) }
    }
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function limitString(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  return value.length > max ? value.slice(0, max) : value
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
