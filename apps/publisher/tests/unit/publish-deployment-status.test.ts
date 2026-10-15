import { describe, expect, it } from "vitest"
import type { DeploymentHistory, DeploymentRun, GitCommit } from "../../src/shared/contracts"
import { publishedDeploymentStatus } from "../../src/renderer/src/publishDeploymentStatus"

const latestCommit: GitCommit = {
  id: "a".repeat(40),
  authoredAt: "2026-10-14T10:00:00Z",
  subject: "Publish update",
}

const deployments: DeploymentHistory = {
  runs: [],
  actionsUrl: "https://github.com/example/garden/actions",
  liveSiteUrl: "https://example.com",
}

function run(
  status: DeploymentRun["status"],
  url = "https://github.com/example/garden/actions/runs/1",
): DeploymentRun {
  return {
    id: "run-1",
    headSha: latestCommit.id,
    startedAt: "2026-10-14T10:01:00Z",
    status,
    ...(url ? { url } : {}),
  }
}

describe("publishedDeploymentStatus", () => {
  it("maps a matching succeeded deployment to completed progress", () => {
    expect(
      publishedDeploymentStatus(latestCommit, { ...deployments, runs: [run("succeeded")] }),
    ).toEqual({
      progress: { phase: "complete", message: "发布成功，部署已完成。", percent: 100 },
      actionsUrl: "https://github.com/example/garden/actions/runs/1",
    })
  })

  it("maps a matching failed deployment to failed progress", () => {
    expect(
      publishedDeploymentStatus(latestCommit, { ...deployments, runs: [run("failed")] }),
    ).toEqual({
      progress: { phase: "failed", message: "发布已完成，但部署失败。", percent: 100 },
      actionsUrl: "https://github.com/example/garden/actions/runs/1",
    })
  })

  it("maps a matching cancelled deployment to failed progress", () => {
    expect(
      publishedDeploymentStatus(latestCommit, { ...deployments, runs: [run("cancelled")] }),
    ).toEqual({
      progress: { phase: "failed", message: "发布已完成，但部署已取消。", percent: 100 },
      actionsUrl: "https://github.com/example/garden/actions/runs/1",
    })
  })

  it.each([
    ["missing latest commit", undefined, deployments],
    [
      "mismatched head SHA",
      latestCommit,
      { ...deployments, runs: [{ ...run("succeeded"), headSha: "b".repeat(40) }] },
    ],
    ["matching pending", latestCommit, { ...deployments, runs: [run("pending")] }],
    ["matching running", latestCommit, { ...deployments, runs: [run("running")] }],
    [
      "running with an unavailable timeout",
      latestCommit,
      { ...deployments, unavailableMessage: "部署历史请求超时。", runs: [run("running")] },
    ],
  ])("uses uncertainty for %s", (_name, commit, history) => {
    expect(publishedDeploymentStatus(commit, history)).toEqual({
      progress: { phase: "complete", message: "发布成功，暂时无法确认部署状态。", percent: 100 },
      actionsUrl: deployments.actionsUrl,
    })
  })

  it("falls back to the actions URL when a matching terminal run has no URL", () => {
    expect(
      publishedDeploymentStatus(latestCommit, { ...deployments, runs: [run("succeeded", "")] }),
    ).toEqual({
      progress: { phase: "complete", message: "发布成功，部署已完成。", percent: 100 },
      actionsUrl: deployments.actionsUrl,
    })
  })
})
