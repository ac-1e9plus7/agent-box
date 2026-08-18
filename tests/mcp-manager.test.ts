import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

const { AppRepository } = await import('../src/electron/storage/app-repository')
const { McpClient } = await import('../src/electron/mcp/mcp-client')
const { McpManager } = await import('../src/electron/mcp/mcp-manager')

const mockServerScript = `
process.stdin.on('data', (d) => {
  const lines = d.toString().split('\\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'MockNodeServer', version: '1.0.0' }
          }
        }) + '\\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'calculate_sum',
                description: 'Add two numbers',
                inputSchema: {
                  type: 'object',
                  properties: { a: { type: 'number' }, b: { type: 'number' } },
                  required: ['a', 'b']
                }
              }
            ]
          }
        }) + '\\n');
      } else if (msg.method === 'tools/call') {
        const { a, b } = msg.params.arguments || {};
        const sum = (Number(a) || 0) + (Number(b) || 0);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: 'Sum is: ' + sum }]
          }
        }) + '\\n');
      } else if (msg.method === 'ping') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
      }
    } catch (e) {
      // ignore
    }
  }
});
`

describe('MCP Client & McpManager (Stdio Transport)', () => {
  let tempDirectory: string
  let repo: InstanceType<typeof AppRepository>
  let manager: InstanceType<typeof McpManager>

  beforeAll(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'agentbox-mcp-manager-test-'))
    repo = new AppRepository(tempDirectory)
    await repo.initialize()
    manager = new McpManager(repo)
  })

  afterAll(async () => {
    await manager.closeAll()
    repo.destroy()
    rmSync(tempDirectory, { recursive: true, force: true })
  })

  it('connects to stdio server, performs initialize, lists tools and calls a tool', async () => {
    const client = new McpClient({
      id: 'test-stdio-1',
      name: 'Mock Test Server',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', mockServerScript],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const initResult = await client.connect()
    expect(initResult.serverInfo.name).toBe('MockNodeServer')

    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('calculate_sum')
    expect(tools[0]?.description).toBe('Add two numbers')

    const callResult = await client.callTool('calculate_sum', { a: 40, b: 2 })
    expect(callResult.isError).toBe(false)
    expect(callResult.result).toBe('Sum is: 42')

    const pingOk = await client.ping()
    expect(pingOk).toBe(true)

    await client.close()
  })

  it('tests server connection via McpManager testServer', async () => {
    const result = await manager.testServer({
      name: 'Candidate Server',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', mockServerScript],
    })

    expect(result.ok).toBe(true)
    expect(result.toolsCount).toBe(1)
    expect(result.tools?.[0]?.name).toBe('calculate_sum')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('aggregates tools and executes tool via McpManager', async () => {
    const server = await repo.upsertMcpServer({
      name: 'Persistent Mock Server',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', mockServerScript],
      enabled: true,
    })

    const allTools = await manager.listAllTools()
    expect(allTools.length).toBeGreaterThanOrEqual(1)
    const match = allTools.find((t) => t.name === 'calculate_sum')
    expect(match).toBeDefined()
    expect(match?.serverId).toBe(server.id)

    const exec = await manager.executeTool(server.id, 'calculate_sum', { a: 100, b: 25 })
    expect(exec.isError).toBe(false)
    expect(exec.result).toBe('Sum is: 125')
    expect(exec.serverName).toBe('Persistent Mock Server')
  })
})
