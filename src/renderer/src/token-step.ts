export const TOKEN_BUTTON_STEP = 64_000

export interface TokenStepOptions {
  minimum: number
  maximum: number
}

export type TokenStepDirection = 'decrease' | 'increase'

/**
 * Moves a token value by a 64k button step while stopping at important model
 * boundaries. Text entry can still use values below 64k; the larger step only
 * applies to the +/- controls.
 */
export function stepTokenValue(
  value: number,
  direction: TokenStepDirection,
  { minimum, maximum }: TokenStepOptions,
): number {
  const lowerBound = Math.max(0, Math.trunc(minimum))
  const upperBound = Math.max(lowerBound, Math.trunc(maximum))
  const normalized = Number.isFinite(value) ? Math.min(upperBound, Math.max(lowerBound, Math.trunc(value))) : lowerBound

  if (direction === 'increase' && normalized < TOKEN_BUTTON_STEP) {
    return Math.min(upperBound, Math.max(lowerBound, TOKEN_BUTTON_STEP))
  }
  if (direction === 'decrease' && normalized <= TOKEN_BUTTON_STEP) {
    return lowerBound
  }

  const nominalTarget =
    direction === 'increase'
      ? Math.min(upperBound, normalized + TOKEN_BUTTON_STEP)
      : Math.max(lowerBound, normalized - TOKEN_BUTTON_STEP)
  const anchors = getTokenStepAnchors(upperBound)

  if (direction === 'increase') {
    return anchors.find((anchor) => anchor > normalized && anchor <= nominalTarget) ?? nominalTarget
  }

  return anchors.filter((anchor) => anchor < normalized && anchor >= nominalTarget).at(-1) ?? nominalTarget
}

export function getTokenStepAnchors(maximum: number): number[] {
  const upperBound = Math.max(0, Math.trunc(maximum))
  const anchors = new Set<number>([1_000_000, 2_000_000])

  for (let value = TOKEN_BUTTON_STEP; value <= upperBound; value *= 2) {
    anchors.add(value)
    if (value > Number.MAX_SAFE_INTEGER / 2) break
  }

  return [...anchors].filter((anchor) => anchor <= upperBound).sort((left, right) => left - right)
}
