import { describe, expect, it } from 'vitest'
import {
  parseAnthropicEvent,
  parseChatCompletionEvent,
  parseResponsesEvent,
} from '../src/electron/api/protocol-adapters'
import { buildRequestBody } from '../src/electron/api/request-adapters'
import {
  buildSkillRetrievalQuery,
  retrieveExplicitlyMentionedSkills,
  retrieveRelevantSkills,
} from '../src/electron/api/skill-retriever'
import { DEFAULT_SKILLS, localizedDefaultSkills } from '../src/electron/storage/default-skills'
import { createModelToolName } from '../src/electron/mcp/mcp-client'
import { evaluateToolApproval, validateToolArguments } from '../src/electron/mcp/tool-policy'
import type { ChatRequest, McpToolDefinition, Message, ModelConfig, Skill } from '../src/shared/types'

const timestamp = '2026-08-21T00:00:00.000Z'
const model: ModelConfig = {
  id: 'model-1',
  name: 'Model',
  providerId: 'provider-1',
  remoteId: 'model/remote',
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  supportsReasoning: false,
  defaultReasoningEnabled: false,
  defaultReasoningEffort: 'medium',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const request: ChatRequest = {
  conversationId: 'conversation-1',
  modelId: model.id,
  messages: [],
  reasoningEnabled: false,
  agentMode: true,
}

const tool: McpToolDefinition = {
  name: 'read_file',
  modelName: 'mcp_abc_read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  serverId: 'server-a',
  serverName: 'Filesystem',
}

function messagesWithTrace(): Message[] {
  return [
    { id: 'user-1', role: 'user', content: 'Read package.json', createdAt: timestamp },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'The package name is agentbox.',
      createdAt: timestamp,
      agentTrace: [
        { type: 'assistant_text', turn: 1, text: 'I will inspect the file.' },
        {
          type: 'tool_call',
          turn: 1,
          callId: 'call-1',
          toolName: 'read_file',
          modelToolName: 'mcp_abc_read_file',
          serverId: 'server-a',
          serverName: 'Filesystem',
          args: { path: 'package.json' },
        },
        {
          type: 'tool_result',
          turn: 1,
          callId: 'call-1',
          toolName: 'read_file',
          result: '{"name":"agentbox"}',
        },
        { type: 'assistant_text', turn: 2, text: 'The package name is agentbox.' },
      ],
    },
  ]
}

describe('agent protocol ledger', () => {
  it('parses every parallel Chat Completions tool call in one delta', () => {
    const parsed = parseChatCompletionEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call-a', function: { name: 'one', arguments: '{}' } },
              { index: 1, id: 'call-b', function: { name: 'two', arguments: '{}' } },
            ],
          },
        },
      ],
    })
    expect(parsed.toolCallDeltas).toHaveLength(2)
    expect(parsed.toolCallDeltas?.map((item) => item.id)).toEqual(['call-a', 'call-b'])
  })

  it('preserves Responses call_id separately from the output item id', () => {
    const parsed = parseResponsesEvent({
      type: 'response.output_item.added',
      output_index: 3,
      item: {
        type: 'function_call',
        id: 'fc_item_1',
        call_id: 'call_1',
        name: 'mcp_abc_read_file',
        arguments: '',
      },
    })
    expect(parsed.toolCallDeltas?.[0]).toMatchObject({
      index: 3,
      itemId: 'fc_item_1',
      id: 'call_1',
    })
  })

  it('replays function_call and function_call_output for Responses', () => {
    const body = buildRequestBody('openai-responses', { kind: 'openai' }, model, messagesWithTrace(), request, 4_096, [
      tool,
    ])
    const input = body.input as Array<Record<string, unknown>>
    expect(input).toContainEqual({
      type: 'function_call',
      call_id: 'call-1',
      name: 'mcp_abc_read_file',
      arguments: '{"path":"package.json"}',
    })
    expect(input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{"name":"agentbox"}',
    })
  })

  it('preserves Responses reasoning output items for stateless tool continuation', () => {
    const parsed = parseResponsesEvent({
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
    })
    expect(parsed.responseOutputItem).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' })
    const traced = messagesWithTrace()
    traced[1]!.agentTrace = [
      { type: 'provider_item', turn: 1, format: 'openai-responses', item: parsed.responseOutputItem! },
      ...(traced[1]!.agentTrace || []),
    ]
    const body = buildRequestBody('openai-responses', { kind: 'openai' }, model, traced, request, 4_096, [tool])
    expect(body.input).toContainEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' })
  })

  it('replays ordered tool messages for Chat and Anthropic', () => {
    const chat = buildRequestBody(
      'openai-chat-completions',
      { kind: 'openai' },
      model,
      messagesWithTrace(),
      request,
      4_096,
      [tool],
    )
    const chatMessages = chat.messages as Array<Record<string, unknown>>
    expect(chatMessages.some((message) => message.role === 'tool' && message.tool_call_id === 'call-1')).toBe(true)

    const anthropic = buildRequestBody(
      'anthropic-messages',
      { kind: 'anthropic' },
      model,
      messagesWithTrace(),
      request,
      4_096,
      [tool],
    )
    const anthropicMessages = anthropic.messages as Array<{ role: string; content: unknown }>
    expect(
      anthropicMessages.some(
        (message) => message.role === 'user' && JSON.stringify(message.content).includes('tool_result'),
      ),
    ).toBe(true)
  })

  it('preserves Anthropic thinking signatures around tool use', () => {
    expect(
      parseAnthropicEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'signed-thinking' },
      }).anthropicThinkingDelta,
    ).toEqual({ index: 0, signatureDelta: 'signed-thinking' })

    const traced = messagesWithTrace()
    traced[1]!.agentTrace = [
      {
        type: 'assistant_thinking',
        turn: 1,
        blockIndex: 0,
        thinking: 'private reasoning',
        signature: 'signed-thinking',
      },
      ...(traced[1]!.agentTrace || []),
    ]
    const body = buildRequestBody('anthropic-messages', { kind: 'anthropic' }, model, traced, request, 4_096, [tool])
    const conversation = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(conversation[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'private reasoning',
      signature: 'signed-thinking',
    })
  })
})

describe('tool security policy', () => {
  it('validates arguments against the MCP JSON Schema', () => {
    expect(validateToolArguments(tool, { path: 'README.md' }).ok).toBe(true)
    const invalid = validateToolArguments(tool, { wrong: true })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.message).toContain('path')
  })

  it('auto-runs only explicit low-risk tools under the sensitive policy', () => {
    expect(evaluateToolApproval('sensitive', tool).required).toBe(false)
    expect(evaluateToolApproval('sensitive', { ...tool, annotations: undefined }).required).toBe(true)
    expect(evaluateToolApproval('always', tool).required).toBe(true)
    expect(evaluateToolApproval('full-access', { ...tool, annotations: undefined }).required).toBe(false)
  })

  it('creates stable, server-scoped, provider-safe aliases', () => {
    const first = createModelToolName('server-a', 'read.file')
    const second = createModelToolName('server-b', 'read.file')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9A-Za-z_-]{1,64}$/)
    expect(createModelToolName('server-a', 'read.file')).toBe(first)
  })
})

describe('progressive skill loading', () => {
  const skills: Skill[] = [
    {
      id: 'translator',
      name: '专业翻译',
      description: '翻译与本地化',
      entryFile: 'SKILL.md',
      files: [{ path: 'SKILL.md', kind: 'markdown', content: '保持术语一致并进行中文翻译。' }],
      enabled: true,
    },
    {
      id: 'data-analysis',
      name: '数据分析',
      description: '统计与图表',
      entryFile: 'SKILL.md',
      files: [{ path: 'SKILL.md', kind: 'markdown', content: '计算均值、方差与分位数。' }],
      enabled: true,
    },
  ]

  it('loads only skills relevant to the current request', () => {
    expect(retrieveRelevantSkills('请把这段内容翻译成中文', skills).map((skill) => skill.id)).toEqual(['translator'])
    expect(retrieveRelevantSkills('今天天气如何', skills)).toEqual([])
  })

  it.each([
    ['写一个快速排序', 'code-interpreter'],
    ['检查这段代码为什么报错', 'code-interpreter'],
    ['分析这个 CSV 并画图', 'data-analyst'],
    ['把这段英文翻译成中文', 'translator-polyglot'],
    ['总结这篇 PDF 研报', 'web-extractor'],
    ['帮我优化 system prompt', 'prompt-optimizer'],
  ])('routes a real built-in request %s to %s', (query, expectedId) => {
    // Production routes against the active-language skill catalog (listSkills()
    // materializes localized built-ins); match that precondition here so a
    // Chinese query is scored against Chinese-localized skill content.
    expect(retrieveRelevantSkills(query, localizedDefaultSkills()).map((skill) => skill.id)).toContain(expectedId)
  })

  it('treats a $skill id as an explicit invocation', () => {
    expect(
      retrieveExplicitlyMentionedSkills('请使用 $translator-polyglot', DEFAULT_SKILLS).map((skill) => skill.id),
    ).toEqual(['translator-polyglot'])
  })

  it('uses recent context and attachment metadata for routing', () => {
    const query = buildSkillRetrievalQuery([
      { id: 'u1', role: 'user', content: '这是销售数据', createdAt: timestamp },
      {
        id: 'u2',
        role: 'user',
        content: '继续处理',
        attachments: [
          { id: 'a1', name: 'sales.csv', mimeType: 'text/csv', size: 12, data: 'region,revenue', type: 'text' },
        ],
        createdAt: timestamp,
      },
    ])
    expect(query).toContain('sales.csv')
    expect(retrieveRelevantSkills(query, DEFAULT_SKILLS).map((skill) => skill.id)).toContain('data-analyst')
  })
})
