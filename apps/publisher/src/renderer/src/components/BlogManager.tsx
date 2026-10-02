import {
  ArrowLeft,
  Check,
  ExternalLink,
  FolderPlus,
  GitFork,
  Pencil,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  BlogAddLocalRequest,
  BlogCandidateSelection,
  BlogCloneRequest,
  BlogImportProgress,
  BlogRegistryView,
} from "../../../shared/contracts"
import { ModalShell } from "./ModalShell"

export interface BlogImportUiState {
  readonly view: "list" | "local" | "clone"
  readonly busy: boolean
  readonly localSelection?: BlogCandidateSelection
  readonly progress?: BlogImportProgress
  readonly error?: string
}

export interface BlogManagerProps {
  readonly open: boolean
  readonly registry: BlogRegistryView
  readonly importState: BlogImportUiState
  readonly onClose: () => void
  readonly onChooseLocal: () => void
  readonly onAddLocal: (request: BlogAddLocalRequest) => void
  readonly onClone: (request: BlogCloneRequest) => void
  readonly onInstall: (path: string) => void
  readonly onRename: (id: string, name: string) => void
  readonly onOpenFolder: (id: string) => void
  readonly onRemove: (id: string) => void
  readonly onSwitch: (id: string) => void
}

type ManagerView = BlogImportUiState["view"]

const importPhases = [
  ["cloning", "下载中"],
  ["installing", "安装依赖"],
  ["validating", "检查中"],
  ["complete", "完成"],
] as const

export function BlogManager({
  open,
  registry,
  importState,
  onClose,
  onChooseLocal,
  onAddLocal,
  onClone,
  onInstall,
  onRename,
  onOpenFolder,
  onRemove,
  onSwitch,
}: BlogManagerProps): React.JSX.Element | null {
  const [view, setView] = useState<ManagerView>(importState.view)
  const [localName, setLocalName] = useState("")
  const [cloneRequest, setCloneRequest] = useState<BlogCloneRequest>({
    url: "",
    destination: "",
    name: "",
  })
  const [renaming, setRenaming] = useState<string>()
  const [renameValue, setRenameValue] = useState("")
  const [removing, setRemoving] = useState<string>()
  const closeButton = useRef<HTMLButtonElement>(null)
  const busyFocus = useRef<HTMLDivElement>(null)
  const removeOriginId = useRef<string | undefined>(undefined)
  const restoreRemoveFocus = useRef(false)

  useEffect(() => setView(importState.view), [importState.view])
  useEffect(() => setLocalName(""), [importState.localSelection?.path])
  useEffect(() => {
    if (!open) {
      setRenaming(undefined)
      setRemoving(undefined)
      setLocalName("")
      setCloneRequest({ url: "", destination: "", name: "" })
      setRenameValue("")
    }
  }, [open])
  useEffect(() => {
    if (removing !== undefined || !restoreRemoveFocus.current) return
    restoreRemoveFocus.current = false
    const origin = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-remove-blog-id]"),
    ).find((button) => button.dataset.removeBlogId === removeOriginId.current)
    origin?.focus()
  }, [removing])

  if (!open) return null
  const busy = importState.busy
  const selection = importState.localSelection
  const selectedCanonicalPath =
    selection?.inspection.valid === true ? selection.inspection.canonicalPath : undefined
  const duplicate = selectedCanonicalPath
    ? registry.blogs.find(
        (blog) =>
          blog.canonicalPath.toLocaleLowerCase() === selectedCanonicalPath.toLocaleLowerCase(),
      )
    : undefined

  return (
    <ModalShell
      labelId="blog-manager-title"
      className="blog-manager-dialog"
      initialFocus={busy ? busyFocus : closeButton}
      closeDisabled={busy}
      onClose={onClose}
    >
      <header className="blog-manager-header">
        <div>
          <span className="eyebrow">Knowledge Garden Publisher</span>
          <h2 id="blog-manager-title">管理博客</h2>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="关闭博客管理"
          disabled={busy}
          onClick={onClose}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div
        ref={busyFocus}
        className="blog-manager-body"
        role={busy ? "group" : undefined}
        aria-label={busy ? "博客操作进行中" : undefined}
        tabIndex={busy ? 0 : -1}
      >
        {view === "list" ? (
          <BlogList
            registry={registry}
            busy={busy}
            renaming={renaming}
            renameValue={renameValue}
            removing={removing}
            onStartRename={(id, name) => {
              setRenaming(id)
              setRenameValue(name)
            }}
            onRenameValue={setRenameValue}
            onSaveRename={(id) => {
              const name = renameValue.trim()
              if (!name) return
              onRename(id, name)
              setRenaming(undefined)
            }}
            onOpenFolder={onOpenFolder}
            onStartRemove={(id) => {
              removeOriginId.current = id
              setRemoving(id)
            }}
            onCancelRemove={() => {
              restoreRemoveFocus.current = true
              setRemoving(undefined)
            }}
            onRemove={(id) => {
              onRemove(id)
              setRemoving(undefined)
            }}
            onSwitch={onSwitch}
          />
        ) : view === "local" ? (
          <section className="blog-import-view" aria-label="添加本地博客">
            <ViewBack disabled={busy} onClick={() => setView("list")} />
            <div>
              <h3>添加本地博客</h3>
              <p>选择一个现有的 Quartz Git 仓库。应用不会移动或复制其中的文件。</p>
            </div>
            {!selection ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={onChooseLocal}
              >
                <FolderPlus size={15} aria-hidden="true" /> 选择文件夹
              </button>
            ) : (
              <div className="blog-candidate-card">
                <code>{selection.path}</code>
                {!selection.inspection.valid ? (
                  <p role="alert" className="blog-manager-error">
                    {selection.inspection.message}
                  </p>
                ) : duplicate ? (
                  <>
                    <p role="status">这个文件夹已经添加为“{duplicate.name}”。</p>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy || duplicate.id === registry.activeBlogId}
                      onClick={() => onSwitch(duplicate.id)}
                    >
                      切换到 {duplicate.name}
                    </button>
                  </>
                ) : selection.inspection.needsInstall ? (
                  <>
                    <p role="status">博客结构有效，但需要安装依赖后才能使用。</p>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => onInstall(selection.path)}
                    >
                      安装依赖
                    </button>
                  </>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      const name = localName.trim()
                      if (name) onAddLocal({ path: selection.path, name })
                    }}
                  >
                    <label>
                      显示名称
                      <input
                        value={localName}
                        maxLength={80}
                        disabled={busy}
                        onChange={(event) => setLocalName(event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={busy || !localName.trim()}
                    >
                      添加此博客
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="blog-import-view" aria-label="从 GitHub 下载">
            <ViewBack disabled={busy} onClick={() => setView("list")} />
            <div>
              <h3>从 GitHub 下载</h3>
              <p>支持 GitHub HTTPS 或 SSH 地址。登录由系统 Git Credential Manager 处理。</p>
            </div>
            <form
              className="blog-clone-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (cloneRequest.url.trim() && cloneRequest.destination.trim()) {
                  onClone({
                    url: cloneRequest.url.trim(),
                    destination: cloneRequest.destination.trim(),
                    name: cloneRequest.name?.trim() ?? "",
                  })
                }
              }}
            >
              <label>
                GitHub 仓库地址
                <input
                  value={cloneRequest.url}
                  placeholder="https://github.com/owner/repository.git"
                  disabled={busy}
                  onChange={(event) => {
                    const url = event.currentTarget.value
                    setCloneRequest((current) => ({ ...current, url }))
                  }}
                />
              </label>
              <label>
                保存位置
                <input
                  value={cloneRequest.destination}
                  placeholder={String.raw`D:\Blogs\repository`}
                  disabled={busy}
                  onChange={(event) => {
                    const destination = event.currentTarget.value
                    setCloneRequest((current) => ({ ...current, destination }))
                  }}
                />
              </label>
              <label>
                显示名称（可选）
                <input
                  value={cloneRequest.name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => {
                    const name = event.currentTarget.value
                    setCloneRequest((current) => ({ ...current, name }))
                  }}
                />
              </label>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !cloneRequest.url.trim() || !cloneRequest.destination.trim()}
              >
                <GitFork size={15} aria-hidden="true" /> 开始下载
              </button>
            </form>
            <ImportProgress progress={importState.progress} />
            {importState.error ? (
              <p role="alert" className="blog-manager-error">
                {importState.error}
              </p>
            ) : null}
          </section>
        )}
      </div>

      {view === "list" ? (
        <footer className="blog-manager-footer">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onChooseLocal}
          >
            <FolderPlus size={15} aria-hidden="true" /> 添加本地博客
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => setView("clone")}
          >
            <GitFork size={15} aria-hidden="true" /> 从 GitHub 下载
          </button>
        </footer>
      ) : null}
    </ModalShell>
  )
}

function BlogList({
  registry,
  busy,
  renaming,
  renameValue,
  removing,
  onStartRename,
  onRenameValue,
  onSaveRename,
  onOpenFolder,
  onStartRemove,
  onCancelRemove,
  onRemove,
  onSwitch,
}: {
  readonly registry: BlogRegistryView
  readonly busy: boolean
  readonly renaming?: string
  readonly renameValue: string
  readonly removing?: string
  readonly onStartRename: (id: string, name: string) => void
  readonly onRenameValue: (value: string) => void
  readonly onSaveRename: (id: string) => void
  readonly onOpenFolder: (id: string) => void
  readonly onStartRemove: (id: string) => void
  readonly onCancelRemove: () => void
  readonly onRemove: (id: string) => void
  readonly onSwitch: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="blog-manager-list">
      {registry.blogs.map((blog) => {
        const current = blog.id === registry.activeBlogId
        return (
          <article
            key={blog.id}
            className="blog-manager-card"
            aria-label={`${blog.name}${current ? "，当前博客" : ""}`}
          >
            <div className="blog-manager-card-heading">
              <div>
                <strong>{blog.name}</strong>
                {current ? (
                  <span className="current-blog-badge">
                    <Check size={12} aria-hidden="true" /> 当前博客
                  </span>
                ) : null}
              </div>
              <code title={blog.path}>{blog.path}</code>
            </div>
            {renaming === blog.id ? (
              <form
                className="blog-rename-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  onSaveRename(blog.id)
                }}
              >
                <label>
                  博客名称
                  <input
                    autoFocus
                    value={renameValue}
                    maxLength={80}
                    disabled={busy}
                    onChange={(event) => onRenameValue(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={busy || !renameValue.trim()}
                >
                  保存名称
                </button>
              </form>
            ) : null}
            {removing === blog.id ? (
              <RemoveConfirmation
                id={blog.id}
                name={blog.name}
                busy={busy}
                onCancel={onCancelRemove}
                onConfirm={() => onRemove(blog.id)}
              />
            ) : (
              <div className="blog-manager-card-actions">
                {!current ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => onSwitch(blog.id)}
                  >
                    切换到 {blog.name}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  aria-label={`重命名 ${blog.name}`}
                  onClick={() => onStartRename(blog.id, blog.name)}
                >
                  <Pencil size={14} aria-hidden="true" /> 重命名
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  aria-label={`打开 ${blog.name} 文件夹`}
                  onClick={() => onOpenFolder(blog.id)}
                >
                  <ExternalLink size={14} aria-hidden="true" /> 打开文件夹
                </button>
                <button
                  type="button"
                  className="secondary-button blog-remove-button"
                  disabled={busy || current}
                  aria-label={`从列表移除 ${blog.name}`}
                  data-remove-blog-id={blog.id}
                  onClick={() => onStartRemove(blog.id)}
                >
                  <Trash2 size={14} aria-hidden="true" /> 移除
                </button>
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

function RemoveConfirmation({
  id,
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly id: string
  readonly name: string
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  const titleId = `remove-blog-${id}-title`
  const descriptionId = `remove-blog-${id}-description`
  return (
    <div
      className="blog-remove-confirm"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <strong id={titleId}>确认移除 {name}</strong>
      <div id={descriptionId}>
        <p>只会从应用列表中移除“{name}”。</p>
        <small>不会删除本地文件、Git 记录或 GitHub 仓库。</small>
      </div>
      <div>
        <button
          ref={cancel}
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>
          确认移除 {name}
        </button>
      </div>
    </div>
  )
}

function ViewBack({
  disabled,
  onClick,
}: {
  readonly disabled: boolean
  readonly onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="blog-view-back"
      aria-label="返回博客列表"
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowLeft size={16} aria-hidden="true" /> 返回
    </button>
  )
}

function ImportProgress({
  progress,
}: {
  readonly progress?: BlogImportProgress
}): React.JSX.Element | null {
  if (!progress) return null
  const currentIndex = importPhases.findIndex(([phase]) => phase === progress.phase)
  return (
    <div className="blog-import-progress" role="status" aria-label="导入进度" aria-live="polite">
      <ol>
        {importPhases.map(([phase, label], index) => (
          <li
            key={phase}
            className={
              phase === progress.phase ? "current" : index < currentIndex ? "complete" : undefined
            }
            aria-current={phase === progress.phase ? "step" : undefined}
            data-state={
              phase === progress.phase ? "current" : index < currentIndex ? "complete" : "pending"
            }
          >
            {label}
          </li>
        ))}
      </ol>
      <p>{progress.message}</p>
    </div>
  )
}
