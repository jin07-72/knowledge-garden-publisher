import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BlogManager, type BlogImportUiState } from "../../src/renderer/src/components/BlogManager"
import { BlogSwitcher } from "../../src/renderer/src/components/BlogSwitcher"
import type { BlogRegistryView } from "../../src/shared/contracts"

const registry: BlogRegistryView = {
  version: 1,
  activeBlogId: "knowledge",
  blogs: [
    {
      id: "knowledge",
      name: "Knowledge Garden",
      path: String.raw`C:\Users\me\knowledge-garden`,
      canonicalPath: String.raw`C:\Users\me\knowledge-garden`,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastOpenedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "study",
      name: "Study Garden",
      path: String.raw`D:\Blogs\study`,
      canonicalPath: String.raw`D:\Blogs\study`,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastOpenedAt: "2026-10-01T00:00:00.000Z",
    },
  ],
}

function managerProps(importState: BlogImportUiState = { view: "list", busy: false }) {
  return {
    open: true,
    registry,
    importState,
    onClose: vi.fn(),
    onChooseLocal: vi.fn(),
    onAddLocal: vi.fn(),
    onClone: vi.fn(),
    onInstall: vi.fn(),
    onRename: vi.fn(),
    onOpenFolder: vi.fn(),
    onRemove: vi.fn(),
    onSwitch: vi.fn(),
  }
}

afterEach(() => cleanup())

describe("BlogSwitcher", () => {
  it("exposes an accessible radio menu, current marker, paths, and typed actions", async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    const onAddLocal = vi.fn()
    const onClone = vi.fn()
    const onManage = vi.fn()
    render(
      <BlogSwitcher
        registry={registry}
        disabled={false}
        onSwitch={onSwitch}
        onAddLocal={onAddLocal}
        onClone={onClone}
        onManage={onManage}
      />,
    )

    const trigger = screen.getByRole("button", { name: /切换博客：Knowledge Garden/ })
    expect(trigger).toHaveAttribute("aria-haspopup", "menu")
    expect(screen.getByText(String.raw`C:\Users\me\knowledge-garden`)).toBeVisible()
    await user.click(trigger)

    const menu = screen.getByRole("menu", { name: "选择博客" })
    expect(within(menu).getByRole("menuitemradio", { name: /Knowledge Garden/ })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(within(menu).getByText("当前")).toBeVisible()
    const study = within(menu).getByRole("menuitemradio", { name: /Study Garden/ })
    expect(study).toHaveAttribute("aria-checked", "false")
    expect(study).toHaveTextContent(String.raw`D:\Blogs\study`)
    await user.click(study)
    expect(onSwitch).toHaveBeenCalledWith("study")
    expect(screen.queryByRole("menu", { name: "选择博客" })).not.toBeInTheDocument()

    await user.click(trigger)
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "添加本地博客" }),
    )
    expect(onAddLocal).toHaveBeenCalledOnce()
    await user.click(trigger)
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "从 GitHub 下载" }),
    )
    expect(onClone).toHaveBeenCalledOnce()
    await user.click(trigger)
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "管理博客" }))
    expect(onManage).toHaveBeenCalledOnce()
  })

  it("supports keyboard opening and closes on Escape or outside interaction", async () => {
    const user = userEvent.setup()
    render(
      <BlogSwitcher
        registry={registry}
        disabled={false}
        onSwitch={vi.fn()}
        onAddLocal={vi.fn()}
        onClone={vi.fn()}
        onManage={vi.fn()}
      />,
    )
    const trigger = screen.getByRole("button", { name: /切换博客/ })
    trigger.focus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("menuitemradio", { name: /Knowledge Garden/ })).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("menuitemradio", { name: /Study Garden/ })).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it.each(["{Enter}", " "])(
    "opens exactly once with %s and closes naturally on Tab",
    async (key) => {
      const user = userEvent.setup()
      render(
        <>
          <BlogSwitcher
            registry={registry}
            disabled={false}
            onSwitch={vi.fn()}
            onAddLocal={vi.fn()}
            onClone={vi.fn()}
            onManage={vi.fn()}
          />
          <button type="button">后续控件</button>
        </>,
      )
      const trigger = screen.getByRole("button", { name: /切换博客/ })
      trigger.focus()
      await user.keyboard(key)
      expect(screen.getByRole("menu")).toBeInTheDocument()
      expect(trigger).toHaveAttribute("aria-expanded", "true")
      await user.tab()
      expect(screen.queryByRole("menu")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "后续控件" })).toHaveFocus()
    },
  )

  it("uses roving focus with Home, End, wrapping arrows, and Shift+Tab closure", async () => {
    const user = userEvent.setup()
    render(
      <BlogSwitcher
        registry={registry}
        disabled={false}
        onSwitch={vi.fn()}
        onAddLocal={vi.fn()}
        onClone={vi.fn()}
        onManage={vi.fn()}
      />,
    )
    const trigger = screen.getByRole("button", { name: /切换博客/ })
    trigger.focus()
    await user.keyboard("{ArrowDown}")
    const items = Array.from(
      screen.getByRole("menu").querySelectorAll<HTMLElement>("[role^='menuitem']"),
    )
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1)
    await user.keyboard("{End}")
    expect(screen.getByRole("menuitem", { name: "管理博客" })).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("menuitemradio", { name: /Knowledge Garden/ })).toHaveFocus()
    await user.keyboard("{ArrowUp}")
    expect(screen.getByRole("menuitem", { name: "管理博客" })).toHaveFocus()
    await user.keyboard("{Home}")
    expect(screen.getByRole("menuitemradio", { name: /Knowledge Garden/ })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("disables switching and actions while busy", async () => {
    render(
      <BlogSwitcher
        registry={registry}
        disabled
        onSwitch={vi.fn()}
        onAddLocal={vi.fn()}
        onClone={vi.fn()}
        onManage={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: /切换博客/ })).toBeDisabled()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })
})

describe("BlogManager", () => {
  it("lists blogs and emits switch, rename, folder, and non-destructive removal intents", async () => {
    const user = userEvent.setup()
    const props = managerProps()
    render(<BlogManager {...props} />)

    const dialog = screen.getByRole("dialog", { name: "管理博客" })
    const current = within(dialog).getByRole("article", { name: /Knowledge Garden/ })
    expect(current).toHaveTextContent("当前博客")
    expect(current).toHaveTextContent(String.raw`C:\Users\me\knowledge-garden`)
    expect(
      within(current).getByRole("button", { name: "从列表移除 Knowledge Garden" }),
    ).toBeDisabled()
    const study = within(dialog).getByRole("article", { name: /Study Garden/ })
    await user.click(within(study).getByRole("button", { name: "切换到 Study Garden" }))
    expect(props.onSwitch).toHaveBeenCalledWith("study")
    await user.click(within(study).getByRole("button", { name: "打开 Study Garden 文件夹" }))
    expect(props.onOpenFolder).toHaveBeenCalledWith("study")
    await user.click(within(study).getByRole("button", { name: "重命名 Study Garden" }))
    const input = within(study).getByRole("textbox", { name: "博客名称" })
    await user.clear(input)
    await user.type(input, "Study Notes")
    await user.click(within(study).getByRole("button", { name: "保存名称" }))
    expect(props.onRename).toHaveBeenCalledWith("study", "Study Notes")

    await user.click(within(study).getByRole("button", { name: "从列表移除 Study Garden" }))
    const confirmation = within(dialog).getByRole("alertdialog", {
      name: "确认移除 Study Garden",
    })
    expect(within(confirmation).getByText(/只会从应用列表中移除/)).toBeVisible()
    expect(within(dialog).getByText(/不会删除本地文件、Git 记录或 GitHub 仓库/)).toBeVisible()
    expect(within(confirmation).getByRole("button", { name: "取消" })).toHaveFocus()
    await user.click(within(confirmation).getByRole("button", { name: "取消" }))
    expect(within(study).getByRole("button", { name: "从列表移除 Study Garden" })).toHaveFocus()
    await user.click(within(study).getByRole("button", { name: "从列表移除 Study Garden" }))
    await user.click(within(dialog).getByRole("button", { name: "确认移除 Study Garden" }))
    expect(props.onRemove).toHaveBeenCalledWith("study")
  })

  it("shows a valid local candidate and emits an add intent", async () => {
    const user = userEvent.setup()
    const props = managerProps({
      view: "local",
      busy: false,
      localSelection: {
        path: String.raw`D:\Blogs\new-garden`,
        inspection: {
          valid: true,
          canonicalPath: String.raw`D:\Blogs\new-garden`,
          needsInstall: false,
        },
      },
    })
    render(<BlogManager {...props} />)
    expect(screen.getByText(String.raw`D:\Blogs\new-garden`)).toBeVisible()
    const name = screen.getByRole("textbox", { name: "显示名称" })
    await user.type(name, "New Garden")
    await user.click(screen.getByRole("button", { name: "添加此博客" }))
    expect(props.onAddLocal).toHaveBeenCalledWith({
      path: String.raw`D:\Blogs\new-garden`,
      name: "New Garden",
    })
  })

  it("resets local and clone drafts when candidates change or the manager reopens", async () => {
    const user = userEvent.setup()
    const props = managerProps({
      view: "local",
      busy: false,
      localSelection: {
        path: String.raw`D:\Blogs\one`,
        inspection: {
          valid: true,
          canonicalPath: String.raw`D:\Blogs\one`,
          needsInstall: false,
        },
      },
    })
    const view = render(<BlogManager {...props} />)
    await user.type(screen.getByRole("textbox", { name: "显示名称" }), "First draft")
    view.rerender(
      <BlogManager
        {...props}
        importState={{
          view: "local",
          busy: false,
          localSelection: {
            path: String.raw`D:\Blogs\two`,
            inspection: {
              valid: true,
              canonicalPath: String.raw`D:\Blogs\two`,
              needsInstall: false,
            },
          },
        }}
      />,
    )
    expect(screen.getByRole("textbox", { name: "显示名称" })).toHaveValue("")

    view.rerender(
      <BlogManager {...props} open={false} importState={{ view: "clone", busy: false }} />,
    )
    view.rerender(<BlogManager {...props} open importState={{ view: "clone", busy: false }} />)
    await user.type(screen.getByRole("textbox", { name: "GitHub 仓库地址" }), "draft")
    view.rerender(
      <BlogManager {...props} open={false} importState={{ view: "clone", busy: false }} />,
    )
    view.rerender(<BlogManager {...props} open importState={{ view: "clone", busy: false }} />)
    expect(screen.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveValue("")
  })

  it("offers dependency installation for an otherwise valid local candidate", async () => {
    const user = userEvent.setup()
    const props = managerProps({
      view: "local",
      busy: false,
      localSelection: {
        path: String.raw`D:\Blogs\needs-install`,
        inspection: {
          valid: true,
          canonicalPath: String.raw`D:\Blogs\needs-install`,
          needsInstall: true,
        },
      },
    })
    render(<BlogManager {...props} />)
    expect(screen.getByRole("status")).toHaveTextContent("需要安装依赖")
    await user.click(screen.getByRole("button", { name: "安装依赖" }))
    expect(props.onInstall).toHaveBeenCalledWith(String.raw`D:\Blogs\needs-install`)
  })

  it("recognizes duplicate local paths and switches to the existing blog", async () => {
    const user = userEvent.setup()
    const props = managerProps({
      view: "local",
      busy: false,
      localSelection: {
        path: String.raw`D:\Blogs\STUDY`,
        inspection: {
          valid: true,
          canonicalPath: String.raw`D:\Blogs\study`,
          needsInstall: false,
        },
      },
    })
    render(<BlogManager {...props} />)
    expect(screen.getByRole("status")).toHaveTextContent("已经添加")
    await user.click(screen.getByRole("button", { name: "切换到 Study Garden" }))
    expect(props.onSwitch).toHaveBeenCalledWith("study")
  })

  it("renders invalid candidate guidance", () => {
    const props = managerProps({
      view: "local",
      busy: false,
      localSelection: {
        path: String.raw`D:\Notes`,
        inspection: { valid: false, code: "QUARTZ_MISSING", message: "不是 Quartz 博客。" },
      },
    })
    render(<BlogManager {...props} />)
    expect(screen.getByRole("alert")).toHaveTextContent("不是 Quartz 博客。")
    expect(screen.queryByRole("button", { name: "添加此博客" })).not.toBeInTheDocument()
  })

  it("collects a GitHub clone request and reports progress and errors", async () => {
    const user = userEvent.setup()
    const props = managerProps({
      view: "clone",
      busy: false,
      progress: { phase: "installing", message: "正在安装依赖…" },
      error: "下载失败，目标目录已保留。",
    })
    render(<BlogManager {...props} />)
    await user.type(
      screen.getByRole("textbox", { name: "GitHub 仓库地址" }),
      "https://github.com/me/garden.git",
    )
    await user.type(screen.getByRole("textbox", { name: "保存位置" }), String.raw`D:\Blogs\garden`)
    await user.type(screen.getByRole("textbox", { name: /显示名称/ }), "Garden")
    expect(screen.getByRole("status", { name: "导入进度" })).toHaveTextContent("正在安装依赖")
    expect(screen.getByRole("alert")).toHaveTextContent("下载失败")
    await user.click(screen.getByRole("button", { name: "开始下载" }))
    expect(props.onClone).toHaveBeenCalledWith({
      url: "https://github.com/me/garden.git",
      destination: String.raw`D:\Blogs\garden`,
      name: "Garden",
    })
  })

  it("allows a GitHub clone request to use the repository name by leaving display name blank", async () => {
    const user = userEvent.setup()
    const props = managerProps({ view: "clone", busy: false })
    render(<BlogManager {...props} />)
    await user.type(
      screen.getByRole("textbox", { name: "GitHub 仓库地址" }),
      "https://github.com/me/learning-notes.git",
    )
    await user.type(
      screen.getByRole("textbox", { name: "保存位置" }),
      String.raw`D:\Blogs\learning-notes`,
    )

    const submit = screen.getByRole("button", { name: "开始下载" })
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(props.onClone).toHaveBeenCalledWith({
      url: "https://github.com/me/learning-notes.git",
      destination: String.raw`D:\Blogs\learning-notes`,
      name: "",
    })
  })

  it.each([
    ["cloning", "下载中", "正在下载…"],
    ["installing", "安装依赖", "正在安装依赖…"],
    ["validating", "检查中", "正在检查…"],
    ["complete", "完成", "导入完成。"],
  ] as const)("marks %s as the current import stage", (phase, label, message) => {
    const props = managerProps({
      view: "clone",
      busy: phase !== "complete",
      progress: { phase, message },
    })
    render(<BlogManager {...props} />)

    const progress = screen.getByRole("status", { name: "导入进度" })
    expect(progress).toHaveTextContent(message)
    const stages = within(progress).getAllByRole("listitem")
    const current = stages.find((stage) => stage.textContent === label)
    expect(current).toHaveAttribute("aria-current", "step")
    expect(current).toHaveAttribute("data-state", "current")
    expect(stages.filter((stage) => stage.hasAttribute("aria-current"))).toHaveLength(1)
  })

  it("disables mutating controls while an operation is busy", () => {
    const props = managerProps({ view: "list", busy: true })
    render(<BlogManager {...props} />)
    expect(screen.getByRole("button", { name: "添加本地博客" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "从 GitHub 下载" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "切换到 Study Garden" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "关闭博客管理" })).toBeDisabled()
    expect(screen.getByLabelText("博客操作进行中")).toHaveFocus()
  })
})
