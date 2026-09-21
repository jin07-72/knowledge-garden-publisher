import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, extname, isAbsolute, posix, relative, resolve } from "node:path"
import { parseDocument } from "yaml"
import type { AppError, Visibility } from "../../shared/contracts"
import { systemCommandRunner, type CommandRunner } from "../lib/commandRunner"

const validDomains = new Set<NoteDomain>(["technology", "reading", "language", "life"])
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const hashPattern = /^[a-f0-9]{64}$/
const stateName = ".garden-publisher"
const transactionDirectoryName = "transactions"
const keyRelativePath = `${stateName}/keys/recovery-hmac.key`

export type NoteDomain = "technology" | "reading" | "language" | "life"

export interface TransactionRevision {
  mtimeMs: number
  contentHash: string
}

export interface TransactionMove {
  source: string
  target: string
  revision: TransactionRevision
  mode: number
  kind: "note" | "attachment"
}

export interface TransactionCollisionCheck {
  path: string
  expected: "absent"
}

export interface WikiLinkEdit {
  path: string
  revision: TransactionRevision
  oldTarget: string
  newTarget: string
  count: number
  qualification: "qualified" | "unqualified"
}

interface TransactionPlanBase {
  version: 1
  id: string
  createdAt: string
  workspaceIdentity: string
  source: string
  target: string
  sourceRevision: TransactionRevision
  moves: TransactionMove[]
  collisionChecks: TransactionCollisionCheck[]
  warnings: TransactionWarning[]
  integrity: string
}

export interface VisibilityChangePlan extends TransactionPlanBase {
  kind: "visibility"
  visibility: Visibility
  historyWarning: boolean
  linkEdits: []
}

export interface RenamePlan extends TransactionPlanBase {
  kind: "rename"
  visibility: Visibility
  oldDomain: NoteDomain
  oldSlug: string
  newDomain: NoteDomain
  newSlug: string
  alias: string
  linkEdits: WikiLinkEdit[]
}

export type NoteTransactionPlan = VisibilityChangePlan | RenamePlan

export interface VisibilityChangeInput {
  workspace: string
  path: string
  visibility: Visibility
  runner?: CommandRunner
}

export interface RenameInput {
  workspace: string
  path: string
  domain?: NoteDomain
  slug?: string
  newDomain?: NoteDomain
  newSlug?: string
}

export type TransactionPhase =
  | "journal-created"
  | "note-published"
  | "links-published"
  | "attachments-published"
  | "source-removed"

export interface NoteTransactionAdapter {
  afterPhase?: (phase: TransactionPhase) => Promise<void> | void
  beforePublish?: (path: string) => Promise<void> | void
  beforeAttachmentRootPublish?: (path: string) => Promise<void> | void
  beforeRollback?: () => Promise<void> | void
}

export interface TransactionContext {
  workspace: string
  adapter?: NoteTransactionAdapter
}

export interface TransactionWarning {
  code: "PUBLIC_HISTORY_REMAINS"
  message: string
}

export interface TransactionResult {
  id: string
  changedPaths: string[]
  pendingPublicDeletion?: string
  historyWarning: boolean
  warnings: TransactionWarning[]
}

export interface PendingTransaction {
  id: string
  kind: "visibility" | "rename"
  createdAt: string
  phase: string
  paths: string[]
}

interface SafeFile {
  bytes: Buffer
  revision: TransactionRevision
  mode: number
}

interface ParsedNotePath {
  visibility: Visibility
  root: "content" | "private"
  domain: NoteDomain
  slug: string
  path: string
}

interface JournalBackup {
  path: string
  file: string
  contentHash: string
  mode: number
}

interface JournalPayload {
  version: 1
  id: string
  kind: "visibility" | "rename"
  createdAt: string
  phase: string
  paths: string[]
  backups: JournalBackup[]
}

interface JournalManifest extends JournalPayload {
  integrity: string
}

function transactionError(
  code: Extract<AppError["code"], `TRANSACTION_${string}`>,
  message: string,
  details?: AppError["details"],
): AppError {
  return details === undefined
    ? ({ code, message } as AppError)
    : ({ code, message, details } as AppError)
}

function blocked(issue: string, path: string): AppError {
  return transactionError(
    "TRANSACTION_PLAN_BLOCKED",
    "The note transaction cannot be planned safely.",
    {
      issue,
      path,
    },
  )
}

function rethrowPlanningError(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("TRANSACTION_")
  ) {
    throw error
  }
  throw blocked("PLANNING_FAILED", ".")
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function forward(path: string): string {
  return path.replaceAll("\\", "/")
}

function inside(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate)
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`
}

function hmac(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex")
}

function sameMac(left: string, right: string): boolean {
  if (!hashPattern.test(left) || !hashPattern.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

async function canonicalWorkspace(input: string): Promise<{ root: string; identity: string }> {
  try {
    const root = await realpath(resolve(input))
    const details = await stat(root, { bigint: true })
    if (!details.isDirectory()) throw new Error("not a directory")
    return {
      root,
      identity: sha256(`${root}\0${details.dev}:${details.ino}:${details.birthtimeNs}`),
    }
  } catch {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The transaction workspace is unavailable.")
  }
}

function absolutePath(workspace: string, path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw transactionError(
      "TRANSACTION_PLAN_INVALID",
      "The transaction plan contains an invalid path.",
    )
  }
  const candidate = resolve(workspace, ...path.split("/"))
  if (!inside(workspace, candidate)) {
    throw transactionError(
      "TRANSACTION_PLAN_INVALID",
      "The transaction plan contains an invalid path.",
    )
  }
  return candidate
}

function parseNotePath(path: string): ParsedNotePath {
  if (!path || path.includes("\\") || isAbsolute(path) || posix.isAbsolute(path)) {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The note path is invalid.", { path: "." })
  }
  const parts = path.split("/")
  if (parts.length !== 3) {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The note path is invalid.", { path })
  }
  const [root, domain, filename] = parts
  const visibility = root === "content" ? "public" : root === "private" ? "private" : undefined
  const slug = filename?.endsWith(".md") ? filename.slice(0, -3) : ""
  if (
    visibility === undefined ||
    !validDomains.has(domain as NoteDomain) ||
    slug === "index" ||
    !slugPattern.test(slug) ||
    `${root}/${domain}/${slug}.md` !== path
  ) {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The note path is invalid.", { path })
  }
  return {
    visibility,
    root: root as "content" | "private",
    domain: domain as NoteDomain,
    slug,
    path,
  }
}

async function ensureSafeDirectory(path: string, parent: string): Promise<void> {
  const details = await lstat(path)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("unsafe directory")
  const canonical = await realpath(path)
  if (!inside(parent, canonical)) throw new Error("unsafe directory")
}

async function safeFile(workspace: string, path: string): Promise<SafeFile> {
  const target = absolutePath(workspace, path)
  let handle
  try {
    const before = await lstat(target, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("unsafe file")
    const canonical = await realpath(target)
    if (!inside(workspace, canonical)) throw new Error("escaped file")
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(target, flags)
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}` !==
        `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}`
    ) {
      throw new Error("changed file")
    }
    const bytes = await handle.readFile()
    const after = await lstat(target, { bigint: true })
    if (
      `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}` !==
      `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}`
    ) {
      throw new Error("changed file")
    }
    const ordinary = await handle.stat()
    return {
      bytes,
      revision: { mtimeMs: ordinary.mtimeMs, contentHash: sha256(bytes) },
      mode: Number(opened.mode),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw transactionError("TRANSACTION_STALE", "A transaction source is missing.", { path })
    }
    if ((error as { code?: string }).code?.startsWith("TRANSACTION_")) throw error
    throw transactionError("TRANSACTION_PLAN_BLOCKED", "A transaction source is unsafe.", {
      issue: "UNSAFE_SOURCE",
      path,
    })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function pathState(
  workspace: string,
  path: string,
): Promise<"absent" | "present" | "unsafe"> {
  try {
    const details = await lstat(absolutePath(workspace, path))
    return details.isSymbolicLink() ? "unsafe" : "present"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
    return "unsafe"
  }
}

async function ensureStateDirectories(workspace: string): Promise<void> {
  const state = resolve(workspace, stateName)
  try {
    await mkdir(state, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  await ensureSafeDirectory(state, workspace)
  for (const child of ["keys", transactionDirectoryName, "transaction-locks"]) {
    const path = resolve(state, child)
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    await ensureSafeDirectory(path, state)
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function durableWrite(path: string, bytes: Uint8Array | string, mode = 0o600): Promise<void> {
  let handle
  try {
    handle = await open(path, "wx", mode)
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function trustKey(workspace: string, create: boolean): Promise<Buffer> {
  if (create) await ensureStateDirectories(workspace)
  const path = resolve(workspace, ...keyRelativePath.split("/"))
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("unsafe key")
    const key = await readFile(path)
    if (key.length !== 32) throw new Error("invalid key")
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      throw transactionError(
        "TRANSACTION_PLAN_INVALID",
        "The transaction trust key is unavailable.",
      )
    }
  }
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    const key = randomBytes(32)
    await durableWrite(temporary, key)
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  const key = await readFile(path)
  if (key.length !== 32)
    throw transactionError("TRANSACTION_PLAN_INVALID", "The transaction trust key is unavailable.")
  return key
}

function unsignedPlan<T extends NoteTransactionPlan>(plan: T): Omit<T, "integrity"> {
  const { integrity: _integrity, ...unsigned } = plan
  return unsigned
}

function signPlan<T extends Omit<NoteTransactionPlan, "integrity">>(
  plan: T,
  key: Buffer,
): T & { integrity: string } {
  return { ...plan, integrity: hmac(key, plan) }
}

async function attachmentFiles(
  workspace: string,
  root: "content" | "private",
  slug: string,
): Promise<TransactionMove[]> {
  const sourceRoot = `${root}/_assets/${slug}`
  const absoluteRoot = absolutePath(workspace, sourceRoot)
  try {
    const details = await lstat(absoluteRoot)
    if (details.isSymbolicLink() || !details.isDirectory())
      throw blocked("UNSAFE_ATTACHMENT_ENTRY", sourceRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    if ((error as { code?: string }).code === "TRANSACTION_PLAN_BLOCKED") throw error
    throw blocked("UNSAFE_ATTACHMENT_ENTRY", sourceRoot)
  }
  const moves: TransactionMove[] = []
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = resolve(directory, entry.name)
      const relativeChild = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const display = `${sourceRoot}/${relativeChild}`
      const details = await lstat(child)
      if (details.isSymbolicLink()) throw blocked("UNSAFE_ATTACHMENT_ENTRY", display)
      if (details.isDirectory()) {
        if (!inside(absoluteRoot, await realpath(child)))
          throw blocked("UNSAFE_ATTACHMENT_ENTRY", display)
        await visit(child, relativeChild)
      } else if (details.isFile()) {
        const file = await safeFile(workspace, display)
        moves.push({
          source: display,
          target: display,
          revision: file.revision,
          mode: file.mode,
          kind: "attachment",
        })
      } else {
        throw blocked("UNSAFE_ATTACHMENT_ENTRY", display)
      }
    }
  }
  await visit(absoluteRoot, "")
  return moves
}

function externalReference(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)
}

interface LocalReferenceOccurrence {
  start: number
  end: number
  target: string
  syntax: "markdown" | "wiki-embed"
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function localReferenceOccurrences(source: string): LocalReferenceOccurrence[] {
  const mask = markdownMask(source)
  const occurrences: LocalReferenceOccurrence[] = []
  const ordinary = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g
  for (const match of mask.matchAll(ordinary)) {
    const index = match.index
    if (escapedAt(source, index)) continue
    const maskedTarget = match[1]
    const targetOffset = match[0].indexOf(maskedTarget)
    let start = index + targetOffset
    let end = start + maskedTarget.length
    if (source[start] === "<" && source[end - 1] === ">") {
      start += 1
      end -= 1
    }
    const target = source.slice(start, end)
    if (!externalReference(target)) occurrences.push({ start, end, target, syntax: "markdown" })
  }
  const embeds = /!\[\[([^\]\n]+)\]\]/g
  for (const match of mask.matchAll(embeds)) {
    const index = match.index
    if (escapedAt(source, index)) continue
    const rawInner = source.slice(index + 3, index + match[0].length - 2)
    const target = rawInner.split("|", 1)[0].split("#", 1)[0].trim()
    if (!target || externalReference(target)) continue
    const targetOffset = rawInner.indexOf(target)
    const start = index + 3 + targetOffset
    occurrences.push({ start, end: start + target.length, target, syntax: "wiki-embed" })
  }
  return occurrences.sort((left, right) => left.start - right.start)
}

function attachmentCandidate(
  workspace: string,
  note: ParsedNotePath,
  occurrence: LocalReferenceOccurrence,
): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(occurrence.target.split(/[?#]/, 1)[0])
  } catch {
    throw blocked("AMBIGUOUS_ATTACHMENT", note.path)
  }
  if (!decoded || decoded.includes("\\")) throw blocked("AMBIGUOUS_ATTACHMENT", note.path)
  const extension = extname(decoded).toLowerCase()
  if (extension === ".md" || (occurrence.syntax === "wiki-embed" && extension === "")) {
    return undefined
  }
  const candidate = decoded.startsWith("/")
    ? resolve(workspace, note.root, decoded.slice(1))
    : decoded.startsWith("_assets/")
      ? resolve(workspace, note.root, decoded)
      : resolve(workspace, note.root, note.domain, decoded)
  if (!inside(workspace, candidate)) throw blocked("AMBIGUOUS_ATTACHMENT", note.path)
  return candidate
}

async function assertOwnedReferences(
  workspace: string,
  note: ParsedNotePath,
  markdown: string,
): Promise<void> {
  const owned = resolve(workspace, note.root, "_assets", note.slug)
  for (const occurrence of localReferenceOccurrences(markdown)) {
    const candidate = attachmentCandidate(workspace, note, occurrence)
    if (candidate === undefined) continue
    if (!inside(owned, candidate)) throw blocked("AMBIGUOUS_ATTACHMENT", note.path)
  }
  for (const scanned of await scanMarkdown(workspace)) {
    if (scanned.path === note.path) continue
    for (const occurrence of localReferenceOccurrences(scanned.file.bytes.toString("utf8"))) {
      const candidate = attachmentCandidate(workspace, scanned.note, occurrence)
      if (candidate !== undefined && inside(owned, candidate)) {
        throw blocked("SHARED_ATTACHMENT", scanned.path)
      }
    }
  }
}

async function trackedByGit(
  workspace: string,
  path: string,
  runner: CommandRunner,
): Promise<boolean> {
  try {
    const result = await runner.run({
      executable: "git",
      args: ["ls-files", "--error-unmatch", "--", path],
      cwd: workspace,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    })
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
  } catch {
    // Converted to a stable, body-free planning issue below.
  }
  throw blocked("GIT_HISTORY_CHECK_FAILED", path)
}

async function buildBase(
  workspaceInput: string,
  sourcePath: string,
  targetPath: string,
  attachmentTargetRoot: string,
  remapAttachment: (path: string) => string,
): Promise<{
  workspace: string
  workspaceIdentity: string
  sourceFile: SafeFile
  moves: TransactionMove[]
  collisionChecks: TransactionCollisionCheck[]
  key: Buffer
}> {
  const { root: workspace, identity: workspaceIdentity } = await canonicalWorkspace(workspaceInput)
  const sourceFile = await safeFile(workspace, sourcePath)
  const source = parseNotePath(sourcePath)
  const sourceAttachmentRoot = `${source.root}/_assets/${source.slug}`
  const attachmentMoves =
    sourceAttachmentRoot === attachmentTargetRoot
      ? []
      : await attachmentFiles(workspace, source.root, source.slug)
  for (const move of attachmentMoves) move.target = remapAttachment(move.source)
  const noteMove: TransactionMove = {
    source: sourcePath,
    target: targetPath,
    revision: sourceFile.revision,
    mode: sourceFile.mode,
    kind: "note",
  }
  if ((await pathState(workspace, targetPath)) !== "absent")
    throw blocked("TARGET_EXISTS", targetPath)
  if (
    attachmentMoves.length > 0 &&
    (await pathState(workspace, attachmentTargetRoot)) !== "absent"
  ) {
    throw blocked("ATTACHMENT_TARGET_EXISTS", attachmentTargetRoot)
  }
  const collisionChecks = [
    targetPath,
    ...(attachmentMoves.length > 0
      ? [attachmentTargetRoot, ...attachmentMoves.map(({ target }) => target)]
      : []),
  ].map((path) => ({ path, expected: "absent" as const }))
  const key = await trustKey(workspace, true)
  return {
    workspace,
    workspaceIdentity,
    sourceFile,
    moves: [noteMove, ...attachmentMoves],
    collisionChecks,
    key,
  }
}

async function buildVisibilityChangePlan(
  input: VisibilityChangeInput,
): Promise<VisibilityChangePlan> {
  const source = parseNotePath(input.path)
  if (input.visibility !== "public" && input.visibility !== "private") {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The requested visibility is invalid.")
  }
  if (source.visibility === input.visibility) {
    throw transactionError(
      "TRANSACTION_PLAN_INVALID",
      "The note already has the requested visibility.",
      {
        path: source.path,
      },
    )
  }
  const targetRoot = input.visibility === "public" ? "content" : "private"
  const target = `${targetRoot}/${source.domain}/${source.slug}.md`
  const sourceAttachmentRoot = `${source.root}/_assets/${source.slug}`
  const targetAttachmentRoot = `${targetRoot}/_assets/${source.slug}`
  const base = await buildBase(
    input.workspace,
    source.path,
    target,
    targetAttachmentRoot,
    (path) => `${targetAttachmentRoot}${path.slice(sourceAttachmentRoot.length)}`,
  )
  await assertOwnedReferences(base.workspace, source, base.sourceFile.bytes.toString("utf8"))
  const historyWarning =
    source.visibility === "public"
      ? await trackedByGit(base.workspace, source.path, input.runner ?? systemCommandRunner)
      : false
  const warnings: TransactionWarning[] = historyWarning
    ? [
        {
          code: "PUBLIC_HISTORY_REMAINS",
          message: "Published Git history still contains this note.",
        },
      ]
    : []
  return signPlan(
    {
      version: 1,
      kind: "visibility",
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      workspaceIdentity: base.workspaceIdentity,
      source: source.path,
      target,
      sourceRevision: base.sourceFile.revision,
      visibility: input.visibility,
      moves: base.moves,
      collisionChecks: base.collisionChecks,
      linkEdits: [],
      historyWarning,
      warnings,
    },
    base.key,
  ) as VisibilityChangePlan
}

export async function planVisibilityChange(
  input: VisibilityChangeInput,
): Promise<VisibilityChangePlan> {
  try {
    return await buildVisibilityChangePlan(input)
  } catch (error) {
    rethrowPlanningError(error)
  }
}

interface ScannedMarkdown {
  path: string
  file: SafeFile
  note: ParsedNotePath
}

async function scanMarkdown(workspace: string): Promise<ScannedMarkdown[]> {
  const scanned: ScannedMarkdown[] = []
  for (const root of ["content", "private"] as const) {
    const rootPath = resolve(workspace, root)
    await ensureSafeDirectory(rootPath, workspace).catch(() => {
      throw blocked("UNSAFE_MARKDOWN_TREE", root)
    })
    for (const domain of [...validDomains].sort()) {
      const directory = resolve(rootPath, domain)
      try {
        await ensureSafeDirectory(directory, rootPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw blocked("UNSAFE_MARKDOWN_TREE", `${root}/${domain}`)
      }
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const path = `${root}/${domain}/${entry.name}`
        if (entry.isSymbolicLink()) throw blocked("UNSAFE_MARKDOWN_TREE", path)
        if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") continue
        let note: ParsedNotePath
        try {
          note = parseNotePath(path)
        } catch {
          continue
        }
        scanned.push({ path, note, file: await safeFile(workspace, path) })
      }
    }
  }
  return scanned
}

function maskRange(mask: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1)
    if (mask[index] !== "\n" && mask[index] !== "\r") mask[index] = " "
}

function markdownMask(source: string): string {
  const mask = [...source]
  const bom = source.startsWith("\uFEFF") ? 1 : 0
  if (source.slice(bom).startsWith("---")) {
    const frontmatter = /^(?:\uFEFF)?---[\t ]*\r?\n[\s\S]*?^---[\t ]*(?:\r?\n|$)/m.exec(source)
    if (frontmatter?.index === 0) maskRange(mask, 0, frontmatter[0].length)
  }
  const fence = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm
  let opening: RegExpExecArray | null
  while ((opening = fence.exec(source)) !== null) {
    const marker = opening[2][0]
    if (mask[opening.index + opening[1].length] !== marker) continue
    const minimumLength = opening[2].length
    const closing = /^( {0,3})(`+|~+)[\t ]*(?:\r?\n|$)/gm
    closing.lastIndex = fence.lastIndex
    let end = source.length
    let candidate: RegExpExecArray | null
    while ((candidate = closing.exec(source)) !== null) {
      if (candidate[2][0] === marker && candidate[2].length >= minimumLength) {
        end = candidate.index + candidate[0].length
        break
      }
    }
    maskRange(mask, opening.index, end)
    fence.lastIndex = end
  }
  for (const match of source.matchAll(/^(?: {4}|\t).*$/gm)) {
    maskRange(mask, match.index, match.index + match[0].length)
  }
  for (const match of source.matchAll(/(`+)[^\r\n]*?\1/g))
    maskRange(mask, match.index, match.index + match[0].length)
  for (const match of source.matchAll(/https?:\/\/[^\s<>()]+/g))
    maskRange(mask, match.index, match.index + match[0].length)
  return mask.join("")
}

interface WikiOccurrence {
  start: number
  end: number
  target: string
}

function wikiOccurrences(source: string): WikiOccurrence[] {
  const mask = markdownMask(source)
  const occurrences: WikiOccurrence[] = []
  const expression = /!?\[\[([^\]\n]+)\]\]/g
  for (const match of mask.matchAll(expression)) {
    const index = match.index
    let slashes = 0
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1
    if (slashes % 2 === 1) continue
    const rawInner = source.slice(
      index + (source[index] === "!" ? 3 : 2),
      index + match[0].length - 2,
    )
    const target = rawInner.split("|", 1)[0].split("#", 1)[0].trim()
    if (!target) continue
    const targetOffset = rawInner.indexOf(target)
    const innerStart = index + (source[index] === "!" ? 3 : 2)
    occurrences.push({
      start: innerStart + targetOffset,
      end: innerStart + targetOffset + target.length,
      target,
    })
  }
  return occurrences
}

function assertAliasSupported(markdown: string): void {
  const match = /^(?:\uFEFF)?---[\t ]*\r?\n([\s\S]*?)^---[\t ]*(?:\r?\n|$)/m.exec(markdown)
  if (match?.index !== 0) throw blocked("ALIASES_UNSUPPORTED", "frontmatter")
  const document = parseDocument(match[1])
  if (document.errors.length > 0) throw blocked("ALIASES_UNSUPPORTED", "frontmatter")
  const value = document.toJS() as unknown
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw blocked("ALIASES_UNSUPPORTED", "frontmatter")
  }
  const aliases = (value as Record<string, unknown>).aliases
  if (
    aliases !== undefined &&
    typeof aliases !== "string" &&
    (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string"))
  ) {
    throw blocked("ALIASES_UNSUPPORTED", "frontmatter")
  }
}

function addAlias(markdown: string, alias: string): string {
  assertAliasSupported(markdown)
  const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n"
  const frontmatter = /^(?:\uFEFF)?---[\t ]*\r?\n([\s\S]*?)^---[\t ]*(?:\r?\n|$)/m.exec(markdown)!
  const full = frontmatter[0]
  const body = frontmatter[1]
  const document = parseDocument(body)
  const values = (document.toJS() as Record<string, unknown>).aliases
  const aliases =
    values === undefined ? [] : typeof values === "string" ? [values] : (values as string[])
  if (aliases.includes(alias)) return markdown
  const escapedAlias = alias
  let updated: string
  const flow = /^aliases:[\t ]*\[([^\r\n]*)\][\t ]*$/m.exec(body)
  if (flow) {
    const insertion = flow[1].trim() === "" ? escapedAlias : `${flow[1]}, ${escapedAlias}`
    updated =
      body.slice(0, flow.index) +
      flow[0].replace(flow[1], insertion) +
      body.slice(flow.index + flow[0].length)
  } else {
    const block = /^aliases:[\t ]*\r?\n((?:[\t ]+-[^\r\n]*(?:\r?\n|$))*)/m.exec(body)
    if (block) {
      const insertAt = block.index + block[0].length
      const separator = block[0].endsWith("\n") ? "" : lineEnding
      updated =
        body.slice(0, insertAt) +
        `${separator}  - ${escapedAlias}${lineEnding}` +
        body.slice(insertAt)
    } else {
      const scalar = /^aliases:[\t ]*([^\r\n]+)[\t ]*$/m.exec(body)
      if (scalar) {
        const previous = scalar[1].trim()
        updated =
          body.slice(0, scalar.index) +
          `aliases:${lineEnding}  - ${previous}${lineEnding}  - ${escapedAlias}` +
          body.slice(scalar.index + scalar[0].length)
      } else {
        updated = `${body}aliases:${lineEnding}  - ${escapedAlias}${lineEnding}`
      }
    }
  }
  const bodyStart = full.indexOf(body)
  return markdown.slice(0, bodyStart) + updated + markdown.slice(bodyStart + body.length)
}

function rewriteOwnedAttachmentReferences(
  markdown: string,
  workspace: string,
  source: ParsedNotePath,
  newSlug: string,
): string {
  if (source.slug === newSlug) return markdown
  const owned = resolve(workspace, source.root, "_assets", source.slug)
  const segment = `/_assets/${source.slug}/`
  const replacementSegment = `/_assets/${newSlug}/`
  const replacements: Array<{ start: number; end: number; replacement: string }> = []
  for (const occurrence of localReferenceOccurrences(markdown)) {
    const candidate = attachmentCandidate(workspace, source, occurrence)
    if (candidate === undefined || !inside(owned, candidate)) continue
    const normalized = occurrence.target.replaceAll("\\", "/")
    const segmentIndex = normalized.indexOf(segment)
    const rootRelativePrefix = `_assets/${source.slug}/`
    const rootRelativeIndex = normalized.indexOf(rootRelativePrefix)
    let replacement: string
    if (segmentIndex >= 0) {
      replacement =
        occurrence.target.slice(0, segmentIndex) +
        replacementSegment +
        occurrence.target.slice(segmentIndex + segment.length)
    } else if (rootRelativeIndex === 0) {
      replacement = `_assets/${newSlug}/${occurrence.target.slice(rootRelativePrefix.length)}`
    } else {
      throw blocked("AMBIGUOUS_ATTACHMENT", source.path)
    }
    replacements.push({ start: occurrence.start, end: occurrence.end, replacement })
  }
  replacements.sort((left, right) => right.start - left.start)
  let result = markdown
  for (const edit of replacements) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}

function applyWikiEdits(source: string, edits: readonly WikiLinkEdit[]): string {
  const replacements: Array<WikiOccurrence & { replacement: string }> = []
  for (const edit of edits) {
    const matches = wikiOccurrences(source).filter(({ target }) => target === edit.oldTarget)
    if (matches.length !== edit.count) {
      throw transactionError("TRANSACTION_STALE", "A Wiki-link edit no longer matches its plan.", {
        path: edit.path,
      })
    }
    for (const match of matches) replacements.push({ ...match, replacement: edit.newTarget })
  }
  replacements.sort((left, right) => right.start - left.start)
  let result = source
  for (const replacement of replacements) {
    result =
      result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end)
  }
  return result
}

async function buildRenamePlan(input: RenameInput): Promise<RenamePlan> {
  const source = parseNotePath(input.path)
  const newDomain = input.domain ?? input.newDomain ?? source.domain
  const newSlug = input.slug ?? input.newSlug ?? source.slug
  if (!validDomains.has(newDomain) || !slugPattern.test(newSlug) || newSlug === "index") {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The rename target is invalid.", {
      path: source.path,
    })
  }
  if (newDomain === source.domain && newSlug === source.slug) {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The rename target matches the source.", {
      path: source.path,
    })
  }
  const target = `${source.root}/${newDomain}/${newSlug}.md`
  const sourceAttachmentRoot = `${source.root}/_assets/${source.slug}`
  const targetAttachmentRoot = `${source.root}/_assets/${newSlug}`
  const base = await buildBase(
    input.workspace,
    source.path,
    target,
    targetAttachmentRoot,
    (path) => `${targetAttachmentRoot}${path.slice(sourceAttachmentRoot.length)}`,
  )
  const sourceMarkdown = base.sourceFile.bytes.toString("utf8")
  assertAliasSupported(sourceMarkdown)
  await assertOwnedReferences(base.workspace, source, sourceMarkdown)
  const notes = await scanMarkdown(base.workspace)
  const sameSlug = notes.filter(({ note }) => note.slug === source.slug)
  const oldQualified = `${source.domain}/${source.slug}`
  const newQualified = `${newDomain}/${newSlug}`
  const linkEdits: WikiLinkEdit[] = []
  for (const scanned of notes) {
    const occurrences = wikiOccurrences(scanned.file.bytes.toString("utf8"))
    const qualifiedCount = occurrences.filter(({ target: link }) => link === oldQualified).length
    if (qualifiedCount > 0) {
      linkEdits.push({
        path: scanned.path,
        revision: scanned.file.revision,
        oldTarget: oldQualified,
        newTarget: newQualified,
        count: qualifiedCount,
        qualification: "qualified",
      })
    }
    const unqualifiedCount = occurrences.filter(({ target: link }) => link === source.slug).length
    if (unqualifiedCount > 0 && newSlug !== source.slug) {
      if (sameSlug.length !== 1) throw blocked("AMBIGUOUS_WIKI_LINK", scanned.path)
      linkEdits.push({
        path: scanned.path,
        revision: scanned.file.revision,
        oldTarget: source.slug,
        newTarget: newSlug,
        count: unqualifiedCount,
        qualification: "unqualified",
      })
    }
  }
  linkEdits.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.oldTarget.localeCompare(right.oldTarget),
  )
  const alias = newSlug !== source.slug ? source.slug : oldQualified
  return signPlan(
    {
      version: 1,
      kind: "rename",
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      workspaceIdentity: base.workspaceIdentity,
      source: source.path,
      target,
      sourceRevision: base.sourceFile.revision,
      visibility: source.visibility,
      oldDomain: source.domain,
      oldSlug: source.slug,
      newDomain,
      newSlug,
      alias,
      moves: base.moves,
      collisionChecks: base.collisionChecks,
      linkEdits,
      warnings: [],
    },
    base.key,
  ) as RenamePlan
}

export async function planRename(input: RenameInput): Promise<RenamePlan> {
  try {
    return await buildRenamePlan(input)
  } catch (error) {
    rethrowPlanningError(error)
  }
}

function isPlanShape(value: unknown): value is NoteTransactionPlan {
  if (typeof value !== "object" || value === null) return false
  const plan = value as Partial<NoteTransactionPlan>
  return (
    plan.version === 1 &&
    (plan.kind === "visibility" || plan.kind === "rename") &&
    typeof plan.id === "string" &&
    /^[a-f0-9-]{36}$/i.test(plan.id) &&
    typeof plan.createdAt === "string" &&
    !Number.isNaN(Date.parse(plan.createdAt)) &&
    typeof plan.workspaceIdentity === "string" &&
    hashPattern.test(plan.workspaceIdentity) &&
    typeof plan.source === "string" &&
    typeof plan.target === "string" &&
    typeof plan.integrity === "string" &&
    hashPattern.test(plan.integrity) &&
    Array.isArray(plan.moves) &&
    Array.isArray(plan.collisionChecks) &&
    Array.isArray(plan.linkEdits) &&
    Array.isArray(plan.warnings)
  )
}

async function verifyPlan(
  plan: unknown,
  expectedKind: NoteTransactionPlan["kind"],
  workspaceInput: string,
): Promise<{ plan: NoteTransactionPlan; workspace: string; key: Buffer }> {
  if (!isPlanShape(plan) || plan.kind !== expectedKind) {
    throw transactionError("TRANSACTION_PLAN_INVALID", "The transaction plan is invalid.")
  }
  const { root: workspace, identity } = await canonicalWorkspace(workspaceInput)
  if (identity !== plan.workspaceIdentity) {
    throw transactionError(
      "TRANSACTION_PLAN_INVALID",
      "The transaction plan belongs to another workspace.",
    )
  }
  const key = await trustKey(workspace, false)
  if (!sameMac(plan.integrity, hmac(key, unsignedPlan(plan)))) {
    throw transactionError(
      "TRANSACTION_PLAN_INVALID",
      "The transaction plan integrity check failed.",
    )
  }
  // Parsing every plan path after authentication prevents a signed-but-malformed
  // plan produced by an older implementation from escaping the workspace.
  parseNotePath(plan.source)
  parseNotePath(plan.target)
  for (const move of plan.moves) {
    absolutePath(workspace, move.source)
    absolutePath(workspace, move.target)
    if (
      !hashPattern.test(move.revision?.contentHash ?? "") ||
      !Number.isFinite(move.revision?.mtimeMs)
    ) {
      throw transactionError(
        "TRANSACTION_PLAN_INVALID",
        "The transaction plan contains an invalid revision.",
      )
    }
  }
  for (const collision of plan.collisionChecks) absolutePath(workspace, collision.path)
  for (const edit of plan.linkEdits) {
    parseNotePath(edit.path)
    if (
      !hashPattern.test(edit.revision?.contentHash ?? "") ||
      !Number.isFinite(edit.revision?.mtimeMs) ||
      !Number.isInteger(edit.count) ||
      edit.count < 1
    )
      throw transactionError(
        "TRANSACTION_PLAN_INVALID",
        "The transaction plan contains an invalid link edit.",
      )
  }
  return { plan, workspace, key }
}

async function acquireLocks(
  workspace: string,
  paths: readonly string[],
): Promise<() => Promise<void>> {
  await ensureStateDirectories(workspace)
  const root = resolve(workspace, stateName, "transaction-locks")
  const unique = [...new Set(paths)].sort((left, right) => left.localeCompare(right))
  const acquired: string[] = []
  try {
    for (const path of unique) {
      const lock = resolve(root, `${sha256(path)}.lock`)
      try {
        await mkdir(lock, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw transactionError(
            "TRANSACTION_LOCKED",
            "A conflicting note transaction is already running.",
            {
              path,
            },
          )
        }
        throw error
      }
      await durableWrite(
        resolve(lock, "owner.json"),
        `${JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      )
      acquired.push(lock)
    }
  } catch (error) {
    await Promise.all(acquired.reverse().map((path) => rm(path, { recursive: true, force: true })))
    if ((error as { code?: string }).code?.startsWith("TRANSACTION_")) throw error
    throw transactionError("TRANSACTION_LOCKED", "Transaction locks could not be acquired.")
  }
  return async () => {
    for (const path of acquired.reverse()) await rm(path, { recursive: true, force: true })
  }
}

function revisionMatches(actual: TransactionRevision, expected: TransactionRevision): boolean {
  return actual.contentHash === expected.contentHash && actual.mtimeMs === expected.mtimeMs
}

async function revalidatePlan(workspace: string, plan: NoteTransactionPlan): Promise<void> {
  for (const move of plan.moves) {
    let current: SafeFile
    try {
      current = await safeFile(workspace, move.source)
    } catch {
      throw transactionError("TRANSACTION_STALE", "A transaction source changed after planning.", {
        path: move.source,
      })
    }
    if (!revisionMatches(current.revision, move.revision)) {
      throw transactionError("TRANSACTION_STALE", "A transaction source changed after planning.", {
        path: move.source,
      })
    }
  }
  const editRevisions = new Map<string, TransactionRevision>()
  for (const edit of plan.linkEdits) editRevisions.set(edit.path, edit.revision)
  for (const [path, revision] of editRevisions) {
    const current = await safeFile(workspace, path).catch(() => undefined)
    if (current === undefined || !revisionMatches(current.revision, revision)) {
      throw transactionError("TRANSACTION_STALE", "A Wiki-link source changed after planning.", {
        path,
      })
    }
  }
  for (const collision of plan.collisionChecks) {
    if ((await pathState(workspace, collision.path)) !== "absent") {
      throw transactionError(
        "TRANSACTION_COLLISION",
        "A transaction target was created after planning.",
        {
          path: collision.path,
        },
      )
    }
  }
}

function journalIntegrity(key: Buffer, payload: JournalPayload): string {
  return hmac(key, payload)
}

async function writeJournalManifest(
  directory: string,
  payload: JournalPayload,
  key: Buffer,
): Promise<void> {
  const manifest: JournalManifest = { ...payload, integrity: journalIntegrity(key, payload) }
  const target = resolve(directory, "manifest.json")
  const temporary = `${target}.tmp-${randomUUID()}`
  try {
    await durableWrite(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(temporary, target)
    await syncDirectory(directory)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function createJournal(
  workspace: string,
  plan: NoteTransactionPlan,
  key: Buffer,
): Promise<{ directory: string; manifest: JournalPayload; backupFiles: Map<string, SafeFile> }> {
  await ensureStateDirectories(workspace)
  const transactions = resolve(workspace, stateName, transactionDirectoryName)
  const directory = resolve(transactions, plan.id)
  const staging = resolve(transactions, `.staging-${plan.id}-${randomUUID()}`)
  const backupFiles = new Map<string, SafeFile>()
  const paths = [
    ...new Set([
      ...plan.moves.map(({ source }) => source),
      ...plan.linkEdits.map(({ path }) => path),
    ]),
  ].sort((left, right) => left.localeCompare(right))
  try {
    await mkdir(staging, { mode: 0o700 })
    await mkdir(resolve(staging, "backups"), { mode: 0o700 })
    const backups: JournalBackup[] = []
    for (const [index, path] of paths.entries()) {
      const file = await safeFile(workspace, path)
      backupFiles.set(path, file)
      const name = `${String(index).padStart(4, "0")}-${sha256(path)}.bin`
      await durableWrite(resolve(staging, "backups", name), file.bytes)
      backups.push({
        path,
        file: `backups/${name}`,
        contentHash: file.revision.contentHash,
        mode: file.mode,
      })
    }
    const manifest: JournalPayload = {
      version: 1,
      id: plan.id,
      kind: plan.kind,
      createdAt: plan.createdAt,
      phase: "prepared",
      paths: [
        ...new Set([
          ...plan.moves.flatMap(({ source, target }) => [source, target]),
          ...plan.linkEdits.map(({ path }) => path),
        ]),
      ].sort(),
      backups,
    }
    await writeJournalManifest(staging, manifest, key)
    await syncDirectory(resolve(staging, "backups"))
    await syncDirectory(staging)
    try {
      await rename(staging, directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw transactionError(
          "TRANSACTION_PLAN_INVALID",
          "This transaction plan was already executed.",
        )
      }
      throw error
    }
    await syncDirectory(transactions)
    return { directory, manifest, backupFiles }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if ((error as { code?: string }).code?.startsWith("TRANSACTION_")) throw error
    throw transactionError("TRANSACTION_FAILED", "The transaction journal could not be created.")
  }
}

async function updateJournal(
  journal: { directory: string; manifest: JournalPayload },
  phase: string,
  key: Buffer,
): Promise<void> {
  journal.manifest = { ...journal.manifest, phase }
  await writeJournalManifest(journal.directory, journal.manifest, key)
}

async function publishExclusive(
  workspace: string,
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const target = absolutePath(workspace, path)
  const parent = dirname(target)
  await ensureSafeDirectory(parent, workspace)
  const temporary = `${target}.garden-publisher-${randomUUID()}`
  let published = false
  try {
    await durableWrite(temporary, bytes)
    if ((await pathState(workspace, path)) !== "absent") {
      throw transactionError(
        "TRANSACTION_COLLISION",
        "A transaction target was created during execution.",
        { path },
      )
    }
    try {
      // A same-directory hard link publishes the fully synced staging inode
      // atomically and, unlike rename(), never replaces a late external target.
      await link(temporary, target)
      published = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw transactionError(
          "TRANSACTION_COLLISION",
          "A transaction target was created during execution.",
          { path },
        )
      }
      throw error
    }
    await chmod(target, mode & 0o777)
    const installed = await safeFile(workspace, path)
    if (!installed.bytes.equals(bytes)) throw new Error("published bytes changed")
    await syncDirectory(parent)
  } catch (error) {
    if (published) {
      const installed = await safeFile(workspace, path).catch(() => undefined)
      if (installed === undefined || !installed.bytes.equals(bytes)) {
        throw transactionError(
          "TRANSACTION_UNCERTAIN",
          "An exclusive transaction publication could not be confirmed.",
          { path },
        )
      }
      try {
        await rm(target, { force: true })
        await syncDirectory(parent)
      } catch {
        throw transactionError(
          "TRANSACTION_UNCERTAIN",
          "An exclusive transaction publication could not be rolled back.",
          { path },
        )
      }
    }
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function replaceAtomic(
  workspace: string,
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const target = absolutePath(workspace, path)
  const temporary = `${target}.garden-publisher-${randomUUID()}`
  try {
    await durableWrite(temporary, bytes)
    await rename(temporary, target)
    await chmod(target, mode & 0o777)
    const installed = await safeFile(workspace, path)
    if (!installed.bytes.equals(bytes)) throw new Error("replacement changed")
    await syncDirectory(dirname(target))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function editsByPath(plan: NoteTransactionPlan): Map<string, WikiLinkEdit[]> {
  const grouped = new Map<string, WikiLinkEdit[]>()
  for (const edit of plan.linkEdits)
    grouped.set(edit.path, [...(grouped.get(edit.path) ?? []), edit])
  return grouped
}

async function publishAttachments(
  workspace: string,
  plan: NoteTransactionPlan,
  adapter: NoteTransactionAdapter,
  appliedHashes: Map<string, string>,
  publishedRoots: Set<string>,
): Promise<void> {
  const moves = plan.moves.filter(({ kind }) => kind === "attachment")
  if (moves.length === 0) return
  const targetRoot = moves[0].target.split("/").slice(0, 3).join("/")
  const absoluteTargetRoot = absolutePath(workspace, targetRoot)
  const parent = dirname(absoluteTargetRoot)
  await ensureSafeDirectory(parent, workspace)
  const staging = resolve(parent, `.garden-publisher-${plan.id}-${randomUUID()}`)
  try {
    await mkdir(staging, { mode: 0o700 })
    for (const move of moves) {
      const relativeTarget = move.target.slice(targetRoot.length + 1)
      const target = resolve(staging, ...relativeTarget.split("/"))
      if (!inside(staging, target)) throw new Error("invalid attachment target")
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const source = await safeFile(workspace, move.source)
      if (!revisionMatches(source.revision, move.revision)) {
        throw transactionError("TRANSACTION_STALE", "An attachment changed during execution.", {
          path: move.source,
        })
      }
      await durableWrite(target, source.bytes)
      await chmod(target, move.mode & 0o777)
    }
    await adapter.beforePublish?.(targetRoot)
    await adapter.beforeAttachmentRootPublish?.(targetRoot)
    try {
      await mkdir(absoluteTargetRoot, { mode: 0o700 })
      publishedRoots.add(targetRoot)
      await syncDirectory(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      throw transactionError(
        "TRANSACTION_COLLISION",
        "An attachment target was created during execution.",
        { path: targetRoot },
      )
    }
    const createdDirectories = new Set<string>([absoluteTargetRoot])
    for (const move of moves) {
      const relativeTarget = move.target.slice(targetRoot.length + 1)
      const parts = relativeTarget.split("/")
      let directory = absoluteTargetRoot
      for (const part of parts.slice(0, -1)) {
        const child = resolve(directory, part)
        if (!inside(absoluteTargetRoot, child)) throw new Error("invalid attachment target")
        if (!createdDirectories.has(child)) {
          try {
            await mkdir(child, { mode: 0o700 })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw transactionError(
                "TRANSACTION_COLLISION",
                "An attachment target was created during execution.",
                { path: move.target },
              )
            }
            throw error
          }
          await syncDirectory(directory)
          createdDirectories.add(child)
        }
        directory = child
      }
      const staged = await readFile(resolve(staging, ...relativeTarget.split("/")))
      if (sha256(staged) !== move.revision.contentHash) {
        throw new Error("staged attachment verification failed")
      }
      await publishExclusive(workspace, move.target, staged, move.mode)
      appliedHashes.set(move.target, move.revision.contentHash)
      const installed = await safeFile(workspace, move.target)
      if (installed.revision.contentHash !== move.revision.contentHash)
        throw new Error("attachment verification failed")
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function removeSources(
  workspace: string,
  plan: NoteTransactionPlan,
  journalDirectory: string,
): Promise<void> {
  const removed = resolve(journalDirectory, "removed")
  await mkdir(removed, { mode: 0o700 })
  const sourceNote = absolutePath(workspace, plan.source)
  await rename(sourceNote, resolve(removed, "note.md"))
  await syncDirectory(dirname(sourceNote))
  const attachments = plan.moves.filter(({ kind }) => kind === "attachment")
  if (attachments.length > 0) {
    const sourceRoot = attachments[0].source.split("/").slice(0, 3).join("/")
    await rename(absolutePath(workspace, sourceRoot), resolve(removed, "attachments"))
    await syncDirectory(dirname(absolutePath(workspace, sourceRoot)))
  }
  await syncDirectory(removed)
}

async function treeMatchesAppliedMoves(
  workspace: string,
  rootPath: string,
  moves: readonly TransactionMove[],
  appliedHashes: ReadonlyMap<string, string>,
): Promise<boolean> {
  const expected = moves
    .filter((move) => appliedHashes.has(move.target))
    .map((move) => ({
      path: move.target.slice(rootPath.length + 1),
      hash: appliedHashes.get(move.target)!,
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const absoluteRoot = absolutePath(workspace, rootPath)
  const actual: Array<{ path: string; hash: string }> = []
  async function visit(directory: string, prefix: string): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) return false
      if (entry.isDirectory()) {
        if (!(await visit(path, relativePath))) return false
      } else if (entry.isFile()) {
        const bytes = await readFile(path)
        actual.push({ path: relativePath, hash: sha256(bytes) })
      } else return false
    }
    return true
  }
  try {
    if (!(await visit(absoluteRoot, ""))) return false
  } catch {
    return false
  }
  actual.sort((left, right) => left.path.localeCompare(right.path))
  return canonicalJson(actual) === canonicalJson(expected)
}

async function rollback(
  workspace: string,
  plan: NoteTransactionPlan,
  journal: { directory: string; manifest: JournalPayload; backupFiles: Map<string, SafeFile> },
  key: Buffer,
  adapter: NoteTransactionAdapter,
  appliedHashes: ReadonlyMap<string, string>,
  publishedRoots: ReadonlySet<string>,
): Promise<boolean> {
  try {
    await adapter.beforeRollback?.()
    const attachmentMoves = plan.moves.filter(({ kind }) => kind === "attachment")
    const sourceRoot = attachmentMoves[0]?.source.split("/").slice(0, 3).join("/")
    const targetRoot = attachmentMoves[0]?.target.split("/").slice(0, 3).join("/")
    const removed = resolve(journal.directory, "removed")
    if (sourceRoot && (await pathState(workspace, sourceRoot)) === "absent") {
      const removedAssets = resolve(removed, "attachments")
      try {
        await rename(removedAssets, absolutePath(workspace, sourceRoot))
      } catch {
        for (const move of attachmentMoves) {
          const backup = journal.backupFiles.get(move.source)
          if (!backup) return false
          await mkdir(dirname(absolutePath(workspace, move.source)), {
            recursive: true,
            mode: 0o700,
          })
          await publishExclusive(workspace, move.source, backup.bytes, backup.mode)
        }
      }
    }
    const sourceBackup = journal.backupFiles.get(plan.source)
    if (!sourceBackup) return false
    if ((await pathState(workspace, plan.source)) === "absent") {
      await publishExclusive(workspace, plan.source, sourceBackup.bytes, sourceBackup.mode)
    } else {
      const current = await safeFile(workspace, plan.source)
      if (!current.bytes.equals(sourceBackup.bytes)) return false
    }
    if (
      targetRoot &&
      publishedRoots.has(targetRoot) &&
      (await pathState(workspace, targetRoot)) === "present"
    ) {
      if (!(await treeMatchesAppliedMoves(workspace, targetRoot, attachmentMoves, appliedHashes)))
        return false
      await rm(absolutePath(workspace, targetRoot), { recursive: true, force: true })
      await syncDirectory(dirname(absolutePath(workspace, targetRoot)))
    }
    for (const path of new Set(plan.linkEdits.map(({ path }) => path))) {
      if (path === plan.source) continue
      const backup = journal.backupFiles.get(path)
      if (!backup) return false
      const current = await safeFile(workspace, path)
      const appliedHash = appliedHashes.get(path)
      if (appliedHash === undefined) {
        if (!current.bytes.equals(backup.bytes)) return false
      } else {
        if (current.revision.contentHash !== appliedHash) return false
        await replaceAtomic(workspace, path, backup.bytes, backup.mode)
      }
    }
    if ((await pathState(workspace, plan.target)) === "present") {
      const target = await safeFile(workspace, plan.target)
      if (target.revision.contentHash !== appliedHashes.get(plan.target)) return false
      await rm(absolutePath(workspace, plan.target), { force: true })
      await syncDirectory(dirname(absolutePath(workspace, plan.target)))
    }
    for (const [path, backup] of journal.backupFiles) {
      const current = await safeFile(workspace, path)
      if (
        current.revision.contentHash !== backup.revision.contentHash ||
        !current.bytes.equals(backup.bytes)
      )
        return false
    }
    if ((await pathState(workspace, plan.target)) !== "absent") return false
    if (
      targetRoot &&
      publishedRoots.has(targetRoot) &&
      (await pathState(workspace, targetRoot)) !== "absent"
    )
      return false
    await updateJournal(journal, "rolled-back", key)
    return true
  } catch {
    return false
  }
}

function planPaths(plan: NoteTransactionPlan): string[] {
  return [
    ...new Set([
      ...plan.moves.flatMap(({ source, target }) => [source, target]),
      ...plan.linkEdits.map(({ path }) => path),
    ]),
  ]
}

async function readJournalManifest(
  directory: string,
  key: Buffer,
): Promise<JournalManifest | undefined> {
  try {
    const details = await lstat(directory)
    if (details.isSymbolicLink() || !details.isDirectory()) return undefined
    const manifestPath = resolve(directory, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<JournalManifest>
    if (
      manifest.version !== 1 ||
      typeof manifest.id !== "string" ||
      (manifest.kind !== "visibility" && manifest.kind !== "rename") ||
      typeof manifest.createdAt !== "string" ||
      typeof manifest.phase !== "string" ||
      !Array.isArray(manifest.paths) ||
      !manifest.paths.every((path) => typeof path === "string") ||
      !Array.isArray(manifest.backups) ||
      typeof manifest.integrity !== "string"
    )
      return undefined
    const payload: JournalPayload = {
      version: 1,
      id: manifest.id,
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      phase: manifest.phase,
      paths: manifest.paths as string[],
      backups: manifest.backups as JournalBackup[],
    }
    if (!sameMac(manifest.integrity, journalIntegrity(key, payload))) return undefined
    return { ...payload, integrity: manifest.integrity }
  } catch {
    return undefined
  }
}

export async function inspectPendingTransactions(
  input: { workspace: string } | string,
): Promise<PendingTransaction[]> {
  const { root: workspace } = await canonicalWorkspace(
    typeof input === "string" ? input : input.workspace,
  )
  let key: Buffer
  try {
    key = await trustKey(workspace, false)
  } catch {
    return []
  }
  const root = resolve(workspace, stateName, transactionDirectoryName)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw transactionError(
      "TRANSACTION_PLAN_INVALID",
      "Transaction history could not be inspected.",
    )
  }
  const pending: PendingTransaction[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".staging-"))
      continue
    const manifest = await readJournalManifest(resolve(root, entry.name), key)
    if (!manifest) {
      throw transactionError(
        "TRANSACTION_PENDING",
        "Retained transaction evidence failed authentication and must be inspected.",
      )
    }
    if (["complete", "rolled-back"].includes(manifest.phase)) continue
    pending.push({
      id: manifest.id,
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      phase: manifest.phase,
      paths: [...manifest.paths],
    })
  }
  return pending
}

async function assertNoPendingConflict(
  workspace: string,
  plan: NoteTransactionPlan,
): Promise<void> {
  const pending = await inspectPendingTransactions({ workspace })
  const paths = new Set(planPaths(plan))
  const conflict = pending.find((transaction) => transaction.paths.some((path) => paths.has(path)))
  if (conflict) {
    throw transactionError(
      "TRANSACTION_PENDING",
      "An incomplete transaction must be inspected first.",
      {
        transactionId: conflict.id,
        phase: conflict.phase,
      },
    )
  }
}

async function execute(
  rawPlan: unknown,
  expectedKind: NoteTransactionPlan["kind"],
  context: TransactionContext,
): Promise<TransactionResult> {
  const verified = await verifyPlan(rawPlan, expectedKind, context.workspace)
  const { plan, workspace, key } = verified
  await assertNoPendingConflict(workspace, plan)
  const releaseLocks = await acquireLocks(workspace, planPaths(plan))
  let journal:
    { directory: string; manifest: JournalPayload; backupFiles: Map<string, SafeFile> } | undefined
  let mutationStarted = false
  const appliedHashes = new Map<string, string>()
  const publishedRoots = new Set<string>()
  const adapter = context.adapter ?? {}
  try {
    await revalidatePlan(workspace, plan)
    journal = await createJournal(workspace, plan, key)
    await adapter.afterPhase?.("journal-created")

    const grouped = editsByPath(plan)
    const source = await safeFile(workspace, plan.source)
    if (!revisionMatches(source.revision, plan.sourceRevision)) {
      throw transactionError("TRANSACTION_STALE", "The note changed during transaction setup.", {
        path: plan.source,
      })
    }
    let targetBytes = source.bytes
    if (plan.kind === "rename") {
      const parsedSource = parseNotePath(plan.source)
      const linked = applyWikiEdits(source.bytes.toString("utf8"), grouped.get(plan.source) ?? [])
      const attachments = rewriteOwnedAttachmentReferences(
        linked,
        workspace,
        parsedSource,
        plan.newSlug,
      )
      targetBytes = Buffer.from(addAlias(attachments, plan.alias), "utf8")
    }
    await adapter.beforePublish?.(plan.target)
    await publishExclusive(workspace, plan.target, targetBytes, source.mode)
    appliedHashes.set(plan.target, sha256(targetBytes))
    mutationStarted = true
    await updateJournal(journal, "note-published", key)
    await adapter.afterPhase?.("note-published")

    for (const [path, edits] of grouped) {
      if (path === plan.source) continue
      const current = await safeFile(workspace, path)
      if (!revisionMatches(current.revision, edits[0].revision)) {
        throw transactionError(
          "TRANSACTION_STALE",
          "A Wiki-link source changed during execution.",
          {
            path,
          },
        )
      }
      const updated = Buffer.from(applyWikiEdits(current.bytes.toString("utf8"), edits), "utf8")
      await replaceAtomic(workspace, path, updated, current.mode)
      appliedHashes.set(path, sha256(updated))
    }
    await updateJournal(journal, "links-published", key)
    await adapter.afterPhase?.("links-published")

    await publishAttachments(workspace, plan, adapter, appliedHashes, publishedRoots)
    await updateJournal(journal, "attachments-published", key)
    await adapter.afterPhase?.("attachments-published")

    await removeSources(workspace, plan, journal.directory)
    await updateJournal(journal, "source-removed", key)
    await adapter.afterPhase?.("source-removed")

    await updateJournal(journal, "complete", key)
    const changedPaths = planPaths(plan).sort((left, right) => left.localeCompare(right))
    return {
      id: plan.id,
      changedPaths,
      ...(plan.kind === "visibility" && parseNotePath(plan.source).visibility === "public"
        ? { pendingPublicDeletion: plan.source }
        : {}),
      historyWarning: plan.kind === "visibility" ? plan.historyWarning : false,
      warnings: [...plan.warnings],
    }
  } catch (error) {
    if (!mutationStarted && journal) {
      await updateJournal(journal, "rolled-back", key).catch(() => undefined)
      if ((error as { code?: string }).code?.startsWith("TRANSACTION_")) throw error
      throw transactionError(
        "TRANSACTION_FAILED",
        "The transaction failed before modifying note data.",
        {
          transactionId: plan.id,
        },
      )
    }
    if (mutationStarted && journal) {
      const restored = await rollback(
        workspace,
        plan,
        journal,
        key,
        adapter,
        appliedHashes,
        publishedRoots,
      )
      if (!restored) {
        await updateJournal(journal, "rollback-uncertain", key).catch(() => undefined)
        throw transactionError(
          "TRANSACTION_UNCERTAIN",
          "The transaction could not be safely confirmed or rolled back.",
          { transactionId: plan.id },
        )
      }
      throw transactionError("TRANSACTION_FAILED", "The transaction failed and was rolled back.", {
        transactionId: plan.id,
      })
    }
    if ((error as { code?: string }).code?.startsWith("TRANSACTION_")) throw error
    throw transactionError(
      "TRANSACTION_FAILED",
      "The transaction failed before modifying note data.",
      {
        transactionId: plan.id,
      },
    )
  } finally {
    await releaseLocks().catch(() => undefined)
  }
}

export async function executeVisibilityChange(
  plan: VisibilityChangePlan,
  context: TransactionContext,
): Promise<TransactionResult> {
  return execute(plan, "visibility", context)
}

export async function executeRename(
  plan: RenamePlan,
  context: TransactionContext,
): Promise<TransactionResult> {
  return execute(plan, "rename", context)
}
