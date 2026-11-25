import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance"
import type { AppearanceSnapshot, PreviewStatus } from "../../src/shared/contracts"
import type {
  AppearanceAdapter,
  AppearancePlan,
} from "../../src/main/services/appearance/appearanceAdapter"
import type { AppearanceAssetService } from "../../src/main/services/appearance/appearanceAssets"
import {
  createAppearanceService,
  hasAppearanceUndoHistory,
  type AppearanceServiceDependencies,
} from "../../src/main/services/appearance/appearanceService"

const sessionOne = "11111111-1111-4111-8111-111111111111"
const sessionTwo = "22222222-2222-4222-8222-222222222222"
const baselineHash = "a".repeat(64)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(overrides: Partial<AppearanceSnapshot> = {}): AppearanceSnapshot {
  return {
    framework: "quartz",
    supported: true,
    settings: DEFAULT_APPEARANCE,
    baselineHash,
    canUndo: false,
    ...overrides,
  }
}

function plan(): AppearancePlan {
  return {
    baselineHash,
    settings: DEFAULT_APPEARANCE,
    writes: [],
    deletes: [],
  }
}

function adapter(current = snapshot()): AppearanceAdapter {
  return {
    framework: current.framework,
    read: vi.fn(async () => current),
    plan: vi.fn(async () => plan()),
  }
}

function assets(): AppearanceAssetService {
  return {
    choose: vi.fn(async () => ({
      source: "staged" as const,
      token: sessionOne,
      name: "hero.png",
    })),
    resolve: vi.fn(() => ({
      token: sessionOne,
      name: "hero.png",
      extension: ".png" as const,
      hash: "b".repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
    })),
    consume: vi.fn(() => ({
      token: sessionOne,
      name: "hero.png",
      extension: ".png" as const,
      hash: "b".repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
    })),
    dispose: vi.fn(),
  }
}

function previewRuntime(overrides: Partial<AppearanceServiceDependencies["preview"]> = {}) {
  let status: PreviewStatus = {
    state: "ready",
    generation: 4,
    port: 4173,
    url: "http://127.0.0.1:4173/",
  }
  return {
    getStatus: vi.fn(() => status),
    stop: vi.fn(async () => {
      status = { state: "stopped", generation: status.generation }
      return status
    }),
    start: vi.fn(async () => {
      status = {
        state: "ready",
        generation: status.generation + 1,
        port: 4173,
        url: "http://127.0.0.1:4173/",
      }
      return status
    }),
    ...overrides,
  }
}

function dependencies(
  overrides: Partial<AppearanceServiceDependencies> = {},
): AppearanceServiceDependencies {
  return {
    workspace: "C:/Blogs/garden",
    adapter: adapter(),
    assets: assets(),
    preview: previewRuntime(),
    installPreview: vi.fn(async () => true),
    removePreview: vi.fn(async () => true),
    executePlan: vi.fn(async (_workspace, _plan, verifyBuild) => {
      await verifyBuild()
      return { id: sessionOne, status: "verified" as const, canUndo: true }
    }),
    undoTransaction: vi.fn(async (_workspace, _baseline, verifyBuild) => {
      await verifyBuild()
      return { id: sessionTwo, status: "undone" as const, canUndo: false }
    }),
    recoverTransactions: vi.fn(async () => []),
    hasUndoHistory: vi.fn(async () => false),
    ...overrides,
  }
}

describe("appearance service", () => {
  it("reads the adapter snapshot and preserves recovered undo state", async () => {
    const current = snapshot()
    const service = await createAppearanceService(
      dependencies({
        adapter: adapter(current),
        recoverTransactions: vi.fn(async () => [
          { id: sessionOne, status: "recovered" as const, canUndo: true },
        ]),
      }),
    )

    await expect(service.read()).resolves.toEqual({ ...current, canUndo: true })
  })

  it("does not erase undo capability reported by the adapter", async () => {
    const current = snapshot({ canUndo: true })
    const service = await createAppearanceService(
      dependencies({ adapter: adapter(current), recoverTransactions: vi.fn(async () => []) }),
    )

    await expect(service.read()).resolves.toEqual(current)
  })

  it("restores one-step undo capability from durable history after restart", async () => {
    const service = await createAppearanceService(
      dependencies({
        recoverTransactions: vi.fn(async () => []),
        hasUndoHistory: vi.fn(async () => true),
      }),
    )

    await expect(service.read()).resolves.toMatchObject({ canUndo: true })
  })

  it("discovers the ordinary durable current history directory after service restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "appearance-restart-history-"))
    try {
      await mkdir(join(root, ".garden-publisher", "appearance-history", "current"), {
        recursive: true,
      })
      const service = await createAppearanceService(
        dependencies({
          workspace: root,
          recoverTransactions: vi.fn(async () => []),
          hasUndoHistory: undefined,
        }),
      )

      await expect(service.read()).resolves.toMatchObject({ canUndo: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps unsupported frameworks read-only", async () => {
    const unsupported = snapshot({
      framework: "hugo",
      supported: false,
      message: "Hugo appearance support is not installed.",
    })
    const service = await createAppearanceService(
      dependencies({ adapter: adapter(unsupported), recoverTransactions: vi.fn(async () => []) }),
    )

    await expect(service.read()).resolves.toEqual(unsupported)
    await expect(
      service.preview({
        url: "http://127.0.0.1:4173/",
        sessionId: sessionOne,
        settings: DEFAULT_APPEARANCE,
      }),
    ).rejects.toMatchObject({ code: "APPEARANCE_UNSUPPORTED" })
  })

  it("delegates background selection without exposing paths", async () => {
    const assetService = assets()
    const service = await createAppearanceService(dependencies({ assets: assetService }))

    await expect(service.chooseBackground()).resolves.toEqual({
      source: "staged",
      token: sessionOne,
      name: "hero.png",
    })
    expect(assetService.choose).toHaveBeenCalledOnce()
  })

  it("serializes preview injection so the newest request is the final applied style", async () => {
    const first = deferred<boolean>()
    const calls: string[] = []
    const installPreview = vi.fn(async ({ css }: { readonly css: string }) => {
      calls.push(css)
      if (calls.length === 1) return first.promise
      return true
    })
    const service = await createAppearanceService(dependencies({ installPreview }))
    const older = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })
    const newerSettings = {
      ...DEFAULT_APPEARANCE,
      colors: { ...DEFAULT_APPEARANCE.colors, accent: "#ff0000" },
    }
    const newer = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionTwo,
      settings: newerSettings,
    })

    await vi.waitFor(() => expect(installPreview).toHaveBeenCalledTimes(1))
    first.resolve(true)
    await expect(Promise.all([older, newer])).resolves.toEqual([
      { sessionId: sessionOne },
      { sessionId: sessionTwo },
    ])
    expect(calls.at(-1)).toContain("--publisher-accent: #ff0000")
  })

  it("orders preview supersession by call arrival before asynchronous framework reads", async () => {
    const firstRead = deferred<AppearanceSnapshot>()
    const currentAdapter = adapter(snapshot())
    vi.mocked(currentAdapter.read)
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValue(snapshot())
    const installPreview = vi.fn(async (_request: { readonly css: string }) => true)
    const service = await createAppearanceService(
      dependencies({ adapter: currentAdapter, installPreview }),
    )
    const older = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })
    const newer = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionTwo,
      settings: {
        ...DEFAULT_APPEARANCE,
        colors: { ...DEFAULT_APPEARANCE.colors, accent: "#ff0000" },
      },
    })

    await expect(newer).resolves.toEqual({ sessionId: sessionTwo })
    firstRead.resolve(snapshot())
    await expect(older).resolves.toEqual({ sessionId: sessionOne })
    expect(installPreview).toHaveBeenCalledTimes(1)
    expect(installPreview.mock.calls[0]?.[0].css).toContain("--publisher-accent: #ff0000")
  })

  it("preserves the PreviewManager baseDir in managed background URLs", async () => {
    const installPreview = vi.fn(async (_request: { readonly css: string }) => true)
    const service = await createAppearanceService(dependencies({ installPreview }))
    const baseDir = "0123456789abcdef0123456789abcdef"
    const name = `${"b".repeat(64)}.png`

    await service.preview({
      url: `http://127.0.0.1:4173/${baseDir}/notes/a`,
      sessionId: sessionOne,
      settings: {
        ...DEFAULT_APPEARANCE,
        background: {
          kind: "image",
          asset: { source: "managed", name },
          overlay: "#000000",
          opacity: 0.5,
          position: "center",
          fixed: false,
        },
      },
    })

    expect(installPreview.mock.calls[0]?.[0].css).toContain(
      `url("http://127.0.0.1:4173/${baseDir}/publisher/${name}")`,
    )
  })

  it.each([
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
    "0123456789abcdef0123456789abcdeg",
    "0123456789ABCDEF0123456789ABCDEF",
  ])("does not trust malformed preview baseDir segment %s", async (baseDir) => {
    const installPreview = vi.fn(async (_request: { readonly css: string }) => true)
    const service = await createAppearanceService(dependencies({ installPreview }))
    const name = `${"b".repeat(64)}.png`

    await service.preview({
      url: `http://127.0.0.1:4173/${baseDir}/notes/a`,
      sessionId: sessionOne,
      settings: {
        ...DEFAULT_APPEARANCE,
        background: {
          kind: "image",
          asset: { source: "managed", name },
          overlay: "#000000",
          opacity: 0.5,
          position: "center",
          fixed: false,
        },
      },
    })

    expect(installPreview.mock.calls[0]?.[0].css).toContain(
      `url("http://127.0.0.1:4173/publisher/${name}")`,
    )
    expect(installPreview.mock.calls[0]?.[0].css).not.toContain(`/${baseDir}/publisher/`)
  })

  it("does not infer a PreviewManager baseDir from a backslash-normalized path", async () => {
    const installPreview = vi.fn(async (_request: { readonly css: string }) => true)
    const service = await createAppearanceService(dependencies({ installPreview }))
    const baseDir = "0123456789abcdef0123456789abcdef"
    const name = `${"b".repeat(64)}.png`

    await service.preview({
      url: String.raw`http://127.0.0.1:4173/${baseDir}\notes/a`,
      sessionId: sessionOne,
      settings: {
        ...DEFAULT_APPEARANCE,
        background: {
          kind: "image",
          asset: { source: "managed", name },
          overlay: "#000000",
          opacity: 0.5,
          position: "center",
          fixed: false,
        },
      },
    })

    expect(installPreview.mock.calls[0]?.[0].css).toContain(
      `url("http://127.0.0.1:4173/publisher/${name}")`,
    )
    expect(installPreview.mock.calls[0]?.[0].css).not.toContain(`/${baseDir}/publisher/`)
  })

  it("detects only an ordinary canonical durable undo directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "appearance-undo-history-"))
    const historyRoot = join(root, ".garden-publisher", "appearance-history")
    const current = join(historyRoot, "current")
    const foreign = join(root, "foreign")
    try {
      await mkdir(current, { recursive: true })
      await expect(hasAppearanceUndoHistory(root)).resolves.toBe(true)

      await rm(current, { recursive: true })
      await writeFile(current, "not a directory")
      await expect(hasAppearanceUndoHistory(root)).resolves.toBe(false)

      await rm(current)
      await mkdir(foreign)
      await symlink(foreign, current, process.platform === "win32" ? "junction" : "dir")
      await expect(hasAppearanceUndoHistory(root)).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("clears only the tracked preview session", async () => {
    const removePreview = vi.fn(async () => true)
    const service = await createAppearanceService(dependencies({ removePreview }))
    await service.preview({
      url: "http://127.0.0.1:4173/notes/a",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })

    await service.clearPreview({ sessionId: sessionTwo })
    expect(removePreview).not.toHaveBeenCalled()
    await service.clearPreview({ sessionId: sessionOne })
    expect(removePreview).toHaveBeenCalledExactlyOnceWith({
      url: "http://127.0.0.1:4173/notes/a",
      sessionId: sessionOne,
    })
  })

  it("forwards a validated component preview target to the frame installer", async () => {
    const installPreview = vi.fn(async () => true)
    const service = await createAppearanceService(dependencies({ installPreview }))

    await service.preview({
      url: "http://127.0.0.1:4173/notes/a",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
      target: { componentId: "domainCard", state: "hover" },
    })

    expect(installPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:4173/notes/a",
        sessionId: sessionOne,
        target: { componentId: "domainCard", state: "hover" },
      }),
    )
  })

  it("clearing an older session does not supersede a newer preview still reading", async () => {
    const nextRead = deferred<AppearanceSnapshot>()
    const currentAdapter = adapter(snapshot())
    const installPreview = vi.fn(async (_request: { readonly css: string }) => true)
    const removePreview = vi.fn(async () => true)
    const service = await createAppearanceService(
      dependencies({ adapter: currentAdapter, installPreview, removePreview }),
    )
    await service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })
    vi.mocked(currentAdapter.read).mockImplementationOnce(() => nextRead.promise)
    const newer = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionTwo,
      settings: {
        ...DEFAULT_APPEARANCE,
        colors: { ...DEFAULT_APPEARANCE.colors, accent: "#ff0000" },
      },
    })
    await vi.waitFor(() => expect(currentAdapter.read).toHaveBeenCalledTimes(2))

    await service.clearPreview({ sessionId: sessionOne })
    nextRead.resolve(snapshot())
    await newer

    expect(removePreview).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
    })
    expect(installPreview).toHaveBeenCalledTimes(2)
    expect(installPreview.mock.calls.at(-1)?.[0].css).toContain("--publisher-accent: #ff0000")
  })

  it("applies a plan, clears the draft, restarts preview, and exposes undo", async () => {
    const currentAdapter = adapter(snapshot())
    const removePreview = vi.fn(async () => true)
    const runtime = previewRuntime()
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await verifyBuild()
      return { id: sessionOne, status: "verified" as const, canUndo: true }
    })
    const service = await createAppearanceService(
      dependencies({
        adapter: currentAdapter,
        preview: runtime,
        removePreview,
        executePlan,
      }),
    )
    await service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })

    await expect(service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })).resolves.toEqual({
      snapshot: { ...snapshot(), canUndo: true },
    })
    expect(removePreview).toHaveBeenCalledBefore(executePlan)
    expect(currentAdapter.plan).toHaveBeenCalledWith(DEFAULT_APPEARANCE, baselineHash, undefined)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(runtime.start).toHaveBeenCalledExactlyOnceWith({ workspace: "C:/Blogs/garden" })
  })

  it("lets preview build failure escape the verifier so the executor can roll back", async () => {
    const runtime = previewRuntime({
      start: vi
        .fn()
        .mockResolvedValueOnce({
          state: "error" as const,
          generation: 5,
          error: { code: "PREVIEW_BUILD_FAILED" as const, message: "Quartz build failed." },
        })
        .mockResolvedValueOnce({ state: "ready" as const, generation: 5 }),
    })
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await expect(verifyBuild()).rejects.toMatchObject({ code: "PREVIEW_BUILD_FAILED" })
      throw {
        code: "APPEARANCE_TRANSACTION_FAILED",
        message: "The appearance update failed and was rolled back.",
      }
    })
    const service = await createAppearanceService(dependencies({ preview: runtime, executePlan }))

    await expect(
      service.apply({ settings: DEFAULT_APPEARANCE, baselineHash }),
    ).rejects.toMatchObject({ code: "APPEARANCE_TRANSACTION_FAILED" })
    expect(executePlan).toHaveBeenCalledOnce()
  })

  it("undoes through the same preview rebuild verifier", async () => {
    const runtime = previewRuntime()
    const undoTransaction = vi.fn(async (_workspace, baseline, verifyBuild) => {
      expect(baseline).toBe(baselineHash)
      await verifyBuild()
      return { id: sessionTwo, status: "undone" as const, canUndo: false }
    })
    const service = await createAppearanceService(
      dependencies({ preview: runtime, undoTransaction }),
    )

    await expect(service.undo({ baselineHash })).resolves.toEqual({
      snapshot: { ...snapshot(), canUndo: false },
    })
    expect(undoTransaction).toHaveBeenCalledOnce()
  })

  it("rejects a concurrent mutation instead of overlapping apply and undo", async () => {
    const release = deferred<void>()
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await verifyBuild()
      await release.promise
      return { id: sessionOne, status: "verified" as const, canUndo: true }
    })
    const service = await createAppearanceService(dependencies({ executePlan }))
    const applying = service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
    await vi.waitFor(() => expect(executePlan).toHaveBeenCalledOnce())

    await expect(service.undo({ baselineHash })).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
    release.resolve()
    await applying
  })

  it.each(["apply", "undo"] as const)(
    "rejects preview while a %s mutation remains in flight",
    async (kind) => {
      const release = deferred<void>()
      const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
        await verifyBuild()
        await release.promise
        return { id: sessionOne, status: "verified" as const, canUndo: true }
      })
      const undoTransaction = vi.fn(async (_workspace, _baseline, verifyBuild) => {
        await verifyBuild()
        await release.promise
        return { id: sessionTwo, status: "undone" as const, canUndo: false }
      })
      const service = await createAppearanceService(dependencies({ executePlan, undoTransaction }))
      const mutation =
        kind === "apply"
          ? service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
          : service.undo({ baselineHash })
      await vi.waitFor(() =>
        expect(kind === "apply" ? executePlan : undoTransaction).toHaveBeenCalledOnce(),
      )

      await expect(
        service.preview({
          url: "http://127.0.0.1:4173/",
          sessionId: sessionOne,
          settings: DEFAULT_APPEARANCE,
        }),
      ).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
      release.resolve()
      await mutation
    },
  )

  it("supersedes an older preview even when mutation validation fails first", async () => {
    const olderRead = deferred<AppearanceSnapshot>()
    const currentAdapter = adapter(snapshot())
    vi.mocked(currentAdapter.read)
      .mockImplementationOnce(() => olderRead.promise)
      .mockRejectedValueOnce(new Error("adapter read failed"))
    const installPreview = vi.fn(async () => true)
    const service = await createAppearanceService(
      dependencies({ adapter: currentAdapter, installPreview }),
    )
    const older = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })

    await expect(service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })).rejects.toThrow(
      "adapter read failed",
    )
    olderRead.resolve(snapshot())
    await expect(older).resolves.toEqual({ sessionId: sessionOne })
    expect(installPreview).not.toHaveBeenCalled()
  })

  it("supersedes an older asynchronous preview after a successful mutation", async () => {
    const olderRead = deferred<AppearanceSnapshot>()
    const currentAdapter = adapter(snapshot())
    vi.mocked(currentAdapter.read)
      .mockImplementationOnce(() => olderRead.promise)
      .mockResolvedValue(snapshot())
    const installPreview = vi.fn(async () => true)
    const service = await createAppearanceService(
      dependencies({ adapter: currentAdapter, installPreview }),
    )
    const older = service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })

    await expect(
      service.apply({ settings: DEFAULT_APPEARANCE, baselineHash }),
    ).resolves.toMatchObject({ snapshot: { canUndo: true } })
    olderRead.resolve(snapshot())
    await expect(older).resolves.toEqual({ sessionId: sessionOne })
    expect(installPreview).not.toHaveBeenCalled()
  })

  it("keeps preview busy between build verification and transaction commit", async () => {
    const commit = deferred<void>()
    const verified = deferred<void>()
    const installPreview = vi.fn(async () => true)
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await verifyBuild()
      verified.resolve()
      await commit.promise
      return { id: sessionOne, status: "verified" as const, canUndo: true }
    })
    const service = await createAppearanceService(dependencies({ executePlan, installPreview }))
    const applying = service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
    await verified.promise

    await expect(
      service.preview({
        url: "http://127.0.0.1:4173/",
        sessionId: sessionTwo,
        settings: DEFAULT_APPEARANCE,
      }),
    ).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
    expect(installPreview).not.toHaveBeenCalled()
    commit.resolve()
    await applying
  })

  it.each(["apply", "undo"] as const)(
    "restores the rolled-back preview after a failed %s build",
    async (kind) => {
      let status: PreviewStatus = { state: "ready", generation: 4 }
      let starts = 0
      const runtime = previewRuntime({
        getStatus: vi.fn(() => status),
        stop: vi.fn(async () => {
          status = { state: "stopped", generation: status.generation }
          return status
        }),
        start: vi.fn(async () => {
          starts += 1
          status =
            starts === 1
              ? {
                  state: "error",
                  generation: status.generation + 1,
                  error: { code: "PREVIEW_BUILD_FAILED", message: "new appearance failed" },
                }
              : { state: "ready", generation: status.generation + 1 }
          return status
        }),
      })
      const failed = {
        code: "APPEARANCE_TRANSACTION_FAILED" as const,
        message: "The appearance update failed and was rolled back.",
      }
      const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
        await expect(verifyBuild()).rejects.toMatchObject({ code: "PREVIEW_BUILD_FAILED" })
        throw failed
      })
      const undoTransaction = vi.fn(async (_workspace, _baseline, verifyBuild) => {
        await expect(verifyBuild()).rejects.toMatchObject({ code: "PREVIEW_BUILD_FAILED" })
        throw failed
      })
      const service = await createAppearanceService(
        dependencies({ preview: runtime, executePlan, undoTransaction }),
      )
      const mutation =
        kind === "apply"
          ? service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
          : service.undo({ baselineHash })

      await expect(mutation).rejects.toEqual(failed)
      expect(runtime.start).toHaveBeenCalledTimes(2)
      expect(runtime.getStatus()).toMatchObject({ state: "ready", generation: 6 })
    },
  )

  it("reports preview recovery failure after transaction rollback", async () => {
    let status: PreviewStatus = { state: "ready", generation: 4 }
    let starts = 0
    const runtime = previewRuntime({
      getStatus: vi.fn(() => status),
      stop: vi.fn(async () => {
        status = { state: "stopped", generation: status.generation }
        return status
      }),
      start: vi.fn(async () => {
        starts += 1
        status = {
          state: "error",
          generation: status.generation + 1,
          error: {
            code: "PREVIEW_BUILD_FAILED",
            message: starts === 1 ? "new appearance failed" : "old appearance recovery failed",
          },
        }
        return status
      }),
    })
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await expect(verifyBuild()).rejects.toMatchObject({ code: "PREVIEW_BUILD_FAILED" })
      throw {
        code: "APPEARANCE_TRANSACTION_FAILED",
        message: "The appearance update failed and was rolled back.",
      }
    })
    const service = await createAppearanceService(dependencies({ preview: runtime, executePlan }))

    await expect(service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })).rejects.toEqual({
      code: "PREVIEW_BUILD_FAILED",
      message: "old appearance recovery failed",
    })
    expect(runtime.start).toHaveBeenCalledTimes(2)
  })

  it("restores the rolled-back preview when the executor preserves a verification conflict", async () => {
    let status: PreviewStatus = { state: "ready", generation: 4 }
    let starts = 0
    const runtime = previewRuntime({
      getStatus: vi.fn(() => status),
      stop: vi.fn(async () => {
        status = { state: "stopped", generation: status.generation }
        return status
      }),
      start: vi.fn(async () => {
        starts += 1
        status =
          starts === 1
            ? {
                state: "error",
                generation: status.generation + 1,
                error: { code: "PREVIEW_BUILD_FAILED", message: "new appearance failed" },
              }
            : { state: "ready", generation: status.generation + 1 }
        return status
      }),
    })
    const conflict = {
      code: "APPEARANCE_CONFLICT" as const,
      message: "Appearance files changed during verification.",
    }
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await expect(verifyBuild()).rejects.toMatchObject({ code: "PREVIEW_BUILD_FAILED" })
      throw conflict
    })
    const service = await createAppearanceService(dependencies({ preview: runtime, executePlan }))

    await expect(service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })).rejects.toEqual(
      conflict,
    )
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(runtime.getStatus()).toMatchObject({ state: "ready" })
  })

  it("does not claim preview recovery when rollback is uncertain", async () => {
    const runtime = previewRuntime({
      start: vi.fn(async () => ({
        state: "error" as const,
        generation: 5,
        error: { code: "PREVIEW_BUILD_FAILED" as const, message: "new appearance failed" },
      })),
    })
    const uncertain = {
      code: "APPEARANCE_TRANSACTION_UNCERTAIN" as const,
      message: "The appearance update could not be safely resolved.",
    }
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await expect(verifyBuild()).rejects.toMatchObject({ code: "PREVIEW_BUILD_FAILED" })
      throw uncertain
    })
    const service = await createAppearanceService(dependencies({ preview: runtime, executePlan }))

    await expect(service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })).rejects.toEqual(
      uncertain,
    )
    expect(runtime.start).toHaveBeenCalledOnce()
  })

  it.each(["apply", "undo"] as const)(
    "rolls back %s when the verified snapshot cannot be read",
    async (kind) => {
      const currentAdapter = adapter(snapshot())
      vi.mocked(currentAdapter.read)
        .mockResolvedValueOnce(snapshot())
        .mockRejectedValueOnce(new Error("snapshot read failed"))
      let rolledBack = false
      const failed = {
        code: "APPEARANCE_TRANSACTION_FAILED" as const,
        message: "The appearance update failed and was rolled back.",
      }
      const executor = async (verifyBuild: () => Promise<void>) => {
        try {
          await verifyBuild()
        } catch {
          rolledBack = true
          throw failed
        }
        return { id: sessionOne, status: "verified" as const, canUndo: kind === "apply" }
      }
      const service = await createAppearanceService(
        dependencies({
          adapter: currentAdapter,
          executePlan: vi.fn(async (_workspace, _plan, verifyBuild) => executor(verifyBuild)),
          undoTransaction: vi.fn(async (_workspace, _baseline, verifyBuild) =>
            executor(verifyBuild),
          ),
        }),
      )
      const mutation =
        kind === "apply"
          ? service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
          : service.undo({ baselineHash })

      await expect(mutation).rejects.toEqual(failed)
      expect(rolledBack).toBe(true)
    },
  )

  it.each([
    ["apply", false, true],
    ["undo", true, false],
  ] as const)(
    "caches the verified snapshot before %s commit and returns exact canUndo",
    async (kind, adapterCanUndo, expectedCanUndo) => {
      const currentAdapter = adapter(snapshot({ canUndo: adapterCanUndo }))
      let readsAtCommit = 0
      const executor = async (verifyBuild: () => Promise<void>) => {
        await verifyBuild()
        readsAtCommit = vi.mocked(currentAdapter.read).mock.calls.length
        return { id: sessionOne, status: "verified" as const, canUndo: expectedCanUndo }
      }
      const service = await createAppearanceService(
        dependencies({
          adapter: currentAdapter,
          executePlan: vi.fn(async (_workspace, _plan, verifyBuild) => executor(verifyBuild)),
          undoTransaction: vi.fn(async (_workspace, _baseline, verifyBuild) =>
            executor(verifyBuild),
          ),
        }),
      )
      const receipt =
        kind === "apply"
          ? await service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
          : await service.undo({ baselineHash })

      expect(readsAtCommit).toBe(2)
      expect(currentAdapter.read).toHaveBeenCalledTimes(2)
      expect(receipt.snapshot.canUndo).toBe(expectedCanUndo)
    },
  )

  it("consumes a staged asset only after the verified transaction commits", async () => {
    const assetService = assets()
    const settings = {
      ...DEFAULT_APPEARANCE,
      background: {
        kind: "image" as const,
        asset: { source: "staged" as const, token: sessionOne, name: "hero.png" },
        overlay: "#000000",
        opacity: 0.5,
        position: "center" as const,
        fixed: false,
      },
    }
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await verifyBuild()
      expect(assetService.consume).not.toHaveBeenCalled()
      return { id: sessionOne, status: "verified" as const, canUndo: true }
    })
    const service = await createAppearanceService(
      dependencies({ assets: assetService, executePlan }),
    )

    await service.apply({ settings, baselineHash })

    expect(assetService.consume).toHaveBeenCalledExactlyOnceWith(sessionOne)
  })

  it("invalidates pending previews and clears owned resources on dispose", async () => {
    const assetService = assets()
    const removePreview = vi.fn(async () => true)
    const service = await createAppearanceService(
      dependencies({ assets: assetService, removePreview }),
    )
    await service.preview({
      url: "http://127.0.0.1:4173/",
      sessionId: sessionOne,
      settings: DEFAULT_APPEARANCE,
    })

    await service.dispose()
    expect(removePreview).toHaveBeenCalledOnce()
    expect(assetService.dispose).toHaveBeenCalledOnce()
    await expect(service.read()).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
  })

  it("lets an already committed mutation return its receipt while disposal waits", async () => {
    const committed = deferred<void>()
    const executePlan = vi.fn(async (_workspace, _plan, verifyBuild) => {
      await verifyBuild()
      await committed.promise
      return { id: sessionOne, status: "verified" as const, canUndo: true }
    })
    const service = await createAppearanceService(dependencies({ executePlan }))
    const applying = service.apply({ settings: DEFAULT_APPEARANCE, baselineHash })
    await vi.waitFor(() => expect(executePlan).toHaveBeenCalledOnce())

    const disposal = service.dispose()
    committed.resolve()

    await expect(applying).resolves.toMatchObject({ snapshot: { canUndo: true } })
    await expect(disposal).resolves.toBeUndefined()
  })
})
