import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  type WorkspaceCapabilities,
  type AppError,
  type WorkspaceInspection,
  type WorkspaceIssue,
  type WorkspaceRepairReceipt,
  type WorkspaceRepairRequest,
} from "../../shared/contracts"
import { type CommandResult, type CommandRunner, systemCommandRunner } from "../lib/commandRunner"

export interface InspectWorkspaceOptions {
  readonly checkGit: boolean
  readonly runner?: CommandRunner
  readonly runtime?: BundledNpmRuntime
  readonly checkRemote?: boolean
  readonly online?: () => boolean | Promise<boolean>
  readonly previewPortAvailable?: () => Promise<boolean>
}

export interface BundledNpmRuntime {
  readonly nodePath: string
  readonly npmCliPath: string
}

export interface RepairWorkspaceOptions {
  readonly runner?: CommandRunner
  readonly runtime: BundledNpmRuntime
}

interface RequiredPath {
  readonly relativePath: string
  readonly expectedType: "directory" | "file"
  readonly missingCode: WorkspaceIssue["code"]
  readonly wrongTypeCode: WorkspaceIssue["code"]
  readonly missingMessage: string
  readonly wrongTypeMessage: string
}

const readOnlyGitEnv = { GIT_OPTIONAL_LOCKS: "0" } as const

const requiredPaths: readonly RequiredPath[] = [
  {
    relativePath: "content",
    expectedType: "directory",
    missingCode: "CONTENT_MISSING",
    wrongTypeCode: "CONTENT_NOT_DIRECTORY",
    missingMessage: "Create the content directory.",
    wrongTypeMessage: "Replace content with a directory.",
  },
  {
    relativePath: "private",
    expectedType: "directory",
    missingCode: "PRIVATE_MISSING",
    wrongTypeCode: "PRIVATE_NOT_DIRECTORY",
    missingMessage: "Create the private directory.",
    wrongTypeMessage: "Replace private with a directory.",
  },
  {
    relativePath: "scripts",
    expectedType: "directory",
    missingCode: "SCRIPTS_MISSING",
    wrongTypeCode: "SCRIPTS_NOT_DIRECTORY",
    missingMessage: "Create the scripts directory.",
    wrongTypeMessage: "Replace scripts with a directory.",
  },
  {
    relativePath: "package-lock.json",
    expectedType: "file",
    missingCode: "PACKAGE_LOCK_MISSING",
    wrongTypeCode: "PACKAGE_LOCK_NOT_FILE",
    missingMessage: "Restore package-lock.json.",
    wrongTypeMessage: "Replace package-lock.json with a file.",
  },
  {
    relativePath: "quartz.config.yaml",
    expectedType: "file",
    missingCode: "QUARTZ_CONFIG_MISSING",
    wrongTypeCode: "QUARTZ_CONFIG_NOT_FILE",
    missingMessage: "Restore quartz.config.yaml.",
    wrongTypeMessage: "Replace quartz.config.yaml with a file.",
  },
  {
    relativePath: "scripts/validate-content.mjs",
    expectedType: "file",
    missingCode: "VALIDATE_CONTENT_MISSING",
    wrongTypeCode: "VALIDATE_CONTENT_NOT_FILE",
    missingMessage: "Restore scripts/validate-content.mjs.",
    wrongTypeMessage: "Replace scripts/validate-content.mjs with a file.",
  },
]

function issue(
  code: WorkspaceIssue["code"],
  message: string,
  path?: string,
  repair?: WorkspaceIssue["repair"],
): WorkspaceIssue {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(repair === undefined ? {} : { repair }),
  } as WorkspaceIssue
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInsideWorkspace(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
}

async function canonicalWorkspaceRoot(
  rootPath: string,
): Promise<{ root: string; issues: WorkspaceIssue[] }> {
  const normalizedRoot = resolve(rootPath)
  try {
    const rootDetails = await stat(normalizedRoot)
    if (!rootDetails.isDirectory()) {
      return {
        root: normalizedRoot,
        issues: [
          issue("INVALID_WORKSPACE", "Select an existing workspace directory.", normalizedRoot),
        ],
      }
    }
    return { root: await realpath(normalizedRoot), issues: [] }
  } catch {
    return {
      root: normalizedRoot,
      issues: [
        issue("INVALID_WORKSPACE", "Select an existing workspace directory.", normalizedRoot),
      ],
    }
  }
}

async function inspectRequiredPaths(root: string): Promise<WorkspaceIssue[]> {
  const issues: WorkspaceIssue[] = []
  for (const requirement of requiredPaths) {
    const path = resolve(root, requirement.relativePath)
    try {
      const linkDetails = await lstat(path)
      if (linkDetails.isSymbolicLink()) {
        issues.push(
          issue("UNSAFE_PATH", "Replace linked required paths with workspace-owned entries.", path),
        )
        continue
      }
      const canonicalPath = await realpath(path)
      if (!isInsideWorkspace(root, canonicalPath)) {
        issues.push(
          issue("UNSAFE_PATH", "Required paths must remain inside the selected workspace.", path),
        )
        continue
      }
      const details = await stat(canonicalPath)
      const hasExpectedType =
        requirement.expectedType === "directory" ? details.isDirectory() : details.isFile()
      if (!hasExpectedType) {
        issues.push(issue(requirement.wrongTypeCode, requirement.wrongTypeMessage, path))
      }
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT") {
        issues.push(issue(requirement.missingCode, requirement.missingMessage, path))
      } else if (code === "ENOTDIR") {
        issues.push(issue(requirement.wrongTypeCode, requirement.wrongTypeMessage, path))
      } else {
        issues.push(
          issue("WORKSPACE_ACCESS_FAILED", "Could not inspect a required workspace path.", path),
        )
      }
    }
  }
  return issues
}

function didSucceed(result: CommandResult): boolean {
  return result.exitCode === 0
}

function isCredentialFailure(stderr: string): boolean {
  return /authenticat|credential|permission denied|could not read username|terminal prompts disabled/i.test(
    stderr,
  )
}

async function inspectGit(
  root: string,
  runner: CommandRunner,
  checkRemote: boolean,
  online: () => boolean | Promise<boolean>,
): Promise<WorkspaceIssue[]> {
  const issues: WorkspaceIssue[] = []
  let topLevel: CommandResult
  try {
    topLevel = await runner.run({
      executable: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: root,
      env: readOnlyGitEnv,
    })
  } catch {
    return [issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
  }

  if (!didSucceed(topLevel)) {
    return [issue("GIT_NOT_REPOSITORY", "Initialize this folder as a Git repository.")]
  }
  let gitRoot: string
  try {
    gitRoot = await realpath(resolve(topLevel.stdout.trim()))
  } catch {
    return [issue("GIT_ROOT_MISMATCH", "Git reported a repository root outside this workspace.")]
  }
  if (!pathsEqual(gitRoot, root)) {
    return [issue("GIT_ROOT_MISMATCH", "Open the Git repository root, not a nested folder.")]
  }

  let remotes: CommandResult
  try {
    remotes = await runner.run({
      executable: "git",
      args: ["remote"],
      cwd: root,
      env: readOnlyGitEnv,
    })
  } catch {
    return [issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
  }
  if (!didSucceed(remotes)) {
    issues.push(issue("GIT_ORIGIN_FAILED", "Could not list repository remotes."))
  } else if (!remotes.stdout.split(/\r?\n/).some((remote) => remote === "origin")) {
    issues.push(issue("GIT_ORIGIN_MISSING", "Add an origin remote before publishing."))
  } else {
    let origin: CommandResult
    try {
      origin = await runner.run({
        executable: "git",
        args: ["remote", "get-url", "origin"],
        cwd: root,
        env: readOnlyGitEnv,
      })
    } catch {
      return [issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
    }
    if (!didSucceed(origin) || origin.stdout.trim() === "") {
      issues.push(
        issue(
          "GIT_ORIGIN_FAILED",
          "Could not read the origin remote. Check the repository configuration.",
        ),
      )
    } else if (
      checkRemote &&
      (await Promise.resolve()
        .then(online)
        .catch(() => false))
    ) {
      let fetch: CommandResult
      try {
        fetch = await runner.run({
          executable: "git",
          args: ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
          cwd: root,
          env: {
            ...readOnlyGitEnv,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "Never",
          },
        })
      } catch {
        issues.push(issue("GIT_ORIGIN_UNREACHABLE", "Could not safely read origin/main."))
        fetch = { exitCode: 0, stdout: "", stderr: "" }
      }
      if (!didSucceed(fetch)) {
        issues.push(
          isCredentialFailure(fetch.stderr)
            ? issue("GIT_FETCH_AUTH_FAILED", "Git credentials could not read origin/main.")
            : issue("GIT_ORIGIN_UNREACHABLE", "origin/main is not reachable right now."),
        )
      }
    }
  }

  let status: CommandResult
  try {
    status = await runner.run({
      executable: "git",
      args: ["status", "--porcelain=v2"],
      cwd: root,
      env: readOnlyGitEnv,
    })
  } catch {
    return [...issues, issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
  }
  if (!didSucceed(status)) {
    issues.push(issue("GIT_STATUS_FAILED", "Could not inspect the Git working tree."))
  }
  return issues
}

async function inspectDependencies(
  root: string,
  runtime: BundledNpmRuntime,
  runner: CommandRunner,
): Promise<WorkspaceIssue[]> {
  const dependencyIssue = (
    code: "DEPENDENCIES_MISSING" | "DEPENDENCIES_INVALID",
    message: string,
  ): WorkspaceIssue => issue(code, message, undefined, "install-dependencies")
  const installedLock = resolve(root, "node_modules", ".package-lock.json")
  const sourceLock = resolve(root, "package-lock.json")
  try {
    const [nodeModules, hiddenDetails, sourceDetails] = await Promise.all([
      lstat(resolve(root, "node_modules")),
      lstat(installedLock),
      lstat(sourceLock),
    ])
    if (
      nodeModules.isSymbolicLink() ||
      !nodeModules.isDirectory() ||
      hiddenDetails.isSymbolicLink() ||
      !hiddenDetails.isFile() ||
      sourceDetails.isSymbolicLink() ||
      !sourceDetails.isFile()
    ) {
      return [
        dependencyIssue(
          "DEPENDENCIES_MISSING",
          "Repository dependencies are not installed safely.",
        ),
      ]
    }
    const maximumLockBytes = 32 * 1024 * 1024
    if (hiddenDetails.size > maximumLockBytes || sourceDetails.size > maximumLockBytes) {
      return [
        dependencyIssue(
          "DEPENDENCIES_INVALID",
          "A dependency lock file is too large to verify safely.",
        ),
      ]
    }
    const [sourceBytes, installedBytes] = await Promise.all([
      readFile(sourceLock),
      readFile(installedLock),
    ])
    const source = JSON.parse(sourceBytes.toString("utf8")) as {
      lockfileVersion?: unknown
      packages?: unknown
    }
    const installed = JSON.parse(installedBytes.toString("utf8")) as {
      lockfileVersion?: unknown
      packages?: unknown
    }
    if (
      source.lockfileVersion !== installed.lockfileVersion ||
      !source.packages ||
      typeof source.packages !== "object" ||
      !installed.packages ||
      typeof installed.packages !== "object"
    ) {
      return [
        dependencyIssue(
          "DEPENDENCIES_INVALID",
          "Installed dependencies do not match package-lock.json.",
        ),
      ]
    }
    const expected = source.packages as Record<string, unknown>
    const actual = installed.packages as Record<string, unknown>
    const lockFields = [
      "version",
      "resolved",
      "integrity",
      "link",
      "dev",
      "optional",
      "peer",
    ] as const
    const fingerprint = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      const record = value as Record<string, unknown>
      return JSON.stringify(Object.fromEntries(lockFields.map((field) => [field, record[field]])))
    }
    for (const [path, expectedPackage] of Object.entries(expected)) {
      if (!path.startsWith("node_modules/")) continue
      const expectedRecord = expectedPackage as Record<string, unknown>
      const actualPackage = actual[path]
      if (actualPackage === undefined && expectedRecord.optional === true) continue
      if (
        actualPackage === undefined ||
        fingerprint(expectedPackage) === undefined ||
        fingerprint(expectedPackage) !== fingerprint(actualPackage)
      ) {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
      if (expectedRecord.link === true) continue
      if (typeof expectedRecord.version !== "string") {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
      const packageDirectory = resolve(root, ...path.split("/"))
      const manifestPath = resolve(packageDirectory, "package.json")
      if (!isInsideWorkspace(resolve(root, "node_modules"), packageDirectory)) {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
      if (!pathsEqual(await realpath(packageDirectory), packageDirectory)) {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
      const manifestDetails = await lstat(manifestPath)
      if (
        manifestDetails.isSymbolicLink() ||
        !manifestDetails.isFile() ||
        manifestDetails.size > 1024 * 1024
      ) {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown }
      if (manifest.version !== expectedRecord.version) {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
    }
    for (const path of Object.keys(actual)) {
      if (path.startsWith("node_modules/") && expected[path] === undefined) {
        return [
          dependencyIssue(
            "DEPENDENCIES_INVALID",
            "Installed dependencies do not match package-lock.json.",
          ),
        ]
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [
        dependencyIssue(
          "DEPENDENCIES_MISSING",
          "Repository dependencies are missing or incomplete.",
        ),
      ]
    }
    return [
      dependencyIssue("DEPENDENCIES_INVALID", "Installed dependency state could not be verified."),
    ]
  }
  try {
    const result = await runner.run({
      executable: runtime.nodePath,
      args: [runtime.npmCliPath, "ls", "--all", "--ignore-scripts", "--json"],
      cwd: root,
      env: { npm_config_audit: "false", npm_config_fund: "false" },
    })
    if (didSucceed(result)) return []
    return [
      dependencyIssue("DEPENDENCIES_MISSING", "Repository dependencies are missing or incomplete."),
    ]
  } catch {
    return [
      dependencyIssue(
        "DEPENDENCIES_INVALID",
        "The bundled runtime could not verify repository dependencies.",
      ),
    ]
  }
}

export async function inspectWorkspace(
  rootPath: string,
  options: InspectWorkspaceOptions,
): Promise<WorkspaceInspection> {
  const workspaceRoot = await canonicalWorkspaceRoot(rootPath)
  const root = workspaceRoot.root
  const issues = [...workspaceRoot.issues]
  if (workspaceRoot.issues.length === 0) {
    issues.push(...(await inspectRequiredPaths(root)))
  }
  const files = issues.length === 0
  const gitIssues =
    options.checkGit && workspaceRoot.issues.length === 0
      ? await inspectGit(
          root,
          options.runner ?? systemCommandRunner,
          options.checkRemote ?? false,
          options.online ?? (() => true),
        )
      : []
  issues.push(...gitIssues)
  const dependencyIssues =
    options.runtime &&
    workspaceRoot.issues.length === 0 &&
    issues.every((item) => item.code !== "PACKAGE_LOCK_MISSING")
      ? await inspectDependencies(root, options.runtime, options.runner ?? systemCommandRunner)
      : []
  issues.push(...dependencyIssues)
  if (options.previewPortAvailable && workspaceRoot.issues.length === 0) {
    let available = false
    try {
      available = await options.previewPortAvailable()
    } catch {
      available = false
    }
    if (!available) {
      issues.push(issue("PREVIEW_PORT_UNAVAILABLE", "The local preview port is already in use."))
    }
  }
  const git = options.checkGit && workspaceRoot.issues.length === 0 && gitIssues.length === 0
  const dependencies = dependencyIssues.length === 0
  const previewPort = !issues.some((item) => item.code === "PREVIEW_PORT_UNAVAILABLE")
  const capabilities: WorkspaceCapabilities = {
    files,
    preview: files && dependencies && previewPort,
    git,
    publish: files && dependencies && git,
  }

  if (issues.length === 0) {
    return { ok: true, root, capabilities, issues: [] }
  }
  return { ok: false, root, capabilities, issues }
}

/** The only automatic first-run repair: an explicit npm ci through the bundled runtime. */
export async function repairWorkspace(
  rootPath: string,
  request: WorkspaceRepairRequest,
  options: RepairWorkspaceOptions,
): Promise<WorkspaceRepairReceipt> {
  if (request.action !== "install-dependencies") {
    throw {
      code: "INVALID_INPUT",
      message: "This repair action is not supported.",
    } satisfies AppError
  }
  const workspace = await canonicalWorkspaceRoot(rootPath)
  if (workspace.issues.length > 0) throw workspace.issues[0]
  const lockPath = resolve(workspace.root, "package-lock.json")
  try {
    const lock = await lstat(lockPath)
    if (lock.isSymbolicLink() || !lock.isFile()) throw new Error("unsafe lock")
  } catch {
    throw issue("REPAIR_FAILED", "Restore package-lock.json before installing dependencies.")
  }
  let result: CommandResult
  try {
    result = await (options.runner ?? systemCommandRunner).run({
      executable: options.runtime.nodePath,
      args: [options.runtime.npmCliPath, "ci", "--no-audit", "--no-fund"],
      cwd: workspace.root,
      env: { npm_config_audit: "false", npm_config_fund: "false" },
    })
  } catch {
    throw issue("REPAIR_FAILED", "The bundled npm runtime could not start dependency repair.")
  }
  if (!didSucceed(result)) {
    throw issue("REPAIR_FAILED", "npm ci could not install the repository dependencies.")
  }
  return { action: request.action, message: "Repository dependencies were installed." }
}
