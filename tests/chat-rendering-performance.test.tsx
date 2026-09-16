// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from 'node:fs'
import React, { Profiler } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatContent } from '../src/renderer/src/components/ChatContent'
import { preprocessMarkdown } from '../src/renderer/src/markdown-helper'
import type { ChatMessage } from '../src/renderer/src/types'

vi.mock('../src/renderer/src/markdown-helper', async (original) => {
  const actual = await original<typeof import('../src/renderer/src/markdown-helper')>()
  return { ...actual, preprocessMarkdown: vi.fn(actual.preprocessMarkdown) }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('only reparses the changed assistant while streaming through a history of Markdown messages', () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const messages: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    createdAt: new Date().toISOString(),
    content: `Message ${index}\n\n**Markdown** $x^2$`,
    status: index === 39 ? 'streaming' : 'complete',
  }))
  const props = {
    models: [],
    streaming: true,
    suggestions: [],
    onEditMessage: vi.fn(async () => true),
    onRegenerate: vi.fn(),
    onResumeAgent: vi.fn(),
    onSuggestion: vi.fn(),
  }
  const durations: number[] = []
  const tree = (items: ChatMessage[]) => (
    <Profiler id="chat" onRender={(_id, _phase, duration) => durations.push(duration)}>
      <ChatContent {...props} messages={items} allMessages={items} />
    </Profiler>
  )
  const view = render(tree(messages))
  const initialParses = vi.mocked(preprocessMarkdown).mock.calls.length
  expect(initialParses).toBe(20)
  vi.mocked(preprocessMarkdown).mockClear()
  const updated = messages.map((message, index) =>
    index === 39 ? { ...message, content: message.content + ' delta' } : message,
  )
  view.rerender(tree(updated))
  const deltaParses = vi.mocked(preprocessMarkdown).mock.calls.length
  expect(deltaParses).toBe(1)
  mkdirSync('artifacts/quality-review', { recursive: true })
  writeFileSync(
    'artifacts/quality-review/render-performance.json',
    JSON.stringify({ messages: 40, initialParses, deltaParses, profilerDurationsMs: durations }, null, 2),
  )
})
