import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { Lock, RefreshCw, X } from "lucide-react"
import type { ChangeGroup, ChangeKind, ChangeReview } from "../../../shared/contracts"
import { ModalShell } from "./ModalShell"

interface PublishReviewProps {
  readonly state: "loading" | "ready" | "error"
  readonly review?: ChangeReview
  readonly error?: string
  readonly onClose: () => void
  readonly onRefresh: () => void
}

const kindLabel: Record<ChangeKind, string> = {
  added: "新增",
  modified: "修改",
  unpublish: "下线",
  attachment: "附件",
  private: "私密",
  config: "配置",
}

function visiblePaths(group: ChangeGroup): readonly string[] {
  if (group.kind === "private" || group.kind === "attachment") return []
  return group.paths.filter((path) => !path.includes("/_assets/"))
}

export function PublishReview({
  state,
  review,
  error,
  onClose,
  onRefresh,
}: PublishReviewProps): React.JSX.Element {
  const closeButton = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    setSelected(
      new Set(
        review?.groups.filter((group) => group.selection === "default").map((group) => group.id),
      ),
    )
  }, [review])

  const counts = useMemo(() => {
    const chosen = review?.groups.filter((group) => selected.has(group.id)) ?? []
    return {
      notes: chosen.filter((group) => group.kind !== "attachment" && group.kind !== "config")
        .length,
      attachments: chosen.reduce((total, group) => total + group.attachments.length, 0),
    }
  }, [review, selected])

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <ModalShell
      labelId="publish-review-title"
      className="publish-review-dialog"
      initialFocus={closeButton}
      onClose={onClose}
    >
      <header className="publish-review-header">
        <div>
          <p className="eyebrow">发布前最后确认</p>
          <h2 id="publish-review-title">检查并发布</h2>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="关闭发布检查"
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="publish-review-body">
        {state === "loading" ? <p className="review-state">正在检查可发布内容…</p> : null}
        {state === "error" ? (
          <div className="review-state review-error" role="alert">
            <strong>暂时无法检查发布内容</strong>
            <span>{error ?? "请稍后重试。"}</span>
            <button type="button" className="secondary-button" onClick={onRefresh}>
              <RefreshCw size={14} aria-hidden="true" /> 重新检查
            </button>
          </div>
        ) : null}
        {state === "ready" && review?.blockedReason ? (
          <div className="review-blocked" role="alert">
            {review.blockedReason}
          </div>
        ) : null}
        {state === "ready" && (review?.groups.length ?? 0) === 0 ? (
          <div className="review-state">
            <strong>当前没有可发布变化</strong>
            <span>继续写作即可，需要时再回来检查。</span>
            <button type="button" className="secondary-button" onClick={onRefresh}>
              <RefreshCw size={14} aria-hidden="true" /> 重新检查
            </button>
          </div>
        ) : null}
        {state === "ready" && review && review.groups.length > 0 ? (
          <div className="change-groups" aria-label="可发布内容">
            {review.groups.map((group, index) => {
              const locked = group.selection === "locked"
              const paths = visiblePaths(group)
              return (
                <Fragment key={group.id}>
                  {group.kind === "config" &&
                  !review.groups.slice(0, index).some((item) => item.kind === "config") ? (
                    <h3 className="advanced-heading">高级选项</h3>
                  ) : null}
                  <section className={`change-group change-${group.kind}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!locked && selected.has(group.id)}
                        disabled={locked}
                        onChange={() => toggle(group.id)}
                        aria-label={`${kindLabel[group.kind]}：${group.label}`}
                      />
                      <span className="change-copy">
                        <strong>
                          <span className="change-kind">{kindLabel[group.kind]}</span>：
                          {group.label}
                        </strong>
                        <small>{group.description}</small>
                        {paths.map((path) => (
                          <code key={path}>{path}</code>
                        ))}
                      </span>
                      {locked ? <Lock size={15} aria-label="已锁定" /> : null}
                    </label>
                    {group.attachments.length > 0 ? (
                      <ul className="attachment-tree" aria-label={`${group.label} 的附件`}>
                        {group.attachments.map((attachment) => (
                          <li key={attachment.path}>{attachment.label}</li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                </Fragment>
              )
            })}
          </div>
        ) : null}
      </div>

      <footer className="publish-review-footer">
        <div>
          <strong>
            {counts.notes} 篇文章，{counts.attachments} 个附件
          </strong>
          <small id="publish-step-note">
            验证并发布将在下一步开放；此处只确认选择，不会开始发布。
          </small>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled
          aria-describedby="publish-step-note"
        >
          验证并发布
        </button>
      </footer>
    </ModalShell>
  )
}
