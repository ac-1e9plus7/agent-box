import type { Conversation } from './types'
import { t } from '../../shared/i18n'

export interface WorkspaceConversationGroup {
  label: string
  path?: string
  conversations: Conversation[]
  updatedAt: string
}

export type NewConversationWorkspaceSource = 'current' | 'default' | 'recent'

export interface NewConversationWorkspaceOption {
  conversationCount: number
  label: string
  path: string
  source: NewConversationWorkspaceSource
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

export function getNewConversationWorkspaceOptions(
  conversations: Conversation[],
  currentDirectory?: string,
  defaultDirectory?: string,
): NewConversationWorkspaceOption[] {
  const existingGroups = groupConversationsByWorkspace(conversations).filter((group) => Boolean(group.path))
  const groupByKey = new Map(existingGroups.map((group) => [workspaceKey(group.path), group]))
  const seen = new Set<string>()
  const options: NewConversationWorkspaceOption[] = []

  const addOption = (path: string | undefined, source: NewConversationWorkspaceSource): void => {
    const trimmed = path?.trim()
    if (!trimmed) return
    const key = workspaceKey(trimmed)
    if (seen.has(key)) return
    const group = groupByKey.get(key)
    seen.add(key)
    options.push({
      conversationCount: group?.conversations.length ?? 0,
      label: workspaceLabel(trimmed),
      path: group?.path ?? trimmed,
      source,
    })
  }

  addOption(defaultDirectory, 'default')
  addOption(currentDirectory, 'current')
  for (const group of existingGroups) addOption(group.path, 'recent')
  return options
}

function workspaceKey(directory?: string): string {
  if (!directory) return '__no_workspace__'
  const normalized = directory.replaceAll('\\', '/').replace(/\/$/, '')
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
}

function workspaceLabel(directory?: string): string {
  if (!directory) return t('No working directory')
  return directory.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || directory
}
