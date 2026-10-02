// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createRelaunchScheduler,
  createBlogManagementAdapter,
  createBlogRuntime,
  resolveBlogRegistryFile,
  resolveE2eCloneSource,
} from "../../src/main/blogRuntime"
import type { BlogRecord, BlogRegistryView } from "../../src/shared/contracts"
import { BlogImportError } from "../../src/main/services/blogImport"
import { createPublisherCloseCoordinator } from "../../src/main/publisherServices"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "blog-runtime-"))
  temporaryDirectories.push(path)
  return path
}

const first: BlogRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "First",
  path: String.raw`C:\Blogs\first`,
  canonicalPath: String.raw`C:\Blogs\first`,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastOpenedAt: "2026-10-01T00:00:00.000Z",
}
const second: BlogRecord = {
  ...first,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Second",
  path: String.raw`C:\Blogs\second`,
  canonicalPath: String.raw`C:\Blogs\second`,
}

function state(activeBlogId = first.id): BlogRegistryView {
  return { version: 1, activeBlogId, blogs: [first, second] }
}

describe("blog runtime", () => {
  it("validates the active registry workspace before returning it", async () => {
    const inspect = vi.fn(async () => ({
      valid: true as const,
      canonicalPath: first.canonicalPath,
      needsInstall: false,
    }))
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate: vi.fn() },
      inspect,
      assertIdle: vi.fn(),
      dispose: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    })

    await expect(runtime.active()).resolves.toEqual(first)
    expect(inspect).toHaveBeenCalledWith(first.canonicalPath)
  })

  it.each([
    { inspection: { valid: false as const, code: "INVALID_DIRECTORY", message: "missing" } },
    {
      inspection: {
        valid: true as const,
        canonicalPath: String.raw`C:\Blogs\elsewhere`,
        needsInstall: false,
      },
    },
  ])("fails safely when the active workspace is unavailable or moved", async ({ inspection }) => {
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate: vi.fn() },
      inspect: async () => inspection,
      assertIdle: vi.fn(),
      dispose: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    })

    await expect(runtime.active()).rejects.toMatchObject({ code: "BLOG_WORKSPACE_UNAVAILABLE" })
  })

  it("switches in the exact validate, idle, dispose, activate, relaunch, quit order", async () => {
    const order: string[] = []
    const runtime = createBlogRuntime({
      registry: {
        load: async () => {
          order.push("load")
          return state()
        },
        activate: async () => {
          order.push("activate")
          return state(second.id)
        },
      },
      inspect: async () => {
        order.push("inspect")
        return { valid: true, canonicalPath: second.canonicalPath, needsInstall: false }
      },
      assertIdle: async () => {
        order.push("idle")
      },
      dispose: async () => {
        order.push("dispose")
      },
      relaunch: () => order.push("relaunch"),
      quit: () => order.push("quit"),
    })

    await runtime.switchTo({ id: second.id, editorSaved: true })
    expect(order).toEqual(["load", "inspect", "idle", "dispose", "activate", "relaunch", "quit"])
  })

  it("quits exactly once and preserves a relaunch failure after activation", async () => {
    const relaunchError = new Error("relaunch failed")
    const quitError = new Error("quit failed")
    const relaunch = vi.fn(() => {
      throw relaunchError
    })
    const quit = vi.fn(() => {
      throw quitError
    })
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate: async () => state(second.id) },
      inspect: async () => ({
        valid: true,
        canonicalPath: second.canonicalPath,
        needsInstall: false,
      }),
      assertIdle: async () => undefined,
      dispose: async () => undefined,
      relaunch,
      quit,
    })

    await expect(runtime.switchTo({ id: second.id, editorSaved: true })).rejects.toBe(relaunchError)
    expect(relaunch).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it("preserves an activation failure when both terminal calls also fail", async () => {
    const activationError = new Error("activation failed")
    const relaunch = vi.fn(() => {
      throw new Error("relaunch failed")
    })
    const quit = vi.fn(() => {
      throw new Error("quit failed")
    })
    const runtime = createBlogRuntime({
      registry: {
        load: async () => state(),
        activate: async () => {
          throw activationError
        },
      },
      inspect: async () => ({
        valid: true,
        canonicalPath: second.canonicalPath,
        needsInstall: false,
      }),
      assertIdle: async () => undefined,
      dispose: async () => undefined,
      relaunch,
      quit,
    })

    await expect(runtime.switchTo({ id: second.id, editorSaved: true })).rejects.toBe(
      activationError,
    )
    expect(relaunch).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it("rejects direct switch calls that do not confirm a saved editor", async () => {
    const load = vi.fn(async () => state())
    const runtime = createBlogRuntime({
      registry: { load, activate: vi.fn() },
      inspect: vi.fn(),
      assertIdle: vi.fn(),
      dispose: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    })

    await expect(
      runtime.switchTo({ id: second.id, editorSaved: false } as never),
    ).rejects.toMatchObject({ code: "BLOG_EDITOR_UNSAVED" })
    expect(load).not.toHaveBeenCalled()
  })

  it.each(["inspect", "idle", "dispose"] as const)(
    "preserves the active blog when %s fails before activation",
    async (failure) => {
      let active = first.id
      const activate = vi.fn(async (id: string) => {
        active = id
        return state(id)
      })
      const fail = async (stage: typeof failure): Promise<void> => {
        if (failure === stage) throw new Error(`${stage} failed`)
      }
      const runtime = createBlogRuntime({
        registry: { load: async () => state(active), activate },
        inspect: async () => {
          await fail("inspect")
          return { valid: true, canonicalPath: second.canonicalPath, needsInstall: false }
        },
        assertIdle: () => fail("idle"),
        dispose: () => fail("dispose"),
        relaunch: vi.fn(),
        quit: vi.fn(),
      })

      await expect(runtime.switchTo({ id: second.id, editorSaved: true })).rejects.toThrow()
      expect(active).toBe(first.id)
      expect(activate).not.toHaveBeenCalled()
    },
  )

  it("relaunches the unchanged active blog when activation fails after disposal", async () => {
    const order: string[] = []
    const relaunch = vi.fn(() => order.push("relaunch"))
    const quit = vi.fn(() => order.push("quit"))
    const runtime = createBlogRuntime({
      registry: {
        load: async () => state(),
        activate: async () => {
          order.push("activate")
          throw new Error("registry write failed")
        },
      },
      inspect: async () => ({
        valid: true,
        canonicalPath: second.canonicalPath,
        needsInstall: false,
      }),
      assertIdle: async () => undefined,
      dispose: async () => {
        order.push("dispose")
      },
      relaunch,
      quit,
    })

    await expect(runtime.switchTo({ id: second.id, editorSaved: true })).rejects.toThrow(
      "registry write failed",
    )
    expect(order).toEqual(["dispose", "activate", "relaunch", "quit"])
  })

  it("ignores the E2E registry override in packaged builds", () => {
    expect(
      resolveBlogRegistryFile({
        isPackaged: true,
        e2e: true,
        userDataPath: String.raw`C:\Users\me\AppData\Publisher`,
        override: String.raw`C:\temp\blogs.json`,
      }),
    ).toBe(String.raw`C:\Users\me\AppData\Publisher\blogs.json`)
  })

  it("accepts an absolute registry override only for unpackaged E2E runs", () => {
    expect(
      resolveBlogRegistryFile({
        isPackaged: false,
        e2e: true,
        userDataPath: String.raw`C:\Users\me\AppData\Publisher`,
        override: String.raw`C:\temp\blogs.json`,
      }),
    ).toBe(String.raw`C:\temp\blogs.json`)
    expect(
      resolveBlogRegistryFile({
        isPackaged: false,
        e2e: false,
        userDataPath: String.raw`C:\Users\me\AppData\Publisher`,
        override: String.raw`C:\temp\blogs.json`,
      }),
    ).toBe(String.raw`C:\Users\me\AppData\Publisher\blogs.json`)
  })
})

describe("E2E clone source", () => {
  it("accepts an existing absolute local Git source only in unpackaged E2E mode", async () => {
    const root = await temporaryDirectory()
    const source = join(root, "fixture.git")
    await mkdir(source)

    expect(resolveE2eCloneSource({ isPackaged: false, e2e: true, override: source })).toBe(source)
    expect(resolveE2eCloneSource({ isPackaged: true, e2e: true, override: source })).toBeUndefined()
    expect(
      resolveE2eCloneSource({ isPackaged: false, e2e: false, override: source }),
    ).toBeUndefined()
  })

  it("rejects missing, relative, and non-directory override paths", async () => {
    const root = await temporaryDirectory()
    const file = join(root, "fixture.bundle")
    await writeFile(file, "not a repository directory")

    expect(
      resolveE2eCloneSource({ isPackaged: false, e2e: true, override: "fixture.git" }),
    ).toBeUndefined()
    expect(
      resolveE2eCloneSource({
        isPackaged: false,
        e2e: true,
        override: join(root, "missing.git"),
      }),
    ).toBeUndefined()
    expect(resolveE2eCloneSource({ isPackaged: false, e2e: true, override: file })).toBeUndefined()
  })
})

describe("relaunch scheduler", () => {
  it.each([
    { isPackaged: true, e2e: true },
    { isPackaged: false, e2e: false },
  ])("uses the real application relaunch outside unpackaged E2E mode", async (mode) => {
    const root = await temporaryDirectory()
    const marker = join(root, "relaunch-requested")
    const relaunch = vi.fn()
    const record = vi.fn()
    const schedule = createRelaunchScheduler({ ...mode, marker, relaunch, record })

    schedule()

    expect(relaunch).toHaveBeenCalledOnce()
    expect(record).not.toHaveBeenCalled()
  })

  it("records the actual scheduling call instead of spawning only in unpackaged E2E", async () => {
    const root = await temporaryDirectory()
    const marker = join(root, "relaunch-requested")
    const relaunch = vi.fn()
    const record = vi.fn()
    const schedule = createRelaunchScheduler({
      isPackaged: false,
      e2e: true,
      marker,
      relaunch,
      record,
    })

    schedule()

    expect(record).toHaveBeenCalledWith(marker, "relaunch-requested")
    expect(relaunch).not.toHaveBeenCalled()
  })

  it("fails closed to the real relaunch when the E2E marker is not a valid absolute target", () => {
    const relaunch = vi.fn()
    const record = vi.fn()
    const schedule = createRelaunchScheduler({
      isPackaged: false,
      e2e: true,
      marker: "relative-marker",
      relaunch,
      record,
    })

    schedule()

    expect(relaunch).toHaveBeenCalledOnce()
    expect(record).not.toHaveBeenCalled()
  })
})

describe("blog management adapter", () => {
  it("reports active workspace availability without exposing inspection failures", async () => {
    const registry = {
      load: vi.fn(async () => state()),
      add: vi.fn(async () => state()),
      rename: vi.fn(async () => state()),
      activate: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      relocate: vi.fn(async () => state()),
      recover: vi.fn(async () => state()),
    }
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, code: "SECRET_PATH_ERROR", message: "C:\\secret" })
      .mockRejectedValueOnce(new Error("C:\\secret"))
      .mockResolvedValueOnce({
        valid: true,
        canonicalPath: first.canonicalPath,
        needsInstall: false,
      })
    const adapter = createBlogManagementAdapter({
      registry,
      importer: { clone: vi.fn(), install: vi.fn() },
      inspect,
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(adapter.services.list()).resolves.toMatchObject({
      activeAvailability: "unavailable",
    })
    await expect(adapter.services.list()).resolves.toMatchObject({
      activeAvailability: "unavailable",
    })
    await expect(adapter.services.list()).resolves.toMatchObject({
      activeAvailability: "available",
    })
  })

  it("keeps registry management available without constructing workspace services", async () => {
    const registry = {
      load: vi.fn(async () => state()),
      add: vi.fn(async () => state()),
      rename: vi.fn(async () => state()),
      activate: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      relocate: vi.fn(async () => state()),
      recover: vi.fn(async () => state()),
    }
    const adapter = createBlogManagementAdapter({
      registry,
      importer: { clone: vi.fn(), install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(async () => undefined),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(adapter.services.list()).resolves.toEqual({
      ...state(),
      activeAvailability: "unavailable",
    })
    await expect(adapter.services.chooseLocal()).resolves.toBeUndefined()
    expect(adapter.services.subscribeProgress(vi.fn())).toEqual(expect.any(Function))
  })

  it("validates and registers local, cloned, and relocated workspaces", async () => {
    const registry = {
      load: vi.fn(async () => state()),
      add: vi.fn(async () => state()),
      rename: vi.fn(async () => state()),
      activate: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      relocate: vi.fn(async () => state()),
      recover: vi.fn(async () => state()),
    }
    const inspect = vi.fn(async (path: string) => ({
      valid: true as const,
      canonicalPath: path,
      needsInstall: false,
    }))
    const clone = vi.fn(async () => ({
      canonicalPath: String.raw`C:\Blogs\cloned`,
      owner: "owner",
      repository: "repo",
    }))
    const adapter = createBlogManagementAdapter({
      registry,
      importer: { clone, install: vi.fn() },
      inspect,
      chooseDirectory: async () => String.raw`C:\Blogs\local`,
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(adapter.services.chooseLocal()).resolves.toMatchObject({
      path: String.raw`C:\Blogs\local`,
      inspection: { valid: true },
    })
    await adapter.services.addLocal({ name: "Local", path: String.raw`C:\Blogs\local` })
    await adapter.services.recoverLocal({ name: "Recovered", path: String.raw`C:\Blogs\recovered` })
    await adapter.services.clone({
      name: "Clone",
      url: "https://github.com/owner/repo",
      destination: String.raw`C:\Blogs\cloned`,
    })
    await adapter.services.relocate({ id: second.id, path: String.raw`C:\Blogs\moved` })

    expect(registry.add).toHaveBeenNthCalledWith(1, {
      name: "Local",
      path: String.raw`C:\Blogs\local`,
    })
    expect(registry.add).toHaveBeenNthCalledWith(2, {
      name: "Clone",
      path: String.raw`C:\Blogs\cloned`,
    })
    expect(registry.recover).toHaveBeenCalledWith({
      name: "Recovered",
      path: String.raw`C:\Blogs\recovered`,
    })
    expect(registry.relocate).toHaveBeenCalledWith(second.id, String.raw`C:\Blogs\moved`)
  })

  it.each([
    [undefined, "learning-notes"],
    ["   ", "learning-notes"],
    [" My Garden ", "My Garden"],
  ] as const)("derives a safe clone display name from %s", async (name, expectedName) => {
    const registry = {
      load: vi.fn(async () => state()),
      add: vi.fn(async () => state()),
      rename: vi.fn(async () => state()),
      activate: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      relocate: vi.fn(async () => state()),
      recover: vi.fn(async () => state()),
    }
    const clone = vi.fn(async () => ({
      canonicalPath: String.raw`C:\Blogs\learning-notes`,
      owner: "owner",
      repository: "learning-notes",
    }))
    const adapter = createBlogManagementAdapter({
      registry,
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await adapter.services.clone({
      url: "https://github.com/owner/learning-notes.git",
      destination: String.raw`C:\Blogs\learning-notes`,
      ...(name === undefined ? {} : { name }),
    })

    expect(clone).toHaveBeenCalledWith(
      expect.objectContaining({ name: expectedName }),
      expect.any(AbortSignal),
    )
    expect(registry.add).toHaveBeenCalledWith({
      name: expectedName,
      path: String.raw`C:\Blogs\learning-notes`,
    })
  })

  it("rejects invalid clone identity before starting an import or writing an empty registry name", async () => {
    const registry = {
      load: vi.fn(async () => state()),
      add: vi.fn(async () => state()),
      rename: vi.fn(async () => state()),
      activate: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      relocate: vi.fn(async () => state()),
      recover: vi.fn(async () => state()),
    }
    const clone = vi.fn()
    const adapter = createBlogManagementAdapter({
      registry,
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(
      adapter.services.clone({
        url: "https://example.com/owner/repository",
        destination: String.raw`C:\Blogs\repository`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REPOSITORY_URL" })
    for (const name of ["x".repeat(81), "bad\u0001name"]) {
      await expect(
        adapter.services.clone({
          url: "https://github.com/owner/repository",
          destination: String.raw`C:\Blogs\repository`,
          name,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" })
    }
    expect(clone).not.toHaveBeenCalled()
    expect(registry.add).not.toHaveBeenCalled()
  })

  it("cancels the active clone and forwards switch only after editor save confirmation", async () => {
    let receivedSignal: AbortSignal | undefined
    const clone = vi.fn((_request, signal?: AbortSignal) => {
      receivedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      })
    })
    const switchTo = vi.fn(async () => undefined)
    const adapter = createBlogManagementAdapter({
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo,
    })
    const operation = adapter.services.clone({
      name: "Clone",
      url: "https://github.com/owner/repo",
      destination: String.raw`C:\Blogs\cloned`,
    })
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())
    await adapter.services.cancelImport()
    await expect(operation).rejects.toThrow("cancelled")
    expect(receivedSignal?.aborted).toBe(true)

    await adapter.services.switch({ id: second.id, editorSaved: true })
    expect(switchTo).toHaveBeenCalledWith({ id: second.id, editorSaved: true })
  })

  it("blocks new imports, aborts and awaits an active import before switching", async () => {
    let finish!: (error?: Error) => void
    let receivedSignal: AbortSignal | undefined
    const clone = vi.fn((_request, signal?: AbortSignal) => {
      receivedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        finish = (error = new BlogImportError("CANCELLED", "cancelled")) => reject(error)
      })
    })
    const adapter = createBlogManagementAdapter({
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })
    const operation = adapter.services.clone({
      name: "Clone",
      url: "https://github.com/owner/repo",
      destination: String.raw`C:\Blogs\cloned`,
    })
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())
    const relaunch = vi.fn()
    const quit = vi.fn()
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate: async () => state(second.id) },
      inspect: async () => ({
        valid: true,
        canonicalPath: second.canonicalPath,
        needsInstall: false,
      }),
      assertIdle: adapter.prepareForShutdown,
      dispose: adapter.prepareForShutdown,
      relaunch,
      quit,
    })
    const switching = runtime.switchTo({ id: second.id, editorSaved: true })
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true))
    await expect(adapter.services.install({ path: first.canonicalPath })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    finish()
    await expect(switching).resolves.toBeUndefined()
    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" })
    expect(relaunch).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it("fails shutdown closed when active import termination is uncertain", async () => {
    let receivedSignal: AbortSignal | undefined
    const clone = vi.fn((_request, signal?: AbortSignal) => {
      receivedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new BlogImportError("IMPORT_UNAVAILABLE", "termination uncertain"))
          },
          { once: true },
        )
      })
    })
    const adapter = createBlogManagementAdapter({
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })
    const operation = adapter.services.clone({
      name: "Clone",
      url: "https://github.com/owner/repo",
      destination: String.raw`C:\Blogs\cloned`,
    })
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())

    await expect(adapter.prepareForShutdown()).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    await expect(operation).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    await expect(adapter.prepareForShutdown()).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    const activate = vi.fn(async () => state(second.id))
    const dispose = vi.fn(async () => undefined)
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate },
      inspect: async () => ({
        valid: true,
        canonicalPath: second.canonicalPath,
        needsInstall: false,
      }),
      assertIdle: adapter.prepareForShutdown,
      dispose,
      relaunch: vi.fn(),
      quit: vi.fn(),
    })
    await expect(runtime.switchTo({ id: second.id, editorSaved: true })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    expect(dispose).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    await expect(adapter.services.install({ path: first.canonicalPath })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })

    const allowQuit = vi.fn()
    const reportFailure = vi.fn()
    const coordinator = createPublisherCloseCoordinator({
      requestRendererFlush: async () => true,
      cleanup: adapter.prepareForShutdown,
      allowClose: vi.fn(),
      allowQuit,
      reportFailure,
    })
    await coordinator.beforeQuit({ preventDefault: vi.fn() })
    expect(allowQuit).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith("保存或关闭准备失败，窗口仍保持打开。")
  })

  it("latches uncertain termination observed by cancel before the shutdown barrier", async () => {
    let receivedSignal: AbortSignal | undefined
    const clone = vi.fn((_request, signal?: AbortSignal) => {
      receivedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new BlogImportError("IMPORT_UNAVAILABLE", "secret command details"))
          },
          { once: true },
        )
      })
    })
    const adapter = createBlogManagementAdapter({
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })
    const operation = adapter.services.clone({
      name: "Clone",
      url: "https://github.com/owner/repo",
      destination: String.raw`C:\Blogs\cloned`,
    })
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())

    await expect(adapter.services.cancelImport()).resolves.toBeUndefined()
    await expect(operation).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    await expect(adapter.prepareForShutdown()).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    await expect(adapter.services.install({ path: first.canonicalPath })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
      message: "Blog imports are unavailable while the app is closing.",
    })
  })

  it("latches an uncertain import rejection that settles before shutdown starts", async () => {
    let rejectClone!: (error: Error) => void
    const adapter = createBlogManagementAdapter({
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
      },
      importer: {
        clone: () =>
          new Promise<never>((_resolve, reject) => {
            rejectClone = reject
          }),
        install: vi.fn(),
      },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })
    const operation = adapter.services.clone({
      name: "Clone",
      url: "https://github.com/owner/repo",
      destination: String.raw`C:\Blogs\cloned`,
    })
    await vi.waitFor(() => expect(rejectClone).toEqual(expect.any(Function)))
    rejectClone(new BlogImportError("IMPORT_UNAVAILABLE", "termination uncertain"))
    await expect(operation).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    await vi.waitFor(async () => {
      await expect(adapter.prepareForShutdown()).rejects.toMatchObject({
        code: "IMPORT_UNAVAILABLE",
      })
    })
  })
})
