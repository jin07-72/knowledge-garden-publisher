import { lstat, realpath, rename } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { isAbsolute, relative, resolve } from "node:path"
import {
  MANAGED_NOTE_PATH_PATTERN,
  type AppError,
  type NoteTrashReceipt,
  type TrashAdapter,
} from "../../shared/contracts"
import { trashNote as trashVerifiedNote } from "./noteFiles"

export interface TrashManagedNoteInput {
  readonly workspace: string
  readonly path: string
  readonly trash: TrashAdapter
  readonly isTracked: (workspace: string, path: string) => Promise<boolean>
}

function noteError(code: AppError["code"], message: string): AppError {
  return { code, message } as AppError
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
}

function entryIdentity(details: Awaited<ReturnType<typeof lstat>>): string {
  return `${details.dev}:${details.ino}`
}

async function ownedAttachmentDirectory(
  workspaceInput: string,
  notePath: string,
): Promise<
  | {
      readonly directory: string
      readonly assetsRoot: string
      readonly assetsIdentity: string
      readonly directoryIdentity: string
    }
  | undefined
> {
  const match = MANAGED_NOTE_PATH_PATTERN.exec(notePath)
  if (!match) {
    throw noteError("NOTE_FILE_INVALID", "Choose a note inside a managed content directory.")
  }
  let workspace: string
  try {
    workspace = await realpath(resolve(workspaceInput))
  } catch {
    throw noteError("NOTE_FILE_ACCESS_FAILED", "The knowledge garden workspace is unavailable.")
  }
  const visibilityRoot = match[1]!
  const slug = match[3]!
  const managedRoot = resolve(workspace, visibilityRoot)
  const assetsRoot = resolve(managedRoot, "_assets")
  const directory = resolve(assetsRoot, slug)
  if (!isInside(workspace, managedRoot) || !isInside(managedRoot, directory)) {
    throw noteError("NOTE_FILE_UNSAFE_PATH", "The attachment path left the managed workspace.")
  }
  try {
    const rootDetails = await lstat(assetsRoot)
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The managed attachment root is unsafe.")
    }
    const canonicalAssets = await realpath(assetsRoot)
    if (!pathsEqual(canonicalAssets, assetsRoot) || !isInside(managedRoot, canonicalAssets)) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The managed attachment root is unsafe.")
    }
    const details = await lstat(directory)
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The owned attachment path is unsafe.")
    }
    const canonical = await realpath(directory)
    if (!pathsEqual(canonical, directory) || !isInside(canonicalAssets, canonical)) {
      throw noteError("NOTE_FILE_UNSAFE_PATH", "The owned attachment path is unsafe.")
    }
    return {
      directory,
      assetsRoot: canonicalAssets,
      assetsIdentity: entryIdentity(rootDetails),
      directoryIdentity: entryIdentity(details),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    if (typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("NOTE_")) {
      throw error
    }
    throw noteError("NOTE_FILE_ACCESS_FAILED", "Could not validate the owned attachments.")
  }
}

async function trashOwnedAttachments(
  owned: {
    readonly directory: string
    readonly assetsRoot: string
    readonly assetsIdentity: string
    readonly directoryIdentity: string
  },
  trash: TrashAdapter,
): Promise<void> {
  const staged = resolve(owned.assetsRoot, `.garden-trash-${randomUUID()}`)
  try {
    const [assets, directory, canonicalAssets, canonicalDirectory] = await Promise.all([
      lstat(owned.assetsRoot),
      lstat(owned.directory),
      realpath(owned.assetsRoot),
      realpath(owned.directory),
    ])
    if (
      assets.isSymbolicLink() ||
      directory.isSymbolicLink() ||
      !assets.isDirectory() ||
      !directory.isDirectory() ||
      entryIdentity(assets) !== owned.assetsIdentity ||
      entryIdentity(directory) !== owned.directoryIdentity ||
      !pathsEqual(canonicalAssets, owned.assetsRoot) ||
      !pathsEqual(canonicalDirectory, owned.directory)
    ) {
      throw new Error("attachment identity changed")
    }
    await rename(owned.directory, staged)
  } catch {
    throw noteError(
      "NOTE_FILE_COMMIT_UNCERTAIN",
      "The attachment path changed during deletion. Check the workspace before retrying.",
    )
  }
  try {
    try {
      await trash.trashItem(staged)
    } catch {
      // shell.trashItem can reject after Windows has accepted the move; reconcile below.
    }
    try {
      await lstat(staged)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    await rename(staged, owned.directory)
    throw noteError(
      "NOTE_FILE_WRITE_FAILED",
      "The attachments were not moved to the Recycle Bin and were safely restored.",
    )
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("NOTE_")) {
      throw error
    }
    throw noteError(
      "NOTE_FILE_COMMIT_UNCERTAIN",
      "The attachment deletion could not be confirmed. Check the Recycle Bin before retrying.",
    )
  }
}

export function createElectronTrashAdapter(shell: Pick<TrashAdapter, "trashItem">): TrashAdapter {
  if (typeof shell?.trashItem !== "function") {
    throw new TypeError("An Electron shell.trashItem capability is required.")
  }
  return Object.freeze({ trashItem: (absolutePath: string) => shell.trashItem(absolutePath) })
}

/** Deletes only one validated note and the attachment directory owned by its slug. */
export async function trashManagedNote(input: TrashManagedNoteInput): Promise<NoteTrashReceipt> {
  if (typeof input.trash?.trashItem !== "function" || typeof input.isTracked !== "function") {
    throw noteError("INVALID_INPUT", "A Recycle Bin adapter and tracking check are required.")
  }
  const owned = await ownedAttachmentDirectory(input.workspace, input.path)
  const receipt = await trashVerifiedNote(input)
  if (owned) await trashOwnedAttachments(owned, input.trash)
  return receipt
}

export const trashNote = trashManagedNote
