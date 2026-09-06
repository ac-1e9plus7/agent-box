// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { DataPlatFields } from '../src/renderer/src/components/settings/DataPlatFields'
import { applyStreamEvent } from '../src/renderer/src/hooks/useChatStream'
import { setLanguage } from '../src/shared/i18n'
import type { Conversation } from '../src/renderer/src/types'

describe('data platform settings and persisted stream marker', () => {
  it('edits write-only credentials and disables the adapter explicitly', () => {
    setLanguage('en-US')
    const change = vi.fn()
    const view = render(<DataPlatFields onChange={change} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(change).toHaveBeenCalledWith({ apiBaseUrl: 'http://localhost:8080', agentId: 'agentbox', loginToken: '' })
    view.rerender(
      <DataPlatFields
        value={{ apiBaseUrl: 'http://localhost:8080', agentId: 'agentbox', loginToken: '••••••••' }}
        onChange={change}
      />,
    )
    const password = screen.getByLabelText('Data platform login token')
    expect(password.getAttribute('type')).toBe('password')
    fireEvent.change(password, { target: { value: 'fixture-replacement' } })
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ loginToken: 'fixture-replacement' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(change).toHaveBeenLastCalledWith(null)
    cleanup()
  })
  it('keeps the data marker on derived answers even when no tools run in that turn', () => {
    const conversation: Conversation = {
      id: 'c',
      modelId: 'model',
      title: 'Data',
      createdAt: '2026-09-06T00:00:00Z',
      updatedAt: '2026-09-06T00:00:00Z',
      messages: [{ id: 'a', role: 'assistant', content: '', createdAt: '2026-09-06T00:00:00Z' }],
    }
    const active = { conversationId: 'c', assistantMessageId: 'a', requestId: 'r', agentMode: true }
    const marked = applyStreamEvent(conversation, active, { type: 'data-plat-context', requestId: 'r' })
    const rendered = applyStreamEvent(marked, active, { type: 'text-delta', requestId: 'r', delta: 'Summary' })
    expect(rendered.messages[0]?.governedData).toBe(true)
  })
})
