import { _electron as electron, expect, test } from "@playwright/test"
import type { ChildProcess } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import {
  createQuartzGardenFixture,
  createTemporaryGitRepository,
  git,
  markedDomainIndex,
} from "../helpers/git"
import {
  createE2eRuntime,
  createTemporaryDirectory,
  exists,
  removeTemporaryDirectory,
} from "../helpers/fs"

const publisherRoot = resolve(import.meta.dirname, "../..")
type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>
const launchedChildren = new Set<ChildProcess>()

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child: ChildProcess, milliseconds = 5_000): Promise<boolean> {
  if (childHasExited(child)) return true
  return new Promise<boolean>((resolvePromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (exited: boolean): void => {
      if (timer) clearTimeout(timer)
      child.off("exit", onExit)
      resolvePromise(exited)
    }
    const onExit = (): void => finish(true)
    child.once("exit", onExit)
    timer = setTimeout(() => finish(childHasExited(child)), milliseconds)
  })
}

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

async function terminateLaunchedChild(child: ChildProcess): Promise<boolean> {
  if (childHasExited(child)) return true
  // Use the original ChildProcess handle rather than a raw PID. This avoids
  // targeting an unrelated process if Windows has already recycled the PID.
  try {
    child.kill("SIGKILL")
  } catch {
    // The original child may have exited between the state check and kill.
  }
  return waitForChildExit(child)
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return
  const child = application.process()
  const close = application.close()
  if (!(await bounded(close, 5_000))) await terminateLaunchedChild(child)
  await bounded(close, 5_000)
  if (!(await waitForChildExit(child)) && !(await terminateLaunchedChild(child))) {
    throw new Error(`Electron process ${child.pid ?? "unknown"} remained after forced termination.`)
  }
  launchedChildren.delete(child)
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right)
}

async function launchApplication(
  stateRoot: string,
  env: Record<string, string | undefined>,
): Promise<ElectronApplication> {
  const userData = join(stateRoot, "user-data")
  await mkdir(userData, { recursive: true })
  const launchEnvironment = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const application = await electron.launch({
    args: [".", `--user-data-dir=${userData}`],
    cwd: publisherRoot,
    env: launchEnvironment,
  })
  launchedChildren.add(application.process())
  const actualUserData = await application.evaluate(({ app }) => app.getPath("userData"))
  expect(samePath(actualUserData, userData)).toBe(true)
  return application
}

async function captureTrashTargets(
  application: ElectronApplication,
  receipt: string,
): Promise<void> {
  await application.evaluate(({ shell }, receiptPath) => {
    const originalTrashItem = shell.trashItem.bind(shell)
    shell.trashItem = async (target: string): Promise<void> => {
      const fileSystem = process.getBuiltinModule("node:fs/promises")
      await fileSystem.appendFile(receiptPath, `${target}\n`, "utf8")
      await originalTrashItem(target)
    }
  }, receipt)
}

async function createNote(
  page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
  options: {
    readonly title: string
    readonly slug: string
    readonly description: string
    readonly tags: string
    readonly domain: string
    readonly visibility: "public" | "private"
  },
): Promise<void> {
  await page.getByRole("button", { name: "新建笔记" }).click()
  const dialog = page.getByRole("dialog", { name: "新建笔记" })
  await dialog.getByRole("textbox", { name: "标题" }).fill(options.title)
  await dialog.getByRole("textbox", { name: "文件名" }).fill(options.slug)
  await dialog.getByRole("textbox", { name: "描述" }).fill(options.description)
  await dialog.getByRole("textbox", { name: "标签" }).fill(options.tags)
  await dialog.getByRole("combobox", { name: "领域" }).selectOption(options.domain)
  await dialog
    .getByRole("radio", { name: options.visibility === "public" ? "公开" : "私密" })
    .check()
  await dialog.getByRole("button", { name: "创建" }).click()
  const outcome = await Promise.race([
    dialog.waitFor({ state: "detached" }).then(() => ({ kind: "created" as const })),
    dialog
      .getByRole("alert")
      .waitFor({ state: "visible" })
      .then(async () => ({
        kind: "error" as const,
        message: (await dialog.getByRole("alert").textContent())?.trim() ?? "unknown error",
      })),
  ])
  if (outcome.kind === "error") throw new Error(`Note creation failed: ${outcome.message}`)
}

async function createDomain(
  page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
  name: string,
  slug: string,
): Promise<void> {
  await page.getByRole("button", { name: "管理领域" }).click()
  await page.getByRole("button", { name: "新建领域" }).click()
  const dialog = page.getByRole("dialog", { name: "新建领域" })
  await dialog.getByRole("textbox", { name: "显示名称" }).fill(name)
  await dialog.getByRole("textbox", { name: "英文路径" }).fill(slug)
  await dialog.getByRole("button", { name: "创建领域" }).click()
  await expect(page.getByRole("article", { name })).toBeVisible()
  await page.getByRole("button", { name: "关闭" }).click()
}

test.afterAll(async () => {
  const survivors: string[] = []
  for (const child of launchedChildren) {
    if (await waitForChildExit(child)) continue
    survivors.push(String(child.pid ?? "unknown"))
    await terminateLaunchedChild(child)
  }
  if (survivors.length > 0) {
    throw new Error(`Electron test processes remained after cleanup: ${survivors.join(", ")}`)
  }
})

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
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-publish-")
  let application: ElectronApplication | undefined
  try {
    await Promise.all([
      writeGardenFile(repository.root, "content/life/alpha.md", note("Alpha", "original alpha")),
      writeGardenFile(repository.root, "content/life/beta.md", note("Beta", "original beta")),
      writeGardenFile(repository.root, "content/life/gamma.md", note("Gamma", "original gamma")),
      writeGardenFile(
        repository.root,
        "content/life/index.md",
        markedDomainIndex({ slug: "life", name: "生活", order: 1 }, 1),
      ),
      writeGardenFile(repository.root, "scripts/validate-content.mjs", "process.exit(0)\n"),
      writeGardenFile(repository.root, "quartz/bootstrap-cli.mjs", ""),
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

    const runtimeRoot = await createE2eRuntime(stateRoot)
    await writeFile(
      join(repository.root, "node_modules", ".package-lock.json"),
      JSON.stringify({
        name: "e2e-garden",
        lockfileVersion: 3,
        packages: { "": { name: "e2e-garden" } },
      }),
    )

    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: repository.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
      GARDEN_PUBLISHER_E2E_DEPLOYMENT: "success",
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
    await removeTemporaryDirectory(stateRoot)
  }
})

test("manages independent blogs across safe application restarts", async () => {
  const first = await createQuartzGardenFixture({
    directoryName: "Knowledge Garden",
    noteTitle: "First Garden Note",
    noteBody: "first garden only",
  })
  const second = await createQuartzGardenFixture({
    directoryName: "Second Garden",
    noteTitle: "Second Garden Note",
    noteBody: "second garden only",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-state-")
  const registry = join(stateRoot, "blogs.json")
  const relaunchMarker = join(stateRoot, "relaunch-requested")
  const runtimeRoot = await createE2eRuntime(stateRoot)
  const environment = {
    ...process.env,
    GARDEN_PUBLISHER_E2E: "1",
    GARDEN_PUBLISHER_E2E_WORKSPACE: first.root,
    GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
    GARDEN_PUBLISHER_E2E_REGISTRY: registry,
    GARDEN_PUBLISHER_E2E_CHOOSE_LOCAL: second.root,
    GARDEN_PUBLISHER_E2E_RELAUNCH_MARKER: relaunchMarker,
  }
  let application: ElectronApplication | undefined
  try {
    application = await launchApplication(stateRoot, environment)
    let page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "切换博客：Knowledge Garden" })).toBeVisible()
    await expect(page.getByRole("button", { name: /First Garden Note，公开/ })).toBeVisible()

    await page.getByRole("button", { name: "切换博客：Knowledge Garden" }).click()
    await page.getByRole("menuitem", { name: "添加本地博客" }).click()
    const local = page.getByRole("region", { name: "添加本地博客" })
    await expect(local.locator("code")).toContainText(second.root)
    await local.getByLabel("显示名称").fill("Second Garden")
    await local.getByRole("button", { name: "添加此博客" }).click()
    await expect(page.getByRole("article", { name: "Second Garden" })).toBeVisible()
    await page.getByRole("button", { name: "关闭博客管理" }).click()

    await page.getByRole("button", { name: /First Garden Note，公开/ }).click()
    const editor = page.locator(".cm-content")
    await editor.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\npending switch save")

    const closed = application.waitForEvent("close")
    await page.getByRole("button", { name: "切换博客：Knowledge Garden" }).click()
    await page.getByRole("menuitemradio", { name: /Second Garden/ }).click()
    await closed
    application = undefined
    await expect.poll(async () => readFile(relaunchMarker, "utf8")).toContain("relaunch-requested")
    expect(await readFile(join(first.root, first.notePath), "utf8")).toContain(
      "pending switch save",
    )

    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "切换博客：Second Garden" })).toBeVisible()
    await expect(page.getByRole("button", { name: /Second Garden Note，公开/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /First Garden Note，公开/ })).toHaveCount(0)

    await closeApplication(application)
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.getByRole("button", { name: "切换博客：Second Garden" })).toBeVisible()

    await page.getByRole("button", { name: "切换博客：Second Garden" }).click()
    await page.getByRole("menuitem", { name: "管理博客" }).click()
    await page.getByRole("button", { name: "从列表移除 Knowledge Garden" }).click()
    await page.getByRole("button", { name: "确认移除 Knowledge Garden" }).click()
    await expect(page.getByRole("article", { name: "Knowledge Garden" })).toHaveCount(0)
    expect(await exists(first.root)).toBe(true)
    expect(await readFile(join(first.root, first.notePath), "utf8")).toContain(
      "pending switch save",
    )
    await page.getByRole("button", { name: "关闭博客管理" }).click()

    await page.setViewportSize({ width: 620, height: 760 })
    const switcher = page.getByRole("button", { name: "切换博客：Second Garden" })
    await expect(switcher).toBeVisible()
    await expect(switcher.locator("strong")).toHaveText("Second Garden")
    await expect(switcher.locator("small")).toBeHidden()
    await switcher.click()
    const narrowMenu = page.getByRole("menu", { name: "选择博客" })
    await expect(narrowMenu).toBeVisible()
    await expect(narrowMenu.locator(".blog-menu-copy small")).toBeHidden()
    const manage = narrowMenu.getByRole("menuitem", { name: "管理博客" })
    await expect(manage).toBeVisible()
    await expect(manage).toBeEnabled()
    await manage.click()
    await expect(narrowMenu).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "管理博客" })).toBeVisible()
    await page.getByRole("button", { name: "关闭博客管理" }).click()
    await expect(page.getByRole("button", { name: "切换博客：Second Garden" })).toBeVisible()
  } finally {
    await closeApplication(application)
    await Promise.all([first.cleanup(), second.cleanup()])
    await removeTemporaryDirectory(stateRoot)
  }
})

test("manages custom domains across restarts and blogs", async () => {
  const first = await createQuartzGardenFixture({
    directoryName: "Blog A",
    noteTitle: "Blog A Note",
    noteBody: "blog a only",
  })
  const second = await createQuartzGardenFixture({
    directoryName: "Blog B",
    noteTitle: "Blog B Note",
    noteBody: "blog b only",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-domains-")
  const registry = join(stateRoot, "blogs.json")
  const relaunchMarker = join(stateRoot, "relaunch-requested")
  const trashReceipt = join(stateRoot, "trash-receipt.txt")
  const runtimeRoot = await createE2eRuntime(stateRoot)
  const environment = {
    ...process.env,
    GARDEN_PUBLISHER_E2E: "1",
    GARDEN_PUBLISHER_E2E_WORKSPACE: first.root,
    GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
    GARDEN_PUBLISHER_E2E_REGISTRY: registry,
    GARDEN_PUBLISHER_E2E_CHOOSE_LOCAL: second.root,
    GARDEN_PUBLISHER_E2E_RELAUNCH_MARKER: relaunchMarker,
  }
  const publicPath = "content/artificial-intelligence/public-ai-note.md"
  const privatePath = "private/artificial-intelligence/private-ai-note.md"
  let application: ElectronApplication | undefined
  try {
    application = await launchApplication(stateRoot, environment)
    let page = await application.firstWindow()
    await expect(page.getByRole("button", { name: "切换博客：Blog A" })).toBeVisible()

    await createDomain(page, "人工智能", "artificial-intelligence")
    await createNote(page, {
      title: "公开 AI 笔记",
      slug: "public-ai-note",
      description: "公开人工智能笔记",
      tags: "AI,公开",
      domain: "artificial-intelligence",
      visibility: "public",
    })
    await createNote(page, {
      title: "私密 AI 笔记",
      slug: "private-ai-note",
      description: "私密人工智能笔记",
      tags: "AI,私密",
      domain: "artificial-intelligence",
      visibility: "private",
    })

    const notes = page.getByRole("navigation", { name: "笔记" })
    const unrelatedNote = notes.getByRole("button", { name: "Blog A Note，公开", exact: true })
    await expect(unrelatedNote).toBeVisible()
    await notes.getByRole("button", { name: "人工智能", exact: true }).click()
    await expect(unrelatedNote).toHaveCount(0)
    const publicNote = notes.getByRole("button", { name: "公开 AI 笔记，公开", exact: true })
    const privateNote = notes.getByRole("button", { name: "私密 AI 笔记，私密", exact: true })
    await expect(publicNote).toBeVisible()
    await expect(privateNote).toBeVisible()
    await publicNote.click()
    await expect(page.getByRole("region", { name: "Markdown 编辑器" })).toContainText(publicPath)
    await privateNote.click()
    await expect(page.getByRole("region", { name: "Markdown 编辑器" })).toContainText(privatePath)
    expect(await exists(join(first.root, ...publicPath.split("/")))).toBe(true)
    expect(await exists(join(first.root, ...privatePath.split("/")))).toBe(true)

    await page.getByRole("button", { name: "管理领域" }).click()
    let manager = page.getByRole("dialog", { name: "管理领域" })
    const nonEmptyDomain = manager.getByRole("article", { name: "人工智能" })
    await expect(nonEmptyDomain).toContainText("公开 1")
    await expect(nonEmptyDomain).toContainText("私密 1")
    await expect(
      nonEmptyDomain.getByRole("button", { name: "删除（公开 1，私密 1）" }),
    ).toBeDisabled()
    await manager.getByRole("button", { name: "关闭" }).click()

    await closeApplication(application)
    application = undefined
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.getByRole("button", { name: "人工智能" })).toBeVisible()
    await expect(page.getByRole("button", { name: "公开 AI 笔记，公开" })).toBeVisible()
    await expect(page.getByRole("button", { name: "私密 AI 笔记，私密" })).toBeVisible()

    await page.getByRole("button", { name: "切换博客：Blog A" }).click()
    await page.getByRole("menuitem", { name: "添加本地博客" }).click()
    const local = page.getByRole("region", { name: "添加本地博客" })
    await local.getByLabel("显示名称").fill("Blog B")
    await local.getByRole("button", { name: "添加此博客" }).click()
    await expect(page.getByRole("article", { name: "Blog B" })).toBeVisible()
    await page.getByRole("button", { name: "关闭博客管理" }).click()

    let closed = application.waitForEvent("close")
    await page.getByRole("button", { name: "切换博客：Blog A" }).click()
    await page.getByRole("menuitemradio", { name: /Blog B/ }).click()
    await closed
    application = undefined
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.getByRole("button", { name: "切换博客：Blog B" })).toBeVisible()
    const blogBNotes = page.getByRole("navigation", { name: "笔记" })
    await expect(blogBNotes.getByRole("button", { name: "生活", exact: true })).toBeVisible()
    const blogBFixtureNote = blogBNotes.getByRole("button", {
      name: "Blog B Note，公开",
      exact: true,
    })
    await expect(blogBFixtureNote).toBeVisible()
    await blogBFixtureNote.click()
    await expect(page.getByRole("region", { name: "Markdown 编辑器" })).toContainText(
      second.notePath,
    )
    await expect(blogBNotes.getByRole("button", { name: "人工智能", exact: true })).toHaveCount(0)

    closed = application.waitForEvent("close")
    await page.getByRole("button", { name: "切换博客：Blog B" }).click()
    await page.getByRole("menuitemradio", { name: /Blog A/ }).click()
    await closed
    application = undefined
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.getByRole("button", { name: "切换博客：Blog A" })).toBeVisible()
    const returnedNotes = page.getByRole("navigation", { name: "笔记" })
    await expect(returnedNotes.getByRole("button", { name: "人工智能", exact: true })).toBeVisible()
    const returnedPublicNote = returnedNotes.getByRole("button", {
      name: "公开 AI 笔记，公开",
      exact: true,
    })
    await expect(returnedPublicNote).toBeVisible()
    await expect(
      returnedNotes.getByRole("button", { name: "私密 AI 笔记，私密", exact: true }),
    ).toBeVisible()
    await returnedPublicNote.click()
    await expect(page.getByRole("region", { name: "Markdown 编辑器" })).toContainText(publicPath)

    await captureTrashTargets(application, trashReceipt)
    await createDomain(page, "待删除领域", "temporary-domain")
    await page.getByRole("button", { name: "管理领域" }).click()
    manager = page.getByRole("dialog", { name: "管理领域" })
    await manager
      .getByRole("article", { name: "待删除领域" })
      .getByRole("button", { name: "删除" })
      .click()
    const confirmation = page.getByRole("dialog", { name: "确认删除领域？" })
    await confirmation.getByRole("button", { name: "确认删除" }).click()
    await expect(page.getByRole("article", { name: "待删除领域" })).toHaveCount(0)
    await manager.getByRole("button", { name: "关闭" }).click()

    expect(await exists(join(first.root, "content", "temporary-domain"))).toBe(false)
    expect(await exists(join(first.root, "private", "temporary-domain"))).toBe(false)
    await expect
      .poll(async () =>
        (await readFile(trashReceipt, "utf8")).trim().split(/\r?\n/).filter(Boolean),
      )
      .toHaveLength(1)
    const targets = (await readFile(trashReceipt, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    expect(targets).toHaveLength(1)
    expect(
      samePath(dirname(targets[0]!), join(first.root, ".garden-publisher", "domain-transactions")),
    ).toBe(true)
    expect(basename(targets[0]!)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(await exists(join(first.root, ...publicPath.split("/")))).toBe(true)
    expect(await exists(join(first.root, ...privatePath.split("/")))).toBe(true)
  } finally {
    await closeApplication(application)
    await Promise.all([first.cleanup(), second.cleanup()])
    await removeTemporaryDirectory(stateRoot)
  }
})

test("clones a validated GitHub request from a local E2E bare repository", async () => {
  const active = await createQuartzGardenFixture({
    directoryName: "Knowledge Garden",
    noteTitle: "Active Note",
    noteBody: "active garden",
  })
  const cloneSource = await createQuartzGardenFixture({
    directoryName: "Clone Source",
    noteTitle: "Cloned Note",
    noteBody: "cloned without a network",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-clone-")
  const destination = join(stateRoot, "Cloned Garden")
  const validationMarker = join(stateRoot, "clone-validated")
  const runtimeRoot = await createE2eRuntime(stateRoot)
  let application: ElectronApplication | undefined
  try {
    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: active.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
      GARDEN_PUBLISHER_E2E_CLONE_SOURCE: cloneSource.remote,
      GARDEN_PUBLISHER_E2E_VALIDATION_MARKER: validationMarker,
    })
    const page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await page.getByRole("button", { name: "切换博客：Knowledge Garden" }).click()
    await page.getByRole("menuitem", { name: "从 GitHub 下载" }).click()
    const clone = page.getByRole("region", { name: "从 GitHub 下载" })
    await clone.getByLabel("GitHub 仓库地址").fill("https://github.com/example/cloned-garden.git")
    await clone.getByLabel("保存位置").fill(destination)
    await clone.getByLabel("显示名称（可选）").fill("Cloned Garden")
    await clone.getByRole("button", { name: "开始下载" }).click()

    await expect
      .poll(async () => exists(join(destination, "node_modules", ".package-lock.json")))
      .toBe(true)
    await expect.poll(async () => exists(validationMarker)).toBe(true)
    expect(await readFile(validationMarker, "utf8")).toContain("validated")
    await expect(page.getByRole("article", { name: "Cloned Garden" })).toBeVisible()
    expect(await readFile(join(destination, cloneSource.notePath), "utf8")).toContain(
      "cloned without a network",
    )
    await expect(page.locator("body")).not.toContainText(cloneSource.remote)
  } finally {
    await closeApplication(application)
    await Promise.all([active.cleanup(), cloneSource.cleanup()])
    await removeTemporaryDirectory(stateRoot)
  }
})

test("recovers a corrupt registry through the local blog chooser", async () => {
  const garden = await createQuartzGardenFixture({
    directoryName: "Recovered Garden",
    noteTitle: "Recovered Note",
    noteBody: "registry recovery",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-recovery-")
  const registry = join(stateRoot, "blogs.json")
  const runtimeRoot = await createE2eRuntime(stateRoot)
  await writeFile(registry, "{broken registry")
  const environment = {
    ...process.env,
    GARDEN_PUBLISHER_E2E: "1",
    GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
    GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
    GARDEN_PUBLISHER_E2E_REGISTRY: registry,
    GARDEN_PUBLISHER_E2E_CHOOSE_LOCAL: garden.root,
  }
  let application: ElectronApplication | undefined
  try {
    application = await launchApplication(stateRoot, environment)
    let page = await application.firstWindow()
    const recovery = page.getByRole("dialog", { name: "博客恢复" })
    await expect(recovery).toBeVisible()
    await recovery.getByRole("button", { name: "选择文件夹" }).click()
    await expect(recovery.locator("code")).toContainText(garden.root)
    await recovery.getByLabel("显示名称").fill("Recovered Garden")
    const closed = application.waitForEvent("close")
    await recovery.getByRole("button", { name: "恢复此博客" }).click()
    await closed
    application = undefined

    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "切换博客：Recovered Garden" })).toBeVisible()
    await expect(page.getByRole("button", { name: /Recovered Note，公开/ })).toBeVisible()
  } finally {
    await closeApplication(application)
    await garden.cleanup()
    await removeTemporaryDirectory(stateRoot)
  }
})
