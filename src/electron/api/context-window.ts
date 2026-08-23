import type { ContextManagementMode, Message } from '../../shared/types'
import {
  REQUEST_OVERHEAD,
  RESERVED_SAFETY_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
} from '../../shared/token-estimate'
import { t } from "../../shared/i18n"

// Re-exported so existing import sites keep working; the estimate now lives in
// the shared module and is reused by the renderer context projection.
export { estimateMessageTokens, estimateTextTokens }

export class ContextWindowError extends Error {
  readonly code = 'context_window_exceeded'

  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowError'
  }
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
    throw new Error(t("模型上下文窗口配置无效。"))
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error(t("模型最大输出长度配置无效。"))
  }

  const inputBudget = contextWindow - maxOutputTokens - RESERVED_SAFETY_TOKENS
  if (inputBudget <= REQUEST_OVERHEAD) {
    throw new ContextWindowError(
      t("上下文窗口不足以为模型输出预留空间。请降低最大输出 Token 或增大模型上下文窗口。"),
    )
  }

  const systemMessages = messages.filter((message) => message.role === 'system')
  const turns = groupConversationTurns(messages)
  const latestTurn = turns.at(-1)
  if (!latestTurn?.some((message) => message.role === 'user')) {
    throw new Error(t("发送内容必须包含用户消息。"))
  }
  const fullInputEstimate =
    REQUEST_OVERHEAD +
    messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)

  if (mode === 'manual') {
    if (fullInputEstimate > inputBudget) {
      throw new ContextWindowError(
        t("当前对话估算需要 {value0} 个输入 token，但模型仅有约 {value1} 个可用输入 token。", { value0: fullInputEstimate, value1: inputBudget }) +
          t("请新建会话、缩短系统提示词或最后一个问题、降低最大输出 Token，") +
          t("或选择“本次自动裁剪”/在设置中启用“自动裁剪”。"),
      )
    }
    return {
      messages: [...messages],
      estimatedInputTokens: fullInputEstimate,
      removedMessageCount: 0,
    }
  }

  if (mode !== 'auto') throw new Error(t("上下文管理模式无效。"))
  let used = REQUEST_OVERHEAD
  used += systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  used += latestTurn.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (used > inputBudget) {
    throw new ContextWindowError(
      t("系统提示词与最后一条用户消息已超过模型可用上下文。") +
        t("请缩短系统提示词或最后一条消息，或降低最大输出 Token。"),
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
