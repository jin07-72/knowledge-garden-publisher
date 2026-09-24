import { describe, expect, it, vi } from "vitest"
import {
  IPC_CHANNELS,
  type AppError,
  type PreviewStatus,
  type PublishProgress,
} from "../../src/shared/contracts"
import {
  registerPublisherIpc,
  type IpcEventTarget,
  type IpcMainPort,
  type PublisherIpcServices,
} from "../../src/main/ipc"
import { createGardenApi, type IpcRendererPort } from "../../src/preload/gardenApi"

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
  previewSubscriptions(): number
  publishSubscriptions(): number
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

  return {
    calls,
    workspace: { inspect: call("workspaceInspect") },
    notes: {
      list: call("notesList"),
      read: call("notesRead"),
      save: call("notesSave"),
      create: call("notesCreate"),
      rename: call("notesRename"),
      changeVisibility: call("notesChangeVisibility"),
      trash: call("notesTrash"),
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
    changes: { list: call("changesList") },
    publish: {
      start: call("publishStart"),
      cancel: call("publishCancel"),
      subscribe(listener) {
        publishListeners.add(listener)
        return () => publishListeners.delete(listener)
      },
    },
    history: { git: call("historyGit"), deployments: call("historyDeployments") },
    emitPreview(status) {
      for (const listener of previewListeners) listener(status)
    },
    emitPublish(progress) {
      for (const listener of publishListeners) listener(progress)
    },
    previewSubscriptions: () => previewListeners.size,
    publishSubscriptions: () => publishListeners.size,
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
  const dispose = registerPublisherIpc({
    ipcMain: ipc,
    services: servicePorts,
    isTrustedSender: (event) => event === trustedEvent,
    eventTargets: () => [target],
  })
  return { ipc, servicePorts, sent, dispose }
}

describe("secure publisher IPC", () => {
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

  it("validates every request before a service sees it", async () => {
    const { ipc, servicePorts } = setup()
    const invalidRequests: Array<[string, unknown, string]> = [
      [IPC_CHANNELS.requests.workspaceInspect, { workspace: "C:/elsewhere" }, "workspaceInspect"],
      [IPC_CHANNELS.requests.notesList, {}, "notesList"],
      [IPC_CHANNELS.requests.notesRead, { path: "../private/secret.md" }, "notesRead"],
      [IPC_CHANNELS.requests.notesSave, { path: "content/life/a.md" }, "notesSave"],
      [IPC_CHANNELS.requests.notesCreate, { domain: "secrets" }, "notesCreate"],
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
      [IPC_CHANNELS.requests.publishStart, { changeGroupIds: ["../secret"] }, "publishStart"],
      [IPC_CHANNELS.requests.publishCancel, { operationId: "../bad" }, "publishCancel"],
      [IPC_CHANNELS.requests.historyGit, { limit: 0 }, "historyGit"],
      [IPC_CHANNELS.requests.historyDeployments, { limit: 501 }, "historyDeployments"],
    ]

    for (const [channel, request, call] of invalidRequests) {
      const result = await ipc.invoke(channel, trustedEvent, request)
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
      expect(servicePorts.calls[call]).not.toHaveBeenCalled()
    }
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

    await expect(
      ipc.invoke(IPC_CHANNELS.requests.notesRead, trustedEvent, {
        path: "private/life/daily-note.md",
      }),
    ).resolves.toEqual({ ok: true, value: { source: "notesRead" } })
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
  it("is deeply frozen and contains no raw Electron, path, shell, or command capability", () => {
    const api = createGardenApi(new FakeIpcRenderer())
    expect(Object.isFrozen(api)).toBe(true)
    for (const namespace of Object.values(api)) expect(Object.isFrozen(namespace)).toBe(true)
    expect(api).not.toHaveProperty("ipcRenderer")
    expect(api).not.toHaveProperty("fs")
    expect(api).not.toHaveProperty("shell")
    expect(api).not.toHaveProperty("exec")
    expect(Object.keys(api).sort()).toEqual(
      ["changes", "history", "notes", "preview", "publish", "workspace"].sort(),
    )
  })

  it("maps each method to its one allowlisted channel", async () => {
    const ipc = new FakeIpcRenderer()
    const api = createGardenApi(ipc)
    await api.workspace.inspect()
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
    await api.preview.start({ preferredPort: 4173 })
    await api.preview.stop()
    await api.preview.status()
    await api.changes.list()
    await api.publish.start({ changeGroupIds: ["note:a"], message: "Publish A" })
    await api.publish.cancel({ operationId: "publish-1" })
    await api.history.git({ limit: 20 })
    await api.history.deployments({ limit: 20 })

    expect(ipc.invokes.map(([channel]) => channel)).toEqual(Object.values(IPC_CHANNELS.requests))
  })

  it("returns unsubscribe functions that remove only their wrapped listener", () => {
    const ipc = new FakeIpcRenderer()
    const api = createGardenApi(ipc)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = api.preview.onProgress(first)
    api.preview.onProgress(second)
    ipc.emit(IPC_CHANNELS.events.previewProgress, { state: "starting", generation: 1 })
    unsubscribeFirst()
    ipc.emit(IPC_CHANNELS.events.previewProgress, { state: "ready", generation: 1 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
