import type { ContextManagementMode, Message } from '../../shared/types'

const PER_MESSAGE_OVERHEAD = 8
const REQUEST_OVERHEAD = 64
const RESERVED_SAFETY_TOKENS = 128

export class ContextWindowError extends Error {
  readonly code = 'context_window_exceeded'

  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowError'
  }
}

/** A dependency-free, deliberately conservative token estimate. */
export function estimateTextTokens(text: string): number {
  let cjkAndWideCharacters = 0
  let otherCharacters = 0

  for (const character of text) {
    if (/[^\u0000-\u024f]/u.test(character)) cjkAndWideCharacters += 1
    else otherCharacters += character.length
  }

  return cjkAndWideCharacters + Math.ceil(otherCharacters / 4)
}

export function estimateMessageTokens(message: Message): number {
  return PER_MESSAGE_OVERHEAD + estimateTextTokens(message.content)
}

export interface ContextPreparationResult {
  messages: Message[]
  estimatedInputTokens: number
  removedMessageCount: number
}

export function resolveContextManagementMode(
  configuredMode: ContextManagementMode,
  allowContextTrimming?: boolean,
): ContextManagementMode {
  return allowContextTrimming ? 'auto' : configuredMode
}

/**
 * Removes the oldest expendable turns until the prompt fits the configured
 * window. System messages and the most recent user message are never removed.
 */
export function prepareMessagesForContext(
  messages: Message[],
  contextWindow: number,
  maxOutputTokens: number,
  mode: ContextManagementMode = 'manual',
): ContextPreparationResult {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('模型上下文窗口配置无效。')
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error('模型最大输出长度配置无效。')
  }

  const inputBudget = contextWindow - maxOutputTokens - RESERVED_SAFETY_TOKENS
  if (inputBudget <= REQUEST_OVERHEAD) {
    throw new ContextWindowError(
      '上下文窗口不足以为模型输出预留空间。请降低最大输出 Token 或增大模型上下文窗口。',
    )
  }

  const systemMessages = messages.filter((message) => message.role === 'system')
  const turns = groupConversationTurns(messages)
  const latestTurn = turns.at(-1)
  if (!latestTurn?.some((message) => message.role === 'user')) {
    throw new Error('发送内容必须包含用户消息。')
  }
  const fullInputEstimate =
    REQUEST_OVERHEAD +
    messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)

  if (mode === 'manual') {
    if (fullInputEstimate > inputBudget) {
      throw new ContextWindowError(
        `当前对话估算需要 ${fullInputEstimate} 个输入 token，但模型仅有约 ${inputBudget} 个可用输入 token。` +
          '请新建会话、缩短系统提示词或最后一个问题、降低最大输出 Token，' +
          '或选择“本次自动裁剪”/在设置中启用“自动裁剪”。',
      )
    }
    return {
      messages: [...messages],
      estimatedInputTokens: fullInputEstimate,
      removedMessageCount: 0,
    }
  }

  if (mode !== 'auto') throw new Error('上下文管理模式无效。')
  let used = REQUEST_OVERHEAD
  used += systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  used += latestTurn.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (used > inputBudget) {
    throw new ContextWindowError(
      '系统提示词与最后一条用户消息已超过模型可用上下文。' +
        '请缩短系统提示词或最后一条消息，或降低最大输出 Token。',
    )
  }

  const selectedTurns: Message[][] = [latestTurn]
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const turn = turns[index]!
    const cost = turn.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    if (used + cost > inputBudget) break
    selectedTurns.unshift(turn)
    used += cost
  }

  const selectedMessages = new Set([...systemMessages, ...selectedTurns.flat()])
  const prepared = messages.filter((message) => selectedMessages.has(message))
  return {
    messages: prepared,
    estimatedInputTokens: used,
    removedMessageCount: messages.length - prepared.length,
  }
}

function groupConversationTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') turns.push([message])
    else if (turns.length > 0) turns.at(-1)!.push(message)
  }
  return turns
}
