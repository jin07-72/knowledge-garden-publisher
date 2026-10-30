import {
  IMAGE_LIBRARY_MAX_NAME_LENGTH,
  KEBAB_SLUG_SOURCE,
  type AppError,
} from "../../shared/contracts"

export type ImageFormat =
  | { readonly extension: ".png"; readonly mime: "image/png" }
  | { readonly extension: ".jpg"; readonly mime: "image/jpeg" }
  | { readonly extension: ".jpeg"; readonly mime: "image/jpeg" }
  | { readonly extension: ".gif"; readonly mime: "image/gif" }
  | { readonly extension: ".webp"; readonly mime: "image/webp" }
  | { readonly extension: ".avif"; readonly mime: "image/avif" }

export const IMAGE_FILE_EXTENSIONS = Object.freeze([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
] as const)

type Signature = "png" | "jpeg" | "gif" | "webp" | "avif"
type FormatDefinition = ImageFormat & { readonly signature: Signature }

const IMAGE_FORMATS: readonly FormatDefinition[] = Object.freeze([
  Object.freeze({ extension: ".png", mime: "image/png", signature: "png" }),
  Object.freeze({ extension: ".jpg", mime: "image/jpeg", signature: "jpeg" }),
  Object.freeze({ extension: ".jpeg", mime: "image/jpeg", signature: "jpeg" }),
  Object.freeze({ extension: ".gif", mime: "image/gif", signature: "gif" }),
  Object.freeze({ extension: ".webp", mime: "image/webp", signature: "webp" }),
  Object.freeze({ extension: ".avif", mime: "image/avif", signature: "avif" }),
])

// Product validation bound: compatible-brand parsing never scans more than one 64 KiB ftyp box.
const AVIF_MAX_FTYP_BOX_BYTES = 64 * 1024
const IMAGE_METADATA_SCAN_BYTES = 1024 * 1024
export const IMAGE_MAX_DECODED_DIMENSION = 16_384
export const IMAGE_MAX_DECODED_PIXELS = 40_000_000
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const UNSAFE_WINDOWS_NAME_PATTERN = /[<>:"/\\|?*]/
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\.|$)/i
const SLUG_PATTERN = new RegExp(`^${KEBAB_SLUG_SOURCE}$`)

function invalidImage(): AppError {
  return { code: "IMAGE_LIBRARY_INVALID", message: "The image is invalid." }
}

function imageTooLarge(): AppError {
  return { code: "IMAGE_LIBRARY_TOO_LARGE", message: "The image dimensions are too large." }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function uint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1]
}

function uint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x1_0000
}

function uint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x1_0000 +
    bytes[offset + 3] * 0x1_000000
  )
}

function uint64(bytes: Uint8Array, offset: number): number | undefined {
  const high = uint32(bytes, offset)
  if (high > 0x1f_ffff) return undefined
  return high * 0x1_0000_0000 + uint32(bytes, offset + 4)
}

function hasAvifBrand(bytes: Uint8Array, brand: "avif" | "avis"): boolean {
  if (bytes.length < 16 || !hasAscii(bytes, 4, "ftyp")) return false
  const shortSize = uint32(bytes, 0)
  const extended = shortSize === 1
  if (extended && bytes.length < 24) return false
  const boxSize = shortSize === 0 ? bytes.length : extended ? uint64(bytes, 8) : shortSize
  if (boxSize === undefined) return false
  const majorBrandOffset = extended ? 16 : 8
  const compatibleBrandsOffset = extended ? 24 : 16
  if (
    boxSize < compatibleBrandsOffset ||
    boxSize > AVIF_MAX_FTYP_BOX_BYTES ||
    boxSize > bytes.length ||
    (boxSize - compatibleBrandsOffset) % 4 !== 0
  )
    return false
  if (
    hasAscii(bytes, majorBrandOffset, brand)
  )
    return true
  for (let offset = compatibleBrandsOffset; offset < boxSize; offset += 4) {
    if (hasAscii(bytes, offset, brand)) return true
  }
  return false
}

function isAvif(bytes: Uint8Array): boolean {
  return hasAvifBrand(bytes, "avif") || hasAvifBrand(bytes, "avis")
}

function matchesSignature(bytes: Uint8Array, signature: Signature): boolean {
  switch (signature) {
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case "gif":
      return hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")
    case "webp":
      return hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")
    case "avif":
      return isAvif(bytes)
  }
}

export interface BoundedImageMetadata {
  readonly width: number
  readonly height: number
  readonly mime: ImageFormat["mime"]
}

function boundedDimensions(
  width: number,
  height: number,
  mime: ImageFormat["mime"],
): BoundedImageMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw invalidImage()
  if (
    width > IMAGE_MAX_DECODED_DIMENSION ||
    height > IMAGE_MAX_DECODED_DIMENSION ||
    width > Math.floor(IMAGE_MAX_DECODED_PIXELS / height)
  )
    throw imageTooLarge()
  return { width, height, mime }
}

/** Applies the same allocation limits used by the bounded container readers. */
export function validateBoundedImageDimensions(
  width: number,
  height: number,
  mime: ImageFormat["mime"],
): BoundedImageMetadata {
  return boundedDimensions(width, height, mime)
}

function boundedFrame(
  width: number,
  height: number,
  x: number,
  y: number,
  canvas: BoundedImageMetadata,
): void {
  const frame = boundedDimensions(width, height, canvas.mime)
  if (x > canvas.width - frame.width || y > canvas.height - frame.height) throw invalidImage()
}

function pngMetadata(bytes: Uint8Array): BoundedImageMetadata {
  if (bytes.length < 33 || uint32(bytes, 8) !== 13 || !hasAscii(bytes, 12, "IHDR"))
    throw invalidImage()
  const metadata = boundedDimensions(uint32(bytes, 16), uint32(bytes, 20), "image/png")
  let offset = 8
  let hasImageData = false
  // Framing is sufficient for the pre-decode allocation gate; the native decoder validates CRCs.
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw invalidImage()
    const length = uint32(bytes, offset)
    const data = offset + 8
    const end = data + length
    if (!Number.isSafeInteger(end) || end + 4 > bytes.length) throw invalidImage()
    if (hasAscii(bytes, offset + 4, "IHDR") && (offset !== 8 || length !== 13)) throw invalidImage()
    if (hasAscii(bytes, offset + 4, "IDAT")) hasImageData ||= length > 0
    if (hasAscii(bytes, offset + 4, "fcTL")) {
      if (length !== 26) throw invalidImage()
      boundedFrame(uint32(bytes, data + 4), uint32(bytes, data + 8), uint32(bytes, data + 12), uint32(bytes, data + 16), metadata)
    }
    if (hasAscii(bytes, offset + 4, "IEND")) {
      if (length !== 0 || !hasImageData || end + 4 !== bytes.length) throw invalidImage()
      return metadata
    }
    offset = end + 4
  }
  throw invalidImage()
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function jpegMetadata(bytes: Uint8Array): BoundedImageMetadata {
  const limit = Math.min(bytes.length, IMAGE_METADATA_SCAN_BYTES)
  let offset = 2
  let metadata: BoundedImageMetadata | undefined
  let sawScan = false
  let entropyBytes = 0
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw invalidImage()
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) throw invalidImage()
    const marker = bytes[offset++]
    if (marker === 0xd9) {
      if (metadata === undefined || !sawScan || entropyBytes === 0) throw invalidImage()
      return metadata
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      throw invalidImage()
    if (offset + 2 > bytes.length || (metadata === undefined && offset + 2 > limit))
      throw invalidImage()
    const length = uint16(bytes, offset)
    const end = offset + length
    if (length < 2 || end > bytes.length || (metadata === undefined && end > limit))
      throw invalidImage()
    if (JPEG_START_OF_FRAME.has(marker)) {
      const components = bytes[offset + 7]
      if (length !== 8 + components * 3 || components === 0 || metadata !== undefined)
        throw invalidImage()
      metadata = boundedDimensions(uint16(bytes, offset + 5), uint16(bytes, offset + 3), "image/jpeg")
    } else if (marker === 0xda) {
      const components = bytes[offset + 2]
      if (metadata === undefined || components === 0 || length !== 6 + components * 2)
        throw invalidImage()
      sawScan = true
      offset = end
      let nextMarker: number | undefined
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          entropyBytes += 1
          offset += 1
          continue
        }
        const markerStart = offset
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
        if (offset >= bytes.length) throw invalidImage()
        const entropyMarker = bytes[offset]
        if (entropyMarker === 0x00) {
          entropyBytes += 1
          offset += 1
          continue
        }
        if (entropyMarker >= 0xd0 && entropyMarker <= 0xd7) {
          offset += 1
          continue
        }
        offset = markerStart
        nextMarker = entropyMarker
        break
      }
      if (nextMarker === undefined) throw invalidImage()
      continue
    }
    offset = end
  }
  throw invalidImage()
}

function gifMetadata(bytes: Uint8Array): BoundedImageMetadata {
  if (bytes.length < 13) throw invalidImage()
  const metadata = boundedDimensions(uint16LittleEndian(bytes, 6), uint16LittleEndian(bytes, 8), "image/gif")
  let offset = 13
  if ((bytes[10] & 0x80) !== 0) offset += 3 * (1 << ((bytes[10] & 0x07) + 1))
  if (offset > bytes.length) throw invalidImage()
  let hasImage = false
  const subBlocks = (): void => {
    while (offset < bytes.length) {
      const length = bytes[offset++]
      if (length === 0) return
      if (offset + length > bytes.length) throw invalidImage()
      offset += length
    }
    throw invalidImage()
  }
  while (offset < bytes.length) {
    const block = bytes[offset++]
    if (block === 0x3b) {
      if (!hasImage || offset !== bytes.length) throw invalidImage()
      return metadata
    }
    if (block === 0x21) {
      if (offset + 2 > bytes.length) throw invalidImage()
      offset += 1
      const size = bytes[offset++]
      if (offset + size > bytes.length) throw invalidImage()
      offset += size
      subBlocks()
      continue
    }
    if (block !== 0x2c || offset + 9 > bytes.length) throw invalidImage()
    const imageLeft = uint16LittleEndian(bytes, offset)
    const imageTop = uint16LittleEndian(bytes, offset + 2)
    const imageWidth = uint16LittleEndian(bytes, offset + 4)
    const imageHeight = uint16LittleEndian(bytes, offset + 6)
    const packed = bytes[offset + 8]
    boundedFrame(imageWidth, imageHeight, imageLeft, imageTop, metadata)
    offset += 9
    if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1))
    if (offset >= bytes.length || bytes[offset++] < 2) throw invalidImage()
    subBlocks()
    hasImage = true
  }
  throw invalidImage()
}

interface HeaderBudget {
  inspected: number
}

function inspectHeader(budget: HeaderBudget, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || budget.inspected > IMAGE_METADATA_SCAN_BYTES - count)
    throw invalidImage()
  budget.inspected += count
}

function webpEnd(offset: number, size: number, end: number): number {
  const value = offset + size
  if (!Number.isSafeInteger(value) || value > end) throw invalidImage()
  return value
}

function webpFramePayload(
  bytes: Uint8Array,
  typeOffset: number,
  data: number,
  size: number,
  frame: BoundedImageMetadata,
  budget: HeaderBudget,
): void {
  if (hasAscii(bytes, typeOffset, "VP8 ")) {
    if (size < 10 || !startsWith(bytes.subarray(data + 3), [0x9d, 0x01, 0x2a])) throw invalidImage()
    inspectHeader(budget, 10)
    const width = uint16LittleEndian(bytes, data + 6) & 0x3fff
    const height = uint16LittleEndian(bytes, data + 8) & 0x3fff
    if (width !== frame.width || height !== frame.height) throw invalidImage()
    return
  }
  if (hasAscii(bytes, typeOffset, "VP8L")) {
    if (size < 5 || bytes[data] !== 0x2f) throw invalidImage()
    inspectHeader(budget, 5)
    const bits = uint32LittleEndian(bytes, data + 1)
    const width = (bits & 0x3fff) + 1
    const height = (Math.floor(bits / 0x4000) & 0x3fff) + 1
    if (width !== frame.width || height !== frame.height) throw invalidImage()
    return
  }
  throw invalidImage()
}

function webpAnimationFrame(
  bytes: Uint8Array,
  data: number,
  end: number,
  canvas: BoundedImageMetadata,
  budget: HeaderBudget,
): void {
  if (end - data < 16) throw invalidImage()
  inspectHeader(budget, 16)
  const x = uint24LittleEndian(bytes, data) * 2
  const y = uint24LittleEndian(bytes, data + 3) * 2
  const width = uint24LittleEndian(bytes, data + 6) + 1
  const height = uint24LittleEndian(bytes, data + 9) + 1
  boundedFrame(width, height, x, y, canvas)
  const frame = { width, height, mime: "image/webp" } as const
  let offset = data + 16
  let hasImage = false
  while (offset < end) {
    if (offset + 8 > end) throw invalidImage()
    inspectHeader(budget, 8)
    const size = uint32LittleEndian(bytes, offset + 4)
    const payload = offset + 8
    const payloadEnd = webpEnd(payload, size, end)
    if (hasAscii(bytes, offset, "VP8 ") || hasAscii(bytes, offset, "VP8L")) {
      if (hasImage) throw invalidImage()
      webpFramePayload(bytes, offset, payload, size, frame, budget)
      hasImage = true
    } else if (hasAscii(bytes, offset, "ALPH") && size === 0) throw invalidImage()
    offset = webpEnd(payloadEnd, size & 1, end)
  }
  if (!hasImage) throw invalidImage()
}

function webpMetadata(bytes: Uint8Array): BoundedImageMetadata {
  if (bytes.length < 20) throw invalidImage()
  const riffEnd = uint32LittleEndian(bytes, 4) + 8
  if (!Number.isSafeInteger(riffEnd) || riffEnd < 20 || riffEnd !== bytes.length) throw invalidImage()
  const budget: HeaderBudget = { inspected: 0 }
  let offset = 12
  let metadata: BoundedImageMetadata | undefined
  let animation = false
  let animationHeader = false
  let animationFrame = false
  let hasStaticImage = false
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) throw invalidImage()
    inspectHeader(budget, 8)
    const size = uint32LittleEndian(bytes, offset + 4)
    const data = offset + 8
    const end = webpEnd(data, size, riffEnd)
    if (hasAscii(bytes, offset, "VP8X")) {
      if (size !== 10 || metadata !== undefined) throw invalidImage()
      inspectHeader(budget, 10)
      animation = (bytes[data] & 0x02) !== 0
      metadata = boundedDimensions(
        uint24LittleEndian(bytes, data + 4) + 1,
        uint24LittleEndian(bytes, data + 7) + 1,
        "image/webp",
      )
    } else if (hasAscii(bytes, offset, "ANIM")) {
      if (!animation || animationHeader || size !== 6) throw invalidImage()
      inspectHeader(budget, 6)
      animationHeader = true
    } else if (hasAscii(bytes, offset, "ANMF")) {
      if (!animation || metadata === undefined) throw invalidImage()
      webpAnimationFrame(bytes, data, end, metadata, budget)
      animationFrame = true
    } else if (hasAscii(bytes, offset, "VP8 ") || hasAscii(bytes, offset, "VP8L")) {
      if (animation || hasStaticImage) throw invalidImage()
      if (hasAscii(bytes, offset, "VP8 ")) {
        if (size < 10 || !startsWith(bytes.subarray(data + 3), [0x9d, 0x01, 0x2a])) throw invalidImage()
        inspectHeader(budget, 10)
        const width = uint16LittleEndian(bytes, data + 6) & 0x3fff
        const height = uint16LittleEndian(bytes, data + 8) & 0x3fff
        metadata ??= boundedDimensions(width, height, "image/webp")
        if (metadata.width !== width || metadata.height !== height) throw invalidImage()
      } else {
        if (size < 5 || bytes[data] !== 0x2f) throw invalidImage()
        inspectHeader(budget, 5)
        const bits = uint32LittleEndian(bytes, data + 1)
        const width = (bits & 0x3fff) + 1
        const height = (Math.floor(bits / 0x4000) & 0x3fff) + 1
        metadata ??= boundedDimensions(width, height, "image/webp")
        if (metadata.width !== width || metadata.height !== height) throw invalidImage()
      }
      hasStaticImage = true
    }
    offset = webpEnd(end, size & 1, riffEnd)
  }
  if (
    offset !== riffEnd ||
    metadata === undefined ||
    (animation ? !animationHeader || !animationFrame : !hasStaticImage)
  )
    throw invalidImage()
  return metadata
}

interface IsoBox {
  readonly type: string
  readonly data: number
  readonly end: number
}

const ISO_MAX_BOXES = 8_192
const ISO_MAX_NESTING = 16

interface IsoWalkState extends HeaderBudget {
  boxes: number
  hasMediaData: boolean
  av01Entries: number
  requiresAv01Sample: boolean
}

function isoBox(bytes: Uint8Array, offset: number, parentEnd: number, state: IsoWalkState): IsoBox {
  if (offset + 8 > parentEnd || offset + 8 > bytes.length) throw invalidImage()
  if (state.boxes >= ISO_MAX_BOXES) throw invalidImage()
  state.boxes += 1
  inspectHeader(state, 8)
  const shortSize = uint32(bytes, offset)
  let header = 8
  let size: number | undefined = shortSize
  if (shortSize === 1) {
    if (offset + 16 > parentEnd || offset + 16 > bytes.length) throw invalidImage()
    header = 16
    inspectHeader(state, 8)
    size = uint64(bytes, offset + 8)
  } else if (shortSize === 0) size = parentEnd - offset
  if (size === undefined || !Number.isSafeInteger(size) || size < header) throw invalidImage()
  const boxEnd = offset + size
  if (!Number.isSafeInteger(boxEnd) || boxEnd > parentEnd || boxEnd > bytes.length)
    throw invalidImage()
  return {
    type: String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    ),
    data: offset + header,
    end: boxEnd,
  }
}

function av1SampleEntry(
  bytes: Uint8Array,
  entry: IsoBox,
  found: Array<{ width: number; height: number }>,
  state: IsoWalkState,
): void {
  const visualSampleEntryBytes = 78
  if (entry.end - entry.data < visualSampleEntryBytes) throw invalidImage()
  inspectHeader(state, visualSampleEntryBytes)
  const width = uint16(bytes, entry.data + 24)
  const height = uint16(bytes, entry.data + 26)
  boundedDimensions(width, height, "image/avif")
  found.push({ width, height })
  let offset = entry.data + visualSampleEntryBytes
  let configurationBoxes = 0
  while (offset < entry.end) {
    const child = isoBox(bytes, offset, entry.end, state)
    if (child.type === "av1C") {
      if (configurationBoxes !== 0 || child.end - child.data < 4) throw invalidImage()
      inspectHeader(state, 4)
      if (bytes[child.data] !== 0x81) throw invalidImage()
      configurationBoxes += 1
    }
    offset = child.end
  }
  if (offset !== entry.end || configurationBoxes !== 1) throw invalidImage()
  state.av01Entries += 1
}

function sampleDescriptionBox(
  bytes: Uint8Array,
  box: IsoBox,
  found: Array<{ width: number; height: number }>,
  state: IsoWalkState,
): void {
  if (box.end - box.data < 8) throw invalidImage()
  inspectHeader(state, 8)
  if (bytes[box.data] !== 0 || bytes[box.data + 1] !== 0 || bytes[box.data + 2] !== 0 || bytes[box.data + 3] !== 0)
    throw invalidImage()
  const entryCount = uint32(bytes, box.data + 4)
  if (entryCount === 0 || entryCount > ISO_MAX_BOXES) throw invalidImage()
  let offset = box.data + 8
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const entry = isoBox(bytes, offset, box.end, state)
    if (entry.type !== "av01") throw invalidImage()
    av1SampleEntry(bytes, entry, found, state)
    offset = entry.end
  }
  if (offset !== box.end) throw invalidImage()
}

function collectAvifDimensions(
  bytes: Uint8Array,
  start: number,
  end: number,
  container: "top" | "meta" | "iprp" | "ipco" | "moov" | "trak" | "mdia" | "minf" | "stbl",
  found: Array<{ width: number; height: number }>,
  state: IsoWalkState,
  depth: number,
): void {
  if (depth > ISO_MAX_NESTING) throw invalidImage()
  let offset = start
  let hasTrackHeader = false
  let hasMedia = false
  let hasMediaInformation = false
  let hasSampleTable = false
  let hasSampleDescription = false
  while (offset < end) {
    const box = isoBox(bytes, offset, end, state)
    if (box.end <= offset) throw invalidImage()
    if (container === "top" && box.type === "meta") {
      if (box.data + 4 > box.end) throw invalidImage()
      inspectHeader(state, 4)
      collectAvifDimensions(bytes, box.data + 4, box.end, "meta", found, state, depth + 1)
    } else if (container === "meta" && box.type === "iprp") {
      collectAvifDimensions(bytes, box.data, box.end, "iprp", found, state, depth + 1)
    } else if (container === "iprp" && box.type === "ipco") {
      collectAvifDimensions(bytes, box.data, box.end, "ipco", found, state, depth + 1)
    } else if (container === "ipco" && box.type === "ispe") {
      if (box.data + 12 !== box.end) throw invalidImage()
      inspectHeader(state, 12)
      found.push({ width: uint32(bytes, box.data + 4), height: uint32(bytes, box.data + 8) })
    } else if (container === "top" && box.type === "moov" && state.requiresAv01Sample) {
      collectAvifDimensions(bytes, box.data, box.end, "moov", found, state, depth + 1)
    } else if (container === "moov" && box.type === "trak") {
      collectAvifDimensions(bytes, box.data, box.end, "trak", found, state, depth + 1)
    } else if (container === "trak" && box.type === "tkhd") {
      if (hasTrackHeader || hasMedia) throw invalidImage()
      const payloadSize = box.end - box.data
      if (payloadSize !== 84 && payloadSize !== 96) throw invalidImage()
      inspectHeader(state, 12)
      hasTrackHeader = true
    } else if (container === "trak" && box.type === "mdia") {
      if (!hasTrackHeader || hasMedia) throw invalidImage()
      collectAvifDimensions(bytes, box.data, box.end, "mdia", found, state, depth + 1)
      hasMedia = true
    } else if (container === "mdia" && box.type === "minf") {
      if (hasMediaInformation) throw invalidImage()
      collectAvifDimensions(bytes, box.data, box.end, "minf", found, state, depth + 1)
      hasMediaInformation = true
    } else if (container === "minf" && box.type === "stbl") {
      if (hasSampleTable) throw invalidImage()
      collectAvifDimensions(bytes, box.data, box.end, "stbl", found, state, depth + 1)
      hasSampleTable = true
    } else if (container === "stbl" && box.type === "stsd") {
      if (hasSampleDescription) throw invalidImage()
      sampleDescriptionBox(bytes, box, found, state)
      hasSampleDescription = true
    } else if (container === "top" && box.type === "mdat") {
      if (box.data === box.end) throw invalidImage()
      state.hasMediaData = true
    }
    offset = box.end
  }
  if (offset !== end) throw invalidImage()
  if (
    (container === "trak" && (!hasTrackHeader || !hasMedia)) ||
    (container === "mdia" && !hasMediaInformation) ||
    (container === "minf" && !hasSampleTable) ||
    (container === "stbl" && !hasSampleDescription)
  )
    throw invalidImage()
}

function avifMetadata(bytes: Uint8Array): BoundedImageMetadata {
  const found: Array<{ width: number; height: number }> = []
  const requiresAv01Sample = hasAvifBrand(bytes, "avis")
  const state: IsoWalkState = {
    inspected: 0,
    boxes: 0,
    hasMediaData: false,
    av01Entries: 0,
    requiresAv01Sample,
  }
  collectAvifDimensions(bytes, 0, bytes.length, "top", found, state, 0)
  if (
    found.length === 0 ||
    !state.hasMediaData ||
    (requiresAv01Sample && state.av01Entries === 0)
  )
    throw invalidImage()
  let maximum = boundedDimensions(found[0].width, found[0].height, "image/avif")
  for (const dimensions of found.slice(1)) {
    const candidate = boundedDimensions(dimensions.width, dimensions.height, "image/avif")
    if (candidate.width * candidate.height > maximum.width * maximum.height) maximum = candidate
  }
  return maximum
}

/** Reads only bounded container metadata and never invokes an image decoder. */
export function readBoundedImageMetadata(bytes: Uint8Array): BoundedImageMetadata {
  if (matchesSignature(bytes, "png")) return pngMetadata(bytes)
  if (matchesSignature(bytes, "jpeg")) return jpegMetadata(bytes)
  if (matchesSignature(bytes, "gif")) return gifMetadata(bytes)
  if (matchesSignature(bytes, "webp")) return webpMetadata(bytes)
  if (matchesSignature(bytes, "avif")) return avifMetadata(bytes)
  throw invalidImage()
}

function formatForName(name: string): FormatDefinition | undefined {
  const lowerName = name.toLowerCase()
  return IMAGE_FORMATS.find(({ extension }) => lowerName.endsWith(extension))
}

function imageFormat(format: FormatDefinition): ImageFormat {
  switch (format.extension) {
    case ".png":
      return { extension: format.extension, mime: format.mime }
    case ".jpg":
      return { extension: format.extension, mime: format.mime }
    case ".jpeg":
      return { extension: format.extension, mime: format.mime }
    case ".gif":
      return { extension: format.extension, mime: format.mime }
    case ".webp":
      return { extension: format.extension, mime: format.mime }
    case ".avif":
      return { extension: format.extension, mime: format.mime }
  }
}

export function normalizeImageName(name: string): string {
  const format = formatForName(name)
  if (
    name.length === 0 ||
    name.length > IMAGE_LIBRARY_MAX_NAME_LENGTH ||
    format === undefined ||
    name.length === format.extension.length ||
    name === "." ||
    name === ".." ||
    UNSAFE_WINDOWS_NAME_PATTERN.test(name) ||
    CONTROL_CHARACTER_PATTERN.test(name) ||
    /[. ]$/.test(name) ||
    WINDOWS_DEVICE_NAME_PATTERN.test(name)
  )
    throw invalidImage()
  return name
}

export function detectImageFormat(bytes: Uint8Array, name: string): ImageFormat {
  const safeName = normalizeImageName(name)
  const format = formatForName(safeName)
  if (format === undefined || !matchesSignature(bytes, format.signature)) throw invalidImage()
  return imageFormat(format)
}

export function markdownForImage(slug: string, name: string): string {
  if (!SLUG_PATTERN.test(slug)) throw invalidImage()
  const safeName = normalizeImageName(name)
  const format = formatForName(safeName)
  if (format === undefined) throw invalidImage()
  const stem = safeName.slice(0, -format.extension.length)
  const alt = stem.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
  const destinationName = safeName.replace(/%/g, "%25").replace(/#/g, "%23")
  return `![${alt}](<../_assets/${slug}/${destinationName}>)`
}

export function imageDataUrl(mime: ImageFormat["mime"], bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}
