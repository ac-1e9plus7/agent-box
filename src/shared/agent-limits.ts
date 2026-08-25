import { t } from './i18n'

export const DEFAULT_AGENT_TOOL_TURN_LIMIT = 30
export const MIN_AGENT_TOOL_TURN_LIMIT = 1
export const MAX_AGENT_TOOL_TURN_LIMIT = 100

export function normalizeAgentToolTurnLimit(value: unknown): number {
  const resolved = value === undefined || value === null ? DEFAULT_AGENT_TOOL_TURN_LIMIT : value
  if (
    typeof resolved !== 'number' ||
    !Number.isInteger(resolved) ||
    resolved < MIN_AGENT_TOOL_TURN_LIMIT ||
    resolved > MAX_AGENT_TOOL_TURN_LIMIT
  ) {
    throw new Error(
      t('The Agent tool-call limit must be an integer from {value0} to {value1}.', {
        value0: MIN_AGENT_TOOL_TURN_LIMIT,
        value1: MAX_AGENT_TOOL_TURN_LIMIT,
      }),
    )
  }
  return resolved
}
