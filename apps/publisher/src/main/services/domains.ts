import { constants, type BigIntStats } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import matter from "gray-matter"
import type {
  DomainCreateRequest,
  DomainRemoveRequest,
  DomainRenameRequest,
  DomainSlug,
  DomainSummary,
  SerializableValue,
} from "../../shared/contracts"
import { domainNameSchema, domainSlugSchema, domainSummarySchema } from "../../shared/ipcSchemas"

const LEGACY_DOMAIN_ORDER = Number.MAX_SAFE_INTEGER

const grayMatterWithEngines = matter as typeof matter & {
  readonly engines: {
    readonly yaml: {
      readonly parse: (input: string) => Record<string, unknown>
    }
  }
}

const SAFE_MATTER_OPTIONS = {
  language: "yaml",
  engines: {
    yaml: {
      parse: grayMatterWithEngines.engines.yaml.parse,
    },
  },
} satisfies Parameters<typeof matter>[1]

type DomainDiscoveryCode = "DOMAIN_METADATA_INVALID" | "DOMAIN_UNSAFE_PATH"

interface DomainDiscoveryError {
  readonly code: DomainDiscoveryCode
  readonly message: string
  readonly details: Readonly<Record<string, SerializableValue>>
}

interface ManagedRoot {
  readonly name: "content" | "private"
  readonly directory: string
  readonly identity: FileIdentity
}

interface CanonicalWorkspace {
  readonly directory: string
  readonly identity: FileIdentity
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

interface DiscoveredDomain {
  readonly summary: DomainSummary
  readonly hasExplicitOrder: boolean
}

interface DiscoverDomainsOptions {
  /** Test seam for deterministically exercising a post-read file mutation. */
  readonly afterIndexRead?: (path: string) => Promise<void> | void
  /** Test seam for deterministically exercising an ancestor-swap race. */
  readonly afterCountReaddir?: (path: string) => Promise<void> | void
  /** Test seam for holding one count while another managed path changes. */
  readonly afterCountComplete?: (path: string) => Promise<void> | void
}

export interface DomainCatalog {
  list(): Promise<readonly DomainSummary[]>
  require(slug: DomainSlug): Promise<DomainSummary>
  create(request: DomainCreateRequest): Promise<readonly DomainSummary[]>
  rename(request: DomainRenameRequest): Promise<readonly DomainSummary[]>
  remove(request: DomainRemoveRequest): Promise<readonly DomainSummary[]>
  assertIdle(): Promise<void>
  dispose(): Promise<void>
}

function toForwardSlashes(path: string): string {
  return path.replaceAll("\\", "/")
}

function displayPath(workspace: string, candidate: string): string {
  const path = toForwardSlashes(relative(workspace, candidate))
  return path || "."
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference))
}

function domainError(
  code: DomainDiscoveryCode,
  message: string,
  path: string,
): DomainDiscoveryError {
  return { code, message, details: { path } }
}

function unsafePath(path: string): DomainDiscoveryError {
  return domainError("DOMAIN_UNSAFE_PATH", "A linked or unstable domain path was rejected.", path)
}

function invalidMetadata(path: string): DomainDiscoveryError {
  return domainError("DOMAIN_METADATA_INVALID", "A marked domain page has invalid metadata.", path)
}

function isDomainDiscoveryError(error: unknown): error is DomainDiscoveryError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "DOMAIN_UNSAFE_PATH" ||
      (error as { code?: unknown }).code === "DOMAIN_METADATA_INVALID")
  )
}

function fileIdentity(details: BigIntStats): FileIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function canonicalWorkspace(workspacePath: string): Promise<CanonicalWorkspace> {
  const requested = resolve(workspacePath)
  try {
    const canonical = await realpath(requested)
    const details = await lstat(canonical, { bigint: true })
    if (details.isSymbolicLink() || !details.isDirectory()) throw unsafePath(".")
    if (!pathsEqual(canonical, await realpath(canonical))) throw unsafePath(".")
    return { directory: canonical, identity: fileIdentity(details) }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(".")
  }
}

async function canonicalManagedRoot(
  workspace: string,
  name: ManagedRoot["name"],
): Promise<ManagedRoot> {
  const candidate = resolve(workspace, name)
  const path = displayPath(workspace, candidate)
  try {
    const details = await lstat(candidate, { bigint: true })
    if (details.isSymbolicLink() || !details.isDirectory()) throw unsafePath(path)
    const canonical = await realpath(candidate)
    if (!isInside(workspace, canonical) || !pathsEqual(candidate, canonical)) throw unsafePath(path)
    const after = await lstat(candidate, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameFileIdentity(fileIdentity(details), fileIdentity(after))
    ) {
      throw unsafePath(path)
    }
    return { name, directory: canonical, identity: fileIdentity(after) }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(path)
  }
}

async function canonicalDirectory(
  workspace: string,
  managedRoot: ManagedRoot,
  candidate: string,
  missingIsEmpty: boolean,
): Promise<string | undefined> {
  const path = displayPath(workspace, candidate)
  try {
    const details = await lstat(candidate)
    if (details.isSymbolicLink() || !details.isDirectory()) throw unsafePath(path)
    const canonical = await realpath(candidate)
    if (!isInside(managedRoot.directory, canonical) || !pathsEqual(candidate, canonical)) {
      throw unsafePath(path)
    }
    return canonical
  } catch (error) {
    if (
      missingIsEmpty &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined
    }
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(path)
  }
}

async function readDomainPage(
  workspace: string,
  managedRoot: ManagedRoot,
  candidateDirectory: string,
  options: DiscoverDomainsOptions,
): Promise<{ readonly path: string; readonly source: string } | undefined> {
  const candidate = resolve(candidateDirectory, "index.md")
  const path = displayPath(workspace, candidate)
  let before: BigIntStats
  let canonicalFile: string
  try {
    before = await lstat(candidate, { bigint: true })
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined
    }
    throw unsafePath(path)
  }
  if (before.isSymbolicLink() || !before.isFile()) throw unsafePath(path)
  try {
    canonicalFile = await realpath(candidate)
  } catch {
    throw unsafePath(path)
  }
  if (!isInside(managedRoot.directory, canonicalFile) || !pathsEqual(candidate, canonicalFile)) {
    throw unsafePath(path)
  }

  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
  let handle
  try {
    handle = await open(candidate, flags)
  } catch {
    throw unsafePath(path)
  }
  try {
    const expected = fileIdentity(before)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileIdentity(expected, fileIdentity(opened))) {
      throw unsafePath(path)
    }
    const source = await handle.readFile({ encoding: "utf8" })
    await options.afterIndexRead?.(path)
    const afterHandle = await handle.stat({ bigint: true })
    const afterPath = await lstat(candidate, { bigint: true })
    const afterCanonical = await realpath(candidate)
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileIdentity(expected, fileIdentity(afterHandle)) ||
      !sameFileIdentity(expected, fileIdentity(afterPath)) ||
      !pathsEqual(canonicalFile, afterCanonical)
    ) {
      throw unsafePath(path)
    }
    return { path, source }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(path)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function countDirectMarkdown(
  workspace: string,
  managedRoot: ManagedRoot,
  slug: DomainSlug,
  options: DiscoverDomainsOptions,
): Promise<number> {
  const requested = resolve(managedRoot.directory, slug)
  const directory = await canonicalDirectory(workspace, managedRoot, requested, true)
  if (directory === undefined) return 0

  const directoryPath = displayPath(workspace, directory)
  let expectedDirectoryIdentity: FileIdentity
  try {
    const before = await lstat(directory, { bigint: true })
    const canonical = await realpath(directory)
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      !isInside(managedRoot.directory, canonical) ||
      !pathsEqual(directory, canonical)
    ) {
      throw unsafePath(directoryPath)
    }
    expectedDirectoryIdentity = fileIdentity(before)
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(directoryPath)
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    throw unsafePath(directoryPath)
  }
  await options.afterCountReaddir?.(directory)

  let count = 0
  for (const entry of entries) {
    const candidate = resolve(directory, entry.name)
    const path = displayPath(workspace, candidate)
    let before: BigIntStats
    let after: BigIntStats
    let canonical: string
    try {
      before = await lstat(candidate, { bigint: true })
      if (before.isSymbolicLink()) throw unsafePath(path)
      canonical = await realpath(candidate)
      after = await lstat(candidate, { bigint: true })
    } catch (error) {
      if (isDomainDiscoveryError(error)) throw error
      throw unsafePath(path)
    }
    if (
      after.isSymbolicLink() ||
      !isInside(directory, canonical) ||
      !pathsEqual(candidate, canonical) ||
      !sameFileIdentity(fileIdentity(before), fileIdentity(after))
    ) {
      throw unsafePath(path)
    }
    if (entry.name !== "index.md" && entry.name.endsWith(".md") && after.isFile()) count += 1
  }

  try {
    const after = await lstat(directory, { bigint: true })
    const canonical = await realpath(directory)
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameFileIdentity(expectedDirectoryIdentity, fileIdentity(after)) ||
      !pathsEqual(directory, canonical)
    ) {
      throw unsafePath(directoryPath)
    }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(directoryPath)
  }
  await options.afterCountComplete?.(directory)
  return count
}

type GardenDomainMarker = "true" | "false" | "absent" | "ambiguous"

interface SafeYamlSource {
  readonly source: string
  readonly hasFrontmatter: boolean
  readonly supported: boolean
}

function normalizeSafeYamlSource(source: string): SafeYamlSource {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source
  const delimiter = "---"
  if (!normalized.startsWith(delimiter) || normalized[delimiter.length] === "-") {
    return { source: normalized, hasFrontmatter: false, supported: true }
  }

  let remainder = normalized.slice(delimiter.length)
  const lineBreak = remainder.search(/\r?\n/)
  if (lineBreak < 0) return { source: normalized, hasFrontmatter: false, supported: true }
  const language = remainder.slice(0, lineBreak).trim()
  if (language !== "" && !/^(?:yaml|yml)$/i.test(language)) {
    return { source: normalized, hasFrontmatter: true, supported: false }
  }

  return {
    source: `${delimiter}${normalized.slice(delimiter.length + lineBreak)}`,
    hasFrontmatter: true,
    supported: true,
  }
}

function grayMatterYamlBlock(source: string): string | undefined {
  const normalized = normalizeSafeYamlSource(source)
  if (!normalized.hasFrontmatter || !normalized.supported) return undefined

  const remainder = normalized.source.slice("---".length)
  const closeIndex = remainder.indexOf(`\n---`)
  return closeIndex < 0 ? remainder : remainder.slice(0, closeIndex)
}

function preclassifyGardenDomain(source: string): GardenDomainMarker {
  const frontmatter = grayMatterYamlBlock(source)
  if (frontmatter === undefined) return "absent"

  const lines = frontmatter.split(/\r?\n/)
  const declarations = lines.filter(
    (line) => line.trim() !== "" && !line.trimStart().startsWith("#"),
  )
  const commonIndent = declarations.reduce((minimum, line) => {
    const indentation = /^[ \t]*/.exec(line)?.[0].length ?? 0
    return Math.min(minimum, indentation)
  }, Number.POSITIVE_INFINITY)

  let sawTrue = false
  let sawFalse = false
  let sawAmbiguous = false
  for (const originalLine of lines) {
    const line = Number.isFinite(commonIndent) ? originalLine.slice(commonIndent) : originalLine
    const declaration = /^(?:gardenDomain|'gardenDomain'|"gardenDomain")[ \t]*:(.*)$/.exec(line)
    if (!declaration) continue
    const value = /^[ \t]*(true|false)[ \t]*(?:#.*)?$/i.exec(declaration[1])?.[1].toLowerCase()
    if (value === "true") sawTrue = true
    else if (value === "false") sawFalse = true
    else sawAmbiguous = true
  }
  if (sawAmbiguous || (sawTrue && sawFalse)) return "ambiguous"
  if (sawTrue) return "true"
  return sawFalse ? "false" : "absent"
}

function parseDomainPage(
  page: { readonly path: string; readonly source: string },
  slug: string,
):
  | {
      readonly slug: DomainSlug
      readonly name: string
      readonly description: string
      readonly order: number
      readonly hasExplicitOrder: boolean
    }
  | undefined {
  const safeSource = normalizeSafeYamlSource(page.source)
  if (safeSource.hasFrontmatter && !safeSource.supported) throw invalidMetadata(page.path)

  let data: Record<string, unknown>
  try {
    const parsed = matter(safeSource.source, SAFE_MATTER_OPTIONS).data
    data =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
  } catch {
    const marker = preclassifyGardenDomain(page.source)
    if (marker === "true" || marker === "ambiguous") throw invalidMetadata(page.path)
    return undefined
  }

  if (data.gardenDomain !== true) return undefined

  const parsedSlug = domainSlugSchema.safeParse(slug)
  const parsedName = domainNameSchema.safeParse(data.title)
  const parsedDescription = domainSummarySchema.shape.description.safeParse(data.description)
  const hasExplicitOrder = data.domainOrder !== undefined
  const parsedOrder = domainSummarySchema.shape.order.safeParse(
    hasExplicitOrder ? data.domainOrder : LEGACY_DOMAIN_ORDER,
  )
  if (
    !parsedSlug.success ||
    !parsedName.success ||
    !parsedDescription.success ||
    !parsedOrder.success
  ) {
    throw invalidMetadata(page.path)
  }

  return {
    slug: parsedSlug.data,
    name: parsedName.data,
    description: parsedDescription.data,
    order: parsedOrder.data,
    hasExplicitOrder,
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDomains(left: DiscoveredDomain, right: DiscoveredDomain): number {
  if (left.hasExplicitOrder !== right.hasExplicitOrder) return left.hasExplicitOrder ? -1 : 1
  const order = left.summary.order - right.summary.order
  return order === 0 ? compareText(left.summary.slug, right.summary.slug) : order
}

async function revalidateBoundary(
  workspace: string,
  boundary: { readonly directory: string; readonly identity: FileIdentity },
): Promise<void> {
  const path = displayPath(workspace, boundary.directory)
  try {
    const details = await lstat(boundary.directory, { bigint: true })
    const canonical = await realpath(boundary.directory)
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !pathsEqual(boundary.directory, canonical) ||
      !sameFileIdentity(boundary.identity, fileIdentity(details))
    ) {
      throw unsafePath(path)
    }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(path)
  }
}

export async function discoverDomains(workspacePath: string): Promise<readonly DomainSummary[]>
export async function discoverDomains(
  workspacePath: string,
  options: DiscoverDomainsOptions = {},
): Promise<readonly DomainSummary[]> {
  const canonical = await canonicalWorkspace(workspacePath)
  const workspace = canonical.directory
  const content = await canonicalManagedRoot(workspace, "content")
  const privateRoot = await canonicalManagedRoot(workspace, "private")
  let entries
  try {
    entries = await readdir(content.directory, { withFileTypes: true })
  } catch {
    throw unsafePath("content")
  }
  entries.sort((left, right) => compareText(left.name, right.name))

  const domains: DiscoveredDomain[] = []
  for (const entry of entries) {
    const candidate = resolve(content.directory, entry.name)
    const path = displayPath(workspace, candidate)
    let details
    try {
      details = await lstat(candidate)
    } catch {
      throw unsafePath(path)
    }
    if (details.isSymbolicLink()) throw unsafePath(path)
    if (!details.isDirectory()) continue

    const candidateDirectory = await canonicalDirectory(workspace, content, candidate, false)
    if (candidateDirectory === undefined) throw unsafePath(path)
    const page = await readDomainPage(workspace, content, candidateDirectory, options)
    if (page === undefined) continue
    const metadata = parseDomainPage(page, entry.name)
    if (metadata === undefined) continue

    const [publicNotes, privateNotes] = await Promise.all([
      countDirectMarkdown(workspace, content, metadata.slug, options),
      countDirectMarkdown(workspace, privateRoot, metadata.slug, options),
    ])
    const summary = domainSummarySchema.parse({
      slug: metadata.slug,
      name: metadata.name,
      description: metadata.description,
      order: metadata.order,
      publicNotes,
      privateNotes,
    })
    domains.push({ summary, hasExplicitOrder: metadata.hasExplicitOrder })
  }

  await Promise.all([
    revalidateBoundary(workspace, canonical),
    revalidateBoundary(workspace, content),
    revalidateBoundary(workspace, privateRoot),
  ])
  return domains.sort(compareDomains).map(({ summary }) => summary)
}

export async function discoverDomainSlugs(workspace: string): Promise<ReadonlySet<string>> {
  return new Set((await discoverDomains(workspace)).map(({ slug }) => slug))
}
