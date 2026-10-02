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
  const activeIndex = Math.max(
    0,
    registry.blogs.findIndex((blog) => blog.id === registry.activeBlogId),
  )
  const [focusIndex, setFocusIndex] = useState(activeIndex)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const active =
    registry.blogs.find((blog) => blog.id === registry.activeBlogId) ?? registry.blogs[0]

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>(`[data-menu-index="${focusIndex}"]`)?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    return () => document.removeEventListener("pointerdown", closeOutside)
  }, [focusIndex, open])

  const openAndFocus = (index = activeIndex): void => {
    if (disabled) return
    setFocusIndex(index)
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
        onClick={() => {
          if (open) setOpen(false)
          else openAndFocus()
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            openAndFocus(event.key === "ArrowUp" ? registry.blogs.length + 2 : activeIndex)
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
            if (event.key === "Tab") {
              queueMicrotask(() => setOpen(false))
              return
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const count = registry.blogs.length + 3
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? count - 1
                  : event.key === "ArrowUp"
                    ? (focusIndex - 1 + count) % count
                    : (focusIndex + 1) % count
            setFocusIndex(next)
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
                  data-menu-index={registry.blogs.indexOf(blog)}
                  tabIndex={focusIndex === registry.blogs.indexOf(blog) ? 0 : -1}
                  disabled={disabled}
                  onFocus={() => setFocusIndex(registry.blogs.indexOf(blog))}
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
              data-menu-index={registry.blogs.length}
              tabIndex={focusIndex === registry.blogs.length ? 0 : -1}
              disabled={disabled}
              onFocus={() => setFocusIndex(registry.blogs.length)}
              onClick={() => finish(onAddLocal)}
            >
              <FolderPlus size={15} aria-hidden="true" /> 添加本地博客
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-index={registry.blogs.length + 1}
              tabIndex={focusIndex === registry.blogs.length + 1 ? 0 : -1}
              disabled={disabled}
              onFocus={() => setFocusIndex(registry.blogs.length + 1)}
              onClick={() => finish(onClone)}
            >
              <GitFork size={15} aria-hidden="true" /> 从 GitHub 下载
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-index={registry.blogs.length + 2}
              tabIndex={focusIndex === registry.blogs.length + 2 ? 0 : -1}
              disabled={disabled}
              onFocus={() => setFocusIndex(registry.blogs.length + 2)}
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
