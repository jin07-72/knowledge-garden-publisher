import type { DeploymentHistory, GitCommit, PublishProgress } from "../../shared/contracts"

export interface PublishedDeploymentStatus {
  readonly progress: PublishProgress
  readonly actionsUrl?: string
}

const uncertainMessage = "发布成功，暂时无法确认部署状态。"

export function publishedDeploymentStatus(
  latestCommit: GitCommit | undefined,
  deployments: DeploymentHistory,
): PublishedDeploymentStatus {
  const run = latestCommit
    ? deployments.runs.find((candidate) => candidate.headSha === latestCommit.id)
    : undefined

  if (run?.status === "succeeded") {
    return {
      progress: { phase: "complete", message: "发布成功，部署已完成。", percent: 100 },
      actionsUrl: run.url ?? deployments.actionsUrl,
    }
  }

  if (run?.status === "failed") {
    return {
      progress: { phase: "failed", message: "发布已完成，但部署失败。", percent: 100 },
      actionsUrl: run.url ?? deployments.actionsUrl,
    }
  }

  if (run?.status === "cancelled") {
    return {
      progress: { phase: "failed", message: "发布已完成，但部署已取消。", percent: 100 },
      actionsUrl: run.url ?? deployments.actionsUrl,
    }
  }

  return {
    progress: { phase: "complete", message: uncertainMessage, percent: 100 },
    actionsUrl: deployments.actionsUrl,
  }
}
