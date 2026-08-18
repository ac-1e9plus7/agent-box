import { describe, expect, it } from 'vitest'
import { handleComposerKeyDown } from '../src/renderer/src/composer-helper'

describe('handleComposerKeyDown', () => {
  const baseParams = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    sendOnEnter: true,
    canSend: true,
    draft: 'Hello world',
    selectionStart: 11,
    selectionEnd: 11
  }

  describe('when sendOnEnter is true', () => {
    it('returns send on plain Enter when canSend is true', () => {
      const action = handleComposerKeyDown({ ...baseParams })
      expect(action).toEqual({ type: 'send' })
    })

    it('returns none on plain Enter when canSend is false', () => {
      const action = handleComposerKeyDown({ ...baseParams, canSend: false })
      expect(action).toEqual({ type: 'none' })
    })

    it('returns newline on Ctrl+Enter instead of sending', () => {
      const action = handleComposerKeyDown({
        ...baseParams,
        ctrlKey: true,
        draft: 'Line1',
        selectionStart: 5,
        selectionEnd: 5
      })

      expect(action).toEqual({
        type: 'newline',
        nextDraft: 'Line1\n',
        nextCursor: 6
      })
    })

    it('returns newline on Cmd/Meta+Enter instead of sending', () => {
      const action = handleComposerKeyDown({
        ...baseParams,
        metaKey: true,
        draft: 'Hello world',
        selectionStart: 5,
        selectionEnd: 5
      })

      expect(action).toEqual({
        type: 'newline',
        nextDraft: 'Hello\n world',
        nextCursor: 6
      })
    })

    it('replaces selection range with newline on Ctrl+Enter', () => {
      const action = handleComposerKeyDown({
        ...baseParams,
        ctrlKey: true,
        draft: 'Hello REPLACE world',
        selectionStart: 6,
        selectionEnd: 13
      })

      expect(action).toEqual({
        type: 'newline',
        nextDraft: 'Hello \n world',
        nextCursor: 7
      })
    })

    it('returns none on Shift+Enter so browser handles native newline', () => {
      const action = handleComposerKeyDown({ ...baseParams, shiftKey: true })
      expect(action).toEqual({ type: 'none' })
    })

    it('returns none when IME is composing', () => {
      const action = handleComposerKeyDown({ ...baseParams, isComposing: true })
      expect(action).toEqual({ type: 'none' })
    })
  })

  describe('when sendOnEnter is false', () => {
    it('returns send on Ctrl+Enter when canSend is true', () => {
      const action = handleComposerKeyDown({ ...baseParams, sendOnEnter: false, ctrlKey: true })
      expect(action).toEqual({ type: 'send' })
    })

    it('returns send on Cmd/Meta+Enter when canSend is true', () => {
      const action = handleComposerKeyDown({ ...baseParams, sendOnEnter: false, metaKey: true })
      expect(action).toEqual({ type: 'send' })
    })

    it('returns none on Ctrl+Enter when canSend is false', () => {
      const action = handleComposerKeyDown({ ...baseParams, sendOnEnter: false, ctrlKey: true, canSend: false })
      expect(action).toEqual({ type: 'none' })
    })

    it('returns none on plain Enter so browser handles newline', () => {
      const action = handleComposerKeyDown({ ...baseParams, sendOnEnter: false })
      expect(action).toEqual({ type: 'none' })
    })
  })
})
