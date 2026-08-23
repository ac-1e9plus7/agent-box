// @vitest-environment jsdom

import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App'
import {
  createRendererApiMock,
  rendererConversation,
} from './renderer-test-fixtures'

describe('App renderer integration', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('opens the new-conversation flow from the application shortcut', async () => {
    const bridge = createRendererApiMock()
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    render(<App />)
    await screen.findByLabelText('消息输入框')

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    expect(await screen.findByRole('dialog', { name: '新建对话' })).toBeTruthy()
  })

  it('sends through the bridge and applies streamed content to the active conversation', async () => {
    const bridge = createRendererApiMock()
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    render(<App />)
    await screen.findByText('已有回答')

    fireEvent.change(screen.getByLabelText('消息输入框'), {
      target: { value: '新的问题' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(bridge.mocks.stream).toHaveBeenCalledOnce())
    expect(bridge.mocks.stream).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: rendererConversation.id,
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: '新的问题' })]),
    }))

    await act(async () => {
      bridge.emit({ type: 'text-delta', requestId: 'request-1', delta: '流式回答' })
    })
    expect(await screen.findByText('流式回答')).toBeTruthy()

    await act(async () => {
      bridge.emit({ type: 'done', requestId: 'request-1', finishReason: 'stop' })
    })
    await waitFor(() => {
      const lastSaved = bridge.mocks.conversationSave.mock.calls.at(-1)?.[0]
      expect(lastSaved.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: '流式回答' }),
      ]))
    })
  })
})
