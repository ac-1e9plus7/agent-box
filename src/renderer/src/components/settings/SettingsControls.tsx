import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  MAX_AGENT_TOOL_TURN_LIMIT,
  MIN_AGENT_TOOL_TURN_LIMIT,
} from '../../../../shared/agent-limits'
import { t } from '../../../../shared/i18n'
import { stepTokenValue } from '../../token-step'
import { Icon } from '../Icon'

export function SettingsToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className={`settings-toggle ${disabled ? 'is-disabled' : ''}`}>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span aria-hidden="true"><i /></span>
      <em>{label}</em>
    </label>
  )
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }): JSX.Element {
  return (
    <div className="field-label">
      <span>{children}</span>
      {hint && <small>{hint}</small>}
    </div>
  )
}

export function TokenStepper({
  ariaLabel,
  maximum,
  minimum,
  onChange,
  value,
}: {
  ariaLabel: string
  maximum: number
  minimum: number
  onChange: (value: number) => void
  value: number
}): JSX.Element {
  const [inputValue, setInputValue] = useState(String(value))

  useEffect(() => {
    setInputValue(String(value))
  }, [value])

  const commitInput = (): void => {
    const parsed = Number(inputValue)
    if (!inputValue.trim() || !Number.isFinite(parsed)) {
      setInputValue(String(value))
      return
    }
    const normalized = Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
    setInputValue(String(normalized))
    onChange(normalized)
  }

  const applyButtonStep = (direction: 'decrease' | 'increase'): void => {
    const parsed = Number(inputValue)
    const current = inputValue.trim() && Number.isFinite(parsed) ? parsed : value
    const next = stepTokenValue(current, direction, { minimum, maximum })
    setInputValue(String(next))
    onChange(next)
  }

  return (
    <div className="token-stepper">
      <button
        aria-label={t("Reduce {value0}", { value0: ariaLabel })}
        disabled={value <= minimum}
        onClick={() => applyButtonStep('decrease')}
        title={t("Buttons adjust in 64K increments and snap to key values such as 2ⁿ, 1M, and 2M")}
        type="button"
      >
        <Icon name="minus" size={14} />
      </button>
      <input
        aria-label={ariaLabel}
        max={maximum}
        min={minimum}
        step="1"
        type="number"
        value={inputValue}
        onBlur={commitInput}
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setInputValue(String(value))
            event.preventDefault()
          }
        }}
      />
      <button
        aria-label={t("Add {value0}", { value0: ariaLabel })}
        disabled={value >= maximum}
        onClick={() => applyButtonStep('increase')}
        title={t("Buttons adjust in 64K increments and snap to key values such as 2ⁿ, 1M, and 2M")}
        type="button"
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}

export function AgentTurnLimitInput({
  onChange,
  value,
}: {
  onChange: (value: number) => void
  value: number
}): JSX.Element {
  const [inputValue, setInputValue] = useState(String(value))

  useEffect(() => {
    setInputValue(String(value))
  }, [value])

  const commit = (): void => {
    const parsed = Number(inputValue)
    if (!Number.isInteger(parsed)) {
      setInputValue(String(value))
      return
    }
    const normalized = Math.min(
      MAX_AGENT_TOOL_TURN_LIMIT,
      Math.max(MIN_AGENT_TOOL_TURN_LIMIT, parsed),
    )
    setInputValue(String(normalized))
    onChange(normalized)
  }

  return (
    <label className="agent-turn-limit-control">
      <input
        aria-label={t("Agent tool-call limit")}
        max={MAX_AGENT_TOOL_TURN_LIMIT}
        min={MIN_AGENT_TOOL_TURN_LIMIT}
        onBlur={commit}
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setInputValue(String(value))
            event.preventDefault()
          }
        }}
        type="number"
        value={inputValue}
      />
      <span>{t(value === 1 ? "turn" : "turns")}</span>
    </label>
  )
}
