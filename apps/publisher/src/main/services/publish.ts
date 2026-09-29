import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
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
  /** Test-only cleanup race seam. Production construction never supplies this hook. */
  readonly beforeDependencyLinkUnlink?: (request: DependencyLinkRequest) => Promise<void>
}

/** Explicitly unsafe construction seam used only by repository integration tests. */
export type PublisherTestDependencies = PublishDependencies

export interface ProductionPublisherOptions {
  readonly workspace: string
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
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
  readonly publishRoot: string
  readonly publishRootIdentity: FileIdentity
  readonly root: string
  readonly rootIdentity: FileIdentity
  readonly index: string
  readonly installIndex: string
  readonly verify: string
  verifyIdentity?: FileIdentity
  readonly dependencyLink: string
  readonly dependencyTarget: string
  readonly dependencyTargetIdentity: FileIdentity
  dependencyLinkIdentity?: FileIdentity
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
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
  const allowed = new Set([
    "workspace",
    "isPackaged",
    "resourcesPath",
    "appPath",
    "onProgress",
    "timeoutMs",
    "criticalSectionTimeoutMs",
  ])
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new TypeError("Unsupported production publisher option.")
  }
  const { workspace, isPackaged, resourcesPath, appPath } = options
  return new Publisher(
    {
      workspace,
      runtime: resolveProductionPublishRuntime({
        workspace,
        isPackaged,
        resourcesPath,
        appPath,
      }),
      onProgress: options.onProgress,
      timeoutMs: options.timeoutMs,
      criticalSectionTimeoutMs: options.criticalSectionTimeoutMs,
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

export interface BoundedCommandRequest extends CommandRequest {
  readonly maxOutputBytes?: number
}

export interface BoundedCommandRunner extends CommandRunner {
  run(request: BoundedCommandRequest): Promise<CommandResult>
}

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

const commonInheritedEnvironmentKeys = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "windir",
  "PATH",
  "Path",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "COMSPEC",
  "PATHEXT",
] as const

const gitCredentialEnvironmentKeys = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GCM_INTERACTIVE",
  "GCM_PROVIDER",
  "GCM_AUTHORITY",
  "GCM_HTTP_TIMEOUT",
] as const

const gitProxyEnvironmentKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const

const internalGitEnvironmentKeys = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_TERMINAL_PROMPT",
])
const safeRequestedEnvironmentKeys = new Set(["npm_config_audit", "npm_config_fund"])

function publishCommandEnvironment(
  executable: string,
  requested: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of commonInheritedEnvironmentKeys) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  const git = ["git", "git.exe"].includes(basename(executable).toLowerCase())
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (safeRequestedEnvironmentKeys.has(key) && value !== undefined) environment[key] = value
  }
  if (git) {
    for (const key of [...gitCredentialEnvironmentKeys, ...gitProxyEnvironmentKeys]) {
      const value = process.env[key]
      if (value !== undefined) environment[key] = value
    }
    for (const [key, value] of Object.entries(requested ?? {})) {
      if (internalGitEnvironmentKeys.has(key) && value !== undefined) environment[key] = value
    }
  }
  return environment
}

export function createBoundedPublishCommandRunner(options: {
  readonly spawner: PublishCommandSpawner
  readonly terminate: (child: PublishCommandProcess) => Promise<boolean>
  readonly commandDeadlineMs?: number
  readonly terminationDeadlineMs?: number
}): BoundedCommandRunner {
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
            env: publishCommandEnvironment(request.executable, request.env),
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
        const outputLimit = Math.min(
          MAX_OUTPUT_BYTES,
          Math.max(1, request.maxOutputBytes ?? MAX_OUTPUT_BYTES),
        )
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
          if (stdoutBytes + stderrBytes > outputLimit) {
            stop(new PublishCommandFailure("Publication command output exceeded its safe limit."))
          } else {
            stdout.push(bytes)
          }
        })
        child.stderr.on("data", (chunk: Buffer | string) => {
          if (settled || stopping) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stderrBytes += bytes.byteLength
          if (stderrBytes > MAX_STDERR_BYTES || stdoutBytes + stderrBytes > outputLimit) {
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

export function createSystemBoundedCommandRunner(
  options: {
    readonly commandDeadlineMs?: number
    readonly terminationDeadlineMs?: number
  } = {},
): BoundedCommandRunner {
  const terminate = createProductionProcessTreeTerminator()
  return createBoundedPublishCommandRunner({
    spawner: (executable, args, options) =>
      spawn(executable, [...args], options) as unknown as PublishCommandProcess,
    terminate: (child) => terminate(child),
    commandDeadlineMs: options.commandDeadlineMs,
    terminationDeadlineMs: options.terminationDeadlineMs,
  })
}

const systemPublishCommandRunner = createSystemBoundedCommandRunner()

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

function fileIdentity(details: {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
}): FileIdentity {
  return { dev: details.dev, ino: details.ino, birthtimeNs: details.birthtimeNs }
}

function sameIdentity(
  left: FileIdentity,
  right: { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
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
    readonly operationPaths: OperationPaths
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

      if (!(await this.#operationPathsAreCurrent(options.operationPaths))) {
        throw error("CLEANUP_FAILED", "The publication operation folder changed unexpectedly.")
      }
      try {
        await lstat(options.operationPaths.installIndex)
        throw error("REF_UPDATE_FAILED", "The controlled installation index already exists.")
      } catch (caught) {
        if (caught instanceof PublishError) throw caught
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error("REF_UPDATE_FAILED", "The controlled installation index is unavailable.")
        }
      }
      const installEnvironment = {
        ...gitEnvironment,
        GIT_INDEX_FILE: options.operationPaths.installIndex,
      }
      await this.#git(
        options.workspace,
        ["read-tree", options.tree],
        critical.signal,
        "REF_UPDATE_FAILED",
        "The verified publication index could not be regenerated.",
        { env: installEnvironment },
      )
      const installDetails = await lstat(options.operationPaths.installIndex).catch(() => undefined)
      const installCanonical = await realpath(options.operationPaths.installIndex).catch(
        () => undefined,
      )
      if (
        !installDetails?.isFile() ||
        installDetails.isSymbolicLink() ||
        !installCanonical ||
        !pathsEqual(installCanonical, resolve(options.operationPaths.installIndex)) ||
        !isInside(options.operationPaths.root, installCanonical)
      ) {
        throw error("REF_UPDATE_FAILED", "The regenerated publication index is unsafe.")
      }
      const installTree = (
        await this.#git(
          options.workspace,
          ["write-tree"],
          critical.signal,
          "REF_UPDATE_FAILED",
          "The regenerated publication index could not be verified.",
          { env: installEnvironment },
        )
      ).stdout.trim()
      if (installTree !== options.tree) {
        throw error("TREE_INVALID", "The regenerated publication index differs from verification.")
      }
      const checkedDetails = await lstat(options.operationPaths.installIndex, {
        bigint: true,
      }).catch(() => undefined)
      const checkedCanonical = await realpath(options.operationPaths.installIndex).catch(
        () => undefined,
      )
      if (
        !checkedDetails?.isFile() ||
        checkedDetails.isSymbolicLink() ||
        !checkedCanonical ||
        !pathsEqual(checkedCanonical, resolve(options.operationPaths.installIndex)) ||
        !isInside(options.operationPaths.root, checkedCanonical)
      ) {
        throw error("REF_UPDATE_FAILED", "The regenerated publication index changed unexpectedly.")
      }
      const installIdentity = fileIdentity(checkedDetails)
      const installHandle = await open(options.operationPaths.installIndex, "r")
      let verifiedIndex: Buffer
      try {
        const openedDetails = await installHandle.stat({ bigint: true })
        if (
          !openedDetails.isFile() ||
          !sameIdentity(installIdentity, openedDetails) ||
          openedDetails.size <= 0n ||
          openedDetails.size > BigInt(MAX_GIT_INDEX_BYTES)
        ) {
          throw error("REF_UPDATE_FAILED", "The regenerated publication index is invalid.")
        }
        verifiedIndex = await installHandle.readFile()
        const finalDetails = await installHandle.stat({ bigint: true })
        if (
          !sameIdentity(installIdentity, finalDetails) ||
          finalDetails.size !== BigInt(verifiedIndex.byteLength)
        ) {
          throw error("REF_UPDATE_FAILED", "The regenerated publication index changed while read.")
        }
      } finally {
        await installHandle.close()
      }
      if (critical.signal.aborted) throw critical.signal.reason

      refMayHaveAdvanced = true
      await this.#git(
        options.workspace,
        ["update-ref", "refs/heads/main", options.commit, options.oldHead],
        critical.signal,
        "REF_UPDATE_FAILED",
        "The verified publication version could not be installed.",
      )
      this.#pendingPush = { commit: options.commit, tree: options.tree }

      await lock.writeFile(verifiedIndex)
      // Persist the complete verified index before the atomic lock-file replacement.
      await lock.sync()
      await lock.close()
      lockOpen = false
      await rename(paths.lock, paths.index)
      ownsLock = false

      const installedIndexTree = (
        await this.#git(
          options.workspace,
          ["write-tree"],
          critical.signal,
          "REF_UPDATE_FAILED",
          "The installed publication index could not be confirmed.",
        )
      ).stdout.trim()
      if (installedIndexTree !== options.tree) {
        this.#terminationUncertain = true
        throw error("TREE_INVALID", "The installed index differs from the verified tree.")
      }
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
    const publishRootDetails = await lstat(publishRoot, { bigint: true })
    const rootDetails = await lstat(canonical, { bigint: true })
    const dependencyTarget = await realpath(this.dependencies.runtime.nodeModules)
    const dependencyTargetDetails = await lstat(dependencyTarget, { bigint: true })
    if (
      publishRootDetails.isSymbolicLink() ||
      !publishRootDetails.isDirectory() ||
      rootDetails.isSymbolicLink() ||
      !rootDetails.isDirectory()
    ) {
      throw error("UNSAFE_STATE_PATH", "The publication operation folder is unsafe.")
    }
    const verify = join(canonical, "verify")
    return {
      publishRoot,
      publishRootIdentity: fileIdentity(publishRootDetails),
      root: canonical,
      rootIdentity: fileIdentity(rootDetails),
      index: join(canonical, "temporary.index"),
      installIndex: join(canonical, `install-${randomUUID()}.index`),
      verify,
      dependencyLink: join(verify, "node_modules"),
      dependencyTarget,
      dependencyTargetIdentity: fileIdentity(dependencyTargetDetails),
    }
  }

  async #operationPathsAreCurrent(paths: OperationPaths): Promise<boolean> {
    try {
      const expectedPublishRoot = resolve(paths.publishRoot)
      const expectedRoot = resolve(paths.root)
      const rootDetails = await lstat(expectedRoot, { bigint: true })
      if (
        rootDetails.isSymbolicLink() ||
        !rootDetails.isDirectory() ||
        !sameIdentity(paths.rootIdentity, rootDetails) ||
        !(await this.#publishRootIsCurrent(paths))
      ) {
        return false
      }
      const canonicalRoot = await realpath(expectedRoot)
      return (
        pathsEqual(canonicalRoot, expectedRoot) &&
        isInside(expectedPublishRoot, canonicalRoot) &&
        !pathsEqual(expectedPublishRoot, canonicalRoot)
      )
    } catch {
      return false
    }
  }

  async #publishRootIsCurrent(paths: OperationPaths): Promise<boolean> {
    try {
      const expected = resolve(paths.publishRoot)
      const details = await lstat(expected, { bigint: true })
      const canonical = await realpath(expected)
      return (
        details.isDirectory() &&
        !details.isSymbolicLink() &&
        sameIdentity(paths.publishRootIdentity, details) &&
        pathsEqual(canonical, expected)
      )
    } catch {
      return false
    }
  }

  async #dependencyLinkIsCurrent(paths: OperationPaths): Promise<boolean> {
    try {
      const details = await lstat(paths.dependencyLink, { bigint: true })
      if (
        !paths.dependencyLinkIdentity ||
        !details.isSymbolicLink() ||
        !sameIdentity(paths.dependencyLinkIdentity, details)
      ) {
        return false
      }
      const target = await realpath(paths.dependencyLink)
      const targetDetails = await lstat(target, { bigint: true })
      return (
        pathsEqual(target, paths.dependencyTarget) &&
        targetDetails.isDirectory() &&
        !targetDetails.isSymbolicLink() &&
        sameIdentity(paths.dependencyTargetIdentity, targetDetails)
      )
    } catch (caught) {
      return (
        paths.dependencyLinkIdentity === undefined &&
        (caught as NodeJS.ErrnoException).code === "ENOENT"
      )
    }
  }

  async #verifyPathIsCurrent(paths: OperationPaths): Promise<boolean> {
    if (!paths.verifyIdentity || !(await this.#operationPathsAreCurrent(paths))) return false
    try {
      const details = await lstat(paths.verify, { bigint: true })
      const canonical = await realpath(paths.verify)
      return (
        details.isDirectory() &&
        !details.isSymbolicLink() &&
        sameIdentity(paths.verifyIdentity, details) &&
        pathsEqual(canonical, resolve(paths.verify)) &&
        isInside(paths.root, canonical)
      )
    } catch {
      return false
    }
  }

  async #cleanup(
    workspace: string,
    paths: OperationPaths | undefined,
    worktreeAdded: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!paths) return
    if (!(await this.#operationPathsAreCurrent(paths))) {
      throw error("CLEANUP_FAILED", "The publication operation folder changed unexpectedly.")
    }
    let cleanupFailure = false
    await this.dependencies.beforeDependencyLinkUnlink?.({
      target: paths.dependencyTarget,
      link: paths.dependencyLink,
      type: "junction",
    })
    if (
      !(await this.#operationPathsAreCurrent(paths)) ||
      !(await this.#dependencyLinkIsCurrent(paths))
    ) {
      throw error("CLEANUP_FAILED", "The publication dependency link changed unexpectedly.")
    }
    if (paths.dependencyLinkIdentity) {
      try {
        await unlink(paths.dependencyLink)
      } catch {
        throw error("CLEANUP_FAILED", "The publication dependency link could not be removed.")
      }
      if (
        !(await this.#operationPathsAreCurrent(paths)) ||
        (await lstat(paths.dependencyLink).then(
          () => true,
          (caught: NodeJS.ErrnoException) => caught.code !== "ENOENT",
        ))
      ) {
        throw error("CLEANUP_FAILED", "The publication dependency link was not removed safely.")
      }
    }
    if (worktreeAdded) {
      if (!(await this.#verifyPathIsCurrent(paths))) {
        throw error("CLEANUP_FAILED", "The verification worktree changed unexpectedly.")
      }
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
      if (!(await this.#operationPathsAreCurrent(paths))) cleanupFailure = true
      const verifyStillExists = await lstat(paths.verify).then(
        () => true,
        (caught: NodeJS.ErrnoException) => caught.code !== "ENOENT",
      )
      if (verifyStillExists) cleanupFailure = true
    }
    if (cleanupFailure) {
      throw error("CLEANUP_FAILED", "Temporary publication files could not be removed safely.")
    }
    if (!(await this.#operationPathsAreCurrent(paths))) {
      throw error("CLEANUP_FAILED", "The publication operation folder changed unexpectedly.")
    }
    const cleanupRoot = join(paths.publishRoot, `.cleanup-${randomUUID()}`)
    try {
      await lstat(cleanupRoot)
      cleanupFailure = true
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailure = true
    }
    if (!cleanupFailure) {
      try {
        if (!(await this.#operationPathsAreCurrent(paths))) {
          throw new Error("operation changed")
        }
        await rename(paths.root, cleanupRoot)
        const details = await lstat(cleanupRoot, { bigint: true })
        const canonical = await realpath(cleanupRoot)
        if (
          details.isSymbolicLink() ||
          !details.isDirectory() ||
          !sameIdentity(paths.rootIdentity, details) ||
          !pathsEqual(canonical, cleanupRoot) ||
          !isInside(paths.publishRoot, canonical) ||
          !(await this.#publishRootIsCurrent(paths))
        ) {
          throw new Error("quarantine changed")
        }
        await rm(cleanupRoot, { force: true, recursive: true })
        if (
          !(await this.#publishRootIsCurrent(paths)) ||
          (await lstat(cleanupRoot).then(
            () => true,
            (caught: NodeJS.ErrnoException) => caught.code !== "ENOENT",
          ))
        ) {
          throw new Error("quarantine cleanup uncertain")
        }
      } catch {
        cleanupFailure = true
      }
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
      const verifyDetails = await lstat(operationPaths.verify, { bigint: true }).catch(
        () => undefined,
      )
      const verifyCanonical = await realpath(operationPaths.verify).catch(() => undefined)
      if (
        !verifyDetails?.isDirectory() ||
        verifyDetails.isSymbolicLink() ||
        !verifyCanonical ||
        !pathsEqual(verifyCanonical, resolve(operationPaths.verify)) ||
        !isInside(operationPaths.root, verifyCanonical)
      ) {
        throw error("VERIFY_FAILED", "The isolated verification folder is unsafe.")
      }
      operationPaths.verifyIdentity = fileIdentity(verifyDetails)
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
      const dependencyLinkDetails = await lstat(operationPaths.dependencyLink, {
        bigint: true,
      }).catch(() => undefined)
      if (dependencyLinkDetails) {
        if (!dependencyLinkDetails.isSymbolicLink()) {
          throw error("VERIFY_FAILED", "The verification dependency link is unsafe.")
        }
        operationPaths.dependencyLinkIdentity = fileIdentity(dependencyLinkDetails)
        if (!(await this.#dependencyLinkIsCurrent(operationPaths))) {
          throw error("VERIFY_FAILED", "The verification dependency link is unsafe.")
        }
      } else if (!this.dependencies.createDependencyLink) {
        throw error("VERIFY_FAILED", "The verification dependency link is unavailable.")
      }
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
        operationPaths,
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
