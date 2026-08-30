// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    { id: 'tab-2', url: 'https://two.example/', title: 'Two', loading: true, canGoBack: false, canGoForward: false },
  ],
}

describe('BrowserPanel multi-tab UI', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('switches, creates, and closes tabs through the typed preload bridge', async () => {
    const bridge = createRendererApiMock()
    const switchTab = vi.spyOn(bridge.api.browser, 'switchTab').mockResolvedValue({ ...state, activeTabId: 'tab-2' })
    const newTab = vi.spyOn(bridge.api.browser, 'newTab').mockResolvedValue(state)
    const closeTab = vi.spyOn(bridge.api.browser, 'closeTab').mockResolvedValue({
      status: 'tab-closed',
      state,
    })
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

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]?.closest('.browser-tab')?.classList.contains('is-active')).toBe(true)
    expect(tabs[1]?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelectorAll('.browser-tab-site-icon')).toHaveLength(2)
    expect(document.querySelector('.browser-tab-loading')).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }))
    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签页' }))
    fireEvent.click(screen.getAllByRole('button', { name: '关闭浏览器标签页' })[0]!)

    await waitFor(() => {
      expect(switchTab).toHaveBeenCalledWith('conversation-1', 'tab-2')
      expect(newTab).toHaveBeenCalledWith('conversation-1')
      expect(closeTab).toHaveBeenCalledWith('conversation-1', 'tab-1')
    })
  })

  it('closes the complete browser panel when its final tab is closed', async () => {
    const bridge = createRendererApiMock()
    const closeTab = vi.spyOn(bridge.api.browser, 'closeTab').mockResolvedValue({ status: 'session-closed' })
    const onClosePanel = vi.fn()
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    render(
      <BrowserPanel
        conversationId="conversation-1"
        onClosePanel={onClosePanel}
        onError={vi.fn()}
        onState={vi.fn()}
        state={{ ...state, activeTabId: 'tab-1', tabs: [state.tabs[0]!] }}
        viewVisible={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭浏览器标签页' }))

    await waitFor(() => {
      expect(closeTab).toHaveBeenCalledWith('conversation-1', 'tab-1')
      expect(onClosePanel).toHaveBeenCalledOnce()
    })
  })

  it('shows and can cancel a deferred close while the Agent holds the browser lease', async () => {
    const bridge = createRendererApiMock()
    const deferredState = { ...state, agentActive: true, closePending: true }
    const closeTab = vi.spyOn(bridge.api.browser, 'closeTab').mockResolvedValue({
      status: 'deferred',
      state: deferredState,
    })
    const cancelPendingClose = vi.spyOn(bridge.api.browser, 'cancelPendingClose').mockResolvedValue({
      ...state,
      agentActive: true,
      closePending: undefined,
    })
    const onState = vi.fn()
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    const { rerender } = render(
      <BrowserPanel
        conversationId="conversation-1"
        onClosePanel={vi.fn()}
        onError={vi.fn()}
        onState={onState}
        state={{ ...state, agentActive: true, tabs: [state.tabs[0]!] }}
        viewVisible={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭浏览器标签页' }))
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith('conversation-1', 'tab-1'))
    expect(onState).toHaveBeenCalledWith(deferredState)

    rerender(
      <BrowserPanel
        conversationId="conversation-1"
        onClosePanel={vi.fn()}
        onError={vi.fn()}
        onState={onState}
        state={deferredState}
        viewVisible={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '保持浏览器打开' }))

    await waitFor(() => expect(cancelPendingClose).toHaveBeenCalledWith('conversation-1'))
  })

  it('ignores a late ensure result after the panel unmounts', async () => {
    const bridge = createRendererApiMock()
    let finishEnsure!: () => void
    vi.spyOn(bridge.api.browser, 'ensure').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishEnsure = () => resolve(state)
        }),
    )
    vi.spyOn(bridge.api.browser, 'setViewState').mockImplementation(() => new Promise(() => undefined))
    const onState = vi.fn()
    const onError = vi.fn()
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    const { unmount } = render(
      <BrowserPanel
        conversationId="conversation-1"
        onClosePanel={vi.fn()}
        onError={onError}
        onState={onState}
        state={undefined}
        viewVisible={false}
      />,
    )
    unmount()
    await act(async () => finishEnsure())

    expect(onState).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a close result from a panel that has switched conversations', async () => {
    const bridge = createRendererApiMock()
    let finishClose!: () => void
    vi.spyOn(bridge.api.browser, 'closeTab').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishClose = () => resolve({ status: 'session-closed' })
        }),
    )
    const onClosePanel = vi.fn()
    Object.defineProperty(window, 'agentbox', { configurable: true, value: bridge.api })

    const { rerender } = render(
      <BrowserPanel
        conversationId="conversation-1"
        onClosePanel={onClosePanel}
        onError={vi.fn()}
        onState={vi.fn()}
        state={{ ...state, tabs: [state.tabs[0]!] }}
        viewVisible={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭浏览器标签页' }))
    rerender(
      <BrowserPanel
        conversationId="conversation-2"
        onClosePanel={onClosePanel}
        onError={vi.fn()}
        onState={vi.fn()}
        state={{ ...state, conversationId: 'conversation-2', tabs: [state.tabs[0]!] }}
        viewVisible={false}
      />,
    )
    await act(async () => finishClose())

    expect(onClosePanel).not.toHaveBeenCalled()
  })
})
