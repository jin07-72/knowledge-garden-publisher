import { z } from "zod"
import type { AppearanceSettings } from "./appearance"
import {
  APP_ERROR_CODES,
  IMAGE_LIBRARY_MAX_GALLERY_THUMBNAIL_TOTAL_LENGTH,
  IMAGE_LIBRARY_MAX_ITEMS,
  IMAGE_LIBRARY_MAX_NAME_LENGTH,
  IMAGE_LIBRARY_MAX_PREVIEW_DATA_URL_LENGTH,
  IMAGE_LIBRARY_MAX_PREVIEW_DECODED_BYTES,
  IMAGE_LIBRARY_MAX_SELECTION_ITEMS,
  IMAGE_LIBRARY_MAX_SELECTION_NAME_TOTAL_LENGTH,
  IMAGE_LIBRARY_MAX_SELECTION_THUMBNAIL_TOTAL_LENGTH,
  IMAGE_LIBRARY_MAX_THUMBNAIL_DATA_URL_LENGTH,
  IMAGE_LIBRARY_MAX_THUMBNAIL_DECODED_BYTES,
  IPC_CHANNELS,
  KEBAB_SLUG_SOURCE,
  MANAGED_NOTE_PATH_PATTERN,
  parseGitHubRepositoryUrl,
  type AppearanceApplyReceipt,
  type AppearanceApplyRequest,
  type AppearanceBackgroundSelection,
  type AppearanceClearPreviewRequest,
  type AppearancePreviewReceipt,
  type AppearancePreviewRequest,
  type AppearanceSnapshot,
  type AppearanceUndoRequest,
  type AppError,
  type DomainPublicErrorCode,
  type IpcResult,
} from "./contracts"

export const MAX_MARKDOWN_UTF8_BYTES = 16 * 1024 * 1024
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) bytes += 1
    else if (unit <= 0x7ff) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}
export const markdownSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= MAX_MARKDOWN_UTF8_BYTES)

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/
const windowsAbsolutePathPattern = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/
const blogPathSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 1_024)
  .refine((value) => windowsAbsolutePathPattern.test(value))
  .refine((value) => !controlCharacterPattern.test(value))
const blogNameSchema = z
  .string()
  .max(80)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !controlCharacterPattern.test(value))
  .transform((value) => value.trim())
const optionalBlogNameSchema = z
  .string()
  .max(80)
  .refine((value) => !controlCharacterPattern.test(value))
  .transform((value) => value.trim())
const blogResponseNameSchema = z
  .string()
  .max(80)
  .refine((value) => value.trim().length > 0)
  .refine((value) => value === value.trim())
  .refine((value) => !controlCharacterPattern.test(value))
const blogIdSchema = z.string().uuid()
const blogUrlSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 2_048)
  .refine((value) => parseGitHubRepositoryUrl(value) !== undefined)
const websiteUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => !controlCharacterPattern.test(value))
const websiteUpdateUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => !controlCharacterPattern.test(value))

const RESERVED_DOMAIN_SLUGS = new Set(["index", "content", "private", "garden-publisher"])
export const domainSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(new RegExp(`^${KEBAB_SLUG_SOURCE}$`))
  .refine((value) => !RESERVED_DOMAIN_SLUGS.has(value))
export const domainNameSchema = z.string().trim().min(1).max(80)
const domainDescriptionSchema = z
  .string()
  .max(2_000)
  .refine((value) => value === value.trim())
const domainTagSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim())
const domainTagsSchema = z
  .array(domainTagSchema)
  .max(100)
  .refine((tags) => new Set(tags).size === tags.length)
export const domainCreateSchema = z
  .object({ name: domainNameSchema, slug: domainSlugSchema })
  .strict()
export const domainRenameSchema = z
  .object({ slug: domainSlugSchema, name: domainNameSchema })
  .strict()
export const domainUpdateMetadataSchema = z
  .object({
    slug: domainSlugSchema,
    description: domainDescriptionSchema,
    tags: domainTagsSchema,
  })
  .strict()
export const domainRemoveSchema = z.object({ slug: domainSlugSchema }).strict()
export const domainSummarySchema = z
  .object({
    slug: domainSlugSchema,
    name: domainNameSchema,
    description: domainDescriptionSchema,
    tags: domainTagsSchema,
    order: z.number().int().nonnegative(),
    publicNotes: z.number().int().nonnegative(),
    privateNotes: z.number().int().nonnegative(),
  })
  .strict()

export const blogIdRequestSchema = z.object({ id: blogIdSchema }).strict()
export const blogPathRequestSchema = z.object({ path: blogPathSchema }).strict()
export const blogAddLocalRequestSchema = z
  .object({ path: blogPathSchema, name: blogNameSchema })
  .strict()
export const blogCloneRequestSchema = z
  .object({
    url: blogUrlSchema,
    destination: blogPathSchema,
    name: optionalBlogNameSchema.optional(),
  })
  .strict()
export const blogRenameRequestSchema = z.object({ id: blogIdSchema, name: blogNameSchema }).strict()
export const blogRelocateRequestSchema = z
  .object({ id: blogIdSchema, path: blogPathSchema })
  .strict()
export const blogSwitchRequestSchema = z
  .object({ id: blogIdSchema, editorSaved: z.literal(true) })
  .strict()
export const blogWebsiteUpdateRequestSchema = z
  .object({ id: blogIdSchema, websiteUrl: websiteUpdateUrlSchema.nullable() })
  .strict()
export const blogLinkOpenRequestSchema = z
  .object({ id: blogIdSchema, kind: z.enum(["repository", "website"]) })
  .strict()

// Domain failures may contain workspace paths and transaction diagnostics internally.
// Main IPC and preload both use this schema, so neither forwards their raw messages.
const domainPublicErrorMessages: Readonly<Partial<Record<AppError["code"], string>>> = {
  DOMAIN_ALREADY_EXISTS: "A domain with that name or path already exists.",
  DOMAIN_BUSY: "A domain operation is still in progress. Try again when it finishes.",
  DOMAIN_DISPOSED: "Domain management is unavailable. Reopen the workspace.",
  DOMAIN_NOT_FOUND: "The requested domain no longer exists. Refresh the domain list.",
  DOMAIN_NOT_EMPTY: "The domain contents changed. Review them and try again.",
  DOMAIN_ORDER_EXHAUSTED: "No safe domain order remains for a new domain.",
  DOMAIN_ROLLBACK_UNCERTAIN:
    "The domain operation could not be safely recovered. Review the workspace before retrying.",
  DOMAIN_METADATA_INVALID: "A domain page has invalid metadata. Correct it before retrying.",
  DOMAIN_UNSAFE_PATH: "An unsafe or changed domain path was rejected.",
} satisfies Record<DomainPublicErrorCode, string>

const imageLibraryPublicErrorMessages: Readonly<Partial<Record<AppError["code"], string>>> = {
  IMAGE_LIBRARY_INVALID: "图片库请求无效，请刷新后重试。",
  IMAGE_LIBRARY_UNSAFE: "图片库路径不安全，已停止操作。",
  IMAGE_LIBRARY_TOO_LARGE: "所选图片超过数量或大小限制。",
  IMAGE_LIBRARY_CONFLICT: "图片名称冲突，请确认后重试。",
  IMAGE_LIBRARY_CHANGED: "图片或笔记已发生变化，请刷新后重试。",
  IMAGE_LIBRARY_FAILED: "图片库操作失败，请重试。",
}

const cleanupWarningMessages: Readonly<Record<string, string>> = {
  LOCK_RELEASE_FAILED: "部分操作锁未能安全释放。",
  CLEANUP_UNCERTAIN: "部分清理状态无法确认，请人工检查后重试。",
  CLEANUP_SYNC_FAILED: "清理后的目录同步失败，请人工检查后重试。",
  CLEANUP_RETAINED: "图片库目录含有外部内容，已安全保留。",
  CLEANUP_FAILED: "部分图片库项目未能安全清理。",
  DELETE_MARKER_UNCERTAIN: "请人工检查图片库占位文件。",
  DELETE_RECOVERY_UNCERTAIN: "请人工检查图片删除恢复记录。",
  DELETE_RECOVERY_COLLISION: "图片删除恢复位置存在冲突，请人工检查。",
  DELETE_CLEANUP_UNCERTAIN: "请人工检查图片删除记录。",
}

function publicCleanupWarnings(
  details: unknown,
): readonly { readonly code: string; readonly message: string }[] | undefined {
  try {
    if (typeof details !== "object" || details === null) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(details, "cleanupWarnings")
    if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
      return undefined
    if (descriptor.value.length === 0 || descriptor.value.length > 32) return undefined
    const warnings: { code: string; message: string }[] = []
    for (const value of descriptor.value) {
      if (typeof value !== "object" || value === null) return undefined
      const code = Object.getOwnPropertyDescriptor(value, "code")
      const message = Object.getOwnPropertyDescriptor(value, "message")
      if (
        !code ||
        !("value" in code) ||
        typeof code.value !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(code.value) ||
        !message ||
        !("value" in message) ||
        typeof message.value !== "string" ||
        message.value.length < 1 ||
        message.value.length > 500
      )
        return undefined
      warnings.push({
        code: code.value,
        message: cleanupWarningMessages[code.value] ?? "部分清理状态需要人工检查。",
      })
    }
    return warnings
  } catch {
    return undefined
  }
}

export const appErrorSchema = z
  .object({
    code: z.enum(APP_ERROR_CODES),
    message: z.string().min(1).max(1_000),
    details: z.unknown().optional(),
  })
  .strip()
  .transform(({ code, message, details }): AppError => {
    const cleanupWarnings = publicCleanupWarnings(details)
    return {
      code,
      message: domainPublicErrorMessages[code] ?? imageLibraryPublicErrorMessages[code] ?? message,
      ...(cleanupWarnings ? { details: { cleanupWarnings } } : {}),
    } as AppError
  })

const pathSchema = z.string().min(1).max(512)
export const managedNotePathSchema = z.string().max(512).regex(MANAGED_NOTE_PATH_PATTERN)
export const noteSlugSchema = z
  .string()
  .max(128)
  .regex(new RegExp(`^${KEBAB_SLUG_SOURCE}$`))
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const windowsDeviceNamePattern =
  /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\.|$)/i
const safeBitmapImageNameSchema = z
  .string()
  .min(1)
  .max(IMAGE_LIBRARY_MAX_NAME_LENGTH)
  .refine((value) => value !== "." && value !== "..")
  .refine((value) => !/[<>:"/\\|?*]/.test(value))
  .refine((value) => !controlCharacterPattern.test(value))
  .refine((value) => !/[. ]$/.test(value))
  .refine((value) => !windowsDeviceNamePattern.test(value))
  .regex(/^.+\.(?:png|jpe?g|gif|webp|avif)$/i)
const appearanceColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const appearanceFontSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim())
  .regex(
    /^(?:"[A-Za-z0-9][A-Za-z0-9 -]*"|'[A-Za-z0-9][A-Za-z0-9 -]*'|[A-Za-z][A-Za-z0-9 -]*)(?:,\s*(?:"[A-Za-z0-9][A-Za-z0-9 -]*"|'[A-Za-z0-9][A-Za-z0-9 -]*'|[A-Za-z][A-Za-z0-9 -]*))*$/,
  )
const appearanceImageNameSchema = safeBitmapImageNameSchema
const appearanceAssetShape = {
  managed: { source: z.literal("managed"), name: appearanceImageNameSchema },
  staged: {
    source: z.literal("staged"),
    token: z.string().uuid(),
    name: appearanceImageNameSchema,
  },
} as const
const appearanceBackgroundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), color: appearanceColorSchema }).strict(),
  z
    .object({
      kind: z.literal("gradient"),
      start: appearanceColorSchema,
      end: appearanceColorSchema,
      angle: z.number().finite().min(0).max(360),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      asset: z.discriminatedUnion("source", [
        z.object(appearanceAssetShape.managed).strict(),
        z.object(appearanceAssetShape.staged).strict(),
      ]),
      overlay: appearanceColorSchema,
      opacity: z.number().finite().min(0).max(1),
      position: z.enum(["center", "top", "bottom"]),
      fixed: z.boolean(),
    })
    .strict(),
])
const appearanceColorsSchema = z
  .object({
    page: appearanceColorSchema,
    surface: appearanceColorSchema,
    text: appearanceColorSchema,
    heading: appearanceColorSchema,
    accent: appearanceColorSchema,
    secondary: appearanceColorSchema,
    border: appearanceColorSchema,
    code: appearanceColorSchema,
  })
  .strict()
const appearanceTypographySchema = z
  .object({
    header: appearanceFontSchema,
    body: appearanceFontSchema,
    code: appearanceFontSchema,
    baseSizePx: z.number().finite().min(10).max(32),
    lineHeight: z.number().finite().min(1).max(3),
  })
  .strict()
const appearanceLayoutSchema = z
  .object({
    articleWidthCh: z.number().finite().min(32).max(120),
    pageWidthPx: z.number().finite().min(640).max(2_560),
    sidebarWidthPx: z.number().finite().min(160).max(640),
    sidebars: z.enum(["both", "left", "none"]),
    gapPx: z.number().finite().min(0).max(128),
  })
  .strict()
const appearanceCustomCssSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= 64 * 1024)
  .refine((value) => !value.includes("\u0000"))
  .refine((value) => !/<\/style/i.test(value))
export const appearanceSettingsSchema: z.ZodType<AppearanceSettings> = z
  .object({
    schemaVersion: z.literal(1),
    preset: z.enum(["knowledge-garden", "paper", "minimal", "custom"]),
    background: appearanceBackgroundSchema,
    colors: appearanceColorsSchema,
    typography: appearanceTypographySchema,
    layout: appearanceLayoutSchema,
    customCss: appearanceCustomCssSchema,
  })
  .strict()
const imageNameSchema = safeBitmapImageNameSchema
const imageDataUrlHeaderPattern = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/
const base64PayloadPattern = /^[A-Za-z0-9+/]*={0,2}$/
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function hasCanonicalBase64Padding(payload: string): boolean {
  if (payload.endsWith("==")) return (base64Alphabet.indexOf(payload.at(-3)!) & 0x0f) === 0
  if (payload.endsWith("=")) return (base64Alphabet.indexOf(payload.at(-2)!) & 0x03) === 0
  return true
}
function canonicalBase64Payload(value: string): string | undefined {
  const header = imageDataUrlHeaderPattern.exec(value)?.[0]
  if (header === undefined) return undefined
  const payload = value.slice(header.length)
  if (payload.length === 0 || payload.length % 4 !== 0 || !base64PayloadPattern.test(payload))
    return undefined
  return hasCanonicalBase64Padding(payload) ? payload : undefined
}
function decodedBase64ByteLength(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return (payload.length / 4) * 3 - padding
}
const imageDataUrlSchema = (maxLength: number, maxDecodedBytes: number) =>
  z.string().superRefine((value, context) => {
    if (value.length > maxLength) {
      context.addIssue({ code: "custom", message: "Image data URL exceeds the encoded limit." })
      return
    }
    const payload = canonicalBase64Payload(value)
    if (payload === undefined) {
      context.addIssue({ code: "custom", message: "Image data URL is not canonical Base64." })
      return
    }
    if (decodedBase64ByteLength(payload) > maxDecodedBytes)
      context.addIssue({ code: "custom", message: "Image data exceeds the decoded byte limit." })
  })
const thumbnailDataUrlSchema = imageDataUrlSchema(
  IMAGE_LIBRARY_MAX_THUMBNAIL_DATA_URL_LENGTH,
  IMAGE_LIBRARY_MAX_THUMBNAIL_DECODED_BYTES,
)
const previewDataUrlSchema = imageDataUrlSchema(
  IMAGE_LIBRARY_MAX_PREVIEW_DATA_URL_LENGTH,
  IMAGE_LIBRARY_MAX_PREVIEW_DECODED_BYTES,
)
const uniqueImageNames = (names: readonly string[]) =>
  new Set(names.map((name) => name.toLowerCase())).size === names.length
const totalThumbnailLength = (images: readonly { readonly thumbnailDataUrl: string }[]) =>
  images.reduce((total, image) => total + image.thumbnailDataUrl.length, 0)
const missingDataProperty = Symbol("missing-data-property")
function ownDataProperty(value: object, key: PropertyKey): unknown | typeof missingDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : missingDataProperty
}
function hasRawThumbnailBudget(value: unknown, maxCount: number, maxTotalLength: number): boolean {
  try {
    if (typeof value !== "object" || value === null) return false
    const images = ownDataProperty(value, "images")
    if (!Array.isArray(images)) return false
    const length = ownDataProperty(images, "length")
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length > maxCount)
      return false
    let totalLength = 0
    for (let index = 0; index < length; index += 1) {
      const item = ownDataProperty(images, index)
      if (typeof item !== "object" || item === null) return false
      const thumbnail = ownDataProperty(item, "thumbnailDataUrl")
      if (typeof thumbnail !== "string") return false
      totalLength += thumbnail.length
      if (totalLength > maxTotalLength) return false
    }
    return true
  } catch {
    return false
  }
}

export const imageLibraryPathRequestSchema = z.object({ path: managedNotePathSchema }).strict()
export const imageLibraryItemRequestSchema = z
  .object({
    path: managedNotePathSchema,
    name: imageNameSchema,
    expectedContentHash: hashSchema.optional(),
  })
  .strict()
export const imageLibraryDeleteRequestSchema = imageLibraryItemRequestSchema.extend({
  expectedContentHash: hashSchema,
})
export const imageLibraryCommitRequestSchema = z
  .object({
    path: managedNotePathSchema,
    selectionId: z.string().uuid(),
    include: z.array(imageNameSchema).min(1).max(IMAGE_LIBRARY_MAX_SELECTION_ITEMS),
    overwrite: z.array(imageNameSchema).max(IMAGE_LIBRARY_MAX_SELECTION_ITEMS),
  })
  .strict()
  .refine(({ include }) => uniqueImageNames(include), { path: ["include"] })
  .refine(
    ({ include }) =>
      include.reduce((total, name) => total + utf8ByteLength(name), 0) <=
      IMAGE_LIBRARY_MAX_SELECTION_NAME_TOTAL_LENGTH,
    { path: ["include"] },
  )
  .refine(({ overwrite }) => uniqueImageNames(overwrite), { path: ["overwrite"] })
  .refine(
    ({ include, overwrite }) => {
      const included = new Set(include.map((name) => name.toLowerCase()))
      return overwrite.every((name) => included.has(name.toLowerCase()))
    },
    { path: ["overwrite"] },
  )

const imageLibraryItemSchema = z
  .object({
    name: imageNameSchema,
    sizeBytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    contentHash: hashSchema,
    thumbnailDataUrl: thumbnailDataUrlSchema,
    markdown: z.string().min(1).max(2_048),
  })
  .strip()
const imageLibraryViewDetailedSchema = z
  .object({
    path: managedNotePathSchema,
    images: z.array(imageLibraryItemSchema).max(IMAGE_LIBRARY_MAX_ITEMS),
  })
  .strip()
  .refine(
    ({ images }) =>
      totalThumbnailLength(images) <= IMAGE_LIBRARY_MAX_GALLERY_THUMBNAIL_TOTAL_LENGTH,
    { path: ["images"] },
  )
const imageLibraryViewSchema = z
  .unknown()
  .refine(
    (value) =>
      hasRawThumbnailBudget(
        value,
        IMAGE_LIBRARY_MAX_ITEMS,
        IMAGE_LIBRARY_MAX_GALLERY_THUMBNAIL_TOTAL_LENGTH,
      ),
    { path: ["images"] },
  )
  .pipe(imageLibraryViewDetailedSchema)
const selectedImageLibraryItemSchema = imageLibraryItemSchema.extend({ conflict: z.boolean() })
const imageLibrarySelectionSchema = z
  .unknown()
  .refine(
    (value) =>
      hasRawThumbnailBudget(
        value,
        IMAGE_LIBRARY_MAX_SELECTION_ITEMS,
        IMAGE_LIBRARY_MAX_SELECTION_THUMBNAIL_TOTAL_LENGTH,
      ),
    { path: ["images"] },
  )
  .pipe(
    z.discriminatedUnion("cancelled", [
      z
        .object({
          cancelled: z.literal(true),
          selectionId: z.undefined().optional(),
          images: z.array(selectedImageLibraryItemSchema).max(0),
          conflicts: z.array(imageNameSchema).max(0),
        })
        .strip()
        .refine((selection) => !Object.prototype.hasOwnProperty.call(selection, "selectionId")),
      z
        .object({
          cancelled: z.literal(false),
          selectionId: z.string().uuid(),
          images: z
            .array(selectedImageLibraryItemSchema)
            .min(1)
            .max(IMAGE_LIBRARY_MAX_SELECTION_ITEMS),
          conflicts: z
            .array(imageNameSchema)
            .max(IMAGE_LIBRARY_MAX_SELECTION_ITEMS)
            .refine(uniqueImageNames),
        })
        .strip()
        .refine(({ images }) => uniqueImageNames(images.map(({ name }) => name)), {
          path: ["images"],
        })
        .refine(
          ({ images }) =>
            totalThumbnailLength(images) <= IMAGE_LIBRARY_MAX_SELECTION_THUMBNAIL_TOTAL_LENGTH,
          { path: ["images"] },
        )
        .refine(
          ({ images, conflicts }) => {
            const expected = images.filter(({ conflict }) => conflict).map(({ name }) => name)
            return (
              expected.length === conflicts.length &&
              expected.every((name, index) => conflicts[index] === name)
            )
          },
          { path: ["conflicts"] },
        ),
    ]),
  )
const imageLibraryPreviewSchema = z
  .object({
    name: imageNameSchema,
    sizeBytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    contentHash: hashSchema,
    markdown: z.string().min(1).max(2_048),
    dataUrl: previewDataUrlSchema,
  })
  .strip()
const warningSchema = z
  .object({ code: z.string().min(1).max(128), message: z.string().min(1).max(1_000) })
  .strip()
const capabilitiesSchema = z
  .object({ files: z.boolean(), preview: z.boolean(), git: z.boolean(), publish: z.boolean() })
  .strip()
const workspaceIssueSchema = z
  .object({
    code: z.enum(APP_ERROR_CODES),
    message: z.string().min(1).max(1_000),
    details: z.unknown().optional(),
    path: pathSchema.optional(),
    repair: z.literal("install-dependencies").optional(),
  })
  .strip()
  .transform(({ code, message, path, repair }) => {
    return {
      code,
      message,
      ...(path === undefined ? {} : { path }),
      ...(repair === undefined ? {} : { repair }),
    }
  })
export const workspaceInspectionSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      root: pathSchema,
      capabilities: capabilitiesSchema,
      issues: z.tuple([]),
    })
    .strip(),
  z
    .object({
      ok: z.literal(false),
      root: pathSchema,
      capabilities: capabilitiesSchema,
      issues: z.array(workspaceIssueSchema).max(100),
    })
    .strip(),
])
const workspaceRepairReceiptSchema = z
  .object({
    action: z.literal("install-dependencies"),
    message: z.string().min(1).max(1_000),
  })
  .strip()
const noteSummarySchema = z
  .object({
    path: pathSchema,
    domain: domainSlugSchema,
    slug: noteSlugSchema,
    title: z.string().min(1).max(256),
    date: z.string().min(1).max(64),
    description: z.string().min(1).max(2_000),
    visibility: z.enum(["public", "private"]),
    updatedAt: z.string().min(1).max(64),
    tags: z.array(z.string().min(1).max(128)).min(1).max(100),
  })
  .strip()
export const noteCreateSchema = z
  .object({
    visibility: z.enum(["public", "private"]),
    domain: domainSlugSchema,
    slug: noteSlugSchema,
    title: z.string().trim().min(1).max(256),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    body: markdownSchema.optional(),
  })
  .strict()
export const noteRenameSchema = z
  .object({
    path: managedNotePathSchema,
    newDomain: domainSlugSchema.optional(),
    newSlug: noteSlugSchema.optional(),
  })
  .strict()
  .refine((request) => request.newDomain !== undefined || request.newSlug !== undefined)
const noteDocumentSchema = z
  .object({
    path: pathSchema,
    markdown: markdownSchema,
    mtimeMs: z.number().finite().nonnegative(),
    contentHash: hashSchema,
  })
  .strip()
const noteWriteReceiptSchema = z
  .object({
    path: pathSchema,
    updatedAt: z.string().min(1).max(64),
    mtimeMs: z.number().finite().nonnegative(),
    contentHash: hashSchema,
    warnings: z.array(warningSchema).max(100).optional(),
  })
  .strip()
const noteRecoverySchema = z
  .object({
    path: pathSchema,
    markdown: markdownSchema,
    baseMtimeMs: z.number().finite().nonnegative(),
    baseContentHash: hashSchema,
    createdAt: z.string().datetime(),
    contentHash: hashSchema,
  })
  .strip()
const noteTransactionReceiptSchema = z
  .object({
    id: z.string().min(1).max(128),
    changedPaths: z.array(pathSchema).max(1_000),
    linkEditedPaths: z.array(pathSchema).max(1_000).optional(),
    pendingPublicDeletion: pathSchema.optional(),
    historyWarning: z.boolean(),
    warnings: z.array(warningSchema).max(100),
  })
  .strip()
const noteTrashReceiptSchema = z
  .object({
    path: pathSchema,
    pendingPublicDeletion: pathSchema.optional(),
    historyWarning: z.boolean(),
    attachmentCleanup: z.discriminatedUnion("status", [
      z.object({ status: z.enum(["trashed", "not-found"]) }).strict(),
      z
        .object({
          status: z.enum(["retained-ambiguous", "failed"]),
          message: z.string().min(1).max(1_000),
        })
        .strict(),
    ]),
  })
  .strip()
const literalLoopbackAuthorityPattern = /^http:\/\/127\.0\.0\.1(?::([0-9]+))?(?:[/?#]|$)/
const loopbackUrlSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= 2_048)
  .url()
  .refine((value) => {
    const authority = literalLoopbackAuthorityPattern.exec(value)
    if (authority === null) return false
    const rawPort = authority[1]
    if (rawPort !== undefined) {
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return false
    }
    try {
      const url = new URL(value)
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.username === "" &&
        url.password === ""
      )
    } catch {
      return false
    }
  })
const appearanceResponseAssetSchema = z.discriminatedUnion("source", [
  z.object(appearanceAssetShape.managed).strip(),
  z.object(appearanceAssetShape.staged).strip(),
])
const appearanceResponseBackgroundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), color: appearanceColorSchema }).strip(),
  z
    .object({
      kind: z.literal("gradient"),
      start: appearanceColorSchema,
      end: appearanceColorSchema,
      angle: z.number().finite().min(0).max(360),
    })
    .strip(),
  z
    .object({
      kind: z.literal("image"),
      asset: appearanceResponseAssetSchema,
      overlay: appearanceColorSchema,
      opacity: z.number().finite().min(0).max(1),
      position: z.enum(["center", "top", "bottom"]),
      fixed: z.boolean(),
    })
    .strip(),
])
const appearanceResponseSettingsSchema: z.ZodType<AppearanceSettings> = z
  .object({
    schemaVersion: z.literal(1),
    preset: z.enum(["knowledge-garden", "paper", "minimal", "custom"]),
    background: appearanceResponseBackgroundSchema,
    colors: appearanceColorsSchema.strip(),
    typography: appearanceTypographySchema.strip(),
    layout: appearanceLayoutSchema.strip(),
    customCss: appearanceCustomCssSchema,
  })
  .strip()
const appearanceSnapshotSchema: z.ZodType<AppearanceSnapshot> = z
  .object({
    framework: z.enum(["quartz", "hugo", "hexo", "unknown"]),
    supported: z.boolean(),
    settings: appearanceResponseSettingsSchema,
    baselineHash: hashSchema,
    canUndo: z.boolean(),
    message: z.string().min(1).max(1_000).optional(),
  })
  .strip()
const appearanceBackgroundSelectionSchema: z.ZodType<AppearanceBackgroundSelection> = z
  .object({
    source: z.literal("staged"),
    token: z.string().uuid(),
    name: appearanceImageNameSchema,
  })
  .strip()
const appearancePreviewReceiptSchema: z.ZodType<AppearancePreviewReceipt> = z
  .object({ sessionId: z.string().uuid() })
  .strip()
const appearanceApplyReceiptSchema: z.ZodType<AppearanceApplyReceipt> = z
  .object({ snapshot: appearanceSnapshotSchema })
  .strip()
export const appearancePreviewRequestSchema: z.ZodType<AppearancePreviewRequest> = z
  .object({
    url: loopbackUrlSchema,
    sessionId: z.string().uuid(),
    settings: appearanceSettingsSchema,
  })
  .strict()
export const appearanceClearPreviewRequestSchema: z.ZodType<AppearanceClearPreviewRequest> = z
  .object({ sessionId: z.string().uuid() })
  .strict()
export const appearanceApplyRequestSchema: z.ZodType<AppearanceApplyRequest> = z
  .object({ settings: appearanceSettingsSchema, baselineHash: hashSchema })
  .strict()
export const appearanceUndoRequestSchema: z.ZodType<AppearanceUndoRequest> = z
  .object({ baselineHash: hashSchema })
  .strict()
const previewStatusSchema = z
  .object({
    state: z.enum(["stopped", "starting", "ready", "building", "error", "stopping"]),
    generation: z.number().int().nonnegative(),
    port: z.number().int().min(1).max(65_535).optional(),
    url: loopbackUrlSchema.optional(),
    lastSuccessfulUrl: loopbackUrlSchema.optional(),
    error: appErrorSchema.optional(),
  })
  .strip()
const changeGroupSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(512),
    kind: z.enum(["added", "modified", "unpublish", "attachment", "private", "config"]),
    selection: z.enum(["default", "optional", "locked"]),
    description: z.string().min(1).max(1_000),
    paths: z.array(pathSchema).max(500),
    attachments: z
      .array(z.object({ path: pathSchema, label: z.string().min(1).max(512) }).strip())
      .max(500),
  })
  .strip()
const changeReviewSchema = z
  .object({
    groups: z.array(changeGroupSchema).max(1_000),
    blockedReason: z.string().min(1).max(1_000).optional(),
  })
  .strip()
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 512 * 1024)
const publishStartReceiptSchema = z.object({ operationId: z.string().min(1).max(128) }).strip()
const publishBranchRepairReceiptSchema = z
  .object({
    branch: z.literal("main"),
    upstream: z.literal("origin/main"),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .strip()
const gitCommitSchema = z
  .object({
    id: z.string().min(1).max(128),
    authoredAt: z.string().min(1).max(64),
    subject: z.string().min(1).max(1_000),
    author: z.string().min(1).max(256).optional(),
  })
  .strip()
const deploymentRunSchema = z
  .object({
    id: z.string().min(1).max(128),
    headSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    startedAt: z.string().min(1).max(64),
    completedAt: z.string().min(1).max(64).optional(),
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    url: z.string().url().max(2_048).optional(),
    error: appErrorSchema.optional(),
  })
  .strip()
const githubUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => new URL(value).protocol === "https:" && new URL(value).hostname === "github.com",
  )
const liveSiteUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === "https:")
const deploymentHistorySchema = z
  .object({
    runs: z.array(deploymentRunSchema).max(100),
    actionsUrl: githubUrlSchema,
    liveSiteUrl: liveSiteUrlSchema,
    unavailableMessage: z.string().min(1).max(500).optional(),
  })
  .strip()

export const publishProgressSchema = z
  .object({
    phase: z.enum(["validating", "committing", "pushing", "deploying", "complete", "failed"]),
    message: z.string().max(2_000),
    percent: z.number().min(0).max(100).optional(),
  })
  .strip()

const blogRecordSchema = z
  .object({
    id: blogIdSchema,
    name: blogResponseNameSchema,
    path: blogPathSchema,
    canonicalPath: blogPathSchema,
    createdAt: z.string().datetime(),
    lastOpenedAt: z.string().datetime(),
    websiteUrl: websiteUrlSchema.optional(),
  })
  .strip()
const blogDisplayRecordSchema = z
  .object({
    id: blogIdSchema,
    name: blogResponseNameSchema,
    path: blogPathSchema,
    canonicalPath: blogPathSchema,
    createdAt: z.string().datetime(),
    lastOpenedAt: z.string().datetime(),
    repository: z
      .object({ display: z.string().min(1).max(2_048), url: websiteUrlSchema.optional() })
      .strip(),
    website: z.discriminatedUnion("source", [
      z.object({ source: z.enum(["manual", "quartz"]), url: websiteUrlSchema }).strip(),
      z.object({ source: z.literal("unconfigured") }).strip(),
    ]),
  })
  .strip()
const blogRegistryViewSchema = z
  .object({
    version: z.literal(1),
    activeBlogId: blogIdSchema,
    blogs: z.array(blogDisplayRecordSchema).min(1).max(1_000),
  })
  .strip()
const blogRegistryStatusSchema = blogRegistryViewSchema.extend({
  activeAvailability: z.enum(["available", "unavailable"]),
})
const blogCandidateInspectionSchema = z.discriminatedUnion("valid", [
  z
    .object({ valid: z.literal(true), canonicalPath: blogPathSchema, needsInstall: z.boolean() })
    .strip(),
  z
    .object({
      valid: z.literal(false),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(1_000),
    })
    .strip(),
])
const blogCandidateSelectionSchema = z
  .object({ path: blogPathSchema, inspection: blogCandidateInspectionSchema })
  .strip()
const blogImportReceiptSchema = z
  .object({
    canonicalPath: blogPathSchema,
    owner: z.string().min(1).max(39),
    repository: z.string().min(1).max(100),
  })
  .strip()
export const blogImportProgressSchema = z
  .object({
    phase: z.enum(["cloning", "installing", "validating", "complete"]),
    message: z.string().min(1).max(1_000),
  })
  .strict()

export const previewProgressSchema = previewStatusSchema
export const previewRevealRequestSchema = z
  .object({
    url: loopbackUrlSchema,
    text: z.string().trim().min(1).max(4_096),
    positionRatio: z.number().finite().min(0).max(1),
  })
  .strict()
export const beforeCloseSchema = z.object({ requestId: z.string().uuid() }).strict()
export const closeBlockedSchema = z.object({ message: z.string().min(1).max(1_000) }).strict()
export const trashRecoveryUpdateSchema = z
  .object({
    restored: z.array(pathSchema).max(1_024),
    conflicts: z.array(pathSchema).max(1_024),
  })
  .strict()

type RequestChannel = (typeof IPC_CHANNELS.requests)[keyof typeof IPC_CHANNELS.requests]

export const IPC_SUCCESS_SCHEMAS = {
  [IPC_CHANNELS.requests.workspaceInspectSafety]: workspaceInspectionSchema,
  [IPC_CHANNELS.requests.workspaceInspect]: workspaceInspectionSchema,
  [IPC_CHANNELS.requests.workspaceRepair]: workspaceRepairReceiptSchema,
  [IPC_CHANNELS.requests.domainsList]: z.array(domainSummarySchema).max(1_000),
  [IPC_CHANNELS.requests.domainsCreate]: z.array(domainSummarySchema).max(1_000),
  [IPC_CHANNELS.requests.domainsRename]: z.array(domainSummarySchema).max(1_000),
  [IPC_CHANNELS.requests.domainsUpdateMetadata]: z.array(domainSummarySchema).max(1_000),
  [IPC_CHANNELS.requests.domainsRemove]: z.array(domainSummarySchema).max(1_000),
  [IPC_CHANNELS.requests.notesList]: z.array(noteSummarySchema).max(100_000),
  [IPC_CHANNELS.requests.notesRead]: noteDocumentSchema,
  [IPC_CHANNELS.requests.notesSave]: noteWriteReceiptSchema,
  [IPC_CHANNELS.requests.notesCreate]: noteWriteReceiptSchema,
  [IPC_CHANNELS.requests.notesRename]: noteTransactionReceiptSchema,
  [IPC_CHANNELS.requests.notesChangeVisibility]: noteTransactionReceiptSchema,
  [IPC_CHANNELS.requests.notesTrash]: noteTrashReceiptSchema,
  [IPC_CHANNELS.requests.notesRecoveryGet]: noteRecoverySchema.optional(),
  [IPC_CHANNELS.requests.notesRecoveryWrite]: z.object({ contentHash: hashSchema }).strip(),
  [IPC_CHANNELS.requests.notesRecoveryDiscard]: z.undefined(),
  [IPC_CHANNELS.requests.imagesOpen]: imageLibraryViewSchema,
  [IPC_CHANNELS.requests.imagesSelect]: imageLibrarySelectionSchema,
  [IPC_CHANNELS.requests.imagesCommit]: imageLibraryViewSchema,
  [IPC_CHANNELS.requests.imagesPreview]: imageLibraryPreviewSchema,
  [IPC_CHANNELS.requests.imagesDelete]: imageLibraryViewSchema,
  [IPC_CHANNELS.requests.imagesCopyMarkdown]: z.undefined(),
  [IPC_CHANNELS.requests.previewStart]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewStop]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewStatus]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewRevealSelection]: z.enum(["found", "not-found", "not-ready"]),
  [IPC_CHANNELS.requests.appearanceRead]: appearanceSnapshotSchema,
  [IPC_CHANNELS.requests.appearanceChooseBackground]: appearanceBackgroundSelectionSchema.optional(),
  [IPC_CHANNELS.requests.appearancePreview]: appearancePreviewReceiptSchema,
  [IPC_CHANNELS.requests.appearanceClearPreview]: z.undefined(),
  [IPC_CHANNELS.requests.appearanceApply]: appearanceApplyReceiptSchema,
  [IPC_CHANNELS.requests.appearanceUndo]: appearanceApplyReceiptSchema,
  [IPC_CHANNELS.requests.changesList]: changeReviewSchema,
  [IPC_CHANNELS.requests.changesCancel]: z.undefined(),
  [IPC_CHANNELS.requests.publishStart]: publishStartReceiptSchema,
  [IPC_CHANNELS.requests.publishRepairBranch]: publishBranchRepairReceiptSchema,
  [IPC_CHANNELS.requests.publishCancel]: z.undefined(),
  [IPC_CHANNELS.requests.historyGit]: z.array(gitCommitSchema).max(500),
  [IPC_CHANNELS.requests.historyDeployments]: deploymentHistorySchema,
  [IPC_CHANNELS.requests.historyClearCache]: z.undefined(),
  [IPC_CHANNELS.requests.historyCancel]: z.undefined(),
  [IPC_CHANNELS.requests.historyOpenLink]: z.undefined(),
  [IPC_CHANNELS.requests.lifecycleCloseAck]: z.undefined(),
  [IPC_CHANNELS.requests.blogsList]: blogRegistryStatusSchema,
  [IPC_CHANNELS.requests.blogsChooseLocal]: blogCandidateSelectionSchema.optional(),
  [IPC_CHANNELS.requests.blogsAddLocal]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsRecoverLocal]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsClone]: blogImportReceiptSchema,
  [IPC_CHANNELS.requests.blogsCancelImport]: z.undefined(),
  [IPC_CHANNELS.requests.blogsInstall]: blogCandidateInspectionSchema,
  [IPC_CHANNELS.requests.blogsRename]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsRelocate]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsRemove]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsOpenFolder]: z.undefined(),
  [IPC_CHANNELS.requests.blogsUpdateWebsite]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsOpenLink]: z.undefined(),
  [IPC_CHANNELS.requests.blogsSwitch]: z.undefined(),
} satisfies Record<RequestChannel, z.ZodType>

export function ipcResultSchema<T>(success: z.ZodType<T>): z.ZodType<IpcResult<T>> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: success }).strict(),
    z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
  ]) as z.ZodType<IpcResult<T>>
}
