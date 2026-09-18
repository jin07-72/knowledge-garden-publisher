import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runCommand,
  type CommandRequest,
  type CommandResult
} from "../../src/main/lib/commandRunner"
import { removeTemporaryDirectory } from "./fs"

function isolatedGitEnvironment(
  env?: Record<string, string | undefined>,
  emptyGlobalConfig?: string
): Record<string, string | undefined> {
  if (!emptyGlobalConfig) throw new Error("An isolated Git configuration path is required.")
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGlobalConfig
  }
}

export async function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>
): Promise<CommandResult> {
  const emptyGlobalConfig = join(cwd, `.publisher-test-git-config-${crypto.randomUUID()}`)
  await writeFile(emptyGlobalConfig, "")
  return runCommand({ executable: "git", args, cwd, env: isolatedGitEnvironment(env, emptyGlobalConfig) })
}

export interface TemporaryGitRepository {
  root: string
  remote: string
  cleanup(): Promise<void>
}

export interface GitFixtureDependencies {
  readonly createTempDirectory?: () => Promise<string>
  readonly runGit?: (request: CommandRequest) => Promise<CommandResult>
}

export async function createTemporaryGitRepository(
  dependencies: GitFixtureDependencies = {}
): Promise<TemporaryGitRepository> {
  const base = await (dependencies.createTempDirectory?.() ?? mkdtemp(join(tmpdir(), "garden-git-")))
  try {
    const root = join(base, "workspace")
    const remote = join(base, "origin.git")
    const emptyGlobalConfig = join(base, "empty-global.gitconfig")
    const env = isolatedGitEnvironment(undefined, emptyGlobalConfig)
    const runGit = dependencies.runGit ?? runCommand
    await mkdir(root)
    await writeFile(emptyGlobalConfig, "")

    for (const [cwd, args] of [
      [base, ["init", "--bare", "--initial-branch=main", "--object-format=sha1", remote]],
      [root, ["init", "--initial-branch=main", "--object-format=sha1"]],
      [root, ["config", "user.name", "Garden Test"]],
      [root, ["config", "user.email", "garden-test@example.invalid"]],
      [root, ["remote", "add", "origin", remote]]
    ] as const) {
      const result = await runGit({ executable: "git", args, cwd, env })
      if (result.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed`)
      }
    }

    return { root, remote, cleanup: () => removeTemporaryDirectory(base) }
  } catch (error) {
    await removeTemporaryDirectory(base)
    throw error
  }
}
