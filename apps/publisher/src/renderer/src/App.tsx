import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BookOpen, Check, Eye, GitBranch, LoaderCircle, Trash2, TriangleAlert } from "lucide-react"
import type {
  AppError,
  BlogAddLocalRequest,
  BlogCloneRequest,
  BlogRegistryView,
  ChangeReview,
  GardenApi,
  NoteCreateRequest,
  NoteDocument,
  NoteSummary,
  NoteTrashReceipt,
  PreviewStatus,
  PublishProgress,
  Visibility,
  WorkspaceInspection,
  WorkspaceRepairAction,
} from "../../shared/contracts"
import { NoteSidebar } from "./components/NoteSidebar"
import { ModalShell } from "./components/ModalShell"
import { MarkdownEditor, type MarkdownEditorHandle } from "./components/MarkdownEditor"
import { PreviewPane } from "./components/PreviewPane"
import { VisibilityMenu } from "./components/VisibilityMenu"
import { PublishReview } from "./components/PublishReview"
import type { HistorySnapshot } from "./components/HistoryView"
import { FirstRun } from "./components/FirstRun"
import { DeleteNoteDialog } from "./components/DeleteNoteDialog"
import { BlogSwitcher } from "./components/BlogSwitcher"
import { BlogManager, type BlogImportUiState } from "./components/BlogManager"
import "./app.css"

type LoadState = "loading" | "ready" | "error"

const stoppedPreview: PreviewStatus = { state: "stopped", generation: 0 }
const PANE_STORAGE_KEY = "garden-publisher:pane-sizes"
const DEFAULT_PANE_SIZES = { sidebar: 240, editor: 520 }
const MIN_SIDEBAR = 190
const MAX_SIDEBAR = 420
const MIN_EDITOR = 360
const MAX_EDITOR = 900
const MIN_PREVIEW = 360
const COMPACT_PANE_BREAKPOINT = 1050

type PaneSizes = { sidebar: number; editor: number }

function clampPaneSizes(value: PaneSizes, width: number): PaneSizes {
  if (width <= COMPACT_PANE_BREAKPOINT) {
    return {
      sidebar: Math.min(
        value.sidebar,
        Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, width - MIN_EDITOR)),
      ),
      editor: MIN_EDITOR,
    }
  }
  const sidebar = Math.min(
    value.sidebar,
    Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, width - MIN_EDITOR - MIN_PREVIEW)),
  )
  return {
    sidebar,
    editor: Math.min(
      value.editor,
      Math.min(MAX_EDITOR, Math.max(MIN_EDITOR, width - sidebar - MIN_PREVIEW)),
    ),
  }
}

function storedPaneSizes(width: number): PaneSizes | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(PANE_STORAGE_KEY) ?? "null") as unknown
    if (
      !value ||
      typeof value !== "object" ||
      !("sidebar" in value) ||
      !("editor" in value) ||
      typeof value.sidebar !== "number" ||
      typeof value.editor !== "number" ||
      !Number.isFinite(value.sidebar) ||
      !Number.isFinite(value.editor) ||
      value.sidebar < MIN_SIDEBAR ||
      value.sidebar > MAX_SIDEBAR ||
      value.editor < MIN_EDITOR ||
      value.editor > MAX_EDITOR
    ) {
      return undefined
    }
    return clampPaneSizes(
      { sidebar: value.sidebar as number, editor: value.editor as number },
      width,
    )
  } catch {
    return undefined
  }
}

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
      onLostPointerCapture={() => {
        drag.current = undefined
      }}
    />
  )
}

export function PublisherApp({
  api,
  initialRegistry,
  diagnosticsReady = false,
}: {
  readonly api: GardenApi
  readonly initialRegistry: BlogRegistryView
  readonly diagnosticsReady?: boolean
}): React.JSX.Element {
  const [registry, setRegistry] = useState<BlogRegistryView>(initialRegistry)
  const [managerOpen, setManagerOpen] = useState(false)
  const [blogBusy, setBlogBusy] = useState(false)
  const blogBusyRef = useRef(false)
  const [importState, setImportState] = useState<BlogImportUiState>({
    view: "list",
    busy: false,
  })
  const [notes, setNotes] = useState<readonly NoteSummary[]>([])
  const [selectedPath, setSelectedPath] = useState<string>()
  const [document, setDocument] = useState<NoteDocument>()
  const [documentError, setDocumentError] = useState<string>()
  const [documentRetry, setDocumentRetry] = useState(0)
  const [notesState, setNotesState] = useState<LoadState>("loading")
  const [notesMessage, setNotesMessage] = useState("正在读取花园…")
  const [preview, setPreview] = useState<PreviewStatus>(stoppedPreview)
  const [changeCount, setChangeCount] = useState<number>()
  const [changeReview, setChangeReview] = useState<ChangeReview>()
  const [changeReviewState, setChangeReviewState] = useState<LoadState>("loading")
  const [changeReviewOpen, setChangeReviewOpen] = useState(false)
  const [publishMessage, setPublishMessage] = useState("正在检查可发布变化…")
  const [publishProgress, setPublishProgress] = useState<PublishProgress>()
  const [saveStateLabel, setSaveStateLabel] = useState("已保存")
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
  const [pendingDelete, setPendingDelete] = useState<NoteSummary>()
  const [trashNotice, setTrashNotice] = useState<string>()
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth || 1440)
  const initialPaneSizes = useRef(storedPaneSizes(workspaceWidth))
  const [paneSizes, setPaneSizes] = useState(initialPaneSizes.current ?? DEFAULT_PANE_SIZES)
  const [customPaneSizes, setCustomPaneSizes] = useState(Boolean(initialPaneSizes.current))
  const confirmationCancel = useRef<HTMLButtonElement>(null)
  const postDeleteFocus = useRef<HTMLButtonElement>(null)
  const appMounted = useRef(true)
  const workspace = useRef<HTMLDivElement>(null)
  const markdownEditor = useRef<MarkdownEditorHandle>(null)
  const notesRequest = useRef(0)
  const previewRequest = useRef(0)
  const changesRequest = useRef(0)
  const previewStart = useRef<ReturnType<GardenApi["preview"]["start"]> | undefined>(undefined)
  const safePaneSizes = useMemo(
    () => clampPaneSizes(paneSizes, workspaceWidth),
    [paneSizes, workspaceWidth],
  )
  const compactPanes = workspaceWidth <= COMPACT_PANE_BREAKPOINT

  const setBlogOperationBusy = useCallback((busy: boolean): void => {
    blogBusyRef.current = busy
    setBlogBusy(busy)
    setImportState((current) => ({ ...current, busy }))
  }, [])

  const runBlogOperation = useCallback(
    async (operation: () => Promise<void>): Promise<void> => {
      if (blogBusyRef.current) return
      setBlogOperationBusy(true)
      setImportState((current) => ({ ...current, error: undefined }))
      try {
        await operation()
      } catch (failure) {
        if (appMounted.current) {
          setImportState((current) => ({
            ...current,
            error: failure instanceof Error ? failure.message : "博客操作失败，请重试。",
          }))
          setManagerOpen(true)
        }
      } finally {
        if (appMounted.current) setBlogOperationBusy(false)
      }
    },
    [setBlogOperationBusy],
  )

  const refreshBlogs = useCallback(async (): Promise<BlogRegistryView> => {
    const result = await api.blogs.list()
    if (!result.ok) throw new Error(result.error.message)
    if (appMounted.current) setRegistry(result.value)
    return result.value
  }, [api])

  const switchBlog = useCallback(
    (id: string): void => {
      if (id === registry.activeBlogId || blogBusyRef.current) return
      void runBlogOperation(async () => {
        const editorSaved = (await markdownEditor.current?.flushSave()) ?? true
        if (!editorSaved) throw new Error("当前笔记保存失败，未切换博客。")
        const result = await api.blogs.switch({ id, editorSaved: true })
        if (!result.ok) throw new Error(result.error.message)
      })
    },
    [api, registry.activeBlogId, runBlogOperation],
  )

  useEffect(
    () =>
      api.blogs.onImportProgress((progress) => {
        if (!appMounted.current) return
        setImportState((current) => ({ ...current, progress }))
      }),
    [api],
  )

  const selectedNote = useMemo(
    () => notes.find((note) => note.path === selectedPath),
    [notes, selectedPath],
  )

  const selectNote = useCallback(
    async (path: string): Promise<void> => {
      if (path === selectedPath) return
      const safeToSwitch = (await markdownEditor.current?.flush()) ?? true
      if (safeToSwitch && appMounted.current) {
        setDocument(undefined)
        setSelectedPath(path)
      }
    },
    [selectedPath],
  )

  useEffect(() => {
    appMounted.current = true
    const unsubscribeBeforeClose = api.lifecycle.onBeforeClose(({ requestId }) => {
      setSaveStateLabel("正在安全保存并关闭…")
      void Promise.resolve()
        .then(() => markdownEditor.current?.flush() ?? true)
        .then(
          async (success) => {
            if (!success && appMounted.current) setSaveStateLabel("保存失败，窗口仍保持打开")
            await api.lifecycle.acknowledgeClose({ requestId, success })
          },
          async () => {
            if (appMounted.current) setSaveStateLabel("保存失败，窗口仍保持打开")
            await api.lifecycle.acknowledgeClose({ requestId, success: false })
          },
        )
        .catch(() => {
          if (appMounted.current) setSaveStateLabel("关闭确认失败，窗口仍保持打开")
        })
    })
    const unsubscribeCloseBlocked = api.lifecycle.onCloseBlocked((message) => {
      if (appMounted.current) setSaveStateLabel(message)
    })
    return () => {
      appMounted.current = false
      unsubscribeBeforeClose()
      unsubscribeCloseBlocked()
    }
  }, [api])

  useEffect(() => {
    const updateWidth = (width: number): void => {
      if (Number.isFinite(width) && width > 0) setWorkspaceWidth(width)
    }
    const measure = (): void => {
      updateWidth(workspace.current?.clientWidth || window.innerWidth || 1440)
    }
    measure()
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            updateWidth(entries[0]?.contentRect.width || window.innerWidth || 1440)
          })
    if (workspace.current) observer?.observe(workspace.current)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  const loadNotes = useCallback(async () => {
    const request = ++notesRequest.current
    setNotesState("loading")
    setNotesMessage("正在读取花园…")
    let result: Awaited<ReturnType<GardenApi["notes"]["list"]>>
    try {
      result = await api.notes.list()
    } catch (error) {
      if (request !== notesRequest.current) return
      setNotesState("error")
      setNotesMessage(error instanceof Error ? error.message : "无法读取笔记列表")
      return
    }
    if (request !== notesRequest.current) return
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

  const applyPreview = useCallback((next: PreviewStatus): void => {
    setPreview((current) => {
      if (next.generation < current.generation) return current
      if (next.state === "error" && !next.lastSuccessfulUrl && current.lastSuccessfulUrl) {
        return { ...next, lastSuccessfulUrl: current.lastSuccessfulUrl }
      }
      return next
    })
  }, [])

  const startPreview = useCallback(() => {
    if (!previewStart.current) {
      previewStart.current = api.preview.start({ preferredPort: 8080 }).finally(() => {
        previewStart.current = undefined
      })
    }
    return previewStart.current
  }, [api])

  const loadChanges = useCallback(async (): Promise<void> => {
    const request = ++changesRequest.current
    setChangeReviewState("loading")
    let result: Awaited<ReturnType<GardenApi["changes"]["list"]>>
    try {
      result = await api.changes.list()
    } catch (error) {
      if (request !== changesRequest.current) return
      setChangeReview(undefined)
      setChangeCount(undefined)
      setChangeReviewState("error")
      setPublishMessage(error instanceof Error ? error.message : "无法检查可发布变化")
      return
    }
    if (request !== changesRequest.current) return
    if (!result.ok) {
      setChangeReview(undefined)
      setChangeCount(undefined)
      setChangeReviewState("error")
      setPublishMessage(messageFor(result.error, "发布检查暂不可用。"))
      return
    }
    setChangeReview(result.value)
    setChangeReviewState("ready")
    const publishable = result.value.groups.filter((group) => group.selection === "default").length
    setChangeCount(publishable)
    setPublishMessage(
      result.value.blockedReason ??
        (result.value.groups.length === 0 ? "当前没有可发布变化" : "可查看并选择要发布的变化"),
    )
  }, [api])

  useEffect(() => {
    const unsubscribeRecovery = api.notes.onRecovery(({ restored, conflicts }) => {
      if (!appMounted.current) return
      if (restored.length > 0) {
        setTrashNotice(`已从 Windows 回收站恢复 ${restored.length} 项，笔记列表已更新。`)
        void loadNotes()
      }
      if (conflicts.length > 0) {
        setTrashNotice(`回收站恢复项与 ${conflicts[0]} 冲突；恢复副本仍安全保留在恢复区。`)
      }
    })
    void loadNotes()
    const currentPreviewRequest = ++previewRequest.current
    void api.preview
      .status()
      .then(async (result) => {
        if (currentPreviewRequest !== previewRequest.current) return
        if (!result.ok) {
          applyPreview({ state: "error", generation: 0, error: result.error })
          return
        }
        applyPreview(result.value)
        if (result.value.state === "stopped") {
          const started = await startPreview()
          if (currentPreviewRequest !== previewRequest.current) return
          applyPreview(
            started.ok
              ? started.value
              : { state: "error", generation: result.value.generation, error: started.error },
          )
        }
      })
      .catch((error: unknown) => {
        if (currentPreviewRequest !== previewRequest.current) return
        setPreview((current) => ({
          state: "error",
          generation: current.generation,
          lastSuccessfulUrl: current.lastSuccessfulUrl ?? current.url,
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "无法读取预览状态",
          },
        }))
      })
    void loadChanges()
    const unsubscribePreview = api.preview.onProgress(applyPreview)
    const unsubscribePublish = api.publish.onProgress(setPublishProgress)
    return () => {
      unsubscribeRecovery()
      unsubscribePreview()
      unsubscribePublish()
      notesRequest.current += 1
      previewRequest.current += 1
      changesRequest.current += 1
      void api.changes.cancel()
    }
  }, [api, applyPreview, loadChanges, loadNotes, startPreview])

  useEffect(() => {
    if (!customPaneSizes) return
    if (paneSizes.sidebar !== safePaneSizes.sidebar || paneSizes.editor !== safePaneSizes.editor) {
      setPaneSizes(safePaneSizes)
    }
    try {
      localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(safePaneSizes))
    } catch {
      // Persistence is optional; resizing must keep working when storage is unavailable or full.
    }
  }, [customPaneSizes, paneSizes, safePaneSizes])

  const resizeSidebar = (sidebar: number): void => {
    setCustomPaneSizes(true)
    setPaneSizes((current) => ({
      ...current,
      sidebar: Math.min(
        MAX_SIDEBAR,
        Math.max(
          MIN_SIDEBAR,
          Math.min(sidebar, workspaceWidth - safePaneSizes.editor - MIN_PREVIEW),
        ),
      ),
    }))
  }
  const resizeEditor = (editor: number): void => {
    setCustomPaneSizes(true)
    setPaneSizes((current) => ({
      ...current,
      editor: Math.min(
        MAX_EDITOR,
        Math.max(
          MIN_EDITOR,
          Math.min(editor, workspaceWidth - safePaneSizes.sidebar - MIN_PREVIEW),
        ),
      ),
    }))
  }

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
    if (!((await markdownEditor.current?.flush()) ?? true)) {
      return "当前笔记保存失败，已保留编辑内容。"
    }
    const result = await api.notes.create(request)
    if (!appMounted.current) return undefined
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
    if (note.path === selectedPath && !((await markdownEditor.current?.flush()) ?? true)) {
      setVisibilityError({
        path: note.path,
        title: note.title,
        message: "当前笔记保存失败，已保留编辑内容。",
      })
      return
    }
    setVisibilityBusy(true)
    setVisibilityError(undefined)
    try {
      const result = await api.notes.changeVisibility({ path: note.path, visibility })
      if (!appMounted.current) return
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
      if (!appMounted.current) return
      setVisibilityError({
        path: note.path,
        title: note.title,
        message: error instanceof Error ? error.message : "无法更改这篇笔记的可见性",
      })
    } finally {
      if (appMounted.current) setVisibilityBusy(false)
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

  const deleteNote = async (note: NoteSummary): Promise<NoteTrashReceipt> => {
    if (note.path === selectedPath && !((await markdownEditor.current?.flush()) ?? true)) {
      throw new Error("当前笔记保存失败，编辑内容已保留；未执行删除。")
    }
    const result = await api.notes.trash({ path: note.path })
    if (!result.ok) throw new Error(messageFor(result.error, "无法将笔记移入回收站。"))
    if (!appMounted.current) return result.value
    setNotes((current) => current.filter((candidate) => candidate.path !== note.path))
    if (selectedPath === note.path) {
      setSelectedPath(undefined)
      setDocument(undefined)
      setDocumentError(undefined)
    }
    const deletionMessages = [
      result.value.pendingPublicDeletion
        ? "笔记已移入回收站；已发布的在线副本仍会保留，直到再次发布下架变化。"
        : "笔记已移入 Windows 回收站。",
      ...(result.value.attachmentCleanup.status === "failed" ||
      result.value.attachmentCleanup.status === "retained-ambiguous"
        ? [result.value.attachmentCleanup.message]
        : result.value.attachmentCleanup.status === "trashed"
          ? ["专属附件也已移入 Windows 回收站。"]
          : []),
    ]
    setTrashNotice(deletionMessages.join(" "))
    void loadChanges()
    return result.value
  }

  const loadHistory = useCallback(
    async (requestId: string): Promise<HistorySnapshot> => {
      const [git, deployments] = await Promise.all([
        api.history.git({ limit: 20, requestId }),
        api.history.deployments({ limit: 20, requestId }),
      ])
      if (!git.ok) throw new Error(messageFor(git.error, "本地发布历史暂不可用。"))
      if (!deployments.ok) throw new Error(messageFor(deployments.error, "部署历史暂不可用。"))
      return { commits: git.value, deployments: deployments.value }
    },
    [api],
  )
  const cancelHistory = useCallback(
    async (requestId: string): Promise<void> => {
      await api.history.cancel({ requestId })
    },
    [api],
  )
  const openHistoryLink = useCallback(
    async (url: string): Promise<void> => {
      const result = await api.history.openLink({ url })
      if (!result.ok) throw new Error(messageFor(result.error, "无法打开链接。"))
    },
    [api],
  )

  const previewLabel: Record<PreviewStatus["state"], string> = {
    stopped: "预览未启动",
    starting: "预览启动中",
    ready: "预览就绪",
    building: "预览更新中",
    error: "预览出错",
    stopping: "预览停止中",
  }

  const chooseLocalBlog = (): void => {
    setManagerOpen(true)
    setImportState((current) => ({ ...current, view: "local", localSelection: undefined }))
    void runBlogOperation(async () => {
      const result = await api.blogs.chooseLocal()
      if (!result.ok) throw new Error(result.error.message)
      if (appMounted.current && result.value) {
        setImportState((current) => ({ ...current, view: "local", localSelection: result.value }))
      }
    })
  }

  const addLocalBlog = (request: BlogAddLocalRequest): void => {
    void runBlogOperation(async () => {
      const result = await api.blogs.addLocal(request)
      if (!result.ok) throw new Error(result.error.message)
      if (appMounted.current) {
        setRegistry(result.value)
        setImportState({ view: "list", busy: true })
      }
    })
  }

  const cloneBlog = (request: BlogCloneRequest): void => {
    void runBlogOperation(async () => {
      setImportState((current) => ({ ...current, view: "clone", progress: undefined }))
      const normalized = { ...request, name: request.name?.trim() || undefined }
      const result = await api.blogs.clone(normalized)
      if (!result.ok) throw new Error(result.error.message)
      await refreshBlogs()
      if (appMounted.current) setImportState({ view: "list", busy: true })
    })
  }

  const installBlog = (path: string): void => {
    void runBlogOperation(async () => {
      const result = await api.blogs.install({ path })
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value.valid) throw new Error(result.value.message)
      if (appMounted.current) {
        setImportState((current) => ({
          ...current,
          view: "local",
          localSelection: { path, inspection: result.value },
        }))
      }
    })
  }

  const updateRegistry = (operation: () => ReturnType<GardenApi["blogs"]["rename"]>): void => {
    void runBlogOperation(async () => {
      const result = await operation()
      if (!result.ok) throw new Error(result.error.message)
      if (appMounted.current) setRegistry(result.value)
    })
  }

  return (
    <main
      className="app-shell"
      data-workspace-diagnostics={diagnosticsReady ? "ready" : "checking"}
    >
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <BookOpen size={18} />
        </div>
        <div>
          <p className="eyebrow">个人知识花园</p>
          <h1>~/Knowledge Garden</h1>
        </div>
        <BlogSwitcher
          registry={registry}
          disabled={blogBusy}
          onSwitch={switchBlog}
          onAddLocal={chooseLocalBlog}
          onClone={() => {
            setManagerOpen(true)
            setImportState((current) => ({ ...current, view: "clone", error: undefined }))
          }}
          onManage={() => {
            setManagerOpen(true)
            setImportState((current) => ({ ...current, view: "list", error: undefined }))
          }}
        />
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
      {trashNotice ? (
        <div className="global-alert" role="status">
          <Trash2 size={16} aria-hidden="true" />
          <span>{trashNotice}</span>
          <button type="button" aria-label="关闭删除提示" onClick={() => setTrashNotice(undefined)}>
            ×
          </button>
        </div>
      ) : null}

      <div
        ref={workspace}
        className={`workspace-grid${compactPanes ? " compact-panes" : ""}`}
        style={
          customPaneSizes
            ? ({
                "--sidebar-width": `${safePaneSizes.sidebar}px`,
                "--editor-width": `${safePaneSizes.editor}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        <NoteSidebar
          notes={notes}
          loadState={notesState}
          message={notesMessage}
          selectedPath={selectedPath}
          onSelect={(path) => void selectNote(path)}
          onCreate={createNote}
          onRetry={() => void loadNotes()}
          focusTarget={postDeleteFocus}
          separator={
            !compactPanes ? (
              <PaneSeparator
                label="调整笔记栏宽度"
                value={safePaneSizes.sidebar}
                minimum={MIN_SIDEBAR}
                maximum={Math.max(
                  MIN_SIDEBAR,
                  Math.min(MAX_SIDEBAR, workspaceWidth - safePaneSizes.editor - MIN_PREVIEW),
                )}
                onResize={resizeSidebar}
              />
            ) : undefined
          }
        />

        <section className="editor-pane pane" aria-label="Markdown 编辑器" role="region">
          {!compactPanes ? (
            <PaneSeparator
              label="调整编辑器宽度"
              value={safePaneSizes.editor}
              minimum={MIN_EDITOR}
              maximum={Math.max(
                MIN_EDITOR,
                Math.min(MAX_EDITOR, workspaceWidth - safePaneSizes.sidebar - MIN_PREVIEW),
              )}
              onResize={resizeEditor}
            />
          ) : null}
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
              <div className="editor-actions">
                <VisibilityMenu
                  value={selectedNote.visibility}
                  disabled={visibilityBusy}
                  onChange={(value) => requestVisibility(selectedNote, value)}
                />
                <button
                  type="button"
                  className="icon-button danger-icon-button"
                  aria-label="删除当前笔记"
                  onClick={() => setPendingDelete(selectedNote)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
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
              ) : document ? (
                <MarkdownEditor
                  key={document.path}
                  ref={markdownEditor}
                  document={document}
                  notes={notes}
                  save={api.notes.save}
                  read={() => api.notes.read({ path: document.path })}
                  recovery={{
                    get: () => api.notes.recovery.get({ path: document.path }),
                    write: api.notes.recovery.write,
                    discard: api.notes.recovery.discard,
                  }}
                  onSaved={(receipt) => {
                    setDocument((current) =>
                      current?.path === receipt.path
                        ? {
                            ...current,
                            mtimeMs: receipt.mtimeMs,
                            contentHash: receipt.contentHash,
                          }
                        : current,
                    )
                    setNotes((current) =>
                      current.map((note) =>
                        note.path === receipt.path
                          ? { ...note, updatedAt: receipt.updatedAt }
                          : note,
                      ),
                    )
                  }}
                  onSaveStateChange={setSaveStateLabel}
                />
              ) : (
                <p className="editor-notice">正在载入 Markdown…</p>
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

        <PreviewPane
          note={selectedNote}
          preview={preview}
          onLoadHistory={loadHistory}
          onCancelHistory={cancelHistory}
          onOpenHistoryLink={openHistoryLink}
        />
      </div>

      <footer className="statusbar" aria-label="发布状态">
        <div className="status-live" role="status" aria-live="polite" aria-label="发布状态">
          <div className="status-item">
            <Check size={14} aria-hidden="true" />
            <span>{saveStateLabel}</span>
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
        </div>
        <button
          className="publish-button"
          type="button"
          aria-describedby={
            changeReviewState === "error" ? "publish-review-unavailable" : undefined
          }
          onClick={() => {
            setChangeReviewOpen(true)
            void loadChanges()
          }}
        >
          检查并发布
        </button>
        <span id="publish-review-unavailable" className="sr-only">
          {changeReviewState === "error" ? publishMessage : "发布检查可用。"}
        </span>
      </footer>

      {changeReviewOpen ? (
        <PublishReview
          state={changeReviewState}
          review={changeReview}
          error={changeReviewState === "error" ? publishMessage : undefined}
          onClose={() => {
            changesRequest.current += 1
            void api.changes.cancel()
            setChangeReviewOpen(false)
          }}
          onRefresh={() => void loadChanges()}
          onPublish={async (changeGroupIds) => {
            const saved = (await markdownEditor.current?.flush()) ?? true
            if (!saved) throw new Error("当前笔记保存失败，未开始发布。")
            const result = await api.publish.start({ changeGroupIds })
            if (!result.ok) {
              const message = messageFor(result.error, "无法开始发布。")
              setPublishMessage(message)
              throw new Error(message)
            }
            setPublishMessage("正在验证所选公开变化…")
            setChangeReviewOpen(false)
          }}
        />
      ) : null}

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
            <p>若已上线，当前在线副本要等发布下架</p>
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
      {pendingDelete ? (
        <DeleteNoteDialog
          note={pendingDelete}
          onClose={() => setPendingDelete(undefined)}
          onDelete={() => deleteNote(pendingDelete)}
          onDeleted={() => {
            setPendingDelete(undefined)
            requestAnimationFrame(() => postDeleteFocus.current?.focus())
          }}
        />
      ) : null}
      <BlogManager
        open={managerOpen}
        registry={registry}
        importState={importState}
        onClose={() => setManagerOpen(false)}
        onChooseLocal={chooseLocalBlog}
        onAddLocal={addLocalBlog}
        onClone={cloneBlog}
        onInstall={installBlog}
        onRename={(id, name) => updateRegistry(() => api.blogs.rename({ id, name }))}
        onOpenFolder={(id) => {
          void runBlogOperation(async () => {
            const result = await api.blogs.openFolder({ id })
            if (!result.ok) throw new Error(result.error.message)
          })
        }}
        onRemove={(id) => updateRegistry(() => api.blogs.remove({ id }))}
        onSwitch={switchBlog}
        onCancelImport={() => {
          void api.blogs
            .cancelImport()
            .then((result) => {
              if (!result.ok && appMounted.current) {
                setImportState((current) => ({ ...current, error: result.error.message }))
              }
            })
            .catch((failure: unknown) => {
              if (appMounted.current) {
                setImportState((current) => ({
                  ...current,
                  error: failure instanceof Error ? failure.message : "无法取消导入。",
                }))
              }
            })
        }}
      />
    </main>
  )
}

function PublisherStartup({
  api,
  registry,
}: {
  readonly api: GardenApi
  readonly registry: BlogRegistryView
}): React.JSX.Element {
  const [safety, setSafety] = useState<WorkspaceInspection>()
  const [inspection, setInspection] = useState<WorkspaceInspection>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const inspectDiagnostics = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.workspace.inspect()
      if (!mounted.current) return
      if (!result.ok) {
        setError(messageFor(result.error, "无法完成启动检查。"))
        setInspection(undefined)
      } else {
        setInspection(result.value)
      }
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "无法完成启动检查。")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [api])

  const inspectSafety = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.workspace.inspectSafety()
      if (!mounted.current) return
      if (!result.ok) {
        setError(messageFor(result.error, "无法完成本地安全检查。"))
        setSafety(undefined)
        return
      }
      setSafety(result.value)
      if (result.value.capabilities.files) void inspectDiagnostics()
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "无法完成本地安全检查。")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [api, inspectDiagnostics])

  useEffect(() => {
    void inspectSafety()
  }, [inspectSafety])
  if (safety?.capabilities.files) {
    return (
      <>
        {inspection?.ok === false || error ? (
          <FirstRun
            compact
            inspection={inspection}
            busy={busy}
            error={error}
            onRetry={() => void inspectDiagnostics()}
            onRepair={async (action: WorkspaceRepairAction) => {
              setBusy(true)
              setError(undefined)
              try {
                const result = await api.workspace.repair({ action })
                if (!result.ok) throw new Error(messageFor(result.error, "无法修复仓库依赖。"))
                await inspectDiagnostics()
              } catch (failure) {
                if (mounted.current)
                  setError(failure instanceof Error ? failure.message : "无法修复仓库依赖。")
              } finally {
                if (mounted.current) setBusy(false)
              }
            }}
          />
        ) : null}
        <PublisherApp
          api={api}
          initialRegistry={registry}
          diagnosticsReady={inspection?.ok === true}
        />
      </>
    )
  }
  return (
    <FirstRun
      inspection={safety}
      busy={busy}
      error={error}
      onRetry={() => void inspectSafety()}
      onRepair={async (action: WorkspaceRepairAction) => {
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.workspace.repair({ action })
          if (!result.ok) throw new Error(messageFor(result.error, "无法修复仓库依赖。"))
          await inspectSafety()
        } catch (failure) {
          if (mounted.current)
            setError(failure instanceof Error ? failure.message : "无法修复仓库依赖。")
        } finally {
          if (mounted.current) setBusy(false)
        }
      }}
    />
  )
}

function BlogStartup({ api }: { readonly api: GardenApi }): React.JSX.Element {
  const [registry, setRegistry] = useState<BlogRegistryView>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setRegistry(undefined)
    setError(undefined)
    void api.blogs
      .list()
      .then((result) => {
        if (!active) return
        if (result.ok) setRegistry(result.value)
        else setError(result.error.message)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "无法读取博客列表。")
      })
    return () => {
      active = false
    }
  }, [api, attempt])

  if (error) {
    return (
      <main className="first-run-shell">
        <section className="first-run-card" role="region" aria-label="博客恢复">
          <header>
            <div>
              <p className="eyebrow">Knowledge Garden Publisher</p>
              <h1>博客恢复</h1>
            </div>
          </header>
          <p role="alert">{error}</p>
          <p>工作区服务尚未启动。修复或恢复博客列表后再继续。</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setAttempt((v) => v + 1)}
          >
            重新读取博客列表
          </button>
        </section>
      </main>
    )
  }
  if (!registry) {
    return (
      <main className="first-run-shell">
        <section className="first-run-card" role="status" aria-label="正在载入博客">
          <p>正在载入博客…</p>
        </section>
      </main>
    )
  }
  return <PublisherStartup api={api} registry={registry} />
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
  return <BlogStartup api={window.garden} />
}
