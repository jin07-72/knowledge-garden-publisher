import { useEffect, useState } from "react"
import { HexAlphaColorPicker, HexColorPicker } from "react-colorful"

export interface AppearanceColorPickerProps {
  readonly label: string
  readonly value: string
  readonly allowAlpha: boolean
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
}

function normalizePickerHex(raw: string, allowAlpha: boolean): string | undefined {
  const trimmed = raw.trim()
  const pattern = allowAlpha ? /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/ : /^#[0-9a-fA-F]{6}$/
  return pattern.test(trimmed) ? trimmed.toUpperCase() : undefined
}

function extractRgbHex(value: string): string {
  const match = /^#[0-9a-fA-F]{6}/.exec(value.trim())
  return match ? match[0].toUpperCase() : "#000000"
}

function extractAlphaSuffix(value: string, allowAlpha: boolean): string {
  if (!allowAlpha) return ""
  const trimmed = value.trim()
  return /^#[0-9a-fA-F]{8}$/.test(trimmed) ? trimmed.slice(7, 9).toUpperCase() : ""
}

function formatDisplayHex(value: string, allowAlpha: boolean): string {
  return normalizePickerHex(value, allowAlpha) ?? extractRgbHex(value)
}

function alphaPercentFromHex(value: string, allowAlpha: boolean): number {
  if (!allowAlpha) return 100
  const trimmed = value.trim()
  if (!/^#[0-9a-fA-F]{8}$/.test(trimmed)) return 100
  const alphaByte = Number.parseInt(trimmed.slice(7, 9), 16)
  return Math.round((alphaByte / 255) * 100)
}

function alphaHexFromPercent(percent: number): string {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)))
  return Math.round((clamped / 100) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase()
}

export function AppearanceColorPicker({
  label,
  value,
  allowAlpha,
  disabled = false,
  onChange,
}: AppearanceColorPickerProps): React.JSX.Element {
  const displayValue = formatDisplayHex(value, allowAlpha)
  const rgbHex = extractRgbHex(value)
  const [textDraft, setTextDraft] = useState(displayValue)
  const [textDirty, setTextDirty] = useState(false)
  const [alphaText, setAlphaText] = useState(() => String(alphaPercentFromHex(value, allowAlpha)))

  useEffect(() => {
    setTextDraft(formatDisplayHex(value, allowAlpha))
    setTextDirty(false)
    setAlphaText(String(alphaPercentFromHex(value, allowAlpha)))
  }, [value, allowAlpha])

  const handlePickerChange = (nextColor: string): void => {
    if (disabled) return
    const normalized = normalizePickerHex(nextColor, allowAlpha)
    if (normalized === undefined) return
    setTextDraft(normalized)
    setTextDirty(false)
    setAlphaText(String(alphaPercentFromHex(normalized, allowAlpha)))
    onChange(normalized)
  }

  const handleNativeColorChange = (rawRgb: string): void => {
    if (disabled) return
    const normalizedRgb = normalizePickerHex(rawRgb, false)
    if (normalizedRgb === undefined) return
    const suffix = extractAlphaSuffix(value, allowAlpha)
    const normalized = `${normalizedRgb}${suffix}`
    setTextDraft(normalized)
    setTextDirty(false)
    onChange(normalized)
  }

  const commitTextDraft = (): void => {
    if (disabled) return
    const normalized = normalizePickerHex(textDraft, allowAlpha)
    if (normalized === undefined) {
      setTextDirty(false)
      setTextDraft(displayValue)
      return
    }
    setTextDraft(normalized)
    setAlphaText(String(alphaPercentFromHex(normalized, allowAlpha)))
    if (textDirty || normalized !== displayValue) {
      setTextDirty(false)
      onChange(normalized)
    }
  }

  const handleAlphaChange = (rawAlpha: string): void => {
    if (disabled) return
    setAlphaText(rawAlpha)
    const trimmed = rawAlpha.trim()
    if (!/^\d{1,3}$/.test(trimmed)) return
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return
    const nextValue = `${rgbHex}${alphaHexFromPercent(parsed)}`
    setTextDraft(nextValue)
    setTextDirty(false)
    onChange(nextValue)
  }

  const handleAlphaBlur = (): void => {
    const trimmed = alphaText.trim()
    const parsed = /^\d{1,3}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setAlphaText(String(alphaPercentFromHex(value, allowAlpha)))
    }
  }

  return (
    <div className="appearance-color-picker" aria-disabled={disabled}>
      <div className="appearance-color-picker-header">
        <label className="appearance-color-picker-native">
          <span>{label}</span>
          <span
            className={
              allowAlpha
                ? "appearance-color-swatch appearance-color-swatch-alpha"
                : "appearance-color-swatch"
            }
          >
            <span
              className="appearance-color-swatch-fill"
              style={{ backgroundColor: displayValue }}
            />
          </span>
          <input
            type="color"
            value={rgbHex.toLowerCase()}
            disabled={disabled}
            onChange={(event) => handleNativeColorChange(event.target.value)}
          />
        </label>
      </div>
      <div className="appearance-color-picker-surface">
        {allowAlpha ? (
          <HexAlphaColorPicker color={displayValue} onChange={handlePickerChange} />
        ) : (
          <HexColorPicker color={rgbHex} onChange={handlePickerChange} />
        )}
      </div>
      <div className="appearance-color-picker-inputs">
        <label className="appearance-color-hex-field">
          <span>Hex</span>
          <input
            type="text"
            aria-label={`${label}颜色值`}
            value={textDraft}
            maxLength={16}
            disabled={disabled}
            onChange={(event) => {
              setTextDraft(event.target.value)
              setTextDirty(true)
            }}
            onBlur={commitTextDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitTextDraft()
              }
            }}
          />
        </label>
        {allowAlpha ? (
          <label className="appearance-color-alpha-field">
            <span>透明度 (%)</span>
            <input
              type="number"
              aria-label={`${label}透明度`}
              min={0}
              max={100}
              step={1}
              value={alphaText}
              disabled={disabled}
              onChange={(event) => handleAlphaChange(event.target.value)}
              onBlur={handleAlphaBlur}
            />
          </label>
        ) : null}
      </div>
    </div>
  )
}
