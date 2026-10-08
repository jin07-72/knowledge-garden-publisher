import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DomainManager } from "../../src/renderer/src/components/DomainManager"
import type { DomainSummary, IpcResult } from "../../src/shared/contracts"
import { createGardenApi } from "../../src/preload/gardenApi"

const domains: readonly DomainSummary[] = [
  { slug: "technology", name: "技术", description: "", order: 1, publicNotes: 2, privateNotes: 1 },
  { slug: "empty", name: "空领域", description: "", order: 2, publicNotes: 0, privateNotes: 0 },
]

afterEach(() => cleanup())

describe("DomainManager", () => {
  it.each([
    ["create", "DOMAIN_ALREADY_EXISTS", "A domain with that name or path already exists."],
    ["rename", "DOMAIN_ALREADY_EXISTS", "A domain with that name or path already exists."],
    ["remove", "DOMAIN_NOT_EMPTY", "This domain is not empty and cannot be removed."],
    [
      "rename",
      "DOMAIN_ROLLBACK_UNCERTAIN",
      "The domain operation could not be safely recovered. Review the workspace before retrying.",
    ],
  ] as const)(
    "keeps %s open and displays the public %s rejection",
    async (operation, code, message) => {
      const user = userEvent.setup()
      const invoke = vi.fn(async () => ({ ok: false, error: { code, message } }))
      const api = createGardenApi({ invoke, on: vi.fn(), removeListener: vi.fn() })
      const unwrap = async (
        response: Promise<IpcResult<readonly DomainSummary[]>>,
      ): Promise<readonly DomainSummary[]> => {
        const result = await response
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }
      render(
        <DomainManager
          domains={domains}
          onClose={vi.fn()}
          onCreate={(request) => unwrap(api.domains.create(request))}
          onRename={(request) => unwrap(api.domains.rename(request))}
          onRemove={(request) => unwrap(api.domains.remove(request))}
        />,
      )
      if (operation === "create") {
        await user.click(screen.getByRole("button", { name: "新建领域" }))
        await user.type(screen.getByLabelText("显示名称"), "新领域")
        await user.type(screen.getByLabelText("英文路径"), "new-domain")
        await user.click(screen.getByRole("button", { name: "创建领域" }))
      } else if (operation === "rename") {
        await user.click(
          within(screen.getByRole("article", { name: "空领域" })).getByRole("button", {
            name: "重命名",
          }),
        )
        await user.clear(screen.getByLabelText("显示名称"))
        await user.type(screen.getByLabelText("显示名称"), "技术")
        await user.click(screen.getByRole("button", { name: "保存名称" }))
      } else {
        await user.click(
          within(screen.getByRole("article", { name: "空领域" })).getByRole("button", {
            name: "删除",
          }),
        )
        await user.click(screen.getByRole("button", { name: "确认删除" }))
      }
      expect(await screen.findByRole("alert")).toHaveTextContent(message)
      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "关闭" })).toBeEnabled()
      expect(invoke).toHaveBeenCalledOnce()
      if (operation !== "remove") {
        expect(screen.getByLabelText("显示名称")).toHaveValue(
          operation === "create" ? "新领域" : "技术",
        )
      } else {
        expect(screen.getByRole("button", { name: "确认删除" })).toBeEnabled()
      }
    },
  )

  it("creates a domain with trimmed values and returned list", async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn(async () => domains)
    render(
      <DomainManager
        domains={domains}
        onClose={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn(async () => domains)}
        onRemove={vi.fn(async () => domains)}
      />,
    )

    await user.click(screen.getByRole("button", { name: "新建领域" }))
    await user.type(screen.getByLabelText("显示名称"), " 新领域 ")
    await user.type(screen.getByLabelText("英文路径"), "new-domain")
    await user.click(screen.getByRole("button", { name: "创建领域" }))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: "新领域", slug: "new-domain" }),
    )
  })

  it("shows validation feedback without calling create", async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn(async () => domains)
    render(
      <DomainManager
        domains={domains}
        onClose={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn(async () => domains)}
        onRemove={vi.fn(async () => domains)}
      />,
    )
    await user.click(screen.getByRole("button", { name: "新建领域" }))
    await user.click(screen.getByRole("button", { name: "创建领域" }))
    expect(screen.getByRole("alert")).toHaveTextContent("显示名称不能为空")
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("rejects an invalid slug without calling create", async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn(async () => domains)
    render(
      <DomainManager
        domains={domains}
        onClose={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn(async () => domains)}
        onRemove={vi.fn(async () => domains)}
      />,
    )
    await user.click(screen.getByRole("button", { name: "新建领域" }))
    await user.type(screen.getByLabelText("显示名称"), "新领域")
    await user.type(screen.getByLabelText("英文路径"), "Content")
    await user.click(screen.getByRole("button", { name: "创建领域" }))
    expect(screen.getByRole("alert")).toHaveTextContent("只能使用小写")
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("renames without editing the immutable slug", async () => {
    const user = userEvent.setup()
    const onRename = vi.fn(async () => domains)
    render(
      <DomainManager
        domains={domains}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => domains)}
        onRename={onRename}
        onRemove={vi.fn(async () => domains)}
      />,
    )
    const card = screen.getByRole("article", { name: "技术" })
    await user.click(within(card).getByRole("button", { name: "重命名" }))
    expect(screen.getByLabelText("英文路径")).toHaveAttribute("readonly")
    await user.clear(screen.getByLabelText("显示名称"))
    await user.type(screen.getByLabelText("显示名称"), "工程")
    await user.click(screen.getByRole("button", { name: "保存名称" }))
    await waitFor(() => expect(onRename).toHaveBeenCalledWith({ slug: "technology", name: "工程" }))
  })

  it("requires confirmation for an empty domain and disables non-empty delete", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn(async () => domains)
    render(
      <DomainManager
        domains={domains}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => domains)}
        onRename={vi.fn(async () => domains)}
        onRemove={onRemove}
      />,
    )
    const nonEmpty = screen.getByRole("article", { name: "技术" })
    expect(within(nonEmpty).getByRole("button", { name: /删除/ })).toBeDisabled()
    const empty = screen.getByRole("article", { name: "空领域" })
    await user.click(
      within(screen.getByRole("article", { name: "空领域" })).getByRole("button", {
        name: /删除/,
      }),
    )
    expect(screen.getByText("确认删除领域？")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "取消" }))
    await waitFor(() =>
      expect(
        within(screen.getByRole("article", { name: "空领域" })).getByRole("button", {
          name: "重命名",
        }),
      ).toHaveFocus(),
    )
    await user.click(
      within(screen.getByRole("article", { name: "空领域" })).getByRole("button", {
        name: /删除/,
      }),
    )
    await user.click(screen.getByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith({ slug: "empty" }))
  })

  it("focuses an existing dialog control after removing the focused domain", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onRemove = vi.fn(async (_request: { readonly slug: string }) => [domains[0]!])
    function Harness(): React.JSX.Element {
      const [currentDomains, setCurrentDomains] = useState(domains)
      return (
        <DomainManager
          domains={currentDomains}
          onClose={onClose}
          onCreate={vi.fn(async () => currentDomains)}
          onRename={vi.fn(async () => currentDomains)}
          onRemove={async (request) => {
            const next = await onRemove(request)
            setCurrentDomains(next)
            return next
          }}
        />
      )
    }
    render(<Harness />)
    await user.click(
      within(screen.getByRole("article", { name: "空领域" })).getByRole("button", { name: "删除" }),
    )
    await user.click(screen.getByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith({ slug: "empty" }))
    await waitFor(() =>
      expect(
        within(screen.getByRole("article", { name: "技术" })).getByRole("button", {
          name: "重命名",
        }),
      ).toHaveFocus(),
    )
    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("closes on Escape while idle and restores focus to the opener", async () => {
    const user = userEvent.setup()
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            管理领域
          </button>
          {open ? (
            <DomainManager
              domains={domains}
              onClose={() => setOpen(false)}
              onCreate={vi.fn(async () => domains)}
              onRename={vi.fn(async () => domains)}
              onRemove={vi.fn(async () => domains)}
            />
          ) : null}
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole("button", { name: "管理领域" })
    await user.click(opener)
    screen.getByRole("button", { name: "关闭" }).focus()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it("keeps the form busy and shows a service failure", async () => {
    const user = userEvent.setup()
    let reject!: (reason: unknown) => void
    const onCreate = vi.fn(
      () =>
        new Promise<readonly DomainSummary[]>((_, fail) => {
          reject = fail
        }),
    )
    render(
      <DomainManager
        domains={domains}
        onClose={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn(async () => domains)}
        onRemove={vi.fn(async () => domains)}
      />,
    )
    await user.click(screen.getByRole("button", { name: "新建领域" }))
    await user.type(screen.getByLabelText("显示名称"), "新领域")
    await user.type(screen.getByLabelText("英文路径"), "new-domain")
    await user.click(screen.getByRole("button", { name: "创建领域" }))
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled()
    await user.keyboard("{Escape}")
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    reject(new Error("领域服务暂不可用"))
    expect(await screen.findByRole("alert")).toHaveTextContent("领域服务暂不可用")
    expect(screen.getByRole("button", { name: "关闭" })).toBeEnabled()
  })
})
