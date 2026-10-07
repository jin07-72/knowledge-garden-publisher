import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EditorView } from "@codemirror/view"
import { createHash } from "node:crypto"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../src/renderer/src/App"
import type {
  BlogRegistryView,
  BlogRegistryStatus,
  DomainSummary,
  GardenApi,
  IpcResult,
  PreviewStatus,
  WorkspaceInspection,
} from "../../src/shared/contracts"

const registry: BlogRegistryStatus = {
  version: 1,
  activeAvailability: "available",
  activeBlogId: "legacy",
  blogs: [
    {
      id: "legacy",
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

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

const domainSummaries: readonly DomainSummary[] = [
  { slug: "technology", name: "技术", description: "", order: 1, publicNotes: 0, privateNotes: 0 },
  { slug: "reading", name: "阅读", description: "", order: 2, publicNotes: 0, privateNotes: 0 },
  { slug: "language", name: "语言", description: "", order: 3, publicNotes: 0, privateNotes: 0 },
  { slug: "life", name: "生活", description: "", order: 4, publicNotes: 0, privateNotes: 0 },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function gardenApi(): GardenApi {
  const ready: PreviewStatus = { state: "ready", generation: 1, url: "http://127.0.0.1:8080" }
  const inspection: WorkspaceInspection = {
    ok: true,
    root: registry.blogs[0].canonicalPath,
    capabilities: { files: true, preview: true, git: true, publish: true },
    issues: [],
  }
  return {
    blogs: {
      list: vi.fn(async () => ok(registry)),
      chooseLocal: vi.fn(async () => ok(undefined)),
      addLocal: vi.fn(async () => ok(registry)),
      recoverLocal: vi.fn(async () => ok(registry)),
      clone: vi.fn(),
      cancelImport: vi.fn(async () => ok(undefined)),
      install: vi.fn(),
      rename: vi.fn(async () => ok(registry)),
      relocate: vi.fn(async () => ok(registry)),
      remove: vi.fn(async () => ok(registry)),
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
      inspectSafety: vi.fn(async () => ok(inspection)),
      inspect: vi.fn(async () => ok(inspection)),
      repair: vi.fn(),
    },
    domains: {
      list: vi.fn(async () => ok(domainSummaries)),
      create: vi.fn(async () => ok(domainSummaries)),
      rename: vi.fn(async () => ok(domainSummaries)),
      remove: vi.fn(async () => ok(domainSummaries)),
    },
    notes: {
      onRecovery: vi.fn(() => () => undefined),
      list: vi.fn(async () => ok([])),
      read: vi.fn(),
      save: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      changeVisibility: vi.fn(),
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
      list: vi.fn(async () => ({
        ok: false as const,
        error: { code: "SERVICE_UNAVAILABLE" as const, message: "Unavailable" },
      })),
      cancel: vi.fn(async () => ok(undefined)),
    },
    publish: { start: vi.fn(), cancel: vi.fn(), onProgress: vi.fn(() => () => undefined) },
    history: {
      git: vi.fn(),
      deployments: vi.fn(),
      cancel: vi.fn(async () => ok(undefined)),
      openLink: vi.fn(async () => ok(undefined)),
    },
  }
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
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
  Object.defineProperty(window, "garden", { configurable: true, value: undefined })
  vi.restoreAllMocks()
})

describe("App blog orchestration", () => {
  it("recovers an unavailable blog chooser after StrictMode error cleanup", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const unavailable = { ...registry, activeAvailability: "unavailable" as const }
    const chosen = String.raw`E:\Recovered\garden`
    vi.mocked(api.blogs.list).mockResolvedValue(ok(unavailable))
    vi.mocked(api.blogs.chooseLocal)
      .mockRejectedValueOnce(new Error("无法打开文件夹选择器。"))
      .mockResolvedValueOnce(
        ok({
          path: chosen,
          inspection: { valid: true, canonicalPath: chosen, needsInstall: false },
        }),
      )
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    await user.click(await screen.findByRole("button", { name: "重新定位 Knowledge Garden" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("无法打开文件夹选择器")
    const retry = screen.getByRole("button", { name: "选择文件夹" })
    expect(retry).not.toBeDisabled()
    await user.click(retry)
    expect(await screen.findByText(chosen)).toBeVisible()
    expect(api.blogs.chooseLocal).toHaveBeenCalledTimes(2)
  })

  it("recovers a corrupt registry chooser after StrictMode error cleanup", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const chosen = String.raw`D:\Blogs\recovered`
    vi.mocked(api.blogs.list).mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "博客列表需要恢复。" },
    })
    vi.mocked(api.blogs.chooseLocal)
      .mockRejectedValueOnce(new Error("无法打开文件夹选择器。"))
      .mockResolvedValueOnce(
        ok({
          path: chosen,
          inspection: { valid: true, canonicalPath: chosen, needsInstall: false },
        }),
      )
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    const choose = await screen.findByRole("button", { name: "选择文件夹" })
    await user.click(choose)
    expect(await screen.findByRole("alert")).toHaveTextContent("无法打开文件夹选择器")
    expect(choose).not.toBeDisabled()
    await user.click(choose)
    expect(await screen.findByText(chosen)).toBeVisible()
    expect(api.blogs.chooseLocal).toHaveBeenCalledTimes(2)
  })

  it("acknowledges close requests while corrupt-registry recovery has no editor", async () => {
    const api = gardenApi()
    let beforeClose: ((request: { readonly requestId: string }) => void) | undefined
    vi.mocked(api.blogs.list).mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "博客列表需要恢复。" },
    })
    vi.mocked(api.lifecycle.onBeforeClose).mockImplementation((listener) => {
      beforeClose = listener
      return () => undefined
    })
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)
    await screen.findByRole("dialog", { name: "博客恢复" })
    act(() => beforeClose?.({ requestId: "recover-close" }))

    await waitFor(() =>
      expect(api.lifecycle.acknowledgeClose).toHaveBeenCalledWith({
        requestId: "recover-close",
        success: true,
      }),
    )
  })

  it("shows actionable recovery for an unavailable active blog without starting workspace services", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const unavailable = { ...registry, activeAvailability: "unavailable" as const }
    vi.mocked(api.blogs.list).mockResolvedValue(ok(unavailable))
    vi.mocked(api.blogs.chooseLocal).mockResolvedValue(
      ok({
        path: String.raw`E:\Recovered\garden`,
        inspection: {
          valid: true,
          canonicalPath: String.raw`E:\Recovered\garden`,
          needsInstall: false,
        },
      }),
    )
    vi.mocked(api.blogs.relocate).mockResolvedValue(ok(registry))
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)

    expect(await screen.findByRole("dialog", { name: "博客恢复" })).toBeVisible()
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
    expect(api.notes.list).not.toHaveBeenCalled()
    expect(api.preview.status).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "重新定位 Knowledge Garden" }))
    await user.click(await screen.findByRole("button", { name: "更新博客位置" }))
    await waitFor(() =>
      expect(api.blogs.relocate).toHaveBeenCalledWith({
        id: "legacy",
        path: String.raw`E:\Recovered\garden`,
      }),
    )
    expect(api.blogs.switch).toHaveBeenCalledWith({ id: "legacy", editorSaved: true })
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
  })

  it("switches to an alternate registered blog once in recovery and reports switch errors", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const unavailable = { ...registry, activeAvailability: "unavailable" as const }
    const pending = deferred<IpcResult<void>>()
    vi.mocked(api.blogs.list).mockResolvedValue(ok(unavailable))
    vi.mocked(api.blogs.switch).mockReturnValue(pending.promise)
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    const switchButton = await screen.findByRole("button", { name: "切换到 Study Garden" })
    await user.dblClick(switchButton)
    expect(api.blogs.switch).toHaveBeenCalledTimes(1)
    expect(api.blogs.switch).toHaveBeenCalledWith({ id: "study", editorSaved: true })
    expect(switchButton).toBeDisabled()
    pending.resolve({
      ok: false,
      error: { code: "BLOG_SWITCH_BUSY", message: "暂时无法切换博客。" },
    })

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法切换博客")
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
    expect(api.notes.list).not.toHaveBeenCalled()
  })

  it("switches to an already registered blog selected as the recovery candidate", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const unavailable = { ...registry, activeAvailability: "unavailable" as const }
    vi.mocked(api.blogs.list).mockResolvedValue(ok(unavailable))
    vi.mocked(api.blogs.chooseLocal).mockResolvedValue(
      ok({
        path: registry.blogs[1].path,
        inspection: {
          valid: true,
          canonicalPath: registry.blogs[1].canonicalPath,
          needsInstall: false,
        },
      }),
    )
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "重新定位 Knowledge Garden" }))
    expect(await screen.findByText(/已经添加为“Study Garden”/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "切换到 Study Garden" }))

    expect(api.blogs.switch).toHaveBeenCalledWith({ id: "study", editorSaved: true })
    expect(api.blogs.relocate).not.toHaveBeenCalled()
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
  })

  it("loads the blog registry before publisher startup and shows the migrated legacy blog", async () => {
    const pending = deferred<IpcResult<BlogRegistryStatus>>()
    const api = gardenApi()
    vi.mocked(api.blogs.list).mockReturnValueOnce(pending.promise)
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)

    expect(screen.getByRole("status", { name: "正在载入博客" })).toBeVisible()
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
    pending.resolve(ok(registry))

    expect(await screen.findByRole("button", { name: /切换博客：Knowledge Garden/ })).toBeVisible()
    expect(api.workspace.inspectSafety).toHaveBeenCalledOnce()
  })

  it("offers local recovery with invalid guidance without touching workspace services when registry loading fails", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    vi.mocked(api.blogs.list).mockResolvedValueOnce({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "博客列表需要恢复。" },
    })
    vi.mocked(api.blogs.chooseLocal).mockResolvedValueOnce(
      ok({
        path: String.raw`D:\Not-a-blog`,
        inspection: { valid: false, code: "NOT_QUARTZ", message: "请选择 Quartz 博客文件夹。" },
      }),
    )
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)

    expect(await screen.findByRole("dialog", { name: "博客恢复" })).toHaveTextContent(
      "博客列表需要恢复",
    )
    await user.click(screen.getByRole("button", { name: "选择文件夹" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择 Quartz 博客文件夹")
    expect(api.blogs.recoverLocal).not.toHaveBeenCalled()
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
    expect(api.notes.list).not.toHaveBeenCalled()
    expect(api.preview.status).not.toHaveBeenCalled()
    expect(api.publish.start).not.toHaveBeenCalled()
  })

  it("installs and recovers a valid local blog before requesting a safe relaunch", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const chosen = String.raw`D:\Blogs\recovered`
    vi.mocked(api.blogs.list).mockResolvedValueOnce({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "博客列表需要恢复。" },
    })
    vi.mocked(api.blogs.chooseLocal).mockResolvedValueOnce(
      ok({
        path: chosen,
        inspection: { valid: true, canonicalPath: chosen, needsInstall: true },
      }),
    )
    vi.mocked(api.blogs.install).mockResolvedValueOnce(
      ok({ valid: true, canonicalPath: chosen, needsInstall: false }),
    )
    const recovered: BlogRegistryView = {
      ...registry,
      activeBlogId: "recovered",
      blogs: [
        {
          ...registry.blogs[0],
          id: "recovered",
          name: "Recovered",
          path: chosen,
          canonicalPath: chosen,
        },
      ],
    }
    const recovering = deferred<IpcResult<BlogRegistryView>>()
    vi.mocked(api.blogs.recoverLocal).mockReturnValueOnce(recovering.promise)
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)
    await user.click(await screen.findByRole("button", { name: "选择文件夹" }))
    await user.click(await screen.findByRole("button", { name: "安装依赖" }))
    await user.type(await screen.findByLabelText("显示名称"), "Recovered")
    await user.dblClick(screen.getByRole("button", { name: "恢复此博客" }))

    await waitFor(() => expect(api.blogs.recoverLocal).toHaveBeenCalledTimes(1))
    expect(api.blogs.recoverLocal).toHaveBeenCalledWith({ path: chosen, name: "Recovered" })
    recovering.resolve(ok(recovered))
    await waitFor(() => expect(api.blogs.switch).toHaveBeenCalledOnce())
    expect(api.blogs.switch).toHaveBeenCalledWith({ id: "recovered", editorSaved: true })
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
  })

  it("keeps retry as a secondary corrupt-registry recovery action", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    vi.mocked(api.blogs.list)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "博客列表需要恢复。" },
      })
      .mockResolvedValueOnce(ok(registry))
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)
    await user.click(await screen.findByRole("button", { name: "重新读取博客列表" }))
    expect(await screen.findByRole("button", { name: /切换博客：Knowledge Garden/ })).toBeVisible()
    expect(api.blogs.list).toHaveBeenCalledTimes(2)
  })

  it("reports corrupt-registry recovery failures without starting the workspace", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const chosen = String.raw`D:\Blogs\recovered`
    vi.mocked(api.blogs.list).mockResolvedValueOnce({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "博客列表需要恢复。" },
    })
    vi.mocked(api.blogs.chooseLocal).mockResolvedValueOnce(
      ok({
        path: chosen,
        inspection: { valid: true, canonicalPath: chosen, needsInstall: false },
      }),
    )
    vi.mocked(api.blogs.recoverLocal).mockResolvedValueOnce({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "无法安全恢复博客列表。" },
    })
    Object.defineProperty(window, "garden", { configurable: true, value: api })

    render(<App />)
    await user.click(await screen.findByRole("button", { name: "选择文件夹" }))
    await user.type(await screen.findByLabelText("显示名称"), "Recovered")
    await user.click(screen.getByRole("button", { name: "恢复此博客" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("无法安全恢复博客列表")
    expect(api.blogs.switch).not.toHaveBeenCalled()
    expect(api.workspace.inspectSafety).not.toHaveBeenCalled()
  })

  it("switches safely without an editor and suppresses duplicate switch intents", async () => {
    const user = userEvent.setup()
    const pending = deferred<IpcResult<void>>()
    const api = gardenApi()
    vi.mocked(api.blogs.switch).mockReturnValue(pending.promise)
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    const trigger = await screen.findByRole("button", { name: /切换博客：Knowledge Garden/ })
    await user.click(trigger)
    const menu = screen.getByRole("menu", { name: "选择博客" })
    await user.click(within(menu).getByRole("menuitemradio", { name: /Study Garden/ }))
    expect(api.blogs.switch).toHaveBeenCalledWith({ id: "study", editorSaved: true })
    expect(api.blogs.switch).toHaveBeenCalledTimes(1)
    expect(trigger).toBeDisabled()

    pending.resolve(ok(undefined))
    await waitFor(() => expect(trigger).not.toBeDisabled())
  })

  it("adds a valid local blog and installs missing dependencies before registration", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    vi.mocked(api.blogs.chooseLocal).mockResolvedValue(
      ok({
        path: String.raw`D:\Blogs\local`,
        inspection: {
          valid: true,
          canonicalPath: String.raw`D:\Blogs\local`,
          needsInstall: true,
        },
      }),
    )
    vi.mocked(api.blogs.install).mockResolvedValue(
      ok({
        valid: true,
        canonicalPath: String.raw`D:\Blogs\local`,
        needsInstall: false,
      }),
    )
    vi.mocked(api.blogs.addLocal).mockResolvedValue(ok(registry))
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    await user.click(await screen.findByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitem", { name: /添加本地博客/ }))
    expect(await screen.findByText(/需要安装依赖/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "安装依赖" }))
    await user.type(await screen.findByLabelText("显示名称"), "Local Garden")
    await user.click(screen.getByRole("button", { name: "添加此博客" }))

    expect(api.blogs.install).toHaveBeenCalledWith({ path: String.raw`D:\Blogs\local` })
    expect(api.blogs.addLocal).toHaveBeenCalledWith({
      path: String.raw`D:\Blogs\local`,
      name: "Local Garden",
    })
  })

  it("forwards clone progress, omits a blank optional name, refreshes, and unsubscribes", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const pending =
      deferred<
        ReturnType<typeof ok<{ canonicalPath: string; owner: string; repository: string }>>
      >()
    const unsubscribe = vi.fn()
    let progress: ((value: { phase: "cloning"; message: string }) => void) | undefined
    vi.mocked(api.blogs.onImportProgress).mockImplementation((listener) => {
      progress = listener as typeof progress
      return unsubscribe
    })
    vi.mocked(api.blogs.clone).mockReturnValue(pending.promise)
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    const view = render(<App />)

    await user.click(await screen.findByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitem", { name: /从 GitHub 下载/ }))
    await user.type(screen.getByLabelText("GitHub 仓库地址"), "https://github.com/acme/garden.git")
    await user.type(screen.getByLabelText("保存位置"), String.raw`D:\Blogs\garden`)
    await user.click(screen.getByRole("button", { name: /开始下载/ }))

    act(() => progress?.({ phase: "cloning", message: "正在安全下载…" }))
    expect(screen.getByRole("status", { name: "导入进度" })).toHaveTextContent("正在安全下载")
    await user.click(screen.getByRole("button", { name: "取消导入" }))
    expect(api.blogs.cancelImport).toHaveBeenCalledOnce()
    expect(api.blogs.clone).toHaveBeenCalledWith({
      url: "https://github.com/acme/garden.git",
      destination: String.raw`D:\Blogs\garden`,
      name: undefined,
    })
    pending.resolve(
      ok({ canonicalPath: String.raw`D:\Blogs\garden`, owner: "acme", repository: "garden" }),
    )
    await waitFor(() => expect(api.blogs.list).toHaveBeenCalledTimes(2))
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("routes rename, open-folder, and non-destructive removal through the blog API", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    await user.click(await screen.findByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitem", { name: "管理博客" }))

    await user.click(screen.getByRole("button", { name: "打开 Study Garden 文件夹" }))
    await waitFor(() => expect(api.blogs.openFolder).toHaveBeenCalledWith({ id: "study" }))

    await user.click(screen.getByRole("button", { name: "重命名 Study Garden" }))
    const name = screen.getByLabelText("博客名称")
    await user.clear(name)
    await user.type(name, "Study Notes")
    await user.click(screen.getByRole("button", { name: "保存名称" }))
    await waitFor(() =>
      expect(api.blogs.rename).toHaveBeenCalledWith({ id: "study", name: "Study Notes" }),
    )

    await user.click(screen.getByRole("button", { name: "从列表移除 Study Garden" }))
    await user.click(screen.getByRole("button", { name: "确认移除 Study Garden" }))
    await waitFor(() => expect(api.blogs.remove).toHaveBeenCalledWith({ id: "study" }))
  })

  it("saves the latest editor text before switching and refuses the switch after save failure", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const note = {
      path: "content/technology/switch.md",
      domain: "technology" as const,
      slug: "switch",
      title: "Switch",
      date: "2026-10-02",
      description: "switch test",
      visibility: "public" as const,
      updatedAt: "2026-10-02T00:00:00.000Z",
      tags: ["test"],
    }
    vi.mocked(api.notes.list).mockResolvedValue(ok([note]))
    vi.mocked(api.notes.read).mockResolvedValue(
      ok({ path: note.path, markdown: "# Before", mtimeMs: 1, contentHash: "a".repeat(64) }),
    )
    vi.mocked(api.notes.save).mockResolvedValue({
      ok: false,
      error: { code: "NOTE_FILE_WRITE_FAILED", message: "无法保存" },
    })
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    const textbox = await screen.findByRole("textbox")
    await waitFor(() => expect(textbox).toHaveAttribute("contenteditable", "true"))
    await user.click(textbox)
    await user.keyboard(" updated")
    await user.click(screen.getByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))

    await waitFor(() => expect(api.notes.save).toHaveBeenCalledOnce())
    expect(api.blogs.switch).not.toHaveBeenCalled()
    expect(await screen.findByRole("alert")).toHaveTextContent("当前笔记保存失败")

    vi.mocked(api.notes.save).mockImplementation(async (request) =>
      ok({
        path: request.path,
        updatedAt: "2026-10-02T00:01:00.000Z",
        mtimeMs: 2,
        contentHash: createHash("sha256").update(request.markdown).digest("hex"),
      }),
    )
    await user.click(screen.getByRole("button", { name: "关闭博客管理" }))
    await user.click(screen.getByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))
    await waitFor(() =>
      expect(api.blogs.switch).toHaveBeenCalledWith({ id: "study", editorSaved: true }),
    )
    expect(vi.mocked(api.notes.save).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(api.blogs.switch).mock.invocationCallOrder[0],
    )
  })

  it("locks the editor before the switch save barrier and unlocks only after switch failure", async () => {
    const user = userEvent.setup()
    const api = gardenApi()
    const pendingSwitch = deferred<IpcResult<void>>()
    const successfulSwitch = deferred<IpcResult<void>>()
    const note = {
      path: "content/technology/switch-barrier.md",
      domain: "technology" as const,
      slug: "switch-barrier",
      title: "Switch barrier",
      date: "2026-10-02",
      description: "switch barrier test",
      visibility: "public" as const,
      updatedAt: "2026-10-02T00:00:00.000Z",
      tags: ["test"],
    }
    vi.mocked(api.notes.list).mockResolvedValue(ok([note]))
    vi.mocked(api.notes.read).mockResolvedValue(
      ok({ path: note.path, markdown: "# Before", mtimeMs: 1, contentHash: "a".repeat(64) }),
    )
    vi.mocked(api.notes.save).mockImplementation(async (request) =>
      ok({
        path: request.path,
        updatedAt: "2026-10-02T00:01:00.000Z",
        mtimeMs: 2,
        contentHash: createHash("sha256").update(request.markdown).digest("hex"),
      }),
    )
    vi.mocked(api.blogs.switch)
      .mockReturnValueOnce(pendingSwitch.promise)
      .mockReturnValueOnce(successfulSwitch.promise)
    Object.defineProperty(window, "garden", { configurable: true, value: api })
    render(<App />)

    const textbox = await screen.findByRole("textbox")
    await waitFor(() => expect(textbox).toHaveAttribute("contenteditable", "true"))
    const editor = EditorView.findFromDOM(textbox)
    if (!editor) throw new Error("CodeMirror view not found")
    act(() => {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: "# Latest before switch" },
      })
    })
    await user.click(screen.getByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))

    await waitFor(() => expect(api.blogs.switch).toHaveBeenCalledOnce())
    expect(api.notes.save).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: "# Latest before switch" }),
    )
    expect(textbox).toHaveAttribute("contenteditable", "false")
    expect(screen.getByRole("status", { name: "编辑器切换状态" })).toHaveTextContent("编辑已暂停")
    act(() => {
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: " forbidden" },
      })
    })
    expect(editor.state.sliceDoc()).toBe("# Latest before switch")
    expect(api.notes.save).toHaveBeenCalledTimes(1)

    pendingSwitch.resolve({
      ok: false,
      error: { code: "BLOG_SWITCH_BUSY", message: "暂时无法切换博客。" },
    })
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法切换博客")
    await waitFor(() => expect(textbox).toHaveAttribute("contenteditable", "true"))
    act(() => {
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: " allowed" } })
    })
    expect(editor.state.sliceDoc()).toBe("# Latest before switch allowed")

    await user.click(screen.getByRole("button", { name: "关闭博客管理" }))
    await user.click(screen.getByRole("button", { name: /切换博客：Knowledge Garden/ }))
    await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))
    await waitFor(() => expect(api.blogs.switch).toHaveBeenCalledTimes(2))
    successfulSwitch.resolve(ok(undefined))
    await act(async () => void (await successfulSwitch.promise))
    expect(textbox).toHaveAttribute("contenteditable", "false")
  })
})
