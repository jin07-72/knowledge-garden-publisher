import { lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { type CommandRunner, systemCommandRunner } from "../lib/commandRunner"
import { type BoundedCommandRunner } from "./publish"
import { inspectWorkspaceDependencyState } from "./workspace"

const maximumRepositoryUrlLength = 1_024
const importOutputBytes = 2 * 1024 * 1024
const gitReadEnvironment = { GIT_OPTIONAL_LOCKS: "0" } as const

export interface GitHubRepository {
  readonly url: string
  readonly owner: string
  readonly repository: string
}

export interface BlogCandidateDependencies {
  readonly runner?: CommandRunner
}

export type BlogCandidateInspection =
  | { readonly valid: true; readonly canonicalPath: string; readonly needsInstall: boolean }
  | { readonly valid: false; readonly code: string; readonly message: string }

type ValidBlogCandidateInspection = Extract<BlogCandidateInspection, { readonly valid: true }>

interface ReservedBlogTarget {
  readonly displayPath: string
  readonly canonicalParent: string
  readonly canonicalPath: string
  readonly device: bigint
  readonly inode: bigint
}

export type BlogImportPhase = "cloning" | "installing" | "validating" | "complete"

export interface BlogImportProgress {
  readonly phase: BlogImportPhase
  readonly path: string
}

export interface BlogCloneRequest {
  readonly url: string
  readonly destination: string
  readonly name: string
}

export interface BlogImportReceipt {
  readonly canonicalPath: string
  readonly owner: string
  readonly repository: string
}

export interface BlogImportService {
  clone(request: BlogCloneRequest, signal?: AbortSignal): Promise<BlogImportReceipt>
  install(path: string, signal?: AbortSignal): Promise<BlogCandidateInspection>
}

export interface BlogImportErrorShape {
  readonly code: string
  readonly message: string
  readonly path?: string
}

class BlogImportError extends Error implements BlogImportErrorShape {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message)
    this.name = "BlogImportError"
  }
}

function importError(code: string, message: string, path?: string): BlogImportError {
  return new BlogImportError(code, message, path)
}

function pathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function reserveCloneTarget(path: string): Promise<ReservedBlogTarget> {
  const displayPath = resolve(path)
  const parent = dirname(displayPath)
  let canonicalParent: string
  try {
    canonicalParent = await realpath(parent)
    const parentDetails = await lstat(canonicalParent)
    if (!parentDetails.isDirectory()) throw new Error("not a directory")
  } catch {
    throw importError("DESTINATION_INVALID", "The selected destination parent folder is unavailable.", displayPath)
  }
  try {
    await mkdir(displayPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw importError("DESTINATION_EXISTS", "Choose a destination that does not already exist.", displayPath)
    }
    throw importError("DESTINATION_INVALID", "The selected destination cannot be reserved.", displayPath)
  }
  return await captureTarget(displayPath, canonicalParent, displayPath)
}

async function captureTarget(
  path: string,
  canonicalParent: string,
  displayPath: string,
): Promise<ReservedBlogTarget> {
  const canonicalPath = await realpath(path).catch(() => undefined)
  const details = await lstat(path, { bigint: true }).catch(() => undefined)
  const expectedPath = resolve(canonicalParent, basename(path))
  if (
    !canonicalPath ||
    !details ||
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    !pathsEqual(canonicalPath, expectedPath) ||
    !pathInside(canonicalParent, canonicalPath)
  ) {
    throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", displayPath)
  }
  return {
    displayPath,
    canonicalParent,
    canonicalPath,
    device: details.dev,
    inode: details.ino,
  }
}

async function assertTarget(target: ReservedBlogTarget): Promise<void> {
  const details = await lstat(target.canonicalPath, { bigint: true }).catch(() => undefined)
  const canonicalPath = await realpath(target.canonicalPath).catch(() => undefined)
  if (
    !details ||
    !canonicalPath ||
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

const ownerPattern = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
const repositoryPattern = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?"
const httpsRepositoryPattern = new RegExp(
  `^https://github\\.com/(${ownerPattern})/(${repositoryPattern})(?:\\.git)?$`,
)
const sshRepositoryPattern = new RegExp(
  `^git@github\\.com:(${ownerPattern})/(${repositoryPattern})(?:\\.git)?$`,
)

/** Parses only literal GitHub clone URLs that can safely occupy one Git argument. */
export function parseGitHubRepository(value: string): GitHubRepository {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumRepositoryUrlLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f\s]/.test(value)
  ) {
    throw importError("INVALID_REPOSITORY_URL", "Enter a valid GitHub repository URL.")
  }
  const match = httpsRepositoryPattern.exec(value) ?? sshRepositoryPattern.exec(value)
  if (!match) {
    throw importError("INVALID_REPOSITORY_URL", "Enter a valid GitHub repository URL.")
  }
  const [, owner, matchedRepository] = match
  const repository = matchedRepository.endsWith(".git")
    ? matchedRepository.slice(0, -".git".length)
    : matchedRepository
  if (!repository || repository === "." || repository === "..") {
    throw importError("INVALID_REPOSITORY_URL", "Enter a valid GitHub repository URL.")
  }
  return { url: value, owner, repository }
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

async function inspectCandidateGit(root: string, runner: CommandRunner): Promise<BlogCandidateInspection | undefined> {
  let topLevel: { readonly exitCode: number; readonly stdout: string }
  try {
    topLevel = await runner.run({
      executable: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: root,
      env: gitReadEnvironment,
    })
  } catch {
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
    })
    if (origin.exitCode !== 0 || origin.stdout.trim() === "") {
      return invalidCandidate("GIT_ORIGIN_FAILED", "Could not read the origin remote.")
    }
  } catch {
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
  const gitInvalid = await inspectCandidateGit(root, dependencies.runner ?? systemCommandRunner)
  if (gitInvalid) return gitInvalid
  const dependencyIssues = await inspectWorkspaceDependencyState(root)
  return { valid: true, canonicalPath: root, needsInstall: dependencyIssues.length > 0 }
}

export function createBlogImportService(dependencies: {
  readonly gitExecutable: string
  readonly nodePath: string
  readonly npmCliPath: string
  readonly runner: BoundedCommandRunner
  readonly inspect: typeof inspectBlogCandidate
  readonly onProgress: (progress: BlogImportProgress) => void
}): BlogImportService {
  let active = false

  const runOperation = async <T>(signal: AbortSignal | undefined, operation: (operationSignal: AbortSignal) => Promise<T>): Promise<T> => {
    if (active) throw importError("IMPORT_ACTIVE", "Another blog import is already running.")
    active = true
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    try {
      if (controller.signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.")
      return await operation(controller.signal)
    } finally {
      signal?.removeEventListener("abort", cancel)
      active = false
    }
  }

  const assertNotCancelled = (signal: AbortSignal): void => {
    if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.")
  }
  const emit = (phase: BlogImportPhase, path: string): void => dependencies.onProgress({ phase, path })
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
    } catch {
      if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", path)
      throw importError("VALIDATION_FAILED", "The selected blog could not be validated.", path)
    }
    assertNotCancelled(signal)
    if (!preflight.valid) {
      throw importError("VALIDATION_FAILED", "The selected blog could not be validated.", path)
    }
    let target: ReservedBlogTarget
    try {
      target = reserved ?? await captureTarget(preflight.canonicalPath, dirname(preflight.canonicalPath), path)
      if (!pathsEqual(preflight.canonicalPath, target.canonicalPath)) {
        throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", target.displayPath)
      }
      await assertTarget(target)
    } catch (error) {
      if (error instanceof BlogImportError) throw error
      throw importError("TARGET_CHANGED", "The blog destination changed unexpectedly.", path)
    }
    emit("installing", target.canonicalPath)
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
    } catch {
      if (signal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", path)
      throw importError("INSTALL_FAILED", "npm could not install blog dependencies.", path)
    }
    assertNotCancelled(signal)
    if (result.exitCode !== 0) throw importError("INSTALL_FAILED", "npm could not install blog dependencies.", path)
    await assertTarget(target)
    emit("validating", target.canonicalPath)
    let inspection: BlogCandidateInspection
    try {
      inspection = await inspectWithCancellation(target.canonicalPath, signal)
    } catch {
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
      const target = await reserveCloneTarget(request.destination)
      emit("cloning", target.canonicalPath)
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
      } catch {
        if (operationSignal.aborted) throw importError("CANCELLED", "Blog import was cancelled.", target.displayPath)
        throw importError("CLONE_FAILED", "Git could not clone the blog repository.", target.displayPath)
      }
      assertNotCancelled(operationSignal)
      if (clone.exitCode !== 0) throw importError("CLONE_FAILED", "Git could not clone the blog repository.", target.displayPath)
      await assertTarget(target)
      const inspection = await installAt(target.canonicalPath, operationSignal, target)
      emit("complete", target.canonicalPath)
      return {
        canonicalPath: inspection.canonicalPath,
        owner: repository.owner,
        repository: repository.repository,
      }
    }),
    install: (path, signal) => runOperation(signal, async (operationSignal) => {
      const inspection = await installAt(resolve(path), operationSignal)
      emit("complete", inspection.canonicalPath)
      return inspection
    }),
  }
}
