import { describe, expect, it } from 'vitest'
import { parseAnthropicEvent } from '../src/electron/api/protocol-adapters'
import { applyStreamEvent } from '../src/renderer/src/hooks/useChatStream'
import type { Conversation } from '../src/renderer/src/types'
import type { TokenUsageDetails } from '../src/shared/types'

const timestamp = '2026-01-01T00:00:00.000Z'

describe('streamed token usage', () => {
  it('merges partial fields within a model request and sums separate Agent turns', () => {
    let conversation: Conversation = {
      id: 'conversation',
      title: 'Usage',
      modelId: 'model',
      messages: [
        {
          id: 'assistant',
          role: 'assistant',
          content: '',
          createdAt: timestamp,
          status: 'streaming',
        },
      ],
      currentLeafId: 'assistant',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const stream = {
      requestId: 'request',
      conversationId: conversation.id,
      assistantMessageId: 'assistant',
      agentMode: true,
    }
    const applyUsage = (turn: number, usage: TokenUsageDetails): void => {
      conversation = applyStreamEvent(conversation, stream, {
        type: 'usage',
        requestId: 'request',
        turn,
        usage,
      })
    }

    const anthropicStart = parseAnthropicEvent({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 15,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 12,
        },
      },
    }).usage
    const anthropicDelta = parseAnthropicEvent({
      type: 'message_delta',
      usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } },
    }).usage
    if (!anthropicStart || !anthropicDelta) throw new Error('Expected Anthropic usage fragments')
    applyUsage(1, anthropicStart)
    applyUsage(1, anthropicDelta)

    expect(conversation.messages[0]?.usage).toMatchObject({
      inputTokens: 117,
      outputTokens: 7,
      reasoningTokens: 3,
      cachedInputTokens: 90,
      cacheWriteTokens: 12,
      totalTokens: 124,
    })

    applyUsage(2, { inputTokens: 50, cachedInputTokens: 20 })
    applyUsage(2, { outputTokens: 10, totalTokens: 60 })

    expect(conversation.messages[0]?.usage).toEqual({
      inputTokens: 167,
      outputTokens: 17,
      reasoningTokens: 3,
      cachedInputTokens: 110,
      cacheWriteTokens: 12,
      totalTokens: 184,
      modelRequests: [
        {
          turn: 1,
          inputTokens: 117,
          outputTokens: 7,
          reasoningTokens: 3,
          cachedInputTokens: 90,
          cacheWriteTokens: 12,
        },
        {
          turn: 2,
          inputTokens: 50,
          outputTokens: 10,
          cachedInputTokens: 20,
          totalTokens: 60,
        },
      ],
    })
  })
})
