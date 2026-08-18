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
const { normalizeAppSettings } = await import('../src/electron/storage/settings-schema')

describe('MCP Schema & AppRepository Storage', () => {
  let tempDirectory: string
  let repo: InstanceType<typeof AppRepository>

  beforeAll(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'agentbox-mcp-test-'))
    repo = new AppRepository(tempDirectory)
    await repo.initialize()
  })

  afterAll(() => {
    repo.destroy()
    rmSync(tempDirectory, { recursive: true, force: true })
  })

  describe('settings-schema MCP options', () => {
    it('applies default mcpEnabled (true) and mcpToolRetrievalMode (auto) when omitted', () => {
      const normalized = normalizeAppSettings({
        theme: 'system',
        sendShortcut: 'enter',
        contextManagementMode: 'manual',
        defaultReasoningEnabled: false,
        defaultReasoningEffort: 'medium',
        systemPrompt: '',
      })
      expect(normalized.mcpEnabled).toBe(true)
      expect(normalized.mcpToolRetrievalMode).toBe('auto')
    })

    it('respects explicitly set mcpEnabled and mcpToolRetrievalMode', () => {
      const normalized = normalizeAppSettings({
        theme: 'dark',
        sendShortcut: 'mod-enter',
        contextManagementMode: 'auto',
        defaultReasoningEnabled: true,
        defaultReasoningEffort: 'high',
        mcpEnabled: false,
        mcpToolRetrievalMode: 'all',
        systemPrompt: 'test prompt',
      })
      expect(normalized.mcpEnabled).toBe(false)
      expect(normalized.mcpToolRetrievalMode).toBe('all')
    })

    it('rejects invalid mcpToolRetrievalMode', () => {
      expect(() =>
        normalizeAppSettings({
          theme: 'system',
          sendShortcut: 'enter',
          contextManagementMode: 'manual',
          defaultReasoningEnabled: false,
          defaultReasoningEffort: 'medium',
          mcpToolRetrievalMode: 'invalid_mode',
          systemPrompt: '',
        }),
      ).toThrow('Invalid MCP tool retrieval mode')
    })
  })

  describe('AppRepository MCP Server CRUD', () => {
    it('starts with empty mcpServers list', () => {
      expect(repo.listMcpServers()).toEqual([])
    })

    it('adds a valid stdio MCP server with command, args, and env', async () => {
      const server = await repo.upsertMcpServer({
        name: 'Filesystem Server',
        description: 'Read and write local files',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\AllowedPath'],
        env: {
          DEBUG: 'true',
          MAX_DEPTH: '5',
        },
        enabled: true,
      })

      expect(server.id).toBeDefined()
      expect(server.name).toBe('Filesystem Server')
      expect(server.transport).toBe('stdio')
      expect(server.command).toBe('npx')
      expect(server.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\AllowedPath'])
      expect(server.env).toEqual({ DEBUG: 'true', MAX_DEPTH: '5' })
      expect(server.enabled).toBe(true)

      const list = repo.listMcpServers()
      expect(list).toHaveLength(1)
      expect(list[0]?.id).toBe(server.id)
    })

    it('adds a valid sse MCP server with url and custom headers', async () => {
      const server = await repo.upsertMcpServer({
        name: 'Remote Database MCP',
        description: 'Postgres query server',
        transport: 'sse',
        url: 'http://127.0.0.1:8080/sse',
        headers: {
          'X-Custom-Auth': 'token123',
        },
        enabled: true,
      })

      expect(server.id).toBeDefined()
      expect(server.name).toBe('Remote Database MCP')
      expect(server.transport).toBe('sse')
      expect(server.url).toBe('http://127.0.0.1:8080/sse')
      expect(server.headers).toEqual({ 'X-Custom-Auth': 'token123' })
    })

    it('rejects stdio server with missing command or invalid env key', async () => {
      await expect(
        repo.upsertMcpServer({
          name: 'Bad Stdio',
          transport: 'stdio',
          command: '',
        }),
      ).rejects.toThrow('Invalid mcp server command')

      await expect(
        repo.upsertMcpServer({
          name: 'Bad Stdio Env',
          transport: 'stdio',
          command: 'node',
          env: {
            '123-invalid': 'value',
          },
        }),
      ).rejects.toThrow('Invalid environment variable key')
    })

    it('rejects sse server with remote non-https URL', async () => {
      await expect(
        repo.upsertMcpServer({
          name: 'Insecure Remote SSE',
          transport: 'sse',
          url: 'http://remote-server.com/sse',
        }),
      ).rejects.toThrow('远程供应商地址必须使用 HTTPS；HTTP 仅允许本机回环地址。')
    })

    it('updates existing MCP server', async () => {
      const created = await repo.upsertMcpServer({
        name: 'Git MCP',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git'],
        enabled: true,
      })

      const updated = await repo.upsertMcpServer({
        id: created.id,
        name: 'Git MCP (Updated)',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git', '--read-only'],
        enabled: false,
      })

      expect(updated.id).toBe(created.id)
      expect(updated.name).toBe('Git MCP (Updated)')
      expect(updated.args).toEqual(['mcp-server-git', '--read-only'])
      expect(updated.enabled).toBe(false)
    })

    it('toggles MCP server enabled flag', async () => {
      const created = await repo.upsertMcpServer({
        name: 'Weather MCP',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
        enabled: true,
      })

      const toggled = await repo.toggleMcpServer(created.id, false)
      expect(toggled.enabled).toBe(false)
      expect(repo.getMcpServer(created.id)?.enabled).toBe(false)

      const toggledBack = await repo.toggleMcpServer(created.id, true)
      expect(toggledBack.enabled).toBe(true)
      expect(repo.getMcpServer(created.id)?.enabled).toBe(true)
    })

    it('removes MCP server', async () => {
      const server1 = await repo.upsertMcpServer({
        name: 'Server To Remove 1',
        transport: 'stdio',
        command: 'node',
      })
      const server2 = await repo.upsertMcpServer({
        name: 'Server To Keep 2',
        transport: 'stdio',
        command: 'python',
      })

      const countBefore = repo.listMcpServers().length
      await repo.removeMcpServer(server1.id)
      const list = repo.listMcpServers()
      expect(list.length).toBe(countBefore - 1)
      expect(list.find((s) => s.id === server1.id)).toBeUndefined()
      expect(list.find((s) => s.id === server2.id)).toBeDefined()
    })

    it('saves and reads conversation with toolExecutions and mcpServerIds', async () => {
      const conversation = await repo.saveConversation({
        id: 'conv-mcp-1',
        title: 'MCP Conversation Test',
        modelId: 'openrouter-auto',
        agentMode: true,
        mcpServerIds: ['mcp-srv-1', 'mcp-srv-2'],
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Please list directory files',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'msg-2',
            role: 'assistant',
            content: 'Here are the files in current directory.',
            toolExecutions: [
              {
                id: 'call_123',
                toolName: 'list_directory',
                serverName: 'Filesystem Server',
                args: { path: '.' },
                result: '["file1.txt", "file2.txt"]',
                isError: false,
                status: 'complete',
              },
            ],
            createdAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      expect(conversation.mcpServerIds).toEqual(['mcp-srv-1', 'mcp-srv-2'])
      expect(conversation.messages[1]?.toolExecutions).toBeDefined()
      expect(conversation.messages[1]?.toolExecutions?.[0]?.toolName).toBe('list_directory')
      expect(conversation.messages[1]?.toolExecutions?.[0]?.args).toEqual({ path: '.' })
      expect(conversation.messages[1]?.toolExecutions?.[0]?.status).toBe('complete')
    })
  })
})
