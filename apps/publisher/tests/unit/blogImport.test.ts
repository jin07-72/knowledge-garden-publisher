import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CommandRunner } from "../../src/main/lib/commandRunner"
import {
  createBoundedCommandRunnerForTest,
  PublishCommandFailure,
  type BoundedCommandRunner,
} from "../../src/main/services/publish"
import {
  createBlogImportService,
  inspectBlogCandidate,
  parseGitHubRepository,
  type BlogCandidateInspection,
} from "../../src/main/services/blogImport"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function temporaryDirectory(prefix = "blog-import-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

async function createCandidate(root: string, installed = true): Promise<void> {
  await mkdir(join(root, "content"), { recursive: true })
  await mkdir(join(root, "quartz"), { recursive: true })
  await writeFile(join(root, "package.json"), '{"name":"garden"}')
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}')
  await writeFile(join(root, "quartz", "bootstrap-cli.mjs"), "")
  if (installed) {
    await mkdir(join(root, "node_modules"), { recursive: true })
    await writeFile(join(root, "node_modules", ".package-lock.json"), '{"lockfileVersion":3,"packages":{}}')
  }
}

function gitRunner(root: string, requests: Parameters<CommandRunner["run"]>[0][] = []): BoundedCommandRunner {
  return createBoundedCommandRunnerForTest({
    run: async (request) => {
      requests.push(request)
      if (request.args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
      if (request.args[0] === "remote" && request.args.length === 1)
        return { exitCode: 0, stdout: "origin\n", stderr: "" }
      if (request.args[0] === "remote") return { exitCode: 0, stdout: "git@github.com:owner/repository.git\n", stderr: "" }
      if (request.args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" }
      if (request.args[1] === "ls") return { exitCode: 0, stdout: "{}", stderr: "" }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  })
}

const runtime = { nodePath: "bundled-node.exe", npmCliPath: "npm-cli.js" }

const genericRunnerForTypeTest: CommandRunner = {
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
}
// @ts-expect-error A generic runner cannot claim the bounded process-tree capability.
const rejectedBoundedRunner: BoundedCommandRunner = genericRunnerForTypeTest
void rejectedBoundedRunner

describe("parseGitHubRepository", () => {
  it.each([
    ["https://github.com/openai/quartz", "https://github.com/openai/quartz", "openai", "quartz"],
    ["https://github.com/openai/quartz.git", "https://github.com/openai/quartz.git", "openai", "quartz"],
    ["git@github.com:openai/quartz", "git@github.com:openai/quartz", "openai", "quartz"],
    ["git@github.com:openai/quartz.git", "git@github.com:openai/quartz.git", "openai", "quartz"],
  ])("normalizes accepted GitHub repository URL %s", (value, url, owner, repository) => {
    expect(parseGitHubRepository(value)).toEqual({ url, owner, repository })
  })

  it.each([
    "http://github.com/openai/quartz",
    "https://gitlab.com/openai/quartz",
    "file:///tmp/quartz",
    "https://user:secret@github.com/openai/quartz",
    "https://github.com/openai/quartz?token=secret",
    "https://github.com/openai/quartz#readme",
    "https://github.com/openai/quartz/extra",
    "https://github.com/openai/../quartz",
    "https://github.com/-owner/quartz",
    "https://github.com/openai/-quartz",
    "git@github.com:openai/quartz --upload-pack=evil",
    "--config=evil",
    "git@github.com:openai/quartz.git?token=secret",
    `https://github.com/${"a".repeat(100)}/quartz`,
  ])("rejects unsafe repository URL %s", (value) => {
    expect(() => parseGitHubRepository(value)).toThrow(/GitHub repository/i)
  })
})

describe("inspectBlogCandidate", () => {
  it("accepts a complete Quartz Git candidate", async () => {
    const root = await temporaryDirectory()
    await createCandidate(root)

    await expect(inspectBlogCandidate(root, { runner: gitRunner(root) })).resolves.toMatchObject({
      valid: true,
      canonicalPath: root,
      needsInstall: false,
    })
  })

  it("accepts missing installed dependencies but marks installation required", async () => {
    const root = await temporaryDirectory()
    await createCandidate(root, false)

    await expect(inspectBlogCandidate(root, { runner: gitRunner(root) })).resolves.toMatchObject({
      valid: true,
      canonicalPath: root,
      needsInstall: true,
    })
  })

  it("accepts mismatched installed dependencies but marks installation required", async () => {
    const root = await temporaryDirectory()
    await createCandidate(root)
    await writeFile(
      join(root, "package-lock.json"),
      '{"lockfileVersion":3,"packages":{"node_modules/example":{"version":"1.0.0"}}}',
    )

    await expect(inspectBlogCandidate(root, { runner: gitRunner(root) })).resolves.toMatchObject({
      valid: true,
      canonicalPath: root,
      needsInstall: true,
    })
  })

  it.each([
    ["package.json", "PACKAGE_JSON_MISSING"],
    ["quartz/bootstrap-cli.mjs", "QUARTZ_BOOTSTRAP_MISSING"],
    ["content", "CONTENT_MISSING"],
  ])("rejects a candidate missing %s", async (relativePath, code) => {
    const root = await temporaryDirectory()
    await createCandidate(root)
    await rm(join(root, relativePath), { force: true, recursive: true })

    await expect(inspectBlogCandidate(root, { runner: gitRunner(root) })).resolves.toMatchObject({
      valid: false,
      code,
    })
  })

  it("rejects a directory that is not a Git repository or has no origin", async () => {
    const root = await temporaryDirectory()
    await createCandidate(root)
    const noGit: CommandRunner = { run: async () => ({ exitCode: 1, stdout: "", stderr: "raw secret" }) }
    const noOrigin: CommandRunner = {
      run: async ({ args }) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
        if (args[0] === "remote") return { exitCode: 0, stdout: "", stderr: "" }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    }

    await expect(inspectBlogCandidate(root, { runner: createBoundedCommandRunnerForTest(noGit) })).resolves.toMatchObject({ valid: false, code: "GIT_NOT_REPOSITORY" })
    await expect(inspectBlogCandidate(root, { runner: createBoundedCommandRunnerForTest(noOrigin) })).resolves.toMatchObject({ valid: false, code: "GIT_ORIGIN_MISSING" })
  })

  it("rejects a repository whose origin URL cannot be read", async () => {
    const root = await temporaryDirectory()
    await createCandidate(root)
    const blankOrigin: CommandRunner = {
      run: async ({ args }) => {
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${root}\n`, stderr: "" }
        if (args[0] === "remote" && args.length === 1) return { exitCode: 0, stdout: "origin\n", stderr: "" }
        if (args[0] === "remote") return { exitCode: 0, stdout: "\n", stderr: "raw origin URL" }
        if (args[1] === "ls") return { exitCode: 0, stdout: "{}", stderr: "" }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    }

    await expect(inspectBlogCandidate(root, { runner: createBoundedCommandRunnerForTest(blankOrigin) })).resolves.toMatchObject({
      valid: false,
      code: "GIT_ORIGIN_FAILED",
      message: expect.not.stringContaining("raw origin"),
    })
  })
})

describe("createBlogImportService", () => {
  function valid(path: string): BlogCandidateInspection {
    return { valid: true, canonicalPath: path, needsInstall: false }
  }

  function serviceDependencies(options: {
    readonly runner: CommandRunner
    readonly inspect?: typeof inspectBlogCandidate
    readonly progress: string[]
    readonly afterParentCapturedBeforeMkdir?: () => Promise<void>
    readonly cloneSource?: (repository: {
      readonly url: string
      readonly owner: string
      readonly repository: string
    }) => string | undefined
  }) {
    return {
      gitExecutable: "git.exe",
      ...runtime,
      runner: createBoundedCommandRunnerForTest(options.runner),
      inspect: options.inspect ?? (async (path: string) => valid(path)),
      onProgress: ({ phase }: { phase: string }) => options.progress.push(phase),
      afterParentCapturedBeforeMkdir: options.afterParentCapturedBeforeMkdir,
      cloneSource: options.cloneSource,
    }
  }

  it("clones with literal Git and npm arguments then emits safe ordered phases", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const phases: string[] = []
    const runner: CommandRunner = {
      run: async (request) => {
        requests.push(request)
        return { exitCode: 0, stdout: "raw clone output", stderr: "raw npm output" }
      },
    }
    const service = createBlogImportService(serviceDependencies({ runner, progress: phases }))

    await expect(service.clone({ url: "https://github.com/openai/quartz.git", destination, name: "Quartz" })).resolves.toMatchObject({ canonicalPath: destination, owner: "openai", repository: "quartz" })

    expect(requests).toEqual([
      expect.objectContaining({
        executable: "git.exe",
        args: ["clone", "--", "https://github.com/openai/quartz.git", "."],
        cwd: destination,
        env: { GIT_TERMINAL_PROMPT: "1" },
        signal: expect.any(AbortSignal),
        maxOutputBytes: 2 * 1024 * 1024,
      }),
      expect.objectContaining({
        executable: "bundled-node.exe",
        args: ["npm-cli.js", "ci", "--no-audit", "--no-fund"],
        cwd: destination,
        env: { npm_config_audit: "false", npm_config_fund: "false" },
        signal: expect.any(AbortSignal),
        maxOutputBytes: 2 * 1024 * 1024,
      }),
    ])
    expect(phases).toEqual(["cloning", "installing", "validating", "complete"])
  })

  it("resolves an internal clone source only after validating the public GitHub URL", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const localSource = join(parent, "fixture.git")
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const resolvedRepositories: unknown[] = []
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async (request) => {
          requests.push(request)
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
      progress: [],
      cloneSource: (repository) => {
        resolvedRepositories.push(repository)
        return localSource
      },
    }))

    await expect(service.clone({
      url: "https://github.com/openai/quartz.git",
      destination,
      name: "Quartz",
    })).resolves.toMatchObject({ owner: "openai", repository: "quartz" })
    expect(resolvedRepositories).toEqual([{
      url: "https://github.com/openai/quartz.git",
      owner: "openai",
      repository: "quartz",
    }])
    expect(requests[0]?.args).toEqual(["clone", "--", localSource, "."])
  })

  it("never resolves an internal clone source for an invalid public URL", async () => {
    const parent = await temporaryDirectory()
    let resolved = false
    let ran = false
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async () => {
          ran = true
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
      progress: [],
      cloneSource: () => {
        resolved = true
        return join(parent, "fixture.git")
      },
    }))

    await expect(service.clone({
      url: "file:///secret/repository",
      destination: join(parent, "clone"),
    })).rejects.toMatchObject({ code: "INVALID_REPOSITORY_URL" })
    expect(resolved).toBe(false)
    expect(ran).toBe(false)
  })

  it("refuses to clone into an existing destination before starting Git", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "existing")
    await mkdir(destination)
    let called = false
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => { called = true; return { exitCode: 0, stdout: "", stderr: "" } } },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "DESTINATION_EXISTS", path: destination })
    expect(called).toBe(false)
  })

  it("preserves the clone destination and skips install after Git fails", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "partial-clone")
    const phases: string[] = []
    let inspections = 0
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async ({ args }) => {
          if (args[0] === "clone") {
            await writeFile(join(destination, "partial-clone.txt"), "preserve me")
          }
          return { exitCode: 1, stdout: "sensitive raw output", stderr: "https://user:secret@example.invalid" }
        },
      },
      inspect: async (path) => { inspections += 1; return valid(path) },
      progress: phases,
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "CLONE_FAILED", path: destination, message: expect.not.stringContaining("sensitive") })
    expect((await lstat(join(destination, "partial-clone.txt"))).isFile()).toBe(true)
    expect(inspections).toBe(0)
    expect(phases).toEqual(["cloning"])
  })

  it("stops before final validation when npm install fails", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    let inspections = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async ({ args }) => ({ exitCode: args[0] === "clone" ? 0 : 1, stdout: "", stderr: "" }) },
      inspect: async (path) => { inspections += 1; return valid(path) },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "INSTALL_FAILED" })
    expect(inspections).toBe(1)
  })

  it("does not report completion when final validation requires installation", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const phases: string[] = []
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      inspect: async (path) => ({ valid: true, canonicalPath: path, needsInstall: true }),
      progress: phases,
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" })
    expect(phases).toEqual(["cloning", "installing", "validating"])
  })

  it("maps final inspector output to a safe validation error", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const phases: string[] = []
    let inspections = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      inspect: async (path) => {
        inspections += 1
        if (inspections === 1) return valid(path)
        throw new Error("raw final inspector secret")
      },
      progress: phases,
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.not.stringContaining("raw final inspector secret"),
    })
    expect(phases).toEqual(["cloning", "installing", "validating"])
  })

  it("maps cancellation during final validation to CANCELLED without completion", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const controller = new AbortController()
    const phases: string[] = []
    let inspections = 0
    let beginFinalInspection!: () => void
    let finishFinalInspection!: () => void
    const finalInspectionStarted = new Promise<void>((resolve) => { beginFinalInspection = resolve })
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      inspect: async (path) => {
        inspections += 1
        if (inspections === 1) return valid(path)
        return new Promise<BlogCandidateInspection>((resolve) => {
          finishFinalInspection = () => resolve(valid(path))
          beginFinalInspection()
        })
      },
      progress: phases,
    }))
    const operation = service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" }, controller.signal)
    await finalInspectionStarted
    controller.abort()
    finishFinalInspection()

    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" })
    expect(phases).toEqual(["cloning", "installing", "validating"])
  })

  it("accepts the planned clone request and returns a stable final canonical path", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      inspect: async (path) => valid(path),
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).resolves.toMatchObject({
      canonicalPath: destination,
      owner: "openai",
      repository: "quartz",
    })
  })

  it("preserves the reserved target but rejects its replacement before npm", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async (request) => {
          requests.push(request)
          if (request.args[0] === "clone") {
            const replacement = join(parent, "replacement")
            await mkdir(replacement)
            await rm(request.cwd, { force: true, recursive: true })
            await rename(replacement, request.cwd)
          }
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "TARGET_CHANGED", path: destination })
    expect(requests).toHaveLength(1)
    expect((await lstat(destination)).isDirectory()).toBe(true)
  })

  it("rejects a target moved into a replacement parent before npm", async () => {
    const root = await temporaryDirectory()
    const parent = join(root, "parent")
    const movedParent = join(root, "moved-parent")
    const destination = join(parent, "quartz")
    await mkdir(parent)
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async (request) => {
          requests.push(request)
          if (request.args[0] === "clone") {
            await rename(parent, movedParent)
            await mkdir(parent)
            await rename(join(movedParent, "quartz"), destination)
          }
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({
      code: "TARGET_CHANGED",
      path: destination,
    })
    expect(requests).toHaveLength(1)
    expect((await lstat(destination)).isDirectory()).toBe(true)
  })

  it("poisons the service after unconfirmed process termination", async () => {
    const parent = await temporaryDirectory()
    const firstDestination = join(parent, "first")
    const secondDestination = join(parent, "second")
    let calls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async () => {
          calls += 1
          throw new PublishCommandFailure("raw process details", true)
        },
      },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination: firstDestination, name: "Quartz" })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
      message: expect.not.stringContaining("raw process details"),
    })
    await expect(service.clone({ url: "https://github.com/openai/quartz", destination: secondDestination, name: "Quartz" })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
    })
    expect(calls).toBe(1)
  })

  it("poisons the service when npm termination is uncertain", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    let calls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async ({ args }) => {
        calls += 1
        if (args[0] !== "clone") throw new PublishCommandFailure("raw npm termination", true)
        return { exitCode: 0, stdout: "", stderr: "" }
      } },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({
      code: "IMPORT_UNAVAILABLE",
      message: expect.not.stringContaining("raw npm termination"),
    })
    await expect(service.install(join(parent, "second"))).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    expect(calls).toBe(2)
  })

  it("propagates uncertain Git inspection through standalone and service preflight", async () => {
    const root = await temporaryDirectory()
    await createCandidate(root)
    const uncertain = createBoundedCommandRunnerForTest({
      run: async () => { throw new PublishCommandFailure("raw git termination", true) },
    })
    await expect(inspectBlogCandidate(root, { runner: uncertain })).rejects.toMatchObject({ terminationUncertain: true })
    let calls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: createBoundedCommandRunnerForTest({ run: async () => { calls += 1; throw new PublishCommandFailure("raw git termination", true) } }),
      inspect: inspectBlogCandidate,
      progress: [],
    }))

    await expect(service.install(root)).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE", message: expect.not.stringContaining("raw git termination") })
    await expect(service.install(join(root, "second"))).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    expect(calls).toBe(1)
  })

  it("poisons the service when final inspection reports uncertain termination", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const phases: string[] = []
    let inspections = 0
    let calls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" } } },
      inspect: async (path) => {
        inspections += 1
        if (inspections === 1) return valid(path)
        throw new PublishCommandFailure("raw final termination", true)
      },
      progress: phases,
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE", message: expect.not.stringContaining("raw final termination") })
    expect(phases).toEqual(["cloning", "installing", "validating"])
    await expect(service.clone({ url: "https://github.com/openai/quartz", destination: join(parent, "second"), name: "Quartz" })).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    expect(calls).toBe(2)
  })

  it("preserves delayed final-inspection termination uncertainty after cancellation", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const controller = new AbortController()
    let inspections = 0
    let rejectFinal!: (error: Error) => void
    let finalStarted!: () => void
    const started = new Promise<void>((resolve) => { finalStarted = resolve })
    let runnerCalls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => { runnerCalls += 1; return { exitCode: 0, stdout: "", stderr: "" } } },
      inspect: async (path) => {
        inspections += 1
        if (inspections === 1) return valid(path)
        return new Promise<BlogCandidateInspection>((_resolve, reject) => {
          rejectFinal = reject
          finalStarted()
        })
      },
      progress: [],
    }))
    const first = service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" }, controller.signal)
    await started
    controller.abort()
    rejectFinal(new PublishCommandFailure("raw delayed termination", true))

    await expect(first).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE", message: expect.not.stringContaining("raw delayed termination") })
    await expect(service.clone({ url: "https://github.com/openai/quartz", destination: join(parent, "second"), name: "Quartz" })).rejects.toMatchObject({ code: "IMPORT_UNAVAILABLE" })
    expect(runnerCalls).toBe(2)
    expect(inspections).toBe(2)
  })

  it("rejects a parent replacement between baseline capture and target reservation", async () => {
    const root = await temporaryDirectory()
    const parent = join(root, "parent")
    const moved = join(root, "moved")
    const destination = join(parent, "quartz")
    await mkdir(parent)
    let calls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" } } },
      afterParentCapturedBeforeMkdir: async () => {
        await rename(parent, moved)
        await mkdir(parent)
      },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).rejects.toMatchObject({ code: "TARGET_CHANGED", path: destination })
    expect(calls).toBe(0)
  })

  it("uses the canonical ancestor directory when the requested parent is a link", async ({ skip }) => {
    const parent = await temporaryDirectory()
    const outside = await temporaryDirectory()
    const linkedParent = join(parent, "linked-parent")
    try {
      await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return skip()
      throw error
    }
    const destination = join(linkedParent, "quartz")
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async (request) => { requests.push(request); return { exitCode: 0, stdout: "", stderr: "" } } },
      progress: [],
    }))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" })).resolves.toMatchObject({ canonicalPath: join(outside, "quartz") })
    expect(requests[0]).toMatchObject({ cwd: join(outside, "quartz"), args: ["clone", "--", "https://github.com/openai/quartz", "."] })
  })

  it("keeps the service busy after cancelling a slow inspector until it settles", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const secondDestination = join(parent, "second")
    const controller = new AbortController()
    let inspections = 0
    let finishInspection!: () => void
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      inspect: async (path) => {
        inspections += 1
        if (inspections === 1) return valid(path)
        return new Promise<BlogCandidateInspection>((resolve) => { finishInspection = () => resolve(valid(path)) })
      },
      progress: [],
    }))
    const first = service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" }, controller.signal)
    while (inspections < 2) await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination: secondDestination, name: "Quartz" })).rejects.toMatchObject({ code: "IMPORT_ACTIVE" })
    finishInspection()
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" })
  })

  it("passes cancellation to the active command and stops later phases", async () => {
    const parent = await temporaryDirectory()
    const destination = join(parent, "quartz")
    const controller = new AbortController()
    const phases: string[] = []
    let commandSignal: AbortSignal | undefined
    let acknowledgeTermination!: () => void
    let settled = false
    const service = createBlogImportService(serviceDependencies({
      runner: {
        run: async ({ signal }) => new Promise((_, reject) => {
          commandSignal = signal
          signal?.addEventListener("abort", () => {
            acknowledgeTermination = () => reject(new Error("cancelled"))
          }, { once: true })
        }),
      },
      progress: phases,
    }))
    const operation = service.clone({ url: "https://github.com/openai/quartz", destination, name: "Quartz" }, controller.signal)
    void operation.catch(() => { settled = true })
    while (!commandSignal) await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    acknowledgeTermination()

    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" })
    expect(commandSignal?.aborted).toBe(true)
    expect(phases).toEqual(["cloning"])
  })

  it("rejects a second operation while another import command is active", async () => {
    const parent = await temporaryDirectory()
    const firstDestination = join(parent, "first")
    const secondDestination = join(parent, "second")
    let release!: () => void
    const firstCommand = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      release = () => resolve({ exitCode: 1, stdout: "", stderr: "" })
    })
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => firstCommand },
      progress: [],
    }))
    const first = service.clone({ url: "https://github.com/openai/quartz", destination: firstDestination, name: "Quartz" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(service.clone({ url: "https://github.com/openai/quartz", destination: secondDestination, name: "Quartz" })).rejects.toMatchObject({ code: "IMPORT_ACTIVE" })
    release()
    await expect(first).rejects.toMatchObject({ code: "CLONE_FAILED" })
  })

  it("installs in place then returns the final inspection", async () => {
    const root = await temporaryDirectory()
    const requests: Parameters<CommandRunner["run"]>[0][] = []
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async (request) => { requests.push(request); return { exitCode: 0, stdout: "", stderr: "" } } },
      progress: [],
    }))

    await expect(service.install(root)).resolves.toEqual(valid(root))
    expect(requests).toEqual([expect.objectContaining({ cwd: root, args: ["npm-cli.js", "ci", "--no-audit", "--no-fund"] })])
  })

  it("does not run npm when the install path fails candidate preflight", async () => {
    const root = await temporaryDirectory()
    let runnerCalls = 0
    const service = createBlogImportService(serviceDependencies({
      runner: { run: async () => { runnerCalls += 1; return { exitCode: 0, stdout: "", stderr: "" } } },
      inspect: async () => ({ valid: false, code: "CONTENT_MISSING", message: "The content directory is required." }),
      progress: [],
    }))

    await expect(service.install(root)).rejects.toMatchObject({ code: "VALIDATION_FAILED", path: root })
    expect(runnerCalls).toBe(0)
  })
})
