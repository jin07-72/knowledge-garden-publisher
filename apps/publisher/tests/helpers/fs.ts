import { access, rm } from "node:fs/promises"
import { constants } from "node:fs"

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
}
