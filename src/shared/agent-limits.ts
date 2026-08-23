import { t } from "./i18n"

export const DEFAULT_AGENT_TOOL_TURN_LIMIT = 30
export const MIN_AGENT_TOOL_TURN_LIMIT = 1
export const MAX_AGENT_TOOL_TURN_LIMIT = 100

export function normalizeAgentToolTurnLimit(value: unknown): number {
  const resolved = value === undefined || value === null
    ? DEFAULT_AGENT_TOOL_TURN_LIMIT
    : value
  if (
    typeof resolved !== 'number'
    || !Number.isInteger(resolved)
    || resolved < MIN_AGENT_TOOL_TURN_LIMIT
    || resolved > MAX_AGENT_TOOL_TURN_LIMIT
  ) {
    throw new Error(t("Agent 工具调用轮次必须是 {value0}-{value1} 之间的整数。", { value0: MIN_AGENT_TOOL_TURN_LIMIT, value1: MAX_AGENT_TOOL_TURN_LIMIT }))
  }
  return resolved
}
