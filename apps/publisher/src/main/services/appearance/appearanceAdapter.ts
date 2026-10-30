import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { AppearanceSettings, BlogFramework } from "../../../shared/appearance"
import { DEFAULT_APPEARANCE } from "../../../shared/appearance"
import type { AppearanceSnapshot, AppError } from "../../../shared/contracts"
import { QuartzAppearanceAdapter } from "./quartzAppearanceAdapter"

export interface AppearanceWrite {
  readonly path: string
  readonly expectedHash: string | null
  readonly bytes: Uint8Array
}

export interface AppearanceDelete {
  readonly path: string
  readonly expectedHash: string
}

export interface AppearancePlan {
  readonly baselineHash: string
  readonly settings: AppearanceSettings
  readonly writes: readonly AppearanceWrite[]
  readonly deletes: readonly AppearanceDelete[]
}

/** A validated, in-memory asset. It deliberately contains no filesystem path. */
export interface StagedAppearanceAsset {
  readonly token: string
  readonly name: string
  readonly extension: ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".avif"
  readonly hash: string
  readonly bytes: Uint8Array
}

export interface AppearanceAdapter {
  readonly framework: BlogFramework
  read(): Promise<AppearanceSnapshot>
  plan(
    settings: AppearanceSettings,
    baselineHash: string,
    staged?: StagedAppearanceAsset,
  ): Promise<AppearancePlan>
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

async function canonicalRoot(rootInput: string): Promise<string | undefined> {
  try {
    const root = resolve(rootInput)
    const [details, canonical] = await Promise.all([lstat(root), realpath(root)])
    return details.isDirectory() && !details.isSymbolicLink() && pathsEqual(root, canonical)
      ? canonical
      : undefined
  } catch {
    return undefined
  }
}

async function ordinaryEntry(
  root: string,
  path: string,
  kind: "file" | "directory",
): Promise<boolean> {
  try {
    const segments = path.split("/")
    const absolute = resolve(root, ...segments)
    if (!isInside(root, absolute)) return false
    let current = root
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!)
      const [details, canonical] = await Promise.all([lstat(current), realpath(current)])
      const leaf = index === segments.length - 1
      if (
        details.isSymbolicLink() ||
        !pathsEqual(current, canonical) ||
        !isInside(root, canonical) ||
        (!leaf && !details.isDirectory()) ||
        (leaf && kind === "file" && !details.isFile()) ||
        (leaf && kind === "directory" && !details.isDirectory())
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

async function ordinaryFile(root: string, path: string): Promise<boolean> {
  return ordinaryEntry(root, path, "file")
}

async function ordinaryDirectory(root: string, path: string): Promise<boolean> {
  return ordinaryEntry(root, path, "directory")
}

async function readPackage(root: string): Promise<Record<string, unknown> | undefined> {
  if (!(await ordinaryFile(root, "package.json"))) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function isQuartz(root: string, manifest: Record<string, unknown> | undefined) {
  const scripts = record(manifest?.scripts)
  return (
    manifest?.name === "@jackyzha0/quartz" &&
    scripts?.quartz === "./quartz/bootstrap-cli.mjs" &&
    (await ordinaryFile(root, "quartz/bootstrap-cli.mjs")) &&
    (await ordinaryFile(root, "quartz.config.yaml")) &&
    (await ordinaryFile(root, "quartz/styles/custom.scss"))
  )
}

async function isHugo(root: string): Promise<boolean> {
  const configNames = ["hugo.toml", "hugo.yaml", "hugo.yml"]
  const modernConfig = (
    await Promise.all(configNames.map((name) => ordinaryFile(root, name)))
  ).some(Boolean)
  const legacyMarkers = await Promise.all(
    ["archetypes", "layouts", "themes"].map((name) => ordinaryDirectory(root, name)),
  )
  return (
    (await ordinaryDirectory(root, "content")) &&
    (modernConfig || ((await ordinaryFile(root, "config.toml")) && legacyMarkers.some(Boolean)))
  )
}

async function isHexo(root: string, manifest: Record<string, unknown> | undefined) {
  const dependencies = {
    ...record(manifest?.dependencies),
    ...record(manifest?.devDependencies),
  }
  return (
    typeof dependencies.hexo === "string" &&
    (await ordinaryFile(root, "_config.yml")) &&
    (await ordinaryDirectory(root, "source"))
  )
}

/** Read-only detection with deterministic precedence for roots containing mixed markers. */
export async function detectBlogFramework(rootInput: string): Promise<BlogFramework> {
  const root = await canonicalRoot(rootInput)
  if (root === undefined) return "unknown"
  const manifest = await readPackage(root)
  if (await isQuartz(root, manifest)) return "quartz"
  if (await isHugo(root)) return "hugo"
  if (await isHexo(root, manifest)) return "hexo"
  return "unknown"
}

class UnsupportedAppearanceAdapter implements AppearanceAdapter {
  constructor(readonly framework: BlogFramework) {}

  async read(): Promise<AppearanceSnapshot> {
    const label =
      this.framework === "unknown"
        ? "This blog framework is not recognized or supported."
        : `${this.framework === "hugo" ? "Hugo" : "Hexo"} appearance support is not installed.`
    return {
      framework: this.framework,
      supported: false,
      settings: DEFAULT_APPEARANCE,
      baselineHash: createHash("sha256").update(`unsupported:${this.framework}`).digest("hex"),
      canUndo: false,
      message: label,
    }
  }

  async plan(): Promise<AppearancePlan> {
    throw {
      code: "APPEARANCE_UNSUPPORTED",
      message: "This blog framework does not have an appearance adapter.",
    } satisfies AppError
  }
}

export async function createAppearanceAdapter(root: string): Promise<AppearanceAdapter> {
  const framework = await detectBlogFramework(root)
  return framework === "quartz"
    ? new QuartzAppearanceAdapter(root)
    : new UnsupportedAppearanceAdapter(framework)
}
