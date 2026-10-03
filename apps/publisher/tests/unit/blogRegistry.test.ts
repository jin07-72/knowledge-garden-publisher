import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBlogRegistry } from "../../src/main/services/blogRegistry"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createGarden(name: string): Promise<string> {
  const root = join(await createDirectory("garden-blog-registry-"), name)
  await mkdir(root)
  return root
}

function createRegistry(file: string, legacyPath: string) {
  let instant = 0
  let identifier = 0
  return createBlogRegistry({
    file,
    legacyPath,
    now: () => new Date(`2026-10-01T00:00:${String(instant++).padStart(2, "0")}.000Z`),
    uuid: () => `00000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`,
  })
}

describe("blog registry", () => {
  it("normalizes persisted names and rejects names outside the renderer-safe boundary", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const added = await registry.add({ name: "  Second  ", path: secondPath })
    expect(added.blogs[1]).toMatchObject({ name: "Second" })
    for (const name of ["", "   ", "bad\u0001name", "bad\u0085name", "x".repeat(81)]) {
      await expect(registry.rename(added.blogs[1]!.id, name)).rejects.toThrow("Invalid blog name")
    }
  })

  it("migrates the legacy garden as the first active blog", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, legacyPath)

    const state = await registry.load()

    expect(state.version).toBe(1)
    expect(state.blogs).toHaveLength(1)
    expect(state.blogs[0]).toMatchObject({
      path: legacyPath,
      canonicalPath: await realpath(legacyPath),
    })
    expect(state.activeBlogId).toBe(state.blogs[0]?.id)
    await expect(readFile(file, "utf8")).resolves.toContain('"version":1')
  })

  it("persists each state through a same-directory replacement without leaving a temporary registry", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, legacyPath)

    await registry.add({ name: "Second", path: secondPath })

    const persisted = JSON.parse(await readFile(file, "utf8"))
    expect(persisted).toMatchObject({
      version: 1,
      blogs: [{ path: legacyPath }, { path: secondPath }],
    })
    await expect(readdir(directory)).resolves.toEqual([basename(file)])
  })

  it("cleans only recognized stale registry candidate and temporary files after acquiring its lease", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const file = join(directory, "blogs.v1.json")
    const candidate = join(
      directory,
      ".blogs.v1.json.lock.candidate-00000000-0000-4000-8000-000000000001",
    )
    const temporary = join(directory, ".blogs.v1.json.00000000-0000-4000-8000-000000000001.tmp")
    await Promise.all([writeFile(candidate, "stale"), writeFile(temporary, "stale")])
    const stale = new Date(Date.now() - 2_000)
    await Promise.all([utimes(candidate, stale, stale), utimes(temporary, stale, stale)])

    await createRegistry(file, legacyPath).load()

    await expect(readdir(directory)).resolves.toEqual([basename(file)])
  })

  it("serializes concurrent registrations so neither update is lost", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const thirdPath = await createGarden("third")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    await registry.load()

    await Promise.all([
      registry.add({ name: "Second", path: secondPath }),
      registry.add({ name: "Third", path: thirdPath }),
    ])

    const state = await registry.load()
    expect(state.blogs).toHaveLength(3)
    expect(state.blogs.map((blog) => blog.path)).toEqual(
      expect.arrayContaining([legacyPath, secondPath, thirdPath]),
    )
  })

  it("serializes concurrent registrations from separate registry instances", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const thirdPath = await createGarden("third")
    const file = join(directory, "blogs.v1.json")
    let identifier = 0
    const uuid = () => `00000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`
    const first = createBlogRegistry({
      file,
      legacyPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      uuid,
    })
    const second = createBlogRegistry({
      file,
      legacyPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      uuid,
    })
    await first.load()

    await Promise.all([
      first.add({ name: "Second", path: secondPath }),
      second.add({ name: "Third", path: thirdPath }),
    ])

    const state = await first.load()
    expect(state.blogs).toHaveLength(3)
    expect(state.blogs.map((blog) => blog.path)).toEqual(
      expect.arrayContaining([legacyPath, secondPath, thirdPath]),
    )
  })

  it("retains the previous registry when syncing a temporary write fails", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const file = join(directory, "blogs.v1.json")
    let failTemporarySync = false
    let identifier = 0
    const fileSystem = {
      open: async (path: string, flags: "r" | "wx", mode?: number) => {
        const handle = await openFile(path, flags, mode)
        if (!failTemporarySync || flags !== "wx" || !path.endsWith(".tmp")) return handle
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            throw new Error("simulated sync failure")
          },
          close: handle.close.bind(handle),
        }
      },
    }
    const registryOptions: Parameters<typeof createBlogRegistry>[0] & {
      readonly fileSystem: typeof fileSystem
    } = {
      file,
      legacyPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      uuid: () => `00000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`,
      fileSystem,
    }
    const registry = createBlogRegistry(registryOptions)
    await registry.load()
    const previous = await readFile(file, "utf8")
    failTemporarySync = true

    await expect(registry.add({ name: "Second", path: secondPath })).rejects.toThrow(
      "simulated sync failure",
    )
    await expect(readFile(file, "utf8")).resolves.toBe(previous)
    await expect(readdir(directory)).resolves.toEqual([basename(file)])
  })

  it("does not delete a temporary file it failed to create exclusively", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const file = join(directory, "blogs.v1.json")
    let failTemporaryOpen = false
    let foreignTemporary: string | undefined
    let identifier = 0
    const fileSystem = {
      open: async (path: string, flags: "r" | "wx", mode?: number) => {
        if (failTemporaryOpen && flags === "wx" && path.endsWith(".tmp")) {
          await writeFile(path, "foreign temporary data")
          foreignTemporary = path
          throw Object.assign(new Error("temporary already exists"), { code: "EEXIST" })
        }
        return openFile(path, flags, mode)
      },
    }
    const registryOptions: Parameters<typeof createBlogRegistry>[0] & {
      readonly fileSystem: typeof fileSystem
    } = {
      file,
      legacyPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      uuid: () => `00000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`,
      fileSystem,
    }
    const registry = createBlogRegistry(registryOptions)
    await registry.load()
    const previous = await readFile(file, "utf8")
    failTemporaryOpen = true

    await expect(registry.add({ name: "Second", path: secondPath })).rejects.toMatchObject({
      code: "EEXIST",
    })
    await expect(readFile(file, "utf8")).resolves.toBe(previous)
    await expect(readFile(foreignTemporary!, "utf8")).resolves.toBe("foreign temporary data")
  })

  it("retains the previous registry when replacing its temporary file fails", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const file = join(directory, "blogs.v1.json")
    let failReplacement = false
    let identifier = 0
    const fileSystem = {
      rename: async (source: string, destination: string) => {
        if (failReplacement && source.endsWith(".tmp")) throw new Error("simulated rename failure")
        const { rename } = await import("node:fs/promises")
        await rename(source, destination)
      },
    }
    const registryOptions: Parameters<typeof createBlogRegistry>[0] & {
      readonly fileSystem: typeof fileSystem
    } = {
      file,
      legacyPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      uuid: () => `00000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`,
      fileSystem,
    }
    const registry = createBlogRegistry(registryOptions)
    await registry.load()
    const previous = await readFile(file, "utf8")
    failReplacement = true

    await expect(registry.add({ name: "Second", path: secondPath })).rejects.toThrow(
      "simulated rename failure",
    )
    await expect(readFile(file, "utf8")).resolves.toBe(previous)
    await expect(readdir(directory)).resolves.toEqual([basename(file)])
  })

  it("preserves a relative display path while storing its real canonical path", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const relativePath = relative(process.cwd(), secondPath)
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)

    const state = await registry.add({ name: "Second", path: relativePath })

    expect(state.blogs[1]).toMatchObject({
      path: relativePath,
      canonicalPath: await realpath(relativePath),
    })
  })

  it("keeps a missing inactive workspace registered so it can be removed", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const added = await registry.add({ name: "Second", path: secondPath })
    const second = added.blogs[1]!
    await rm(secondPath, { recursive: true })

    await expect(registry.load()).resolves.toMatchObject({
      blogs: [{ path: legacyPath }, { id: second.id, path: secondPath }],
    })
    await expect(registry.remove(second.id)).resolves.toMatchObject({
      blogs: [{ path: legacyPath }],
    })
  })

  it("relocates a missing inactive workspace to a new available directory", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const replacementPath = await createGarden("replacement")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const added = await registry.add({ name: "Second", path: secondPath })
    const second = added.blogs[1]!
    await rm(secondPath, { recursive: true })

    await expect(registry.relocate(second.id, replacementPath)).resolves.toMatchObject({
      blogs: [
        { path: legacyPath },
        { id: second.id, path: replacementPath, canonicalPath: await realpath(replacementPath) },
      ],
    })
  })

  it("does not resolve persisted relative display paths against a later working directory", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const relativePath = relative(process.cwd(), secondPath)
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    await registry.add({ name: "Second", path: relativePath })
    const originalWorkingDirectory = process.cwd()

    try {
      process.chdir(directory)
      await expect(registry.load()).resolves.toMatchObject({
        blogs: [{ path: legacyPath }, { path: relativePath }],
      })
    } finally {
      process.chdir(originalWorkingDirectory)
    }
  })

  it("returns the existing state when the canonical path differs only by Windows casing", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const file = join(directory, "blogs.v1.json")
    const canonicalPath = (await realpath(legacyPath)).toLocaleUpperCase("en-US")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeBlogId: "00000000-0000-4000-8000-000000000001",
        blogs: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Legacy",
            path: legacyPath,
            canonicalPath,
            createdAt: "2026-10-01T00:00:00.000Z",
            lastOpenedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    )
    const registry = createRegistry(file, legacyPath)

    const state = await registry.add({ name: "Duplicate", path: legacyPath })

    expect(state.blogs).toHaveLength(1)
    expect(state.blogs[0]).toMatchObject({ name: "Legacy", canonicalPath })
  })

  it("rejects a generated id collision instead of registering ambiguous records", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const duplicateId = "00000000-0000-4000-8000-000000000001"
    const registry = createBlogRegistry({
      file: join(directory, "blogs.v1.json"),
      legacyPath,
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      uuid: () => duplicateId,
    })
    await registry.load()

    await expect(registry.add({ name: "Second", path: secondPath })).rejects.toThrow("collision")
    await expect(registry.load()).resolves.toMatchObject({ blogs: [{ id: duplicateId }] })
  })

  it("keeps a corrupt registry and reports recovery instead of replacing it", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const file = join(directory, "blogs.v1.json")
    await writeFile(file, "{broken")
    const registry = createRegistry(file, legacyPath)

    await expect(registry.load()).rejects.toMatchObject({
      code: "BLOG_REGISTRY_INVALID",
      path: file,
    })
    await expect(readFile(file, "utf8")).resolves.toBe("{broken")
  })

  it("recovers a corrupt registry only after preserving its exact bytes in a unique sibling backup", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const corrupt = Buffer.from([0xff, 0x7b, 0x00, 0x42])
    await writeFile(file, corrupt)
    const registry = createRegistry(file, legacyPath)

    const recovered = await registry.recover({ name: "Recovered", path: recoveredPath })

    expect(recovered).toMatchObject({
      version: 1,
      activeBlogId: recovered.blogs[0]?.id,
      blogs: [{ name: "Recovered", path: recoveredPath }],
    })
    const backup = (await readdir(directory)).find((name) =>
      /^blogs\.v1\.json\.corrupt-[0-9a-f-]{36}\.bak$/i.test(name),
    )
    expect(backup).toBeDefined()
    await expect(readFile(join(directory, backup!))).resolves.toEqual(corrupt)
    await expect(registry.load()).resolves.toEqual(recovered)
  })

  it("recovers a missing registry when the legacy workspace is unavailable without inventing a backup", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const unavailableLegacy = join(directory, "missing-legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, unavailableLegacy)

    await expect(registry.load()).rejects.toMatchObject({ code: "ENOENT" })

    const recovered = await registry.recover({ name: "Recovered", path: recoveredPath })

    expect(recovered).toMatchObject({
      version: 1,
      activeBlogId: recovered.blogs[0]?.id,
      blogs: [{ name: "Recovered", path: recoveredPath }],
    })
    await expect(registry.load()).resolves.toEqual(recovered)
    expect((await readdir(directory)).filter((name) => name.endsWith(".bak"))).toEqual([])
  })

  it("removes a newly published registry when missing-file recovery cannot durably sync it", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const unavailableLegacy = join(directory, "missing-legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    let directorySyncs = 0
    const fileSystem = {
      open: async (path: string, flags: "r" | "wx", mode?: number) => {
        const handle = await openFile(path, flags, mode)
        if (path !== directory || flags !== "r") return handle
        directorySyncs += 1
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            if (directorySyncs === 1) throw new Error("simulated recovery durability failure")
            await handle.sync()
          },
          close: handle.close.bind(handle),
        }
      },
    }
    const registry = createBlogRegistry({ file, legacyPath: unavailableLegacy, fileSystem })

    await expect(registry.recover({ name: "Recovered", path: recoveredPath })).rejects.toThrow(
      "simulated recovery durability failure",
    )

    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".bak") || name.endsWith(".tmp")),
    ).toEqual([])
  })

  it("serializes concurrent missing-file recovery and rejects the loser as healthy", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const unavailableLegacy = join(directory, "missing-legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, unavailableLegacy)

    const results = await Promise.allSettled([
      registry.recover({ name: "Recovered", path: recoveredPath }),
      registry.recover({ name: "Recovered twice", path: recoveredPath }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({ code: "BLOG_REGISTRY_HEALTHY" })
    expect((await readdir(directory)).filter((name) => name.endsWith(".bak"))).toEqual([])
  })

  it("rejects recovery for a healthy registry without creating a backup", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, legacyPath)
    await registry.load()

    await expect(
      registry.recover({ name: "Recovered", path: recoveredPath }),
    ).rejects.toMatchObject({
      code: "BLOG_REGISTRY_HEALTHY",
    })
    await expect(readdir(directory)).resolves.toEqual([basename(file)])
  })

  it("keeps the corrupt original and durable backup when replacement fails", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const corrupt = "{broken"
    await writeFile(file, corrupt)
    const fileSystem = {
      rename: async () => {
        throw new Error("simulated recovery publish failure")
      },
    }
    const registry = createBlogRegistry({ file, legacyPath, fileSystem })

    await expect(registry.recover({ name: "Recovered", path: recoveredPath })).rejects.toThrow(
      "simulated recovery publish failure",
    )
    await expect(readFile(file, "utf8")).resolves.toBe(corrupt)
    const backups = (await readdir(directory)).filter((name) => name.endsWith(".bak"))
    expect(backups).toHaveLength(1)
    await expect(readFile(join(directory, backups[0]!), "utf8")).resolves.toBe(corrupt)
  })

  it("atomically restores corrupt bytes when replacement fails after publication", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const corrupt = Buffer.from([0xff, 0x00, 0x7b])
    await writeFile(file, corrupt)
    let directorySyncs = 0
    const fileSystem = {
      open: async (path: string, flags: "r" | "wx", mode?: number) => {
        const handle = await openFile(path, flags, mode)
        if (path !== directory || flags !== "r") return handle
        directorySyncs += 1
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            if (directorySyncs === 2) throw new Error("simulated post-publish sync failure")
            await handle.sync()
          },
          close: handle.close.bind(handle),
        }
      },
    }
    const registry = createBlogRegistry({ file, legacyPath, fileSystem })

    await expect(registry.recover({ name: "Recovered", path: recoveredPath })).rejects.toThrow(
      "simulated post-publish sync failure",
    )
    await expect(readFile(file)).resolves.toEqual(corrupt)
    const backups = (await readdir(directory)).filter((name) => name.endsWith(".bak"))
    expect(backups).toHaveLength(1)
    await expect(readFile(join(directory, backups[0]!))).resolves.toEqual(corrupt)
  })

  it("preserves the primary recovery failure when corrupt-byte rollback durability also fails", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    const corrupt = Buffer.from([0xff, 0x00, 0x7b])
    await writeFile(file, corrupt)
    let directorySyncs = 0
    const fileSystem = {
      open: async (path: string, flags: "r" | "wx", mode?: number) => {
        const handle = await openFile(path, flags, mode)
        if (path !== directory || flags !== "r") return handle
        directorySyncs += 1
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            if (directorySyncs === 2) throw new Error("replacement durability failed")
            if (directorySyncs === 3) throw new Error("rollback durability failed")
            await handle.sync()
          },
          close: handle.close.bind(handle),
        }
      },
    }
    const registry = createBlogRegistry({ file, legacyPath, fileSystem })

    const failure = await registry.recover({ name: "Recovered", path: recoveredPath }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "replacement durability failed" }),
      expect.objectContaining({ message: "rollback durability failed" }),
    ])
    await expect(readFile(file)).resolves.toEqual(corrupt)
  })

  it("preserves the primary missing-file recovery failure when rollback sync also fails", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const unavailableLegacy = join(directory, "missing-legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    let directorySyncs = 0
    const fileSystem = {
      open: async (path: string, flags: "r" | "wx", mode?: number) => {
        const handle = await openFile(path, flags, mode)
        if (path !== directory || flags !== "r") return handle
        directorySyncs += 1
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            if (directorySyncs === 1) throw new Error("replacement durability failed")
            if (directorySyncs === 2) throw new Error("rollback durability failed")
            await handle.sync()
          },
          close: handle.close.bind(handle),
        }
      },
    }
    const registry = createBlogRegistry({ file, legacyPath: unavailableLegacy, fileSystem })

    const failure = await registry.recover({ name: "Recovered", path: recoveredPath }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "replacement durability failed" }),
      expect.objectContaining({ message: "rollback durability failed" }),
    ])
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("serializes concurrent corrupt-registry recovery so only one replacement succeeds", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const recoveredPath = await createGarden("recovered")
    const file = join(directory, "blogs.v1.json")
    await writeFile(file, "{broken")
    const registry = createRegistry(file, legacyPath)

    const results = await Promise.allSettled([
      registry.recover({ name: "Recovered", path: recoveredPath }),
      registry.recover({ name: "Recovered twice", path: recoveredPath }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: "BLOG_REGISTRY_HEALTHY",
    })
    expect((await readdir(directory)).filter((name) => name.endsWith(".bak"))).toHaveLength(1)
  })

  it("rejects a schema-valid canonical path that no longer matches the display path", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const unrelatedPath = await createGarden("unrelated")
    const file = join(directory, "blogs.v1.json")
    const source = JSON.stringify({
      version: 1,
      activeBlogId: "00000000-0000-4000-8000-000000000001",
      blogs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Legacy",
          path: legacyPath,
          canonicalPath: await realpath(unrelatedPath),
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    })
    await writeFile(file, source)

    await expect(createRegistry(file, legacyPath).load()).rejects.toMatchObject({
      code: "BLOG_REGISTRY_INVALID",
      path: file,
    })
    await expect(readFile(file, "utf8")).resolves.toBe(source)
  })

  it("rejects an unavailable canonical path when its absolute display path still exists", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const file = join(directory, "blogs.v1.json")
    const source = JSON.stringify({
      version: 1,
      activeBlogId: "00000000-0000-4000-8000-000000000001",
      blogs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Legacy",
          path: legacyPath,
          canonicalPath: join(directory, "missing-workspace"),
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    })
    await writeFile(file, source)

    await expect(createRegistry(file, legacyPath).load()).rejects.toMatchObject({
      code: "BLOG_REGISTRY_INVALID",
      path: file,
    })
    await expect(readFile(file, "utf8")).resolves.toBe(source)
  })

  it("rejects persisted registry data with duplicate ids", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const file = join(directory, "blogs.v1.json")
    const duplicateId = "00000000-0000-4000-8000-000000000001"
    const source = JSON.stringify({
      version: 1,
      activeBlogId: duplicateId,
      blogs: [
        {
          id: duplicateId,
          name: "Legacy",
          path: legacyPath,
          canonicalPath: await realpath(legacyPath),
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
        },
        {
          id: duplicateId,
          name: "Second",
          path: secondPath,
          canonicalPath: await realpath(secondPath),
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    })
    await writeFile(file, source)

    await expect(createRegistry(file, legacyPath).load()).rejects.toMatchObject({
      code: "BLOG_REGISTRY_INVALID",
      path: file,
    })
    await expect(readFile(file, "utf8")).resolves.toBe(source)
  })

  it("renames a registered blog and persists the new display name", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, legacyPath)
    const added = await registry.add({ name: "Second", path: secondPath })
    const second = added.blogs[1]!

    const renamed = await registry.rename(second.id, "Renamed blog")

    expect(renamed.blogs[1]).toMatchObject({ id: second.id, name: "Renamed blog" })
    await expect(createRegistry(file, legacyPath).load()).resolves.toMatchObject({
      blogs: [{ name: expect.any(String) }, { name: "Renamed blog" }],
    })
  })

  it("activates a registered blog and refreshes its last-opened timestamp", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const added = await registry.add({ name: "Second", path: secondPath })
    const second = added.blogs[1]!

    const activated = await registry.activate(second.id)

    expect(activated.activeBlogId).toBe(second.id)
    expect(activated.blogs[1]?.lastOpenedAt).not.toBe(second.lastOpenedAt)
  })

  it("removes an inactive blog without removing its workspace", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const added = await registry.add({ name: "Second", path: secondPath })
    const second = added.blogs[1]!

    const removed = await registry.remove(second.id)

    expect(removed.blogs).toHaveLength(1)
    await expect(stat(secondPath)).resolves.toBeDefined()
  })

  it("rejects removal of the active blog", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const state = await registry.load()

    await expect(registry.remove(state.activeBlogId)).rejects.toThrow("active")
    await expect(stat(legacyPath)).resolves.toBeDefined()
  })

  it("recanonicalizes relocated paths and rejects a relocation to another registered workspace", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const thirdPath = await createGarden("third")
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)
    const added = await registry.add({ name: "Second", path: secondPath })
    const second = added.blogs[1]!

    const relocated = await registry.relocate(second.id, thirdPath)

    expect(relocated.blogs[1]).toMatchObject({ path: thirdPath })
    await expect(registry.relocate(second.id, legacyPath)).rejects.toThrow("already registered")
  })
})
