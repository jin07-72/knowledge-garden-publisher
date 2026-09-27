import { useCallback, useEffect, useState } from "react"
import { CircleAlert, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react"
import type { DeploymentHistory, DeploymentRun, GitCommit } from "../../../shared/contracts"

export interface HistorySnapshot {
  readonly commits: readonly GitCommit[]
  readonly deployments: DeploymentHistory
}

interface HistoryViewProps {
  readonly loadHistory: (requestId: string) => Promise<HistorySnapshot>
  readonly cancelHistory: (requestId: string) => Promise<void>
  readonly openExternal: (url: string) => Promise<void>
}

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly snapshot: HistorySnapshot }

const stateLabel: Record<DeploymentRun["status"], string> = {
  pending: "等待部署",
  running: "正在部署",
  succeeded: "已部署",
  failed: "部署失败",
  cancelled: "部署已取消",
}

let requestSequence = 0

function nextRequestId(): string {
  requestSequence += 1
  return `history-${Date.now().toString(36)}-${requestSequence.toString(36)}`
}

function dateLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function SafeLink({
  href,
  children,
  openExternal,
  onOpenError,
}: {
  readonly href: string
  readonly children: React.ReactNode
  readonly openExternal: (url: string) => Promise<void>
  readonly onOpenError: () => void
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        try {
          void openExternal(href).catch(() => onOpenError())
        } catch {
          onOpenError()
        }
      }}
    >
      {children}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  )
}

export function HistoryView({
  loadHistory,
  cancelHistory,
  openExternal,
}: HistoryViewProps): React.JSX.Element {
  const [state, setState] = useState<ViewState>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)
  const [linkError, setLinkError] = useState(false)
  const retry = useCallback(() => {
    setState({ kind: "loading" })
    setAttempt((current) => current + 1)
  }, [])

  useEffect(() => {
    let active = true
    const requestId = nextRequestId()
    setState({ kind: "loading" })
    void loadHistory(requestId).then(
      (snapshot) => {
        if (active) setState({ kind: "ready", snapshot })
      },
      () => {
        if (active) setState({ kind: "error" })
      },
    )
    return () => {
      active = false
      try {
        void cancelHistory(requestId).catch(() => undefined)
      } catch {
        // Unmount remains safe if cancellation transport is already unavailable.
      }
    }
  }, [attempt, cancelHistory, loadHistory])

  if (state.kind === "loading") {
    return (
      <div className="history-state" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={20} aria-hidden="true" />
        <strong>正在读取发布历史…</strong>
        <span>本地记录可以离线查看，部署状态可能需要一点时间。</span>
      </div>
    )
  }

  if (state.kind === "error") {
    return (
      <div className="history-state history-error" role="alert">
        <CircleAlert size={20} aria-hidden="true" />
        <strong>无法读取发布历史</strong>
        <span>本地仓库可能暂时不可用，请稍后重试。</span>
        <button type="button" onClick={retry}>
          <RefreshCw size={13} aria-hidden="true" />
          重新读取
        </button>
      </div>
    )
  }

  const { commits, deployments } = state.snapshot
  return (
    <section className="history-view" aria-label="发布历史">
      <header className="history-summary">
        <div>
          <strong>发布历史</strong>
          <span>
            {commits.length > 0 ? `${commits.length} 条本地记录` : "还没有本地发布记录。"}
          </span>
        </div>
        <button type="button" onClick={retry} aria-label="重新读取">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>

      {deployments.unavailableMessage ? (
        <div className="history-notice" role="status">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{deployments.unavailableMessage}</span>
        </div>
      ) : null}

      {linkError ? (
        <div className="history-notice history-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <span>无法打开链接，请稍后重试。</span>
        </div>
      ) : null}

      {commits.length > 0 ? (
        <ol className="history-list">
          {commits.map((commit) => {
            const deployment = deployments.runs.find((run) => run.headSha === commit.id)
            const status = deployment ? stateLabel[deployment.status] : "等待部署记录"
            return (
              <li key={commit.id} className="history-entry">
                <div className="history-entry-heading">
                  <strong>{commit.subject}</strong>
                  <time dateTime={commit.authoredAt}>{dateLabel(commit.authoredAt)}</time>
                </div>
                <dl>
                  <div>
                    <dt>Commit</dt>
                    <dd>
                      <code>{commit.id.slice(0, 7)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>GitHub Pages</dt>
                    <dd className={`deployment-${deployment?.status ?? "unknown"}`}>{status}</dd>
                  </div>
                </dl>
                <div className="history-links">
                  <SafeLink
                    href={deployments.liveSiteUrl}
                    openExternal={openExternal}
                    onOpenError={() => setLinkError(true)}
                  >
                    查看网站
                  </SafeLink>
                  {deployment?.url ? (
                    <SafeLink
                      href={deployment.url}
                      openExternal={openExternal}
                      onOpenError={() => setLinkError(true)}
                    >
                      查看部署详情
                    </SafeLink>
                  ) : (
                    <SafeLink
                      href={deployments.actionsUrl}
                      openExternal={openExternal}
                      onOpenError={() => setLinkError(true)}
                    >
                      打开 GitHub Actions
                    </SafeLink>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="history-empty">
          <strong>还没有本地发布记录。</strong>
          <span>完成第一次发布后，这里会显示对应的部署状态。</span>
        </div>
      )}

      <footer className="history-fallback-links">
        <SafeLink
          href={deployments.actionsUrl}
          openExternal={openExternal}
          onOpenError={() => setLinkError(true)}
        >
          打开 GitHub Actions
        </SafeLink>
        <SafeLink
          href={deployments.liveSiteUrl}
          openExternal={openExternal}
          onOpenError={() => setLinkError(true)}
        >
          打开线上网站
        </SafeLink>
      </footer>
    </section>
  )
}
