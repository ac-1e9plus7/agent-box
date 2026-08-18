import type { McpServerConfig, McpServerInput, McpServerTestResult, McpToolDefinition } from '../../shared/types'
import { AppRepository } from '../storage/app-repository'
import { McpClient } from './mcp-client'

export class McpManager {
  private readonly clients = new Map<string, McpClient>()

  constructor(private readonly repository: AppRepository) {}

  private getOrCreateClient(config: McpServerConfig): McpClient {
    const existing = this.clients.get(config.id)
    if (existing) {
      const c = existing.serverConfig
      if (
        c.transport === config.transport &&
        c.command === config.command &&
        c.url === config.url &&
        JSON.stringify(c.args) === JSON.stringify(config.args) &&
        JSON.stringify(c.env) === JSON.stringify(config.env) &&
        JSON.stringify(c.headers) === JSON.stringify(config.headers)
      ) {
        return existing
      }
      void existing.close().catch(() => {})
      this.clients.delete(config.id)
    }

    const client = new McpClient(config)
    this.clients.set(config.id, client)
    return client
  }

  async listAllTools(serverIds?: string[]): Promise<McpToolDefinition[]> {
    const settings = this.repository.getSettings()
    if (settings.mcpEnabled === false) return []

    const allServers = this.repository.listMcpServers().filter((s) => s.enabled)
    const targetServers = serverIds?.length
      ? allServers.filter((s) => serverIds.includes(s.id))
      : allServers

    if (targetServers.length === 0) return []

    const toolPromises = targetServers.map(async (server) => {
      try {
        const client = this.getOrCreateClient(server)
        return await client.listTools()
      } catch (err) {
        console.warn(`Failed to list tools for MCP server ${server.name} (${server.id}):`, err)
        return []
      }
    })

    const results = await Promise.all(toolPromises)
    return results.flat()
  }

  async executeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError: boolean; serverName: string }> {
    const server = this.repository.getMcpServer(serverId)
    if (!server) {
      return {
        result: `MCP Server with id "${serverId}" not found.`,
        isError: true,
        serverName: 'Unknown',
      }
    }

    try {
      const client = this.getOrCreateClient(server)
      const res = await client.callTool(toolName, args)
      return {
        ...res,
        serverName: server.name,
      }
    } catch (err) {
      return {
        result: `Failed to execute tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        serverName: server.name,
      }
    }
  }

  async testServer(input: McpServerInput): Promise<McpServerTestResult> {
    const startTime = performance.now()
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const testClient = new McpClient(tempConfig)
    try {
      await testClient.connect()
      const tools = await testClient.listTools()
      const latencyMs = Math.round(performance.now() - startTime)
      return {
        ok: true,
        latencyMs,
        toolsCount: tools.length,
        message: `连接成功 (已发现 ${tools.length} 个工具)`,
        tools,
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime)
      return {
        ok: false,
        latencyMs,
        toolsCount: 0,
        message: err instanceof Error ? err.message : '连接失败',
      }
    } finally {
      await testClient.close().catch(() => {})
    }
  }

  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map((c) => c.close().catch(() => {}))
    this.clients.clear()
    await Promise.all(closePromises)
  }
}
