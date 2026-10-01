import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBlogRegistry } from "../../src/main/services/blogRegistry"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
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
  it("migrates the legacy garden as the first active blog", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const file = join(directory, "blogs.v1.json")
    const registry = createRegistry(file, legacyPath)

    const state = await registry.load()

    expect(state.version).toBe(1)
    expect(state.blogs).toHaveLength(1)
    expect(state.blogs[0]).toMatchObject({ path: legacyPath, canonicalPath: await realpath(legacyPath) })
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
    expect(persisted).toMatchObject({ version: 1, blogs: [{ path: legacyPath }, { path: secondPath }] })
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

    await expect(registry.load()).resolves.toMatchObject({
      blogs: [{ path: legacyPath }, { path: secondPath }, { path: thirdPath }],
    })
  })

  it("preserves a relative display path while storing its real canonical path", async () => {
    const directory = await createDirectory("garden-blog-registry-state-")
    const legacyPath = await createGarden("legacy")
    const secondPath = await createGarden("second")
    const relativePath = relative(process.cwd(), secondPath)
    const registry = createRegistry(join(directory, "blogs.v1.json"), legacyPath)

    const state = await registry.add({ name: "Second", path: relativePath })

    expect(state.blogs[1]).toMatchObject({ path: relativePath, canonicalPath: await realpath(relativePath) })
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

    await expect(registry.load()).rejects.toMatchObject({ code: "BLOG_REGISTRY_INVALID", path: file })
    await expect(readFile(file, "utf8")).resolves.toBe("{broken")
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

    await expect(createRegistry(file, legacyPath).load()).rejects.toMatchObject({ code: "BLOG_REGISTRY_INVALID", path: file })
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
    await expect(createRegistry(file, legacyPath).load()).resolves.toMatchObject({ blogs: [{ name: expect.any(String) }, { name: "Renamed blog" }] })
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
