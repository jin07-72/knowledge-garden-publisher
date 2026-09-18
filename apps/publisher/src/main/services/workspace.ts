import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type WorkspaceCapabilities,
  type WorkspaceInspection,
  type WorkspaceIssue
} from "../../shared/contracts"
import {
  type CommandResult,
  type CommandRunner,
  systemCommandRunner
} from "../lib/commandRunner"

export interface InspectWorkspaceOptions {
  readonly checkGit: boolean
  readonly runner?: CommandRunner
}

interface RequiredPath {
  readonly relativePath: string
  readonly expectedType: "directory" | "file"
  readonly missingCode: WorkspaceIssue["code"]
  readonly wrongTypeCode: WorkspaceIssue["code"]
  readonly missingMessage: string
  readonly wrongTypeMessage: string
}

const requiredPaths: readonly RequiredPath[] = [
  {
    relativePath: "content",
    expectedType: "directory",
    missingCode: "CONTENT_MISSING",
    wrongTypeCode: "CONTENT_NOT_DIRECTORY",
    missingMessage: "Create the content directory.",
    wrongTypeMessage: "Replace content with a directory."
  },
  {
    relativePath: "private",
    expectedType: "directory",
    missingCode: "PRIVATE_MISSING",
    wrongTypeCode: "PRIVATE_NOT_DIRECTORY",
    missingMessage: "Create the private directory.",
    wrongTypeMessage: "Replace private with a directory."
  },
  {
    relativePath: "scripts",
    expectedType: "directory",
    missingCode: "SCRIPTS_MISSING",
    wrongTypeCode: "SCRIPTS_NOT_DIRECTORY",
    missingMessage: "Create the scripts directory.",
    wrongTypeMessage: "Replace scripts with a directory."
  },
  {
    relativePath: "package-lock.json",
    expectedType: "file",
    missingCode: "PACKAGE_LOCK_MISSING",
    wrongTypeCode: "PACKAGE_LOCK_NOT_FILE",
    missingMessage: "Restore package-lock.json.",
    wrongTypeMessage: "Replace package-lock.json with a file."
  },
  {
    relativePath: "quartz.config.yaml",
    expectedType: "file",
    missingCode: "QUARTZ_CONFIG_MISSING",
    wrongTypeCode: "QUARTZ_CONFIG_NOT_FILE",
    missingMessage: "Restore quartz.config.yaml.",
    wrongTypeMessage: "Replace quartz.config.yaml with a file."
  },
  {
    relativePath: "scripts/validate-content.mjs",
    expectedType: "file",
    missingCode: "VALIDATE_CONTENT_MISSING",
    wrongTypeCode: "VALIDATE_CONTENT_NOT_FILE",
    missingMessage: "Restore scripts/validate-content.mjs.",
    wrongTypeMessage: "Replace scripts/validate-content.mjs with a file."
  }
]

function issue(code: WorkspaceIssue["code"], message: string, path?: string): WorkspaceIssue {
  return path === undefined ? { code, message } : { code, message, path }
}

async function inspectRequiredPaths(root: string): Promise<WorkspaceIssue[]> {
  const issues: WorkspaceIssue[] = []
  for (const requirement of requiredPaths) {
    const path = resolve(root, requirement.relativePath)
    try {
      const details = await stat(path)
      const hasExpectedType =
        requirement.expectedType === "directory" ? details.isDirectory() : details.isFile()
      if (!hasExpectedType) {
        issues.push(issue(requirement.wrongTypeCode, requirement.wrongTypeMessage, path))
      }
    } catch {
      issues.push(issue(requirement.missingCode, requirement.missingMessage, path))
    }
  }
  return issues
}

function didSucceed(result: CommandResult): boolean {
  return result.exitCode === 0
}

async function inspectGit(root: string, runner: CommandRunner): Promise<WorkspaceIssue[]> {
  const issues: WorkspaceIssue[] = []
  let topLevel: CommandResult
  try {
    topLevel = await runner.run({ executable: "git", args: ["rev-parse", "--show-toplevel"], cwd: root })
  } catch {
    return [issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
  }

  if (!didSucceed(topLevel)) {
    return [issue("GIT_NOT_REPOSITORY", "Initialize this folder as a Git repository.")]
  }
  if (resolve(topLevel.stdout.trim()) !== root) {
    return [issue("GIT_ROOT_MISMATCH", "Open the Git repository root, not a nested folder.")]
  }

  let origin: CommandResult
  try {
    origin = await runner.run({ executable: "git", args: ["remote", "get-url", "origin"], cwd: root })
  } catch {
    return [issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
  }
  if (!didSucceed(origin) || origin.stdout.trim() === "") {
    const code = /no such remote|does not appear to be a git repository/i.test(origin.stderr)
      ? "GIT_ORIGIN_MISSING"
      : "GIT_ORIGIN_FAILED"
    issues.push(
      issue(
        code,
        code === "GIT_ORIGIN_MISSING"
          ? "Add an origin remote before publishing."
          : "Could not read the origin remote. Check the repository configuration."
      )
    )
  }

  let status: CommandResult
  try {
    status = await runner.run({ executable: "git", args: ["status", "--porcelain=v2"], cwd: root })
  } catch {
    return [...issues, issue("GIT_UNAVAILABLE", "Git is unavailable. Install Git and try again.")]
  }
  if (!didSucceed(status)) {
    issues.push(issue("GIT_STATUS_FAILED", "Could not inspect the Git working tree."))
  }
  return issues
}

export async function inspectWorkspace(
  rootPath: string,
  options: InspectWorkspaceOptions
): Promise<WorkspaceInspection> {
  const root = resolve(rootPath)
  const issues = await inspectRequiredPaths(root)
  const files = issues.length === 0
  const gitIssues = options.checkGit ? await inspectGit(root, options.runner ?? systemCommandRunner) : []
  issues.push(...gitIssues)
  const git = options.checkGit && gitIssues.length === 0
  const capabilities: WorkspaceCapabilities = {
    files,
    preview: files,
    git,
    publish: files && git
  }

  if (issues.length === 0) {
    return { ok: true, root, capabilities, issues: [] }
  }
  return { ok: false, root, capabilities, issues }
}
