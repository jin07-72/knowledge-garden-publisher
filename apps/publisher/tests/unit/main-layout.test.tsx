import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EditorView } from "@codemirror/view"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPublisherCloseCoordinator } from "../../src/main/publisherServices"
import { App as StartupApp, PublisherApp } from "../../src/renderer/src/App"
import { BlogSwitcher } from "../../src/renderer/src/components/BlogSwitcher"
import { shanghaiCalendarDate } from "../../src/renderer/src/components/NoteSidebar"
import type {
  ChangeReview,
  BlogCandidateInspection,
  BlogImportReceipt,
  BlogRegistryView,
  DeploymentHistory,
  GardenApi,
  GitCommit,
  IpcResult,
  NoteDocument,
  NoteSummary,
  NoteTransactionReceipt,
  NoteWriteReceipt,
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

function markdownHash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
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
    blogs: {
      list: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      chooseLocal: vi.fn(async () => ok(undefined)),
      addLocal: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      clone: vi.fn(async () => unavailable<BlogImportReceipt>("博客服务将在后续任务中提供。")),
      cancelImport: vi.fn(async () => ok(undefined)),
      install: vi.fn(async () =>
        unavailable<BlogCandidateInspection>("博客服务将在后续任务中提供。"),
      ),
      rename: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      relocate: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      remove: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      openFolder: vi.fn(async () => ok(undefined)),
      switch: vi.fn(async () => ok(undefined)),
      onImportProgress: vi.fn(() => () => undefined),
    },
    lifecycle: {
      acknowledgeClose: vi.fn(async () => ok(undefined)),
      onBeforeClose: vi.fn(() => () => undefined),
      onCloseBlocked: vi.fn(() => () => undefined),
    },
    workspace: {
      inspectSafety: vi.fn(async () =>
        ok<WorkspaceInspection>({
          ok: true,
          root: String.raw`C:\Users\11546\Desktop\web`,
          capabilities: { files: true, preview: true, git: false, publish: false },
          issues: [],
        }),
      ),
      inspect: vi.fn(async () =>
        ok<WorkspaceInspection>({
          ok: true,
          root: String.raw`C:\Users\11546\Desktop\web`,
          capabilities: { files: true, preview: true, git: true, publish: false },
          issues: [],
        }),
      ),
      repair: vi.fn(async () =>
        ok({ action: "install-dependencies" as const, message: "installed" }),
      ),
    },
    notes: {
      onRecovery: vi.fn(() => () => undefined),
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
      list: vi.fn(async () => unavailable<ChangeReview>("变更服务暂不可用。")),
      cancel: vi.fn(async () => ok(undefined)),
    },
    publish: {
      start: vi.fn(),
      cancel: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
    },
    history: {
      git: vi.fn(async () => unavailable<readonly GitCommit[]>("历史服务将在后续任务中提供。")),
      deployments: vi.fn(async () =>
        unavailable<DeploymentHistory>("部署历史将在后续任务中提供。"),
      ),
      cancel: vi.fn(async () => ok(undefined)),
      openLink: vi.fn(async () => ok(undefined)),
    },
  }
}

describe("publisher main layout", () => {
  let garden: GardenApi
  const App = (): React.JSX.Element => <PublisherApp api={garden} />

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

  it("keeps editing available while transient remote and preferred-port diagnostics remain visible", async () => {
    vi.mocked(garden.workspace.inspect).mockResolvedValueOnce(
      ok({
        ok: false,
        root: String.raw`C:\Users\11546\Desktop\web`,
        capabilities: { files: true, preview: true, git: false, publish: false },
        issues: [
          { code: "GIT_ORIGIN_UNREACHABLE", message: "origin/main is temporarily unreachable." },
          { code: "PREVIEW_PORT_UNAVAILABLE", message: "The preferred preview port is occupied." },
        ],
      }),
    )

    render(<StartupApp />)

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "启动检查" })).toBeVisible()
      expect(screen.getByRole("region", { name: "Markdown 编辑器" })).toBeVisible()
    })
    expect(garden.notes.list).toHaveBeenCalledOnce()
    expect(screen.getByText("origin/main is temporarily unreachable.")).toBeVisible()
    expect(screen.getByText("The preferred preview port is occupied.")).toBeVisible()
  })

  it("mounts the editor after local safety passes while slow diagnostics remain pending", async () => {
    vi.mocked(garden.workspace.inspect).mockImplementationOnce(() => new Promise(() => undefined))

    render(<StartupApp />)

    expect(await screen.findByRole("region", { name: "Markdown 编辑器" })).toBeVisible()
    expect(garden.workspace.inspectSafety).toHaveBeenCalledOnce()
    expect(garden.workspace.inspect).toHaveBeenCalledOnce()
    expect(garden.notes.list).toHaveBeenCalledOnce()
  })

  it("reloads after recovered items and reports conflicts without a reload loop", async () => {
    let recoveryListener:
      ((update: { restored: readonly string[]; conflicts: readonly string[] }) => void) | undefined
    vi.mocked(garden.notes.onRecovery).mockImplementation((listener) => {
      recoveryListener = listener
      return () => undefined
    })
    render(<PublisherApp api={garden} />)
    await waitFor(() => expect(garden.notes.list).toHaveBeenCalledOnce())

    act(() => recoveryListener?.({ restored: ["content/life/daily.md"], conflicts: [] }))
    await waitFor(() => expect(garden.notes.list).toHaveBeenCalledTimes(2))
    expect(screen.getByText(/回收站恢复 1 项/)).toBeVisible()

    act(() => recoveryListener?.({ restored: [], conflicts: ["content/life/daily.md"] }))
    expect(await screen.findByText(/恢复项与 content\/life\/daily\.md 冲突/)).toBeVisible()
    expect(garden.notes.list).toHaveBeenCalledTimes(2)
  })

  it("acknowledges close only after an edit younger than 750ms and its recovery are durable", async () => {
    let beforeClose: ((request: { requestId: string }) => void) | undefined
    vi.mocked(garden.lifecycle.onBeforeClose).mockImplementation((listener) => {
      beforeClose = listener
      return () => undefined
    })
    const recoveryWrite = deferred<Awaited<ReturnType<GardenApi["notes"]["recovery"]["write"]>>>()
    const rendererAck = deferred<boolean>()
    vi.mocked(garden.lifecycle.acknowledgeClose).mockImplementation(async ({ success }) => {
      rendererAck.resolve(success)
      return ok(undefined)
    })
    vi.mocked(garden.notes.recovery.write).mockReturnValue(recoveryWrite.promise)
    vi.mocked(garden.notes.save).mockImplementation(async (request) =>
      ok({
        path: request.path,
        updatedAt: "2026-09-26T00:00:00.000Z",
        mtimeMs: 4,
        contentHash: createHash("sha256").update(request.markdown).digest("hex"),
      }),
    )
    render(<App />)
    await screen.findByRole("region", { name: "Markdown 编辑器" })
    const view = await waitFor(() =>
      EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement),
    )
    await waitFor(() => expect(view!.contentDOM).toHaveAttribute("contenteditable", "true"))
    act(() => {
      view!.dispatch({ changes: { from: view!.state.doc.length, insert: "\nclose now" } })
    })
    const allowClose = vi.fn()
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush: () => {
        beforeClose?.({ requestId: "11111111-1111-4111-8111-111111111111" })
        return rendererAck.promise
      },
      cleanup: vi.fn(async () => undefined),
      allowClose,
      allowQuit: vi.fn(),
      reportFailure: vi.fn(),
    })
    const closeEvent = { preventDefault: vi.fn() }
    const close = coordinator.beforeWindowClose(closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(allowClose).not.toHaveBeenCalled()
    expect(garden.lifecycle.acknowledgeClose).not.toHaveBeenCalled()
    recoveryWrite.resolve(ok({ contentHash: "c".repeat(64) }))
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(garden.lifecycle.acknowledgeClose).toHaveBeenCalledWith({
        requestId: "11111111-1111-4111-8111-111111111111",
        success: true,
      }),
    )
    await close
    expect(allowClose).toHaveBeenCalledOnce()
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
    expect(await within(preview).findByTitle("CSS Grid 布局的 Quartz 精确预览")).toHaveAttribute(
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
    const user = userEvent.setup()
    vi.mocked(garden.changes.list).mockRejectedValueOnce(new Error("变化通道断开"))
    render(<App />)

    const status = await screen.findByRole("status", { name: "发布状态" })
    expect(within(status).getByText("变化通道断开")).toBeVisible()
    const review = screen.getByRole("button", { name: "检查并发布" })
    expect(review).toBeEnabled()
    await user.click(review)
    expect(await screen.findByRole("dialog", { name: "检查并发布" })).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("发布检查暂不可用")
  })

  it("ignores stale StrictMode bootstrap results and starts preview at most once", async () => {
    const firstList = deferred<IpcResult<readonly NoteSummary[]>>()
    const secondList = deferred<IpcResult<readonly NoteSummary[]>>()
    const firstStatus = deferred<IpcResult<PreviewStatus>>()
    const secondStatus = deferred<IpcResult<PreviewStatus>>()
    const firstChanges = deferred<IpcResult<ChangeReview>>()
    const secondChanges = deferred<IpcResult<ChangeReview>>()
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
    secondChanges.resolve(ok({ groups: [] }))
    await waitFor(() => expect(garden.preview.start).toHaveBeenCalledTimes(1))
    firstList.resolve(ok([notes[0]]))
    firstStatus.resolve(ok({ state: "ready", generation: 99, url: "http://stale/" }))
    firstChanges.resolve(
      ok({
        groups: [
          {
            id: "stale",
            label: "旧变化",
            kind: "modified",
            selection: "default",
            description: "旧变化",
            paths: ["content/a.md"],
            attachments: [],
          },
        ],
      }),
    )

    expect(await screen.findByText("private/reading/private-notes.md")).toBeVisible()
    expect(screen.getByText("可发布变化：0")).toBeVisible()
    expect(screen.getByRole("button", { name: "检查并发布" })).toBeEnabled()
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
        contentHash: markdownHash("# CSS Grid 布局\n\n正文\nchanged"),
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

  it("waits for the latest buffer and cleans its old-path recovery before a visibility move", async () => {
    const user = userEvent.setup()
    const save1 = deferred<IpcResult<NoteWriteReceipt>>()
    const save2 = deferred<IpcResult<NoteWriteReceipt>>()
    const events: string[] = []
    vi.mocked(garden.notes.save)
      .mockImplementationOnce(async () => save1.promise)
      .mockImplementationOnce(async () => save2.promise)
    vi.mocked(garden.notes.recovery.write).mockImplementation(async (request) => {
      const contentHash = request.markdown.includes("v2") ? "e".repeat(64) : "d".repeat(64)
      return ok({ contentHash })
    })
    vi.mocked(garden.notes.recovery.discard).mockImplementation(async (request) => {
      events.push(`discard:${request.path}:${request.contentHash}`)
      return ok(undefined)
    })
    vi.mocked(garden.notes.changeVisibility).mockImplementation(async ({ path }) => {
      events.push(`move:${path}`)
      return ok({
        id: "move-after-flush",
        changedPaths: [path],
        historyWarning: false,
        warnings: [],
      })
    })
    vi.mocked(garden.notes.read).mockImplementation(async ({ path }) =>
      ok(
        path === "private/technology/css-grid.md"
          ? {
              ...documents.get(notes[0].path)!,
              path,
              markdown: "# CSS Grid 布局\n\nv1\nv2",
              mtimeMs: 4,
              contentHash: "f".repeat(64),
            }
          : documents.get(path)!,
      ),
    )
    render(<App />)
    await screen.findByText("# CSS Grid 布局", { exact: false })
    const view = EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nv1" } }))

    await user.click(screen.getByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledTimes(1))
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nv2" } }))
    save1.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-09-25T01:00:00.000Z",
        mtimeMs: 3,
        contentHash: markdownHash("# CSS Grid 布局\n\n正文\nv1"),
      }),
    )
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledTimes(2))
    expect(garden.notes.changeVisibility).not.toHaveBeenCalled()
    expect(garden.notes.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: notes[0].path,
        markdown: expect.stringContaining("v2"),
        expectedMtimeMs: 3,
        expectedContentHash: markdownHash("# CSS Grid 布局\n\n正文\nv1"),
      }),
    )

    save2.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-09-25T01:01:00.000Z",
        mtimeMs: 4,
        contentHash: markdownHash("# CSS Grid 布局\n\n正文\nv1\nv2"),
      }),
    )
    await waitFor(() => expect(garden.notes.changeVisibility).toHaveBeenCalledTimes(1))
    expect(events).toContain(`discard:${notes[0].path}:${"e".repeat(64)}`)
    expect(events.at(-1)).toBe(`move:${notes[0].path}`)
    await waitFor(() =>
      expect(garden.notes.recovery.get).toHaveBeenCalledWith({
        path: "private/technology/css-grid.md",
      }),
    )
  })

  it("blocks a visibility move when the latest save in the flush barrier fails", async () => {
    const user = userEvent.setup()
    const save1 = deferred<IpcResult<NoteWriteReceipt>>()
    const save2 = deferred<IpcResult<NoteWriteReceipt>>()
    vi.mocked(garden.notes.save)
      .mockImplementationOnce(async () => save1.promise)
      .mockImplementationOnce(async () => save2.promise)
    render(<App />)
    await screen.findByText("# CSS Grid 布局", { exact: false })
    const view = EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nv1" } }))

    await user.click(screen.getByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledTimes(1))
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nv2" } }))
    save1.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-09-25T01:00:00.000Z",
        mtimeMs: 3,
        contentHash: markdownHash("# CSS Grid 布局\n\n正文\nv1"),
      }),
    )
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledTimes(2))
    save2.resolve({
      ok: false,
      error: { code: "NOTE_FILE_WRITE_FAILED", message: "v2 保存失败" },
    })

    expect(await screen.findByRole("alert", { name: "保存状态" })).toHaveTextContent("保存失败")
    expect(garden.notes.changeVisibility).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "可见性：公开" })).toBeVisible()
    expect(screen.getByText(notes[0].path)).toBeVisible()
    expect(view.state.doc.toString()).toContain("v2")
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

  it("flushes the active editor before recycle-bin deletion and warns about the online copy", async () => {
    const user = userEvent.setup()
    let postCloseFocus: FrameRequestCallback | undefined
    const save = deferred<IpcResult<NoteWriteReceipt>>()
    vi.mocked(garden.notes.save).mockReturnValueOnce(save.promise)
    vi.mocked(garden.notes.trash).mockResolvedValueOnce(
      ok({
        path: notes[0].path,
        pendingPublicDeletion: notes[0].path,
        historyWarning: true,
        attachmentCleanup: {
          status: "failed",
          message: "专属附件仍保留在工作区，请检查后重试清理。",
        },
      }),
    )
    render(<App />)
    const view = await waitFor(() =>
      EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement),
    )
    act(() => view!.dispatch({ changes: { from: view!.state.doc.length, insert: "\ndelete me" } }))

    await user.click(screen.getByRole("button", { name: "删除当前笔记" }))
    const dialog = screen.getByRole("dialog", { name: "将笔记移入回收站？" })
    expect(dialog).toHaveTextContent("它仍会在线，直到你再次发布下架变化")
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      postCloseFocus = callback
      return 1
    })
    await user.click(within(dialog).getByRole("button", { name: "移入回收站" }))
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledOnce())
    expect(garden.notes.trash).not.toHaveBeenCalled()
    save.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-09-28T00:00:00.000Z",
        mtimeMs: 3,
        contentHash: markdownHash(view!.state.doc.toString()),
      }),
    )
    await waitFor(() => expect(garden.notes.trash).toHaveBeenCalledWith({ path: notes[0].path }))
    expect(await screen.findByText(/在线副本仍会保留/)).toBeVisible()
    expect(screen.getByText(/专属附件仍保留/)).toBeVisible()
    expect(screen.queryByText(notes[0].path)).not.toBeInTheDocument()
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    const newNote = screen.getByRole("button", { name: "新建笔记" })
    expect(newNote).not.toHaveFocus()
    act(() => postCloseFocus?.(performance.now()))
    expect(newNote).toHaveFocus()
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
    expect(await within(preview).findByTitle("CSS Grid 布局的 Quartz 精确预览")).toHaveAttribute(
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
    expect(await within(preview).findByText("无法读取发布历史")).toBeVisible()
    const gitRequest = vi.mocked(garden.history.git).mock.calls.at(-1)?.[0]
    const deploymentRequest = vi.mocked(garden.history.deployments).mock.calls.at(-1)?.[0]
    expect(gitRequest?.requestId).toMatch(/^history-/)
    expect(deploymentRequest?.requestId).toBe(gitRequest?.requestId)
  })

  it("shows a safe history error when history loading rejects", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.history.git).mockRejectedValueOnce(new Error("历史通道断开"))
    render(<App />)

    const preview = await screen.findByRole("region", { name: "本地预览" })
    await user.click(within(preview).getByRole("tab", { name: "历史" }))
    expect(await within(preview).findByText("无法读取发布历史")).toBeVisible()
  })

  it("reports unavailable future services honestly in the status bar", async () => {
    render(<App />)

    const status = await screen.findByRole("status", { name: "发布状态" })
    expect(within(status).getByText("已保存")).toBeVisible()
    expect(within(status).getByText("预览就绪")).toBeVisible()
    expect(within(status).getByText("可发布变化：暂不可用")).toBeVisible()
    expect(screen.getByRole("button", { name: "检查并发布" })).toBeEnabled()
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

  it("starts publication with the selected public changes", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.publish.start).mockResolvedValueOnce(ok({ operationId: "publish-1" }))
    vi.mocked(garden.changes.list).mockResolvedValue(
      ok({
        groups: [
          {
            id: "change-1",
            label: "一项变化",
            kind: "modified",
            selection: "default",
            description: "公开文章已修改",
            paths: ["content/technology/a.md"],
            attachments: [],
          },
        ],
      }),
    )
    render(<App />)

    expect(await screen.findByText("可发布变化：1")).toBeVisible()
    const publish = screen.getByRole("button", { name: "检查并发布" })
    expect(publish).toBeEnabled()
    await user.click(publish)
    expect(screen.getByRole("dialog", { name: "检查并发布" })).toBeVisible()
    const confirm = screen.getByRole("button", { name: "验证并发布" })
    await waitFor(() => expect(confirm).toBeEnabled())
    await user.click(confirm)
    await waitFor(() =>
      expect(garden.publish.start).toHaveBeenCalledWith({ changeGroupIds: ["change-1"] }),
    )
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "检查并发布" })).not.toBeInTheDocument(),
    )
  })

  it("ignores pending bootstrap results after unmount without console errors", async () => {
    const list = deferred<IpcResult<readonly NoteSummary[]>>()
    const status = deferred<IpcResult<PreviewStatus>>()
    const changes = deferred<IpcResult<ChangeReview>>()
    vi.mocked(garden.notes.list).mockReturnValueOnce(list.promise)
    vi.mocked(garden.preview.status).mockReturnValueOnce(status.promise)
    vi.mocked(garden.changes.list).mockReturnValueOnce(changes.promise)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const view = render(<App />)
    view.unmount()

    await act(async () => {
      list.resolve(ok(notes))
      status.resolve(ok({ state: "ready", generation: 8, url: "http://late/" }))
      changes.resolve(ok({ groups: [] }))
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

  it("collapses only the blog path at narrow width while retaining the name and switch affordance", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 })
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
      ],
    }
    render(
      <header className="topbar">
        <BlogSwitcher
          registry={registry}
          disabled={false}
          onSwitch={vi.fn()}
          onAddLocal={vi.fn()}
          onClone={vi.fn()}
          onManage={vi.fn()}
        />
      </header>,
    )

    expect(screen.getByRole("button", { name: "切换博客：Knowledge Garden" })).toBeVisible()
    expect(screen.getByText("Knowledge Garden")).toBeVisible()
    const path = screen.getByText(String.raw`C:\Users\me\knowledge-garden`)
    expect(path.tagName).toBe("SMALL")
    expect(path.parentElement).toHaveClass("blog-switcher-copy")

    const stylesheet = readFileSync(resolve(process.cwd(), "src/renderer/src/app.css"), "utf8")
    const narrowRules = stylesheet.slice(
      stylesheet.indexOf("@media (max-width: 680px)"),
      stylesheet.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    expect(narrowRules).toMatch(
      /\.blog-switcher-copy small,\s*\.blog-menu-copy small,\s*\.blog-manager-card-heading code\s*\{\s*display: none;\s*\}/,
    )
    expect(narrowRules).not.toMatch(/\.blog-switcher-trigger[^{]*\{[^}]*display:\s*none/)
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
