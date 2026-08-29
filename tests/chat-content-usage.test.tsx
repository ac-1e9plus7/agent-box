// @vitest-environment jsdom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatContent } from '../src/renderer/src/components/ChatContent'
import { setLanguage } from '../src/shared/i18n'
import type { ChatMessage, ModelConfig } from '../src/renderer/src/types'

const timestamp = '2026-01-01T00:00:00.000Z'
const model: ModelConfig = {
  id: 'model',
  name: 'Usage Model',
  providerId: 'provider',
  remoteId: 'usage-model',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsReasoning: true,
  defaultReasoningEnabled: true,
  defaultReasoningEffort: 'medium',
  createdAt: timestamp,
  updatedAt: timestamp,
}

describe('ChatContent usage summary', () => {
  beforeEach(() => {
    setLanguage('en-US')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })
  afterEach(() => {
    cleanup()
    setLanguage('zh-CN')
  })

  it('shows aggregate token categories and the model-request count', () => {
    const message: ChatMessage = {
      id: 'assistant',
      role: 'assistant',
      content: 'Done',
      modelId: model.id,
      status: 'complete',
      createdAt: timestamp,
      usage: {
        inputTokens: 1_200,
        outputTokens: 80,
        reasoningTokens: 20,
        cachedInputTokens: 900,
        cacheWriteTokens: 50,
        totalTokens: 1_280,
        modelRequests: [
          { turn: 1, inputTokens: 500, outputTokens: 30 },
          { turn: 2, inputTokens: 700, outputTokens: 50 },
        ],
      },
    }

    render(
      <ChatContent
        messages={[message]}
        models={[model]}
        streaming={false}
        suggestions={[]}
        onEditMessage={async () => true}
        onRegenerate={vi.fn()}
        onResumeAgent={vi.fn()}
        onSuggestion={vi.fn()}
      />,
    )

    expect(screen.getByText('Model requests: 2')).toBeTruthy()
    expect(screen.getByText('Total 1.3K tokens')).toBeTruthy()
    expect(screen.getByText('Input 1.2K tokens')).toBeTruthy()
    expect(screen.getByText('Output 80 tokens')).toBeTruthy()
    expect(screen.getAllByText('Reasoning 20 tokens')).toHaveLength(2)
    expect(screen.getByText('Cached input 900 tokens')).toBeTruthy()
    expect(screen.getByText('Cache write 50 tokens')).toBeTruthy()

    const footer = document.querySelector('.message-model-name')?.closest('.message-footer')
    expect(footer).toBeTruthy()
    expect(footer?.querySelector('.message-tools')).toBeTruthy()
    expect(footer?.querySelector('.message-tools .message-model-info')).toBeNull()
    expect(footer?.querySelectorAll('.message-usage-summary > span')).toHaveLength(7)
    expect(footer?.querySelector('.message-usage-summary i')).toBeNull()
  })

  it('shows total-only usage for an empty provider response', () => {
    const message: ChatMessage = {
      id: 'assistant',
      role: 'assistant',
      content: '',
      modelId: model.id,
      status: 'complete',
      createdAt: timestamp,
      usage: { totalTokens: 42 },
    }

    render(
      <ChatContent
        messages={[message]}
        models={[model]}
        streaming={false}
        suggestions={[]}
        onEditMessage={async () => true}
        onRegenerate={vi.fn()}
        onResumeAgent={vi.fn()}
        onSuggestion={vi.fn()}
      />,
    )

    expect(screen.getByText('Model requests: 1')).toBeTruthy()
    expect(screen.getByText('Total 42 tokens')).toBeTruthy()
    expect(screen.getByText('Input — tokens')).toBeTruthy()
  })
})
