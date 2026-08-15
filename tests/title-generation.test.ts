import { describe, expect, it } from 'vitest'
import {
  cleanGeneratedTitle,
  cleanManualTitle,
  firstUserQuestion,
  MAX_TITLE_LENGTH,
} from '../src/renderer/src/title'

describe('cleanGeneratedTitle', () => {
  it('returns a trimmed plain title', () => {
    expect(cleanGeneratedTitle('关于 React 的疑问')).toBe('关于 React 的疑问')
  })

  it('strips surrounding ASCII and Chinese quotes', () => {
    expect(cleanGeneratedTitle('"标题"')).toBe('标题')
    expect(cleanGeneratedTitle('“标题”')).toBe('标题')
    expect(cleanGeneratedTitle('‘标题’')).toBe('标题')
  })

  it('collapses internal whitespace and newlines', () => {
    expect(cleanGeneratedTitle('多行\n标题   内容')).toBe('多行 标题 内容')
  })

  it('drops a trailing sentence-ending punctuation', () => {
    expect(cleanGeneratedTitle('这是一个标题。')).toBe('这是一个标题')
    expect(cleanGeneratedTitle('这是一个标题！')).toBe('这是一个标题')
    expect(cleanGeneratedTitle('title.')).toBe('title')
  })

  it('truncates overly long titles', () => {
    const long = '一'.repeat(MAX_TITLE_LENGTH + 50)
    const result = cleanGeneratedTitle(long)
    expect(result).toBe(`${'一'.repeat(MAX_TITLE_LENGTH)}…`)
  })

  it('returns undefined for empty or whitespace-only input', () => {
    expect(cleanGeneratedTitle('')).toBeUndefined()
    expect(cleanGeneratedTitle('   ')).toBeUndefined()
    expect(cleanGeneratedTitle('\n\n')).toBeUndefined()
    expect(cleanGeneratedTitle('“”')).toBeUndefined()
  })
})

describe('cleanManualTitle', () => {
  it('trims and normalizes whitespace', () => {
    expect(cleanManualTitle('  我的   对话 ')).toBe('我的 对话')
  })

  it('returns undefined for empty input', () => {
    expect(cleanManualTitle('')).toBeUndefined()
    expect(cleanManualTitle('   ')).toBeUndefined()
  })

  it('truncates overly long manual titles', () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH + 10)
    expect(cleanManualTitle(long)).toBe(`${'x'.repeat(MAX_TITLE_LENGTH)}…`)
  })
})

describe('firstUserQuestion', () => {
  it('returns the first non-empty user message', () => {
    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: '  ' },
      { role: 'user' as const, content: 'real question' },
      { role: 'assistant' as const, content: 'answer' },
    ]
    expect(firstUserQuestion(messages)).toBe('real question')
  })

  it('returns empty string when there is no user message', () => {
    expect(firstUserQuestion([{ role: 'assistant', content: 'hi' }])).toBe('')
    expect(firstUserQuestion([])).toBe('')
  })
})
