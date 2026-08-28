import type { AgentInterruption, ChatError, Message, StreamEvent } from '../../shared/types'
import { t } from '../../shared/i18n'

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
  t('Continue'),
  t('Continue execution'),
  t('Go ahead'),
  t('Please continue'),
  t('agentContinuation.continueVariant1'),
  t('agentContinuation.continueVariant2'),
  t('Try again'),
  t('agentContinuation.tryAgainVariant2'),
  t('agentContinuation.tryAgainVariant1'),
  t('agentContinuation.tryAgainVariant3'),
  t('Resume from the interruption'),
  t('Continue previous work'),
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
  return lastMessage?.role === 'assistant' && lastMessage.interruption ? lastMessage.id : undefined
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
    return {
      reason: 'cancelled',
      message: t('Agent execution stopped. The current checkpoint was preserved.'),
      occurredAt,
      finishReason,
    }
  }
  if (finishReason === 'tool_turn_limit') {
    return {
      reason: 'tool_turn_limit',
      message: t('The Agent reached the tool-call turn limit. The current checkpoint was preserved.'),
      occurredAt,
      finishReason,
    }
  }
  if (finishReason && ['length', 'max_tokens', 'incomplete'].includes(finishReason)) {
    return {
      reason: 'output_limit',
      message: t('The model reached its output limit. The current Agent checkpoint was preserved.'),
      occurredAt,
      finishReason,
    }
  }
  return undefined
}

function classifyChatError(error: ChatError): AgentInterruption['reason'] {
  const code = (error.code || '').toLocaleLowerCase()
  const message = error.message.toLocaleLowerCase()
  if (
    error.status === 429 ||
    code.includes('rate') ||
    message.includes(t('Rate limited').toLocaleLowerCase()) ||
    message.includes('rate limit')
  ) {
    return 'rate_limit'
  }
  if (code.includes('timeout') || message.includes(t('time out').toLocaleLowerCase()) || message.includes('timed out'))
    return 'timeout'
  if (
    code.includes('network') ||
    code.includes('fetch') ||
    /econn|socket|connection|网络|连接中断/.test(`${code} ${message}`)
  )
    return 'network'
  if (code.includes('checkpoint')) return 'checkpoint_error'
  if (error.status !== undefined || code) return 'api_error'
  return 'unknown'
}
