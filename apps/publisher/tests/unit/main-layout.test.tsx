import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EditorView } from "@codemirror/view"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../src/renderer/src/App"
import { shanghaiCalendarDate } from "../../src/renderer/src/components/NoteSidebar"
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  return {
    promise: new Promise<T>((done, fail) => {
      resolve = done
      reject = fail
    }),
    resolve,
    reject,
  }
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
      recovery: {
        get: vi.fn(async () => ok(undefined)),
        write: vi.fn(async () => ok({ contentHash: "c".repeat(64) })),
        discard: vi.fn(async () => ok(undefined)),
      },
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
    localStorage.clear()
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
    garden = createGardenMock()
    Object.defineProperty(window, "garden", { configurable: true, value: garden })
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps modal isolation and focus stable under StrictMode effect replay", async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await act(async () => Promise.resolve())
    expect(document.querySelector(".app-shell")).toHaveAttribute("inert")
    expect(within(dialog).getByRole("textbox", { name: "标题" })).toHaveFocus()
  })

  it("closes the visibility menu on Tab, outside pointer, and focus leaving", async () => {
    const user = userEvent.setup()
    render(<App />)
    const trigger = await screen.findByRole("button", { name: "可见性：公开" })

    await user.click(trigger)
    within(screen.getByRole("menu", { name: "选择可见性" }))
      .getByRole("menuitemradio", { name: /私密/ })
      .focus()
    await user.tab()
    expect(screen.queryByRole("menu", { name: "选择可见性" })).not.toBeInTheDocument()

    await user.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole("menu", { name: "选择可见性" })).not.toBeInTheDocument()
  })

  it("ignores stale preview events while retaining the last successful preview on errors", async () => {
    let progress: ((status: PreviewStatus) => void) | undefined
    vi.mocked(garden.preview.onProgress).mockImplementation((listener) => {
      progress = listener
      return () => undefined
    })
    render(<App />)
    const preview = await screen.findByRole("region", { name: "本地预览" })

    act(() => {
      progress?.({
        state: "ready",
        generation: 5,
        url: "http://127.0.0.1:9000/",
        lastSuccessfulUrl: "http://127.0.0.1:9000/",
      })
      progress?.({
        state: "error",
        generation: 4,
        error: { code: "PREVIEW_BUILD_FAILED", message: "旧错误" },
      })
    })
    expect(within(preview).queryByText("旧错误")).not.toBeInTheDocument()
    expect(await within(preview).findByTitle("CSS Grid 布局的 Quartz 精确预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:9000/technology/css-grid",
    )

    act(() => {
      progress?.({
        state: "error",
        generation: 5,
        error: { code: "PREVIEW_BUILD_FAILED", message: "新错误" },
      })
    })
    expect(within(preview).getByText("新错误")).toBeVisible()
    expect(within(preview).getByTitle("CSS Grid 布局的 Quartz 精确预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:9000/technology/css-grid",
    )
  })

  it("reports a rejected preview status request without an unhandled bootstrap failure", async () => {
    vi.mocked(garden.preview.status).mockRejectedValueOnce(new Error("状态通道断开"))
    render(<App />)

    const preview = await screen.findByRole("region", { name: "本地预览" })
    expect(await within(preview).findByRole("alert")).toHaveTextContent("状态通道断开")
  })

  it("reports a rejected change-list request without an unhandled bootstrap failure", async () => {
    vi.mocked(garden.changes.list).mockRejectedValueOnce(new Error("变化通道断开"))
    render(<App />)

    const status = await screen.findByRole("status", { name: "发布状态" })
    expect(within(status).getByText("变化通道断开")).toBeVisible()
    expect(screen.getByRole("button", { name: "检查并发布" })).toBeDisabled()
  })

  it("ignores stale StrictMode bootstrap results and starts preview at most once", async () => {
    const firstList = deferred<IpcResult<readonly NoteSummary[]>>()
    const secondList = deferred<IpcResult<readonly NoteSummary[]>>()
    const firstStatus = deferred<IpcResult<PreviewStatus>>()
    const secondStatus = deferred<IpcResult<PreviewStatus>>()
    const firstChanges = deferred<IpcResult<readonly ChangeGroup[]>>()
    const secondChanges = deferred<IpcResult<readonly ChangeGroup[]>>()
    const lists = [firstList, secondList]
    const statuses = [firstStatus, secondStatus]
    const changes = [firstChanges, secondChanges]
    vi.mocked(garden.notes.list).mockImplementation(() => lists.shift()!.promise)
    vi.mocked(garden.preview.status).mockImplementation(() => statuses.shift()!.promise)
    vi.mocked(garden.changes.list).mockImplementation(() => changes.shift()!.promise)
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await waitFor(() => expect(garden.notes.list).toHaveBeenCalledTimes(2))

    secondList.resolve(ok([notes[1]]))
    secondStatus.resolve(ok({ state: "stopped", generation: 2 }))
    secondChanges.resolve(ok([]))
    await waitFor(() => expect(garden.preview.start).toHaveBeenCalledTimes(1))
    firstList.resolve(ok([notes[0]]))
    firstStatus.resolve(ok({ state: "ready", generation: 99, url: "http://stale/" }))
    firstChanges.resolve(ok([{ id: "stale", label: "旧变化", paths: ["content/a.md"] }]))

    expect(await screen.findByText("private/reading/private-notes.md")).toBeVisible()
    expect(screen.getByText("可发布变化：0")).toBeVisible()
    expect(screen.getByRole("button", { name: "检查并发布" })).toBeDisabled()
  })

  it("uses the Shanghai calendar date for new notes", () => {
    expect(shanghaiCalendarDate(new Date("2026-01-01T16:30:00.000Z"))).toBe("2026-01-02")
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

  it("keeps a busy create dialog modal and avoids updates after it unmounts", async () => {
    const user = userEvent.setup()
    const creation = deferred<Awaited<ReturnType<GardenApi["notes"]["create"]>>>()
    vi.mocked(garden.notes.create).mockReturnValueOnce(creation.promise)
    const view = render(<App />)

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "等待创建")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "描述")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), "标签")
    await user.click(within(dialog).getByRole("button", { name: "创建" }))

    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled()
    await user.keyboard("{Escape}")
    expect(dialog).toBeVisible()
    fireEvent.submit(dialog.querySelector("form")!)
    expect(garden.notes.create).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => {
      creation.resolve(
        ok({
          path: "content/technology/new-note.md",
          updatedAt: "2026-09-25T00:00:00.000Z",
          mtimeMs: 4,
          contentHash: "late",
        }),
      )
      await Promise.resolve()
    })
  })

  it("creates and closes the new-note dialog after StrictMode effect replay", async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "严格模式笔记")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "严格模式描述")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), "测试")
    await user.click(within(dialog).getByRole("button", { name: "创建" }))

    expect(await screen.findByText("content/technology/new-note.md")).toBeVisible()
    expect(screen.queryByRole("dialog", { name: "新建笔记" })).not.toBeInTheDocument()
  })

  it("recovers a StrictMode new-note dialog after create rejects", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.create)
      .mockRejectedValueOnce(new Error("创建通道断开"))
      .mockResolvedValueOnce(
        ok({
          path: "content/technology/new-note.md",
          updatedAt: "2026-09-25T00:00:00.000Z",
          mtimeMs: 4,
          contentHash: "retry",
        }),
      )
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "重试笔记")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "失败后重试")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), "测试")
    await user.click(within(dialog).getByRole("button", { name: "创建" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("创建通道断开")
    const retry = within(dialog).getByRole("button", { name: "创建" })
    expect(retry).toBeEnabled()
    await user.click(retry)
    expect(await screen.findByText("content/technology/new-note.md")).toBeVisible()
    expect(screen.queryByRole("dialog", { name: "新建笔记" })).not.toBeInTheDocument()
  })

  it("traps focus in the inert new-note modal and restores trigger focus", async () => {
    const user = userEvent.setup()
    render(<App />)

    const trigger = await screen.findByRole("button", { name: "新建笔记" })
    await user.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    const shell = document.querySelector(".app-shell")
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole("textbox", { name: "标题" })).toHaveFocus()
    expect(shell).toHaveAttribute("inert")
    expect(shell).toHaveAttribute("aria-hidden", "true")

    const close = within(dialog).getByRole("button", { name: "关闭" })
    const cancel = within(dialog).getByRole("button", { name: "取消" })
    close.focus()
    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()

    fireEvent.pointerDown(document.querySelector(".dialog-backdrop")!)
    expect(dialog).toBeVisible()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "新建笔记" })).not.toBeInTheDocument()
    expect(shell).not.toHaveAttribute("inert")
    expect(shell).not.toHaveAttribute("aria-hidden")
    expect(trigger).toHaveFocus()
  })

  it("changes visibility with pointer and keyboard-friendly menu semantics", async () => {
    const user = userEvent.setup()
    render(<App />)

    const visibility = await screen.findByRole("button", { name: "可见性：公开" })
    expect(visibility).toHaveAttribute("aria-haspopup", "menu")
    await user.click(visibility)
    expect(screen.getByText("发布后进入网站和 GitHub")).toBeVisible()
    expect(screen.getByText("移入私密目录；已发布副本需发布后下架")).toBeVisible()
    expect(screen.queryByText("只保留在这台电脑上")).not.toBeInTheDocument()

    const privateOption = screen.getByRole("menuitemradio", { name: /私密/ })
    privateOption.focus()
    await user.keyboard("{Enter}")

    const confirm = screen.getByRole("dialog", { name: "确认设为私密" })
    expect(within(confirm).getByText("若已上线，当前在线副本要等发布下架")).toBeVisible()
    expect(within(confirm).getByText("Git 历史可能仍可见")).toBeVisible()
    expect(garden.notes.changeVisibility).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole("button", { name: "取消" }))
    expect(visibility).toHaveFocus()

    await user.click(visibility)
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    const confirmed = screen.getByRole("dialog", { name: "确认设为私密" })
    await user.click(within(confirmed).getByRole("button", { name: "确认设为私密" }))

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
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )
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
    expect(await screen.findByText("正在载入 Markdown…")).toBeVisible()
    expect(screen.queryByText("# CSS Grid 布局", { exact: false })).not.toBeInTheDocument()

    resolvePrivate?.(ok(documents.get(notes[1].path)!))
    expect(await screen.findByText("# 私密阅读札记", { exact: false })).toBeVisible()
  })

  it("flushes a changed note before reading the next selection", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.save).mockResolvedValueOnce(
      ok({
        path: notes[0].path,
        updatedAt: "2026-09-25T01:00:00.000Z",
        mtimeMs: 3,
        contentHash: "c".repeat(64),
      }),
    )
    render(<App />)
    await screen.findByText("# CSS Grid 布局", { exact: false })
    const content = document.querySelector(".cm-content") as HTMLElement
    const view = EditorView.findFromDOM(content)!
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nchanged" } }))

    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledTimes(1))
    expect(garden.notes.read).toHaveBeenCalledWith({ path: notes[1].path })
  })

  it("blocks a note switch and retains the buffer when its flush fails", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.save).mockResolvedValueOnce({
      ok: false,
      error: { code: "NOTE_FILE_WRITE_FAILED", message: "磁盘不可写" },
    })
    render(<App />)
    await screen.findByText("# CSS Grid 布局", { exact: false })
    const view = EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nretained" } }))

    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    expect(await screen.findByRole("alert", { name: "保存状态" })).toHaveTextContent("保存失败")
    expect(view.state.doc.toString()).toContain("retained")
    expect(screen.getByText(notes[0].path)).toBeVisible()
    expect(garden.notes.read).not.toHaveBeenCalledWith({ path: notes[1].path })
  })

  it("shows note-read failures in the editor and supports retry", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.read)
      .mockResolvedValueOnce(unavailable<NoteDocument>("无法读取这篇笔记"))
      .mockResolvedValueOnce(ok(documents.get(notes[0].path)!))
    render(<App />)

    const editor = screen.getByRole("region", { name: "Markdown 编辑器" })
    expect(await within(editor).findByRole("alert")).toHaveTextContent("无法读取这篇笔记")
    expect(within(editor).queryByText("正在载入 Markdown…")).not.toBeInTheDocument()
    await user.click(within(editor).getByRole("button", { name: "重试读取" }))
    expect(await within(editor).findByText("# CSS Grid 布局", { exact: false })).toBeVisible()
  })

  it("keeps the public selection and announces a visibility failure", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.changeVisibility).mockResolvedValueOnce(
      unavailable<NoteTransactionReceipt>("无法移动这篇笔记"),
    )
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    const confirm = screen.getByRole("dialog", { name: "确认设为私密" })
    await user.click(within(confirm).getByRole("button", { name: "确认设为私密" }))

    const editor = screen.getByRole("region", { name: "Markdown 编辑器" })
    expect(await screen.findByRole("alert")).toHaveTextContent("无法移动这篇笔记")
    expect(within(editor).queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "可见性：公开" })).toBeVisible()
    expect(screen.getByText("content/technology/css-grid.md")).toBeVisible()
  })

  it("attributes a late visibility failure to its original note", async () => {
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
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )
    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))

    await act(async () => {
      resolveVisibility?.(unavailable<NoteTransactionReceipt>("无法移动这篇笔记"))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("CSS Grid 布局：无法移动这篇笔记")
    expect(screen.getByText("private/reading/private-notes.md")).toBeVisible()
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
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )
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

  it.each(["success", "failure"] as const)(
    "ignores a pending visibility %s after unmount",
    async (outcome) => {
      const user = userEvent.setup()
      const visibility = deferred<IpcResult<NoteTransactionReceipt>>()
      vi.mocked(garden.notes.changeVisibility).mockReturnValueOnce(visibility.promise)
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const view = render(<App />)

      await user.click(await screen.findByRole("button", { name: "可见性：公开" }))
      await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
      await user.click(
        within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
          name: "确认设为私密",
        }),
      )
      view.unmount()
      await act(async () => {
        if (outcome === "success") {
          visibility.resolve(
            ok({ id: "visibility-late", changedPaths: [], historyWarning: false, warnings: [] }),
          )
        } else {
          visibility.reject(new Error("late failure"))
        }
        await Promise.resolve()
      })

      expect(consoleError).not.toHaveBeenCalled()
    },
  )

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

  it("shows a safe history error when history loading rejects", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.history.git).mockRejectedValueOnce(new Error("历史通道断开"))
    render(<App />)

    const preview = await screen.findByRole("region", { name: "本地预览" })
    await user.click(within(preview).getByRole("tab", { name: "历史" }))
    expect(await within(preview).findByText("无法读取历史记录，请稍后重试。")).toBeVisible()
  })

  it("reports unavailable future services honestly in the status bar", async () => {
    render(<App />)

    const status = await screen.findByRole("status", { name: "发布状态" })
    expect(within(status).getByText("已保存")).toBeVisible()
    expect(within(status).getByText("预览就绪")).toBeVisible()
    expect(within(status).getByText("可发布变化：暂不可用")).toBeVisible()
    expect(screen.getByRole("button", { name: "检查并发布" })).toBeDisabled()
    expect(within(status).getByText(/发布检查暂不可用/)).toBeVisible()
  })

  it("announces note-list failures and retries without hiding the error", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.list)
      .mockResolvedValueOnce(unavailable<readonly NoteSummary[]>("读取列表失败"))
      .mockResolvedValueOnce(ok(notes))
    render(<App />)

    const navigation = screen.getByRole("navigation", { name: "笔记" })
    const alert = await within(navigation).findByRole("alert")
    expect(alert).toHaveTextContent("读取列表失败")
    await user.click(within(alert).getByRole("button", { name: "重试" }))
    expect(await within(navigation).findByRole("button", { name: /CSS Grid 布局/ })).toBeVisible()
    expect(within(navigation).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps publish review disabled for both empty and non-empty successful change checks", async () => {
    vi.mocked(garden.changes.list).mockResolvedValueOnce(
      ok([{ id: "change-1", label: "一项变化", paths: ["content/a.md"] }]),
    )
    render(<App />)

    expect(await screen.findByText("可发布变化：1")).toBeVisible()
    const publish = screen.getByRole("button", { name: "检查并发布" })
    expect(publish).toBeDisabled()
    expect(publish).toHaveAccessibleDescription(/发布审查功能尚未启用/)
    expect(garden.publish.start).not.toHaveBeenCalled()
  })

  it("ignores pending bootstrap results after unmount without console errors", async () => {
    const list = deferred<IpcResult<readonly NoteSummary[]>>()
    const status = deferred<IpcResult<PreviewStatus>>()
    const changes = deferred<IpcResult<readonly ChangeGroup[]>>()
    vi.mocked(garden.notes.list).mockReturnValueOnce(list.promise)
    vi.mocked(garden.preview.status).mockReturnValueOnce(status.promise)
    vi.mocked(garden.changes.list).mockReturnValueOnce(changes.promise)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const view = render(<App />)
    view.unmount()

    await act(async () => {
      list.resolve(ok(notes))
      status.resolve(ok({ state: "ready", generation: 8, url: "http://late/" }))
      changes.resolve(ok([]))
      await Promise.resolve()
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("resizes pane separators with keyboard and pointer input", async () => {
    render(<App />)

    const sidebarSeparator = screen.getByRole("separator", { name: "调整笔记栏宽度" })
    const workspace = sidebarSeparator.closest(".workspace-grid")
    expect(workspace).not.toHaveAttribute("style")

    sidebarSeparator.focus()
    fireEvent.keyDown(sidebarSeparator, { key: "ArrowRight" })
    expect((workspace as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("252px")
    expect((workspace as HTMLElement).style.getPropertyValue("--editor-width")).toBe("520px")

    fireEvent.pointerDown(sidebarSeparator, { clientX: 200 })
    fireEvent.pointerMove(sidebarSeparator, { clientX: 240 })
    fireEvent.pointerUp(sidebarSeparator)
    expect((workspace as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("292px")

    fireEvent.pointerDown(sidebarSeparator, { clientX: 240 })
    fireEvent.pointerCancel(sidebarSeparator)
    fireEvent.pointerMove(sidebarSeparator, { clientX: 300 })
    expect((workspace as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("292px")
  })

  it("jointly bounds both separators, stops on lost capture, and persists safe sizes", () => {
    const view = render(<App />)
    const sidebar = screen.getByRole("separator", { name: "调整笔记栏宽度" })
    const editor = screen.getByRole("separator", { name: "调整编辑器宽度" })
    const workspace = sidebar.closest(".workspace-grid")!
    Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 1440 })
    Object.assign(sidebar, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    Object.assign(editor, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    expect(sidebar).toHaveAttribute("aria-valuemin", "190")
    expect(sidebar).toHaveAttribute("aria-valuemax", "420")
    expect(sidebar).toHaveAttribute("aria-valuenow", "240")
    expect(editor).toHaveAttribute("aria-valuemin", "360")
    expect(editor).toHaveAttribute("aria-valuemax", "840")
    expect(editor).toHaveAttribute("aria-valuenow", "520")

    fireEvent.pointerDown(sidebar, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(sidebar, { pointerId: 1, clientX: 1000 })
    expect((workspace as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("420px")
    fireEvent.lostPointerCapture(sidebar, { pointerId: 1 })
    fireEvent.pointerMove(sidebar, { pointerId: 1, clientX: 0 })
    expect((workspace as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("420px")

    fireEvent.pointerDown(editor, { pointerId: 2, clientX: 0 })
    fireEvent.pointerMove(editor, { pointerId: 2, clientX: 1000 })
    fireEvent.pointerUp(editor, { pointerId: 2, clientX: 1000 })
    expect((workspace as HTMLElement).style.getPropertyValue("--sidebar-width")).toBe("420px")
    expect((workspace as HTMLElement).style.getPropertyValue("--editor-width")).toBe("660px")
    expect(editor).toHaveAttribute("aria-valuemax", "660")
    expect(editor).toHaveAttribute("aria-valuenow", "660")
    fireEvent.keyDown(editor, { key: "ArrowRight" })
    expect(editor).toHaveAttribute("aria-valuenow", "660")
    expect(JSON.parse(localStorage.getItem("garden-publisher:pane-sizes")!)).toEqual({
      sidebar: 420,
      editor: 660,
    })

    view.unmount()
    render(<App />)
    const restored = document.querySelector<HTMLElement>(".workspace-grid")!
    expect(restored.style.getPropertyValue("--sidebar-width")).toBe("420px")
    expect(restored.style.getPropertyValue("--editor-width")).toBe("660px")
  })

  it("falls back from malformed persisted pane sizes", () => {
    localStorage.setItem("garden-publisher:pane-sizes", '{"sidebar":"huge","editor":99999}')
    render(<App />)
    expect(document.querySelector(".workspace-grid")).not.toHaveAttribute("style")
  })

  it("uses the two-column responsive model at 960px without inapplicable separators", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 960 })
    localStorage.setItem("garden-publisher:pane-sizes", '{"sidebar":420,"editor":900}')
    render(<App />)

    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    const workspace = document.querySelector<HTMLElement>(".workspace-grid")!
    expect(workspace.style.getPropertyValue("--sidebar-width")).toBe("420px")
    expect(workspace.style.getPropertyValue("--editor-width")).toBe("360px")
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("garden-publisher:pane-sizes")!)).toEqual({
        sidebar: 420,
        editor: 360,
      }),
    )
  })

  it("reclamps persisted panes when a ResizeObserver reports a wide-to-narrow change", async () => {
    let reportWidth: ((width: number) => void) | undefined
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        reportWidth = (width) =>
          callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          )
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    localStorage.setItem("garden-publisher:pane-sizes", '{"sidebar":420,"editor":660}')
    render(<App />)
    expect(screen.getAllByRole("separator")).toHaveLength(2)

    act(() => reportWidth?.(960))

    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    const workspace = document.querySelector<HTMLElement>(".workspace-grid")!
    expect(workspace.style.getPropertyValue("--sidebar-width")).toBe("420px")
    expect(workspace.style.getPropertyValue("--editor-width")).toBe("360px")
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("garden-publisher:pane-sizes")!)).toEqual({
        sidebar: 420,
        editor: 360,
      }),
    )
  })

  it("keeps pane resizing usable when localStorage persistence throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError")
    })
    render(<App />)

    const sidebar = screen.getByRole("separator", { name: "调整笔记栏宽度" })
    fireEvent.keyDown(sidebar, { key: "ArrowRight" })
    expect(sidebar).toHaveAttribute("aria-valuenow", "252")
  })
})
