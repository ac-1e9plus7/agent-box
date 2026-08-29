import { describe, expect, it } from 'vitest'
import type { McpToolDefinition, Message } from '../src/shared/types'
import {
  compactOlderAgentTurns,
  compactToolResultsForModel,
  formatFullToolResult,
  readTextChunk,
  restoreDynamicallyExposedTools,
  searchAdditionalTools,
  seedFullToolResultStore,
  selectInitialDynamicTools,
  type FullToolResultStore,
} from '../src/electron/api/agent-token-optimization'

function tool(name: string, description: string, serverId = 'test'): McpToolDefinition {
  return {
    name,
    modelName: `safe_${name}`,
    description,
    inputSchema: { type: 'object', properties: {} },
    serverId,
    serverName: serverId,
  }
}

function completeTurn(turn: number, callId: string, result = 'ok'): Message {
  return {
    id: `assistant-${turn}`,
    role: 'assistant',
    content: '',
    createdAt: new Date(0).toISOString(),
    agentTrace: [
      {
        type: 'tool_call',
        turn,
        callId,
        toolName: 'read',
        modelToolName: 'safe_read',
        args: { path: `${turn}.txt` },
      },
      { type: 'tool_result', turn, callId, toolName: 'read', result },
    ],
  }
}

describe('Agent token optimization helpers', () => {
  it('keeps full results in the local store while producing a bounded deterministic model preview', () => {
    const fullResult = `${'head-'.repeat(800)}CENTER${'-tail'.repeat(800)}`
    const messages: Message[] = [completeTurn(1, 'call-result-1', fullResult)]
    const store: FullToolResultStore = new Map()

    seedFullToolResultStore(messages, store)
    const compacted = compactToolResultsForModel(messages, 1_000)
    const preview = compacted[0]?.agentTrace?.find((item) => item.type === 'tool_result')

    expect(preview?.type).toBe('tool_result')
    if (preview?.type !== 'tool_result') throw new Error('Expected a compacted result')
    expect(preview.result).toHaveLength(1_000)
    expect(preview.result).toContain('call_id="call-result-1"')
    expect(preview.result).toContain('head-head-')
    expect(preview.result).toContain('-tail-tail')
    expect(preview.resultContent).toBeUndefined()
    expect(preview.resultTruncated).toBe(true)
    expect(messages[0]?.agentTrace?.find((item) => item.type === 'tool_result')).toMatchObject({ result: fullResult })
    expect(formatFullToolResult(store.get('call-result-1')!)).toBe(fullResult)
    expect(compactToolResultsForModel(messages, 1_000)).toEqual(compacted)
  })

  it('preserves image payloads while compacting oversized textual tool results', () => {
    const messages: Message[] = [
      {
        id: 'assistant-media',
        role: 'assistant',
        content: '',
        createdAt: new Date(0).toISOString(),
        toolExecutions: [
          {
            id: 'call-image',
            toolName: 'browser_screenshot',
            args: {},
            result: 'metadata '.repeat(500),
            resultContent: [{ type: 'image', mimeType: 'image/jpeg', data: 'a'.repeat(32_000) }],
            structuredResult: { page: 'example', details: 'x'.repeat(2_000) },
            status: 'complete',
          },
        ],
        agentTrace: [
          {
            type: 'tool_result',
            turn: 1,
            callId: 'call-image',
            toolName: 'browser_screenshot',
            result: 'metadata '.repeat(500),
            resultContent: [{ type: 'image', mimeType: 'image/jpeg', data: 'a'.repeat(32_000) }],
            structuredResult: { page: 'example', details: 'x'.repeat(2_000) },
          },
        ],
      },
    ]

    const compacted = compactToolResultsForModel(messages, 1_000)
    const result = compacted[0]?.agentTrace?.find((item) => item.type === 'tool_result')

    if (result?.type !== 'tool_result') throw new Error('Expected a compacted image result')
    expect(result.result).toContain('call_id="call-image"')
    expect(result.resultContent).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: 'a'.repeat(32_000) }])
    expect(result.structuredResult).toBeUndefined()
    expect(result.resultTruncated).toBe(true)
    expect(compacted[0]?.toolExecutions?.[0]?.resultContent).toBeUndefined()
    expect(compactToolResultsForModel(compacted, 1_000)).toEqual(compacted)
  })

  it('caps retained replay images below the checkpoint artifact budget', () => {
    const messages: Message[] = [
      {
        id: 'assistant-many-images',
        role: 'assistant',
        content: '',
        createdAt: new Date(0).toISOString(),
        agentTrace: [
          {
            type: 'tool_result',
            turn: 1,
            callId: 'call-many-images',
            toolName: 'browser_screenshot',
            result: 'metadata '.repeat(500),
            resultContent: [
              { type: 'image', mimeType: 'image/jpeg', data: 'a'.repeat(1_500_000) },
              { type: 'image', mimeType: 'image/jpeg', data: 'b'.repeat(1_500_000) },
            ],
          },
        ],
      },
    ]

    const compacted = compactToolResultsForModel(messages, 1_000)
    const result = compacted[0]?.agentTrace?.find((item) => item.type === 'tool_result')

    if (result?.type !== 'tool_result') throw new Error('Expected a compacted image result')
    expect(result.resultContent).toHaveLength(1)
    expect(result.resultContent?.[0]).toMatchObject({ data: 'a'.repeat(1_500_000) })
  })

  it('includes structured and content payloads in the complete chunk source', () => {
    const messages = [completeTurn(1, 'call-structured')]
    messages[0]!.agentTrace![1] = {
      type: 'tool_result',
      turn: 1,
      callId: 'call-structured',
      toolName: 'read',
      result: 'plain',
      resultContent: [{ type: 'text', text: 'content' }],
      structuredResult: { z: 1, a: 2 },
    }
    const store: FullToolResultStore = new Map()
    seedFullToolResultStore(messages, store)

    const complete = formatFullToolResult(store.get('call-structured')!)
    expect(complete).toContain('[result_content]')
    expect(complete).toContain('[structured_result]')
    expect(complete).toContain('{"a":2,"z":1}')
    expect(readTextChunk(complete, 5, 9)).toMatchObject({ offset: 5, nextOffset: 14 })
  })

  it('routes the initial catalog with a limit and searches only additional authorized tools', () => {
    const catalog = [
      tool('read_file', 'Read source files from a workspace', 'built-in'),
      tool('write_file', 'Write source files to a workspace', 'built-in'),
      tool('weather', 'Fetch weather forecasts for a city', 'mcp-weather'),
    ]
    const initial = selectInitialDynamicTools('Please inspect and read source files', catalog, 1)

    expect(initial.map((item) => item.name)).toEqual(['read_file'])
    expect(searchAdditionalTools('safe_weather', catalog, initial, 2).map((item) => item.name)).toEqual(['weather'])
    expect(searchAdditionalTools('read_file', initial, [], 2)).toEqual(initial)

    const checkpoint: Message = {
      id: 'checkpoint',
      role: 'assistant',
      content: '',
      createdAt: new Date(0).toISOString(),
      agentTrace: [
        {
          type: 'tool_call',
          turn: 1,
          callId: 'search-1',
          toolName: 'search_tools',
          modelToolName: 'agentbox_search_tools',
          args: { query: 'safe_weather', max_tools: 1 },
        },
        { type: 'tool_result', turn: 1, callId: 'search-1', toolName: 'search_tools', result: 'loaded' },
      ],
    }
    expect(restoreDynamicallyExposedTools(checkpoint, catalog, [], 2).map((item) => item.name)).toEqual(['weather'])
  })

  it('replaces only complete older current-run tool turns and preserves the configured recent turns', () => {
    const longResult = 'x'.repeat(8_000)
    const messages: Message[] = [
      { id: 'user', role: 'user', content: 'Do the work', createdAt: new Date(0).toISOString() },
      completeTurn(1, 'call-1', longResult),
      completeTurn(2, 'call-2', longResult),
      {
        id: 'incomplete',
        role: 'assistant',
        content: '',
        createdAt: new Date(0).toISOString(),
        agentTrace: [
          {
            type: 'tool_call',
            turn: 3,
            callId: 'call-incomplete',
            toolName: 'write',
            modelToolName: 'safe_write',
            args: {},
          },
        ],
      },
      completeTurn(4, 'call-4', longResult),
    ]

    const compacted = compactOlderAgentTurns(messages, {
      contextWindow: 10_000,
      maxOutputTokens: 1_000,
      thresholdPercent: 50,
      keepRecentTurns: 1,
    })

    expect(compacted.some((message) => message.id === 'assistant-1')).toBe(false)
    expect(compacted.some((message) => message.id === 'assistant-2')).toBe(false)
    expect(compacted.some((message) => message.id === 'assistant-4')).toBe(true)
    expect(compacted.some((message) => message.id === 'incomplete')).toBe(true)
    const summary = compacted.find((message) => message.id === 'agentbox-model-context-summary')
    expect(summary?.agentTrace).toBeUndefined()
    expect(summary?.content).toContain('call_id="call-1"')
    expect(summary?.content).toContain('call_id="call-2"')
    expect(summary?.content).not.toContain('call_id="call-4"')
  })

  it('does nothing below the soft threshold', () => {
    const messages: Message[] = [
      { id: 'user', role: 'user', content: 'Short request', createdAt: new Date(0).toISOString() },
      completeTurn(1, 'call-short'),
      completeTurn(2, 'call-recent'),
    ]
    expect(
      compactOlderAgentTurns(messages, {
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        thresholdPercent: 70,
        keepRecentTurns: 1,
      }),
    ).toEqual(messages)
  })
})
