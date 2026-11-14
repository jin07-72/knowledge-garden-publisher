import { _electron as electron, expect, test, type Locator } from "@playwright/test"
import { execFile, type ChildProcess } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import { deflateSync } from "node:zlib"
import matter from "gray-matter"
import { parse } from "yaml"
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

function pngChunk(type: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  const result = Buffer.alloc(12 + payload.length)
  result.writeUInt32BE(payload.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length)
  return result
}

function onePixelPng(red: number, green: number, blue: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

async function expectDecodedImage(image: Locator): Promise<void> {
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const decoded = element as HTMLImageElement
        return decoded.complete && decoded.naturalWidth > 0 && decoded.naturalHeight > 0
      }),
    )
    .toBe(true)
}

async function expectBlogAddresses(
  container: Locator,
  localPath: string,
  website = "未配置网站",
): Promise<void> {
  const addresses = container.locator(".blog-address-rows")
  await expect(addresses).toHaveCount(1)
  for (const label of ["仓库", "网站", "本地"]) {
    await expect(addresses.locator("dt", { hasText: new RegExp(`^${label}$`) })).toBeVisible()
  }
  await expect(addresses.locator("dd").nth(0)).toHaveText("未配置仓库")
  await expect(addresses.locator("dd").nth(1)).toHaveText(website)
  await expect(addresses.locator("dd").nth(2)).toHaveText(localPath)
  for (const action of await addresses.locator("button").all()) {
    await expect(action).toHaveAccessibleDescription(website)
  }
  expect(
    await container.evaluate((element) => {
      const topbar = element.matches(".blog-switcher-summary") ? element.closest(".topbar") : null
      const bounds = (topbar ?? element).getBoundingClientRect()
      return Array.from(
        element.querySelectorAll(
          ".blog-address-rows, .blog-address-row, dt, dd, .blog-address-open",
        ),
      )
        .filter((child) => {
          const rect = child.getBoundingClientRect()
          return (
            rect.left < Math.max(0, bounds.left) - 1 ||
            rect.right > Math.min(window.innerWidth, bounds.right) + 1 ||
            (topbar !== null && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1))
          )
        })
        .map((child) => child.className || child.tagName)
    }),
    "address rectangles must fit their container",
  ).toEqual([])
  expect(
    await container.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
}

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
    if (process.platform === "win32" && Number.isSafeInteger(child.pid) && child.pid! > 0) {
      await new Promise<void>((resolvePromise) => {
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => resolvePromise(),
        )
      })
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    // The original child may have exited between the state check and kill.
  }
  return waitForChildExit(child)
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return
  const child = application.process()
  const close = application.close()
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    close.then(
      async () =>
        (await waitForChildExit(child, 45_000))
          ? { kind: "closed" as const }
          : { kind: "timeout" as const },
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolvePromise) => {
      // The application may spend 10 seconds flushing renderer state before it can
      // dispose the preview workspace and its Quartz child process.
      timer = setTimeout(() => resolvePromise({ kind: "timeout" }), 45_000)
    }),
  ])
  if (timer) clearTimeout(timer)

  if (outcome.kind !== "closed") {
    const terminated = await terminateLaunchedChild(child)
    launchedChildren.delete(child)
    if (!terminated) {
      throw new Error(
        `Electron process ${child.pid ?? "unknown"} remained after graceful close failed and forced termination was attempted.`,
      )
    }
    if (outcome.kind === "timeout") {
      throw new Error("Electron application.close() exceeded the 45 second graceful-close limit.")
    }
    throw new Error("Electron application.close() rejected during graceful shutdown.", {
      cause: outcome.error,
    })
  }
  launchedChildren.delete(child)
}

async function holdLoopbackPortIfAvailable(port: number): Promise<Server | undefined> {
  const server = createServer()
  return new Promise((resolvePromise, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolvePromise(undefined)
      else reject(error)
    })
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolvePromise(server))
  })
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()))
  })
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolvePromise) => {
    const finish = (available: boolean): void => {
      server.removeAllListeners()
      resolvePromise(available)
    }
    server.once("error", () => finish(false))
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(!error))
    })
  })
}

async function previewWorkspaceDirectories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("knowledge-garden-preview-"))
    .map((entry) => entry.name)
    .sort()
}

async function removeTemporaryDirectoryEventually(path: string): Promise<void> {
  let lastError: unknown
  await expect
    .poll(
      async () => {
        try {
          await removeTemporaryDirectory(path)
          return true
        } catch (error) {
          lastError = error
          return false
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true)
    .catch(() => {
      throw lastError
    })
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
    // Raw Electron binaries can hit a Windows sandbox breakpoint (0x80000003)
    // before app startup on this host. E2E uses only disposable fixtures and a
    // dedicated user-data directory, so disabling that host sandbox is scoped
    // to the Windows test process rather than the packaged application.
    args: [
      ...(process.platform === "win32" ? ["--no-sandbox"] : []),
      ".",
      `--user-data-dir=${userData}`,
    ],
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
    shell.trashItem = async (target: string): Promise<void> => {
      const fileSystem = process.getBuiltinModule("node:fs/promises")
      await fileSystem.appendFile(receiptPath, `${target}\n`, "utf8")
    }
  }, receipt)
}

async function snapshotClipboard(
  application: ElectronApplication,
): Promise<{ readonly safeToMutate: boolean }> {
  return application.evaluate(async ({ clipboard }) => {
    type StoredPayload =
      | {
          readonly format: string
          readonly kind: "blob"
          readonly mime: string
          readonly bytes: Buffer
        }
      | {
          readonly format: string
          readonly kind: "bookmark"
          readonly value: Electron.ClipboardBookmark
        }
    type Snapshot =
      | { readonly mode: "modern"; readonly items: readonly (readonly StoredPayload[])[] }
      | {
          readonly mode: "legacy"
          readonly safeToMutate: boolean
          readonly formats: readonly { readonly format: string; readonly bytes: Buffer }[]
          readonly text: string
          readonly html: string
          readonly rtf: string
          readonly bookmark: Electron.ClipboardBookmark
          readonly imagePng: Buffer
        }
    type LegacyClipboard = {
      availableFormats(): string[]
      readBuffer(format: string): Buffer
      readText(): string
      readHTML(): string
      readRTF(): string
      readBookmark(): Electron.ClipboardBookmark
      readImage(): { isEmpty(): boolean; toPNG(): Buffer }
    }
    const key = Symbol.for("garden-publisher.e2e.clipboard-snapshot")
    const store = globalThis as typeof globalThis & { [key]?: Snapshot }
    if (store[key]) throw new Error("An E2E clipboard snapshot is already installed.")
    const commonKind = (
      format: string,
    ): "text" | "html" | "rtf" | "bookmark" | "image" | undefined => {
      const compact = format.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "")
      if (compact.includes("bookmark") || compact.includes("urilist") || compact === "url")
        return "bookmark"
      if (compact.includes("html")) return "html"
      if (compact.includes("rtf") || compact.includes("richtext")) return "rtf"
      if (
        compact.includes("image") ||
        compact.includes("png") ||
        compact.includes("bitmap") ||
        compact.endsWith("dib")
      )
        return "image"
      if (
        compact === "text" ||
        compact.includes("textplain") ||
        compact.includes("unicodetext") ||
        compact.includes("utf8plaintext") ||
        compact.includes("utf16plaintext")
      )
        return "text"
      return undefined
    }
    const legacy = clipboard as unknown as Partial<LegacyClipboard>
    if (typeof legacy.availableFormats === "function") {
      const names = legacy.availableFormats()
      const canReadRaw = typeof legacy.readBuffer === "function"
      const safeToMutate = canReadRaw && names.every((format) => commonKind(format) !== undefined)
      const image = legacy.readImage?.()
      store[key] = {
        mode: "legacy",
        safeToMutate,
        formats: canReadRaw
          ? names.map((format) => ({ format, bytes: Buffer.from(legacy.readBuffer!(format)) }))
          : [],
        text: legacy.readText?.() ?? "",
        html: legacy.readHTML?.() ?? "",
        rtf: legacy.readRTF?.() ?? "",
        bookmark: legacy.readBookmark?.() ?? { title: "", url: "" },
        imagePng: image && !image.isEmpty() ? image.toPNG() : Buffer.alloc(0),
      }
      return { safeToMutate }
    }

    const items: StoredPayload[][] = []
    for (const item of await clipboard.read()) {
      const stored: StoredPayload[] = []
      for (const format of item.types) {
        const payload = await item.getType(format)
        stored.push(
          payload instanceof Blob
            ? {
                format,
                kind: "blob",
                mime: payload.type,
                bytes: Buffer.from(await payload.arrayBuffer()),
              }
            : { format, kind: "bookmark", value: { ...payload } },
        )
      }
      items.push(stored)
    }
    store[key] = { mode: "modern", items }
    return { safeToMutate: true }
  })
}

async function restoreClipboard(
  application: ElectronApplication | undefined,
): Promise<"restored" | "unmodified" | "missing" | "failed"> {
  if (!application) return "missing"
  return application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    type StoredPayload =
      | {
          readonly format: string
          readonly kind: "blob"
          readonly mime: string
          readonly bytes: Buffer
        }
      | {
          readonly format: string
          readonly kind: "bookmark"
          readonly value: Electron.ClipboardBookmark
        }
    type Snapshot =
      | { readonly mode: "modern"; readonly items: readonly (readonly StoredPayload[])[] }
      | {
          readonly mode: "legacy"
          readonly safeToMutate: boolean
          readonly formats: readonly { readonly format: string; readonly bytes: Buffer }[]
          readonly text: string
          readonly html: string
          readonly rtf: string
          readonly bookmark: Electron.ClipboardBookmark
          readonly imagePng: Buffer
        }
    type LegacyClipboard = {
      availableFormats(): string[]
      readBuffer(format: string): Buffer
      write(data: {
        text?: string
        html?: string
        rtf?: string
        bookmark?: string
        image?: ReturnType<typeof nativeImage.createFromBuffer>
      }): void
    }
    const key = Symbol.for("garden-publisher.e2e.clipboard-snapshot")
    const store = globalThis as typeof globalThis & { [key]?: Snapshot }
    const snapshot = store[key]
    if (!snapshot) return "missing"
    const standardKind = (
      format: string,
    ): "text" | "html" | "rtf" | "bookmark" | "image" | undefined => {
      const compact = format.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "")
      if (compact.includes("bookmark") || compact.includes("urilist") || compact === "url")
        return "bookmark"
      if (compact.includes("html")) return "html"
      if (compact.includes("rtf") || compact.includes("richtext")) return "rtf"
      if (
        compact.includes("image") ||
        compact.includes("png") ||
        compact.includes("bitmap") ||
        compact.endsWith("dib")
      )
        return "image"
      if (
        compact === "text" ||
        compact.includes("textplain") ||
        compact.includes("unicodetext") ||
        compact.includes("utf8plaintext") ||
        compact.includes("utf16plaintext")
      )
        return "text"
      return undefined
    }
    const equalPayloads = (
      left: readonly StoredPayload[],
      right: readonly StoredPayload[],
    ): boolean => {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        const wanted = left[index]
        const found = right[index]
        if (wanted.format !== found.format || wanted.kind !== found.kind) return false
        if (wanted.kind === "bookmark" && found.kind === "bookmark") {
          if (wanted.value.title !== found.value.title || wanted.value.url !== found.value.url)
            return false
        } else if (wanted.kind === "blob" && found.kind === "blob") {
          if (wanted.mime !== found.mime || !wanted.bytes.equals(found.bytes)) return false
        }
      }
      return true
    }
    const readModern = async (): Promise<StoredPayload[][]> => {
      const items: StoredPayload[][] = []
      for (const item of await clipboard.read()) {
        const stored: StoredPayload[] = []
        for (const format of item.types) {
          const payload = await item.getType(format)
          stored.push(
            payload instanceof Blob
              ? {
                  format,
                  kind: "blob",
                  mime: payload.type,
                  bytes: Buffer.from(await payload.arrayBuffer()),
                }
              : { format, kind: "bookmark", value: { ...payload } },
          )
        }
        items.push(stored)
      }
      return items
    }
    try {
      if (snapshot.mode === "legacy") {
        if (!snapshot.safeToMutate) return "unmodified"
        const legacy = clipboard as unknown as LegacyClipboard
        if (snapshot.formats.length === 0) {
          clipboard.clear()
          return legacy.availableFormats().length === 0 ? "restored" : "failed"
        }
        const kinds = new Set(snapshot.formats.map(({ format }) => standardKind(format)))
        legacy.write({
          ...(kinds.has("text")
            ? { text: snapshot.text }
            : kinds.has("bookmark")
              ? { text: snapshot.bookmark.url }
              : {}),
          ...(kinds.has("html") ? { html: snapshot.html } : {}),
          ...(kinds.has("rtf") ? { rtf: snapshot.rtf } : {}),
          ...(kinds.has("bookmark") ? { bookmark: snapshot.bookmark.title } : {}),
          ...(kinds.has("image") ? { image: nativeImage.createFromBuffer(snapshot.imagePng) } : {}),
        })
        const restoredFormats = legacy.availableFormats()
        if (restoredFormats.length !== snapshot.formats.length) return "failed"
        return snapshot.formats.every(({ format, bytes }) => {
          const restored = restoredFormats.find(
            (candidate) =>
              candidate.toLocaleLowerCase("en-US") === format.toLocaleLowerCase("en-US"),
          )
          return restored !== undefined && legacy.readBuffer(restored).equals(bytes)
        })
          ? "restored"
          : "failed"
      }

      if (snapshot.items.length === 0) {
        clipboard.clear()
        return (await clipboard.read()).length === 0 ? "restored" : "failed"
      }
      const items = snapshot.items.map((payloads) => {
        const data: Record<string, Blob | Electron.ClipboardBookmark> = {}
        for (const payload of payloads) {
          data[payload.format] =
            payload.kind === "blob"
              ? new Blob([Uint8Array.from(payload.bytes)], { type: payload.mime })
              : { ...payload.value }
        }
        return new ClipboardItem(data)
      })
      await clipboard.write(items)
      const restored = await readModern()
      if (restored.length !== snapshot.items.length) return "failed"
      for (let index = 0; index < snapshot.items.length; index += 1) {
        if (!equalPayloads(snapshot.items[index], restored[index])) return "failed"
      }
      return "restored"
    } finally {
      delete store[key]
    }
  })
}

async function verifyClipboardItemRoundTrip(application: ElectronApplication): Promise<void> {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const rawJsonFormat = 'electron application/osclipboard;format="application/json"'
    const expected = [
      {
        format: rawJsonFormat,
        mime: rawJsonFormat,
        bytes: Buffer.from('{"source":"garden-publisher","value":44}', "utf8"),
      },
      {
        format: "text/plain",
        mime: "text/plain",
        bytes: Buffer.from("garden-publisher clipboard self-check", "utf8"),
      },
    ]
    await clipboard.write([
      new ClipboardItem(
        Object.fromEntries(
          expected.map(({ format, mime, bytes }) => [
            format,
            new Blob([Uint8Array.from(bytes)], { type: mime }),
          ]),
        ),
      ),
    ])
    const items = await clipboard.read()
    if (items.length !== 1) {
      throw new Error(`ClipboardItem self-check expected one item, received ${items.length}.`)
    }
    const [item] = items
    if (item.types.length !== expected.length) {
      throw new Error(
        `ClipboardItem self-check expected ${expected.length} MIME types, received ${item.types.length}.`,
      )
    }
    for (const wanted of expected) {
      if (!item.types.includes(wanted.format)) {
        throw new Error(
          `ClipboardItem self-check lost the ${wanted.format} MIME type; available: ${item.types.join(", ")}.`,
        )
      }
      const payload = await item.getType(wanted.format)
      if (!(payload instanceof Blob)) {
        throw new Error(`ClipboardItem self-check type ${wanted.format} did not return a Blob.`)
      }
      const actualBytes = Buffer.from(await payload.arrayBuffer())
      if (payload.type !== wanted.mime || !actualBytes.equals(wanted.bytes)) {
        throw new Error(
          `ClipboardItem self-check changed ${wanted.format}: expected ${wanted.mime}/${wanted.bytes.toString("hex")}, received ${payload.type}/${actualBytes.toString("hex")}.`,
        )
      }
    }
  })
}

async function installImageChooser(
  application: ElectronApplication,
  selections: readonly (readonly string[])[],
): Promise<void> {
  await application.evaluate(({ dialog }, queuedSelections) => {
    const state = dialog as typeof dialog & {
      __gardenImageDialog?: typeof dialog.showOpenDialog
      __gardenImageSelections?: string[][]
    }
    state.__gardenImageDialog ??= dialog.showOpenDialog
    state.__gardenImageSelections = queuedSelections.map((selection) => [...selection])
    dialog.showOpenDialog = (async () => {
      const filePaths = state.__gardenImageSelections?.shift() ?? []
      return { canceled: filePaths.length === 0, filePaths }
    }) as typeof dialog.showOpenDialog
  }, selections)
}

async function restoreImageChooser(application: ElectronApplication | undefined): Promise<boolean> {
  if (!application) return false
  return application.evaluate(({ dialog }) => {
    const state = dialog as typeof dialog & {
      __gardenImageDialog?: typeof dialog.showOpenDialog
      __gardenImageSelections?: string[][]
    }
    const original = state.__gardenImageDialog
    if (!original) return false
    dialog.showOpenDialog = original
    const restored = dialog.showOpenDialog === original
    delete state.__gardenImageDialog
    delete state.__gardenImageSelections
    return restored
  })
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

async function gitOutput(root: string, args: readonly string[]): Promise<string> {
  const result = await git(root, args)
  expect(result.exitCode).toBe(0)
  return result.stdout.trim()
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

const quartzAppearanceConfiguration = `configuration:
  pageTitle: Appearance Garden
  keepMe: unchanged
  theme:
    fontOrigin: local
    typography:
      header: Existing Header
      body: Existing Body
      code: Existing Code
    colors:
      lightMode:
        light: "#101010"
        lightgray: "#202020"
        gray: "#303030"
        darkgray: "#d0d0d0"
        dark: "#f0f0f0"
        secondary: "#22d3ee"
        tertiary: "#94a3b8"
        highlight: "rgba(0, 0, 0, 0.1)"
        textHighlight: "rgba(0, 0, 0, 0.2)"
      darkMode:
        light: "#101010"
        lightgray: "#202020"
        gray: "#303030"
        darkgray: "#d0d0d0"
        dark: "#f0f0f0"
        secondary: "#22d3ee"
        tertiary: "#94a3b8"
        highlight: "rgba(34, 211, 238, 0.1)"
        textHighlight: "rgba(148, 163, 184, 0.2)"
plugins:
  - source: fixture-plugin
    enabled: true
`

const quartzPreviewCli = `import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { dirname, join } from "node:path"

const value = (name) => process.argv[process.argv.indexOf(name) + 1]
const port = Number(value("--port"))
const wsPort = Number(value("--wsPort"))
const host = process.env.QUARTZ_PREVIEW_LOOPBACK ?? "127.0.0.1"
const target = join(process.cwd(), "quartz", "styles", "publisher-appearance.scss")
const marker = join(process.cwd(), ".garden-publisher", "appearance-e2e-rebuild.json")
let recorded = false
const recordRebuild = () => {
  if (recorded || !existsSync(target)) return
  recorded = true
  process.stdout.write("Detected change, rebuilding\\n")
  process.stdout.write("Done rebuilding\\n")
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ target }) + "\\n")
}
const watcher = watch(join(process.cwd(), "quartz", "styles"), () => queueMicrotask(recordRebuild))
const http = createHttpServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  response.end("<!doctype html><html><head></head><body><main>Quartz preview</main></body></html>")
})
const websocket = createTcpServer(() => undefined)
await Promise.all([
  new Promise((resolvePromise, reject) => {
    http.once("error", reject)
    http.listen(port, host, resolvePromise)
  }),
  new Promise((resolvePromise, reject) => {
    websocket.once("error", reject)
    websocket.listen(wsPort, host, resolvePromise)
  }),
])
const shutdown = () => {
  watcher.close()
  http.close()
  websocket.close()
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
`

async function extendQuartzAppearanceFixture(root: string): Promise<void> {
  const packagePath = join(root, "package.json")
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    name: string
    scripts: Record<string, string>
  }
  await Promise.all([
    writeFile(
      packagePath,
      JSON.stringify(
        {
          ...manifest,
          name: "@jackyzha0/quartz",
          scripts: { ...manifest.scripts, quartz: "./quartz/bootstrap-cli.mjs" },
        },
        null,
        2,
      ) + "\n",
    ),
    writeGardenFile(root, "quartz.config.yaml", quartzAppearanceConfiguration),
    writeGardenFile(
      root,
      "quartz/styles/custom.scss",
      '@use "./variables.scss" as *;\n\n.fixture { color: #abcdef; }\n',
    ),
    writeGardenFile(root, "quartz/bootstrap-cli.mjs", quartzPreviewCli),
    writeGardenFile(root, "quartz/static/.gitkeep", ""),
  ])
  await gitOutput(root, [
    "add",
    "package.json",
    "quartz.config.yaml",
    "quartz/bootstrap-cli.mjs",
    "quartz/styles/custom.scss",
    "quartz/static/.gitkeep",
  ])
  await gitOutput(root, ["commit", "-m", "Add Quartz appearance fixture"])
  await gitOutput(root, ["push", "origin", "main"])
}

test("locates selected editor text in the current preview", async () => {
  const garden = await createQuartzGardenFixture({
    directoryName: "Preview Navigation Garden",
    noteTitle: "Preview Navigation",
    noteBody: "A uniquely located preview sentence.",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-preview-navigation-")
  const notePath = join(garden.root, ...garden.notePath.split("/"))
  const noteBefore = await readFile(notePath)
  let application: ElectronApplication | undefined
  try {
    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: await createE2eRuntime(stateRoot),
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
    })
    const page = await application.firstWindow()
    await expect(page.getByTitle("Preview Navigation的 Quartz 精确预览")).toBeVisible()
    await expect
      .poll(
        () =>
          application!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.map(
              (frame) => frame.url,
            ),
          ),
        { timeout: 30_000 },
      )
      .toContainEqual(expect.stringContaining("/life/fixture"))
    await application.evaluate(async ({ BrowserWindow }) => {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find(
        (candidate) => candidate.url.includes("/life/fixture"),
      )
      if (!frame) throw new Error("Exact preview frame was not available")
      await frame.executeJavaScript(
        'document.body.innerHTML = "<main><h1>Preview Navigation</h1><p>A uniquely located preview sentence.</p></main>"',
      )
    })
    const editor = page.locator(".cm-content")
    await expect(editor).toHaveAttribute("contenteditable", "true")
    await editor.click()
    await page.keyboard.press("Control+A")
    await page.getByRole("button", { name: "定位预览" }).click()

    await expect(page.getByRole("status", { name: "预览定位状态" })).toHaveText("已定位到预览")
    await expect(
      page
        .frameLocator('iframe[title="Preview Navigation的 Quartz 精确预览"]')
        .locator(".publisher-preview-locate-highlight"),
    ).toBeVisible()
    expect(await readFile(notePath)).toEqual(noteBefore)
  } finally {
    await closeApplication(application)
    await garden.cleanup()
    await removeTemporaryDirectory(stateRoot)
  }
})

test("appearance designer previews, applies, persists, and undoes without publishing", async () => {
  const garden = await createQuartzGardenFixture({
    directoryName: "Appearance Garden",
    noteTitle: "Appearance Note",
    noteBody: "appearance workflow fixture",
  })
  await extendQuartzAppearanceFixture(garden.root)
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-appearance-")
  const registry = join(stateRoot, "blogs.json")
  const runtimeRoot = await createE2eRuntime(stateRoot)
  const environment = {
    ...process.env,
    GARDEN_PUBLISHER_E2E: "1",
    GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
    GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
    GARDEN_PUBLISHER_E2E_REGISTRY: registry,
    GARDEN_PUBLISHER_E2E_REAL_PREVIEW: "1",
  }
  const configPath = join(garden.root, "quartz.config.yaml")
  const customPath = join(garden.root, "quartz", "styles", "custom.scss")
  const manifestPath = join(garden.root, "quartz", "styles", "publisher-appearance.json")
  const stylesheetPath = join(garden.root, "quartz", "styles", "publisher-appearance.scss")
  const configBefore = await readFile(configPath)
  const customBefore = await readFile(customPath)
  const remoteBefore = await gitOutput(garden.root, ["rev-parse", "origin/main"])
  const rebuildMarker = join(garden.root, ".garden-publisher", "appearance-e2e-rebuild.json")
  const fixtureBase = dirname(garden.root)
  const tempRoot = resolve(process.env.TEMP ?? process.env.TMP ?? fixtureBase)
  const previewWorkspacesBefore = await previewWorkspaceDirectories(tempRoot)
  const preferredPortHolder = await holdLoopbackPortIfAvailable(8080)
  const previewPorts = new Set<number>()
  let application: ElectronApplication | undefined

  const realPreviewTransitions = async (): Promise<
    readonly {
      readonly state: string
      readonly generation: number
      readonly port?: number
      readonly url?: string
    }[]
  > =>
    application!.evaluate(async ({ BrowserWindow }) => {
      void BrowserWindow
      const transitions = (
        globalThis as typeof globalThis & {
          __GARDEN_PUBLISHER_E2E_REAL_PREVIEW_STATES__?: readonly {
            readonly state: string
            readonly generation: number
            readonly port?: number
            readonly url?: string
          }[]
        }
      ).__GARDEN_PUBLISHER_E2E_REAL_PREVIEW_STATES__
      return transitions ? [...transitions] : []
    })

  const expectPreviewReleased = async (): Promise<void> => {
    for (const port of previewPorts) {
      await expect.poll(() => loopbackPortAvailable(port), { timeout: 15_000 }).toBe(true)
    }
    const current = await previewWorkspaceDirectories(tempRoot)
    for (const name of current.filter((entry) => !previewWorkspacesBefore.includes(entry))) {
      if (basename(name) !== name || !name.startsWith("knowledge-garden-preview-")) {
        throw new Error(`Refusing to clean an unexpected preview workspace: ${name}`)
      }
      await removeTemporaryDirectoryEventually(join(tempRoot, name))
    }
    await expect
      .poll(() => previewWorkspaceDirectories(tempRoot), { timeout: 15_000 })
      .toEqual(previewWorkspacesBefore)
  }

  const expectPreviewPort = async (
    page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
  ): Promise<number> => {
    const source = await page.getByTitle("Appearance Note的 Quartz 精确预览").getAttribute("src")
    if (!source) throw new Error("The exact Quartz preview iframe did not expose its URL.")
    const iframePort = Number(new URL(source).port)
    expect(iframePort).not.toBe(8080)
    await expect
      .poll(async () => {
        const ready = [...(await realPreviewTransitions())]
          .reverse()
          .find((transition) => transition.state === "ready" && transition.port === iframePort)
        return ready?.port
      })
      .toBe(iframePort)
    previewPorts.add(iframePort)
    return iframePort
  }

  const editDraft = async (
    page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
  ): Promise<void> => {
    const dialog = page.getByRole("dialog", { name: "外观设置" })
    await dialog.getByLabel("背景类型").selectOption("gradient")
    await dialog.getByLabel("强调色").fill("#123456")
    await dialog.getByLabel("正文宽度").fill("76")
    await expect(dialog.getByText("实时预览已更新", { exact: true })).toBeVisible()
    const appearanceDocument = page.getByTitle("博客外观实时预览").contentFrame()
    const previewStyle = appearanceDocument.locator("style[data-publisher-appearance-preview]")
    await expect.poll(() => previewStyle.textContent()).toContain("--publisher-accent: #123456")
    await expect.poll(() => previewStyle.textContent()).toContain("--publisher-article-width: 76ch")
    await expect.poll(() => previewStyle.textContent()).toContain("linear-gradient(135deg")
    await expect(
      page
        .getByTitle("Appearance Note的 Quartz 精确预览")
        .contentFrame()
        .locator("style[data-publisher-appearance-preview]"),
    ).toHaveCount(0)
  }

  try {
    application = await launchApplication(stateRoot, environment)
    let page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await expect(page.getByTitle("Appearance Note的 Quartz 精确预览")).toBeVisible()
    await expect(page.getByTitle("Appearance Note的 Quartz 精确预览")).toHaveAttribute(
      "src",
      /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\//,
    )
    const firstPreviewPort = await expectPreviewPort(page)
    await expect
      .poll(
        () =>
          application!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.map(
              (frame) => frame.url,
            ),
          ),
        { timeout: 30_000 },
      )
      .toContainEqual(expect.stringContaining("/life/fixture"))

    await page.getByRole("button", { name: "外观" }).click()
    await expect(page.getByTitle("博客外观实时预览")).toBeVisible()
    const appearanceSource = await page.getByTitle("博客外观实时预览").getAttribute("src")
    if (!appearanceSource) throw new Error("The appearance preview iframe did not expose its URL.")
    expect(Number(new URL(appearanceSource).port)).toBe(firstPreviewPort)
    await editDraft(page)
    await page
      .getByRole("dialog", { name: "外观设置" })
      .getByRole("button", { name: "取消" })
      .click()
    await expect(page.getByRole("dialog", { name: "外观设置" })).toHaveCount(0)
    expect(await readFile(configPath)).toEqual(configBefore)
    expect(await readFile(customPath)).toEqual(customBefore)
    expect(await exists(manifestPath)).toBe(false)
    expect(await exists(stylesheetPath)).toBe(false)
    await expect(
      page
        .getByTitle("博客外观实时预览")
        .contentFrame()
        .locator("style[data-publisher-appearance-preview]"),
    ).toHaveCount(0)

    await page.getByRole("button", { name: "外观" }).click()
    await editDraft(page)
    const appearance = page.getByRole("dialog", { name: "外观设置" })
    const transitionsBeforeApply = await realPreviewTransitions()
    const rebuildStateStart = transitionsBeforeApply.length
    const generationBeforeApply = transitionsBeforeApply.at(-1)?.generation
    expect(generationBeforeApply).toBeDefined()
    await appearance.getByRole("button", { name: "一键应用" }).click()
    await expect(appearance.getByText(/外观已应用/)).toBeVisible()
    await appearance.getByRole("button", { name: "取消" }).click()
    await expect(appearance).toHaveCount(0)
    await expect(page.getByRole("status", { name: "发布状态" })).toContainText("预览就绪")
    await expect.poll(async () => exists(manifestPath)).toBe(true)
    await expect.poll(async () => exists(stylesheetPath)).toBe(true)
    expect(await readFile(stylesheetPath, "utf8")).toContain("--publisher-accent: #123456")
    expect(await readFile(stylesheetPath, "utf8")).toContain("--publisher-article-width: 76ch")
    expect(await readFile(customPath, "utf8")).toContain("publisher-appearance:start")
    const appliedConfiguration = parse(await readFile(configPath, "utf8")) as {
      configuration: {
        keepMe: string
        theme: {
          typography: { header: string; body: string; code: string }
          colors: {
            lightMode: { secondary: string; tertiary: string }
            darkMode: { secondary: string; tertiary: string }
          }
        }
      }
    }
    expect(appliedConfiguration.configuration.keepMe).toBe("unchanged")
    expect(appliedConfiguration.configuration.theme.typography).toEqual({
      header: "Existing Header",
      body: "Existing Body",
      code: "Existing Code",
    })
    expect(appliedConfiguration.configuration.theme.colors.lightMode.secondary).toBe("#123456")
    expect(appliedConfiguration.configuration.theme.colors.darkMode.secondary).toBe("#123456")
    expect(appliedConfiguration.configuration.theme.colors.lightMode.tertiary).toBe("#94a3b8")
    expect(appliedConfiguration.configuration.theme.colors.darkMode.tertiary).toBe("#94a3b8")
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      settings: {
        background: { kind: "gradient" },
        colors: { accent: "#123456" },
        layout: { articleWidthCh: 76 },
      },
    })
    await expect.poll(async () => exists(rebuildMarker)).toBe(true)
    await expect
      .poll(async () =>
        (await realPreviewTransitions())
          .slice(rebuildStateStart)
          .map(({ state }) => state)
          .join(" -> "),
      )
      .toMatch(/building(?: -> [a-z]+)* -> ready/)
    await expect
      .poll(async () => (await realPreviewTransitions()).at(-1)?.generation ?? -1)
      .toBeGreaterThan(generationBeforeApply!)
    expect(await gitOutput(garden.root, ["rev-parse", "origin/main"])).toBe(remoteBefore)

    await closeApplication(application)
    application = undefined
    await expectPreviewReleased()
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await expect(page.getByTitle("Appearance Note的 Quartz 精确预览")).toBeVisible()
    await expectPreviewPort(page)
    await expect(page.locator(".publish-summary")).not.toContainText("正在检查可发布变化")
    await page.getByRole("button", { name: "外观" }).click()
    const persisted = page.getByRole("dialog", { name: "外观设置" })
    await expect(persisted.getByLabel("背景类型")).toHaveValue("gradient")
    await expect(persisted.getByLabel("强调色")).toHaveValue("#123456")
    await expect(persisted.getByLabel("正文宽度")).toHaveValue("76")
    await expect(persisted.getByRole("button", { name: "撤销上次应用" })).toBeEnabled()
    await persisted.getByRole("button", { name: "取消" }).click()

    await page.getByRole("button", { name: "外观" }).click()
    const undo = page.getByRole("dialog", { name: "外观设置" })
    await undo.getByRole("button", { name: "撤销上次应用" }).click()
    await expect(undo.getByText(/已撤销上次应用/)).toBeVisible()
    await expect.poll(async () => exists(manifestPath)).toBe(false)
    await expect.poll(async () => exists(stylesheetPath)).toBe(false)
    expect(await readFile(configPath)).toEqual(configBefore)
    expect(await readFile(customPath)).toEqual(customBefore)
    expect(await gitOutput(garden.root, ["status", "--porcelain"])).toBe("")
    expect(await gitOutput(garden.root, ["rev-parse", "origin/main"])).toBe(remoteBefore)
    await undo.getByRole("button", { name: "取消" }).click()
    await expect(undo).toHaveCount(0)
    await expect(page.getByRole("status", { name: "发布状态" })).toContainText("预览就绪")
  } finally {
    const cleanupErrors: unknown[] = []
    for (const cleanup of [
      () => closeApplication(application),
      expectPreviewReleased,
      () => garden.cleanup(),
      () => removeTemporaryDirectoryEventually(stateRoot),
      () => closeServer(preferredPortHolder),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    for (const path of [fixtureBase, stateRoot]) {
      try {
        expect(await exists(path), `E2E cleanup left ${path}`).toBe(false)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      expect(launchedChildren.size, "E2E cleanup left an owned Electron process").toBe(0)
      if (preferredPortHolder) {
        await expect.poll(() => loopbackPortAvailable(8080), { timeout: 15_000 }).toBe(true)
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Appearance E2E cleanup did not complete safely.")
    }
  }
})

test("manages a note image library", async () => {
  const guide = await readFile(join(publisherRoot, "README.md"), "utf8")
  for (const expected of [
    "图片库",
    "25 MiB",
    "50",
    "不会自动修改 Markdown",
    "永久删除",
    "content/_assets/<note-slug>/",
    "private/_assets/<note-slug>/",
  ]) {
    expect(guide).toContain(expected)
  }
  const garden = await createQuartzGardenFixture({
    directoryName: "Image Garden",
    noteTitle: "Image Note",
    noteBody: "the markdown must remain byte-for-byte unchanged",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-images-")
  const sources = join(stateRoot, "sources")
  const replacementSources = join(stateRoot, "replacement-sources")
  const alpha = join(sources, "alpha.png")
  const beta = join(sources, "beta.png")
  const removed = join(sources, "removed.png")
  const replacementAlpha = join(replacementSources, "alpha.png")
  const originalAlpha = onePixelPng(255, 0, 0)
  const overwrittenAlpha = onePixelPng(0, 255, 0)
  const betaBytes = onePixelPng(0, 0, 255)
  const removedBytes = onePixelPng(255, 255, 0)
  const notePath = join(garden.root, ...garden.notePath.split("/"))
  const libraryPath = join(garden.root, "content", "_assets", "fixture")
  let application: ElectronApplication | undefined
  let chooserInstallationAttempted = false
  let primaryFailure: unknown
  try {
    await Promise.all([
      mkdir(sources, { recursive: true }),
      mkdir(replacementSources, { recursive: true }),
    ])
    await Promise.all([
      writeFile(alpha, originalAlpha),
      writeFile(beta, betaBytes),
      writeFile(removed, removedBytes),
      writeFile(replacementAlpha, overwrittenAlpha),
    ])
    const noteBefore = await readFile(notePath)
    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: await createE2eRuntime(stateRoot),
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
    })
    chooserInstallationAttempted = true
    await installImageChooser(application, [[alpha, beta, removed], [replacementAlpha]])
    const page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
    await page.getByRole("button", { name: "Image Note，公开" }).click()

    await page.getByRole("button", { name: "图片库" }).click()
    const library = page.getByRole("dialog", { name: "Image Note 图片库" })
    await expect(library).toBeVisible()
    await expect(library.getByText("暂无图片")).toBeVisible()
    await expect.poll(async () => exists(join(libraryPath, ".gitkeep"))).toBe(true)

    await library.getByRole("button", { name: "添加图片" }).click()
    const candidates = page.getByRole("dialog", { name: "确认添加图片" })
    await expect(candidates.getByText("alpha.png")).toBeVisible()
    await expect(candidates.getByText("beta.png")).toBeVisible()
    await expect(candidates.getByText("removed.png")).toBeVisible()
    for (const name of ["alpha.png", "beta.png", "removed.png"]) {
      await expectDecodedImage(candidates.locator("li", { hasText: name }).locator("img"))
    }
    await candidates.getByRole("button", { name: "移除 removed.png" }).click()
    await expect(candidates.getByText("removed.png")).toHaveCount(0)
    await candidates.getByRole("button", { name: "确认添加 2 张图片" }).click()
    for (const name of ["alpha.png", "beta.png"]) {
      const thumbnail = page.getByRole("button", { name: `预览 ${name}` })
      await expect(thumbnail).toBeVisible()
      await expectDecodedImage(thumbnail.locator("img"))
    }
    expect(await exists(join(libraryPath, ".gitkeep"))).toBe(false)
    expect(await readFile(join(libraryPath, "alpha.png"))).toEqual(originalAlpha)
    expect(await readFile(join(libraryPath, "beta.png"))).toEqual(betaBytes)
    expect(await exists(join(libraryPath, "removed.png"))).toBe(false)
    expect(await exists(removed)).toBe(true)
    expect(await readFile(removed)).toEqual(removedBytes)

    await page.getByRole("button", { name: "添加图片" }).click()
    await page.getByRole("button", { name: "继续" }).click()
    const overwrite = page.getByRole("dialog", { name: "确认覆盖同名图片" })
    await expect(overwrite.getByText("alpha.png")).toBeVisible()
    await overwrite.getByRole("button", { name: "覆盖并继续" }).click()
    await expect(page.getByRole("button", { name: "预览 alpha.png" })).toBeVisible()
    expect(await readFile(join(libraryPath, "alpha.png"))).toEqual(overwrittenAlpha)

    await page.getByRole("button", { name: "预览 alpha.png" }).click()
    const preview = page.getByRole("dialog", { name: "alpha.png" })
    await expect(preview.getByRole("img", { name: "alpha.png" })).toBeVisible()
    await expect(preview.getByText("1 × 1 像素")).toBeVisible()
    await expect(preview.getByText(`${overwrittenAlpha.length} B`)).toBeVisible()
    expect(await readFile(notePath)).toEqual(noteBefore)

    await preview.getByRole("button", { name: "删除图片" }).click()
    await page.getByRole("button", { name: "永久删除 alpha.png" }).click()
    await expect(page.getByRole("button", { name: "预览 alpha.png" })).toHaveCount(0)
    await page.getByRole("button", { name: "预览 beta.png" }).click()
    await page.getByRole("button", { name: "删除图片" }).click()
    await page.getByRole("button", { name: "永久删除 beta.png" }).click()
    await expect(page.getByText("暂无图片")).toBeVisible()
    expect(await exists(join(libraryPath, "alpha.png"))).toBe(false)
    expect(await exists(join(libraryPath, "beta.png"))).toBe(false)
    expect(await exists(join(libraryPath, ".gitkeep"))).toBe(true)
    expect(await readFile(notePath)).toEqual(noteBefore)
    expect(await readdir(join(garden.root, ".garden-publisher", "image-import"))).toEqual([])
  } catch (failure) {
    primaryFailure = failure
  }

  const cleanupFailures: unknown[] = []
  if (chooserInstallationAttempted) {
    try {
      expect(await restoreImageChooser(application)).toBe(true)
    } catch (failure) {
      cleanupFailures.push(failure)
    }
  }
  try {
    await closeApplication(application)
  } catch (failure) {
    cleanupFailures.push(failure)
  }
  try {
    await garden.cleanup()
  } catch (failure) {
    cleanupFailures.push(failure)
  }
  try {
    await removeTemporaryDirectory(stateRoot)
  } catch (failure) {
    cleanupFailures.push(failure)
  }

  if (primaryFailure !== undefined && cleanupFailures.length === 0) throw primaryFailure
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      primaryFailure === undefined
        ? "The image library E2E cleanup failed."
        : "The image library E2E flow failed; cleanup results are attached.",
    )
  }
})

test("copies image Markdown without changing the note", async () => {
  const garden = await createQuartzGardenFixture({
    directoryName: "Clipboard Image Garden",
    noteTitle: "Clipboard Image Note",
    noteBody: "the markdown must remain byte-for-byte unchanged",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-clipboard-")
  const notePath = join(garden.root, ...garden.notePath.split("/"))
  const libraryPath = join(garden.root, "content", "_assets", "fixture")
  const imagePath = join(libraryPath, "alpha.png")
  let application: ElectronApplication | undefined
  let clipboardSnapshotInstalled = false
  let clipboardSafeToMutate = false
  let clipboardSkipReason: string | undefined
  let primaryFailure: unknown
  try {
    await mkdir(libraryPath, { recursive: true })
    await writeFile(imagePath, onePixelPng(255, 0, 0))
    const noteBefore = await readFile(notePath)
    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: await createE2eRuntime(stateRoot),
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
    })
    const clipboardSnapshot = await snapshotClipboard(application)
    clipboardSnapshotInstalled = true
    clipboardSafeToMutate = clipboardSnapshot.safeToMutate
    if (!clipboardSnapshot.safeToMutate) {
      clipboardSkipReason =
        "The legacy clipboard contains a format that cannot be restored atomically; leaving it untouched."
    } else {
      await verifyClipboardItemRoundTrip(application)
      const page = await application.firstWindow()
      await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()
      await page.getByRole("button", { name: "Clipboard Image Note，公开" }).click()
      await page.getByRole("button", { name: "图片库" }).click()
      await page.getByRole("button", { name: "预览 alpha.png" }).click()
      const preview = page.getByRole("dialog", { name: "alpha.png" })
      await preview.getByRole("button", { name: "复制 Markdown 链接" }).click()
      await expect(preview.getByRole("status")).toHaveText("已复制 Markdown 链接")
      expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        "![alpha](<../_assets/fixture/alpha.png>)",
      )
      expect(await readFile(notePath)).toEqual(noteBefore)
    }
  } catch (failure) {
    primaryFailure = failure
  }

  const cleanupFailures: unknown[] = []
  if (clipboardSnapshotInstalled) {
    try {
      expect(await restoreClipboard(application)).toBe(
        clipboardSafeToMutate ? "restored" : "unmodified",
      )
    } catch (failure) {
      cleanupFailures.push(failure)
    }
  }
  try {
    await closeApplication(application)
  } catch (failure) {
    cleanupFailures.push(failure)
  }
  try {
    await garden.cleanup()
  } catch (failure) {
    cleanupFailures.push(failure)
  }
  try {
    await removeTemporaryDirectory(stateRoot)
  } catch (failure) {
    cleanupFailures.push(failure)
  }

  if (primaryFailure !== undefined && cleanupFailures.length === 0) throw primaryFailure
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      primaryFailure === undefined
        ? "The clipboard E2E cleanup failed."
        : "The clipboard E2E flow failed; cleanup results are attached.",
    )
  }
  if (clipboardSkipReason) test.skip(true, clipboardSkipReason)
})

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
    await expect(page.getByRole("status", { name: "发布状态" })).toContainText(
      "代码已推送，正在等待 GitHub Pages 部署…",
    )

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

test("repairs legacy master and publishes the exact selection", async () => {
  const garden = await createQuartzGardenFixture({
    directoryName: "Legacy Branch Garden",
    noteTitle: "Existing",
    noteBody: "tracked baseline",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-e2e-branch-repair-")
  let application: ElectronApplication | undefined
  let primaryFailure: unknown
  const privatePath = join(garden.root, "private", "life", "draft.md")
  const unrelatedPublicPath = join(garden.root, "content", "life", "unrelated.md")
  const privateBefore = note("Private draft", "must stay local and unchanged")
  try {
    await git(garden.root, ["branch", "-m", "master"])
    await git(garden.root, ["branch", "--set-upstream-to=origin/main", "master"])
    await Promise.all([
      writeGardenFile(
        garden.root,
        "content/life/selected.md",
        note(
          "Selected publication",
          "![diagram](../_assets/selected/diagram.png)\n\nselected body",
        ),
      ),
      writeGardenFile(garden.root, "content/life/unrelated.md", note("Unrelated", "leave local")),
      writeGardenFile(garden.root, "private/life/draft.md", privateBefore),
      writeGardenFile(garden.root, "content/_assets/selected/diagram.png", "fixture image bytes"),
    ])

    const runtimeRoot = await createE2eRuntime(stateRoot)
    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: runtimeRoot,
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
      GARDEN_PUBLISHER_E2E_DEPLOYMENT: "success",
    })
    const page = await application.firstWindow()
    await expect(page.locator('main[data-workspace-diagnostics="ready"]')).toBeVisible()

    await page.getByRole("button", { name: "检查并发布" }).click()
    const review = page.getByRole("dialog", { name: "检查并发布" })
    const selected = review.getByRole("checkbox", { name: /selected/i })
    const unrelated = review.getByRole("checkbox", { name: /unrelated/i })
    await expect(selected).toBeChecked()
    await expect(unrelated).toBeChecked()
    await unrelated.uncheck()
    await review.getByRole("button", { name: "验证并发布" }).click()

    await expect(review.getByRole("alert")).toContainText("本地 master")
    await review.getByRole("button", { name: "安全切换到 main 并继续" }).click()
    await expect(review).toHaveCount(0)
    await expect(page.getByRole("status", { name: "发布状态" })).toContainText(
      "代码已推送，正在等待 GitHub Pages 部署…",
    )

    await expect.poll(() => gitOutput(garden.root, ["branch", "--show-current"])).toBe("main")
    await expect
      .poll(() =>
        gitOutput(garden.root, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]),
      )
      .toBe("origin/main")
    await expect
      .poll(() => gitOutput(garden.root, ["rev-parse", "origin/main"]))
      .toBe(await gitOutput(garden.root, ["rev-parse", "HEAD"]))
    expect(
      await gitOutput(garden.root, ["show", "origin/main:content/life/selected.md"]),
    ).toContain("selected body")
    expect(
      await gitOutput(garden.root, [
        "ls-tree",
        "-r",
        "--name-only",
        "origin/main",
        "content/_assets/selected",
      ]),
    ).toBe("content/_assets/selected/diagram.png")
    expect(await readFile(privatePath, "utf8")).toBe(privateBefore)
    expect(
      await gitOutput(garden.root, [
        "status",
        "--porcelain",
        "--ignored",
        "--",
        "private/life/draft.md",
      ]),
    ).toBe("!! private/life/")
    expect(
      await gitOutput(garden.root, [
        "ls-tree",
        "-r",
        "--name-only",
        "origin/main",
        "private/life/draft.md",
      ]),
    ).toBe("")
    expect(await exists(unrelatedPublicPath)).toBe(true)
    expect(
      await gitOutput(garden.root, ["status", "--porcelain", "--", "content/life/unrelated.md"]),
    ).toBe("?? content/life/unrelated.md")
  } catch (failure) {
    primaryFailure = failure
  }

  const cleanupFailures: unknown[] = []
  try {
    await closeApplication(application)
  } catch (failure) {
    cleanupFailures.push(failure)
  }
  try {
    if (!(await bounded(garden.cleanup(), 10_000))) {
      throw new Error("The temporary E2E garden could not be cleaned up within 10 seconds.")
    }
  } catch (failure) {
    cleanupFailures.push(failure)
  }
  try {
    await removeTemporaryDirectory(stateRoot)
  } catch (failure) {
    cleanupFailures.push(failure)
  }

  if (primaryFailure !== undefined && cleanupFailures.length === 0) throw primaryFailure
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      primaryFailure === undefined
        ? "The branch repair E2E cleanup failed."
        : "The branch repair E2E flow failed; cleanup results are attached.",
    )
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
  const website = `https://example.com/${"long-garden-address/".repeat(12)}`
  await writeFile(join(first.root, "quartz.config.yaml"), `configuration:\n  baseUrl: ${website}\n`)
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

    const summary = page.locator(".blog-switcher-summary")
    await expectBlogAddresses(summary, first.root, website)
    const trigger = page.getByRole("button", { name: "切换博客：Knowledge Garden" })
    await trigger.focus()
    await page.keyboard.press("Tab")
    await expect(
      summary.getByRole("button", { name: "打开 Knowledge Garden 的网站" }),
    ).toBeFocused()
    await trigger.focus()
    await page.keyboard.press("ArrowDown")
    const menu = page.getByRole("menu", { name: "选择博客" })
    await expectBlogAddresses(menu, first.root, website)
    await expect(menu.getByRole("menuitemradio")).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(menu.getByRole("menuitem", { name: "打开 Knowledge Garden 的网站" })).toBeFocused()
    await expect(page.locator("button button, button a, a button")).toHaveCount(0)
    await menu.getByRole("menuitem", { name: "管理博客" }).click()
    const manager = page.getByRole("dialog", { name: "管理博客" })
    await expectBlogAddresses(manager, first.root, website)
    await page.setViewportSize({ width: 900, height: 720 })
    await expectBlogAddresses(summary, first.root, website)
    await expectBlogAddresses(manager, first.root, website)
    await expect(page.locator("button button, button a, a button")).toHaveCount(0)
    await manager.getByRole("button", { name: "编辑 Knowledge Garden 的网站地址" }).click()
    await expect(manager.getByText(`当前自动读取：${website}`, { exact: true })).toBeVisible()
    await expect(manager.getByLabel("网站地址", { exact: true })).toBeVisible()
    expect(
      await manager.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1)
    await manager.getByRole("button", { name: "取消编辑网站地址" }).click()
    await page.getByRole("button", { name: "关闭博客管理" }).click()

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
    await expectBlogAddresses(page.locator(".blog-switcher-summary"), second.root)
    await switcher.click()
    const narrowMenu = page.getByRole("menu", { name: "选择博客" })
    await expect(narrowMenu).toBeVisible()
    await expectBlogAddresses(narrowMenu, second.root)
    const manage = narrowMenu.getByRole("menuitem", { name: "管理博客" })
    await expect(manage).toBeVisible()
    await expect(manage).toBeEnabled()
    await manage.click()
    await expect(narrowMenu).toHaveCount(0)
    const narrowManager = page.getByRole("dialog", { name: "管理博客" })
    await expect(narrowManager).toBeVisible()
    await expectBlogAddresses(narrowManager, second.root)
    await expect(page.locator("button button, button a, a button")).toHaveCount(0)
    await narrowManager.getByRole("button", { name: "编辑 Second Garden 的网站地址" }).click()
    await expect(
      narrowManager.getByText(
        "尚未配置网站地址。可以输入网站地址，或在 Quartz 配置中设置 baseUrl。",
      ),
    ).toBeVisible()
    expect(
      await narrowManager.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1)
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
  const domainIndexPath = join(first.root, "content", "artificial-intelligence", "index.md")
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
    const publicNoteBeforeMetadata = await readFile(
      join(first.root, ...publicPath.split("/")),
      "utf8",
    )
    const privateNoteBeforeMetadata = await readFile(
      join(first.root, ...privatePath.split("/")),
      "utf8",
    )
    const privatePathsBeforeMetadata = await readdir(
      join(first.root, "private", "artificial-intelligence"),
    )

    await page.getByRole("button", { name: "管理领域" }).click()
    let manager = page.getByRole("dialog", { name: "管理领域" })
    const nonEmptyDomain = manager.getByRole("article", { name: "人工智能" })
    await expect(nonEmptyDomain).toContainText("公开 1")
    await expect(nonEmptyDomain).toContainText("私密 1")
    await expect(
      nonEmptyDomain.getByRole("button", { name: "删除（公开 1，私密 1）" }),
    ).toBeEnabled()
    await nonEmptyDomain.getByRole("button", { name: "编辑 人工智能 的信息" }).click()
    const metadataEditor = page.getByRole("dialog", { name: "编辑领域信息" })
    await metadataEditor.getByLabel("描述（选填）").fill("人工智能领域说明")
    await metadataEditor.getByLabel("标签（选填）").fill("AI，研究, AI")
    await metadataEditor.getByRole("button", { name: "保存信息" }).click()
    manager = page.getByRole("dialog", { name: "管理领域" })
    await expect(manager.getByRole("article", { name: "人工智能" })).toContainText(
      "人工智能领域说明",
    )
    const populatedTags = manager.getByRole("article", { name: "人工智能" }).getByLabel("领域标签")
    await expect(populatedTags.getByText("AI", { exact: true })).toBeVisible()
    await expect(populatedTags.getByText("研究", { exact: true })).toBeVisible()
    await manager.getByRole("button", { name: "关闭" }).click()

    const populatedDomainMetadata = matter(await readFile(domainIndexPath, "utf8")).data
    expect(populatedDomainMetadata.description).toBe("人工智能领域说明")
    expect(populatedDomainMetadata.tags).toEqual(["AI", "研究"])
    expect(await readFile(join(first.root, ...publicPath.split("/")), "utf8")).toBe(
      publicNoteBeforeMetadata,
    )
    expect(await readFile(join(first.root, ...privatePath.split("/")), "utf8")).toBe(
      privateNoteBeforeMetadata,
    )
    expect(await readdir(join(first.root, "private", "artificial-intelligence"))).toEqual(
      privatePathsBeforeMetadata,
    )

    await closeApplication(application)
    application = undefined
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await expect(page.getByRole("button", { name: "人工智能" })).toBeVisible()
    await expect(page.getByRole("button", { name: "公开 AI 笔记，公开" })).toBeVisible()
    await expect(page.getByRole("button", { name: "私密 AI 笔记，私密" })).toBeVisible()
    await page.getByRole("button", { name: "管理领域" }).click()
    manager = page.getByRole("dialog", { name: "管理领域" })
    const persistedDomain = manager.getByRole("article", { name: "人工智能" })
    await expect(persistedDomain).toContainText("人工智能领域说明")
    await expect(
      persistedDomain.getByLabel("领域标签").getByText("AI", { exact: true }),
    ).toBeVisible()
    await expect(
      persistedDomain.getByLabel("领域标签").getByText("研究", { exact: true }),
    ).toBeVisible()
    await persistedDomain.getByRole("button", { name: "编辑 人工智能 的信息" }).click()
    const persistedMetadataEditor = page.getByRole("dialog", { name: "编辑领域信息" })
    await expect(persistedMetadataEditor.getByLabel("描述（选填）")).toHaveValue("人工智能领域说明")
    await expect(persistedMetadataEditor.getByLabel("标签（选填）")).toHaveValue("AI, 研究")
    await persistedMetadataEditor.getByLabel("描述（选填）").fill("")
    await persistedMetadataEditor.getByLabel("标签（选填）").fill("")
    await persistedMetadataEditor.getByRole("button", { name: "保存信息" }).click()
    manager = page.getByRole("dialog", { name: "管理领域" })
    await expect(manager.getByRole("article", { name: "人工智能" })).toContainText("未填写描述")
    await expect(manager.getByRole("article", { name: "人工智能" })).toContainText("无标签")
    await manager.getByRole("button", { name: "关闭" }).click()

    const clearedDomainMetadata = matter(await readFile(domainIndexPath, "utf8")).data
    expect(clearedDomainMetadata).not.toHaveProperty("description")
    expect(clearedDomainMetadata).not.toHaveProperty("tags")
    expect(await readFile(join(first.root, ...publicPath.split("/")), "utf8")).toBe(
      publicNoteBeforeMetadata,
    )
    expect(await readFile(join(first.root, ...privatePath.split("/")), "utf8")).toBe(
      privateNoteBeforeMetadata,
    )
    expect(await readdir(join(first.root, "private", "artificial-intelligence"))).toEqual(
      privatePathsBeforeMetadata,
    )

    await closeApplication(application)
    application = undefined
    application = await launchApplication(stateRoot, environment)
    page = await application.firstWindow()
    await page.getByRole("button", { name: "管理领域" }).click()
    manager = page.getByRole("dialog", { name: "管理领域" })
    const clearedPersistedDomain = manager.getByRole("article", { name: "人工智能" })
    await expect(clearedPersistedDomain).toContainText("未填写描述")
    await expect(clearedPersistedDomain).toContainText("无标签")
    await manager.getByRole("button", { name: "关闭" }).click()

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
      .getByRole("button", { name: "删除", exact: true })
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
