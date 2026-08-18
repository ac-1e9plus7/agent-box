import type { McpServerConfig, McpToolDefinition, McpToolParameterSchema } from '../../shared/types'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface McpInitializeResult {
  protocolVersion: string
  capabilities: {
    tools?: Record<string, unknown>
    prompts?: Record<string, unknown>
    resources?: Record<string, unknown>
    logging?: Record<string, unknown>
  }
  serverInfo: {
    name: string
    version?: string
  }
}

export interface McpRawTool {
  name: string
  description?: string
  inputSchema?: McpToolParameterSchema
}

export interface McpListToolsResult {
  tools: McpRawTool[]
  nextCursor?: string
}

export interface McpToolContentBlock {
  type: 'text' | 'image' | 'resource'
  text?: string
  data?: string
  mimeType?: string
  resource?: {
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }
}

export interface McpCallToolResult {
  content: McpToolContentBlock[]
  isError?: boolean
}

export interface McpTransport {
  start(): Promise<void>
  send(message: JsonRpcMessage): Promise<void>
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  close(): Promise<void>
  readonly isConnected: boolean
}
