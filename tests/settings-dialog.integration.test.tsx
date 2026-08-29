// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog'
import { t } from '../src/shared/i18n'
import { rendererModel, rendererProvider, rendererSettings } from './renderer-test-fixtures'

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
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ userNickname: '本地用户' }),
        models: [expect.objectContaining({ id: rendererModel.id, name: '重命名模型' })],
        providers: [expect.objectContaining({ id: rendererProvider.id, name: '重命名服务商' })],
      }),
    )
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

  it('stages a custom browser home page', async () => {
    const onSave = vi.fn(async () => undefined)

    render(
      <SettingsDialog
        initialSection="general"
        models={[rendererModel]}
        mcpServers={[]}
        open
        preferences={{ ...rendererSettings, builtInBrowserEnabled: true }}
        providers={[rendererProvider]}
        skills={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByLabelText(t('Browser home page')), {
      target: { value: 'https://example.com/start' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('Save changes') }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ browserHomePage: 'https://example.com/start' }),
      }),
    )
  })

  it('stages independent Agent token optimizations and reveals only enabled numeric controls', async () => {
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
        onClose={vi.fn()}
        onSave={onSave}
      />,
    )

    const toolResultCharacters = t('Maximum model-visible tool-result characters')
    const dynamicToolLimit = t('Initial dynamic tool limit')
    const compactionThreshold = t('Context compaction threshold')
    const recentTurns = t('Recent Agent turns to keep')

    expect(screen.queryByLabelText(toolResultCharacters)).toBeNull()
    expect(screen.queryByLabelText(dynamicToolLimit)).toBeNull()
    expect(screen.queryByLabelText(compactionThreshold)).toBeNull()
    expect(screen.queryByLabelText(recentTurns)).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: t('Compact tool results sent to the model') }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('Expose a smaller tool set dynamically') }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('Load Skill resources only when needed') }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('Compact long-running Agent context') }))

    const toolResultInput = screen.getByLabelText(toolResultCharacters)
    fireEvent.change(toolResultInput, { target: { value: '24000' } })
    fireEvent.blur(toolResultInput)
    const dynamicToolInput = screen.getByLabelText(dynamicToolLimit)
    fireEvent.change(dynamicToolInput, { target: { value: '8' } })
    fireEvent.blur(dynamicToolInput)
    const thresholdInput = screen.getByLabelText(compactionThreshold)
    fireEvent.change(thresholdInput, { target: { value: '80' } })
    fireEvent.blur(thresholdInput)
    const recentTurnsInput = screen.getByLabelText(recentTurns)
    fireEvent.change(recentTurnsInput, { target: { value: '5' } })
    fireEvent.blur(recentTurnsInput)
    fireEvent.change(screen.getByLabelText(t('Provider context reuse')), {
      target: { value: 'native-continuation' },
    })

    fireEvent.click(screen.getByRole('button', { name: t('Save changes') }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({
          agentToolResultCompactionEnabled: true,
          agentToolResultMaxCharacters: 24_000,
          agentDynamicToolExposureEnabled: true,
          agentDynamicToolLimit: 8,
          agentLazySkillResourcesEnabled: true,
          agentContextCompactionEnabled: true,
          agentContextCompactionThresholdPercent: 80,
          agentContextCompactionKeepRecentTurns: 5,
          agentProviderContextOptimizationMode: 'native-continuation',
        }),
      }),
    )
  })
})
