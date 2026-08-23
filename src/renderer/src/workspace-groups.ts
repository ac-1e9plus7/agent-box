import type { Conversation } from './types'

export interface WorkspaceConversationGroup {
  label: string
  path?: string
  conversations: Conversation[]
  updatedAt: string
}

export function groupConversationsByWorkspace(conversations: Conversation[], query = ''): WorkspaceConversationGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = conversations.filter((conversation) => {
    const haystack = `${conversation.title} ${conversation.workingDirectory || ''}`.toLocaleLowerCase()
    return haystack.includes(normalizedQuery)
  })
  const groups = new Map<string, WorkspaceConversationGroup>()
  for (const conversation of filtered) {
    const key = workspaceKey(conversation.workingDirectory)
    const existing = groups.get(key)
    if (existing) {
      existing.conversations.push(conversation)
      if (conversation.updatedAt > existing.updatedAt) existing.updatedAt = conversation.updatedAt
    } else {
      groups.set(key, {
        label: workspaceLabel(conversation.workingDirectory),
        path: conversation.workingDirectory,
        conversations: [conversation],
        updatedAt: conversation.updatedAt,
      })
    }
  }
  return Array.from(groups.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function workspaceKey(directory?: string): string {
  if (!directory) return '__no_workspace__'
  const normalized = directory.replaceAll('\\', '/').replace(/\/$/, '')
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
}

function workspaceLabel(directory?: string): string {
  if (!directory) return '无工作目录'
  return directory.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || directory
}
