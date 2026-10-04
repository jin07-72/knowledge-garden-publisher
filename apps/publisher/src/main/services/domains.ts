import { constants, type BigIntStats } from "node:fs"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises"
import { isAbsolute, relative, resolve, win32 } from "node:path"
import matter from "gray-matter"
import { isMap, isScalar, parseDocument, stringify as stringifyYaml } from "yaml"
import type {
  DomainCreateRequest,
  DomainRemoveRequest,
  DomainRenameRequest,
  DomainSlug,
  DomainSummary,
  SerializableValue,
  TrashAdapter,
} from "../../shared/contracts"
import {
  domainCreateSchema,
  domainNameSchema,
  domainRemoveSchema,
  domainRenameSchema,
  domainSlugSchema,
  domainSummarySchema,
} from "../../shared/ipcSchemas"

const LEGACY_DOMAIN_ORDER = Number.MAX_SAFE_INTEGER
const DOMAIN_RENAME_TRANSACTION_DIRECTORY = "domain-rename-transactions"
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const grayMatterWithEngines = matter as typeof matter & {
  readonly engines: {
    readonly yaml: {
      readonly parse: (input: string) => Record<string, unknown>
      readonly stringify: (data: object) => string
    }
  }
}

const SAFE_MATTER_OPTIONS = {
  language: "yaml",
  engines: {
    yaml: {
      parse: grayMatterWithEngines.engines.yaml.parse,
      stringify: grayMatterWithEngines.engines.yaml.stringify,
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

interface SerializedFileIdentity {
  readonly dev: string
  readonly ino: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

interface DomainRenameEvidence {
  readonly identity: SerializedFileIdentity
  readonly contentHash: string
}

type DomainRenamePhase = "prepared" | "quarantined" | "published"

interface DomainRenameJournal {
  readonly version: 1
  readonly id: string
  readonly phase: DomainRenamePhase
  readonly target: string
  readonly temporary: string
  readonly backup: string
  readonly quarantine: string
  readonly intendedTitle: string
  readonly original: DomainRenameEvidence
  readonly published: DomainRenameEvidence
}

interface DomainRenameJournalRecord {
  readonly journal: DomainRenameJournal
  readonly directory: string
  readonly directoryIdentity: string
  readonly transactions: string
  readonly transactionsIdentity: string
  readonly journalPath: string
  readonly journalIdentity: FileIdentity
  readonly journalBytes: Buffer
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

interface DomainFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>
  sync(): Promise<void>
  stat(options: { readonly bigint: true }): Promise<BigIntStats>
  close(): Promise<void>
}

interface DomainCatalogFileSystem {
  readonly open?: (path: string, flags: "r" | "wx", mode?: number) => Promise<DomainFileHandle>
  readonly mkdir?: typeof mkdir
  readonly rename?: typeof rename
  readonly link?: typeof link
  readonly replaceFile?: (replacement: string, replaced: string, backup: string) => Promise<void>
  readonly spawn?: typeof spawn
  readonly replaceFileTimeoutMs?: number
}

interface DomainCatalogHooks {
  readonly afterRenameRead?: (path: string) => Promise<void> | void
  readonly afterRemoveInspection?: (path: string) => Promise<void> | void
}

export interface DomainCatalogOptions {
  readonly workspace: string
  readonly trash: TrashAdapter
  readonly now?: () => Date
  readonly uuid?: () => string
  readonly fileSystem?: DomainCatalogFileSystem
  readonly hooks?: DomainCatalogHooks
}

type DomainCatalogErrorCode =
  | "DOMAIN_ALREADY_EXISTS"
  | "DOMAIN_BUSY"
  | "DOMAIN_DISPOSED"
  | "DOMAIN_NOT_FOUND"
  | "DOMAIN_NOT_EMPTY"
  | "DOMAIN_ORDER_EXHAUSTED"
  | "DOMAIN_ROLLBACK_UNCERTAIN"

class DomainCatalogError extends Error {
  constructor(
    readonly code: DomainCatalogErrorCode,
    message: string,
    readonly details: Readonly<Record<string, SerializableValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DomainCatalogError"
  }
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

function sameStableFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  )
}

function serializeFileIdentity(identity: FileIdentity): SerializedFileIdentity {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  }
}

function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function renameEvidence(identity: FileIdentity, bytes: Buffer): DomainRenameEvidence {
  return { identity: serializeFileIdentity(identity), contentHash: contentHash(bytes) }
}

function matchesRenameEvidence(
  file: { readonly bytes: Buffer; readonly identity: FileIdentity },
  evidence: DomainRenameEvidence,
): boolean {
  return (
    file.identity.dev.toString() === evidence.identity.dev &&
    file.identity.ino.toString() === evidence.identity.ino &&
    file.identity.size.toString() === evidence.identity.size &&
    file.identity.mtimeNs.toString() === evidence.identity.mtimeNs &&
    contentHash(file.bytes) === evidence.contentHash
  )
}

function isSerializedFileIdentity(value: unknown): value is SerializedFileIdentity {
  if (typeof value !== "object" || value === null) return false
  const identity = value as Record<string, unknown>
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => typeof identity[key] === "string" && /^\d+$/.test(identity[key]),
  )
}

function isRenameEvidence(value: unknown): value is DomainRenameEvidence {
  if (typeof value !== "object" || value === null) return false
  const evidence = value as Record<string, unknown>
  return (
    isSerializedFileIdentity(evidence.identity) &&
    typeof evidence.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(evidence.contentHash)
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
): Promise<
  | {
      readonly path: string
      readonly source: string
      readonly identity: FileIdentity
      readonly mode: number
    }
  | undefined
> {
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
    return { path, source, identity: expected, mode: Number(opened.mode) }
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

function replaceTitleScalar(source: string, title: string, path: string): string {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:(?:yaml|yml)[ \t]*)?\r?\n/i.exec(source)
  if (opening === null) throw invalidMetadata(path)
  const yamlStart = opening[0].length
  const closing = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(source.slice(yamlStart))
  if (closing === null) throw invalidMetadata(path)
  const delimiterPrefix = /^(?:\r\n|\n)/.exec(closing[0])?.[0] ?? ""
  const yamlEnd = yamlStart + closing.index + delimiterPrefix.length
  const yaml = source.slice(yamlStart, yamlEnd)
  const document = parseDocument(yaml, { keepSourceTokens: true })
  if (document.errors.length > 0 || !isMap(document.contents)) throw invalidMetadata(path)
  const titlePairs = document.contents.items.filter(
    (pair) => isScalar(pair.key) && pair.key.value === "title",
  )
  if (titlePairs.length !== 1) throw invalidMetadata(path)
  const value = titlePairs[0].value
  if (
    !isScalar(value) ||
    typeof value.value !== "string" ||
    value.range === undefined ||
    value.range === null ||
    value.anchor !== undefined ||
    value.tag !== undefined ||
    !["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE", "BLOCK_LITERAL", "BLOCK_FOLDED"].includes(
      value.type ?? "",
    )
  ) {
    throw invalidMetadata(path)
  }
  const [start, end] = value.range
  let replacement: string
  if (value.type === "QUOTE_SINGLE") replacement = `'${title.replaceAll("'", "''")}'`
  else if (value.type === "QUOTE_DOUBLE") replacement = JSON.stringify(title)
  else {
    replacement = stringifyYaml(title).trimEnd()
    if (replacement.includes("\n") || replacement.includes("\r")) throw invalidMetadata(path)
    if (value.type === "BLOCK_LITERAL" || value.type === "BLOCK_FOLDED") {
      const rawBlock = yaml.slice(start, end)
      const headerEnd = rawBlock.indexOf("\n")
      if (headerEnd < 0) throw invalidMetadata(path)
      const header = rawBlock.slice(0, headerEnd).replace(/\r$/, "")
      const comment = /([ \t]+#.*)$/.exec(header)?.[1] ?? ""
      const trailingLineBreak = /(\r\n|\n)$/.exec(rawBlock)?.[1]
      if (trailingLineBreak === undefined) throw invalidMetadata(path)
      replacement += `${comment}${trailingLineBreak}`
    }
  }
  return `${source.slice(0, yamlStart + start)}${replacement}${source.slice(yamlStart + end)}`
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

async function revalidateMutatedBoundary(
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
      inodeIdentity(details) !== inodeIdentity(boundary.identity)
    ) {
      throw unsafePath(path)
    }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(path)
  }
}

async function revalidateMutationBoundaries(
  workspace: string,
  boundaries: readonly { readonly directory: string; readonly identity: FileIdentity }[],
): Promise<void> {
  await Promise.all(boundaries.map((boundary) => revalidateMutatedBoundary(workspace, boundary)))
}

async function discoverDomainEntries(
  workspacePath: string,
  options: DiscoverDomainsOptions = {},
): Promise<readonly DiscoveredDomain[]> {
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
  return domains.sort(compareDomains)
}

export async function discoverDomains(workspacePath: string): Promise<readonly DomainSummary[]>
export async function discoverDomains(
  workspacePath: string,
  options: DiscoverDomainsOptions = {},
): Promise<readonly DomainSummary[]> {
  return (await discoverDomainEntries(workspacePath, options)).map(({ summary }) => summary)
}

export async function discoverDomainSlugs(workspace: string): Promise<ReadonlySet<string>> {
  return new Set((await discoverDomains(workspace)).map(({ slug }) => slug))
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  )
}

const REPLACE_FILE_TIMEOUT_MS = 30_000
const REPLACE_FILE_TERMINATION_GRACE_MS = 5_000
const REPLACE_FILE_ERROR_SENTINEL = "KGP_REPLACE_FILE_ERROR:"

export function parseReplaceFileDiagnostic(
  output: string,
): { readonly code: number; readonly message: string } | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = new RegExp(`^${REPLACE_FILE_ERROR_SENTINEL}(\\d+):([A-Za-z0-9+/=]+)$`).exec(
      line.trim(),
    )
    if (match === null) continue
    const code = Number(match[1])
    if (!Number.isSafeInteger(code)) continue
    try {
      return { code, message: Buffer.from(match[2], "base64").toString("utf8") }
    } catch {
      continue
    }
  }
  return undefined
}

export function nativeWindowsPath(pathValue: string, name: string): string {
  const normalized = pathValue.replaceAll("/", "\\")
  if (!win32.isAbsolute(normalized)) {
    throw new Error(`Atomic file replacement requires an absolute ${name} path`)
  }
  const extendedPrefix = "\\\\?\\"
  const isDrivePath = (value: string): boolean => /^[A-Za-z]:\\/.test(value)
  const isUncPath = (value: string): boolean => {
    const parts = value.split("\\")
    return parts.length >= 3 && parts[0].length > 0 && parts[1].length > 0 && parts[2].length > 0
  }
  if (normalized.startsWith(extendedPrefix)) {
    const rest = normalized.slice(extendedPrefix.length)
    if (isDrivePath(rest) || (rest.toUpperCase().startsWith("UNC\\") && isUncPath(rest.slice(4)))) {
      return normalized
    }
    throw new Error(`Unsupported Windows device namespace in ${name} path`)
  }
  if (normalized.startsWith("\\\\.\\") || normalized.startsWith("\\??\\")) {
    throw new Error(`Unsupported Windows device namespace in ${name} path`)
  }
  if (normalized.startsWith("\\\\")) {
    const unc = normalized.slice(2)
    if (!isUncPath(unc)) throw new Error(`Invalid absolute UNC ${name} path`)
    return `${extendedPrefix}UNC\\${unc}`
  }
  if (isDrivePath(normalized)) return `${extendedPrefix}${normalized}`
  throw new Error(`Unsupported absolute Windows ${name} path`)
}

async function replaceFileWithBackup(
  replacement: string,
  replaced: string,
  backup: string,
  fallbackLink: typeof link = link,
  fallbackRename: typeof rename = rename,
  spawnEntry: typeof spawn = spawn,
  timeoutMs = REPLACE_FILE_TIMEOUT_MS,
): Promise<void> {
  if (process.platform !== "win32") {
    await fallbackLink(replaced, backup)
    await fallbackRename(replacement, replaced)
    return
  }
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for atomic file replacement")
  }
  const nativeReplacement = nativeWindowsPath(replacement, "replacement")
  const nativeReplaced = nativeWindowsPath(replaced, "replaced")
  const nativeBackup = nativeWindowsPath(backup, "backup")
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Write-ReplaceError([int] $code, [string] $message) {
  if ([string]::IsNullOrWhiteSpace($message)) { $message = 'ReplaceFileW failed' }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message))
  [Console]::WriteLine(('KGP_REPLACE_FILE_ERROR:{0}:{1}' -f $code, $encoded))
}
function Get-RequiredAbsolutePath([string] $name) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^(?:[A-Za-z]:\\\\|\\\\\\\\)') {
    throw "Missing or non-absolute $name environment value"
  }
  return $value
}
try {
  $replaced = Get-RequiredAbsolutePath 'KGP_REPLACED'
  $replacement = Get-RequiredAbsolutePath 'KGP_REPLACEMENT'
  $backup = Get-RequiredAbsolutePath 'KGP_BACKUP'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GardenPublisherNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ReplaceFileW(
    string replacedFileName,
    string replacementFileName,
    string backupFileName,
    uint replaceFlags,
    IntPtr exclude,
    IntPtr reserved);
}
'@
  if (-not [GardenPublisherNative]::ReplaceFileW($replaced, $replacement, $backup, 0, [IntPtr]::Zero, [IntPtr]::Zero)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $message = [System.ComponentModel.Win32Exception]::new($code).Message
    Write-ReplaceError $code $message
    exit 1
  }
} catch {
  Write-ReplaceError 1 $_.Exception.Message
  exit 1
}
`
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64")
  const executable = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!isAbsolute(executable)) {
    throw new Error("Windows PowerShell path is not absolute")
  }
  await new Promise<void>((resolveProcess, rejectProcess) => {
    for (const [name, value] of [
      ["KGP_REPLACED", replaced],
      ["KGP_REPLACEMENT", replacement],
      ["KGP_BACKUP", backup],
    ] as const) {
      if (value.length === 0 || !isAbsolute(value)) {
        rejectProcess(new Error(`Atomic file replacement requires an absolute ${name} path`))
        return
      }
    }
    const environment = {
      ...process.env,
      KGP_REPLACED: nativeReplaced,
      KGP_REPLACEMENT: nativeReplacement,
      KGP_BACKUP: nativeBackup,
    }
    const child = spawnEntry(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = ""
    let stdout = ""
    let outputTruncated = false
    let settled = false
    let timedOut = false
    let childClosed = false
    let childError: unknown
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolveClose) => {
      resolveClosed = resolveClose
    })
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const appendOutput = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString()
      if (next.length <= 16_384) return next
      outputTruncated = true
      return next.slice(0, 16_384)
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.once("error", (error: unknown) => {
      if (timedOut) {
        childError = error
        return
      }
      if (settled) return
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      settled = true
      const failure = new Error("Windows PowerShell could not execute ReplaceFileW", {
        cause: error,
      })
      Object.assign(failure, { code: "WINDOWS_POWERSHELL_UNAVAILABLE" })
      rejectProcess(failure)
    })
    child.once("close", (code, signal) => {
      childClosed = true
      resolveClosed()
      if (settled) return
      if (timedOut) return
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      settled = true
      if (code === 0 && signal === null) {
        resolveProcess()
        return
      }
      const output = `${stderr}\n${stdout}`.trim()
      const diagnostic = parseReplaceFileDiagnostic(output)
      const win32Code = diagnostic?.code
      const win32Message = diagnostic?.message
      const failure = new Error(
        win32Message ||
          `ReplaceFileW exited with ${signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`}${outputTruncated ? " (output truncated)" : ""}`,
        {
          cause: {
            kind: "win32",
            code: win32Code,
            message: win32Message,
            signal,
            outputTruncated,
          },
        },
      )
      Object.assign(failure, { code: "WIN32_REPLACE_FILE_FAILED", win32Code })
      rejectProcess(failure)
    })
    const boundedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(1, timeoutMs)
      : REPLACE_FILE_TIMEOUT_MS
    timeoutHandle = setTimeout(() => {
      timedOut = true
      void (async () => {
        let terminationError: unknown = childError
        try {
          if (child.pid === undefined) {
            throw new Error("ReplaceFileW helper PID was unavailable for tree termination")
          }
          const killResult = child.kill()
          if (!killResult) {
            throw new Error("ReplaceFileW helper refused termination")
          }
          const taskkill = spawnEntry(
            resolve(systemRoot, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
          )
          await new Promise<void>((resolveTaskkill, rejectTaskkill) => {
            let taskkillSettled = false
            const taskkillTimeout = setTimeout(() => {
              if (taskkillSettled) return
              taskkillSettled = true
              taskkill.kill()
              rejectTaskkill(new Error("taskkill timed out while terminating ReplaceFileW"))
            }, REPLACE_FILE_TERMINATION_GRACE_MS)
            taskkill.once("error", (error: unknown) => {
              if (taskkillSettled) return
              taskkillSettled = true
              clearTimeout(taskkillTimeout)
              rejectTaskkill(error)
            })
            taskkill.once("close", (taskkillCode, taskkillSignal) => {
              if (taskkillSettled) return
              taskkillSettled = true
              clearTimeout(taskkillTimeout)
              if (taskkillCode === 0 && taskkillSignal === null) resolveTaskkill()
              else rejectTaskkill(new Error("taskkill could not terminate ReplaceFileW"))
            })
          })
        } catch (error) {
          terminationError = error
        }
        if (terminationError === undefined && childError !== undefined) {
          terminationError = childError
        }
        if (!childClosed) {
          let graceHandle: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            closed,
            new Promise<void>((resolveGrace) => {
              graceHandle = setTimeout(resolveGrace, REPLACE_FILE_TERMINATION_GRACE_MS)
            }),
          ])
          if (graceHandle !== undefined) clearTimeout(graceHandle)
        }
        if (settled) return
        settled = true
        if (childClosed && terminationError === undefined) {
          rejectProcess(new Error(`ReplaceFileW timed out after ${timeoutMs}ms`))
        } else {
          rejectProcess(
            catalogError(
              "DOMAIN_ROLLBACK_UNCERTAIN",
              "ReplaceFileW termination could not be confirmed safely.",
              {},
              terminationError,
            ),
          )
        }
      })()
    }, boundedTimeoutMs)
  })
}

function inodeIdentity(details: { readonly dev: bigint; readonly ino: bigint }): string {
  return `${details.dev}:${details.ino}`
}

function shanghaiCalendarDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${value("year")}-${value("month")}-${value("day")}`
}

async function syncDirectory(
  directory: string,
  openFile: NonNullable<DomainCatalogFileSystem["open"]>,
): Promise<void> {
  let handle: DomainFileHandle | undefined
  try {
    handle = await openFile(directory, "r")
    await handle.sync()
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function pathEntry(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined
    throw error
  }
}

async function removeOwnedFile(
  path: string,
  parent: string,
  expectedIdentity: FileIdentity,
  expectedBytes: Buffer,
): Promise<void> {
  const current = await readOwnedBytes(path, parent, inodeIdentity(expectedIdentity))
  if (
    current === undefined ||
    !sameFileIdentity(current.identity, expectedIdentity) ||
    !current.bytes.equals(expectedBytes)
  ) {
    throw new Error(`Created file identity is no longer owned: ${path}`)
  }
  await unlink(path)
}

async function removeOwnedEmptyDirectory(path: string, expectedIdentity: string): Promise<void> {
  const details = await pathEntry(path)
  if (
    details === undefined ||
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    inodeIdentity(details) !== expectedIdentity ||
    (await readdir(path)).length !== 0
  ) {
    throw new Error(`Created directory identity is no longer empty and owned: ${path}`)
  }
  await rmdir(path)
}

async function readOwnedBytes(
  path: string,
  parent: string,
  expectedInode?: string,
): Promise<
  { readonly bytes: Buffer; readonly inode: string; readonly identity: FileIdentity } | undefined
> {
  let handle
  try {
    const before = await lstat(path, { bigint: true })
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (expectedInode !== undefined && inodeIdentity(before) !== expectedInode) ||
      !pathsEqual(path, await realpath(path)) ||
      !isInside(parent, path)
    ) {
      return undefined
    }
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(path, flags)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileIdentity(fileIdentity(before), fileIdentity(opened))) {
      return undefined
    }
    const bytes = await handle.readFile()
    const after = await lstat(path, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameFileIdentity(fileIdentity(opened), fileIdentity(after)) ||
      !pathsEqual(path, await realpath(path))
    ) {
      return undefined
    }
    return { bytes, inode: inodeIdentity(after), identity: fileIdentity(after) }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertExactFileIdentity(
  workspace: string,
  path: string,
  expected: FileIdentity,
): Promise<void> {
  try {
    const details = await lstat(path, { bigint: true })
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      !sameFileIdentity(expected, fileIdentity(details)) ||
      !pathsEqual(path, await realpath(path))
    ) {
      throw unsafePath(displayPath(workspace, path))
    }
  } catch (error) {
    if (isDomainDiscoveryError(error)) throw error
    throw unsafePath(displayPath(workspace, path))
  }
}

function catalogError(
  code: DomainCatalogErrorCode,
  message: string,
  details: Readonly<Record<string, SerializableValue>> = {},
  cause?: unknown,
): DomainCatalogError {
  return new DomainCatalogError(code, message, details, cause === undefined ? undefined : { cause })
}

function nameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("zh-CN")
}

export function createDomainCatalog(options: DomainCatalogOptions): DomainCatalog {
  if (typeof options.trash?.trashItem !== "function") {
    throw new TypeError("A Recycle Bin adapter is required.")
  }
  const now = options.now ?? (() => new Date())
  const uuid = options.uuid ?? randomUUID
  const openFile =
    options.fileSystem?.open ?? (open as NonNullable<DomainCatalogFileSystem["open"]>)
  const createDirectory = options.fileSystem?.mkdir ?? mkdir
  const renameEntry = options.fileSystem?.rename ?? rename
  const linkEntry = options.fileSystem?.link ?? link
  const replaceFileEntry =
    options.fileSystem?.replaceFile ??
    ((replacement: string, replaced: string, backup: string) =>
      replaceFileWithBackup(
        replacement,
        replaced,
        backup,
        linkEntry,
        renameEntry,
        options.fileSystem?.spawn ?? spawn,
        options.fileSystem?.replaceFileTimeoutMs ?? REPLACE_FILE_TIMEOUT_MS,
      ))
  let queue: Promise<void> = Promise.resolve()
  let pendingMutations = 0
  let disposed = false
  let blocked: unknown
  let disposal: Promise<void> | undefined
  const acceptedOperations = new Set<Promise<unknown>>()

  const unavailable = (): unknown =>
    blocked ??
    catalogError("DOMAIN_DISPOSED", "The domain catalog has been disposed and cannot be used.")

  function trackAccepted<T>(operation: Promise<T>): Promise<T> {
    acceptedOperations.add(operation)
    void operation.then(
      () => acceptedOperations.delete(operation),
      () => acceptedOperations.delete(operation),
    )
    return operation
  }

  function mutation<T>(operation: () => Promise<T>): Promise<T> {
    if (disposed || blocked !== undefined) return Promise.reject(unavailable())
    pendingMutations += 1
    const result = queue.then(() => {
      if (blocked !== undefined) throw blocked
      return operation()
    })
    const settled = result.then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof DomainCatalogError && error.code === "DOMAIN_ROLLBACK_UNCERTAIN") {
          blocked = error
        }
      },
    )
    queue = settled.finally(() => {
      pendingMutations -= 1
    })
    return trackAccepted(result)
  }

  function observation<T>(operation: () => Promise<T>): Promise<T> {
    if (disposed || blocked !== undefined) return Promise.reject(unavailable())
    return trackAccepted(
      queue.then(() => {
        if (blocked !== undefined) throw blocked
        return operation()
      }),
    )
  }

  pendingMutations += 1
  queue = trackAccepted(
    recoverDomainRenameTransactions()
      .catch((error: unknown) => {
        blocked =
          error instanceof DomainCatalogError && error.code === "DOMAIN_ROLLBACK_UNCERTAIN"
            ? error
            : catalogError(
                "DOMAIN_ROLLBACK_UNCERTAIN",
                "An incomplete domain rename could not be recovered safely.",
                { path: `.garden-publisher/${DOMAIN_RENAME_TRANSACTION_DIRECTORY}` },
                error,
              )
      })
      .finally(() => {
        pendingMutations -= 1
      }),
  )

  async function rollbackCreate(
    workspace: string,
    canonical: CanonicalWorkspace,
    roots: readonly ManagedRoot[],
    created: {
      readonly publicDirectory: string
      readonly publicDirectoryIdentity?: string
      readonly index: string
      readonly indexIdentity?: FileIdentity
      readonly indexBytes?: Buffer
      readonly privateDirectory: string
      readonly privateDirectoryIdentity?: string
    },
    primary: unknown,
  ): Promise<never> {
    const failures: unknown[] = []
    const boundaries = [canonical, ...roots]
    try {
      await revalidateMutationBoundaries(workspace, boundaries)
    } catch (error) {
      throw catalogError(
        "DOMAIN_ROLLBACK_UNCERTAIN",
        "Domain creation failed and rollback could not be confirmed.",
        { path: displayPath(workspace, created.publicDirectory) },
        new AggregateError([primary, error], "Domain creation rollback roots changed"),
      )
    }
    if (created.privateDirectoryIdentity !== undefined) {
      await removeOwnedEmptyDirectory(
        created.privateDirectory,
        created.privateDirectoryIdentity,
      ).catch((error: unknown) => failures.push(error))
    }
    if (created.indexIdentity !== undefined && created.indexBytes !== undefined) {
      await removeOwnedFile(
        created.index,
        created.publicDirectory,
        created.indexIdentity,
        created.indexBytes,
      ).catch((error: unknown) => failures.push(error))
    }
    if (created.publicDirectoryIdentity !== undefined) {
      await removeOwnedEmptyDirectory(
        created.publicDirectory,
        created.publicDirectoryIdentity,
      ).catch((error: unknown) => failures.push(error))
    }
    for (const root of roots) {
      await syncDirectory(root.directory, openFile).catch((error: unknown) => failures.push(error))
    }
    await revalidateMutationBoundaries(workspace, boundaries).catch((error: unknown) =>
      failures.push(error),
    )
    if (failures.length > 0) {
      throw catalogError(
        "DOMAIN_ROLLBACK_UNCERTAIN",
        "Domain creation failed and rollback could not be confirmed.",
        { path: displayPath(workspace, created.publicDirectory) },
        new AggregateError([primary, ...failures], "Domain creation rollback failed"),
      )
    }
    throw primary
  }

  async function create(request: DomainCreateRequest): Promise<readonly DomainSummary[]> {
    const input = domainCreateSchema.parse(request)
    const canonical = await canonicalWorkspace(options.workspace)
    const content = await canonicalManagedRoot(canonical.directory, "content")
    const privateRoot = await canonicalManagedRoot(canonical.directory, "private")
    const discoveredDomains = await discoverDomainEntries(canonical.directory)
    const domains = discoveredDomains.map(({ summary }) => summary)
    if (
      domains.some(
        (domain) => domain.slug === input.slug || nameKey(domain.name) === nameKey(input.name),
      )
    ) {
      throw catalogError(
        "DOMAIN_ALREADY_EXISTS",
        "A domain with the same slug or display name already exists.",
        { slug: input.slug, name: input.name },
      )
    }
    const maximumOrder = discoveredDomains.reduce(
      (maximum, domain) =>
        domain.hasExplicitOrder ? Math.max(maximum, domain.summary.order) : maximum,
      0,
    )
    if (!Number.isSafeInteger(maximumOrder) || maximumOrder >= Number.MAX_SAFE_INTEGER) {
      throw catalogError("DOMAIN_ORDER_EXHAUSTED", "No safe domain order remains for a new domain.")
    }
    const nextOrder = maximumOrder + 1
    const publicDirectory = resolve(content.directory, input.slug)
    const privateDirectory = resolve(privateRoot.directory, input.slug)
    const index = resolve(publicDirectory, "index.md")
    for (const candidate of [publicDirectory, privateDirectory]) {
      const existing = await pathEntry(candidate)
      if (existing === undefined) continue
      if (existing.isSymbolicLink()) throw unsafePath(displayPath(canonical.directory, candidate))
      throw catalogError(
        "DOMAIN_ALREADY_EXISTS",
        "A file or directory already occupies the requested domain path.",
        { path: displayPath(canonical.directory, candidate) },
      )
    }
    await Promise.all([
      revalidateBoundary(canonical.directory, canonical),
      revalidateBoundary(canonical.directory, content),
      revalidateBoundary(canonical.directory, privateRoot),
    ])

    let publicDirectoryIdentity: string | undefined
    let indexInode: string | undefined
    let indexFingerprint: FileIdentity | undefined
    let indexBytes: Buffer | undefined
    let privateDirectoryIdentity: string | undefined
    let expectedLanding: Buffer | undefined
    let handle: DomainFileHandle | undefined
    try {
      await createDirectory(publicDirectory, { mode: 0o700 })
      const publicDetails = await lstat(publicDirectory, { bigint: true })
      if (publicDetails.isSymbolicLink() || !publicDetails.isDirectory()) {
        throw unsafePath(displayPath(canonical.directory, publicDirectory))
      }
      publicDirectoryIdentity = inodeIdentity(publicDetails)

      const landing = matter.stringify(
        `\n这里用于整理${input.name}领域的学习记录。\n`,
        {
          title: input.name,
          date: shanghaiCalendarDate(now()),
          description: `${input.name}领域的学习记录。`,
          tags: [input.slug],
          gardenDomain: true,
          domainOrder: nextOrder,
        },
        SAFE_MATTER_OPTIONS,
      )
      expectedLanding = Buffer.from(landing, "utf8")
      handle = await openFile(index, "wx", 0o600)
      const indexDetails = await handle.stat({ bigint: true })
      if (!indexDetails.isFile()) throw unsafePath(displayPath(canonical.directory, index))
      indexInode = inodeIdentity(indexDetails)
      indexFingerprint = fileIdentity(indexDetails)
      indexBytes = Buffer.alloc(0)
      await handle.writeFile(expectedLanding)
      const writtenIndexDetails = await handle.stat({ bigint: true })
      if (!writtenIndexDetails.isFile() || inodeIdentity(writtenIndexDetails) !== indexInode) {
        throw unsafePath(displayPath(canonical.directory, index))
      }
      indexFingerprint = fileIdentity(writtenIndexDetails)
      indexBytes = expectedLanding
      await handle.sync()
      const syncedIndexDetails = await handle.stat({ bigint: true })
      if (!syncedIndexDetails.isFile() || inodeIdentity(syncedIndexDetails) !== indexInode) {
        throw unsafePath(displayPath(canonical.directory, index))
      }
      indexFingerprint = fileIdentity(syncedIndexDetails)
      await handle.close()
      handle = undefined

      await createDirectory(privateDirectory, { mode: 0o700 })
      const privateDetails = await lstat(privateDirectory, { bigint: true })
      if (privateDetails.isSymbolicLink() || !privateDetails.isDirectory()) {
        throw unsafePath(displayPath(canonical.directory, privateDirectory))
      }
      privateDirectoryIdentity = inodeIdentity(privateDetails)
      await Promise.all([
        syncDirectory(publicDirectory, openFile),
        syncDirectory(privateDirectory, openFile),
      ])
      await Promise.all([
        syncDirectory(content.directory, openFile),
        syncDirectory(privateRoot.directory, openFile),
      ])
      const [installedPublic, installedPrivate, installedLanding] = await Promise.all([
        pathEntry(publicDirectory),
        pathEntry(privateDirectory),
        readOwnedBytes(index, publicDirectory, indexInode),
      ])
      if (
        installedPublic === undefined ||
        installedPublic.isSymbolicLink() ||
        !installedPublic.isDirectory() ||
        inodeIdentity(installedPublic) !== publicDirectoryIdentity ||
        !pathsEqual(publicDirectory, await realpath(publicDirectory)) ||
        installedPrivate === undefined ||
        installedPrivate.isSymbolicLink() ||
        !installedPrivate.isDirectory() ||
        inodeIdentity(installedPrivate) !== privateDirectoryIdentity ||
        !pathsEqual(privateDirectory, await realpath(privateDirectory)) ||
        installedLanding === undefined ||
        indexFingerprint === undefined ||
        !sameFileIdentity(installedLanding.identity, indexFingerprint) ||
        expectedLanding === undefined ||
        !installedLanding.bytes.equals(expectedLanding)
      ) {
        throw unsafePath(displayPath(canonical.directory, publicDirectory))
      }
      await Promise.all([
        revalidateMutatedBoundary(canonical.directory, canonical),
        revalidateMutatedBoundary(canonical.directory, content),
        revalidateMutatedBoundary(canonical.directory, privateRoot),
      ])
      return await discoverDomains(canonical.directory)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (isFileSystemError(error, "EEXIST")) {
        error = catalogError(
          "DOMAIN_ALREADY_EXISTS",
          "A file or directory already occupies the requested domain path.",
          { slug: input.slug },
          error,
        )
      }
      return rollbackCreate(
        canonical.directory,
        canonical,
        [content, privateRoot],
        {
          publicDirectory,
          publicDirectoryIdentity,
          index,
          indexIdentity: indexFingerprint,
          indexBytes,
          privateDirectory,
          privateDirectoryIdentity,
        },
        error,
      )
    }
  }

  async function cleanupTemporary(path: string, identity: string | undefined): Promise<void> {
    const current = await pathEntry(path)
    if (current === undefined) return
    if (
      identity === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      inodeIdentity(current) !== identity
    ) {
      throw new Error(`Temporary file ownership changed: ${path}`)
    }
    await unlink(path)
  }

  function parseRenameJournal(
    workspace: string,
    transactionId: string,
    bytes: Buffer,
  ): DomainRenameJournal | undefined {
    if (bytes.length > 64 * 1024) return undefined
    let value: unknown
    try {
      value = JSON.parse(bytes.toString("utf8"))
    } catch {
      return undefined
    }
    if (typeof value !== "object" || value === null) return undefined
    const journal = value as Record<string, unknown>
    if (
      journal.version !== 1 ||
      journal.id !== transactionId ||
      !["prepared", "quarantined", "published"].includes(String(journal.phase)) ||
      typeof journal.target !== "string" ||
      typeof journal.temporary !== "string" ||
      typeof journal.backup !== "string" ||
      typeof journal.quarantine !== "string" ||
      typeof journal.intendedTitle !== "string" ||
      !isRenameEvidence(journal.original) ||
      !isRenameEvidence(journal.published)
    ) {
      return undefined
    }
    const targetParts = journal.target.split("/")
    if (
      targetParts.length !== 3 ||
      targetParts[0] !== "content" ||
      targetParts[2] !== "index.md" ||
      !domainSlugSchema.safeParse(targetParts[1]).success ||
      !domainNameSchema.safeParse(journal.intendedTitle).success
    ) {
      return undefined
    }
    const target = resolve(workspace, ...targetParts)
    const expected = {
      temporary: displayPath(workspace, `${target}.tmp-${transactionId}`),
      backup: displayPath(workspace, `${target}.backup-${transactionId}`),
      quarantine: displayPath(workspace, `${target}.quarantine-${transactionId}`),
    }
    if (
      journal.temporary !== expected.temporary ||
      journal.backup !== expected.backup ||
      journal.quarantine !== expected.quarantine
    ) {
      return undefined
    }
    return journal as unknown as DomainRenameJournal
  }

  async function readRenameJournalRecord(
    workspace: string,
    transactions: string,
    transactionsIdentity: string,
    transaction: string,
    transactionIdentity: string,
    transactionId: string,
  ): Promise<DomainRenameJournalRecord> {
    const entries = await readdir(transaction)
    const stagedEntries = entries.filter((entry) =>
      /^journal\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        entry,
      ),
    )
    if (
      entries.some((entry) => entry !== "journal.json" && !stagedEntries.includes(entry)) ||
      stagedEntries.length > 1 ||
      entries.length === 0
    ) {
      throw new Error("Domain rename transaction contains unexpected entries")
    }
    const finalPath = resolve(transaction, "journal.json")
    const stagedPath =
      stagedEntries.length === 1 ? resolve(transaction, stagedEntries[0]) : undefined
    const final = await readOwnedBytes(finalPath, transaction)
    const staged =
      stagedPath === undefined ? undefined : await readOwnedBytes(stagedPath, transaction)
    if (stagedPath !== undefined && staged === undefined) {
      throw new Error("Domain rename staged journal is unsafe")
    }
    let current = final ?? staged
    if (current === undefined) throw new Error("Domain rename journal is unsafe")
    let journal = parseRenameJournal(workspace, transactionId, current.bytes)
    if (journal === undefined) throw new Error("Domain rename journal is invalid")
    let selectedJournalPath = final === undefined ? stagedPath! : finalPath
    if (final !== undefined && staged !== undefined) {
      const finalJournal = parseRenameJournal(workspace, transactionId, final.bytes)
      const stagedJournal = parseRenameJournal(workspace, transactionId, staged.bytes)
      if (finalJournal === undefined || stagedJournal === undefined) {
        throw new Error("Domain rename journal is invalid")
      }
      const sameEvidence = (left: DomainRenameEvidence, right: DomainRenameEvidence): boolean =>
        left.contentHash === right.contentHash &&
        left.identity.dev === right.identity.dev &&
        left.identity.ino === right.identity.ino &&
        left.identity.size === right.identity.size &&
        left.identity.mtimeNs === right.identity.mtimeNs &&
        left.identity.ctimeNs === right.identity.ctimeNs
      const sameImmutableFields =
        finalJournal.id === stagedJournal.id &&
        finalJournal.target === stagedJournal.target &&
        finalJournal.temporary === stagedJournal.temporary &&
        finalJournal.backup === stagedJournal.backup &&
        finalJournal.quarantine === stagedJournal.quarantine &&
        finalJournal.intendedTitle === stagedJournal.intendedTitle &&
        sameEvidence(finalJournal.original, stagedJournal.original) &&
        sameEvidence(finalJournal.published, stagedJournal.published)
      if (!sameImmutableFields) {
        throw new Error("Domain rename journal transition fields changed")
      }
      const monotonic =
        (finalJournal.phase === "prepared" && stagedJournal.phase === "quarantined") ||
        (finalJournal.phase === "prepared" && stagedJournal.phase === "published") ||
        (finalJournal.phase === "quarantined" && stagedJournal.phase === "published")
      if (finalJournal.phase === stagedJournal.phase) {
        if (!final.bytes.equals(staged.bytes)) {
          throw new Error("Domain rename journal publication is ambiguous")
        }
        await removeOwnedFile(stagedPath!, transaction, staged.identity, staged.bytes)
      } else if (monotonic) {
        await removeOwnedFile(finalPath, transaction, final.identity, final.bytes)
        current = staged
        journal = stagedJournal
        selectedJournalPath = stagedPath!
      } else {
        throw new Error("Domain rename journal phase transition is invalid")
      }
      await syncDirectory(transaction, openFile)
    }
    return {
      journal,
      directory: transaction,
      directoryIdentity: transactionIdentity,
      transactions,
      transactionsIdentity,
      journalPath: selectedJournalPath,
      journalIdentity: current.identity,
      journalBytes: current.bytes,
    }
  }

  async function safeExistingDirectory(
    workspace: string,
    parent: string,
    path: string,
  ): Promise<string | undefined> {
    const details = await pathEntry(path)
    if (details === undefined) return undefined
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !isInside(parent, path) ||
      !pathsEqual(path, await realpath(path))
    ) {
      throw unsafePath(displayPath(workspace, path))
    }
    return inodeIdentity(details)
  }

  async function inspectRenameArtifact(
    path: string,
    parent: string,
  ): Promise<
    { readonly bytes: Buffer; readonly inode: string; readonly identity: FileIdentity } | undefined
  > {
    const file = await readOwnedBytes(path, parent)
    if (file === undefined && (await pathEntry(path)) !== undefined) {
      throw new Error(`Domain rename artifact is unsafe: ${path}`)
    }
    return file
  }

  async function recoverRenameJournal(
    canonical: CanonicalWorkspace,
    content: ManagedRoot,
    privateRoot: ManagedRoot,
    record: DomainRenameJournalRecord,
  ): Promise<"old" | "new"> {
    const workspace = canonical.directory
    const boundaries = [canonical, content, privateRoot]
    const target = resolve(workspace, ...record.journal.target.split("/"))
    const parent = resolve(target, "..")
    const temporary = resolve(workspace, ...record.journal.temporary.split("/"))
    const backup = resolve(workspace, ...record.journal.backup.split("/"))
    const quarantine = resolve(workspace, ...record.journal.quarantine.split("/"))
    const verifyChain = async (): Promise<void> => {
      await revalidateMutationBoundaries(workspace, boundaries)
      await assertTransactionDirectory(
        workspace,
        resolve(workspace, ".garden-publisher"),
        record.transactions,
        record.transactionsIdentity,
      )
      await assertTransactionDirectory(
        workspace,
        record.transactions,
        record.directory,
        record.directoryIdentity,
      )
    }
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      await verifyChain()
      try {
        const result = await operation()
        await verifyChain()
        return result
      } catch (error) {
        try {
          await verifyChain()
        } catch (chainError) {
          throw new AggregateError([error, chainError], "Domain rename recovery chain changed")
        }
        throw error
      }
    }
    const inspectAll = async () =>
      Promise.all([
        inspectRenameArtifact(target, parent),
        inspectRenameArtifact(temporary, parent),
        inspectRenameArtifact(backup, parent),
        inspectRenameArtifact(quarantine, parent),
      ])

    await verifyChain()
    let [targetFile, temporaryFile, backupFile, quarantineFile] = await inspectAll()
    const targetIsOld =
      targetFile !== undefined && matchesRenameEvidence(targetFile, record.journal.original)
    const targetIsNew =
      targetFile !== undefined && matchesRenameEvidence(targetFile, record.journal.published)
    if (targetFile !== undefined && !targetIsOld && !targetIsNew) {
      throw new Error("Domain rename target contains unrecognized bytes")
    }

    let outcome: "old" | "new"
    if (targetIsOld) outcome = "old"
    else if (targetIsNew) outcome = "new"
    else {
      const restorable = [
        { path: quarantine, file: quarantineFile, outcome: "old" as const },
        { path: backup, file: backupFile, outcome: "old" as const },
        { path: temporary, file: temporaryFile, outcome: "new" as const },
      ].find(({ file, outcome: candidate }) =>
        file === undefined
          ? false
          : matchesRenameEvidence(
              file,
              candidate === "old" ? record.journal.original : record.journal.published,
            ),
      )
      if (restorable === undefined) {
        if (quarantineFile !== undefined) {
          await guarded(() => linkEntry(quarantine, target))
          const restored = await inspectRenameArtifact(target, parent)
          if (
            restored === undefined ||
            restored.inode !== quarantineFile.inode ||
            !restored.bytes.equals(quarantineFile.bytes)
          ) {
            throw new Error("Concurrent domain replacement could not be restored")
          }
          await guarded(() => syncDirectory(parent, openFile))
        }
        throw new Error("Domain rename recovery has no recognized target state")
      }
      await guarded(() => linkEntry(restorable.path, target))
      await guarded(() => syncDirectory(parent, openFile))
      targetFile = await inspectRenameArtifact(target, parent)
      if (
        targetFile === undefined ||
        !matchesRenameEvidence(
          targetFile,
          restorable.outcome === "old" ? record.journal.original : record.journal.published,
        )
      ) {
        throw new Error("Domain rename recovery publication could not be verified")
      }
      outcome = restorable.outcome
    }

    const expectedTarget = outcome === "old" ? record.journal.original : record.journal.published
    targetFile = await inspectRenameArtifact(target, parent)
    if (targetFile === undefined || !matchesRenameEvidence(targetFile, expectedTarget)) {
      throw new Error("Recovered domain rename target changed")
    }

    ;[, temporaryFile, backupFile, quarantineFile] = await inspectAll()
    const artifacts = [
      { path: temporary, file: temporaryFile, evidence: record.journal.published },
      { path: backup, file: backupFile, evidence: record.journal.original },
      { path: quarantine, file: quarantineFile, evidence: record.journal.original },
    ]
    for (const artifact of artifacts) {
      if (artifact.file === undefined) continue
      const current = await inspectRenameArtifact(artifact.path, parent)
      if (current === undefined || !matchesRenameEvidence(current, artifact.evidence)) {
        throw new Error("Domain rename recovery artifact changed")
      }
      await guarded(() => removeOwnedFile(artifact.path, parent, current.identity, current.bytes))
    }
    await guarded(() => syncDirectory(parent, openFile))
    targetFile = await inspectRenameArtifact(target, parent)
    if (targetFile === undefined || !matchesRenameEvidence(targetFile, expectedTarget)) {
      throw new Error("Recovered domain rename target changed during cleanup")
    }
    const currentJournal = await readOwnedBytes(
      record.journalPath,
      record.directory,
      inodeIdentity(record.journalIdentity),
    )
    if (
      currentJournal === undefined ||
      !sameFileIdentity(currentJournal.identity, record.journalIdentity) ||
      !currentJournal.bytes.equals(record.journalBytes)
    ) {
      throw new Error("Domain rename journal changed during recovery")
    }
    await guarded(() =>
      removeOwnedFile(
        record.journalPath,
        record.directory,
        currentJournal.identity,
        currentJournal.bytes,
      ),
    )
    await guarded(() => syncDirectory(record.directory, openFile))
    const transactionDetails = await pathEntry(record.directory)
    if (
      transactionDetails === undefined ||
      transactionDetails.isSymbolicLink() ||
      !transactionDetails.isDirectory() ||
      inodeIdentity(transactionDetails) !== record.directoryIdentity ||
      (await readdir(record.directory)).length !== 0
    ) {
      throw new Error("Domain rename transaction cleanup is unsafe")
    }
    await verifyChain()
    await rmdir(record.directory)
    await revalidateMutationBoundaries(workspace, boundaries)
    await assertTransactionDirectory(
      workspace,
      resolve(workspace, ".garden-publisher"),
      record.transactions,
      record.transactionsIdentity,
    )
    await syncDirectory(record.transactions, openFile)
    return outcome
  }

  async function recoverDomainRenameTransactions(): Promise<void> {
    const canonical = await canonicalWorkspace(options.workspace)
    const content = await canonicalManagedRoot(canonical.directory, "content")
    const privateRoot = await canonicalManagedRoot(canonical.directory, "private")
    const state = resolve(canonical.directory, ".garden-publisher")
    const stateIdentity = await safeExistingDirectory(
      canonical.directory,
      canonical.directory,
      state,
    )
    if (stateIdentity === undefined) return
    const transactions = resolve(state, DOMAIN_RENAME_TRANSACTION_DIRECTORY)
    const transactionsIdentity = await safeExistingDirectory(
      canonical.directory,
      state,
      transactions,
    )
    if (transactionsIdentity === undefined) return
    const entries = await readdir(transactions, { withFileTypes: true })
    if (entries.length > 64) throw new Error("Too many domain rename transactions")
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !TRANSACTION_ID_PATTERN.test(entry.name)
      ) {
        throw new Error("Domain rename transaction root contains an unsafe entry")
      }
      const transaction = resolve(transactions, entry.name)
      const transactionIdentity = await safeExistingDirectory(
        canonical.directory,
        transactions,
        transaction,
      )
      if (transactionIdentity === undefined) {
        throw new Error("Domain rename transaction disappeared during recovery")
      }
      const transactionEntries = await readdir(transaction)
      if (transactionEntries.length === 0) {
        await rmdir(transaction)
        await syncDirectory(transactions, openFile)
        continue
      }
      const record = await readRenameJournalRecord(
        canonical.directory,
        transactions,
        transactionsIdentity,
        transaction,
        transactionIdentity,
        entry.name,
      )
      await recoverRenameJournal(canonical, content, privateRoot, record)
    }
    await revalidateMutationBoundaries(canonical.directory, [canonical, content, privateRoot])
  }

  async function durableRenamePage(
    workspace: string,
    boundaries: readonly { readonly directory: string; readonly identity: FileIdentity }[],
    page: {
      readonly path: string
      readonly source: string
      readonly identity: FileIdentity
      readonly mode: number
    },
    bytes: Buffer,
    intendedTitle: string,
  ): Promise<void> {
    const target = resolve(workspace, ...page.path.split("/"))
    const parent = resolve(target, "..")
    const transactionId = uuid()
    const temporary = `${target}.tmp-${transactionId}`
    const backup = `${target}.backup-${transactionId}`
    const quarantine = `${target}.quarantine-${transactionId}`
    const state = resolve(workspace, ".garden-publisher")
    const transactions = resolve(state, DOMAIN_RENAME_TRANSACTION_DIRECTORY)
    const transaction = resolve(transactions, transactionId)
    const journalPath = resolve(transaction, "journal.json")
    const original = Buffer.from(page.source, "utf8")
    let handle: DomainFileHandle | undefined
    let temporaryIdentity: string | undefined
    let backupIdentity: string | undefined
    let backupFingerprint: FileIdentity | undefined
    let publishedFingerprint: FileIdentity | undefined
    let publicationAttempted = false
    let publicationVerified = false
    let backupRemoved = false
    let quarantineContainsUnknown = false
    let stagedJournalForeign = false
    let journal: DomainRenameJournal | undefined
    let journalIdentity: FileIdentity | undefined
    let journalBytes: Buffer | undefined
    let transactionIdentity: string | undefined
    let transactionsIdentity: string | undefined
    let stagedJournalPath: string | undefined
    let stagedJournalIdentity: FileIdentity | undefined
    let stagedJournalBytes: Buffer | undefined

    const persistJournal = async (phase: DomainRenamePhase): Promise<void> => {
      if (journal === undefined || transactionIdentity === undefined) {
        throw new Error("Domain rename journal is not prepared")
      }
      const next: DomainRenameJournal = { ...journal, phase }
      const nextBytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8")
      const stagedJournal = `${journalPath}.tmp-${uuid()}`
      let journalHandle: DomainFileHandle | undefined
      let stagedIdentity: FileIdentity | undefined
      let stagedBytes: Buffer | undefined
      let journalPublished = false
      let journalFinalVerified = false
      try {
        stagedJournalPath = stagedJournal
        journalHandle = await openFile(stagedJournal, "wx", 0o600)
        stagedIdentity = fileIdentity(await journalHandle.stat({ bigint: true }))
        stagedJournalIdentity = stagedIdentity
        await journalHandle.writeFile(nextBytes)
        await journalHandle.sync()
        await journalHandle.close()
        journalHandle = undefined
        if (stagedIdentity === undefined) {
          stagedJournalForeign = true
          throw new Error("Domain rename staged journal ownership is unavailable")
        }
        const staged = await readOwnedBytes(
          stagedJournal,
          transaction,
          inodeIdentity(stagedIdentity),
        )
        if (
          staged === undefined ||
          staged.inode !== inodeIdentity(stagedIdentity) ||
          !staged.bytes.equals(nextBytes)
        ) {
          stagedJournalForeign = true
          throw new Error("Domain rename staged journal ownership changed")
        }
        stagedIdentity = staged.identity
        stagedBytes = staged.bytes
        stagedJournalIdentity = staged.identity
        stagedJournalBytes = staged.bytes
        await renameEntry(stagedJournal, journalPath)
        journalPublished = true
        const current = await readOwnedBytes(
          journalPath,
          transaction,
          inodeIdentity(stagedIdentity),
        )
        if (
          current === undefined ||
          current.inode !== inodeIdentity(stagedIdentity) ||
          !current.bytes.equals(nextBytes)
        ) {
          stagedJournalForeign = true
          throw new Error("Domain rename journal publication ownership changed")
        }
        journalFinalVerified = true
        stagedJournalPath = undefined
        stagedJournalIdentity = undefined
        stagedJournalBytes = undefined
        journal = next
        journalIdentity = current.identity
        journalBytes = current.bytes
        await syncDirectory(transaction, openFile)
        await syncDirectory(transactions, openFile)
        await syncDirectory(state, openFile)
      } finally {
        await journalHandle?.close().catch(() => undefined)
        let staged: BigIntStats | undefined
        try {
          staged = await pathEntry(stagedJournal)
        } catch (error) {
          stagedJournalForeign = true
          throw new Error("Domain rename staged journal ownership could not be inspected", {
            cause: error,
          })
        }
        if (staged !== undefined && journalPublished && journalFinalVerified) {
          const current = await readOwnedBytes(stagedJournal, transaction)
          if (
            current === undefined ||
            stagedIdentity === undefined ||
            stagedBytes === undefined ||
            !sameFileIdentity(current.identity, stagedIdentity) ||
            !current.bytes.equals(stagedBytes)
          ) {
            stagedJournalForeign = true
            throw new Error("Domain rename staged journal ownership changed")
          }
          await unlink(stagedJournal)
        } else if (staged !== undefined && journalPublished && !journalFinalVerified) {
          stagedJournalForeign = true
        } else if (
          staged !== undefined &&
          stagedIdentity !== undefined &&
          stagedBytes !== undefined
        ) {
          const current = await readOwnedBytes(stagedJournal, transaction)
          if (
            current === undefined ||
            !sameFileIdentity(current.identity, stagedIdentity) ||
            !current.bytes.equals(stagedBytes)
          ) {
            stagedJournalForeign = true
            throw new Error("Domain rename staged journal ownership changed")
          }
        } else if (!journalPublished && stagedIdentity === undefined && staged !== undefined) {
          stagedJournalForeign = true
          throw new Error("Domain rename staged journal ownership could not be authenticated")
        } else if (!journalPublished && stagedIdentity !== undefined) {
          const current = await readOwnedBytes(stagedJournal, transaction)
          if (
            current === undefined ||
            inodeIdentity(current.identity) !== inodeIdentity(stagedIdentity)
          ) {
            stagedJournalForeign = true
            throw new Error("Domain rename staged journal ownership changed")
          }
          stagedJournalIdentity = current.identity
          stagedJournalBytes = current.bytes
        }
      }
    }

    const verifyBoundaries = (): Promise<void> =>
      revalidateMutationBoundaries(workspace, boundaries)

    const guardedMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
      await verifyBoundaries()
      try {
        const result = await operation()
        await verifyBoundaries()
        return result
      } catch (error) {
        try {
          await verifyBoundaries()
        } catch (boundaryError) {
          throw new AggregateError(
            [error, boundaryError],
            "Domain rename mutation crossed an untrusted managed boundary",
          )
        }
        throw error
      }
    }

    const uncertain = (primary: unknown, failures: readonly unknown[]): DomainCatalogError =>
      catalogError(
        "DOMAIN_ROLLBACK_UNCERTAIN",
        "Domain rename failed and rollback could not be confirmed.",
        { path: displayPath(workspace, target) },
        new AggregateError([primary, ...failures], "Domain rename rollback failed"),
      )

    const verifyPublishedTarget = async (): Promise<void> => {
      const current = await readOwnedBytes(target, parent, temporaryIdentity)
      if (
        current === undefined ||
        publishedFingerprint === undefined ||
        !sameStableFileIdentity(current.identity, publishedFingerprint) ||
        !current.bytes.equals(bytes)
      ) {
        throw new Error("Committed domain rename identity changed")
      }
      await verifyBoundaries()
    }

    const retireJournal = async (): Promise<void> => {
      if (journal === undefined || transactionIdentity === undefined) {
        return
      }
      const ownedPath = journalIdentity === undefined ? stagedJournalPath : journalPath
      const ownedIdentity = journalIdentity === undefined ? stagedJournalIdentity : journalIdentity
      const ownedBytes = journalIdentity === undefined ? stagedJournalBytes : journalBytes
      if (ownedPath === undefined || ownedIdentity === undefined || ownedBytes === undefined) return
      const current = await readOwnedBytes(ownedPath, transaction, inodeIdentity(ownedIdentity))
      if (
        current === undefined ||
        !sameFileIdentity(current.identity, ownedIdentity) ||
        !current.bytes.equals(ownedBytes)
      ) {
        throw new Error("Domain rename journal ownership changed during rollback")
      }
      await removeOwnedFile(ownedPath, transaction, current.identity, current.bytes)
      await syncDirectory(transaction, openFile)
      const details = await pathEntry(transaction)
      if (
        details === undefined ||
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        inodeIdentity(details) !== transactionIdentity ||
        (await readdir(transaction)).length !== 0
      ) {
        throw new Error("Domain rename rollback transaction cleanup is unsafe")
      }
      await rmdir(transaction)
      await syncDirectory(transactions, openFile)
      await syncDirectory(state, openFile)
    }

    try {
      handle = await openFile(temporary, "wx", 0o600)
      temporaryIdentity = inodeIdentity(await handle.stat({ bigint: true }))
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await chmod(temporary, page.mode & 0o777)
      const staged = await readOwnedBytes(temporary, parent, temporaryIdentity)
      if (staged === undefined || !staged.bytes.equals(bytes)) {
        throw unsafePath(displayPath(workspace, temporary))
      }
      await verifyBoundaries()
      await ensureTransactionParent(workspace, workspace, state)
      transactionsIdentity = await ensureTransactionParent(workspace, state, transactions)
      transactionIdentity = await ensureTransactionParent(workspace, transactions, transaction)
      await syncDirectory(transactions, openFile)
      journal = {
        version: 1,
        id: transactionId,
        phase: "prepared",
        target: displayPath(workspace, target),
        temporary: displayPath(workspace, temporary),
        backup: displayPath(workspace, backup),
        quarantine: displayPath(workspace, quarantine),
        intendedTitle,
        original: renameEvidence(page.identity, original),
        published: renameEvidence(staged.identity, bytes),
      }
      await persistJournal("prepared")
      await assertExactFileIdentity(workspace, target, page.identity)
      await guardedMutation(() => syncDirectory(parent, openFile))
      await guardedMutation(() => replaceFileEntry(temporary, target, backup))
      publicationAttempted = true
      const [installed, retainedBackup, retainedTemporary] = await Promise.all([
        readOwnedBytes(target, parent, temporaryIdentity),
        readOwnedBytes(backup, parent),
        pathEntry(temporary),
      ])
      if (
        installed === undefined ||
        retainedBackup === undefined ||
        retainedTemporary !== undefined ||
        !installed.bytes.equals(bytes) ||
        !sameStableFileIdentity(retainedBackup.identity, page.identity) ||
        !retainedBackup.bytes.equals(original)
      ) {
        throw new Error("Atomic domain rename replacement could not be verified")
      }
      backupIdentity = retainedBackup.inode
      backupFingerprint = retainedBackup.identity
      publicationVerified = true
      publishedFingerprint = installed.identity
      backupFingerprint = retainedBackup.identity
      await guardedMutation(() => syncDirectory(parent, openFile))
      const [durable, publishedBackup] = await Promise.all([
        readOwnedBytes(target, parent, temporaryIdentity),
        readOwnedBytes(backup, parent, backupIdentity),
      ])
      if (
        durable === undefined ||
        publishedBackup === undefined ||
        !sameStableFileIdentity(durable.identity, publishedFingerprint) ||
        !sameFileIdentity(publishedBackup.identity, backupFingerprint) ||
        !durable.bytes.equals(bytes) ||
        !publishedBackup.bytes.equals(original)
      ) {
        throw new Error("Renamed landing page changed during directory sync")
      }
      await guardedMutation(() =>
        removeOwnedFile(backup, parent, publishedBackup.identity, original),
      )
      backupIdentity = undefined
      backupFingerprint = undefined
      backupRemoved = true
      await persistJournal("published")
      try {
        await guardedMutation(() => syncDirectory(parent, openFile))
      } catch (finalSyncError) {
        const failures: unknown[] = []
        await verifyPublishedTarget().catch((error: unknown) => failures.push(error))
        if (failures.length === 0) {
          await guardedMutation(() => syncDirectory(parent, openFile)).catch((error: unknown) =>
            failures.push(error),
          )
        }
        if (failures.length === 0) {
          await verifyPublishedTarget().catch((error: unknown) => failures.push(error))
        }
        if (failures.length > 0) throw uncertain(finalSyncError, failures)
      }
      await verifyPublishedTarget()
      if (journalIdentity === undefined || journalBytes === undefined) {
        throw new Error("Domain rename journal identity is unavailable")
      }
      await removeOwnedFile(journalPath, transaction, journalIdentity, journalBytes)
      await syncDirectory(transaction, openFile)
      if (transactionIdentity === undefined || transactionsIdentity === undefined) {
        throw new Error("Domain rename transaction identity is unavailable")
      }
      await removeOwnedEmptyDirectory(transaction, transactionIdentity)
      await syncDirectory(transactions, openFile)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      const failures: unknown[] = []
      try {
        await verifyBoundaries()
      } catch (boundaryError) {
        throw uncertain(error, [boundaryError])
      }
      if (error instanceof DomainCatalogError && error.code === "DOMAIN_ROLLBACK_UNCERTAIN") {
        throw error
      }
      if (quarantineContainsUnknown) {
        throw uncertain(error, [new Error("Concurrent quarantine bytes are preserved")])
      }
      if (stagedJournalForeign) {
        throw uncertain(error, [new Error("Concurrent staged journal bytes are preserved")])
      }
      const backupCurrent = await readOwnedBytes(
        backup,
        parent,
        backupIdentity ?? inodeIdentity(page.identity),
      )
      let targetCurrent = await readOwnedBytes(target, parent)
      let temporaryCurrent = await readOwnedBytes(temporary, parent, temporaryIdentity)
      const backupEntry = await pathEntry(backup)
      if (backupCurrent === undefined && backupEntry !== undefined) {
        throw uncertain(error, [new Error("Domain rename backup identity is unavailable")])
      }
      if (backupCurrent === undefined && publicationAttempted && backupRemoved) {
        const committed = await readOwnedBytes(target, parent, temporaryIdentity)
        if (
          !publicationVerified ||
          committed === undefined ||
          publishedFingerprint === undefined ||
          !sameFileIdentity(committed.identity, publishedFingerprint) ||
          !committed.bytes.equals(bytes)
        ) {
          throw uncertain(error, [new Error("Committed domain rename cannot be verified")])
        }
        await guardedMutation(() => syncDirectory(parent, openFile)).catch((syncError: unknown) =>
          failures.push(syncError),
        )
        await verifyPublishedTarget().catch((verifyError: unknown) => failures.push(verifyError))
        if (failures.length > 0) throw uncertain(error, failures)
        return
      }
      if (backupCurrent === undefined && publicationAttempted) {
        throw uncertain(error, [new Error("Domain rename publication lost its source backup")])
      }
      if (backupCurrent === undefined) {
        if (
          !publicationAttempted &&
          !(isDomainDiscoveryError(error) && error.code === "DOMAIN_UNSAFE_PATH") &&
          targetCurrent !== undefined &&
          (targetCurrent.inode === temporaryIdentity ||
            targetCurrent.inode !== inodeIdentity(page.identity) ||
            !targetCurrent.bytes.equals(original))
        ) {
          throw uncertain(error, [new Error("Domain rename target changed before publication")])
        }
        if (temporaryCurrent !== undefined) {
          if (!temporaryCurrent.bytes.equals(bytes)) {
            throw uncertain(error, [new Error("Domain rename staging file changed")])
          }
          await guardedMutation(() =>
            removeOwnedFile(temporary, parent, temporaryCurrent!.identity, bytes),
          ).catch((cleanupError: unknown) => failures.push(cleanupError))
          temporaryCurrent = undefined
        }
        if (failures.length === 0) {
          await guardedMutation(() => syncDirectory(parent, openFile)).catch(
            (cleanupError: unknown) => failures.push(cleanupError),
          )
        }
        if (failures.length === 0) {
          await retireJournal().catch((cleanupError: unknown) => failures.push(cleanupError))
        }
        if (failures.length > 0) throw uncertain(error, failures)
        throw error
      } else {
        const backupDrifted =
          (backupFingerprint !== undefined &&
            !sameFileIdentity(backupCurrent.identity, backupFingerprint)) ||
          !backupCurrent.bytes.equals(original)
        const targetIsBackup =
          targetCurrent !== undefined && targetCurrent.inode === backupCurrent.inode
        const targetIsOwnedPublication =
          targetCurrent !== undefined &&
          targetCurrent.inode === temporaryIdentity &&
          targetCurrent.bytes.equals(bytes)
        const targetIsEditedPublication =
          targetCurrent !== undefined &&
          targetCurrent.inode === temporaryIdentity &&
          !targetCurrent.bytes.equals(bytes)
        if (targetIsEditedPublication) {
          throw uncertain(error, [new Error("Published domain rename contains a concurrent edit")])
        }
        if (targetIsOwnedPublication && backupDrifted) {
          throw uncertain(error, [new Error("Concurrent replacement bytes are preserved")])
        }
        if (!targetIsBackup && targetCurrent !== undefined && !targetIsOwnedPublication) {
          throw uncertain(error, [new Error("Domain rename target contains an unowned edit")])
        } else if (!targetIsBackup) {
          if (targetIsOwnedPublication) {
            await guardedMutation(() =>
              removeOwnedFile(target, parent, targetCurrent!.identity, bytes),
            ).catch((rollbackError: unknown) => failures.push(rollbackError))
          }
          if (failures.length === 0) {
            await guardedMutation(() => linkEntry(backup, target)).catch((rollbackError: unknown) =>
              failures.push(rollbackError),
            )
          }
          targetCurrent = await readOwnedBytes(target, parent, backupCurrent.inode)
          if (
            targetCurrent === undefined ||
            targetCurrent.inode !== backupCurrent.inode ||
            !targetCurrent.bytes.equals(backupCurrent.bytes)
          ) {
            failures.push(new Error("Domain rename backup could not be restored"))
          } else {
            const refreshedBackup = await readOwnedBytes(backup, parent, backupCurrent.inode)
            const refreshedTarget = await readOwnedBytes(target, parent, backupCurrent.inode)
            if (
              refreshedBackup === undefined ||
              refreshedTarget === undefined ||
              refreshedBackup.inode !== refreshedTarget.inode ||
              !refreshedBackup.bytes.equals(original) ||
              !refreshedTarget.bytes.equals(original)
            ) {
              failures.push(new Error("Domain rename restored backup could not be verified"))
            } else {
              await removeOwnedFile(backup, parent, refreshedBackup.identity, original).catch(
                (cleanupError: unknown) => failures.push(cleanupError),
              )
              if (failures.length === 0) backupIdentity = undefined
            }
          }
        } else if (backupDrifted) {
          failures.push(new Error("Domain rename source was edited during publication"))
        } else {
          await guardedMutation(() =>
            removeOwnedFile(backup, parent, backupCurrent.identity, original),
          ).catch((rollbackError: unknown) => failures.push(rollbackError))
          if (failures.length === 0) backupIdentity = undefined
        }
      }
      if (failures.length === 0 && temporaryCurrent !== undefined) {
        if (!temporaryCurrent.bytes.equals(bytes)) {
          failures.push(new Error("Domain rename staging file changed during rollback"))
        } else {
          await guardedMutation(() =>
            removeOwnedFile(temporary, parent, temporaryCurrent!.identity, bytes),
          ).catch((cleanupError: unknown) => failures.push(cleanupError))
        }
        temporaryCurrent = undefined
      }
      if (failures.length === 0) {
        await guardedMutation(() => syncDirectory(parent, openFile)).catch(
          (cleanupError: unknown) => failures.push(cleanupError),
        )
      }
      if (failures.length === 0) {
        const currentQuarantine = await readOwnedBytes(quarantine, parent)
        if (currentQuarantine !== undefined) {
          if (!currentQuarantine.bytes.equals(original)) {
            failures.push(new Error("Domain rename quarantine changed during rollback"))
          } else {
            await removeOwnedFile(quarantine, parent, currentQuarantine.identity, original).catch(
              (cleanupError: unknown) => failures.push(cleanupError),
            )
          }
        }
      }
      if (failures.length === 0) {
        await retireJournal().catch((cleanupError: unknown) => failures.push(cleanupError))
      }
      if (failures.length > 0) {
        throw uncertain(error, failures)
      }
      throw error
    }
  }

  async function renameDomain(request: DomainRenameRequest): Promise<readonly DomainSummary[]> {
    const input = domainRenameSchema.parse(request)
    const canonical = await canonicalWorkspace(options.workspace)
    const content = await canonicalManagedRoot(canonical.directory, "content")
    const privateRoot = await canonicalManagedRoot(canonical.directory, "private")
    const domains = await discoverDomains(canonical.directory)
    const domain = domains.find((candidate) => candidate.slug === input.slug)
    if (!domain) {
      throw catalogError("DOMAIN_NOT_FOUND", "The requested domain does not exist.", {
        slug: input.slug,
      })
    }
    if (
      domains.some(
        (candidate) =>
          candidate.slug !== input.slug && nameKey(candidate.name) === nameKey(input.name),
      )
    ) {
      throw catalogError(
        "DOMAIN_ALREADY_EXISTS",
        "A domain with the same display name already exists.",
        { name: input.name },
      )
    }
    const directory = await canonicalDirectory(
      canonical.directory,
      content,
      resolve(content.directory, input.slug),
      false,
    )
    if (directory === undefined) {
      throw catalogError("DOMAIN_NOT_FOUND", "The requested domain does not exist.", {
        slug: input.slug,
      })
    }
    const page = await readDomainPage(canonical.directory, content, directory, {})
    if (page === undefined || parseDomainPage(page, input.slug) === undefined) {
      throw catalogError("DOMAIN_NOT_FOUND", "The requested domain does not exist.", {
        slug: input.slug,
      })
    }
    const safeSource = normalizeSafeYamlSource(page.source)
    if (!safeSource.hasFrontmatter || !safeSource.supported) throw invalidMetadata(page.path)
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(safeSource.source, SAFE_MATTER_OPTIONS)
    } catch {
      throw invalidMetadata(page.path)
    }
    if (parsed.data.gardenDomain !== true) throw invalidMetadata(page.path)
    const renamed = replaceTitleScalar(page.source, input.name, page.path)
    await options.hooks?.afterRenameRead?.(page.path)
    await durableRenamePage(
      canonical.directory,
      [canonical, content, privateRoot],
      page,
      Buffer.from(renamed, "utf8"),
      input.name,
    )
    return discoverDomains(canonical.directory)
  }

  async function ensureTransactionParent(
    workspace: string,
    parent: string,
    candidate: string,
  ): Promise<string> {
    try {
      await createDirectory(candidate, { mode: 0o700 })
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error
    }
    try {
      const details = await lstat(candidate, { bigint: true })
      const canonical = await realpath(candidate)
      if (
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        !isInside(parent, canonical) ||
        !pathsEqual(candidate, canonical)
      ) {
        throw unsafePath(displayPath(workspace, candidate))
      }
      return inodeIdentity(details)
    } catch (error) {
      if (isDomainDiscoveryError(error)) throw error
      throw unsafePath(displayPath(workspace, candidate))
    }
  }

  async function assertTransactionDirectory(
    workspace: string,
    parent: string,
    candidate: string,
    expectedIdentity: string,
  ): Promise<void> {
    try {
      const details = await lstat(candidate, { bigint: true })
      const canonical = await realpath(candidate)
      if (
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        inodeIdentity(details) !== expectedIdentity ||
        !isInside(parent, canonical) ||
        !pathsEqual(candidate, canonical)
      ) {
        throw unsafePath(displayPath(workspace, candidate))
      }
    } catch (error) {
      if (isDomainDiscoveryError(error)) throw error
      throw unsafePath(displayPath(workspace, candidate))
    }
  }

  async function inspectRemovableDirectory(
    workspace: string,
    directory: string,
    expectedEntries: readonly string[],
    expectedDirectoryIdentity?: string,
    expectedIndexIdentity?: FileIdentity,
  ): Promise<string> {
    let details: BigIntStats
    let entries
    try {
      details = await lstat(directory, { bigint: true })
      const canonical = await realpath(directory)
      if (
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        !pathsEqual(directory, canonical) ||
        (expectedDirectoryIdentity !== undefined &&
          inodeIdentity(details) !== expectedDirectoryIdentity)
      ) {
        throw unsafePath(displayPath(workspace, directory))
      }
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isDomainDiscoveryError(error)) throw error
      throw unsafePath(displayPath(workspace, directory))
    }
    const expected = [...expectedEntries].sort(compareText)
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const candidate = resolve(directory, entry.name)
      let entryDetails: BigIntStats
      try {
        entryDetails = await lstat(candidate, { bigint: true })
        if (
          entryDetails.isSymbolicLink() ||
          !pathsEqual(candidate, await realpath(candidate)) ||
          !isInside(directory, candidate)
        ) {
          throw unsafePath(displayPath(workspace, candidate))
        }
      } catch (error) {
        if (isDomainDiscoveryError(error)) throw error
        throw unsafePath(displayPath(workspace, candidate))
      }
      if (!expected.includes(entry.name)) {
        throw catalogError(
          "DOMAIN_NOT_EMPTY",
          "The domain still contains files or directories and cannot be removed.",
          { path: displayPath(workspace, candidate) },
        )
      }
      if (
        entry.name === "index.md" &&
        (entryDetails.isSymbolicLink() ||
          !entryDetails.isFile() ||
          (expectedIndexIdentity !== undefined &&
            !sameFileIdentity(expectedIndexIdentity, fileIdentity(entryDetails))))
      ) {
        throw unsafePath(displayPath(workspace, candidate))
      }
    }
    if (entries.map(({ name }) => name).join("\0") !== expected.join("\0")) {
      throw unsafePath(displayPath(workspace, directory))
    }
    return inodeIdentity(details)
  }

  async function restoreStagedDirectory(
    workspace: string,
    staged: string,
    original: string,
    expectedIdentity: string,
  ): Promise<void> {
    const stagedDetails = await pathEntry(staged)
    const originalDetails = await pathEntry(original)
    if (
      stagedDetails === undefined ||
      stagedDetails.isSymbolicLink() ||
      !stagedDetails.isDirectory() ||
      inodeIdentity(stagedDetails) !== expectedIdentity ||
      originalDetails !== undefined ||
      !pathsEqual(staged, await realpath(staged))
    ) {
      throw new Error(
        `Staged domain path cannot be safely restored: ${displayPath(workspace, original)}`,
      )
    }
    try {
      await renameEntry(staged, original)
    } catch (error) {
      const restoredAfterError = await pathEntry(original)
      if (
        restoredAfterError === undefined ||
        restoredAfterError.isSymbolicLink() ||
        !restoredAfterError.isDirectory() ||
        inodeIdentity(restoredAfterError) !== expectedIdentity
      ) {
        throw error
      }
    }
    const restored = await pathEntry(original)
    if (
      restored === undefined ||
      restored.isSymbolicLink() ||
      !restored.isDirectory() ||
      inodeIdentity(restored) !== expectedIdentity ||
      !pathsEqual(original, await realpath(original))
    ) {
      throw new Error(
        `Restored domain path could not be verified: ${displayPath(workspace, original)}`,
      )
    }
  }

  async function removeDomain(request: DomainRemoveRequest): Promise<readonly DomainSummary[]> {
    const input = domainRemoveSchema.parse(request)
    const canonical = await canonicalWorkspace(options.workspace)
    const content = await canonicalManagedRoot(canonical.directory, "content")
    const privateRoot = await canonicalManagedRoot(canonical.directory, "private")
    const domains = await discoverDomains(canonical.directory)
    if (!domains.some((domain) => domain.slug === input.slug)) {
      throw catalogError("DOMAIN_NOT_FOUND", "The requested domain does not exist.", {
        slug: input.slug,
      })
    }
    const publicDirectory = await canonicalDirectory(
      canonical.directory,
      content,
      resolve(content.directory, input.slug),
      false,
    )
    const privateDirectory = await canonicalDirectory(
      canonical.directory,
      privateRoot,
      resolve(privateRoot.directory, input.slug),
      false,
    )
    if (publicDirectory === undefined || privateDirectory === undefined) {
      throw unsafePath(input.slug)
    }
    const page = await readDomainPage(canonical.directory, content, publicDirectory, {})
    if (page === undefined || parseDomainPage(page, input.slug) === undefined) {
      throw unsafePath(displayPath(canonical.directory, resolve(publicDirectory, "index.md")))
    }
    const publicIdentity = await inspectRemovableDirectory(
      canonical.directory,
      publicDirectory,
      ["index.md"],
      undefined,
      page.identity,
    )
    const privateIdentity = await inspectRemovableDirectory(
      canonical.directory,
      privateDirectory,
      [],
    )
    await options.hooks?.afterRemoveInspection?.(input.slug)
    await inspectRemovableDirectory(
      canonical.directory,
      publicDirectory,
      ["index.md"],
      publicIdentity,
      page.identity,
    )
    await inspectRemovableDirectory(canonical.directory, privateDirectory, [], privateIdentity)
    await Promise.all([
      revalidateMutatedBoundary(canonical.directory, canonical),
      revalidateMutatedBoundary(canonical.directory, content),
      revalidateMutatedBoundary(canonical.directory, privateRoot),
    ])

    const state = resolve(canonical.directory, ".garden-publisher")
    const stateIdentity = await ensureTransactionParent(
      canonical.directory,
      canonical.directory,
      state,
    )
    await syncDirectory(canonical.directory, openFile)
    const transactions = resolve(state, "domain-transactions")
    const transactionsIdentity = await ensureTransactionParent(
      canonical.directory,
      state,
      transactions,
    )
    await syncDirectory(state, openFile)
    const transactionId = uuid()
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        transactionId,
      )
    ) {
      throw new Error("Invalid domain transaction identifier")
    }
    const transaction = resolve(transactions, transactionId)
    try {
      await createDirectory(transaction, { mode: 0o700 })
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        throw unsafePath(displayPath(canonical.directory, transaction))
      }
      throw error
    }
    const transactionDetails = await lstat(transaction, { bigint: true })
    if (
      transactionDetails.isSymbolicLink() ||
      !transactionDetails.isDirectory() ||
      !pathsEqual(transaction, await realpath(transaction))
    ) {
      throw unsafePath(displayPath(canonical.directory, transaction))
    }
    const transactionIdentity = inodeIdentity(transactionDetails)
    const stagedPublic = resolve(transaction, "content")
    const stagedPrivate = resolve(transaction, "private")
    const manifest = resolve(transaction, "manifest.json")
    let publicStaged = false
    let privateStaged = false
    let manifestIdentity: string | undefined
    let manifestHandle: DomainFileHandle | undefined
    let manifestBytes: Buffer | undefined
    let manifestFingerprint: FileIdentity | undefined
    let manifestPublished = false
    let transactionTrusted = true
    let readyForTrash = false

    const verifyTransactionChain = async (): Promise<void> => {
      await Promise.all([
        revalidateMutatedBoundary(canonical.directory, canonical),
        revalidateMutatedBoundary(canonical.directory, content),
        revalidateMutatedBoundary(canonical.directory, privateRoot),
      ])
      await assertTransactionDirectory(
        canonical.directory,
        canonical.directory,
        state,
        stateIdentity,
      )
      await assertTransactionDirectory(
        canonical.directory,
        state,
        transactions,
        transactionsIdentity,
      )
      await assertTransactionDirectory(
        canonical.directory,
        transactions,
        transaction,
        transactionIdentity,
      )
    }

    const verifyTransactionStructure = async (): Promise<void> => {
      await verifyTransactionChain()
      const entries = (await readdir(transaction)).sort(compareText)
      if (entries.join("\0") !== ["content", "manifest.json", "private"].join("\0")) {
        throw new Error("Domain removal transaction contains unexpected entries")
      }
      await assertTransactionDirectory(
        canonical.directory,
        transaction,
        stagedPublic,
        publicIdentity,
      )
      await assertTransactionDirectory(
        canonical.directory,
        transaction,
        stagedPrivate,
        privateIdentity,
      )
      const durableManifest = await readOwnedBytes(manifest, transaction, manifestIdentity)
      if (
        durableManifest === undefined ||
        manifestFingerprint === undefined ||
        manifestBytes === undefined ||
        !sameFileIdentity(durableManifest.identity, manifestFingerprint) ||
        !durableManifest.bytes.equals(manifestBytes)
      ) {
        throw new Error("Domain removal manifest changed before trashing")
      }
      await verifyTransactionChain()
    }

    const restore = async (primary: unknown): Promise<never> => {
      const failures: unknown[] = []
      await manifestHandle?.close().catch((error: unknown) => failures.push(error))
      manifestHandle = undefined
      if (transactionTrusted) {
        await verifyTransactionChain().catch((error: unknown) => {
          transactionTrusted = false
          failures.push(error)
        })
      }
      if (!transactionTrusted) {
        throw catalogError(
          "DOMAIN_ROLLBACK_UNCERTAIN",
          "Domain removal failed and restoration could not be confirmed.",
          { path: displayPath(canonical.directory, transaction) },
          new AggregateError([primary, ...failures], "Domain removal restoration failed"),
        )
      }
      if (manifestPublished) {
        const durableManifest = await readOwnedBytes(manifest, transaction, manifestIdentity)
        try {
          if (
            durableManifest === undefined ||
            manifestBytes === undefined ||
            manifestFingerprint === undefined ||
            !sameFileIdentity(durableManifest.identity, manifestFingerprint) ||
            !durableManifest.bytes.equals(manifestBytes)
          ) {
            throw new Error("The domain removal manifest changed before restoration")
          }
          const parsed = JSON.parse(durableManifest.bytes.toString("utf8")) as Record<
            string,
            unknown
          >
          if (
            parsed.version !== 1 ||
            parsed.id !== transactionId ||
            parsed.slug !== input.slug ||
            parsed.publicPath !== displayPath(canonical.directory, publicDirectory) ||
            parsed.privatePath !== displayPath(canonical.directory, privateDirectory) ||
            parsed.publicIdentity !== publicIdentity ||
            parsed.privateIdentity !== privateIdentity
          ) {
            throw new Error("The domain removal manifest is invalid")
          }
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 0 && privateStaged) {
        await verifyTransactionChain().catch((error: unknown) => failures.push(error))
      }
      if (failures.length === 0 && privateStaged) {
        await restoreStagedDirectory(
          canonical.directory,
          stagedPrivate,
          privateDirectory,
          privateIdentity,
        ).then(
          () => {
            privateStaged = false
          },
          (error: unknown) => failures.push(error),
        )
      }
      if (failures.length === 0) {
        await verifyTransactionChain().catch((error: unknown) => failures.push(error))
      }
      if (failures.length === 0 && publicStaged) {
        await verifyTransactionChain().catch((error: unknown) => failures.push(error))
      }
      if (failures.length === 0 && publicStaged) {
        await restoreStagedDirectory(
          canonical.directory,
          stagedPublic,
          publicDirectory,
          publicIdentity,
        ).then(
          () => {
            publicStaged = false
          },
          (error: unknown) => failures.push(error),
        )
      }
      if (failures.length === 0) {
        await verifyTransactionChain().catch((error: unknown) => failures.push(error))
      }
      if (failures.length === 0 && readyForTrash && !publicStaged && !privateStaged) {
        await inspectRemovableDirectory(
          canonical.directory,
          publicDirectory,
          ["index.md"],
          publicIdentity,
          page.identity,
        ).catch((error: unknown) => failures.push(error))
        await inspectRemovableDirectory(
          canonical.directory,
          privateDirectory,
          [],
          privateIdentity,
        ).catch((error: unknown) => failures.push(error))
      }
      if (failures.length === 0) {
        for (const directory of [content.directory, privateRoot.directory, transaction]) {
          await syncDirectory(directory, openFile).catch((error: unknown) => failures.push(error))
        }
      }
      if (failures.length === 0 && !publicStaged && !privateStaged) {
        await cleanupTemporary(manifest, manifestIdentity).catch((error: unknown) =>
          failures.push(error),
        )
        if (failures.length === 0) {
          manifestIdentity = undefined
          manifestFingerprint = undefined
          const currentTransaction = await pathEntry(transaction)
          if (
            currentTransaction === undefined ||
            currentTransaction.isSymbolicLink() ||
            !currentTransaction.isDirectory() ||
            inodeIdentity(currentTransaction) !== transactionIdentity ||
            (await readdir(transaction)).length !== 0
          ) {
            failures.push(new Error("Domain transaction directory cleanup is unsafe"))
          } else {
            await rmdir(transaction).catch((error: unknown) => failures.push(error))
            await syncDirectory(transactions, openFile).catch((error: unknown) =>
              failures.push(error),
            )
          }
        }
      }
      if (failures.length > 0) {
        throw catalogError(
          "DOMAIN_ROLLBACK_UNCERTAIN",
          "Domain removal failed and restoration could not be confirmed.",
          { path: displayPath(canonical.directory, transaction) },
          new AggregateError([primary, ...failures], "Domain removal restoration failed"),
        )
      }
      throw primary
    }

    try {
      await syncDirectory(transactions, openFile)
      await verifyTransactionChain()
      await renameEntry(publicDirectory, stagedPublic)
      publicStaged = true
      await verifyTransactionChain()
      const stagedPublicDetails = await lstat(stagedPublic, { bigint: true })
      if (
        stagedPublicDetails.isSymbolicLink() ||
        !stagedPublicDetails.isDirectory() ||
        inodeIdentity(stagedPublicDetails) !== publicIdentity ||
        !pathsEqual(stagedPublic, await realpath(stagedPublic))
      ) {
        throw new Error("The staged public domain identity changed")
      }
      await inspectRemovableDirectory(
        canonical.directory,
        stagedPublic,
        ["index.md"],
        publicIdentity,
        page.identity,
      )
      await Promise.all([
        syncDirectory(content.directory, openFile),
        syncDirectory(transaction, openFile),
      ])

      await verifyTransactionChain()
      await renameEntry(privateDirectory, stagedPrivate)
      privateStaged = true
      await verifyTransactionChain()
      const stagedPrivateDetails = await lstat(stagedPrivate, { bigint: true })
      if (
        stagedPrivateDetails.isSymbolicLink() ||
        !stagedPrivateDetails.isDirectory() ||
        inodeIdentity(stagedPrivateDetails) !== privateIdentity ||
        !pathsEqual(stagedPrivate, await realpath(stagedPrivate))
      ) {
        throw new Error("The staged private domain identity changed")
      }
      await inspectRemovableDirectory(canonical.directory, stagedPrivate, [], privateIdentity)
      await Promise.all([
        syncDirectory(privateRoot.directory, openFile),
        syncDirectory(transaction, openFile),
      ])

      manifestBytes = Buffer.from(
        `${JSON.stringify({
          version: 1,
          id: transactionId,
          slug: input.slug,
          createdAt: now().toISOString(),
          publicPath: displayPath(canonical.directory, publicDirectory),
          privatePath: displayPath(canonical.directory, privateDirectory),
          publicIdentity,
          privateIdentity,
        })}\n`,
        "utf8",
      )
      manifestHandle = await openFile(manifest, "wx", 0o600)
      manifestIdentity = inodeIdentity(await manifestHandle.stat({ bigint: true }))
      await manifestHandle.writeFile(manifestBytes)
      await manifestHandle.sync()
      await manifestHandle.close()
      manifestHandle = undefined
      const durableManifest = await readOwnedBytes(manifest, transaction, manifestIdentity)
      if (durableManifest === undefined || !durableManifest.bytes.equals(manifestBytes)) {
        throw new Error("Domain removal manifest could not be verified")
      }
      manifestFingerprint = durableManifest.identity
      await syncDirectory(transaction, openFile)
      manifestPublished = true
      try {
        await verifyTransactionStructure()
      } catch (error) {
        transactionTrusted = false
        throw error
      }
      await inspectRemovableDirectory(
        canonical.directory,
        stagedPublic,
        ["index.md"],
        publicIdentity,
        page.identity,
      )
      await inspectRemovableDirectory(canonical.directory, stagedPrivate, [], privateIdentity)
      try {
        await verifyTransactionStructure()
      } catch (error) {
        transactionTrusted = false
        throw error
      }
      readyForTrash = true
      await options.trash.trashItem(transaction)
      await revalidateMutationBoundaries(canonical.directory, [canonical, content, privateRoot])
      publicStaged = false
      privateStaged = false
      manifestIdentity = undefined
      return await discoverDomains(canonical.directory)
    } catch (error) {
      return restore(error)
    }
  }

  return {
    list: () => observation(() => discoverDomains(options.workspace)),
    require: (slug) =>
      observation(async () => {
        const safeSlug = domainSlugSchema.parse(slug)
        const domain = (await discoverDomains(options.workspace)).find(
          (candidate) => candidate.slug === safeSlug,
        )
        if (!domain) {
          throw catalogError("DOMAIN_NOT_FOUND", "The requested domain does not exist.", {
            slug: safeSlug,
          })
        }
        return domain
      }),
    create: (request) => mutation(() => create(request)),
    rename: (request) => mutation(() => renameDomain(request)),
    remove: (request) => mutation(() => removeDomain(request)),
    assertIdle: async () => {
      if (disposed || blocked !== undefined) throw unavailable()
      if (pendingMutations > 0) {
        throw catalogError("DOMAIN_BUSY", "A domain mutation is still in progress.")
      }
    },
    dispose() {
      if (disposal !== undefined) return disposal
      disposed = true
      disposal = Promise.allSettled([...acceptedOperations]).then(() => {
        if (blocked !== undefined) throw blocked
      })
      return disposal
    },
  }
}
