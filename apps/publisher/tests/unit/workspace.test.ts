import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CommandRunnerError,
  runCommand,
  type CommandRunner
} from "../../src/main/lib/commandRunner"
import { inspectWorkspace } from "../../src/main/services/workspace"
import { exists, removeTemporaryDirectory } from "../helpers/fs"
import {
  createTemporaryGitRepository,
  git,
  type GitFixtureDependencies,
  type TemporaryGitRepository
} from "../helpers/git"

const temporaryDirectories: string[] = []
const temporaryRepositories: TemporaryGitRepository[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
  await Promise.all(temporaryRepositories.splice(0).map((repository) => repository.cleanup()))
})

async function createGarden(root?: string): Promise<string> {
  const gardenRoot = root ?? (await mkdtemp(join(tmpdir(), "garden-workspace-")))
  if (!root) temporaryDirectories.push(gardenRoot)
  await mkdir(join(gardenRoot, "content"), { recursive: true })
  await mkdir(join(gardenRoot, "private"), { recursive: true })
  await mkdir(join(gardenRoot, "scripts"), { recursive: true })
  await writeFile(join(gardenRoot, "package-lock.json"), "{}")
  await writeFile(join(gardenRoot, "quartz.config.yaml"), "configuration: {}")
  await writeFile(join(gardenRoot, "scripts", "validate-content.mjs"), "")
  return gardenRoot
}

describe("inspectWorkspace", () => {
  it("accepts a garden with required roots and scripts", async () => {
    const root = await createGarden()

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(true)
    expect(result.capabilities.files).toBe(true)
    expect(result.capabilities.preview).toBe(true)
    expect(result.capabilities.git).toBe(false)
    expect(result.capabilities.publish).toBe(false)
  })

  it("returns actionable errors for every missing required path", async () => {
    const root = await mkdtemp(join(tmpdir(), "garden-workspace-"))
    temporaryDirectories.push(root)

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "CONTENT_MISSING",
        "PRIVATE_MISSING",
        "SCRIPTS_MISSING",
        "PACKAGE_LOCK_MISSING",
        "QUARTZ_CONFIG_MISSING",
        "VALIDATE_CONTENT_MISSING"
      ])
    )
    expect(result.capabilities).toMatchObject({ files: false, preview: false })
  })

  it.each([
    ["content", "CONTENT_MISSING"],
    ["private", "PRIVATE_MISSING"],
    ["scripts", "SCRIPTS_MISSING"],
    ["package-lock.json", "PACKAGE_LOCK_MISSING"],
    ["quartz.config.yaml", "QUARTZ_CONFIG_MISSING"],
    ["scripts/validate-content.mjs", "VALIDATE_CONTENT_MISSING"]
  ] as const)("reports %s when that required path is absent", async (relativePath, code) => {
    const root = await createGarden()
    await rm(join(root, relativePath), { force: true, recursive: true })

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain(code)
  })

  it("reports wrong types for required directories and files", async () => {
    const root = await mkdtemp(join(tmpdir(), "garden-workspace-"))
    temporaryDirectories.push(root)
    await writeFile(join(root, "content"), "not a directory")
    await mkdir(join(root, "private"))
    await mkdir(join(root, "scripts"))
    await mkdir(join(root, "package-lock.json"))
    await writeFile(join(root, "quartz.config.yaml"), "configuration: {}")
    await mkdir(join(root, "scripts", "validate-content.mjs"))

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "CONTENT_NOT_DIRECTORY",
        "PACKAGE_LOCK_NOT_FILE",
        "VALIDATE_CONTENT_NOT_FILE"
      ])
    )
  })

  it.each([
    ["content", "directory", "CONTENT_NOT_DIRECTORY"],
    ["private", "directory", "PRIVATE_NOT_DIRECTORY"],
    ["scripts", "directory", "SCRIPTS_NOT_DIRECTORY"],
    ["package-lock.json", "file", "PACKAGE_LOCK_NOT_FILE"],
    ["quartz.config.yaml", "file", "QUARTZ_CONFIG_NOT_FILE"],
    ["scripts/validate-content.mjs", "file", "VALIDATE_CONTENT_NOT_FILE"]
  ] as const)("reports %s when required %s has the wrong type", async (relativePath, expectedType, code) => {
    const root = await createGarden()
    const path = join(root, relativePath)
    await rm(path, { force: true, recursive: true })
    if (expectedType === "directory") {
      await writeFile(path, "not a directory")
    } else {
      await mkdir(path)
    }

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain(code)
  })

  it("enables git and publishing only for a matching repository with origin", async () => {
    const repository = await createTemporaryGitRepository()
    temporaryRepositories.push(repository)
    await createGarden(repository.root)

    const result = await inspectWorkspace(repository.root, { checkGit: true })

    expect(result.ok).toBe(true)
    expect(result.capabilities).toEqual({ files: true, preview: true, git: true, publish: true })
  })

  it("rejects a garden nested inside a parent repository", async () => {
    const repository = await createTemporaryGitRepository()
    temporaryRepositories.push(repository)
    const root = await createGarden(join(repository.root, "nested-garden"))

    const result = await inspectWorkspace(root, { checkGit: true })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_ROOT_MISMATCH")
    expect(result.capabilities.git).toBe(false)
  })

  it("reports a missing origin without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "garden-workspace-"))
    temporaryDirectories.push(root)
    await createGarden(root)
    expect((await git(root, ["init"])).exitCode).toBe(0)

    const result = await inspectWorkspace(root, { checkGit: true })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_ORIGIN_MISSING")
    expect(result.capabilities.git).toBe(false)
  })

  it("reports a garden that is not a Git repository", async () => {
    const root = await createGarden()

    const result = await inspectWorkspace(root, { checkGit: true })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_NOT_REPOSITORY")
    expect(result.capabilities.git).toBe(false)
  })

  it("reports an origin command failure separately from a missing origin", async () => {
    const root = await createGarden()
    const runner: CommandRunner = {
      run: async ({ args }) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
        if (args[0] === "remote") return { exitCode: 1, stdout: "", stderr: "permission denied" }
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    }

    const result = await inspectWorkspace(root, { checkGit: true, runner })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_ORIGIN_FAILED")
    expect(result.capabilities.git).toBe(false)
  })

  it("reports git status failures from an injected runner", async () => {
    const root = await createGarden()
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const runner: CommandRunner = {
      run: async (request) => {
        requests.push(request)
        const { args } = request
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
        if (args[0] === "remote") return { exitCode: 0, stdout: "https://example.invalid/garden.git\n", stderr: "" }
        return { exitCode: 1, stdout: "", stderr: "git status failed" }
      }
    }

    const result = await inspectWorkspace(root, { checkGit: true, runner })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_STATUS_FAILED")
    expect(result.capabilities.git).toBe(false)
    expect(requests).toEqual([
      {
        executable: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: root,
        env: { GIT_OPTIONAL_LOCKS: "0" }
      },
      {
        executable: "git",
        args: ["remote", "get-url", "origin"],
        cwd: root,
        env: { GIT_OPTIONAL_LOCKS: "0" }
      },
      {
        executable: "git",
        args: ["status", "--porcelain=v2"],
        cwd: root,
        env: { GIT_OPTIONAL_LOCKS: "0" }
      }
    ])
  })

  it("reports an unavailable git executable from an injected runner", async () => {
    const root = await createGarden()
    const runner: CommandRunner = {
      run: async () => {
        throw new CommandRunnerError("COMMAND_FAILED", "Could not start command.")
      }
    }

    const result = await inspectWorkspace(root, { checkGit: true, runner })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_UNAVAILABLE")
  })
})

describe("runCommand", () => {
  it("passes literal arguments, captures streams separately, and merges environment overrides", async () => {
    const inheritedValue = process.env.GARDEN_INHERITED_VALUE
    process.env.GARDEN_INHERITED_VALUE = "inherited-value"
    try {
      const result = await runCommand({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.argv[1] + ':' + process.env.GARDEN_INHERITED_VALUE); process.stderr.write(process.env.GARDEN_TEST_VALUE)",
          "literal && not-a-shell-command"
        ],
        cwd: process.cwd(),
        env: { GARDEN_TEST_VALUE: "stderr-value" }
      })

      expect(result).toEqual({
        exitCode: 0,
        stdout: "literal && not-a-shell-command:inherited-value",
        stderr: "stderr-value"
      })
    } finally {
      if (inheritedValue === undefined) delete process.env.GARDEN_INHERITED_VALUE
      else process.env.GARDEN_INHERITED_VALUE = inheritedValue
    }
  })

  it("resolves non-zero process exits with their exit code and stderr", async () => {
    const result = await runCommand({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('failed'); process.exit(7)"],
      cwd: process.cwd()
    })

    expect(result).toEqual({ exitCode: 7, stdout: "", stderr: "failed" })
  })

  it("rejects cancellation with a stable error code", async () => {
    const controller = new AbortController()
    const command = runCommand({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal
    })
    controller.abort()

    await expect(command).rejects.toMatchObject({ code: "COMMAND_CANCELLED" })
  })

  it("honors an explicit cwd instead of the process cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "garden-command-cwd-"))
    temporaryDirectories.push(cwd)

    const result = await runCommand({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd
    })

    expect(result.stdout).toBe(cwd)
  })

  it("returns stable cancellation without starting an already-aborted command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "garden-command-abort-"))
    temporaryDirectories.push(cwd)
    const marker = join(cwd, "spawned.txt")
    const controller = new AbortController()
    controller.abort()

    await expect(
      runCommand({
        executable: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "COMMAND_CANCELLED" })
    expect(await exists(marker)).toBe(false)
  })

  it("rejects spawn failures without echoing unsafe executable text", async () => {
    await expect(
      runCommand({
        executable: "missing-command-top-secret",
        args: [],
        cwd: process.cwd()
      })
    ).rejects.toMatchObject({ code: "COMMAND_FAILED", message: "Could not start command." })
  })
})

describe("createTemporaryGitRepository", () => {
  it("uses an isolated configuration and explicit Git initialization options", async () => {
    const requests: Parameters<NonNullable<GitFixtureDependencies["runGit"]>>[0][] = []
    const repository = await createTemporaryGitRepository({
      runGit: async (request) => {
        requests.push(request)
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    })
    temporaryRepositories.push(repository)

    expect(requests).toHaveLength(5)
    expect(requests[0]).toMatchObject({
      args: ["init", "--bare", "--initial-branch=main", "--object-format=sha1", repository.remote],
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: expect.stringContaining("empty-global.gitconfig")
      }
    })
    expect(requests[1]).toMatchObject({
      args: ["init", "--initial-branch=main", "--object-format=sha1"],
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: expect.stringContaining("empty-global.gitconfig")
      }
    })
  })

  it("cleans its allocated temporary directory when setup fails", async () => {
    const base = await mkdtemp(join(tmpdir(), "garden-git-cleanup-"))
    temporaryDirectories.push(base)
    const repository = createTemporaryGitRepository({
      createTempDirectory: async () => base,
      runGit: async () => ({ exitCode: 1, stdout: "", stderr: "failure" })
    })

    await expect(repository).rejects.toThrow("git init failed")
    expect(await exists(base)).toBe(false)
  })
})
