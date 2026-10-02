// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  createBlogManagementAdapter,
  createBlogRuntime,
  resolveBlogRegistryFile,
} from "../../src/main/blogRuntime"
import type { BlogRecord, BlogRegistryView } from "../../src/shared/contracts"

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

describe("blog management adapter", () => {
  it("keeps registry management available without constructing workspace services", async () => {
    const registry = {
      load: vi.fn(async () => state()),
      add: vi.fn(async () => state()),
      rename: vi.fn(async () => state()),
      activate: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      relocate: vi.fn(async () => state()),
    }
    const adapter = createBlogManagementAdapter({
      registry,
      importer: { clone: vi.fn(), install: vi.fn() },
      inspect: vi.fn(),
      chooseDirectory: vi.fn(async () => undefined),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(adapter.services.list()).resolves.toEqual(state())
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
    expect(registry.relocate).toHaveBeenCalledWith(second.id, String.raw`C:\Blogs\moved`)
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
})
