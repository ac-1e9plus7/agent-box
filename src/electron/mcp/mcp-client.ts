import type { McpServerConfig, McpToolDefinition, McpToolParameterSchema } from '../../shared/types'
import type {
  McpCallToolResult,
  McpInitializeResult,
  McpListToolsResult,
  McpRawTool,
  McpTransport,
} from './mcp-types'
import { StdioMcpTransport } from './stdio-transport'
import { SseMcpTransport } from './sse-transport'

export class McpClient {
  private transport: McpTransport
  private _isInitialized = false
  private _serverInfo: { name: string; version?: string } | undefined

  constructor(readonly serverConfig: McpServerConfig) {
    if (serverConfig.transport === 'stdio') {
      this.transport = new StdioMcpTransport(
        serverConfig.command || '',
        serverConfig.args || [],
        serverConfig.env || {},
      )
    } else {
      this.transport = new SseMcpTransport(
        serverConfig.url || '',
        serverConfig.headers || {},
      )
    }
  }

  get isConnected(): boolean {
    return this.transport.isConnected
  }

  get serverInfo(): { name: string; version?: string } | undefined {
    return this._serverInfo
  }

  async connect(): Promise<McpInitializeResult> {
    if (this._isInitialized && this.transport.isConnected) {
      return {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: this._serverInfo || { name: this.serverConfig.name },
      }
    }

    await this.transport.start()

    const initResult = (await this.transport.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: 'AgentBox',
        version: '1.0.0',
      },
    })) as McpInitializeResult

    this._serverInfo = initResult?.serverInfo
    this._isInitialized = true

    // Send initialized notification
    await this.transport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }).catch(() => {})

    return initResult
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this._isInitialized) {
      await this.connect()
    }

    const response = (await this.transport.request('tools/list', {})) as McpListToolsResult
    const rawTools: McpRawTool[] = response?.tools || []

    return rawTools.map((raw) => {
      const inputSchema: McpToolParameterSchema = raw.inputSchema || {
        type: 'object',
        properties: {},
      }
      return {
        name: raw.name,
        description: raw.description,
        inputSchema,
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
      }
    })
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ result: string; isError: boolean }> {
    if (!this._isInitialized) {
      await this.connect()
    }

    try {
      const response = (await this.transport.request('tools/call', {
        name,
        arguments: args,
      }, 60_000)) as McpCallToolResult

      const isError = Boolean(response?.isError)
      let result = ''

      if (Array.isArray(response?.content)) {
        result = response.content
          .map((item) => {
            if (item.type === 'text') return item.text || ''
            if (item.type === 'image') return `[Image: ${item.mimeType || 'image/png'}]`
            if (item.type === 'resource') return item.resource?.text || `[Resource: ${item.resource?.uri}]`
            return JSON.stringify(item)
          })
          .join('\n')
      } else if (typeof response === 'string') {
        result = response
      } else {
        result = JSON.stringify(response)
      }

      return { result, isError }
    } catch (err) {
      return {
        result: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.transport.request('ping', {}, 5000)
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    this._isInitialized = false
    await this.transport.close()
  }
}
