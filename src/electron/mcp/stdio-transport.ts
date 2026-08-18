import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, McpTransport } from './mcp-types'

export class StdioMcpTransport implements McpTransport {
  private process: ChildProcess | undefined
  private buffer = ''
  private readonly pendingRequests = new Map<
    string | number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  private stderrBuffer = ''
  private _isConnected = false

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {},
  ) {}

  get isConnected(): boolean {
    return this._isConnected
  }

  async start(): Promise<void> {
    if (this._isConnected) return

    return new Promise((resolve, reject) => {
      let started = false
      try {
        this.process = spawn(this.command, this.args, {
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        })
      } catch (err) {
        return reject(new Error(`无法启动 MCP 子进程: ${err instanceof Error ? err.message : String(err)}`))
      }

      this.process.on('error', (err) => {
        this._isConnected = false
        this.cleanupPending(err)
        if (!started) {
          started = true
          reject(new Error(`MCP 子进程启动失败: ${err.message}`))
        }
      })

      this.process.on('exit', (code, signal) => {
        this._isConnected = false
        const exitMsg = `MCP 子进程已退出 (code: ${code ?? 'none'}, signal: ${signal ?? 'none'})${this.stderrBuffer ? `\nStderr: ${this.stderrBuffer.slice(-2048)}` : ''}`
        this.cleanupPending(new Error(exitMsg))
      })

      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.handleStdoutData(chunk)
      })

      this.process.stderr?.on('data', (chunk: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-16384)
      })

      this._isConnected = true
      started = true
      resolve()
    })
  }

  private handleStdoutData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage
        this.handleMessage(message)
      } catch {
        // Ignore non-JSON lines (e.g. tool startup banners)
      }
    }
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
    if (!this.process?.stdin || !this._isConnected) {
      throw new Error('MCP 子进程未连接或已关闭')
    }
    const payload = JSON.stringify(message) + '\n'
    return new Promise((resolve, reject) => {
      this.process!.stdin!.write(payload, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
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
    if (this.process) {
      try {
        this.process.kill('SIGTERM')
      } catch {
        // ignore
      }
      const proc = this.process
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 2000)
      this.process = undefined
    }
  }
}
