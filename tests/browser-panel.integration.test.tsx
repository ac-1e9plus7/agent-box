// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../src/renderer/src/components/browser/BrowserPanel'
import type { BrowserState } from '../src/shared/types'
import { createRendererApiMock } from './renderer-test-fixtures'

const state: BrowserState = {
  conversationId: 'conversation-1',
  sessionId: 'browser-1',
  phase: 'ready',
  url: 'https://one.example/',
  title: 'One',
  loading: false,
  visible: true,
  canGoBack: false,
  canGoForward: false,
  activeTabId: 'tab-1',
  tabs: [
    { id: 'tab-1', url: 'https://one.example/', title: 'One', loading: false, canGoBack: false, canGoForward: false },
    { id: 'tab-2', url: 'https://two.example/', title: 'Two', loading: false, canGoBack: false, canGoForward: false },
  ],
}

describe('BrowserPanel multi-tab UI', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('switches, creates, and closes tabs through the typed preload bridge', async () => {
    const bridge = createRendererApiMock()
    const switchTab = vi.spyOn(bridge.api.browser, 'switchTab').mockResolvedValue({ ...state, activeTabId: 'tab-2' })
    const newTab = vi.spyOn(bridge.api.browser, 'newTab').mockResolvedValue(state)
    const closeTab = vi.spyOn(bridge.api.browser, 'closeTab').mockResolvedValue(state)
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    render(
      <BrowserPanel
        conversationId="conversation-1"
        onClosePanel={vi.fn()}
        onError={vi.fn()}
        onState={vi.fn()}
        state={state}
        viewVisible={false}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }))
    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签页' }))
    fireEvent.click(screen.getAllByRole('button', { name: '关闭浏览器标签页' })[0]!)

    await waitFor(() => {
      expect(switchTab).toHaveBeenCalledWith('conversation-1', 'tab-2')
      expect(newTab).toHaveBeenCalledWith('conversation-1')
      expect(closeTab).toHaveBeenCalledWith('conversation-1', 'tab-1')
    })
  })
})
