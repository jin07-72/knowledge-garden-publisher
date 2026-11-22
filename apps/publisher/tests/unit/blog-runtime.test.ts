// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createRelaunchScheduler,
  createBlogManagementAdapter,
  createBlogRuntime,
  runBlogManagementShutdown,
  resolveBlogRegistryFile,
  resolveE2eCloneSource,
} from "../../src/main/blogRuntime"
import type {
  BlogCandidateInspection,
  BlogRecord,
  BlogRegistryState,
  BlogRegistryView,
} from "../../src/shared/contracts"
import { BlogAddressError, normalizePublicWebsite } from "../../src/main/services/blogAddresses"
import type { BlogAvailabilityInspection } from "../../src/main/services/blogAvailability"
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

function state(activeBlogId = first.id): BlogRegistryState {
  return { version: 1, activeBlogId, blogs: [first, second] }
}

function displayState(current: BlogRegistryState): BlogRegistryView {
  return {
    ...current,
    blogs: current.blogs.map(({ websiteUrl, ...blog }) => ({
      ...blog,
      repository: {
        display: "git@github.com:owner/garden.git",
        url: "https://github.com/owner/garden",
      },
      website: websiteUrl ? { source: "manual", url: websiteUrl } : { source: "unconfigured" },
    })),
  }
}

function addressDependencies() {
  return {
    addresses: {
      normalizeWebsite: vi.fn(normalizePublicWebsite),
      describe: vi.fn(async (current: BlogRegistryState) => displayState(current)),
      resolveLink: vi.fn(async () => "https://garden.example/"),
    },
    openExternal: vi.fn(async (_url: string) => undefined),
  }
}

async function inspectAvailable(path: string): Promise<BlogAvailabilityInspection> {
  return { available: true, canonicalPath: path }
}

function managementFixture() {
  const registry = {
    load: vi.fn(async () => state()),
    add: vi.fn(async (_request: { name: string; path: string }) => state()),
    recover: vi.fn(async () => state()),
    rename: vi.fn(async () => state()),
    activate: vi.fn(async () => state()),
    remove: vi.fn(async () => state()),
    relocate: vi.fn(async () => state()),
    setWebsiteUrl: vi.fn(async (_id: string, _websiteUrl?: string) => state()),
  }
  const dependencies = {
    ...addressDependencies(),
    registry,
    importer: { clone: vi.fn(), install: vi.fn() },
    inspect: vi.fn(async (path: string): Promise<BlogCandidateInspection> => ({
      valid: true as const,
      canonicalPath: path,
      needsInstall: false,
    })),
    inspectAvailability: vi.fn(async (path: string): Promise<BlogAvailabilityInspection> => ({
      available: true,
      canonicalPath: path,
    })),
    chooseDirectory: vi.fn(),
    openFolder: vi.fn(),
    switchTo: vi.fn(),
  }
  return { ...dependencies, ...createBlogManagementAdapter(dependencies) }
}

describe("blog runtime", () => {
  it("uses local availability for the active blog's stored canonical path", async () => {
    const inspectAvailability = vi.fn(async () => ({
      available: true as const,
      canonicalPath: first.canonicalPath,
    }))
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate: vi.fn() },
      inspectAvailability,
      assertIdle: vi.fn(),
      dispose: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    })

    await expect(runtime.active()).resolves.toEqual(first)
    expect(inspectAvailability).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
  })

  it.each([
    { inspection: { available: false as const } },
    {
      inspection: {
        available: true as const,
        canonicalPath: String.raw`C:\Blogs\elsewhere`,
      },
    },
  ])("fails safely when the active workspace is unavailable or moved", async ({ inspection }) => {
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate: vi.fn() },
      inspectAvailability: async () => inspection,
      assertIdle: vi.fn(),
      dispose: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    })

    await expect(runtime.active()).rejects.toMatchObject({ code: "BLOG_WORKSPACE_UNAVAILABLE" })
  })

  it.each([
    { inspection: { available: false as const } },
    {
      inspection: {
        available: true as const,
        canonicalPath: String.raw`C:\Blogs\elsewhere`,
      },
    },
  ])("rejects a switch when the target is unavailable or moved", async ({ inspection }) => {
    const activate = vi.fn()
    const runtime = createBlogRuntime({
      registry: { load: async () => state(), activate },
      inspectAvailability: async () => inspection,
      assertIdle: vi.fn(),
      dispose: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    })

    await expect(runtime.switchTo({ id: second.id, editorSaved: true })).rejects.toMatchObject({
      code: "BLOG_WORKSPACE_UNAVAILABLE",
    })
    expect(activate).not.toHaveBeenCalled()
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
      inspectAvailability: async () => {
        order.push("inspect")
        return { available: true, canonicalPath: second.canonicalPath }
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
      inspectAvailability: async () => ({
        available: true,
        canonicalPath: second.canonicalPath,
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
      inspectAvailability: async () => ({
        available: true,
        canonicalPath: second.canonicalPath,
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
      inspectAvailability: vi.fn(),
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
        inspectAvailability: async () => {
          await fail("inspect")
          return { available: true, canonicalPath: second.canonicalPath }
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
      inspectAvailability: async () => ({
        available: true,
        canonicalPath: second.canonicalPath,
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

  it.each([undefined, "relative-marker", String.raw`C:\missing-parent\relaunch-requested`])(
    "never spawns an unmanaged process for invalid E2E marker %s",
    (marker) => {
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

      expect(relaunch).not.toHaveBeenCalled()
      expect(record).not.toHaveBeenCalled()
    },
  )
})

describe("blog management adapter", () => {
  it.each(["available", "unavailable"] as const)(
    "describes the loaded state when the active workspace is %s",
    async (availability) => {
      const fixture = managementFixture()
      const current = state()
      fixture.registry.load.mockResolvedValue(current)
      if (availability === "unavailable") {
        fixture.inspectAvailability.mockRejectedValue(new Error("missing"))
      }

      await expect(fixture.services.list()).resolves.toEqual({
        ...displayState(current),
        activeAvailability: availability,
      })
      expect(fixture.registry.load).toHaveBeenCalledOnce()
      expect(fixture.addresses.describe).toHaveBeenCalledExactlyOnceWith(current)
      expect(fixture.inspect).not.toHaveBeenCalled()
    },
  )

  it("lists a locally available blog when strict candidate inspection fails", async () => {
    const fixture = managementFixture()
    fixture.inspect.mockResolvedValue({
      valid: false,
      code: "GIT_UNAVAILABLE",
      message: "Git unavailable",
    })
    fixture.inspectAvailability.mockResolvedValue({
      available: true,
      canonicalPath: first.canonicalPath,
    })

    await expect(fixture.services.list()).resolves.toMatchObject({
      activeAvailability: "available",
    })
    expect(fixture.inspect).not.toHaveBeenCalled()
    expect(fixture.inspectAvailability).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
  })

  it("does not conceal unexpected view generation failures", async () => {
    const fixture = managementFixture()
    const error = new Error("unexpected resolver bug")
    fixture.addresses.describe.mockRejectedValue(error)
    await expect(fixture.services.list()).rejects.toBe(error)
  })

  it.each([
    {
      method: "addLocal",
      operation: "add",
      request: { name: "New", path: second.path },
      args: [{ name: "New", path: second.path }],
    },
    {
      method: "recoverLocal",
      operation: "recover",
      request: { name: "New", path: second.path },
      args: [{ name: "New", path: second.path }],
    },
    {
      method: "rename",
      operation: "rename",
      request: { id: second.id, name: "New" },
      args: [second.id, "New"],
    },
    {
      method: "relocate",
      operation: "relocate",
      request: { id: second.id, path: second.path },
      args: [second.id, second.path],
    },
    { method: "remove", operation: "remove", request: { id: second.id }, args: [second.id] },
  ] as const)(
    "returns the current described view after $method",
    async ({ method, operation, request, args }) => {
      const fixture = managementFixture()
      const updated: BlogRegistryState = {
        version: 1,
        activeBlogId: second.id,
        blogs: [{ ...second, name: "New" }],
      }
      fixture.registry[operation].mockResolvedValue(updated)

      const result = await fixture.services[method](request as never)

      expect(result).toEqual(displayState(updated))
      expect(fixture.registry[operation]).toHaveBeenCalledExactlyOnceWith(...args)
      expect(fixture.addresses.describe).toHaveBeenCalledExactlyOnceWith(updated)
      expect(fixture.registry[operation].mock.invocationCallOrder[0]).toBeLessThan(
        fixture.addresses.describe.mock.invocationCallOrder[0]!,
      )
      expect(fixture.registry.load).not.toHaveBeenCalled()
    },
  )

  it("persists a clone while returning its receipt and describes it on the next list", async () => {
    const fixture = managementFixture()
    const receipt = {
      canonicalPath: String.raw`C:\Blogs\cloned`,
      owner: "owner",
      repository: "repo",
    }
    const cloned: BlogRecord = {
      ...second,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Clone",
      path: receipt.canonicalPath,
      canonicalPath: receipt.canonicalPath,
    }
    let current = state()
    fixture.registry.load.mockImplementation(async () => current)
    fixture.registry.add.mockImplementation(async () => {
      current = { ...current, blogs: [...current.blogs, cloned] }
      return current
    })
    fixture.importer.clone.mockResolvedValue(receipt)

    await expect(
      fixture.services.clone({
        name: "Clone",
        url: "https://github.com/owner/repo",
        destination: receipt.canonicalPath,
      }),
    ).resolves.toBe(receipt)
    expect(fixture.registry.add).toHaveBeenCalledExactlyOnceWith({
      name: "Clone",
      path: receipt.canonicalPath,
    })
    expect(fixture.addresses.describe).not.toHaveBeenCalled()
    await expect(fixture.services.list()).resolves.toEqual({
      ...displayState(current),
      activeAvailability: "available",
    })
    expect(fixture.addresses.describe).toHaveBeenCalledExactlyOnceWith(current)
  })

  it("normalizes a website exactly once before persisting and describing the updated state", async () => {
    const fixture = managementFixture()
    const updated: BlogRegistryState = {
      ...state(),
      blogs: [{ ...first, websiteUrl: "https://garden.example/" }, second],
    }
    fixture.registry.setWebsiteUrl.mockResolvedValue(updated)

    await expect(
      fixture.services.updateWebsite({ id: first.id, websiteUrl: "garden.example" }),
    ).resolves.toEqual(displayState(updated))
    expect(fixture.addresses.normalizeWebsite).toHaveBeenCalledExactlyOnceWith("garden.example")
    expect(fixture.registry.setWebsiteUrl).toHaveBeenCalledExactlyOnceWith(
      first.id,
      "https://garden.example/",
    )
    expect(fixture.addresses.describe).toHaveBeenCalledExactlyOnceWith(updated)
    expect(fixture.addresses.normalizeWebsite.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.registry.setWebsiteUrl.mock.invocationCallOrder[0]!,
    )
    expect(fixture.registry.setWebsiteUrl.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.addresses.describe.mock.invocationCallOrder[0]!,
    )
  })

  it("clears a website without normalizing null and describes the cleared state", async () => {
    const fixture = managementFixture()
    const updated = state()
    fixture.registry.setWebsiteUrl.mockResolvedValue(updated)

    await expect(
      fixture.services.updateWebsite({ id: first.id, websiteUrl: null }),
    ).resolves.toEqual(displayState(updated))
    expect(fixture.addresses.normalizeWebsite).not.toHaveBeenCalled()
    expect(fixture.registry.setWebsiteUrl).toHaveBeenCalledExactlyOnceWith(first.id, undefined)
    expect(fixture.addresses.describe).toHaveBeenCalledExactlyOnceWith(updated)
  })

  it.each(["", "   ", "javascript:alert(1)"])(
    "rejects invalid non-null website %j before mutation",
    async (websiteUrl) => {
      const fixture = managementFixture()
      fixture.addresses.normalizeWebsite.mockReturnValue(undefined)

      await expect(fixture.services.updateWebsite({ id: first.id, websiteUrl })).rejects.toEqual(
        new BlogAddressError("INVALID_WEBSITE"),
      )
      expect(fixture.addresses.normalizeWebsite).toHaveBeenCalledExactlyOnceWith(websiteUrl)
      expect(fixture.registry.setWebsiteUrl).not.toHaveBeenCalled()
      expect(fixture.addresses.describe).not.toHaveBeenCalled()
    },
  )

  it("validates the current workspace before resolving and opening its link", async () => {
    const fixture = managementFixture()
    const current = state()
    const order: string[] = []
    fixture.registry.load.mockImplementation(async () => {
      order.push("load")
      return current
    })
    fixture.inspect.mockImplementation(async () => {
      await Promise.resolve()
      order.push("inspect")
      return { valid: true, canonicalPath: first.canonicalPath, needsInstall: false }
    })
    fixture.addresses.resolveLink.mockImplementation(async () => {
      order.push("resolve")
      return "https://garden.example/"
    })
    fixture.openExternal.mockImplementation(async () => {
      order.push("open")
    })

    await fixture.services.openLink({ id: first.id, kind: "website" })

    expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
    expect(fixture.addresses.resolveLink).toHaveBeenCalledExactlyOnceWith(
      current,
      first.id,
      "website",
    )
    expect(fixture.openExternal).toHaveBeenCalledExactlyOnceWith("https://garden.example/")
    expect(order).toEqual(["load", "inspect", "resolve", "open"])
  })

  it("rejects an unregistered link id without inspection or resolution", async () => {
    const fixture = managementFixture()

    const operation = fixture.services.openLink({ id: "missing-blog", kind: "website" })
    await expect(operation).rejects.toBeInstanceOf(BlogAddressError)
    await expect(operation).rejects.toMatchObject({
      code: "LINK_UNAVAILABLE",
      message: "Blog link is unavailable",
    })

    expect(fixture.inspect).not.toHaveBeenCalled()
    expect(fixture.addresses.resolveLink).not.toHaveBeenCalled()
    expect(fixture.openExternal).not.toHaveBeenCalled()
  })

  it.each(["invalid", "throws", "different path"] as const)(
    "rejects a manual website link with a safe error when workspace inspection %s",
    async (failure) => {
      const fixture = managementFixture()
      fixture.registry.load.mockResolvedValue({
        ...state(),
        blogs: [{ ...first, websiteUrl: "https://garden.example/" }],
      })
      if (failure === "invalid") {
        fixture.inspect.mockResolvedValue({
          valid: false,
          code: "SECRET",
          message: "C:\\secret\\missing",
        })
      } else if (failure === "throws") {
        fixture.inspect.mockRejectedValue(new Error("Could not read C:\\secret\\missing"))
      } else {
        fixture.inspect.mockResolvedValue({
          valid: true,
          canonicalPath: second.canonicalPath,
          needsInstall: false,
        })
      }

      const operation = fixture.services.openLink({ id: first.id, kind: "website" })
      await expect(operation).rejects.toBeInstanceOf(BlogAddressError)
      await expect(operation).rejects.toMatchObject({
        code: "LINK_UNAVAILABLE",
        message: "Blog link is unavailable",
      })

      expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
      expect(fixture.addresses.resolveLink).not.toHaveBeenCalled()
      expect(fixture.openExternal).not.toHaveBeenCalled()
    },
  )

  it("uses platform path case semantics when validating a link workspace", async () => {
    const fixture = managementFixture()
    fixture.inspect.mockResolvedValue({
      valid: true,
      canonicalPath: first.canonicalPath.toUpperCase(),
      needsInstall: false,
    })

    const operation = fixture.services.openLink({ id: first.id, kind: "website" })
    if (process.platform === "win32") {
      await expect(operation).resolves.toBeUndefined()
      expect(fixture.openExternal).toHaveBeenCalledExactlyOnceWith("https://garden.example/")
    } else {
      await expect(operation).rejects.toEqual(new BlogAddressError("LINK_UNAVAILABLE"))
      expect(fixture.addresses.resolveLink).not.toHaveBeenCalled()
      expect(fixture.openExternal).not.toHaveBeenCalled()
    }
    expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
  })

  it("reloads and resolves every open request and passes only the trusted result to the opener", async () => {
    const fixture = managementFixture()
    const initial = state()
    const changed: BlogRegistryState = {
      ...state(),
      blogs: [{ ...first, websiteUrl: "https://changed.example/" }, second],
    }
    fixture.registry.load.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed)
    fixture.addresses.resolveLink
      .mockResolvedValueOnce("https://github.com/owner/current")
      .mockResolvedValueOnce("https://changed.example/")

    await fixture.services.openLink({
      id: first.id,
      kind: "repository",
      url: "https://untrusted.example/",
    } as never)
    await fixture.services.openLink({ id: first.id, kind: "website" })

    expect(fixture.registry.load).toHaveBeenCalledTimes(2)
    expect(fixture.addresses.resolveLink).toHaveBeenNthCalledWith(
      1,
      initial,
      first.id,
      "repository",
    )
    expect(fixture.addresses.resolveLink).toHaveBeenNthCalledWith(2, changed, first.id, "website")
    expect(fixture.openExternal.mock.calls).toEqual([
      ["https://github.com/owner/current"],
      ["https://changed.example/"],
    ])
    expect(fixture.addresses.describe).not.toHaveBeenCalled()
  })

  it("does not open a link when fresh resolution fails", async () => {
    const fixture = managementFixture()
    const error = new BlogAddressError("LINK_UNAVAILABLE")
    fixture.addresses.resolveLink.mockRejectedValue(error)

    await expect(fixture.services.openLink({ id: first.id, kind: "website" })).rejects.toBe(error)
    expect(fixture.openExternal).not.toHaveBeenCalled()
  })

  it("reports external opener failure without exposing the target or raw error", async () => {
    const fixture = managementFixture()
    fixture.openExternal.mockRejectedValue(new Error("Could not launch https://garden.example/"))

    await expect(fixture.services.openLink({ id: first.id, kind: "website" })).rejects.toEqual(
      new Error("The blog link could not be opened."),
    )
  })

  it.each(["throws", "unavailable", "different path"] as const)(
    "reports the active workspace unavailable when local inspection %s",
    async (failure) => {
      const fixture = managementFixture()
      if (failure === "throws") {
        fixture.inspectAvailability.mockRejectedValue(new Error("C:\\secret"))
      } else if (failure === "unavailable") {
        fixture.inspectAvailability.mockResolvedValue({ available: false })
      } else {
        fixture.inspectAvailability.mockResolvedValue({
          available: true,
          canonicalPath: second.canonicalPath,
        })
      }

      await expect(fixture.services.list()).resolves.toMatchObject({
        activeAvailability: "unavailable",
      })
      expect(fixture.inspect).not.toHaveBeenCalled()
      expect(fixture.inspectAvailability).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
    },
  )

  it("uses platform path case semantics for local availability", async () => {
    const fixture = managementFixture()
    fixture.inspectAvailability.mockResolvedValue({
      available: true,
      canonicalPath: first.canonicalPath.toUpperCase(),
    })

    await expect(fixture.services.list()).resolves.toMatchObject({
      activeAvailability: process.platform === "win32" ? "available" : "unavailable",
    })
    expect(fixture.inspect).not.toHaveBeenCalled()
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
      setWebsiteUrl: vi.fn(async () => state()),
    }
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry,
      importer: { clone: vi.fn(), install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: vi.fn(async () => ({ available: false as const })),
      chooseDirectory: vi.fn(async () => undefined),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(adapter.services.list()).resolves.toEqual({
      ...displayState(state()),
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
      setWebsiteUrl: vi.fn(async () => state()),
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
      ...addressDependencies(),
      registry,
      importer: { clone, install: vi.fn() },
      inspect,
      inspectAvailability: inspectAvailable,
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
    {
      method: "addLocal",
      request: { name: "Local", path: first.canonicalPath },
      mutation: "add",
    },
    {
      method: "recoverLocal",
      request: { name: "Recovered", path: first.canonicalPath },
      mutation: "recover",
    },
    {
      method: "relocate",
      request: { id: first.id, path: first.canonicalPath },
      mutation: "relocate",
    },
  ] as const)(
    "keeps strict candidate validation for $method",
    async ({ method, request, mutation }) => {
      const fixture = managementFixture()
      fixture.inspect.mockResolvedValue({
        valid: false,
        code: "GIT_ORIGIN_MISSING",
        message: "origin missing",
      })

      await expect(fixture.services[method](request as never)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      })
      expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
      expect(fixture.inspectAvailability).not.toHaveBeenCalled()
      expect(fixture.registry[mutation]).not.toHaveBeenCalled()
    },
  )

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
      setWebsiteUrl: vi.fn(async () => state()),
    }
    const clone = vi.fn(async () => ({
      canonicalPath: String.raw`C:\Blogs\learning-notes`,
      owner: "owner",
      repository: "learning-notes",
    }))
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry,
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
      setWebsiteUrl: vi.fn(async () => state()),
    }
    const clone = vi.fn()
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry,
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
      inspectAvailability: async () => ({
        available: true,
        canonicalPath: second.canonicalPath,
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

  it("restores the import gate when shutdown cleanup fails after preparation", async () => {
    const installed = {
      valid: true as const,
      canonicalPath: first.canonicalPath,
      needsInstall: false,
    }
    const install = vi.fn(async () => installed)
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone: vi.fn(), install },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(
      runBlogManagementShutdown({
        prepare: adapter.prepareForShutdown,
        cleanup: async () => {
          throw new Error("preview cleanup failed")
        },
        restore: adapter.restoreAfterFailedShutdown,
      }),
    ).rejects.toThrow("preview cleanup failed")

    await expect(adapter.services.install({ path: first.canonicalPath })).resolves.toEqual(
      installed,
    )
  })

  it("keeps imports closed after successful shutdown cleanup", async () => {
    const install = vi.fn(async () => ({
      valid: true as const,
      canonicalPath: first.canonicalPath,
      needsInstall: false,
    }))
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone: vi.fn(), install },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await runBlogManagementShutdown({
      prepare: adapter.prepareForShutdown,
      cleanup: async () => undefined,
      restore: adapter.restoreAfterFailedShutdown,
    })

    await expect(adapter.services.install({ path: first.canonicalPath })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    expect(install).not.toHaveBeenCalled()
  })

  it("keeps imports closed when cleanup fails after entering irreversible resource disposal", async () => {
    const install = vi.fn(async () => ({
      valid: true as const,
      canonicalPath: first.canonicalPath,
      needsInstall: false,
    }))
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone: vi.fn(), install },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
      chooseDirectory: vi.fn(),
      openFolder: vi.fn(),
      switchTo: vi.fn(),
    })

    await expect(
      runBlogManagementShutdown({
        prepare: adapter.prepareForShutdown,
        cleanup: async (markRestoreUnsafe) => {
          markRestoreUnsafe()
          throw new Error("preview cleanup failed after publisher disposal")
        },
        restore: adapter.restoreAfterFailedShutdown,
      }),
    ).rejects.toThrow("preview cleanup failed after publisher disposal")

    await expect(adapter.services.install({ path: first.canonicalPath })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    expect(install).not.toHaveBeenCalled()
  })

  it("does not clear uncertain import termination when shutdown preparation fails", async () => {
    let receivedSignal: AbortSignal | undefined
    const clone = vi.fn((_request, signal?: AbortSignal) => {
      receivedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new BlogImportError("IMPORT_UNAVAILABLE", "termination uncertain")),
          { once: true },
        )
      })
    })
    const adapter = createBlogManagementAdapter({
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
    const cleanup = vi.fn(async () => undefined)

    await expect(
      runBlogManagementShutdown({
        prepare: adapter.prepareForShutdown,
        cleanup,
        restore: adapter.restoreAfterFailedShutdown,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    await expect(operation).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    expect(cleanup).not.toHaveBeenCalled()
    adapter.restoreAfterFailedShutdown()
    await expect(adapter.services.install({ path: first.canonicalPath })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
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
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
      inspectAvailability: async () => ({
        available: true,
        canonicalPath: second.canonicalPath,
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
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: { clone, install: vi.fn() },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
      ...addressDependencies(),
      registry: {
        load: async () => state(),
        add: vi.fn(),
        rename: vi.fn(),
        activate: vi.fn(),
        remove: vi.fn(),
        relocate: vi.fn(),
        recover: vi.fn(),
        setWebsiteUrl: vi.fn(),
      },
      importer: {
        clone: () =>
          new Promise<never>((_resolve, reject) => {
            rejectClone = reject
          }),
        install: vi.fn(),
      },
      inspect: vi.fn(),
      inspectAvailability: inspectAvailable,
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
