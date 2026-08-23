import type { AgentInterruption, ChatError, Message, StreamEvent } from '../../shared/types'

const EXACT_CONTINUATION_COMMANDS = new Set([
  'go',
  'go on',
  'continue',
  'continue please',
  'resume',
  'resume please',
  'retry',
  'retry please',
  'try again',
  'again',
  '继续',
  '继续执行',
  '继续吧',
  '请继续',
  '接着来',
  '接着做',
  '重试',
  '再试一次',
  '再次尝试',
  '重新尝试',
  '从中断处继续',
  '继续之前的工作',
])

export function isAgentContinuationCommand(content: string): boolean {
  const normalized = content
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[。！？!?.,，；;:：]+$/g, '')
    .replace(/\s+/g, ' ')
  if (!normalized || normalized.length > 40) return false
  if (EXACT_CONTINUATION_COMMANDS.has(normalized)) return true
  return /^(?:请)?(?:继续|接着)(?:执行|完成|处理|尝试|之前的工作|刚才的任务)?(?:一下|吧)?$/.test(normalized)
}

export function resolveNaturalAgentResumeMessageId(
  messages: Message[],
  content: string,
  hasAttachments = false,
): string | undefined {
  if (hasAttachments || !isAgentContinuationCommand(content)) return undefined
  const lastMessage = messages.at(-1)
  return lastMessage?.role === 'assistant' && lastMessage.interruption
    ? lastMessage.id
    : undefined
}

export function interruptionFromStreamEvent(
  event: Extract<StreamEvent, { type: 'done' | 'error' }>,
  agentMode: boolean,
  occurredAt = new Date().toISOString(),
): AgentInterruption | undefined {
  if (!agentMode) return undefined
  if (event.type === 'error') {
    return {
      reason: classifyChatError(event.error),
      message: event.error.message,
      occurredAt,
      errorCode: event.error.code,
      status: event.error.status,
      retryAfterSeconds: event.error.retryAfterSeconds,
    }
  }

  const finishReason = event.finishReason
  if (finishReason === 'cancelled') {
    return { reason: 'cancelled', message: 'Agent 执行已停止，当前现场已保留。', occurredAt, finishReason }
  }
  if (finishReason === 'tool_turn_limit') {
    return { reason: 'tool_turn_limit', message: 'Agent 已达到工具调用轮次上限，当前现场已保留。', occurredAt, finishReason }
  }
  if (finishReason && ['length', 'max_tokens', 'incomplete'].includes(finishReason)) {
    return { reason: 'output_limit', message: '模型输出达到长度限制，当前 Agent 现场已保留。', occurredAt, finishReason }
  }
  return undefined
}

function classifyChatError(error: ChatError): AgentInterruption['reason'] {
  const code = (error.code || '').toLocaleLowerCase()
  const message = error.message.toLocaleLowerCase()
  if (error.status === 429 || code.includes('rate') || message.includes('限流') || message.includes('rate limit')) {
    return 'rate_limit'
  }
  if (code.includes('timeout') || message.includes('超时') || message.includes('timed out')) return 'timeout'
  if (
    code.includes('network')
    || code.includes('fetch')
    || /econn|socket|connection|网络|连接中断/.test(`${code} ${message}`)
  ) return 'network'
  if (error.status !== undefined || code) return 'api_error'
  return 'unknown'
}
