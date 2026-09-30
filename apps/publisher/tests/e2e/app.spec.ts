import { _electron as electron, expect, test } from "@playwright/test"
import { execFile } from "node:child_process"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createTemporaryGitRepository, git } from "../helpers/git"

const publisherRoot = resolve(import.meta.dirname, "../..")

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function killLaunchedProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The launched app already exited.
    }
    return
  }
  await new Promise<void>((resolvePromise) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
      resolvePromise(),
    )
  })
}

async function closeApplication(
  application: Awaited<ReturnType<typeof electron.launch>> | undefined,
): Promise<void> {
  if (!application) return
  const child = application.process()
  const close = application.close()
  if (!(await bounded(close, 5_000))) await killLaunchedProcessTree(child.pid)
  await bounded(close, 5_000)
}

async function writeGardenFile(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, ...path.split("/"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

const note = (title: string, body: string): string => `---
title: ${title}
date: 2026-09-30
description: ${title} description
tags:
  - e2e
---

# ${title}

${body}
`

test("edits, changes visibility, and publishes only the selected public note", async () => {
  const repository = await createTemporaryGitRepository()
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await Promise.all([
      writeGardenFile(repository.root, "content/life/alpha.md", note("Alpha", "original alpha")),
      writeGardenFile(repository.root, "content/life/beta.md", note("Beta", "original beta")),
      writeGardenFile(repository.root, "content/life/gamma.md", note("Gamma", "original gamma")),
      writeGardenFile(repository.root, "scripts/validate-content.mjs", "process.exit(0)\n"),
      writeGardenFile(repository.root, "private/.gitkeep", ""),
      writeGardenFile(
        repository.root,
        ".gitignore",
        "node_modules/\n.e2e-runtime/\n.garden-publisher/\nprivate/*\n!private/.gitkeep\n",
      ),
      writeGardenFile(repository.root, "quartz.config.yaml", "configuration: {}\n"),
      writeGardenFile(
        repository.root,
        "package.json",
        JSON.stringify({
          name: "e2e-garden",
          private: true,
          scripts: { "verify:site": 'node -e "process.exit(0)"' },
        }),
      ),
      writeGardenFile(
        repository.root,
        "package-lock.json",
        JSON.stringify({
          name: "e2e-garden",
          lockfileVersion: 3,
          packages: { "": { name: "e2e-garden" } },
        }),
      ),
      mkdir(join(repository.root, "node_modules"), { recursive: true }),
      mkdir(join(repository.root, "private", "life"), { recursive: true }),
    ])
    await git(repository.root, ["add", "."])
    await git(repository.root, ["commit", "-m", "Initial garden"])
    await git(repository.root, ["push", "-u", "origin", "main"])

    const runtimeRoot = join(repository.root, ".e2e-runtime")
    const npmCli = join(runtimeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    await mkdir(dirname(npmCli), { recursive: true })
    await copyFile(process.execPath, join(runtimeRoot, "node.exe"))
    await writeFile(npmCli, "process.exit(0)\n")
    await writeFile(
      join(repository.root, "node_modules", ".package-lock.json"),
      JSON.stringify({
        name: "e2e-garden",
        lockfileVersion: 3,
        packages: { "": { name: "e2e-garden" } },
      }),
    )

    application = await electron.launch({
      args: ["."],
      cwd: publisherRoot,
      env: {
        ...process.env,
        GARDEN_PUBLISHER_E2E: "1",
        GARDEN_PUBLISHER_E2E_WORKSPACE: repository.root,
        GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
        GARDEN_PUBLISHER_E2E_DEPLOYMENT: "success",
      },
    })
    const page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await expect(page.getByRole("region", { name: "启动检查" })).toHaveCount(0)

    await page.getByRole("button", { name: /Alpha，公开/ }).click()
    const editor = page.locator(".cm-content")
    await expect(editor).toContainText("original alpha")
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\nselected alpha edit")
    await expect
      .poll(async () => readFile(join(repository.root, "content", "life", "alpha.md"), "utf8"))
      .toContain("selected alpha edit")

    await page.getByRole("button", { name: /Gamma，公开/ }).click()
    await expect(editor).toContainText("original gamma")
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\nunselected gamma edit")
    await expect
      .poll(async () => readFile(join(repository.root, "content", "life", "gamma.md"), "utf8"))
      .toContain("unselected gamma edit")

    await page.getByRole("button", { name: /Beta，公开/ }).click()
    await expect(editor).toContainText("original beta")
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\nprivate beta edit")
    await expect
      .poll(async () => readFile(join(repository.root, "content", "life", "beta.md"), "utf8"))
      .toContain("private beta edit")
    await page.getByRole("button", { name: "可见性：公开" }).click()
    await page.getByRole("menuitemradio", { name: /私密/ }).click()
    await page.getByRole("button", { name: "确认设为私密" }).click()
    await expect(page.getByRole("button", { name: "可见性：私密" })).toBeVisible()

    await page.getByRole("button", { name: "检查并发布" }).click()
    const review = page.getByRole("dialog", { name: "检查并发布" })
    await expect(review.getByLabel("已锁定").first()).toBeVisible()
    const alphaChange = review.getByRole("checkbox", { name: /alpha/i })
    await expect(alphaChange).toBeChecked()
    const gammaChange = review.getByRole("checkbox", { name: /gamma/i })
    await expect(gammaChange).toBeChecked()
    await gammaChange.uncheck()
    const betaDeletion = review.getByRole("checkbox", { name: /beta/i })
    await expect(betaDeletion).toBeChecked()
    await betaDeletion.uncheck()
    await expect(alphaChange).toBeChecked()
    await review.getByRole("button", { name: "验证并发布" }).click()
    await expect(page.getByRole("status", { name: "发布状态" })).toContainText("部署成功")

    const remoteAlpha = await git(repository.root, ["show", "origin/main:content/life/alpha.md"])
    expect(remoteAlpha.stdout).toContain("selected alpha edit")
    const remoteBeta = await git(repository.root, ["show", "origin/main:content/life/beta.md"])
    expect(remoteBeta.stdout).toContain("original beta")
    expect(remoteBeta.stdout).not.toContain("private beta edit")
    const remoteGamma = await git(repository.root, ["show", "origin/main:content/life/gamma.md"])
    expect(remoteGamma.stdout).toContain("original gamma")
    expect(remoteGamma.stdout).not.toContain("unselected gamma edit")
    expect(await readFile(join(repository.root, "content", "life", "gamma.md"), "utf8")).toContain(
      "unselected gamma edit",
    )
    const remotePrivate = await git(repository.root, [
      "ls-tree",
      "-r",
      "--name-only",
      "origin/main",
      "private",
    ])
    expect(remotePrivate.stdout.trim()).toBe("private/.gitkeep")
    expect(await readFile(join(repository.root, "private", "life", "beta.md"), "utf8")).toContain(
      "private beta edit",
    )
  } finally {
    await closeApplication(application)
    if (!(await bounded(repository.cleanup(), 10_000))) {
      throw new Error("The temporary E2E garden could not be cleaned up within 10 seconds.")
    }
  }
})
