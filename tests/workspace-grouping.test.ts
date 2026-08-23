import { describe, expect, it } from 'vitest'
import { getNewConversationWorkspaceOptions, groupConversationsByWorkspace } from '../src/renderer/src/workspace-groups'
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

  it('offers current, default, and recent workspaces in a stable deduplicated order', () => {
    const options = getNewConversationWorkspaceOptions([
      conversation('current one', 'C:\\code\\alpha', '2026-01-02T00:00:00.000Z'),
      conversation('current two', 'C:\\code\\alpha\\', '2026-01-03T00:00:00.000Z'),
      conversation('recent', 'C:\\code\\beta', '2026-01-04T00:00:00.000Z'),
      conversation('legacy', undefined, '2026-01-05T00:00:00.000Z'),
    ], 'c:\\code\\alpha', 'D:\\projects\\default')

    expect(options.map((option) => ({
      count: option.conversationCount,
      path: option.path,
      source: option.source,
    }))).toEqual([
      { count: 2, path: 'C:\\code\\alpha', source: 'current' },
      { count: 0, path: 'D:\\projects\\default', source: 'default' },
      { count: 1, path: 'C:\\code\\beta', source: 'recent' },
    ])
  })
})
