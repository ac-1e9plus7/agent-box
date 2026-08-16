import { describe, expect, it } from 'vitest'
import { formatFileSize, isImageFile, isPdfFile, isTextFile } from '../src/renderer/src/file-helper'

describe('file-helper', () => {
  it('formats file sizes accurately', () => {
    expect(formatFileSize(500)).toBe('500 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })

  it('detects image files', () => {
    expect(isImageFile({ type: 'image/png', name: 'photo.png' } as File)).toBe(true)
    expect(isImageFile({ type: 'image/jpeg', name: 'photo.jpg' } as File)).toBe(true)
    expect(isImageFile({ type: 'text/plain', name: 'photo.txt' } as File)).toBe(false)
  })

  it('detects PDF files', () => {
    expect(isPdfFile({ type: 'application/pdf', name: 'paper.pdf' } as File)).toBe(true)
    expect(isPdfFile({ type: '', name: 'paper.pdf' } as File)).toBe(true)
    expect(isPdfFile({ type: 'text/plain', name: 'paper.txt' } as File)).toBe(false)
  })

  it('detects text and code files', () => {
    expect(isTextFile({ type: 'text/plain', name: 'notes.txt' } as File)).toBe(true)
    expect(isTextFile({ type: 'application/json', name: 'data.json' } as File)).toBe(true)
    expect(isTextFile({ type: '', name: 'script.py' } as File)).toBe(true)
    expect(isTextFile({ type: '', name: 'app.tsx' } as File)).toBe(true)
    expect(isTextFile({ type: '', name: 'style.css' } as File)).toBe(true)
    expect(isTextFile({ type: 'image/png', name: 'photo.png' } as File)).toBe(false)
  })
})
