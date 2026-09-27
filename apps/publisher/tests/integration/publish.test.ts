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
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, type CommandRequest } from "../../src/main/lib/commandRunner"
import {
  Publisher,
  PublishError,
  createBoundedPublishCommandRunner,
  type PublishCommandProcess,
  type PublishDependencies,
  type PublishPhase,
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
    "node_modules/\nprivate/\n.garden-publisher/\napps/publisher/vendor/\n",
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
  overrides: Partial<PublishDependencies> = {},
): Publisher {
  return new Publisher({
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

describe("exact-tree publication", () => {
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
    expect(await output(repository.root, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toMatch(
      /(?:^|\n)private\//i,
    )
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
    const junction = vi.fn<NonNullable<PublishDependencies["createDependencyLink"]>>(
      async () => undefined,
    )
    const verifySite = vi.fn<NonNullable<PublishDependencies["verifySite"]>>(async (request) => {
      expect(await output(request.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD")
      expect(await output(request.cwd, ["show", "HEAD:content/technology/css-grid.md"])).toBe(
        "verify me",
      )
      return { exitCode: 0 }
    })

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
    await put(repository.root, "content/technology/css-grid.md", "invalid site\n")

    await expect(
      publisher(repository, { verifySite: async () => ({ exitCode: 1 }) }).publish({
        paths: ["content/technology/css-grid.md"],
      }),
    ).rejects.toMatchObject({ code: "VERIFY_FAILED" })

    expect(await output(repository.root, ["rev-parse", "HEAD"])).toBe(before)
    const publishRoot = join(repository.root, ".garden-publisher", "publish")
    expect(await readdir(publishRoot).catch(() => [])).toEqual([])
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
