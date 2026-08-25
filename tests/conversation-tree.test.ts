import { describe, expect, it } from 'vitest'
import {
  deleteMessageNode,
  ensureMessageTree,
  getActiveMessageChain,
  getAncestorsForRegeneration,
  getMessageSiblings,
  switchBranch,
} from '../src/shared/conversation-tree'
import type { Conversation, Message } from '../src/shared/types'

describe('Conversation Tree and Multi-Version Branching', () => {
  it('normalizes legacy linear message arrays without parentMessageId', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'Q1', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'A1', createdAt: '2026-01-01T00:01:00Z' },
      { id: 'm3', role: 'user', content: 'Q2', createdAt: '2026-01-01T00:02:00Z' },
      { id: 'm4', role: 'assistant', content: 'A2', createdAt: '2026-01-01T00:03:00Z' },
    ]

    const normalized = ensureMessageTree(messages)
    expect(normalized[0]?.parentMessageId).toBeNull()
    expect(normalized[1]?.parentMessageId).toBe('m1')
    expect(normalized[2]?.parentMessageId).toBe('m2')
    expect(normalized[3]?.parentMessageId).toBe('m3')

    const activeChain = getActiveMessageChain({ messages })
    expect(activeChain.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('correctly computes message siblings and pagination count', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Explain AI', parentMessageId: null, createdAt: '2026-01-01T00:00:00Z' },
      {
        id: 'a1_v1',
        role: 'assistant',
        content: 'Version 1',
        parentMessageId: 'u1',
        createdAt: '2026-01-01T00:01:00Z',
      },
      {
        id: 'a1_v2',
        role: 'assistant',
        content: 'Version 2',
        parentMessageId: 'u1',
        createdAt: '2026-01-01T00:02:00Z',
      },
      {
        id: 'a1_v3',
        role: 'assistant',
        content: 'Version 3',
        parentMessageId: 'u1',
        createdAt: '2026-01-01T00:03:00Z',
      },
    ]

    const info1 = getMessageSiblings(messages, 'a1_v1')
    expect(info1.total).toBe(3)
    expect(info1.currentIndex).toBe(0)
    expect(info1.siblings.map((s) => s.id)).toEqual(['a1_v1', 'a1_v2', 'a1_v3'])

    const info2 = getMessageSiblings(messages, 'a1_v2')
    expect(info2.total).toBe(3)
    expect(info2.currentIndex).toBe(1)

    const info3 = getMessageSiblings(messages, 'a1_v3')
    expect(info3.total).toBe(3)
    expect(info3.currentIndex).toBe(2)
  })

  it('retrieves accurate ancestors for regenerating any historical assistant answer', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Hello', parentMessageId: null, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Hi there', parentMessageId: 'u1', createdAt: '2026-01-01T00:01:00Z' },
      { id: 'u2', role: 'user', content: 'What is 2+2?', parentMessageId: 'a1', createdAt: '2026-01-01T00:02:00Z' },
      { id: 'a2', role: 'assistant', content: '4', parentMessageId: 'u2', createdAt: '2026-01-01T00:03:00Z' },
    ]

    // Regenerating historical answer a1 (turn 1)
    const result1 = getAncestorsForRegeneration(messages, 'a1')
    expect(result1.parentUserMessage?.id).toBe('u1')
    expect(result1.ancestors.map((m) => m.id)).toEqual(['u1'])

    // Regenerating answer a2 (turn 2)
    const result2 = getAncestorsForRegeneration(messages, 'a2')
    expect(result2.parentUserMessage?.id).toBe('u2')
    expect(result2.ancestors.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('handles multi-turn conversation branching without copying subsequent turns', () => {
    // Initial conversation: Turn 1 (u1 -> a1_v1), Turn 2 (u2 -> a2_v1)
    const conv: Conversation = {
      id: 'conv-1',
      title: 'Branching Test',
      modelId: 'test-model',
      messages: [
        { id: 'u1', role: 'user', content: 'Tell me a joke', parentMessageId: null, createdAt: '2026-01-01T00:00:00Z' },
        {
          id: 'a1_v1',
          role: 'assistant',
          content: 'Why did the chicken cross the road?',
          parentMessageId: 'u1',
          createdAt: '2026-01-01T00:01:00Z',
        },
        { id: 'u2', role: 'user', content: 'Explain it', parentMessageId: 'a1_v1', createdAt: '2026-01-01T00:02:00Z' },
        {
          id: 'a2_v1',
          role: 'assistant',
          content: 'To get to the other side.',
          parentMessageId: 'u2',
          createdAt: '2026-01-01T00:03:00Z',
        },
      ],
      currentLeafId: 'a2_v1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:03:00Z',
    }

    // Active chain on branch 1
    const active1 = getActiveMessageChain(conv)
    expect(active1.map((m) => m.id)).toEqual(['u1', 'a1_v1', 'u2', 'a2_v1'])

    // User regenerates historical answer a1_v1 -> creates a1_v2 as child of u1
    const a1_v2: Message = {
      id: 'a1_v2',
      role: 'assistant',
      content: 'A programmer went out...',
      parentMessageId: 'u1',
      createdAt: '2026-01-01T00:04:00Z',
    }

    const branchedConv: Conversation = {
      ...conv,
      messages: [...conv.messages, a1_v2],
      currentLeafId: a1_v2.id,
      updatedAt: '2026-01-01T00:04:00Z',
    }

    // Active chain on branch 2 contains ONLY u1 -> a1_v2 (no u2 or a2_v1!)
    const active2 = getActiveMessageChain(branchedConv)
    expect(active2.map((m) => m.id)).toEqual(['u1', 'a1_v2'])

    // User switches pagination on turn 1 back to a1_v1 (< 1 / 2 >)
    const switchedBack = switchBranch(branchedConv, 'a1_v1')
    expect(switchedBack.currentLeafId).toBe('a2_v1') // Deepest leaf of a1_v1

    const activeSwitched = getActiveMessageChain(switchedBack)
    expect(activeSwitched.map((m) => m.id)).toEqual(['u1', 'a1_v1', 'u2', 'a2_v1'])

    // User switches pagination forward to a1_v2 (< 2 / 2 >)
    const switchedForward = switchBranch(branchedConv, 'a1_v2')
    expect(switchedForward.currentLeafId).toBe('a1_v2')

    const activeForward = getActiveMessageChain(switchedForward)
    expect(activeForward.map((m) => m.id)).toEqual(['u1', 'a1_v2'])

    // User continues conversation on branch 2 with u3 -> a3
    const u3: Message = {
      id: 'u3',
      role: 'user',
      content: 'That was funny!',
      parentMessageId: 'a1_v2',
      createdAt: '2026-01-01T00:05:00Z',
    }
    const a3: Message = {
      id: 'a3',
      role: 'assistant',
      content: 'Glad you liked it!',
      parentMessageId: 'u3',
      createdAt: '2026-01-01T00:06:00Z',
    }

    const continuedBranch2: Conversation = {
      ...branchedConv,
      messages: [...branchedConv.messages, u3, a3],
      currentLeafId: 'a3',
    }

    const activeContinued2 = getActiveMessageChain(continuedBranch2)
    expect(activeContinued2.map((m) => m.id)).toEqual(['u1', 'a1_v2', 'u3', 'a3'])

    // Switching back to branch 1 still recovers branch 1 completely
    const recoverBranch1 = switchBranch(continuedBranch2, 'a1_v1')
    expect(recoverBranch1.currentLeafId).toBe('a2_v1')
    expect(getActiveMessageChain(recoverBranch1).map((m) => m.id)).toEqual(['u1', 'a1_v1', 'u2', 'a2_v1'])

    // Switching to branch 2 goes down to a3
    const recoverBranch2 = switchBranch(continuedBranch2, 'a1_v2')
    expect(recoverBranch2.currentLeafId).toBe('a3')
    expect(getActiveMessageChain(recoverBranch2).map((m) => m.id)).toEqual(['u1', 'a1_v2', 'u3', 'a3'])
  })

  it('seamlessly supports historical flat conversations created before the tree upgrade', () => {
    // Legacy conversation: no parentMessageId on any message and no currentLeafId on conversation
    const legacyConv: Conversation = {
      id: 'legacy-conv-1',
      title: 'Historical Conversation',
      modelId: 'legacy-model',
      messages: [
        { id: 'old_u1', role: 'user', content: 'What is Python?', createdAt: '2026-01-01T00:00:00Z' },
        {
          id: 'old_a1',
          role: 'assistant',
          content: 'Python is a programming language.',
          createdAt: '2026-01-01T00:01:00Z',
        },
        { id: 'old_u2', role: 'user', content: 'Give an example', createdAt: '2026-01-01T00:02:00Z' },
        { id: 'old_a2', role: 'assistant', content: 'print("hello")', createdAt: '2026-01-01T00:03:00Z' },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:03:00Z',
    }

    // 1. Initial chain seamlessly resolves all historical turns
    const chain = getActiveMessageChain(legacyConv)
    expect(chain.map((m) => m.id)).toEqual(['old_u1', 'old_a1', 'old_u2', 'old_a2'])

    // 2. User clicks regenerate on historical turn 1 assistant answer (old_a1)
    const { ancestors, parentUserMessage } = getAncestorsForRegeneration(legacyConv.messages, 'old_a1')
    expect(parentUserMessage?.id).toBe('old_u1')
    expect(ancestors.map((m) => m.id)).toEqual(['old_u1'])

    // 3. New assistant message old_a1_v2 is created as sibling of old_a1
    const newAnswer: Message = {
      id: 'old_a1_v2',
      role: 'assistant',
      content: 'Python is a high-level interpreted language.',
      parentMessageId: 'old_u1',
      createdAt: '2026-01-01T00:04:00Z',
    }

    const updatedConv: Conversation = {
      ...legacyConv,
      messages: [...ensureMessageTree(legacyConv.messages), newAnswer],
      currentLeafId: newAnswer.id,
    }

    // 4. Branch 2 active chain only has old_u1 -> old_a1_v2
    expect(getActiveMessageChain(updatedConv).map((m) => m.id)).toEqual(['old_u1', 'old_a1_v2'])

    // 5. Pagination count on turn 1 is now 2
    const siblingsInfo = getMessageSiblings(updatedConv.messages, 'old_a1_v2')
    expect(siblingsInfo.total).toBe(2)
    expect(siblingsInfo.currentIndex).toBe(1)

    // 6. User paginates back to version 1 -> restores old_u2 and old_a2
    const switched = switchBranch(updatedConv, 'old_a1')
    expect(getActiveMessageChain(switched).map((m) => m.id)).toEqual(['old_u1', 'old_a1', 'old_u2', 'old_a2'])
  })

  it('supports deleting a specific version or branch and updating leaf correctly', () => {
    // Conversation with two branches at turn 1:
    // u1 -> a1_v1 -> u2 -> a2
    //    -> a1_v2 -> u3 -> a3
    const conv: Conversation = {
      id: 'conv-del',
      title: 'Delete Test',
      modelId: 'test-model',
      messages: [
        { id: 'u1', role: 'user', content: 'Start', parentMessageId: null, createdAt: '2026-01-01T00:00:00Z' },
        {
          id: 'a1_v1',
          role: 'assistant',
          content: 'Answer V1',
          parentMessageId: 'u1',
          createdAt: '2026-01-01T00:01:00Z',
        },
        { id: 'u2', role: 'user', content: 'Follow up 1', parentMessageId: 'a1_v1', createdAt: '2026-01-01T00:02:00Z' },
        { id: 'a2', role: 'assistant', content: 'Answer 2', parentMessageId: 'u2', createdAt: '2026-01-01T00:03:00Z' },
        {
          id: 'a1_v2',
          role: 'assistant',
          content: 'Answer V2',
          parentMessageId: 'u1',
          createdAt: '2026-01-01T00:04:00Z',
        },
        { id: 'u3', role: 'user', content: 'Follow up 2', parentMessageId: 'a1_v2', createdAt: '2026-01-01T00:05:00Z' },
        { id: 'a3', role: 'assistant', content: 'Answer 3', parentMessageId: 'u3', createdAt: '2026-01-01T00:06:00Z' },
      ],
      currentLeafId: 'a3',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:06:00Z',
    }

    // 1. Delete a1_v2 (the second version of turn 1)
    // Should recursively delete a1_v2, u3, a3
    const afterDelV2 = deleteMessageNode(conv, 'a1_v2')
    expect(afterDelV2.messages.map((m) => m.id)).toEqual(['u1', 'a1_v1', 'u2', 'a2'])
    // Because a1_v2 had sibling a1_v1, currentLeafId shifts to deepest leaf of a1_v1 ('a2')
    expect(afterDelV2.currentLeafId).toBe('a2')
    expect(getActiveMessageChain(afterDelV2).map((m) => m.id)).toEqual(['u1', 'a1_v1', 'u2', 'a2'])

    // 2. Delete u2 (and its descendant a2)
    const afterDelU2 = deleteMessageNode(afterDelV2, 'u2')
    expect(afterDelU2.messages.map((m) => m.id)).toEqual(['u1', 'a1_v1'])
    expect(afterDelU2.currentLeafId).toBe('a1_v1')

    // 3. Delete root message u1 (and everything below)
    const afterDelAll = deleteMessageNode(afterDelU2, 'u1')
    expect(afterDelAll.messages).toEqual([])
    expect(afterDelAll.currentLeafId).toBeUndefined()
  })
})
