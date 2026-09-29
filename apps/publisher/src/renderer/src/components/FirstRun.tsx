import { AlertTriangle, CheckCircle2, RefreshCw, Wrench } from "lucide-react"
import type {
  WorkspaceInspection,
  WorkspaceIssue,
  WorkspaceRepairAction,
} from "../../../shared/contracts"

interface FirstRunProps {
  readonly inspection?: WorkspaceInspection
  readonly busy: boolean
  readonly error?: string
  readonly compact?: boolean
  readonly onRetry: () => void
  readonly onRepair: (action: WorkspaceRepairAction) => Promise<void>
}

const guidance: Partial<Record<WorkspaceIssue["code"], string>> = {
  INVALID_WORKSPACE: "请恢复固定的知识花园目录，然后重新检查。",
  GIT_UNAVAILABLE: "请从 git-scm.com 安装 Git，完成后重新启动应用。应用不会代替你安装 Git。",
  GIT_NOT_REPOSITORY:
    "请将此固定目录恢复为 Git 仓库（例如重新克隆仓库），不要在应用中初始化空仓库。",
  GIT_ROOT_MISMATCH: "请确保固定工作区就是 Git 仓库根目录，而不是仓库内的子目录。",
  GIT_ORIGIN_MISSING: "请在 Git 中配置名为 origin 的现有远程仓库；应用不会重写远程地址。",
  GIT_ORIGIN_FAILED: "请检查 origin 配置，并在 Git 中修复；应用不会改写远程地址。",
  GIT_ORIGIN_UNREACHABLE: "请检查网络连接，以及 origin/main 是否存在，然后重新检查。",
  GIT_FETCH_AUTH_FAILED:
    "请在 Windows 凭据管理器或 Git Credential Manager 中修复 GitHub 登录。应用不会索取或保存 GitHub token。",
  DEPENDENCIES_MISSING: "仓库依赖尚未安装。可用应用随附的 Node/npm 执行一次 npm ci。",
  DEPENDENCIES_INVALID: "已安装依赖与 package-lock.json 不一致。可重新执行 npm ci 恢复。",
  PREVIEW_PORT_UNAVAILABLE: "请关闭占用预览端口的程序，再重新检查。",
}

export function FirstRun({
  inspection,
  busy,
  error,
  compact = false,
  onRetry,
  onRepair,
}: FirstRunProps): React.JSX.Element {
  const issues = inspection?.ok === false ? inspection.issues : []
  const card = (
    <section className="first-run-card" role="region" aria-label="启动检查">
      <header>
        <span className="first-run-icon" aria-hidden="true">
          {inspection?.ok ? <CheckCircle2 /> : <Wrench />}
        </span>
        <div>
          <p className="eyebrow">Knowledge Garden Publisher</p>
          <h1>启动检查</h1>
        </div>
      </header>
      {!inspection ? <p role="status">正在检查固定工作区…</p> : null}
      {inspection?.ok ? <p role="status">工作区已准备好。</p> : null}
      {issues.length > 0 ? (
        <ul className="diagnostic-list">
          {issues.map((item, index) => (
            <li key={`${item.code}-${item.path ?? index}`}>
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>{item.message}</strong>
                <p>{guidance[item.code] ?? "请恢复所需仓库文件后重新检查。"}</p>
                {item.path ? <code>{item.path}</code> : null}
                {item.repair === "install-dependencies" ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void onRepair(item.repair!)}
                  >
                    安装仓库依赖
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="first-run-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="secondary-button" disabled={busy} onClick={onRetry}>
        <RefreshCw size={15} aria-hidden="true" />
        {busy ? "正在处理…" : "重新检查"}
      </button>
    </section>
  )
  return compact ? (
    <aside className="startup-diagnostics-banner">{card}</aside>
  ) : (
    <main className="first-run-shell">{card}</main>
  )
}
