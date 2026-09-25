import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { Visibility } from "../../../shared/contracts"

const options: readonly { value: Visibility; label: string; consequence: string }[] = [
  { value: "public", label: "公开", consequence: "发布后进入网站和 GitHub" },
  { value: "private", label: "私密", consequence: "移入私密目录；已发布副本需发布后下架" },
]

interface VisibilityMenuProps {
  readonly value: Visibility
  readonly disabled?: boolean
  readonly onChange: (value: Visibility) => void
}

export function VisibilityMenu({
  value,
  disabled,
  onChange,
}: VisibilityMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("[role='menuitemradio']")?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!control.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside, true)
    return () => document.removeEventListener("pointerdown", closeOutside, true)
  }, [open])

  const choose = (next: Visibility): void => {
    setOpen(false)
    onChange(next)
    trigger.current?.focus()
  }

  return (
    <div
      ref={control}
      className="visibility-control"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="visibility-button"
        aria-label={`可见性：${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`visibility-dot ${value}`} aria-hidden="true" />
        {selected.label}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menu}
          className="visibility-menu"
          role="menu"
          aria-label="选择可见性"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"),
            )
            const current = items.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === "Escape") {
              event.preventDefault()
              setOpen(false)
              trigger.current?.focus()
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              const direction = event.key === "ArrowDown" ? 1 : -1
              items[(current + direction + items.length) % items.length]?.focus()
            }
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => choose(option.value)}
            >
              <span className={`visibility-dot ${option.value}`} aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                <small>{option.consequence}</small>
              </span>
              {option.value === value ? (
                <span className="menu-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
