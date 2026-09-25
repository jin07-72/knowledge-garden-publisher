import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

interface ModalShellProps {
  readonly labelId: string
  readonly className: string
  readonly initialFocus?: React.RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly children: React.ReactNode
}

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

export function ModalShell({
  labelId,
  className,
  initialFocus,
  onClose,
  children,
}: ModalShellProps): React.JSX.Element {
  const dialog = useRef<HTMLElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const shell = document.querySelector<HTMLElement>(".app-shell")
    const hadInert = shell?.hasAttribute("inert") ?? false
    const previousAriaHidden = shell?.getAttribute("aria-hidden")
    shell?.setAttribute("inert", "")
    shell?.setAttribute("aria-hidden", "true")

    const first = dialog.current?.querySelector<HTMLElement>(focusableSelector)
    ;(initialFocus?.current ?? first)?.focus()

    return () => {
      if (!shell) return
      if (!hadInert) shell.removeAttribute("inert")
      if (typeof previousAriaHidden === "string") {
        shell.setAttribute("aria-hidden", previousAriaHidden)
      } else {
        shell.removeAttribute("aria-hidden")
      }
      queueMicrotask(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus()
      })
    }
  }, [initialFocus])

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <section
        ref={dialog}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== "Tab") return
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector),
          )
          if (items.length === 0) {
            event.preventDefault()
            return
          }
          const first = items[0]!
          const last = items.at(-1)!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        {children}
      </section>
    </div>,
    document.body,
  )
}
