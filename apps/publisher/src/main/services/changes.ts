import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import {
  KEBAB_SLUG_SOURCE,
  MANAGED_NOTE_PATH_PATTERN,
  type ChangeAttachment,
  type ChangeGroup,
  type ChangeKind,
  type ChangeReview,
  type ChangeSelection,
} from "../../shared/contracts"
import { domainSlugSchema } from "../../shared/ipcSchemas"
import type { PreviewProcess } from "./preview"
import {
  captureNoteDomainSnapshot,
  revalidateNoteDomains,
  type NoteDomainSnapshot,
} from "./noteDomains"
import { createProductionProcessTreeTerminator } from "./previewRuntime"

export const MAX_CHANGE_STATUS_BYTES = 2 * 1024 * 1024
export const MAX_CHANGE_STDERR_BYTES = 64 * 1024
export const MAX_CHANGE_RECORDS = 1_000
export const MAX_CHANGE_PATHS = 500
export const MAX_CHANGE_REVIEW_BYTES = 512 * 1024
const CHANGE_SCAN_DEADLINE_MS = 15_000

type ChangeScanCode =
  "CHANGE_SCAN_INVALID" | "CHANGE_SCAN_LIMIT" | "CHANGE_SCAN_CANCELLED" | "CHANGE_SCAN_FAILED"

class ChangeScanError extends Error {
  readonly name = "ChangeScanError"

  constructor(
    readonly code: ChangeScanCode,
    message: string,
    readonly terminationUncertain = false,
  ) {
    super(message)
  }
}

export interface ChangeCommandRequest {
  readonly executable: "git"
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  readonly deadlineMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
}

export interface ChangeCommandResult {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface ChangeCommandRunner {
  run(request: ChangeCommandRequest): Promise<ChangeCommandResult>
}

export interface ChangeCommandProcess extends PreviewProcess {}

export type ChangeCommandSpawner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly shell: false
    readonly windowsHide: true
    readonly detached: true
  },
) => ChangeCommandProcess

export type PorcelainEntry = {
  readonly recordType: "ordinary" | "rename" | "unmerged" | "untracked" | "ignored"
  readonly path: string
  readonly originalPath?: string
  readonly index: string
  readonly worktree: string
  readonly submodule: string
}

export interface ListChangesOptions {
  readonly workspace: string
  readonly runner?: ChangeCommandRunner
  readonly signal?: AbortSignal
  /** Test seam for exact porcelain fixtures. Production always invokes Git itself. */
  readonly statusOutput?: Buffer
}

export interface ChangeScanner {
  list(): Promise<ChangeReview>
  cancel(): Promise<void>
  dispose(): Promise<void>
}

type MutableGroup = {
  id: string
  label: string
  kind: ChangeKind
  selection: ChangeSelection
  description: string
  paths: string[]
  attachments: ChangeAttachment[]
}

const ordinaryStatusPattern = /^[.MTAD]{2}$/
const renameStatusPattern = /^(?:[RC][.MTAD]|[.MTAD][RC])$/
const unmergedStatusPattern = /^(?:DD|AU|UD|UA|DU|AA|UU)$/
const submodulePattern = /^(?:N\.\.\.|S[.C][.M][.U])$/
const modePattern = /^(?:000000|100644|100755|120000|160000)$/
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const scorePattern = /^[RC](?:100|[1-9]?[0-9])$/
const slugPattern = new RegExp(`^${KEBAB_SLUG_SOURCE}$`)
const removedDomainLanding = new RegExp(`^content\/(${KEBAB_SLUG_SOURCE})\/index\.md$`)
const publicAttachment = new RegExp(`^content\/_assets\/(${KEBAB_SLUG_SOURCE})\/(.+)$`)
const privateAttachment = new RegExp(`^private\/_assets\/(${KEBAB_SLUG_SOURCE})\/(.+)$`)

type ManagedNote = {
  readonly domain: string
  readonly slug: string
}

function managedNote(
  path: string,
  root: "content" | "private",
  domains: NoteDomainSnapshot,
): ManagedNote | undefined {
  const match = MANAGED_NOTE_PATH_PATTERN.exec(path)
  if (match?.[1] !== root || !match[2] || !match[3] || !domains.has(match[2])) return undefined
  return { domain: match[2], slug: match[3] }
}

function removedDomainPublicNote(
  path: string,
  removedDomains: ReadonlySet<string>,
): ManagedNote | undefined {
  const match = MANAGED_NOTE_PATH_PATTERN.exec(path)
  if (match?.[1] !== "content" || !match[2] || !match[3] || !removedDomains.has(match[2])) {
    return undefined
  }
  return { domain: match[2], slug: match[3] }
}

function scanError(code: ChangeScanCode, message: string): ChangeScanError {
  return new ChangeScanError(code, message)
}

function invalid(message = "Git returned invalid publication status data."): ChangeScanError {
  return scanError("CHANGE_SCAN_INVALID", message)
}

function ensureBufferLimit(buffer: Buffer): void {
  if (buffer.byteLength > MAX_CHANGE_STATUS_BYTES) {
    throw scanError("CHANGE_SCAN_LIMIT", "Publication status exceeded the safe size limit.")
  }
}

function decodeStatus(output: Buffer): string {
  ensureBufferLimit(output)
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output)
  } catch {
    throw invalid()
  }
}

function parseHeader(record: string, tokenCount: number): { tokens: string[]; path: string } {
  const tokens: string[] = []
  let offset = 0
  for (let index = 0; index < tokenCount; index += 1) {
    const separator = record.indexOf(" ", offset)
    if (separator < 0) throw invalid()
    const token = record.slice(offset, separator)
    if (!token) throw invalid()
    tokens.push(token)
    offset = separator + 1
  }
  const path = record.slice(offset)
  if (!path) throw invalid()
  return { tokens, path }
}

function validateCommon(tokens: string[], type: "1" | "2" | "u"): readonly string[] {
  const status = tokens[1] ?? ""
  if (tokens[0] !== type) throw invalid()
  if (
    type === "u"
      ? !unmergedStatusPattern.test(status)
      : type === "2"
        ? !renameStatusPattern.test(status)
        : !ordinaryStatusPattern.test(status) || status === ".."
  ) {
    throw invalid()
  }
  if (type === "1" && unmergedStatusPattern.test(status)) throw invalid()
  if (!submodulePattern.test(tokens[2] ?? "")) throw invalid()
  const modeCount = type === "u" ? 4 : 3
  const oidCount = type === "u" ? 3 : 2
  const modeStart = 3
  const oidStart = modeStart + modeCount
  if (!tokens.slice(modeStart, oidStart).every((token) => modePattern.test(token))) throw invalid()
  const oids = tokens.slice(oidStart, oidStart + oidCount)
  if (!oids.every((token) => oidPattern.test(token))) {
    throw invalid()
  }
  if (type === "2") {
    const score = tokens[8] ?? ""
    const kind = status.includes("R") ? "R" : "C"
    if (!scorePattern.test(score) || score[0] !== kind) throw invalid()
  }
  return oids
}

function parsePorcelainBuffer(
  output: Buffer,
  expectedOidWidth?: number,
): { readonly entries: readonly PorcelainEntry[]; readonly oidWidth?: number } {
  if (output.byteLength === 0) return { entries: [], oidWidth: expectedOidWidth }
  const decoded = decodeStatus(output)
  if (!decoded.endsWith("\0")) throw invalid("Git status output was not NUL terminated.")
  const fields = decoded.slice(0, -1).split("\0")
  if (fields.some((field) => field.length === 0)) throw invalid()
  const entries: PorcelainEntry[] = []
  let oidWidth = expectedOidWidth
  const currentPaths = new Set<string>()
  const renameOrigins = new Set<string>()

  for (let cursor = 0; cursor < fields.length; cursor += 1) {
    if (entries.length >= MAX_CHANGE_RECORDS) {
      throw scanError("CHANGE_SCAN_LIMIT", "Publication status contained too many records.")
    }
    const record = fields[cursor]!
    let entry: PorcelainEntry
    if (record.startsWith("1 ")) {
      const { tokens, path } = parseHeader(record, 8)
      const oids = validateCommon(tokens, "1")
      oidWidth ??= oids[0]?.length
      if (oids.some((oid) => oid.length !== oidWidth)) throw invalid()
      entry = {
        recordType: "ordinary",
        path,
        index: tokens[1]![0]!,
        worktree: tokens[1]![1]!,
        submodule: tokens[2]!,
      }
    } else if (record.startsWith("2 ")) {
      const { tokens, path } = parseHeader(record, 9)
      const oids = validateCommon(tokens, "2")
      oidWidth ??= oids[0]?.length
      if (oids.some((oid) => oid.length !== oidWidth)) throw invalid()
      const originalPath = fields[++cursor]
      if (!originalPath) throw invalid("Malformed porcelain-v2 rename record.")
      entry = {
        recordType: "rename",
        path,
        originalPath,
        index: tokens[1]![0]!,
        worktree: tokens[1]![1]!,
        submodule: tokens[2]!,
      }
    } else if (record.startsWith("u ")) {
      const { tokens, path } = parseHeader(record, 10)
      const oids = validateCommon(tokens, "u")
      oidWidth ??= oids[0]?.length
      if (oids.some((oid) => oid.length !== oidWidth)) throw invalid()
      entry = {
        recordType: "unmerged",
        path,
        index: tokens[1]![0]!,
        worktree: tokens[1]![1]!,
        submodule: tokens[2]!,
      }
    } else if (record.startsWith("? ") || record.startsWith("! ")) {
      const path = record.slice(2)
      if (!path) throw invalid()
      entry = {
        recordType: record[0] === "?" ? "untracked" : "ignored",
        path,
        index: record[0]!,
        worktree: record[0]!,
        submodule: "N...",
      }
    } else {
      throw invalid()
    }
    if (currentPaths.has(entry.path)) throw invalid("Duplicate path in change status.")
    currentPaths.add(entry.path)
    if (entry.originalPath) {
      if (renameOrigins.has(entry.originalPath)) throw invalid("Duplicate rename origin in status.")
      renameOrigins.add(entry.originalPath)
    }
    entries.push(entry)
  }
  if (currentPaths.size + renameOrigins.size > MAX_CHANGE_PATHS) {
    throw scanError("CHANGE_SCAN_LIMIT", "Publication status contained too many paths.")
  }
  return { entries, oidWidth }
}

export function parsePorcelainV2(output: Buffer): readonly PorcelainEntry[] {
  return parsePorcelainBuffer(output).entries
}

function terminationFailure(): ChangeScanError {
  return new ChangeScanError(
    "CHANGE_SCAN_FAILED",
    "Publication scan termination was not confirmed.",
    true,
  )
}

export function createBoundedChangeCommandRunner(options: {
  readonly spawner: ChangeCommandSpawner
  readonly terminate: (child: ChangeCommandProcess) => Promise<boolean>
  readonly terminationDeadlineMs?: number
}): ChangeCommandRunner {
  return {
    run(request) {
      if (request.signal?.aborted) {
        return Promise.reject(scanError("CHANGE_SCAN_CANCELLED", "Change scan was cancelled."))
      }
      return new Promise<ChangeCommandResult>((resolvePromise, rejectPromise) => {
        let settled = false
        let stopping = false
        let pendingError: ChangeScanError | undefined
        let stdoutBytes = 0
        let stderrBytes = 0
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let child: ChangeCommandProcess
        try {
          child = options.spawner(request.executable, request.args, {
            cwd: request.cwd,
            env: { ...process.env, ...request.env },
            shell: false,
            windowsHide: true,
            detached: true,
          })
        } catch {
          rejectPromise(scanError("CHANGE_SCAN_FAILED", "Could not start the publication scan."))
          return
        }
        const finish = (error?: ChangeScanError, result?: ChangeCommandResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          request.signal?.removeEventListener("abort", abort)
          if (error) rejectPromise(error)
          else resolvePromise(result!)
        }
        const terminateAndFinish = async (): Promise<void> => {
          if (settled) return
          let deadline: ReturnType<typeof setTimeout> | undefined
          try {
            const confirmed = await Promise.race([
              options.terminate(child),
              new Promise<false>((resolvePromise) => {
                deadline = setTimeout(
                  () => resolvePromise(false),
                  options.terminationDeadlineMs ?? 3_500,
                )
              }),
            ])
            if (!settled) {
              finish(
                confirmed
                  ? (pendingError ??
                      scanError("CHANGE_SCAN_FAILED", "Publication scan was stopped."))
                  : terminationFailure(),
              )
            }
          } catch {
            if (!settled) finish(terminationFailure())
          } finally {
            if (deadline) clearTimeout(deadline)
          }
        }
        const stop = (error: ChangeScanError): void => {
          if (settled || stopping) return
          stopping = true
          pendingError = error
          void terminateAndFinish()
        }
        const abort = (): void =>
          stop(scanError("CHANGE_SCAN_CANCELLED", "Change scan was cancelled."))
        const timer = setTimeout(
          () => stop(scanError("CHANGE_SCAN_FAILED", "Publication scan timed out.")),
          request.deadlineMs,
        )
        request.signal?.addEventListener("abort", abort, { once: true })
        if (request.signal?.aborted) abort()
        child.on("error", () => {
          stop(scanError("CHANGE_SCAN_FAILED", "Could not start or stop the publication scan."))
        })
        child.on("close", (code) => {
          if (stopping) return
          if (code === null) {
            finish(scanError("CHANGE_SCAN_FAILED", "Publication scan did not finish safely."))
          } else {
            finish(undefined, {
              exitCode: code,
              stdout: Buffer.concat(stdout, stdoutBytes),
              stderr: Buffer.concat(stderr, stderrBytes),
            })
          }
        })
        const childStdout = child.stdout
        const childStderr = child.stderr
        if (!childStdout || !childStderr) {
          stop(scanError("CHANGE_SCAN_FAILED", "Publication scan streams were unavailable."))
          return
        }
        childStdout.on("data", (chunk: Buffer | string) => {
          if (settled || stopping) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stdoutBytes += bytes.byteLength
          if (stdoutBytes > request.maxStdoutBytes) {
            stop(scanError("CHANGE_SCAN_LIMIT", "Publication status exceeded the safe size limit."))
            return
          }
          stdout.push(bytes)
        })
        childStderr.on("data", (chunk: Buffer | string) => {
          if (settled || stopping) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stderrBytes += bytes.byteLength
          if (stderrBytes > request.maxStderrBytes) {
            stop(scanError("CHANGE_SCAN_LIMIT", "Git diagnostics exceeded the safe size limit."))
            return
          }
          stderr.push(bytes)
        })
      })
    },
  }
}

const productionTerminator = createProductionProcessTreeTerminator()
const systemChangeCommandRunner = createBoundedChangeCommandRunner({
  spawner: (executable, args, options) =>
    spawn(executable, [...args], options) as unknown as ChangeCommandProcess,
  terminate: async (child) => (await productionTerminator(child)) === "terminated",
})

function assertRelativePath(path: string): void {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw invalid("Git returned a path that is not a safe workspace path.")
  }
  if (Buffer.byteLength(path, "utf8") > 512) {
    throw scanError("CHANGE_SCAN_LIMIT", "A publication path exceeded the safe size limit.")
  }
}

function isContained(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
}

type AwaitGuard = <T>(operation: Promise<T>) => Promise<T>

async function assertManagedPathBoundary(
  workspace: string,
  path: string,
  guard: AwaitGuard,
): Promise<void> {
  if (!/^(?:content|private)\//.test(path)) return
  let current = workspace
  for (const part of path.replace(/\/$/, "").split("/")) {
    current = resolve(current, part)
    if (!isContained(workspace, current)) throw invalid("Managed path escaped the workspace.")
    try {
      const info = await guard(lstat(current))
      if (info.isSymbolicLink()) {
        throw invalid("Managed content crosses a symbolic link boundary.")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

function hasUnsafeManagedAlias(path: string, domains: NoteDomainSnapshot): boolean {
  const segments = path.split("/")
  const root = segments[0] ?? ""
  if (/^(?:content|private)$/i.test(root) && root !== root.toLowerCase()) return true
  if (root !== "content" && root !== "private") return false
  const domain = segments[1] ?? ""
  const canonicalDomain = domains.orderedSlugs.find(
    (item) => item.toLowerCase() === domain.toLowerCase(),
  )
  if (canonicalDomain && domain !== canonicalDomain) return true
  if (domain.toLowerCase() === "_assets" && domain !== "_assets") return true
  if (canonicalDomain && segments.length === 3 && path.toLowerCase().endsWith(".md")) {
    return !MANAGED_NOTE_PATH_PATTERN.test(path)
  }
  if (domain === "_assets" && segments.length >= 3) return !slugPattern.test(segments[2] ?? "")
  return false
}

function idFor(kind: ChangeKind, key: string): string {
  return `${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`
}

function makeGroup(
  kind: ChangeKind,
  key: string,
  label: string,
  selection: ChangeSelection,
  description: string,
): MutableGroup {
  return { id: idFor(kind, key), label, kind, selection, description, paths: [], attachments: [] }
}

function isDeletion(entry: PorcelainEntry): boolean {
  return entry.index === "D" || entry.worktree === "D"
}

function isAddition(entry: PorcelainEntry): boolean {
  return entry.recordType === "untracked" || entry.index === "A" || entry.worktree === "A"
}

function publicDescription(kind: ChangeKind): string {
  if (kind === "added") return "新增公开文章"
  if (kind === "unpublish") return "将从公开网站移除"
  if (kind === "attachment") return "公开文章的附件变化"
  return "公开文章已修改"
}

function addUnique(target: string[], path: string): void {
  if (!target.includes(path)) target.push(path)
}

function immutableGroup(group: MutableGroup): ChangeGroup {
  return { ...group, paths: [...group.paths], attachments: [...group.attachments] }
}

type AttachmentDelta = { slug: string; path: string; label: string }

async function existingPublicIdentities(
  workspace: string,
  slug: string,
  domains: NoteDomainSnapshot,
  guard: AwaitGuard,
): Promise<string[]> {
  const identities: string[] = []
  for (const domain of domains.orderedSlugs) {
    try {
      const info = await guard(lstat(resolve(workspace, "content", domain, `${slug}.md`)))
      if (info.isFile()) identities.push(`${domain}/${slug}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return identities
}

function commandRequest(
  workspace: string,
  args: readonly string[],
  deadlineMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
  signal?: AbortSignal,
): ChangeCommandRequest {
  return {
    executable: "git",
    args,
    cwd: workspace,
    env: { GIT_OPTIONAL_LOCKS: "0" },
    signal,
    deadlineMs,
    maxStdoutBytes,
    maxStderrBytes,
  }
}

export async function listChanges(options: ListChangesOptions): Promise<ChangeReview> {
  const deadlineAt = Date.now() + CHANGE_SCAN_DEADLINE_MS
  const throwIfStopped = (): void => {
    if (options.signal?.aborted) {
      throw scanError("CHANGE_SCAN_CANCELLED", "Change scan was cancelled.")
    }
    if (Date.now() >= deadlineAt) {
      throw scanError("CHANGE_SCAN_FAILED", "Publication scan timed out.")
    }
  }
  const remainingDeadline = (): number => {
    throwIfStopped()
    return Math.max(1, deadlineAt - Date.now())
  }
  const guard: AwaitGuard = async <T>(operation: Promise<T>): Promise<T> => {
    throwIfStopped()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(scanError("CHANGE_SCAN_FAILED", "Publication scan timed out.")),
        remainingDeadline(),
      )
      abort = () => reject(scanError("CHANGE_SCAN_CANCELLED", "Change scan was cancelled."))
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
    })
    try {
      return await Promise.race([operation, stopped])
    } finally {
      if (timer) clearTimeout(timer)
      if (abort) options.signal?.removeEventListener("abort", abort)
    }
  }
  throwIfStopped()
  const workspace = await guard(realpath(resolve(options.workspace)))
  const noteDomains = await guard(captureNoteDomainSnapshot(workspace))
  throwIfStopped()
  let output: Buffer | undefined = options.statusOutput
  let ignoredPrivateOutput: Buffer = Buffer.alloc(0)
  let totalStdoutBytes = output?.byteLength ?? 0
  let totalStderrBytes = 0
  if (output === undefined) {
    const runner = options.runner ?? systemChangeCommandRunner
    const result = await runner.run(
      commandRequest(
        workspace,
        [
          "status",
          "--porcelain=v2",
          "-z",
          "--renames",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        remainingDeadline(),
        MAX_CHANGE_STATUS_BYTES,
        MAX_CHANGE_STDERR_BYTES,
        options.signal,
      ),
    )
    if (result.exitCode !== 0) {
      throw scanError("CHANGE_SCAN_FAILED", "Could not inspect publication changes.")
    }
    throwIfStopped()
    output = result.stdout
    totalStdoutBytes += result.stdout.byteLength
    totalStderrBytes += result.stderr.byteLength
    const remainingStdoutBytes = MAX_CHANGE_STATUS_BYTES - totalStdoutBytes
    const remainingStderrBytes = MAX_CHANGE_STDERR_BYTES - totalStderrBytes
    if (remainingStdoutBytes <= 0 || remainingStderrBytes <= 0) {
      throw scanError("CHANGE_SCAN_LIMIT", "Publication scan exceeded the safe output limit.")
    }
    const ignoredPrivate = await runner.run(
      commandRequest(
        workspace,
        [
          "status",
          "--porcelain=v2",
          "-z",
          "--renames",
          "--untracked-files=all",
          "--ignore-submodules=none",
          "--ignored=matching",
          "--",
          "private",
        ],
        remainingDeadline(),
        remainingStdoutBytes,
        remainingStderrBytes,
        options.signal,
      ),
    )
    if (ignoredPrivate.exitCode !== 0) {
      throw scanError("CHANGE_SCAN_FAILED", "Could not inspect private local changes.")
    }
    throwIfStopped()
    ignoredPrivateOutput = ignoredPrivate.stdout
    totalStdoutBytes += ignoredPrivate.stdout.byteLength
    totalStderrBytes += ignoredPrivate.stderr.byteLength
  }
  if (totalStdoutBytes > MAX_CHANGE_STATUS_BYTES || totalStderrBytes > MAX_CHANGE_STDERR_BYTES) {
    throw scanError("CHANGE_SCAN_LIMIT", "Publication scan exceeded the safe output limit.")
  }
  ensureBufferLimit(output)
  ensureBufferLimit(ignoredPrivateOutput)
  const primaryStatus = parsePorcelainBuffer(output)
  const ignoredStatus = parsePorcelainBuffer(ignoredPrivateOutput, primaryStatus.oidWidth)
  const entries = [
    ...primaryStatus.entries,
    ...ignoredStatus.entries.filter(
      (entry) => entry.recordType === "ignored" && /^private\//i.test(entry.path),
    ),
  ]
  if (entries.length > MAX_CHANGE_RECORDS) {
    throw scanError("CHANGE_SCAN_LIMIT", "Publication status contained too many records.")
  }
  const pathCount = entries.reduce((count, entry) => count + 1 + (entry.originalPath ? 1 : 0), 0)
  if (pathCount > MAX_CHANGE_PATHS) {
    throw scanError("CHANGE_SCAN_LIMIT", "Publication status contained too many paths.")
  }
  for (const entry of entries) {
    throwIfStopped()
    for (const path of [entry.path, entry.originalPath]) {
      if (!path) continue
      assertRelativePath(path)
      await assertManagedPathBoundary(workspace, path, guard)
    }
  }

  if (entries.some((entry) => entry.recordType === "unmerged")) {
    return { groups: [], blockedReason: "检测到内容冲突，请先解决后再检查发布。" }
  }
  if (entries.some((entry) => entry.submodule.startsWith("S"))) {
    return { groups: [], blockedReason: "检测到子模块变化，无法安全确定发布内容。" }
  }
  const removedDomains = new Set<string>()
  for (const entry of entries) {
    if (!isDeletion(entry)) continue
    const landing = removedDomainLanding.exec(entry.path)
    if (landing?.[1] && domainSlugSchema.safeParse(landing[1]).success) {
      removedDomains.add(landing[1])
    }
  }
  const finishReview = async (review: ChangeReview): Promise<ChangeReview> => {
    if (Buffer.byteLength(JSON.stringify(review), "utf8") > MAX_CHANGE_REVIEW_BYTES) {
      throw scanError("CHANGE_SCAN_LIMIT", "Publication review exceeded the safe size limit.")
    }
    await guard(revalidateNoteDomains(noteDomains))
    throwIfStopped()
    return review
  }
  if (
    entries.some(
      (entry) =>
        hasUnsafeManagedAlias(entry.path, noteDomains) ||
        Boolean(entry.originalPath && hasUnsafeManagedAlias(entry.originalPath, noteDomains)),
    )
  ) {
    return finishReview({
      groups: [],
      blockedReason: "检测到大小写不规范或无效的内容路径，请先修正。",
    })
  }

  const staged = entries.some(
    (entry) =>
      (entry.recordType === "ordinary" || entry.recordType === "rename") && entry.index !== ".",
  )
  const publicGroups = new Map<string, MutableGroup>()
  const privateGroups = new Map<string, MutableGroup>()
  const attachments: AttachmentDelta[] = []
  const config = makeGroup("config", "repository", "配置修改", "optional", "高级选项，默认不发布")

  const addPrivate = (path: string): void => {
    const note = managedNote(path, "private", noteDomains)
    const asset = privateAttachment.exec(path)
    const identity = note ? `${note.domain}/${note.slug}` : asset ? `asset/${asset[1]}` : path
    const label = note?.slug ?? asset?.[1] ?? basename(path).replace(/\.[^.]*$/, "")
    if (!privateGroups.has(identity)) {
      privateGroups.set(
        identity,
        makeGroup("private", identity, label!, "locked", "只保留在本机，不会发布"),
      )
    }
  }
  const addPublicNote = (
    path: string,
    note: ManagedNote,
    entry: PorcelainEntry,
    forcedUnpublish = false,
  ): MutableGroup => {
    const identity = `${note.domain}/${note.slug}`
    const kind: ChangeKind =
      forcedUnpublish || isDeletion(entry) ? "unpublish" : isAddition(entry) ? "added" : "modified"
    let group = publicGroups.get(identity)
    if (!group) {
      group = makeGroup(kind, identity, note.slug, "default", publicDescription(kind))
      publicGroups.set(identity, group)
    }
    addUnique(group.paths, path)
    return group
  }
  const addDelta = (path: string, entry: PorcelainEntry, origin: boolean): void => {
    const note =
      managedNote(path, "content", noteDomains) ??
      (origin || isDeletion(entry) ? removedDomainPublicNote(path, removedDomains) : undefined)
    if (note) {
      addPublicNote(path, note, entry, origin)
      return
    }
    const landing = isDeletion(entry) ? removedDomainLanding.exec(path) : null
    if (landing?.[1] && removedDomains.has(landing[1])) {
      addPublicNote(path, { domain: landing[1], slug: "index" }, entry, true)
      return
    }
    const attachment = publicAttachment.exec(path)
    if (attachment) {
      attachments.push({ slug: attachment[1]!, path, label: attachment[2]! })
      return
    }
    if (path.startsWith("private/")) {
      addPrivate(path)
      return
    }
    addUnique(config.paths, path)
  }

  for (const entry of entries) {
    throwIfStopped()
    if (entry.recordType === "ignored" && !entry.path.startsWith("private/")) continue
    if (entry.recordType === "rename" && entry.originalPath) {
      const currentNote = managedNote(entry.path, "content", noteDomains)
      const originalNote =
        managedNote(entry.originalPath, "content", noteDomains) ??
        removedDomainPublicNote(entry.originalPath, removedDomains)
      if (currentNote && originalNote) {
        const current = addPublicNote(entry.path, currentNote, entry)
        addUnique(current.paths, entry.originalPath)
      } else {
        addDelta(entry.path, entry, false)
        addDelta(entry.originalPath, entry, true)
      }
    } else {
      addDelta(entry.path, entry, false)
    }
  }

  for (const item of attachments) {
    throwIfStopped()
    const changedIdentities = [...publicGroups.keys()].filter((identity) =>
      identity.endsWith(`/${item.slug}`),
    )
    const existingIdentities = await existingPublicIdentities(
      workspace,
      item.slug,
      noteDomains,
      guard,
    )
    const identities = [...new Set([...changedIdentities, ...existingIdentities])]
    if (identities.length > 1) {
      return finishReview({
        groups: [],
        blockedReason: "检测到附件归属不明确，请先确保文章 slug 唯一。",
      })
    }
    const identity = identities[0] ?? `attachment/${item.slug}`
    let group = publicGroups.get(identity)
    if (!group) {
      group = makeGroup(
        "attachment",
        identity,
        item.slug,
        "default",
        publicDescription("attachment"),
      )
      publicGroups.set(identity, group)
    }
    addUnique(group.paths, item.path)
    if (!group.attachments.some((attachment) => attachment.path === item.path)) {
      group.attachments.push({ path: item.path, label: item.label })
    }
  }

  const groups = [
    ...publicGroups.values(),
    ...privateGroups.values(),
    ...(config.paths.length > 0 ? [config] : []),
  ]
  const pathOwners = new Map<string, string>()
  for (const group of groups) {
    if (group.selection === "locked") continue
    for (const path of group.paths) {
      const owner = pathOwners.get(path)
      if (owner && owner !== group.id) {
        return finishReview({
          groups: [],
          blockedReason: "检测到同一路径同时属于多个发布选项，无法安全继续。",
        })
      }
      pathOwners.set(path, group.id)
    }
  }
  const immutable = groups.map(immutableGroup).sort((left, right) => {
    const order: Record<ChangeKind, number> = {
      added: 0,
      modified: 1,
      unpublish: 2,
      attachment: 3,
      private: 4,
      config: 5,
    }
    return order[left.kind] - order[right.kind] || left.label.localeCompare(right.label, "zh-CN")
  })
  const review: ChangeReview = {
    groups: immutable,
    ...(staged ? { blockedReason: "检测到其他工具已准备中的发布内容，请先处理后再继续。" } : {}),
  }
  return finishReview(review)
}

export function createChangeScanner(options: {
  readonly workspace: string
  readonly runner?: ChangeCommandRunner
}): ChangeScanner {
  let active: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined
  let blocked: ChangeScanError | undefined
  let disposed = false
  const cancel = async (): Promise<void> => {
    const current = active
    current?.controller.abort()
    await current?.settled
    if (blocked) throw blocked
  }
  return {
    list() {
      if (disposed) {
        return Promise.reject(
          scanError("CHANGE_SCAN_FAILED", "Publication scanning has been shut down."),
        )
      }
      if (blocked) return Promise.reject(blocked)
      const predecessor = active?.settled ?? Promise.resolve()
      active?.controller.abort()
      const controller = new AbortController()
      const operation = predecessor
        .then(() => {
          if (disposed) {
            throw scanError("CHANGE_SCAN_FAILED", "Publication scanning has been shut down.")
          }
          if (blocked) throw blocked
          return listChanges({ ...options, signal: controller.signal })
        })
        .catch((error: unknown) => {
          if (error instanceof ChangeScanError && error.terminationUncertain) blocked = error
          throw error
        })
      const settled = operation.then(
        () => undefined,
        () => undefined,
      )
      active = { controller, settled }
      void settled.then(() => {
        if (active?.controller === controller) active = undefined
      })
      return operation
    },
    cancel,
    async dispose() {
      disposed = true
      await cancel()
    },
  }
}
