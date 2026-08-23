import { describe, expect, it } from 'vitest'
import { groupConversationsByWorkspace } from '../src/renderer/src/workspace-groups'
import type { Conversation } from '../src/renderer/src/types'

const conversation = (id: string, workingDirectory: string | undefined, updatedAt: string): Conversation => ({
  id,
  title: id,
  modelId: 'model',
  workingDirectory,
  messages: [],
  createdAt: updatedAt,
  updatedAt,
})

describe('workspace conversation grouping', () => {
  it('groups chats with the same working directory together', () => {
    const groups = groupConversationsByWorkspace([
      conversation('one', 'C:\\code\\alpha', '2026-01-02T00:00:00.000Z'),
      conversation('two', 'C:\\code\\alpha', '2026-01-03T00:00:00.000Z'),
      conversation('three', 'C:\\other\\alpha', '2026-01-01T00:00:00.000Z'),
      conversation('loose', undefined, '2025-12-31T00:00:00.000Z'),
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0]?.conversations.map((item) => item.id)).toEqual(['one', 'two'])
    expect(groups.filter((group) => group.label === 'alpha')).toHaveLength(2)
    expect(groups.find((group) => !group.path)?.label).toBe('无工作目录')
  })

  it('searches both conversation titles and full workspace paths', () => {
    const groups = groupConversationsByWorkspace([
      conversation('frontend task', '/repo/apps/web', '2026-01-02T00:00:00.000Z'),
      conversation('backend task', '/repo/services/api', '2026-01-01T00:00:00.000Z'),
    ], 'services')
    expect(groups.flatMap((group) => group.conversations).map((item) => item.id)).toEqual(['backend task'])
  })
})
