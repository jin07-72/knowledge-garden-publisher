import { _electron as electron, expect, test } from "@playwright/test"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createTemporaryGitRepository, git } from "../helpers/git"

const publisherRoot = resolve(import.meta.dirname, "../..")

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
      writeGardenFile(repository.root, "scripts/validate-content.mjs", "process.exit(0)\n"),
      writeGardenFile(repository.root, "private/.gitkeep", ""),
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
    ])
    await git(repository.root, ["add", "."])
    await git(repository.root, ["commit", "-m", "Initial garden"])
    await git(repository.root, ["push", "-u", "origin", "main"])

    const runtimeRoot = join(repository.root, ".e2e-runtime")
    const npmCli = join(runtimeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    await mkdir(dirname(npmCli), { recursive: true })
    await copyFile(process.execPath, join(runtimeRoot, "node.exe"))
    await writeFile(npmCli, "process.exit(0)\n")

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
    await expect(page.getByRole("region", { name: "启动检查" })).toContainText("工作区已准备好")

    await page.getByRole("button", { name: /Alpha，公开/ }).click()
    const editor = page.locator(".cm-content")
    await expect(editor).toContainText("original alpha")
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\nselected alpha edit")
    await expect(page.getByLabel("保存状态")).toContainText("已保存")

    await page.getByRole("button", { name: /Beta，公开/ }).click()
    await expect(editor).toContainText("original beta")
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\nunselected beta edit")
    await expect(page.getByLabel("保存状态")).toContainText("已保存")
    await page.getByRole("button", { name: "可见性：公开" }).click()
    await page.getByRole("option", { name: /私密/ }).click()
    await page.getByRole("button", { name: "确认设为私密" }).click()
    await expect(page.getByRole("button", { name: "可见性：私密" })).toBeVisible()

    await page.getByRole("button", { name: "检查并发布" }).click()
    const review = page.getByRole("dialog", { name: "检查并发布" })
    await expect(review.getByLabel("已锁定").first()).toBeVisible()
    const alphaChange = review.getByRole("checkbox", { name: /Alpha/ })
    await expect(alphaChange).toBeChecked()
    for (const checkbox of await review.getByRole("checkbox").all()) {
      if ((await checkbox.getAttribute("aria-label"))?.includes("Alpha")) continue
      if (await checkbox.isEnabled()) await checkbox.uncheck()
    }
    await review.getByRole("button", { name: "验证并发布" }).click()
    await expect(page.getByLabel("发布状态")).toContainText("部署成功")

    const remoteAlpha = await git(repository.root, ["show", "origin/main:content/life/alpha.md"])
    expect(remoteAlpha.stdout).toContain("selected alpha edit")
    const remoteBeta = await git(repository.root, ["show", "origin/main:content/life/beta.md"])
    expect(remoteBeta.stdout).toContain("original beta")
    expect(remoteBeta.stdout).not.toContain("unselected beta edit")
    const remotePrivate = await git(repository.root, [
      "ls-tree",
      "-r",
      "--name-only",
      "origin/main",
      "private",
    ])
    expect(remotePrivate.stdout.trim()).toBe("")
    expect(await readFile(join(repository.root, "private", "life", "beta.md"), "utf8")).toContain(
      "unselected beta edit",
    )
  } finally {
    await application?.close()
    await repository.cleanup()
  }
})
