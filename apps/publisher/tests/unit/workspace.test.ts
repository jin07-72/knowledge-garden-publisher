import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import {
  CommandRunnerError,
  createCommandRunner,
  runCommand,
  type CommandProcess,
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

  it("does not advertise Git capability when the selected root is not a directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "garden-workspace-parent-"))
    temporaryDirectories.push(parent)
    const root = join(parent, "not-a-workspace")
    await writeFile(root, "not a directory")

    const result = await inspectWorkspace(root, { checkGit: true })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("INVALID_WORKSPACE")
    expect(result.capabilities.git).toBe(false)
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
        if (args[0] === "remote" && args.length === 1) return { exitCode: 0, stdout: "origin\n", stderr: "" }
        if (args[0] === "remote") return { exitCode: 1, stdout: "", stderr: "任意语言的失败" }
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    }

    const result = await inspectWorkspace(root, { checkGit: true, runner })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("GIT_ORIGIN_FAILED")
    expect(result.capabilities.git).toBe(false)
  })

  it("does not mistake a failed remote listing for a missing origin", async () => {
    const root = await createGarden()
    const runner: CommandRunner = {
      run: async ({ args }) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
        if (args[0] === "remote") return { exitCode: 1, stdout: "", stderr: "任意语言的失败" }
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    }

    const result = await inspectWorkspace(root, { checkGit: true, runner })

    expect(result.issues.map((issue) => issue.code)).toContain("GIT_ORIGIN_FAILED")
    expect(result.issues.map((issue) => issue.code)).not.toContain("GIT_ORIGIN_MISSING")
  })

  it("reports git status failures from an injected runner", async () => {
    const root = await createGarden()
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const runner: CommandRunner = {
      run: async (request) => {
        requests.push(request)
        const { args } = request
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
        if (args[0] === "remote" && args.length === 1) return { exitCode: 0, stdout: "origin\n", stderr: "" }
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
        args: ["remote"],
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

  it("accepts a canonical Git root reached through a directory alias", async ({ skip }) => {
    const repository = await createTemporaryGitRepository()
    temporaryRepositories.push(repository)
    await createGarden(repository.root)
    const alias = join(repository.root, "..", "garden-alias")
    try {
      await symlink(repository.root, alias, process.platform === "win32" ? "junction" : "dir")
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    const result = await inspectWorkspace(alias, { checkGit: true })

    expect(result.ok).toBe(true)
  })

  it.skipIf(process.platform !== "win32")("accepts a Git root whose reported path differs only by case", async () => {
    const root = await createGarden()
    const runner: CommandRunner = {
      run: async ({ args }) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root.toUpperCase()}\n`, stderr: "" }
        if (args[0] === "remote" && args.length === 1) return { exitCode: 0, stdout: "origin\n", stderr: "" }
        return { exitCode: 0, stdout: "https://example.invalid/garden.git\n", stderr: "" }
      }
    }

    const result = await inspectWorkspace(root, { checkGit: true, runner })

    expect(result.ok).toBe(true)
  })

  it("rejects a required file symlink even when it resolves inside the workspace", async ({ skip }) => {
    const root = await createGarden()
    const target = join(root, "quartz.config.real.yaml")
    const linkedPath = join(root, "quartz.config.yaml")
    await writeFile(target, "configuration: {}")
    await rm(linkedPath)
    try {
      await symlink(target, linkedPath, "file")
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("UNSAFE_PATH")
    expect(result.capabilities).toMatchObject({ files: false, preview: false })
  })

  it("rejects a required directory junction or symlink outside the workspace", async ({ skip }) => {
    const root = await createGarden()
    const outside = await mkdtemp(join(tmpdir(), "garden-outside-"))
    temporaryDirectories.push(outside)
    const content = join(root, "content")
    await rm(content, { force: true, recursive: true })
    try {
      await symlink(outside, content, process.platform === "win32" ? "junction" : "dir")
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }

    const result = await inspectWorkspace(root, { checkGit: false })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("UNSAFE_PATH")
    expect(result.capabilities.files).toBe(false)
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

  it("waits for the direct child to close before settling cancellation", async () => {
    const child = new EventEmitter() as EventEmitter & CommandProcess
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    let killCalls = 0
    child.kill = () => {
      killCalls += 1
      return true
    }
    const runner = createCommandRunner(() => child)
    const controller = new AbortController()
    const command = runner.run({ executable: "ignored", args: [], cwd: process.cwd(), signal: controller.signal })
    let settled = false
    void command.catch(() => {
      settled = true
    })

    controller.abort()
    await Promise.resolve()
    expect(killCalls).toBe(1)
    expect(settled).toBe(false)

    child.emit("close", null)
    await expect(command).rejects.toMatchObject({ code: "COMMAND_CANCELLED" })
  })

  it("reports a termination failure when the child errors after a successful kill request", async () => {
    const child = new EventEmitter() as EventEmitter & CommandProcess
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const runner = createCommandRunner(() => child)
    const controller = new AbortController()
    const command = runner.run({ executable: "ignored", args: [], cwd: process.cwd(), signal: controller.signal })

    controller.abort()
    child.emit("error")

    await expect(command).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "Command termination was not confirmed.",
      details: { reason: "termination" }
    })
  })

  it.each([
    ["returns false", () => false],
    ["throws", () => {
      throw new Error("kill failed")
    }]
  ])("reports a termination failure when kill %s", async (_description, kill) => {
    const child = new EventEmitter() as EventEmitter & CommandProcess
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = kill
    const runner = createCommandRunner(() => child)
    const controller = new AbortController()

    const command = runner.run({ executable: "ignored", args: [], cwd: process.cwd(), signal: controller.signal })
    controller.abort()

    await expect(command).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "Command termination was not confirmed.",
      details: { reason: "termination" }
    })
  })

  it("settles as cancelled when close fires synchronously during kill", async () => {
    const child = new EventEmitter() as EventEmitter & CommandProcess
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {
      child.emit("close", null)
      return true
    }
    const runner = createCommandRunner(() => child)
    const controller = new AbortController()
    const command = runner.run({ executable: "ignored", args: [], cwd: process.cwd(), signal: controller.signal })

    controller.abort()

    await expect(command).rejects.toMatchObject({ code: "COMMAND_CANCELLED" })
  })

  it("settles once and removes abort handling after cancellation closes", async () => {
    const child = new EventEmitter() as EventEmitter & CommandProcess
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    let killCalls = 0
    child.kill = () => {
      killCalls += 1
      return true
    }
    const runner = createCommandRunner(() => child)
    const controller = new AbortController()
    const command = runner.run({ executable: "ignored", args: [], cwd: process.cwd(), signal: controller.signal })
    let rejectionCount = 0
    void command.catch(() => {
      rejectionCount += 1
    })

    controller.abort()
    controller.abort()
    child.emit("close", null)
    await command.catch(() => undefined)
    controller.abort()
    await Promise.resolve()

    expect(killCalls).toBe(1)
    expect(rejectionCount).toBe(1)
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

  it("does not invoke an injected spawner for an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    let spawnCalls = 0
    const runner = createCommandRunner(() => {
      spawnCalls += 1
      throw new Error("must not spawn")
    })

    await expect(
      runner.run({ executable: "ignored", args: [], cwd: process.cwd(), signal: controller.signal })
    ).rejects.toMatchObject({ code: "COMMAND_CANCELLED" })
    expect(spawnCalls).toBe(0)
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
    expect(requests.every((request) => request.env?.GIT_CONFIG_NOSYSTEM === "1")).toBe(true)
    expect(requests.every((request) => request.env?.GIT_CONFIG_GLOBAL === join(repository.root, "..", "empty-global.gitconfig"))).toBe(true)
    expect(await exists(join(repository.root, "..", "empty-global.gitconfig"))).toBe(true)
  })

  it("does not permit caller Git configuration overrides", async () => {
    const root = await createGarden()
    const callerGlobalConfig = join(root, "caller-global.gitconfig")
    await writeFile(callerGlobalConfig, "[user]\nname = Caller Override\n")

    const result = await git(root, ["config", "--global", "--get", "user.name"], {
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_GLOBAL: callerGlobalConfig
    })

    expect(result.exitCode).toBe(1)
  })

  it("does not create a Git configuration artifact in the command cwd", async () => {
    const root = await createGarden()
    const before = await readdir(root)

    const result = await git(root, ["--version"])

    expect(result.exitCode).toBe(0)
    expect(await readdir(root)).toEqual(before)
  })

  it("neutralizes command-scope Git configuration inherited through the helper arguments", async () => {
    const root = await createGarden()

    const result = await git(root, ["config", "user.name"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Caller Injection",
      GIT_CONFIG_PARAMETERS: "'user.name'='Caller Parameters'"
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
  })

  it("neutralizes command-scope Git configuration inherited from the process environment", async () => {
    const root = await createGarden()
    const previous = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
      parameters: process.env.GIT_CONFIG_PARAMETERS
    }
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Process Injection",
      GIT_CONFIG_PARAMETERS: "'user.name'='Process Parameters'"
    })
    try {
      const result = await git(root, ["config", "user.name"])

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        const key = `GIT_CONFIG_${name === "count" ? "COUNT" : name === "key" ? "KEY_0" : name === "value" ? "VALUE_0" : "PARAMETERS"}`
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
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
