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
import { APPEARANCE_PRESETS } from "../../src/shared/appearance"
import type {
  AppearanceSnapshot,
  ChangeReview,
  DomainSummary,
  BlogCandidateInspection,
  BlogImportReceipt,
  BlogRegistryView,
  BlogRegistryStatus,
  DeploymentHistory,
  GardenApi,
  GitCommit,
  IpcResult,
  NoteDocument,
  NoteSummary,
  NoteTransactionReceipt,
  NoteWriteReceipt,
  PreviewStatus,
  PublishProgress,
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

const domainSummaries: readonly DomainSummary[] = [
  {
    slug: "technology",
    name: "技术",
    description: "",
    tags: [],
    order: 1,
    publicNotes: 1,
    privateNotes: 0,
  },
  {
    slug: "reading",
    name: "阅读",
    description: "",
    tags: [],
    order: 2,
    publicNotes: 0,
    privateNotes: 1,
  },
  {
    slug: "language",
    name: "语言",
    description: "",
    tags: [],
    order: 3,
    publicNotes: 0,
    privateNotes: 0,
  },
  {
    slug: "life",
    name: "生活",
    description: "",
    tags: [],
    order: 4,
    publicNotes: 0,
    privateNotes: 0,
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

function deploymentHistory(
  headSha: string,
  status: DeploymentHistory["runs"][number]["status"] = "succeeded",
): DeploymentHistory {
  return {
    runs: [
      {
        id: "42",
        headSha,
        startedAt: "2026-10-15T00:00:01.000Z",
        completedAt: "2026-10-15T00:00:02.000Z",
        status,
        url: "https://github.com/octocat/garden/actions/runs/42",
      },
    ],
    actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
    liveSiteUrl: "https://octocat.github.io/garden/",
  }
}

function capturePublishProgress(api: GardenApi): {
  emit(progress: PublishProgress): void
} {
  let listener: ((progress: PublishProgress) => void) | undefined
  vi.mocked(api.publish.onProgress).mockImplementation((next) => {
    listener = next
    return () => undefined
  })
  return {
    emit(progress) {
      if (!listener) throw new Error("Publish progress listener is not subscribed")
      act(() => listener?.(progress))
    },
  }
}

const testRegistry: BlogRegistryStatus = {
  version: 1,
  activeAvailability: "available",
  activeBlogId: "00000000-0000-4000-8000-000000000000",
  blogs: [
    {
      id: "00000000-0000-4000-8000-000000000000",
      name: "Knowledge Garden",
      path: String.raw`C:\Users\11546\Desktop\web`,
      canonicalPath: String.raw`C:\Users\11546\Desktop\web`,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastOpenedAt: "2026-10-01T00:00:00.000Z",
      repository: { display: "https://github.com/me/garden", url: "https://github.com/me/garden" },
      website: { source: "manual", url: "https://garden.example.com/" },
    },
  ],
}

const twoBlogRegistry: BlogRegistryStatus = {
  ...testRegistry,
  blogs: [
    ...testRegistry.blogs,
    {
      id: "study",
      name: "Study Garden",
      path: String.raw`C:\Users\11546\Desktop\study`,
      canonicalPath: String.raw`C:\Users\11546\Desktop\study`,
      createdAt: "2026-10-02T00:00:00.000Z",
      lastOpenedAt: "2026-10-02T00:00:00.000Z",
      repository: { display: "未配置仓库" },
      website: { source: "unconfigured" },
    },
  ],
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
      list: vi.fn(async () => ok(testRegistry)),
      chooseLocal: vi.fn(async () => ok(undefined)),
      addLocal: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      recoverLocal: vi.fn(async () =>
        unavailable<BlogRegistryView>("博客服务将在后续任务中提供。"),
      ),
      clone: vi.fn(async () => unavailable<BlogImportReceipt>("博客服务将在后续任务中提供。")),
      cancelImport: vi.fn(async () => ok(undefined)),
      install: vi.fn(async () =>
        unavailable<BlogCandidateInspection>("博客服务将在后续任务中提供。"),
      ),
      rename: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      relocate: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      remove: vi.fn(async () => unavailable<BlogRegistryView>("博客服务将在后续任务中提供。")),
      openFolder: vi.fn(async () => ok(undefined)),
      openLink: vi.fn(async () => ok(undefined)),
      updateWebsite: vi.fn(async () => ok(testRegistry)),
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
    domains: {
      list: vi.fn(async () => ok(domainSummaries)),
      create: vi.fn(async () => ok(domainSummaries)),
      rename: vi.fn(async () => ok(domainSummaries)),
      updateMetadata: vi.fn(async () => ok(domainSummaries)),
      remove: vi.fn(async () => ok(domainSummaries)),
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
    images: {
      open: vi.fn(async ({ path }) => ok({ path, images: [] })),
      select: vi.fn(async () =>
        ok({ images: [] as const, conflicts: [] as const, cancelled: true as const }),
      ),
      commit: vi.fn(async ({ path }) => ok({ path, images: [] })),
      preview: vi.fn(),
      delete: vi.fn(async ({ path }) => ok({ path, images: [] })),
      copyMarkdown: vi.fn(async () => ok(undefined)),
    },
    preview: {
      start: vi.fn(async () => ok(ready)),
      stop: vi.fn(),
      status: vi.fn(async () => ok(ready)),
      revealSelection: vi.fn(async () => ok("found" as const)),
      onProgress: vi.fn(() => () => undefined),
    },
    appearance: {
      read: vi.fn(),
      chooseBackground: vi.fn(),
      preview: vi.fn(),
      clearPreview: vi.fn(),
      apply: vi.fn(),
      undo: vi.fn(),
    },
    changes: {
      list: vi.fn(async () => unavailable<ChangeReview>("变更服务暂不可用。")),
      cancel: vi.fn(async () => ok(undefined)),
    },
    publish: {
      start: vi.fn(),
      status: vi.fn(async () => ok({ active: false as const })),
      repairBranch: vi.fn(),
      cancel: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
    },
    history: {
      git: vi.fn(async () => unavailable<readonly GitCommit[]>("历史服务将在后续任务中提供。")),
      deployments: vi.fn(async () =>
        unavailable<DeploymentHistory>("部署历史将在后续任务中提供。"),
      ),
      clearCache: vi.fn(async () => ok(undefined)),
      cancel: vi.fn(async () => ok(undefined)),
      openLink: vi.fn(async () => ok(undefined)),
    },
  }
}

describe("publisher main layout", () => {
  async function openBlogManager(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /切换博客：/ }))
    await user.click(screen.getByRole("menuitem", { name: "管理博客" }))
    return screen.getByRole("dialog", { name: "管理博客" })
  }

  it("opens summary, menu, and manager addresses using only blog ID and kind", async () => {
    const user = userEvent.setup()
    const api = createGardenMock()
    render(<PublisherApp api={api} initialRegistry={testRegistry} />)
    await user.click(screen.getByRole("button", { name: "打开 Knowledge Garden 的仓库" }))
    expect(api.blogs.openLink).toHaveBeenLastCalledWith({
      id: testRegistry.activeBlogId,
      kind: "repository",
    })
    await user.click(screen.getByRole("button", { name: /切换博客：/ }))
    await user.click(screen.getByRole("menuitem", { name: "打开 Knowledge Garden 的网站" }))
    expect(api.blogs.openLink).toHaveBeenLastCalledWith({
      id: testRegistry.activeBlogId,
      kind: "website",
    })
    const dialog = await openBlogManager(user)
    await user.click(within(dialog).getByRole("button", { name: "打开 Knowledge Garden 的网站" }))
    expect(api.blogs.openLink).toHaveBeenCalledTimes(3)
    expect(api.blogs.openLink).toHaveBeenLastCalledWith({
      id: testRegistry.activeBlogId,
      kind: "website",
    })
  })

  it("shows safe open failures in the manager without losing registry addresses", async () => {
    const user = userEvent.setup()
    const api = createGardenMock()
    vi.mocked(api.blogs.openLink).mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "无法打开网站，请重试。" },
    })
    render(<PublisherApp api={api} initialRegistry={testRegistry} />)
    await user.click(screen.getByRole("button", { name: "打开 Knowledge Garden 的网站" }))
    const dialog = await screen.findByRole("dialog", { name: "管理博客" })
    expect(within(dialog).getByRole("alert")).toHaveTextContent("无法打开网站，请重试。")
    expect(within(dialog).getByTitle("https://garden.example.com/")).toBeVisible()
  })

  it.each(["manual", "quartz", "unconfigured"] as const)(
    "refreshes every website instance after a %s save result",
    async (source) => {
      const user = userEvent.setup()
      const api = createGardenMock()
      const pending = deferred<IpcResult<BlogRegistryView>>()
      vi.mocked(api.blogs.updateWebsite).mockReturnValue(pending.promise)
      render(<PublisherApp api={api} initialRegistry={testRegistry} />)
      const dialog = await openBlogManager(user)
      await user.click(
        within(dialog).getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }),
      )
      const input = screen.getByRole("textbox", { name: "网站地址" })
      expect(input).toHaveValue("https://garden.example.com/")
      await user.clear(input)
      if (source === "manual") await user.type(input, "  normalized.example.com/blog  ")
      await user.click(screen.getByRole("button", { name: "保存网站地址" }))
      expect(api.blogs.updateWebsite).toHaveBeenCalledExactlyOnceWith({
        id: testRegistry.activeBlogId,
        websiteUrl: source === "manual" ? "normalized.example.com/blog" : null,
      })
      expect(input).toBeDisabled()
      const website =
        source === "unconfigured"
          ? { source }
          : { source, url: "https://normalized.example.com/blog" }
      await act(async () =>
        pending.resolve(ok({ ...testRegistry, blogs: [{ ...testRegistry.blogs[0], website }] })),
      )
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "网站地址" })).toBeNull())
      const label = source === "unconfigured" ? "未配置网站" : "https://normalized.example.com/blog"
      expect(screen.getAllByTitle(label)).toHaveLength(2)
      await user.click(screen.getByRole("button", { name: "关闭博客管理" }))
      await user.click(screen.getByRole("button", { name: /切换博客：/ }))
      expect(within(screen.getByRole("menu")).getByTitle(label)).toBeVisible()
    },
  )

  it("retains an invalid website draft and safe backend error", async () => {
    const user = userEvent.setup()
    const api = createGardenMock()
    vi.mocked(api.blogs.updateWebsite).mockResolvedValue({
      ok: false,
      error: { code: "INVALID_INPUT", message: "网站地址必须使用 HTTP 或 HTTPS。" },
    })
    render(<PublisherApp api={api} initialRegistry={testRegistry} />)
    await openBlogManager(user)
    await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
    const input = screen.getByRole("textbox", { name: "网站地址" })
    await user.clear(input)
    await user.type(input, "  javascript:bad  ")
    await user.click(screen.getByRole("button", { name: "保存网站地址" }))
    expect(await screen.findByText("网站地址必须使用 HTTP 或 HTTPS。")).toBeVisible()
    expect(input).toHaveValue("  javascript:bad  ")
    expect(input).toBeEnabled()
  })

  it("ignores an older startup list after a newer website mutation and serializes mutations", async () => {
    const user = userEvent.setup()
    const stale = deferred<IpcResult<BlogRegistryStatus>>()
    vi.mocked(garden.blogs.list).mockReturnValueOnce(stale.promise)
    const saved: BlogRegistryView = {
      ...testRegistry,
      blogs: [
        {
          ...testRegistry.blogs[0],
          website: { source: "manual", url: "https://new.example.com/" },
        },
      ],
    }
    const updating = deferred<IpcResult<BlogRegistryView>>()
    vi.mocked(garden.blogs.updateWebsite).mockReturnValue(updating.promise)
    render(
      <StrictMode>
        <StartupApp />
      </StrictMode>,
    )
    await screen.findByRole("button", { name: /切换博客：/ })
    await openBlogManager(user)
    await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
    const input = screen.getByRole("textbox", { name: "网站地址" })
    await user.clear(input)
    await user.type(input, "new.example.com")
    await user.click(screen.getByRole("button", { name: "保存网站地址" }))
    fireEvent.submit(input.closest("form")!)
    fireEvent.click(screen.getByRole("button", { name: "重命名 Knowledge Garden" }))
    expect(garden.blogs.updateWebsite).toHaveBeenCalledTimes(1)
    expect(garden.blogs.rename).not.toHaveBeenCalled()
    await act(async () => updating.resolve(ok(saved)))
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "网站地址" })).toBeNull())
    await act(async () => stale.resolve(ok(testRegistry)))
    expect(screen.getAllByTitle("https://new.example.com/")).toHaveLength(2)
    expect(screen.queryByTitle("https://garden.example.com/")).toBeNull()
  })

  it("supports website editing and safe link opening for registered recovery blogs", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.blogs.list).mockResolvedValue(
      ok({ ...testRegistry, activeAvailability: "unavailable" }),
    )
    render(<StartupApp />)
    const dialog = await screen.findByRole("dialog", { name: "博客恢复" })
    await user.click(within(dialog).getByRole("button", { name: "打开 Knowledge Garden 的网站" }))
    expect(garden.blogs.openLink).toHaveBeenCalledWith({
      id: testRegistry.activeBlogId,
      kind: "website",
    })
    await user.click(screen.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }))
    await user.clear(screen.getByRole("textbox", { name: "网站地址" }))
    await user.click(screen.getByRole("button", { name: "保存网站地址" }))
    expect(garden.blogs.updateWebsite).toHaveBeenCalledWith({
      id: testRegistry.activeBlogId,
      websiteUrl: null,
    })
  })

  let garden: GardenApi
  const App = (): React.JSX.Element => <PublisherApp api={garden} initialRegistry={testRegistry} />

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

  function enableAppearance(api: GardenApi): AppearanceSnapshot {
    const snapshot: AppearanceSnapshot = {
      framework: "quartz",
      supported: true,
      settings: APPEARANCE_PRESETS.paper,
      baselineHash: "a".repeat(64),
      canUndo: true,
    }
    vi.mocked(api.appearance.read).mockResolvedValue(ok(snapshot))
    vi.mocked(api.appearance.preview).mockImplementation(async ({ sessionId }) => ok({ sessionId }))
    vi.mocked(api.appearance.clearPreview).mockResolvedValue(ok(undefined))
    vi.mocked(api.appearance.apply).mockResolvedValue(
      ok({ snapshot: { ...snapshot, baselineHash: "b".repeat(64) } }),
    )
    vi.mocked(api.appearance.undo).mockResolvedValue(
      ok({ snapshot: { ...snapshot, baselineHash: "b".repeat(64), canUndo: false } }),
    )
    return snapshot
  }

  it("places the active-blog appearance entry beside domains and uses only the last good preview", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    vi.mocked(garden.preview.status).mockResolvedValue(
      ok({
        state: "building",
        generation: 7,
        url: "http://127.0.0.1:8080/current-build/",
        lastSuccessfulUrl: "http://127.0.0.1:8080/last-good/",
      }),
    )
    render(<App />)

    const domains = screen.getByRole("button", { name: "管理领域" })
    const appearance = screen.getByRole("button", { name: "外观" })
    expect(domains.nextElementSibling).toBe(appearance)
    await user.click(appearance)

    expect(await screen.findByRole("dialog", { name: "外观设置" })).toBeVisible()
    expect(garden.appearance.read).toHaveBeenCalledOnce()
    await waitFor(() => expect(garden.appearance.preview).toHaveBeenCalledOnce())
    const previewRequest = vi.mocked(garden.appearance.preview).mock.calls[0]![0]
    const previewUrl = new URL(previewRequest.url)
    expect(`${previewUrl.origin}${previewUrl.pathname}`).toBe("http://127.0.0.1:8080/last-good/")
    expect(previewUrl.searchParams.get("kgpAppearance")).toBe(previewRequest.sessionId)
    expect(
      vi.mocked(garden.appearance.preview).mock.calls.map(([request]) => {
        const url = new URL(request.url)
        return `${url.origin}${url.pathname}`
      }),
    ).not.toContain("http://127.0.0.1:8080/current-build/")
  })

  it("flushes the current Markdown before appearance apply and refreshes changes without publishing", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    vi.mocked(garden.changes.list)
      .mockResolvedValueOnce(ok({ groups: [] }))
      .mockResolvedValue(
        ok({
          groups: [
            {
              id: "appearance:publisher-appearance",
              label: "外观修改",
              kind: "appearance",
              selection: "optional",
              description: "博客背景、主题配色与排版；选择后发布到线上站点。",
              paths: [
                "quartz/styles/publisher-appearance.json",
                "quartz/styles/publisher-appearance.scss",
              ],
              attachments: [],
            },
          ],
        }),
      )
    vi.mocked(garden.notes.save).mockImplementation(async (request) =>
      ok({
        path: request.path,
        updatedAt: "2026-10-30T10:00:00.000Z",
        mtimeMs: 3,
        contentHash: markdownHash(request.markdown),
      }),
    )
    render(<App />)

    await user.click(await screen.findByRole("button", { name: /CSS Grid 布局/ }))
    const textbox = await screen.findByRole("textbox")
    const editor = EditorView.findFromDOM(textbox)
    if (!editor) throw new Error("CodeMirror view not found")
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nchanged" } }))

    await user.click(screen.getByRole("button", { name: "外观" }))
    fireEvent.change(await screen.findByLabelText("强调色"), { target: { value: "#112233" } })
    await user.click(screen.getByRole("button", { name: "一键应用" }))

    await waitFor(() => expect(garden.appearance.apply).toHaveBeenCalledOnce())
    expect(garden.notes.save).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: expect.stringContaining("changed") }),
    )
    expect(vi.mocked(garden.notes.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(garden.appearance.apply).mock.invocationCallOrder[0],
    )
    expect(garden.publish.start).not.toHaveBeenCalled()
    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("可发布变化：1")).toBeVisible()
  })

  it("disables appearance while publication is preparing the current Markdown", async () => {
    const user = userEvent.setup()
    const saving = deferred<Awaited<ReturnType<GardenApi["notes"]["save"]>>>()
    vi.mocked(garden.notes.save).mockReturnValue(saving.promise)
    vi.mocked(garden.changes.list).mockResolvedValue(
      ok({
        groups: [
          {
            id: "note:publish",
            label: "Publish",
            kind: "modified",
            selection: "default",
            description: "待发布笔记",
            paths: [notes[0].path],
            attachments: [],
          },
        ],
      }),
    )
    vi.mocked(garden.publish.start).mockResolvedValue(ok({ operationId: "publish-appearance" }))
    render(<App />)

    await user.click(await screen.findByRole("button", { name: /CSS Grid 布局/ }))
    const textbox = await screen.findByRole("textbox")
    const editor = EditorView.findFromDOM(textbox)
    if (!editor) throw new Error("CodeMirror view not found")
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\npublish" } }))
    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    await user.click(await screen.findByRole("button", { name: "验证并发布" }))

    expect(screen.getByRole("button", { name: "外观", hidden: true })).toBeDisabled()
    saving.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-10-30T10:00:00.000Z",
        mtimeMs: 3,
        contentHash: "c".repeat(64),
      }),
    )
    await act(async () => void (await saving.promise))
  })

  it("disables appearance while repairing the branch before a publication retry", async () => {
    const user = userEvent.setup()
    const repairing = deferred<Awaited<ReturnType<GardenApi["publish"]["repairBranch"]>>>()
    vi.mocked(garden.changes.list).mockResolvedValue(
      ok({
        groups: [
          {
            id: "note:repair",
            label: "Repair",
            kind: "modified",
            selection: "default",
            description: "待修复分支后发布",
            paths: [notes[0].path],
            attachments: [],
          },
        ],
      }),
    )
    vi.mocked(garden.publish.start)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "PUBLISH_BRANCH_REPAIR_REQUIRED",
          message: "需要安全切换到 main。",
        },
      })
      .mockResolvedValueOnce(ok({ operationId: "publish-after-repair" }))
    vi.mocked(garden.publish.repairBranch).mockReturnValue(repairing.promise)
    render(<App />)

    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    await user.click(await screen.findByRole("button", { name: "验证并发布" }))
    await user.click(await screen.findByRole("button", { name: "安全切换到 main 并继续" }))

    expect(screen.getByRole("button", { name: "外观", hidden: true })).toBeDisabled()
    repairing.resolve(ok({ branch: "main", upstream: "origin/main", head: "a".repeat(40) }))
    await waitFor(() => expect(garden.publish.start).toHaveBeenCalledTimes(2))
  })

  it.each([
    ["complete", "发布成功", 100],
    ["failed", "发布失败", undefined],
    ["failed", "发布已取消", undefined],
  ] as const)(
    "keeps appearance disabled for the active publish operation until %s: %s",
    async (phase, message, percent) => {
      const user = userEvent.setup()
      const progress = capturePublishProgress(garden)
      enableAppearance(garden)
      vi.mocked(garden.changes.list).mockResolvedValue(
        ok({
          groups: [
            {
              id: "note:active-publish",
              label: "Active publish",
              kind: "modified",
              selection: "default",
              description: "正在发布",
              paths: [notes[0].path],
              attachments: [],
            },
          ],
        }),
      )
      vi.mocked(garden.publish.start).mockResolvedValue(ok({ operationId: "publish-active" }))
      render(<App />)

      await user.click(screen.getByRole("button", { name: "检查并发布" }))
      await user.click(await screen.findByRole("button", { name: "验证并发布" }))
      await waitFor(() => expect(garden.publish.start).toHaveBeenCalledOnce())

      const appearance = screen.getByRole("button", { name: "外观" })
      expect(appearance).toBeDisabled()
      fireEvent.click(appearance)
      expect(garden.appearance.read).not.toHaveBeenCalled()

      progress.emit({ phase, message, ...(percent === undefined ? {} : { percent }) })
      await waitFor(() => expect(appearance).toBeEnabled())
    },
  )

  it("restores the active publish interlock after the renderer remounts", async () => {
    enableAppearance(garden)
    vi.mocked(garden.publish.status).mockResolvedValue(
      ok({ active: true as const, operationId: "publish-remount" }),
    )

    const first = render(<App />)
    await waitFor(() => expect(screen.getByRole("button", { name: "外观" })).toBeDisabled())
    first.unmount()

    render(<App />)
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledTimes(2))
    expect(screen.getByRole("button", { name: "外观", hidden: true })).toBeDisabled()
  })

  it("does not let a stale active status overwrite a newer terminal publish event", async () => {
    enableAppearance(garden)
    const status = deferred<Awaited<ReturnType<GardenApi["publish"]["status"]>>>()
    vi.mocked(garden.publish.status).mockReturnValue(status.promise)
    const progress = capturePublishProgress(garden)
    render(<App />)
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledOnce())

    progress.emit({ phase: "failed", message: "发布已取消" })
    status.resolve(ok({ active: true as const, operationId: "stale-operation" }))
    await act(async () => void (await status.promise))

    expect(screen.getByRole("button", { name: "外观" })).toBeEnabled()
  })

  it("does not let a stale inactive status overwrite a newer active publish event", async () => {
    enableAppearance(garden)
    const status = deferred<Awaited<ReturnType<GardenApi["publish"]["status"]>>>()
    vi.mocked(garden.publish.status).mockReturnValue(status.promise)
    const progress = capturePublishProgress(garden)
    render(<App />)
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledOnce())

    progress.emit({ phase: "pushing", message: "正在推送…", percent: 80 })
    status.resolve(ok({ active: false as const }))
    await act(async () => void (await status.promise))

    expect(screen.getByRole("button", { name: "外观" })).toBeDisabled()
  })

  it("keeps the interlock when start reports that a publication is already running", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    vi.mocked(garden.publish.start).mockResolvedValue({
      ok: false,
      error: { code: "INVALID_INPUT", message: "A publication is already running." },
    })
    vi.mocked(garden.publish.status)
      .mockResolvedValueOnce(ok({ active: false as const }))
      .mockResolvedValueOnce(ok({ active: true as const, operationId: "publish-existing" }))
    vi.mocked(garden.changes.list).mockResolvedValue(
      ok({
        groups: [
          {
            id: "note:existing-publish",
            label: "Existing publish",
            kind: "modified",
            selection: "default",
            description: "changed",
            paths: [notes[0].path],
            attachments: [],
          },
        ],
      }),
    )
    render(<App />)
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledOnce())

    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    await user.click(await screen.findByRole("button", { name: "验证并发布" }))
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledTimes(2))

    expect(screen.getByRole("button", { name: "外观", hidden: true })).toBeDisabled()
  })

  it("releases the interlock when a rejected start is confirmed inactive", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    vi.mocked(garden.publish.start).mockResolvedValue({
      ok: false,
      error: { code: "INVALID_INPUT", message: "The publication selection is invalid." },
    })
    vi.mocked(garden.publish.status).mockResolvedValue(ok({ active: false as const }))
    vi.mocked(garden.changes.list).mockResolvedValue(
      ok({
        groups: [
          {
            id: "note:rejected-publish",
            label: "Rejected publish",
            kind: "modified",
            selection: "default",
            description: "changed",
            paths: [notes[0].path],
            attachments: [],
          },
        ],
      }),
    )
    render(<App />)
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledOnce())

    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    await user.click(await screen.findByRole("button", { name: "验证并发布" }))
    await waitFor(() => expect(garden.publish.status).toHaveBeenCalledTimes(2))

    expect(screen.getByRole("button", { name: "外观", hidden: true })).toBeEnabled()
  })

  it("refreshes an already-open publication review after undo without publishing", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    render(<App />)

    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    await screen.findByRole("dialog", { name: "检查并发布" })
    const beforeUndo = vi.mocked(garden.changes.list).mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: "外观", hidden: true }))
    await screen.findByRole("dialog", { name: "外观设置" })
    await user.click(screen.getByRole("button", { name: "撤销上次应用" }))

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(beforeUndo + 1))
    expect(garden.publish.start).not.toHaveBeenCalled()
  })

  it("does not apply an appearance flush that became stale during a blog switch", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    const saving = deferred<Awaited<ReturnType<GardenApi["notes"]["save"]>>>()
    vi.mocked(garden.notes.save).mockReturnValue(saving.promise)
    vi.mocked(garden.blogs.switch).mockResolvedValue(ok(undefined))
    render(<PublisherApp api={garden} initialRegistry={twoBlogRegistry} />)

    await user.click(await screen.findByRole("button", { name: /CSS Grid 布局/ }))
    const textbox = await screen.findByRole("textbox")
    const editor = EditorView.findFromDOM(textbox)
    if (!editor) throw new Error("CodeMirror view not found")
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nstale" } }))
    await user.click(screen.getByRole("button", { name: "外观" }))
    fireEvent.change(await screen.findByLabelText("强调色"), { target: { value: "#112233" } })
    await user.click(screen.getByRole("button", { name: "一键应用" }))
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledOnce())

    fireEvent.click(
      screen.getByRole("button", { name: /切换博客：Knowledge Garden/, hidden: true }),
    )
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Study Garden/, hidden: true }))
    saving.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-10-30T10:00:00.000Z",
        mtimeMs: 3,
        contentHash: markdownHash(`${documents.get(notes[0].path)!.markdown}\nstale`),
      }),
    )

    await waitFor(() => expect(garden.blogs.switch).toHaveBeenCalledOnce())
    expect(garden.appearance.apply).not.toHaveBeenCalled()
  })

  it("closes and clears an appearance session before switching blogs", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    const order: string[] = []
    vi.mocked(garden.appearance.clearPreview).mockImplementation(async () => {
      order.push("clear")
      return ok(undefined)
    })
    const switching = deferred<IpcResult<void>>()
    vi.mocked(garden.blogs.switch).mockImplementation(() => {
      order.push("switch")
      return switching.promise
    })
    render(<PublisherApp api={garden} initialRegistry={twoBlogRegistry} />)

    await user.click(screen.getByRole("button", { name: "外观" }))
    await waitFor(() => expect(garden.appearance.preview).toHaveBeenCalledOnce())
    fireEvent.click(
      screen.getByRole("button", { name: /切换博客：Knowledge Garden/, hidden: true }),
    )
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Study Garden/, hidden: true }))

    await waitFor(() => expect(garden.blogs.switch).toHaveBeenCalledOnce())
    expect(screen.queryByRole("dialog", { name: "外观设置" })).not.toBeInTheDocument()
    expect(order).toEqual(["clear", "switch"])
    expect(screen.getByRole("button", { name: "外观", hidden: true })).toBeDisabled()
    expect(garden.publish.start).not.toHaveBeenCalled()
    switching.resolve(ok(undefined))
  })

  it("keeps the appearance session open and aborts a blog switch when preview cleanup fails", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    vi.mocked(garden.appearance.clearPreview).mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "无法清理旧外观预览" },
    })
    render(<PublisherApp api={garden} initialRegistry={twoBlogRegistry} />)

    await user.click(screen.getByRole("button", { name: "外观" }))
    await waitFor(() => expect(garden.appearance.preview).toHaveBeenCalledOnce())
    fireEvent.click(
      screen.getByRole("button", { name: /切换博客：Knowledge Garden/, hidden: true }),
    )
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Study Garden/, hidden: true }))

    expect(await screen.findByRole("alert")).toHaveTextContent("无法清理旧外观预览")
    expect(screen.getByRole("dialog", { name: "外观设置" })).toBeVisible()
    expect(garden.blogs.switch).not.toHaveBeenCalled()
    expect(garden.appearance.clearPreview).toHaveBeenCalledOnce()
  })

  it("invalidates a pending appearance apply and clears its preview when App unmounts", async () => {
    const user = userEvent.setup()
    enableAppearance(garden)
    const saving = deferred<Awaited<ReturnType<GardenApi["notes"]["save"]>>>()
    vi.mocked(garden.notes.save).mockReturnValue(saving.promise)
    const view = render(<App />)

    await user.click(await screen.findByRole("button", { name: /CSS Grid 布局/ }))
    const textbox = await screen.findByRole("textbox")
    const editor = EditorView.findFromDOM(textbox)
    if (!editor) throw new Error("CodeMirror view not found")
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nunmount" } }))
    await user.click(screen.getByRole("button", { name: "外观" }))
    fireEvent.change(await screen.findByLabelText("强调色"), { target: { value: "#112233" } })
    await waitFor(() => expect(garden.appearance.preview).toHaveBeenCalledOnce())
    const sessionId = vi.mocked(garden.appearance.preview).mock.calls[0]![0].sessionId
    await user.click(screen.getByRole("button", { name: "一键应用" }))
    await waitFor(() => expect(garden.notes.save).toHaveBeenCalledOnce())

    view.unmount()
    expect(garden.appearance.clearPreview).toHaveBeenCalledWith({ sessionId })
    saving.resolve(
      ok({
        path: notes[0].path,
        updatedAt: "2026-10-30T10:00:00.000Z",
        mtimeMs: 3,
        contentHash: markdownHash(`${documents.get(notes[0].path)!.markdown}\nunmount`),
      }),
    )
    await act(async () => void (await saving.promise))
    expect(garden.appearance.apply).not.toHaveBeenCalled()
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
    const user = userEvent.setup()
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
      expect(garden.notes.list).toHaveBeenCalledOnce()
    })
    expect(screen.getByText("origin/main is temporarily unreachable.")).toBeVisible()
    expect(screen.getByText("The preferred preview port is occupied.")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "关闭启动检查提示" }))
    expect(screen.queryByRole("region", { name: "启动检查" })).not.toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Markdown 编辑器" })).toBeVisible()
  })

  it("reports when the preview port remains occupied after retrying diagnostics", async () => {
    vi.mocked(garden.workspace.inspect).mockResolvedValue(
      ok({
        ok: false,
        root: String.raw`C:\Users\11546\Desktop\web`,
        capabilities: { files: true, preview: true, git: true, publish: false },
        issues: [
          { code: "PREVIEW_PORT_UNAVAILABLE", message: "The preferred preview port is occupied." },
        ],
      }),
    )

    render(<StartupApp />)

    await screen.findByRole("button", { name: "重新检查" })
    await waitFor(() => expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }))
    await waitFor(() => expect(garden.workspace.inspect).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("重新检查完成：预览端口仍被占用。")).toBeVisible()
  })

  it("clears stale occupied-port feedback before a repair-triggered reinspection", async () => {
    const occupiedWithRepair = ok<WorkspaceInspection>({
      ok: false,
      root: String.raw`C:\Users\11546\Desktop\web`,
      capabilities: { files: true, preview: false, git: true, publish: false },
      issues: [
        {
          code: "DEPENDENCIES_MISSING",
          message: "Dependencies are missing.",
          repair: "install-dependencies",
        },
        { code: "PREVIEW_PORT_UNAVAILABLE", message: "The preferred preview port is occupied." },
      ],
    })
    vi.mocked(garden.workspace.inspect).mockReset().mockResolvedValue(occupiedWithRepair)

    render(<StartupApp />)

    await waitFor(() => expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled())
    await waitFor(() => expect(garden.workspace.inspect).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }))
    await waitFor(() => expect(garden.workspace.inspect).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("重新检查完成：预览端口仍被占用。")).toBeVisible()

    vi.mocked(garden.workspace.inspect).mockResolvedValue(
      ok({
        ok: false,
        root: String.raw`C:\Users\11546\Desktop\web`,
        capabilities: { files: true, preview: true, git: false, publish: false },
        issues: [
          { code: "GIT_ORIGIN_UNREACHABLE", message: "origin/main is temporarily unreachable." },
        ],
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: "安装仓库依赖" }))
    await waitFor(() => expect(garden.workspace.inspect).toHaveBeenCalledTimes(3))
    expect(screen.queryByText("重新检查完成：预览端口仍被占用。")).not.toBeInTheDocument()
    expect(screen.getByText("origin/main is temporarily unreachable.")).toBeVisible()
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
    render(<PublisherApp api={garden} initialRegistry={testRegistry} />)
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

  it("ignores stale preview events and does not render a stale frame after an error", async () => {
    let progress: ((status: PreviewStatus) => void) | undefined
    vi.mocked(garden.preview.onProgress).mockImplementation((listener) => {
      progress = listener
      return () => undefined
    })
    render(<App />)
    const preview = await screen.findByRole("region", { name: "本地预览" })
    await userEvent.click(within(preview).getByRole("tab", { name: "全站本地" }))

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
    expect(await within(preview).findByTitle("Quartz 本地全站预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:9000/",
    )

    act(() => {
      progress?.({
        state: "error",
        generation: 5,
        error: { code: "PREVIEW_BUILD_FAILED", message: "新错误" },
      })
    })
    expect(within(preview).getByText("新错误")).toBeVisible()
    expect(within(preview).queryByTitle("Quartz 本地全站预览")).not.toBeInTheDocument()
    expect(within(preview).getByText("本地全站尚未就绪")).toBeVisible()
  })

  it("reports a rejected preview status request without an unhandled bootstrap failure", async () => {
    vi.mocked(garden.preview.status).mockRejectedValueOnce(new Error("状态通道断开"))
    render(<App />)

    const preview = await screen.findByRole("region", { name: "本地预览" })
    await userEvent.click(within(preview).getByRole("tab", { name: "全站本地" }))
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

  it("renders a custom fifth domain in filters and the new-note selector", async () => {
    const user = userEvent.setup()
    const customDomains = [
      ...domainSummaries,
      {
        slug: "craft",
        name: "创作",
        description: "",
        tags: [],
        order: 5,
        publicNotes: 0,
        privateNotes: 0,
      },
    ] as const
    vi.mocked(garden.domains.list).mockResolvedValueOnce(ok(customDomains))
    render(<App />)

    const navigation = await screen.findByRole("navigation", { name: "笔记" })
    expect(within(navigation).getByRole("button", { name: "创作" })).toBeVisible()
    await user.click(within(navigation).getByRole("button", { name: "新建笔记" }))
    expect(
      within(screen.getByRole("dialog", { name: "新建笔记" })).getByRole("option", {
        name: "创作",
      }),
    ).toHaveValue("craft")
  })

  it("treats a custom slug named all as a real domain, not the all sentinel", async () => {
    const user = userEvent.setup()
    const customDomains = [
      ...domainSummaries,
      {
        slug: "all",
        name: "全量资料",
        description: "",
        tags: [],
        order: 5,
        publicNotes: 0,
        privateNotes: 0,
      },
    ] as const
    const customNote: NoteSummary = {
      path: "content/all/custom.md",
      domain: "all",
      slug: "custom",
      title: "全量资料笔记",
      date: "2026-09-19",
      description: "custom slug",
      visibility: "public",
      updatedAt: "2026-09-24T08:00:00.000Z",
      tags: [],
    }
    vi.mocked(garden.domains.list).mockResolvedValueOnce(ok(customDomains))
    vi.mocked(garden.notes.list).mockResolvedValueOnce(ok([...notes, customNote]))
    render(<App />)

    const navigation = await screen.findByRole("navigation", { name: "笔记" })
    const customFilter = within(navigation).getByRole("button", { name: "全量资料" })
    await user.click(customFilter)
    expect(customFilter).toHaveAttribute("aria-pressed", "true")
    expect(within(navigation).getByRole("button", { name: /全量资料笔记/ })).toBeVisible()
    expect(
      within(navigation).queryByRole("button", { name: /CSS Grid 布局/ }),
    ).not.toBeInTheDocument()
    expect(within(navigation).getByRole("button", { name: "全部领域" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  })

  it("reconciles a new-note selection when domains arrive after the dialog opens", async () => {
    const user = userEvent.setup()
    const pendingDomains = deferred<IpcResult<readonly DomainSummary[]>>()
    vi.mocked(garden.domains.list).mockReturnValueOnce(pendingDomains.promise)
    render(<App />)

    await user.click(screen.getByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "延迟领域")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "延迟领域描述")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), "测试")
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled()

    pendingDomains.resolve(ok(domainSummaries))
    await waitFor(() =>
      expect(within(dialog).getByRole("combobox", { name: "领域" })).toHaveValue("technology"),
    )
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "创建" })).toBeEnabled())
  })

  it("does not let an old domain load overwrite a mutation response", async () => {
    const user = userEvent.setup()
    const oldLoad = deferred<IpcResult<readonly DomainSummary[]>>()
    const createdDomains = [
      ...domainSummaries,
      {
        slug: "craft",
        name: "创作",
        description: "",
        tags: [],
        order: 5,
        publicNotes: 0,
        privateNotes: 0,
      },
    ] as const
    vi.mocked(garden.domains.list).mockReturnValueOnce(oldLoad.promise)
    vi.mocked(garden.domains.create).mockResolvedValueOnce(ok(createdDomains))
    render(<App />)

    await user.click(screen.getByRole("button", { name: "管理领域" }))
    await user.click(screen.getByRole("button", { name: "新建领域" }))
    const dialog = screen.getByRole("dialog", { name: "新建领域" })
    await user.type(within(dialog).getByLabelText("显示名称"), "创作")
    await user.type(within(dialog).getByLabelText("英文路径"), "craft")
    await user.click(within(dialog).getByRole("button", { name: "创建领域" }))
    await waitFor(() => expect(screen.getByRole("article", { name: "创作" })).toBeVisible())

    oldLoad.resolve(ok(domainSummaries))
    await Promise.resolve()
    expect(screen.getByRole("article", { name: "创作" })).toBeVisible()
  })

  it("updates domain metadata from the manager without note or publish side effects", async () => {
    const user = userEvent.setup()
    const updatedDomains = domainSummaries.map((domain) =>
      domain.slug === "technology"
        ? { ...domain, description: "工程与工具", tags: ["工程", "实践"] }
        : domain,
    )
    vi.mocked(garden.domains.updateMetadata).mockResolvedValueOnce(ok(updatedDomains))
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "管理领域" }))
    const manager = screen.getByRole("dialog", { name: "管理领域" })
    await user.click(within(manager).getByRole("button", { name: "编辑 技术 的信息" }))
    await user.type(screen.getByLabelText("描述（选填）"), " 工程与工具 ")
    await user.type(screen.getByLabelText("标签（选填）"), "工程，实践, 工程")

    vi.clearAllMocks()
    await user.click(screen.getByRole("button", { name: "保存信息" }))

    await waitFor(() =>
      expect(garden.domains.updateMetadata).toHaveBeenCalledWith({
        slug: "technology",
        description: "工程与工具",
        tags: ["工程", "实践"],
      }),
    )
    const updatedCard = screen.getByRole("article", { name: "技术" })
    expect(within(updatedCard).getByText("工程与工具")).toBeVisible()
    expect(within(updatedCard).getByText("工程")).toBeVisible()
    expect(within(updatedCard).getByText("实践")).toBeVisible()
    expect(garden.notes.save).not.toHaveBeenCalled()
    expect(garden.notes.list).not.toHaveBeenCalled()
    expect(garden.notes.read).not.toHaveBeenCalled()
    expect(garden.notes.rename).not.toHaveBeenCalled()
    expect(garden.notes.changeVisibility).not.toHaveBeenCalled()
    expect(garden.publish.start).not.toHaveBeenCalled()
  })

  it("restarts domain loading after a failed mutation invalidates startup loading", async () => {
    const user = userEvent.setup()
    const startup = deferred<IpcResult<readonly DomainSummary[]>>()
    const replacement = deferred<IpcResult<readonly DomainSummary[]>>()
    let listRequest = 0
    vi.mocked(garden.domains.list).mockImplementation(() => {
      listRequest += 1
      return listRequest === 1 ? startup.promise : replacement.promise
    })
    vi.mocked(garden.domains.create).mockRejectedValueOnce(new Error("创建领域失败"))
    vi.mocked(garden.domains.create).mockResolvedValueOnce(unavailable("领域服务失败"))
    render(<App />)

    await user.click(screen.getByRole("button", { name: "管理领域" }))
    await user.click(screen.getByRole("button", { name: "新建领域" }))
    const dialog = screen.getByRole("dialog", { name: "新建领域" })
    await user.type(within(dialog).getByLabelText("显示名称"), "失败领域")
    await user.type(within(dialog).getByLabelText("英文路径"), "failed-domain")
    await user.click(within(dialog).getByRole("button", { name: "创建领域" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("创建领域失败")
    expect(garden.domains.list).toHaveBeenCalledTimes(2)

    replacement.resolve(ok(domainSummaries))
    await user.click(screen.getByRole("button", { name: "关闭" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "技术" })).toBeVisible())

    await user.click(screen.getByRole("button", { name: "管理领域" }))
    await user.click(screen.getByRole("button", { name: "新建领域" }))
    const serviceFailureDialog = screen.getByRole("dialog", { name: "新建领域" })
    await user.type(within(serviceFailureDialog).getByLabelText("显示名称"), "服务失败")
    await user.type(within(serviceFailureDialog).getByLabelText("英文路径"), "service-failure")
    await user.click(within(serviceFailureDialog).getByRole("button", { name: "创建领域" }))
    expect(await within(serviceFailureDialog).findByRole("alert")).toHaveTextContent("领域服务失败")
    await waitFor(() => expect(garden.domains.list).toHaveBeenCalledTimes(3))
  })

  it("resets an active filter when a successful remove omits that domain", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.domains.remove).mockResolvedValueOnce(ok(domainSummaries.slice(0, 3)))
    render(<App />)

    const navigation = await screen.findByRole("navigation", { name: "笔记" })
    await user.click(within(navigation).getByRole("button", { name: "生活" }))
    await user.click(screen.getByRole("button", { name: "管理领域" }))
    const manager = screen.getByRole("dialog", { name: "管理领域" })
    const life = within(manager).getByRole("article", { name: "生活" })
    await user.click(within(life).getByRole("button", { name: "删除" }))
    await user.click(
      within(screen.getByRole("dialog", { name: "确认删除领域？" })).getByRole("button", {
        name: "确认删除",
      }),
    )
    await waitFor(() => expect(garden.domains.remove).toHaveBeenCalledWith({ slug: "life" }))
    await user.click(screen.getByRole("button", { name: "关闭" }))

    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "笔记" })).getByRole("button", {
          name: "全部领域",
        }),
      ).toHaveAttribute("aria-pressed", "true"),
    )
  })

  it("creates a note through the accessible new-note form", async () => {
    const user = userEvent.setup()
    let domainRequest = 0
    const countedDomains = domainSummaries.map((domain) =>
      domain.slug === "life" ? { ...domain, privateNotes: 1 } : domain,
    )
    vi.mocked(garden.domains.list).mockImplementation(async () => {
      domainRequest += 1
      return ok(domainRequest === 1 ? domainSummaries : countedDomains)
    })
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
    await waitFor(() => expect(garden.domains.list).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole("button", { name: "管理领域" }))
    expect(within(screen.getByRole("article", { name: "生活" })).getByText("私密 1")).toBeVisible()
  })

  it("defaults omitted note description and tags to 无", async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    const description = within(dialog).getByRole("textbox", { name: "描述" })
    const tags = within(dialog).getByRole("textbox", { name: "标签" })
    const create = within(dialog).getByRole("button", { name: "创建" })

    expect(description).not.toBeRequired()
    expect(tags).not.toBeRequired()
    expect(within(dialog).getAllByText("不填写默认为无")).toHaveLength(2)
    expect(create).toBeDisabled()

    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "无元数据笔记")
    expect(create).toBeEnabled()
    await user.click(create)

    await waitFor(() => {
      expect(garden.notes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "无元数据笔记",
          description: "无",
          tags: ["无"],
        }),
      )
    })
  })

  it("defaults whitespace-only description and comma-only tags to 无", async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "空白元数据笔记")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "   ")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), " , ， ")
    await user.click(within(dialog).getByRole("button", { name: "创建" }))

    await waitFor(() => {
      expect(garden.notes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "空白元数据笔记",
          description: "无",
          tags: ["无"],
        }),
      )
    })
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
    await user.click(screen.getByRole("button", { name: "可见性：私密" }))
    const selectedPrivate = screen.getByRole("menuitemradio", { name: /私密/ })
    expect(selectedPrivate).toHaveAttribute("aria-checked", "true")
    expect(selectedPrivate).toHaveFocus()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(garden.domains.list).toHaveBeenCalledTimes(2))
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

  it("refreshes publishable changes immediately after privatizing a public note", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.changes.list)
      .mockResolvedValueOnce(ok({ groups: [] }))
      .mockResolvedValueOnce(
        ok({
          groups: [
            {
              id: "unpublish-css-grid",
              label: "css-grid",
              kind: "unpublish",
              selection: "default",
              description: "将从公开网站移除",
              paths: ["content/technology/css-grid.md"],
              attachments: [],
            },
          ],
        }),
      )
    vi.mocked(garden.notes.changeVisibility).mockResolvedValueOnce(
      ok({
        id: "visibility-refresh",
        changedPaths: ["content/technology/css-grid.md", "private/technology/css-grid.md"],
        pendingPublicDeletion: "content/technology/css-grid.md",
        historyWarning: false,
        warnings: [],
      }),
    )
    render(<App />)

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledOnce())
    await user.click(await screen.findByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2))
    expect(screen.getByText("可发布变化：1")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    expect(screen.getByRole("checkbox", { name: /css-grid/ })).toBeChecked()
    expect(screen.getByText("将从公开网站移除")).toBeVisible()
  })

  it("refreshes pending changes after privatizing and announces automatic link cleanup", async () => {
    const user = userEvent.setup()
    const review: ChangeReview = {
      groups: [
        {
          id: "modified-index",
          label: "index",
          kind: "modified",
          selection: "default",
          description: "公开文章已修改",
          paths: ["content/technology/index.md"],
          attachments: [],
        },
        {
          id: "unpublish-css-grid",
          label: "css-grid",
          kind: "unpublish",
          selection: "default",
          description: "将从公开网站移除",
          paths: ["content/technology/css-grid.md"],
          attachments: [],
        },
        {
          id: "added-new-links",
          label: "new-links",
          kind: "added",
          selection: "default",
          description: "新增公开文章",
          paths: ["content/reading/new-links.md"],
          attachments: [],
        },
        {
          id: "modified-unrelated",
          label: "unrelated",
          kind: "modified",
          selection: "default",
          description: "无关修改",
          paths: ["content/life/unrelated.md"],
          attachments: [],
        },
        {
          id: "private-css-grid",
          label: "css-grid",
          kind: "private",
          selection: "locked",
          description: "只保留在本机，不会发布",
          paths: ["private/technology/css-grid.md"],
          attachments: [],
        },
      ],
    }
    vi.mocked(garden.changes.list)
      .mockResolvedValueOnce(ok({ groups: [] }))
      .mockResolvedValue(ok(review))
    vi.mocked(garden.notes.changeVisibility).mockResolvedValueOnce(
      ok({
        id: "visibility-auto",
        changedPaths: [
          "content/technology/css-grid.md",
          "private/technology/css-grid.md",
          "content/technology/index.md",
          "content/reading/new-links.md",
        ],
        linkEditedPaths: ["content/reading/new-links.md", "content/technology/index.md"],
        pendingPublicDeletion: "content/technology/css-grid.md",
        historyWarning: false,
        warnings: [],
      }),
    )
    render(<App />)

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledOnce())
    await user.click(await screen.findByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2))
    expect(garden.publish.start).not.toHaveBeenCalled()
    expect(screen.getByText("已自动清理 2 个页面中的入站链接")).toBeVisible()
    expect(screen.getByText("可发布变化：4")).toBeVisible()
  })

  it("does not call publish even when a privatized note has a pending public deletion", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.changes.list)
      .mockResolvedValueOnce(ok({ groups: [] }))
      .mockResolvedValue(
        ok({
          groups: [
            {
              id: "unpublish-css-grid",
              label: "css-grid",
              kind: "unpublish",
              selection: "default",
              description: "将从公开网站移除",
              paths: ["content/technology/css-grid.md"],
              attachments: [],
            },
          ],
        }),
      )
    vi.mocked(garden.notes.changeVisibility).mockResolvedValueOnce(
      ok({
        id: "visibility-auto-failed",
        changedPaths: ["content/technology/css-grid.md", "private/technology/css-grid.md"],
        pendingPublicDeletion: "content/technology/css-grid.md",
        historyWarning: false,
        warnings: [],
      }),
    )
    render(<App />)

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledOnce())
    await user.click(await screen.findByRole("button", { name: "可见性：公开" }))
    await user.click(screen.getByRole("menuitemradio", { name: /私密/ }))
    await user.click(
      within(screen.getByRole("dialog", { name: "确认设为私密" })).getByRole("button", {
        name: "确认设为私密",
      }),
    )

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2))
    expect(garden.publish.start).not.toHaveBeenCalled()
    expect(screen.getByText("可发布变化：1")).toBeVisible()
  })

  it("retains the latest private buffer in the editor and local preview after making it public", async () => {
    const user = userEvent.setup()
    const nextPath = "content/reading/private-notes.md"
    const latestMarkdown = "# 私密阅读札记\n\n正文\n\nprivate-to-public latest"
    vi.mocked(garden.notes.save).mockResolvedValueOnce(
      ok({
        path: notes[1].path,
        updatedAt: "2026-09-25T02:00:00.000Z",
        mtimeMs: 5,
        contentHash: markdownHash(latestMarkdown),
      }),
    )
    vi.mocked(garden.notes.read).mockImplementation(async ({ path }) =>
      ok(
        path === nextPath
          ? {
              ...documents.get(notes[1].path)!,
              path,
              markdown: latestMarkdown,
              mtimeMs: 5,
              contentHash: markdownHash(latestMarkdown),
            }
          : documents.get(path)!,
      ),
    )
    render(<App />)

    await user.click(await screen.findByRole("button", { name: /私密阅读札记/ }))
    await screen.findByText("# 私密阅读札记", { exact: false })
    const beforeMove = EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!
    act(() =>
      beforeMove.dispatch({
        changes: { from: beforeMove.state.doc.length, insert: "\n\nprivate-to-public latest" },
      }),
    )
    await user.click(await screen.findByRole("button", { name: "可见性：私密" }))
    await user.click(screen.getByRole("menuitemradio", { name: /公开/ }))

    await waitFor(() =>
      expect(garden.notes.save).toHaveBeenCalledWith(
        expect.objectContaining({ path: notes[1].path, markdown: latestMarkdown }),
      ),
    )
    await waitFor(() =>
      expect(garden.notes.changeVisibility).toHaveBeenCalledWith({
        path: notes[1].path,
        visibility: "public",
      }),
    )
    expect(await screen.findByText(nextPath)).toBeVisible()
    await waitFor(() =>
      expect(
        EditorView.findFromDOM(
          document.querySelector(".cm-content") as HTMLElement,
        )?.state.doc.toString(),
      ).toBe(latestMarkdown),
    )
    expect(
      within(screen.getByRole("region", { name: "本地预览" })).getByTitle(
        "私密阅读札记的 Quartz 精确预览",
      ),
    ).toHaveAttribute("src", "http://127.0.0.1:8080/reading/private-notes")
    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2))
    expect(garden.publish.start).not.toHaveBeenCalled()
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
    expect(await screen.findByText("private/technology/css-grid.md")).toBeVisible()
    await waitFor(() =>
      expect(
        EditorView.findFromDOM(
          document.querySelector(".cm-content") as HTMLElement,
        )?.state.doc.toString(),
      ).toContain("v2"),
    )
    expect(
      within(screen.getByRole("region", { name: "本地预览" })).getByTitle(
        "CSS Grid 布局的 Quartz 精确预览",
      ),
    ).toHaveAttribute("src", "http://127.0.0.1:8080/technology/css-grid")
    expect(garden.publish.start).not.toHaveBeenCalled()
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
    await waitFor(() => expect(garden.domains.list).toHaveBeenCalledTimes(2))
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

  it("keeps exact Quartz note preview primary and offers secondary destinations", async () => {
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
    const publicFrame = within(preview).getByTitle("线上公开站")
    expect(publicFrame).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/garden\.example\.com\/\?refresh=/),
    )
    const firstPublicSrc = publicFrame.getAttribute("src")
    expect(garden.history.clearCache).toHaveBeenCalledOnce()
    await user.click(within(preview).getByRole("button", { name: "刷新线上站" }))
    expect(within(preview).getByTitle("线上公开站")).not.toHaveAttribute(
      "src",
      firstPublicSrc ?? "",
    )
    expect(garden.history.clearCache).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    await user.click(within(preview).getByRole("tab", { name: "当前笔记" }))
    expect(within(preview).getByText("私密笔记不会映射到公开网址")).toBeVisible()
    expect(within(preview).getByTitle("私密阅读札记的 Quartz 精确预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8080/reading/private-notes",
    )

    await user.click(within(preview).getByRole("tab", { name: "历史" }))
    expect(await within(preview).findByText("无法读取发布历史")).toBeVisible()
    const gitRequest = vi.mocked(garden.history.git).mock.calls.at(-1)?.[0]
    const deploymentRequest = vi.mocked(garden.history.deployments).mock.calls.at(-1)?.[0]
    expect(gitRequest?.requestId).toMatch(/^history-/)
    expect(deploymentRequest?.requestId).toBe(gitRequest?.requestId)
  })

  it("locates selected editor text in the exact current-note preview", async () => {
    const user = userEvent.setup()
    render(<App />)
    const view = await waitFor(() =>
      EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement),
    )
    await waitFor(() => expect(view!.contentDOM).toHaveAttribute("contenteditable", "true"))
    const source = view!.state.doc.toString()
    const from = source.indexOf("正文")
    act(() => {
      view!.dispatch({ selection: { anchor: from, head: from + 2 } })
    })

    await user.click(screen.getByRole("button", { name: "定位预览" }))

    await waitFor(() =>
      expect(garden.preview.revealSelection).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/technology/css-grid",
        text: "正文",
        positionRatio: (from + from + 2) / 2 / source.length,
      }),
    )
    expect(screen.getByRole("status", { name: "预览定位状态" })).toHaveTextContent("已定位到预览")
  })

  it("ignores a preview-navigation result after switching notes", async () => {
    const user = userEvent.setup()
    const result =
      deferred<Awaited<ReturnType<NonNullable<GardenApi["preview"]["revealSelection"]>>>>()
    vi.mocked(garden.preview.revealSelection!).mockReturnValue(result.promise)
    render(<App />)
    const view = await waitFor(() =>
      EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement),
    )
    await waitFor(() => expect(view!.contentDOM).toHaveAttribute("contenteditable", "true"))
    const source = view!.state.doc.toString()
    const from = source.indexOf("正文")
    act(() => view!.dispatch({ selection: { anchor: from, head: from + 2 } }))
    await user.click(screen.getByRole("button", { name: "定位预览" }))
    await waitFor(() => expect(garden.preview.revealSelection).toHaveBeenCalledOnce())

    await user.click(screen.getByRole("button", { name: /私密阅读札记/ }))
    await waitFor(() =>
      expect(document.querySelector(".editor-placeholder")).toHaveAttribute(
        "data-editor-document",
        notes[1].path,
      ),
    )
    await act(async () => result.resolve(ok("found")))

    expect(screen.queryByRole("status", { name: "预览定位状态" })).not.toBeInTheDocument()
  })

  it("keeps the private Quartz route while editing", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.notes.save).mockResolvedValue(
      ok({
        path: notes[1].path,
        updatedAt: "2026-09-26T00:00:00.000Z",
        mtimeMs: 5,
        contentHash: markdownHash("# 私密阅读札记\n\n正文\n\n实时预览内容"),
      }),
    )
    render(<App />)

    await user.click(await screen.findByRole("button", { name: /私密阅读札记/ }))
    const preview = screen.getByRole("region", { name: "本地预览" })
    expect(await within(preview).findByTitle("私密阅读札记的 Quartz 精确预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8080/reading/private-notes",
    )

    const view = await waitFor(() =>
      EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement),
    )
    await act(async () => {
      view!.dispatch({ changes: { from: view!.state.doc.length, insert: "\n\n实时预览内容" } })
    })
    expect(view!.state.doc.toString()).toContain("实时预览内容")
  })

  it("keeps the public Quartz route while editing", async () => {
    render(<App />)

    const preview = await screen.findByRole("region", { name: "本地预览" })
    expect(await within(preview).findByTitle("CSS Grid 布局的 Quartz 精确预览")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8080/technology/css-grid",
    )

    const view = await waitFor(() =>
      EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement),
    )
    await act(async () => {
      view!.dispatch({ changes: { from: view!.state.doc.length, insert: "\n\n公开实时预览" } })
    })
    expect(view!.state.doc.toString()).toContain("公开实时预览")
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

  it("rescans changes and reports the matching deployment after publication completes", async () => {
    const user = userEvent.setup()
    let publishProgress: ((progress: PublishProgress) => void) | undefined
    const commitId = "a".repeat(40)
    const runUrl = "https://github.com/octocat/garden/actions/runs/42"
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    vi.mocked(garden.publish.onProgress).mockImplementation((listener) => {
      publishProgress = listener
      return () => undefined
    })
    vi.mocked(garden.changes.list)
      .mockResolvedValueOnce(
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
      .mockResolvedValueOnce(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    render(<App />)

    expect(await screen.findByText("可发布变化：1")).toBeVisible()
    expect(screen.queryByRole("button", { name: "查看 Actions" })).not.toBeInTheDocument()
    act(() => {
      publishProgress?.({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })
    })

    expect(await screen.findByText("可发布变化：0")).toBeVisible()
    expect(screen.queryByRole("button", { name: "查看 Actions" })).not.toBeInTheDocument()
    deployments.resolve(
      ok({
        runs: [
          {
            id: "42",
            headSha: commitId,
            startedAt: "2026-10-15T00:00:01.000Z",
            completedAt: "2026-10-15T00:00:02.000Z",
            status: "succeeded",
            url: runUrl,
          },
        ],
        actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
        liveSiteUrl: "https://octocat.github.io/garden/",
      }),
    )
    expect(await screen.findByText("发布成功，部署已完成。")).toBeVisible()
    const actions = screen.getByRole("button", { name: "查看 Actions" })
    await user.click(actions)
    expect(garden.history.openLink).toHaveBeenCalledWith({ url: runUrl })
    act(() => {
      publishProgress?.({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })
    })
    expect(screen.getByText("发布成功，部署已完成。")).toBeVisible()
    expect(screen.queryByText("发布成功，正在等待部署。")).not.toBeInTheDocument()
    expect(garden.history.deployments).toHaveBeenCalledOnce()
    act(() => {
      publishProgress?.({ phase: "validating", message: "正在验证…", percent: 10 })
    })
    expect(screen.queryByRole("button", { name: "查看 Actions" })).not.toBeInTheDocument()
    const gitRequest = vi.mocked(garden.history.git).mock.calls.at(-1)?.[0]
    const deploymentRequest = vi.mocked(garden.history.deployments).mock.calls.at(-1)?.[0]
    expect(gitRequest).toEqual({
      limit: 1,
      requestId: expect.stringMatching(/^publish-deployment-/),
    })
    expect(deploymentRequest).toEqual({ limit: 20, requestId: gitRequest?.requestId })
  })

  it("reports an Actions link failure without erasing the completed deployment status", async () => {
    const user = userEvent.setup()
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockResolvedValueOnce(ok(deploymentHistory(commitId)))
    vi.mocked(garden.history.openLink).mockResolvedValueOnce({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "无法打开 Actions 链接。" },
    })
    render(<App />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

    expect(await screen.findByText("发布成功，部署已完成。")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "查看 Actions" }))
    await waitFor(() => {
      const status = screen.getByRole("status", { name: "发布状态" })
      expect(status).toHaveTextContent("发布成功，部署已完成。")
      expect(status).toHaveTextContent("无法打开 Actions 链接。")
    })
  })

  it("ignores a stale Actions link failure after validation starts", async () => {
    const user = userEvent.setup()
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    const openLink = deferred<IpcResult<void>>()
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockResolvedValueOnce(ok(deploymentHistory(commitId)))
    vi.mocked(garden.history.openLink).mockReturnValueOnce(openLink.promise)
    render(<App />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

    expect(await screen.findByText("发布成功，部署已完成。")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "查看 Actions" }))
    progress.emit({ phase: "validating", message: "正在验证…", percent: 10 })
    expect(screen.queryByRole("button", { name: "查看 Actions" })).not.toBeInTheDocument()
    expect(screen.getByText("正在验证…")).toBeVisible()

    openLink.resolve({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "无法打开 Actions 链接。" },
    })
    await act(async () => void (await openLink.promise))
    expect(screen.getByText("正在验证…")).toBeVisible()
    expect(screen.queryByText("无法打开 Actions 链接。")).not.toBeInTheDocument()
  })

  it.each([
    ["failed", "发布已完成，但部署失败。"],
    ["cancelled", "发布已完成，但部署已取消。"],
  ] as const)(
    "reports a matching %s deployment without claiming publication failed",
    async (status, message) => {
      const progress = capturePublishProgress(garden)
      const commitId = "a".repeat(40)
      vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
      vi.mocked(garden.history.git).mockResolvedValueOnce(
        ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
      )
      vi.mocked(garden.history.deployments).mockResolvedValueOnce(
        ok(deploymentHistory(commitId, status)),
      )
      render(<App />)

      progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

      expect(await screen.findByText(message)).toBeVisible()
      expect(screen.queryByText("发布失败")).not.toBeInTheDocument()
    },
  )

  it("uses deployment uncertainty when deployment history rejects", async () => {
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockRejectedValueOnce(new Error("deployment unavailable"))
    render(<App />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

    expect(await screen.findByText("代码已推送，暂时无法确认部署状态。")).toBeVisible()
    expect(screen.queryByText("发布失败")).not.toBeInTheDocument()
  })

  it("keeps waiting when the returned run belongs to another commit", async () => {
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockResolvedValueOnce(
      ok(deploymentHistory("b".repeat(40))),
    )
    render(<App />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

    expect(await screen.findByText("代码已推送，正在等待 GitHub Pages 部署…")).toBeVisible()
    expect(screen.queryByText("发布成功，部署已完成。")).not.toBeInTheDocument()
  })

  it("rechecks a pending deployment until it succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20 })
    try {
      const progress = capturePublishProgress(garden)
      const commitId = "a".repeat(40)
      vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
      vi.mocked(garden.history.git).mockResolvedValue(
        ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
      )
      vi.mocked(garden.history.deployments)
        .mockResolvedValueOnce(ok(deploymentHistory(commitId, "pending")))
        .mockResolvedValueOnce(ok(deploymentHistory(commitId, "succeeded")))
      render(<App />)

      progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

      expect(await screen.findByText("代码已推送，正在等待 GitHub Pages 部署…")).toBeVisible()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000)
      })
      expect(await screen.findByText("发布成功，部署已完成。")).toBeVisible()
      expect(garden.history.deployments).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts only one deployment query for repeated complete events in one publication", async () => {
    const progress = capturePublishProgress(garden)
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockImplementation(() => new Promise(() => undefined))
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    render(<App />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })
    progress.emit({ phase: "complete", message: "重复完成事件", percent: 100 })

    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
  })

  it("cancels and ignores a deployment result made stale by a new validation", async () => {
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    vi.mocked(garden.history.cancel).mockImplementationOnce(() => {
      throw new Error("synchronous cancellation failure")
    })
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    render(<App />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })
    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
    const requestId = vi.mocked(garden.history.deployments).mock.calls[0]?.[0]?.requestId

    progress.emit({ phase: "validating", message: "正在验证…", percent: 10 })
    await act(async () => Promise.resolve())
    expect(garden.history.cancel).toHaveBeenCalledWith({ requestId })

    deployments.resolve(ok(deploymentHistory(commitId)))
    await act(async () => void (await deployments.promise))
    expect(screen.getByText("正在验证…")).toBeVisible()
    expect(screen.queryByText("发布成功，部署已完成。")).not.toBeInTheDocument()
  })

  it("allows a second completion after validation to become the current deployment result", async () => {
    const progress = capturePublishProgress(garden)
    const firstCommit = "a".repeat(40)
    const secondCommit = "b".repeat(40)
    const firstDeployments = deferred<IpcResult<DeploymentHistory>>()
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git)
      .mockResolvedValueOnce(
        ok([{ id: firstCommit, authoredAt: "2026-10-15T00:00:00.000Z", subject: "First" }]),
      )
      .mockResolvedValueOnce(
        ok([{ id: secondCommit, authoredAt: "2026-10-15T00:01:00.000Z", subject: "Second" }]),
      )
    vi.mocked(garden.history.deployments)
      .mockReturnValueOnce(firstDeployments.promise)
      .mockResolvedValueOnce(ok(deploymentHistory(secondCommit)))
    render(<App />)

    progress.emit({ phase: "complete", message: "第一轮完成", percent: 100 })
    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
    progress.emit({ phase: "validating", message: "正在验证…", percent: 10 })
    progress.emit({ phase: "complete", message: "第二轮完成", percent: 100 })

    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("发布成功，部署已完成。")).toBeVisible()

    firstDeployments.resolve(ok(deploymentHistory(firstCommit, "failed")))
    await act(async () => void (await firstDeployments.promise))
    expect(screen.getByText("发布成功，部署已完成。")).toBeVisible()
    expect(screen.queryByText("发布已完成，但部署失败。")).not.toBeInTheDocument()
  })

  it("cancels pending deployment tracking before switching blogs and ignores its late result", async () => {
    const user = userEvent.setup()
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    render(<PublisherApp api={garden} initialRegistry={twoBlogRegistry} />)

    progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })
    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
    const requestId = vi.mocked(garden.history.deployments).mock.calls[0]?.[0]?.requestId

    await user.click(screen.getByRole("button", { name: "切换博客：Knowledge Garden" }))
    await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))

    await waitFor(() =>
      expect(garden.blogs.switch).toHaveBeenCalledWith({ id: "study", editorSaved: true }),
    )
    expect(garden.history.cancel).toHaveBeenCalledWith({ requestId })
    expect(vi.mocked(garden.history.cancel).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(garden.blogs.switch).mock.invocationCallOrder[0],
    )
    expect(screen.queryByText("代码已推送，正在等待 GitHub Pages 部署…")).not.toBeInTheDocument()

    deployments.resolve(ok(deploymentHistory(commitId)))
    await act(async () => void (await deployments.promise))
    expect(screen.queryByText("发布成功，部署已完成。")).not.toBeInTheDocument()
  })

  it("cancels deployment tracking when a registry update changes the active blog", async () => {
    const user = userEvent.setup()
    const progress = capturePublishProgress(garden)
    const commitId = "a".repeat(40)
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    const activeStudyRegistry: BlogRegistryView = {
      ...twoBlogRegistry,
      activeBlogId: "study",
    }
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    vi.mocked(garden.blogs.rename).mockResolvedValueOnce(ok(activeStudyRegistry))
    render(<PublisherApp api={garden} initialRegistry={twoBlogRegistry} />)

    progress.emit({ phase: "complete", message: "上一轮完成", percent: 100 })
    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
    const requestId = vi.mocked(garden.history.deployments).mock.calls[0]?.[0]?.requestId

    await user.click(screen.getByRole("button", { name: "切换博客：Knowledge Garden" }))
    await user.click(screen.getByRole("menuitem", { name: "管理博客" }))
    await user.click(screen.getByRole("button", { name: "重命名 Study Garden" }))
    const name = screen.getByLabelText("博客名称")
    await user.clear(name)
    await user.type(name, "Study Notes")
    await user.click(screen.getByRole("button", { name: "保存名称" }))

    await waitFor(() => expect(garden.history.cancel).toHaveBeenCalledWith({ requestId }))
    expect(screen.queryByText("代码已推送，正在等待 GitHub Pages 部署…")).not.toBeInTheDocument()

    deployments.resolve(ok(deploymentHistory(commitId)))
    await act(async () => void (await deployments.promise))
    expect(screen.queryByText("发布成功，部署已完成。")).not.toBeInTheDocument()
  })

  it("invalidates an old change scan and loads the new active blog after a registry update", async () => {
    const user = userEvent.setup()
    const oldChanges = deferred<IpcResult<ChangeReview>>()
    const activeStudyRegistry: BlogRegistryView = {
      ...twoBlogRegistry,
      activeBlogId: "study",
    }
    vi.mocked(garden.changes.list)
      .mockReturnValueOnce(oldChanges.promise)
      .mockResolvedValue(
        ok({
          groups: [
            {
              id: "new-change",
              label: "新博客变化",
              kind: "modified",
              selection: "default",
              description: "新博客的公开文章已修改",
              paths: ["content/study/new.md"],
              attachments: [],
            },
          ],
        }),
      )
    vi.mocked(garden.blogs.rename).mockResolvedValueOnce(ok(activeStudyRegistry))
    render(<PublisherApp api={garden} initialRegistry={twoBlogRegistry} />)

    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledOnce())
    await user.click(screen.getByRole("button", { name: "切换博客：Knowledge Garden" }))
    await user.click(screen.getByRole("menuitem", { name: "管理博客" }))
    await user.click(screen.getByRole("button", { name: "重命名 Study Garden" }))
    const name = screen.getByLabelText("博客名称")
    await user.clear(name)
    await user.type(name, "Study Notes")
    await user.click(screen.getByRole("button", { name: "保存名称" }))

    await waitFor(() => expect(garden.changes.cancel).toHaveBeenCalledOnce())
    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("可发布变化：1")).toBeVisible()

    oldChanges.resolve(
      ok({
        groups: [
          {
            id: "old-change-1",
            label: "旧博客变化一",
            kind: "modified",
            selection: "default",
            description: "旧博客变化",
            paths: ["content/old/one.md"],
            attachments: [],
          },
          {
            id: "old-change-2",
            label: "旧博客变化二",
            kind: "modified",
            selection: "default",
            description: "旧博客变化",
            paths: ["content/old/two.md"],
            attachments: [],
          },
        ],
      }),
    )
    await act(async () => void (await oldChanges.promise))
    expect(screen.getByText("可发布变化：1")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "关闭博客管理" }))
    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    expect(screen.getByRole("checkbox", { name: /新博客变化/ })).toBeVisible()
    expect(screen.queryByText("旧博客变化一")).not.toBeInTheDocument()
  })

  it("cancels pending deployment tracking before starting a new publication", async () => {
    const user = userEvent.setup()
    const progress = capturePublishProgress(garden)
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    const publishStart = deferred<Awaited<ReturnType<GardenApi["publish"]["start"]>>>()
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
    vi.mocked(garden.history.git).mockImplementation(() => new Promise(() => undefined))
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    vi.mocked(garden.publish.start).mockReturnValueOnce(publishStart.promise)
    render(<App />)

    progress.emit({ phase: "complete", message: "上一轮完成", percent: 100 })
    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
    const requestId = vi.mocked(garden.history.deployments).mock.calls[0]?.[0]?.requestId
    expect(screen.getByText("代码已推送，正在等待 GitHub Pages 部署…")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "检查并发布" }))
    await user.click(await screen.findByRole("button", { name: "验证并发布" }))

    expect(screen.queryByText("代码已推送，正在等待 GitHub Pages 部署…")).not.toBeInTheDocument()
    publishStart.resolve(ok({ operationId: "publish-2" }))
    await waitFor(() => expect(garden.publish.start).toHaveBeenCalledOnce())
    expect(garden.history.cancel).toHaveBeenCalledWith({ requestId })
    expect(vi.mocked(garden.history.cancel).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(garden.publish.start).mock.invocationCallOrder[0],
    )

    deployments.resolve(ok(deploymentHistory("a".repeat(40))))
    await act(async () => void (await deployments.promise))
    expect(screen.queryByText("发布成功，部署已完成。")).not.toBeInTheDocument()
  })

  it("cancels deployment tracking on unmount without late state updates", async () => {
    let publishProgress: ((progress: PublishProgress) => void) | undefined
    const commitId = "a".repeat(40)
    const deployments = deferred<IpcResult<DeploymentHistory>>()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.mocked(garden.publish.onProgress).mockImplementation((listener) => {
      publishProgress = listener
      return () => undefined
    })
    vi.mocked(garden.changes.list).mockResolvedValue(ok({ groups: [] }))
    vi.mocked(garden.history.git).mockResolvedValueOnce(
      ok([{ id: commitId, authoredAt: "2026-10-15T00:00:00.000Z", subject: "Publish" }]),
    )
    vi.mocked(garden.history.deployments).mockReturnValueOnce(deployments.promise)
    const view = render(<App />)

    act(() => {
      publishProgress?.({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })
    })
    await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
    const requestId = vi.mocked(garden.history.deployments).mock.calls.at(-1)?.[0]?.requestId
    expect(requestId).toMatch(/^publish-deployment-/)

    view.unmount()
    await act(async () => Promise.resolve())
    expect(garden.history.cancel).toHaveBeenCalledWith({ requestId })
    await act(async () => {
      deployments.resolve(
        ok({
          runs: [
            {
              id: "42",
              headSha: commitId,
              startedAt: "2026-10-15T00:00:01.000Z",
              completedAt: "2026-10-15T00:00:02.000Z",
              status: "succeeded",
              url: "https://github.com/octocat/garden/actions/runs/42",
            },
          ],
          actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
          liveSiteUrl: "https://octocat.github.io/garden/",
        }),
      )
      await Promise.resolve()
    })
    expect(consoleError).not.toHaveBeenCalled()
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

  it("retains all blog address labels at narrow width while ellipsizing values without overflow", () => {
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
          repository: { display: "未配置仓库" },
          website: { source: "unconfigured" },
        },
      ],
    }
    render(
      <header className="topbar">
        <BlogSwitcher
          registry={registry}
          disabled={false}
          onSwitch={vi.fn()}
          onOpenLink={vi.fn()}
          onAddLocal={vi.fn()}
          onClone={vi.fn()}
          onManage={vi.fn()}
        />
      </header>,
    )

    expect(screen.getByRole("button", { name: "切换博客：Knowledge Garden" })).toBeVisible()
    expect(screen.getByText("Knowledge Garden")).toBeVisible()
    const path = screen.getByText(String.raw`C:\Users\me\knowledge-garden`)
    expect(path).toHaveClass("blog-address-value")
    expect(path.closest("dl")).toHaveClass("blog-address-rows")
    for (const label of ["仓库", "网站", "本地"]) {
      expect(screen.getByText(label, { exact: true })).toBeVisible()
    }

    const stylesheet = readFileSync(resolve(process.cwd(), "src/renderer/src/app.css"), "utf8")
    const narrowRules = stylesheet.slice(
      stylesheet.indexOf("@media (max-width: 680px)"),
      stylesheet.indexOf("@media (prefers-reduced-motion: reduce)"),
    )
    expect(narrowRules).not.toMatch(
      /\.blog-switcher-copy small|\.blog-menu-copy small|\.blog-manager-card-heading code/,
    )
    expect(narrowRules).not.toMatch(/\.blog-address[^{}]*\{[^}]*display:\s*none/)
    expect(narrowRules).toMatch(
      /\.blog-switcher-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    )
    expect(stylesheet).toMatch(
      /\.blog-address-rows > div\s*\{[^}]*grid-template-columns:\s*38px minmax\(0, 1fr\)/,
    )
    expect(stylesheet).toMatch(
      /\.blog-address-value\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/,
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

  it("provides a '...' button matching status font size to reveal the full status message", async () => {
    const user = userEvent.setup()
    const progress = capturePublishProgress(garden)
    const longMessage =
      "发布失败：网站验证未通过，请检查站点构建。本地修改与未发布内容已完整保留，可修正问题后重新发布。"
    render(<App />)

    progress.emit({ phase: "failed", message: longMessage })
    expect(await screen.findByText(longMessage)).toBeVisible()

    const moreButton = screen.getByRole("button", { name: "显示完整状态" })
    expect(moreButton).toHaveTextContent("...")
    expect(moreButton).toHaveAttribute("aria-expanded", "false")

    await user.click(moreButton)
    expect(moreButton).toHaveAttribute("aria-expanded", "true")
    const dialog = screen.getByRole("dialog", { name: "完整状态信息" })
    expect(within(dialog).getByText(longMessage)).toBeVisible()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "完整状态信息" })).not.toBeInTheDocument()
    expect(moreButton).toHaveAttribute("aria-expanded", "false")

    const stylesheet = readFileSync("src/renderer/src/app.css", "utf8")
    expect(stylesheet).toMatch(/\.publish-summary small\s*\{[^}]*font-size:\s*11px/s)
    expect(stylesheet).toMatch(/\.status-more-button\s*\{[^}]*font-size:\s*11px/s)
  })

  it("refreshes publishable count on public note save and ignores cancelled scan races", async () => {
    const user = userEvent.setup()
    vi.mocked(garden.changes.list)
      .mockResolvedValueOnce(ok({ groups: [] }))
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "CHANGE_SCAN_CANCELLED", message: "Change scan was cancelled." },
      })
      .mockResolvedValue(
        ok({
          groups: [
            {
              id: "note:css-grid",
              label: "css-grid",
              kind: "modified",
              selection: "default",
              description: "公开文章已修改",
              paths: [notes[0].path],
              attachments: [],
            },
          ],
        }),
      )
    vi.mocked(garden.notes.save).mockImplementation(async (request) =>
      ok({
        path: request.path,
        updatedAt: "2026-10-30T10:00:00.000Z",
        mtimeMs: 9,
        contentHash: markdownHash(request.markdown),
      }),
    )
    render(<App />)

    expect(await screen.findByText("可发布变化：0")).toBeVisible()
    await user.click(await screen.findByRole("button", { name: /CSS Grid 布局/ }))
    const textbox = await screen.findByRole("textbox")
    const editor = EditorView.findFromDOM(textbox)
    if (!editor) throw new Error("CodeMirror view not found")

    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nfirst" } }))
    await waitFor(() => expect(garden.changes.list).toHaveBeenCalledTimes(2), { timeout: 3_000 })
    expect(screen.getByText("可发布变化：0")).toBeVisible()
    expect(screen.queryByText(/Change scan was cancelled/)).not.toBeInTheDocument()

    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nsecond" } }))
    expect(await screen.findByText("可发布变化：1", {}, { timeout: 3_000 })).toBeVisible()
  })
})
