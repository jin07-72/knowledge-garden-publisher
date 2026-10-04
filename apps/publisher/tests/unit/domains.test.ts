import { mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { discoverDomains, discoverDomainSlugs } from "../../src/main/services/domains"
import { domainSummarySchema } from "../../src/shared/ipcSchemas"
import { removeTemporaryDirectory } from "../helpers/fs"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function createGarden(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-domains-"))
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(join(root, "content"), { recursive: true }),
    mkdir(join(root, "private"), { recursive: true }),
  ])
  return root
}

async function writeFixture(
  root: string,
  relativePath: string,
  contents = "# Note\n",
): Promise<void> {
  const target = join(root, ...relativePath.split("/"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

function domainPage(
  title: string,
  description: string,
  order?: number,
  gardenDomain: unknown = true,
): string {
  return [
    "---",
    `gardenDomain: ${String(gardenDomain)}`,
    `title: ${title}`,
    `description: ${description}`,
    ...(order === undefined ? [] : [`domainOrder: ${order}`]),
    "---",
    "",
    `# ${title}`,
  ].join("\n")
}

describe("discoverDomains", () => {
  it("discovers only marked top-level pages in configured order and counts direct notes", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("AI", "Artificial intelligence.", 1)),
      writeFixture(root, "content/reading/index.md", domainPage("Reading", "Reading notes.", 2)),
      writeFixture(root, "content/ai/public-note.md"),
      writeFixture(root, "content/ai/nested/not-counted.md"),
      writeFixture(root, "private/ai/private-note.md"),
      writeFixture(root, "private/ai/nested/not-counted.md"),
      writeFixture(root, "private/ai/index.md"),
      writeFixture(
        root,
        "content/drafts/index.md",
        [
          "---",
          "gardenDomain: false",
          "title:",
          "  malformed: but ignored",
          "description: 42",
          "domainOrder: -10",
          "---",
        ].join("\n"),
      ),
      writeFixture(
        root,
        "content/topics/ai/index.md",
        domainPage("Nested AI", "Must not be discovered.", 0),
      ),
    ])

    await expect(discoverDomains(root)).resolves.toEqual([
      {
        slug: "ai",
        name: "AI",
        description: "Artificial intelligence.",
        order: 1,
        publicNotes: 1,
        privateNotes: 1,
      },
      {
        slug: "reading",
        name: "Reading",
        description: "Reading notes.",
        order: 2,
        publicNotes: 0,
        privateNotes: 0,
      },
    ])
  })

  it("sorts equal explicit orders by slug and legacy pages after them by slug", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/beta/index.md", domainPage("Beta", "Beta domain.", 3)),
      writeFixture(root, "content/alpha/index.md", domainPage("Alpha", "Alpha domain.", 3)),
      writeFixture(root, "content/legacy-z/index.md", domainPage("Legacy Z", "Legacy domain.")),
      writeFixture(root, "content/legacy-a/index.md", domainPage("Legacy A", "Legacy domain.")),
    ])

    const domains = await discoverDomains(root)

    expect(domains.map(({ slug }) => slug)).toEqual(["alpha", "beta", "legacy-a", "legacy-z"])
    expect(domains.slice(2).map(({ order }) => order)).toEqual([
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ])
    for (const domain of domains) expect(domainSummarySchema.safeParse(domain).success).toBe(true)
  })

  it.each([
    ["blank title", "title: '" + "'\ndescription: Description.\ndomainOrder: 0"],
    ["non-string description", "title: Domain\ndescription: 42\ndomainOrder: 0"],
    ["negative order", "title: Domain\ndescription: Description.\ndomainOrder: -1"],
    ["fractional order", "title: Domain\ndescription: Description.\ndomainOrder: 1.5"],
  ])("rejects marked metadata with a %s", async (_label, metadata) => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/broken/index.md",
      ["---", "gardenDomain: true", metadata, "---"].join("\n"),
    )

    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/broken/index.md" },
    })
  })

  it("rejects malformed YAML when the page is explicitly marked", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/broken/index.md",
      ["---", "gardenDomain: true", "title: [unterminated", "---"].join("\n"),
    )

    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/broken/index.md" },
    })
  })

  it("rejects uniformly indented malformed YAML when the page is marked", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/indented/index.md",
      ["---", "  gardenDomain: true", "  title: [unterminated", "---"].join("\n"),
    )

    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/indented/index.md" },
    })
  })

  it("rejects malformed YAML in a language-tagged marked frontmatter block", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/tagged/index.md",
      ["---yaml", "gardenDomain: true", "title: [unterminated", "---"].join("\n"),
    )

    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/tagged/index.md" },
    })
  })

  it.each(["javascript", "js"])(
    "rejects executable %s frontmatter without evaluating it",
    async (language) => {
      const root = await createGarden()
      const probe = `__gardenMatter${language}Probe`
      delete (globalThis as Record<string, unknown>)[probe]
      await writeFixture(
        root,
        `content/executable-${language}/index.md`,
        [`---${language}`, `globalThis.${probe} = true`, "---"].join("\n"),
      )

      try {
        await expect(discoverDomains(root)).rejects.toMatchObject({
          code: "DOMAIN_METADATA_INVALID",
          details: { path: `content/executable-${language}/index.md` },
        })
        expect((globalThis as Record<string, unknown>)[probe]).toBeUndefined()
      } finally {
        delete (globalThis as Record<string, unknown>)[probe]
      }
    },
  )

  it("rejects the same malformed marked page consistently across repeated discovery", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/broken/index.md",
      ["---", "gardenDomain: true", "title: [unterminated", "---"].join("\n"),
    )

    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/broken/index.md" },
    })
    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/broken/index.md" },
    })
  })

  it.each(["yml", "YAML", "Yml"])(
    "rejects malformed marked pages with a %s language tag",
    async (language) => {
      const root = await createGarden()
      await writeFixture(
        root,
        `content/malformed-${language}/index.md`,
        [`---${language}`, "gardenDomain: true", "title: [unterminated", "---"].join("\n"),
      )

      await expect(discoverDomains(root)).rejects.toMatchObject({
        code: "DOMAIN_METADATA_INVALID",
        details: { path: `content/malformed-${language}/index.md` },
      })
    },
  )

  it("ignores explicitly unmarked pages with malformed unrelated YAML", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/drafts/index.md",
      ["---", "gardenDomain: false", "title: [unterminated", "---"].join("\n"),
    )

    await expect(discoverDomains(root)).resolves.toEqual([])
  })

  it.each(["false", "true"])("ignores a quoted gardenDomain %s string", async (marker) => {
    const root = await createGarden()
    await writeFixture(
      root,
      `content/quoted-${marker}/index.md`,
      [
        "---",
        `gardenDomain: \"${marker}\"`,
        "title: Quoted marker",
        "description: This is a string, not a boolean marker.",
        "domainOrder: 0",
        "---",
      ].join("\n"),
    )

    await expect(discoverDomains(root)).resolves.toEqual([])
  })

  it("discovers a YAML-tagged boolean true marker", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/tagged-boolean/index.md",
      [
        "---",
        "gardenDomain: !!bool true",
        "title: Tagged boolean",
        "description: This marker is semantically true.",
        "domainOrder: 4",
        "---",
      ].join("\n"),
    )

    await expect(discoverDomains(root)).resolves.toEqual([
      {
        slug: "tagged-boolean",
        name: "Tagged boolean",
        description: "This marker is semantically true.",
        order: 4,
        publicNotes: 0,
        privateNotes: 0,
      },
    ])
  })

  it("rejects a marked page in a directory that is not a valid domain slug", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/Not Valid/index.md",
      domainPage("Invalid slug", "Marked but unsafe to address.", 0),
    )

    await expect(discoverDomains(root)).rejects.toMatchObject({
      code: "DOMAIN_METADATA_INVALID",
      details: { path: "content/Not Valid/index.md" },
    })
  })

  it.each(["managed root", "candidate directory", "index file", "count entry"])(
    "fails closed for a link at the %s boundary",
    async (boundary) => {
      const root = await createGarden()
      const outside = await mkdtemp(join(tmpdir(), "garden-domains-link-target-"))
      temporaryDirectories.push(outside)

      if (boundary === "managed root") {
        await rm(join(root, "content"), { recursive: true })
        await symlink(outside, join(root, "content"), "junction")
      } else if (boundary === "candidate directory") {
        await writeFile(join(outside, "index.md"), domainPage("Linked", "Linked domain.", 0))
        await symlink(outside, join(root, "content", "linked"), "junction")
      } else if (boundary === "index file") {
        await mkdir(join(root, "content", "ai"))
        await symlink(outside, join(root, "content", "ai", "index.md"), "junction")
      } else {
        await writeFixture(root, "content/ai/index.md", domainPage("AI", "AI domain.", 0))
        const linkedDirectory = join(outside, "linked-directory")
        await mkdir(linkedDirectory)
        await symlink(linkedDirectory, join(root, "content", "ai", "linked.md"), "junction")
      }

      await expect(discoverDomains(root)).rejects.toMatchObject({ code: "DOMAIN_UNSAFE_PATH" })
    },
  )

  it("rejects a count directory swapped for a junction after enumeration", async () => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-domains-swap-target-"))
    temporaryDirectories.push(outside)
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("AI", "AI domain.", 0)),
      writeFixture(root, "private/ai/leak.md"),
      writeFile(join(outside, "leak.md"), "# Outside\n"),
    ])
    const privateDomain = await realpath(join(root, "private", "ai"))
    const displaced = join(root, "private", "ai-displaced")
    let didSwap = false
    const discoverWithHooks = discoverDomains as unknown as (
      workspace: string,
      options: { afterCountReaddir(path: string): Promise<void> },
    ) => ReturnType<typeof discoverDomains>

    let error: unknown
    try {
      await discoverWithHooks(root, {
        afterCountReaddir: async (path) => {
          if (path !== privateDomain || didSwap) return
          await rename(privateDomain, displaced)
          await symlink(outside, privateDomain, "junction")
          didSwap = true
        },
      })
    } catch (caught) {
      error = caught
    }
    expect(didSwap).toBe(true)
    expect(error).toMatchObject({ code: "DOMAIN_UNSAFE_PATH" })
  })

  it("rejects a managed root replaced while another root count is pending", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("AI", "AI domain.", 0)),
      writeFixture(root, "private/ai/private-note.md"),
    ])
    const contentDomain = await realpath(join(root, "content", "ai"))
    const privateDomain = await realpath(join(root, "private", "ai"))
    const contentRoot = await realpath(join(root, "content"))
    const displaced = join(root, "content-displaced")
    let releasePrivate!: () => void
    const contentCountFinished = new Promise<void>((resolve) => {
      releasePrivate = resolve
    })
    const fallback = setTimeout(releasePrivate, 100)
    let didSwap = false
    const discoverWithHooks = discoverDomains as unknown as (
      workspace: string,
      options: {
        afterCountReaddir(path: string): Promise<void>
        afterCountComplete(path: string): Promise<void>
      },
    ) => ReturnType<typeof discoverDomains>

    let error: unknown
    try {
      await discoverWithHooks(root, {
        afterCountReaddir: async (path) => {
          if (path === privateDomain) await contentCountFinished
        },
        afterCountComplete: async (path) => {
          if (path !== contentDomain || didSwap) return
          await rename(contentRoot, displaced)
          await mkdir(contentRoot)
          didSwap = true
          clearTimeout(fallback)
          releasePrivate()
        },
      })
    } catch (caught) {
      error = caught
    } finally {
      clearTimeout(fallback)
      releasePrivate()
    }
    expect(didSwap).toBe(true)
    expect(error).toMatchObject({ code: "DOMAIN_UNSAFE_PATH" })
  })

  it("rejects an index file modified after its handle read", async () => {
    const root = await createGarden()
    const source = domainPage("AI", "AI domain.", 0)
    const indexPath = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    const fixedTime = new Date("2026-10-04T05:00:00.000Z")
    await utimes(indexPath, fixedTime, fixedTime)
    let didRewrite = false
    const discoverWithHooks = discoverDomains as unknown as (
      workspace: string,
      options: { afterIndexRead(path: string): Promise<void> },
    ) => ReturnType<typeof discoverDomains>

    let error: unknown
    try {
      await discoverWithHooks(root, {
        afterIndexRead: async (path) => {
          if (path !== "content/ai/index.md") return
          await writeFile(indexPath, source.replace("title: AI", "title: ML"))
          await utimes(indexPath, fixedTime, fixedTime)
          didRewrite = true
        },
      })
    } catch (caught) {
      error = caught
    }
    expect(didRewrite).toBe(true)
    expect(error).toMatchObject({ code: "DOMAIN_UNSAFE_PATH" })
  })
})

describe("discoverDomainSlugs", () => {
  it("returns the discovered domain identities as a read-only set", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("AI", "AI domain.", 0)),
      writeFixture(root, "content/reading/index.md", domainPage("Reading", "Reading domain.", 1)),
    ])

    const slugs = await discoverDomainSlugs(root)

    expect([...slugs]).toEqual(["ai", "reading"])
  })
})
