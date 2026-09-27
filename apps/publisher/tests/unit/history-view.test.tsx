import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HistoryView } from "../../src/renderer/src/components/HistoryView"

afterEach(cleanup)

describe("HistoryView", () => {
  it("renders commits beside plain-language deployment states and safe links", async () => {
    const openExternal = vi.fn(async () => undefined)
    render(
      <HistoryView
        openExternal={openExternal}
        cancelHistory={vi.fn(async () => undefined)}
        loadHistory={vi.fn(async (_requestId: string) => ({
          commits: [
            {
              id: "a".repeat(40),
              authoredAt: "2026-09-27T10:00:00+08:00",
              subject: "发布 CSS Grid 笔记",
              author: "Ada",
            },
          ],
          deployments: {
            runs: [
              {
                id: "42",
                headSha: "a".repeat(40),
                startedAt: "2026-09-27T02:00:00Z",
                completedAt: "2026-09-27T02:02:00Z",
                status: "succeeded" as const,
                url: "https://github.com/octocat/garden/actions/runs/42",
              },
            ],
            actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
            liveSiteUrl: "https://octocat.github.io/garden/",
          },
        }))}
      />,
    )

    expect(await screen.findByText("发布 CSS Grid 笔记")).toBeVisible()
    expect(screen.getByText("已部署")).toBeVisible()
    expect(screen.getByText("aaaaaaa")).toBeVisible()
    expect(screen.getByRole("link", { name: "查看网站" })).toHaveAttribute(
      "href",
      "https://octocat.github.io/garden/",
    )
    expect(screen.getByRole("link", { name: "查看部署详情" })).toHaveAttribute(
      "href",
      "https://github.com/octocat/garden/actions/runs/42",
    )
    await userEvent.click(screen.getByRole("link", { name: "查看部署详情" }))
    expect(openExternal).toHaveBeenCalledWith("https://github.com/octocat/garden/actions/runs/42")
  })

  it("announces loading, shows fallback links, and supports retry", async () => {
    const loadHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        commits: [],
        deployments: {
          runs: [],
          actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
          liveSiteUrl: "https://octocat.github.io/garden/",
          unavailableMessage: "暂时无法读取部署状态，请通过下面的链接查看。",
        },
      })
    const user = userEvent.setup()
    render(
      <HistoryView
        loadHistory={loadHistory}
        cancelHistory={vi.fn(async () => undefined)}
        openExternal={vi.fn(async () => undefined)}
      />,
    )

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取发布历史")
    await user.click(screen.getByRole("button", { name: "重新读取" }))
    expect((await screen.findAllByText("还没有本地发布记录。")).length).toBeGreaterThan(0)
    expect(screen.getByRole("link", { name: "打开 GitHub Actions" })).toBeVisible()
  })

  it("shows a concise error when opening an external history link fails", async () => {
    render(
      <HistoryView
        loadHistory={vi.fn(async (_requestId: string) => ({
          commits: [],
          deployments: {
            runs: [],
            actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
            liveSiteUrl: "https://octocat.github.io/garden/",
          },
        }))}
        cancelHistory={vi.fn(async () => undefined)}
        openExternal={vi.fn(async () => Promise.reject(new Error("shell failed")))}
      />,
    )

    await userEvent.click(await screen.findByRole("link", { name: "打开 GitHub Actions" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("无法打开链接，请稍后重试。")
  })

  it("cancels its own deployment request when unmounted", async () => {
    const loadHistory = vi.fn((_requestId: string) => new Promise<never>(() => undefined))
    const cancelHistory = vi.fn(async () => undefined)
    const view = render(
      <HistoryView
        loadHistory={loadHistory}
        cancelHistory={cancelHistory}
        openExternal={vi.fn(async () => undefined)}
      />,
    )
    await waitFor(() => expect(loadHistory).toHaveBeenCalledOnce())
    const requestId = loadHistory.mock.calls[0]?.[0]

    view.unmount()

    expect(requestId).toMatch(/^history-/)
    expect(cancelHistory).toHaveBeenCalledWith(requestId)
  })
})
