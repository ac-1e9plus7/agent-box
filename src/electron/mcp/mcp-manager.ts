import { ProxyAgent } from 'undici'
import type { McpServerConfig, McpServerInput, McpServerTestResult, McpToolDefinition } from '../../shared/types'
import { AppRepository } from '../storage/app-repository'
import { McpClient, type McpToolExecutionResult } from './mcp-client'
import { t } from "../../shared/i18n"

const MCP_SERVER_CONCURRENCY = 8

export class McpManager {
  private readonly clients = new Map<string, McpClient>()
  private proxyAgent: ProxyAgent | undefined
  private proxyUrl: string | undefined

  constructor(private readonly repository: AppRepository) {}

  private getOrCreateClient(config: McpServerConfig): McpClient {
    const existing = this.clients.get(config.id)
    if (existing) {
      const current = existing.serverConfig
      if (
        current.enabled === config.enabled &&
        current.transport === config.transport &&
        current.command === config.command &&
        current.url === config.url &&
        JSON.stringify(current.args) === JSON.stringify(config.args) &&
        JSON.stringify(current.env) === JSON.stringify(config.env) &&
        JSON.stringify(current.headers) === JSON.stringify(config.headers)
      ) return existing
      void existing.close().catch(() => undefined)
      this.clients.delete(config.id)
    }

    const client = new McpClient(
      config,
      (input, init) => this.fetchWithProxy(input, init),
      () => console.info(`MCP tool list changed: ${config.name} (${config.id})`),
    )
    this.clients.set(config.id, client)
    return client
  }

  async listAllTools(serverIds?: string[]): Promise<McpToolDefinition[]> {
    if (this.repository.getSettings().mcpEnabled === false) return []
    const allServers = this.repository.listMcpServers().filter((server) => server.enabled)
    const targetServers = serverIds === undefined
      ? allServers
      : allServers.filter((server) => serverIds.includes(server.id))
    const results = await mapWithConcurrency(targetServers, MCP_SERVER_CONCURRENCY, async (server) => {
      try {
        return await this.getOrCreateClient(server).listTools()
      } catch (error) {
        console.warn(`Failed to list tools for MCP server ${server.name} (${server.id}):`, error)
        return []
      }
    })
    return results.flat()
  }

  async executeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolExecutionResult & { serverName: string }> {
    if (this.repository.getSettings().mcpEnabled === false) {
      return { result: t("MCP 已在全局设置中停用。"), isError: true, serverName: 'Unknown' }
    }
    const server = this.repository.getMcpServer(serverId)
    if (!server || !server.enabled) {
      return {
        result: `MCP Server with id "${serverId}" is unavailable or disabled.`,
        isError: true,
        serverName: server?.name || 'Unknown',
      }
    }
    try {
      const result = await this.getOrCreateClient(server).callTool(toolName, args, signal)
      return { ...result, serverName: server.name }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      return {
        result: `Failed to execute tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        serverName: server.name,
      }
    }
  }

  async testServer(input: McpServerInput): Promise<McpServerTestResult> {
    const startTime = performance.now()
    const timestamp = new Date().toISOString()
    const tempConfig: McpServerConfig = {
      id: input.id || 'test-temp',
      name: input.name || 'Test Server',
      enabled: true,
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      url: input.url,
      headers: input.headers,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const client = new McpClient(tempConfig, (request, init) => this.fetchWithProxy(request, init))
    try {
      const connection = await client.connect()
      const tools = await client.listTools()
      const protocol = connection.protocolVersion ? t("，协议 {value0}", { value0: connection.protocolVersion }) : ''
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - startTime),
        toolsCount: tools.length,
        message: t("连接成功（{value0}{value1}，已发现 {value2} 个工具）", { value0: connection.transport, value1: protocol, value2: tools.length }),
        tools,
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - startTime),
        toolsCount: 0,
        message: error instanceof Error ? error.message : t("连接失败"),
      }
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((client) => client.close().catch(() => undefined)))
    this.clients.clear()
    if (this.proxyAgent) await this.proxyAgent.close().catch(() => undefined)
    this.proxyAgent = undefined
    this.proxyUrl = undefined
  }

  private async fetchWithProxy(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { proxy } = this.repository.getSettings()
    if (proxy.mode !== 'custom' || !proxy.url) {
      if (this.proxyAgent) void this.proxyAgent.close().catch(() => undefined)
      this.proxyAgent = undefined
      this.proxyUrl = undefined
      return fetch(input, init)
    }
    if (!this.proxyAgent || this.proxyUrl !== proxy.url) {
      if (this.proxyAgent) void this.proxyAgent.close().catch(() => undefined)
      this.proxyAgent = new ProxyAgent(proxy.url)
      this.proxyUrl = proxy.url
    }
    const options = { ...(init || {}) } as RequestInit & { dispatcher?: ProxyAgent }
    options.dispatcher = this.proxyAgent
    return fetch(input, options)
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
