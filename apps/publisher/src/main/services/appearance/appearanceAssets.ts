import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"
import type { AppearanceBackgroundSelection, AppError } from "../../../shared/contracts"
import {
  detectImageFormat,
  IMAGE_FILE_EXTENSIONS,
  readBoundedImageMetadata,
  validateBoundedImageDimensions,
} from "../imageFormats"
import type { StagedAppearanceAsset } from "./appearanceAdapter"

export type { StagedAppearanceAsset } from "./appearanceAdapter"

export const APPEARANCE_ASSET_MAX_FILE_BYTES = 25 * 1024 * 1024
export const APPEARANCE_ASSET_TTL_MS = 5 * 60 * 1000
export const APPEARANCE_ASSET_MAX_SESSIONS = 8
export const APPEARANCE_ASSET_MAX_CONCURRENT_DECODES = 1
// At most eight active storage buffers and eight pending source/storage buffers
// coexist. The single decoder lease permits one extra handoff or decoder clone:
// 17 full-size encoded JS buffers (425 MiB), plus at most eight one-byte growth
// probes. Electron controls native decoded-image memory.
export const APPEARANCE_ASSET_MAX_RETAINED_BYTES =
  (2 * APPEARANCE_ASSET_MAX_SESSIONS + APPEARANCE_ASSET_MAX_CONCURRENT_DECODES) *
  APPEARANCE_ASSET_MAX_FILE_BYTES

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const trustedErrors = new WeakSet<object>()

type SourceIdentity = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">

export interface AppearanceAssetPicker {
  chooseImage(): Promise<string | readonly string[] | undefined>
  acquireDecode?(signal: AbortSignal): Promise<() => void>
  decodePreview(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ readonly width: number; readonly height: number }>
}

export interface AppearanceDecodeSemaphore {
  acquire(signal: AbortSignal): Promise<() => void>
}

export interface AppearanceAssetPickerWindow {
  isDestroyed(): boolean
  readonly webContents: { isDestroyed(): boolean }
}

export interface AppearanceAssetPickerDependencies<TWindow extends AppearanceAssetPickerWindow> {
  readonly getWindow: () => TWindow | undefined
  readonly showOpenDialog: (
    window: TWindow,
    options: {
      properties: ["openFile"]
      filters: Array<{ name: string; extensions: string[] }>
    },
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>
  readonly createImageFromBuffer: (bytes: Buffer) => {
    isEmpty(): boolean
    getSize(): { readonly width: number; readonly height: number }
  }
  readonly decodeSemaphore?: AppearanceDecodeSemaphore
}

export interface AppearanceAssetService {
  choose(): Promise<AppearanceBackgroundSelection | undefined>
  resolve(token: string): StagedAppearanceAsset
  consume(token: string): StagedAppearanceAsset
  dispose(): void
}

export interface AppearanceAssetServiceOptions {
  readonly picker: AppearanceAssetPicker
  readonly now: () => number
  readonly createToken: () => string
  readonly hooks?: {
    readonly afterSourceOpened?: (path: string) => Promise<void> | void
    /** Test-only observation of the bounded source buffer; never crosses IPC. */
    readonly onReadBufferAllocated?: (bytes: Uint8Array) => void
    /** Test-only observation of the one-byte growth probe; never crosses IPC. */
    readonly onTrailingProbeAllocated?: (bytes: Uint8Array) => void
    /** Test-only observation of internal storage; never crosses IPC. */
    readonly onAssetStored?: (token: string, bytes: Uint8Array) => void
    /** Test-only observation of the service-owned byte budget; never crosses IPC. */
    readonly onRetainedBytesChanged?: (bytes: number) => void
  }
}

interface StagedEntry {
  readonly asset: StagedAppearanceAsset
  readonly createdAt: number
}

interface PendingReservation {
  readonly abort: AbortController
  readonly buffers: Set<Uint8Array>
}

interface DecodeWaiter {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (reason: Error) => void
  readonly abort: () => void
}

function invalid(): AppError {
  const error: AppError = {
    code: "APPEARANCE_INVALID",
    message: "The selected background image is invalid.",
  }
  trustedErrors.add(error)
  return error
}

function conflict(): AppError {
  const error: AppError = {
    code: "APPEARANCE_CONFLICT",
    message: "The staged background is unavailable or changed. Choose it again.",
  }
  trustedErrors.add(error)
  return error
}

function isAppearanceAssetError(value: unknown): value is AppError {
  return typeof value === "object" && value !== null && trustedErrors.has(value)
}

function identity(details: BigIntStats): SourceIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  }
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function createAppearanceDecodeSemaphore(
  maximum = APPEARANCE_ASSET_MAX_CONCURRENT_DECODES,
): AppearanceDecodeSemaphore {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid decode concurrency")
  let active = 0
  const waiting: DecodeWaiter[] = []

  const dispatch = (): void => {
    while (active < maximum && waiting.length > 0) {
      const waiter = waiting.shift()!
      waiter.signal.removeEventListener("abort", waiter.abort)
      if (waiter.signal.aborted) {
        waiter.reject(new Error("Decode reservation cancelled"))
        continue
      }
      active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        active -= 1
        dispatch()
      })
    }
  }

  return {
    acquire: (signal) => {
      if (signal.aborted) return Promise.reject(new Error("Decode reservation cancelled"))
      return new Promise<() => void>((resolve, reject) => {
        let waiter!: DecodeWaiter
        const abort = (): void => {
          const index = waiting.indexOf(waiter)
          if (index >= 0) waiting.splice(index, 1)
          reject(new Error("Decode reservation cancelled"))
        }
        waiter = { signal, resolve, reject, abort }
        signal.addEventListener("abort", abort, { once: true })
        waiting.push(waiter)
        dispatch()
      })
    },
  }
}

export function createAppearanceAssetPicker<TWindow extends AppearanceAssetPickerWindow>(
  dependencies: AppearanceAssetPickerDependencies<TWindow>,
): AppearanceAssetPicker {
  const decodeSemaphore = dependencies.decodeSemaphore ?? createAppearanceDecodeSemaphore()
  return {
    acquireDecode: decodeSemaphore.acquire,
    chooseImage: async () => {
      const window = dependencies.getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return undefined
      const result = await dependencies.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [
          {
            name: "图片",
            extensions: IMAGE_FILE_EXTENSIONS.map((extension) => extension.slice(1)),
          },
        ],
      })
      if (result.canceled) return undefined
      return result.filePaths.length === 1 ? result.filePaths[0] : result.filePaths
    },
    decodePreview: async (bytes) => {
      // Use an exact view so native decoding does not add another encoded-byte copy.
      let buffer: Buffer | undefined = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let image:
        ReturnType<AppearanceAssetPickerDependencies<TWindow>["createImageFromBuffer"]> | undefined
      try {
        image = dependencies.createImageFromBuffer(buffer)
        if (image.isEmpty()) throw new Error("The selected image could not be decoded.")
        const { width, height } = image.getSize()
        if (
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          !Number.isSafeInteger(height) ||
          height <= 0
        )
          throw new Error("The selected image could not be decoded.")
        return { width, height }
      } finally {
        image = undefined
        buffer = undefined
      }
    },
  }
}

async function readBoundedSource(
  path: string,
  hooks: AppearanceAssetServiceOptions["hooks"],
  allocate: (length: number) => Uint8Array,
  ensureActive: () => void,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let bytes: Uint8Array | undefined
  let trailing: Uint8Array | undefined
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw invalid()
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) throw invalid()
    if (before.size > BigInt(APPEARANCE_ASSET_MAX_FILE_BYTES)) throw invalid()
    if (!pathsEqual(await realpath(path), path)) throw invalid()

    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) throw conflict()
    await hooks?.afterSourceOpened?.(path)
    ensureActive()

    const expectedBytes = Number(opened.size)
    bytes = allocate(expectedBytes)
    hooks?.onReadBufferAllocated?.(bytes)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      ensureActive()
      if (bytesRead === 0) break
      offset += bytesRead
    }
    trailing = new Uint8Array(1)
    hooks?.onTrailingProbeAllocated?.(trailing)
    const { bytesRead: trailingBytes } = await handle.read(trailing, 0, 1, expectedBytes)
    ensureActive()
    const [after, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ])
    if (
      offset !== expectedBytes ||
      trailingBytes !== 0 ||
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameIdentity(identity(opened), identity(after)) ||
      !sameIdentity(identity(opened), identity(pathAfter)) ||
      !pathsEqual(canonicalAfter, path)
    ) {
      bytes.fill(0)
      throw conflict()
    }
    return bytes
  } catch (error) {
    bytes?.fill(0)
    if (isAppearanceAssetError(error)) throw error
    throw invalid()
  } finally {
    trailing?.fill(0)
    await handle?.close().catch(() => undefined)
  }
}

function cloneAsset(asset: StagedAppearanceAsset): StagedAppearanceAsset {
  return Object.freeze({ ...asset, bytes: new Uint8Array(asset.bytes) })
}

export function createAppearanceAssetService(
  options: AppearanceAssetServiceOptions,
): AppearanceAssetService {
  const entries = new Map<string, StagedEntry>()
  const reservations = new Set<PendingReservation>()
  const ownedBuffers = new Set<Uint8Array>()
  const localDecodeSemaphore = createAppearanceDecodeSemaphore()
  const acquireDecode =
    options.picker.acquireDecode?.bind(options.picker) ?? localDecodeSemaphore.acquire
  let retainedBytes = 0
  let disposed = false

  const retainedBytesChanged = (): void => {
    try {
      options.hooks?.onRetainedBytesChanged?.(retainedBytes)
    } catch {
      // Observation hooks never affect production ownership or cleanup.
    }
  }

  const releaseOwned = (bytes: Uint8Array): void => {
    if (!ownedBuffers.delete(bytes)) return
    bytes.fill(0)
    retainedBytes -= bytes.length
    retainedBytesChanged()
  }

  const remove = (token: string): void => {
    const entry = entries.get(token)
    entries.delete(token)
    if (entry !== undefined) releaseOwned(entry.asset.bytes)
  }

  const purgeExpired = (): void => {
    const now = options.now()
    for (const [token, entry] of entries) {
      if (now - entry.createdAt >= APPEARANCE_ASSET_TTL_MS) remove(token)
    }
  }

  const active = (token: string): StagedEntry => {
    if (disposed) throw conflict()
    purgeExpired()
    const entry = TOKEN_PATTERN.test(token) ? entries.get(token) : undefined
    if (entry === undefined) throw conflict()
    return entry
  }

  const uniqueToken = (): string => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = options.createToken()
      if (TOKEN_PATTERN.test(token) && !entries.has(token)) return token
    }
    throw conflict()
  }

  const ensureByteRoom = (additionalBytes: number): void => {
    if (retainedBytes > APPEARANCE_ASSET_MAX_RETAINED_BYTES - additionalBytes) throw conflict()
  }

  const allocateOwned = (length: number, reservation: PendingReservation): Uint8Array => {
    if (!Number.isSafeInteger(length) || length < 0 || length > APPEARANCE_ASSET_MAX_FILE_BYTES)
      throw invalid()
    ensureByteRoom(length)
    const bytes = new Uint8Array(length)
    ownedBuffers.add(bytes)
    reservation.buffers.add(bytes)
    retainedBytes += length
    retainedBytesChanged()
    return bytes
  }

  const cloneOwned = (source: Uint8Array, reservation: PendingReservation): Uint8Array => {
    const bytes = allocateOwned(source.length, reservation)
    bytes.set(source)
    return bytes
  }

  const releaseReserved = (reservation: PendingReservation, bytes: Uint8Array): void => {
    reservation.buffers.delete(bytes)
    releaseOwned(bytes)
  }

  const reserve = (): PendingReservation => {
    if (disposed) throw conflict()
    purgeExpired()
    if (reservations.size >= APPEARANCE_ASSET_MAX_SESSIONS) throw conflict()
    const reservation: PendingReservation = { abort: new AbortController(), buffers: new Set() }
    reservations.add(reservation)
    return reservation
  }

  return {
    async choose(): Promise<AppearanceBackgroundSelection | undefined> {
      if (disposed) throw conflict()
      let source: string | readonly string[] | undefined
      try {
        source = await options.picker.chooseImage()
      } catch {
        throw invalid()
      }
      if (disposed) throw conflict()
      if (source === undefined) return undefined
      if (typeof source !== "string") {
        if (source.length !== 1) throw invalid()
        source = source[0]
      }
      if (typeof source !== "string" || source.length === 0) throw invalid()

      const reservation = reserve()
      try {
        let sourceBytes: Uint8Array | undefined = await readBoundedSource(
          source,
          options.hooks,
          (length) => allocateOwned(length, reservation),
          () => {
            if (disposed) throw conflict()
          },
        )
        if (disposed) throw conflict()
        const name = basename(source)
        const format = detectImageFormat(sourceBytes, name)
        const metadata = readBoundedImageMetadata(sourceBytes)
        if (metadata.mime !== format.mime) throw invalid()

        const releaseDecode = await acquireDecode(reservation.abort.signal)
        try {
          if (disposed) throw conflict()
          const storedBytes = cloneOwned(sourceBytes, reservation)
          releaseReserved(reservation, sourceBytes)
          // Drop the last service reference before allocating the disposable decoder clone.
          sourceBytes = undefined

          const decoderBytes = cloneOwned(storedBytes, reservation)
          let decoded: { readonly width: number; readonly height: number }
          try {
            decoded = await options.picker.decodePreview(decoderBytes, reservation.abort.signal)
          } finally {
            releaseReserved(reservation, decoderBytes)
          }
          validateBoundedImageDimensions(decoded.width, decoded.height, format.mime)
          if (disposed) throw conflict()
          const verifiedFormat = detectImageFormat(storedBytes, name)
          const verifiedMetadata = readBoundedImageMetadata(storedBytes)
          if (verifiedFormat.mime !== format.mime || verifiedMetadata.mime !== format.mime)
            throw invalid()
          const token = uniqueToken()
          const asset: StagedAppearanceAsset = {
            token,
            name,
            extension: format.extension,
            hash: createHash("sha256").update(storedBytes).digest("hex"),
            bytes: storedBytes,
          }
          try {
            options.hooks?.onAssetStored?.(token, asset.bytes)
          } catch {
            throw invalid()
          }
          purgeExpired()
          while (entries.size >= APPEARANCE_ASSET_MAX_SESSIONS) {
            const oldest = entries.keys().next().value as string | undefined
            if (oldest === undefined) throw conflict()
            remove(oldest)
          }
          entries.set(token, { asset, createdAt: options.now() })
          reservation.buffers.delete(storedBytes)
          return Object.freeze({ source: "staged", token, name })
        } finally {
          releaseDecode()
        }
      } catch (error) {
        if (disposed || reservation.abort.signal.aborted) throw conflict()
        if (isAppearanceAssetError(error)) throw error
        throw invalid()
      } finally {
        reservations.delete(reservation)
        for (const bytes of reservation.buffers) releaseOwned(bytes)
        reservation.buffers.clear()
      }
    },

    resolve(token: string): StagedAppearanceAsset {
      return cloneAsset(active(token).asset)
    },

    consume(token: string): StagedAppearanceAsset {
      const entry = active(token)
      const result = cloneAsset(entry.asset)
      remove(token)
      return result
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const reservation of reservations) reservation.abort.abort()
      for (const bytes of [...ownedBuffers]) releaseOwned(bytes)
      reservations.clear()
      entries.clear()
    },
  }
}
