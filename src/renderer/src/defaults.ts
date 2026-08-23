import type { PromptSuggestion } from './types'
import { t } from "../../shared/i18n"

export const promptSuggestions: PromptSuggestion[] = [
  {
    icon: 'sparkles',
    title: t("一起构思"),
    description: t("把一个模糊想法变成清晰方案"),
    prompt: t("帮我把下面这个想法梳理成一个可执行的方案：")
  },
  {
    icon: 'code',
    title: t("编写代码"),
    description: t("实现、解释或优化一段代码"),
    prompt: t("请帮我实现这个功能，并解释关键设计：")
  },
  {
    icon: 'file',
    title: t("润色文字"),
    description: t("让表达更清晰、自然、专业"),
    prompt: t("请帮我润色下面这段文字，保留原意：")
  },
  {
    icon: 'globe',
    title: t("分析问题"),
    description: t("从多个角度拆解复杂问题"),
    prompt: t("请从多个角度分析这个问题，并给出结论：")
  }
]
