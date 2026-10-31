import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { constants, type BigIntStats } from "node:fs"
import {
  lstat,
  link as rawLink,
  mkdir as rawMkdir,
  open as rawOpen,
  readdir as rawReaddir,
  readFile,
  realpath,
  rmdir as rawRmdir,
  unlink as rawUnlink,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { AppError } from "../../../shared/contracts"
import { internalRecoveryKey } from "../noteFiles"
import type { AppearancePlan } from "./appearanceAdapter"

const TRANSACTION_ROOT = ".garden-publisher/appearance-transactions"
const HISTORY_ROOT = ".garden-publisher/appearance-history"

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const JOURNAL_PATTERN = /^journal\.(\d{8})\.json$/
const JOURNAL_TEMP_PATTERN = /^\.journal\.(\d{8})\.[a-f0-9-]{36}\.tmp$/i
const CLEANUP_TEMP_PATTERN = /^\.cleanup\.[a-f0-9-]{36}\.tmp$/i
const ID_SOURCE = ID_PATTERN.source.slice(1, -1)
const HISTORY_COPY_CLAIM_PATTERN = new RegExp(
  `^\.history-copy-(${ID_SOURCE})-(candidate|current)\.claim$`,
  "i",
)
const CLEANUP_ROOT_CLAIM_PATTERN = new RegExp(
  `^\.cleanup-root-(${ID_SOURCE})-([a-f0-9-]{36})\.claim$`,
  "i",
)
const CLEANUP_DIRECTORY_PATTERN = new RegExp(
  `^\\.(${ID_SOURCE}|current|(?:candidate|previous)-${ID_SOURCE})(?:\\.cleanup-[a-f0-9-]{36})+$`,
  "i",
)
const AUTHENTICATION_CONTEXT = "garden-publisher/appearance-transaction/journal/v1\0"
const CLEANUP_AUTHENTICATION_CONTEXT = "garden-publisher/appearance-transaction/cleanup/v1\0"
const CLEANUP_ROOT_CLAIM_AUTHENTICATION_CONTEXT =
  "garden-publisher/appearance-transaction/cleanup-root-claim/v1\0"
const CLONE_OWNERSHIP_AUTHENTICATION_CONTEXT =
  "garden-publisher/appearance-transaction/clone-ownership/v1\0"
const HISTORY_COPY_CLAIM_AUTHENTICATION_CONTEXT =
  "garden-publisher/appearance-transaction/history-copy-claim/v1\0"
const ID_AUTHENTICATION_CONTEXT = "garden-publisher/appearance-transaction/id/v1\0"
const MAX_JOURNAL_BYTES = 1024 * 1024
// Appearance inputs are retained in both working and recovery evidence. Bound them before any
// publisher state is created so a malformed plan cannot force unbounded memory or disk use.
const MAX_APPEARANCE_FILE_BYTES = 16 * 1024 * 1024
const MAX_APPEARANCE_TOTAL_BYTES = 64 * 1024 * 1024
const WINDOWS_BARRIER_PATTERN = /^\.durability-barrier-([a-f0-9-]{36})\.tmp$/i
const WINDOWS_BARRIER_AUTHENTICATION_CONTEXT = "garden-publisher/windows-directory-barrier/v1\0"
const IDENTITY_CAPABILITY_CLAIM_PATTERN = new RegExp(
  `^\\.identity-capability-(${ID_SOURCE})\\.claim$`,
  "i",
)
const IDENTITY_CAPABILITY_AUTHENTICATION_CONTEXT =
  "garden-publisher/appearance-transaction/identity-capability/v1\0"

type AppearanceJournalPhase = "prepared" | "published" | "verified"

interface AppearanceJournalEntry {
  readonly path: string
  readonly beforeHash: string | null
  readonly afterHash: string | null
  readonly beforeIdentity: { readonly dev: string; readonly ino: string } | null
  readonly afterIdentity: { readonly dev: string; readonly ino: string } | null
  readonly backupIdentity: { readonly dev: string; readonly ino: string } | null
  readonly stagedIdentity: { readonly dev: string; readonly ino: string } | null
  readonly installIdentity: { readonly dev: string; readonly ino: string } | null
  readonly publishTempIdentity: AuthenticatedTempIdentity | null
  readonly publishTempConsumed: boolean
  readonly rollbackTempIdentity: AuthenticatedTempIdentity | null
  readonly rollbackTempConsumed: boolean
  readonly backup: string | null
  readonly staged: string | null
}

interface AuthenticatedFileIdentity {
  readonly dev: string
  readonly ino: string
}

interface AuthenticatedTempIdentity extends AuthenticatedFileIdentity {
  readonly ctimeNs: string
  readonly nlink: string
}

interface AuthenticatedDirectoryIdentity extends AuthenticatedFileIdentity {
  readonly birthtimeNs: string
}

interface WindowsDirectoryBarrierClaim {
  readonly version: 1
  readonly token: string
  readonly parent: AuthenticatedDirectoryIdentity
  readonly file: AuthenticatedFileIdentity
}

interface WindowsDirectoryBarrierEnvelope {
  readonly claim: WindowsDirectoryBarrierClaim
  readonly authentication: string
}

interface JournalOwnership {
  readonly transaction: AuthenticatedDirectoryIdentity
  readonly evidence: Readonly<
    Record<"backups" | "staged" | "quarantine" | "installed", AuthenticatedDirectoryIdentity>
  >
  readonly journal: AuthenticatedFileIdentity | null
}

interface AppearanceJournal {
  readonly version: 1
  readonly id: string
  readonly phase: AppearanceJournalPhase
  readonly entries: readonly AppearanceJournalEntry[]
  readonly revision: number
  readonly kind: "apply" | "undo"
  readonly baselineHash: string
  readonly historyId: string | null
  readonly ownership: JournalOwnership
}

interface JournalEnvelope {
  readonly journal: AppearanceJournal
  readonly authentication: string
}

interface CleanupIntent {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly root: { readonly dev: string; readonly ino: string }
  readonly marker: { readonly dev: string; readonly ino: string }
  readonly markerAlias: string
  readonly entries: readonly {
    readonly path: string
    readonly type: "file" | "directory"
    readonly dev: string
    readonly ino: string
  }[]
}

interface CleanupEnvelope {
  readonly cleanup: CleanupIntent
  readonly authentication: string
}

interface CleanupRootClaim {
  readonly version: 1
  readonly id: string
  readonly rootName: string
  readonly phase: "started"
  readonly cleanup: CleanupIntent
  readonly marker: AuthenticatedFileIdentity
}

interface CleanupRootClaimEnvelope {
  readonly claim: CleanupRootClaim
  readonly authentication: string
}

interface CloneOwnershipIntent {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly root: AuthenticatedDirectoryIdentity
  readonly evidence: JournalOwnership["evidence"]
  readonly marker: AuthenticatedFileIdentity
}

interface CloneOwnershipEnvelope {
  readonly ownership: CloneOwnershipIntent
  readonly authentication: string
}

interface HistoryCopyClaim {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly source: AuthenticatedDirectoryIdentity
  readonly destination: "candidate" | "current"
  readonly marker: AuthenticatedFileIdentity
}

interface HistoryCopyClaimEnvelope {
  readonly claim: HistoryCopyClaim
  readonly authentication: string
}

export interface AppearanceTransactionReceipt {
  readonly id: string
  readonly status: "verified" | "recovered" | "undone"
  readonly canUndo: boolean
}

type AppearanceTransactionOperation =
  | {
      readonly kind: "stage-write" | "stage-fsync" | "backup-write" | "backup-fsync"
      readonly index: number
    }
  | {
      readonly kind:
        "journal-write" | "journal-file-fsync" | "journal-rename" | "journal-directory-fsync"
      readonly revision: number
    }
  | {
      readonly kind:
        | "publish-temp-write"
        | "after-quarantine"
        | "after-install"
        | "replace"
        | "delete"
        | "publish-file-fsync"
        | "publish-directory-fsync"
      readonly index: number
    }
  | { readonly kind: "rollback-replace" | "rollback-delete"; readonly index: number }
  | { readonly kind: "verify" | "history-promote" | "undo-history-remove" }

interface AppearanceTransactionOptions {
  /** Test seam and audit hook. Throwing aborts at the named durability boundary. */
  readonly beforeOperation?: (operation: AppearanceTransactionOperation) => Promise<void> | void
  readonly createId?: () => string
  /** Rechecks the adapter-level baseline immediately before transaction preparation. */
  readonly readBaselineHash?: () => Promise<string>
}

type FileSystemInstruction =
  | "directory-barrier"
  | "directory-barrier-open"
  | "directory-barrier-write"
  | "directory-barrier-fsync"
  | "directory-barrier-unlink"
  | "transaction-root-fsync"
  | "state-directory-mkdir"
  | "state-directory-parent-fsync"
  | "transaction-directory-mkdir"
  | "transaction-directory-rmdir"
  | "evidence-directory-mkdir"
  | "evidence-directory-fsync"
  | "transaction-directory-fsync"
  | "evidence-open"
  | "evidence-write"
  | "evidence-fsync"
  | "journal-temp-open"
  | "journal-temp-write"
  | "journal-temp-fsync"
  | "journal-rename"
  | "journal-parent-fsync"
  | "quarantine-rename"
  | "quarantine-fsync"
  | "target-parent-after-quarantine-fsync"
  | "publish-temp-open"
  | "publish-temp-write"
  | "publish-temp-fsync"
  | "publish-temp-link"
  | "publish-temp-unlink"
  | "installed-evidence-link"
  | "installed-evidence-fsync"
  | "install-link"
  | "install-file-fsync"
  | "install-parent-fsync"
  | "quarantine-unlink"
  | "cleanup-marker-open"
  | "cleanup-marker-write"
  | "cleanup-marker-fsync"
  | "cleanup-marker-link"
  | "cleanup-marker-unlink"
  | "cleanup-rename"
  | "cleanup-root-claim-open"
  | "cleanup-root-claim-write"
  | "cleanup-root-claim-fsync"
  | "cleanup-root-claim-unlink"
  | "cleanup-unlink"
  | "cleanup-rmdir"
  | "history-copy-link"
  | "history-directory-mkdir"
  | "history-switch-rename"
  | "history-parent-fsync"
  | "history-claim-open"
  | "history-claim-write"
  | "history-claim-fsync"
  | "history-claim-unlink"
  | "identity-capability-open"
  | "identity-capability-claim-open"
  | "identity-capability-link"
  | "identity-capability-unlink"
  | "fs-open"
  | "fs-write"
  | "fs-fsync"
  | "fs-mkdir"
  | "fs-link"
  | "fs-unlink"
  | "fs-rmdir"

interface TestRuntime {
  readonly options?: AppearanceTransactionOptions
  readonly emulateDirectorySync?: boolean
  ordinals?: Map<FileSystemInstruction, number>
  readonly filesystem?: {
    run<T>(
      instruction: FileSystemInstruction,
      operation: () => Promise<T>,
      event?: FileSystemEvent,
    ): Promise<T>
  }
}

interface FileSystemEvent {
  readonly instruction: FileSystemInstruction
  readonly ordinal: number
  readonly pathRole?: string
  readonly fileIndex?: number
  readonly transactionPhase?: AppearanceJournalPhase | "bootstrap" | "cleanup" | "recovery"
}

type FileSystemOperationContext = {
  readonly pathRole: string
  readonly fileIndex?: number
  readonly transactionPhase: AppearanceJournalPhase | "bootstrap" | "cleanup" | "recovery"
}

function fsContext(
  pathRole: string,
  transactionPhase: FileSystemOperationContext["transactionPhase"],
  fileIndex?: number,
): FileSystemOperationContext {
  return fileIndex === undefined
    ? { pathRole, transactionPhase }
    : { pathRole, transactionPhase, fileIndex }
}

const HANDLE_CONTEXTS = new WeakMap<object, FileSystemOperationContext>()

const TEST_RUNTIME_SYMBOL = Symbol.for("garden-publisher.appearance-transaction.test-runtime")

function testRuntime(): TestRuntime | undefined {
  if (process.env.NODE_ENV !== "test") return undefined
  return (globalThis as Record<PropertyKey, unknown>)[TEST_RUNTIME_SYMBOL] as
    TestRuntime | undefined
}

async function fsInstruction<T>(
  instruction: FileSystemInstruction,
  operation: () => Promise<T>,
  metadata: Omit<FileSystemEvent, "instruction" | "ordinal"> = {},
): Promise<T> {
  const runtime = testRuntime()
  if (runtime?.filesystem === undefined) return operation()
  runtime.ordinals ??= new Map()
  const ordinal = runtime.ordinals.get(instruction) ?? 0
  runtime.ordinals.set(instruction, ordinal + 1)
  return runtime.filesystem.run(instruction, operation, { instruction, ordinal, ...metadata })
}

async function open(
  path: string,
  flags: string | number,
  mode: number | undefined,
  context: FileSystemOperationContext,
  authenticate?: () => Promise<void>,
) {
  const handle = await fsInstruction(
    "fs-open",
    async () => {
      await authenticate?.()
      return mode === undefined ? rawOpen(path, flags) : rawOpen(path, flags, mode)
    },
    context,
  )
  HANDLE_CONTEXTS.set(handle, context)
  return handle
}

async function mkdir(
  path: string,
  options: { readonly mode?: number; readonly recursive?: false } | undefined,
  context: FileSystemOperationContext,
  authenticate?: () => Promise<void>,
) {
  return fsInstruction(
    "fs-mkdir",
    async () => {
      await authenticate?.()
      return rawMkdir(path, options)
    },
    context,
  )
}

async function link(
  source: string,
  destination: string,
  context: FileSystemOperationContext,
  identity?: AuthenticatedFileIdentity,
  destinationParentIdentity?: AuthenticatedDirectoryIdentity,
  authenticate?: () => Promise<void>,
): Promise<void> {
  await fsInstruction(
    "fs-link",
    async () => {
      if (identity !== undefined) {
        const current = await lstat(source, { bigint: true })
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          !matchesFileIdentity(current, identity)
        )
          throw uncertain()
      }
      if (destinationParentIdentity !== undefined) {
        const parent = await lstat(dirname(destination), { bigint: true })
        if (
          !parent.isDirectory() ||
          parent.isSymbolicLink() ||
          !matchesDirectoryOwnership(parent, destinationParentIdentity)
        )
          throw uncertain()
      }
      await authenticate?.()
      await rawLink(source, destination)
    },
    context,
  )
}

async function writeHandle(
  handle: Awaited<ReturnType<typeof rawOpen>>,
  bytes: string | Uint8Array,
): Promise<void> {
  const context = HANDLE_CONTEXTS.get(handle)
  await fsInstruction(
    "fs-write",
    async () => {
      await handle.writeFile(bytes)
    },
    context,
  )
}

async function syncHandle(handle: Awaited<ReturnType<typeof rawOpen>>): Promise<void> {
  const context = HANDLE_CONTEXTS.get(handle)
  await fsInstruction("fs-fsync", () => handle.sync(), context)
}

interface FileEvidence {
  readonly hash: string
  readonly bytes: Buffer
  readonly identity: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">
}

interface DirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
}

interface PreparedTransaction {
  readonly workspace: string
  readonly directory: string
  readonly directoryIdentity: DirectoryIdentity
  readonly key: Buffer
  readonly preconditions?: ReadonlyMap<string, FileEvidence | null>
  journal: AppearanceJournal
  cleanupAuthorized: boolean
  cleanupIntent?: CleanupIntent
  cloneOwnership?: CloneOwnershipIntent
  readonly ownedEntries: Map<string, { readonly dev: bigint; readonly ino: bigint }>
}

async function rememberOwnedEntry(transaction: PreparedTransaction, path: string): Promise<void> {
  const details = await lstat(resolve(transaction.directory, ...path.split("/")), { bigint: true })
  transaction.ownedEntries.set(path, { dev: details.dev, ino: details.ino })
}

function forgetOwnedEntry(transaction: PreparedTransaction, path: string): void {
  transaction.ownedEntries.delete(path)
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function authenticatedTransactionId(key: Buffer): string {
  const nonce = randomBytes(8)
  nonce[6] = (nonce[6]! & 0x0f) | 0x40
  const tag = createHmac("sha256", key)
    .update(ID_AUTHENTICATION_CONTEXT)
    .update(nonce)
    .digest()
    .subarray(0, 8)
  tag[0] = (tag[0]! & 0x3f) | 0x80
  const bytes = Buffer.concat([nonce, tag])
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
}

function appError(code: AppError["code"], message: string): AppError {
  return { code, message } as AppError
}

function conflict(): AppError {
  return appError(
    "APPEARANCE_CONFLICT",
    "Appearance files changed before the update could be applied.",
  )
}

function failed(): AppError {
  return appError(
    "APPEARANCE_TRANSACTION_FAILED",
    "The appearance update failed and was rolled back.",
  )
}

function uncertain(): AppError {
  return appError(
    "APPEARANCE_TRANSACTION_UNCERTAIN",
    "The appearance update could not be safely resolved; recovery evidence was retained.",
  )
}

function isSimulationCrash(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { simulateCrash?: unknown }).simulateCrash === true
  )
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validTempIdentityTransition(
  previous: AuthenticatedTempIdentity | null,
  current: AuthenticatedTempIdentity | null,
  previousConsumed: boolean,
  currentConsumed: boolean,
): boolean {
  if (previous === null) return true
  if (current === null || previous.dev !== current.dev || previous.ino !== current.ino) return false
  return (
    JSON.stringify(previous) === JSON.stringify(current) || (!previousConsumed && currentConsumed)
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function canonicalJournal(journal: AppearanceJournal): string {
  return JSON.stringify({
    version: journal.version,
    id: journal.id,
    phase: journal.phase,
    entries: journal.entries.map((entry) => ({
      path: entry.path,
      beforeHash: entry.beforeHash,
      afterHash: entry.afterHash,
      beforeIdentity: entry.beforeIdentity,
      afterIdentity: entry.afterIdentity,
      backupIdentity: entry.backupIdentity,
      stagedIdentity: entry.stagedIdentity,
      installIdentity: entry.installIdentity,
      publishTempIdentity: entry.publishTempIdentity,
      publishTempConsumed: entry.publishTempConsumed,
      rollbackTempIdentity: entry.rollbackTempIdentity,
      rollbackTempConsumed: entry.rollbackTempConsumed,
      backup: entry.backup,
      staged: entry.staged,
    })),
    revision: journal.revision,
    kind: journal.kind,
    baselineHash: journal.baselineHash,
    historyId: journal.historyId,
    ownership: journal.ownership,
  })
}

function authenticate(key: Buffer, journal: AppearanceJournal): string {
  return createHmac("sha256", key)
    .update(AUTHENTICATION_CONTEXT)
    .update(canonicalJournal(journal))
    .digest("hex")
}

function authenticateCleanup(key: Buffer, cleanup: CleanupIntent): string {
  return createHmac("sha256", key)
    .update(CLEANUP_AUTHENTICATION_CONTEXT)
    .update(JSON.stringify(cleanup))
    .digest("hex")
}

function authenticateCleanupRootClaim(key: Buffer, claim: CleanupRootClaim): string {
  return createHmac("sha256", key)
    .update(CLEANUP_ROOT_CLAIM_AUTHENTICATION_CONTEXT)
    .update(JSON.stringify(claim))
    .digest("hex")
}

function authenticateCloneOwnership(key: Buffer, ownership: CloneOwnershipIntent): string {
  return createHmac("sha256", key)
    .update(CLONE_OWNERSHIP_AUTHENTICATION_CONTEXT)
    .update(JSON.stringify(ownership))
    .digest("hex")
}

function authenticateHistoryCopyClaim(key: Buffer, claim: HistoryCopyClaim): string {
  return createHmac("sha256", key)
    .update(HISTORY_COPY_CLAIM_AUTHENTICATION_CONTEXT)
    .update(JSON.stringify(claim))
    .digest("hex")
}

function validateCleanupIntent(value: unknown, expectedId?: string): CleanupIntent {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "id", "revision", "root", "marker", "markerAlias", "entries"]) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !record(value.root) ||
    !exactKeys(value.root, ["dev", "ino"]) ||
    typeof value.root.dev !== "string" ||
    !validIdentityNumber(value.root.dev) ||
    typeof value.root.ino !== "string" ||
    !validIdentityNumber(value.root.ino) ||
    !record(value.marker) ||
    !exactKeys(value.marker, ["dev", "ino"]) ||
    typeof value.marker.dev !== "string" ||
    !validIdentityNumber(value.marker.dev) ||
    typeof value.marker.ino !== "string" ||
    !validIdentityNumber(value.marker.ino) ||
    typeof value.markerAlias !== "string" ||
    !CLEANUP_TEMP_PATTERN.test(value.markerAlias) ||
    !Array.isArray(value.entries)
  )
    throw uncertain()
  const entries = value.entries
  if (
    entries.length > 1024 ||
    entries.some(
      (entry) =>
        !record(entry) ||
        !exactKeys(entry, ["path", "type", "dev", "ino"]) ||
        typeof entry.path !== "string" ||
        !validRelativePath(entry.path) ||
        !["file", "directory"].includes(String(entry.type)) ||
        typeof entry.dev !== "string" ||
        !validIdentityNumber(entry.dev) ||
        typeof entry.ino !== "string" ||
        !validIdentityNumber(entry.ino),
    )
  )
    throw uncertain()
  const paths = entries.map((entry) => (entry as CleanupEntry).path)
  if (
    new Set(paths).size !== paths.length ||
    [...paths].sort(compareOrdinal).some((path, index) => path !== paths[index])
  )
    throw uncertain()
  return value as unknown as CleanupIntent
}

function validateCleanupRootClaim(value: unknown, expectedId: string): CleanupRootClaim {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "id", "rootName", "phase", "cleanup", "marker"]) ||
    value.version !== 1 ||
    value.id !== expectedId ||
    typeof value.rootName !== "string" ||
    ![expectedId, "current", `.candidate-${expectedId}`].includes(value.rootName) ||
    value.phase !== "started" ||
    !validAuthenticatedFileIdentity(value.marker)
  )
    throw uncertain()
  const cleanup = validateCleanupIntent(value.cleanup, expectedId)
  return { ...(value as unknown as CleanupRootClaim), cleanup }
}

function sameMac(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false
  const leftBytes = Buffer.from(left, "hex")
  const rightBytes = Buffer.from(right, "hex")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function validRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return false
  const components = path.split("/")
  if (components.some((component) => component === "" || component === "." || component === ".."))
    return false
  if (components[0]!.toLocaleLowerCase("en-US") === ".garden-publisher") return false
  return components.every(
    (component) =>
      !/[. ]$/.test(component) &&
      !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
        component,
      ),
  )
}

function windowsPathAlias(path: string): string {
  return path
    .split("/")
    .map((component) => component.normalize("NFC").toUpperCase())
    .join("/")
}

function validateRelativePath(path: string): void {
  if (!validRelativePath(path)) throw conflict()
}

function targetPath(workspace: string, path: string): string {
  validateRelativePath(path)
  const absolute = resolve(workspace, ...path.split("/"))
  if (!inside(workspace, absolute)) throw conflict()
  return absolute
}

async function canonicalWorkspace(workspaceInput: string): Promise<string> {
  try {
    const workspace = resolve(workspaceInput)
    const [details, canonical] = await Promise.all([lstat(workspace), realpath(workspace)])
    if (!details.isDirectory() || details.isSymbolicLink() || !pathsEqual(workspace, canonical))
      throw conflict()
    return canonical
  } catch (error) {
    if (record(error) && error.code === "APPEARANCE_CONFLICT") throw error
    throw conflict()
  }
}

// Electron owns this service from one main process. Serializing by canonical workspace prevents
// the singleton history and recovery journal from being observed midway through another public
// operation without adding a second, unsafe cross-process lock protocol.
const workspaceOperationTails = new Map<string, Promise<void>>()
const activeWorkspaceOperationTokens = new Set<symbol>()
const activeWorkspaceOperation = new AsyncLocalStorage<{
  readonly canonical: string
  readonly serializationKey: string
  readonly token: symbol
  recoveryKey?: Buffer
}>()

async function serializeWorkspaceOperation<T>(
  workspaceInput: string,
  operation: (workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = await canonicalWorkspace(workspaceInput)
  const key = process.platform === "win32" ? workspace.toLocaleLowerCase("en-US") : workspace
  const inherited = activeWorkspaceOperation.getStore()
  if (inherited?.serializationKey === key && activeWorkspaceOperationTokens.has(inherited.token))
    throw failed()
  const previous = workspaceOperationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn
  })
  workspaceOperationTails.set(key, turn)
  await previous
  const token = Symbol("appearance-workspace-operation")
  activeWorkspaceOperationTokens.add(token)
  try {
    return await activeWorkspaceOperation.run(
      { canonical: workspace, serializationKey: key, token },
      () => operation(workspace),
    )
  } finally {
    activeWorkspaceOperationTokens.delete(token)
    release()
    if (workspaceOperationTails.get(key) === turn) workspaceOperationTails.delete(key)
  }
}

async function assertSafeAncestors(workspace: string, absolute: string): Promise<void> {
  const parent = dirname(absolute)
  if (!inside(workspace, parent)) throw conflict()
  const segments = relative(workspace, parent).split(sep).filter(Boolean)
  let current = workspace
  try {
    for (const segment of segments) {
      current = resolve(current, segment)
      const [details, canonical] = await Promise.all([lstat(current), realpath(current)])
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        !pathsEqual(current, canonical) ||
        !inside(workspace, canonical)
      )
        throw conflict()
    }
  } catch {
    throw conflict()
  }
}

async function readOrdinaryFile(
  workspace: string,
  path: string,
  context: FileSystemOperationContext,
  maxBytes = MAX_APPEARANCE_FILE_BYTES,
): Promise<FileEvidence | null> {
  const absolute = targetPath(workspace, path)
  await assertSafeAncestors(workspace, absolute)
  let details: BigIntStats
  try {
    details = await lstat(absolute, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw conflict()
  }
  if (!details.isFile() || details.isSymbolicLink()) throw conflict()
  if (details.size > BigInt(maxBytes)) throw conflict()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const canonical = await realpath(absolute)
    if (!pathsEqual(canonical, absolute) || !inside(workspace, canonical)) throw conflict()
    handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      undefined,
      context,
    )
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== details.dev ||
      opened.ino !== details.ino ||
      opened.size !== details.size ||
      opened.size > BigInt(maxBytes) ||
      opened.mtimeNs !== details.mtimeNs ||
      opened.ctimeNs !== details.ctimeNs
    )
      throw conflict()
    const length = Number(opened.size)
    const bytes = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== length) throw conflict()
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(absolute, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    )
      throw conflict()
    return {
      bytes,
      hash: hash(bytes),
      identity: {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeNs: opened.mtimeNs,
        ctimeNs: opened.ctimeNs,
      },
    }
  } catch (error) {
    if (record(error) && error.code === "APPEARANCE_CONFLICT") throw error
    throw conflict()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function sameIdentity(left: FileEvidence, right: FileEvidence): boolean {
  return (
    left.hash === right.hash &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.identity.size === right.identity.size &&
    left.identity.mtimeNs === right.identity.mtimeNs &&
    left.identity.ctimeNs === right.identity.ctimeNs
  )
}

function sameEvidence(left: FileEvidence | null, right: FileEvidence | null): boolean {
  return left === null ? right === null : right !== null && sameIdentity(left, right)
}

function directoryIdentity(
  details: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): DirectoryIdentity {
  if (details.dev <= 0n || details.ino <= 0n) throw uncertain()
  return { dev: details.dev, ino: details.ino, birthtimeNs: details.birthtimeNs }
}

function validIdentityNumber(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false
  try {
    return BigInt(value) > 0n
  } catch {
    return false
  }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
}

function authenticatedFileIdentity(
  details: Pick<BigIntStats, "dev" | "ino">,
): AuthenticatedFileIdentity {
  if (details.dev <= 0n || details.ino <= 0n) throw uncertain()
  return { dev: details.dev.toString(), ino: details.ino.toString() }
}

function authenticatedTempIdentity(
  details: Pick<BigIntStats, "dev" | "ino" | "ctimeNs" | "nlink">,
): AuthenticatedTempIdentity {
  return {
    ...authenticatedFileIdentity(details),
    ctimeNs: details.ctimeNs.toString(),
    nlink: details.nlink.toString(),
  }
}

function authenticatedDirectoryIdentity(
  details: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): AuthenticatedDirectoryIdentity {
  return {
    ...authenticatedFileIdentity(details),
    birthtimeNs: details.birthtimeNs.toString(),
  }
}

function matchesFileIdentity(
  details: Pick<BigIntStats, "dev" | "ino">,
  identity: AuthenticatedFileIdentity | null,
): boolean {
  return (
    identity !== null &&
    validIdentityNumber(identity.dev) &&
    validIdentityNumber(identity.ino) &&
    details.dev > 0n &&
    details.ino > 0n &&
    details.dev.toString() === identity.dev &&
    details.ino.toString() === identity.ino
  )
}

function matchesTempIdentity(
  details: Pick<BigIntStats, "dev" | "ino" | "ctimeNs" | "nlink">,
  identity: AuthenticatedTempIdentity | null,
): boolean {
  return (
    identity !== null &&
    matchesFileIdentity(details, identity) &&
    details.ctimeNs.toString() === identity.ctimeNs &&
    details.nlink.toString() === identity.nlink
  )
}

function matchesDirectoryOwnership(
  details: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
  identity: AuthenticatedDirectoryIdentity,
): boolean {
  return (
    matchesFileIdentity(details, identity) &&
    details.birthtimeNs.toString() === identity.birthtimeNs
  )
}

async function recoverFilesystemIdentityCapability(directory: string, key: Buffer): Promise<void> {
  const claims = (await readdir(directory)).filter((name) =>
    IDENTITY_CAPABILITY_CLAIM_PATTERN.test(name),
  )
  if (claims.length > 1) throw uncertain()
  const claimName = claims[0]
  if (claimName === undefined) return
  const token = IDENTITY_CAPABILITY_CLAIM_PATTERN.exec(claimName)![1]!
  const authentication = createHmac("sha256", key)
    .update(IDENTITY_CAPABILITY_AUTHENTICATION_CONTEXT)
    .update(token)
    .digest("hex")
  const expectedClaim = Buffer.from(JSON.stringify({ version: 1, token, authentication }))
  const paths = {
    alias: resolve(directory, `.identity-capability-${token}-a-link.tmp`),
    first: resolve(directory, `.identity-capability-${token}-a.tmp`),
    second: resolve(directory, `.identity-capability-${token}-b.tmp`),
    claim: resolve(directory, claimName),
  }
  const expected = {
    alias: Buffer.from(`${token}:a`),
    first: Buffer.from(`${token}:a`),
    second: Buffer.from(`${token}:b`),
    claim: expectedClaim,
  }
  const identities = new Map<keyof typeof paths, AuthenticatedFileIdentity>()
  for (const name of ["claim", "alias", "first", "second"] as const) {
    const path = paths[name]
    const details = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (details === undefined) continue
    if (!details.isFile() || details.isSymbolicLink()) throw uncertain()
    const bytes = await readFile(path)
    const owned =
      name === "claim"
        ? expected.claim.equals(bytes)
        : bytes.length <= expected[name].length &&
          expected[name].subarray(0, bytes.length).equals(bytes)
    if (!owned) throw uncertain()
    identities.set(name, authenticatedFileIdentity(details))
  }
  const alias = identities.get("alias")
  const first = identities.get("first")
  if (
    alias !== undefined &&
    first !== undefined &&
    (alias.dev !== first.dev || alias.ino !== first.ino)
  )
    throw uncertain()
  for (const name of ["alias", "first", "second", "claim"] as const) {
    const identity = identities.get(name)
    if (identity === undefined) continue
    await fsInstruction("identity-capability-unlink", () =>
      unlinkAuthenticated(paths[name], identity, fsContext("identity-capability", "recovery")),
    )
  }
  await syncDirectory(directory, fsContext("identity-capability", "recovery"))
}

async function probeFilesystemIdentityCapability(directory: string, key: Buffer): Promise<void> {
  await recoverFilesystemIdentityCapability(directory, key)
  const token = randomUUID()
  const claim = resolve(directory, `.identity-capability-${token}.claim`)
  const first = resolve(directory, `.identity-capability-${token}-a.tmp`)
  const alias = resolve(directory, `.identity-capability-${token}-a-link.tmp`)
  const second = resolve(directory, `.identity-capability-${token}-b.tmp`)
  const authentication = createHmac("sha256", key)
    .update(IDENTITY_CAPABILITY_AUTHENTICATION_CONTEXT)
    .update(token)
    .digest("hex")
  let firstIdentity: AuthenticatedFileIdentity | undefined
  let secondIdentity: AuthenticatedFileIdentity | undefined
  let actualFirstIdentity: AuthenticatedFileIdentity | undefined
  let actualSecondIdentity: AuthenticatedFileIdentity | undefined
  let claimHandle: Awaited<ReturnType<typeof open>> | undefined
  let firstHandle: Awaited<ReturnType<typeof open>> | undefined
  let secondHandle: Awaited<ReturnType<typeof open>> | undefined
  let simulatedCrash = false
  try {
    claimHandle = await fsInstruction("identity-capability-claim-open", () =>
      open(claim, "wx", 0o600, {
        pathRole: "identity-capability-claim",
        transactionPhase: "bootstrap",
      }),
    )
    authenticatedFileIdentity(await claimHandle.stat({ bigint: true }))
    await writeHandle(claimHandle, JSON.stringify({ version: 1, token, authentication }))
    await syncHandle(claimHandle)
    firstHandle = await fsInstruction("identity-capability-open", () =>
      open(first, "wx", 0o600, {
        pathRole: "identity-capability",
        transactionPhase: "bootstrap",
      }),
    )
    secondHandle = await fsInstruction("identity-capability-open", () =>
      open(second, "wx", 0o600, {
        pathRole: "identity-capability",
        transactionPhase: "bootstrap",
      }),
    )
    await writeHandle(firstHandle, `${token}:a`)
    await syncHandle(firstHandle)
    await writeHandle(secondHandle, `${token}:b`)
    await syncHandle(secondHandle)
    actualFirstIdentity = authenticatedFileIdentity(await lstat(first, { bigint: true }))
    actualSecondIdentity = authenticatedFileIdentity(await lstat(second, { bigint: true }))
    firstIdentity = authenticatedFileIdentity(await firstHandle.stat({ bigint: true }))
    secondIdentity = authenticatedFileIdentity(await secondHandle.stat({ bigint: true }))
    if (firstIdentity.dev === secondIdentity.dev && firstIdentity.ino === secondIdentity.ino)
      throw failed()
    await fsInstruction("identity-capability-link", () =>
      link(
        first,
        alias,
        { pathRole: "identity-capability", transactionPhase: "bootstrap" },
        actualFirstIdentity,
      ),
    )
    const linked = await lstat(alias, { bigint: true })
    if (!matchesFileIdentity(linked, actualFirstIdentity)) throw failed()
  } catch (error) {
    if (isSimulationCrash(error)) {
      simulatedCrash = true
      throw error
    }
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_FAILED") throw error
    throw failed()
  } finally {
    await claimHandle?.close().catch(() => undefined)
    await firstHandle?.close().catch(() => undefined)
    await secondHandle?.close().catch(() => undefined)
    if (!simulatedCrash) await recoverFilesystemIdentityCapability(directory, key)
  }
}

async function publishFileNoClobber(
  source: string,
  destination: string,
  identity: AuthenticatedFileIdentity,
  context: FileSystemOperationContext,
): Promise<void> {
  await fsInstruction(
    "fs-link",
    async () => {
      const current = await lstat(source, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || !matchesFileIdentity(current, identity))
        throw uncertain()
      try {
        await rawLink(source, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const published = await lstat(destination, { bigint: true })
        if (
          !published.isFile() ||
          published.isSymbolicLink() ||
          !matchesFileIdentity(published, identity) ||
          published.dev !== current.dev ||
          published.ino !== current.ino
        )
          throw uncertain()
      }
    },
    context,
  )
  await fsInstruction(
    "fs-unlink",
    async () => {
      const [current, published] = await Promise.all([
        lstat(source, { bigint: true }),
        lstat(destination, { bigint: true }),
      ])
      if (!matchesFileIdentity(current, identity) || !matchesFileIdentity(published, identity))
        throw uncertain()
      await rawUnlink(source)
    },
    context,
  )
  await syncDirectory(dirname(destination), context)
}

async function unlinkAuthenticated(
  path: string,
  identity: AuthenticatedFileIdentity,
  context: FileSystemOperationContext,
  authenticate?: () => Promise<void>,
): Promise<void> {
  await fsInstruction(
    "fs-unlink",
    async () => {
      const current = await lstat(path, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || !matchesFileIdentity(current, identity))
        throw uncertain()
      await authenticate?.()
      await rawUnlink(path)
    },
    context,
  )
}

async function rmdirAuthenticated(
  path: string,
  identity: AuthenticatedDirectoryIdentity,
  context: FileSystemOperationContext,
  authenticate?: () => Promise<void>,
): Promise<void> {
  await fsInstruction(
    "fs-rmdir",
    async () => {
      const current = await lstat(path, { bigint: true })
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !matchesDirectoryOwnership(current, identity) ||
        (await readdir(path)).length !== 0
      )
        throw uncertain()
      await authenticate?.()
      await rawRmdir(path)
    },
    context,
  )
}

async function ensureSafeDirectory(workspace: string, relativePath: string): Promise<string> {
  if (relativePath !== TRANSACTION_ROOT && relativePath !== HISTORY_ROOT) throw failed()
  let directory = workspace
  for (const segment of relativePath.split("/")) {
    directory = resolve(directory, segment)
    if (!inside(workspace, directory)) throw failed()
    let created = false
    try {
      await fsInstruction("state-directory-mkdir", () =>
        mkdir(
          directory,
          { mode: 0o700 },
          {
            pathRole: "state-directory",
            transactionPhase: "bootstrap",
          },
        ),
      )
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failed()
    }
    const [details, canonical] = await Promise.all([lstat(directory), realpath(directory)])
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      !pathsEqual(directory, canonical) ||
      !inside(workspace, canonical)
    ) {
      throw failed()
    }
    if (created)
      await fsInstruction("state-directory-parent-fsync", () =>
        syncDirectory(dirname(directory), fsContext("state-directory", "bootstrap")),
      )
  }
  return directory
}

async function windowsDirectoryBarrierKey(): Promise<Buffer> {
  const context = activeWorkspaceOperation.getStore()
  if (context === undefined) throw uncertain()
  if (context.recoveryKey !== undefined) return context.recoveryKey
  try {
    const key = await internalRecoveryKey(context.canonical, false)
    context.recoveryKey = key
    return key
  } catch {
    throw uncertain()
  }
}

function authenticateWindowsDirectoryBarrier(
  key: Buffer,
  claim: WindowsDirectoryBarrierClaim,
): string {
  return createHmac("sha256", key)
    .update(WINDOWS_BARRIER_AUTHENTICATION_CONTEXT)
    .update(JSON.stringify(claim))
    .digest("hex")
}

async function syncDirectory(path: string, context: FileSystemOperationContext): Promise<void> {
  await fsInstruction(
    "directory-barrier",
    async () => {
      if (testRuntime()?.emulateDirectorySync === true) return
      if (process.platform === "win32") {
        // Windows does not expose POSIX directory fsync through Node. This is deliberately a
        // journal-recoverable fence, not a claim of strict namespace durability: every payload
        // file is fsynced separately, and this O_EXCL token records an identity-checked,
        // restart-recognizable point from which the authenticated journal can converge.
        await recoverWindowsDirectoryBarriers(path, context)
        const token = randomUUID()
        const barrier = resolve(path, `.durability-barrier-${token}.tmp`)
        const key = await windowsDirectoryBarrierKey()
        const parentBefore = authenticatedDirectoryIdentity(await lstat(path, { bigint: true }))
        let handle: Awaited<ReturnType<typeof open>> | undefined
        let identity: AuthenticatedFileIdentity | undefined
        try {
          handle = await fsInstruction(
            "directory-barrier-open",
            () => open(barrier, "wx", 0o600, context),
            context,
          )
          identity = authenticatedFileIdentity(await handle.stat({ bigint: true }))
          const claim: WindowsDirectoryBarrierClaim = {
            version: 1,
            token,
            parent: parentBefore,
            file: identity,
          }
          const envelope: WindowsDirectoryBarrierEnvelope = {
            claim,
            authentication: authenticateWindowsDirectoryBarrier(key, claim),
          }
          await fsInstruction(
            "directory-barrier-write",
            () => writeHandle(handle!, JSON.stringify(envelope)),
            context,
          )
          await fsInstruction("directory-barrier-fsync", () => syncHandle(handle!), context)
          const [opened, published, parentAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(barrier, { bigint: true }),
            lstat(path, { bigint: true }),
          ])
          if (
            !opened.isFile() ||
            !published.isFile() ||
            published.isSymbolicLink() ||
            !matchesFileIdentity(opened, identity) ||
            !matchesFileIdentity(published, identity) ||
            !matchesDirectoryOwnership(parentAfter, parentBefore)
          )
            throw uncertain()
        } finally {
          await handle?.close().catch(() => undefined)
        }
        if (identity === undefined) throw uncertain()
        await fsInstruction(
          "directory-barrier-unlink",
          () => unlinkAuthenticated(barrier, identity!, context),
          context,
        )
        return
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(path, "r", undefined, context)
        await syncHandle(handle)
      } finally {
        await handle?.close().catch(() => undefined)
      }
    },
    context,
  )
}

async function recoverWindowsDirectoryBarriers(
  path: string,
  context: FileSystemOperationContext,
): Promise<void> {
  if (process.platform !== "win32") return
  const key = await windowsDirectoryBarrierKey()
  const names = await rawReaddir(path)
  for (const name of names) {
    const match = WINDOWS_BARRIER_PATTERN.exec(name)
    if (match === null || !ID_PATTERN.test(match[1]!)) continue
    const barrier = resolve(path, name)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        barrier,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        undefined,
        context,
      )
      const [opened, published, bytes] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(barrier, { bigint: true }),
        handle.readFile(),
      ])
      let envelope: unknown
      try {
        envelope = JSON.parse(bytes.toString("utf8"))
      } catch {
        throw uncertain()
      }
      if (
        !opened.isFile() ||
        !published.isFile() ||
        published.isSymbolicLink() ||
        opened.dev !== published.dev ||
        opened.ino !== published.ino ||
        !record(envelope) ||
        !exactKeys(envelope, ["claim", "authentication"]) ||
        !record(envelope.claim) ||
        !exactKeys(envelope.claim, ["version", "token", "parent", "file"]) ||
        envelope.claim.version !== 1 ||
        envelope.claim.token !== match[1] ||
        !validAuthenticatedDirectoryIdentity(envelope.claim.parent) ||
        !validAuthenticatedFileIdentity(envelope.claim.file) ||
        typeof envelope.authentication !== "string"
      )
        throw uncertain()
      const claim = envelope.claim as unknown as WindowsDirectoryBarrierClaim
      const authenticated = envelope as unknown as WindowsDirectoryBarrierEnvelope
      if (
        !Buffer.from(JSON.stringify(authenticated)).equals(bytes) ||
        !sameMac(authenticated.authentication, authenticateWindowsDirectoryBarrier(key, claim)) ||
        !matchesFileIdentity(opened, claim.file) ||
        !matchesDirectoryOwnership(await lstat(path, { bigint: true }), claim.parent)
      )
        throw uncertain()
      const identity = authenticatedFileIdentity(opened)
      await handle.close()
      handle = undefined
      await fsInstruction(
        "directory-barrier-unlink",
        () => unlinkAuthenticated(barrier, identity, context),
        context,
      )
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}

async function readdir(path: string): Promise<string[]> {
  await recoverWindowsDirectoryBarriers(path, fsContext("directory-barrier", "recovery"))
  return rawReaddir(path)
}

async function syncFile(path: string, context: FileSystemOperationContext): Promise<void> {
  const handle = await open(path, "r+", undefined, context)
  try {
    await syncHandle(handle)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function writeExclusiveSynced(
  path: string,
  bytes: Uint8Array,
  afterOpen: () => Promise<void>,
  beforeWrite: () => Promise<void>,
  beforeSync: () => Promise<void>,
  context: FileSystemOperationContext,
): Promise<void> {
  const handle = await fsInstruction("evidence-open", () => open(path, "wx", 0o600, context))
  try {
    await afterOpen()
    await beforeWrite()
    await fsInstruction("evidence-write", () => writeHandle(handle, bytes))
    await beforeSync()
    await fsInstruction("evidence-fsync", () => syncHandle(handle))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function invoke(
  options: AppearanceTransactionOptions,
  operation: AppearanceTransactionOperation,
): Promise<void> {
  await options.beforeOperation?.(operation)
}

function validatePlan(plan: AppearancePlan): number {
  if (!DIGEST_PATTERN.test(plan.baselineHash)) throw conflict()
  const entryCount = plan.writes.length + plan.deletes.length
  if (entryCount < 1 || entryCount > 128) throw conflict()
  const paths = new Set<string>()
  let totalBytes = 0
  for (const entry of plan.writes) {
    validateRelativePath(entry.path)
    const alias = windowsPathAlias(entry.path)
    if (
      paths.has(alias) ||
      (entry.expectedHash !== null && !DIGEST_PATTERN.test(entry.expectedHash))
    )
      throw conflict()
    if (entry.bytes.byteLength > MAX_APPEARANCE_FILE_BYTES) throw conflict()
    totalBytes += entry.bytes.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_APPEARANCE_TOTAL_BYTES)
      throw conflict()
    paths.add(alias)
  }
  for (const entry of plan.deletes) {
    validateRelativePath(entry.path)
    const alias = windowsPathAlias(entry.path)
    if (paths.has(alias) || !DIGEST_PATTERN.test(entry.expectedHash)) throw conflict()
    paths.add(alias)
  }
  return totalBytes
}

async function validatePreconditions(
  workspace: string,
  plan: AppearancePlan,
): Promise<Map<string, FileEvidence | null>> {
  let totalBytes = validatePlan(plan)
  const evidence = new Map<string, FileEvidence | null>()
  const entries = [...plan.writes, ...plan.deletes].sort((left, right) =>
    compareOrdinal(left.path, right.path),
  )
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const current = await readOrdinaryFile(
      workspace,
      entry.path,
      fsContext("target", "bootstrap", index),
      MAX_APPEARANCE_FILE_BYTES,
    )
    if (entry.expectedHash === null ? current !== null : current?.hash !== entry.expectedHash)
      throw conflict()
    totalBytes += Number(current?.identity.size ?? 0n)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_APPEARANCE_TOTAL_BYTES)
      throw conflict()
    evidence.set(entry.path, current)
  }
  return evidence
}

async function revalidatePreconditions(
  workspace: string,
  evidence: ReadonlyMap<string, FileEvidence | null>,
): Promise<void> {
  let index = 0
  for (const [path, expected] of evidence) {
    const current = await readOrdinaryFile(workspace, path, fsContext("target", "prepared", index))
    if (expected === null ? current !== null : current === null || !sameIdentity(expected, current))
      throw conflict()
    index += 1
  }
}

function journalEntry(
  index: number,
  path: string,
  before: FileEvidence | null,
  afterHash: string | null,
): AppearanceJournalEntry {
  return {
    path,
    beforeHash: before?.hash ?? null,
    afterHash,
    beforeIdentity:
      before === null
        ? null
        : { dev: before.identity.dev.toString(), ino: before.identity.ino.toString() },
    afterIdentity: null,
    backupIdentity: null,
    stagedIdentity: null,
    installIdentity: null,
    publishTempIdentity: null,
    publishTempConsumed: false,
    rollbackTempIdentity: null,
    rollbackTempConsumed: false,
    backup: before === null ? null : `backups/${index.toString().padStart(8, "0")}.bin`,
    staged: afterHash === null ? null : `staged/${index.toString().padStart(8, "0")}.bin`,
  }
}

async function writeJournal(
  transaction: PreparedTransaction,
  options: AppearanceTransactionOptions,
): Promise<void> {
  const { key, directory } = transaction
  const sequence = transaction.journal.revision.toString().padStart(8, "0")
  const temporary = resolve(directory, `.journal.${sequence}.${randomUUID()}.tmp`)
  const destination = resolve(directory, `journal.${sequence}.json`)
  const journalContext: FileSystemOperationContext = {
    pathRole: "journal-temp",
    transactionPhase: transaction.journal.phase,
  }
  const handle = await fsInstruction("journal-temp-open", () =>
    open(temporary, "wx", 0o600, journalContext),
  )
  await rememberOwnedEntry(transaction, basename(temporary))
  try {
    const opened = await handle.stat({ bigint: true })
    transaction.journal = {
      ...transaction.journal,
      ownership: {
        ...transaction.journal.ownership,
        journal: authenticatedFileIdentity(opened),
      },
    }
    const envelope: JournalEnvelope = {
      journal: transaction.journal,
      authentication: authenticate(key, transaction.journal),
    }
    await invoke(options, { kind: "journal-write", revision: transaction.journal.revision })
    await fsInstruction("journal-temp-write", () => writeHandle(handle, JSON.stringify(envelope)))
    await invoke(options, { kind: "journal-file-fsync", revision: transaction.journal.revision })
    await fsInstruction("journal-temp-fsync", () => syncHandle(handle))
  } finally {
    await handle.close().catch(() => undefined)
  }
  await invoke(options, { kind: "journal-rename", revision: transaction.journal.revision })
  const journalIdentity = transaction.journal.ownership.journal
  if (journalIdentity === null) throw uncertain()
  await fsInstruction("journal-rename", () =>
    publishFileNoClobber(temporary, destination, journalIdentity, {
      pathRole: "journal",
      transactionPhase: transaction.journal.phase,
    }),
  )
  forgetOwnedEntry(transaction, basename(temporary))
  await rememberOwnedEntry(transaction, basename(destination))
  await invoke(options, {
    kind: "journal-directory-fsync",
    revision: transaction.journal.revision,
  })
  await fsInstruction("journal-parent-fsync", () =>
    syncDirectory(directory, fsContext("journal", transaction.journal.phase)),
  )
}

async function advanceJournal(
  transaction: PreparedTransaction,
  phase: "published" | "verified",
  options: AppearanceTransactionOptions,
): Promise<void> {
  if (phase === "published") {
    const entries: AppearanceJournalEntry[] = []
    for (let index = 0; index < transaction.journal.entries.length; index += 1) {
      const entry = transaction.journal.entries[index]!
      if (entry.afterHash === null) {
        entries.push(entry)
        continue
      }
      const current = await readOrdinaryFile(
        transaction.workspace,
        entry.path,
        fsContext("target", transaction.journal.phase, index),
      ).catch(() => {
        throw uncertain()
      })
      const installed = resolve(
        transaction.directory,
        `installed/${index.toString().padStart(8, "0")}.bin`,
      )
      const evidence = await lstat(installed, { bigint: true }).catch(() => {
        throw uncertain()
      })
      if (
        current === null ||
        current.hash !== entry.afterHash ||
        current.identity.dev !== evidence.dev ||
        current.identity.ino !== evidence.ino
      )
        throw uncertain()
      entries.push({
        ...entry,
        afterIdentity: {
          dev: current.identity.dev.toString(),
          ino: current.identity.ino.toString(),
        },
      })
    }
    transaction.journal = { ...transaction.journal, entries }
  }
  transaction.journal = {
    ...transaction.journal,
    phase,
    revision: transaction.journal.revision + 1,
  }
  await writeJournal(transaction, options)
  if (phase === "published") {
    const installedRoot = resolve(transaction.directory, "installed")
    for (const name of await readdir(installedRoot)) {
      if (!/^\d{8}\.bin$/.test(name)) throw uncertain()
      const fileIndex = Number(name.slice(0, 8))
      const identity = transaction.journal.entries[fileIndex]?.installIdentity
      if (identity === null || identity === undefined) throw uncertain()
      await unlinkAuthenticated(resolve(installedRoot, name), identity, {
        pathRole: "installed-evidence",
        fileIndex,
        transactionPhase: transaction.journal.phase,
      })
      forgetOwnedEntry(transaction, `installed/${name}`)
    }
    await syncDirectory(installedRoot, fsContext("installed-evidence", transaction.journal.phase))
  }
}

async function authenticateEvidenceIdentity(
  transaction: PreparedTransaction,
  index: number,
  field: "backupIdentity" | "stagedIdentity" | "installIdentity",
  path: string,
  options: AppearanceTransactionOptions,
): Promise<void> {
  await rememberOwnedEntry(transaction, path)
  const details = await lstat(resolve(transaction.directory, ...path.split("/")), { bigint: true })
  const identity = { dev: details.dev.toString(), ino: details.ino.toString() }
  const current = transaction.journal.entries[index]![field]
  if (current !== null && (current.dev !== identity.dev || current.ino !== identity.ino))
    throw uncertain()
  transaction.journal = {
    ...transaction.journal,
    entries: transaction.journal.entries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, [field]: identity } : entry,
    ),
  }
  void options
}

async function authenticateEntryIdentity(
  transaction: PreparedTransaction,
  index: number,
  field:
    | "backupIdentity"
    | "stagedIdentity"
    | "installIdentity"
    | "publishTempIdentity"
    | "rollbackTempIdentity",
  identity: AuthenticatedFileIdentity,
  options: AppearanceTransactionOptions,
): Promise<void> {
  const current = transaction.journal.entries[index]!
  const previous = current[field]
  if (previous !== null) {
    if (previous.dev !== identity.dev || previous.ino !== identity.ino) throw uncertain()
    return
  }
  const entries = transaction.journal.entries.map((entry, entryIndex) =>
    entryIndex === index ? { ...entry, [field]: identity } : entry,
  )
  transaction.journal = {
    ...transaction.journal,
    entries,
    revision: transaction.journal.revision + 1,
  }
  await writeJournal(transaction, options)
}

async function consumePublishedTemp(
  transaction: PreparedTransaction,
  index: number,
  rollback: boolean,
  temporary: string,
  options: AppearanceTransactionOptions,
): Promise<void> {
  const field = rollback ? "rollbackTempConsumed" : "publishTempConsumed"
  const identityField = rollback ? "rollbackTempIdentity" : "publishTempIdentity"
  const entry = transaction.journal.entries[index]!
  if (entry[field]) return
  const identity = entry[identityField]
  if (identity === null) throw uncertain()
  const details = await lstat(temporary, { bigint: true }).catch(() => {
    throw uncertain()
  })
  if (!details.isFile() || details.isSymbolicLink() || !matchesFileIdentity(details, identity))
    throw uncertain()
  transaction.journal = {
    ...transaction.journal,
    entries: transaction.journal.entries.map((candidate, entryIndex) =>
      entryIndex === index
        ? {
            ...candidate,
            [identityField]: authenticatedTempIdentity(details),
            [field]: true,
          }
        : candidate,
    ),
    revision: transaction.journal.revision + 1,
  }
  await writeJournal(transaction, options)
}

async function prepare(
  workspace: string,
  plan: AppearancePlan,
  options: AppearanceTransactionOptions,
  kind: "apply" | "undo",
  historyId: string | null,
): Promise<PreparedTransaction> {
  if (
    options.readBaselineHash !== undefined &&
    (await options.readBaselineHash()) !== plan.baselineHash
  )
    throw conflict()
  const evidence = await validatePreconditions(workspace, plan)
  const key = await internalRecoveryKey(workspace, true)
  const operationContext = activeWorkspaceOperation.getStore()
  if (operationContext !== undefined) operationContext.recoveryKey = key
  const transactionRoot = await ensureSafeDirectory(workspace, TRANSACTION_ROOT)
  await probeFilesystemIdentityCapability(transactionRoot, key)
  const id = options.createId?.() ?? authenticatedTransactionId(key)
  if (!ID_PATTERN.test(id)) throw failed()
  const directory = resolve(transactionRoot, id)
  await fsInstruction("transaction-directory-mkdir", () =>
    mkdir(
      directory,
      { mode: 0o700 },
      { pathRole: "transaction-directory", transactionPhase: "bootstrap" },
    ),
  )
  const initialDirectory = await lstat(directory, { bigint: true })
  try {
    await fsInstruction("transaction-root-fsync", () =>
      syncDirectory(transactionRoot, fsContext("transaction-directory", "bootstrap")),
    )
  } catch (error) {
    const current = await lstat(directory, { bigint: true }).catch(() => undefined)
    if (
      current === undefined ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== initialDirectory.dev ||
      current.ino !== initialDirectory.ino ||
      (await readdir(directory)).length !== 0
    )
      throw uncertain()
    await fsInstruction("transaction-directory-rmdir", () =>
      rmdirAuthenticated(directory, authenticatedDirectoryIdentity(initialDirectory), {
        pathRole: "transaction-directory",
        transactionPhase: "bootstrap",
      }),
    )
    await syncDirectory(transactionRoot, fsContext("transaction-directory", "bootstrap"))
    throw error
  }
  await fsInstruction("evidence-directory-mkdir", () =>
    mkdir(
      resolve(directory, "staged"),
      { mode: 0o700 },
      { pathRole: "staged-directory", transactionPhase: "bootstrap" },
    ),
  )
  await fsInstruction("evidence-directory-mkdir", () =>
    mkdir(
      resolve(directory, "backups"),
      { mode: 0o700 },
      { pathRole: "backup-directory", transactionPhase: "bootstrap" },
    ),
  )
  await fsInstruction("evidence-directory-mkdir", () =>
    mkdir(
      resolve(directory, "quarantine"),
      { mode: 0o700 },
      { pathRole: "quarantine-directory", transactionPhase: "bootstrap" },
    ),
  )
  await fsInstruction("evidence-directory-mkdir", () =>
    mkdir(
      resolve(directory, "installed"),
      { mode: 0o700 },
      { pathRole: "installed-directory", transactionPhase: "bootstrap" },
    ),
  )
  const ownedDirectory = directoryIdentity(initialDirectory)
  const evidenceOwnership = Object.fromEntries(
    await Promise.all(
      (["backups", "staged", "quarantine", "installed"] as const).map(async (name) => [
        name,
        authenticatedDirectoryIdentity(await lstat(resolve(directory, name), { bigint: true })),
      ]),
    ),
  ) as JournalOwnership["evidence"]
  const planned = [
    ...plan.writes.map((entry) => ({
      path: entry.path,
      beforeHash: entry.expectedHash,
      afterHash: hash(entry.bytes),
      bytes: Buffer.from(entry.bytes),
    })),
    ...plan.deletes.map((entry) => ({
      path: entry.path,
      beforeHash: entry.expectedHash,
      afterHash: null,
      bytes: null,
    })),
  ].sort((left, right) => compareOrdinal(left.path, right.path))
  const entries = planned.map((entry, index) =>
    journalEntry(index, entry.path, evidence.get(entry.path) ?? null, entry.afterHash),
  )
  const journal: AppearanceJournal = {
    version: 1,
    id,
    phase: "prepared",
    entries,
    revision: 1,
    kind,
    baselineHash: plan.baselineHash,
    historyId,
    ownership: {
      transaction: authenticatedDirectoryIdentity(initialDirectory),
      evidence: evidenceOwnership,
      journal: null,
    },
  }
  const transaction: PreparedTransaction = {
    workspace,
    directory,
    directoryIdentity: ownedDirectory,
    key,
    preconditions: evidence,
    journal,
    cleanupAuthorized: false,
    ownedEntries: new Map(),
  }
  try {
    for (const name of ["staged", "backups", "quarantine", "installed"])
      await rememberOwnedEntry(transaction, name)
    // The first authenticated journal is durable before any evidence file is created. This
    // makes every later partial staging state attributable to this transaction on restart.
    await Promise.all([
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(resolve(directory, "staged"), fsContext("staged-directory", "bootstrap")),
      ),
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(resolve(directory, "backups"), fsContext("backup-directory", "bootstrap")),
      ),
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(
          resolve(directory, "quarantine"),
          fsContext("quarantine-directory", "bootstrap"),
        ),
      ),
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(
          resolve(directory, "installed"),
          fsContext("installed-directory", "bootstrap"),
        ),
      ),
    ])
    await fsInstruction("transaction-directory-fsync", () =>
      syncDirectory(directory, fsContext("transaction-directory", "bootstrap")),
    )
    await writeOwnershipMarker(transaction, directory, "bootstrap.json", 0)
    await rememberOwnedEntry(transaction, "bootstrap.json")
    await writeJournal(transaction, options)
    for (let index = 0; index < planned.length; index += 1) {
      const entry = planned[index]!
      const journalItem = entries[index]!
      if (journalItem.staged !== null) {
        await writeExclusiveSynced(
          resolve(directory, journalItem.staged),
          entry.bytes!,
          () =>
            authenticateEvidenceIdentity(
              transaction,
              index,
              "stagedIdentity",
              journalItem.staged!,
              options,
            ),
          () => invoke(options, { kind: "stage-write", index }),
          () => invoke(options, { kind: "stage-fsync", index }),
          { pathRole: "staged-evidence", fileIndex: index, transactionPhase: "prepared" },
        )
        await rememberOwnedEntry(transaction, journalItem.staged)
        const installedPath = `installed/${index.toString().padStart(8, "0")}.bin`
        await writeExclusiveSynced(
          resolve(directory, installedPath),
          entry.bytes!,
          () =>
            authenticateEvidenceIdentity(
              transaction,
              index,
              "installIdentity",
              installedPath,
              options,
            ),
          () => Promise.resolve(),
          () => Promise.resolve(),
          { pathRole: "installed-evidence", fileIndex: index, transactionPhase: "prepared" },
        )
        await rememberOwnedEntry(transaction, installedPath)
      }
      if (journalItem.backup !== null) {
        const original = evidence.get(entry.path)
        if (original === null || original === undefined || original.hash !== journalItem.beforeHash)
          throw conflict()
        await writeExclusiveSynced(
          resolve(directory, journalItem.backup),
          original.bytes,
          () =>
            authenticateEvidenceIdentity(
              transaction,
              index,
              "backupIdentity",
              journalItem.backup!,
              options,
            ),
          () => invoke(options, { kind: "backup-write", index }),
          () => invoke(options, { kind: "backup-fsync", index }),
          { pathRole: "backup-evidence", fileIndex: index, transactionPhase: "prepared" },
        )
        await rememberOwnedEntry(transaction, journalItem.backup)
      }
    }
    await Promise.all([
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(resolve(directory, "staged"), fsContext("staged-directory", "prepared")),
      ),
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(resolve(directory, "backups"), fsContext("backup-directory", "prepared")),
      ),
      fsInstruction("evidence-directory-fsync", () =>
        syncDirectory(
          resolve(directory, "installed"),
          fsContext("installed-directory", "prepared"),
        ),
      ),
    ])
    await fsInstruction("transaction-directory-fsync", () =>
      syncDirectory(directory, fsContext("transaction-directory", "prepared")),
    )
    // Evidence bytes and their parent directories are durable before their identities are
    // promoted together. A restart before this revision can safely enumerate partial evidence
    // only inside the authenticated evidence directories and roll it back through cleanup.
    transaction.journal = {
      ...transaction.journal,
      revision: transaction.journal.revision + 1,
    }
    await writeJournal(transaction, options)
    await revalidatePreconditions(workspace, evidence)
    return transaction
  } catch (error) {
    if (isSimulationCrash(error)) throw error
    try {
      await cleanupTransaction(transaction)
    } catch (cleanupError) {
      if (isSimulationCrash(cleanupError)) throw cleanupError
      throw uncertain()
    }
    if (record(error) && error.code === "APPEARANCE_CONFLICT") throw error
    throw failed()
  }
}

async function readEvidenceFile(
  directory: string,
  path: string,
  expectedHash: string,
  context: FileSystemOperationContext,
): Promise<Buffer> {
  const absolute = resolve(directory, ...path.split("/"))
  if (!inside(directory, absolute)) throw uncertain()
  const details = await lstat(absolute, { bigint: true })
  if (!details.isFile() || details.isSymbolicLink()) throw uncertain()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (!pathsEqual(await realpath(absolute), absolute)) throw uncertain()
    handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      undefined,
      context,
    )
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== details.dev ||
      opened.ino !== details.ino ||
      opened.size !== details.size ||
      opened.mtimeNs !== details.mtimeNs ||
      opened.ctimeNs !== details.ctimeNs
    )
      throw uncertain()
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(absolute, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      hash(bytes) !== expectedHash
    )
      throw uncertain()
    return bytes
  } catch (error) {
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
    throw uncertain()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readStableJsonFile(
  path: string,
  context: FileSystemOperationContext,
): Promise<{ readonly value: unknown; readonly details: BigIntStats }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const details = await lstat(path, { bigint: true })
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > BigInt(MAX_JOURNAL_BYTES) ||
      !pathsEqual(await realpath(path), path)
    )
      throw uncertain()
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), undefined, context)
    const opened = await handle.stat({ bigint: true })
    if (
      opened.dev !== details.dev ||
      opened.ino !== details.ino ||
      opened.size !== details.size ||
      opened.mtimeNs !== details.mtimeNs ||
      opened.ctimeNs !== details.ctimeNs
    )
      throw uncertain()
    const value: unknown = JSON.parse(await handle.readFile("utf8"))
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size ||
      pathAfter.mtimeNs !== opened.mtimeNs ||
      pathAfter.ctimeNs !== opened.ctimeNs
    )
      throw uncertain()
    return { value, details: opened }
  } catch (error) {
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
    throw uncertain()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function quarantineEvidence(
  transaction: PreparedTransaction,
  index: number,
  expected: FileEvidence,
): Promise<string> {
  const path = `quarantine/${index.toString().padStart(8, "0")}.bin`
  const absolute = resolve(transaction.directory, path)
  try {
    await lstat(absolute)
    throw uncertain()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const target = targetPath(transaction.workspace, transaction.journal.entries[index]!.path)
  await fsInstruction("quarantine-rename", () =>
    publishFileNoClobber(target, absolute, authenticatedFileIdentity(expected.identity), {
      pathRole: "quarantine-evidence",
      fileIndex: index,
      transactionPhase: transaction.journal.phase,
    }),
  )
  let details: BigIntStats
  try {
    details = await lstat(absolute, { bigint: true })
    await readEvidenceFile(transaction.directory, path, expected.hash, {
      pathRole: "quarantine-evidence",
      fileIndex: index,
      transactionPhase: transaction.journal.phase,
    })
  } catch {
    throw uncertain()
  }
  if (
    details.dev !== expected.identity.dev ||
    details.ino !== expected.identity.ino ||
    details.size !== expected.identity.size
  ) {
    try {
      const capturedIdentity = authenticatedFileIdentity(details)
      await link(
        absolute,
        target,
        { pathRole: "target", fileIndex: index, transactionPhase: transaction.journal.phase },
        capturedIdentity,
      )
      await unlinkAuthenticated(absolute, capturedIdentity, {
        pathRole: "quarantine-evidence",
        fileIndex: index,
        transactionPhase: transaction.journal.phase,
      })
      await syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index))
      await syncDirectory(
        dirname(absolute),
        fsContext("quarantine-evidence", transaction.journal.phase, index),
      )
    } catch (error) {
      if (isSimulationCrash(error)) throw error
      throw uncertain()
    }
    throw conflict()
  }
  await fsInstruction("quarantine-fsync", () =>
    syncDirectory(
      dirname(absolute),
      fsContext("quarantine-evidence", transaction.journal.phase, index),
    ),
  )
  await fsInstruction("target-parent-after-quarantine-fsync", () =>
    syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index)),
  )
  await rememberOwnedEntry(transaction, path)
  return absolute
}

async function atomicReplace(
  transaction: PreparedTransaction,
  index: number,
  evidencePath: string,
  expectedHash: string,
  expectedCurrent: FileEvidence | null,
  options: AppearanceTransactionOptions,
  rollback = false,
): Promise<void> {
  const entry = transaction.journal.entries[index]!
  const target = targetPath(transaction.workspace, entry.path)
  await assertSafeAncestors(transaction.workspace, target)
  const temporary = resolve(
    dirname(target),
    `.${basename(target)}.appearance-${transaction.journal.id}-${index.toString().padStart(8, "0")}.tmp`,
  )
  let quarantine: string | undefined
  let simulatedCrash = false
  let temporaryIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined
  const source = resolve(transaction.directory, ...evidencePath.split("/"))
  try {
    const evidenceRole = evidencePath.startsWith("backups/") ? "backup-evidence" : "staged-evidence"
    const operationContext: FileSystemOperationContext = {
      pathRole: evidenceRole,
      fileIndex: index,
      transactionPhase: transaction.journal.phase,
    }
    const bytes = await readEvidenceFile(
      transaction.directory,
      evidencePath,
      expectedHash,
      operationContext,
    )
    if (!rollback) await invoke(options, { kind: "publish-temp-write", index })
    if (rollback) {
      await fsInstruction("publish-temp-link", async () => {
        const sourceIdentity = evidencePath.startsWith("backups/")
          ? entry.backupIdentity
          : entry.stagedIdentity
        if (sourceIdentity === null) throw uncertain()
        await link(
          source,
          temporary,
          {
            pathRole: "publish-temp",
            fileIndex: index,
            transactionPhase: transaction.journal.phase,
          },
          sourceIdentity,
        )
        const details = await lstat(temporary, { bigint: true })
        temporaryIdentity = { dev: details.dev, ino: details.ino }
        await syncDirectory(
          dirname(temporary),
          fsContext("publish-temp", transaction.journal.phase, index),
        )
        await authenticateEntryIdentity(
          transaction,
          index,
          "rollbackTempIdentity",
          authenticatedTempIdentity(details),
          options,
        )
      })
    } else {
      const installedPath = `installed/${index.toString().padStart(8, "0")}.bin`
      const installed = resolve(transaction.directory, installedPath)
      const identity = entry.installIdentity
      if (identity === null) throw uncertain()
      const handle = await fsInstruction("publish-temp-open", () =>
        open(installed, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), undefined, {
          pathRole: "installed-evidence",
          fileIndex: index,
          transactionPhase: transaction.journal.phase,
        }),
      )
      try {
        const opened = await handle.stat({ bigint: true })
        if (opened.dev.toString() !== identity.dev || opened.ino.toString() !== identity.ino)
          throw uncertain()
        await fsInstruction("publish-temp-write", () => writeHandle(handle, bytes))
        await fsInstruction("publish-temp-fsync", () => syncHandle(handle))
      } finally {
        await handle.close().catch(() => undefined)
      }
      await fsInstruction("installed-evidence-fsync", () =>
        syncDirectory(
          dirname(installed),
          fsContext("installed-evidence", transaction.journal.phase, index),
        ),
      )
      await fsInstruction("installed-evidence-link", async () => {
        await link(
          installed,
          temporary,
          {
            pathRole: "publish-temp",
            fileIndex: index,
            transactionPhase: transaction.journal.phase,
          },
          identity,
        )
        const details = await lstat(temporary, { bigint: true })
        temporaryIdentity = { dev: details.dev, ino: details.ino }
        await syncDirectory(
          dirname(temporary),
          fsContext("publish-temp", transaction.journal.phase, index),
        )
        await authenticateEntryIdentity(
          transaction,
          index,
          "publishTempIdentity",
          authenticatedTempIdentity(details),
          options,
        )
      }).catch((error) => {
        if (isSimulationCrash(error)) throw error
        throw uncertain()
      })
    }
    const createdTemporary = await lstat(temporary, { bigint: true })
    temporaryIdentity ??= { dev: createdTemporary.dev, ino: createdTemporary.ino }
    if (!rollback) await invoke(options, { kind: "publish-file-fsync", index })
    await syncFile(temporary, fsContext("publish-temp", transaction.journal.phase, index))
    await invoke(options, { kind: rollback ? "rollback-replace" : "replace", index })
    if (expectedCurrent !== null) {
      quarantine = await quarantineEvidence(transaction, index, expectedCurrent)
      await invoke(options, { kind: "after-quarantine", index })
    }
    const latestTempIdentity = rollback
      ? transaction.journal.entries[index]!.rollbackTempIdentity
      : transaction.journal.entries[index]!.publishTempIdentity
    if (latestTempIdentity === null) throw uncertain()
    await fsInstruction("install-link", () =>
      link(
        temporary,
        target,
        { pathRole: "target", fileIndex: index, transactionPhase: transaction.journal.phase },
        latestTempIdentity,
      ),
    ).catch((error) => {
      if (isSimulationCrash(error)) throw error
      throw uncertain()
    })
    await invoke(options, { kind: "after-install", index })
    await fsInstruction("install-file-fsync", () =>
      syncFile(target, fsContext("target", transaction.journal.phase, index)),
    )
    await fsInstruction("install-parent-fsync", () =>
      syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index)),
    )
    await consumePublishedTemp(transaction, index, rollback, temporary, options)
    await fsInstruction("publish-temp-unlink", () =>
      unlinkAuthenticated(temporary, latestTempIdentity, {
        pathRole: "publish-temp",
        fileIndex: index,
        transactionPhase: transaction.journal.phase,
      }),
    )
    await syncDirectory(
      dirname(temporary),
      fsContext("publish-temp", transaction.journal.phase, index),
    )
    if (quarantine !== undefined) {
      const captured = quarantine
      const capturedIdentity = transaction.ownedEntries.get(
        `quarantine/${index.toString().padStart(8, "0")}.bin`,
      )
      if (capturedIdentity === undefined) throw uncertain()
      await fsInstruction("quarantine-unlink", () =>
        unlinkAuthenticated(
          captured,
          { dev: capturedIdentity.dev.toString(), ino: capturedIdentity.ino.toString() },
          {
            pathRole: "quarantine-evidence",
            fileIndex: index,
            transactionPhase: transaction.journal.phase,
          },
        ),
      )
      forgetOwnedEntry(transaction, `quarantine/${index.toString().padStart(8, "0")}.bin`)
      await fsInstruction("quarantine-fsync", () =>
        syncDirectory(
          dirname(captured),
          fsContext("quarantine-evidence", transaction.journal.phase, index),
        ),
      )
    }
    const published = await readOrdinaryFile(
      transaction.workspace,
      entry.path,
      fsContext("target", transaction.journal.phase, index),
    ).catch(() => {
      throw uncertain()
    })
    if (published === null || published.hash !== expectedHash) throw uncertain()
  } catch (error) {
    simulatedCrash = isSimulationCrash(error)
    throw error
  } finally {
    if (!simulatedCrash) {
      const tempDetails = await lstat(temporary, { bigint: true }).catch(() => undefined)
      const latestEntry = transaction.journal.entries[index]!
      const journalIdentity = rollback
        ? latestEntry.rollbackTempIdentity
        : latestEntry.publishTempIdentity
      const consumed = rollback ? latestEntry.rollbackTempConsumed : latestEntry.publishTempConsumed
      const authenticatedTemp =
        tempDetails !== undefined &&
        (consumed
          ? matchesTempIdentity(tempDetails, journalIdentity)
          : matchesFileIdentity(tempDetails, journalIdentity))
      const locallyCreatedUnjournaledTemp =
        journalIdentity === null &&
        tempDetails !== undefined &&
        temporaryIdentity !== undefined &&
        temporaryIdentity.dev === tempDetails.dev &&
        temporaryIdentity.ino === tempDetails.ino
      if (
        tempDetails !== undefined &&
        tempDetails.isFile() &&
        !tempDetails.isSymbolicLink() &&
        (authenticatedTemp || locallyCreatedUnjournaledTemp)
      ) {
        await fsInstruction("publish-temp-unlink", () =>
          unlinkAuthenticated(temporary, authenticatedFileIdentity(tempDetails), {
            pathRole: "publish-temp",
            fileIndex: index,
            transactionPhase: transaction.journal.phase,
          }),
        ).catch(() => undefined)
        await syncDirectory(
          dirname(temporary),
          fsContext("publish-temp", transaction.journal.phase, index),
        ).catch(() => undefined)
      }
    }
  }
  if (!rollback) await invoke(options, { kind: "publish-directory-fsync", index })
  await syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index))
}

async function resolvePublishTemps(transaction: PreparedTransaction): Promise<void> {
  for (let index = 0; index < transaction.journal.entries.length; index += 1) {
    const entry = transaction.journal.entries[index]!
    const target = targetPath(transaction.workspace, entry.path)
    const temporary = resolve(
      dirname(target),
      `.${basename(target)}.appearance-${transaction.journal.id}-${index.toString().padStart(8, "0")}.tmp`,
    )
    const tempDetails = await lstat(temporary, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw uncertain()
      },
    )
    if (tempDetails === undefined) continue
    if (!tempDetails.isFile() || tempDetails.isSymbolicLink()) throw uncertain()
    const ownedForward = entry.publishTempConsumed
      ? matchesTempIdentity(tempDetails, entry.publishTempIdentity)
      : matchesFileIdentity(tempDetails, entry.publishTempIdentity)
    const ownedRollback = entry.rollbackTempConsumed
      ? matchesTempIdentity(tempDetails, entry.rollbackTempIdentity)
      : matchesFileIdentity(tempDetails, entry.rollbackTempIdentity)
    if (!ownedForward && !ownedRollback) throw uncertain()
    const identity = ownedForward ? entry.publishTempIdentity : entry.rollbackTempIdentity
    if (identity === null) throw uncertain()
    await fsInstruction("publish-temp-unlink", () =>
      unlinkAuthenticated(temporary, identity, {
        pathRole: "publish-temp",
        fileIndex: index,
        transactionPhase: transaction.journal.phase,
      }),
    )
    await syncDirectory(
      dirname(temporary),
      fsContext("publish-temp", transaction.journal.phase, index),
    )
  }
}

async function publish(
  transaction: PreparedTransaction,
  options: AppearanceTransactionOptions,
): Promise<void> {
  for (let index = 0; index < transaction.journal.entries.length; index += 1) {
    const entry = transaction.journal.entries[index]!
    const target = targetPath(transaction.workspace, entry.path)
    const current = await readOrdinaryFile(
      transaction.workspace,
      entry.path,
      fsContext("target", transaction.journal.phase, index),
    )
    const prepared = transaction.preconditions?.get(entry.path)
    if (
      (prepared !== undefined && !sameEvidence(prepared, current)) ||
      (prepared === undefined &&
        (entry.beforeHash === null ? current !== null : current?.hash !== entry.beforeHash))
    ) {
      throw conflict()
    }
    if (entry.afterHash === null) {
      await invoke(options, { kind: "delete", index })
      if (current === null) throw conflict()
      const quarantine = await quarantineEvidence(transaction, index, current)
      await invoke(options, { kind: "after-quarantine", index })
      const confirmed = await readOrdinaryFile(
        transaction.workspace,
        entry.path,
        fsContext("target", transaction.journal.phase, index),
      ).catch(() => {
        throw uncertain()
      })
      if (confirmed !== null) throw uncertain()
      const quarantineIdentity = transaction.ownedEntries.get(
        `quarantine/${index.toString().padStart(8, "0")}.bin`,
      )
      if (quarantineIdentity === undefined) throw uncertain()
      await fsInstruction("quarantine-unlink", () =>
        unlinkAuthenticated(
          quarantine,
          { dev: quarantineIdentity.dev.toString(), ino: quarantineIdentity.ino.toString() },
          {
            pathRole: "quarantine-evidence",
            fileIndex: index,
            transactionPhase: transaction.journal.phase,
          },
        ),
      )
      forgetOwnedEntry(transaction, `quarantine/${index.toString().padStart(8, "0")}.bin`)
      await fsInstruction("quarantine-fsync", () =>
        syncDirectory(
          dirname(quarantine),
          fsContext("quarantine-evidence", transaction.journal.phase, index),
        ),
      )
      await invoke(options, { kind: "publish-directory-fsync", index })
      await syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index))
    } else {
      if (entry.staged === null) throw uncertain()
      await atomicReplace(transaction, index, entry.staged, entry.afterHash, current, options)
    }
  }
}

type ExactState = "before" | "after" | "other"

function matchesAuthenticatedIdentity(
  current: FileEvidence,
  identity: AppearanceJournalEntry["beforeIdentity"] | AppearanceJournalEntry["afterIdentity"],
): boolean {
  return (
    identity !== null &&
    current.identity.dev.toString() === identity.dev &&
    current.identity.ino.toString() === identity.ino
  )
}

function matchesJournalEvidenceIdentity(
  details: Pick<BigIntStats, "dev" | "ino">,
  entry: AppearanceJournalEntry,
  digest: string,
): boolean {
  if (entry.beforeHash === digest && matchesFileIdentity(details, entry.beforeIdentity)) return true
  return (
    entry.afterHash === digest &&
    (matchesFileIdentity(details, entry.afterIdentity) ||
      matchesFileIdentity(details, entry.installIdentity))
  )
}

async function sameAsEvidence(
  transaction: PreparedTransaction,
  current: FileEvidence,
  path: string | null,
  expectedHash: string | null,
): Promise<boolean> {
  if (path === null || expectedHash === null || current.hash !== expectedHash) return false
  const absolute = resolve(transaction.directory, ...path.split("/"))
  if (path.startsWith("installed/")) {
    try {
      await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw uncertain()
    }
  }
  try {
    await readEvidenceFile(transaction.directory, path, expectedHash, {
      pathRole: path.startsWith("installed/") ? "installed-evidence" : "transaction-evidence",
      transactionPhase: transaction.journal.phase,
    })
  } catch (error) {
    throw error
  }
  const details = await lstat(absolute, { bigint: true })
  return current.identity.dev === details.dev && current.identity.ino === details.ino
}

async function exactState(
  transaction: PreparedTransaction,
  entry: AppearanceJournalEntry,
  index: number,
): Promise<ExactState> {
  let current: FileEvidence | null
  try {
    current = await readOrdinaryFile(
      transaction.workspace,
      entry.path,
      fsContext("target", transaction.journal.phase, index),
    )
  } catch {
    return "other"
  }
  if (
    entry.beforeHash === null
      ? current === null
      : current !== null &&
        current.hash === entry.beforeHash &&
        (matchesAuthenticatedIdentity(current, entry.beforeIdentity) ||
          (await sameAsEvidence(transaction, current, entry.backup, entry.beforeHash)))
  )
    return "before"
  if (
    entry.afterHash === null
      ? current === null
      : current !== null &&
        current.hash === entry.afterHash &&
        (matchesAuthenticatedIdentity(current, entry.afterIdentity) ||
          (await sameAsEvidence(
            transaction,
            current,
            entry.staged === null ? null : `installed/${basename(entry.staged)}`,
            entry.afterHash,
          )))
  )
    return "after"
  return "other"
}

async function resolveQuarantineArtifacts(
  transaction: PreparedTransaction,
  desired: "before" | "after",
  options: AppearanceTransactionOptions,
): Promise<void> {
  for (let index = 0; index < transaction.journal.entries.length; index += 1) {
    const entry = transaction.journal.entries[index]!
    const path = `quarantine/${index.toString().padStart(8, "0")}.bin`
    const quarantine = resolve(transaction.directory, path)
    let quarantineDetails: BigIntStats
    try {
      quarantineDetails = await lstat(quarantine, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw uncertain()
    }
    if (!quarantineDetails.isFile() || quarantineDetails.isSymbolicLink()) throw uncertain()
    const authenticatedQuarantine = [entry.beforeHash, entry.afterHash].some(
      (digest) =>
        digest !== null && matchesJournalEvidenceIdentity(quarantineDetails, entry, digest),
    )
    if (!authenticatedQuarantine) throw uncertain()
    const expected = desired === "before" ? entry.beforeHash : entry.afterHash
    const current = await readOrdinaryFile(
      transaction.workspace,
      entry.path,
      fsContext("target", transaction.journal.phase, index),
    ).catch(() => {
      throw uncertain()
    })
    const currentState = current === null ? undefined : await exactState(transaction, entry, index)
    if (current !== null && currentState === "other") throw uncertain()
    if (current === null && expected !== null) {
      let quarantineIsDesired = false
      try {
        await readEvidenceFile(transaction.directory, path, expected, {
          pathRole: "quarantine-evidence",
          fileIndex: index,
          transactionPhase: transaction.journal.phase,
        })
        quarantineIsDesired = true
      } catch {
        quarantineIsDesired = false
      }
      if (quarantineIsDesired) {
        const target = targetPath(transaction.workspace, entry.path)
        await assertSafeAncestors(transaction.workspace, target)
        await link(
          quarantine,
          target,
          { pathRole: "target", fileIndex: index, transactionPhase: transaction.journal.phase },
          authenticatedFileIdentity(quarantineDetails),
        ).catch(() => {
          throw uncertain()
        })
        await syncFile(target, fsContext("target", transaction.journal.phase, index))
        await syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index))
        continue
      }
      const evidence = desired === "before" ? entry.backup : entry.staged
      if (evidence === null) throw uncertain()
      await atomicReplace(
        transaction,
        index,
        evidence,
        expected,
        null,
        options,
        desired === "before",
      )
      continue
    }
    if (current !== null && currentState !== desired) {
      try {
        await unlinkAuthenticated(quarantine, authenticatedFileIdentity(quarantineDetails), {
          pathRole: "quarantine-evidence",
          fileIndex: index,
          transactionPhase: transaction.journal.phase,
        })
        forgetOwnedEntry(transaction, path)
        await syncDirectory(
          dirname(quarantine),
          fsContext("quarantine-evidence", transaction.journal.phase, index),
        )
      } catch {
        throw uncertain()
      }
    }
  }
}

async function verifyState(
  transaction: PreparedTransaction,
  which: "before" | "after",
): Promise<boolean> {
  for (let index = 0; index < transaction.journal.entries.length; index += 1)
    if ((await exactState(transaction, transaction.journal.entries[index]!, index)) !== which)
      return false
  return true
}

async function rollback(
  transaction: PreparedTransaction,
  options: AppearanceTransactionOptions,
): Promise<void> {
  const states: ExactState[] = []
  for (let index = 0; index < transaction.journal.entries.length; index += 1)
    states.push(await exactState(transaction, transaction.journal.entries[index]!, index))
  if (states.includes("other")) throw uncertain()
  for (let index = 0; index < transaction.journal.entries.length; index += 1) {
    if (states[index] === "before") continue
    const entry = transaction.journal.entries[index]!
    const target = targetPath(transaction.workspace, entry.path)
    const current = await readOrdinaryFile(
      transaction.workspace,
      entry.path,
      fsContext("target", transaction.journal.phase, index),
    ).catch(() => {
      throw uncertain()
    })
    if (
      entry.afterHash === null
        ? current !== null
        : current === null || current.hash !== entry.afterHash
    )
      throw uncertain()
    if (entry.beforeHash === null) {
      await invoke(options, { kind: "rollback-delete", index })
      if (current === null) throw uncertain()
      const quarantine = await quarantineEvidence(transaction, index, current)
      await invoke(options, { kind: "after-quarantine", index })
      const confirmed = await readOrdinaryFile(
        transaction.workspace,
        entry.path,
        fsContext("target", transaction.journal.phase, index),
      ).catch(() => {
        throw uncertain()
      })
      if (confirmed !== null) throw uncertain()
      const quarantineDetails = await lstat(quarantine, { bigint: true })
      await fsInstruction("quarantine-unlink", () =>
        unlinkAuthenticated(quarantine, authenticatedFileIdentity(quarantineDetails), {
          pathRole: "quarantine-evidence",
          fileIndex: index,
          transactionPhase: transaction.journal.phase,
        }),
      )
      forgetOwnedEntry(transaction, `quarantine/${index.toString().padStart(8, "0")}.bin`)
      await fsInstruction("quarantine-fsync", () =>
        syncDirectory(
          dirname(quarantine),
          fsContext("quarantine-evidence", transaction.journal.phase, index),
        ),
      )
      await syncDirectory(dirname(target), fsContext("target", transaction.journal.phase, index))
    } else {
      if (entry.backup === null) throw uncertain()
      await atomicReplace(
        transaction,
        index,
        entry.backup,
        entry.beforeHash,
        current,
        options,
        true,
      )
    }
  }
  if (!(await verifyState(transaction, "before"))) throw uncertain()
  for (const directoryName of ["quarantine", "installed"] as const) {
    const directory = resolve(transaction.directory, directoryName)
    for (const name of await readdir(directory)) {
      if (!/^\d{8}\.bin$/.test(name)) throw uncertain()
      const index = Number(name.slice(0, 8))
      const entry = transaction.journal.entries[index]
      if (entry === undefined) throw uncertain()
      const candidates =
        directoryName === "installed" ? [entry.afterHash] : [entry.beforeHash, entry.afterHash]
      let authenticated = false
      const artifact = await lstat(resolve(directory, name), { bigint: true })
      if (!artifact.isFile() || artifact.isSymbolicLink()) throw uncertain()
      if (
        directoryName === "installed" &&
        transaction.journal.phase === "prepared" &&
        matchesFileIdentity(artifact, entry.installIdentity)
      )
        authenticated = true
      for (const digest of candidates) {
        if (authenticated) break
        if (digest === null) continue
        try {
          await readEvidenceFile(transaction.directory, `${directoryName}/${name}`, digest, {
            pathRole: directoryName === "installed" ? "installed-evidence" : "quarantine-evidence",
            fileIndex: index,
            transactionPhase: transaction.journal.phase,
          })
          authenticated =
            directoryName === "installed"
              ? transaction.journal.phase === "prepared" &&
                (entry.installIdentity === null ||
                  matchesFileIdentity(artifact, entry.installIdentity))
              : matchesJournalEvidenceIdentity(artifact, entry, digest)
          if (authenticated) break
        } catch {
          // Try the other authenticated state hash.
        }
      }
      if (!authenticated) throw uncertain()
      await unlinkAuthenticated(resolve(directory, name), authenticatedFileIdentity(artifact), {
        pathRole: directoryName === "installed" ? "installed-evidence" : "quarantine-evidence",
        fileIndex: index,
        transactionPhase: transaction.journal.phase,
      })
      forgetOwnedEntry(transaction, `${directoryName}/${name}`)
    }
    await syncDirectory(
      directory,
      fsContext(
        directoryName === "installed" ? "installed-evidence" : "quarantine-evidence",
        transaction.journal.phase,
      ),
    )
  }
}

type CleanupEntry = CleanupIntent["entries"][number]

function cleanupIdentity(
  details: Pick<BigIntStats, "dev" | "ino">,
): Pick<CleanupEntry, "dev" | "ino"> {
  return { dev: details.dev.toString(), ino: details.ino.toString() }
}

async function captureCleanupIntent(
  transaction: PreparedTransaction,
  allowPartialEvidence: boolean,
  ignoredTemporaryName: string,
  markerIdentity: Pick<BigIntStats, "dev" | "ino">,
): Promise<CleanupIntent> {
  const rootDetails = await lstat(transaction.directory, { bigint: true })
  if (
    !rootDetails.isDirectory() ||
    rootDetails.isSymbolicLink() ||
    !sameDirectoryIdentity(directoryIdentity(rootDetails), transaction.directoryIdentity) ||
    !pathsEqual(await realpath(transaction.directory), transaction.directory)
  )
    throw uncertain()
  const entries: CleanupEntry[] = []
  const expectedByDirectory = new Map<string, Set<string>>([
    ["backups", new Set()],
    ["staged", new Set()],
    ["quarantine", new Set()],
    ["installed", new Set()],
  ])
  for (const entry of transaction.journal.entries) {
    if (entry.backup !== null) expectedByDirectory.get("backups")!.add(basename(entry.backup))
    if (entry.staged !== null) {
      expectedByDirectory.get("staged")!.add(basename(entry.staged))
      if (transaction.journal.phase === "prepared")
        expectedByDirectory.get("installed")!.add(basename(entry.staged))
    }
  }
  for (const [directoryName, expectedNames] of expectedByDirectory) {
    const directory = resolve(transaction.directory, directoryName)
    const details = await lstat(directory, { bigint: true })
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      !pathsEqual(await realpath(directory), directory)
    )
      throw uncertain()
    const ownedDirectory = transaction.ownedEntries.get(directoryName)
    if (
      ownedDirectory === undefined ||
      ownedDirectory.dev !== details.dev ||
      ownedDirectory.ino !== details.ino
    )
      throw uncertain()
    const actualNames = new Set(await readdir(directory))
    if (
      (!allowPartialEvidence && actualNames.size !== expectedNames.size) ||
      [...actualNames].some((name) => !expectedNames.has(name))
    )
      throw uncertain()
    entries.push({ path: directoryName, type: "directory", ...cleanupIdentity(details) })
    for (const name of [...actualNames].sort()) {
      const path = resolve(directory, name)
      const child = await lstat(path, { bigint: true })
      if (!child.isFile() || child.isSymbolicLink() || !pathsEqual(await realpath(path), path))
        throw uncertain()
      const relativePath = `${directoryName}/${name}`
      const owned = transaction.ownedEntries.get(relativePath)
      if (owned === undefined || owned.dev !== child.dev || owned.ino !== child.ino)
        throw uncertain()
      entries.push({
        path: relativePath,
        type: "file",
        ...cleanupIdentity(child),
      })
    }
  }
  const topNames = await readdir(transaction.directory)
  const expectedTop = new Set(["backups", "staged", "quarantine", "installed"])
  for (const name of topNames) {
    if (expectedTop.has(name)) continue
    if (name === ignoredTemporaryName) {
      expectedTop.add(name)
      continue
    }
    if (
      !JOURNAL_PATTERN.test(name) &&
      !JOURNAL_TEMP_PATTERN.test(name) &&
      !CLEANUP_TEMP_PATTERN.test(name) &&
      name !== "ownership.json" &&
      name !== "bootstrap.json"
    )
      throw uncertain()
    const path = resolve(transaction.directory, name)
    const child = await lstat(path, { bigint: true })
    if (!child.isFile() || child.isSymbolicLink() || !pathsEqual(await realpath(path), path))
      throw uncertain()
    const owned = transaction.ownedEntries.get(name)
    if (owned === undefined || owned.dev !== child.dev || owned.ino !== child.ino) throw uncertain()
    entries.push({ path: name, type: "file", ...cleanupIdentity(child) })
    expectedTop.add(name)
  }
  if (topNames.length !== expectedTop.size) throw uncertain()
  entries.sort((left, right) => compareOrdinal(left.path, right.path))
  return {
    version: 1,
    id: transaction.journal.id,
    revision: transaction.journal.revision,
    root: cleanupIdentity(rootDetails),
    marker: cleanupIdentity(markerIdentity),
    markerAlias: ignoredTemporaryName,
    entries,
  }
}

function sameCleanupIdentity(details: BigIntStats, entry: CleanupEntry): boolean {
  return details.dev.toString() === entry.dev && details.ino.toString() === entry.ino
}

async function preflightAuthorizedTree(
  directory: string,
  intent: CleanupIntent,
  key: Buffer,
  allowStarted = false,
): Promise<Pick<BigIntStats, "dev" | "ino">> {
  const children = new Map<string, Set<string>>()
  children.set("", new Set(allowStarted ? ["cleanup.json", "cleanup.started"] : ["cleanup.json"]))
  for (const entry of intent.entries) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ""
    const name = entry.path.slice(parent.length === 0 ? 0 : parent.length + 1)
    const expected = children.get(parent) ?? new Set<string>()
    expected.add(name)
    children.set(parent, expected)
    if (entry.type === "directory" && !children.has(entry.path)) children.set(entry.path, new Set())
  }
  for (const [parent, expected] of children) {
    const path = parent === "" ? directory : resolve(directory, ...parent.split("/"))
    const actual = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const wanted = [...expected].sort()
    if (actual.some((name) => !wanted.includes(name))) throw uncertain()
  }
  for (const entry of intent.entries) {
    const path = resolve(directory, ...entry.path.split("/"))
    const details = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (details === undefined) continue
    if (
      details.isSymbolicLink() ||
      !sameCleanupIdentity(details, entry) ||
      (entry.type === "file" ? !details.isFile() : !details.isDirectory()) ||
      !pathsEqual(await realpath(path), path)
    )
      throw uncertain()
  }
  const marker = resolve(directory, "cleanup.json")
  const { value: envelope, details: markerDetails } = await readStableJsonFile(
    marker,
    fsContext("cleanup-marker", "cleanup"),
  )
  if (
    markerDetails.dev.toString() !== intent.marker.dev ||
    markerDetails.ino.toString() !== intent.marker.ino ||
    !pathsEqual(await realpath(marker), marker)
  )
    throw uncertain()
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["cleanup", "authentication"]) ||
    typeof envelope.authentication !== "string"
  )
    throw uncertain()
  const cleanup = validateCleanupIntent(envelope.cleanup, intent.id)
  const expectedMac = authenticateCleanup(key, intent)
  if (
    !sameMac(envelope.authentication, authenticateCleanup(key, cleanup)) ||
    !sameMac(envelope.authentication, expectedMac)
  )
    throw uncertain()
  return markerDetails
}

async function readCleanupRootClaim(
  path: string,
  key: Buffer,
  expectedId: string,
): Promise<CleanupRootClaim> {
  const { value: envelope, details } = await readStableJsonFile(
    path,
    fsContext("cleanup-claim", "cleanup"),
  )
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["claim", "authentication"]) ||
    typeof envelope.authentication !== "string"
  )
    throw uncertain()
  const claim = validateCleanupRootClaim(envelope.claim, expectedId)
  if (
    !sameMac(envelope.authentication, authenticateCleanupRootClaim(key, claim)) ||
    !matchesFileIdentity(details, claim.marker)
  )
    throw uncertain()
  return claim
}

async function assertCleanupRootClaim(
  path: string,
  key: Buffer,
  expected: CleanupRootClaim,
): Promise<void> {
  const { value: envelope, details } = await readStableJsonFile(
    path,
    fsContext("cleanup-claim", "cleanup"),
  )
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["claim", "authentication"]) ||
    typeof envelope.authentication !== "string" ||
    !matchesFileIdentity(details, expected.marker) ||
    JSON.stringify(envelope.claim) !== JSON.stringify(expected) ||
    !sameMac(envelope.authentication, authenticateCleanupRootClaim(key, expected))
  )
    throw uncertain()
}

async function createCleanupRootClaim(
  directory: string,
  cleanup: CleanupIntent,
  key: Buffer,
): Promise<{ readonly path: string; readonly claim: CleanupRootClaim }> {
  const parent = dirname(directory)
  const path = resolve(parent, `.cleanup-root-${cleanup.id}-${randomUUID()}.claim`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await fsInstruction("cleanup-root-claim-open", () =>
      open(path, "wx", 0o600, { pathRole: "cleanup-claim", transactionPhase: "cleanup" }),
    )
    const claim: CleanupRootClaim = {
      version: 1,
      id: cleanup.id,
      rootName: basename(directory),
      phase: "started",
      cleanup,
      marker: authenticatedFileIdentity(await handle.stat({ bigint: true })),
    }
    const envelope: CleanupRootClaimEnvelope = {
      claim,
      authentication: authenticateCleanupRootClaim(key, claim),
    }
    await fsInstruction("cleanup-root-claim-write", () =>
      writeHandle(handle!, JSON.stringify(envelope)),
    )
    await fsInstruction("cleanup-root-claim-fsync", () => syncHandle(handle!))
  } finally {
    await handle?.close().catch(() => undefined)
  }
  await syncDirectory(parent, fsContext("cleanup-claim", "cleanup"))
  const claim = await readCleanupRootClaim(path, key, cleanup.id)
  return { path, claim }
}

async function removeAuthorizedTree(
  directory: string,
  intent: CleanupIntent,
  key: Buffer,
  rootClaim?: { readonly path: string; readonly claim: CleanupRootClaim },
): Promise<void> {
  const authenticateClaim =
    rootClaim === undefined
      ? undefined
      : () => assertCleanupRootClaim(rootClaim.path, key, rootClaim.claim)
  const root = await lstat(directory, { bigint: true }).catch(() => undefined)
  if (root === undefined) return
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.dev.toString() !== intent.root.dev ||
    root.ino.toString() !== intent.root.ino ||
    !pathsEqual(await realpath(directory), directory)
  )
    throw uncertain()
  const rootNames = await readdir(directory)
  if (rootNames.length === 0) {
    if (rootClaim === undefined) throw uncertain()
    await fsInstruction("cleanup-rmdir", () =>
      rmdirAuthenticated(
        directory,
        authenticatedDirectoryIdentity(root),
        { pathRole: "cleanup-root", transactionPhase: "cleanup" },
        authenticateClaim,
      ),
    )
    await syncDirectory(dirname(directory), fsContext("cleanup-root", "cleanup"))
    return
  }
  const markerLinks = rootNames.filter((name) => CLEANUP_TEMP_PATTERN.test(name))
  if (markerLinks.length > 1) throw uncertain()
  for (const name of markerLinks) {
    if (name !== intent.markerAlias) throw uncertain()
    const path = resolve(directory, name)
    const details = await lstat(path, { bigint: true })
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.dev.toString() !== intent.marker.dev ||
      details.ino.toString() !== intent.marker.ino
    )
      throw uncertain()
    await fsInstruction("cleanup-marker-unlink", () =>
      unlinkAuthenticated(
        path,
        { dev: intent.marker.dev, ino: intent.marker.ino },
        { pathRole: "cleanup-marker", transactionPhase: "cleanup" },
        authenticateClaim,
      ),
    )
  }
  if (markerLinks.length > 0) await syncDirectory(directory, fsContext("cleanup-marker", "cleanup"))
  const started = resolve(directory, "cleanup.started")
  const startedDetails = await lstat(started, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw uncertain()
    },
  )
  if (startedDetails !== undefined) {
    if (
      !startedDetails.isFile() ||
      startedDetails.isSymbolicLink() ||
      startedDetails.dev.toString() !== intent.marker.dev ||
      startedDetails.ino.toString() !== intent.marker.ino
    )
      throw uncertain()
  }
  const markerIdentity = await preflightAuthorizedTree(
    directory,
    intent,
    key,
    startedDetails !== undefined,
  )
  const files = intent.entries.filter((entry) => entry.type === "file")
  const directories = intent.entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.length - left.path.length)
  for (const entry of files) {
    const path = resolve(directory, ...entry.path.split("/"))
    const details = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw uncertain()
    })
    if (details === undefined) continue
    if (!details.isFile() || details.isSymbolicLink() || !sameCleanupIdentity(details, entry))
      throw uncertain()
    await fsInstruction("cleanup-unlink", () =>
      unlinkAuthenticated(
        path,
        authenticatedDirectoryIdentity(details),
        { pathRole: "cleanup-entry", transactionPhase: "cleanup" },
        authenticateClaim,
      ),
    )
  }
  for (const entry of directories) {
    const path = resolve(directory, ...entry.path.split("/"))
    const details = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw uncertain()
    })
    if (details === undefined) continue
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      !sameCleanupIdentity(details, entry) ||
      (await readdir(path)).length !== 0
    )
      throw uncertain()
    await fsInstruction("cleanup-rmdir", () =>
      rmdirAuthenticated(
        path,
        authenticatedDirectoryIdentity(details),
        { pathRole: "cleanup-child", transactionPhase: "cleanup" },
        authenticateClaim,
      ),
    )
  }
  const remaining = await readdir(directory)
  if (remaining.some((name) => name !== "cleanup.json" && name !== "cleanup.started"))
    throw uncertain()
  if (remaining.includes("cleanup.started")) {
    await unlinkAuthenticated(
      started,
      { dev: intent.marker.dev, ino: intent.marker.ino },
      { pathRole: "cleanup-marker", transactionPhase: "cleanup" },
      authenticateClaim,
    )
    await syncDirectory(directory, fsContext("cleanup-marker", "cleanup"))
  }
  const marker = resolve(directory, "cleanup.json")
  if (remaining.includes("cleanup.json")) {
    const currentMarker = await lstat(marker, { bigint: true })
    if (
      !currentMarker.isFile() ||
      currentMarker.isSymbolicLink() ||
      currentMarker.dev !== markerIdentity.dev ||
      currentMarker.ino !== markerIdentity.ino
    )
      throw uncertain()
    await fsInstruction("cleanup-unlink", () =>
      unlinkAuthenticated(
        marker,
        authenticatedFileIdentity(markerIdentity),
        { pathRole: "cleanup-marker", transactionPhase: "cleanup" },
        authenticateClaim,
      ),
    )
  }
  await fsInstruction("cleanup-rmdir", () =>
    rmdirAuthenticated(
      directory,
      authenticatedDirectoryIdentity(root),
      { pathRole: "cleanup-root", transactionPhase: "cleanup" },
      authenticateClaim,
    ),
  )
  await syncDirectory(dirname(directory), fsContext("cleanup-root", "cleanup"))
}

async function finishCleanupRootClaim(
  directory: string,
  key: Buffer,
  rootClaim: { readonly path: string; readonly claim: CleanupRootClaim },
): Promise<void> {
  const details = await lstat(directory, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw uncertain()
  })
  if (details !== undefined) {
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.dev.toString() !== rootClaim.claim.cleanup.root.dev ||
      details.ino.toString() !== rootClaim.claim.cleanup.root.ino ||
      !pathsEqual(await realpath(directory), directory)
    )
      throw uncertain()
    await removeAuthorizedTree(directory, rootClaim.claim.cleanup, key, rootClaim)
  }
  await syncDirectory(dirname(directory), fsContext("cleanup-root", "cleanup"))
  await fsInstruction("cleanup-root-claim-unlink", () =>
    unlinkAuthenticated(rootClaim.path, rootClaim.claim.marker, {
      pathRole: "cleanup-claim",
      transactionPhase: "cleanup",
    }),
  )
  await syncDirectory(dirname(directory), fsContext("cleanup-claim", "cleanup"))
}

async function recoverCleanupRootClaims(root: string, key: Buffer): Promise<void> {
  for (const name of (await readdir(root)).sort()) {
    if (!name.startsWith(".cleanup-root-")) continue
    const match = CLEANUP_ROOT_CLAIM_PATTERN.exec(name)
    if (match === null || !ID_PATTERN.test(match[1]!)) throw uncertain()
    const path = resolve(root, name)
    const claim = await readCleanupRootClaim(path, key, match[1]!)
    const directory = resolve(root, claim.rootName)
    if (!inside(root, directory) || dirname(directory) !== root) throw uncertain()
    await finishCleanupRootClaim(directory, key, { path, claim })
  }
}

async function cleanupTransaction(transaction: PreparedTransaction): Promise<void> {
  let cleanup = transaction.cleanupIntent
  if (!transaction.cleanupAuthorized || cleanup === undefined) {
    const hasJournal = (await readdir(transaction.directory)).some((name) =>
      JOURNAL_PATTERN.test(name),
    )
    if (!hasJournal) {
      if (transaction.preconditions === undefined) throw uncertain()
      await revalidatePreconditions(transaction.workspace, transaction.preconditions)
    }
    const temporary = resolve(transaction.directory, `.cleanup.${randomUUID()}.tmp`)
    const destination = resolve(transaction.directory, "cleanup.json")
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let simulatedCrash = false
    let temporaryIdentity: AuthenticatedFileIdentity | undefined
    try {
      handle = await fsInstruction("cleanup-marker-open", () =>
        open(temporary, "wx", 0o600, {
          pathRole: "cleanup-marker",
          transactionPhase: "cleanup",
        }),
      )
      const markerDetails = await handle.stat({ bigint: true })
      temporaryIdentity = authenticatedFileIdentity(markerDetails)
      cleanup = await captureCleanupIntent(
        transaction,
        !hasJournal || transaction.journal.phase === "prepared",
        basename(temporary),
        markerDetails,
      )
      const envelope: CleanupEnvelope = {
        cleanup,
        authentication: authenticateCleanup(transaction.key, cleanup),
      }
      await fsInstruction("cleanup-marker-write", () =>
        writeHandle(handle!, JSON.stringify(envelope)),
      )
      await fsInstruction("cleanup-marker-fsync", () => syncHandle(handle!))
      await handle.close()
      handle = undefined
      await fsInstruction("cleanup-marker-link", () =>
        link(
          temporary,
          destination,
          { pathRole: "cleanup-marker", transactionPhase: "cleanup" },
          temporaryIdentity,
        ),
      )
      await fsInstruction("cleanup-marker-unlink", () =>
        unlinkAuthenticated(temporary, temporaryIdentity!, {
          pathRole: "cleanup-marker",
          transactionPhase: "cleanup",
        }),
      )
      await syncDirectory(transaction.directory, fsContext("cleanup-marker", "cleanup"))
      transaction.cleanupAuthorized = true
      transaction.cleanupIntent = cleanup
    } catch (error) {
      if (isSimulationCrash(error)) {
        simulatedCrash = true
        throw error
      }
      throw uncertain()
    } finally {
      await handle?.close().catch(() => undefined)
      if (!simulatedCrash) {
        const current = await lstat(temporary, { bigint: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw uncertain()
          },
        )
        if (current !== undefined) {
          if (!matchesFileIdentity(current, temporaryIdentity ?? null)) throw uncertain()
          await unlinkAuthenticated(temporary, temporaryIdentity!, {
            pathRole: "cleanup-marker",
            transactionPhase: "cleanup",
          })
          await syncDirectory(transaction.directory, fsContext("cleanup-marker", "cleanup"))
        }
      }
    }
  }
  // The final ownership claim lives beside the directory so it survives the empty-root and
  // post-rmdir crash windows. Every destructive operation reauthenticates it in-port.
  const rootClaim = await fsInstruction("cleanup-rename", () =>
    createCleanupRootClaim(transaction.directory, cleanup!, transaction.key),
  )
  await finishCleanupRootClaim(transaction.directory, transaction.key, rootClaim)
}

async function cleanupTombstones(
  root: string,
  _workspace: string,
  key: Buffer,
  activeIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const name of (await readdir(root)).sort()) {
    const match = CLEANUP_DIRECTORY_PATTERN.exec(name)
    if (match === null) continue
    const base = match[1]!
    const expectedId = ID_PATTERN.test(base) ? base : undefined
    if (expectedId !== undefined && activeIds.has(expectedId)) throw uncertain()
    const directory = resolve(root, name)
    const marker = resolve(directory, "cleanup.json")
    const { value: envelope } = await readStableJsonFile(
      marker,
      fsContext("cleanup-marker", "cleanup"),
    )
    if (
      !record(envelope) ||
      !exactKeys(envelope, ["cleanup", "authentication"]) ||
      !record(envelope.cleanup) ||
      typeof envelope.authentication !== "string"
    )
      throw uncertain()
    const cleanup = validateCleanupIntent(envelope.cleanup, expectedId)
    if (!sameMac(envelope.authentication, authenticateCleanup(key, cleanup))) throw uncertain()
    await removeAuthorizedTree(directory, cleanup, key)
  }
}

async function resumeInPlaceCleanupClaim(
  directory: string,
  key: Buffer,
  expectedId?: string,
): Promise<"none" | "prepared" | "started"> {
  const marker = resolve(directory, "cleanup.json")
  try {
    await lstat(marker)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none"
    throw error
  }
  const { value: envelope } = await readStableJsonFile(
    marker,
    fsContext("cleanup-marker", "cleanup"),
  )
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["cleanup", "authentication"]) ||
    typeof envelope.authentication !== "string"
  )
    throw uncertain()
  const cleanup = validateCleanupIntent(envelope.cleanup, expectedId)
  if (!sameMac(envelope.authentication, authenticateCleanup(key, cleanup))) throw uncertain()
  const rootClaim = await createCleanupRootClaim(directory, cleanup, key)
  await finishCleanupRootClaim(directory, key, rootClaim)
  return "prepared"
}

async function resumeHistoryCleanupClaims(root: string, key: Buffer): Promise<void> {
  await recoverCleanupRootClaims(root, key)
  for (const name of await readdir(root)) {
    const match = /^\.(?:candidate|previous)-([a-f0-9-]{36})$/i.exec(name)
    if (name !== "current" && (match === null || !ID_PATTERN.test(match[1]!))) continue
    await resumeInPlaceCleanupClaim(resolve(root, name), key, match?.[1])
  }
}

async function readAuthenticatedOwnershipMarker(
  path: string,
  key: Buffer,
  id: string,
  revision: number,
  context: FileSystemOperationContext,
): Promise<CloneOwnershipIntent> {
  const { value: envelope, details } = await readStableJsonFile(path, context)
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["ownership", "authentication"]) ||
    typeof envelope.authentication !== "string"
  )
    throw uncertain()
  const ownership = validateCloneOwnership(envelope.ownership, id, revision)
  if (
    !sameMac(envelope.authentication, authenticateCloneOwnership(key, ownership)) ||
    !matchesFileIdentity(details, ownership.marker)
  )
    throw uncertain()
  return ownership
}

async function writeOwnershipMarker(
  transaction: PreparedTransaction,
  destination: string,
  name: "bootstrap.json" | "ownership.json",
  revision: number,
  authenticate?: () => Promise<void>,
): Promise<CloneOwnershipIntent> {
  const path = resolve(destination, name)
  const handle = await open(
    path,
    "wx",
    0o600,
    {
      pathRole: name === "bootstrap.json" ? "bootstrap-marker" : "history-ownership",
      transactionPhase: name === "bootstrap.json" ? "bootstrap" : transaction.journal.phase,
    },
    authenticate,
  )
  let ownership: CloneOwnershipIntent
  try {
    const marker = authenticatedFileIdentity(await handle.stat({ bigint: true }))
    ownership = {
      version: 1,
      id: transaction.journal.id,
      revision,
      root: authenticatedDirectoryIdentity(await lstat(destination, { bigint: true })),
      evidence: Object.fromEntries(
        await Promise.all(
          (["backups", "staged", "quarantine", "installed"] as const).map(async (directoryName) => [
            directoryName,
            authenticatedDirectoryIdentity(
              await lstat(resolve(destination, directoryName), { bigint: true }),
            ),
          ]),
        ),
      ) as JournalOwnership["evidence"],
      marker,
    }
    const envelope: CloneOwnershipEnvelope = {
      ownership,
      authentication: authenticateCloneOwnership(transaction.key, ownership),
    }
    await writeHandle(handle, JSON.stringify(envelope))
    await syncHandle(handle)
  } finally {
    await handle.close().catch(() => undefined)
  }
  await syncDirectory(
    destination,
    fsContext(
      name === "bootstrap.json" ? "bootstrap-marker" : "history-ownership",
      name === "bootstrap.json" ? "bootstrap" : transaction.journal.phase,
    ),
  )
  return ownership
}

async function writeCloneOwnership(
  transaction: PreparedTransaction,
  destination: string,
  authenticate: () => Promise<void>,
): Promise<CloneOwnershipIntent> {
  return writeOwnershipMarker(
    transaction,
    destination,
    "ownership.json",
    transaction.journal.revision,
    authenticate,
  )
}

function historyClaimDestination(
  transaction: PreparedTransaction,
  destination: string,
): "candidate" | "current" {
  const name = basename(destination)
  if (name === "current") return "current"
  if (name === `.candidate-${transaction.journal.id}`) return "candidate"
  throw uncertain()
}

function historyClaimPath(transaction: PreparedTransaction, destination: string): string {
  const destinationKind = historyClaimDestination(transaction, destination)
  return resolve(
    dirname(destination),
    `.history-copy-${transaction.journal.id}-${destinationKind}.claim`,
  )
}

async function readHistoryCopyClaim(
  transaction: PreparedTransaction,
  destination: string,
): Promise<{ readonly path: string; readonly claim: HistoryCopyClaim }> {
  const path = historyClaimPath(transaction, destination)
  const destinationKind = historyClaimDestination(transaction, destination)
  const { value: envelope, details } = await readStableJsonFile(
    path,
    fsContext("history-claim", transaction.journal.phase),
  )
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["claim", "authentication"]) ||
    typeof envelope.authentication !== "string"
  )
    throw uncertain()
  const claim = validateHistoryCopyClaim(
    envelope.claim,
    transaction.journal.id,
    transaction.journal.revision,
    destinationKind,
  )
  if (
    !sameMac(envelope.authentication, authenticateHistoryCopyClaim(transaction.key, claim)) ||
    !matchesFileIdentity(details, claim.marker) ||
    !matchesDirectoryOwnership(await lstat(transaction.directory, { bigint: true }), claim.source)
  )
    throw uncertain()
  return { path, claim }
}

async function prepareHistoryCopyClaim(
  transaction: PreparedTransaction,
  destination: string,
): Promise<{ readonly path: string; readonly claim: HistoryCopyClaim }> {
  const path = historyClaimPath(transaction, destination)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await fsInstruction("history-claim-open", () =>
      open(path, "wx", 0o600, {
        pathRole: "history-claim",
        transactionPhase: transaction.journal.phase,
      }),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain()
    return readHistoryCopyClaim(transaction, destination)
  }
  try {
    const claim: HistoryCopyClaim = {
      version: 1,
      id: transaction.journal.id,
      revision: transaction.journal.revision,
      source: authenticatedDirectoryIdentity(await lstat(transaction.directory, { bigint: true })),
      destination: historyClaimDestination(transaction, destination),
      marker: authenticatedFileIdentity(await handle.stat({ bigint: true })),
    }
    const envelope: HistoryCopyClaimEnvelope = {
      claim,
      authentication: authenticateHistoryCopyClaim(transaction.key, claim),
    }
    await fsInstruction("history-claim-write", () => writeHandle(handle!, JSON.stringify(envelope)))
    await fsInstruction("history-claim-fsync", () => syncHandle(handle!))
  } finally {
    await handle.close().catch(() => undefined)
  }
  await syncDirectory(dirname(destination), fsContext("history-claim", transaction.journal.phase))
  return readHistoryCopyClaim(transaction, destination)
}

async function assertHistoryCopyClaim(
  transaction: PreparedTransaction,
  destination: string,
  expected: HistoryCopyClaim,
): Promise<void> {
  const current = await readHistoryCopyClaim(transaction, destination)
  if (JSON.stringify(current.claim) !== JSON.stringify(expected)) throw uncertain()
}

async function consumeHistoryCopyClaim(path: string, claim: HistoryCopyClaim): Promise<void> {
  await fsInstruction("history-claim-unlink", () =>
    unlinkAuthenticated(path, claim.marker, {
      pathRole: "history-claim",
      transactionPhase: "cleanup",
    }),
  )
  await syncDirectory(dirname(path), fsContext("history-claim", "cleanup"))
}

async function cloneForHistory(
  transaction: PreparedTransaction,
  destination: string,
): Promise<PreparedTransaction> {
  const copyClaim = await prepareHistoryCopyClaim(transaction, destination)
  let created = false
  let ownership: CloneOwnershipIntent
  try {
    await fsInstruction("history-directory-mkdir", () =>
      mkdir(
        destination,
        { mode: 0o700 },
        { pathRole: "history-directory", transactionPhase: transaction.journal.phase },
        () => assertHistoryCopyClaim(transaction, destination, copyClaim.claim),
      ),
    )
    created = true
  } catch (error) {
    if (isSimulationCrash(error)) throw error
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain()
  }
  if (created) {
    for (const name of ["staged", "backups", "quarantine", "installed"]) {
      const path = resolve(destination, name)
      await fsInstruction("history-directory-mkdir", () =>
        mkdir(
          path,
          { mode: 0o700 },
          { pathRole: "history-directory", transactionPhase: transaction.journal.phase },
          () => assertHistoryCopyClaim(transaction, destination, copyClaim.claim),
        ),
      ).catch((error) => {
        if (isSimulationCrash(error)) throw error
        throw uncertain()
      })
    }
    await Promise.all([
      syncDirectory(
        resolve(destination, "staged"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
      syncDirectory(
        resolve(destination, "backups"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
      syncDirectory(
        resolve(destination, "quarantine"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
      syncDirectory(
        resolve(destination, "installed"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
    ])
    await syncDirectory(destination, fsContext("history-directory", transaction.journal.phase))
    ownership = await writeCloneOwnership(transaction, destination, () =>
      assertHistoryCopyClaim(transaction, destination, copyClaim.claim),
    )
    await syncDirectory(
      dirname(destination),
      fsContext("history-directory", transaction.journal.phase),
    )
  } else {
    try {
      ownership = await readAuthenticatedOwnershipMarker(
        resolve(destination, "ownership.json"),
        transaction.key,
        transaction.journal.id,
        transaction.journal.revision,
        fsContext("history-ownership", transaction.journal.phase),
      )
      const rootDetails = await lstat(destination, { bigint: true })
      if (!matchesDirectoryOwnership(rootDetails, ownership.root)) throw uncertain()
      for (const name of ["staged", "backups", "quarantine", "installed"] as const) {
        const path = resolve(destination, name)
        const details = await lstat(path, { bigint: true })
        if (
          !details.isDirectory() ||
          details.isSymbolicLink() ||
          !pathsEqual(await realpath(path), path) ||
          !matchesDirectoryOwnership(details, ownership.evidence[name])
        )
          throw uncertain()
      }
    } catch {
      throw uncertain()
    }
  }
  const clone: PreparedTransaction = {
    ...transaction,
    directory: destination,
    directoryIdentity: directoryIdentity(await lstat(destination, { bigint: true })),
    preconditions: undefined,
  }
  try {
    for (const entry of transaction.journal.entries) {
      if (entry.backup !== null && entry.beforeHash !== null) {
        const source = resolve(transaction.directory, entry.backup)
        const target = resolve(destination, entry.backup)
        if (entry.backupIdentity === null) throw uncertain()
        try {
          await fsInstruction("history-copy-link", () =>
            link(
              source,
              target,
              {
                pathRole: "history-evidence",
                fileIndex: transaction.journal.entries.indexOf(entry),
                transactionPhase: transaction.journal.phase,
              },
              entry.backupIdentity!,
              ownership.evidence.backups,
              () => assertHistoryCopyClaim(transaction, destination, copyClaim.claim),
            ),
          )
        } catch (error) {
          if (isSimulationCrash(error)) throw error
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain()
          const [sourceDetails, targetDetails, parentDetails] = await Promise.all([
            lstat(source, { bigint: true }),
            lstat(target, { bigint: true }),
            lstat(dirname(target), { bigint: true }),
          ])
          if (
            !sourceDetails.isFile() ||
            sourceDetails.isSymbolicLink() ||
            !targetDetails.isFile() ||
            targetDetails.isSymbolicLink() ||
            !matchesDirectoryOwnership(parentDetails, ownership.evidence.backups) ||
            sourceDetails.dev !== targetDetails.dev ||
            sourceDetails.ino !== targetDetails.ino
          )
            throw uncertain()
        }
        await readEvidenceFile(destination, entry.backup, entry.beforeHash, {
          pathRole: "history-evidence",
          fileIndex: transaction.journal.entries.indexOf(entry),
          transactionPhase: transaction.journal.phase,
        })
      }
      if (entry.staged !== null && entry.afterHash !== null) {
        const source = resolve(transaction.directory, entry.staged)
        const target = resolve(destination, entry.staged)
        if (entry.stagedIdentity === null) throw uncertain()
        try {
          await fsInstruction("history-copy-link", () =>
            link(
              source,
              target,
              {
                pathRole: "history-evidence",
                fileIndex: transaction.journal.entries.indexOf(entry),
                transactionPhase: transaction.journal.phase,
              },
              entry.stagedIdentity!,
              ownership.evidence.staged,
              () => assertHistoryCopyClaim(transaction, destination, copyClaim.claim),
            ),
          )
        } catch (error) {
          if (isSimulationCrash(error)) throw error
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain()
          const [sourceDetails, targetDetails, parentDetails] = await Promise.all([
            lstat(source, { bigint: true }),
            lstat(target, { bigint: true }),
            lstat(dirname(target), { bigint: true }),
          ])
          if (
            !sourceDetails.isFile() ||
            sourceDetails.isSymbolicLink() ||
            !targetDetails.isFile() ||
            targetDetails.isSymbolicLink() ||
            !matchesDirectoryOwnership(parentDetails, ownership.evidence.staged) ||
            sourceDetails.dev !== targetDetails.dev ||
            sourceDetails.ino !== targetDetails.ino
          )
            throw uncertain()
        }
        await readEvidenceFile(destination, entry.staged, entry.afterHash, {
          pathRole: "history-evidence",
          fileIndex: transaction.journal.entries.indexOf(entry),
          transactionPhase: transaction.journal.phase,
        })
      }
    }
    await Promise.all([
      syncDirectory(
        resolve(destination, "staged"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
      syncDirectory(
        resolve(destination, "backups"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
      syncDirectory(
        resolve(destination, "quarantine"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
      syncDirectory(
        resolve(destination, "installed"),
        fsContext("history-evidence", transaction.journal.phase),
      ),
    ])
    for (let revision = 1; revision <= transaction.journal.revision; revision += 1) {
      const name = `journal.${revision.toString().padStart(8, "0")}.json`
      const source = resolve(transaction.directory, name)
      const target = resolve(destination, name)
      const { value: sourceEnvelope, details: sourceDetails } = await readStableJsonFile(
        source,
        fsContext("history-journal", transaction.journal.phase),
      )
      if (
        !record(sourceEnvelope) ||
        !record(sourceEnvelope.journal) ||
        typeof sourceEnvelope.authentication !== "string"
      )
        throw uncertain()
      const sourceJournal = validateJournal(
        sourceEnvelope.journal,
        transaction.journal.id,
        revision,
      )
      if (
        !sameMac(sourceEnvelope.authentication, authenticate(transaction.key, sourceJournal)) ||
        !matchesFileIdentity(sourceDetails, sourceJournal.ownership.journal)
      )
        throw uncertain()
      try {
        await fsInstruction("history-copy-link", () =>
          link(
            source,
            target,
            { pathRole: "history-journal", transactionPhase: transaction.journal.phase },
            sourceJournal.ownership.journal!,
            ownership.root,
            () => assertHistoryCopyClaim(transaction, destination, copyClaim.claim),
          ),
        )
      } catch (error) {
        if (isSimulationCrash(error)) throw error
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain()
        const [sourceDetails, targetDetails, parentDetails] = await Promise.all([
          lstat(source, { bigint: true }),
          lstat(target, { bigint: true }),
          lstat(dirname(target), { bigint: true }),
        ])
        if (
          !sourceDetails.isFile() ||
          sourceDetails.isSymbolicLink() ||
          !targetDetails.isFile() ||
          targetDetails.isSymbolicLink() ||
          !matchesDirectoryOwnership(parentDetails, ownership.root) ||
          sourceDetails.dev !== targetDetails.dev ||
          sourceDetails.ino !== targetDetails.ino
        )
          throw uncertain()
      }
    }
    await syncDirectory(destination, fsContext("history-directory", transaction.journal.phase))
    const installed = await loadTransaction(
      destination,
      transaction.workspace,
      transaction.key,
      transaction.journal.id,
    )
    await consumeHistoryCopyClaim(copyClaim.path, copyClaim.claim)
    return installed
  } catch (error) {
    if (isSimulationCrash(error)) throw error
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
    throw uncertain()
  }
}

async function promoteHistory(
  transaction: PreparedTransaction,
  options: AppearanceTransactionOptions,
): Promise<void> {
  await invoke(options, { kind: "history-promote" })
  const historyRoot = await ensureSafeDirectory(transaction.workspace, HISTORY_ROOT)
  await cleanupTombstones(historyRoot, transaction.workspace, transaction.key)
  await resumeHistoryCleanupClaims(historyRoot, transaction.key)
  const current = resolve(historyRoot, "current")
  const candidate = resolve(historyRoot, `.candidate-${transaction.journal.id}`)
  const claimKinds = new Set<"candidate" | "current">()
  for (const name of await readdir(historyRoot)) {
    if (!name.endsWith(".claim")) continue
    const match = HISTORY_COPY_CLAIM_PATTERN.exec(name)
    if (match === null || match[1] !== transaction.journal.id) throw uncertain()
    claimKinds.add(match[2] as "candidate" | "current")
  }
  if (claimKinds.has("candidate")) await cloneForHistory(transaction, candidate)
  if (claimKinds.has("current")) {
    const source = await loadTransaction(
      candidate,
      transaction.workspace,
      transaction.key,
      transaction.journal.id,
    )
    await cloneForHistory(source, current)
  }
  let currentHistory: PreparedTransaction | undefined
  try {
    currentHistory = await loadTransaction(current, transaction.workspace, transaction.key)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  if (currentHistory?.journal.id === transaction.journal.id) {
    for (const leftover of [candidate]) {
      try {
        const loaded = await loadTransaction(leftover, transaction.workspace, transaction.key)
        await cleanupTransaction(loaded)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw uncertain()
      }
    }
    await cleanupTransaction(transaction)
    return
  }
  let candidateHistory: PreparedTransaction
  try {
    candidateHistory = await loadTransaction(
      candidate,
      transaction.workspace,
      transaction.key,
      transaction.journal.id,
    )
  } catch {
    candidateHistory = await cloneForHistory(transaction, candidate)
    await syncDirectory(historyRoot, fsContext("history-directory", transaction.journal.phase))
  }

  try {
    if (currentHistory !== undefined) {
      await fsInstruction("history-switch-rename", () => cleanupTransaction(currentHistory!))
      await fsInstruction("history-parent-fsync", () =>
        syncDirectory(historyRoot, fsContext("history-directory", transaction.journal.phase)),
      )
    }
    await fsInstruction("history-switch-rename", () => cloneForHistory(candidateHistory, current))
    await fsInstruction("history-parent-fsync", () =>
      syncDirectory(historyRoot, fsContext("history-directory", transaction.journal.phase)),
    )
    const installedHistory = await loadTransaction(
      current,
      transaction.workspace,
      transaction.key,
      transaction.journal.id,
    )
    await cleanupTransaction(candidateHistory)
    await cleanupTransaction(transaction)
    void installedHistory
  } catch (error) {
    if (isSimulationCrash(error)) throw error
    throw uncertain()
  }
}

async function executeCore(
  workspaceInput: string,
  plan: AppearancePlan,
  verifyBuild: () => Promise<void>,
  options: AppearanceTransactionOptions,
  kind: "apply" | "undo",
  retainHistory: boolean,
  historyId: string | null,
): Promise<AppearanceTransactionReceipt> {
  const workspace = await canonicalWorkspace(workspaceInput)
  let transaction: PreparedTransaction | undefined
  try {
    transaction = await prepare(workspace, plan, options, kind, historyId)
    await publish(transaction, options)
    await advanceJournal(transaction, "published", options)
    await invoke(options, { kind: "verify" })
    await verifyBuild()
    await advanceJournal(transaction, "verified", options)
    if (retainHistory) await promoteHistory(transaction, options)
    // A verified undo remains recoverable until its source history is durably removed.
    return {
      id: transaction.journal.id,
      status: kind === "undo" ? "undone" : "verified",
      canUndo: retainHistory,
    }
  } catch (error) {
    if (isSimulationCrash(error)) throw error
    if (transaction === undefined) {
      if (record(error) && error.code === "APPEARANCE_CONFLICT") throw error
      if (record(error) && error.code === "APPEARANCE_TRANSACTION_FAILED") throw error
      if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
      throw failed()
    }
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
    // Once verification is durable, the new files are the committed state. History promotion is
    // recoverable metadata work; rolling the files back would create journal revisions after a
    // terminal verified revision and could discard a successfully verified appearance.
    if (transaction.journal.phase === "verified") throw uncertain()
    try {
      await rollback(transaction, options)
      await cleanupTransaction(transaction)
    } catch (cleanupError) {
      if (isSimulationCrash(cleanupError)) throw cleanupError
      throw uncertain()
    }
    if (record(error) && error.code === "APPEARANCE_CONFLICT") throw error
    throw failed()
  }
}

export async function executeAppearancePlan(
  workspace: string,
  plan: AppearancePlan,
  verifyBuild: () => Promise<void>,
): Promise<AppearanceTransactionReceipt> {
  return serializeWorkspaceOperation(workspace, (canonical) =>
    executeCore(canonical, plan, verifyBuild, testRuntime()?.options ?? {}, "apply", true, null),
  )
}

function validAuthenticatedFileIdentity(value: unknown): value is AuthenticatedFileIdentity {
  return (
    record(value) &&
    exactKeys(value, ["dev", "ino"]) &&
    typeof value.dev === "string" &&
    validIdentityNumber(value.dev) &&
    typeof value.ino === "string" &&
    validIdentityNumber(value.ino)
  )
}

function validAuthenticatedTempIdentity(value: unknown): value is AuthenticatedTempIdentity {
  return (
    record(value) &&
    exactKeys(value, ["dev", "ino", "ctimeNs", "nlink"]) &&
    typeof value.dev === "string" &&
    validIdentityNumber(value.dev) &&
    typeof value.ino === "string" &&
    validIdentityNumber(value.ino) &&
    typeof value.ctimeNs === "string" &&
    /^\d+$/.test(value.ctimeNs) &&
    typeof value.nlink === "string" &&
    /^\d+$/.test(value.nlink)
  )
}

function validAuthenticatedDirectoryIdentity(
  value: unknown,
): value is AuthenticatedDirectoryIdentity {
  return (
    record(value) &&
    exactKeys(value, ["dev", "ino", "birthtimeNs"]) &&
    typeof value.dev === "string" &&
    validIdentityNumber(value.dev) &&
    typeof value.ino === "string" &&
    validIdentityNumber(value.ino) &&
    typeof value.birthtimeNs === "string" &&
    /^\d+$/.test(value.birthtimeNs)
  )
}

function validJournalOwnership(value: unknown): value is JournalOwnership {
  if (
    !record(value) ||
    !exactKeys(value, ["transaction", "evidence", "journal"]) ||
    !validAuthenticatedDirectoryIdentity(value.transaction) ||
    !validAuthenticatedFileIdentity(value.journal) ||
    !record(value.evidence) ||
    !exactKeys(value.evidence, ["backups", "staged", "quarantine", "installed"])
  )
    return false
  const evidence = value.evidence
  return (["backups", "staged", "quarantine", "installed"] as const).every((name) =>
    validAuthenticatedDirectoryIdentity(evidence[name]),
  )
}

function validateCloneOwnership(
  value: unknown,
  expectedId: string,
  expectedRevision: number,
): CloneOwnershipIntent {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "id", "revision", "root", "evidence", "marker"]) ||
    value.version !== 1 ||
    value.id !== expectedId ||
    value.revision !== expectedRevision ||
    !validAuthenticatedDirectoryIdentity(value.root) ||
    !validAuthenticatedFileIdentity(value.marker) ||
    !record(value.evidence) ||
    !exactKeys(value.evidence, ["backups", "staged", "quarantine", "installed"])
  )
    throw uncertain()
  const evidence = value.evidence
  if (
    !(["backups", "staged", "quarantine", "installed"] as const).every((name) =>
      validAuthenticatedDirectoryIdentity(evidence[name]),
    )
  )
    throw uncertain()
  return value as unknown as CloneOwnershipIntent
}

function validateHistoryCopyClaim(
  value: unknown,
  expectedId: string,
  expectedRevision: number,
  expectedDestination: "candidate" | "current",
): HistoryCopyClaim {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "id", "revision", "source", "destination", "marker"]) ||
    value.version !== 1 ||
    value.id !== expectedId ||
    value.revision !== expectedRevision ||
    value.destination !== expectedDestination ||
    !validAuthenticatedDirectoryIdentity(value.source) ||
    !validAuthenticatedFileIdentity(value.marker)
  )
    throw uncertain()
  return value as unknown as HistoryCopyClaim
}

function validEntry(value: unknown, index: number): value is AppearanceJournalEntry {
  if (
    !record(value) ||
    !exactKeys(value, [
      "path",
      "beforeHash",
      "afterHash",
      "beforeIdentity",
      "afterIdentity",
      "backupIdentity",
      "stagedIdentity",
      "installIdentity",
      "publishTempIdentity",
      "publishTempConsumed",
      "rollbackTempIdentity",
      "rollbackTempConsumed",
      "backup",
      "staged",
    ])
  )
    return false
  const before = value.beforeHash
  const after = value.afterHash
  const identity = value.beforeIdentity
  const installedIdentity = value.afterIdentity
  const backupIdentity = value.backupIdentity
  const stagedIdentity = value.stagedIdentity
  const installIdentity = value.installIdentity
  const publishTempIdentity = value.publishTempIdentity
  const rollbackTempIdentity = value.rollbackTempIdentity
  const slot = index.toString().padStart(8, "0")
  return (
    typeof value.path === "string" &&
    validRelativePath(value.path) &&
    (before === null || (typeof before === "string" && DIGEST_PATTERN.test(before))) &&
    (after === null || (typeof after === "string" && DIGEST_PATTERN.test(after))) &&
    (before === null
      ? identity === null
      : record(identity) &&
        exactKeys(identity, ["dev", "ino"]) &&
        typeof identity.dev === "string" &&
        /^\d+$/.test(identity.dev) &&
        typeof identity.ino === "string" &&
        /^\d+$/.test(identity.ino)) &&
    (installedIdentity === null ||
      (record(installedIdentity) &&
        exactKeys(installedIdentity, ["dev", "ino"]) &&
        typeof installedIdentity.dev === "string" &&
        /^\d+$/.test(installedIdentity.dev) &&
        typeof installedIdentity.ino === "string" &&
        /^\d+$/.test(installedIdentity.ino))) &&
    (backupIdentity === null ||
      (record(backupIdentity) &&
        exactKeys(backupIdentity, ["dev", "ino"]) &&
        typeof backupIdentity.dev === "string" &&
        /^\d+$/.test(backupIdentity.dev) &&
        typeof backupIdentity.ino === "string" &&
        /^\d+$/.test(backupIdentity.ino))) &&
    (stagedIdentity === null ||
      (record(stagedIdentity) &&
        exactKeys(stagedIdentity, ["dev", "ino"]) &&
        typeof stagedIdentity.dev === "string" &&
        /^\d+$/.test(stagedIdentity.dev) &&
        typeof stagedIdentity.ino === "string" &&
        /^\d+$/.test(stagedIdentity.ino))) &&
    (installIdentity === null ||
      (record(installIdentity) &&
        exactKeys(installIdentity, ["dev", "ino"]) &&
        typeof installIdentity.dev === "string" &&
        /^\d+$/.test(installIdentity.dev) &&
        typeof installIdentity.ino === "string" &&
        /^\d+$/.test(installIdentity.ino))) &&
    (publishTempIdentity === null || validAuthenticatedTempIdentity(publishTempIdentity)) &&
    (rollbackTempIdentity === null || validAuthenticatedTempIdentity(rollbackTempIdentity)) &&
    typeof value.publishTempConsumed === "boolean" &&
    typeof value.rollbackTempConsumed === "boolean" &&
    (!value.publishTempConsumed || publishTempIdentity !== null) &&
    (!value.rollbackTempConsumed || rollbackTempIdentity !== null) &&
    value.backup === (before === null ? null : `backups/${slot}.bin`) &&
    value.staged === (after === null ? null : `staged/${slot}.bin`) &&
    (value.backup === null ? backupIdentity === null : true) &&
    (value.staged === null ? stagedIdentity === null : true) &&
    (value.staged === null ? installIdentity === null : true) &&
    (value.staged === null ? publishTempIdentity === null : true) &&
    (before === null ? rollbackTempIdentity === null : true) &&
    !(before === null && after === null)
  )
}

function validateJournal(value: unknown, id: string, revision: number): AppearanceJournal {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "id",
      "phase",
      "entries",
      "revision",
      "kind",
      "baselineHash",
      "historyId",
      "ownership",
    ])
  )
    throw uncertain()
  if (
    value.version !== 1 ||
    value.id !== id ||
    value.revision !== revision ||
    !["prepared", "published", "verified"].includes(String(value.phase)) ||
    !["apply", "undo"].includes(String(value.kind)) ||
    typeof value.baselineHash !== "string" ||
    !DIGEST_PATTERN.test(value.baselineHash) ||
    !validJournalOwnership(value.ownership) ||
    !(
      value.historyId === null ||
      (typeof value.historyId === "string" && ID_PATTERN.test(value.historyId))
    ) ||
    (value.kind === "apply" ? value.historyId !== null : value.historyId === null) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 128 ||
    !value.entries.every(validEntry)
  )
    throw uncertain()
  const paths = value.entries.map((entry) => (entry as AppearanceJournalEntry).path)
  if (
    new Set(paths).size !== paths.length ||
    [...paths].sort(compareOrdinal).some((path, index) => path !== paths[index])
  )
    throw uncertain()
  return value as unknown as AppearanceJournal
}

async function finalizeAuthenticatedJournalTemp(
  directory: string,
  key: Buffer,
  expectedId: string | undefined,
  names: readonly string[],
): Promise<string[]> {
  const temporaryNames = names.filter((name) => JOURNAL_TEMP_PATTERN.test(name))
  if (temporaryNames.length === 0) return [...names]
  const journalNames = names.filter((name) => JOURNAL_PATTERN.test(name))
  if (temporaryNames.length !== 1 || journalNames.length === 0) throw uncertain()
  const temporaryName = temporaryNames[0]!
  const temporaryRevision = Number(JOURNAL_TEMP_PATTERN.exec(temporaryName)![1])
  if (temporaryRevision <= journalNames.length) {
    const temporary = resolve(directory, temporaryName)
    const destination = resolve(
      directory,
      `journal.${temporaryRevision.toString().padStart(8, "0")}.json`,
    )
    const { value: envelope, details } = await readStableJsonFile(
      temporary,
      fsContext("journal-temp", "recovery"),
    )
    if (
      !record(envelope) ||
      !exactKeys(envelope, ["journal", "authentication"]) ||
      typeof envelope.authentication !== "string" ||
      !record(envelope.journal) ||
      typeof envelope.journal.id !== "string"
    )
      throw uncertain()
    const id = expectedId ?? envelope.journal.id
    const journal = validateJournal(envelope.journal, id, temporaryRevision)
    const published = await lstat(destination, { bigint: true })
    if (
      !sameMac(envelope.authentication, authenticate(key, journal)) ||
      !matchesFileIdentity(details, journal.ownership.journal) ||
      !matchesFileIdentity(published, journal.ownership.journal) ||
      details.dev !== published.dev ||
      details.ino !== published.ino
    )
      throw uncertain()
    await unlinkAuthenticated(temporary, journal.ownership.journal!, {
      pathRole: "journal-temp",
      transactionPhase: "recovery",
    })
    await syncDirectory(directory, fsContext("journal", "recovery"))
    return readdir(directory)
  }
  const revision = journalNames.length + 1
  if (temporaryRevision !== revision) throw uncertain()
  const temporary = resolve(directory, temporaryName)
  const { value: envelope, details } = await readStableJsonFile(
    temporary,
    fsContext("journal-temp", "recovery"),
  )
  if (
    !record(envelope) ||
    !exactKeys(envelope, ["journal", "authentication"]) ||
    typeof envelope.authentication !== "string" ||
    !record(envelope.journal) ||
    typeof envelope.journal.id !== "string"
  )
    throw uncertain()
  const id = expectedId ?? envelope.journal.id
  const journal = validateJournal(envelope.journal, id, revision)
  if (
    !sameMac(envelope.authentication, authenticate(key, journal)) ||
    !matchesFileIdentity(details, journal.ownership.journal)
  )
    throw uncertain()
  await publishFileNoClobber(
    temporary,
    resolve(directory, `journal.${revision.toString().padStart(8, "0")}.json`),
    journal.ownership.journal!,
    { pathRole: "journal", transactionPhase: "recovery" },
  )
  await syncDirectory(directory, fsContext("journal", "recovery"))
  return readdir(directory)
}

async function loadTransaction(
  directory: string,
  workspace: string,
  key: Buffer,
  expectedId?: string,
): Promise<PreparedTransaction> {
  if (expectedId !== undefined && !ID_PATTERN.test(expectedId)) throw uncertain()
  const directoryDetails = await lstat(directory, { bigint: true })
  if (
    !directoryDetails.isDirectory() ||
    directoryDetails.isSymbolicLink() ||
    !pathsEqual(await realpath(directory), directory)
  )
    throw uncertain()
  let names = await readdir(directory)
  names = await finalizeAuthenticatedJournalTemp(directory, key, expectedId, names)
  const journalNames = names.filter((name) => JOURNAL_PATTERN.test(name)).sort()
  if (
    journalNames.length === 0 ||
    names.some(
      (name) =>
        name.startsWith("journal.") &&
        !JOURNAL_PATTERN.test(name) &&
        !JOURNAL_TEMP_PATTERN.test(name),
    )
  )
    throw uncertain()
  let latest: AppearanceJournal | undefined
  for (let index = 0; index < journalNames.length; index += 1) {
    const expectedRevision = index + 1
    const name = journalNames[index]!
    if (Number(JOURNAL_PATTERN.exec(name)![1]) !== expectedRevision) throw uncertain()
    const path = resolve(directory, name)
    const { value: envelope, details } = await readStableJsonFile(
      path,
      fsContext("journal", "recovery"),
    )
    if (
      !record(envelope) ||
      !exactKeys(envelope, ["journal", "authentication"]) ||
      typeof envelope.authentication !== "string"
    )
      throw uncertain()
    const candidateId =
      record(envelope.journal) && typeof envelope.journal.id === "string" ? envelope.journal.id : ""
    const id = expectedId ?? candidateId
    if (!ID_PATTERN.test(id)) throw uncertain()
    const journal = validateJournal(envelope.journal, id, expectedRevision)
    if (
      !sameMac(envelope.authentication, authenticate(key, journal)) ||
      !matchesFileIdentity(details, journal.ownership.journal)
    )
      throw uncertain()
    if (
      (latest === undefined && journal.phase !== "prepared") ||
      (latest?.phase === "prepared" && !["prepared", "published"].includes(journal.phase)) ||
      (latest?.phase === "published" && !["published", "verified"].includes(journal.phase)) ||
      latest?.phase === "verified"
    )
      throw uncertain()
    if (
      journal.entries.some((entry) => {
        if (journal.phase === "prepared") return entry.afterIdentity !== null
        return (
          (entry.afterHash === null
            ? entry.afterIdentity !== null
            : entry.afterIdentity === null) ||
          (entry.backup !== null && entry.backupIdentity === null) ||
          (entry.staged !== null && entry.stagedIdentity === null) ||
          (entry.afterHash !== null &&
            (entry.installIdentity === null ||
              entry.publishTempIdentity === null ||
              !entry.publishTempConsumed)) ||
          (journal.phase === "verified" && entry.rollbackTempIdentity !== null)
        )
      })
    )
      throw uncertain()
    if (latest !== undefined) {
      if (
        latest.kind !== journal.kind ||
        latest.baselineHash !== journal.baselineHash ||
        latest.historyId !== journal.historyId ||
        JSON.stringify(latest.ownership.transaction) !==
          JSON.stringify(journal.ownership.transaction) ||
        JSON.stringify(latest.ownership.evidence) !== JSON.stringify(journal.ownership.evidence) ||
        latest.entries.length !== journal.entries.length
      )
        throw uncertain()
      let statePromotions = 0
      for (let entryIndex = 0; entryIndex < latest.entries.length; entryIndex += 1) {
        const previous = latest.entries[entryIndex]!
        const current = journal.entries[entryIndex]!
        if (
          previous.path !== current.path ||
          previous.beforeHash !== current.beforeHash ||
          previous.afterHash !== current.afterHash ||
          JSON.stringify(previous.beforeIdentity) !== JSON.stringify(current.beforeIdentity) ||
          previous.backup !== current.backup ||
          previous.staged !== current.staged ||
          (previous.backupIdentity !== null &&
            JSON.stringify(previous.backupIdentity) !== JSON.stringify(current.backupIdentity)) ||
          (previous.stagedIdentity !== null &&
            JSON.stringify(previous.stagedIdentity) !== JSON.stringify(current.stagedIdentity)) ||
          (previous.installIdentity !== null &&
            JSON.stringify(previous.installIdentity) !== JSON.stringify(current.installIdentity)) ||
          !validTempIdentityTransition(
            previous.publishTempIdentity,
            current.publishTempIdentity,
            previous.publishTempConsumed,
            current.publishTempConsumed,
          ) ||
          !validTempIdentityTransition(
            previous.rollbackTempIdentity,
            current.rollbackTempIdentity,
            previous.rollbackTempConsumed,
            current.rollbackTempConsumed,
          ) ||
          (previous.publishTempConsumed && !current.publishTempConsumed) ||
          (previous.rollbackTempConsumed && !current.rollbackTempConsumed) ||
          (previous.afterIdentity !== null &&
            JSON.stringify(previous.afterIdentity) !== JSON.stringify(current.afterIdentity))
        )
          throw uncertain()
        for (const field of [
          "backupIdentity",
          "stagedIdentity",
          "installIdentity",
          "publishTempIdentity",
          "rollbackTempIdentity",
          "afterIdentity",
        ] as const)
          if (previous[field] === null && current[field] !== null) statePromotions += 1
        for (const field of ["publishTempConsumed", "rollbackTempConsumed"] as const)
          if (!previous[field] && current[field]) statePromotions += 1
      }
      if (
        (latest.phase === journal.phase && statePromotions < 1) ||
        (latest.phase === "prepared" &&
          journal.phase === "published" &&
          statePromotions !== journal.entries.filter((entry) => entry.afterHash !== null).length) ||
        (latest.phase === "published" && journal.phase === "verified" && statePromotions !== 0)
      )
        throw uncertain()
    }
    latest = journal
  }
  if (latest === undefined) throw uncertain()
  let bootstrapOwnership: CloneOwnershipIntent | undefined
  if (names.includes("bootstrap.json")) {
    bootstrapOwnership = await readAuthenticatedOwnershipMarker(
      resolve(directory, "bootstrap.json"),
      key,
      latest.id,
      0,
      fsContext("bootstrap-marker", "recovery"),
    )
    if (
      JSON.stringify(bootstrapOwnership.root) !== JSON.stringify(latest.ownership.transaction) ||
      JSON.stringify(bootstrapOwnership.evidence) !== JSON.stringify(latest.ownership.evidence)
    )
      throw uncertain()
  }
  let cloneOwnership: CloneOwnershipIntent | undefined
  if (names.includes("ownership.json")) {
    cloneOwnership = await readAuthenticatedOwnershipMarker(
      resolve(directory, "ownership.json"),
      key,
      latest.id,
      latest.revision,
      fsContext("history-ownership", latest.phase),
    )
  }
  if (bootstrapOwnership === undefined && cloneOwnership === undefined) throw uncertain()
  if (
    !matchesDirectoryOwnership(directoryDetails, latest.ownership.transaction) &&
    (cloneOwnership === undefined ||
      !matchesDirectoryOwnership(directoryDetails, cloneOwnership.root))
  )
    throw uncertain()
  let cleanupAuthorized = false
  let cleanupIntent: CleanupIntent | undefined
  if (names.includes("cleanup.json")) {
    const path = resolve(directory, "cleanup.json")
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const details = await lstat(path, { bigint: true })
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > MAX_JOURNAL_BYTES ||
        !pathsEqual(await realpath(path), path)
      )
        throw uncertain()
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), undefined, {
        pathRole: "cleanup-marker",
        transactionPhase: "cleanup",
      })
      const opened = await handle.stat({ bigint: true })
      if (
        opened.dev !== details.dev ||
        opened.ino !== details.ino ||
        opened.size !== details.size ||
        opened.mtimeNs !== details.mtimeNs ||
        opened.ctimeNs !== details.ctimeNs
      )
        throw uncertain()
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"))
      const after = await handle.stat({ bigint: true })
      const pathAfter = await lstat(path, { bigint: true })
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs ||
        pathAfter.dev !== opened.dev ||
        pathAfter.ino !== opened.ino ||
        !record(parsed) ||
        !exactKeys(parsed, ["cleanup", "authentication"]) ||
        !record(parsed.cleanup) ||
        typeof parsed.authentication !== "string" ||
        ((cleanupIntent = validateCleanupIntent(parsed.cleanup, latest.id)),
        cleanupIntent.revision !== latest.revision) ||
        !sameMac(parsed.authentication, authenticateCleanup(key, cleanupIntent))
      )
        throw uncertain()
      cleanupAuthorized = true
    } catch (error) {
      if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
      throw uncertain()
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  const expectedTopLevel = new Set([
    "backups",
    "staged",
    "quarantine",
    "installed",
    ...journalNames,
    ...names.filter((name) => CLEANUP_TEMP_PATTERN.test(name)),
    ...(bootstrapOwnership === undefined ? [] : ["bootstrap.json"]),
    ...(cloneOwnership === undefined ? [] : ["ownership.json"]),
    ...(cleanupAuthorized ? ["cleanup.json"] : []),
  ])
  if (names.some((name) => !expectedTopLevel.has(name))) throw uncertain()
  for (const evidenceDirectory of ["backups", "staged"] as const) {
    const evidenceRoot = resolve(directory, evidenceDirectory)
    const evidenceDetails = await lstat(evidenceRoot, { bigint: true })
    if (
      !evidenceDetails.isDirectory() ||
      evidenceDetails.isSymbolicLink() ||
      !pathsEqual(await realpath(evidenceRoot), evidenceRoot) ||
      (!matchesDirectoryOwnership(evidenceDetails, latest.ownership.evidence[evidenceDirectory]) &&
        (cloneOwnership === undefined ||
          !matchesDirectoryOwnership(evidenceDetails, cloneOwnership.evidence[evidenceDirectory])))
    ) {
      throw uncertain()
    }
    const expectedNames = latest.entries
      .map((entry) => entry[evidenceDirectory === "backups" ? "backup" : "staged"])
      .filter((path): path is string => path !== null)
      .map((path) => basename(path))
      .sort()
    const actualNames = (await readdir(evidenceRoot)).sort()
    const partialPrepared = latest.phase === "prepared"
    if (
      (!partialPrepared && expectedNames.length !== actualNames.length) ||
      actualNames.some((name) => !expectedNames.includes(name))
    ) {
      throw uncertain()
    }
  }
  const quarantineRoot = resolve(directory, "quarantine")
  const quarantineDetails = await lstat(quarantineRoot, { bigint: true })
  if (
    !quarantineDetails.isDirectory() ||
    quarantineDetails.isSymbolicLink() ||
    !pathsEqual(await realpath(quarantineRoot), quarantineRoot) ||
    (!matchesDirectoryOwnership(quarantineDetails, latest.ownership.evidence.quarantine) &&
      (cloneOwnership === undefined ||
        !matchesDirectoryOwnership(quarantineDetails, cloneOwnership.evidence.quarantine)))
  )
    throw uncertain()
  for (const name of await readdir(quarantineRoot)) {
    if (!/^\d{8}\.bin$/.test(name)) throw uncertain()
    const index = Number(name.slice(0, 8))
    const entry = latest.entries[index]
    if (entry === undefined) throw uncertain()
    const expected = [entry.beforeHash, entry.afterHash].filter(
      (value): value is string => value !== null,
    )
    let matched = false
    const evidence = await lstat(resolve(quarantineRoot, name), { bigint: true })
    if (!evidence.isFile() || evidence.isSymbolicLink()) throw uncertain()
    for (const digest of expected) {
      try {
        await readEvidenceFile(directory, `quarantine/${name}`, digest, {
          pathRole: "quarantine-evidence",
          fileIndex: index,
          transactionPhase: latest.phase,
        })
        matched = matchesJournalEvidenceIdentity(evidence, entry, digest)
        if (matched) break
      } catch {
        // Try the other authenticated before/after digest before failing closed.
      }
    }
    if (!matched) throw uncertain()
  }
  const installedRoot = resolve(directory, "installed")
  const installedDetails = await lstat(installedRoot, { bigint: true })
  if (
    !installedDetails.isDirectory() ||
    installedDetails.isSymbolicLink() ||
    !pathsEqual(await realpath(installedRoot), installedRoot) ||
    (!matchesDirectoryOwnership(installedDetails, latest.ownership.evidence.installed) &&
      (cloneOwnership === undefined ||
        !matchesDirectoryOwnership(installedDetails, cloneOwnership.evidence.installed)))
  )
    throw uncertain()
  for (const name of await readdir(installedRoot)) {
    if (!/^\d{8}\.bin$/.test(name)) throw uncertain()
    const index = Number(name.slice(0, 8))
    const entry = latest.entries[index]
    if (entry?.afterHash === null || entry?.afterHash === undefined) throw uncertain()
    const evidence = await lstat(resolve(installedRoot, name), { bigint: true })
    if (
      !evidence.isFile() ||
      evidence.isSymbolicLink() ||
      (entry.installIdentity === null
        ? latest.phase !== "prepared"
        : evidence.dev.toString() !== entry.installIdentity.dev ||
          evidence.ino.toString() !== entry.installIdentity.ino)
    )
      throw uncertain()
    try {
      await readEvidenceFile(directory, `installed/${name}`, entry.afterHash, {
        pathRole: "installed-evidence",
        fileIndex: index,
        transactionPhase: latest.phase,
      })
    } catch (error) {
      if (latest.phase !== "prepared") throw error
    }
  }
  for (const entry of latest.entries) {
    if (entry.backup !== null && entry.beforeHash !== null) {
      const exists = await lstat(resolve(directory, entry.backup), { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw uncertain()
        },
      )
      if (exists !== undefined) {
        if (
          entry.backupIdentity === null
            ? latest.phase !== "prepared"
            : exists.dev.toString() !== entry.backupIdentity.dev ||
              exists.ino.toString() !== entry.backupIdentity.ino
        )
          throw uncertain()
        try {
          await readEvidenceFile(directory, entry.backup, entry.beforeHash, {
            pathRole: "backup-evidence",
            fileIndex: latest.entries.indexOf(entry),
            transactionPhase: latest.phase,
          })
        } catch (error) {
          if (latest.phase !== "prepared") throw error
        }
      } else if (latest.phase !== "prepared") throw uncertain()
    }
    if (entry.staged !== null && entry.afterHash !== null) {
      const exists = await lstat(resolve(directory, entry.staged), { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw uncertain()
        },
      )
      if (exists !== undefined) {
        if (
          entry.stagedIdentity === null
            ? latest.phase !== "prepared"
            : exists.dev.toString() !== entry.stagedIdentity.dev ||
              exists.ino.toString() !== entry.stagedIdentity.ino
        )
          throw uncertain()
        try {
          await readEvidenceFile(directory, entry.staged, entry.afterHash, {
            pathRole: "staged-evidence",
            fileIndex: latest.entries.indexOf(entry),
            transactionPhase: latest.phase,
          })
        } catch (error) {
          if (latest.phase !== "prepared") throw error
        }
      } else if (latest.phase !== "prepared") throw uncertain()
    }
  }
  const ownedEntries = new Map<string, { readonly dev: bigint; readonly ino: bigint }>()
  for (const directoryName of ["backups", "staged", "quarantine", "installed"] as const) {
    const directoryPath = resolve(directory, directoryName)
    const directoryStat = await lstat(directoryPath, { bigint: true })
    ownedEntries.set(directoryName, { dev: directoryStat.dev, ino: directoryStat.ino })
    for (const name of await readdir(directoryPath)) {
      const child = await lstat(resolve(directoryPath, name), { bigint: true })
      ownedEntries.set(`${directoryName}/${name}`, { dev: child.dev, ino: child.ino })
    }
  }
  for (const name of journalNames) {
    const child = await lstat(resolve(directory, name), { bigint: true })
    ownedEntries.set(name, { dev: child.dev, ino: child.ino })
  }
  if (cloneOwnership !== undefined) {
    const child = await lstat(resolve(directory, "ownership.json"), { bigint: true })
    ownedEntries.set("ownership.json", { dev: child.dev, ino: child.ino })
  }
  if (bootstrapOwnership !== undefined) {
    const child = await lstat(resolve(directory, "bootstrap.json"), { bigint: true })
    ownedEntries.set("bootstrap.json", { dev: child.dev, ino: child.ino })
  }
  for (const name of names.filter((candidate) => CLEANUP_TEMP_PATTERN.test(candidate))) {
    const path = resolve(directory, name)
    const { value: envelope, details: child } = await readStableJsonFile(
      path,
      fsContext("cleanup-marker", "cleanup"),
    )
    if (
      !record(envelope) ||
      !exactKeys(envelope, ["cleanup", "authentication"]) ||
      typeof envelope.authentication !== "string"
    )
      throw uncertain()
    const intent = validateCleanupIntent(envelope.cleanup, latest.id)
    if (
      intent.revision !== latest.revision ||
      !sameMac(envelope.authentication, authenticateCleanup(key, intent)) ||
      child.dev.toString() !== intent.marker.dev ||
      child.ino.toString() !== intent.marker.ino
    )
      throw uncertain()
    ownedEntries.set(name, { dev: child.dev, ino: child.ino })
  }
  return {
    workspace,
    directory,
    directoryIdentity: directoryIdentity(directoryDetails),
    key,
    journal: latest,
    cleanupAuthorized,
    cleanupIntent,
    cloneOwnership,
    ownedEntries,
  }
}

async function loadKey(workspace: string): Promise<Buffer> {
  try {
    return await internalRecoveryKey(workspace, false)
  } catch {
    throw uncertain()
  }
}

async function recoverFirstJournalOrBootstrap(
  directory: string,
  transactionRoot: string,
  key: Buffer,
  id: string,
): Promise<"journal" | "removed"> {
  const details = await lstat(directory, { bigint: true })
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    !pathsEqual(await realpath(directory), directory)
  )
    throw uncertain()
  const names = await readdir(directory)
  if (names.some((name) => JOURNAL_PATTERN.test(name))) return "journal"
  const evidenceDirectories = ["backups", "staged", "quarantine", "installed"] as const
  const temps = names.filter((name) => JOURNAL_TEMP_PATTERN.test(name))
  if (!names.includes("bootstrap.json")) throw uncertain()
  const bootstrap = await readAuthenticatedOwnershipMarker(
    resolve(directory, "bootstrap.json"),
    key,
    id,
    0,
    fsContext("bootstrap-marker", "recovery"),
  )
  if (!matchesDirectoryOwnership(details, bootstrap.root)) throw uncertain()
  if (
    names.some(
      (name) =>
        !evidenceDirectories.includes(name as (typeof evidenceDirectories)[number]) &&
        name !== "bootstrap.json" &&
        !JOURNAL_TEMP_PATTERN.test(name),
    ) ||
    temps.length > 1
  )
    throw uncertain()
  for (const name of evidenceDirectories) {
    if (!names.includes(name)) throw uncertain()
    const child = resolve(directory, name)
    const childDetails = await lstat(child, { bigint: true })
    if (
      !childDetails.isDirectory() ||
      childDetails.isSymbolicLink() ||
      !pathsEqual(await realpath(child), child) ||
      !matchesDirectoryOwnership(childDetails, bootstrap.evidence[name])
    )
      throw uncertain()
  }
  if (temps.length === 1) {
    const temp = resolve(directory, temps[0]!)
    try {
      const { value: envelope, details: tempDetails } = await readStableJsonFile(
        temp,
        fsContext("journal-temp", "recovery"),
      )
      if (
        !record(envelope) ||
        !exactKeys(envelope, ["journal", "authentication"]) ||
        typeof envelope.authentication !== "string"
      )
        throw uncertain()
      const journal = validateJournal(envelope.journal, id, 1)
      if (
        journal.phase !== "prepared" ||
        !sameMac(envelope.authentication, authenticate(key, journal)) ||
        !matchesFileIdentity(tempDetails, journal.ownership.journal) ||
        JSON.stringify(journal.ownership.transaction) !== JSON.stringify(bootstrap.root) ||
        JSON.stringify(journal.ownership.evidence) !== JSON.stringify(bootstrap.evidence)
      )
        throw uncertain()
      const destination = resolve(directory, "journal.00000001.json")
      await publishFileNoClobber(temp, destination, journal.ownership.journal!, {
        pathRole: "journal",
        transactionPhase: "recovery",
      })
      await syncDirectory(directory, fsContext("journal", "recovery"))
      return "journal"
    } catch {
      // An incomplete or replaced journal temp has no authenticated inode ownership.
      throw uncertain()
    }
  }
  for (const name of evidenceDirectories) {
    const child = resolve(directory, name)
    if ((await readdir(child)).length !== 0) throw uncertain()
  }
  for (const name of [...evidenceDirectories].reverse()) {
    const child = resolve(directory, name)
    const childDetails = await lstat(child, { bigint: true })
    if (!matchesDirectoryOwnership(childDetails, bootstrap.evidence[name])) throw uncertain()
    await rmdirAuthenticated(child, bootstrap.evidence[name], {
      pathRole: "bootstrap-directory",
      transactionPhase: "recovery",
    })
  }
  const marker = resolve(directory, "bootstrap.json")
  const markerDetails = await lstat(marker, { bigint: true })
  if (!matchesFileIdentity(markerDetails, bootstrap.marker)) throw uncertain()
  await unlinkAuthenticated(marker, bootstrap.marker, {
    pathRole: "bootstrap-marker",
    transactionPhase: "recovery",
  })
  if (
    (await readdir(directory)).length !== 0 ||
    !matchesDirectoryOwnership(details, bootstrap.root)
  )
    throw uncertain()
  await rmdirAuthenticated(directory, bootstrap.root, {
    pathRole: "transaction-directory",
    transactionPhase: "recovery",
  })
  await syncDirectory(transactionRoot, fsContext("transaction-directory", "recovery"))
  return "removed"
}

async function finishRecoveredUndo(transaction: PreparedTransaction): Promise<void> {
  if (transaction.journal.historyId === null) throw uncertain()
  const historyRoot = await ensureSafeDirectory(transaction.workspace, HISTORY_ROOT)
  await resumeHistoryCleanupClaims(historyRoot, transaction.key)
  try {
    const history = await loadHistory(transaction.workspace)
    if (history.journal.id !== transaction.journal.historyId) throw uncertain()
    await cleanupTransaction(history)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await cleanupTombstones(historyRoot, transaction.workspace, transaction.key)
  await cleanupTransaction(transaction)
}

async function recoverAppearanceTransactionsCore(
  workspaceInput: string,
  verifyBuild?: () => Promise<void>,
): Promise<readonly AppearanceTransactionReceipt[]> {
  const options = testRuntime()?.options ?? {}
  const workspace = await canonicalWorkspace(workspaceInput)
  const transactionRoot = resolve(workspace, ...TRANSACTION_ROOT.split("/"))
  let names: string[]
  try {
    const rootDetails = await lstat(transactionRoot)
    if (
      !rootDetails.isDirectory() ||
      rootDetails.isSymbolicLink() ||
      !pathsEqual(await realpath(transactionRoot), transactionRoot)
    )
      throw uncertain()
    names = await readdir(transactionRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
    throw uncertain()
  }
  let key: Buffer | undefined
  if (names.some((name) => IDENTITY_CAPABILITY_CLAIM_PATTERN.test(name))) {
    key = await loadKey(workspace)
    await recoverFilesystemIdentityCapability(transactionRoot, key)
    names = await readdir(transactionRoot)
  }
  if (names.length === 0) return []
  key ??= await loadKey(workspace)
  await recoverCleanupRootClaims(transactionRoot, key)
  names = await readdir(transactionRoot)
  const activeNames = names.filter((name) => ID_PATTERN.test(name))
  const cleanupNames = names.filter((name) => !ID_PATTERN.test(name))
  const unsafe = cleanupNames.find((name) => {
    const match = CLEANUP_DIRECTORY_PATTERN.exec(name)
    return match === null || !ID_PATTERN.test(match[1]!)
  })
  if (unsafe !== undefined) throw uncertain()
  if (names.length === 0) return []
  const remainingActive: string[] = []
  const receipts: AppearanceTransactionReceipt[] = []
  for (const name of activeNames) {
    const directory = resolve(transactionRoot, name)
    const cleanup = await resumeInPlaceCleanupClaim(directory, key, name)
    if (cleanup === "none") remainingActive.push(name)
    else if (cleanup === "prepared")
      receipts.push({ id: name, status: "recovered", canUndo: false })
  }
  await cleanupTombstones(transactionRoot, workspace, key, new Set(remainingActive))
  for (const name of remainingActive.sort()) {
    let transaction: PreparedTransaction | undefined
    try {
      const directory = resolve(transactionRoot, name)
      if (
        (await recoverFirstJournalOrBootstrap(directory, transactionRoot, key, name)) === "removed"
      )
        continue
      transaction = await loadTransaction(directory, workspace, key, name)
      await resolvePublishTemps(transaction)
      await resolveQuarantineArtifacts(
        transaction,
        transaction.journal.phase === "verified" ? "after" : "before",
        options,
      )
      const states = await Promise.all(
        transaction.journal.entries.map((entry, index) => exactState(transaction!, entry, index)),
      )
      if (states.includes("other")) throw uncertain()
      if (transaction.journal.phase === "verified") {
        if (states.some((state) => state !== "after")) throw uncertain()
        if (transaction.journal.kind === "undo") {
          await finishRecoveredUndo(transaction)
          receipts.push({ id: transaction.journal.id, status: "recovered", canUndo: false })
        } else {
          await promoteHistory(transaction, options)
          receipts.push({ id: transaction.journal.id, status: "recovered", canUndo: true })
        }
      } else if (
        transaction.journal.phase === "published" &&
        verifyBuild !== undefined &&
        states.every((state) => state === "after")
      ) {
        await verifyBuild()
        await advanceJournal(transaction, "verified", options)
        if (transaction.journal.kind === "undo") {
          await finishRecoveredUndo(transaction)
          receipts.push({ id: transaction.journal.id, status: "recovered", canUndo: false })
        } else {
          await promoteHistory(transaction, options)
          receipts.push({ id: transaction.journal.id, status: "recovered", canUndo: true })
        }
      } else {
        await rollback(transaction, options)
        await cleanupTransaction(transaction)
        receipts.push({ id: transaction.journal.id, status: "recovered", canUndo: false })
      }
    } catch (error) {
      if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
      if (isSimulationCrash(error)) throw error
      if (transaction === undefined) throw uncertain()
      if (transaction.journal.phase === "verified") throw uncertain()
      try {
        await rollback(transaction, options)
        await cleanupTransaction(transaction)
      } catch {
        throw uncertain()
      }
      throw failed()
    }
  }
  return receipts
}

export async function recoverAppearanceTransactions(
  workspace: string,
  verifyBuild?: () => Promise<void>,
): Promise<readonly AppearanceTransactionReceipt[]> {
  return serializeWorkspaceOperation(workspace, (canonical) =>
    recoverAppearanceTransactionsCore(canonical, verifyBuild),
  )
}

async function loadHistory(workspace: string): Promise<PreparedTransaction> {
  const directory = resolve(workspace, ...HISTORY_ROOT.split("/"), "current")
  const key = await loadKey(workspace)
  const history = await loadTransaction(directory, workspace, key)
  if (
    history.journal.kind !== "apply" ||
    history.journal.phase !== "verified" ||
    history.journal.historyId !== null
  )
    throw uncertain()
  return history
}

async function undoAppearanceTransactionCore(
  workspaceInput: string,
  baselineHash: string,
  verifyBuild: () => Promise<void>,
): Promise<AppearanceTransactionReceipt> {
  const options = testRuntime()?.options ?? {}
  if (!DIGEST_PATTERN.test(baselineHash)) throw conflict()
  const workspace = await canonicalWorkspace(workspaceInput)
  if (options.readBaselineHash !== undefined) {
    let currentBaseline: string
    try {
      currentBaseline = await options.readBaselineHash()
    } catch {
      throw failed()
    }
    if (currentBaseline !== baselineHash) throw conflict()
  }
  let history: PreparedTransaction
  try {
    history = await loadHistory(workspace)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw conflict()
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") {
      try {
        await lstat(resolve(workspace, ...HISTORY_ROOT.split("/"), "current"))
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") throw conflict()
      }
    }
    throw uncertain()
  }
  if (history.journal.phase !== "verified") throw conflict()
  if (!(await verifyState(history, "after"))) {
    for (let index = 0; index < history.journal.entries.length; index += 1) {
      const entry = history.journal.entries[index]!
      const current = await readOrdinaryFile(
        workspace,
        entry.path,
        fsContext("target", history.journal.phase, index),
      ).catch(() => {
        throw uncertain()
      })
      if (entry.afterHash === null ? current !== null : current?.hash !== entry.afterHash)
        throw conflict()
    }
    throw uncertain()
  }
  const writes: Array<{ path: string; expectedHash: string | null; bytes: Uint8Array }> = []
  const deletes: Array<{ path: string; expectedHash: string }> = []
  try {
    for (const entry of history.journal.entries) {
      if (entry.beforeHash === null) {
        if (entry.afterHash === null) throw uncertain()
        deletes.push({ path: entry.path, expectedHash: entry.afterHash })
      } else {
        if (entry.backup === null) throw uncertain()
        writes.push({
          path: entry.path,
          expectedHash: entry.afterHash,
          bytes: await readEvidenceFile(history.directory, entry.backup, entry.beforeHash, {
            pathRole: "history-evidence",
            fileIndex: history.journal.entries.indexOf(entry),
            transactionPhase: history.journal.phase,
          }),
        })
      }
    }
  } catch (error) {
    if (record(error) && error.code === "APPEARANCE_TRANSACTION_UNCERTAIN") throw error
    throw uncertain()
  }
  const plan: AppearancePlan = {
    baselineHash,
    settings: {} as AppearancePlan["settings"],
    writes,
    deletes,
  }
  const receipt = await executeCore(
    workspace,
    plan,
    verifyBuild,
    { ...options, readBaselineHash: undefined },
    "undo",
    false,
    history.journal.id,
  )
  const undoDirectory = resolve(workspace, ...TRANSACTION_ROOT.split("/"), receipt.id)
  try {
    await invoke(options, { kind: "undo-history-remove" })
    const currentHistory = await loadHistory(workspace)
    if (currentHistory.journal.id !== history.journal.id) throw uncertain()
    await cleanupTransaction(currentHistory)
    const undoTransaction = await loadTransaction(undoDirectory, workspace, history.key, receipt.id)
    await cleanupTransaction(undoTransaction)
  } catch (error) {
    if (isSimulationCrash(error)) throw error
    throw uncertain()
  }
  return { ...receipt, status: "undone", canUndo: false }
}

export async function undoAppearanceTransaction(
  workspace: string,
  baselineHash: string,
  verifyBuild: () => Promise<void>,
): Promise<AppearanceTransactionReceipt> {
  return serializeWorkspaceOperation(workspace, (canonical) =>
    undoAppearanceTransactionCore(canonical, baselineHash, verifyBuild),
  )
}
