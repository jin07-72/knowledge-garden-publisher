import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../src/renderer/src/App"
import type {
  ChangeGroup,
  DeploymentRun,
  GardenApi,
  GitCommit,
  IpcResult,
  NoteDocument,
  NoteSummary,
  NoteTransactionReceipt,
  PreviewStatus,
  WorkspaceInspection,
} from "../../src/shared/contracts"

const notes: readonly NoteSummary[] = [
  {
    path: "content/technology/css-grid.md",
    domain: "technology",
    slug: "css-grid",
    title: "CSS Grid 布局",
    date: "2026-09-18",
    description: "三栏布局笔记",
    visibility: "public",
    updatedAt: "2026-09-24T08:00:00.000Z",
    tags: ["CSS"],
  },
  {
    path: "private/reading/private-notes.md",
    domain: "reading",
    slug: "private-notes",
    title: "私密阅读札记",
    date: "2026-09-17",
    description: "只留在本机",
    visibility: "private",
    updatedAt: "2026-09-23T08:00:00.000Z",
    tags: ["阅读"],
  },
]

const documents = new Map<string, NoteDocument>([
  [
    notes[0].path,
    {
      path: notes[0].path,
      markdown: "# CSS Grid 布局\n\n正文",
      mtimeMs: 1,
      contentHash: "public-hash",
    },
  ],
  [
    notes[1].path,
    {
      path: notes[1].path,
      markdown: "# 私密阅读札记\n\n正文",
      mtimeMs: 2,
      contentHash: "private-hash",
    },
  ],
])

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

function unavailable<T>(message: string): IpcResult<T> {
  return { ok: false, error: { code: "SERVICE_UNAVAILABLE", message } }
}

function createGardenMock(): GardenApi {
  const ready: PreviewStatus = {
    state: "ready",
    generation: 1,
    port: 8080,
    url: "http://127.0.0.1:8080/",
    lastSuccessfulUrl: "http://127.0.0.1:8080/",
  }

  return {
    workspace: {
      inspect: vi.fn(async () =>
        ok<WorkspaceInspection>({
          ok: true,
          root: String.raw`C:\Users\11546\Desktop\web`,
          capabilities: { files: true, preview: true, git: true, publish: false },
          issues: [],
        }),
      ),
    },
    notes: {
      list: vi.fn(async () => ok(notes)),
      read: vi.fn(async ({ path }) => ok(documents.get(path)!)),
      save: vi.fn(),
      create: vi.fn(async (request) =>
        ok({
          path: `${request.visibility === "public" ? "content" : "private"}/${request.domain}/${request.slug}.md`,
          updatedAt: "2026-09-24T09:00:00.000Z",
          mtimeMs: 3,
          contentHash: "new-hash",
        }),
      ),
      rename: vi.fn(),
      changeVisibility: vi.fn(async ({ path }) =>
        ok({ id: "visibility-1", changedPaths: [path], historyWarning: false, warnings: [] }),
      ),
      trash: vi.fn(),
    },
    preview: {
      start: vi.fn(async () => ok(ready)),
      stop: vi.fn(),
      status: vi.fn(async () => ok(ready)),
      onProgress: vi.fn(() => () => undefined),
    },
    changes: {
      list: vi.fn(async () => unavailable<readonly ChangeGroup[]>("变更服务将在后续任务中提供。")),
    },
    publish: {
      start: vi.fn(),
      cancel: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
    },
    history: {
      git: vi.fn(async () => unavailable<readonly GitCommit[]>("历史服务将在后续任务中提供。")),
      deployments: vi.fn(async () =>
        unavailable<readonly DeploymentRun[]>("部署历史将在后续任务中提供。"),
      ),
    },
  }
}

describe("publisher main layout", () => {
  let garden: GardenApi

  beforeEach(() => {
    garden = createGardenMock()
    Object.defineProperty(window, "garden", { configurable: true, value: garden })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("shows the approved panes, filters notes, and exposes the selected path", async () => {
    const user = userEvent.setup()
    render(<App />)

    const navigation = await screen.findByRole("navigation", { name: "笔记" })
    for (const domain of ["技术", "阅读", "语言", "生活"]) {
      expect(within(navigation).getByRole("button", { name: domain })).toBeVisible()
    }
    expect(within(navigation).getByRole("button", { name: "公开" })).toBeVisible()
    expect(within(navigation).getByRole("button", { name: "私密" })).toBeVisible()
    expect(screen.getByRole("region", { name: "Markdown 编辑器" })).toBeVisible()
    expect(screen.getByRole("region", { name: "本地预览" })).toBeVisible()
    expect(await screen.findByText("content/technology/css-grid.md")).toBeVisible()

    await user.click(within(navigation).getByRole("button", { name: "阅读" }))
    expect(screen.getByRole("button", { name: /私密阅读札记/ })).toBeVisible()
    expect(screen.queryByRole("button", { name: /CSS Grid 布局/ })).not.toBeInTheDocument()

    await user.click(within(navigation).getByRole("button", { name: "全部领域" }))
    await user.click(within(navigation).getByRole("button", { name: "公开" }))
    expect(screen.getByRole("button", { name: /CSS Grid 布局/ })).toBeVisible()
    expect(screen.queryByRole("button", { name: /私密阅读札记/ })).not.toBeInTheDocument()

    const search = within(navigation).getByRole("searchbox", { name: "搜索笔记" })
    await user.click(within(navigation).getByRole("button", { name: "全部可见性" }))
    await user.type(search, "私密")
    expect(screen.getByRole("button", { name: /私密阅读札记/ })).toBeVisible()
  })

  it("creates a note through the accessible new-note form", async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "新的生活笔记")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "今天的生活记录")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), "生活, 日记")
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "领域" }), "life")
    await user.click(within(dialog).getByRole("radio", { name: "私密" }))
    await user.click(within(dialog).getByRole("button", { name: "创建" }))

    await waitFor(() => {
      expect(garden.notes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "新的生活笔记",
          domain: "life",
          visibility: "private",
          slug: "new-note",
          description: "今天的生活记录",
          tags: ["生活", "日记"],
        }),
      )
    })
    expect(await screen.findByText("private/life/new-note.md")).toBeVisible()
  })

  it("closes the new-note dialog with Escape and restores trigger focus", async () => {
    const user = userEvent.setup()
    render(<App />)

    const trigger = await screen.findByRole("button", { name: "新建笔记" })
    await user.click(trigger)
    expect(screen.getByRole("dialog", { name: "新建笔记" })).toBeVisible()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "新建笔记" })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("changes visibility with pointer and keyboard-friendly menu semantics", async () => {
    const user = userEvent.setup()
    render(<App />)

    const visibility = await screen.findByRole("button", { name: "可见性：公开" })
    expect(visibility).toHaveAttribute("aria-haspopup", "menu")
    await user.click(visibility)
    expect(screen.getByText("发布后进入网站和 GitHub")).toBeVisible()
    expect(screen.getByText("只保留在这台电脑上")).toBeVisible()

    const privateOption = screen.getByRole("menuitemradio", { name: /私密/ })
    privateOption.focus()
    await user.keyboard("{Enter}")

    await waitFor(() => {
      expect(garden.notes.changeVisibility).toHaveBeenCalledWith({
        path: "content/technology/css-grid.md",
        visibility: "private",
      })
    })
    expect(screen.getByRole("button", { name: "可见性：私密" })).toBeVisible()
  })

  it("returns focus on Escape and reports a pending public removal after privatizing", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.changeVisibility).mockResolvedValueOnce(
      ok({
        id: "visibility-2",
        changedPaths: ["content/technology/css-grid.md", "private/technology/css-grid.md"],
        pendingPublicDeletion: "content/technology/css-grid.md",
        historyWarning: true,
        warnings: [],
      }),
    )
    render(<App />)

    const visibility = await screen.findByRole("button", { name: "可见性：公开" })
    await user.click(visibility)
    await user.keyboard("{Escape}")
    expect(visibility).toHaveFocus()

    await user.click(visibility)
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    expect(await screen.findByText("仍在线，等待发布下架")).toBeVisible()
    expect(screen.getByText("Git 历史仍可能保留公开内容")).toBeVisible()
  })

  it("clears the previous Markdown while a newly selected note is loading", async () => {
    const user = userEvent.setup()
    let resolvePrivate: ((value: IpcResult<NoteDocument>) => void) | undefined
    vi.mocked(garden.notes.read).mockImplementation(({ path }) => {
      if (path === notes[1].path) {
        return new Promise((resolve) => {
          resolvePrivate = resolve
        })
      }
      return Promise.resolve(ok(documents.get(path)!))
    })
    render(<App />)

    expect(await screen.findByText("# CSS Grid 布局", { exact: false })).toBeVisible()
    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    expect(screen.getByText("正在载入 Markdown…")).toBeVisible()
    expect(screen.queryByText("# CSS Grid 布局", { exact: false })).not.toBeInTheDocument()

    resolvePrivate?.(ok(documents.get(notes[1].path)!))
    expect(await screen.findByText("# 私密阅读札记", { exact: false })).toBeVisible()
  })

  it("does not steal selection when an earlier visibility request finishes late", async () => {
    const user = userEvent.setup()
    let resolveVisibility: ((value: IpcResult<NoteTransactionReceipt>) => void) | undefined
    vi.mocked(garden.notes.changeVisibility).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVisibility = resolve
        }),
    )
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    expect(await screen.findByText("private/reading/private-notes.md")).toBeVisible()

    await act(async () => {
      resolveVisibility?.(
        ok({ id: "visibility-late", changedPaths: [], historyWarning: false, warnings: [] }),
      )
    })
    expect(screen.getByText("private/reading/private-notes.md")).toBeVisible()
    expect(screen.getByRole("button", { name: /私密阅读札记/ })).toHaveAttribute(
      "aria-current",
      "page",
    )
  })

  it("keeps exact-note preview primary and offers secondary destinations", async () => {
    const user = userEvent.setup()
    render(<App />)

    const preview = await screen.findByRole("region", { name: "本地预览" })
    expect(within(preview).getByTitle("CSS Grid 布局的 Quartz 精确预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8080/technology/css-grid",
    )

    await user.click(within(preview).getByRole("tab", { name: "全站本地" }))
    expect(within(preview).getByTitle("Quartz 本地全站预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8080/",
    )

    await user.click(within(preview).getByRole("tab", { name: "线上公开站" }))
    expect(within(preview).getByTitle("线上公开站")).toHaveAttribute(
      "src",
      "https://jin07-72.github.io/knowledge-garden/",
    )

    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    await user.click(within(preview).getByRole("tab", { name: "当前笔记" }))
    expect(within(preview).getByText("私密笔记不会映射到公开网址")).toBeVisible()
    expect(within(preview).queryByTitle(/私密阅读札记的 Quartz 精确预览/)).not.toBeInTheDocument()

    await user.click(within(preview).getByRole("tab", { name: "历史" }))
    expect(await within(preview).findByText(/历史服务暂不可用/)).toBeVisible()
  })

  it("reports unavailable future services honestly in the status bar", async () => {
    render(<App />)

    const status = await screen.findByRole("status", { name: "发布状态" })
    expect(within(status).getByText("已保存")).toBeVisible()
    expect(within(status).getByText("预览就绪")).toBeVisible()
    expect(within(status).getByText("可发布变化：暂不可用")).toBeVisible()
    expect(within(status).getByRole("button", { name: "检查并发布" })).toBeDisabled()
    expect(within(status).getByText(/发布检查暂不可用/)).toBeVisible()
  })

  it("resizes pane separators with keyboard and pointer input", async () => {
    render(<App />)

    const sidebarSeparator = screen.getByRole("separator", { name: "调整笔记栏宽度" })
    const workspace = sidebarSeparator.closest(".workspace-grid")
    expect(workspace).not.toHaveAttribute("style")

    sidebarSeparator.focus()
    fireEvent.keyDown(sidebarSeparator, { key: "ArrowRight" })
    expect(workspace).toHaveStyle({ gridTemplateColumns: "252px 520px minmax(360px, 1fr)" })

    fireEvent.pointerDown(sidebarSeparator, { clientX: 200 })
    fireEvent.pointerMove(sidebarSeparator, { clientX: 240 })
    fireEvent.pointerUp(sidebarSeparator)
    expect(workspace).toHaveStyle({ gridTemplateColumns: "292px 520px minmax(360px, 1fr)" })

    fireEvent.pointerDown(sidebarSeparator, { clientX: 240 })
    fireEvent.pointerCancel(sidebarSeparator)
    fireEvent.pointerMove(sidebarSeparator, { clientX: 300 })
    expect(workspace).toHaveStyle({ gridTemplateColumns: "292px 520px minmax(360px, 1fr)" })
  })
})
