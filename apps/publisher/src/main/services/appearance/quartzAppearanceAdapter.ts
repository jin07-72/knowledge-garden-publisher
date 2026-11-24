import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml"
import { z } from "zod"
import {
  cloneAppearancePreset,
  compileAppearanceCss,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from "../../../shared/appearance"
import type { AppearanceSnapshot, AppError } from "../../../shared/contracts"
import { appearanceSettingsSchema } from "../../../shared/ipcSchemas"
import type {
  AppearanceAdapter,
  AppearanceDelete,
  AppearancePlan,
  AppearanceWrite,
  StagedAppearanceAsset,
} from "./appearanceAdapter"

export const QUARTZ_APPEARANCE_PATHS = Object.freeze({
  manifest: "quartz/styles/publisher-appearance.json",
  stylesheet: "quartz/styles/publisher-appearance.scss",
  backgroundDirectory: "quartz/static/publisher",
  customStylesheet: "quartz/styles/custom.scss",
  config: "quartz.config.yaml",
})

const FIXED_FILES = [
  QUARTZ_APPEARANCE_PATHS.config,
  QUARTZ_APPEARANCE_PATHS.customStylesheet,
  QUARTZ_APPEARANCE_PATHS.manifest,
  QUARTZ_APPEARANCE_PATHS.stylesheet,
] as const
const REQUIRED_FILES = new Set<string>([
  QUARTZ_APPEARANCE_PATHS.config,
  QUARTZ_APPEARANCE_PATHS.customStylesheet,
])
const START_MARKER = "/* publisher-appearance:start */"
const END_MARKER = "/* publisher-appearance:end */"
const SAFE_ASSET_NAME = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|avif)$/
const SAFE_STAGED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"])
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const customStylesheetDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
export const MAX_APPEARANCE_MANIFEST_BYTES = 256 * 1024

interface FileState {
  readonly path: string
  readonly bytes: Uint8Array | null
  readonly hash: string | null
}

type AppearanceSettingsV1 = Omit<AppearanceSettings, "schemaVersion" | "componentColors"> & {
  readonly schemaVersion: 1
}

interface AppearanceManifest {
  readonly settings: AppearanceSettings
  readonly assets: readonly string[]
  readonly rawManifest: Readonly<Record<string, unknown>>
  readonly rawSettings: Readonly<Record<string, unknown>>
}

interface Baseline {
  readonly hash: string
  readonly files: ReadonlyMap<string, FileState>
  readonly manifest: AppearanceManifest | undefined
  readonly configuration: ConfigurationDocument
  readonly custom: string
}

type ConfigurationDocument = Document<Node, true>

export interface QuartzAppearanceAdapterHooks {
  readonly afterFileOpened?: (path: string) => void | Promise<void>
}

function appearanceError(
  code: "APPEARANCE_CONFLICT" | "APPEARANCE_CHANGED" | "APPEARANCE_INVALID",
  message: string,
): AppError {
  return { code, message }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function fileIdentity(details: {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}): string {
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeNs}:${details.ctimeNs}`
}

function directoryIdentity(details: {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
}): string {
  return `${details.dev}:${details.ino}:${details.birthtimeNs}`
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const persistedSettingsSchema = z
  .object({ schemaVersion: z.union([z.literal(1), z.literal(2)]) })
  .passthrough()
const persistedManifestSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    settings: persistedSettingsSchema,
    assets: z.array(z.string()),
  })
  .passthrough()

function knownSettingsCandidate(
  settings: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    preset: settings.preset,
    background: settings.background,
    colors: settings.colors,
    componentColors: settings.componentColors,
    typography: settings.typography,
    layout: settings.layout,
    customCss: settings.customCss,
  }
}

function parseAppearanceV1(settings: Readonly<Record<string, unknown>>): AppearanceSettingsV1 {
  const parsed = appearanceSettingsSchema.safeParse({
    ...knownSettingsCandidate(settings),
    componentColors: {},
  })
  if (!parsed.success) {
    throw appearanceError("APPEARANCE_CONFLICT", "The Publisher appearance manifest is invalid.")
  }
  const {
    componentColors: _componentColors,
    schemaVersion: _schemaVersion,
    ...legacy
  } = parsed.data
  return { ...legacy, schemaVersion: 1 }
}

function migrateAppearanceV1(settings: AppearanceSettingsV1): AppearanceSettings {
  return normalizeAppearanceSettings({ ...settings, schemaVersion: 2, componentColors: {} })
}

interface SassDirective {
  readonly kind: "use" | "forward"
  readonly start: number
  readonly end: number
  readonly module: string | undefined
  readonly namespace: string | "*" | undefined
}

interface SassMarker {
  readonly kind: "start" | "end"
  readonly start: number
  readonly end: number
}

interface SassScan {
  readonly directives: readonly SassDirective[]
  readonly markers: readonly SassMarker[]
  readonly managedImports: readonly SassDirective[]
  readonly preludeEnd: number
}

function lineCommentEnd(source: string, start: number): number {
  const end = source.indexOf("\n", start + 2)
  return end === -1 ? source.length : end + 1
}

function blockCommentEnd(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2)
  return end === -1 ? source.length : end + 2
}

function sassString(
  source: string,
  start: number,
): { readonly end: number; readonly value: string } {
  const quote = source[start]!
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!
    if (escaped) {
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else if (character === quote) {
      return { end: index + 1, value: source.slice(start + 1, index) }
    }
  }
  return { end: source.length, value: source.slice(start + 1) }
}

function sassDirective(source: string, start: number): SassDirective | undefined {
  const match = /^@(use|forward)\b/.exec(source.slice(start))
  if (!match) return undefined
  const kind = match[1] as SassDirective["kind"]
  let module: string | undefined
  let namespace: string | "*" | undefined
  let depth = 0
  let index = start + match[0].length
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = lineCommentEnd(source, index)
      continue
    }
    if (source.startsWith("/*", index)) {
      index = blockCommentEnd(source, index)
      continue
    }
    const character = source[index]!
    if (character === '"' || character === "'") {
      const parsed = sassString(source, index)
      if (module === undefined && depth === 0) module = parsed.value
      index = parsed.end
      continue
    }
    if (
      kind === "use" &&
      module !== undefined &&
      namespace === undefined &&
      depth === 0 &&
      /^as\b/.test(source.slice(index))
    ) {
      index = consumeSassTrivia(source, index + 2)
      if (source[index] === "*") {
        namespace = "*"
        index += 1
        continue
      }
      const explicit = /^[-_a-zA-Z][-_a-zA-Z0-9]*/.exec(source.slice(index))
      if (explicit) {
        namespace = explicit[0]
        index += explicit[0].length
        continue
      }
    }
    if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}")
      depth = Math.max(0, depth - 1)
    else if (character === ";" && depth === 0) {
      index += 1
      const lineEnd = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(index))
      return { kind, start, end: index + (lineEnd?.[0].length ?? 0), module, namespace }
    }
    index += 1
  }
  return undefined
}

function normalizedSassIdentifier(value: string): string {
  return value.replaceAll("_", "-")
}

function isManagedSassModule(module: string | undefined): boolean {
  if (module === undefined) return false
  const direct = module.startsWith("./") ? module.slice(2) : module
  return direct === "publisher-appearance" || direct === "publisher-appearance.scss"
}

function sassUseNamespace(directive: SassDirective): string | "*" | undefined {
  if (directive.kind !== "use" || directive.module === undefined) return undefined
  if (directive.namespace !== undefined) return directive.namespace
  const basename = directive.module.slice(directive.module.lastIndexOf("/") + 1)
  return basename.replace(/^_/, "").replace(/\.(?:scss|sass|css)$/i, "")
}

function hasManagedNamespace(directive: SassDirective): boolean {
  const namespace = sassUseNamespace(directive)
  return (
    namespace !== undefined &&
    namespace !== "*" &&
    normalizedSassIdentifier(namespace) === "publisher-appearance"
  )
}

function consumeSassTrivia(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    const whitespace = /^\s+/.exec(source.slice(index))
    if (whitespace) {
      index += whitespace[0].length
      continue
    }
    if (source.startsWith("//", index)) {
      index = lineCommentEnd(source, index)
      continue
    }
    if (source.startsWith("/*", index)) {
      index = blockCommentEnd(source, index)
      continue
    }
    break
  }
  return index
}

function scanSass(source: string): SassScan {
  const directives: SassDirective[] = []
  const markers: SassMarker[] = []
  let index = source.startsWith("\uFEFF") ? 1 : 0
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      index = lineCommentEnd(source, index)
      continue
    }
    if (source.startsWith("/*", index)) {
      const end = blockCommentEnd(source, index)
      const comment = source.slice(index, end)
      if (comment === START_MARKER) markers.push({ kind: "start", start: index, end })
      if (comment === END_MARKER) markers.push({ kind: "end", start: index, end })
      index = end
      continue
    }
    const character = source[index]!
    if (character === '"' || character === "'") {
      index = sassString(source, index).end
      continue
    }
    const directive = character === "@" ? sassDirective(source, index) : undefined
    if (directive) {
      directives.push(directive)
      index = directive.end
      continue
    }
    index += 1
  }

  const bomEnd = source.startsWith("\uFEFF") ? 1 : 0
  let cursor = bomEnd
  let sawDirective = false
  for (const directive of directives) {
    const afterTrivia = consumeSassTrivia(source, cursor)
    if (afterTrivia !== directive.start) break
    cursor = directive.end
    sawDirective = true
  }
  const preludeEnd = sawDirective ? cursor : consumeSassTrivia(source, bomEnd)
  return {
    directives,
    markers,
    managedImports: directives.filter(
      ({ kind, module }) => kind === "use" && isManagedSassModule(module),
    ),
    preludeEnd,
  }
}

function stylesheetNewline(source: string): "\r\n" | "\n" {
  return /\r\n|\n/.exec(source)?.[0] === "\r\n" ? "\r\n" : "\n"
}

function managedUse(newline: "\r\n" | "\n"): string {
  return `${START_MARKER}${newline}@use "./publisher-appearance.scss";${newline}${END_MARKER}${newline}`
}

function managedCustomStylesheet(source: string): string {
  const scan = scanSass(source)
  const starts = scan.markers.filter(({ kind }) => kind === "start")
  const ends = scan.markers.filter(({ kind }) => kind === "end")
  if (starts.length === 0 && ends.length === 0) {
    if (
      scan.managedImports.length > 0 ||
      scan.directives.some((directive) => hasManagedNamespace(directive))
    ) {
      throw appearanceError(
        "APPEARANCE_CONFLICT",
        "The Publisher appearance stylesheet is imported outside its managed marker block.",
      )
    }
    return `${source.slice(0, scan.preludeEnd)}${managedUse(stylesheetNewline(source))}${source.slice(scan.preludeEnd)}`
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw appearanceError(
      "APPEARANCE_CONFLICT",
      "The Publisher marker block is malformed or duplicated.",
    )
  }
  const start = starts[0]!.start
  const end = ends[0]!.start
  const afterStart = start + START_MARKER.length
  const newline = source.startsWith("\r\n", afterStart)
    ? "\r\n"
    : source.startsWith("\n", afterStart)
      ? "\n"
      : undefined
  const expectedBlock =
    newline === undefined ? undefined : managedUse(newline).slice(0, -newline.length)
  const blockEnd = start + (expectedBlock?.length ?? 0)
  const suffixStart = source.startsWith("\r\n", blockEnd)
    ? blockEnd + 2
    : source.startsWith("\n", blockEnd)
      ? blockEnd + 1
      : blockEnd
  if (
    end < start ||
    expectedBlock === undefined ||
    source.slice(start, blockEnd) !== expectedBlock ||
    (blockEnd < source.length && suffixStart === blockEnd)
  ) {
    throw appearanceError("APPEARANCE_CONFLICT", "The Publisher marker block was changed.")
  }
  if (
    scan.directives.some(
      (directive) => directive !== scan.managedImports[0] && hasManagedNamespace(directive),
    )
  ) {
    throw appearanceError(
      "APPEARANCE_CONFLICT",
      "A Sass import already uses the Publisher appearance namespace.",
    )
  }
  if (
    scan.managedImports.length !== 1 ||
    scan.managedImports[0]!.start < start ||
    scan.managedImports[0]!.end > blockEnd
  ) {
    throw appearanceError(
      "APPEARANCE_CONFLICT",
      "The Publisher appearance stylesheet has an unmanaged import.",
    )
  }
  const withoutManagedBlock = `${source.slice(0, start)}${source.slice(suffixStart)}`
  if (start !== scanSass(withoutManagedBlock).preludeEnd) {
    throw appearanceError(
      "APPEARANCE_CONFLICT",
      "The Publisher marker block is not in the Sass prelude.",
    )
  }
  return source
}

function isManagedAssetPath(path: string): boolean {
  const prefix = `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/`
  return path.startsWith(prefix) && SAFE_ASSET_NAME.test(path.slice(prefix.length))
}

function parseManifest(bytes: Uint8Array): AppearanceManifest {
  if (bytes.length > MAX_APPEARANCE_MANIFEST_BYTES) {
    throw appearanceError("APPEARANCE_CONFLICT", "The Publisher appearance manifest is too large.")
  }
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    throw appearanceError(
      "APPEARANCE_CONFLICT",
      "The Publisher appearance manifest is invalid JSON.",
    )
  }
  const manifest = persistedManifestSchema.safeParse(value)
  if (
    !manifest.success ||
    manifest.data.schemaVersion !== manifest.data.settings.schemaVersion ||
    !manifest.data.assets.every(isManagedAssetPath) ||
    new Set(manifest.data.assets).size !== manifest.data.assets.length
  ) {
    throw appearanceError("APPEARANCE_CONFLICT", "The Publisher appearance manifest is invalid.")
  }
  const rawSettings = manifest.data.settings as Record<string, unknown>
  let normalized: AppearanceSettings
  if (manifest.data.schemaVersion === 1) {
    normalized = migrateAppearanceV1(parseAppearanceV1(rawSettings))
  } else {
    const settings = appearanceSettingsSchema.safeParse(knownSettingsCandidate(rawSettings))
    if (!settings.success) {
      throw appearanceError("APPEARANCE_CONFLICT", "The Publisher appearance manifest is invalid.")
    }
    normalized = normalizeAppearanceSettings(settings.data)
  }
  if (
    normalized.background.kind === "image" &&
    (normalized.background.asset.source !== "managed" ||
      !SAFE_ASSET_NAME.test(normalized.background.asset.name) ||
      !manifest.data.assets.includes(
        `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/${normalized.background.asset.name}`,
      ))
  ) {
    throw appearanceError("APPEARANCE_CONFLICT", "The manifest background asset is inconsistent.")
  }
  return {
    settings: normalized,
    assets: [...manifest.data.assets].sort(),
    rawManifest: manifest.data,
    rawSettings,
  }
}

function parseConfiguration(bytes: Uint8Array): ConfigurationDocument {
  try {
    const document = parseDocument(decoder.decode(bytes), {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    })
    if (document.errors.length > 0 || !isMap(document.contents)) throw new Error()
    return document
  } catch {
    throw appearanceError("APPEARANCE_CONFLICT", "quartz.config.yaml could not be parsed safely.")
  }
}

function resolvedConfigurationNode(document: ConfigurationDocument, value: unknown): unknown {
  const seen = new Set<unknown>()
  let current = value
  while (isAlias(current)) {
    if (seen.has(current)) {
      throw appearanceError("APPEARANCE_CONFLICT", "quartz.config.yaml contains an invalid alias.")
    }
    seen.add(current)
    current = current.resolve(document)
  }
  return current
}

function configurationNodeAt(document: ConfigurationDocument, path: readonly string[]): unknown {
  let current = resolvedConfigurationNode(document, document.contents)
  for (const key of path) {
    if (!isMap(current)) return undefined
    current = resolvedConfigurationNode(document, current.get(key, true))
  }
  return current
}

function configurationValueAt(document: ConfigurationDocument, path: readonly string[]): unknown {
  const value = configurationNodeAt(document, path)
  return isScalar(value) ? value.value : undefined
}

function configurationMapAt(document: ConfigurationDocument, path: readonly string[]): YAMLMap {
  const root = resolvedConfigurationNode(document, document.contents)
  if (!isMap(root)) {
    throw appearanceError("APPEARANCE_CONFLICT", "quartz.config.yaml has an invalid structure.")
  }
  let current: YAMLMap = root
  for (const key of path) {
    const existing = current.get(key, true)
    if (existing === undefined) {
      const created = document.createNode({})
      if (!isMap(created)) {
        throw appearanceError("APPEARANCE_CONFLICT", "quartz.config.yaml has an invalid structure.")
      }
      current.set(key, created)
      current = created
      continue
    }
    const resolved = resolvedConfigurationNode(document, existing)
    if (!isMap(resolved)) {
      throw appearanceError("APPEARANCE_CONFLICT", "quartz.config.yaml has an invalid structure.")
    }
    current = resolved
  }
  return current
}

function setConfigurationScalar(map: YAMLMap, key: string, value: string): void {
  const existing = map.get(key, true)
  if (isScalar(existing)) {
    existing.value = value
  } else {
    map.set(key, value)
  }
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value) ? value : fallback
}

function font(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback
}

function settingsFromConfiguration(configuration: ConfigurationDocument): AppearanceSettings {
  const settings = cloneAppearancePreset("knowledge-garden")
  const typography = ["configuration", "theme", "typography"] as const
  const dark = ["configuration", "theme", "colors", "darkMode"] as const
  return normalizeAppearanceSettings({
    ...settings,
    preset: "custom",
    colors: {
      ...settings.colors,
      page: color(configurationValueAt(configuration, [...dark, "light"]), settings.colors.page),
      surface: color(
        configurationValueAt(configuration, [...dark, "lightgray"]),
        settings.colors.surface,
      ),
      border: color(configurationValueAt(configuration, [...dark, "gray"]), settings.colors.border),
      text: color(configurationValueAt(configuration, [...dark, "darkgray"]), settings.colors.text),
      heading: color(
        configurationValueAt(configuration, [...dark, "dark"]),
        settings.colors.heading,
      ),
      accent: color(
        configurationValueAt(configuration, [...dark, "secondary"]),
        settings.colors.accent,
      ),
      secondary: color(
        configurationValueAt(configuration, [...dark, "tertiary"]),
        settings.colors.secondary,
      ),
    },
    typography: {
      ...settings.typography,
      header: font(
        configurationValueAt(configuration, [...typography, "header"]),
        settings.typography.header,
      ),
      body: font(
        configurationValueAt(configuration, [...typography, "body"]),
        settings.typography.body,
      ),
      code: font(
        configurationValueAt(configuration, [...typography, "code"]),
        settings.typography.code,
      ),
    },
  })
}

function updatedConfiguration(
  configuration: ConfigurationDocument,
  settings: AppearanceSettings,
): ConfigurationDocument {
  const document = configuration.clone()
  const typography = configurationMapAt(document, ["configuration", "theme", "typography"])
  setConfigurationScalar(typography, "header", settings.typography.header)
  setConfigurationScalar(typography, "body", settings.typography.body)
  setConfigurationScalar(typography, "code", settings.typography.code)

  for (const mode of ["lightMode", "darkMode"] as const) {
    const colors = configurationMapAt(document, ["configuration", "theme", "colors", mode])
    setConfigurationScalar(colors, "light", settings.colors.page)
    setConfigurationScalar(colors, "lightgray", settings.colors.surface)
    setConfigurationScalar(colors, "gray", settings.colors.border)
    setConfigurationScalar(colors, "darkgray", settings.colors.text)
    setConfigurationScalar(colors, "dark", settings.colors.heading)
    setConfigurationScalar(colors, "secondary", settings.colors.accent)
    setConfigurationScalar(colors, "tertiary", settings.colors.secondary)
  }
  return document
}

function managedConfigurationFingerprint(configuration: ConfigurationDocument): string {
  const value = (...path: string[]) => configurationValueAt(configuration, path)
  const managedMode = (mode: string) =>
    ["light", "lightgray", "gray", "darkgray", "dark", "secondary", "tertiary"].map((key) =>
      value("configuration", "theme", "colors", mode, key),
    )
  return JSON.stringify([
    value("configuration", "theme", "typography", "header"),
    value("configuration", "theme", "typography", "body"),
    value("configuration", "theme", "typography", "code"),
    managedMode("lightMode"),
    managedMode("darkMode"),
  ])
}

function manifestBytes(
  settings: AppearanceSettings,
  assets: readonly string[],
  previous: AppearanceManifest | undefined,
): Uint8Array {
  const value = {
    ...previous?.rawManifest,
    schemaVersion: 2,
    settings: { ...previous?.rawSettings, ...settings },
    assets,
  }
  const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.length > MAX_APPEARANCE_MANIFEST_BYTES) {
    throw appearanceError("APPEARANCE_INVALID", "The Publisher appearance manifest is too large.")
  }
  return bytes
}

export class QuartzAppearanceAdapter implements AppearanceAdapter {
  readonly framework = "quartz" as const
  readonly #root: string
  readonly #hooks: QuartzAppearanceAdapterHooks

  constructor(root: string, hooks: QuartzAppearanceAdapterHooks = {}) {
    this.#root = resolve(root)
    this.#hooks = hooks
  }

  async #assertRoot(): Promise<string> {
    try {
      const details = await lstat(this.#root)
      const canonical = await realpath(this.#root)
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        !pathsEqual(canonical, this.#root)
      ) {
        throw new Error()
      }
      return canonical
    } catch {
      throw appearanceError("APPEARANCE_CONFLICT", "The Quartz workspace root is unsafe.")
    }
  }

  async #readSafe(root: string, path: string, required: boolean): Promise<FileState> {
    const absolute = resolve(root, ...path.split("/"))
    if (!isInside(root, absolute)) {
      throw appearanceError("APPEARANCE_CONFLICT", "An appearance path leaves the workspace.")
    }
    const segments = path.split("/")
    let current = root
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!)
      try {
        const details = await lstat(current)
        if (details.isSymbolicLink()) throw new Error("link")
        if (index < segments.length - 1 && !details.isDirectory()) throw new Error("parent")
        if (index === segments.length - 1 && !details.isFile()) throw new Error("file")
        const canonical = await realpath(current)
        if (!isInside(root, canonical) || !pathsEqual(canonical, current))
          throw new Error("outside")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" && !required) return { path, bytes: null, hash: null }
        throw appearanceError(
          "APPEARANCE_CONFLICT",
          `The appearance path ${path} is missing or unsafe.`,
        )
      }
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const parent = dirname(absolute)
      const [parentBefore, parentCanonical, before, canonical] = await Promise.all([
        lstat(parent, { bigint: true }),
        realpath(parent),
        lstat(absolute, { bigint: true }),
        realpath(absolute),
      ])
      if (
        parentBefore.isSymbolicLink() ||
        !parentBefore.isDirectory() ||
        !pathsEqual(parentCanonical, parent) ||
        !isInside(root, parentCanonical) ||
        before.isSymbolicLink() ||
        !before.isFile() ||
        !pathsEqual(canonical, absolute) ||
        !isInside(root, canonical)
      ) {
        throw new Error("unsafe appearance file")
      }
      const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
      handle = await open(absolute, flags)
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(before)) {
        throw new Error("appearance file changed before reading")
      }
      await this.#hooks.afterFileOpened?.(path)
      const bytes = await handle.readFile()
      const [openedAfter, after, canonicalAfter, parentAfter, parentCanonicalAfter] =
        await Promise.all([
          handle.stat({ bigint: true }),
          lstat(absolute, { bigint: true }),
          realpath(absolute),
          lstat(parent, { bigint: true }),
          realpath(parent),
        ])
      if (
        !openedAfter.isFile() ||
        fileIdentity(opened) !== fileIdentity(openedAfter) ||
        after.isSymbolicLink() ||
        !after.isFile() ||
        fileIdentity(openedAfter) !== fileIdentity(after) ||
        !pathsEqual(canonicalAfter, canonical) ||
        !pathsEqual(canonicalAfter, absolute) ||
        !isInside(root, canonicalAfter) ||
        parentAfter.isSymbolicLink() ||
        !parentAfter.isDirectory() ||
        directoryIdentity(parentBefore) !== directoryIdentity(parentAfter) ||
        !pathsEqual(parentCanonicalAfter, parentCanonical) ||
        !pathsEqual(parentCanonicalAfter, parent) ||
        !isInside(root, parentCanonicalAfter)
      ) {
        throw new Error("appearance file changed while reading")
      }
      return { path, bytes, hash: sha256(bytes) }
    } catch {
      throw appearanceError(
        "APPEARANCE_CONFLICT",
        "An appearance file is missing, inaccessible, changed, or unsafe.",
      )
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #assertOptionalSafeDirectory(root: string, path: string): Promise<void> {
    let current = root
    const segments = path.split("/")
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!)
      try {
        const details = await lstat(current)
        if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("unsafe")
        const canonical = await realpath(current)
        if (!isInside(root, canonical) || !pathsEqual(canonical, current))
          throw new Error("outside")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw appearanceError("APPEARANCE_CONFLICT", `The appearance path ${path} is unsafe.`)
      }
    }
  }

  async #capture(): Promise<Baseline> {
    const root = await this.#assertRoot()
    await this.#assertOptionalSafeDirectory(root, QUARTZ_APPEARANCE_PATHS.backgroundDirectory)
    const states = await Promise.all(
      FIXED_FILES.map((path) => this.#readSafe(root, path, REQUIRED_FILES.has(path))),
    )
    const files = new Map(states.map((state) => [state.path, state]))
    const manifestState = files.get(QUARTZ_APPEARANCE_PATHS.manifest)!
    const manifest = manifestState.bytes === null ? undefined : parseManifest(manifestState.bytes)
    if (manifest) {
      for (const path of manifest.assets) {
        const state = await this.#readSafe(root, path, true)
        const name = path.slice(QUARTZ_APPEARANCE_PATHS.backgroundDirectory.length + 1)
        const expectedHash = name.slice(0, name.indexOf("."))
        if (state.hash !== expectedHash) {
          throw appearanceError(
            "APPEARANCE_CONFLICT",
            "The managed background content does not match its name.",
          )
        }
        files.set(path, state)
      }
    }
    const configState = files.get(QUARTZ_APPEARANCE_PATHS.config)!
    const customState = files.get(QUARTZ_APPEARANCE_PATHS.customStylesheet)!
    const configuration = parseConfiguration(configState.bytes!)
    let custom: string
    try {
      custom = customStylesheetDecoder.decode(customState.bytes!)
    } catch {
      throw appearanceError("APPEARANCE_CONFLICT", "custom.scss is not valid UTF-8.")
    }
    managedCustomStylesheet(custom)
    const tuples = [...files.values()]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(({ path, bytes, hash }) => [path, bytes !== null, hash] as const)
    return {
      hash: sha256(encoder.encode(JSON.stringify(tuples))),
      files,
      manifest,
      configuration,
      custom,
    }
  }

  async read(): Promise<AppearanceSnapshot> {
    const baseline = await this.#capture()
    return {
      framework: this.framework,
      supported: true,
      settings: baseline.manifest?.settings ?? settingsFromConfiguration(baseline.configuration),
      baselineHash: baseline.hash,
      canUndo: false,
    }
  }

  async plan(
    requested: AppearanceSettings,
    baselineHash: string,
    staged?: StagedAppearanceAsset,
  ): Promise<AppearancePlan> {
    const baseline = await this.#capture()
    if (baseline.hash !== baselineHash) {
      throw appearanceError("APPEARANCE_CHANGED", "Appearance files changed after they were read.")
    }
    const parsed = appearanceSettingsSchema.safeParse(requested)
    if (!parsed.success) {
      throw appearanceError("APPEARANCE_INVALID", "The requested appearance settings are invalid.")
    }
    let settings = normalizeAppearanceSettings(parsed.data)
    const writes: AppearanceWrite[] = []
    const deletes: AppearanceDelete[] = []
    const nextAssets: string[] = []
    let imageUrl: string | undefined

    if (settings.background.kind === "image") {
      const asset = settings.background.asset
      if (asset.source === "staged") {
        if (
          staged === undefined ||
          staged.token !== asset.token ||
          staged.name !== asset.name ||
          !SAFE_STAGED_EXTENSIONS.has(staged.extension) ||
          sha256(staged.bytes) !== staged.hash ||
          !/^[a-f0-9]{64}$/.test(staged.hash)
        ) {
          throw appearanceError(
            "APPEARANCE_INVALID",
            "The staged background does not match the request.",
          )
        }
        const name = `${staged.hash}${staged.extension}`
        const path = `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/${name}`
        const existing = await this.#readSafe(await this.#assertRoot(), path, false)
        if (existing.bytes !== null && existing.hash !== staged.hash) {
          throw appearanceError(
            "APPEARANCE_CONFLICT",
            "The managed background destination is occupied.",
          )
        }
        writes.push({
          path,
          expectedHash: existing.hash,
          bytes: new Uint8Array(staged.bytes),
        })
        nextAssets.push(path)
        imageUrl = `/publisher/${name}`
        settings = {
          ...settings,
          background: { ...settings.background, asset: { source: "managed", name } },
        }
      } else {
        if (!SAFE_ASSET_NAME.test(asset.name)) {
          throw appearanceError("APPEARANCE_INVALID", "The managed background name is invalid.")
        }
        const path = `${QUARTZ_APPEARANCE_PATHS.backgroundDirectory}/${asset.name}`
        if (!baseline.manifest?.assets.includes(path)) {
          throw appearanceError(
            "APPEARANCE_CONFLICT",
            "The managed background is not owned by Publisher.",
          )
        }
        nextAssets.push(path)
        imageUrl = `/publisher/${asset.name}`
      }
    }

    for (const path of baseline.manifest?.assets ?? []) {
      if (!nextAssets.includes(path)) {
        deletes.push({ path, expectedHash: baseline.files.get(path)!.hash! })
      }
    }

    const nextConfiguration = updatedConfiguration(baseline.configuration, settings)
    const desired = new Map<string, Uint8Array>([
      [QUARTZ_APPEARANCE_PATHS.manifest, manifestBytes(settings, nextAssets, baseline.manifest)],
      [
        QUARTZ_APPEARANCE_PATHS.stylesheet,
        encoder.encode(`${compileAppearanceCss(settings, { imageUrl })}\n`),
      ],
      [
        QUARTZ_APPEARANCE_PATHS.customStylesheet,
        encoder.encode(managedCustomStylesheet(baseline.custom)),
      ],
    ])
    if (
      managedConfigurationFingerprint(nextConfiguration) !==
      managedConfigurationFingerprint(baseline.configuration)
    ) {
      desired.set(QUARTZ_APPEARANCE_PATHS.config, encoder.encode(nextConfiguration.toString()))
    }
    for (const [path, bytes] of desired) {
      const current = baseline.files.get(path)!
      if (current.bytes === null || current.hash !== sha256(bytes)) {
        writes.push({ path, expectedHash: current.hash, bytes })
      }
    }
    const byPath = (left: { readonly path: string }, right: { readonly path: string }) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    writes.sort(byPath)
    deletes.sort(byPath)
    // Planning narrows filesystem races but cannot eliminate changes after this method returns.
    // Task 5's executor must revalidate every expected hash/absence and parent path immediately
    // before mutation.
    return { baselineHash: baseline.hash, settings, writes, deletes }
  }
}
