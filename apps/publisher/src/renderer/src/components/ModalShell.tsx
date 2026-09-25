import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

interface ModalShellProps {
  readonly labelId: string
  readonly className: string
  readonly initialFocus?: React.RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly closeDisabled?: boolean
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
  closeDisabled = false,
  children,
}: ModalShellProps): React.JSX.Element {
  const dialog = useRef<HTMLElement>(null)
  const effectGeneration = useRef(0)
  const isolation = useRef<
    | {
        shell?: HTMLElement
        hadInert: boolean
        previousAriaHidden: string | null
        previouslyFocused: HTMLElement | null
      }
    | undefined
  >(undefined)

  useEffect(() => {
    const generation = ++effectGeneration.current
    if (!isolation.current) {
      const shell = document.querySelector<HTMLElement>(".app-shell") ?? undefined
      isolation.current = {
        shell,
        hadInert: shell?.hasAttribute("inert") ?? false,
        previousAriaHidden: shell?.getAttribute("aria-hidden") ?? null,
        previouslyFocused: document.activeElement as HTMLElement | null,
      }
    }
    const { shell } = isolation.current
    shell?.setAttribute("inert", "")
    shell?.setAttribute("aria-hidden", "true")

    const first = dialog.current?.querySelector<HTMLElement>(focusableSelector)
    ;(initialFocus?.current ?? first)?.focus()

    return () => {
      queueMicrotask(() => {
        if (effectGeneration.current !== generation) return
        const snapshot = isolation.current
        isolation.current = undefined
        if (!snapshot) return
        if (!snapshot.hadInert) snapshot.shell?.removeAttribute("inert")
        if (snapshot.previousAriaHidden !== null) {
          snapshot.shell?.setAttribute("aria-hidden", snapshot.previousAriaHidden)
        } else {
          snapshot.shell?.removeAttribute("aria-hidden")
        }
        if (snapshot.previouslyFocused?.isConnected) snapshot.previouslyFocused.focus()
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
          if (event.key === "Escape" && !closeDisabled) {
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
