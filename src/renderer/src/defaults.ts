import type { PromptSuggestion } from './types'

export const promptSuggestions: PromptSuggestion[] = [
  {
    icon: 'sparkles',
    title: '一起构思',
    description: '把一个模糊想法变成清晰方案',
    prompt: '帮我把下面这个想法梳理成一个可执行的方案：'
  },
  {
    icon: 'code',
    title: '编写代码',
    description: '实现、解释或优化一段代码',
    prompt: '请帮我实现这个功能，并解释关键设计：'
  },
  {
    icon: 'file',
    title: '润色文字',
    description: '让表达更清晰、自然、专业',
    prompt: '请帮我润色下面这段文字，保留原意：'
  },
  {
    icon: 'globe',
    title: '分析问题',
    description: '从多个角度拆解复杂问题',
    prompt: '请从多个角度分析这个问题，并给出结论：'
  }
]
