import { describe, expect, it } from 'vitest'
import { getTokenStepAnchors, stepTokenValue } from '../src/renderer/src/token-step'

const contextBounds = { minimum: 1_024, maximum: 100_000_000 }
const outputBounds = { minimum: 256, maximum: 10_000_000 }

describe('token +/- stepping', () => {
  it('uses a regular decimal 64k jump away from anchors', () => {
    expect(stepTokenValue(128_000, 'increase', contextBounds)).toBe(192_000)
    expect(stepTokenValue(192_000, 'decrease', contextBounds)).toBe(128_000)
  })

  it('stops at power-of-two multiples of 64k in both directions', () => {
    expect(stepTokenValue(100_000, 'increase', contextBounds)).toBe(128_000)
    expect(stepTokenValue(150_000, 'decrease', contextBounds)).toBe(128_000)
    expect(stepTokenValue(980_000, 'increase', contextBounds)).toBe(1_000_000)
    expect(stepTokenValue(1_040_000, 'decrease', contextBounds)).toBe(1_024_000)
  })

  it('stops separately at decimal 1m and the adjacent 1.024m power anchor', () => {
    expect(stepTokenValue(960_000, 'increase', contextBounds)).toBe(1_000_000)
    expect(stepTokenValue(1_000_000, 'increase', contextBounds)).toBe(1_024_000)
    expect(stepTokenValue(1_024_000, 'decrease', contextBounds)).toBe(1_000_000)
    expect(stepTokenValue(1_000_000, 'decrease', contextBounds)).toBe(936_000)
  })

  it('stops separately at decimal 2m and the adjacent 2.048m power anchor', () => {
    expect(stepTokenValue(1_960_000, 'increase', contextBounds)).toBe(2_000_000)
    expect(stepTokenValue(2_000_000, 'increase', contextBounds)).toBe(2_048_000)
    expect(stepTokenValue(2_048_000, 'decrease', contextBounds)).toBe(2_000_000)
  })

  it('preserves small manually entered values while buttons move toward valid limits', () => {
    expect(stepTokenValue(8_192, 'increase', outputBounds)).toBe(64_000)
    expect(stepTokenValue(8_192, 'decrease', outputBounds)).toBe(256)
    expect(stepTokenValue(1_024, 'decrease', contextBounds)).toBe(1_024)
  })

  it('clamps at the configured maximum', () => {
    expect(stepTokenValue(9_990_000, 'increase', outputBounds)).toBe(10_000_000)
    expect(stepTokenValue(10_000_000, 'increase', outputBounds)).toBe(10_000_000)
  })

  it('exposes both decimal and power anchors', () => {
    expect(getTokenStepAnchors(2_100_000)).toEqual([
      64_000,
      128_000,
      256_000,
      512_000,
      1_000_000,
      1_024_000,
      2_000_000,
      2_048_000
    ])
  })
})
