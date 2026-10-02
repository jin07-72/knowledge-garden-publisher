import { Check, ChevronDown, FolderPlus, GitFork, Settings2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { BlogRegistryView } from "../../../shared/contracts"

export interface BlogSwitcherProps {
  readonly registry: BlogRegistryView
  readonly disabled: boolean
  readonly onSwitch: (id: string) => void
  readonly onAddLocal: () => void
  readonly onClone: () => void
  readonly onManage: () => void
}

export function BlogSwitcher({
  registry,
  disabled,
  onSwitch,
  onAddLocal,
  onClone,
  onManage,
}: BlogSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const active =
    registry.blogs.find((blog) => blog.id === registry.activeBlogId) ?? registry.blogs[0]

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    return () => document.removeEventListener("pointerdown", closeOutside)
  }, [open])

  const openAndFocus = (): void => {
    if (disabled) return
    setOpen(true)
  }

  const finish = (action: () => void): void => {
    setOpen(false)
    action()
  }

  return (
    <div ref={root} className="blog-switcher">
      <button
        ref={trigger}
        type="button"
        className="blog-switcher-trigger"
        aria-label={`切换博客：${active?.name ?? "未选择博客"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !active}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            openAndFocus()
          }
        }}
      >
        <span className="blog-switcher-copy">
          <strong>{active?.name ?? "未选择博客"}</strong>
          {active ? <small title={active.path}>{active.path}</small> : null}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="blog-switcher-menu"
          role="menu"
          aria-label="选择博客"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              setOpen(false)
              trigger.current?.focus()
              return
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]:not([disabled]), [role="menuitem"]:not([disabled])',
              ),
            )
            if (items.length === 0) return
            const current = items.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowUp"
                    ? (current - 1 + items.length) % items.length
                    : (current + 1) % items.length
            items[next]?.focus()
          }}
        >
          <div className="blog-switcher-options">
            {registry.blogs.map((blog) => {
              const current = blog.id === registry.activeBlogId
              return (
                <button
                  key={blog.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  disabled={disabled}
                  onClick={() => finish(() => onSwitch(blog.id))}
                >
                  <span className="blog-menu-check" aria-hidden="true">
                    {current ? <Check size={14} /> : null}
                  </span>
                  <span className="blog-menu-copy">
                    <span>
                      <strong>{blog.name}</strong>
                      {current ? <em>当前</em> : null}
                    </span>
                    <small title={blog.path}>{blog.path}</small>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="blog-switcher-actions">
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => finish(onAddLocal)}
            >
              <FolderPlus size={15} aria-hidden="true" /> 添加本地博客
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => finish(onClone)}
            >
              <GitFork size={15} aria-hidden="true" /> 从 GitHub 下载
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => finish(onManage)}
            >
              <Settings2 size={15} aria-hidden="true" /> 管理博客
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
