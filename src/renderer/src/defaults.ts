import type { PromptSuggestion } from './types'
import { t } from "../../shared/i18n"

export const promptSuggestions: PromptSuggestion[] = [
  {
    icon: 'sparkles',
    title: t("Brainstorm"),
    description: t("Turn a vague idea into an actionable plan"),
    prompt: t("Turn the following idea into an actionable plan:")
  },
  {
    icon: 'code',
    title: t("Write code"),
    description: t("Implement, explain, or optimize code"),
    prompt: t("Implement this feature and explain the key design decisions:")
  },
  {
    icon: 'file',
    title: t("Polish writing"),
    description: t("Make writing clearer, more natural, and more professional"),
    prompt: t("Polish the following text while preserving its meaning:")
  },
  {
    icon: 'globe',
    title: t("Analyze the problem"),
    description: t("Analyze complex problems from multiple perspectives"),
    prompt: t("Analyze this problem from multiple perspectives and provide a conclusion:")
  }
]
