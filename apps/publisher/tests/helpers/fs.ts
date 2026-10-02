import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
}

export async function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const target = join(root, ...relativePath.split("/"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

export async function createE2eRuntime(root: string): Promise<string> {
  const runtimeRoot = join(root, "runtime")
  const npmCli = join(runtimeRoot, "node_modules", "npm", "bin", "npm-cli.js")
  await mkdir(dirname(npmCli), { recursive: true })
  await copyFile(process.execPath, join(runtimeRoot, "node.exe"))
  await writeFile(
    npmCli,
    [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      'fs.mkdirSync(path.join(process.cwd(), "node_modules"), { recursive: true })',
      'fs.copyFileSync(path.join(process.cwd(), "package-lock.json"), path.join(process.cwd(), "node_modules", ".package-lock.json"))',
      "process.exit(0)",
      "",
    ].join("\n"),
  )
  return runtimeRoot
}
