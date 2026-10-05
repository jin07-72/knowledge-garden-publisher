import { describe, expect, it, vi } from "vitest"
import {
  IPC_CHANNELS,
  type AppError,
  type BlogImportProgress,
  type PreviewStatus,
  type PublishProgress,
} from "../../src/shared/contracts"
import {
  registerBlogManagementIpc,
  registerLifecycleIpc,
  registerPublisherIpc,
  type IpcEventTarget,
  type IpcMainPort,
  type PublisherIpcServices,
} from "../../src/main/ipc"
import { BlogImportError, type BlogImportErrorCode } from "../../src/main/services/blogImport"
import { createGardenApi, type IpcRendererPort } from "../../src/preload/gardenApi"
import type { GardenApi as SharedGardenApi } from "../../src/shared/contracts"

type Handler = (event: unknown, request?: unknown) => Promise<unknown>

class FakeIpcMain implements IpcMainPort {
  readonly handlers = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  invoke(channel: string, event: unknown, request?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) return Promise.reject(new Error(`No handler for ${channel}`))
    return handler(event, request)
  }
}

function services(): PublisherIpcServices & {
  readonly calls: Record<string, ReturnType<typeof vi.fn>>
  emitPreview(status: PreviewStatus): void
  emitPublish(progress: PublishProgress): void
  emitRecovery(update: { restored: readonly string[]; conflicts: readonly string[] }): void
  emitBlogProgress(progress: BlogImportProgress): void
  previewSubscriptions(): number
  publishSubscriptions(): number
  blogSubscriptions(): number
} {
  const calls = new Proxy<Record<string, ReturnType<typeof vi.fn>>>({} as never, {
    get(target, key: string) {
      target[key] ??= vi.fn(async () => ({ source: key }))
      return target[key]
    },
  })
  const call = (name: string): any => calls[name]
  const previewListeners = new Set<(status: PreviewStatus) => void>()
  const publishListeners = new Set<(progress: PublishProgress) => void>()
  const recoveryListeners = new Set<
    (update: { restored: readonly string[]; conflicts: readonly string[] }) => void
  >()
  const blogListeners = new Set<(progress: BlogImportProgress) => void>()

  return {
    calls,
    workspace: {
      inspectSafety: call("workspaceInspectSafety"),
      inspect: call("workspaceInspect"),
      repair: call("workspaceRepair"),
    },
    domains: {
      list: call("domainsList"),
      create: call("domainsCreate"),
      rename: call("domainsRename"),
      remove: call("domainsRemove"),
    },
    notes: {
      subscribeRecovery(listener) {
        recoveryListeners.add(listener)
        return () => recoveryListeners.delete(listener)
      },
      list: call("notesList"),
      read: call("notesRead"),
      save: call("notesSave"),
      create: call("notesCreate"),
      rename: call("notesRename"),
      changeVisibility: call("notesChangeVisibility"),
      trash: call("notesTrash"),
      recovery: {
        get: call("notesRecoveryGet"),
        write: call("notesRecoveryWrite"),
        discard: call("notesRecoveryDiscard"),
      },
    },
    preview: {
      start: call("previewStart"),
      stop: call("previewStop"),
      status: call("previewStatus"),
      subscribe(listener) {
        previewListeners.add(listener)
        return () => previewListeners.delete(listener)
      },
    },
    changes: { list: call("changesList"), cancel: call("changesCancel") },
    publish: {
      start: call("publishStart"),
      cancel: call("publishCancel"),
      subscribe(listener) {
        publishListeners.add(listener)
        return () => publishListeners.delete(listener)
      },
    },
    history: {
      git: call("historyGit"),
      deployments: call("historyDeployments"),
      cancel: call("historyCancel"),
      openLink: call("historyOpenLink"),
    },
    blogs: {
      list: call("blogsList"),
      chooseLocal: call("blogsChooseLocal"),
      addLocal: call("blogsAddLocal"),
      recoverLocal: call("blogsRecoverLocal"),
      clone: call("blogsClone"),
      cancelImport: call("blogsCancelImport"),
      install: call("blogsInstall"),
      rename: call("blogsRename"),
      relocate: call("blogsRelocate"),
      remove: call("blogsRemove"),
      openFolder: call("blogsOpenFolder"),
      switch: call("blogsSwitch"),
      subscribeProgress(listener) {
        blogListeners.add(listener)
        return () => blogListeners.delete(listener)
      },
    },
    emitPreview(status) {
      for (const listener of previewListeners) listener(status)
    },
    emitPublish(progress) {
      for (const listener of publishListeners) listener(progress)
    },
    emitRecovery(update) {
      for (const listener of recoveryListeners) listener(update)
    },
    emitBlogProgress(progress) {
      for (const listener of blogListeners) listener(progress)
    },
    previewSubscriptions: () => previewListeners.size,
    publishSubscriptions: () => publishListeners.size,
    blogSubscriptions: () => blogListeners.size,
  }
}

const trustedEvent = { sender: { id: 7, isDestroyed: () => false } }

function setup() {
  const ipc = new FakeIpcMain()
  const servicePorts = services()
  const sent: Array<[string, unknown]> = []
  const target: IpcEventTarget = {
    id: 7,
    isDestroyed: () => false,
    send(channel, payload) {
      sent.push([channel, payload])
    },
  }
  const acknowledgeClose = vi.fn()
  const disposeLifecycle = registerLifecycleIpc({
    ipcMain: ipc,
    isTrustedSender: (event) => event === trustedEvent,
    acknowledgeClose,
  })
  const disposeWorkspace = registerPublisherIpc({
    ipcMain: ipc,
    services: servicePorts,
    isTrustedSender: (event) => event === trustedEvent,
    eventTargets: () => [target],
  })
  const dispose = () => {
    disposeWorkspace()
    disposeLifecycle()
  }
  return { ipc, servicePorts, sent, dispose, acknowledgeClose }
}

describe("secure publisher IPC", () => {
  it("keeps lifecycle close acknowledgements available in recovery and after workspace IPC disposal", async () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const acknowledgeClose = vi.fn()
    const disposeLifecycle = registerLifecycleIpc({
      ipcMain: ipc,
      isTrustedSender: (event) => event === trustedEvent,
      acknowledgeClose,
    })
    const request = { requestId: "11111111-1111-4111-8111-111111111111", success: true }

    await expect(
      ipc.invoke(IPC_CHANNELS.requests.lifecycleCloseAck, trustedEvent, request),
    ).resolves.toEqual({ ok: true, value: undefined })

    const disposeWorkspace = registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: () => true,
      eventTargets: () => [],
      includeBlogManagement: false,
    })
    disposeWorkspace()

    await expect(
      ipc.invoke(IPC_CHANNELS.requests.lifecycleCloseAck, trustedEvent, request),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(acknowledgeClose).toHaveBeenCalledTimes(2)
    disposeLifecycle()
  })

  it("can register blog recovery IPC before workspace-bound services exist", async () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const dispose = registerBlogManagementIpc({
      ipcMain: ipc,
      services: servicePorts.blogs!,
      isTrustedSender: (event) => event === trustedEvent,
      eventTargets: () => [],
    })

    expect(ipc.handlers.has(IPC_CHANNELS.requests.blogsList)).toBe(true)
    expect(ipc.handlers.has(IPC_CHANNELS.requests.notesList)).toBe(false)
    expect(servicePorts.blogSubscriptions()).toBe(1)
    await ipc.invoke(IPC_CHANNELS.requests.blogsList, trustedEvent)
    expect(servicePorts.calls.blogsList).toHaveBeenCalledOnce()
    dispose()
    expect(servicePorts.blogSubscriptions()).toBe(0)
  })

  it("adds workspace IPC later without replacing independently registered blog recovery IPC", () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const disposeBlogs = registerBlogManagementIpc({
      ipcMain: ipc,
      services: servicePorts.blogs!,
      isTrustedSender: () => true,
      eventTargets: () => [],
    })
    const disposeWorkspace = registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: () => true,
      eventTargets: () => [],
      includeBlogManagement: false,
    })

    expect(ipc.handlers.has(IPC_CHANNELS.requests.blogsList)).toBe(true)
    expect(ipc.handlers.has(IPC_CHANNELS.requests.notesList)).toBe(true)
    expect(servicePorts.blogSubscriptions()).toBe(1)
    disposeWorkspace()
    expect(ipc.handlers.has(IPC_CHANNELS.requests.blogsList)).toBe(true)
    disposeBlogs()
    expect(ipc.handlers.size).toBe(0)
  })

  it("routes validated blog requests and rejects untrusted senders before the service", async () => {
    const { ipc, servicePorts } = setup()
    const id = "11111111-1111-4111-8111-111111111111"
    const request = { id, name: "Renamed" }
    const value = {
      version: 1,
      activeBlogId: id,
      blogs: [
        {
          id,
          name: "Renamed",
          path: String.raw`C:\\Blogs\\quartz`,
          canonicalPath: String.raw`C:\\Blogs\\quartz`,
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    }
    servicePorts.calls.blogsRename.mockResolvedValueOnce(value)
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsRename, trustedEvent, request),
    ).resolves.toEqual({
      ok: true,
      value,
    })
    expect(servicePorts.calls.blogsRename).toHaveBeenCalledWith(request)
    await expect(
      ipc.invoke(
        IPC_CHANNELS.requests.blogsRename,
        { sender: { isDestroyed: () => false } },
        request,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IPC_UNAUTHORIZED" },
    })
    expect(servicePorts.calls.blogsRename).toHaveBeenCalledOnce()
  })

  it("accepts omitted and blank clone names while rejecting invalid repository URLs", async () => {
    const { ipc, servicePorts } = setup()
    servicePorts.calls.blogsClone.mockResolvedValue({
      canonicalPath: String.raw`C:\Blogs\quartz`,
      owner: "openai",
      repository: "quartz",
    })
    const base = {
      url: "https://github.com/openai/quartz",
      destination: String.raw`C:\Blogs\quartz`,
    }

    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsClone, trustedEvent, base),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsClone, trustedEvent, { ...base, name: "   " }),
    ).resolves.toMatchObject({ ok: true })
    expect(servicePorts.calls.blogsClone).toHaveBeenNthCalledWith(1, base)
    expect(servicePorts.calls.blogsClone).toHaveBeenNthCalledWith(2, { ...base, name: "" })

    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsClone, trustedEvent, {
        ...base,
        url: "https://example.com/openai/quartz",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "The request is invalid." },
    })
    expect(servicePorts.calls.blogsClone).toHaveBeenCalledTimes(2)
  })

  it("routes strict corrupt-registry recovery and keeps failures path-safe", async () => {
    const { ipc, servicePorts } = setup()
    const request = { path: String.raw`C:\Blogs\quartz`, name: "Recovered" }
    servicePorts.calls.blogsRecoverLocal.mockRejectedValueOnce(
      new Error(String.raw`Could not replace C:\Users\owner\AppData\blogs.json`),
    )

    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsRecoverLocal, trustedEvent, request),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    })
    expect(servicePorts.calls.blogsRecoverLocal).toHaveBeenCalledWith(request)
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsRecoverLocal, {}, request),
    ).resolves.toMatchObject({ ok: false, error: { code: "IPC_UNAUTHORIZED" } })
    expect(servicePorts.calls.blogsRecoverLocal).toHaveBeenCalledTimes(1)
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsRecoverLocal, trustedEvent, {
        ...request,
        extra: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
  })

  it("requires saved-editor confirmation and returns a bounded switch-busy error", async () => {
    const { ipc, servicePorts } = setup()
    const id = "11111111-1111-4111-8111-111111111111"
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsSwitch, trustedEvent, { id }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    })
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsSwitch, trustedEvent, { id, editorSaved: false }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect(servicePorts.calls.blogsSwitch).not.toHaveBeenCalled()

    servicePorts.calls.blogsSwitch.mockRejectedValueOnce({
      code: "BLOG_SWITCH_BUSY",
      message: "secret workspace path",
    })
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsSwitch, trustedEvent, { id, editorSaved: true }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "BLOG_SWITCH_BUSY",
        message: "Finish the current publication task before switching blogs.",
      },
    })
  })

  it("fails closed instead of exposing a registry record with a relative display path", async () => {
    const { ipc, servicePorts } = setup()
    servicePorts.calls.blogsList.mockResolvedValueOnce({
      version: 1,
      activeAvailability: "available",
      activeBlogId: "11111111-1111-4111-8111-111111111111",
      blogs: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Quartz",
          path: "relative\\quartz",
          canonicalPath: String.raw`C:\\Blogs\\quartz`,
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    })
    await expect(ipc.invoke(IPC_CHANNELS.requests.blogsList, trustedEvent)).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    })
  })

  it("maps typed blog import failures to bounded public errors without disclosing internals", async () => {
    const cases: readonly [string, string, unknown, BlogImportErrorCode, string, string][] = [
      [
        IPC_CHANNELS.requests.blogsClone,
        "blogsClone",
        {
          url: "https://github.com/openai/quartz",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
        },
        "DESTINATION_EXISTS",
        "BLOG_DESTINATION_EXISTS",
        "The destination already exists.",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        "blogsClone",
        {
          url: "https://github.com/openai/quartz",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
        },
        "IMPORT_ACTIVE",
        "BLOG_IMPORT_ACTIVE",
        "Another blog import is already running.",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        "blogsClone",
        {
          url: "https://github.com/openai/quartz",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
        },
        "CANCELLED",
        "BLOG_IMPORT_CANCELLED",
        "Blog import was cancelled.",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        "blogsClone",
        {
          url: "https://github.com/openai/quartz",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
        },
        "CLONE_FAILED",
        "BLOG_CLONE_FAILED",
        "Git could not clone the blog repository.",
      ],
      [
        IPC_CHANNELS.requests.blogsInstall,
        "blogsInstall",
        { path: String.raw`C:\\Blogs\\quartz` },
        "INSTALL_FAILED",
        "BLOG_INSTALL_FAILED",
        "Blog dependencies could not be installed.",
      ],
      [
        IPC_CHANNELS.requests.blogsInstall,
        "blogsInstall",
        { path: String.raw`C:\\Blogs\\quartz` },
        "VALIDATION_FAILED",
        "BLOG_VALIDATION_FAILED",
        "The blog could not be validated.",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        "blogsClone",
        {
          url: "https://github.com/openai/quartz",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
        },
        "IMPORT_UNAVAILABLE",
        "BLOG_IMPORT_UNAVAILABLE",
        "Blog import requires an application restart.",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        "blogsClone",
        {
          url: "https://github.com/openai/quartz",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
        },
        "INVALID_REPOSITORY_URL",
        "INVALID_INPUT",
        "The request is invalid.",
      ],
    ]
    for (const [channel, call, request, internalCode, code, message] of cases) {
      const { ipc, servicePorts } = setup()
      servicePorts.calls[call].mockRejectedValueOnce(
        new BlogImportError(
          internalCode,
          "secret https://user:token@github.com/openai/quartz",
          String.raw`C:\\secret`,
        ),
      )
      const result = await ipc.invoke(channel, trustedEvent, request)
      expect(result).toEqual({ ok: false, error: { code, message } })
      expect(JSON.stringify(result)).not.toContain("secret")
      expect(JSON.stringify(result)).not.toContain("token")
    }
    const { ipc, servicePorts } = setup()
    servicePorts.calls.blogsClone.mockRejectedValueOnce(
      new BlogImportError("UNMAPPED" as BlogImportErrorCode, "secret"),
    )
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.blogsClone, trustedEvent, {
        url: "https://github.com/openai/quartz",
        destination: String.raw`C:\\Blogs\\quartz`,
        name: "Quartz",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    })
  })

  it("fails closed for prototype-key and valid-looking non-import blog failures", async () => {
    const request = {
      url: "https://github.com/openai/quartz",
      destination: String.raw`C:\\Blogs\\quartz`,
      name: "Quartz",
    }
    for (const error of [
      new BlogImportError("constructor" as BlogImportErrorCode, "secret C:\\private"),
      new BlogImportError(
        "__proto__" as BlogImportErrorCode,
        "secret https://user:token@github.com/openai/quartz",
      ),
      { code: "BLOG_CLONE_FAILED", message: "secret C:\\private\\stdout" },
      {
        code: "WORKSPACE_ACCESS_FAILED",
        message: "secret https://user:token@github.com/openai/quartz",
      },
    ]) {
      const { ipc, servicePorts } = setup()
      servicePorts.calls.blogsClone.mockRejectedValueOnce(error)
      const result = await ipc.invoke(IPC_CHANNELS.requests.blogsClone, trustedEvent, request)
      expect(result).toEqual({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "The application could not complete the request.",
        },
      })
      expect(JSON.stringify(result)).not.toContain("secret")
      expect(JSON.stringify(result)).not.toContain("token")
    }
  })

  it("keeps the finite blog channel allowlist safe until the optional service is wired", async () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    delete (servicePorts as { blogs?: unknown }).blogs
    registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: (event) => event === trustedEvent,
      eventTargets: () => [],
    })
    await expect(ipc.invoke(IPC_CHANNELS.requests.blogsList, trustedEvent)).resolves.toEqual({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "Blog management is not available." },
    })
  })

  it("forwards only validated blog progress and cleans the blog subscription", () => {
    const { servicePorts, sent, dispose } = setup()
    expect(servicePorts.blogSubscriptions()).toBe(1)
    servicePorts.emitBlogProgress({
      phase: "cloning",
      message: "Cloning blog.",
      stdout: "secret",
    } as never)
    servicePorts.emitBlogProgress({ phase: "cloning", message: "Cloning blog." })
    expect(sent).toEqual([
      [IPC_CHANNELS.events.blogsImportProgress, { phase: "cloning", message: "Cloning blog." }],
    ])
    dispose()
    expect(servicePorts.blogSubscriptions()).toBe(0)
  })

  it("does not emit blog progress when the trusted target provider returns no targets", () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const eventTargets = vi.fn((): readonly IpcEventTarget[] => [])
    registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: () => true,
      eventTargets,
    })
    servicePorts.emitBlogProgress({ phase: "cloning", message: "Cloning blog." })
    expect(eventTargets).toHaveBeenCalledOnce()
  })
  it("registers only the explicit request allowlist", () => {
    const { ipc, dispose } = setup()
    expect([...ipc.handlers.keys()].sort()).toEqual(
      [...Object.values(IPC_CHANNELS.requests)].sort(),
    )
    expect(ipc.handlers.has("shell.exec")).toBe(false)
    expect(ipc.handlers.has("fs.readFile")).toBe(false)
    dispose()
    expect(ipc.handlers.size).toBe(0)
  })

  it("routes the exact domain request pairs and validates every successful result", async () => {
    const { ipc, servicePorts } = setup()
    const domains = [
      {
        slug: "artificial-intelligence",
        name: "Artificial Intelligence",
        description: "Notes about artificial intelligence.",
        order: 4,
        publicNotes: 2,
        privateNotes: 1,
      },
    ]
    const pairs = [
      [IPC_CHANNELS.requests.domainsList, undefined, "domainsList"],
      [
        IPC_CHANNELS.requests.domainsCreate,
        { name: "Artificial Intelligence", slug: "artificial-intelligence" },
        "domainsCreate",
      ],
      [
        IPC_CHANNELS.requests.domainsRename,
        { slug: "artificial-intelligence", name: "AI" },
        "domainsRename",
      ],
      [IPC_CHANNELS.requests.domainsRemove, { slug: "artificial-intelligence" }, "domainsRemove"],
    ] as const

    for (const [channel, request, call] of pairs) {
      servicePorts.calls[call].mockResolvedValueOnce(domains)
      await expect(ipc.invoke(channel, trustedEvent, request)).resolves.toEqual({
        ok: true,
        value: domains,
      })
      expect(servicePorts.calls[call]).toHaveBeenCalledWith(
        ...(request === undefined ? [] : [request]),
      )
    }

    servicePorts.calls.domainsList.mockResolvedValueOnce([{ ...domains[0], publicNotes: -1 }])
    await expect(ipc.invoke(IPC_CHANNELS.requests.domainsList, trustedEvent)).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    })
  })

  it("rejects strict invalid and untrusted domain requests before service dispatch", async () => {
    const { ipc, servicePorts } = setup()
    const cases = [
      [IPC_CHANNELS.requests.domainsList, {}, "domainsList"],
      [
        IPC_CHANNELS.requests.domainsCreate,
        { name: "Artificial Intelligence", slug: "AI", extra: true },
        "domainsCreate",
      ],
      [IPC_CHANNELS.requests.domainsRename, { slug: "life", name: "   " }, "domainsRename"],
      [IPC_CHANNELS.requests.domainsRemove, { slug: "../life" }, "domainsRemove"],
    ] as const

    for (const [channel, request, call] of cases) {
      await expect(ipc.invoke(channel, trustedEvent, request)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      })
      await expect(
        ipc.invoke(channel, { sender: { isDestroyed: () => false } }, request),
      ).resolves.toMatchObject({ ok: false, error: { code: "IPC_UNAUTHORIZED" } })
      expect(servicePorts.calls[call]).not.toHaveBeenCalled()
    }
  })

  it("rolls back every earlier domain handler when registration finds a duplicate", () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const occupied = vi.fn(async () => undefined)
    ipc.handle(IPC_CHANNELS.requests.domainsRename, occupied)

    expect(() =>
      registerPublisherIpc({
        ipcMain: ipc,
        services: servicePorts,
        isTrustedSender: () => true,
        eventTargets: () => [],
        includeBlogManagement: false,
      }),
    ).toThrow(`duplicate handler: ${IPC_CHANNELS.requests.domainsRename}`)
    expect([...ipc.handlers.entries()]).toEqual([[IPC_CHANNELS.requests.domainsRename, occupied]])
  })

  it("validates every request before a service sees it", async () => {
    const { ipc, servicePorts } = setup()
    const invalidRequests: Array<[string, unknown, string]> = [
      [IPC_CHANNELS.requests.workspaceInspect, { workspace: "C:/elsewhere" }, "workspaceInspect"],
      [IPC_CHANNELS.requests.domainsList, {}, "domainsList"],
      [
        IPC_CHANNELS.requests.domainsCreate,
        { name: "New domain", slug: "New-Domain" },
        "domainsCreate",
      ],
      [
        IPC_CHANNELS.requests.domainsRename,
        { slug: "life", name: "Life", extra: true },
        "domainsRename",
      ],
      [IPC_CHANNELS.requests.domainsRemove, { slug: "private" }, "domainsRemove"],
      [IPC_CHANNELS.requests.notesList, {}, "notesList"],
      [IPC_CHANNELS.requests.notesRead, { path: "../private/secret.md" }, "notesRead"],
      [IPC_CHANNELS.requests.notesSave, { path: "content/life/a.md" }, "notesSave"],
      [IPC_CHANNELS.requests.notesCreate, { domain: "secrets" }, "notesCreate"],
      [
        IPC_CHANNELS.requests.notesCreate,
        {
          visibility: "public",
          domain: "life",
          slug: "empty-tags",
          title: "Empty tags",
          date: "2026-09-24",
          description: "Invalid note",
          tags: [],
        },
        "notesCreate",
      ],
      [
        IPC_CHANNELS.requests.notesRename,
        { path: "content/life/a.md", slug: "../b" },
        "notesRename",
      ],
      [
        IPC_CHANNELS.requests.notesChangeVisibility,
        { path: "content/life/a.md", visibility: "hidden" },
        "notesChangeVisibility",
      ],
      [IPC_CHANNELS.requests.notesTrash, { path: "C:\\Windows\\win.ini" }, "notesTrash"],
      [IPC_CHANNELS.requests.previewStart, { preferredPort: 70_000 }, "previewStart"],
      [IPC_CHANNELS.requests.previewStop, null, "previewStop"],
      [IPC_CHANNELS.requests.previewStatus, {}, "previewStatus"],
      [IPC_CHANNELS.requests.changesList, [], "changesList"],
      [IPC_CHANNELS.requests.changesCancel, {}, "changesCancel"],
      [IPC_CHANNELS.requests.publishStart, { changeGroupIds: ["../secret"] }, "publishStart"],
      [
        IPC_CHANNELS.requests.publishStart,
        { changeGroupIds: ["note:a", "note:a"] },
        "publishStart",
      ],
      [IPC_CHANNELS.requests.publishCancel, { operationId: "../bad" }, "publishCancel"],
      [IPC_CHANNELS.requests.historyGit, { limit: 0 }, "historyGit"],
      [IPC_CHANNELS.requests.historyGit, { requestId: "../bad" }, "historyGit"],
      [IPC_CHANNELS.requests.historyDeployments, { limit: 101 }, "historyDeployments"],
      [IPC_CHANNELS.requests.historyCancel, { requestId: "../bad" }, "historyCancel"],
      [IPC_CHANNELS.requests.blogsList, {}, "blogsList"],
      [IPC_CHANNELS.requests.blogsChooseLocal, {}, "blogsChooseLocal"],
      [
        IPC_CHANNELS.requests.blogsAddLocal,
        { path: "relative\\quartz", name: "Quartz", extra: true },
        "blogsAddLocal",
      ],
      [
        IPC_CHANNELS.requests.blogsRecoverLocal,
        { path: "relative\\quartz", name: "Quartz", extra: true },
        "blogsRecoverLocal",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        {
          url: "https://github.com/openai/quartz?token=secret",
          destination: String.raw`C:\\Blogs\\quartz`,
          name: "Quartz",
          extra: true,
        },
        "blogsClone",
      ],
      [IPC_CHANNELS.requests.blogsCancelImport, {}, "blogsCancelImport"],
      [
        IPC_CHANNELS.requests.blogsInstall,
        { path: "relative\\quartz", extra: true },
        "blogsInstall",
      ],
      [
        IPC_CHANNELS.requests.blogsRename,
        { id: "not-a-uuid", name: "Quartz", extra: true },
        "blogsRename",
      ],
      [
        IPC_CHANNELS.requests.blogsRelocate,
        { id: "not-a-uuid", path: "relative\\quartz", extra: true },
        "blogsRelocate",
      ],
      [IPC_CHANNELS.requests.blogsRemove, { id: "not-a-uuid", extra: true }, "blogsRemove"],
      [IPC_CHANNELS.requests.blogsOpenFolder, { id: "not-a-uuid", extra: true }, "blogsOpenFolder"],
      [IPC_CHANNELS.requests.blogsSwitch, { id: "not-a-uuid", extra: true }, "blogsSwitch"],
    ]

    for (const [channel, request, call] of invalidRequests) {
      const result = await ipc.invoke(channel, trustedEvent, request)
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
      expect(servicePorts.calls[call]).not.toHaveBeenCalled()
    }
  })

  it("enforces the Markdown limit in UTF-8 bytes rather than UTF-16 code units", async () => {
    const { ipc, servicePorts } = setup()
    const markdown = "界".repeat(Math.floor((16 * 1024 * 1024) / 3) + 1)
    const result = await ipc.invoke(IPC_CHANNELS.requests.notesSave, trustedEvent, {
      path: "content/life/a.md",
      markdown,
      expectedMtimeMs: 1,
      expectedContentHash: "a".repeat(64),
    })
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect(servicePorts.calls.notesSave).not.toHaveBeenCalled()
  })

  it("accepts only a trusted, strictly validated close acknowledgement", async () => {
    const { ipc, acknowledgeClose } = setup()
    const request = { requestId: "11111111-1111-4111-8111-111111111111", success: false }
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.lifecycleCloseAck, trustedEvent, request),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(acknowledgeClose).toHaveBeenCalledWith(request)
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.lifecycleCloseAck, trustedEvent, {
        ...request,
        force: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect(acknowledgeClose).toHaveBeenCalledOnce()
  })

  it("accepts only normalized managed note paths", async () => {
    const { ipc, servicePorts } = setup()
    const paths = [
      "../content/life/a.md",
      "content/life/../../private/life/secret.md",
      "/content/life/a.md",
      "C:/garden/content/life/a.md",
      String.raw`content\life\a.md`,
      "content/_assets/a/file.png",
      "content/life/A.md",
    ]
    for (const path of paths) {
      const result = await ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, { path })
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    }
    expect(servicePorts.calls.notesRead).not.toHaveBeenCalled()

    servicePorts.calls.notesRead.mockResolvedValueOnce({
      path: "private/life/daily-note.md",
      markdown: "# Daily",
      mtimeMs: 1,
      contentHash: "a".repeat(64),
    })
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
        path: "private/life/daily-note.md",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        path: "private/life/daily-note.md",
        markdown: "# Daily",
        mtimeMs: 1,
        contentHash: "a".repeat(64),
      },
    })
    expect(servicePorts.calls.notesRead).toHaveBeenCalledWith({
      path: "private/life/daily-note.md",
    })
  })

  it("rejects untrusted or destroyed senders before dispatch", async () => {
    const { ipc, servicePorts } = setup()
    const result = await ipc.invoke(IPC_CHANNELS.requests.notesList, {
      sender: { id: 7, isDestroyed: () => true },
    })
    expect(result).toEqual({
      ok: false,
      error: { code: "IPC_UNAUTHORIZED", message: "This application window is not authorized." },
    })
    expect(servicePorts.calls.notesList).not.toHaveBeenCalled()
  })

  it("rejects every blog channel before service dispatch for an untrusted sender", async () => {
    const { ipc, servicePorts } = setup()
    const id = "11111111-1111-4111-8111-111111111111"
    const destination = String.raw`C:\\Blogs\\quartz`
    const calls: readonly [string, unknown, string][] = [
      [IPC_CHANNELS.requests.blogsList, undefined, "blogsList"],
      [IPC_CHANNELS.requests.blogsChooseLocal, undefined, "blogsChooseLocal"],
      [IPC_CHANNELS.requests.blogsAddLocal, { path: destination, name: "Quartz" }, "blogsAddLocal"],
      [
        IPC_CHANNELS.requests.blogsRecoverLocal,
        { path: destination, name: "Recovered" },
        "blogsRecoverLocal",
      ],
      [
        IPC_CHANNELS.requests.blogsClone,
        { url: "https://github.com/openai/quartz", destination, name: "Quartz" },
        "blogsClone",
      ],
      [IPC_CHANNELS.requests.blogsCancelImport, undefined, "blogsCancelImport"],
      [IPC_CHANNELS.requests.blogsInstall, { path: destination }, "blogsInstall"],
      [IPC_CHANNELS.requests.blogsRename, { id, name: "Quartz" }, "blogsRename"],
      [IPC_CHANNELS.requests.blogsRelocate, { id, path: destination }, "blogsRelocate"],
      [IPC_CHANNELS.requests.blogsRemove, { id }, "blogsRemove"],
      [IPC_CHANNELS.requests.blogsOpenFolder, { id }, "blogsOpenFolder"],
      [IPC_CHANNELS.requests.blogsSwitch, { id, editorSaved: true }, "blogsSwitch"],
    ]
    for (const [channel, request, call] of calls) {
      await expect(
        ipc.invoke(channel, { sender: { isDestroyed: () => false } }, request),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "IPC_UNAUTHORIZED" },
      })
      expect(servicePorts.calls[call]).not.toHaveBeenCalled()
    }
  })

  it("fails closed when sender authorization races with destruction", async () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: () => {
        throw new Error("window destroyed")
      },
      eventTargets: () => [],
    })

    await expect(ipc.invoke(IPC_CHANNELS.requests.notesList, trustedEvent)).resolves.toEqual({
      ok: false,
      error: { code: "IPC_UNAUTHORIZED", message: "This application window is not authorized." },
    })
    expect(servicePorts.calls.notesList).not.toHaveBeenCalled()
  })

  it("serializes typed errors and hides unexpected exception details", async () => {
    const { ipc, servicePorts } = setup()
    const typed: AppError = { code: "EXTERNAL_EDIT", message: "The note changed on disk." }
    servicePorts.calls.notesRead.mockRejectedValueOnce(typed)
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
        path: "content/life/daily.md",
      }),
    ).resolves.toEqual({ ok: false, error: typed })

    servicePorts.calls.notesRead.mockRejectedValueOnce(
      new Error("secret C:\\Users\\11546\\Desktop\\web\\private\\life\\diary.md"),
    )
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
        path: "content/life/daily.md",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    })
  })

  it("validates and strips every successful service response", async () => {
    const { ipc, servicePorts } = setup()
    const extra = { privateSource: "secret", callback: () => undefined }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    servicePorts.calls.notesList.mockResolvedValueOnce([
      {
        path: "content/life/daily.md",
        domain: "life",
        slug: "daily",
        title: "Daily",
        date: "2026-09-24",
        description: "Daily note",
        visibility: "public",
        updatedAt: "2026-09-24T00:00:00.000Z",
        tags: ["life"],
        privateSource: "secret",
      },
    ])
    await expect(ipc.invoke(IPC_CHANNELS.requests.notesList, trustedEvent)).resolves.toEqual({
      ok: true,
      value: [
        {
          path: "content/life/daily.md",
          domain: "life",
          slug: "daily",
          title: "Daily",
          date: "2026-09-24",
          description: "Daily note",
          visibility: "public",
          updatedAt: "2026-09-24T00:00:00.000Z",
          tags: ["life"],
        },
      ],
    })

    servicePorts.calls.notesRead.mockResolvedValueOnce({
      path: "content/life/daily.md",
      markdown: "# Daily",
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      extra,
      cyclic,
    })
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
        path: "content/life/daily.md",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        path: "content/life/daily.md",
        markdown: "# Daily",
        mtimeMs: 1,
        contentHash: "a".repeat(64),
      },
    })

    servicePorts.calls.notesRead.mockResolvedValueOnce({ path: "content/life/daily.md" })
    await expect(
      ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
        path: "content/life/daily.md",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application could not complete the request." },
    })
  })

  it("rejects semantically inconsistent workspace inspection results", async () => {
    const { ipc, servicePorts } = setup()
    servicePorts.calls.workspaceInspect.mockResolvedValueOnce({
      ok: true,
      root: "C:/garden",
      capabilities: { files: true, preview: true, git: false, publish: false },
      issues: [{ code: "GIT_UNAVAILABLE", message: "Git is unavailable." }],
    })
    await expect(ipc.invoke(IPC_CHANNELS.requests.workspaceInspect, trustedEvent)).resolves.toEqual(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "The application could not complete the request.",
        },
      },
    )
  })

  it("drops public error details so secret-shaped fields cannot cross", async () => {
    const { ipc, servicePorts } = setup()
    const cyclic: Record<string, unknown> = {
      command: "secret",
      huge: "x".repeat(20_000),
      apiKey: "api-secret",
      authorization: "bearer-secret",
      cookie: "session-secret",
      privateSource: "private-secret",
    }
    cyclic.self = cyclic
    servicePorts.calls.notesRead.mockRejectedValueOnce({
      code: "NOTE_FILE_ACCESS_FAILED",
      message: "Could not read note.",
      details: { path: "content/life/daily.md", cyclic, callback: () => undefined },
    })
    const result = await ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
      path: "content/life/daily.md",
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOTE_FILE_ACCESS_FAILED", message: "Could not read note." },
    })
    expect(result).toEqual({
      ok: false,
      error: { code: "NOTE_FILE_ACCESS_FAILED", message: "Could not read note." },
    })
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(8_192)
    expect(JSON.stringify(result)).not.toContain("callback")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("forwards validated progress only to live authorized targets and cleans subscriptions", () => {
    const { servicePorts, sent, dispose } = setup()
    expect(servicePorts.previewSubscriptions()).toBe(1)
    expect(servicePorts.publishSubscriptions()).toBe(1)

    servicePorts.emitPreview({
      state: "ready",
      generation: 1,
      port: 4173,
      url: "http://127.0.0.1:4173/",
    })
    servicePorts.emitPublish({ phase: "validating", message: "Checking", percent: 25 })
    expect(sent).toEqual([
      [IPC_CHANNELS.events.previewProgress, expect.objectContaining({ state: "ready" })],
      [IPC_CHANNELS.events.publishProgress, expect.objectContaining({ phase: "validating" })],
    ])

    dispose()
    expect(servicePorts.previewSubscriptions()).toBe(0)
    expect(servicePorts.publishSubscriptions()).toBe(0)
  })

  it("isolates event target destruction races from service producers", () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: () => true,
      eventTargets: () => {
        throw new Error("window destroyed")
      },
    })
    expect(() => servicePorts.emitPreview({ state: "starting", generation: 1 })).not.toThrow()
  })

  it("removes every handler even when a service unsubscribe fails", () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const previewUnsubscribe = vi.fn(() => {
      throw new Error("preview cleanup failed")
    })
    const publishUnsubscribe = vi.fn()
    Object.defineProperty(servicePorts.preview, "subscribe", {
      value: vi.fn(() => previewUnsubscribe),
    })
    Object.defineProperty(servicePorts.publish, "subscribe", {
      value: vi.fn(() => publishUnsubscribe),
    })
    const dispose = registerPublisherIpc({
      ipcMain: ipc,
      services: servicePorts,
      isTrustedSender: () => true,
      eventTargets: () => [],
    })

    expect(dispose).not.toThrow()
    expect(previewUnsubscribe).toHaveBeenCalledOnce()
    expect(publishUnsubscribe).toHaveBeenCalledOnce()
    expect(ipc.handlers.size).toBe(0)
  })

  it("rolls back an earlier subscription when a later subscription fails", () => {
    const ipc = new FakeIpcMain()
    const servicePorts = services()
    const previewUnsubscribe = vi.fn()
    Object.defineProperty(servicePorts.preview, "subscribe", {
      value: vi.fn(() => previewUnsubscribe),
    })
    Object.defineProperty(servicePorts.publish, "subscribe", {
      value: vi.fn(() => {
        throw new Error("publish subscription failed")
      }),
    })

    expect(() =>
      registerPublisherIpc({
        ipcMain: ipc,
        services: servicePorts,
        isTrustedSender: () => true,
        eventTargets: () => [],
      }),
    ).toThrow("publish subscription failed")
    expect(previewUnsubscribe).toHaveBeenCalledOnce()
    expect(ipc.handlers.size).toBe(0)
  })
})

class FakeIpcRenderer implements IpcRendererPort {
  readonly invokes: Array<[string, unknown?]> = []
  readonly listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()

  async invoke(channel: string, request?: unknown): Promise<unknown> {
    this.invokes.push([channel, request])
    return { ok: true, value: channel }
  }

  on(channel: string, listener: (event: unknown, payload: unknown) => void): this {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return this
  }

  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): this {
    this.listeners.get(channel)?.delete(listener)
    return this
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({}, payload)
  }
}

describe("preload garden API", () => {
  it("exposes domain management through the shared renderer contract", () => {
    const api: SharedGardenApi = createGardenApi(new FakeIpcRenderer())
    void api.domains.list()
    void api.domains.create({ name: "Artificial Intelligence", slug: "artificial-intelligence" })
    void api.domains.rename({ slug: "artificial-intelligence", name: "AI" })
    void api.domains.remove({ slug: "artificial-intelligence" })
  })

  it("is deeply frozen and contains no raw Electron, path, shell, or command capability", () => {
    const api = createGardenApi(new FakeIpcRenderer())
    expect(Object.isFrozen(api)).toBe(true)
    for (const namespace of Object.values(api)) expect(Object.isFrozen(namespace)).toBe(true)
    expect(api).not.toHaveProperty("ipcRenderer")
    expect(api).not.toHaveProperty("fs")
    expect(api).not.toHaveProperty("shell")
    expect(api).not.toHaveProperty("exec")
    expect(Object.keys(api).sort()).toEqual(
      [
        "blogs",
        "changes",
        "history",
        "lifecycle",
        "domains",
        "notes",
        "preview",
        "publish",
        "workspace",
      ].sort(),
    )
  })

  it("maps each method to its one allowlisted channel", async () => {
    const ipc = new FakeIpcRenderer()
    const api = createGardenApi(ipc)
    await api.blogs.list()
    await api.blogs.chooseLocal()
    await api.blogs.addLocal({ path: String.raw`C:\\Blogs\\quartz`, name: "Quartz" })
    await api.blogs.recoverLocal({ path: String.raw`C:\\Blogs\\quartz`, name: "Recovered" })
    await api.blogs.clone({
      url: "https://github.com/openai/quartz",
      destination: String.raw`C:\\Blogs\\quartz`,
      name: "Quartz",
    })
    await api.blogs.cancelImport()
    await api.blogs.install({ path: String.raw`C:\\Blogs\\quartz` })
    await api.blogs.rename({ id: "11111111-1111-4111-8111-111111111111", name: "Quartz" })
    await api.blogs.relocate({
      id: "11111111-1111-4111-8111-111111111111",
      path: String.raw`C:\\Blogs\\moved`,
    })
    await api.blogs.remove({ id: "11111111-1111-4111-8111-111111111111" })
    await api.blogs.openFolder({ id: "11111111-1111-4111-8111-111111111111" })
    await api.blogs.switch({ id: "11111111-1111-4111-8111-111111111111", editorSaved: true })
    await api.workspace.inspectSafety()
    await api.workspace.inspect()
    await api.workspace.repair({ action: "install-dependencies" })
    await api.domains.list()
    await api.domains.create({ name: "Artificial Intelligence", slug: "artificial-intelligence" })
    await api.domains.rename({ slug: "artificial-intelligence", name: "AI" })
    await api.domains.remove({ slug: "artificial-intelligence" })
    await api.notes.list()
    await api.notes.read({ path: "content/life/a.md" })
    await api.notes.save({
      path: "content/life/a.md",
      markdown: "# A",
      expectedMtimeMs: 1,
      expectedContentHash: "a".repeat(64),
    })
    await api.notes.create({
      visibility: "public",
      domain: "life",
      slug: "a",
      title: "A",
      date: "2026-09-24",
      description: "A note",
      tags: ["life"],
    })
    await api.notes.rename({ path: "content/life/a.md", newSlug: "b" })
    await api.notes.changeVisibility({ path: "content/life/a.md", visibility: "private" })
    await api.notes.trash({ path: "content/life/a.md" })
    await api.notes.recovery.get({ path: "content/life/a.md" })
    await api.notes.recovery.write({
      path: "content/life/a.md",
      markdown: "# draft",
      baseMtimeMs: 1,
      baseContentHash: "a".repeat(64),
    })
    await api.notes.recovery.discard({
      path: "content/life/a.md",
      contentHash: "b".repeat(64),
    })
    await api.preview.start({ preferredPort: 4173 })
    await api.preview.stop()
    await api.preview.status()
    await api.changes.list()
    await api.changes.cancel()
    await api.publish.start({ changeGroupIds: ["note:a"], message: "Publish A" })
    await api.publish.cancel({ operationId: "publish-1" })
    await api.history.git({ limit: 20, requestId: "history-1" })
    await api.history.deployments({ limit: 20, requestId: "history-1" })
    await api.history.cancel({ requestId: "history-1" })
    await api.history.openLink({
      url: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
    })
    await api.lifecycle.acknowledgeClose({
      requestId: "11111111-1111-4111-8111-111111111111",
      success: true,
    })

    expect(ipc.invokes.map(([channel]) => channel).sort()).toEqual(
      Object.values(IPC_CHANNELS.requests).sort(),
    )
  })

  it("maps domain methods to exact channels and request objects", async () => {
    const ipc = new FakeIpcRenderer()
    const api = createGardenApi(ipc)
    const create = { name: "Artificial Intelligence", slug: "artificial-intelligence" }
    const rename = { slug: "artificial-intelligence", name: "AI" }
    const remove = { slug: "artificial-intelligence" }

    await api.domains.list()
    await api.domains.create(create)
    await api.domains.rename(rename)
    await api.domains.remove(remove)

    expect(ipc.invokes).toEqual([
      [IPC_CHANNELS.requests.domainsList, undefined],
      [IPC_CHANNELS.requests.domainsCreate, create],
      [IPC_CHANNELS.requests.domainsRename, rename],
      [IPC_CHANNELS.requests.domainsRemove, remove],
    ])
  })

  it("validates domain results at the preload boundary", async () => {
    const ipc = new FakeIpcRenderer()
    ipc.invoke = vi.fn(async () => ({
      ok: true,
      value: [
        {
          slug: "life",
          name: "Life",
          description: "Life notes.",
          order: 0,
          publicNotes: -1,
          privateNotes: 0,
        },
      ],
    }))

    await expect(createGardenApi(ipc).domains.list()).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application returned an invalid response." },
    })
  })

  it("replaces malformed main-process envelopes with a fixed internal error", async () => {
    const ipc = new FakeIpcRenderer()
    ipc.invoke = vi.fn(async () => ({ ok: true, value: { path: "private/life/a.md" } }))
    const result = await createGardenApi(ipc).notes.read({ path: "content/life/a.md" })
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application returned an invalid response." },
    })
  })

  it("converts synchronous invoke throws and asynchronous rejections to fixed results", async () => {
    const expected = {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application returned an invalid response." },
    }
    const synchronous = new FakeIpcRenderer()
    synchronous.invoke = vi.fn(() => {
      throw new Error("sync transport failure")
    })
    await expect(createGardenApi(synchronous).notes.list()).resolves.toEqual(expected)

    const asynchronous = new FakeIpcRenderer()
    asynchronous.invoke = vi.fn(async () => Promise.reject(new Error("async transport failure")))
    await expect(createGardenApi(asynchronous).notes.list()).resolves.toEqual(expected)
  })

  it("rejects inconsistent workspace inspection envelopes in preload", async () => {
    const ipc = new FakeIpcRenderer()
    ipc.invoke = vi.fn(async () => ({
      ok: true,
      value: {
        ok: true,
        root: "C:/garden",
        capabilities: { files: false, preview: false, git: false, publish: false },
        issues: [{ code: "GIT_UNAVAILABLE", message: "Git is unavailable." }],
      },
    }))
    await expect(createGardenApi(ipc).workspace.inspect()).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The application returned an invalid response." },
    })
  })

  it("returns unsubscribe functions that remove only their wrapped listener", () => {
    const ipc = new FakeIpcRenderer()
    const api = createGardenApi(ipc)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = api.preview.onProgress(first)
    api.preview.onProgress(second)
    ipc.emit(IPC_CHANNELS.events.previewProgress, { state: "ready", generation: -1 })
    ipc.emit(IPC_CHANNELS.events.previewProgress, { state: "starting", generation: 1 })
    unsubscribeFirst()
    ipc.emit(IPC_CHANNELS.events.previewProgress, { state: "ready", generation: 1 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it("validates blog progress before dispatching and unsubscribes its wrapped listener", () => {
    const ipc = new FakeIpcRenderer()
    const listener = vi.fn()
    const unsubscribe = createGardenApi(ipc).blogs.onImportProgress(listener)
    ipc.emit(IPC_CHANNELS.events.blogsImportProgress, {
      phase: "cloning",
      message: "Cloning blog.",
      stdout: "secret",
    })
    ipc.emit(IPC_CHANNELS.events.blogsImportProgress, {
      phase: "cloning",
      message: "Cloning blog.",
    })
    unsubscribe()
    ipc.emit(IPC_CHANNELS.events.blogsImportProgress, {
      phase: "complete",
      message: "Blog import complete.",
    })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ phase: "cloning", message: "Cloning blog." })
  })

  it("validates lifecycle events and removes their wrapped listeners", () => {
    const ipc = new FakeIpcRenderer()
    const api = createGardenApi(ipc)
    const beforeClose = vi.fn()
    const blocked = vi.fn()
    const unsubscribe = api.lifecycle.onBeforeClose(beforeClose)
    api.lifecycle.onCloseBlocked(blocked)
    ipc.emit(IPC_CHANNELS.events.beforeClose, { requestId: "not-a-uuid" })
    ipc.emit(IPC_CHANNELS.events.beforeClose, {
      requestId: "11111111-1111-4111-8111-111111111111",
    })
    ipc.emit(IPC_CHANNELS.events.closeBlocked, { message: "保存失败" })
    unsubscribe()
    ipc.emit(IPC_CHANNELS.events.beforeClose, {
      requestId: "22222222-2222-4222-8222-222222222222",
    })
    expect(beforeClose).toHaveBeenCalledOnce()
    expect(blocked).toHaveBeenCalledWith("保存失败")
  })
})
