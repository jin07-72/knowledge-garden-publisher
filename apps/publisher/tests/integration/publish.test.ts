import { mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
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
    holdRetry = false
    releaseRetry?.()
    const retried = await retry
    expect(retried.commit).toBe(retained)
    expect(await output(repository.root, ["rev-parse", "origin/main"])).toBe(retained)
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
