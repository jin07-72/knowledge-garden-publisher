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
      repository: {
        display: "https://github.com/me/knowledge",
        url: "https://github.com/me/knowledge",
      },
      website: { source: "quartz", url: "https://knowledge.example.com/" },
    },
    {
      id: "study",
      name: "Study Garden",
      path: String.raw`D:\Blogs\study`,
      canonicalPath: String.raw`D:\Blogs\study`,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastOpenedAt: "2026-10-01T00:00:00.000Z",
      repository: { display: "git@private.example.com:me/study.git" },
      website: { source: "unconfigured" },
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
    onOpenLink: vi.fn(),
    onUpdateWebsite: vi.fn(),
    onRemove: vi.fn(),
    onSwitch: vi.fn(),
  }
}

afterEach(() => cleanup())

function switcherProps() {
  return {
    registry,
    disabled: false,
    onSwitch: vi.fn(),
    onOpenLink: vi.fn(),
    onAddLocal: vi.fn(),
    onClone: vi.fn(),
    onManage: vi.fn(),
  }
}

describe("BlogSwitcher", () => {
  it("keeps all mutually exclusive radio choices in the same menu scope", async () => {
    const user = userEvent.setup()
    render(<BlogSwitcher {...switcherProps()} />)
    await user.click(screen.getByRole("button", { name: /切换博客/ }))
    const menu = screen.getByRole("menu")
    const choices = within(menu).getAllByRole("menuitemradio")
    expect(choices).toHaveLength(registry.blogs.length)
    for (const choice of choices) {
      expect(choice.closest('[role="group"], [role="radiogroup"], [role="menu"]')).toBe(menu)
    }
  })

  it("describes switch and link buttons with full addresses and unique stable value IDs", async () => {
    const user = userEvent.setup()
    const props = switcherProps()
    const view = render(<BlogSwitcher {...props} />)
    const trigger = screen.getByRole("button", { name: /切换博客/ })
    const configuredDescription = `${registry.blogs[0].repository.display} https://knowledge.example.com/ ${registry.blogs[0].path}`
    expect(trigger).toHaveAccessibleDescription(configuredDescription)
    const topRepo = screen.getByRole("button", { name: "打开 Knowledge Garden 的仓库" })
    const topSite = screen.getByRole("button", { name: "打开 Knowledge Garden 的网站" })
    expect(topRepo).toHaveAccessibleDescription(registry.blogs[0].repository.display)
    expect(topSite).toHaveAccessibleDescription("https://knowledge.example.com/")
    const originalDescriptionIds = trigger.getAttribute("aria-describedby")
    await user.click(trigger)
    const menu = screen.getByRole("menu")
    expect(
      within(menu).getByRole("menuitemradio", { name: /Knowledge Garden/ }),
    ).toHaveAccessibleDescription(configuredDescription)
    expect(
      within(menu).getByRole("menuitemradio", { name: /Study Garden/ }),
    ).toHaveAccessibleDescription(
      `${registry.blogs[1].repository.display} 未配置网站 ${registry.blogs[1].path}`,
    )
    const menuRepo = within(menu).getByRole("menuitem", { name: "打开 Knowledge Garden 的仓库" })
    const menuSite = within(menu).getByRole("menuitem", { name: "打开 Knowledge Garden 的网站" })
    for (const [button, value] of [
      [topRepo, registry.blogs[0].repository.display],
      [topSite, "https://knowledge.example.com/"],
      [menuRepo, registry.blogs[0].repository.display],
      [menuSite, "https://knowledge.example.com/"],
    ] as const) {
      expect(button).toHaveAccessibleDescription(value)
      const valueNode = document.getElementById(button.getAttribute("aria-describedby")!)
      expect(valueNode?.tagName).toBe("DD")
      expect(valueNode).toHaveTextContent(value)
    }
    const valueIds = Array.from(document.querySelectorAll("dd[id]"), (node) => node.id)
    expect(valueIds).toHaveLength(9)
    expect(new Set(valueIds).size).toBe(valueIds.length)
    view.rerender(<BlogSwitcher {...props} />)
    expect(trigger).toHaveAttribute("aria-describedby", originalDescriptionIds)
    expect(Array.from(document.querySelectorAll("dd[id]"), (node) => node.id)).toEqual(valueIds)
  })

  it("opens the inactive blog's repository and website without switching", async () => {
    const user = userEvent.setup()
    const props = switcherProps()
    const configured: BlogRegistryView = {
      ...registry,
      blogs: [
        registry.blogs[0],
        {
          ...registry.blogs[1],
          repository: {
            display: "https://github.com/me/study",
            url: "https://github.com/me/study",
          },
          website: { source: "manual", url: "https://study.example.com/" },
        },
      ],
    }
    render(<BlogSwitcher {...props} registry={configured} />)
    for (const [kind, label] of [
      ["repository", "仓库"],
      ["website", "网站"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: /切换博客/ }))
      await user.click(
        within(screen.getByRole("menu")).getByRole("menuitem", {
          name: `打开 Study Garden 的${label}`,
        }),
      )
      expect(props.onOpenLink).toHaveBeenLastCalledWith("study", kind)
      expect(screen.queryByRole("menu")).toBeNull()
    }
    expect(props.onOpenLink).toHaveBeenCalledTimes(2)
    expect(props.onSwitch).not.toHaveBeenCalled()
  })

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
        onOpenLink={vi.fn()}
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
    expect(within(menu).getByText(String.raw`D:\Blogs\study`)).toBeVisible()
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
        onOpenLink={vi.fn()}
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
    expect(screen.getByRole("menuitem", { name: "打开 Knowledge Garden 的仓库" })).toHaveFocus()
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
            onOpenLink={vi.fn()}
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
        onOpenLink={vi.fn()}
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
        onOpenLink={vi.fn()}
        onAddLocal={vi.fn()}
        onClone={vi.fn()}
        onManage={vi.fn()}
      />,
    )
    const trigger = screen.getByRole("button", { name: /切换博客/ })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("shows three labelled address rows and full values in the summary and every menu blog", async () => {
    const user = userEvent.setup()
    render(<BlogSwitcher {...switcherProps()} />)
    for (const label of ["仓库", "网站", "本地"]) {
      expect(screen.getByText(label, { exact: true })).toBeVisible()
    }
    for (const value of [
      registry.blogs[0].repository.display,
      "https://knowledge.example.com/",
      registry.blogs[0].path,
    ]) {
      expect(screen.getByTitle(value)).toHaveTextContent(value)
    }
    expect(screen.getByRole("button", { name: "打开 Knowledge Garden 的仓库" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "打开 Knowledge Garden 的网站" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: /切换博客/ }))
    const menu = screen.getByRole("menu")
    for (const label of ["仓库", "网站", "本地"]) {
      expect(within(menu).getAllByText(label, { exact: true })).toHaveLength(2)
    }
    for (const blog of registry.blogs) {
      expect(within(menu).getByTitle(blog.repository.display)).toHaveTextContent(
        blog.repository.display,
      )
      expect(within(menu).getByTitle(blog.path)).toHaveTextContent(blog.path)
    }
    expect(within(menu).getByTitle("https://knowledge.example.com/")).toBeVisible()
    expect(within(menu).getByTitle("未配置网站")).toBeVisible()
    expect(within(menu).queryByRole("menuitem", { name: "打开 Study Garden 的仓库" })).toBeNull()
    expect(within(menu).queryByRole("menuitem", { name: "打开 Study Garden 的网站" })).toBeNull()
    expect(document.querySelector("button button, button a, a button")).toBeNull()
  })

  it.each(["manual", "quartz"] as const)(
    "opens %s website and repository by id and kind from summary and menu",
    async (source) => {
      const user = userEvent.setup()
      const props = switcherProps()
      const configured: BlogRegistryView = {
        ...registry,
        blogs: [{ ...registry.blogs[0], website: { source, url: "https://garden.example.com/" } }],
      }
      render(<BlogSwitcher {...props} registry={configured} />)
      for (const [kind, label] of [
        ["repository", "仓库"],
        ["website", "网站"],
      ] as const) {
        await user.click(screen.getByRole("button", { name: `打开 Knowledge Garden 的${label}` }))
        expect(props.onOpenLink).toHaveBeenLastCalledWith("knowledge", kind)
        await user.click(screen.getByRole("button", { name: /切换博客/ }))
        await user.click(
          within(screen.getByRole("menu")).getByRole("menuitem", {
            name: `打开 Knowledge Garden 的${label}`,
          }),
        )
        expect(props.onOpenLink).toHaveBeenLastCalledWith("knowledge", kind)
        expect(screen.queryByRole("menu")).toBeNull()
      }
      expect(props.onOpenLink).toHaveBeenCalledTimes(4)
      expect(props.onSwitch).not.toHaveBeenCalled()
      await user.click(screen.getByRole("button", { name: /切换博客/ }))
      await user.click(screen.getByRole("menuitemradio", { name: /Knowledge Garden/ }))
      expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith("knowledge")
      expect(props.onOpenLink).toHaveBeenCalledTimes(4)
      expect(props.onAddLocal).not.toHaveBeenCalled()
      expect(props.onClone).not.toHaveBeenCalled()
      expect(props.onManage).not.toHaveBeenCalled()
    },
  )

  it("includes available links in a contiguous roving sequence and opens upward at the end", async () => {
    const user = userEvent.setup()
    render(<BlogSwitcher {...switcherProps()} />)
    const trigger = screen.getByRole("button", { name: /切换博客/ })
    trigger.focus()
    await user.keyboard("{ArrowUp}")
    expect(screen.getByRole("menuitem", { name: "管理博客" })).toHaveFocus()
    await user.keyboard("{Home}")
    const menu = screen.getByRole("menu")
    const expected = [
      within(menu).getByRole("menuitemradio", { name: /Knowledge Garden/ }),
      within(menu).getByRole("menuitem", { name: "打开 Knowledge Garden 的仓库" }),
      within(menu).getByRole("menuitem", { name: "打开 Knowledge Garden 的网站" }),
      within(menu).getByRole("menuitemradio", { name: /Study Garden/ }),
      within(menu).getByRole("menuitem", { name: "添加本地博客" }),
      within(menu).getByRole("menuitem", { name: "从 GitHub 下载" }),
      within(menu).getByRole("menuitem", { name: "管理博客" }),
    ]
    expect(menu.querySelectorAll("[data-menu-index]")).toHaveLength(expected.length)
    for (const [index, item] of expected.entries()) {
      expect(item).toHaveAttribute("data-menu-index", String(index))
      expect(item).toHaveFocus()
      expect(expected.filter((button) => button.tabIndex === 0)).toEqual([item])
      await user.keyboard("{ArrowDown}")
    }
    expect(expected[0]).toHaveFocus()
    for (const item of [...expected].reverse()) {
      await user.keyboard("{ArrowUp}")
      expect(item).toHaveFocus()
    }
  })

  it("opens on the active switch action after preceding blogs with links", async () => {
    const user = userEvent.setup()
    render(<BlogSwitcher {...switcherProps()} registry={{ ...registry, activeBlogId: "study" }} />)
    await user.click(screen.getByRole("button", { name: /切换博客/ }))
    expect(screen.getByRole("menuitemradio", { name: /Study Garden/ })).toHaveFocus()
  })

  it("disables every address and menu action when busy, including keyboard dispatch", async () => {
    const user = userEvent.setup()
    const props = switcherProps()
    const view = render(<BlogSwitcher {...props} />)
    await user.click(screen.getByRole("button", { name: /切换博客/ }))
    const first = screen.getByRole("menuitemradio", { name: /Knowledge Garden/ })
    view.rerender(<BlogSwitcher {...props} disabled />)
    for (const button of document.querySelectorAll("button")) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    fireEvent.keyDown(first, { key: "Enter" })
    fireEvent.keyDown(first, { key: " " })
    fireEvent.keyDown(first, { key: "ArrowDown" })
    for (const callback of [
      props.onOpenLink,
      props.onSwitch,
      props.onAddLocal,
      props.onClone,
      props.onManage,
    ]) {
      expect(callback).not.toHaveBeenCalled()
    }
  })
})

describe("BlogManager", () => {
  it("shows all address rows with stable unique descriptions and opens only available links", async () => {
    const user = userEvent.setup()
    const props = managerProps()
    const view = render(<BlogManager {...props} />)
    for (const blog of registry.blogs) {
      const card = within(screen.getByRole("article", { name: new RegExp(blog.name) }))
      for (const label of ["仓库", "网站", "本地"]) expect(card.getByText(label)).toBeVisible()
      expect(card.getByTitle(blog.path)).toBeVisible()
      expect(card.getByTitle(blog.repository.display)).toBeVisible()
      expect(card.getByRole("button", { name: `编辑 ${blog.name} 的网站地址` })).toBeEnabled()
    }
    const ids = Array.from(document.querySelectorAll("dd[id]"), (node) => node.id)
    expect(new Set(ids).size).toBe(6)
    view.rerender(<BlogManager {...props} registry={{ ...registry }} />)
    expect(Array.from(document.querySelectorAll("dd[id]"), (node) => node.id)).toEqual(ids)
    for (const [kind, label, value] of [
      ["repository", "仓库", registry.blogs[0].repository.display],
      ["website", "网站", "https://knowledge.example.com/"],
    ] as const) {
      const button = screen.getByRole("button", { name: `打开 Knowledge Garden 的${label}` })
      expect(button).toHaveAccessibleDescription(value)
      await user.click(button)
      expect(props.onOpenLink).toHaveBeenLastCalledWith("knowledge", kind)
      expect(screen.queryByRole("button", { name: `打开 Study Garden 的${label}` })).toBeNull()
    }
  })

  it.each(["manual", "quartz", "unconfigured"] as const)(
    "initializes the %s editor accurately",
    async (source) => {
      const user = userEvent.setup()
      const website =
        source === "unconfigured" ? { source } : { source, url: "https://garden.example.com/" }
      render(
        <BlogManager
          {...managerProps()}
          registry={{ ...registry, blogs: [{ ...registry.blogs[0], website }] }}
        />,
      )
      await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
      expect(screen.getByRole("textbox", { name: "网站地址" })).toHaveValue(
        source === "manual" ? website.url : "",
      )
      if (source === "quartz")
        expect(screen.getByText("当前自动读取：https://garden.example.com/")).toBeVisible()
      if (source === "unconfigured") expect(screen.getByText(/尚未配置网站地址/)).toBeVisible()
    },
  )

  it("trims a submitted draft without normalizing and preserves it after failure", async () => {
    const user = userEvent.setup()
    const props = managerProps()
    const view = render(<BlogManager {...props} />)
    await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
    const input = screen.getByRole("textbox", { name: "网站地址" })
    await user.type(input, "  garden.example.com/path  ")
    await user.click(screen.getByRole("button", { name: "保存网站地址" }))
    expect(props.onUpdateWebsite).toHaveBeenCalledExactlyOnceWith(
      "knowledge",
      "garden.example.com/path",
    )
    expect(input).toHaveValue("  garden.example.com/path  ")
    view.rerender(<BlogManager {...props} importState={{ view: "list", busy: true }} />)
    view.rerender(
      <BlogManager
        {...props}
        importState={{ view: "list", busy: false, error: "网站地址无效。" }}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("网站地址无效。")
    expect(input).toHaveValue("  garden.example.com/path  ")
    // A later unrelated successful operation must not discard the failed draft.
    view.rerender(<BlogManager {...props} importState={{ view: "list", busy: true }} />)
    view.rerender(<BlogManager {...props} registry={{ ...registry }} />)
    expect(input).toHaveValue("  garden.example.com/path  ")
  })

  it.each([false, true])(
    "closes only after a successful busy cycle and registry refresh (same value: %s)",
    async (sameValue) => {
      const user = userEvent.setup()
      const props = managerProps()
      const manual: BlogRegistryView = {
        ...registry,
        blogs: [
          {
            ...registry.blogs[0],
            website: { source: "manual", url: "https://garden.example.com/" },
          },
        ],
      }
      const view = render(<BlogManager {...props} registry={manual} />)
      await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
      if (!sameValue) await user.clear(screen.getByRole("textbox", { name: "网站地址" }))
      await user.click(screen.getByRole("button", { name: "保存网站地址" }))
      expect(props.onUpdateWebsite).toHaveBeenCalledWith(
        "knowledge",
        sameValue ? "https://garden.example.com/" : null,
      )
      expect(screen.getByRole("textbox", { name: "网站地址" })).toBeVisible()
      view.rerender(
        <BlogManager {...props} registry={manual} importState={{ view: "list", busy: true }} />,
      )
      view.rerender(<BlogManager {...props} registry={manual} />)
      expect(screen.getByRole("textbox", { name: "网站地址" })).toBeVisible()
      view.rerender(<BlogManager {...props} registry={{ ...manual }} />)
      expect(screen.queryByRole("textbox", { name: "网站地址" })).toBeNull()
    },
  )

  it("allows one editor and restores the exact edit trigger on cancel", async () => {
    const user = userEvent.setup()
    const props = managerProps()
    render(<BlogManager {...props} />)
    await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
    const trigger = screen.getByRole("button", { name: "编辑 Study Garden 的网站地址" })
    await user.click(trigger)
    expect(screen.getAllByRole("textbox", { name: "网站地址" })).toHaveLength(1)
    expect(
      within(screen.getByRole("article", { name: /Study Garden/ })).getByRole("textbox", {
        name: "网站地址",
      }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "取消编辑网站地址" }))
    expect(screen.queryByRole("textbox", { name: "网站地址" })).toBeNull()
    expect(trigger).toHaveFocus()
    expect(props.onUpdateWebsite).not.toHaveBeenCalled()
  })

  it.each(["cancel", "save"] as const)(
    "restores the replacement website edit trigger after list remount and %s",
    async (completion) => {
      const user = userEvent.setup()
      const props = managerProps()
      const view = render(<BlogManager {...props} />)
      const original = screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" })
      await user.click(original)
      await user.click(screen.getByRole("button", { name: "从 GitHub 下载" }))
      expect(original.isConnected).toBe(false)
      await user.click(screen.getByRole("button", { name: "返回博客列表" }))
      const replacement = screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" })
      expect(replacement).not.toBe(original)
      expect(screen.getByRole("textbox", { name: "网站地址" })).toBeVisible()
      if (completion === "cancel") {
        await user.click(screen.getByRole("button", { name: "取消编辑网站地址" }))
        expect(props.onUpdateWebsite).not.toHaveBeenCalled()
      } else {
        await user.click(screen.getByRole("button", { name: "保存网站地址" }))
        view.rerender(<BlogManager {...props} importState={{ view: "list", busy: true }} />)
        view.rerender(<BlogManager {...props} registry={{ ...registry }} />)
      }
      expect(screen.queryByRole("textbox", { name: "网站地址" })).toBeNull()
      expect(replacement).toHaveFocus()
      expect(document.body).not.toHaveFocus()
    },
  )

  it("blocks address editing, open actions, and registry controls throughout busy operations", async () => {
    const user = userEvent.setup()
    const props = managerProps()
    const view = render(<BlogManager {...props} />)
    await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
    view.rerender(<BlogManager {...props} importState={{ view: "list", busy: true }} />)
    for (const button of document.querySelectorAll("button")) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    fireEvent.submit(screen.getByRole("textbox", { name: "网站地址" }).closest("form")!)
    for (const callback of [
      props.onUpdateWebsite,
      props.onOpenLink,
      props.onRename,
      props.onRemove,
      props.onSwitch,
      props.onChooseLocal,
      props.onOpenFolder,
      props.onClose,
    ])
      expect(callback).not.toHaveBeenCalled()
  })

  it("offers recovery relocation only for a valid non-duplicate candidate", async () => {
    const user = userEvent.setup()
    const onRelocate = vi.fn()
    const props = {
      ...managerProps({ view: "list", busy: false }),
      recoveryBlogId: "knowledge",
      onRelocate,
    }
    const view = render(<BlogManager {...props} />)
    await user.click(screen.getByRole("button", { name: "重新定位 Knowledge Garden" }))
    expect(props.onChooseLocal).toHaveBeenCalledOnce()

    view.rerender(
      <BlogManager
        {...props}
        importState={{
          view: "local",
          busy: false,
          localSelection: {
            path: String.raw`E:\Recovered\garden`,
            inspection: {
              valid: true,
              canonicalPath: String.raw`E:\Recovered\garden`,
              needsInstall: false,
            },
          },
        }}
      />,
    )
    await user.click(screen.getByRole("button", { name: "更新博客位置" }))
    expect(onRelocate).toHaveBeenCalledWith("knowledge", String.raw`E:\Recovered\garden`)

    view.rerender(
      <BlogManager
        {...props}
        importState={{
          view: "local",
          busy: false,
          localSelection: {
            path: registry.blogs[1].path,
            inspection: {
              valid: true,
              canonicalPath: registry.blogs[1].canonicalPath,
              needsInstall: false,
            },
          },
        }}
      />,
    )
    expect(screen.getByText(/已经添加为“Study Garden”/)).toBeVisible()
    expect(screen.queryByRole("button", { name: "更新博客位置" })).not.toBeInTheDocument()
  })

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

  it("cancels only the removal confirmation on Escape and restores its trigger", async () => {
    const user = userEvent.setup()
    const props = managerProps()
    render(<BlogManager {...props} />)
    const manager = screen.getByRole("dialog", { name: "管理博客" })
    const study = within(manager).getByRole("article", { name: /Study Garden/ })
    const remove = within(study).getByRole("button", { name: "从列表移除 Study Garden" })
    await user.click(remove)
    expect(
      within(manager).getByRole("alertdialog", { name: "确认移除 Study Garden" }),
    ).toBeVisible()

    await user.keyboard("{Escape}")

    expect(screen.getByRole("dialog", { name: "管理博客" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(within(study).getByRole("button", { name: "从列表移除 Study Garden" })).toHaveFocus()
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

  it("does not dispatch an already-filled clone form while busy", async () => {
    const user = userEvent.setup()
    const props = managerProps({ view: "clone", busy: false })
    const view = render(<BlogManager {...props} />)
    await user.type(
      screen.getByRole("textbox", { name: "GitHub 仓库地址" }),
      "https://github.com/me/garden",
    )
    await user.type(screen.getByRole("textbox", { name: "保存位置" }), "D:/Blogs/garden")
    view.rerender(<BlogManager {...props} importState={{ view: "clone", busy: true }} />)
    fireEvent.submit(screen.getByRole("textbox", { name: "保存位置" }).closest("form")!)
    expect(props.onClone).not.toHaveBeenCalled()
  })
})
