// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog'
import {
  rendererModel,
  rendererProvider,
  rendererSettings,
} from './renderer-test-fixtures'

describe('SettingsDialog renderer integration', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps general, model, and provider edits in one staged save transaction', async () => {
    const onClose = vi.fn()
    const onSave = vi.fn(async () => undefined)

    render(
      <SettingsDialog
        initialSection="general"
        models={[rendererModel]}
        mcpServers={[]}
        open
        preferences={rendererSettings}
        providers={[rendererProvider]}
        skills={[]}
        onClose={onClose}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('你希望显示的名字'), {
      target: { value: '本地用户' },
    })

    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.change(screen.getByLabelText('显示名称'), {
      target: { value: '重命名模型' },
    })

    fireEvent.click(screen.getByRole('button', { name: '服务商' }))
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: '重命名服务商' },
    })

    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      preferences: expect.objectContaining({ userNickname: '本地用户' }),
      models: [expect.objectContaining({ id: rendererModel.id, name: '重命名模型' })],
      providers: [expect.objectContaining({ id: rendererProvider.id, name: '重命名服务商' })],
    }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not submit staged changes when cancelled', () => {
    const onClose = vi.fn()
    const onSave = vi.fn()

    render(
      <SettingsDialog
        initialSection="general"
        models={[rendererModel]}
        mcpServers={[]}
        open
        preferences={rendererSettings}
        providers={[rendererProvider]}
        skills={[]}
        onClose={onClose}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('你希望显示的名字'), {
      target: { value: '不应保存' },
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
