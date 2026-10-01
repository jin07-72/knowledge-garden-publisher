import { lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import {
  PublishCommandFailure,
  type BoundedCommandRunner,
  createSystemBoundedCommandRunner,
} from "./publish"
import { inspectWorkspaceDependencyState } from "./workspace"
import {
  parseGitHubRepositoryUrl,
  type BlogCandidateInspection,
  type BlogCloneRequest,
  type BlogImportPhase,
  type BlogImportProgress,
  type BlogImportReceipt,
  type GitHubRepository,
} from "../../shared/contracts"

const maximumRepositoryUrlLength = 2_048
const importOutputBytes = 2 * 1024 * 1024
const gitReadEnvironment = { GIT_OPTIONAL_LOCKS: "0" } as const

export type {
  BlogCandidateInspection,
  BlogCloneRequest,
  BlogImportPhase,
  BlogImportProgress,
  BlogImportReceipt,
  GitHubRepository,
} from "../../shared/contracts"

export interface BlogCandidateDependencies {
  readonly runner?: BoundedCommandRunner
}

type ValidBlogCandidateInspection = Extract<BlogCandidateInspection, { readonly valid: true }>

interface ReservedBlogTarget {
  readonly displayPath: string
  readonly canonicalParent: string
  readonly canonicalPath: string
  readonly device: bigint
  readonly inode: bigint
  readonly parentDevice: bigint
  readonly parentInode: bigint
}

interface ParentIdentity {
  readonly canonicalPath: string
  readonly device: bigint
  readonly inode: bigint
}

export interface BlogImportService {
  clone(request: BlogCloneRequest, signal?: AbortSignal): Promise<BlogImportReceipt>
  install(path: string, signal?: AbortSignal): Promise<BlogCandidateInspection>
}

export interface BlogImportDependencies {
  readonly gitExecutable: string
  readonly nodePath: string
  readonly npmCliPath: string
  readonly runner: BoundedCommandRunner
  readonly inspect: typeof inspectBlogCandidate
  readonly onProgress: (progress: BlogImportProgress) => void
  readonly afterParentCapturedBeforeMkdir?: () => Promise<void>
}

export const BLOG_IMPORT_ERROR_CODES = [
  "DESTINATION_INVALID",
  "DESTINATION_EXISTS",
  "TARGET_CHANGED",
  "INVALID_REPOSITORY_URL",
  "IMPORT_UNAVAILABLE",
  "IMPORT_ACTIVE",
  "CANCELLED",
  "VALIDATION_FAILED",
  "INSTALL_FAILED",
  "CLONE_FAILED",
] as const

export type BlogImportErrorCode = (typeof BLOG_IMPORT_ERROR_CODES)[number]

export interface BlogImportErrorShape {
  readonly code: BlogImportErrorCode
  readonly message: string
  readonly path?: string
}

export class BlogImportError extends Error implements BlogImportErrorShape {
  constructor(
    readonly code: BlogImportErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message)
    this.name = "BlogImportError"
  }
}

function importError(code: BlogImportErrorCode, message: string, path?: string): BlogImportError {
  return new BlogImportError(code, message, path)
}

function terminationUncertainFailure(error: unknown): PublishCommandFailure | undefined {
  return error instanceof PublishCommandFailure && error.terminationUncertain ? error : undefined
}

function rethrowTerminationUncertain(error: unknown): void {
  const uncertain = terminationUncertainFailure(error)
  if (uncertain) throw uncertain
}

function pathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function reserveCloneTarget(
  path: string,
  afterParentCapturedBeforeMkdir?: () => Promise<void>,
): Promise<ReservedBlogTarget> {
  const displayPath = resolve(path)
  const parent = dirname(displayPath)
  let parentIdentity: ParentIdentity
  try {
    const canonicalPath = await realpath(parent)
    const parentDetails = await lstat(canonicalPath, { bigint: true })
    if (!parentDetails.isDirectory()) throw new Error("not a directory")
    parentIdentity = { canonicalPath, device: parentDetails.dev, inode: parentDetails.ino }
  } catch {
    throw importError("DESTINATION_INVALID", "The selected destination parent folder is unavailable.", displayPath)
  }
  try {
    await afterParentCapturedBeforeMkdir?.()
    await assertParentIdentity(parentIdentity, displayPath)
    await mkdir(displayPath)
  } catch (error) {
    if (error instanceof BlogImportError) throw error
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw importError("DESTINATION_EXISTS", "Choose a destination that does not already exist.", displayPath)
    }
    throw importError("DESTINATION_INVALID", "The selected destination cannot be reserved.", displayPath)
  }
  await assertParentIdentity(parentIdentity, displayPath)
  return await captureTarget(displayPath, parentIdentity, displayPath)
}

async function assertParentIdentity(parent: ParentIdentity, displayPath: string): Promise<void> {
  const canonicalPath = await realpath(parent.canonicalPath).catch(() => undefined)
  const details = await lstat(parent.canonicalPath, { bigint: true }).catch(() => undefined)
  if (
    !canonicalPath ||
    !details ||
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    !pathsEqual(canonicalPath, parent.canonicalPath) ||
    details.dev !== parent.device ||
    details.ino !== parent.inode
  ) {
    throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", displayPath)
  }
}

async function captureTarget(
  path: string,
  parent: ParentIdentity,
  displayPath: string,
): Promise<ReservedBlogTarget> {
  const canonicalPath = await realpath(path).catch(() => undefined)
  await assertParentIdentity(parent, displayPath)
  const details = await lstat(path, { bigint: true }).catch(() => undefined)
  const expectedPath = resolve(parent.canonicalPath, basename(path))
  if (
    !canonicalPath ||
    !details ||
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    !pathsEqual(canonicalPath, expectedPath) ||
    !pathInside(parent.canonicalPath, canonicalPath)
  ) {
    throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", displayPath)
  }
  return {
    displayPath,
    canonicalParent: parent.canonicalPath,
    canonicalPath,
    device: details.dev,
    inode: details.ino,
    parentDevice: parent.device,
    parentInode: parent.inode,
  }
}

async function assertTarget(target: ReservedBlogTarget): Promise<void> {
  const details = await lstat(target.canonicalPath, { bigint: true }).catch(() => undefined)
  const canonicalPath = await realpath(target.canonicalPath).catch(() => undefined)
  const parentDetails = await lstat(target.canonicalParent, { bigint: true }).catch(() => undefined)
  if (
    !details ||
    !canonicalPath ||
    !parentDetails ||
    parentDetails.isSymbolicLink() ||
    !parentDetails.isDirectory() ||
    parentDetails.dev !== target.parentDevice ||
    parentDetails.ino !== target.parentInode ||
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    details.dev !== target.device ||
    details.ino !== target.inode ||
    !pathsEqual(canonicalPath, target.canonicalPath) ||
    !pathInside(target.canonicalParent, canonicalPath)
  ) {
    throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", target.displayPath)
  }
}

function invalidCandidate(code: string, message: string): BlogCandidateInspection {
  return { valid: false, code, message }
}

/** Parses only literal GitHub clone URLs that can safely occupy one Git argument. */
export function parseGitHubRepository(value: string): GitHubRepository {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumRepositoryUrlLength ||
    !parseGitHubRepositoryUrl(value)
  ) {
    throw importError("INVALID_REPOSITORY_URL", "Enter a valid GitHub repository URL.")
  }
  return parseGitHubRepositoryUrl(value)!
}

async function inspectRequiredCandidatePath(
  root: string,
  relativePath: string,
  expected: "file" | "directory",
  code: string,
  message: string,
): Promise<BlogCandidateInspection | undefined> {
  const candidate = resolve(root, relativePath)
  try {
    const details = await lstat(candidate)
    if (details.isSymbolicLink()) return invalidCandidate("UNSAFE_PATH", "Required blog files must not be links.")
    const canonical = await realpath(candidate)
    if (!pathInside(root, canonical)) return invalidCandidate("UNSAFE_PATH", "Required blog files must stay inside the selected folder.")
    if ((expected === "file" && !details.isFile()) || (expected === "directory" && !details.isDirectory())) {
      return invalidCandidate(code, message)
    }
  } catch {
    return invalidCandidate(code, message)
  }
  return undefined
}

async function inspectCandidateGit(root: string, runner: BoundedCommandRunner): Promise<BlogCandidateInspection | undefined> {
  let topLevel: { readonly exitCode: number; readonly stdout: string }
  try {
    topLevel = await runner.run({
      executable: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: root,
      env: gitReadEnvironment,
      maxOutputBytes: importOutputBytes,
    })
  } catch (error) {
    rethrowTerminationUncertain(error)
    return invalidCandidate("GIT_UNAVAILABLE", "Git is unavailable for this blog folder.")
  }
  if (topLevel.exitCode !== 0) return invalidCandidate("GIT_NOT_REPOSITORY", "The selected folder is not a Git repository.")
  let gitRoot: string
  try {
    gitRoot = await realpath(resolve(topLevel.stdout.trim()))
  } catch {
    return invalidCandidate("GIT_ROOT_MISMATCH", "Git did not report this folder as its repository root.")
  }
  if (!pathsEqual(gitRoot, root)) return invalidCandidate("GIT_ROOT_MISMATCH", "Select the Git repository root, not a nested folder.")
  try {
    const remotes = await runner.run({
      executable: "git",
      args: ["remote"],
      cwd: root,
      env: gitReadEnvironment,
      maxOutputBytes: importOutputBytes,
    })
    if (remotes.exitCode !== 0) return invalidCandidate("GIT_ORIGIN_FAILED", "Could not inspect Git remotes.")
    if (!remotes.stdout.split(/\r?\n/).some((remote) => remote === "origin")) {
      return invalidCandidate("GIT_ORIGIN_MISSING", "This blog repository has no origin remote.")
    }
    const origin = await runner.run({
      executable: "git",
      args: ["remote", "get-url", "origin"],
      cwd: root,
      env: gitReadEnvironment,
      maxOutputBytes: importOutputBytes,
    })
    if (origin.exitCode !== 0 || origin.stdout.trim() === "") {
      return invalidCandidate("GIT_ORIGIN_FAILED", "Could not read the origin remote.")
    }
  } catch (error) {
    rethrowTerminationUncertain(error)
    return invalidCandidate("GIT_UNAVAILABLE", "Git is unavailable for this blog folder.")
  }
  return undefined
}

export async function inspectBlogCandidate(
  path: string,
  dependencies: BlogCandidateDependencies = {},
): Promise<BlogCandidateInspection> {
  const normalized = resolve(path)
  let root: string
  try {
    const details = await lstat(normalized)
    if (details.isSymbolicLink() || !details.isDirectory()) {
      return invalidCandidate("INVALID_DIRECTORY", "Select an existing blog directory.")
    }
    root = await realpath(normalized)
  } catch {
    return invalidCandidate("INVALID_DIRECTORY", "Select an existing blog directory.")
  }

  const requiredPaths: readonly [string, "file" | "directory", string, string][] = [
    ["package.json", "file", "PACKAGE_JSON_MISSING", "package.json is required."],
    ["package-lock.json", "file", "PACKAGE_LOCK_MISSING", "package-lock.json is required."],
    ["quartz/bootstrap-cli.mjs", "file", "QUARTZ_BOOTSTRAP_MISSING", "Quartz bootstrap files are required."],
    ["content", "directory", "CONTENT_MISSING", "The content directory is required."],
  ]
  for (const [relativePath, expected, code, message] of requiredPaths) {
    const invalid = await inspectRequiredCandidatePath(root, relativePath, expected, code, message)
    if (invalid) return invalid
  }
  const gitInvalid = await inspectCandidateGit(root, dependencies.runner ?? createSystemBoundedCommandRunner({ commandDeadlineMs: 15_000 }))
  if (gitInvalid) return gitInvalid
  const dependencyIssues = await inspectWorkspaceDependencyState(root)
  return { valid: true, canonicalPath: root, needsInstall: dependencyIssues.length > 0 }
}

export function createBlogImportService(dependencies: BlogImportDependencies): BlogImportService {
  let active = false
  let terminationUncertain = false

  const runOperation = async <T>(signal: AbortSignal | undefined, operation: (operationSignal: AbortSignal) => Promise<T>): Promise<T> => {
    if (terminationUncertain) {
      throw importError("IMPORT_UNAVAILABLE", "A previous import command may still be running; restart the app.")
    }
    if (active) throw importError("IMPORT_ACTIVE", "Another blog import is already running.")
    active = true
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    try {
      if (controller.signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.")
      return await operation(controller.signal)
    } catch (error) {
      if (error instanceof PublishCommandFailure && error.terminationUncertain) {
        terminationUncertain = true
        throw importError("IMPORT_UNAVAILABLE", "A command termination could not be confirmed; restart the app.")
      }
      throw error
    } finally {
      signal?.removeEventListener("abort", cancel)
      active = false
    }
  }

  const assertNotCancelled = (signal: AbortSignal): void => {
    if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.")
  }
  const emit = (phase: BlogImportPhase): void => dependencies.onProgress({
    phase,
    message: phase === "complete" ? "Blog import complete." : `Blog import ${phase}.`,
  })
  const inspectWithCancellation = (
    path: string,
    signal: AbortSignal,
  ): Promise<BlogCandidateInspection> =>
    new Promise((resolveInspection, rejectInspection) => {
      let settled = false
      const cleanup = (): void => signal.removeEventListener("abort", cancel)
      const reject = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        rejectInspection(error)
      }
      const resolve = (inspection: BlogCandidateInspection): void => {
        if (settled) return
        settled = true
        cleanup()
        resolveInspection(inspection)
      }
      let cancelled = false
      const cancel = (): void => {
        cancelled = true
      }
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) {
        reject(importError("CANCELLED", "Blog import was cancelled.", path))
        return
      }
      void Promise.resolve()
        .then(() => dependencies.inspect(path, { runner: dependencies.runner }))
        .then(
          (inspection) => {
            if (cancelled || signal.aborted) reject(importError("CANCELLED", "Blog import was cancelled.", path))
            else resolve(inspection)
          },
          (error: unknown) => {
            const uncertain = terminationUncertainFailure(error)
            if (uncertain) {
              reject(uncertain)
              return
            }
            if (cancelled || signal.aborted) reject(importError("CANCELLED", "Blog import was cancelled.", path))
            else reject(error)
          },
        )
    })

  const installAt = async (
    path: string,
    signal: AbortSignal,
    reserved?: ReservedBlogTarget,
  ): Promise<ValidBlogCandidateInspection> => {
    assertNotCancelled(signal)
    let preflight: BlogCandidateInspection
    try {
      preflight = await inspectWithCancellation(path, signal)
    } catch (error) {
      rethrowTerminationUncertain(error)
      if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", path)
      throw importError("VALIDATION_FAILED", "The selected blog could not be validated.", path)
    }
    assertNotCancelled(signal)
    if (!preflight.valid) {
      throw importError("VALIDATION_FAILED", "The selected blog could not be validated.", path)
    }
    let target: ReservedBlogTarget
    try {
      if (reserved) {
        target = reserved
      } else {
        const canonicalPath = dirname(preflight.canonicalPath)
        const details = await lstat(canonicalPath, { bigint: true })
        target = await captureTarget(
          preflight.canonicalPath,
          { canonicalPath, device: details.dev, inode: details.ino },
          path,
        )
      }
      if (!pathsEqual(preflight.canonicalPath, target.canonicalPath)) {
        throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", target.displayPath)
      }
      await assertTarget(target)
    } catch (error) {
      if (error instanceof BlogImportError) throw error
      throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", path)
    }
    emit("installing")
    let result: { readonly exitCode: number }
    try {
      result = await dependencies.runner.run({
        executable: dependencies.nodePath,
        args: [dependencies.npmCliPath, "ci", "--no-audit", "--no-fund"],
        cwd: target.canonicalPath,
        env: { npm_config_audit: "false", npm_config_fund: "false" },
        signal,
        maxOutputBytes: importOutputBytes,
      })
    } catch (error) {
      rethrowTerminationUncertain(error)
      if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", path)
      throw importError("INSTALL_FAILED", "npm could not install blog dependencies.", path)
    }
    assertNotCancelled(signal)
    if (result.exitCode !== 0) throw importError("INSTALL_FAILED", "npm could not install blog dependencies.", path)
    await assertTarget(target)
    emit("validating")
    let inspection: BlogCandidateInspection
    try {
      inspection = await inspectWithCancellation(target.canonicalPath, signal)
    } catch (error) {
      rethrowTerminationUncertain(error)
      if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", path)
      throw importError("VALIDATION_FAILED", "The imported blog could not be validated.", path)
    }
    assertNotCancelled(signal)
    if (!inspection.valid) {
      throw importError("VALIDATION_FAILED", "The imported blog could not be validated.", path)
    }
    if (inspection.needsInstall) {
      throw importError("VALIDATION_FAILED", "The imported blog could not be validated.", path)
    }
    if (!pathsEqual(inspection.canonicalPath, target.canonicalPath)) {
      throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", target.displayPath)
    }
    await assertTarget(target)
    return inspection
  }

  return {
    clone: (request, signal) => runOperation(signal, async (operationSignal) => {
      const repository = parseGitHubRepository(request.url)
      const target = await reserveCloneTarget(
        request.destination,
        dependencies.afterParentCapturedBeforeMkdir,
      )
      emit("cloning")
      let clone: { readonly exitCode: number }
      try {
        clone = await dependencies.runner.run({
          executable: dependencies.gitExecutable,
          args: ["clone", "--", repository.url, "."],
          cwd: target.canonicalPath,
          env: { GIT_TERMINAL_PROMPT: "1" },
          signal: operationSignal,
          maxOutputBytes: importOutputBytes,
        })
      } catch (error) {
        rethrowTerminationUncertain(error)
        if (operationSignal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", target.displayPath)
        throw importError("CLONE_FAILED", "Git could not clone the blog repository.", target.displayPath)
      }
      assertNotCancelled(operationSignal)
      if (clone.exitCode !== 0) throw importError("CLONE_FAILED", "Git could not clone the blog repository.", target.displayPath)
      await assertTarget(target)
      const inspection = await installAt(target.canonicalPath, operationSignal, target)
      emit("complete")
      return {
        canonicalPath: inspection.canonicalPath,
        owner: repository.owner,
        repository: repository.repository,
      }
    }),
    install: (path, signal) => runOperation(signal, async (operationSignal) => {
      const inspection = await installAt(resolve(path), operationSignal)
      emit("complete")
      return inspection
    }),
  }
}
