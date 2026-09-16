import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { McpClient, safeMcpError } from '../src/electron/mcp/mcp-client'
import { getLanguage, setLanguage } from '../src/shared/i18n'

const config = {
  id: 'lifecycle',
  name: 'Fixture',
  enabled: true,
  transport: 'http' as const,
  url: 'https://example.test/mcp',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
afterEach(() => vi.restoreAllMocks())

describe('MCP connection ownership', () => {
  it('cancels one connection waiter without cancelling another consumer', async () => {
    let release!: () => void
    vi.spyOn(Client.prototype, 'connect').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    vi.spyOn(Client.prototype, 'close').mockResolvedValue()
    vi.spyOn(StreamableHTTPClientTransport.prototype, 'close').mockResolvedValue()
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] })
    const client = new McpClient(config)
    const controller = new AbortController()
    const cancelled = client.listTools(controller.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const surviving = client.listTools()
    controller.abort()
    await rejected
    release()
    await expect(surviving).resolves.toEqual([])
    expect(client.isConnected).toBe(true)
    await client.close()
  })
  it('shares one initialization among concurrent consumers', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(() => barrier)
    vi.spyOn(Client.prototype, 'close').mockResolvedValue()
    vi.spyOn(StreamableHTTPClientTransport.prototype, 'close').mockResolvedValue()
    const client = new McpClient(config)
    const first = client.connect()
    const second = client.connect()
    release()
    await Promise.all([first, second])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(client.isConnected).toBe(true)
    await client.close()
    expect(client.isConnected).toBe(false)
  })

  it('closes pending transports and prevents completion after shutdown', async () => {
    let release!: () => void
    vi.spyOn(Client.prototype, 'connect').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const closeClient = vi.spyOn(Client.prototype, 'close').mockResolvedValue()
    const closeTransport = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close').mockResolvedValue()
    const client = new McpClient(config)
    const pending = client.connect()
    const rejected = expect(pending).rejects.toThrow()
    await client.close()
    release()
    await rejected
    expect(closeClient).toHaveBeenCalledTimes(1)
    expect(closeTransport).toHaveBeenCalledTimes(1)
    expect(client.isConnected).toBe(false)
  })

  it('cleans failed HTTP attempts before SSE fallback and permits retry', async () => {
    vi.spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(new Error('private-token'))
      .mockRejectedValueOnce(new Error('private-token'))
      .mockResolvedValue()
    const closeClient = vi.spyOn(Client.prototype, 'close').mockResolvedValue()
    const closeHttp = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close').mockResolvedValue()
    const closeSse = vi.spyOn(SSEClientTransport.prototype, 'close').mockResolvedValue()
    const client = new McpClient(config)
    await expect(client.connect()).rejects.not.toThrow('private-token')
    expect(closeClient).toHaveBeenCalledTimes(2)
    expect(closeHttp).toHaveBeenCalledTimes(1)
    expect(closeSse).toHaveBeenCalledTimes(1)
    await client.connect()
    expect(client.isConnected).toBe(true)
    await client.close()
  })

  it('localizes safe diagnostics and never echoes upstream secrets or causes', () => {
    const original = getLanguage()
    try {
      for (const language of ['en-US', 'zh-CN'] as const) {
        setLanguage(language)
        const error = Object.assign(new Error('Authorization: secret-fixture', { cause: 'secret-fixture' }), {
          code: 'ECONNREFUSED',
        })
        const result = safeMcpError(error)
        expect(result).not.toContain('secret-fixture')
        expect(result).toContain('ECONNREFUSED')
        expect(result).toContain(language === 'en-US' ? 'Check' : '检查')
      }
    } finally {
      setLanguage(original)
    }
  })
})
