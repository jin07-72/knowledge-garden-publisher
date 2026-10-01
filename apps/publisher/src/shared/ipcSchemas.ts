import { z } from "zod"
import {
  APP_ERROR_CODES,
  IPC_CHANNELS,
  parseGitHubRepositoryUrl,
  type AppError,
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
const blogIdSchema = z.string().uuid()
const blogUrlSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 2_048)
  .refine((value) => parseGitHubRepositoryUrl(value) !== undefined)

export const blogIdRequestSchema = z.object({ id: blogIdSchema }).strict()
export const blogPathRequestSchema = z.object({ path: blogPathSchema }).strict()
export const blogAddLocalRequestSchema = z
  .object({ path: blogPathSchema, name: blogNameSchema })
  .strict()
export const blogCloneRequestSchema = z
  .object({ url: blogUrlSchema, destination: blogPathSchema, name: blogNameSchema })
  .strict()
export const blogRenameRequestSchema = z.object({ id: blogIdSchema, name: blogNameSchema }).strict()
export const blogRelocateRequestSchema = z.object({ id: blogIdSchema, path: blogPathSchema }).strict()
export const blogSwitchRequestSchema = blogIdRequestSchema

export const appErrorSchema = z
  .object({
    code: z.enum(APP_ERROR_CODES),
    message: z.string().min(1).max(1_000),
    details: z.unknown().optional(),
  })
  .strip()
  .transform(({ code, message }): AppError => ({ code, message }) as AppError)

const pathSchema = z.string().min(1).max(512)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
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
    domain: z.enum(["technology", "reading", "language", "life"]),
    slug: z.string().min(1).max(128),
    title: z.string().min(1).max(256),
    date: z.string().min(1).max(64),
    description: z.string().min(1).max(2_000),
    visibility: z.enum(["public", "private"]),
    updatedAt: z.string().min(1).max(64),
    tags: z.array(z.string().min(1).max(128)).min(1).max(100),
  })
  .strip()
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
const loopbackUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === "http:" && url.hostname === "127.0.0.1"
  })
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
    name: blogNameSchema,
    path: blogPathSchema,
    canonicalPath: blogPathSchema,
    createdAt: z.string().datetime(),
    lastOpenedAt: z.string().datetime(),
  })
  .strip()
const blogRegistryViewSchema = z
  .object({ version: z.literal(1), activeBlogId: blogIdSchema, blogs: z.array(blogRecordSchema).min(1).max(1_000) })
  .strip()
const blogCandidateInspectionSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true), canonicalPath: blogPathSchema, needsInstall: z.boolean() }).strip(),
  z.object({ valid: z.literal(false), code: z.string().min(1).max(128), message: z.string().min(1).max(1_000) }).strip(),
])
const blogCandidateSelectionSchema = z
  .object({ path: blogPathSchema, inspection: blogCandidateInspectionSchema })
  .strip()
const blogImportReceiptSchema = z
  .object({ canonicalPath: blogPathSchema, owner: z.string().min(1).max(39), repository: z.string().min(1).max(100) })
  .strip()
export const blogImportProgressSchema = z
  .object({ phase: z.enum(["cloning", "installing", "validating", "complete"]), message: z.string().min(1).max(1_000) })
  .strict()

export const previewProgressSchema = previewStatusSchema
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
  [IPC_CHANNELS.requests.previewStart]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewStop]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewStatus]: previewStatusSchema,
  [IPC_CHANNELS.requests.changesList]: changeReviewSchema,
  [IPC_CHANNELS.requests.changesCancel]: z.undefined(),
  [IPC_CHANNELS.requests.publishStart]: publishStartReceiptSchema,
  [IPC_CHANNELS.requests.publishCancel]: z.undefined(),
  [IPC_CHANNELS.requests.historyGit]: z.array(gitCommitSchema).max(500),
  [IPC_CHANNELS.requests.historyDeployments]: deploymentHistorySchema,
  [IPC_CHANNELS.requests.historyCancel]: z.undefined(),
  [IPC_CHANNELS.requests.historyOpenLink]: z.undefined(),
  [IPC_CHANNELS.requests.lifecycleCloseAck]: z.undefined(),
  [IPC_CHANNELS.requests.blogsList]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsChooseLocal]: blogCandidateSelectionSchema.optional(),
  [IPC_CHANNELS.requests.blogsAddLocal]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsClone]: blogImportReceiptSchema,
  [IPC_CHANNELS.requests.blogsCancelImport]: z.undefined(),
  [IPC_CHANNELS.requests.blogsInstall]: blogCandidateInspectionSchema,
  [IPC_CHANNELS.requests.blogsRename]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsRelocate]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsRemove]: blogRegistryViewSchema,
  [IPC_CHANNELS.requests.blogsOpenFolder]: z.undefined(),
  [IPC_CHANNELS.requests.blogsSwitch]: z.undefined(),
} satisfies Record<RequestChannel, z.ZodType>

export function ipcResultSchema<T>(success: z.ZodType<T>): z.ZodType<IpcResult<T>> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: success }).strict(),
    z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
  ]) as z.ZodType<IpcResult<T>>
}
