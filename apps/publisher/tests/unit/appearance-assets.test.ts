import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  APPEARANCE_ASSET_MAX_FILE_BYTES,
  APPEARANCE_ASSET_MAX_RETAINED_BYTES,
  APPEARANCE_ASSET_TTL_MS,
  createAppearanceAssetPicker,
  createAppearanceDecodeSemaphore,
  createAppearanceAssetService,
  type AppearanceAssetPicker,
} from "../../src/main/services/appearance/appearanceAssets"
import { IMAGE_FILE_EXTENSIONS } from "../../src/main/services/imageFormats"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const ascii = (value: string) => Uint8Array.from(Buffer.from(value, "ascii"))
const uint32 = (value: number) =>
  Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])

function png(width = 2, height = 2, totalBytes?: number): Uint8Array {
  const minimum = 58
  const length = totalBytes ?? minimum
  if (length < minimum) throw new Error("PNG fixture is too small")
  const bytes = new Uint8Array(length)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set(uint32(13), 8)
  bytes.set(ascii("IHDR"), 12)
  bytes.set(uint32(width), 16)
  bytes.set(uint32(height), 20)
  bytes.set([8, 2, 0, 0, 0], 24)
  const payloadBytes = length - 57
  const idat = 33
  bytes.set(uint32(payloadBytes), idat)
  bytes.set(ascii("IDAT"), idat + 4)
  bytes[idat + 8] = 1
  const iend = idat + 12 + payloadBytes
  bytes.set(uint32(0), iend)
  bytes.set(ascii("IEND"), iend + 4)
  return bytes
}

async function fixture(name = "背景 图.PNG", bytes = png()) {
  const root = await mkdtemp(join(tmpdir(), "appearance-assets-"))
  roots.push(root)
  const blog = join(root, "blog")
  const staticDirectory = join(blog, "quartz", "static")
  const publisherDirectory = join(staticDirectory, "publisher")
  await mkdir(blog, { recursive: true })
  const sentinel = join(blog, "note.md")
  await writeFile(sentinel, "unchanged\n")
  const source = join(root, name)
  await writeFile(source, bytes)
  return { root, blog, staticDirectory, publisherDirectory, sentinel, source }
}

const tokens = Array.from(
  { length: 16 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
)

function service(options: {
  selected?: string | readonly string[]
  now?: () => number
  tokenOffset?: number
  decodePreview?: AppearanceAssetPicker["decodePreview"]
  afterSourceOpened?: (path: string) => Promise<void> | void
  onReadBufferAllocated?: (bytes: Uint8Array) => void
  onTrailingProbeAllocated?: (bytes: Uint8Array) => void
  onAssetStored?: (token: string, bytes: Uint8Array) => void
}) {
  let token = options.tokenOffset ?? 0
  const decodePreview = options.decodePreview ?? vi.fn(async () => ({ width: 2, height: 2 }))
  const picker: AppearanceAssetPicker = {
    chooseImage: vi.fn(async () => options.selected),
    decodePreview,
  }
  return {
    picker,
    decodePreview,
    assets: createAppearanceAssetService({
      picker,
      now: options.now ?? (() => 0),
      createToken: () => tokens[token++]!,
      hooks: {
        afterSourceOpened: options.afterSourceOpened,
        onReadBufferAllocated: options.onReadBufferAllocated,
        onTrailingProbeAllocated: options.onTrailingProbeAllocated,
        onAssetStored: options.onAssetStored,
      },
    }),
  }
}

async function expectMissing(...paths: readonly string[]): Promise<void> {
  for (const path of paths) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
}

function expectAppearanceError(
  operation: () => unknown,
  code: "APPEARANCE_INVALID" | "APPEARANCE_CONFLICT",
) {
  expect(operation).toThrow(expect.objectContaining({ code }))
}

describe("appearance asset picker adapter", () => {
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false) },
  }

  it("opens one filtered file and preserves single or multiple dialog results", async () => {
    const showOpenDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: ["C:\\one.png"] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ["C:\\one.png", "C:\\two.jpg"] })
    const picker = createAppearanceAssetPicker({
      getWindow: () => window,
      showOpenDialog,
      createImageFromBuffer: vi.fn(),
    })

    await expect(picker.chooseImage()).resolves.toBe("C:\\one.png")
    await expect(picker.chooseImage()).resolves.toEqual(["C:\\one.png", "C:\\two.jpg"])
    expect(showOpenDialog).toHaveBeenCalledWith(window, {
      properties: ["openFile"],
      filters: [
        {
          name: "图片",
          extensions: IMAGE_FILE_EXTENSIONS.map((extension) => extension.slice(1)),
        },
      ],
    })
  })

  it("maps cancellation and destroyed windows without opening a dialog", async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }))
    const getWindow = vi.fn(() => window)
    const picker = createAppearanceAssetPicker({
      getWindow,
      showOpenDialog,
      createImageFromBuffer: vi.fn(),
    })

    await expect(picker.chooseImage()).resolves.toBeUndefined()
    expect(showOpenDialog).toHaveBeenCalledOnce()
    window.isDestroyed.mockReturnValueOnce(true)
    await expect(picker.chooseImage()).resolves.toBeUndefined()
    window.webContents.isDestroyed.mockReturnValueOnce(true)
    await expect(picker.chooseImage()).resolves.toBeUndefined()
    expect(showOpenDialog).toHaveBeenCalledOnce()
  })

  it("passes an exact zero-copy Buffer view to the native decoder", async () => {
    const backing = new Uint8Array([0xaa, 1, 2, 3, 4, 0xbb])
    const bytes = backing.subarray(1, 5)
    let received: Buffer | undefined
    const picker = createAppearanceAssetPicker({
      getWindow: () => window,
      showOpenDialog: vi.fn(),
      createImageFromBuffer: (buffer) => {
        received = buffer
        buffer[0] = 9
        return { isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }) }
      },
    })

    await expect(picker.decodePreview(bytes)).resolves.toEqual({ width: 2, height: 3 })
    expect(received!.buffer).toBe(bytes.buffer)
    expect(received!.byteOffset).toBe(bytes.byteOffset)
    expect(received!.byteLength).toBe(bytes.byteLength)
    expect(bytes[0]).toBe(9)
    expect(backing[0]).toBe(0xaa)
    expect(backing[5]).toBe(0xbb)
  })

  it("rejects empty images and invalid native dimensions", async () => {
    const createImageFromBuffer = vi
      .fn()
      .mockReturnValueOnce({ isEmpty: () => true, getSize: () => ({ width: 2, height: 2 }) })
      .mockReturnValueOnce({ isEmpty: () => false, getSize: () => ({ width: 0, height: 2 }) })
    const picker = createAppearanceAssetPicker({
      getWindow: () => window,
      showOpenDialog: vi.fn(),
      createImageFromBuffer,
    })

    await expect(picker.decodePreview(png())).rejects.toThrow(
      "The selected image could not be decoded.",
    )
    await expect(picker.decodePreview(png())).rejects.toThrow(
      "The selected image could not be decoded.",
    )
  })

  it("shares an injected decode semaphore across picker instances", async () => {
    const decodeSemaphore = createAppearanceDecodeSemaphore()
    const dependencies = {
      getWindow: () => window,
      showOpenDialog: vi.fn(),
      createImageFromBuffer: vi.fn(),
      decodeSemaphore,
    }
    const first = createAppearanceAssetPicker(dependencies)
    const second = createAppearanceAssetPicker(dependencies)
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()

    const releaseFirst = await first.acquireDecode!(firstAbort.signal)
    let secondAcquired = false
    const secondLease = second.acquireDecode!(secondAbort.signal).then((release) => {
      secondAcquired = true
      return release
    })
    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    releaseFirst()
    const releaseSecond = await secondLease
    expect(secondAcquired).toBe(true)
    releaseSecond()
  })
})

describe("appearance background asset staging", () => {
  it("returns undefined when the native picker is cancelled", async () => {
    const item = await fixture()
    const { assets, picker } = service({})

    await expect(assets.choose()).resolves.toBeUndefined()
    expect(picker.chooseImage).toHaveBeenCalledOnce()
    await expectMissing(item.staticDirectory, item.publisherDirectory)
  })

  it("stages one safe image without creating or changing any blog file", async () => {
    const image = png()
    const item = await fixture("背景 图.PNG", image)
    const before = await readFile(item.sentinel)
    const { assets, decodePreview } = service({ selected: item.source })
    await expectMissing(item.staticDirectory, item.publisherDirectory)

    const selection = await assets.choose()

    expect(selection).toEqual({
      source: "staged",
      token: tokens[0],
      name: "背景 图.PNG",
    })
    expect(selection).not.toHaveProperty("path")
    expect(selection).not.toHaveProperty("bytes")
    expect(decodePreview).toHaveBeenCalledOnce()
    await expectMissing(item.staticDirectory, item.publisherDirectory)
    expect(await readFile(item.sentinel)).toEqual(before)

    const staged = assets.resolve(tokens[0])
    expect(staged).toMatchObject({
      token: tokens[0],
      name: "背景 图.PNG",
      extension: ".png",
      hash: createHash("sha256").update(image).digest("hex"),
    })
    expect(staged.bytes).toEqual(image)
  })

  it("defensively rejects a picker result containing multiple files", async () => {
    const first = await fixture("first.png")
    const second = await fixture("second.png")
    const { assets, decodePreview } = service({ selected: [first.source, second.source] })

    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expect(decodePreview).not.toHaveBeenCalled()
    await expectMissing(
      first.staticDirectory,
      first.publisherDirectory,
      second.staticDirectory,
      second.publisherDirectory,
    )
  })

  it("accepts exactly 25 MiB of file bytes and rejects the next byte", async () => {
    expect(APPEARANCE_ASSET_MAX_FILE_BYTES).toBe(25 * 1024 * 1024)
    const exact = await fixture("边界.png", png(2, 2, APPEARANCE_ASSET_MAX_FILE_BYTES))
    const over = await fixture("over.png")
    await truncate(over.source, APPEARANCE_ASSET_MAX_FILE_BYTES + 1)
    const exactAssets = service({ selected: exact.source }).assets
    const overAssets = service({ selected: over.source, tokenOffset: 1 }).assets

    const selection = await exactAssets.choose()
    expect(exactAssets.resolve(selection!.token).bytes).toHaveLength(
      APPEARANCE_ASSET_MAX_FILE_BYTES,
    )
    await expect(overAssets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
  })

  it("rejects an extension/signature mismatch before native decoding", async () => {
    const item = await fixture("photo.jpg", png())
    const { assets, decodePreview } = service({ selected: item.source })

    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expect(decodePreview).not.toHaveBeenCalled()
    await expectMissing(item.staticDirectory, item.publisherDirectory)
  })

  it("rejects excessive metadata and native decoder dimensions", async () => {
    const metadataTooLarge = await fixture("metadata.png", png(16_385, 1))
    const decodedTooLarge = await fixture("decoded.png")
    const first = service({ selected: metadataTooLarge.source })
    const second = service({
      selected: decodedTooLarge.source,
      tokenOffset: 1,
      decodePreview: vi.fn(async () => ({ width: 10_000, height: 4_001 })),
    })

    await expect(first.assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expect(first.decodePreview).not.toHaveBeenCalled()
    await expect(second.assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
  })

  it("rejects a symlink source and does not disclose its path", async ({ skip }) => {
    const target = await fixture("target.png")
    const linked = join(target.root, "linked.png")
    try {
      await symlink(target.source, linked, "file")
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) skip()
      throw error
    }
    const { assets } = service({ selected: linked })

    let failure: unknown
    try {
      await assets.choose()
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: "APPEARANCE_INVALID" })
    expect(JSON.stringify(failure)).not.toContain(linked)
  })

  it("rejects a source reached through a junctioned parent", async ({ skip }) => {
    const target = await fixture("target.png")
    const linkedParent = join(target.root, "linked-parent")
    try {
      await symlink(target.root, linkedParent, process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) skip()
      throw error
    }
    const { assets } = service({ selected: join(linkedParent, "target.png") })

    await expect(assets.choose()).rejects.toEqual({
      code: "APPEARANCE_INVALID",
      message: "The selected background image is invalid.",
    })
  })

  it("rejects a source whose path identity changes during the bounded read", async () => {
    const item = await fixture("changing.png")
    const { assets } = service({
      selected: item.source,
      afterSourceOpened: async (path) => {
        await rename(path, `${path}.old`)
        await writeFile(path, png(3, 3))
      },
    })

    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
  })

  it("scrubs the trailing growth probe after a source changes", async () => {
    const item = await fixture("growing.png")
    let trailingProbe: Uint8Array | undefined
    const { assets } = service({
      selected: item.source,
      afterSourceOpened: async (path) => {
        const grown = new Uint8Array(png().length + 1)
        grown.set(png())
        grown[grown.length - 1] = 0x7f
        await writeFile(path, grown)
      },
      onTrailingProbeAllocated: (bytes) => {
        trailingProbe = bytes
      },
    })

    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
    expect(trailingProbe).toEqual(Uint8Array.of(0))
  })

  it("rejects a same-inode source truncated and rewritten through the open handle window", async () => {
    const item = await fixture("same-inode.png")
    const before = await lstat(item.source, { bigint: true })
    const { assets } = service({
      selected: item.source,
      afterSourceOpened: async (path) => {
        await truncate(path, 0)
        await writeFile(path, png().subarray(0, -1))
      },
    })

    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
    const after = await lstat(item.source, { bigint: true })
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
  })

  it("does not trust or disclose a path-bearing error from a staging dependency", async () => {
    const item = await fixture("private-source.png")
    const { assets } = service({
      selected: item.source,
      afterSourceOpened: () => {
        throw { code: "APPEARANCE_INVALID", message: item.source }
      },
    })

    let failure: unknown
    try {
      await assets.choose()
    } catch (error) {
      failure = error
    }
    expect(failure).toEqual({
      code: "APPEARANCE_INVALID",
      message: "The selected background image is invalid.",
    })
  })

  it("expires a token at exactly five minutes", async () => {
    const item = await fixture()
    let now = 10_000
    let stored: Uint8Array | undefined
    const { assets } = service({
      selected: item.source,
      now: () => now,
      onAssetStored: (_token, bytes) => {
        stored = bytes
      },
    })
    const selected = await assets.choose()

    expect(APPEARANCE_ASSET_TTL_MS).toBe(5 * 60 * 1000)
    now += APPEARANCE_ASSET_TTL_MS - 1
    expect(assets.resolve(selected!.token).name).toBe("背景 图.PNG")
    now += 1
    expectAppearanceError(() => assets.resolve(selected!.token), "APPEARANCE_CONFLICT")
    expect(stored).toBeDefined()
    expect(stored!.every((byte) => byte === 0)).toBe(true)
  })

  it("keeps at most eight sessions and evicts the oldest deterministically", async () => {
    const items = await Promise.all(
      Array.from({ length: 9 }, (_, index) => fixture(`asset-${index + 1}.png`)),
    )
    let selected: string | undefined
    let token = 0
    const stored: Uint8Array[] = []
    const assets = createAppearanceAssetService({
      picker: {
        chooseImage: async () => selected,
        decodePreview: async () => ({ width: 2, height: 2 }),
      },
      now: () => 0,
      createToken: () => tokens[token++]!,
      hooks: { onAssetStored: (_token, bytes) => stored.push(bytes) },
    })
    for (const item of items) {
      selected = item.source
      await assets.choose()
    }

    expectAppearanceError(() => assets.resolve(tokens[0]), "APPEARANCE_CONFLICT")
    expect(stored[0]!.every((byte) => byte === 0)).toBe(true)
    for (const bytes of stored.slice(1)) expect(bytes.some((byte) => byte !== 0)).toBe(true)
    for (const active of tokens.slice(1, 9)) expect(assets.resolve(active).token).toBe(active)
  })

  it("preserves all active tokens until a replacement is ready to commit", async () => {
    const items = await Promise.all(
      Array.from({ length: 9 }, (_, index) => fixture(`commit-${index + 1}.png`)),
    )
    let selected: string | undefined
    let token = 0
    let finishDecode: ((value: { width: number; height: number }) => void) | undefined
    let holdReplacement = false
    const decodePreview = vi.fn(() =>
      holdReplacement
        ? new Promise<{ width: number; height: number }>((resolve) => {
            finishDecode = resolve
          })
        : Promise.resolve({ width: 2, height: 2 }),
    )
    const assets = createAppearanceAssetService({
      picker: { chooseImage: async () => selected, decodePreview },
      now: () => 0,
      createToken: () => tokens[token++]!,
    })
    for (const item of items.slice(0, 8)) {
      selected = item.source
      await assets.choose()
    }

    selected = items[8]!.source
    holdReplacement = true
    const replacement = assets.choose()
    await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledTimes(9))
    for (const active of tokens.slice(0, 8)) expect(assets.resolve(active).token).toBe(active)

    finishDecode!({ width: 2, height: 2 })
    await expect(replacement).resolves.toMatchObject({ token: tokens[8] })
    expectAppearanceError(() => assets.resolve(tokens[0]), "APPEARANCE_CONFLICT")
    for (const active of tokens.slice(1, 9)) expect(assets.resolve(active).token).toBe(active)
  })

  it("keeps a full active set after cancel, missing, corrupt, and decoder failures", async () => {
    const activeItems = await Promise.all(
      Array.from({ length: 8 }, (_, index) => fixture(`active-${index + 1}.png`)),
    )
    const missing = await fixture("missing.png")
    await rm(missing.source)
    const corrupt = await fixture("corrupt.jpg")
    const decodeFailure = await fixture("decode-failure.png")
    let selected: string | undefined
    let token = 0
    let failDecode = false
    const assets = createAppearanceAssetService({
      picker: {
        chooseImage: async () => selected,
        decodePreview: async () => {
          if (failDecode) throw new Error("decode failed")
          return { width: 2, height: 2 }
        },
      },
      now: () => 0,
      createToken: () => tokens[token++]!,
    })
    for (const item of activeItems) {
      selected = item.source
      await assets.choose()
    }
    const expectAllActive = (): void => {
      for (const active of tokens.slice(0, 8)) expect(assets.resolve(active).token).toBe(active)
    }

    selected = undefined
    await expect(assets.choose()).resolves.toBeUndefined()
    expectAllActive()
    selected = missing.source
    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expectAllActive()
    selected = corrupt.source
    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expectAllActive()
    selected = decodeFailure.source
    failDecode = true
    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expectAllActive()
  })

  it("serializes mixed replacement decodes and evicts only for the successful commit", async () => {
    const items = await Promise.all(
      Array.from({ length: 10 }, (_, index) => fixture(`mixed-${index + 1}.png`)),
    )
    let selected = 0
    let token = 0
    const finishDecode: Array<{
      resolve: (value: { width: number; height: number }) => void
      reject: (reason: Error) => void
    }> = []
    let holdDecode = false
    const decodePreview = vi.fn(() => {
      if (!holdDecode) return Promise.resolve({ width: 2, height: 2 })
      return new Promise<{ width: number; height: number }>((resolve, reject) => {
        finishDecode.push({ resolve, reject })
      })
    })
    const assets = createAppearanceAssetService({
      picker: { chooseImage: async () => items[selected++]!.source, decodePreview },
      now: () => 0,
      createToken: () => tokens[token++]!,
    })
    for (let index = 0; index < 8; index += 1) await assets.choose()

    holdDecode = true
    const failed = assets.choose()
    const failedAssertion = expect(failed).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledTimes(9))
    const successful = assets.choose()
    expect(finishDecode).toHaveLength(1)
    finishDecode[0]!.reject(new Error("decode failed"))
    await failedAssertion
    for (const active of tokens.slice(0, 8)) expect(assets.resolve(active).token).toBe(active)

    await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledTimes(10))
    expect(finishDecode).toHaveLength(2)
    finishDecode[1]!.resolve({ width: 2, height: 2 })
    await expect(successful).resolves.toMatchObject({ token: tokens[8] })
    expectAppearanceError(() => assets.resolve(tokens[0]), "APPEARANCE_CONFLICT")
    for (const active of tokens.slice(1, 9)) expect(assets.resolve(active).token).toBe(active)
  })

  it("caps pending work at eight and decodes one selection at a time", async () => {
    const items = await Promise.all(
      Array.from({ length: 9 }, (_, index) => fixture(`pending-${index + 1}.png`)),
    )
    let selected = 0
    let token = 0
    const finishDecode: Array<(value: { width: number; height: number }) => void> = []
    const retained: Uint8Array[] = []
    let activeDecodes = 0
    let peakActiveDecodes = 0
    let peakRetainedBytes = 0
    const decodePreview = vi.fn(
      () =>
        new Promise<{ width: number; height: number }>((resolve) => {
          activeDecodes += 1
          peakActiveDecodes = Math.max(peakActiveDecodes, activeDecodes)
          finishDecode.push((value) => {
            activeDecodes -= 1
            resolve(value)
          })
        }),
    )
    const assets = createAppearanceAssetService({
      picker: {
        chooseImage: async () => items[selected++]!.source,
        decodePreview,
      },
      now: () => 0,
      createToken: () => tokens[token++]!,
      hooks: {
        onReadBufferAllocated: (bytes) => retained.push(bytes),
        onRetainedBytesChanged: (bytes) => {
          peakRetainedBytes = Math.max(peakRetainedBytes, bytes)
        },
      },
    })

    expect(APPEARANCE_ASSET_MAX_RETAINED_BYTES).toBe(17 * APPEARANCE_ASSET_MAX_FILE_BYTES)
    const pending = items.map(() => assets.choose())
    const ninth = expect(pending[8]).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
    await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledOnce())
    await ninth
    expect(retained).toHaveLength(8)
    const retainedSourceBytes = retained.reduce((total, bytes) => total + bytes.length, 0)
    expect(retainedSourceBytes).toBeLessThanOrEqual(8 * APPEARANCE_ASSET_MAX_FILE_BYTES)
    expect(peakRetainedBytes).toBe(retainedSourceBytes + retained[0]!.length)
    expect(peakRetainedBytes).toBeLessThanOrEqual(APPEARANCE_ASSET_MAX_RETAINED_BYTES)
    for (let index = 0; index < 8; index += 1) {
      await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledTimes(index + 1))
      expect(activeDecodes).toBe(1)
      finishDecode[index]!({ width: 2, height: 2 })
    }
    await expect(Promise.all(pending.slice(0, 8))).resolves.toHaveLength(8)
    expect(peakActiveDecodes).toBe(1)
  })

  it("releases a reservation after decoder failure", async () => {
    const items = await Promise.all(
      Array.from({ length: 9 }, (_, index) => fixture(`retry-${index + 1}.png`)),
    )
    let selected = 0
    let token = 0
    let first = true
    let failedDecoderBytes: Uint8Array | undefined
    const finishDecode: Array<(value: { width: number; height: number }) => void> = []
    const decodePreview = vi.fn(async (bytes: Uint8Array) => {
      if (first) {
        first = false
        failedDecoderBytes = bytes
        throw new Error("decode failed")
      }
      return new Promise<{ width: number; height: number }>((resolve) => {
        finishDecode.push(resolve)
      })
    })
    const assets = createAppearanceAssetService({
      picker: { chooseImage: async () => items[selected++]!.source, decodePreview },
      now: () => 0,
      createToken: () => tokens[token++]!,
    })

    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expect(failedDecoderBytes!.every((byte) => byte === 0)).toBe(true)
    const pending = items.slice(1).map(() => assets.choose())
    for (let index = 0; index < 8; index += 1) {
      await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledTimes(index + 2))
      finishDecode[index]!({ width: 2, height: 2 })
    }
    await expect(Promise.all(pending)).resolves.toHaveLength(8)
  })

  it("releases and zeros reservations after cancel and validation failure", async () => {
    const invalid = await fixture("mismatch.jpg")
    const valid = await Promise.all(
      Array.from({ length: 8 }, (_, index) => fixture(`after-error-${index + 1}.png`)),
    )
    const selections: Array<string | undefined> = [
      undefined,
      invalid.source,
      ...valid.map((item) => item.source),
    ]
    let selected = 0
    let token = 0
    const retained: Uint8Array[] = []
    const finishDecode: Array<(value: { width: number; height: number }) => void> = []
    const decodePreview = vi.fn(
      () =>
        new Promise<{ width: number; height: number }>((resolve) => {
          finishDecode.push(resolve)
        }),
    )
    const assets = createAppearanceAssetService({
      picker: { chooseImage: async () => selections[selected++], decodePreview },
      now: () => 0,
      createToken: () => tokens[token++]!,
      hooks: { onReadBufferAllocated: (bytes) => retained.push(bytes) },
    })

    await expect(assets.choose()).resolves.toBeUndefined()
    expect(retained).toHaveLength(0)
    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_INVALID" })
    expect(retained[0]!.every((byte) => byte === 0)).toBe(true)

    const pending = valid.map(() => assets.choose())
    for (let index = 0; index < 8; index += 1) {
      await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledTimes(index + 1))
      finishDecode[index]!({ width: 2, height: 2 })
    }
    await expect(Promise.all(pending)).resolves.toHaveLength(8)
  })

  it("isolates stored bytes from a decoder that retains and mutates its input", async () => {
    const image = png()
    const item = await fixture("retained-decoder.png", image)
    let sourceBytes: Uint8Array | undefined
    let decoderBytes: Uint8Array | undefined
    let storedBytes: Uint8Array | undefined
    const assets = createAppearanceAssetService({
      picker: {
        chooseImage: async () => item.source,
        decodePreview: async (bytes) => {
          decoderBytes = bytes
          return { width: 2, height: 2 }
        },
      },
      now: () => 0,
      createToken: () => tokens[0],
      hooks: {
        onReadBufferAllocated: (bytes) => {
          sourceBytes = bytes
        },
        onAssetStored: (_token, bytes) => {
          storedBytes = bytes
        },
      },
    })

    const selected = await assets.choose()
    const expectedHash = createHash("sha256").update(image).digest("hex")
    expect(sourceBytes).not.toBe(storedBytes)
    expect(decoderBytes).not.toBe(sourceBytes)
    expect(decoderBytes).not.toBe(storedBytes)
    expect(sourceBytes!.every((byte) => byte === 0)).toBe(true)
    expect(decoderBytes!.every((byte) => byte === 0)).toBe(true)
    decoderBytes!.fill(0xff)

    const resolved = assets.resolve(selected!.token)
    expect(resolved.bytes).not.toBe(storedBytes)
    expect(resolved.bytes).toEqual(image)
    expect(resolved.hash).toBe(expectedHash)
    resolved.bytes.fill(0)
    const resolvedAgain = assets.resolve(selected!.token)
    expect(resolvedAgain.bytes).toEqual(image)
    expect(resolvedAgain.hash).toBe(expectedHash)
    const consumed = assets.consume(selected!.token)
    expect(consumed.bytes).not.toBe(storedBytes)
    expect(consumed.bytes).toEqual(image)
    expect(consumed.hash).toBe(expectedHash)
    consumed.bytes.fill(0xff)
    expect(storedBytes!.every((byte) => byte === 0)).toBe(true)
  })

  it("isolates tokens between service sessions and consumes each token once", async () => {
    const first = await fixture("first.png")
    const second = await fixture("second.png")
    let stored: Uint8Array | undefined
    const firstAssets = service({
      selected: first.source,
      onAssetStored: (_token, bytes) => {
        stored = bytes
      },
    }).assets
    const secondAssets = service({ selected: second.source, tokenOffset: 1 }).assets
    const firstSelection = await firstAssets.choose()
    const secondSelection = await secondAssets.choose()

    expectAppearanceError(() => firstAssets.resolve(secondSelection!.token), "APPEARANCE_CONFLICT")
    expectAppearanceError(() => secondAssets.resolve(firstSelection!.token), "APPEARANCE_CONFLICT")

    const previewCopy = firstAssets.resolve(firstSelection!.token)
    previewCopy.bytes.fill(0)
    expect(stored!.some((byte) => byte !== 0)).toBe(true)
    expect(firstAssets.resolve(firstSelection!.token).bytes).toEqual(png())
    expect(firstAssets.consume(firstSelection!.token).bytes).toEqual(png())
    expect(stored!.every((byte) => byte === 0)).toBe(true)
    expectAppearanceError(() => firstAssets.consume(firstSelection!.token), "APPEARANCE_CONFLICT")
  })

  it("drops every active token on dispose without mutating returned copies", async () => {
    const item = await fixture()
    let stored: Uint8Array | undefined
    const { assets } = service({
      selected: item.source,
      onAssetStored: (_token, bytes) => {
        stored = bytes
      },
    })
    const selected = await assets.choose()
    const outsideCopy = assets.resolve(selected!.token)

    assets.dispose()

    expectAppearanceError(() => assets.resolve(selected!.token), "APPEARANCE_CONFLICT")
    expect(stored!.every((byte) => byte === 0)).toBe(true)
    expect(outsideCopy.bytes).toEqual(png())
    await expect(assets.choose()).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
  })

  it("cannot publish a late picker result after disposal", async () => {
    const item = await fixture()
    let finish: ((path: string) => void) | undefined
    const chosen = new Promise<string>((resolve) => {
      finish = resolve
    })
    const decodePreview = vi.fn(async () => ({ width: 2, height: 2 }))
    const assets = createAppearanceAssetService({
      picker: { chooseImage: () => chosen, decodePreview },
      now: () => 0,
      createToken: () => tokens[0],
    })

    const pending = assets.choose()
    assets.dispose()
    finish!(item.source)

    await expect(pending).rejects.toMatchObject({ code: "APPEARANCE_CONFLICT" })
    expect(decodePreview).not.toHaveBeenCalled()
  })

  it("cancels a queued decode and scrubs every JS buffer on dispose", async () => {
    const items = await Promise.all([fixture("dispose-1.png"), fixture("dispose-2.png")])
    let selected = 0
    const sourceBytes: Uint8Array[] = []
    const decoderBytes: Uint8Array[] = []
    const decodeSemaphore = createAppearanceDecodeSemaphore()
    const decodePreview = vi.fn(
      (bytes: Uint8Array, signal?: AbortSignal) =>
        new Promise<{ width: number; height: number }>((_resolve, reject) => {
          decoderBytes.push(bytes)
          expect(signal).toBeDefined()
          signal!.addEventListener("abort", () => reject(new Error("decode cancelled")), {
            once: true,
          })
        }),
    )
    const assets = createAppearanceAssetService({
      picker: {
        chooseImage: async () => items[selected++]!.source,
        acquireDecode: decodeSemaphore.acquire,
        decodePreview,
      },
      now: () => 0,
      createToken: () => tokens[0],
      hooks: {
        onReadBufferAllocated: (bytes) => {
          sourceBytes.push(bytes)
        },
      },
    })

    const pending = [assets.choose(), assets.choose()]
    await vi.waitFor(() => expect(decodePreview).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(sourceBytes).toHaveLength(2))
    expect(sourceBytes.filter((bytes) => bytes.every((byte) => byte === 0))).toHaveLength(1)
    expect(sourceBytes.filter((bytes) => bytes.some((byte) => byte !== 0))).toHaveLength(1)
    expect(decoderBytes[0]!.some((byte) => byte !== 0)).toBe(true)
    assets.dispose()
    for (const bytes of [...sourceBytes, ...decoderBytes])
      expect(bytes.every((byte) => byte === 0)).toBe(true)
    await expect(Promise.allSettled(pending)).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "APPEARANCE_CONFLICT" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "APPEARANCE_CONFLICT" }),
      }),
    ])
    expect(decodePreview).toHaveBeenCalledOnce()
    const release = await decodeSemaphore.acquire(new AbortController().signal)
    release()
  })
})
