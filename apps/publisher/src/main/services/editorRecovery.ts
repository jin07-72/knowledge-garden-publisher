import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
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
const maximumDraftEntries = 500

interface StoredDraft extends NoteRecovery {
  readonly version: 1
  readonly integrity: string
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
    Buffer.byteLength(draft.markdown) > maximumDraftBytes ||
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

async function draftRoot(workspace: string): Promise<string> {
  const canonicalWorkspace = await realpath(workspace)
  const recovery = resolve(canonicalWorkspace, ".garden-publisher", "recovery")
  const root = resolve(recovery, "editor")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const [recoveryPath, rootPath, recoveryInfo, rootInfo] = await Promise.all([
    realpath(recovery),
    realpath(root),
    lstat(recovery),
    lstat(root),
  ])
  if (
    recoveryInfo.isSymbolicLink() ||
    rootInfo.isSymbolicLink() ||
    !recoveryInfo.isDirectory() ||
    !rootInfo.isDirectory() ||
    !inside(canonicalWorkspace, recoveryPath) ||
    !inside(recoveryPath, rootPath)
  )
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  return rootPath
}

async function target(workspace: string, path: string): Promise<{ root: string; file: string }> {
  await readNote({ workspace, path })
  const root = await draftRoot(workspace)
  return { root, file: resolve(root, draftName(path)) }
}

async function enforceRetention(root: string): Promise<void> {
  const names = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
  if (names.length <= maximumDraftEntries) return
  const entries = await Promise.all(
    names.map(async (name) => ({ name, mtimeMs: (await stat(resolve(root, name))).mtimeMs })),
  )
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(maximumDraftEntries)) {
    await rm(resolve(root, entry.name), { force: true })
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, "r")
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      process.platform === "win32" &&
      ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(code ?? "")
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
  if (Buffer.byteLength(request.markdown) > maximumDraftBytes) {
    throw failure("INVALID_INPUT", "The recovery content is too large.")
  }
  const { root, file } = await target(workspace, request.path)
  const key = await internalRecoveryKey(workspace, true)
  const draft = {
    version: 1 as const,
    ...request,
    createdAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(request.markdown).digest("hex"),
  }
  const stored: StoredDraft = { ...draft, integrity: signature(key, draft) }
  const temporary = resolve(root, `.${draftName(request.path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(stored), "utf8")
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    await rename(temporary, file)
    await syncDirectory(dirname(file))
    await enforceRetention(root)
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw failure("NOTE_FILE_WRITE_FAILED", "Could not write recovery data.")
  }
  return { contentHash: draft.contentHash }
}

export async function getEditorRecovery(
  workspace: string,
  request: NotePathRequest,
): Promise<NoteRecovery | undefined> {
  const { file } = await target(workspace, request.path)
  const details = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (details === undefined) return undefined
  if (!details.isFile() || details.size > maximumDraftBytes + 4096) {
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  const key = await internalRecoveryKey(workspace, false)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, "utf8"))
  } catch {
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  if (!valid(parsed, request.path, key)) {
    throw failure("RECOVERY_INVALID", "Recovery data is invalid.")
  }
  const { path, markdown, baseMtimeMs, baseContentHash, createdAt, contentHash } = parsed
  return { path, markdown, baseMtimeMs, baseContentHash, createdAt, contentHash }
}

export async function discardEditorRecovery(
  workspace: string,
  request: NoteRecoveryDiscardRequest,
  trash: TrashAdapter,
): Promise<void> {
  const { file } = await target(workspace, request.path)
  try {
    await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw failure("RECOVERY_DISCARD_FAILED", "Could not discard recovery data.")
  }
  const current = await getEditorRecovery(workspace, request)
  if (current === undefined || current.contentHash !== request.contentHash) return
  try {
    await trash.trashItem(file)
  } catch {
    throw failure("RECOVERY_DISCARD_FAILED", "Could not discard recovery data.")
  }
}
