import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createAppearanceAdapter,
  detectBlogFramework,
  type AppearancePlan,
} from "../../src/main/services/appearance/appearanceAdapter"
import {
  QUARTZ_APPEARANCE_PATHS,
  QuartzAppearanceAdapter,
} from "../../src/main/services/appearance/quartzAppearanceAdapter"
import {
  cloneAppearancePreset,
  DEFAULT_APPEARANCE,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from "../../src/shared/appearance"

const temporaryDirectories: string[] = []
const encoder = new TextEncoder()

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "quartz-appearance-"))
  temporaryDirectories.push(path)
  return path
}

const quartzConfiguration = `configuration:
  pageTitle: Test Garden
  keepMe: unchanged
  theme:
    fontOrigin: local
    typography:
      header: Existing Header
      body: Existing Body
      code: Existing Code
    colors:
      lightMode:
        light: "#101010"
        lightgray: "#202020"
        gray: "#303030"
        darkgray: "#d0d0d0"
        dark: "#f0f0f0"
        secondary: "#22d3ee"
        tertiary: "#94a3b8"
        highlight: "rgba(0, 0, 0, 0.1)"
        textHighlight: "rgba(0, 0, 0, 0.2)"
      darkMode:
        light: "#101010"
        lightgray: "#202020"
        gray: "#303030"
        darkgray: "#d0d0d0"
        dark: "#f0f0f0"
        secondary: "#22d3ee"
        tertiary: "#94a3b8"
        highlight: "rgba(34, 211, 238, 0.1)"
        textHighlight: "rgba(148, 163, 184, 0.2)"
plugins:
  - source: test-plugin
    enabled: true
`

async function writeWorkspaceFile(root: string, path: string, bytes: string | Uint8Array) {
  const absolute = join(root, ...path.split("/"))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
}

async function createQuartzWorkspace(
  root: string,
  options: { readonly custom?: string | Uint8Array; readonly config?: string } = {},
): Promise<void> {
  await writeWorkspaceFile(
    root,
    "package.json",
    JSON.stringify({
      name: "@jackyzha0/quartz",
      scripts: { quartz: "./quartz/bootstrap-cli.mjs" },
    }),
  )
  await writeWorkspaceFile(root, "quartz/bootstrap-cli.mjs", "")
  await writeWorkspaceFile(
    root,
    QUARTZ_APPEARANCE_PATHS.config,
    options.config ?? quartzConfiguration,
  )
  await writeWorkspaceFile(
    root,
    QUARTZ_APPEARANCE_PATHS.customStylesheet,
    options.custom ?? '@use "./variables.scss" as *;\n\nbody { color: red; }\n',
  )
}

function customizedSettings(): AppearanceSettings {
  const settings = cloneAppearancePreset("paper")
  return normalizeAppearanceSettings({
    ...settings,
    preset: "custom",
    colors: { ...settings.colors, accent: "#123456", page: "#112233" },
    typography: { ...settings.typography, header: "Garden Header", body: "Garden Body" },
    customCss: ".garden { letter-spacing: 0.02em; }",
  })
}

function manifest(settings: AppearanceSettings, assets: readonly string[] = []): string {
  return `${JSON.stringify({ schemaVersion: 2, settings, assets }, null, 2)}\n`
}

function legacyManifest(
  settings: AppearanceSettings,
  assets: readonly string[] = [],
  extensions: Readonly<Record<string, unknown>> = {},
): string {
  const {
    componentColors: _componentColors,
    schemaVersion: _schemaVersion,
    ...legacySettings
  } = settings
  return `${JSON.stringify(
    {
      ...extensions,
      schemaVersion: 1,
      settings: { ...legacySettings, schemaVersion: 1 },
      assets,
    },
    null,
    2,
  )}\n`
}

async function applyPlan(root: string, plan: AppearancePlan): Promise<void> {
  for (const deletion of plan.deletes) await rm(join(root, ...deletion.path.split("/")))
  for (const write of plan.writes) await writeWorkspaceFile(root, write.path, write.bytes)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

describe("detectBlogFramework", () => {
  it("detects a Quartz root from its package command, bootstrap, config, and styles", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    await expect(detectBlogFramework(root)).resolves.toBe("quartz")
    await expect(createAppearanceAdapter(root)).resolves.toBeInstanceOf(QuartzAppearanceAdapter)
  })

  it("does not classify a directory from a Quartz-like package name alone", async () => {
    const root = await temporaryDirectory()
    await writeWorkspaceFile(root, "package.json", JSON.stringify({ name: "quartz-blog" }))
    await expect(detectBlogFramework(root)).resolves.toBe("unknown")
  })

  it("does not detect a framework through a junctioned marker parent", async ({ skip }) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const outside = await temporaryDirectory()
    await writeWorkspaceFile(outside, "custom.scss", '@use "./variables.scss";\n')
    await rm(join(root, "quartz", "styles"), { recursive: true })
    try {
      await symlink(
        outside,
        join(root, "quartz", "styles"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    await expect(detectBlogFramework(root)).resolves.toBe("unknown")
  })

  it("does not classify a generic content directory and config.toml as Hugo", async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, "content"))
    await writeWorkspaceFile(root, "config.toml", 'theme = "application"\n')
    await expect(detectBlogFramework(root)).resolves.toBe("unknown")
  })

  it("detects Hugo and Hexo distinctly", async () => {
    const hugo = await temporaryDirectory()
    await writeWorkspaceFile(hugo, "hugo.toml", 'baseURL = "https://example.test"\n')
    await mkdir(join(hugo, "content"))

    const hexo = await temporaryDirectory()
    await writeWorkspaceFile(hexo, "_config.yml", "title: Hexo blog\n")
    await writeWorkspaceFile(hexo, "package.json", JSON.stringify({ dependencies: { hexo: "^7" } }))
    await mkdir(join(hexo, "source"))

    await expect(detectBlogFramework(hugo)).resolves.toBe("hugo")
    await expect(detectBlogFramework(hexo)).resolves.toBe("hexo")
  })

  it("uses deterministic Quartz, Hugo, Hexo precedence and never writes while detecting", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    await writeWorkspaceFile(root, "hugo.toml", "")
    await mkdir(join(root, "content"))
    await writeWorkspaceFile(root, "_config.yml", "")
    await mkdir(join(root, "source"))
    const before = (await readFile(join(root, "package.json"))).toString("hex")

    await expect(detectBlogFramework(root)).resolves.toBe("quartz")
    expect((await readFile(join(root, "package.json"))).toString("hex")).toBe(before)
    await expect(lstat(join(root, QUARTZ_APPEARANCE_PATHS.manifest))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("returns unknown and an unsupported read-only adapter for unrecognized roots", async () => {
    const root = await temporaryDirectory()
    await expect(detectBlogFramework(root)).resolves.toBe("unknown")
    const adapter = await createAppearanceAdapter(root)
    await expect(adapter.read()).resolves.toMatchObject({
      framework: "unknown",
      supported: false,
      settings: DEFAULT_APPEARANCE,
      message: expect.stringMatching(/not recognized|unsupported/i),
    })
    await expect(adapter.plan(DEFAULT_APPEARANCE, "0".repeat(64))).rejects.toMatchObject({
      code: "APPEARANCE_UNSUPPORTED",
    })
  })

  it.each(["hugo", "hexo"] as const)("returns an unsupported snapshot for %s", async (kind) => {
    const root = await temporaryDirectory()
    if (kind === "hugo") {
      await writeWorkspaceFile(root, "hugo.yaml", "baseURL: https://example.test\n")
      await mkdir(join(root, "content"))
    } else {
      await writeWorkspaceFile(root, "_config.yml", "title: Test\n")
      await writeWorkspaceFile(
        root,
        "package.json",
        JSON.stringify({ devDependencies: { hexo: "7" } }),
      )
      await mkdir(join(root, "source"))
    }
    const adapter = await createAppearanceAdapter(root)
    await expect(adapter.read()).resolves.toMatchObject({
      framework: kind,
      supported: false,
      message: expect.stringContaining(kind === "hugo" ? "Hugo" : "Hexo"),
    })
  })
})

describe("QuartzAppearanceAdapter", () => {
  it("derives supported managed dark-theme colors and fonts when the manifest is missing", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)

    const snapshot = await new QuartzAppearanceAdapter(root).read()

    expect(snapshot).toMatchObject({ framework: "quartz", supported: true, canUndo: false })
    expect(snapshot.baselineHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.settings).toMatchObject({
      colors: {
        page: "#101010",
        surface: "#202020",
        border: "#303030",
        text: "#d0d0d0",
        heading: "#f0f0f0",
        accent: "#22d3ee",
        secondary: "#94a3b8",
      },
      typography: { header: "Existing Header", body: "Existing Body", code: "Existing Code" },
      layout: DEFAULT_APPEARANCE.layout,
      background: DEFAULT_APPEARANCE.background,
    })
  })

  it("round-trips normalized settings through a valid deterministic manifest", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()
    const settings = customizedSettings()

    const first = await adapter.plan(settings, before.baselineHash)
    expect(first.settings).toEqual(settings)
    expect(first.writes.map((write) => write.path)).toEqual([
      QUARTZ_APPEARANCE_PATHS.config,
      QUARTZ_APPEARANCE_PATHS.customStylesheet,
      QUARTZ_APPEARANCE_PATHS.manifest,
      QUARTZ_APPEARANCE_PATHS.stylesheet,
    ])
    await applyPlan(root, first)

    const after = await adapter.read()
    expect(after.settings).toEqual(settings)
    expect(await readFile(join(root, QUARTZ_APPEARANCE_PATHS.manifest), "utf8")).toBe(
      manifest(settings),
    )
  })

  it("migrates a v1 manifest on first apply without rewriting it on read", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const legacy = legacyManifest(customizedSettings())
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, legacy)
    const adapter = new QuartzAppearanceAdapter(root)

    const snapshot = await adapter.read()

    expect(snapshot.settings).toEqual({
      ...customizedSettings(),
      schemaVersion: 2,
      componentColors: {},
    })
    await expect(readFile(join(root, QUARTZ_APPEARANCE_PATHS.manifest), "utf8")).resolves.toBe(
      legacy,
    )

    const plan = await adapter.plan(snapshot.settings, snapshot.baselineHash)
    await applyPlan(root, plan)
    const persisted = JSON.parse(
      await readFile(join(root, QUARTZ_APPEARANCE_PATHS.manifest), "utf8"),
    ) as Record<string, unknown>
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      settings: { schemaVersion: 2, componentColors: {} },
    })
  })

  it("preserves unknown persisted fields without exposing or compiling them", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const settings = customizedSettings()
    const {
      componentColors: _componentColors,
      schemaVersion: _schemaVersion,
      ...legacySettings
    } = settings
    const persisted = `${JSON.stringify(
      {
        schemaVersion: 1,
        settings: {
          ...legacySettings,
          schemaVersion: 1,
          futureSetting: { keep: "future-settings-marker" },
        },
        assets: [],
        futureManifest: { keep: "future-manifest-marker" },
      },
      null,
      2,
    )}\n`
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, persisted)
    const adapter = new QuartzAppearanceAdapter(root)

    const snapshot = await adapter.read()

    expect(snapshot.settings).toEqual({ ...settings, schemaVersion: 2, componentColors: {} })
    expect(JSON.stringify(snapshot)).not.toContain("future-settings-marker")
    expect(JSON.stringify(snapshot)).not.toContain("future-manifest-marker")

    const plan = await adapter.plan(snapshot.settings, snapshot.baselineHash)
    const stylesheet = plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.stylesheet)
    expect(new TextDecoder().decode(stylesheet?.bytes)).not.toContain("future-settings-marker")
    await applyPlan(root, plan)

    const migrated = JSON.parse(
      await readFile(join(root, QUARTZ_APPEARANCE_PATHS.manifest), "utf8"),
    )
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      settings: {
        schemaVersion: 2,
        componentColors: {},
        futureSetting: { keep: "future-settings-marker" },
      },
      futureManifest: { keep: "future-manifest-marker" },
    })
  })

  it("fails closed when preserved fields exceed safe serialization depth", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const nested = `${'{"next":'.repeat(12_000)}null${"}".repeat(12_000)}`
    const persisted = manifest(customizedSettings()).replace(
      '  "assets": []',
      `  "futureManifest": ${nested},\n  "assets": []`,
    )
    expect(encoder.encode(persisted).length).toBeLessThanOrEqual(256 * 1024)
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, persisted)
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()
    const before = await readFile(join(root, QUARTZ_APPEARANCE_PATHS.manifest))

    const result = adapter.plan(snapshot.settings, snapshot.baselineHash).catch((error) => error)

    await expect(result).resolves.toMatchObject({
      code: "APPEARANCE_INVALID",
      message: expect.not.stringMatching(/RangeError|call stack|JSON/i),
    })
    await expect(readFile(join(root, QUARTZ_APPEARANCE_PATHS.manifest))).resolves.toEqual(before)
  })

  it.each([
    ["top-level __proto__", "{\n", '{\n  "__proto__": { "polluted": true },\n'],
    [
      "nested settings constructor",
      '  "settings": {\n',
      '  "settings": {\n    "future": { "constructor": { "polluted": true } },\n',
    ],
    [
      "nested manifest prototype",
      "{\n",
      '{\n  "future": { "nested": { "prototype": { "polluted": true } } },\n',
    ],
  ])("rejects the dangerous preserved key %s", async (_name, marker, replacement) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const persisted = manifest(customizedSettings()).replace(marker, replacement)
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, persisted)

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it("rejects an oversized appearance manifest before parsing", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    await writeWorkspaceFile(
      root,
      QUARTZ_APPEARANCE_PATHS.manifest,
      new Uint8Array(256 * 1024 + 1).fill("{".charCodeAt(0)),
    )

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })

  it("does not rewrite YAML when its managed values are unchanged", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()

    const plan = await adapter.plan(snapshot.settings, snapshot.baselineHash)

    expect(plan.writes.map(({ path }) => path)).not.toContain(QUARTZ_APPEARANCE_PATHS.config)
  })

  it("inserts one exact managed import after every leading Sass @use statement", async () => {
    const root = await temporaryDirectory()
    const original = '@use "one";\n@use "two" as *;\n\n.rule { color: red; }\n'
    await createQuartzWorkspace(root, { custom: original })
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), snapshot.baselineHash)
    const write = plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.customStylesheet)!
    expect(new TextDecoder().decode(write.bytes)).toBe(
      '@use "one";\n@use "two" as *;\n/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\n\n.rule { color: red; }\n',
    )
  })

  it("preserves a UTF-8 BOM at byte zero when custom.scss has no leading @use", async () => {
    const root = await temporaryDirectory()
    const original = "\uFEFFbody { color: red; }\n"
    await createQuartzWorkspace(root, { custom: encoder.encode(original) })
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), snapshot.baselineHash)
    const custom = plan.writes.find(
      ({ path }) => path === QUARTZ_APPEARANCE_PATHS.customStylesheet,
    )!

    expect(custom.bytes).toEqual(
      encoder.encode(
        '\uFEFF/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\nbody { color: red; }\n',
      ),
    )
  })

  it("preserves BOM and CRLF around a leading @use and remains byte-idempotent", async () => {
    const root = await temporaryDirectory()
    const original = '\uFEFF@use "one";\r\n\r\nbody { color: red; }\r\n'
    const expected =
      '\uFEFF@use "one";\r\n/* publisher-appearance:start */\r\n@use "./publisher-appearance.scss";\r\n/* publisher-appearance:end */\r\n\r\nbody { color: red; }\r\n'
    await createQuartzWorkspace(root, { custom: encoder.encode(original) })
    const adapter = new QuartzAppearanceAdapter(root)
    const settings = customizedSettings()
    const before = await adapter.read()
    await applyPlan(root, await adapter.plan(settings, before.baselineHash))
    const appliedBytes = await readFile(join(root, QUARTZ_APPEARANCE_PATHS.customStylesheet))
    const applied = await adapter.read()

    expect(appliedBytes).toEqual(Buffer.from(encoder.encode(expected)))
    const duplicate = await adapter.plan(settings, applied.baselineHash)
    expect(duplicate.writes.map(({ path }) => path)).not.toContain(
      QUARTZ_APPEARANCE_PATHS.customStylesheet,
    )
    await applyPlan(root, duplicate)
    await expect(readFile(join(root, QUARTZ_APPEARANCE_PATHS.customStylesheet))).resolves.toEqual(
      appliedBytes,
    )
  })

  it("keeps leading comments and inserts after a multiline Sass @use statement", async () => {
    const root = await temporaryDirectory()
    const original =
      '// Quartz imports\n@use "theme" with (\n  $accent: red,\n);\n\n.rule { color: red; }\n'
    await createQuartzWorkspace(root, { custom: original })
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), snapshot.baselineHash)
    const write = plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.customStylesheet)!
    expect(new TextDecoder().decode(write.bytes)).toBe(
      '// Quartz imports\n@use "theme" with (\n  $accent: red,\n);\n/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\n\n.rule { color: red; }\n',
    )
  })

  it("ignores comments, quotes, and nested punctuation while finding the @use terminator", async () => {
    const root = await temporaryDirectory()
    const original =
      '@use "theme" with (\n  // rationale; don\'t end here\n  $options: (accent: red),\n);\n\n.rule { color: red; }\n'
    await createQuartzWorkspace(root, { custom: original })
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), snapshot.baselineHash)
    const custom = new TextDecoder().decode(
      plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.customStylesheet)!.bytes,
    )
    expect(custom.indexOf("publisher-appearance:start")).toBeGreaterThan(custom.indexOf("\n);"))
    expect(custom).toContain("// rationale; don't end here")
  })

  it("accepts the exact managed block at end of file without requiring a trailing newline", async () => {
    const root = await temporaryDirectory()
    const custom =
      '@use "one";\n/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */'
    await createQuartzWorkspace(root, { custom })
    const adapter = new QuartzAppearanceAdapter(root)
    const snapshot = await adapter.read()

    const plan = await adapter.plan(snapshot.settings, snapshot.baselineHash)

    expect(plan.writes.map(({ path }) => path)).not.toContain(
      QUARTZ_APPEARANCE_PATHS.customStylesheet,
    )
  })

  it("fails closed when another leading @use follows the managed marker", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root, {
      custom:
        '@use "one";\n/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\n@use "two";\n.rule { color: red; }\n',
    })

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })

  it.each([
    "@use './publisher-appearance.scss';\n",
    '@use "./publisher-appearance";\n',
    '@use "publisher-appearance.scss";\n',
    '@use "publisher-appearance";\n',
    '@use\n  "publisher-appearance"\n  as managed;\n',
  ])("rejects an unmarked Sass-equivalent managed import: %s", async (custom) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root, { custom })

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })

  it.each([
    '@use "./themes/publisher-appearance.scss";\n',
    '@use "./theme.scss" as publisher-appearance;\n',
    '@use\n  "./theme.scss"\n  as\n  publisher-appearance;\n',
  ])(
    "rejects a colliding Sass namespace before inserting the managed import: %s",
    async (custom) => {
      const root = await temporaryDirectory()
      await createQuartzWorkspace(root, { custom })

      await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
        code: "APPEARANCE_CONFLICT",
      })
    },
  )

  it.each([
    '@use "./theme.scss" as theme;\n',
    '@use "./themes/publisher-appearance.scss" as garden;\n',
    '@use "./theme.scss" as *;\n',
  ])("allows a non-colliding Sass namespace and inserts one managed import: %s", async (custom) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root, { custom })
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), before.baselineHash)
    const stylesheet = new TextDecoder().decode(
      plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.customStylesheet)!.bytes,
    )

    expect(stylesheet).toContain(custom)
    expect(stylesheet.match(/@use "\.\/publisher-appearance\.scss";/g)).toHaveLength(1)
  })

  it("ignores marker and import lookalikes inside strings and ordinary comments", async () => {
    const root = await temporaryDirectory()
    const custom =
      '$example: "/* publisher-appearance:start */ @use \'./publisher-appearance.scss\'; /* publisher-appearance:end */";\n// @use "./publisher-appearance.scss"; publisher-appearance:start\nbody { color: red; }\n'
    await createQuartzWorkspace(root, { custom })
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), before.baselineHash)
    await applyPlan(root, plan)

    await expect(adapter.read()).resolves.toMatchObject({ framework: "quartz", supported: true })
    await expect(
      readFile(join(root, QUARTZ_APPEARANCE_PATHS.customStylesheet), "utf8"),
    ).resolves.toContain(custom)
  })

  it("inserts the managed block after leading @forward and @use directives", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root, {
      custom: '@forward "tokens";\n@use "theme";\n\n.rule { color: red; }\n',
    })
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), before.baselineHash)
    const custom = new TextDecoder().decode(
      plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.customStylesheet)!.bytes,
    )
    expect(custom).toContain('@forward "tokens";\n@use "theme";\n/* publisher-appearance:start */')
  })

  it("is byte-for-byte idempotent after the first plan is applied", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const adapter = new QuartzAppearanceAdapter(root)
    const settings = customizedSettings()
    const before = await adapter.read()
    await applyPlan(root, await adapter.plan(settings, before.baselineHash))
    const applied = await adapter.read()
    const paths = Object.values(QUARTZ_APPEARANCE_PATHS).filter(
      (path) => !path.endsWith("publisher"),
    )
    const bytesBefore = await Promise.all(paths.map((path) => readFile(join(root, path))))

    const duplicate = await adapter.plan(settings, applied.baselineHash)

    expect(duplicate.writes).toEqual([])
    expect(duplicate.deletes).toEqual([])
    await applyPlan(root, duplicate)
    const bytesAfter = await Promise.all(paths.map((path) => readFile(join(root, path))))
    expect(bytesAfter).toEqual(bytesBefore)
  })

  it.each([
    ["missing end", '/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n'],
    ["end before start", "/* publisher-appearance:end */\n/* publisher-appearance:start */\n"],
    [
      "duplicate blocks",
      '/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\n/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\n',
    ],
    [
      "changed managed body",
      '/* publisher-appearance:start */\n@use "./different.scss";\n/* publisher-appearance:end */\n',
    ],
    [
      "marker after an ordinary rule",
      'body { color: red; }\n/* publisher-appearance:start */\n@use "./publisher-appearance.scss";\n/* publisher-appearance:end */\n',
    ],
  ])("fails closed for %s", async (_name, custom) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root, { custom })
    const adapter = new QuartzAppearanceAdapter(root)
    await expect(adapter.read()).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
  })

  it("rejects stale baselines without returning a write plan", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()
    await writeFile(join(root, QUARTZ_APPEARANCE_PATHS.customStylesheet), '@use "changed";\n')

    await expect(adapter.plan(customizedSettings(), before.baselineHash)).rejects.toMatchObject({
      code: "APPEARANCE_CHANGED",
    })
  })

  it("maps a file replacement during handle-based reading to a path-free conflict", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    let replaced = false
    const adapter = new QuartzAppearanceAdapter(root, {
      afterFileOpened: async (path) => {
        if (replaced || path !== QUARTZ_APPEARANCE_PATHS.config) return
        replaced = true
        await rename(join(root, path), join(root, `${path}.moved`))
      },
    })

    const result = adapter.read().catch((error: unknown) => error)

    await expect(result).resolves.toMatchObject({ code: "APPEARANCE_CONFLICT" })
    await expect(result).resolves.toMatchObject({ message: expect.not.stringContaining(root) })
  })

  it("plans only fixed allowed paths and a direct safe background child", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()
    const staged = {
      token: "0d0db930-ae87-4f95-beb2-6d531be50d88",
      name: "wallpaper.png",
      extension: ".png" as const,
      hash: sha256(encoder.encode("image")),
      bytes: encoder.encode("image"),
    }
    const settings: AppearanceSettings = {
      ...customizedSettings(),
      background: {
        kind: "image",
        asset: { source: "staged", token: staged.token, name: staged.name },
        overlay: "#000000",
        opacity: 0.5,
        position: "center",
        fixed: true,
      },
    }

    const plan = await adapter.plan(settings, before.baselineHash, staged)
    const fixed = new Set<string>([
      QUARTZ_APPEARANCE_PATHS.manifest,
      QUARTZ_APPEARANCE_PATHS.stylesheet,
      QUARTZ_APPEARANCE_PATHS.customStylesheet,
      QUARTZ_APPEARANCE_PATHS.config,
    ])
    for (const path of [...plan.writes, ...plan.deletes].map(({ path }) => path)) {
      expect(
        fixed.has(path) ||
          new RegExp(`^${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/[a-f0-9]{64}\\.png$`).test(
            path,
          ),
      ).toBe(true)
      expect(path).not.toMatch(/(^|\/)\.\.(\/|$)|\\/)
    }
    const stylesheet = plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.stylesheet)!
    const css = new TextDecoder().decode(stylesheet.bytes)
    expect(css).toContain(`url("/publisher/${staged.hash}.png")`)
    expect(css).not.toContain(root)
    expect(css).not.toContain(staged.token)
  })

  it("includes an existing same-hash staged destination as a transaction precondition", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const bytes = encoder.encode("existing image")
    const hash = sha256(bytes)
    const path = `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/${hash}.png`
    await writeWorkspaceFile(root, path, bytes)
    const staged = {
      token: "97811a42-af33-485a-bec3-1870a18a2c70",
      name: "existing.png",
      extension: ".png" as const,
      hash,
      bytes,
    }
    const settings: AppearanceSettings = {
      ...customizedSettings(),
      background: {
        kind: "image",
        asset: { source: "staged", token: staged.token, name: staged.name },
        overlay: "#000000",
        opacity: 0.25,
        position: "center",
        fixed: false,
      },
    }
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()

    const plan = await adapter.plan(settings, before.baselineHash, staged)

    expect(plan.writes).toContainEqual({ path, expectedHash: hash, bytes })
  })

  it("deletes a previously managed background when switching away from an image", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const bytes = encoder.encode("old image")
    const name = `${sha256(bytes)}.webp`
    const asset = `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/${name}`
    const settings: AppearanceSettings = {
      ...customizedSettings(),
      background: {
        kind: "image",
        asset: { source: "managed", name },
        overlay: "#000000",
        opacity: 0.4,
        position: "top",
        fixed: false,
      },
    }
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, manifest(settings, [asset]))
    await writeWorkspaceFile(root, asset, bytes)
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()

    const plan = await adapter.plan(customizedSettings(), before.baselineHash)

    expect(plan.deletes).toEqual([{ path: asset, expectedHash: sha256(bytes) }])
  })

  it.each([
    ["invalid JSON", "{"],
    ["an asset outside the allowlist", manifest(customizedSettings(), ["content/private.md"])],
    [
      "a nested asset path",
      manifest(customizedSettings(), ["quartz/static/publisher/nested/image.png"]),
    ],
  ])("rejects a manifest with %s", async (_name, contents) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, contents)
    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })

  it("rejects a tampered content-addressed managed background", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const name = `${"a".repeat(64)}.webp`
    const path = `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/${name}`
    const settings = normalizeAppearanceSettings({
      ...customizedSettings(),
      background: {
        kind: "image",
        overlay: "#000000",
        opacity: 0.7,
        position: "top",
        fixed: false,
        asset: { source: "managed", name },
      },
    })
    await writeWorkspaceFile(root, QUARTZ_APPEARANCE_PATHS.manifest, manifest(settings, [path]))
    await writeWorkspaceFile(root, path, encoder.encode("tampered image"))

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
      message: "The managed background content does not match its name.",
    })
  })

  it("preserves unrelated YAML fields and Quartz-only managed keys", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()
    const plan = await adapter.plan(customizedSettings(), before.baselineHash)
    const config = new TextDecoder().decode(
      plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.config)!.bytes,
    )

    expect(config).toContain("keepMe: unchanged")
    expect(config).toContain("source: test-plugin")
    expect(config).toContain('highlight: "rgba(34, 211, 238, 0.1)"')
    expect(config).not.toContain("baseSizePx")
    expect(config).not.toContain("lineHeight")
  })

  it("preserves YAML comments, scalar styles, anchors, aliases, and unrelated keys", async () => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root, {
      config: `# publisher must retain this document comment
configuration:
  pageTitle: "Quoted Garden" # retain this inline comment
  "__proto__": untouched
  shared: &shared
    nested: true
  sharedCopy: *shared
  theme:
    typography:
      header: "Existing Header"
      body: Existing Body
      code: Existing Code
    colors:
      lightMode: &colors
        light: "#101010"
        lightgray: "#202020"
        gray: "#303030"
        darkgray: "#d0d0d0"
        dark: "#f0f0f0"
        secondary: "#22d3ee"
        tertiary: "#94a3b8"
      darkMode: *colors
plugins:
  - source: test-plugin
`,
    })
    const adapter = new QuartzAppearanceAdapter(root)
    const before = await adapter.read()
    const plan = await adapter.plan(customizedSettings(), before.baselineHash)
    const config = new TextDecoder().decode(
      plan.writes.find(({ path }) => path === QUARTZ_APPEARANCE_PATHS.config)!.bytes,
    )

    expect(config).toContain("# publisher must retain this document comment")
    expect(config).toContain('pageTitle: "Quoted Garden" # retain this inline comment')
    expect(config).toContain('"__proto__": untouched')
    expect(config).toContain("shared: &shared")
    expect(config).toContain("sharedCopy: *shared")
    expect(config).toContain("lightMode: &colors")
    expect(config).toContain("darkMode: *colors")
    expect(config).toContain('header: "Garden Header"')
    expect(config).toContain("source: test-plugin")
  })

  it.each([
    QUARTZ_APPEARANCE_PATHS.config,
    QUARTZ_APPEARANCE_PATHS.customStylesheet,
    QUARTZ_APPEARANCE_PATHS.manifest,
  ])("fails closed when %s is a symlink", async (relativePath) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const outside = await temporaryDirectory()
    const target = join(outside, "target")
    await writeFile(
      target,
      relativePath.endsWith(".json") ? manifest(customizedSettings()) : "safe",
    )
    const absolute = join(root, ...relativePath.split("/"))
    await rm(absolute, { force: true })
    try {
      await symlink(target, absolute, "file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return
      throw error
    }

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })

  it("fails closed when an allowlisted parent directory is a symlink", async ({ skip }) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const outside = await temporaryDirectory()
    await rm(join(root, "quartz", "styles"), { recursive: true })
    await writeWorkspaceFile(outside, "custom.scss", '@use "./variables.scss";\n')
    try {
      await symlink(
        outside,
        join(root, "quartz", "styles"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })

  it("fails closed when the managed background directory is a symlink", async ({ skip }) => {
    const root = await temporaryDirectory()
    await createQuartzWorkspace(root)
    const outside = await temporaryDirectory()
    await mkdir(join(root, "quartz", "static"), { recursive: true })
    try {
      await symlink(
        outside,
        join(root, ...QUARTZ_APPEARANCE_PATHS.backgroundDirectory.split("/")),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    await expect(new QuartzAppearanceAdapter(root).read()).rejects.toMatchObject({
      code: "APPEARANCE_CONFLICT",
    })
  })
})
