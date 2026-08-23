import { describe, expect, it } from 'vitest'
import {
  resolveAvatarCropLayout,
  resolveAvatarOutputSize,
  validateAvatarSourceDimensions,
  validateAvatarSourceFile,
} from '../src/renderer/src/avatar-helper'

describe('avatar crop helper', () => {
  it('centers a square crop over landscape images', () => {
    const layout = resolveAvatarCropLayout(2_000, 800, 1, 0, 0)
    expect(layout.sourceSize).toBeCloseTo(800)
    expect(layout.sourceX).toBeCloseTo(600)
    expect(layout.sourceY).toBeCloseTo(0)
  })

  it('clamps drag offsets so the crop is always covered', () => {
    const leftEdge = resolveAvatarCropLayout(2_000, 800, 1, 10_000, 0)
    const rightEdge = resolveAvatarCropLayout(2_000, 800, 1, -10_000, 0)
    expect(leftEdge.sourceX).toBeCloseTo(0)
    expect(rightEdge.sourceX + rightEdge.sourceSize).toBeCloseTo(2_000)
  })

  it('never exports beyond 1000 by 1000 and avoids upscaling small crops', () => {
    expect(resolveAvatarOutputSize(2_500)).toBe(1_000)
    expect(resolveAvatarOutputSize(420.4)).toBe(420)
  })

  it('rejects SVG, oversized files, and unsafe source dimensions', () => {
    expect(() => validateAvatarSourceFile({ size: 10, type: 'image/svg+xml' })).toThrow('常见位图')
    expect(() => validateAvatarSourceFile({ size: 31 * 1024 * 1024, type: 'image/png' })).toThrow('30 MB')
    expect(() => validateAvatarSourceDimensions(20_001, 100)).toThrow('尺寸过大或无效')
    expect(() => validateAvatarSourceDimensions(12_000, 12_000)).toThrow('尺寸过大或无效')
  })
})
