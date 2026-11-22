import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { inspectBlogAvailability } from "../../src/main/services/blogAvailability"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function createLocalBlog(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-blog-availability-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "content"))
  await mkdir(join(root, "private"))
  return root
}

describe("inspectBlogAvailability", () => {
  it("accepts a local blog with content and private directories without consulting Git", async () => {
    const root = await createLocalBlog()

    await expect(inspectBlogAvailability(root)).resolves.toEqual({
      available: true,
      canonicalPath: await realpath(root),
    })
  })

  it("rejects a local blog when private is missing", async () => {
    const root = await createLocalBlog()
    await rm(join(root, "private"), { recursive: true })

    await expect(inspectBlogAvailability(root)).resolves.toEqual({ available: false })
  })

  it("rejects an unsafe or missing root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "garden-blog-availability-parent-"))
    temporaryDirectories.push(parent)
    const fileRoot = join(parent, "not-a-directory")
    await writeFile(fileRoot, "not a directory")

    await expect(inspectBlogAvailability(fileRoot)).resolves.toEqual({ available: false })
    await expect(inspectBlogAvailability(join(parent, "missing"))).resolves.toEqual({
      available: false,
    })
  })
})
