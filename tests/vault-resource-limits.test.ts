import { describe, expect, it } from 'vitest'
import {
  assertConversationCollectionLimits,
  assertConversationMutationAllowed,
} from '../src/electron/storage/vault-resource-limits'
import type { Conversation } from '../src/shared/types'

const timestamp = '2026-08-15T00:00:00.000Z'
const conversation: Conversation = {
  id: 'conversation',
  title: 'Conversation',
  modelId: 'model',
  messages: [
    {
      id: 'assistant',
      role: 'assistant',
      content: 'Answer',
      citations: [
        { url: 'https://example.com/one' },
        { url: 'https://example.com/two' },
      ],
      createdAt: timestamp,
    },
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
}

describe('aggregate vault resource limits', () => {
  it('accepts a bounded conversation collection', () => {
    expect(() =>
      assertConversationCollectionLimits([conversation], {
        maxSerializedBytes: 10_000,
        maxMessages: 1,
        maxCitations: 2,
      }),
    ).not.toThrow()
  })

  it('enforces aggregate message, citation, and serialized-byte limits', () => {
    expect(() =>
      assertConversationCollectionLimits([conversation], {
        maxSerializedBytes: 10_000,
        maxMessages: 0,
        maxCitations: 2,
      }),
    ).toThrow('too many messages')
    expect(() =>
      assertConversationCollectionLimits([conversation], {
        maxSerializedBytes: 10_000,
        maxMessages: 1,
        maxCitations: 1,
      }),
    ).toThrow('too many citations')
    expect(() =>
      assertConversationCollectionLimits([conversation], {
        maxSerializedBytes: 10,
        maxMessages: 1,
        maxCitations: 2,
      }),
    ).toThrow('too large')
  })

  it('lets a legacy over-limit vault stay unchanged or shrink but not grow', () => {
    const limits = {
      maxSerializedBytes: 1,
      maxMessages: 0,
      maxCitations: 1,
    }
    expect(() =>
      assertConversationMutationAllowed([conversation], [conversation], limits),
    ).not.toThrow()
    expect(() =>
      assertConversationMutationAllowed([conversation], [], limits),
    ).not.toThrow()
    expect(() =>
      assertConversationMutationAllowed(
        [conversation],
        [
          conversation,
          {
            ...conversation,
            id: 'second',
          },
        ],
        limits,
      ),
    ).toThrow()
  })
})
