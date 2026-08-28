import { createHash } from 'node:crypto'

export function agentCheckpointThreadId(conversationId: string, responseMessageId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([conversationId, responseMessageId]), 'utf8')
    .digest('hex')
  return `agent:${digest}`
}
