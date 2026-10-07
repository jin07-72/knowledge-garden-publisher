import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import type {
  DomainCreateRequest,
  DomainRemoveRequest,
  DomainRenameRequest,
  DomainSummary,
} from "../../../shared/contracts"
import { ModalShell } from "./ModalShell"

type DomainManagerMode =
  | { readonly kind: "list" }
  | { readonly kind: "create" }
  | { readonly kind: "rename"; readonly domain: DomainSummary }
  | { readonly kind: "confirm-remove"; readonly domain: DomainSummary }

interface DomainManagerProps {
  readonly domains: readonly DomainSummary[]
  readonly onClose: () => void
  readonly onCreate: (request: DomainCreateRequest) => Promise<readonly DomainSummary[]>
  readonly onRename: (request: DomainRenameRequest) => Promise<readonly DomainSummary[]>
  readonly onRemove: (request: DomainRemoveRequest) => Promise<readonly DomainSummary[]>
}

function validateName(value: string): string | undefined {
  const name = value.trim()
  if (!name) return "显示名称不能为空"
  if (name.length > 80) return "显示名称不能超过 80 个字符"
  return undefined
}

function validateSlug(value: string): string | undefined {
  const slug = value.trim()
  if (!slug) return "英文路径不能为空"
  if (slug.length > 80) return "英文路径不能超过 80 个字符"
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return "英文路径只能使用小写字母、数字和连字符"
  }
  if (new Set(["index", "content", "private", "garden-publisher"]).has(slug)) {
    return "英文路径是保留名称，不能使用"
  }
  return undefined
}

export function DomainManager({
  domains,
  onClose,
  onCreate,
  onRename,
  onRemove,
}: DomainManagerProps): React.JSX.Element {
  const [mode, setMode] = useState<DomainManagerMode>({ kind: "list" })
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const removeCancel = useRef<HTMLButtonElement>(null)
  const returnFocusSlug = useRef<string | undefined>(undefined)
  const renameButtons = useRef(new Map<string, HTMLButtonElement>())
  const createDomainButton = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (mode.kind !== "list" || !returnFocusSlug.current) return
    const slug = returnFocusSlug.current
    returnFocusSlug.current = undefined
    const fallback = renameButtons.current.values().next().value ?? createDomainButton.current
    ;(renameButtons.current.get(slug) ?? fallback)?.focus()
  }, [domains, mode.kind])

  useEffect(() => {
    if (mode.kind === "create" || mode.kind === "rename") {
      queueMicrotask(() => nameInput.current?.focus())
    } else if (mode.kind === "confirm-remove") {
      queueMicrotask(() => removeCancel.current?.focus())
    }
  }, [mode.kind])

  const goList = (): void => {
    if (busy) return
    if (mode.kind === "confirm-remove") returnFocusSlug.current = mode.domain.slug
    setError(undefined)
    setMode({ kind: "list" })
  }

  const openCreate = (): void => {
    if (busy) return
    setName("")
    setSlug("")
    setError(undefined)
    setMode({ kind: "create" })
  }

  const openRename = (domain: DomainSummary): void => {
    if (busy) return
    setName(domain.name)
    setSlug(domain.slug)
    setError(undefined)
    setMode({ kind: "rename", domain })
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || (mode.kind !== "create" && mode.kind !== "rename")) return
    const nameError = validateName(name)
    const slugError = mode.kind === "create" ? validateSlug(slug) : undefined
    const validationError = nameError ?? slugError
    if (validationError) {
      setError(validationError)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      if (mode.kind === "create") {
        await onCreate({ name: name.trim(), slug: slug.trim() })
      } else {
        await onRename({ name: name.trim(), slug: mode.domain.slug })
      }
      if (mode.kind === "create" || mode.kind === "rename") setMode({ kind: "list" })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "领域操作失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (busy || mode.kind !== "confirm-remove") return
    setBusy(true)
    setError(undefined)
    try {
      await onRemove({ slug: mode.domain.slug })
      returnFocusSlug.current = mode.domain.slug
      setMode({ kind: "list" })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法删除领域，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode.kind === "create"
      ? "新建领域"
      : mode.kind === "rename"
        ? "重命名领域"
        : mode.kind === "confirm-remove"
          ? "确认删除领域？"
          : "管理领域"

  return (
    <ModalShell
      labelId="domain-manager-title"
      className="domain-manager-dialog"
      initialFocus={mode.kind === "create" || mode.kind === "rename" ? nameInput : undefined}
      closeDisabled={busy}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <header className="domain-manager-header">
        <h2 id="domain-manager-title">{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          onClick={onClose}
          disabled={busy}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      {mode.kind === "list" ? (
        <>
          <div className="domain-manager-body">
            <div className="domain-manager-list">
              {domains.map((domain) => {
                const noteCount = domain.publicNotes + domain.privateNotes
                return (
                  <article
                    className="domain-manager-card"
                    key={domain.slug}
                    aria-label={domain.name}
                  >
                    <div className="domain-manager-card-heading">
                      <strong>{domain.name}</strong>
                      <code>{domain.slug}</code>
                    </div>
                    <div className="domain-manager-badges" aria-label="笔记数量">
                      <span className="domain-count-badge">公开 {domain.publicNotes}</span>
                      <span className="domain-count-badge">私密 {domain.privateNotes}</span>
                    </div>
                    <div className="domain-manager-card-actions">
                      <button
                        ref={(node) => {
                          if (node) renameButtons.current.set(domain.slug, node)
                          else renameButtons.current.delete(domain.slug)
                        }}
                        type="button"
                        className="secondary-button"
                        onClick={() => openRename(domain)}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        className="secondary-button domain-remove-button"
                        disabled={noteCount > 0}
                        aria-label={
                          noteCount > 0
                            ? `删除（公开 ${domain.publicNotes}，私密 ${domain.privateNotes}）`
                            : "删除"
                        }
                        title={
                          noteCount > 0
                            ? `公开 ${domain.publicNotes}，私密 ${domain.privateNotes} 篇笔记`
                            : undefined
                        }
                        onClick={() => {
                          setError(undefined)
                          setMode({ kind: "confirm-remove", domain })
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                )
              })}
              {domains.length === 0 ? <p className="domain-manager-empty">暂无领域</p> : null}
            </div>
          </div>
          <footer className="domain-manager-footer">
            <button
              ref={createDomainButton}
              type="button"
              className="primary-button"
              onClick={openCreate}
              disabled={busy}
            >
              新建领域
            </button>
          </footer>
        </>
      ) : mode.kind === "confirm-remove" ? (
        <div className="domain-manager-confirm">
          <p>确认删除「{mode.domain.name}」？此操作会移除领域目录，且不能撤销。</p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              ref={removeCancel}
              type="button"
              className="secondary-button"
              onClick={goList}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => void confirmRemove()}
              disabled={busy}
            >
              确认删除
            </button>
          </div>
        </div>
      ) : (
        <form className="domain-manager-form" onSubmit={(event) => void submit(event)} noValidate>
          <label>
            显示名称
            <input
              ref={nameInput}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-describedby={error ? "domain-manager-error" : undefined}
            />
          </label>
          <label>
            英文路径
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              readOnly={mode.kind === "rename"}
              maxLength={80}
              aria-describedby={error ? "domain-manager-error" : undefined}
            />
          </label>
          {error ? (
            <p id="domain-manager-error" className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={goList} disabled={busy}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {mode.kind === "create" ? "创建领域" : "保存名称"}
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  )
}
