import { randomUUID } from 'node:crypto'
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, McpTransport } from './mcp-types'

export class SseMcpTransport implements McpTransport {
  private abortController: AbortController | undefined
  private postEndpoint: string | undefined
  private _isConnected = false
  private readonly pendingRequests = new Map<
    string | number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()

  constructor(
    private readonly sseUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  get isConnected(): boolean {
    return this._isConnected
  }

  async start(): Promise<void> {
    if (this._isConnected) return

    this.abortController = new AbortController()
    const controller = this.abortController

    let initialResolve: (() => void) | undefined
    let initialReject: ((err: Error) => void) | undefined

    const connectionPromise = new Promise<void>((resolve, reject) => {
      initialResolve = resolve
      initialReject = reject
    })

    const timeout = setTimeout(() => {
      if (initialReject) {
        initialReject(new Error(`SSE MCP 连接超时 (${this.sseUrl})`))
        initialReject = undefined
      }
    }, 15_000)

    ;(async () => {
      try {
        const response = await fetch(this.sseUrl, {
          headers: {
            Accept: 'text/event-stream',
            ...this.headers,
          },
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          throw new Error(`SSE 连接失败: HTTP ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = 'message'

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              const data = line.slice(5).trim()
              if (currentEvent === 'endpoint') {
                // MCP SSE spec: endpoint event gives the POST endpoint URL for JSON-RPC
                try {
                  const resolvedUrl = new URL(data, this.sseUrl).toString()
                  this.postEndpoint = resolvedUrl
                } catch {
                  this.postEndpoint = data
                }
                this._isConnected = true
                clearTimeout(timeout)
                if (initialResolve) {
                  initialResolve()
                  initialResolve = undefined
                }
              } else if (currentEvent === 'message') {
                if (!this._isConnected) {
                  this._isConnected = true
                  clearTimeout(timeout)
                  if (initialResolve) {
                    initialResolve()
                    initialResolve = undefined
                  }
                }
                try {
                  const message = JSON.parse(data) as JsonRpcMessage
                  this.handleMessage(message)
                } catch {
                  // ignore malformed data
                }
              }
            } else if (!line.trim()) {
              currentEvent = 'message'
            }
          }
        }
      } catch (err) {
        this._isConnected = false
        clearTimeout(timeout)
        if (initialReject) {
          initialReject(err instanceof Error ? err : new Error(String(err)))
          initialReject = undefined
        }
        this.cleanupPending(err instanceof Error ? err : new Error(String(err)))
      }
    })()

    return connectionPromise
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ('id' in message && message.id !== undefined && message.id !== null) {
      const pending = this.pendingRequests.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.id)
        if ('error' in message && message.error) {
          pending.reject(new Error(`MCP 错误 (${message.error.code}): ${message.error.message}`))
        } else {
          pending.resolve((message as JsonRpcResponse).result)
        }
      }
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const endpoint = this.postEndpoint || this.sseUrl
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(message),
    })

    if (!response.ok) {
      throw new Error(`MCP 请求发送失败: HTTP ${response.status}`)
    }
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this._isConnected) {
      await this.start()
    }
    const id = randomUUID()
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`MCP 请求超时 (${method}, ${timeoutMs}ms)`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.send(msg).catch((err) => {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(err)
      })
    })
  }

  private cleanupPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  async close(): Promise<void> {
    this._isConnected = false
    this.cleanupPending(new Error('MCP 传输层已关闭'))
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = undefined
    }
  }
}
