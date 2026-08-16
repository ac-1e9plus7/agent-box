import type { Conversation, Message } from './types'

/**
 * Ensures all messages in the array have a well-defined `parentMessageId`.
 * If any message lacks `parentMessageId`, this normalizes the array by linking
 * sequentially according to array index order.
 */
export function ensureMessageTree<T extends Message>(messages: T[]): T[] {
  if (messages.length === 0) return []

  return messages.map((message, index) => {
    if (message.parentMessageId !== undefined) return message
    const previous = messages[index - 1]
    return {
      ...message,
      parentMessageId: previous ? previous.id : null,
    }
  })
}

/**
 * Returns the active linear chain of messages from root to the active leaf.
 *
 * If `currentLeafId` is specified and exists, traces backwards from that node to root.
 * Otherwise, walks down the tree following the latest child at each branch point.
 */
export function getActiveMessageChain<T extends Message>(
  conversation: { messages: T[]; currentLeafId?: string }
): T[] {
  if (!conversation.messages || conversation.messages.length === 0) return []

  const normalized = ensureMessageTree(conversation.messages)
  const byId = new Map<string, T>()
  for (const message of normalized) {
    byId.set(message.id, message)
  }

  // If a valid currentLeafId exists, trace backwards to root
  if (conversation.currentLeafId && byId.has(conversation.currentLeafId)) {
    const chain: T[] = []
    let current: T | undefined = byId.get(conversation.currentLeafId)
    const visited = new Set<string>()

    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      chain.unshift(current)
      if (!current.parentMessageId) break
      current = byId.get(current.parentMessageId)
    }

    if (chain.length > 0) return chain
  }

  // Otherwise, find root and walk down picking the latest child
  const childrenMap = new Map<string | null, T[]>()
  for (const message of normalized) {
    const parentKey = message.parentMessageId ?? null
    const list = childrenMap.get(parentKey) ?? []
    list.push(message)
    childrenMap.set(parentKey, list)
  }

  const roots = childrenMap.get(null) ?? []
  if (roots.length === 0) {
    // If no explicit null root, take the first message
    return normalized
  }

  const chain: T[] = []
  let currentNode: T | undefined = roots[roots.length - 1]
  const visited = new Set<string>()

  while (currentNode && !visited.has(currentNode.id)) {
    visited.add(currentNode.id)
    chain.push(currentNode)
    const children = childrenMap.get(currentNode.id) ?? []
    if (children.length === 0) break
    currentNode = children[children.length - 1]
  }

  return chain
}

/**
 * Returns all sibling variants of a message (sharing the same `parentMessageId` and `role`),
 * along with the current version index (0-based) and total count.
 */
export function getMessageSiblings<T extends Message>(
  allMessages: T[],
  messageId: string
): { siblings: T[]; currentIndex: number; total: number } {
  if (!allMessages || allMessages.length === 0) {
    return { siblings: [], currentIndex: 0, total: 1 }
  }

  const normalized = ensureMessageTree(allMessages)
  const target = normalized.find((m) => m.id === messageId)
  if (!target) {
    return { siblings: [], currentIndex: 0, total: 1 }
  }

  const targetParent = target.parentMessageId ?? null
  const siblings = normalized.filter(
    (m) => (m.parentMessageId ?? null) === targetParent && m.role === target.role
  )

  if (siblings.length === 0) {
    return { siblings: [target], currentIndex: 0, total: 1 }
  }

  const currentIndex = siblings.findIndex((m) => m.id === messageId)
  return {
    siblings,
    currentIndex: currentIndex >= 0 ? currentIndex : 0,
    total: siblings.length,
  }
}

/**
 * Finds the deepest descendant leaf node starting from `startNodeId`
 * (preferring the latest child at each branch point).
 */
export function findDeepestLeaf<T extends Message>(
  allMessages: T[],
  startNodeId: string
): T | undefined {
  if (!allMessages || allMessages.length === 0) return undefined

  const normalized = ensureMessageTree(allMessages)
  const byId = new Map<string, T>()
  const childrenMap = new Map<string, T[]>()

  for (const message of normalized) {
    byId.set(message.id, message)
    if (message.parentMessageId) {
      const list = childrenMap.get(message.parentMessageId) ?? []
      list.push(message)
      childrenMap.set(message.parentMessageId, list)
    }
  }

  let current: T | undefined = byId.get(startNodeId)
  if (!current) return undefined

  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    const nextChildren: T[] = childrenMap.get(current.id) ?? []
    if (nextChildren.length === 0) break
    current = nextChildren[nextChildren.length - 1]
  }

  return current
}

/**
 * Switches the conversation's active branch to point to `targetMessageId`.
 * Sets `currentLeafId` to the deepest descendant of `targetMessageId`.
 */
export function switchBranch<C extends Conversation>(
  conversation: C,
  targetMessageId: string
): C {
  const leaf = findDeepestLeaf(conversation.messages, targetMessageId)
  return {
    ...conversation,
    currentLeafId: leaf ? leaf.id : targetMessageId,
  }
}

/**
 * Retrieves the prompt ancestor chain for regenerating a historical assistant message.
 * Returns the message list from root up to and including the parent user message,
 * excluding the target assistant message and any of its children.
 */
export function getAncestorsForRegeneration<T extends Message>(
  allMessages: T[],
  targetAssistantMessageId: string
): { ancestors: T[]; parentUserMessage?: T } {
  const normalized = ensureMessageTree(allMessages)
  const byId = new Map<string, T>()
  for (const message of normalized) {
    byId.set(message.id, message)
  }

  const targetAssistant = byId.get(targetAssistantMessageId)
  if (!targetAssistant) return { ancestors: [] }

  const parentId = targetAssistant.parentMessageId
  if (!parentId || !byId.has(parentId)) {
    return { ancestors: [] }
  }

  const parentUserMessage = byId.get(parentId)
  const ancestors: T[] = []
  let current = parentUserMessage
  const visited = new Set<string>()

  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    ancestors.unshift(current)
    if (!current.parentMessageId) break
    current = byId.get(current.parentMessageId)
  }

  return { ancestors, parentUserMessage }
}

/**
 * Deletes a message node and all of its descendant messages from the conversation tree.
 * If the deleted node had sibling versions, switches the active branch to an adjacent sibling.
 * If it had no siblings, falls back to the deepest leaf of its parent node.
 */
export function deleteMessageNode<C extends Conversation>(
  conversation: C,
  targetMessageId: string
): C {
  const normalized = ensureMessageTree(conversation.messages)
  const byId = new Map<string, (typeof normalized)[0]>()
  const childrenMap = new Map<string, string[]>()

  for (const message of normalized) {
    byId.set(message.id, message)
    if (message.parentMessageId) {
      const list = childrenMap.get(message.parentMessageId) ?? []
      list.push(message.id)
      childrenMap.set(message.parentMessageId, list)
    }
  }

  const target = byId.get(targetMessageId)
  if (!target) return conversation

  // 1. Collect all descendant IDs of targetMessageId (including target itself)
  const toDelete = new Set<string>()
  const queue = [targetMessageId]
  while (queue.length > 0) {
    const currentId = queue.shift()!
    toDelete.add(currentId)
    const childIds = childrenMap.get(currentId) ?? []
    for (const childId of childIds) {
      if (!toDelete.has(childId)) {
        queue.push(childId)
      }
    }
  }

  // 2. Filter remaining messages
  const remainingMessages = normalized.filter((m) => !toDelete.has(m.id))

  if (remainingMessages.length === 0) {
    return {
      ...conversation,
      messages: remainingMessages,
      currentLeafId: undefined,
      updatedAt: new Date().toISOString(),
    }
  }

  // 3. Find new active leaf if currentLeafId was among the deleted nodes or target was deleted
  let newCurrentLeafId = conversation.currentLeafId

  if (!newCurrentLeafId || toDelete.has(newCurrentLeafId)) {
    const targetParent = target.parentMessageId ?? null
    const allSiblings = normalized.filter(
      (m) => (m.parentMessageId ?? null) === targetParent && m.role === target.role
    )
    const targetIndex = allSiblings.findIndex((m) => m.id === targetMessageId)
    const remainingSiblings = allSiblings.filter((m) => !toDelete.has(m.id))

    if (remainingSiblings.length > 0) {
      const prevSibling = targetIndex > 0 ? remainingSiblings[targetIndex - 1] : undefined
      const nextSibling = remainingSiblings[Math.min(targetIndex, remainingSiblings.length - 1)]
      const siblingToPick = prevSibling ?? nextSibling ?? remainingSiblings[0]

      if (siblingToPick) {
        const deepest = findDeepestLeaf(remainingMessages, siblingToPick.id)
        newCurrentLeafId = deepest?.id ?? siblingToPick.id
      }
    } else if (target.parentMessageId && remainingMessages.some((m) => m.id === target.parentMessageId)) {
      const deepest = findDeepestLeaf(remainingMessages, target.parentMessageId)
      newCurrentLeafId = deepest?.id ?? target.parentMessageId
    } else {
      const remainingRoots = remainingMessages.filter((m) => !m.parentMessageId)
      const rootToPick = remainingRoots[remainingRoots.length - 1] ?? remainingMessages[0]
      if (rootToPick) {
        const deepest = findDeepestLeaf(remainingMessages, rootToPick.id)
        newCurrentLeafId = deepest?.id ?? rootToPick.id
      }
    }
  }

  return {
    ...conversation,
    messages: remainingMessages,
    currentLeafId: newCurrentLeafId,
    updatedAt: new Date().toISOString(),
  }
}
