import { useEffect, useRef, useState } from "react"
import { Monitor, RefreshCw, TriangleAlert } from "lucide-react"
import type { NoteSummary, PreviewStatus } from "../../../shared/contracts"
import { HistoryView, type HistorySnapshot } from "./HistoryView"
import { LocalNotePreview } from "./PrivateNotePreview"
import {
  revealPreviewSelection,
  type PreviewNavigationRequest,
  type PreviewNavigationResult,
} from "../previewNavigation"

type PreviewTab = "note" | "site" | "public" | "history"

interface PreviewPaneProps {
  readonly note?: NoteSummary
  readonly markdown?: string
  readonly preview: PreviewStatus
  readonly publicWebsiteUrl?: string
  readonly onLoadHistory: (requestId: string) => Promise<HistorySnapshot>
  readonly onCancelHistory: (requestId: string) => Promise<void>
  readonly onOpenHistoryLink: (url: string) => Promise<void>
  readonly onClearPublicCache: () => Promise<void>
  readonly navigation?: PreviewNavigationRequest
  readonly onNavigationResult?: (requestId: number, result: PreviewNavigationResult) => void
  readonly onRevealExactPreview?: (
    request: PreviewNavigationRequest,
    url: string,
  ) => Promise<PreviewNavigationResult>
}

export function PreviewPane({
  note,
  markdown,
  preview,
  publicWebsiteUrl,
  onLoadHistory,
  onCancelHistory,
  onOpenHistoryLink,
  onClearPublicCache,
  navigation,
  onNavigationResult,
  onRevealExactPreview,
}: PreviewPaneProps): React.JSX.Element {
  const [tab, setTab] = useState<PreviewTab>("note")
  const [exactPreviewLoad, setExactPreviewLoad] = useState(0)
  const fallbackArticle = useRef<HTMLElement>(null)
  const latestNavigationId = useRef<number | undefined>(undefined)
  const navigationCleanup = useRef<(() => void) | undefined>(undefined)
  const navigationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retriedExactNavigationId = useRef<number | undefined>(undefined)
  const [publicRefresh, setPublicRefresh] = useState(() => Date.now().toString(36))
  const refreshPublicSite = (): void => {
    if (!publicWebsiteUrl) return
    void onClearPublicCache()
      .catch(() => undefined)
      .then(() => setPublicRefresh(Date.now().toString(36)))
  }
  const publicUrl = (() => {
    if (!publicWebsiteUrl) return undefined
    try {
      const url = new URL(publicWebsiteUrl)
      url.searchParams.set("refresh", publicRefresh)
      return url.toString()
    } catch {
      return undefined
    }
  })()
  const baseUrl =
    preview.state === "ready" || preview.state === "building"
      ? (preview.url ?? preview.lastSuccessfulUrl)
      : undefined
  const noteUrl = (() => {
    if (!note || !baseUrl) return undefined
    try {
      const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
      return new URL(
        `${encodeURIComponent(note.domain)}/${encodeURIComponent(note.slug)}`,
        base,
      ).toString()
    } catch {
      return undefined
    }
  })()

  useEffect(() => {
    if (!navigation) return
    latestNavigationId.current = navigation.id
    retriedExactNavigationId.current = undefined
    setTab("note")
  }, [navigation])

  useEffect(() => {
    if (!navigation || tab !== "note" || navigation.documentPath !== note?.path) return
    let active = true
    navigationCleanup.current?.()
    navigationCleanup.current = undefined
    if (navigationTimer.current) clearTimeout(navigationTimer.current)
    navigationTimer.current = undefined

    const report = (result: PreviewNavigationResult): void => {
      if (!active || latestNavigationId.current !== navigation.id) return
      onNavigationResult?.(navigation.id, result)
    }

    if (noteUrl) {
      if (!onRevealExactPreview) report("not-ready")
      else {
        void onRevealExactPreview(navigation, noteUrl).then(report, () => report("not-ready"))
      }
    } else if (fallbackArticle.current) {
      const outcome = revealPreviewSelection(fallbackArticle.current, navigation)
      navigationCleanup.current = outcome.cleanup
      report(outcome.result)
      if (outcome.cleanup) {
        navigationTimer.current = setTimeout(() => {
          outcome.cleanup?.()
          if (navigationCleanup.current === outcome.cleanup) navigationCleanup.current = undefined
          navigationTimer.current = undefined
        }, 2_000)
      }
    } else report("not-ready")

    return () => {
      active = false
    }
  }, [
    exactPreviewLoad,
    navigation,
    note?.path,
    noteUrl,
    onNavigationResult,
    onRevealExactPreview,
    tab,
  ])

  useEffect(
    () => () => {
      navigationCleanup.current?.()
      if (navigationTimer.current) clearTimeout(navigationTimer.current)
    },
    [],
  )

  const tabs: readonly { id: PreviewTab; label: string }[] = [
    { id: "note", label: "当前笔记" },
    { id: "site", label: "全站本地" },
    { id: "public", label: "线上公开站" },
    { id: "history", label: "历史" },
  ]

  return (
    <section className="preview-pane pane" aria-label="本地预览" role="region">
      <header className="preview-header">
        <div>
          <span className="eyebrow">本地 Markdown</span>
          <h2>当前笔记预览</h2>
        </div>
        <span className={`preview-chip preview-${preview.state}`}>
          {preview.state === "ready" ? "实时" : preview.state === "building" ? "重建中" : "状态"}
        </span>
      </header>
      <div className="preview-tabs" role="tablist" aria-label="预览目标">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`preview-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`preview-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => {
              if (item.id === "public" && publicUrl) refreshPublicSite()
              setTab(item.id)
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
              event.preventDefault()
              const current = tabs.findIndex((candidate) => candidate.id === tab)
              const next =
                tabs[(current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
              setTab(next.id)
              document.getElementById(`preview-tab-${next.id}`)?.focus()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="preview-canvas"
        id={`preview-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`preview-tab-${tab}`}
      >
        {(tab === "note" || tab === "site") && preview.state === "building" ? (
          <div className="preview-banner preview-building" role="status">
            正在重建；当前显示上次成功版本。
          </div>
        ) : null}
        {tab === "site" && preview.state === "error" ? (
          <div className="preview-banner" role="alert">
            <TriangleAlert size={16} />
            {preview.error?.message ?? "Quartz 预览暂时不可用。"}
          </div>
        ) : null}
        {tab === "note" && note && noteUrl ? (
          <div className="local-note-preview-shell" aria-label={`${note.title}的本地预览`}>
            {note.visibility === "private" ? (
              <div className="local-note-preview-banner">
                <strong>私密笔记不会映射到公开网址</strong>
                <span>仅在这台电脑上预览，不会发布。</span>
              </div>
            ) : null}
            <iframe
              title={`${note.title}的 Quartz 精确预览`}
              src={noteUrl}
              sandbox="allow-same-origin allow-scripts"
              onLoad={() => {
                if (
                  navigation &&
                  latestNavigationId.current === navigation.id &&
                  retriedExactNavigationId.current !== navigation.id
                ) {
                  retriedExactNavigationId.current = navigation.id
                  setExactPreviewLoad((current) => current + 1)
                }
              }}
            />
          </div>
        ) : null}
        {tab === "note" && note && !noteUrl ? (
          <div className="local-note-preview-shell" aria-label={`${note.title}的备用预览`}>
            <div className="local-note-preview-banner local-note-preview-fallback">
              <strong>Quartz 暂不可用，当前显示简化预览</strong>
              <span>本地预览恢复后会自动显示博客的完整样式。</span>
            </div>
            <LocalNotePreview
              markdown={markdown}
              title={note.title}
              privateNote={note.visibility === "private"}
              articleRef={fallbackArticle}
            />
          </div>
        ) : null}
        {tab === "note" && !note ? (
          <div className="empty-state">
            <Monitor size={28} />
            <strong>等待本地预览</strong>
            <span>选择笔记后，这里显示当前本地 Markdown 内容。</span>
          </div>
        ) : null}
        {tab === "site" && baseUrl ? (
          <iframe
            title="Quartz 本地全站预览"
            src={baseUrl}
            sandbox="allow-same-origin allow-scripts"
          />
        ) : null}
        {tab === "site" && !baseUrl ? (
          <div className="empty-state">
            <strong>本地全站尚未就绪</strong>
          </div>
        ) : null}
        {tab === "public" && publicUrl ? (
          <div className="local-note-preview-shell">
            <div className="public-preview-notice">
              <TriangleAlert size={16} aria-hidden="true" />
              <div className="public-preview-notice-copy">
                <strong>线上内容可能受浏览器缓存影响</strong>
                <span>如果刚完成发布，请刷新后再检查。</span>
              </div>
              <button className="public-preview-refresh" type="button" onClick={refreshPublicSite}>
                <RefreshCw size={14} aria-hidden="true" />
                刷新线上站
              </button>
            </div>
            <iframe
              key={publicRefresh}
              title="线上公开站"
              src={publicUrl}
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        ) : null}
        {tab === "public" && !publicUrl ? (
          <div className="empty-state">
            <Monitor size={28} />
            <strong>请在管理博客中配置网站地址</strong>
            <span>配置后，这里会显示当前博客的线上公开站。</span>
          </div>
        ) : null}
        {tab === "history" ? (
          <HistoryView
            loadHistory={onLoadHistory}
            cancelHistory={onCancelHistory}
            openExternal={onOpenHistoryLink}
          />
        ) : null}
      </div>
    </section>
  )
}
