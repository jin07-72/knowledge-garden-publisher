import {
  link as linkFile,
  mkdir,
  mkdtemp,
  lstat,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { EventEmitter } from "node:events"
import { spawn as spawnProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import matter from "gray-matter"
import * as domainService from "../../src/main/services/domains"
import {
  createDomainCatalog,
  discoverDomains,
  discoverDomainSlugs,
  nativeWindowsPath,
  parseReplaceFileDiagnostic,
} from "../../src/main/services/domains"
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

async function fakeAtomicReplaceWithBackup(
  replacement: string,
  replaced: string,
  backup: string,
): Promise<void> {
  await linkFile(replaced, backup)
  await rename(replacement, replaced)
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

function rawFrontmatterBody(source: string): string {
  const closing = source.indexOf("\n---", 3)
  if (closing < 0) throw new Error("fixture frontmatter is not closed")
  let offset = closing + "\n---".length
  if (source[offset] === "\r") offset += 1
  if (source[offset] === "\n") offset += 1
  return source.slice(offset)
}

async function renameJournalEvidence(path: string) {
  const [details, bytes] = await Promise.all([lstat(path, { bigint: true }), readFile(path)])
  return {
    identity: {
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      size: details.size.toString(),
      mtimeNs: details.mtimeNs.toString(),
      ctimeNs: details.ctimeNs.toString(),
    },
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  }
}

async function seedDomainRenameJournal(
  root: string,
  phase: "prepared" | "quarantined" | "published",
): Promise<{
  readonly index: string
  readonly original: string
  readonly published: string
  readonly artifacts: readonly string[]
  readonly transaction: string
}> {
  const id = `00000000-0000-4000-8000-0000000000${
    phase === "prepared" ? "11" : phase === "quarantined" ? "12" : "13"
  }`
  const index = join(root, "content", "ai", "index.md")
  const temporary = `${index}.tmp-${id}`
  const backup = `${index}.backup-${id}`
  const quarantine = `${index}.quarantine-${id}`
  const original = domainPage("人工智能", "人工智能领域。", 1)
  const published = original.replace("title: 人工智能", "title: 智能系统")
  await writeFixture(root, "content/ai/index.md", original)
  await writeFile(temporary, published)
  await linkFile(index, backup)
  const [originalEvidence, publishedEvidence] = await Promise.all([
    renameJournalEvidence(index),
    renameJournalEvidence(temporary),
  ])
  if (phase !== "prepared") await rename(index, quarantine)
  if (phase === "published") await linkFile(temporary, index)
  const transaction = join(root, ".garden-publisher", "domain-rename-transactions", id)
  await mkdir(transaction, { recursive: true })
  await writeFile(
    join(transaction, "journal.json"),
    `${JSON.stringify({
      version: 1,
      id,
      phase,
      target: "content/ai/index.md",
      temporary: `content/ai/index.md.tmp-${id}`,
      backup: `content/ai/index.md.backup-${id}`,
      quarantine: `content/ai/index.md.quarantine-${id}`,
      intendedTitle: "智能系统",
      original: originalEvidence,
      published: publishedEvidence,
    })}\n`,
  )
  return {
    index,
    original,
    published,
    artifacts: [temporary, backup, quarantine],
    transaction,
  }
}

async function seedDomainRenamePhaseTransition(
  root: string,
  finalPhase: "prepared" | "quarantined",
  stagedPhase: "quarantined" | "published",
): Promise<{
  readonly index: string
  readonly original: string
  readonly published: string
  readonly transaction: string
}> {
  const id = `00000000-0000-4000-8000-00000000004${
    finalPhase === "prepared" ? (stagedPhase === "published" ? "3" : "1") : "2"
  }`
  const index = join(root, "content", "ai", "index.md")
  const temporary = `${index}.tmp-${id}`
  const backup = `${index}.backup-${id}`
  const quarantine = `${index}.quarantine-${id}`
  const original = domainPage("人工智能", "人工智能领域。", 1)
  const published = original.replace("title: 人工智能", "title: 智能系统")
  await writeFixture(root, "content/ai/index.md", original)
  await writeFile(temporary, published)
  await linkFile(index, backup)
  const [originalEvidence, publishedEvidence] = await Promise.all([
    renameJournalEvidence(index),
    renameJournalEvidence(temporary),
  ])
  await rename(index, quarantine)
  if (stagedPhase === "published") await linkFile(temporary, index)
  const transaction = join(root, ".garden-publisher", "domain-rename-transactions", id)
  await mkdir(transaction, { recursive: true })
  const journal = (phase: "prepared" | "quarantined" | "published") =>
    `${JSON.stringify({
      version: 1,
      id,
      phase,
      target: "content/ai/index.md",
      temporary: `content/ai/index.md.tmp-${id}`,
      backup: `content/ai/index.md.backup-${id}`,
      quarantine: `content/ai/index.md.quarantine-${id}`,
      intendedTitle: "智能系统",
      original: originalEvidence,
      published: publishedEvidence,
    })}\n`
  await writeFile(join(transaction, "journal.json"), journal(finalPhase))
  await writeFile(
    join(transaction, "journal.json.tmp-00000000-0000-4000-8000-000000000049"),
    journal(stagedPhase),
  )
  return { index, original, published, transaction }
}

describe("discoverDomains", () => {
  it("normalizes Windows replacement paths while preserving only safe extended forms", () => {
    const longDrivePath = `C:\\\\${"a".repeat(270)}\\\\replacement.tmp`
    const uncPath = `\\\\server\\share\\${"b".repeat(270)}\\\\replacement.tmp`
    expect(nativeWindowsPath(longDrivePath, "replacement")).toBe(`\\\\?\\${longDrivePath}`)
    expect(nativeWindowsPath(uncPath, "replaced")).toBe(
      `\\\\?\\UNC\\server\\share\\${"b".repeat(270)}\\\\replacement.tmp`,
    )
    expect(nativeWindowsPath(`\\\\?\\C:\\\\already-extended.tmp`, "backup")).toBe(
      `\\\\?\\C:\\\\already-extended.tmp`,
    )
    expect(() => nativeWindowsPath(`\\\\.\\PhysicalDrive0`, "replacement")).toThrow(
      "Unsupported Windows device namespace",
    )
    expect(() =>
      nativeWindowsPath(`\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1`, "backup"),
    ).toThrow("Unsupported Windows device namespace")
  })

  it("parses only the bounded native replacement diagnostic sentinel", () => {
    const message = "ReplaceFileW failed: 文件被占用"
    const encoded = Buffer.from(message, "utf8").toString("base64")
    expect(
      parseReplaceFileDiagnostic(
        `#< CLIXML\nprogress noise\nKGP_REPLACE_FILE_ERROR:32:${encoded}\nmore noise`,
      ),
    ).toEqual({ code: 32, message })
    expect(parseReplaceFileDiagnostic("#< CLIXML\nprogress noise")).toBeUndefined()
  })

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
  it("binds classification and landing evidence to the same safe read", async () => {
    const root = await createGarden()
    const landing = join(root, "content", "artificial-intelligence", "index.md")
    await writeFixture(
      root,
      "content/artificial-intelligence/index.md",
      domainPage("Artificial intelligence", "A custom marked domain.", 0),
    )
    const discoverSnapshot = (
      domainService as typeof domainService & {
        discoverDomainSnapshot?: (
          workspace: string,
          options: { afterDomainClassified(path: string): Promise<void> },
        ) => Promise<{ readonly slugs: readonly string[] }>
      }
    ).discoverDomainSnapshot

    expect(discoverSnapshot).toBeTypeOf("function")
    let flipped = false
    await expect(
      discoverSnapshot!(root, {
        afterDomainClassified: async (path) => {
          if (flipped || path !== "content/artificial-intelligence/index.md") return
          flipped = true
          await rm(landing)
          await writeFile(landing, "---\ngardenDomain: false\n---\n")
        },
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_UNSAFE_PATH" })
    expect(flipped).toBe(true)
  })
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

describe("DomainCatalog.create", () => {
  it("creates an exclusive landing page and private directory with the next domain order", async () => {
    const root = await createGarden()
    await Promise.all(
      [
        ["technology", "技术", 1],
        ["reading", "阅读", 2],
        ["language", "语言", 3],
        ["life", "生活", 4],
      ].map(([slug, name, order]) =>
        writeFixture(
          root,
          `content/${slug}/index.md`,
          domainPage(String(name), `${String(name)}领域。`, Number(order)),
        ),
      ),
    )
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      now: () => new Date("2026-01-01T16:30:00.000Z"),
    })

    const domains = await catalog.create({ name: "人工智能", slug: "artificial-intelligence" })

    expect(domains.at(-1)).toEqual({
      slug: "artificial-intelligence",
      name: "人工智能",
      description: "人工智能领域的学习记录。",
      order: 5,
      publicNotes: 0,
      privateNotes: 0,
    })
    const expected = matter.stringify("\n这里用于整理人工智能领域的学习记录。\n", {
      title: "人工智能",
      date: "2026-01-02",
      description: "人工智能领域的学习记录。",
      tags: ["artificial-intelligence"],
      gardenDomain: true,
      domainOrder: 5,
    })
    const landing = await readFile(
      join(root, "content", "artificial-intelligence", "index.md"),
      "utf8",
    )
    expect(landing).toBe(expected)
    expect(landing).not.toContain("\r")
    await expect(readdir(join(root, "private", "artificial-intelligence"))).resolves.toEqual([])
    await expect(catalog.list()).resolves.toEqual(domains)
  })

  it("does not populate gray-matter's global cache while generating a landing page", async () => {
    const root = await createGarden()
    const cacheAwareMatter = matter as typeof matter & {
      cache: Record<string, unknown>
      clearCache(): void
    }
    cacheAwareMatter.clearCache()
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    try {
      await catalog.create({ name: "缓存隔离", slug: "cache-isolation" })
      expect(Object.keys(cacheAwareMatter.cache)).toEqual([])
    } finally {
      cacheAwareMatter.clearCache()
    }
  })

  it("rejects duplicate slugs and display names", async () => {
    const root = await createGarden()
    await writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1))
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.create({ name: "机器学习", slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ALREADY_EXISTS",
    })
    await expect(
      catalog.create({ name: "人工智能", slug: "machine-learning" }),
    ).rejects.toMatchObject({ code: "DOMAIN_ALREADY_EXISTS" })
  })

  it.each([
    { name: "", slug: "custom" },
    { name: "x".repeat(81), slug: "custom" },
    { name: "人工智能", slug: "../outside" },
    { name: "人工智能", slug: "content" },
  ])("validates reserved and invalid create requests before touching disk", async (request) => {
    const root = await createGarden()
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.create(request)).rejects.toBeDefined()

    await expect(readdir(join(root, "content"))).resolves.toEqual([])
    await expect(readdir(join(root, "private"))).resolves.toEqual([])
  })

  it.each(["content", "private"])(
    "rejects a collision with an unmarked pre-existing %s directory",
    async (managedRoot) => {
      const root = await createGarden()
      await writeFixture(root, `${managedRoot}/custom/keep.txt`, "do not replace")
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })

      await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toMatchObject({
        code: "DOMAIN_ALREADY_EXISTS",
      })

      await expect(readFile(join(root, managedRoot, "custom", "keep.txt"), "utf8")).resolves.toBe(
        "do not replace",
      )
    },
  )

  it("rolls back only its newly-created public directory when the landing write fails", async () => {
    const root = await createGarden()
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          if (path === join(root, "content", "custom", "index.md") && flags === "wx") {
            throw new Error("simulated second creation failure")
          }
          return openFile(path, flags, mode)
        },
      },
    })

    await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toThrow(
      "simulated second creation failure",
    )

    await expect(readdir(join(root, "content"))).resolves.toEqual([])
    await expect(readdir(join(root, "private"))).resolves.toEqual([])
  })

  it("removes the exact exclusive landing inode when writing it fails after creation", async () => {
    const root = await createGarden()
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== join(root, "content", "custom", "index.md") || flags !== "wx") {
            return handle
          }
          return {
            writeFile: async () => {
              throw new Error("simulated landing write failure")
            },
            sync: handle.sync.bind(handle),
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toThrow(
      "simulated landing write failure",
    )

    await expect(readdir(join(root, "content"))).resolves.toEqual([])
    await expect(readdir(join(root, "private"))).resolves.toEqual([])
  })

  it("fails closed without deleting a replacement installed during private directory creation", async () => {
    const root = await createGarden()
    const publicDirectory = join(root, "content", "custom")
    const privateDirectory = join(root, "private", "custom")
    const displaced = join(root, "owned-custom-displaced")
    const replacement = join(publicDirectory, "replacement.txt")
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        mkdir: (async (path: string, options?: { readonly mode?: number }) => {
          await mkdir(path, options)
          if (path === privateDirectory) {
            await rename(publicDirectory, displaced)
            await mkdir(publicDirectory)
            await writeFile(replacement, "concurrent replacement")
          }
        }) as typeof mkdir,
      },
    })

    await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    await expect(readFile(replacement, "utf8")).resolves.toBe("concurrent replacement")
    await expect(readFile(join(displaced, "index.md"), "utf8")).resolves.toContain("title: 自定义")
    await expect(lstat(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("preserves an in-place landing edit when private directory creation fails", async () => {
    const root = await createGarden()
    const index = join(root, "content", "custom", "index.md")
    const privateDirectory = join(root, "private", "custom")
    const concurrent = "concurrent landing edit"
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        mkdir: (async (path: string, options?: { readonly mode?: number }) => {
          if (path === privateDirectory) {
            await writeFile(index, concurrent)
            throw new Error("simulated private directory creation failure")
          }
          await mkdir(path, options)
        }) as typeof mkdir,
      },
    })

    await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    await expect(readFile(index, "utf8")).resolves.toBe(concurrent)
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("does not delete owned create artifacts relocated into a substituted content root", async () => {
    const root = await createGarden()
    await writeFixture(root, "content/sibling/keep.md", "sibling evidence")
    const contentRoot = join(root, "content")
    const displacedContent = join(root, "owned-content-root")
    const publicDirectory = join(contentRoot, "custom")
    const privateDirectory = join(root, "private", "custom")
    const index = join(publicDirectory, "index.md")
    let substituted = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        mkdir: (async (path: string, options?: { readonly mode?: number }) => {
          if (path === privateDirectory) {
            substituted = true
            await rename(contentRoot, displacedContent)
            await mkdir(contentRoot)
            await rename(join(displacedContent, "custom"), publicDirectory)
            throw new Error("simulated private creation failure after root substitution")
          }
          await mkdir(path, options)
        }) as typeof mkdir,
      },
    })

    await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(substituted).toBe(true)
    await expect(readFile(index, "utf8")).resolves.toContain("title: 自定义")
    await expect(readFile(join(displacedContent, "sibling", "keep.md"), "utf8")).resolves.toBe(
      "sibling evidence",
    )
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("serializes concurrent creates so each observes the previous domain order", async () => {
    const root = await createGarden()
    let releaseFirst!: () => void
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let landingOpens = 0
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          if (String(path).endsWith("index.md") && flags === "wx") {
            landingOpens += 1
            if (landingOpens === 1) {
              firstStarted()
              await firstMayContinue
            }
          }
          return openFile(path, flags, mode)
        },
      },
    })

    const first = catalog.create({ name: "人工智能", slug: "ai" })
    await firstDidStart
    const second = catalog.create({ name: "阅读", slug: "reading" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(landingOpens).toBe(1)
    releaseFirst()

    await expect(Promise.all([first, second])).resolves.toBeDefined()
    await expect(catalog.list()).resolves.toMatchObject([
      { slug: "ai", order: 1 },
      { slug: "reading", order: 2 },
    ])
  })

  it("fails closed when no safe integer domain order remains", async () => {
    const root = await createGarden()
    await writeFixture(
      root,
      "content/legacy/index.md",
      domainPage("Legacy", "Legacy domain.", Number.MAX_SAFE_INTEGER),
    )
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.create({ name: "自定义", slug: "custom" })).rejects.toMatchObject({
      code: "DOMAIN_ORDER_EXHAUSTED",
    })
  })

  it("chooses the next order from explicit orders while keeping legacy domains last", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/explicit/index.md", domainPage("显式", "显式领域。", 4)),
      writeFixture(root, "content/legacy/index.md", domainPage("旧领域", "旧领域。")),
    ])
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    const domains = await catalog.create({ name: "新增", slug: "new-domain" })

    expect(domains.map(({ slug }) => slug)).toEqual(["explicit", "new-domain", "legacy"])
    expect(domains.find(({ slug }) => slug === "new-domain")?.order).toBe(5)
  })
})

describe("DomainCatalog.rename", () => {
  it("changes only the title while preserving the slug, body, and all other frontmatter", async () => {
    const root = await createGarden()
    const source = [
      "---",
      "title: 人工智能",
      "date: 2026-10-04",
      "description: 人工智能领域的学习记录。",
      "tags:",
      "  - ai",
      "gardenDomain: true",
      "domainOrder: 3",
      "custom:",
      "  pinned: true",
      "---",
      "",
      "## 保留正文",
      "",
      "正文内容不会因重命名而变化。",
      "",
    ].join("\n")
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    await mkdir(join(root, "private", "ai"))
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    const domains = await catalog.rename({ slug: "ai", name: "智能系统" })

    expect(domains).toMatchObject([
      {
        slug: "ai",
        name: "智能系统",
        description: "人工智能领域的学习记录。",
        order: 3,
      },
    ])
    const before = matter(source)
    const afterSource = await readFile(index, "utf8")
    const after = matter(afterSource)
    expect(after.data).toEqual({ ...before.data, title: "智能系统" })
    expect(after.content).toBe(before.content)
    expect(afterSource).not.toContain("\r")
    await expect(readdir(join(root, "content"))).resolves.toEqual(["ai"])
  })

  it.each([
    ["without a final newline", "正文没有结尾换行", "\n"],
    ["with CRLF bytes", "第一行\r\n第二行\r\n", "\r\n"],
  ])("preserves a body %s byte-for-byte", async (_label, body, lineEnding) => {
    const root = await createGarden()
    const source =
      [
        "---",
        "title: 人工智能",
        "date: 2026-10-04",
        "description: 人工智能领域的学习记录。",
        "tags:",
        "  - ai",
        "gardenDomain: true",
        "domainOrder: 1",
        "---",
      ].join(lineEnding) +
      lineEnding +
      body
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await catalog.rename({ slug: "ai", name: "智能系统" })

    const renamed = await readFile(index, "utf8")
    expect(rawFrontmatterBody(renamed)).toBe(body)
  })

  it("rejects a duplicate display name and a missing domain", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1)),
      writeFixture(root, "content/reading/index.md", domainPage("阅读", "阅读领域。", 2)),
    ])
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.rename({ slug: "ai", name: "阅读" })).rejects.toMatchObject({
      code: "DOMAIN_ALREADY_EXISTS",
    })
    await expect(catalog.rename({ slug: "missing", name: "不存在" })).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
    })
  })

  it.each(["modified", "swapped"])(
    "rejects a landing page %s after its safe read and before replacement",
    async (change) => {
      const root = await createGarden()
      const source = domainPage("人工智能", "人工智能领域。", 1)
      const index = join(root, "content", "ai", "index.md")
      const displaced = join(root, "content", "ai", "original.md")
      await writeFixture(root, "content/ai/index.md", source)
      const external = source.replace("title: 人工智能", "title: 外部修改")
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
        hooks: {
          afterRenameRead: async () => {
            if (change === "modified") await writeFile(index, external)
            else {
              await rename(index, displaced)
              await writeFile(index, external)
            }
          },
        },
      })

      await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
        code: "DOMAIN_UNSAFE_PATH",
      })

      await expect(readFile(index, "utf8")).resolves.toBe(external)
      expect((await readdir(dirname(index))).filter((name) => name.includes(".tmp-"))).toEqual([])
    },
  )

  it("preserves an edit made immediately before publishing the staged rename", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const concurrent = `${domainPage("发布边界编辑", "用户并发修改。", 1)}\n必须保留`
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let editedAtPublish = false
    let backupPath: string | undefined
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          editedAtPublish = true
          backupPath = backup
          await writeFile(replaced, concurrent)
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toBeDefined()

    expect(editedAtPublish).toBe(true)
    await expect(readFile(backupPath!, "utf8")).resolves.toBe(concurrent)
  })

  it("fails closed when the managed content root changes during rename backup", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const contentRoot = join(root, "content")
    const displacedContent = join(root, "owned-content-root")
    const index = join(contentRoot, "ai", "index.md")
    await Promise.all([
      writeFixture(root, "content/ai/index.md", source),
      writeFixture(root, "content/sibling/keep.md", "sibling evidence"),
    ])
    let substituted = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          if (!substituted) {
            substituted = true
            await rename(contentRoot, displacedContent)
            await mkdir(contentRoot)
            await rename(join(displacedContent, "ai"), join(contentRoot, "ai"))
          }
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(substituted).toBe(true)
    await expect(lstat(index)).resolves.toMatchObject({})
    await expect(readFile(join(displacedContent, "sibling", "keep.md"), "utf8")).resolves.toBe(
      "sibling evidence",
    )
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("preserves a replacement inode installed immediately before atomic replacement", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const concurrent = `${domainPage("并发替换", "用户替换的新文件。", 1)}\n必须保留`
    const index = join(root, "content", "ai", "index.md")
    const displaced = join(root, "content", "ai", "external-original.md")
    await writeFixture(root, "content/ai/index.md", source)
    let replaced = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      uuid: () => "00000000-0000-4000-8000-000000000010",
      fileSystem: {
        replaceFile: async (replacement) => {
          replaced = true
          await rename(index, displaced)
          await writeFile(index, concurrent)
          throw new Error("simulated concurrent replacement before atomic swap")
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toBeDefined()

    expect(replaced).toBe(true)
    await expect(readFile(index, "utf8")).resolves.toBe(concurrent)
    await expect(readFile(displaced, "utf8")).resolves.toBe(source)
  })

  it("rejects a same-byte replacement inode and preserves its backup", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    const displaced = join(root, "content", "ai", "external-original.md")
    await writeFixture(root, "content/ai/index.md", source)
    let backupPath: string | undefined
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          backupPath = backup
          await rename(replaced, displaced)
          await writeFile(replaced, source)
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    await expect(readFile(displaced, "utf8")).resolves.toBe(source)
    await expect(readFile(backupPath!, "utf8")).resolves.toBe(source)
    const displacedIdentity = await lstat(displaced)
    const backupIdentity = await lstat(backupPath!)
    expect(`${backupIdentity.dev}:${backupIdentity.ino}`).not.toBe(
      `${displacedIdentity.dev}:${displacedIdentity.ino}`,
    )
    await expect(readFile(index, "utf8")).resolves.toContain("title: 智能系统")
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it.each(["prepared", "quarantined", "published"] as const)(
    "recovers a %s durable rename journal when a new catalog starts",
    async (phase) => {
      const root = await createGarden()
      const seeded = await seedDomainRenameJournal(root, phase)
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })

      const domains = await catalog.list()

      const expected = phase === "published" ? seeded.published : seeded.original
      expect(domains).toMatchObject([
        { slug: "ai", name: phase === "published" ? "智能系统" : "人工智能" },
      ])
      await expect(readFile(seeded.index, "utf8")).resolves.toBe(expected)
      for (const artifact of seeded.artifacts) {
        await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" })
      }
      await expect(lstat(seeded.transaction)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(catalog.dispose()).resolves.toBeUndefined()
    },
  )

  it("changes only the title scalar bytes and preserves YAML comments and quoting", async () => {
    const root = await createGarden()
    const source = [
      "---",
      "# domain metadata must remain byte-identical",
      "title: '人工智能' # display label",
      'description: "人工智能领域。"',
      'custom: "001" # quoted numeric-looking value',
      "gardenDomain: true",
      "domainOrder: 1",
      "---",
      "",
      "正文保持不变。",
    ].join("\n")
    const expected = source.replace("title: '人工智能'", "title: '智能系统'")
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await catalog.rename({ slug: "ai", name: "智能系统" })

    await expect(readFile(index, "utf8")).resolves.toBe(expected)
  })

  it.each(["|-", ">-"])(
    "replaces a %s block title while preserving every byte outside the scalar node",
    async (style) => {
      const root = await createGarden()
      const originalTitle = `${style}\n  人工\n  智能`
      const source = [
        "---",
        "# frontmatter comment must remain unchanged",
        `title: ${style}`,
        "  人工",
        "  智能",
        'description: "人工智能领域。" # preserve this quote and comment',
        'custom: "001"',
        "gardenDomain: true",
        "domainOrder: 1",
        "---",
        "",
        "正文保持不变。",
      ].join("\n")
      const expected = source.replace(originalTitle, "智能系统")
      const index = join(root, "content", "ai", "index.md")
      await writeFixture(root, "content/ai/index.md", source)
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })

      await catalog.rename({ slug: "ai", name: "智能系统" })

      await expect(readFile(index, "utf8")).resolves.toBe(expected)
    },
  )

  it.each(["|-", ">-"])(
    "preserves a %s indicator-line comment and CRLF outside the replaced block title",
    async (style) => {
      const root = await createGarden()
      const originalTitle = `${style}  # preserve indicator comment\r\n  人工\r\n  智能\r\n`
      const source = [
        "---",
        `title: ${style}  # preserve indicator comment`,
        "  人工",
        "  智能",
        'description: "人工智能领域。" # unrelated comment',
        'custom: "001"',
        "gardenDomain: true",
        "domainOrder: 1",
        "---",
        "",
        "正文保持不变。",
      ].join("\r\n")
      const expected = source.replace(originalTitle, "智能系统  # preserve indicator comment\r\n")
      const index = join(root, "content", "ai", "index.md")
      await writeFixture(root, "content/ai/index.md", source)
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })

      await catalog.rename({ slug: "ai", name: "智能系统" })

      await expect(readFile(index, "utf8")).resolves.toBe(expected)
    },
  )

  it.each(["|-", ">-"])(
    "replaces a last-field %s block title without changing the closing delimiter",
    async (style) => {
      const root = await createGarden()
      const newline = "\r\n"
      const source = [
        "---",
        'description: "人工智能领域。"',
        "gardenDomain: true",
        `title: ${style}  # preserve last-field comment`,
        "  人工",
        "  智能",
        "---",
        "",
        "正文保持不变。",
      ].join(newline)
      const expected = source.replace(
        `${style}  # preserve last-field comment${newline}  人工${newline}  智能`,
        "智能系统  # preserve last-field comment",
      )
      const index = join(root, "content", "ai", "index.md")
      await writeFixture(root, "content/ai/index.md", source)
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })

      await catalog.rename({ slug: "ai", name: "智能系统" })

      await expect(readFile(index, "utf8")).resolves.toBe(expected)
    },
  )

  it("keeps the landing page installed at every durable rename publication boundary", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    const domainDirectory = dirname(index)
    await writeFixture(root, "content/ai/index.md", source)
    let observedMissingTarget = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== domainDirectory || flags !== "r") return handle
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              try {
                await lstat(index)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  observedMissingTarget = true
                  throw new Error("simulated abrupt termination at missing-target window")
                }
                throw error
              }
              await handle.sync()
            },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
      { slug: "ai", name: "智能系统" },
    ])

    expect(observedMissingTarget).toBe(false)
    await expect(readFile(index, "utf8")).resolves.toContain("title: 智能系统")
    expect(
      (await readdir(domainDirectory)).filter(
        (entry) => entry.includes(".backup-") || entry.includes(".tmp-"),
      ),
    ).toEqual([])
  })

  it("keeps the landing page continuously present while atomic replacement is paused", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let release!: () => void
    let started!: () => void
    const replacementStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const continueReplacement = new Promise<void>((resolve) => {
      release = resolve
    })
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          started()
          await continueReplacement
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
        },
      },
    })

    const renameOperation = catalog.rename({ slug: "ai", name: "智能系统" })
    await replacementStarted
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(lstat(index)).resolves.toMatchObject({})
    }
    release()
    await expect(renameOperation).resolves.toMatchObject([{ slug: "ai", name: "智能系统" }])
  })

  it("waits for a timed-out replacement child to close before rollback", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let publicationChild: (EventEmitter & { readonly pid: number; kill: () => boolean }) | undefined
    let publicationClosed = false
    let taskkillOptions: Record<string, unknown> | undefined
    const fakeSpawn = ((_: string, args: readonly string[], options?: Record<string, unknown>) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        kill: vi.fn(() => true),
      }) as EventEmitter & { readonly pid: number; kill: () => boolean }
      if (args[0] === "/PID") {
        taskkillOptions = options
        queueMicrotask(() => child.emit("close", 0, null))
      } else {
        publicationChild = child
        child.once("close", () => {
          publicationClosed = true
        })
      }
      return child
    }) as unknown as typeof spawnProcess
    let settled = false
    let rejection: unknown
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        spawn: fakeSpawn,
        replaceFileTimeoutMs: 20,
      },
    })

    const renameOperation = catalog
      .rename({ slug: "ai", name: "智能系统" })
      .catch((error: unknown) => {
        settled = true
        rejection = error
      })
    for (let attempt = 0; attempt < 100 && publicationChild === undefined; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))

    expect(rejection).toBeUndefined()
    expect(publicationChild).toBeDefined()
    expect(taskkillOptions).toMatchObject({ shell: false, windowsHide: true })
    expect(settled).toBe(false)
    expect(publicationClosed).toBe(false)
    await expect(readdir(join(root, "content", "ai"))).resolves.toSatisfy((entries: string[]) =>
      entries.some((entry) => entry.includes(".tmp-")),
    )

    publicationChild!.emit("close", null, "SIGTERM")
    await renameOperation

    expect(publicationClosed).toBe(true)
    expect(rejection).toMatchObject({ message: expect.stringContaining("timed out") })
    await expect(readFile(index, "utf8")).resolves.toBe(source)
    await expect(readdir(join(root, "content", "ai"))).resolves.not.toContain(
      expect.stringContaining(".tmp-"),
    )
  })

  it("publishes a real Windows replacement through a path longer than MAX_PATH", async () => {
    if (process.platform !== "win32") return
    const base = await mkdtemp(join(tmpdir(), "garden-long-domains-"))
    temporaryDirectories.push(base)
    const root = join(base, "r".repeat(200))
    await Promise.all([
      mkdir(join(root, "content"), { recursive: true }),
      mkdir(join(root, "private"), { recursive: true }),
    ])
    const index = join(root, "content", "ai", "index.md")
    const source = domainPage("人工智能", "人工智能领域。", 1)
    await writeFixture(root, "content/ai/index.md", source)
    expect(index.length).toBeGreaterThan(260)
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
      { slug: "ai", name: "智能系统" },
    ])
    await expect(readFile(index, "utf8")).resolves.toContain("title: 智能系统")
    await expect(readdir(join(root, "content", "ai"))).resolves.not.toContain(
      expect.stringContaining(".backup-"),
    )
  })

  it("retries final directory durability after the committed rename backup is deleted", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    const domainDirectory = dirname(index)
    await writeFixture(root, "content/ai/index.md", source)
    let failedFinalSync = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== domainDirectory || flags !== "r") return handle
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              const entries = await readdir(domainDirectory)
              if (
                !failedFinalSync &&
                entries.includes("index.md") &&
                !entries.some((entry) => entry.includes(".backup-")) &&
                !entries.some((entry) => entry.includes(".tmp-"))
              ) {
                failedFinalSync = true
                throw new Error("simulated final committed directory sync failure")
              }
              await handle.sync()
            },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
      { slug: "ai", name: "智能系统" },
    ])

    expect(failedFinalSync).toBe(true)
    await expect(readFile(index, "utf8")).resolves.toContain("title: 智能系统")
    await expect(catalog.assertIdle()).resolves.toBeUndefined()
  })

  it("cleans its exclusive temporary file when the staged write cannot be synced", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      uuid: () => "00000000-0000-4000-8000-000000000001",
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (!path.includes(".tmp-") || flags !== "wx") return handle
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              throw new Error("simulated temp sync failure")
            },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toThrow(
      "simulated temp sync failure",
    )

    await expect(readFile(index, "utf8")).resolves.toBe(source)
    expect((await readdir(dirname(index))).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  it("restores the original page when parent-directory durability fails after replacement", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    const domainDirectory = dirname(index)
    await writeFixture(root, "content/ai/index.md", source)
    let domainSyncs = 0
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== domainDirectory || flags !== "r") return handle
          domainSyncs += 1
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              if (domainSyncs === 1) throw new Error("simulated directory sync failure")
              await handle.sync()
            },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toThrow(
      "simulated directory sync failure",
    )

    await expect(readFile(index, "utf8")).resolves.toBe(source)
    expect((await readdir(domainDirectory)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  it("preserves a concurrent in-place edit instead of overwriting it during rollback", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const concurrent = `${domainPage("并发编辑", "用户并发修改。", 1)}\n用户的新正文`
    const index = join(root, "content", "ai", "index.md")
    const domainDirectory = dirname(index)
    await writeFixture(root, "content/ai/index.md", source)
    let domainSyncs = 0
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== domainDirectory || flags !== "r") return handle
          domainSyncs += 1
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              if (domainSyncs === 1) {
                await writeFile(index, concurrent)
                throw new Error("simulated directory sync failure after concurrent edit")
              }
              await handle.sync()
            },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    await expect(readFile(index, "utf8")).resolves.toBe(concurrent)
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("preserves a concurrent target created at the rollback publication seam", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const concurrent = `${domainPage("回滚并发替换", "用户在回滚时创建。", 1)}\n不能覆盖`
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let failPublication = true
    let rollbackLinkAttempted = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          if (failPublication) {
            failPublication = false
            await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
            throw new Error("simulated publication failure after atomic replacement")
          }
        },
        link: async (sourcePath, destination) => {
          if (destination === index && String(sourcePath).includes(".backup-")) {
            rollbackLinkAttempted = true
            await writeFile(index, concurrent)
          }
          await linkFile(sourcePath, destination)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(rollbackLinkAttempted).toBe(true)
    await expect(readFile(index, "utf8")).resolves.toBe(concurrent)
  })

  it("recovers a journal whose fsynced staged copy never reached journal.json", async () => {
    const root = await createGarden()
    const seeded = await seedDomainRenameJournal(root, "prepared")
    const stagedJournal = join(
      seeded.transaction,
      "journal.json.tmp-00000000-0000-4000-8000-000000000022",
    )
    await rename(join(seeded.transaction, "journal.json"), stagedJournal)
    await expect(lstat(stagedJournal)).resolves.toMatchObject({})

    const recovered = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })
    await expect(recovered.list()).resolves.toMatchObject([{ slug: "ai", name: "人工智能" }])
  })

  it.each(["EIO", "EACCES"] as const)(
    "cleans up a partial initial journal write for %s",
    async (code) => {
      const root = await createGarden()
      const source = domainPage("人工智能", "人工智能领域。", 1)
      const index = join(root, "content", "ai", "index.md")
      await writeFixture(root, "content/ai/index.md", source)
      let failInitialJournalWrite = true
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
        fileSystem: {
          open: async (path, flags, mode) => {
            const handle = await openFile(path, flags, mode)
            if (failInitialJournalWrite && flags === "wx" && path.includes("journal.json.tmp-")) {
              failInitialJournalWrite = false
              return {
                writeFile: async () => {
                  await handle.writeFile("{")
                  throw Object.assign(new Error(`simulated ${code}`), { code })
                },
                sync: () => handle.sync(),
                stat: (options) => handle.stat(options),
                close: () => handle.close(),
              }
            }
            return handle
          },
        },
      })

      await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toThrow(
        `simulated ${code}`,
      )
      await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
        { slug: "ai", name: "智能系统" },
      ])
      const reopened = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })
      await expect(reopened.list()).resolves.toMatchObject([{ slug: "ai", name: "智能系统" }])
    },
  )

  it("fails closed when the staged journal pathname is replaced before publication", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let movedPath: string | undefined
    let foreignPath: string | undefined
    let replaced = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (!replaced && flags === "wx" && path.includes("journal.json.tmp-")) {
            replaced = true
            movedPath = `${path}.moved`
            foreignPath = path
            return {
              writeFile: async (data) => {
                await handle.writeFile(data)
                await rename(path, movedPath!)
                await writeFile(path, "foreign staged journal")
              },
              sync: () => handle.sync(),
              stat: (options) => handle.stat(options),
              close: () => handle.close(),
            }
          }
          return handle
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    const reopened = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })
    await expect(reopened.list()).rejects.toMatchObject({ code: "DOMAIN_ROLLBACK_UNCERTAIN" })
    await expect(readFile(movedPath!, "utf8")).resolves.toContain('"phase":"prepared"')
    await expect(readFile(foreignPath!, "utf8")).resolves.toBe("foreign staged journal")
  })

  it("retires a prepared journal after rollback before a later rename and reopen", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let failBackup = true
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          if (failBackup) {
            failBackup = false
            throw new Error("simulated one-shot backup failure")
          }
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toThrow(
      "simulated one-shot backup failure",
    )
    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
      { slug: "ai", name: "智能系统" },
    ])

    const reopened = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })
    await expect(reopened.list()).resolves.toMatchObject([{ slug: "ai", name: "智能系统" }])
  })

  it("preserves a replacement staged journal instead of deleting foreign bytes", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const transactionId = "00000000-0000-4000-8000-000000000031"
    const stagedId = "00000000-0000-4000-8000-000000000032"
    const transaction = join(root, ".garden-publisher", "domain-rename-transactions", transactionId)
    const stagedJournal = join(transaction, `journal.json.tmp-${stagedId}`)
    const foreign = Buffer.from("foreign staged journal bytes\n")
    await writeFixture(root, "content/ai/index.md", source)
    const ids = [transactionId, stagedId]
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      uuid: () => ids.shift() ?? stagedId,
      fileSystem: {
        rename: async (sourcePath, destination) => {
          if (sourcePath === stagedJournal && destination === join(transaction, "journal.json")) {
            await writeFile(sourcePath, foreign)
            throw new Error("simulated staged journal replacement")
          }
          await rename(sourcePath, destination)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(readFile(stagedJournal)).resolves.toEqual(foreign)
  })

  it.each([
    ["prepared", "quarantined"],
    ["prepared", "published"],
    ["quarantined", "published"],
  ] as const)(
    "recovers a monotonic %s to %s journal transition after restart",
    async (finalPhase, stagedPhase) => {
      const root = await createGarden()
      const seeded = await seedDomainRenamePhaseTransition(root, finalPhase, stagedPhase)
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
      })

      await expect(catalog.list()).resolves.toMatchObject([
        { slug: "ai", name: stagedPhase === "published" ? "智能系统" : "人工智能" },
      ])
      await expect(readFile(seeded.index, "utf8")).resolves.toBe(
        stagedPhase === "published" ? seeded.published : seeded.original,
      )
    },
  )

  it("fails closed when a prepared-to-published staged journal changes immutable evidence", async () => {
    const root = await createGarden()
    const seeded = await seedDomainRenamePhaseTransition(root, "prepared", "published")
    const stagedPath = join(
      seeded.transaction,
      "journal.json.tmp-00000000-0000-4000-8000-000000000049",
    )
    const staged = await readFile(stagedPath, "utf8")
    await writeFile(
      stagedPath,
      staged.replace('"intendedTitle":"智能系统"', '"intendedTitle":"其他标题"'),
    )
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.list()).rejects.toMatchObject({ code: "DOMAIN_ROLLBACK_UNCERTAIN" })
    await expect(readFile(stagedPath, "utf8")).resolves.toContain('"intendedTitle":"其他标题"')
  })

  it("retires a staged journal after its initial publication reports EIO", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let failInitialPublication = true
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        rename: async (sourcePath, destination) => {
          if (
            failInitialPublication &&
            String(sourcePath).includes("journal.json.tmp-") &&
            String(destination).endsWith("journal.json")
          ) {
            failInitialPublication = false
            throw Object.assign(new Error("simulated journal EIO"), { code: "EIO" })
          }
          await rename(sourcePath, destination)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toThrow(
      "simulated journal EIO",
    )
    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
      { slug: "ai", name: "智能系统" },
    ])
    const reopened = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })
    await expect(reopened.list()).resolves.toMatchObject([{ slug: "ai", name: "智能系统" }])
  })

  it("confirms ordinary rollback after a one-shot exclusive publication failure", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let failPublication = true
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          if (failPublication) {
            failPublication = false
            throw new Error("simulated publication link failure")
          }
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toThrow(
      "simulated publication link failure",
    )
    await expect(catalog.assertIdle()).resolves.toBeUndefined()
    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).resolves.toMatchObject([
      { slug: "ai", name: "智能系统" },
    ])
  })

  it("fails closed when exclusive publication is edited before its first verification", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const concurrent = `${domainPage("即时并发编辑", "用户即时修改。", 1)}\n不能覆盖的新正文`
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let changed = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
          if (!changed) {
            changed = true
            await writeFile(replaced, concurrent)
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(changed).toBe(true)
    await expect(readFile(index, "utf8")).resolves.toBe(concurrent)
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(catalog.dispose()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("fails closed when exclusive publication is edited and then reports failure", async () => {
    const root = await createGarden()
    const source = domainPage("人工智能", "人工智能领域。", 1)
    const concurrent = `${domainPage("提交后的编辑", "用户在提交后修改。", 1)}\n必须保留的正文`
    const index = join(root, "content", "ai", "index.md")
    await writeFixture(root, "content/ai/index.md", source)
    let failedAfterPublication = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      fileSystem: {
        replaceFile: async (replacement, replaced, backup) => {
          await fakeAtomicReplaceWithBackup(replacement, replaced, backup)
          if (!failedAfterPublication) {
            failedAfterPublication = true
            await writeFile(replaced, concurrent)
            throw new Error("simulated hard-link publication failure after commit")
          }
        },
      },
    })

    await expect(catalog.rename({ slug: "ai", name: "智能系统" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(failedAfterPublication).toBe(true)
    await expect(readFile(index, "utf8")).resolves.toBe(concurrent)
    await expect(catalog.list()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(catalog.dispose()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })
})

describe("DomainCatalog.remove", () => {
  async function createEmptyDomain(root: string): Promise<void> {
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1)),
      mkdir(join(root, "private", "ai")),
    ])
  }

  it.each([
    ["a direct public note", "content/ai/note.md"],
    ["a direct private note", "private/ai/note.md"],
    ["an attachment", "content/ai/assets/chart.png"],
    ["an unexpected public file", "content/ai/readme.txt"],
    ["an extra private directory", "private/ai/archive/keep.txt"],
  ])("blocks removal when the domain contains %s", async (_label, extraPath) => {
    const root = await createGarden()
    await createEmptyDomain(root)
    await writeFixture(root, extraPath, "keep")
    const trashItem = vi.fn(async () => undefined)
    const catalog = createDomainCatalog({ workspace: root, trash: { trashItem } })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_NOT_EMPTY",
    })

    expect(trashItem).not.toHaveBeenCalled()
    await expect(readFile(join(root, extraPath), "utf8")).resolves.toBe("keep")
  })

  it("rejects linked entries inside a removable domain as unsafe", async () => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-domain-remove-link-"))
    temporaryDirectories.push(outside)
    await createEmptyDomain(root)
    await symlink(outside, join(root, "content", "ai", "linked"), "junction")
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_UNSAFE_PATH",
    })
  })

  it("fails closed when a file appears after inspection and before staging", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const trashItem = vi.fn(async () => undefined)
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem },
      hooks: {
        afterRemoveInspection: async () => {
          await writeFile(join(root, "private", "ai", "late.md"), "late")
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_NOT_EMPTY",
    })

    expect(trashItem).not.toHaveBeenCalled()
    await expect(readFile(join(root, "private", "ai", "late.md"), "utf8")).resolves.toBe("late")
    await expect(readFile(join(root, "content", "ai", "index.md"), "utf8")).resolves.toContain(
      "title: 人工智能",
    )
  })

  it("restores the domain when a file appears at the staging rename boundary", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const publicDirectory = join(root, "content", "ai")
    const lateFile = join(publicDirectory, "late.md")
    const trashItem = vi.fn(async () => undefined)
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem },
      fileSystem: {
        rename: async (source, destination) => {
          if (source === publicDirectory) await writeFile(lateFile, "late")
          await rename(source, destination)
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_NOT_EMPTY",
    })

    expect(trashItem).not.toHaveBeenCalled()
    await expect(readFile(lateFile, "utf8")).resolves.toBe("late")
    await expect(readdir(join(root, "private", "ai"))).resolves.toEqual([])
  })

  it("stages both empty domain directories under one transaction and trashes it once", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const trashed: string[] = []
    const trashItem = vi.fn(async (target: string) => {
      trashed.push(target)
      await rm(target, { recursive: true })
    })
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem },
      uuid: () => "00000000-0000-4000-8000-000000000002",
    })

    await expect(catalog.remove({ slug: "ai" })).resolves.toEqual([])

    expect(trashItem).toHaveBeenCalledTimes(1)
    expect(trashed[0]).toBe(
      join(
        root,
        ".garden-publisher",
        "domain-transactions",
        "00000000-0000-4000-8000-000000000002",
      ),
    )
    await expect(lstat(join(root, "content", "ai"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(root, "private", "ai"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fails closed when managed roots change while the transaction is being trashed", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    await writeFixture(root, "content/sibling/keep.md", "sibling evidence")
    const contentRoot = join(root, "content")
    const displacedContent = join(root, "owned-content-root")
    const replacementEvidence = join(contentRoot, "replacement.txt")
    let trashed = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: {
        trashItem: async (target) => {
          await rename(contentRoot, displacedContent)
          await mkdir(contentRoot)
          await writeFile(replacementEvidence, "replacement root")
          await rm(target, { recursive: true })
          trashed = true
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(trashed).toBe(true)
    await expect(readFile(replacementEvidence, "utf8")).resolves.toBe("replacement root")
    await expect(readFile(join(displacedContent, "sibling", "keep.md"), "utf8")).resolves.toBe(
      "sibling evidence",
    )
    await expect(catalog.list()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("does not trash a substituted transaction directory containing a foreign entry", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const transactionId = "00000000-0000-4000-8000-000000000006"
    const transaction = join(root, ".garden-publisher", "domain-transactions", transactionId)
    const displaced = `${transaction}-owned`
    const manifest = join(transaction, "manifest.json")
    const foreign = join(transaction, "foreign.txt")
    const trashItem = vi.fn(async () => undefined)
    let substituted = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem },
      uuid: () => transactionId,
      fileSystem: {
        open: async (path, flags, mode) => {
          if (!substituted && path === manifest && flags === "wx") {
            substituted = true
            await rename(transaction, displaced)
            await mkdir(transaction)
            await rename(join(displaced, "content"), join(transaction, "content"))
            await rename(join(displaced, "private"), join(transaction, "private"))
            await writeFile(foreign, "foreign evidence")
          }
          return openFile(path, flags, mode)
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(substituted).toBe(true)
    expect(trashItem).not.toHaveBeenCalled()
    await expect(readFile(foreign, "utf8")).resolves.toBe("foreign evidence")
    await expect(readFile(manifest, "utf8")).resolves.toContain(`"id":"${transactionId}"`)
    await expect(lstat(join(transaction, "content"))).resolves.toMatchObject({})
    await expect(lstat(join(transaction, "private"))).resolves.toMatchObject({})
  })

  it.each(["first", "second"])(
    "restores originals when the %s staging rename fails",
    async (failedRename) => {
      const root = await createGarden()
      await createEmptyDomain(root)
      const publicDirectory = join(root, "content", "ai")
      const privateDirectory = join(root, "private", "ai")
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
        fileSystem: {
          rename: async (source, destination) => {
            if (
              (failedRename === "first" && source === publicDirectory) ||
              (failedRename === "second" && source === privateDirectory)
            ) {
              throw new Error(`simulated ${failedRename} staging failure`)
            }
            await rename(source, destination)
          },
        },
      })

      await expect(catalog.remove({ slug: "ai" })).rejects.toThrow(
        `simulated ${failedRename} staging failure`,
      )

      await expect(readFile(join(publicDirectory, "index.md"), "utf8")).resolves.toContain(
        "title: 人工智能",
      )
      await expect(readdir(privateDirectory)).resolves.toEqual([])
    },
  )

  it("does not restore into a substituted content root after staging", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    await writeFixture(root, "content/sibling/keep.md", "sibling evidence")
    const transactionId = "00000000-0000-4000-8000-000000000008"
    const transaction = join(root, ".garden-publisher", "domain-transactions", transactionId)
    const publicDirectory = join(root, "content", "ai")
    const privateDirectory = join(root, "private", "ai")
    const contentRoot = join(root, "content")
    const displacedContent = join(root, "owned-content-root")
    const replacementEvidence = join(contentRoot, "replacement.txt")
    let rootSubstituted = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem: async () => undefined },
      uuid: () => transactionId,
      fileSystem: {
        rename: async (source, destination) => {
          if (source === privateDirectory) {
            rootSubstituted = true
            await rename(contentRoot, displacedContent)
            await mkdir(contentRoot)
            await writeFile(replacementEvidence, "replacement root")
            throw new Error("simulated private staging failure after root substitution")
          }
          await rename(source, destination)
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(rootSubstituted).toBe(true)
    await expect(readFile(replacementEvidence, "utf8")).resolves.toBe("replacement root")
    await expect(lstat(publicDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(displacedContent, "sibling", "keep.md"), "utf8")).resolves.toBe(
      "sibling evidence",
    )
    await expect(readFile(join(transaction, "content", "index.md"), "utf8")).resolves.toContain(
      "title: 人工智能",
    )
    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it.each(["write", "sync"])(
    "restores both originals when the durable manifest %s fails",
    async (failure) => {
      const root = await createGarden()
      await createEmptyDomain(root)
      const catalog = createDomainCatalog({
        workspace: root,
        trash: { trashItem: async () => undefined },
        fileSystem: {
          open: async (path, flags, mode) => {
            if (!path.endsWith("manifest.json") || flags !== "wx") {
              return openFile(path, flags, mode)
            }
            if (failure === "write") throw new Error("simulated manifest write failure")
            const handle = await openFile(path, flags, mode)
            return {
              writeFile: handle.writeFile.bind(handle),
              sync: async () => {
                throw new Error("simulated manifest sync failure")
              },
              stat: handle.stat.bind(handle),
              close: handle.close.bind(handle),
            }
          },
        },
      })

      await expect(catalog.remove({ slug: "ai" })).rejects.toThrow(
        `simulated manifest ${failure} failure`,
      )

      await expect(readFile(join(root, "content", "ai", "index.md"), "utf8")).resolves.toContain(
        "title: 人工智能",
      )
      await expect(readdir(join(root, "private", "ai"))).resolves.toEqual([])
    },
  )

  it("restores both original paths from the manifest when trashing fails", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const trashItem = vi.fn(async () => {
      throw new Error("Recycle Bin unavailable")
    })
    const catalog = createDomainCatalog({ workspace: root, trash: { trashItem } })

    await expect(catalog.remove({ slug: "ai" })).rejects.toThrow("Recycle Bin unavailable")

    expect(trashItem).toHaveBeenCalledTimes(1)
    await expect(readFile(join(root, "content", "ai", "index.md"), "utf8")).resolves.toContain(
      "title: 人工智能",
    )
    await expect(readdir(join(root, "private", "ai"))).resolves.toEqual([])
  })

  it("retains transaction evidence when restored parents cannot be durably synced", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const transactionId = "00000000-0000-4000-8000-000000000007"
    const transaction = join(root, ".garden-publisher", "domain-transactions", transactionId)
    const manifest = join(transaction, "manifest.json")
    const contentRoot = join(root, "content")
    let contentSyncs = 0
    const trashItem = vi.fn(async () => {
      throw new Error("Recycle Bin unavailable")
    })
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem },
      uuid: () => transactionId,
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== contentRoot || flags !== "r") return handle
          contentSyncs += 1
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => {
              if (contentSyncs === 2) throw new Error("simulated restore parent sync failure")
            },
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    expect(trashItem).toHaveBeenCalledTimes(1)
    await expect(readFile(join(root, "content", "ai", "index.md"), "utf8")).resolves.toContain(
      "title: 人工智能",
    )
    await expect(readdir(join(root, "private", "ai"))).resolves.toEqual([])
    await expect(readFile(manifest, "utf8")).resolves.toContain(`"id":"${transactionId}"`)
    await expect(readdir(transaction)).resolves.toEqual(["manifest.json"])
  })

  it("restores trusted staged directories when their contents drift before trash", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const transactionId = "00000000-0000-4000-8000-000000000009"
    const transaction = join(root, ".garden-publisher", "domain-transactions", transactionId)
    const manifest = join(transaction, "manifest.json")
    const stagedLate = join(transaction, "content", "late.md")
    const trashItem = vi.fn(async () => undefined)
    let addedLateFile = false
    const catalog = createDomainCatalog({
      workspace: root,
      trash: { trashItem },
      uuid: () => transactionId,
      fileSystem: {
        open: async (path, flags, mode) => {
          const handle = await openFile(path, flags, mode)
          if (path !== manifest || flags !== "wx") return handle
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: handle.sync.bind(handle),
            stat: handle.stat.bind(handle),
            close: async () => {
              await handle.close()
              addedLateFile = true
              await writeFile(stagedLate, "late staged content")
            },
          }
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_NOT_EMPTY",
    })

    expect(addedLateFile).toBe(true)
    expect(trashItem).not.toHaveBeenCalled()
    await expect(readFile(join(root, "content", "ai", "late.md"), "utf8")).resolves.toBe(
      "late staged content",
    )
    await expect(readFile(join(root, "content", "ai", "index.md"), "utf8")).resolves.toContain(
      "title: 人工智能",
    )
    await expect(readdir(join(root, "private", "ai"))).resolves.toEqual([])
    await expect(catalog.assertIdle()).resolves.toBeUndefined()
  })

  it("never overwrites a path that appears while restoring after trash failure", async () => {
    const root = await createGarden()
    await createEmptyDomain(root)
    const publicDirectory = join(root, "content", "ai")
    const catalog = createDomainCatalog({
      workspace: root,
      trash: {
        trashItem: async () => {
          await mkdir(publicDirectory)
          await writeFile(join(publicDirectory, "concurrent.txt"), "new owner")
          throw new Error("Recycle Bin unavailable")
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    await expect(readFile(join(publicDirectory, "concurrent.txt"), "utf8")).resolves.toBe(
      "new owner",
    )
    const transactions = await readdir(join(root, ".garden-publisher", "domain-transactions"))
    expect(transactions).toHaveLength(1)
  })
})

describe("DomainCatalog lifecycle", () => {
  it("stays busy through pending trash and makes every dispose caller wait for completion", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1)),
      mkdir(join(root, "private", "ai")),
    ])
    let trashStarted!: (target: string) => void
    const trashDidStart = new Promise<string>((resolve) => {
      trashStarted = resolve
    })
    let finishTrash!: () => void
    const trashMayFinish = new Promise<void>((resolve) => {
      finishTrash = resolve
    })
    const catalog = createDomainCatalog({
      workspace: root,
      trash: {
        trashItem: async (target) => {
          trashStarted(target)
          await trashMayFinish
          await rm(target, { recursive: true })
        },
      },
    })

    const removal = catalog.remove({ slug: "ai" })
    await trashDidStart
    await expect(catalog.assertIdle()).rejects.toMatchObject({ code: "DOMAIN_BUSY" })
    const list = catalog.list()
    const firstDispose = catalog.dispose()
    const secondDispose = catalog.dispose()
    let firstDisposed = false
    let secondDisposed = false
    void firstDispose.then(() => {
      firstDisposed = true
    })
    void secondDispose.then(() => {
      secondDisposed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(firstDisposed).toBe(false)
    expect(secondDisposed).toBe(false)
    await expect(catalog.create({ name: "阅读", slug: "reading" })).rejects.toMatchObject({
      code: "DOMAIN_DISPOSED",
    })
    finishTrash()

    await expect(removal).resolves.toEqual([])
    await expect(list).resolves.toEqual([])
    await expect(Promise.all([firstDispose, secondDispose])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it("waits for accepted observations before disposal resolves", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1)),
      mkdir(join(root, "private", "ai")),
    ])
    let trashStarted!: () => void
    const trashDidStart = new Promise<void>((resolve) => {
      trashStarted = resolve
    })
    let finishTrash!: () => void
    const trashMayFinish = new Promise<void>((resolve) => {
      finishTrash = resolve
    })
    const catalog = createDomainCatalog({
      workspace: root,
      trash: {
        trashItem: async (target) => {
          trashStarted()
          await trashMayFinish
          await rm(target, { recursive: true })
        },
      },
    })

    const removal = catalog.remove({ slug: "ai" })
    await trashDidStart
    let observationSettled = false
    const observation = catalog.list().finally(() => {
      observationSettled = true
    })
    const disposal = catalog.dispose()
    await expect(catalog.list()).rejects.toMatchObject({ code: "DOMAIN_DISPOSED" })
    finishTrash()

    await disposal
    expect(observationSettled).toBe(true)
    await expect(removal).resolves.toEqual([])
    await expect(observation).resolves.toEqual([])
  })

  it("fails closed after an uncertain removal rollback", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1)),
      mkdir(join(root, "private", "ai")),
    ])
    const catalog = createDomainCatalog({
      workspace: root,
      trash: {
        trashItem: async () => {
          await mkdir(join(root, "content", "ai"))
          throw new Error("Recycle Bin unavailable")
        },
      },
    })

    await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })

    await expect(catalog.assertIdle()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(catalog.list()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
    await expect(catalog.dispose()).rejects.toMatchObject({
      code: "DOMAIN_ROLLBACK_UNCERTAIN",
    })
  })

  it("does not start a queued mutation after the preceding operation becomes uncertain", async () => {
    const root = await createGarden()
    await Promise.all([
      writeFixture(root, "content/ai/index.md", domainPage("人工智能", "人工智能领域。", 1)),
      mkdir(join(root, "private", "ai")),
    ])
    let trashStarted!: () => void
    const trashDidStart = new Promise<void>((resolve) => {
      trashStarted = resolve
    })
    let failTrash!: () => void
    const trashMayFail = new Promise<void>((resolve) => {
      failTrash = resolve
    })
    const catalog = createDomainCatalog({
      workspace: root,
      trash: {
        trashItem: async () => {
          trashStarted()
          await trashMayFail
          await mkdir(join(root, "content", "ai"))
          throw new Error("Recycle Bin unavailable")
        },
      },
    })

    const removal = catalog.remove({ slug: "ai" })
    await trashDidStart
    const queuedCreate = catalog.create({ name: "阅读", slug: "reading" })
    failTrash()

    await expect(removal).rejects.toMatchObject({ code: "DOMAIN_ROLLBACK_UNCERTAIN" })
    await expect(queuedCreate).rejects.toMatchObject({ code: "DOMAIN_ROLLBACK_UNCERTAIN" })
    await expect(lstat(join(root, "content", "reading"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
