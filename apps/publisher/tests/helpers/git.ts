import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCommand, type CommandResult } from "../../src/main/lib/commandRunner"
import { removeTemporaryDirectory } from "./fs"

export function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>
): Promise<CommandResult> {
  return runCommand({ executable: "git", args, cwd, env })
}

export interface TemporaryGitRepository {
  root: string
  remote: string
  cleanup(): Promise<void>
}

export async function createTemporaryGitRepository(): Promise<TemporaryGitRepository> {
  const base = await mkdtemp(join(tmpdir(), "garden-git-"))
  const root = join(base, "workspace")
  const remote = join(base, "origin.git")
  await mkdir(root)

  for (const [cwd, args] of [
    [base, ["init", "--bare", remote]],
    [root, ["init"]],
    [root, ["config", "user.name", "Garden Test"]],
    [root, ["config", "user.email", "garden-test@example.invalid"]],
    [root, ["remote", "add", "origin", remote]]
  ] as const) {
    const result = await git(cwd, args)
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr}`)
    }
  }

  return { root, remote, cleanup: () => removeTemporaryDirectory(base) }
}
