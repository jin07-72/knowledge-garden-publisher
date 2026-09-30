import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { EventEmitter } from "node:events"
import { basename, dirname, join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, type CommandRequest } from "../../src/main/lib/commandRunner"
import {
  Publisher,
  PublishError,
  createBoundedPublishCommandRunner,
  createProductionPublisher,
  createPublisherForTest,
  resolveProductionPublishRuntime,
  type PublishCommandProcess,
  type PublishPhase,
  type PublisherTestDependencies,
} from "../../src/main/services/publish"
import { createTemporaryGitRepository, git, type TemporaryGitRepository } from "../helpers/git"

const repositories: TemporaryGitRepository[] = []
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, contents)
}

async function output(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args)
  expect(result.exitCode, `git ${args.join(" ")}`).toBe(0)
  return result.stdout.trim()
}

async function fixture(): Promise<TemporaryGitRepository> {
  const repository = await createTemporaryGitRepository()
  repositories.push(repository)
  await put(
    repository.root,
    ".gitignore",
    "node_modules/\nprivate/*\n!private/.gitkeep\n.garden-publisher/\napps/publisher/vendor/\n",
  )
  await put(
    repository.root,
    "package.json",
    JSON.stringify({ scripts: { "verify:site": "exit 0" } }),
  )
  await put(
    repository.root,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: {} }),
  )
  await put(repository.root, "content/technology/css-grid.md", "original grid\n")
  await put(repository.root, "content/life/weekly-review.md", "original weekly\n")
  await put(repository.root, "content/reading/delete-me.md", "delete me\n")
  await put(repository.root, "private/.gitkeep", "")
  await mkdir(join(repository.root, "node_modules"), { recursive: true })
  await put(repository.root, "apps/publisher/vendor/node/node.exe", "test runtime")
  await put(
    repository.root,
    "apps/publisher/vendor/node/node_modules/npm/bin/npm-cli.js",
    "test npm",
  )
  expect((await git(repository.root, ["add", "."])).exitCode).toBe(0)
  expect((await git(repository.root, ["commit", "-m", "initial"])).exitCode).toBe(0)
  expect((await git(repository.root, ["push", "-u", "origin", "main"])).exitCode).toBe(0)
  return repository
}

function publisher(
  repository: TemporaryGitRepository,
  overrides: Partial<PublisherTestDependencies> = {},
): Publisher {
  return createPublisherForTest({
    workspace: repository.root,
    runtime: {
      root: join(repository.root, "apps/publisher/vendor/node"),
      nodeExecutable: join(repository.root, "apps/publisher/vendor/node/node.exe"),
      npmCliPath: join(
        repository.root,
        "apps/publisher/vendor/node/node_modules/npm/bin/npm-cli.js",
      ),
      nodeModules: join(repository.root, "node_modules"),
    },
    validateDependencies: async () => true,
    verifySite: async () => ({ exitCode: 0 }),
    ...overrides,
  })
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(repositories.splice(0).map((repository) => repository.cleanup()))
})

describe("production publication runtime", () => {
  it("derives the packaged runtime only from resourcesPath and fixes workspace dependencies", () => {
    const runtime = resolveProductionPublishRuntime({
      workspace: String.raw`C:\Garden`,
      isPackaged: true,
      resourcesPath: String.raw`C:\Program Files\Garden Publisher\resources`,
      appPath: String.raw`C:\ignored-dev-app`,
    })

    expect(runtime).toEqual({
      root: resolve(String.raw`C:\Program Files\Garden Publisher\resources`, "node"),
      nodeExecutable: resolve(
        String.raw`C:\Program Files\Garden Publisher\resources`,
        "node",
        "node.exe",
      ),
      npmCliPath: resolve(
        String.raw`C:\Program Files\Garden Publisher\resources`,
        "node",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
      nodeModules: resolve(String.raw`C:\Garden`, "node_modules"),
    })
  })

  it("derives the development runtime only from appPath/vendor/node", () => {
    const runtime = resolveProductionPublishRuntime({
      workspace: String.raw`C:\Garden`,
      isPackaged: false,
      resourcesPath: String.raw`C:\ignored-packaged-resources`,
      appPath: String.raw`C:\src\apps\publisher`,
    })

    expect(runtime.root).toBe(resolve(String.raw`C:\src\apps\publisher`, "vendor", "node"))
    expect(runtime.nodeExecutable).toBe(
      resolve(String.raw`C:\src\apps\publisher`, "vendor", "node", "node.exe"),
    )
    expect(runtime.npmCliPath).toBe(
      resolve(
        String.raw`C:\src\apps\publisher`,
        "vendor",
        "node",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    )
  })

  it("rejects an arbitrary declared runtime on the production construction path", () => {
    expect(() =>
      createProductionPublisher({
        workspace: String.raw`C:\Garden`,
        isPackaged: true,
        resourcesPath: String.raw`C:\Program Files\Garden Publisher\resources`,
        appPath: String.raw`C:\src\apps\publisher`,
        runtime: {
          root: String.raw`D:\attacker`,
          nodeExecutable: String.raw`D:\attacker\node.exe`,
          npmCliPath: String.raw`D:\attacker\npm-cli.js`,
          nodeModules: String.raw`D:\attacker\node_modules`,
        },
      } as never),
    ).toThrow(/unsupported production publisher option/i)
  })

  it.each([
    "runner",
    "runtime",
    "verifySite",
    "validateDependencies",
    "createDependencyLink",
    "beforeIndexLockAcquired",
    "beforeDependencyLinkUnlink",
  ])("rejects the production injection field %s at runtime", (field) => {
    expect(() =>
      createProductionPublisher({
        workspace: String.raw`C:\Garden`,
        isPackaged: false,
        resourcesPath: String.raw`C:\resources`,
        appPath: String.raw`C:\app`,
        [field]: field === "runner" ? { run: vi.fn() } : vi.fn(),
      } as never),
    ).toThrow(/unsupported production publisher option/i)
  })

  it("uses the derived bundled runtime for default dependency and site verification commands", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "production commands\n")
    const runtimeRequests: CommandRequest[] = []
    const runtime = resolveProductionPublishRuntime({
      workspace: repository.root,
      isPackaged: false,
      resourcesPath: join(repository.root, "ignored-resources"),
      appPath: join(repository.root, "apps", "publisher"),
    })
    const service = createPublisherForTest({
      workspace: repository.root,
      runtime,
      runner: {
        run: async (request: CommandRequest) => {
          if (request.executable.toLowerCase().endsWith("node.exe")) {
            runtimeRequests.push(request)
            return { exitCode: 0, stdout: "", stderr: "" }
          }
          return runCommand(request)
        },
      },
    })

    await service.publish({ paths: ["content/technology/css-grid.md"] })

    expect(runtimeRequests).toHaveLength(2)
    expect(runtimeRequests[0]).toMatchObject({
      executable: runtime.nodeExecutable,
      args: [runtime.npmCliPath, "ls", "--all", "--json", "--ignore-scripts"],
      cwd: repository.root,
    })
    expect(runtimeRequests[1]).toMatchObject({
      executable: runtime.nodeExecutable,
      args: [runtime.npmCliPath, "run", "verify:site"],
    })
    expect(runtimeRequests[1]?.cwd).toMatch(/[\\/]\.garden-publisher[\\/]publish[\\/]/)
  })

  it("fails before staging when the default bundled dependency check is unsuccessful", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "invalid dependencies\n")
    const runtime = resolveProductionPublishRuntime({
      workspace: repository.root,
      isPackaged: false,
      resourcesPath: join(repository.root, "ignored-resources"),
      appPath: join(repository.root, "apps", "publisher"),
    })
    const service = createPublisherForTest({
      workspace: repository.root,
      runtime,
      runner: {
        run: async (request: CommandRequest) =>
          request.executable.toLowerCase().endsWith("node.exe")
            ? { exitCode: 1, stdout: "", stderr: "dependency mismatch" }
            : runCommand(request),
      },
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "DEPENDENCIES_INVALID" })
    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(
      await output(repository.root, ["rev-parse", "refs/remotes/origin/main"]),
    )
    await expect(
      readdir(join(repository.root, ".garden-publisher", "publish")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps HEAD, index, remote, and operation state unchanged when default verification exits nonzero", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "invalid production site\n")
    const beforeHead = await output(repository.root, ["rev-parse", "HEAD"])
    const beforeIndex = await output(repository.root, ["write-tree"])
    const beforeRemote = await output(repository.root, ["rev-parse", "refs/remotes/origin/main"])
    const runtime = resolveProductionPublishRuntime({
      workspace: repository.root,
      isPackaged: false,
      resourcesPath: join(repository.root, "ignored-resources"),
      appPath: join(repository.root, "apps", "publisher"),
    })
    const runtimeRequests: CommandRequest[] = []
    const service = createPublisherForTest({
      workspace: repository.root,
      runtime,
      runner: {
        run: async (request: CommandRequest) => {
          if (!request.executable.toLowerCase().endsWith("node.exe")) return runCommand(request)
          runtimeRequests.push(request)
          return {
            exitCode: request.args.includes("verify:site") ? 1 : 0,
            stdout: "",
            stderr: "verification failed",
          }
        },
      },
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" })
    expect(runtimeRequests.map((request) => request.args)).toEqual([
      [runtime.npmCliPath, "ls", "--all", "--json", "--ignore-scripts"],
      [runtime.npmCliPath, "run", "verify:site"],
    ])
    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(beforeHead)
    expect(await output(repository.root, ["write-tree"])).toBe(beforeIndex)
    expect(await output(repository.root, ["rev-parse", "refs/remotes/origin/main"])).toBe(
      beforeRemote,
    )
    expect(
      await readdir(join(repository.root, ".garden-publisher", "publish")).catch(() => []),
    ).toEqual([])
  })
})

describe("exact-tree publication", () => {
  it("preserves only the tracked private placeholder while rejecting private note content", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "selected grid\n")

    await expect(
      publisher(repository).publish({ paths: ["content/technology/css-grid.md"] }),
    ).resolves.toMatchObject({ pushed: true })
    expect(
      await output(repository.root, ["ls-tree", "-r", "--name-only", "origin/main", "private"]),
    ).toBe("private/.gitkeep")

    await expect(
      publisher(repository).publish({ paths: ["private/life/journal.md"] }),
    ).rejects.toMatchObject({ code: "PRIVATE_PATH" })
  })
  it("commits and pushes only selected public paths while preserving unrelated and private edits", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "selected grid\n")
    await put(repository.root, "content/life/weekly-review.md", "unselected weekly\n")
    await put(repository.root, "private/life/journal.md", "private secret\n")
    const phases: PublishPhase[] = []

    const result = await publisher(repository, {
      onProgress: (progress) => phases.push(progress.phase),
    }).publish({ paths: ["content/technology/css-grid.md"], message: "Publish grid" })

    expect(
      (await git(repository.root, ["diff", "--name-only", "HEAD^", "HEAD"])).stdout.trim(),
    ).toBe("content/technology/css-grid.md")
    expect(await output(repository.root, ["show", "HEAD:content/technology/css-grid.md"])).toBe(
      "selected grid",
    )
    expect(await readFile(join(repository.root, "content/life/weekly-review.md"), "utf8")).toBe(
      "unselected weekly\n",
    )
    expect(await readFile(join(repository.root, "private/life/journal.md"), "utf8")).toBe(
      "private secret\n",
    )
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(
      await output(repository.root, ["ls-tree", "-r", "--name-only", "HEAD", "private"]),
    ).toBe("private/.gitkeep")
    expect(await output(repository.root, ["rev-parse", "HEAD^{tree}"])).toBe(result.tree)
    expect(await output(repository.root, ["rev-parse", "origin/main"])).toBe(result.commit)
    expect(phases).toEqual([
      "preflight-fetch",
      "stage-temporary-index",
      "write-tree",
      "synthetic-commit",
      "verify-worktree",
      "update-local-ref",
      "push",
      "cleanup",
      "complete",
    ])
  })

  it("publishes an exact selected deletion without including another deletion", async () => {
    const repository = await fixture()
    await unlink(join(repository.root, "content/reading/delete-me.md"))
    await unlink(join(repository.root, "content/life/weekly-review.md"))

    await publisher(repository).publish({ paths: ["content/reading/delete-me.md"] })

    const names = await output(repository.root, ["ls-tree", "-r", "--name-only", "HEAD"])
    expect(names).not.toContain("content/reading/delete-me.md")
    expect(names).toContain("content/life/weekly-review.md")
    await expect(
      readFile(join(repository.root, "content/life/weekly-review.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("publishes both sides of a selected rename without taking unrelated edits", async () => {
    const repository = await fixture()
    await rename(
      join(repository.root, "content/technology/css-grid.md"),
      join(repository.root, "content/technology/grid-layout.md"),
    )
    await put(repository.root, "content/life/weekly-review.md", "unselected\n")

    await publisher(repository).publish({
      paths: ["content/technology/css-grid.md", "content/technology/grid-layout.md"],
    })

    const names = await output(repository.root, ["ls-tree", "-r", "--name-only", "HEAD"])
    expect(names).not.toContain("content/technology/css-grid.md")
    expect(names).toContain("content/technology/grid-layout.md")
    expect(await readFile(join(repository.root, "content/life/weekly-review.md"), "utf8")).toBe(
      "unselected\n",
    )
  })

  it("creates the controlled dependency link and invokes the pinned runtime in the detached tree", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "verify me\n")
    const junction = vi.fn<NonNullable<PublisherTestDependencies["createDependencyLink"]>>(
      async () => undefined,
    )
    const verifySite = vi.fn<NonNullable<PublisherTestDependencies["verifySite"]>>(
      async (request) => {
        expect(await output(request.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD")
        expect(await output(request.cwd, ["show", "HEAD:content/technology/css-grid.md"])).toBe(
          "verify me",
        )
        return { exitCode: 0 }
      },
    )

    await publisher(repository, { createDependencyLink: junction, verifySite }).publish({
      paths: ["content/technology/css-grid.md"],
    })

    expect(junction).toHaveBeenCalledOnce()
    expect(junction.mock.calls[0]![0]).toMatchObject({
      target: join(repository.root, "node_modules"),
      type: "junction",
    })
    expect(junction.mock.calls[0]![0].link).toMatch(
      /[\\/]\.garden-publisher[\\/]publish[\\/].+[\\/]verify[\\/]node_modules$/,
    )
    expect(verifySite).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: join(repository.root, "apps/publisher/vendor/node/node.exe"),
        args: [
          join(repository.root, "apps/publisher/vendor/node/node_modules/npm/bin/npm-cli.js"),
          "run",
          "verify:site",
        ],
      }),
    )
  })

  it("does not update the real branch when site validation fails and removes its operation directory", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    const beforeIndex = await output(repository.root, ["write-tree"])
    const beforeRemote = await output(repository.root, ["rev-parse", "refs/remotes/origin/main"])
    await put(repository.root, "content/technology/css-grid.md", "invalid site\n")

    await expect(
      publisher(repository, { verifySite: async () => ({ exitCode: 1 }) }).publish({
        paths: ["content/technology/css-grid.md"],
      }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" })

    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(before)
    expect(await output(repository.root, ["write-tree"])).toBe(beforeIndex)
    expect(await output(repository.root, ["rev-parse", "refs/remotes/origin/main"])).toBe(
      beforeRemote,
    )
    const publishRoot = join(repository.root, ".garden-publisher", "publish")
    expect(await readdir(publishRoot).catch(() => [])).toEqual([])
  })

  it("regenerates the install index after verification corrupts the staging index", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "verified selection\n")
    await put(repository.root, "content/life/weekly-review.md", "unselected change\n")

    await publisher(repository, {
      verifySite: async ({ cwd }) => {
        await writeFile(join(dirname(cwd), "temporary.index"), "attacker controlled bytes")
        return { exitCode: 0 }
      },
    }).publish({ paths: ["content/technology/css-grid.md"] })

    expect(await output(repository.root, ["show", "HEAD:content/technology/css-grid.md"])).toBe(
      "verified selection",
    )
    expect(await output(repository.root, ["show", "HEAD:content/life/weekly-review.md"])).toBe(
      "original weekly",
    )
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
  })

  it("never installs a different valid index substituted by verification", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "verified selection\n")
    await put(repository.root, "private/life/journal.md", "private secret\n")

    await publisher(repository, {
      verifySite: async ({ cwd }) => {
        const operationRoot = dirname(cwd)
        const maliciousIndex = join(operationRoot, "malicious.index")
        const env = { GIT_INDEX_FILE: maliciousIndex }
        expect((await git(repository.root, ["read-tree", "HEAD"], env)).exitCode).toBe(0)
        expect(
          (await git(repository.root, ["add", "-f", "--", "private/life/journal.md"], env))
            .exitCode,
        ).toBe(0)
        await rm(join(operationRoot, "temporary.index"), { force: true })
        await rename(maliciousIndex, join(operationRoot, "temporary.index"))
        return { exitCode: 0 }
      },
    }).publish({ paths: ["content/technology/css-grid.md"] })

    const names = await output(repository.root, ["ls-tree", "-r", "--name-only", "HEAD"])
    expect(names).not.toContain("private/life/journal.md")
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
  })

  it("never follows a staging-index symlink substituted by verification", async ({ skip }) => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "verified selection\n")

    await publisher(repository, {
      verifySite: async ({ cwd }) => {
        const operationRoot = dirname(cwd)
        const temporaryIndex = join(operationRoot, "temporary.index")
        const attackerIndex = join(operationRoot, "attacker.index")
        await writeFile(attackerIndex, "attacker controlled bytes")
        await rm(temporaryIndex, { force: true })
        try {
          await symlink(attackerIndex, temporaryIndex, "file")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") skip()
          throw error
        }
        return { exitCode: 0 }
      },
    }).publish({ paths: ["content/technology/css-grid.md"] })

    expect(await output(repository.root, ["show", "HEAD:content/technology/css-grid.md"])).toBe(
      "verified selection",
    )
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
  })

  it("pushes the verified commit instead of a concurrently switched HEAD and confirms its remote tree", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "verified publication\n")
    let switched = false
    const pushRequests: CommandRequest[] = []
    const runner = {
      run: async (request: CommandRequest) => {
        if (request.executable === "git" && request.args[0] === "push") {
          pushRequests.push(request)
          if (!switched) {
            switched = true
            const parent = await output(repository.root, ["rev-parse", "refs/heads/main^"])
            expect(
              (await git(repository.root, ["update-ref", "refs/heads/attacker", parent])).exitCode,
            ).toBe(0)
            expect(
              (await git(repository.root, ["symbolic-ref", "HEAD", "refs/heads/attacker"]))
                .exitCode,
            ).toBe(0)
          }
        }
        return runCommand(request)
      },
    }

    const result = await publisher(repository, { runner }).publish({
      paths: ["content/technology/css-grid.md"],
    })

    expect(pushRequests).toHaveLength(1)
    expect(pushRequests[0]!.args).toContain(`${result.commit}:refs/heads/main`)
    expect(await output(repository.root, ["rev-parse", "refs/remotes/origin/main"])).toBe(
      result.commit,
    )
    expect(await output(repository.root, ["rev-parse", "refs/remotes/origin/main^{tree}"])).toBe(
      result.tree,
    )
    expect(await output(repository.root, ["rev-parse", "HEAD"])).not.toBe(result.commit)
  })

  it("finishes atomic ref/index installation after caller cancellation and retains the verified commit for retry", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    await put(repository.root, "content/technology/css-grid.md", "cancel after ref\n")
    const controller = new AbortController()
    let cancelledAfterRef = false
    const runner = {
      run: async (request: CommandRequest) => {
        const result = await runCommand(request)
        if (
          !cancelledAfterRef &&
          request.executable === "git" &&
          request.args[0] === "update-ref" &&
          request.args[1] === "refs/heads/main" &&
          result.exitCode === 0
        ) {
          cancelledAfterRef = true
          controller.abort()
        }
        return result
      },
    }
    const service = publisher(repository, { runner })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"], signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PUBLISH_CANCELLED" })

    const retained = await output(repository.root, ["rev-parse", "refs/heads/main"])
    expect(retained).not.toBe(before)
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
    const retried = await service.retryPush()
    expect(retried.commit).toBe(retained)
    expect(await output(repository.root, ["rev-parse", "refs/remotes/origin/main"])).toBe(retained)
  })

  it("uses a bounded independent recovery signal when index installation times out after ref update", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    await put(repository.root, "content/technology/css-grid.md", "critical timeout\n")
    let blockIndexInstall = true
    const runner = {
      run: async (request: CommandRequest) => {
        if (
          blockIndexInstall &&
          request.executable === "git" &&
          request.args[0] === "update-ref" &&
          request.args[1] === "refs/heads/main"
        ) {
          const result = await runCommand(request)
          expect(result.exitCode).toBe(0)
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          blockIndexInstall = false
          throw new Error("critical install timed out")
        }
        return runCommand(request)
      },
    }

    await expect(
      publisher(repository, { runner, criticalSectionTimeoutMs: 50 }).publish({
        paths: ["content/technology/css-grid.md"],
      }),
    ).rejects.toMatchObject({ code: "REF_UPDATE_FAILED" })

    expect(await output(repository.root, ["rev-parse", "refs/heads/main"])).toBe(before)
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
  })

  it("uses the real Git index lock, rechecks staged state inside it, and preserves a concurrent intent", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "selected\n")
    await put(repository.root, "content/life/weekly-review.md", "concurrent intent\n")
    let stagedChecks = 0
    let concurrentStageExit: number | undefined
    let lockObserved = false
    const runner = {
      run: async (request: CommandRequest) => {
        if (
          request.executable === "git" &&
          request.args[0] === "diff" &&
          request.args[1] === "--cached" &&
          request.args.includes("--quiet")
        ) {
          stagedChecks += 1
          if (stagedChecks === 2) {
            lockObserved = await lstat(join(repository.root, ".git", "index.lock")).then(
              () => true,
              () => false,
            )
            concurrentStageExit = (
              await git(repository.root, ["add", "content/life/weekly-review.md"])
            ).exitCode
          }
        }
        return runCommand(request)
      },
    }

    await publisher(repository, { runner }).publish({
      paths: ["content/technology/css-grid.md"],
    })

    expect(lockObserved).toBe(true)
    expect(concurrentStageExit).not.toBe(0)
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(await readFile(join(repository.root, "content/life/weekly-review.md"), "utf8")).toBe(
      "concurrent intent\n",
    )
  })

  it("rejects a branch switch in the window before index-lock acquisition without changing either branch or index", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "refs/heads/main"])
    await put(repository.root, "content/technology/css-grid.md", "branch race\n")
    let switched = false
    const service = publisher(repository, {
      beforeIndexLockAcquired: async () => {
        expect((await git(repository.root, ["switch", "-c", "attacker"])).exitCode).toBe(0)
        switched = true
      },
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "REF_CHANGED" })

    expect(switched).toBe(true)
    expect(await output(repository.root, ["rev-parse", "refs/heads/main"])).toBe(before)
    expect(await output(repository.root, ["rev-parse", "refs/heads/attacker"])).toBe(before)
    expect(await output(repository.root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("attacker")
    expect(await output(repository.root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(await readFile(join(repository.root, "content/technology/css-grid.md"), "utf8")).toBe(
      "branch race\n",
    )
  })

  it("does not remove or overwrite a foreign Git index lock", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    await put(repository.root, "content/technology/css-grid.md", "selected\n")
    const lock = join(repository.root, ".git", "index.lock")
    let installedForeignLock = false
    const runner = {
      run: async (request: CommandRequest) => {
        const result = await runCommand(request)
        if (
          !installedForeignLock &&
          request.executable === "git" &&
          request.args[0] === "rev-parse" &&
          request.args[1] === "--absolute-git-dir" &&
          result.exitCode === 0
        ) {
          installedForeignLock = true
          await writeFile(lock, "foreign lock")
        }
        return result
      },
    }

    await expect(
      publisher(repository, { runner }).publish({
        paths: ["content/technology/css-grid.md"],
      }),
    ).rejects.toMatchObject({ code: "INDEX_LOCKED" })

    expect(await readFile(lock, "utf8")).toBe("foreign lock")
    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(before)
    await unlink(lock)
  })

  it("retains the installed commit but fails closed when final tree confirmation is uncertain", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    await put(repository.root, "content/technology/css-grid.md", "uncertain final tree\n")
    let failConfirmation = true
    const runner = {
      run: async (request: CommandRequest) => {
        if (
          failConfirmation &&
          request.executable === "git" &&
          request.args[0] === "rev-parse" &&
          request.args[2] === "refs/heads/main^{tree}"
        ) {
          failConfirmation = false
          return { exitCode: 1, stdout: "", stderr: "uncertain" }
        }
        return runCommand(request)
      },
    }
    const service = publisher(repository, { runner })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "REF_UPDATE_FAILED" })
    expect(await output(repository.root, ["rev-parse", "refs/heads/main"])).not.toBe(before)
    await expect(service.retryPush()).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
  })

  it("blocks real staged changes before creating a publication commit", async () => {
    const repository = await fixture()
    await put(repository.root, "content/life/weekly-review.md", "staged elsewhere\n")
    expect((await git(repository.root, ["add", "content/life/weekly-review.md"])).exitCode).toBe(0)
    await put(repository.root, "content/technology/css-grid.md", "selected\n")
    const before = await output(repository.root, ["rev-parse", "HEAD"])

    await expect(
      publisher(repository).publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "STAGED_CHANGES" })
    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(before)
  })

  it.each([
    {
      name: "a non-main branch",
      prepare: async (root: string) => git(root, ["switch", "-c", "draft"]),
      code: "BRANCH_UNSAFE",
    },
    {
      name: "detached HEAD",
      prepare: async (root: string) => git(root, ["switch", "--detach"]),
      code: "DETACHED_HEAD",
    },
  ])("blocks $name", async ({ prepare, code }) => {
    const repository = await fixture()
    expect((await prepare(repository.root)).exitCode).toBe(0)
    await put(repository.root, "content/technology/css-grid.md", "selected\n")
    await expect(
      publisher(repository).publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code })
  })

  it("fetches first and blocks remote divergence without creating a local commit", async () => {
    const repository = await fixture()
    const peer = await createTemporaryGitRepository()
    repositories.push(peer)
    await rm(peer.root, { force: true, recursive: true })
    expect((await git(dirname(peer.root), ["clone", repository.remote, peer.root])).exitCode).toBe(
      0,
    )
    expect((await git(peer.root, ["config", "user.name", "Garden Peer"])).exitCode).toBe(0)
    expect((await git(peer.root, ["config", "user.email", "peer@example.invalid"])).exitCode).toBe(
      0,
    )
    await put(peer.root, "remote.md", "remote advance\n")
    expect((await git(peer.root, ["add", "remote.md"])).exitCode).toBe(0)
    expect((await git(peer.root, ["commit", "-m", "remote advance"])).exitCode).toBe(0)
    expect((await git(peer.root, ["push", "origin", "main"])).exitCode).toBe(0)
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    await put(repository.root, "content/technology/css-grid.md", "selected\n")

    await expect(
      publisher(repository).publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "REMOTE_DIVERGED" })
    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(before)
  })

  it("keeps the verified local commit after push failure and can retry that exact commit", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "retry me\n")
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    let failPush = true
    let holdRetry = false
    let releaseRetry: (() => void) | undefined
    const commands: CommandRequest[] = []
    const runner = {
      run: async (request: CommandRequest) => {
        commands.push(request)
        if (request.executable === "git" && request.args[0] === "fetch" && holdRetry) {
          await new Promise<void>((resolve) => {
            releaseRetry = resolve
          })
        }
        if (request.executable === "git" && request.args[0] === "push" && failPush) {
          return { exitCode: 1, stdout: "", stderr: "secret credential diagnostic" }
        }
        return runCommand(request)
      },
    }
    const service = publisher(repository, { runner })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "PUSH_FAILED", message: expect.not.stringContaining("secret") })
    const retained = await output(repository.root, ["rev-parse", "HEAD"])
    expect(retained).not.toBe(before)
    expect(await output(repository.root, ["rev-parse", "origin/main"])).toBe(before)

    failPush = false
    holdRetry = true
    const retry = service.retryPush()
    await vi.waitFor(() => expect(releaseRetry).toBeTypeOf("function"))
    await expect(service.retryPush()).rejects.toMatchObject({ code: "PUBLISH_ACTIVE" })
    const parent = await output(repository.root, ["rev-parse", "refs/heads/main^"])
    expect(
      (await git(repository.root, ["update-ref", "refs/heads/attacker", parent])).exitCode,
    ).toBe(0)
    expect(
      (await git(repository.root, ["symbolic-ref", "HEAD", "refs/heads/attacker"])).exitCode,
    ).toBe(0)
    holdRetry = false
    releaseRetry?.()
    const retried = await retry
    expect(retried.commit).toBe(retained)
    expect(await output(repository.root, ["rev-parse", "origin/main"])).toBe(retained)
    expect(await output(repository.root, ["rev-parse", "origin/main^{tree}"])).toBe(retried.tree)
    const pushArguments = commands
      .filter((request) => request.args[0] === "push")
      .flatMap((request) => request.args)
    expect(pushArguments).not.toContain("--force")
    expect(commands.map((request) => request.args[0])).not.toContain("reset")
  })

  it.each([
    { path: "private/life/journal.md", code: "PRIVATE_PATH" },
    { path: "Private/life/journal.md", code: "PRIVATE_PATH" },
    { path: "../outside.md", code: "UNSAFE_PATH" },
    { path: ".git/config", code: "UNSAFE_PATH" },
    { path: ".garden-publisher/publish/foreign", code: "UNSAFE_PATH" },
  ])("rejects unsafe selection $path", async ({ path, code }) => {
    const repository = await fixture()
    await expect(publisher(repository).publish({ paths: [path] })).rejects.toMatchObject({ code })
  })

  it("fails runtime and dependency checks before staging a temporary index", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "selected\n")
    const missing = publisher(repository, {
      runtime: {
        root: join(repository.root, "apps/publisher/vendor/node"),
        nodeExecutable: join(repository.root, "missing-node.exe"),
        npmCliPath: join(repository.root, "missing-npm.js"),
        nodeModules: join(repository.root, "node_modules"),
      },
    })
    await expect(
      missing.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "RUNTIME_MISSING" })

    await expect(
      publisher(repository, { validateDependencies: async () => false }).publish({
        paths: ["content/technology/css-grid.md"],
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCIES_INVALID" })
    expect(
      await readdir(join(repository.root, ".garden-publisher", "publish")).catch(() => []),
    ).toEqual([])
  })

  it.each([
    {
      name: "node executable outside its declared bundle root",
      runtime: async (repository: TemporaryGitRepository) => {
        await put(repository.root, "arbitrary/node.exe", "not bundled")
        return {
          root: join(repository.root, "apps/publisher/vendor/node"),
          nodeExecutable: join(repository.root, "arbitrary/node.exe"),
          npmCliPath: join(
            repository.root,
            "apps/publisher/vendor/node/node_modules/npm/bin/npm-cli.js",
          ),
          nodeModules: join(repository.root, "node_modules"),
        }
      },
    },
    {
      name: "npm CLI outside its fixed bundle location",
      runtime: async (repository: TemporaryGitRepository) => {
        await put(repository.root, "apps/publisher/vendor/node/arbitrary-npm.js", "not npm")
        return {
          root: join(repository.root, "apps/publisher/vendor/node"),
          nodeExecutable: join(repository.root, "apps/publisher/vendor/node/node.exe"),
          npmCliPath: join(repository.root, "apps/publisher/vendor/node/arbitrary-npm.js"),
          nodeModules: join(repository.root, "node_modules"),
        }
      },
    },
    {
      name: "dependency directory outside workspace root",
      runtime: async (repository: TemporaryGitRepository) => {
        const outside = join(dirname(repository.root), "outside-modules")
        await mkdir(outside)
        return {
          root: join(repository.root, "apps/publisher/vendor/node"),
          nodeExecutable: join(repository.root, "apps/publisher/vendor/node/node.exe"),
          npmCliPath: join(
            repository.root,
            "apps/publisher/vendor/node/node_modules/npm/bin/npm-cli.js",
          ),
          nodeModules: outside,
        }
      },
    },
  ])("rejects $name before staging", async ({ runtime }) => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "selected\n")

    await expect(
      publisher(repository, { runtime: await runtime(repository) }).publish({
        paths: ["content/technology/css-grid.md"],
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_MISSING" })
    expect(
      await readdir(join(repository.root, ".garden-publisher", "publish")).catch(() => []),
    ).toEqual([])
  })

  it.skipIf(process.platform !== "win32")(
    "creates and removes a real Windows node_modules junction inside the verification worktree",
    async () => {
      const repository = await fixture()
      await put(repository.root, "content/technology/css-grid.md", "junction verify\n")
      let observed = false
      const service = publisher(repository, {
        verifySite: async ({ cwd }) => {
          const link = join(cwd, "node_modules")
          const details = await lstat(link)
          expect(details.isSymbolicLink()).toBe(true)
          expect((await realpath(link)).toLowerCase()).toBe(
            (await realpath(join(repository.root, "node_modules"))).toLowerCase(),
          )
          observed = true
          return { exitCode: 0 }
        },
      })

      await service.publish({ paths: ["content/technology/css-grid.md"] })

      expect(observed).toBe(true)
      expect(await readdir(join(repository.root, ".garden-publisher", "publish"))).toEqual([])
    },
  )

  it.skipIf(process.platform !== "win32")(
    "rejects runtime and workspace dependency junction escapes before staging",
    async () => {
      const runtimeRepository = await fixture()
      await put(runtimeRepository.root, "content/technology/css-grid.md", "selected\n")
      const runtimeRoot = join(runtimeRepository.root, "apps/publisher/vendor/node")
      const outsideRuntime = join(dirname(runtimeRepository.root), "outside-runtime")
      await mkdir(join(outsideRuntime, "node_modules/npm/bin"), { recursive: true })
      await writeFile(join(outsideRuntime, "node.exe"), "outside")
      await writeFile(join(outsideRuntime, "node_modules/npm/bin/npm-cli.js"), "outside")
      await rm(runtimeRoot, { recursive: true })
      await symlink(outsideRuntime, runtimeRoot, "junction")

      await expect(
        publisher(runtimeRepository).publish({ paths: ["content/technology/css-grid.md"] }),
      ).rejects.toMatchObject({ code: "RUNTIME_MISSING" })

      const modulesRepository = await fixture()
      await put(modulesRepository.root, "content/technology/css-grid.md", "selected\n")
      const outsideModules = join(dirname(modulesRepository.root), "outside-dependencies")
      await mkdir(outsideModules)
      await rm(join(modulesRepository.root, "node_modules"), { recursive: true })
      await symlink(outsideModules, join(modulesRepository.root, "node_modules"), "junction")

      await expect(
        publisher(modulesRepository).publish({ paths: ["content/technology/css-grid.md"] }),
      ).rejects.toMatchObject({ code: "RUNTIME_MISSING" })
    },
  )

  it("cancels a hung verification within the operation deadline without updating HEAD", async () => {
    const repository = await fixture()
    const before = await output(repository.root, ["rev-parse", "HEAD"])
    await put(repository.root, "content/technology/css-grid.md", "timeout\n")
    const service = publisher(repository, {
      timeoutMs: 100,
      verifySite: () => new Promise(() => undefined),
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "PUBLISH_TIMEOUT" })
    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(before)
    expect(
      await readdir(join(repository.root, ".garden-publisher", "publish")).catch(() => []),
    ).toEqual([])
  })

  it("rejects a pre-existing publication-root junction and never removes its target", async ({
    skip,
  }) => {
    const repository = await fixture()
    const outside = join(dirname(repository.root), "outside-state")
    await mkdir(outside)
    await put(outside, "marker.txt", "keep")
    await mkdir(join(repository.root, ".garden-publisher"))
    try {
      await symlink(
        outside,
        join(repository.root, ".garden-publisher", "publish"),
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") skip()
      throw error
    }
    await put(repository.root, "content/technology/css-grid.md", "selected\n")

    await expect(
      publisher(repository).publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" })
    expect(await readFile(join(outside, "marker.txt"), "utf8")).toBe("keep")
  })

  it("fails cleanup closed if verification replaces the publication root", async ({ skip }) => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "cleanup race\n")
    let outsideSentinel = ""
    const service = publisher(repository, {
      verifySite: async ({ cwd }) => {
        const operationRoot = dirname(cwd)
        const publishRoot = dirname(operationRoot)
        const parkedRoot = join(dirname(publishRoot), "publish-parked")
        const outside = join(dirname(repository.root), "outside-cleanup-target")
        const fakeOperation = join(outside, basename(operationRoot))
        outsideSentinel = join(fakeOperation, "sentinel.txt")
        await mkdir(fakeOperation, { recursive: true })
        await writeFile(outsideSentinel, "keep")
        try {
          await rename(publishRoot, parkedRoot)
          await symlink(outside, publishRoot, process.platform === "win32" ? "junction" : "dir")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") skip()
          throw error
        }
        return { exitCode: 1 }
      },
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" })
    expect(await readFile(outsideSentinel, "utf8")).toBe("keep")
    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
  })

  it("does not unlink a dependency link replaced immediately before cleanup", async ({ skip }) => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "dependency cleanup race\n")
    const outside = join(dirname(repository.root), "outside-dependency-target")
    const sentinel = join(outside, "sentinel.txt")
    await mkdir(outside)
    await writeFile(sentinel, "keep")
    let attackedLink = ""
    let hookCalled = false
    const service = publisher(repository, {
      verifySite: async () => ({ exitCode: 1 }),
      beforeDependencyLinkUnlink: async ({ link }) => {
        hookCalled = true
        attackedLink = link
        await unlink(link)
        try {
          await symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") skip()
          throw error
        }
      },
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" })
    expect(hookCalled).toBe(true)
    expect(await readFile(sentinel, "utf8")).toBe("keep")
    expect((await lstat(attackedLink)).isSymbolicLink()).toBe(true)
    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
  })

  it("does not recursively remove a substituted operation after cleanup validation", async ({
    skip,
  }) => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "cleanup late race\n")
    let outsideSentinel = ""
    let replaced = false
    const runner = {
      run: async (request: CommandRequest) => {
        if (
          !replaced &&
          request.executable === "git" &&
          request.args[0] === "worktree" &&
          request.args[1] === "remove"
        ) {
          const verify = request.args.at(-1)!
          const operationRoot = dirname(verify)
          const publishRoot = dirname(operationRoot)
          const parkedRoot = join(dirname(publishRoot), "publish-late-parked")
          const outside = join(dirname(repository.root), "outside-late-cleanup-target")
          const fakeOperation = join(outside, basename(operationRoot))
          const fakeVerify = join(fakeOperation, "verify")
          outsideSentinel = join(fakeVerify, "sentinel.txt")
          await mkdir(fakeVerify, { recursive: true })
          await writeFile(outsideSentinel, "keep")
          try {
            await rename(publishRoot, parkedRoot)
            await symlink(outside, publishRoot, process.platform === "win32" ? "junction" : "dir")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") skip()
            throw error
          }
          replaced = true
        }
        return runCommand(request)
      },
    }
    const service = publisher(repository, {
      runner,
      verifySite: async () => ({ exitCode: 1 }),
    })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" })
    expect(replaced).toBe(true)
    expect(await readFile(outsideSentinel, "utf8")).toBe("keep")
    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
  })

  it("is single-flight and supports explicit cancellation", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "cancel\n")
    const entered = vi.fn()
    const service = publisher(repository, {
      verifySite: ({ signal }) =>
        new Promise((resolve) => {
          entered()
          signal.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true })
        }),
    })
    const operation = service.publish({ paths: ["content/technology/css-grid.md"] })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce(), { timeout: 10_000 })
    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "PUBLISH_ACTIVE" })
    await service.cancel()
    await expect(operation).rejects.toMatchObject({ code: "PUBLISH_CANCELLED" })
  })

  it("fails closed after cancelled cleanup cannot remove its verification worktree", async () => {
    const repository = await fixture()
    await put(repository.root, "content/technology/css-grid.md", "cancel cleanup\n")
    let verifyCalls = 0
    const entered = vi.fn()
    const runner = {
      run: async (request: CommandRequest) => {
        if (
          request.executable === "git" &&
          request.args[0] === "worktree" &&
          request.args[1] === "remove"
        ) {
          return { exitCode: 1, stdout: "", stderr: "cleanup diagnostic" }
        }
        return runCommand(request)
      },
    }
    const service = publisher(repository, {
      runner,
      verifySite: ({ signal }) => {
        verifyCalls += 1
        if (verifyCalls > 1) return Promise.resolve({ exitCode: 0 })
        return new Promise((resolve) => {
          entered()
          signal.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true })
        })
      },
    })
    const operation = service.publish({ paths: ["content/technology/css-grid.md"] })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce(), { timeout: 10_000 })
    await service.cancel()
    await expect(operation).rejects.toMatchObject({ code: "PUBLISH_CANCELLED" })

    await expect(
      service.publish({ paths: ["content/technology/css-grid.md"] }),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
    await expect(service.retryPush()).rejects.toMatchObject({ code: "CLEANUP_FAILED" })
  })

  it("exports typed errors without command stderr or absolute paths", async () => {
    const repository = await fixture()
    const error = new PublishError("PUSH_FAILED", "Could not upload the verified publication.")
    expect(error).toMatchObject({ name: "PublishError", code: "PUSH_FAILED" })
    expect(error).not.toHaveProperty("stderr")
    expect(JSON.stringify(error)).not.toContain(repository.root)
  })
})

describe("bounded publication commands", () => {
  it("uses command-specific allowlisted environments and excludes inherited secrets and overrides", async () => {
    for (const [key, value] of Object.entries({
      PATH: "safe-path",
      TEMP: "safe-temp",
      USERPROFILE: "safe-profile",
      SSH_AUTH_SOCK: "safe-agent",
      HTTP_PROXY: "http://proxy.invalid:8080",
      HTTPS_PROXY: "http://secure-proxy.invalid:8080",
      ALL_PROXY: "socks5://proxy.invalid:1080",
      NO_PROXY: "localhost,127.0.0.1",
      http_proxy: "http://proxy.invalid:8080",
      https_proxy: "http://secure-proxy.invalid:8080",
      all_proxy: "socks5://proxy.invalid:1080",
      no_proxy: "localhost,127.0.0.1",
      GH_TOKEN: "secret-gh",
      GITHUB_TOKEN: "secret-github",
      NPM_TOKEN: "secret-npm",
      NODE_OPTIONS: "--require attacker.js",
      npm_config_registry: "https://attacker.invalid",
      GIT_DIR: "attacker-git-dir",
      GIT_WORK_TREE: "attacker-work-tree",
      GIT_INDEX_FILE: "attacker-index",
      GIT_OBJECT_DIRECTORY: "attacker-objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "attacker-alternate-objects",
    }))
      vi.stubEnv(key, value)
    const captured: Array<{ executable: string; env: NodeJS.ProcessEnv }> = []
    const spawner = (
      executable: string,
      _args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      captured.push({ executable, env: options.env })
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      }) as EventEmitter & PublishCommandProcess
      queueMicrotask(() => child.emit("close", 0))
      return child
    }
    const runner = createBoundedPublishCommandRunner({
      spawner: spawner as never,
      terminate: async () => true,
    })
    try {
      await runner.run({
        executable: "git",
        args: ["status"],
        cwd: process.cwd(),
        env: { GIT_INDEX_FILE: "controlled-index", GIT_TERMINAL_PROMPT: "0" },
      })
      await runner.run({ executable: "node.exe", args: ["verify.js"], cwd: process.cwd() })
    } finally {
      vi.unstubAllEnvs()
    }

    expect(captured[0]?.env).toMatchObject({
      PATH: "safe-path",
      TEMP: "safe-temp",
      USERPROFILE: "safe-profile",
      SSH_AUTH_SOCK: "safe-agent",
      HTTP_PROXY: "http://proxy.invalid:8080",
      HTTPS_PROXY: "http://secure-proxy.invalid:8080",
      ALL_PROXY: "socks5://proxy.invalid:1080",
      NO_PROXY: "localhost,127.0.0.1",
      http_proxy: "http://proxy.invalid:8080",
      https_proxy: "http://secure-proxy.invalid:8080",
      all_proxy: "socks5://proxy.invalid:1080",
      no_proxy: "localhost,127.0.0.1",
      GIT_INDEX_FILE: "controlled-index",
      GIT_TERMINAL_PROMPT: "0",
    })
    expect(captured[1]?.env).toMatchObject({
      PATH: "safe-path",
      TEMP: "safe-temp",
      USERPROFILE: "safe-profile",
    })
    for (const capturedCommand of captured) {
      expect(capturedCommand.env).not.toHaveProperty("GH_TOKEN")
      expect(capturedCommand.env).not.toHaveProperty("GITHUB_TOKEN")
      expect(capturedCommand.env).not.toHaveProperty("NPM_TOKEN")
      expect(capturedCommand.env).not.toHaveProperty("NODE_OPTIONS")
      expect(capturedCommand.env).not.toHaveProperty("npm_config_registry")
      expect(capturedCommand.env).not.toHaveProperty("GIT_DIR")
      expect(capturedCommand.env).not.toHaveProperty("GIT_WORK_TREE")
      expect(capturedCommand.env).not.toHaveProperty("GIT_OBJECT_DIRECTORY")
      expect(capturedCommand.env).not.toHaveProperty("GIT_ALTERNATE_OBJECT_DIRECTORIES")
    }
    expect(captured[1]?.env).not.toHaveProperty("GIT_INDEX_FILE")
    expect(captured[1]?.env).not.toHaveProperty("SSH_AUTH_SOCK")
    for (const proxy of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ]) {
      expect(captured[1]?.env).not.toHaveProperty(proxy)
    }
  })

  it("settles fail-closed when cancellation cannot confirm process-tree termination", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false,
    }) as EventEmitter & PublishCommandProcess
    const terminate = vi.fn(async () => false)
    const runner = createBoundedPublishCommandRunner({
      spawner: () => child,
      terminate,
      commandDeadlineMs: 100,
      terminationDeadlineMs: 5,
    })
    const controller = new AbortController()
    const command = runner.run({
      executable: "git",
      args: ["status"],
      cwd: process.cwd(),
      env: {},
      signal: controller.signal,
    })

    controller.abort()

    await expect(command).rejects.toMatchObject({ terminationUncertain: true })
    expect(terminate).toHaveBeenCalledWith(child)
  })
})
