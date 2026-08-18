export interface ComposerKeyAction {
  type: 'send' | 'newline' | 'none'
  nextDraft?: string
  nextCursor?: number
}

export interface ComposerKeyParams {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
  sendOnEnter: boolean
  canSend: boolean
  draft: string
  selectionStart: number
  selectionEnd: number
}

/**
 * Pure helper function to determine the action for a keydown event in the Composer textarea.
 *
 * Behavior:
 * - When `sendOnEnter` is true:
 *   - Plain Enter (no modifiers) -> 'send' (if canSend)
 *   - Ctrl+Enter or Cmd/Meta+Enter -> 'newline' (inserts '\n' at cursor position instead of sending)
 *   - Shift+Enter -> 'none' (allows default textarea newline behavior)
 * - When `sendOnEnter` is false:
 *   - Ctrl+Enter or Cmd/Meta+Enter -> 'send' (if canSend)
 *   - Plain Enter or Shift+Enter -> 'none' (allows default textarea newline behavior)
 */
export function handleComposerKeyDown(params: ComposerKeyParams): ComposerKeyAction {
  if (params.isComposing) return { type: 'none' }

  if (params.key === 'Enter') {
    const isMod = params.metaKey || params.ctrlKey

    if (params.sendOnEnter) {
      if (!params.shiftKey && !isMod && !params.altKey) {
        return params.canSend ? { type: 'send' } : { type: 'none' }
      }
      if (isMod) {
        const start = Math.max(0, params.selectionStart)
        const end = Math.max(0, params.selectionEnd)
        const nextDraft = params.draft.slice(0, start) + '\n' + params.draft.slice(end)
        return {
          type: 'newline',
          nextDraft,
          nextCursor: start + 1
        }
      }
      return { type: 'none' }
    } else {
      if (isMod) {
        return params.canSend ? { type: 'send' } : { type: 'none' }
      }
      return { type: 'none' }
    }
  }

  return { type: 'none' }
}
