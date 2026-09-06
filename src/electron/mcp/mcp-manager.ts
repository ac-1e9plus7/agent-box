import { ProxyAgent } from 'undici'
import type { McpServerConfig, McpServerInput, McpServerTestResult, McpToolDefinition } from '../../shared/types'
import { AppRepository } from '../storage/app-repository'
import { McpClient, type McpToolExecutionResult } from './mcp-client'
import { t } from '../../shared/i18n'
import { DataPlatSession, dataPlatToken } from './data-plat-session'

const MCP_SERVER_CONCURRENCY = 8

export class McpManager {
  private readonly clients = new Map<string, McpClient>()
  private proxyAgent: ProxyAgent | undefined
  private proxyUrl: string | undefined

  constructor(private readonly repository: AppRepository) {}

  dataPlatServerIds(serverIds?: string[]): string[] {
    return this.repository
      .listMcpServers()
      .filter(
        (server) => server.dataPlat && server.enabled && (serverIds === undefined || serverIds.includes(server.id)),
      )
      .map((server) => server.id)
  }

  createDataPlatSession(conversationId: string, signal: AbortSignal): DataPlatSession {
    return new DataPlatSession(
      this.repository,
      {
        fetch: (input, init) => this.fetchWithProxy(input, init),
        call: async (server, token, tool, args, callSignal) => {
          if (this.repository.getSettings().mcpEnabled === false)
            throw new Error(t('MCP is disabled in global settings.'))
          const client = this.dataPlatClient(server, token, callSignal)
          try {
            const result = await client.callTool(tool, args, callSignal)
            return result.isError && !result.structuredContent
              ? {
                  result: t(
                    'Data platform request failed. Restore the connection and check the execution status before retrying.',
                  ),
                  isError: true,
                }
              : result
          } finally {
            await client.close().catch(() => undefined)
          }
        },
      },
      conversationId,
      signal,
    )
  }

  private dataPlatClient(server: McpServerConfig, token: string, signal: AbortSignal): McpClient {
    const headers = Object.fromEntries(
      Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'),
    )
    return new McpClient({ ...server, headers: { ...headers, Authorization: `Bearer ${token}` } }, (input, init) =>
      this.fetchWithProxy(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) }),
    )
  }

  private async listDataPlatTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
    const signal = AbortSignal.timeout(60000)
    const token = await dataPlatToken({ fetch: (input, init) => this.fetchWithProxy(input, init) }, server, signal)
    const client = this.dataPlatClient(server, token, signal)
    try {
      return await client.listTools()
    } finally {
      await client.close().catch(() => undefined)
    }
  }

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
      )
        return existing
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
    const targetServers =
      serverIds === undefined ? allServers : allServers.filter((server) => serverIds.includes(server.id))
    const results = await mapWithConcurrency(targetServers, MCP_SERVER_CONCURRENCY, async (server) => {
      try {
        return server.dataPlat ? await this.listDataPlatTools(server) : await this.getOrCreateClient(server).listTools()
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
      return { result: t('MCP is disabled in global settings.'), isError: true, serverName: 'Unknown' }
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
      if (server.dataPlat) throw new Error(t('Data platform execution requires the governed Agent session.'))
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
      dataPlat: input.dataPlat ?? undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const client = new McpClient(tempConfig, (request, init) => this.fetchWithProxy(request, init))
    try {
      if (tempConfig.dataPlat) {
        const tools = await this.listDataPlatTools(tempConfig)
        return {
          ok: true,
          latencyMs: Math.round(performance.now() - startTime),
          toolsCount: tools.length,
          message: t('Connection successful'),
          tools,
        }
      }
      const connection = await client.connect()
      const tools = await client.listTools()
      const protocol = connection.protocolVersion
        ? t(', protocol {value0}', { value0: connection.protocolVersion })
        : ''
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - startTime),
        toolsCount: tools.length,
        message: t('Connection successful ({value0}{value1}, {value2} tools found)', {
          value0: connection.transport,
          value1: protocol,
          value2: tools.length,
        }),
        tools,
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - startTime),
        toolsCount: 0,
        message: error instanceof Error ? error.message : t('Connection failed'),
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
    const options = { ...(init || {}), redirect: 'error' as const } as RequestInit & { dispatcher?: ProxyAgent }
    const { proxy } = this.repository.getSettings()
    if (proxy.mode !== 'custom' || !proxy.url) {
      if (this.proxyAgent) void this.proxyAgent.close().catch(() => undefined)
      this.proxyAgent = undefined
      this.proxyUrl = undefined
      return fetch(input, options)
    }
    if (!this.proxyAgent || this.proxyUrl !== proxy.url) {
      if (this.proxyAgent) void this.proxyAgent.close().catch(() => undefined)
      this.proxyAgent = new ProxyAgent(proxy.url)
      this.proxyUrl = proxy.url
    }
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
