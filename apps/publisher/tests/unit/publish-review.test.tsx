import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PublishReview } from "../../src/renderer/src/components/PublishReview"
import type { ChangeReview } from "../../src/shared/contracts"

const review: ChangeReview = {
  groups: [
    {
      id: "note:css-grid",
      label: "CSS Grid",
      kind: "modified",
      selection: "default",
      description: "公开文章已修改",
      paths: ["content/technology/css-grid.md", "content/_assets/css-grid/diagram.png"],
      attachments: [{ path: "content/_assets/css-grid/diagram.png", label: "diagram.png" }],
    },
    {
      id: "note:retired",
      label: "Retired",
      kind: "unpublish",
      selection: "default",
      description: "将从公开网站移除",
      paths: ["content/technology/retired.md"],
      attachments: [],
    },
    {
      id: "private:journal",
      label: "Journal",
      kind: "private",
      selection: "locked",
      description: "只保留在本机，不会发布",
      paths: [],
      attachments: [],
    },
    {
      id: "config:quartz",
      label: "配置修改",
      kind: "config",
      selection: "optional",
      description: "高级选项，默认不发布",
      paths: ["quartz.config.yaml", "package-lock.json"],
      attachments: [],
    },
  ],
}

afterEach(cleanup)

describe("PublishReview", () => {
  it("defaults public work on, locks private work, leaves config off, and counts attachments", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<PublishReview review={review} state="ready" onClose={onClose} onRefresh={vi.fn()} />)

    const dialog = screen.getByRole("dialog", { name: "检查并发布" })
    const publicBox = within(dialog).getByRole("checkbox", { name: /修改.*CSS Grid/ })
    const unpublishBox = within(dialog).getByRole("checkbox", { name: /下线.*Retired/ })
    const privateBox = within(dialog).getByRole("checkbox", { name: /私密.*Journal/ })
    const configBox = within(dialog).getByRole("checkbox", { name: /配置.*配置修改/ })
    expect(publicBox).toBeChecked()
    expect(unpublishBox).toBeChecked()
    expect(privateBox).toBeDisabled()
    expect(privateBox).not.toBeChecked()
    expect(configBox).not.toBeChecked()
    expect(within(dialog).getByRole("heading", { name: "高级选项" })).toBeVisible()
    expect(within(dialog).getByText("quartz.config.yaml")).toBeVisible()
    expect(within(dialog).getByText("package-lock.json")).toBeVisible()
    expect(within(dialog).getByText("将从公开网站移除")).toBeVisible()
    expect(within(dialog).getByText("diagram.png")).toBeVisible()
    expect(within(dialog).getByText("2 篇文章，1 个附件")).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "验证并发布" })).toBeDisabled()
    expect(within(dialog).getByText(/将在下一步开放/)).toBeVisible()

    await user.click(publicBox)
    expect(within(dialog).getByText("1 篇文章，0 个附件")).toBeVisible()
    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("focuses the close control, traps keyboard focus, and closes from the pointer", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<PublishReview review={review} state="ready" onClose={onClose} onRefresh={vi.fn()} />)
    const dialog = screen.getByRole("dialog", { name: "检查并发布" })
    const close = within(dialog).getByRole("button", { name: "关闭发布检查" })
    await waitFor(() => expect(close).toHaveFocus())
    await user.click(close)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("renders refreshable loading, error, blocked, and empty states without technical status text", async () => {
    const user = userEvent.setup()
    const refresh = vi.fn()
    const view = render(<PublishReview state="loading" onClose={vi.fn()} onRefresh={refresh} />)
    expect(screen.getByText("正在检查可发布内容…")).toBeVisible()

    view.rerender(
      <PublishReview state="error" error="无法检查变化" onClose={vi.fn()} onRefresh={refresh} />,
    )
    await user.click(screen.getByRole("button", { name: "重新检查" }))
    expect(refresh).toHaveBeenCalledOnce()

    view.rerender(
      <PublishReview
        state="ready"
        review={{ groups: [], blockedReason: "检测到内容冲突，请先解决后再发布。" }}
        onClose={vi.fn()}
        onRefresh={refresh}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("检测到内容冲突")
    expect(screen.getByText("当前没有可发布变化")).toBeVisible()
    expect(document.body).not.toHaveTextContent("porcelain")
  })
})
