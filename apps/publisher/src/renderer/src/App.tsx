import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BookOpen, Check, Eye, GitBranch, LoaderCircle, TriangleAlert } from "lucide-react"
import type {
  AppError,
  GardenApi,
  NoteCreateRequest,
  NoteDocument,
  NoteSummary,
  PreviewStatus,
  PublishProgress,
  Visibility,
} from "../../shared/contracts"
import { NoteSidebar } from "./components/NoteSidebar"
import { ModalShell } from "./components/ModalShell"
import { PreviewPane } from "./components/PreviewPane"
import { VisibilityMenu } from "./components/VisibilityMenu"
import "./app.css"

type LoadState = "loading" | "ready" | "error"

const stoppedPreview: PreviewStatus = { state: "stopped", generation: 0 }

function messageFor(error: AppError, fallback: string): string {
  return error.code === "SERVICE_UNAVAILABLE" ? fallback : error.message
}

function movedPath(note: NoteSummary, visibility: Visibility): string {
  const root = visibility === "public" ? "content" : "private"
  return `${root}/${note.domain}/${note.slug}.md`
}

function PaneSeparator({
  label,
  value,
  minimum,
  maximum,
  onResize,
}: {
  readonly label: string
  readonly value: number
  readonly minimum: number
  readonly maximum: number
  readonly onResize: (value: number) => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; value: number } | undefined>(undefined)
  const clamp = (next: number): number => Math.min(maximum, Math.max(minimum, next))
  return (
    <div
      className="pane-separator"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        onResize(clamp(value + (event.key === "ArrowRight" ? 12 : -12)))
      }}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, value }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (drag.current) onResize(clamp(drag.current.value + event.clientX - drag.current.x))
      }}
      onPointerUp={(event) => {
        drag.current = undefined
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }}
      onPointerCancel={() => {
        drag.current = undefined
      }}
    />
  )
}

function PublisherApp({ api }: { readonly api: GardenApi }): React.JSX.Element {
  const [notes, setNotes] = useState<readonly NoteSummary[]>([])
  const [selectedPath, setSelectedPath] = useState<string>()
  const [document, setDocument] = useState<NoteDocument>()
  const [documentError, setDocumentError] = useState<string>()
  const [documentRetry, setDocumentRetry] = useState(0)
  const [notesState, setNotesState] = useState<LoadState>("loading")
  const [notesMessage, setNotesMessage] = useState("正在读取花园…")
  const [preview, setPreview] = useState<PreviewStatus>(stoppedPreview)
  const [changeCount, setChangeCount] = useState<number>()
  const [publishMessage, setPublishMessage] = useState("正在检查可发布变化…")
  const [publishProgress, setPublishProgress] = useState<PublishProgress>()
  const [visibilityBusy, setVisibilityBusy] = useState(false)
  const [visibilityError, setVisibilityError] = useState<{
    path: string
    title: string
    message: string
  }>()
  const [pendingVisibility, setPendingVisibility] = useState<{
    note: NoteSummary
    visibility: Visibility
  }>()
  const [visibilityNotice, setVisibilityNotice] = useState<{
    path: string
    messages: readonly string[]
  }>()
  const [paneSizes, setPaneSizes] = useState({ sidebar: 240, editor: 520 })
  const [customPaneSizes, setCustomPaneSizes] = useState(false)
  const confirmationCancel = useRef<HTMLButtonElement>(null)

  const selectedNote = useMemo(
    () => notes.find((note) => note.path === selectedPath),
    [notes, selectedPath],
  )

  const loadNotes = useCallback(async () => {
    const result = await api.notes.list()
    if (!result.ok) {
      setNotesState("error")
      setNotesMessage(result.error.message)
      return
    }
    setNotes(result.value)
    setNotesState("ready")
    setNotesMessage(result.value.length === 0 ? "花园里还没有笔记" : "")
    setSelectedPath((current) =>
      current && result.value.some((note) => note.path === current)
        ? current
        : result.value[0]?.path,
    )
  }, [api])

  useEffect(() => {
    void loadNotes()
    void api.preview.status().then(async (result) => {
      if (!result.ok) {
        setPreview({ state: "error", generation: 0, error: result.error })
        return
      }
      setPreview(result.value)
      if (result.value.state === "stopped") {
        const started = await api.preview.start()
        setPreview(
          started.ok
            ? started.value
            : { state: "error", generation: result.value.generation, error: started.error },
        )
      }
    })
    void api.changes.list().then((result) => {
      if (result.ok) {
        setChangeCount(result.value.length)
        setPublishMessage(
          result.value.length === 0 ? "当前没有可发布变化" : "可查看并选择要发布的变化",
        )
      } else {
        setChangeCount(undefined)
        setPublishMessage(messageFor(result.error, "发布检查暂不可用；后续版本会接入。"))
      }
    })
    const unsubscribePreview = api.preview.onProgress(setPreview)
    const unsubscribePublish = api.publish.onProgress(setPublishProgress)
    return () => {
      unsubscribePreview()
      unsubscribePublish()
    }
  }, [api, loadNotes])

  useEffect(() => {
    if (!selectedPath) {
      setDocument(undefined)
      setDocumentError(undefined)
      return
    }
    let active = true
    setDocument(undefined)
    setDocumentError(undefined)
    void api.notes
      .read({ path: selectedPath })
      .then((result) => {
        if (!active) return
        if (result.ok) setDocument(result.value)
        else setDocumentError(result.error.message)
      })
      .catch((error: unknown) => {
        if (!active) return
        setDocumentError(error instanceof Error ? error.message : "无法读取这篇笔记")
      })
    return () => {
      active = false
    }
  }, [api, documentRetry, selectedPath])

  const createNote = async (request: NoteCreateRequest): Promise<string | undefined> => {
    const result = await api.notes.create(request)
    if (!result.ok) return result.error.message
    const created: NoteSummary = {
      path: result.value.path,
      domain: request.domain,
      slug: request.slug,
      title: request.title,
      date: request.date,
      description: request.description,
      visibility: request.visibility,
      updatedAt: result.value.updatedAt,
      tags: request.tags,
    }
    setNotes((current) => [created, ...current])
    setSelectedPath(created.path)
    setDocument({
      path: created.path,
      markdown: request.body ?? `# ${request.title}\n`,
      mtimeMs: result.value.mtimeMs,
      contentHash: result.value.contentHash,
    })
    return undefined
  }

  const changeVisibility = async (note: NoteSummary, visibility: Visibility): Promise<void> => {
    if (visibility === note.visibility || visibilityBusy) return
    setVisibilityBusy(true)
    setVisibilityError(undefined)
    try {
      const result = await api.notes.changeVisibility({ path: note.path, visibility })
      if (!result.ok) {
        setVisibilityError({ path: note.path, title: note.title, message: result.error.message })
        return
      }
      const nextPath = movedPath(note, visibility)
      setNotes((current) =>
        current.map((candidate) =>
          candidate.path === note.path ? { ...candidate, visibility, path: nextPath } : candidate,
        ),
      )
      setSelectedPath((current) => (current === note.path ? nextPath : current))
      setDocument((current) =>
        current?.path === note.path ? { ...current, path: nextPath } : current,
      )
      const consequenceMessages = [
        ...(result.value.pendingPublicDeletion ? ["仍在线，等待发布下架"] : []),
        ...(result.value.historyWarning ? ["Git 历史仍可能保留公开内容"] : []),
        ...result.value.warnings.map((warning) => warning.message),
      ]
      setVisibilityNotice(
        consequenceMessages.length > 0
          ? { path: nextPath, messages: consequenceMessages }
          : undefined,
      )
    } catch (error) {
      setVisibilityError({
        path: note.path,
        title: note.title,
        message: error instanceof Error ? error.message : "无法更改这篇笔记的可见性",
      })
    } finally {
      setVisibilityBusy(false)
    }
  }

  const requestVisibility = (note: NoteSummary, visibility: Visibility): void => {
    if (visibility === note.visibility || visibilityBusy) return
    setVisibilityError(undefined)
    if (note.visibility === "public" && visibility === "private") {
      setPendingVisibility({ note, visibility })
      return
    }
    void changeVisibility(note, visibility)
  }

  const loadHistory = useCallback(async (): Promise<string> => {
    const [git, deployments] = await Promise.all([
      api.history.git({ limit: 20 }),
      api.history.deployments({ limit: 20 }),
    ])
    if (!git.ok || !deployments.ok) {
      return "历史服务暂不可用；后续版本会显示提交与部署记录。"
    }
    if (git.value.length === 0 && deployments.value.length === 0) return "还没有历史记录。"
    return `本地提交 ${git.value.length} 条 · 部署记录 ${deployments.value.length} 条`
  }, [api])

  const previewLabel: Record<PreviewStatus["state"], string> = {
    stopped: "预览未启动",
    starting: "预览启动中",
    ready: "预览就绪",
    building: "预览更新中",
    error: "预览出错",
    stopping: "预览停止中",
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <BookOpen size={18} />
        </div>
        <div>
          <p className="eyebrow">个人知识花园</p>
          <h1>~/Knowledge Garden</h1>
        </div>
        <div className="topbar-meta">
          <span className={`status-dot preview-${preview.state}`} />
          {previewLabel[preview.state]}
        </div>
      </header>

      {visibilityError ? (
        <div className="global-alert" role="alert" data-note-path={visibilityError.path}>
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            {visibilityError.title}：{visibilityError.message}
          </span>
        </div>
      ) : null}

      <div
        className="workspace-grid"
        style={
          customPaneSizes
            ? {
                gridTemplateColumns: `${paneSizes.sidebar}px ${paneSizes.editor}px minmax(360px, 1fr)`,
              }
            : undefined
        }
      >
        <NoteSidebar
          notes={notes}
          loadState={notesState}
          message={notesMessage}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          onCreate={createNote}
          separator={
            <PaneSeparator
              label="调整笔记栏宽度"
              value={paneSizes.sidebar}
              minimum={190}
              maximum={420}
              onResize={(sidebar) => {
                setCustomPaneSizes(true)
                setPaneSizes((current) => ({ ...current, sidebar }))
              }}
            />
          }
        />

        <section className="editor-pane pane" aria-label="Markdown 编辑器" role="region">
          <PaneSeparator
            label="调整编辑器宽度"
            value={paneSizes.editor}
            minimum={360}
            maximum={900}
            onResize={(editor) => {
              setCustomPaneSizes(true)
              setPaneSizes((current) => ({ ...current, editor }))
            }}
          />
          <header className="editor-header">
            <div className="path-heading">
              <span className="eyebrow">当前笔记</span>
              <strong title={selectedNote?.path}>{selectedNote?.path ?? "尚未选择笔记"}</strong>
              {visibilityNotice && visibilityNotice.path === selectedNote?.path ? (
                <span className="visibility-notice" role="status">
                  {visibilityNotice.messages.map((message) => (
                    <span key={message}>{message}</span>
                  ))}
                </span>
              ) : null}
            </div>
            {selectedNote ? (
              <VisibilityMenu
                value={selectedNote.visibility}
                disabled={visibilityBusy}
                onChange={(value) => requestVisibility(selectedNote, value)}
              />
            ) : null}
          </header>
          <div className="editor-placeholder" data-editor-document={document?.path ?? ""}>
            {selectedNote ? (
              documentError ? (
                <div className="editor-load-error" role="alert">
                  <TriangleAlert size={24} aria-hidden="true" />
                  <strong>无法读取当前笔记</strong>
                  <span>{documentError}</span>
                  <button type="button" onClick={() => setDocumentRetry((current) => current + 1)}>
                    重试读取
                  </button>
                </div>
              ) : (
                <>
                  <div className="editor-gutter" aria-hidden="true">
                    1<br />2<br />3<br />4<br />5<br />6
                  </div>
                  <pre aria-label="Markdown 源文档预览">
                    {document?.markdown ?? "正在载入 Markdown…"}
                  </pre>
                  <p className="editor-notice">
                    编辑器接口已就绪；Markdown 编辑、自动保存与 Wiki 补全将在下一阶段接入。
                  </p>
                </>
              )
            ) : (
              <div className="empty-state">
                <BookOpen size={28} />
                <strong>选择一篇笔记开始写作</strong>
                <span>左侧会同时列出公开和私密内容。</span>
              </div>
            )}
          </div>
        </section>

        <PreviewPane note={selectedNote} preview={preview} onLoadHistory={loadHistory} />
      </div>

      <footer className="statusbar" role="status" aria-label="发布状态">
        <div className="status-item">
          <Check size={14} aria-hidden="true" />
          <span>已保存</span>
        </div>
        <div className="status-item">
          {preview.state === "starting" || preview.state === "building" ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : (
            <Eye size={14} aria-hidden="true" />
          )}
          <span>{previewLabel[preview.state]}</span>
        </div>
        <div className="status-item publish-summary" title={publishMessage}>
          <GitBranch size={14} aria-hidden="true" />
          <span>可发布变化：{changeCount === undefined ? "暂不可用" : changeCount}</span>
          <small>{publishProgress?.message ?? publishMessage}</small>
        </div>
        <button className="publish-button" type="button" disabled={changeCount === undefined}>
          检查并发布
        </button>
      </footer>

      {pendingVisibility ? (
        <ModalShell
          labelId="private-confirm-title"
          className="new-note-dialog visibility-confirm-dialog"
          initialFocus={confirmationCancel}
          onClose={() => setPendingVisibility(undefined)}
        >
          <header>
            <h2 id="private-confirm-title">确认设为私密</h2>
          </header>
          <div className="visibility-confirm-copy">
            <p>当前在线副本要等发布下架</p>
            <p>Git 历史可能仍可见</p>
            <small>如果这篇笔记从未发布，上述在线与历史提醒可能不适用。</small>
          </div>
          <div className="dialog-actions">
            <button
              ref={confirmationCancel}
              type="button"
              className="secondary-button"
              onClick={() => setPendingVisibility(undefined)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button warning-button"
              onClick={() => {
                const pending = pendingVisibility
                setPendingVisibility(undefined)
                void changeVisibility(pending.note, pending.visibility)
              }}
            >
              确认设为私密
            </button>
          </div>
        </ModalShell>
      ) : null}
    </main>
  )
}

export function App(): React.JSX.Element {
  if (!window.garden) {
    return (
      <main className="app-shell bridge-unavailable">
        <header className="topbar">
          <div className="brand-mark" aria-hidden="true">
            <BookOpen size={18} />
          </div>
          <div>
            <p className="eyebrow">个人知识花园</p>
            <h1>~/Knowledge Garden</h1>
          </div>
        </header>
        <div className="workspace-grid">
          <nav className="sidebar pane" aria-label="笔记">
            <div className="empty-state">
              <strong>笔记服务不可用</strong>
              <span>安全桥接未载入，请重新启动应用。</span>
            </div>
          </nav>
          <section className="editor-pane pane" aria-label="Markdown 编辑器" role="region">
            <div className="empty-state">
              <strong>Markdown 编辑器</strong>
              <span>等待安全桥接恢复。</span>
            </div>
          </section>
          <section className="preview-pane pane" aria-label="本地预览" role="region">
            <div className="empty-state">
              <strong>本地预览</strong>
              <span>当前无法启动 Quartz 预览。</span>
            </div>
          </section>
        </div>
        <footer className="statusbar" role="status" aria-label="发布状态">
          安全桥接不可用，未执行任何操作。
        </footer>
      </main>
    )
  }
  return <PublisherApp api={window.garden} />
}
