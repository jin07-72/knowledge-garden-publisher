import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runCommand,
  type CommandRequest,
  type CommandResult,
} from "../../src/main/lib/commandRunner"
import { removeTemporaryDirectory } from "./fs"
import { writeFixtureFile } from "./fs"

function isolatedGitEnvironment(
  env?: Record<string, string | undefined>,
  emptyGlobalConfig?: string,
): Record<string, string | undefined> {
  if (!emptyGlobalConfig) throw new Error("An isolated Git configuration path is required.")
  const sanitizedEnvironment: Record<string, string | undefined> = {
    ...env,
    GIT_CONFIG_PARAMETERS: undefined,
  }
  for (const key of [...Object.keys(process.env), ...Object.keys(env ?? {})]) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
      sanitizedEnvironment[key] = undefined
    }
  }
  return {
    ...sanitizedEnvironment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_COUNT: "0",
  }
}

export async function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<CommandResult> {
  const configDirectory = await mkdtemp(join(tmpdir(), "garden-git-command-config-"))
  const emptyGlobalConfig = join(configDirectory, "empty-global.gitconfig")
  try {
    await writeFile(emptyGlobalConfig, "")
    return await runCommand({
      executable: "git",
      args,
      cwd,
      env: isolatedGitEnvironment(env, emptyGlobalConfig),
    })
  } finally {
    await removeTemporaryDirectory(configDirectory)
  }
}

export interface TemporaryGitRepository {
  root: string
  remote: string
  cleanup(): Promise<void>
}

export interface QuartzGardenFixture extends TemporaryGitRepository {
  readonly notePath: string
  readonly noteTitle: string
}

const fixtureNote = (title: string, body: string): string => `---
title: ${title}
date: 2026-10-02
description: ${title} description
tags:
  - e2e
---

# ${title}

${body}
`

export async function createQuartzGardenFixture(options: {
  readonly directoryName: string
  readonly noteTitle: string
  readonly noteBody: string
}): Promise<QuartzGardenFixture> {
  const repository = await createTemporaryGitRepository()
  const root = join(repository.root, "..", options.directoryName)
  await rename(repository.root, root)
  const notePath = "content/life/fixture.md"
  await Promise.all([
    writeFixtureFile(root, notePath, fixtureNote(options.noteTitle, options.noteBody)),
    writeFixtureFile(root, "scripts/validate-content.mjs", "process.exit(0)\n"),
    writeFixtureFile(root, "private/.gitkeep", ""),
    writeFixtureFile(root, "quartz/bootstrap-cli.mjs", ""),
    writeFixtureFile(root, "quartz.config.yaml", "configuration: {}\n"),
    writeFixtureFile(
      root,
      ".gitignore",
      "node_modules/\n.garden-publisher/\nprivate/*\n!private/.gitkeep\n",
    ),
    writeFixtureFile(
      root,
      "package.json",
      JSON.stringify({
        name: options.directoryName.toLowerCase().replaceAll(" ", "-"),
        private: true,
        scripts: { "verify:site": 'node -e "process.exit(0)"' },
      }),
    ),
    writeFixtureFile(
      root,
      "package-lock.json",
      JSON.stringify({
        name: options.directoryName.toLowerCase().replaceAll(" ", "-"),
        lockfileVersion: 3,
        packages: {},
      }),
    ),
  ])
  await git(root, ["add", "."])
  await git(root, ["commit", "-m", `Create ${options.directoryName}`])
  await git(root, ["push", "-u", "origin", "main"])
  await mkdir(join(root, "node_modules"), { recursive: true })
  await writeFile(
    join(root, "node_modules", ".package-lock.json"),
    JSON.stringify({
      name: options.directoryName.toLowerCase().replaceAll(" ", "-"),
      lockfileVersion: 3,
      packages: {},
    }),
  )
  return { ...repository, root, notePath, noteTitle: options.noteTitle }
}

export interface GitFixtureDependencies {
  readonly createTempDirectory?: () => Promise<string>
  readonly runGit?: (request: CommandRequest) => Promise<CommandResult>
}

export async function createTemporaryGitRepository(
  dependencies: GitFixtureDependencies = {},
): Promise<TemporaryGitRepository> {
  const base = await (dependencies.createTempDirectory?.() ??
    mkdtemp(join(tmpdir(), "garden-git-")))
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
      [root, ["remote", "add", "origin", remote]],
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
