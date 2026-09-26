import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises"
import { relative, resolve } from "node:path"
import type {
  AppError,
  NotePathRequest,
  NoteRecovery,
  NoteRecoveryDiscardRequest,
  NoteRecoveryReceipt,
  NoteRecoveryWriteRequest,
  TrashAdapter,
} from "../../shared/contracts"
import { internalRecoveryKey, readNote } from "./noteFiles"

const maximumDraftBytes = 16 * 1024 * 1024
const maximumStoredBytes = maximumDraftBytes * 6 + 64 * 1024
const maximumDraftEntries = 500

interface StoredDraft extends NoteRecovery {
  readonly version: 1
  readonly integrity: string
}

interface DraftRoot {
  readonly path: string
  readonly identity: string
  readonly workspace: string
}

export interface EditorRecoveryReadAdapter {
  readonly afterLstat?: (file: string) => Promise<void>
  readonly afterOpen?: (file: string) => Promise<void>
}

function failure(code: AppError["code"], message: string): AppError {
  return { code, message } as AppError
}

function inside(parent: string, child: string): boolean {
  const candidate = relative(parent, child)
  return (
    candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith(`..\\`) &&
    !candidate.startsWith("../")
  )
}

function identity(value: { dev: bigint; ino: bigint }): string {
  return `${value.dev}:${value.ino}`
}

function draftName(path: string): string {
  return `${createHash("sha256").update(path).digest("hex")}.json`
}

function unsigned(draft: Omit<StoredDraft, "integrity">): string {
  return JSON.stringify({
    version: draft.version,
    path: draft.path,
    markdown: draft.markdown,
    baseMtimeMs: draft.baseMtimeMs,
    baseContentHash: draft.baseContentHash,
    createdAt: draft.createdAt,
    contentHash: draft.contentHash,
  })
}

function signature(key: Buffer, draft: Omit<StoredDraft, "integrity">): string {
  return createHmac("sha256", key).update(unsigned(draft)).digest("hex")
}

function valid(value: unknown, expectedPath: string, key: Buffer): value is StoredDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Partial<StoredDraft>
  if (
    draft.version !== 1 ||
    draft.path !== expectedPath ||
    typeof draft.markdown !== "string" ||
    Buffer.byteLength(draft.markdown, "utf8") > maximumDraftBytes ||
    typeof draft.baseMtimeMs !== "number" ||
    !Number.isFinite(draft.baseMtimeMs) ||
    typeof draft.baseContentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.baseContentHash) ||
    typeof draft.createdAt !== "string" ||
    Number.isNaN(Date.parse(draft.createdAt)) ||
    typeof draft.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.contentHash) ||
    createHash("sha256").update(draft.markdown).digest("hex") !== draft.contentHash ||
    typeof draft.integrity !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.integrity)
  )
    return false
  const expected = Buffer.from(signature(key, draft as Omit<StoredDraft, "integrity">), "hex")
  const actual = Buffer.from(draft.integrity, "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function checkedDirectory(
  path: string,
  parent: string,
  create: boolean,
): Promise<{ path: string; identity: string }> {
  if (create) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
  }
  const before = await lstat(path, { bigint: true }).catch(() => {
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  })
  if (before.isSymbolicLink() || !before.isDirectory())
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  const canonical = await realpath(path)
  if (!inside(parent, canonical)) throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  const after = await lstat(path, { bigint: true })
  if (after.isSymbolicLink() || !after.isDirectory() || identity(before) !== identity(after))
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  return { path: canonical, identity: identity(after) }
}

async function draftRoot(workspace: string, create = true): Promise<DraftRoot> {
  const canonicalWorkspace = await realpath(workspace)
  const state = await checkedDirectory(
    resolve(canonicalWorkspace, ".garden-publisher"),
    canonicalWorkspace,
    create,
  )
  const root = await checkedDirectory(resolve(state.path, "editor-recovery"), state.path, create)
  return { path: root.path, identity: root.identity, workspace: canonicalWorkspace }
}

async function assertRoot(root: DraftRoot): Promise<void> {
  const details = await lstat(root.path, { bigint: true })
  if (
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    identity(details) !== root.identity ||
    !inside(root.workspace, await realpath(root.path))
  )
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
}

async function target(workspace: string, path: string): Promise<{ root: DraftRoot; file: string }> {
  await readNote({ workspace, path })
  const root = await draftRoot(workspace)
  return { root, file: resolve(root.path, draftName(path)) }
}

function checkedStoredSize(size: bigint): number {
  if (size < 0n || size > BigInt(maximumStoredBytes) || size > BigInt(Number.MAX_SAFE_INTEGER))
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  return Number(size)
}

async function boundedRead(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== expectedBytes) throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  return buffer.subarray(0, offset)
}

async function readStored(
  root: DraftRoot,
  file: string,
  expectedPath: string,
  key: Buffer,
  adapter: EditorRecoveryReadAdapter = {},
): Promise<{ draft: StoredDraft; identity: string } | undefined> {
  let before
  try {
    before = await lstat(file, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  if (before.isSymbolicLink() || !before.isFile())
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  checkedStoredSize(before.size)
  if (!inside(root.path, await realpath(file)))
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  await adapter.afterLstat?.(file)
  let handle: FileHandle | undefined
  try {
    handle = await open(
      file,
      process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(opened) !== identity(before) || opened.size !== before.size)
      throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
    const openedBytes = checkedStoredSize(opened.size)
    await adapter.afterOpen?.(file)
    const bytes = await boundedRead(handle, openedBytes)
    const after = await lstat(file, { bigint: true })
    if (
      after.isSymbolicLink() ||
      identity(after) !== identity(opened) ||
      after.size !== opened.size ||
      !inside(root.path, await realpath(file))
    )
      throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString("utf8"))
    } catch {
      throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
    }
    if (!valid(parsed, expectedPath, key))
      throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
    return { draft: parsed, identity: identity(after) }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function enforceRetention(root: DraftRoot): Promise<void> {
  const entries: Array<{ name: string; mtimeMs: number }> = []
  for (const name of await readdir(root.path)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const details = await lstat(resolve(root.path, name))
    if (!details.isSymbolicLink() && details.isFile())
      entries.push({ name, mtimeMs: details.mtimeMs })
  }
  for (const entry of entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .slice(maximumDraftEntries))
    await unlink(resolve(root.path, entry.name)).catch(() => undefined)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, "r")
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

export async function writeEditorRecovery(
  workspace: string,
  request: NoteRecoveryWriteRequest,
): Promise<NoteRecoveryReceipt> {
  if (Buffer.byteLength(request.markdown, "utf8") > maximumDraftBytes)
    throw failure("INVALID_INPUT", "The recovery content is too large.")
  const { root, file } = await target(workspace, request.path)
  const key = await internalRecoveryKey(workspace, true)
  const draft = {
    version: 1 as const,
    ...request,
    createdAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(request.markdown).digest("hex"),
  }
  const stored: StoredDraft = { ...draft, integrity: signature(key, draft) }
  const bytes = Buffer.from(JSON.stringify(stored), "utf8")
  if (bytes.length > maximumStoredBytes)
    throw failure("INVALID_INPUT", "The recovery content is too large.")
  const temporary = resolve(root.path, `.${draftName(request.path)}.${randomUUID()}.tmp`)
  let published = false
  try {
    await assertRoot(root)
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    await assertRoot(root)
    await rename(temporary, file)
    published = true
    await syncDirectory(root.path)
    await enforceRetention(root)
  } catch (error) {
    if ((error as AppError).code === "RECOVERY_INVALID") throw error
    throw failure("NOTE_FILE_WRITE_FAILED", "Could not write recovery data.")
  } finally {
    if (!published) await unlink(temporary).catch(() => undefined)
  }
  return { contentHash: draft.contentHash }
}

export async function getEditorRecovery(
  workspace: string,
  request: NotePathRequest,
  adapter: EditorRecoveryReadAdapter = {},
): Promise<NoteRecovery | undefined> {
  const { root, file } = await target(workspace, request.path)
  try {
    await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  const key = await internalRecoveryKey(workspace, false)
  const stored = await readStored(root, file, request.path, key, adapter)
  if (!stored) return undefined
  const { path, markdown, baseMtimeMs, baseContentHash, createdAt, contentHash } = stored.draft
  return { path, markdown, baseMtimeMs, baseContentHash, createdAt, contentHash }
}

export async function discardEditorRecovery(
  workspace: string,
  request: NoteRecoveryDiscardRequest,
  _trash: TrashAdapter,
): Promise<void> {
  const { root, file } = await target(workspace, request.path)
  try {
    await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw failure("RECOVERY_DISCARD_FAILED", "Could not discard recovery data.")
  }
  const key = await internalRecoveryKey(workspace, false)
  const stored = await readStored(root, file, request.path, key)
  if (!stored || stored.draft.contentHash !== request.contentHash) return
  try {
    await assertRoot(root)
    const current = await lstat(file, { bigint: true })
    if (current.isSymbolicLink() || identity(current) !== stored.identity)
      throw failure("RECOVERY_DISCARD_FAILED", "Could not discard recovery data.")
    await unlink(file)
    await syncDirectory(root.path)
  } catch (error) {
    if ((error as AppError).code === "RECOVERY_DISCARD_FAILED") throw error
    throw failure("RECOVERY_DISCARD_FAILED", "Could not discard recovery data.")
  }
}
