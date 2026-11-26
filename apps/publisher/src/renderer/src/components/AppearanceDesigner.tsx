import { useEffect, useMemo, useRef, useState } from "react"
import { RotateCcw, Undo2, X } from "lucide-react"
import { cloneAppearancePreset } from "../../../shared/appearance"
import type { AppearanceSettings } from "../../../shared/appearance"
import type {
  AppError,
  AppearancePreviewTarget,
  AppearanceSnapshot,
  GardenApi,
  IpcResult,
} from "../../../shared/contracts"
import { appearanceSettingsSchema } from "../../../shared/ipcSchemas"
import { AppearanceControls } from "./AppearanceControls"
import { AppearancePreview } from "./AppearancePreview"
import { ModalShell } from "./ModalShell"

interface AppearanceDesignerProps {
  readonly api: GardenApi["appearance"]
  readonly previewUrl?: string
  readonly externalError?: string
  readonly onClose: () => void
  readonly onChanged?: () => void
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: AppearanceSnapshot }

type Notice =
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | undefined

function loopbackPreviewUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "http:" && url.hostname === "127.0.0.1" ? url.href : undefined
  } catch {
    return undefined
  }
}

function createSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return "00000000-0000-4000-8000-000000000000"
}

function settingsKey(settings: AppearanceSettings): string {
  return JSON.stringify(settings)
}

function failureMessage(error: AppError, operation: "apply" | "undo" | "read"): string {
  if (error.code === "APPEARANCE_CONFLICT" || error.code === "APPEARANCE_CHANGED") {
    return "外观文件已在其他位置发生变化。请重新读取后再应用，当前草稿已保留。"
  }
  if (error.code === "APPEARANCE_TRANSACTION_FAILED" || error.code === "PREVIEW_BUILD_FAILED") {
    return "构建失败，已恢复应用前的外观。当前草稿仍在，可修正后重试。"
  }
  if (error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") {
    return "外观事务的恢复结果无法确认。请先检查博客文件和本地预览，暂时不要继续应用。"
  }
  if (operation === "read") return `无法读取外观设置：${error.message}`
  if (operation === "undo") return `无法撤销上次应用：${error.message}`
  return `无法应用外观：${error.message}`
}

function resultError<T>(result: IpcResult<T>): AppError | undefined {
  return result.ok ? undefined : result.error
}

export function AppearanceDesigner({
  api,
  previewUrl,
  externalError,
  onClose,
  onChanged,
}: AppearanceDesignerProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [draft, setDraft] = useState<AppearanceSettings>()
  const [previewTarget, setPreviewTarget] = useState<AppearancePreviewTarget>({
    componentId: "domainCard",
    state: "normal",
  })
  const [busy, setBusy] = useState<"apply" | "undo" | "image" | "close">()
  const [notice, setNotice] = useState<Notice>()
  const [previewState, setPreviewState] = useState<"idle" | "updating" | "ready" | "error">("idle")
  const closeButton = useRef<HTMLButtonElement>(null)
  const closing = useRef(false)
  const mounted = useRef(true)
  const sessionId = useRef(createSessionId())
  const readRequestId = useRef(0)
  const previewRequestId = useRef(0)
  const previewTimer = useRef<number | undefined>(undefined)
  const lastFocusSeq = useRef<number | undefined>(undefined)
  const activePreviewUrl = useMemo(() => loopbackPreviewUrl(previewUrl), [previewUrl])
  const sessionPreviewUrl = useMemo(() => {
    if (!activePreviewUrl) return undefined
    const url = new URL(activePreviewUrl)
    url.searchParams.set("kgpAppearance", sessionId.current)
    return url.href
  }, [activePreviewUrl])
  const snapshot = loadState.kind === "ready" ? loadState.snapshot : undefined
  const validation = useMemo(
    () => (draft ? appearanceSettingsSchema.safeParse(draft) : undefined),
    [draft],
  )
  const dirty = Boolean(snapshot && draft && settingsKey(snapshot.settings) !== settingsKey(draft))

  useEffect(() => {
    mounted.current = true
    const requestId = ++readRequestId.current
    void api.read().then((result) => {
      if (!mounted.current || requestId !== readRequestId.current) return
      if (!result.ok) {
        setLoadState({ kind: "error", message: failureMessage(result.error, "read") })
        return
      }
      setDraft(result.value.settings)
      setLoadState({ kind: "ready", snapshot: result.value })
    })
    return () => {
      mounted.current = false
      readRequestId.current += 1
      previewRequestId.current += 1
    }
  }, [api])

  useEffect(() => {
    const requestId = ++previewRequestId.current
    if (!snapshot?.supported || !sessionPreviewUrl || !draft || !validation?.success) {
      setPreviewState("idle")
      return
    }
    setPreviewState("updating")
    const immediateFocus =
      previewTarget.focusSeq !== undefined && previewTarget.focusSeq !== lastFocusSeq.current
    lastFocusSeq.current = previewTarget.focusSeq
    const timer = window.setTimeout(
      () => {
        if (previewTimer.current === timer) previewTimer.current = undefined
        if (closing.current || requestId !== previewRequestId.current) return
        void api
          .preview({
            url: sessionPreviewUrl,
            sessionId: sessionId.current,
            settings: draft,
            target: previewTarget,
          })
          .then((result) => {
            if (!mounted.current || requestId !== previewRequestId.current) return
            setPreviewState(result.ok ? "ready" : "error")
          })
      },
      immediateFocus ? 0 : 100,
    )
    previewTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      if (previewTimer.current === timer) previewTimer.current = undefined
    }
  }, [api, draft, previewTarget, sessionPreviewUrl, snapshot?.supported, validation?.success])

  const close = async (): Promise<void> => {
    if (busy || closing.current) return
    closing.current = true
    setBusy("close")
    previewRequestId.current += 1
    if (previewTimer.current !== undefined) {
      window.clearTimeout(previewTimer.current)
      previewTimer.current = undefined
    }
    try {
      const result = await api.clearPreview({ sessionId: sessionId.current })
      if (!mounted.current) return
      if (!result.ok) {
        closing.current = false
        setBusy(undefined)
        setNotice({ kind: "error", message: `无法关闭外观设置：${result.error.message}` })
        return
      }
      onClose()
    } catch (failure) {
      if (!mounted.current) return
      closing.current = false
      setBusy(undefined)
      setNotice({
        kind: "error",
        message: `无法关闭外观设置：${failure instanceof Error ? failure.message : "预览清理失败"}`,
      })
    }
  }

  const chooseBackground = async (): Promise<void> => {
    if (!draft || busy) return
    setBusy("image")
    setNotice(undefined)
    try {
      const result = await api.chooseBackground()
      if (!mounted.current) return
      if (!result.ok) {
        setNotice({ kind: "error", message: `无法选择背景图片：${result.error.message}` })
        return
      }
      if (!result.value) return
      setDraft({
        ...draft,
        preset: "custom",
        background: {
          kind: "image",
          asset: result.value,
          overlay: draft.background.kind === "image" ? draft.background.overlay : "#000000",
          opacity: draft.background.kind === "image" ? draft.background.opacity : 0.25,
          position: draft.background.kind === "image" ? draft.background.position : "center",
          fixed: draft.background.kind === "image" ? draft.background.fixed : false,
        },
      })
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  const apply = async (): Promise<void> => {
    if (!snapshot || !draft || !dirty || !validation?.success || !activePreviewUrl || busy) return
    setBusy("apply")
    setNotice(undefined)
    const result = await api.apply({ settings: draft, baselineHash: snapshot.baselineHash })
    if (!mounted.current) return
    setBusy(undefined)
    if (!result.ok) {
      setNotice({ kind: "error", message: failureMessage(result.error, "apply") })
      return
    }
    setLoadState({ kind: "ready", snapshot: result.value.snapshot })
    setDraft(result.value.snapshot.settings)
    setNotice({ kind: "success", message: "外观已应用。本地预览已重新构建。" })
    onChanged?.()
  }

  const undo = async (): Promise<void> => {
    if (!snapshot?.canUndo || busy) return
    setBusy("undo")
    setNotice(undefined)
    const result = await api.undo({ baselineHash: snapshot.baselineHash })
    if (!mounted.current) return
    setBusy(undefined)
    if (!result.ok) {
      setNotice({ kind: "error", message: failureMessage(result.error, "undo") })
      return
    }
    setLoadState({ kind: "ready", snapshot: result.value.snapshot })
    setDraft(result.value.snapshot.settings)
    setNotice({ kind: "success", message: "已撤销上次应用。" })
    onChanged?.()
  }

  const invalidMessage =
    draft && validation && !validation.success
      ? draft.customCss.includes("</style") ||
        new TextEncoder().encode(draft.customCss).length > 64 * 1024
        ? "自定义 CSS 包含不允许的内容或超过 64 KiB。"
        : "部分外观字段无效，请检查字体、颜色和数值范围。"
      : undefined

  return (
    <ModalShell
      labelId="appearance-designer-title"
      className="appearance-dialog"
      initialFocus={closeButton}
      closeDisabled={Boolean(busy)}
      onClose={() => void close()}
    >
      <header className="appearance-header">
        <div>
          <p className="eyebrow">Quartz 本地设计器</p>
          <h2 id="appearance-designer-title">外观设置</h2>
        </div>
        <div className="appearance-header-state">
          {dirty ? <span>有未应用的更改</span> : null}
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label="关闭外观设置"
            disabled={Boolean(busy)}
            onClick={() => void close()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      {externalError ? (
        <div className="appearance-state" role="alert">
          {externalError}
        </div>
      ) : null}
      {loadState.kind === "loading" ? (
        <div className="appearance-state" role="status">
          正在读取外观设置…
        </div>
      ) : null}
      {loadState.kind === "error" ? (
        <div className="appearance-state" role="alert">
          {loadState.message}
        </div>
      ) : null}
      {snapshot && !snapshot.supported ? (
        <div className="appearance-state" role="alert">
          <strong>{snapshot.framework.toUpperCase()} 暂不支持外观编辑</strong>
          <span>{snapshot.message ?? "此外观适配器尚未安装。"}</span>
        </div>
      ) : null}
      {snapshot?.supported && draft ? (
        <div className="appearance-body">
          <AppearanceControls
            settings={draft}
            disabled={Boolean(busy)}
            onChange={(settings) => {
              setNotice(undefined)
              setDraft(settings)
            }}
            onChooseBackground={() => void chooseBackground()}
            onPreviewTargetChange={setPreviewTarget}
          />
          <AppearancePreview
            previewUrl={sessionPreviewUrl}
            state={previewState}
            previewTarget={previewTarget}
            pageWidthPx={draft.layout.pageWidthPx}
          />
        </div>
      ) : null}

      {snapshot?.supported ? (
        <footer className="appearance-actions">
          <div className="appearance-actions-copy">
            {invalidMessage ? (
              <span className="form-error" role="alert">
                {invalidMessage}
              </span>
            ) : notice ? (
              <span
                className={notice.kind === "error" ? "form-error" : "appearance-success"}
                role={notice.kind === "error" ? "alert" : "status"}
              >
                {notice.message}
              </span>
            ) : (
              <small>应用只更新本地博客，不会自动发布线上站点。</small>
            )}
          </div>
          <div className="appearance-actions-left">
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() => {
                setNotice(undefined)
                setDraft(cloneAppearancePreset("knowledge-garden"))
              }}
            >
              <RotateCcw size={15} aria-hidden="true" />
              恢复默认
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(busy) || !snapshot.canUndo}
              onClick={() => void undo()}
            >
              <Undo2 size={15} aria-hidden="true" />
              {busy === "undo" ? "正在撤销…" : "撤销上次应用"}
            </button>
          </div>
          <div className="appearance-actions-right">
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() => void close()}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                Boolean(busy) ||
                !dirty ||
                !validation?.success ||
                !activePreviewUrl ||
                previewState === "error"
              }
              onClick={() => void apply()}
            >
              {busy === "apply" ? "正在应用…" : "一键应用"}
            </button>
          </div>
        </footer>
      ) : null}
    </ModalShell>
  )
}
