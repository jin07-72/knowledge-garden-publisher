import { spawn } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type CommandRequest, type CommandResult, type CommandRunner } from "../lib/commandRunner"
import type { PreviewProcess } from "./preview"
import { createProductionProcessTreeTerminator } from "./previewRuntime"

export type PublishPhase =
  | "preflight-fetch"
  | "stage-temporary-index"
  | "write-tree"
  | "synthetic-commit"
  | "verify-worktree"
  | "update-local-ref"
  | "push"
  | "cleanup"
  | "complete"

export interface PublishProgressEvent {
  readonly phase: PublishPhase
  readonly message: string
}

export type PublishErrorCode =
  | "INVALID_SELECTION"
  | "PRIVATE_PATH"
  | "UNSAFE_PATH"
  | "UNSAFE_STATE_PATH"
  | "RUNTIME_MISSING"
  | "DEPENDENCIES_INVALID"
  | "GIT_UNAVAILABLE"
  | "GIT_ROOT_MISMATCH"
  | "DETACHED_HEAD"
  | "BRANCH_UNSAFE"
  | "STAGED_CHANGES"
  | "REMOTE_UNAVAILABLE"
  | "REMOTE_DIVERGED"
  | "STAGING_FAILED"
  | "TREE_INVALID"
  | "COMMIT_FAILED"
  | "VERIFY_FAILED"
  | "REF_CHANGED"
  | "INDEX_LOCKED"
  | "REF_UPDATE_FAILED"
  | "PUSH_FAILED"
  | "PUBLISH_ACTIVE"
  | "PUBLISH_CANCELLED"
  | "PUBLISH_TIMEOUT"
  | "CLEANUP_FAILED"

export class PublishError extends Error {
  readonly name = "PublishError"

  constructor(
    readonly code: PublishErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface PublishRuntime {
  readonly root: string
  readonly nodeExecutable: string
  readonly npmCliPath: string
  readonly nodeModules: string
}

export interface VerifySiteRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly signal: AbortSignal
}

export interface DependencyLinkRequest {
  readonly target: string
  readonly link: string
  readonly type: "junction"
}

interface PublishDependencies {
  readonly workspace: string
  readonly runtime: PublishRuntime
  readonly runner?: CommandRunner
  readonly validateDependencies?: (request: VerifySiteRequest) => Promise<boolean>
  readonly verifySite?: (request: VerifySiteRequest) => Promise<{ readonly exitCode: number }>
  readonly createDependencyLink?: (request: DependencyLinkRequest) => Promise<void>
  readonly onProgress?: (progress: PublishProgressEvent) => void
  readonly timeoutMs?: number
  readonly criticalSectionTimeoutMs?: number
  /** Test-only race seam. Production construction never supplies this hook. */
  readonly beforeIndexLockAcquired?: () => Promise<void>
}

/** Explicitly unsafe construction seam used only by repository integration tests. */
export type PublisherTestDependencies = PublishDependencies

export interface ProductionPublisherOptions {
  readonly workspace: string
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly runner?: CommandRunner
  readonly onProgress?: (progress: PublishProgressEvent) => void
  readonly timeoutMs?: number
  readonly criticalSectionTimeoutMs?: number
}

export interface PublishSelection {
  readonly paths: readonly string[]
  readonly message?: string
  readonly signal?: AbortSignal
}

export interface PublishResult {
  readonly commit: string
  readonly tree: string
  readonly pushed: true
}

interface OperationPaths {
  readonly root: string
  readonly index: string
  readonly verify: string
  readonly dependencyLink: string
}

const MAX_PATHS = 500
const MAX_PATH_BYTES = 512
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_STDERR_BYTES = 64 * 1024
const MAX_GIT_INDEX_BYTES = 32 * 1024 * 1024
const gitEnvironment = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_TERMINAL_PROMPT: "0",
} as const

const publisherConstructionKey = Symbol("publisher-construction-key")

export function resolveProductionPublishRuntime(options: {
  readonly workspace: string
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
}): PublishRuntime {
  const root = options.isPackaged
    ? resolve(options.resourcesPath, "node")
    : resolve(options.appPath, "vendor", "node")
  return {
    root,
    nodeExecutable: resolve(root, "node.exe"),
    npmCliPath: resolve(root, "node_modules", "npm", "bin", "npm-cli.js"),
    nodeModules: resolve(options.workspace, "node_modules"),
  }
}

export function createProductionPublisher(options: ProductionPublisherOptions): Publisher {
  if ("runtime" in options) {
    throw new TypeError("A production runtime cannot be supplied by the caller.")
  }
  const { workspace, isPackaged, resourcesPath, appPath, ...dependencies } = options
  return new Publisher(
    {
      workspace,
      runtime: resolveProductionPublishRuntime({
        workspace,
        isPackaged,
        resourcesPath,
        appPath,
      }),
      ...dependencies,
    },
    publisherConstructionKey,
  )
}

export function createPublisherForTest(dependencies: PublisherTestDependencies): Publisher {
  return new Publisher(dependencies, publisherConstructionKey)
}

function error(code: PublishErrorCode, message: string): PublishError {
  return new PublishError(code, message)
}

export interface PublishCommandProcess extends PreviewProcess {}

export type PublishCommandSpawner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly shell: false
    readonly windowsHide: true
    readonly detached: true
  },
) => PublishCommandProcess

class PublishCommandFailure extends Error {
  readonly name = "PublishCommandFailure"

  constructor(
    message: string,
    readonly terminationUncertain = false,
  ) {
    super(message)
  }
}

export function createBoundedPublishCommandRunner(options: {
  readonly spawner: PublishCommandSpawner
  readonly terminate: (child: PublishCommandProcess) => Promise<boolean>
  readonly commandDeadlineMs?: number
  readonly terminationDeadlineMs?: number
}): CommandRunner {
  return {
    run(request) {
      if (request.signal?.aborted) {
        return Promise.reject(new PublishCommandFailure("Publication command was cancelled."))
      }
      return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
        let child: PublishCommandProcess
        try {
          child = options.spawner(request.executable, request.args, {
            cwd: request.cwd,
            env: { ...process.env, ...request.env },
            shell: false,
            windowsHide: true,
            detached: true,
          })
        } catch {
          rejectPromise(new PublishCommandFailure("Publication command could not start."))
          return
        }
        let settled = false
        let stopping = false
        let stdoutBytes = 0
        let stderrBytes = 0
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let pending = new PublishCommandFailure("Publication command timed out.")
        let commandTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (failure?: PublishCommandFailure, result?: CommandResult): void => {
          if (settled) return
          settled = true
          if (commandTimer) clearTimeout(commandTimer)
          request.signal?.removeEventListener("abort", abort)
          if (failure) rejectPromise(failure)
          else resolvePromise(result!)
        }
        const stop = (failure: PublishCommandFailure): void => {
          if (settled || stopping) return
          stopping = true
          pending = failure
          let terminationTimer: ReturnType<typeof setTimeout> | undefined
          void Promise.race([
            options.terminate(child),
            new Promise<false>((resolvePromise) => {
              terminationTimer = setTimeout(
                () => resolvePromise(false),
                options.terminationDeadlineMs ?? 3_500,
              )
            }),
          ])
            .then(
              (confirmed) =>
                finish(
                  confirmed
                    ? pending
                    : new PublishCommandFailure(
                        "Publication command termination was not confirmed.",
                        true,
                      ),
                ),
              () =>
                finish(
                  new PublishCommandFailure(
                    "Publication command termination was not confirmed.",
                    true,
                  ),
                ),
            )
            .finally(() => {
              if (terminationTimer) clearTimeout(terminationTimer)
            })
        }
        const abort = (): void =>
          stop(new PublishCommandFailure("Publication command was cancelled."))
        commandTimer = setTimeout(
          () => stop(new PublishCommandFailure("Publication command timed out.")),
          options.commandDeadlineMs ?? DEFAULT_TIMEOUT_MS,
        )
        request.signal?.addEventListener("abort", abort, { once: true })
        if (request.signal?.aborted) abort()
        child.on("error", () => stop(new PublishCommandFailure("Publication command failed.")))
        child.on("close", (code) => {
          if (stopping) return
          if (code === null) {
            finish(new PublishCommandFailure("Publication command did not finish safely."))
          } else {
            finish(undefined, {
              exitCode: code,
              stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
              stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
            })
          }
        })
        if (!child.stdout || !child.stderr) {
          stop(new PublishCommandFailure("Publication command streams were unavailable."))
          return
        }
        child.stdout.on("data", (chunk: Buffer | string) => {
          if (settled || stopping) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stdoutBytes += bytes.byteLength
          if (stdoutBytes > MAX_OUTPUT_BYTES) {
            stop(new PublishCommandFailure("Publication command output exceeded its safe limit."))
          } else {
            stdout.push(bytes)
          }
        })
        child.stderr.on("data", (chunk: Buffer | string) => {
          if (settled || stopping) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stderrBytes += bytes.byteLength
          if (stderrBytes > MAX_STDERR_BYTES) {
            stop(
              new PublishCommandFailure("Publication command diagnostics exceeded its safe limit."),
            )
          } else {
            stderr.push(bytes)
          }
        })
      })
    },
  }
}

const productionTerminator = createProductionProcessTreeTerminator()
const systemPublishCommandRunner = createBoundedPublishCommandRunner({
  spawner: (executable, args, options) =>
    spawn(executable, [...args], options) as unknown as PublishCommandProcess,
  terminate: (child) => productionTerminator(child),
})

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
}

function normalizeSelection(paths: readonly string[]): readonly string[] {
  if (paths.length === 0 || paths.length > MAX_PATHS) {
    throw error("INVALID_SELECTION", "Choose at least one safe publication item.")
  }
  const unique = new Set<string>()
  for (const path of paths) {
    if (
      !path ||
      Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
      isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.endsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw error("UNSAFE_PATH", "A selected publication path is unsafe.")
    }
    const lower = path.toLowerCase()
    if (lower === "private" || lower.startsWith("private/")) {
      throw error("PRIVATE_PATH", "Private content cannot be published.")
    }
    if (
      lower === ".git" ||
      lower.startsWith(".git/") ||
      lower === ".garden-publisher" ||
      lower.startsWith(".garden-publisher/")
    ) {
      throw error("UNSAFE_PATH", "A selected publication path is reserved.")
    }
    unique.add(path)
  }
  return [...unique].sort()
}

function decodeNulPaths(value: string): readonly string[] {
  if (!value) return []
  if (!value.endsWith("\0")) throw error("TREE_INVALID", "Git returned malformed tree data.")
  const paths = value.slice(0, -1).split("\0")
  if (paths.some((path) => !path)) throw error("TREE_INVALID", "Git returned malformed tree data.")
  return paths
}

function safeMessage(message: string | undefined): string {
  const normalized = message?.trim()
  if (!normalized) return "Publish Knowledge Garden changes"
  if (normalized.length > 200 || /[\0\r\n]/.test(normalized)) {
    throw error("INVALID_SELECTION", "The publication message is invalid.")
  }
  return normalized
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function progressMessage(phase: PublishPhase): string {
  const messages: Record<PublishPhase, string> = {
    "preflight-fetch": "正在检查远程状态…",
    "stage-temporary-index": "正在准备发布内容…",
    "write-tree": "正在固定发布内容…",
    "synthetic-commit": "正在准备验证版本…",
    "verify-worktree": "正在验证网站…",
    "update-local-ref": "正在创建发布版本…",
    push: "正在上传到 GitHub…",
    cleanup: "正在清理临时文件…",
    complete: "发布完成",
  }
  return messages[phase]
}

export class Publisher {
  readonly #runner: CommandRunner
  #active: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined
  #pendingPush: { readonly commit: string; readonly tree: string } | undefined
  #terminationUncertain = false

  constructor(
    private readonly dependencies: PublishDependencies,
    constructionKey?: symbol,
  ) {
    if (constructionKey !== publisherConstructionKey) {
      throw new TypeError("Publisher must be created by a trusted construction factory.")
    }
    this.#runner = dependencies.runner ?? systemPublishCommandRunner
  }

  #emit(phase: PublishPhase): void {
    this.dependencies.onProgress?.({ phase, message: progressMessage(phase) })
  }

  async #guard<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
        }),
      ])
    } finally {
      if (abort) signal.removeEventListener("abort", abort)
    }
  }

  async #run(
    request: Omit<CommandRequest, "signal">,
    signal: AbortSignal,
    failureCode: PublishErrorCode,
    failureMessage: string,
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<CommandResult> {
    let result: CommandResult
    try {
      result = await this.#runner.run({ ...request, signal })
    } catch (caught) {
      if (
        typeof caught === "object" &&
        caught !== null &&
        "terminationUncertain" in caught &&
        caught.terminationUncertain === true
      ) {
        this.#terminationUncertain = true
      }
      if (signal.aborted) throw signal.reason
      throw error(failureCode, failureMessage)
    }
    if (
      Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr, "utf8") > MAX_OUTPUT_BYTES
    ) {
      throw error(failureCode, failureMessage)
    }
    if (!acceptedExitCodes.includes(result.exitCode)) throw error(failureCode, failureMessage)
    return result
  }

  async #git(
    workspace: string,
    args: readonly string[],
    signal: AbortSignal,
    failureCode: PublishErrorCode,
    failureMessage: string,
    options: {
      readonly env?: Readonly<Record<string, string | undefined>>
      readonly acceptedExitCodes?: readonly number[]
    } = {},
  ): Promise<CommandResult> {
    return this.#run(
      {
        executable: "git",
        args,
        cwd: workspace,
        env: { ...gitEnvironment, ...options.env },
      },
      signal,
      failureCode,
      failureMessage,
      options.acceptedExitCodes,
    )
  }

  async #confirmRemote(
    workspace: string,
    commit: string,
    tree: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#git(
      workspace,
      ["fetch", "--no-tags", "origin", "main"],
      signal,
      "PUSH_FAILED",
      "The uploaded publication could not be confirmed.",
    )
    const remoteCommit = (
      await this.#git(
        workspace,
        ["rev-parse", "--verify", "refs/remotes/origin/main"],
        signal,
        "PUSH_FAILED",
        "The uploaded publication could not be confirmed.",
      )
    ).stdout.trim()
    const remoteTree = (
      await this.#git(
        workspace,
        ["rev-parse", "--verify", "refs/remotes/origin/main^{tree}"],
        signal,
        "PUSH_FAILED",
        "The uploaded publication tree could not be confirmed.",
      )
    ).stdout.trim()
    if (remoteCommit !== commit || remoteTree !== tree) {
      throw error("PUSH_FAILED", "The uploaded publication differs from the verified version.")
    }
  }

  async #realIndexPaths(
    workspace: string,
    signal: AbortSignal,
  ): Promise<{ readonly index: string; readonly lock: string }> {
    const rawGitDirectory = (
      await this.#git(
        workspace,
        ["rev-parse", "--absolute-git-dir"],
        signal,
        "REF_UPDATE_FAILED",
        "The Git metadata folder could not be resolved safely.",
      )
    ).stdout.trim()
    const rawIndex = (
      await this.#git(
        workspace,
        ["rev-parse", "--git-path", "index"],
        signal,
        "REF_UPDATE_FAILED",
        "The Git index path could not be resolved safely.",
      )
    ).stdout.trim()
    if (!rawGitDirectory || !rawIndex || /[\0\r\n]/.test(rawGitDirectory + rawIndex)) {
      throw error("REF_UPDATE_FAILED", "Git returned an unsafe index path.")
    }
    let gitDirectory: string
    let index: string
    try {
      gitDirectory = await realpath(resolve(rawGitDirectory))
      const candidate = isAbsolute(rawIndex) ? resolve(rawIndex) : resolve(workspace, rawIndex)
      const parent = await realpath(dirname(candidate))
      const details = await lstat(candidate)
      index = await realpath(candidate)
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        !isInside(gitDirectory, parent) ||
        !isInside(gitDirectory, index)
      ) {
        throw new Error("unsafe index")
      }
    } catch {
      throw error("REF_UPDATE_FAILED", "The Git index path is unsafe.")
    }
    return { index, lock: `${index}.lock` }
  }

  async #recoverRefAfterInstallFailure(
    workspace: string,
    oldHead: string,
    commit: string,
    tree: string,
  ): Promise<void> {
    const recovery = new AbortController()
    const timer = setTimeout(
      () => recovery.abort(error("REF_UPDATE_FAILED", "Publication recovery timed out.")),
      10_000,
    )
    try {
      const current = (
        await this.#git(
          workspace,
          ["rev-parse", "--verify", "refs/heads/main"],
          recovery.signal,
          "REF_UPDATE_FAILED",
          "The publication ref could not be inspected during recovery.",
        )
      ).stdout.trim()
      if (current === oldHead) {
        this.#pendingPush = undefined
        return
      }
      if (current !== commit) {
        this.#terminationUncertain = true
        throw error("REF_UPDATE_FAILED", "The main branch changed during publication recovery.")
      }
      this.#pendingPush = { commit, tree }
      await this.#git(
        workspace,
        ["update-ref", "refs/heads/main", oldHead, commit],
        recovery.signal,
        "REF_UPDATE_FAILED",
        "The publication ref could not be restored safely.",
      )
      this.#pendingPush = undefined
    } catch (caught) {
      this.#terminationUncertain = true
      throw caught
    } finally {
      clearTimeout(timer)
    }
  }

  async #installVerifiedRefAndIndex(options: {
    readonly workspace: string
    readonly temporaryIndex: string
    readonly oldHead: string
    readonly commit: string
    readonly tree: string
    readonly callerSignal: AbortSignal
  }): Promise<void> {
    if (options.callerSignal.aborted) throw options.callerSignal.reason
    const paths = await this.#realIndexPaths(options.workspace, options.callerSignal)
    await this.dependencies.beforeIndexLockAcquired?.()
    if (options.callerSignal.aborted) throw options.callerSignal.reason
    let lock: Awaited<ReturnType<typeof open>>
    try {
      lock = await open(paths.lock, "wx", 0o600)
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EEXIST") {
        throw error("INDEX_LOCKED", "Another Git operation is updating the publication index.")
      }
      throw error("REF_UPDATE_FAILED", "The Git index could not be locked safely.")
    }
    let ownsLock = true
    let lockOpen = true
    let refMayHaveAdvanced = false
    const critical = new AbortController()
    const criticalTimer = setTimeout(
      () =>
        critical.abort(error("REF_UPDATE_FAILED", "Publication installation timed out safely.")),
      Math.max(1, this.dependencies.criticalSectionTimeoutMs ?? 10_000),
    )
    try {
      const branch = (
        await this.#git(
          options.workspace,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          critical.signal,
          "REF_CHANGED",
          "The current branch changed during publication.",
        )
      ).stdout.trim()
      if (branch !== "main") {
        throw error("REF_CHANGED", "The current branch changed during publication.")
      }
      const head = (
        await this.#git(
          options.workspace,
          ["rev-parse", "--verify", "HEAD"],
          critical.signal,
          "REF_CHANGED",
          "The current publication version changed during publication.",
        )
      ).stdout.trim()
      if (head !== options.oldHead) {
        throw error("REF_CHANGED", "The current publication version changed during publication.")
      }
      const staged = await this.#git(
        options.workspace,
        ["diff", "--cached", "--quiet", "--exit-code"],
        critical.signal,
        "REF_UPDATE_FAILED",
        "The prepared Git state could not be rechecked safely.",
        { acceptedExitCodes: [0, 1] },
      )
      if (staged.exitCode !== 0) {
        throw error("STAGED_CHANGES", "Other prepared changes appeared during publication.")
      }
      refMayHaveAdvanced = true
      await this.#git(
        options.workspace,
        ["update-ref", "refs/heads/main", options.commit, options.oldHead],
        critical.signal,
        "REF_UPDATE_FAILED",
        "The verified publication version could not be installed.",
      )
      this.#pendingPush = { commit: options.commit, tree: options.tree }

      const indexDetails = await stat(options.temporaryIndex)
      if (
        !indexDetails.isFile() ||
        indexDetails.size <= 0 ||
        indexDetails.size > MAX_GIT_INDEX_BYTES
      ) {
        throw error("REF_UPDATE_FAILED", "The verified temporary index is invalid.")
      }
      const verifiedIndex = await readFile(options.temporaryIndex)
      if (critical.signal.aborted) throw critical.signal.reason
      await lock.writeFile(verifiedIndex)
      await lock.sync()
      await lock.close()
      lockOpen = false
      await rename(paths.lock, paths.index)
      ownsLock = false

      const installedTree = (
        await this.#git(
          options.workspace,
          ["rev-parse", "--verify", "refs/heads/main^{tree}"],
          critical.signal,
          "REF_UPDATE_FAILED",
          "The installed publication tree could not be confirmed.",
        )
      ).stdout.trim()
      if (installedTree !== options.tree) {
        this.#terminationUncertain = true
        throw error("TREE_INVALID", "The installed tree differs from the verified tree.")
      }
    } catch (caught) {
      if (!ownsLock) this.#terminationUncertain = true
      if (refMayHaveAdvanced && this.#pendingPush?.commit !== options.commit) {
        this.#pendingPush = { commit: options.commit, tree: options.tree }
      }
      if (refMayHaveAdvanced && ownsLock) {
        try {
          await this.#recoverRefAfterInstallFailure(
            options.workspace,
            options.oldHead,
            options.commit,
            options.tree,
          )
        } catch {
          // Recovery marks the service fail-closed and retains any installed ref state.
        }
      }
      throw caught
    } finally {
      clearTimeout(criticalTimer)
      if (ownsLock) {
        let lockCleanupFailed = false
        if (lockOpen) {
          await lock.close().catch(() => {
            lockCleanupFailed = true
          })
        }
        await unlink(paths.lock).catch(() => {
          lockCleanupFailed = true
        })
        if (lockCleanupFailed) {
          this.#terminationUncertain = true
          throw error("CLEANUP_FAILED", "The Git index lock could not be released safely.")
        }
      }
    }
    if (options.callerSignal.aborted) throw options.callerSignal.reason
  }

  async #workspace(signal: AbortSignal): Promise<string> {
    let workspace: string
    try {
      workspace = await realpath(resolve(this.dependencies.workspace))
    } catch {
      throw error("GIT_UNAVAILABLE", "The publication workspace is unavailable.")
    }
    const top = await this.#git(
      workspace,
      ["rev-parse", "--show-toplevel"],
      signal,
      "GIT_UNAVAILABLE",
      "The publication workspace is not a Git repository.",
    )
    let gitRoot: string
    try {
      gitRoot = await realpath(resolve(top.stdout.trim()))
    } catch {
      throw error("GIT_ROOT_MISMATCH", "Open the repository root before publishing.")
    }
    if (
      process.platform === "win32"
        ? gitRoot.toLowerCase() !== workspace.toLowerCase()
        : gitRoot !== workspace
    ) {
      throw error("GIT_ROOT_MISMATCH", "Open the repository root before publishing.")
    }
    return workspace
  }

  async #assertRuntime(workspace: string, signal: AbortSignal): Promise<void> {
    const runtime = this.dependencies.runtime
    const declaredRoot = resolve(runtime.root)
    const expectedNode = resolve(declaredRoot, "node.exe")
    const expectedNpm = resolve(declaredRoot, "node_modules", "npm", "bin", "npm-cli.js")
    const expectedModules = resolve(workspace, "node_modules")
    if (
      !pathsEqual(resolve(runtime.nodeExecutable), expectedNode) ||
      !pathsEqual(resolve(runtime.npmCliPath), expectedNpm) ||
      !pathsEqual(resolve(runtime.nodeModules), expectedModules)
    ) {
      throw error("RUNTIME_MISSING", "The bundled publication runtime is unavailable.")
    }
    try {
      const rootDetails = await lstat(declaredRoot)
      const modulesDetails = await lstat(expectedModules)
      if (
        !rootDetails.isDirectory() ||
        rootDetails.isSymbolicLink() ||
        !modulesDetails.isDirectory() ||
        modulesDetails.isSymbolicLink()
      ) {
        throw new Error("linked runtime root")
      }
      const canonicalRoot = await realpath(declaredRoot)
      const canonicalModules = await realpath(expectedModules)
      if (
        !pathsEqual(canonicalRoot, declaredRoot) ||
        !pathsEqual(canonicalModules, expectedModules)
      ) {
        throw new Error("aliased runtime root")
      }
      for (const path of [
        expectedNode,
        resolve(declaredRoot, "node_modules"),
        resolve(declaredRoot, "node_modules", "npm"),
        resolve(declaredRoot, "node_modules", "npm", "bin"),
        expectedNpm,
      ]) {
        const details = await lstat(path)
        if (details.isSymbolicLink()) throw new Error("linked runtime component")
        if (path === expectedNode || path === expectedNpm) {
          if (!details.isFile()) throw new Error("runtime component is not a file")
        } else if (!details.isDirectory()) {
          throw new Error("runtime component is not a directory")
        }
        const canonical = await realpath(path)
        if (!isInside(canonicalRoot, canonical) || !pathsEqual(canonical, resolve(path))) {
          throw new Error("runtime component escaped bundle root")
        }
      }
    } catch {
      throw error("RUNTIME_MISSING", "The bundled publication runtime is unavailable.")
    }
    const request: VerifySiteRequest = {
      executable: runtime.nodeExecutable,
      args: [runtime.npmCliPath, "ls", "--all", "--json", "--ignore-scripts"],
      cwd: workspace,
      signal,
    }
    let valid = false
    try {
      valid = this.dependencies.validateDependencies
        ? await this.#guard(this.dependencies.validateDependencies(request), signal)
        : (
            await this.#run(
              request,
              signal,
              "DEPENDENCIES_INVALID",
              "The site dependencies are incomplete.",
            )
          ).exitCode === 0
    } catch (caught) {
      if (signal.aborted) throw signal.reason
      if (caught instanceof PublishError) throw caught
      throw error("DEPENDENCIES_INVALID", "The site dependencies are incomplete.")
    }
    if (!valid) throw error("DEPENDENCIES_INVALID", "The site dependencies are incomplete.")
  }

  async #stateRoot(workspace: string): Promise<string> {
    const state = join(workspace, ".garden-publisher")
    const publish = join(state, "publish")
    for (const directory of [state, publish]) {
      try {
        const details = await lstat(directory)
        if (!details.isDirectory() || details.isSymbolicLink()) {
          throw error("UNSAFE_STATE_PATH", "The publication state folder is unsafe.")
        }
      } catch (caught) {
        if (caught instanceof PublishError) throw caught
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error("UNSAFE_STATE_PATH", "The publication state folder is unavailable.")
        }
        try {
          await mkdir(directory)
        } catch {
          throw error("UNSAFE_STATE_PATH", "The publication state folder is unavailable.")
        }
      }
      let canonical: string
      try {
        canonical = await realpath(directory)
      } catch {
        throw error("UNSAFE_STATE_PATH", "The publication state folder is unavailable.")
      }
      if (!isInside(workspace, canonical)) {
        throw error("UNSAFE_STATE_PATH", "The publication state folder escaped the workspace.")
      }
    }
    return realpath(publish)
  }

  async #paths(workspace: string): Promise<OperationPaths> {
    const publishRoot = await this.#stateRoot(workspace)
    let root: string
    try {
      root = await mkdtemp(join(publishRoot, "operation-"))
    } catch {
      throw error("UNSAFE_STATE_PATH", "A controlled publication folder could not be created.")
    }
    const canonical = await realpath(root)
    if (!isInside(publishRoot, canonical) || canonical === publishRoot) {
      throw error("UNSAFE_STATE_PATH", "The publication operation folder is unsafe.")
    }
    const verify = join(canonical, "verify")
    return {
      root: canonical,
      index: join(canonical, "temporary.index"),
      verify,
      dependencyLink: join(verify, "node_modules"),
    }
  }

  async #cleanup(
    workspace: string,
    paths: OperationPaths | undefined,
    worktreeAdded: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!paths) return
    let cleanupFailure = false
    try {
      await unlink(paths.dependencyLink)
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailure = true
    }
    if (worktreeAdded) {
      try {
        const cleanupController = new AbortController()
        const timer = setTimeout(() => cleanupController.abort(), 10_000)
        try {
          const result = await this.#runner.run({
            executable: "git",
            args: ["worktree", "remove", "--force", "--", paths.verify],
            cwd: workspace,
            env: gitEnvironment,
            signal: cleanupController.signal,
          })
          if (result.exitCode !== 0) cleanupFailure = true
        } finally {
          clearTimeout(timer)
        }
      } catch {
        cleanupFailure = true
      }
    }
    try {
      const publishRoot = await realpath(join(workspace, ".garden-publisher", "publish"))
      const details = await lstat(paths.root)
      const canonical = await realpath(paths.root)
      if (
        details.isSymbolicLink() ||
        !details.isDirectory() ||
        !isInside(publishRoot, canonical) ||
        canonical === publishRoot
      ) {
        cleanupFailure = true
      } else {
        await rm(canonical, { force: true, recursive: true })
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailure = true
    }
    if (cleanupFailure) {
      throw error("CLEANUP_FAILED", "Temporary publication files could not be removed safely.")
    }
  }

  async #execute(selection: PublishSelection, signal: AbortSignal): Promise<PublishResult> {
    const paths = normalizeSelection(selection.paths)
    const message = safeMessage(selection.message)
    this.#emit("preflight-fetch")
    const workspace = await this.#workspace(signal)
    await this.#assertRuntime(workspace, signal)

    const branchResult = await this.#git(
      workspace,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
      "DETACHED_HEAD",
      "Publishing requires the main branch.",
    )
    const branch = branchResult.stdout.trim()
    if (branch !== "main")
      throw error("BRANCH_UNSAFE", "Switch to the main branch before publishing.")

    const staged = await this.#git(
      workspace,
      ["diff", "--cached", "--quiet", "--exit-code"],
      signal,
      "GIT_UNAVAILABLE",
      "Could not inspect prepared Git changes.",
      { acceptedExitCodes: [0, 1] },
    )
    if (staged.exitCode === 1) {
      throw error("STAGED_CHANGES", "Other prepared changes must be handled before publishing.")
    }
    await this.#git(
      workspace,
      ["fetch", "--no-tags", "origin", "main"],
      signal,
      "REMOTE_UNAVAILABLE",
      "The remote publication branch could not be refreshed.",
    )
    const oldHead = (
      await this.#git(
        workspace,
        ["rev-parse", "--verify", "HEAD"],
        signal,
        "GIT_UNAVAILABLE",
        "The current publication version is unavailable.",
      )
    ).stdout.trim()
    await this.#git(
      workspace,
      ["rev-parse", "--verify", "refs/remotes/origin/main"],
      signal,
      "REMOTE_UNAVAILABLE",
      "The remote publication branch is unavailable.",
    )
    const ancestry = await this.#git(
      workspace,
      ["merge-base", "--is-ancestor", "refs/remotes/origin/main", oldHead],
      signal,
      "REMOTE_DIVERGED",
      "The remote publication branch has diverged.",
      { acceptedExitCodes: [0, 1] },
    )
    if (ancestry.exitCode !== 0) {
      throw error("REMOTE_DIVERGED", "Refresh and reconcile the remote branch before publishing.")
    }

    let operationPaths: OperationPaths | undefined
    let worktreeAdded = false
    let primaryError: unknown
    try {
      operationPaths = await this.#paths(workspace)
      const indexEnvironment = { ...gitEnvironment, GIT_INDEX_FILE: operationPaths.index }
      this.#emit("stage-temporary-index")
      await this.#git(
        workspace,
        ["read-tree", oldHead],
        signal,
        "STAGING_FAILED",
        "The temporary publication index could not be initialized.",
        { env: indexEnvironment },
      )
      await this.#git(
        workspace,
        ["add", "-A", "--", ...paths],
        signal,
        "STAGING_FAILED",
        "The selected publication items could not be prepared.",
        { env: indexEnvironment },
      )
      const stagedPaths = [
        ...decodeNulPaths(
          (
            await this.#git(
              workspace,
              ["diff", "--cached", "--no-renames", "--name-only", "-z", oldHead, "--"],
              signal,
              "STAGING_FAILED",
              "The selected publication items could not be checked.",
              { env: indexEnvironment },
            )
          ).stdout,
        ),
      ].sort()
      if (
        stagedPaths.length !== paths.length ||
        stagedPaths.some((path, index) => path !== paths[index])
      ) {
        throw error(
          "INVALID_SELECTION",
          "The selected paths do not exactly match publishable changes.",
        )
      }
      await this.#git(
        workspace,
        ["diff", "--cached", "--check"],
        signal,
        "STAGING_FAILED",
        "The selected publication contains invalid whitespace changes.",
        { env: indexEnvironment },
      )

      this.#emit("write-tree")
      const tree = (
        await this.#git(
          workspace,
          ["write-tree"],
          signal,
          "TREE_INVALID",
          "The exact publication tree could not be created.",
          { env: indexEnvironment },
        )
      ).stdout.trim()
      const treePaths = decodeNulPaths(
        (
          await this.#git(
            workspace,
            ["ls-tree", "-r", "--name-only", "-z", tree],
            signal,
            "TREE_INVALID",
            "The publication tree could not be inspected.",
          )
        ).stdout,
      )
      if (treePaths.some((path) => /^private(?:\/|$)/i.test(path))) {
        throw error("PRIVATE_PATH", "The publication tree contains private content.")
      }

      this.#emit("synthetic-commit")
      const commit = (
        await this.#git(
          workspace,
          ["commit-tree", tree, "-p", oldHead, "-m", message],
          signal,
          "COMMIT_FAILED",
          "A temporary publication version could not be created.",
        )
      ).stdout.trim()

      this.#emit("verify-worktree")
      await this.#git(
        workspace,
        ["worktree", "add", "--detach", "--", operationPaths.verify, commit],
        signal,
        "VERIFY_FAILED",
        "The isolated verification folder could not be created.",
      )
      worktreeAdded = true
      const createLink =
        this.dependencies.createDependencyLink ??
        ((request: DependencyLinkRequest) => symlink(request.target, request.link, request.type))
      await this.#guard(
        createLink({
          target: this.dependencies.runtime.nodeModules,
          link: operationPaths.dependencyLink,
          type: "junction",
        }),
        signal,
      )
      const verifyRequest: VerifySiteRequest = {
        executable: this.dependencies.runtime.nodeExecutable,
        args: [this.dependencies.runtime.npmCliPath, "run", "verify:site"],
        cwd: operationPaths.verify,
        signal,
      }
      let verified: { readonly exitCode: number }
      try {
        verified = this.dependencies.verifySite
          ? await this.#guard(this.dependencies.verifySite(verifyRequest), signal)
          : await this.#run(
              verifyRequest,
              signal,
              "VERIFY_FAILED",
              "The website verification failed.",
            )
      } catch (caught) {
        if (signal.aborted) throw signal.reason
        if (caught instanceof PublishError) throw caught
        throw error("VERIFY_FAILED", "The website verification failed.")
      }
      if (signal.aborted) throw signal.reason
      if (verified.exitCode !== 0) throw error("VERIFY_FAILED", "The website verification failed.")
      const verifiedTree = (
        await this.#git(
          operationPaths.verify,
          ["rev-parse", "HEAD^{tree}"],
          signal,
          "VERIFY_FAILED",
          "The verified website tree could not be confirmed.",
        )
      ).stdout.trim()
      if (verifiedTree !== tree)
        throw error("TREE_INVALID", "The verified tree changed unexpectedly.")

      this.#emit("update-local-ref")
      const currentHead = (
        await this.#git(
          workspace,
          ["rev-parse", "--verify", "refs/heads/main"],
          signal,
          "REF_CHANGED",
          "The main branch changed during publication.",
        )
      ).stdout.trim()
      if (currentHead !== oldHead)
        throw error("REF_CHANGED", "The main branch changed during publication.")
      const currentBranch = (
        await this.#git(
          workspace,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          signal,
          "REF_CHANGED",
          "The current branch changed during publication.",
        )
      ).stdout.trim()
      if (currentBranch !== "main")
        throw error("REF_CHANGED", "The current branch changed during publication.")
      await this.#installVerifiedRefAndIndex({
        workspace,
        temporaryIndex: operationPaths.index,
        oldHead,
        commit,
        tree,
        callerSignal: signal,
      })

      this.#emit("push")
      await this.#git(
        workspace,
        ["push", "origin", `${commit}:refs/heads/main`],
        signal,
        "PUSH_FAILED",
        "Could not upload the verified publication. The local version was kept for retry.",
      )
      await this.#confirmRemote(workspace, commit, tree, signal)
      this.#pendingPush = undefined
      return { commit, tree, pushed: true }
    } catch (caught) {
      primaryError = caught
      throw caught
    } finally {
      this.#emit("cleanup")
      try {
        await this.#cleanup(workspace, operationPaths, worktreeAdded, signal)
      } catch (cleanupError) {
        this.#terminationUncertain = true
        if (primaryError === undefined) throw cleanupError
      }
    }
  }

  publish(selection: PublishSelection): Promise<PublishResult> {
    if (this.#terminationUncertain) {
      return Promise.reject(
        error(
          "CLEANUP_FAILED",
          "A prior publication command may still be running; restart the app.",
        ),
      )
    }
    if (this.#active)
      return Promise.reject(error("PUBLISH_ACTIVE", "A publication is already running."))
    const controller = new AbortController()
    const timeoutMs = Math.max(1, this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const cancelFromCaller = (): void =>
      controller.abort(error("PUBLISH_CANCELLED", "Publication was cancelled."))
    selection.signal?.addEventListener("abort", cancelFromCaller, { once: true })
    const timer = setTimeout(() => {
      controller.abort(error("PUBLISH_TIMEOUT", "Publication timed out."))
    }, timeoutMs)
    if (selection.signal?.aborted) cancelFromCaller()
    const operation = this.#execute(selection, controller.signal).then((result) => {
      this.#emit("complete")
      return result
    })
    const settled = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        clearTimeout(timer)
        selection.signal?.removeEventListener("abort", cancelFromCaller)
        if (this.#active?.controller === controller) this.#active = undefined
      })
    this.#active = { controller, settled }
    return operation
  }

  async cancel(): Promise<void> {
    const active = this.#active
    active?.controller.abort(error("PUBLISH_CANCELLED", "Publication was cancelled."))
    await active?.settled
  }

  retryPush(signal?: AbortSignal): Promise<PublishResult> {
    if (this.#terminationUncertain) {
      return Promise.reject(
        error(
          "CLEANUP_FAILED",
          "A prior publication command may still be running; restart the app.",
        ),
      )
    }
    if (this.#active)
      return Promise.reject(error("PUBLISH_ACTIVE", "A publication is already running."))
    const pending = this.#pendingPush
    if (!pending)
      return Promise.reject(
        error("INVALID_SELECTION", "There is no verified publication waiting to upload."),
      )
    const controller = new AbortController()
    const relay = (): void =>
      controller.abort(error("PUBLISH_CANCELLED", "Publication was cancelled."))
    signal?.addEventListener("abort", relay, { once: true })
    if (signal?.aborted) relay()
    const timer = setTimeout(
      () => controller.abort(error("PUBLISH_TIMEOUT", "Publication timed out.")),
      Math.max(1, this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    )
    const operation = (async (): Promise<PublishResult> => {
      try {
        const workspace = await this.#workspace(controller.signal)
        this.#emit("preflight-fetch")
        await this.#git(
          workspace,
          ["fetch", "--no-tags", "origin", "main"],
          controller.signal,
          "REMOTE_UNAVAILABLE",
          "The remote publication branch could not be refreshed.",
        )
        const retainedMain = (
          await this.#git(
            workspace,
            ["rev-parse", "--verify", "refs/heads/main"],
            controller.signal,
            "REF_CHANGED",
            "The retained publication version is unavailable.",
          )
        ).stdout.trim()
        if (retainedMain !== pending.commit)
          throw error("REF_CHANGED", "The retained publication version changed.")
        const ancestry = await this.#git(
          workspace,
          ["merge-base", "--is-ancestor", "refs/remotes/origin/main", pending.commit],
          controller.signal,
          "REMOTE_DIVERGED",
          "The remote publication branch has diverged.",
          { acceptedExitCodes: [0, 1] },
        )
        if (ancestry.exitCode !== 0)
          throw error("REMOTE_DIVERGED", "The remote branch changed after verification.")
        this.#emit("push")
        await this.#git(
          workspace,
          ["push", "origin", `${pending.commit}:refs/heads/main`],
          controller.signal,
          "PUSH_FAILED",
          "Could not upload the retained publication.",
        )
        await this.#confirmRemote(workspace, pending.commit, pending.tree, controller.signal)
        this.#pendingPush = undefined
        this.#emit("complete")
        return { ...pending, pushed: true }
      } finally {
        signal?.removeEventListener("abort", relay)
      }
    })()
    const settled = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        clearTimeout(timer)
        if (this.#active?.controller === controller) this.#active = undefined
      })
    this.#active = { controller, settled }
    return operation
  }

  async dispose(): Promise<void> {
    await this.cancel()
  }
}
