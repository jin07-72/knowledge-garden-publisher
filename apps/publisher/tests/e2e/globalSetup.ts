import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

const sourceRoot = resolve(import.meta.dirname, "../../../..")
const e2eTempParent = join(dirname(sourceRoot), ".garden-publisher-e2e")
const runPrefix = "run-"

export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir(e2eTempParent, { recursive: true })
  const runRoot = await mkdtemp(join(e2eTempParent, runPrefix))

  process.env.TEMP = runRoot
  process.env.TMP = runRoot

  return async () => {
    const resolvedRunRoot = resolve(runRoot)
    if (
      dirname(resolvedRunRoot) !== resolve(e2eTempParent) ||
      !basename(resolvedRunRoot).startsWith(runPrefix)
    ) {
      throw new Error(`Refusing to clean an unexpected E2E temp root: ${resolvedRunRoot}`)
    }
    await rm(resolvedRunRoot, { force: true, recursive: true })
  }
}
