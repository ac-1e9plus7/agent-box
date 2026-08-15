import { Buffer } from 'node:buffer'
import type { Conversation } from '../../shared/types'

const DEFAULT_LIMITS: ConversationCollectionLimits = {
  maxSerializedBytes: 50 * 1024 * 1024,
  maxMessages: 100_000,
  maxCitations: 100_000,
}

export interface ConversationCollectionLimits {
  maxSerializedBytes: number
  maxMessages: number
  maxCitations: number
}

export interface ConversationCollectionUsage {
  serializedBytes: number
  messages: number
  citations: number
}

/**
 * Applies aggregate limits in addition to each conversation/message limit.
 * Counting the exact serialized UTF-8 representation also accounts for JSON
 * escaping and multi-byte text, rather than treating a JS character as a byte.
 */
export function assertConversationCollectionLimits(
  conversations: Conversation[],
  limits: ConversationCollectionLimits = DEFAULT_LIMITS,
): void {
  const usage = measureConversationCollection(conversations)
  assertUsageWithinLimits(usage, limits)
}

/**
 * Legacy schema-v1 vaults are loaded without this newer aggregate quota. A
 * save may keep or reduce an already-over-limit dimension, but never grow it;
 * this lets users delete or shrink old data instead of locking the vault.
 */
export function assertConversationMutationAllowed(
  current: Conversation[],
  next: Conversation[],
  limits: ConversationCollectionLimits = DEFAULT_LIMITS,
): void {
  const before = measureConversationCollection(current)
  const after = measureConversationCollection(next)
  assertDimensionMutationAllowed(
    before.serializedBytes,
    after.serializedBytes,
    limits.maxSerializedBytes,
    'Vault conversation data is too large',
  )
  assertDimensionMutationAllowed(
    before.messages,
    after.messages,
    limits.maxMessages,
    'Vault contains too many messages',
  )
  assertDimensionMutationAllowed(
    before.citations,
    after.citations,
    limits.maxCitations,
    'Vault contains too many citations',
  )
}

export function measureConversationCollection(
  conversations: Conversation[],
): ConversationCollectionUsage {
  let serializedBytes = 2 // []
  let messages = 0
  let citations = 0

  for (const conversation of conversations) {
    messages += conversation.messages.length
    citations += conversation.messages.reduce(
      (total, message) => total + (message.citations?.length ?? 0),
      0,
    )
    const serialized = JSON.stringify(conversation)
    serializedBytes += Buffer.byteLength(serialized, 'utf8') + 1
  }
  return { serializedBytes, messages, citations }
}

function assertUsageWithinLimits(
  usage: ConversationCollectionUsage,
  limits: ConversationCollectionLimits,
): void {
  if (usage.messages > limits.maxMessages) {
    throw new Error('Vault contains too many messages')
  }
  if (usage.citations > limits.maxCitations) {
    throw new Error('Vault contains too many citations')
  }
  if (usage.serializedBytes > limits.maxSerializedBytes) {
    throw new Error('Vault conversation data is too large')
  }
}

function assertDimensionMutationAllowed(
  before: number,
  after: number,
  limit: number,
  message: string,
): void {
  if (after > limit && after > before) throw new Error(message)
}
