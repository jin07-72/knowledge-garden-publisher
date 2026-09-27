import { z } from "zod"
import { APP_ERROR_CODES, IPC_CHANNELS, type AppError, type IpcResult } from "./contracts"

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
  })
  .strip()
  .transform(({ code, message, path }) => {
    return {
      code,
      message,
      ...(path === undefined ? {} : { path }),
    }
  })
const workspaceInspectionSchema = z.discriminatedUnion("ok", [
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

export const previewProgressSchema = previewStatusSchema
export const beforeCloseSchema = z.object({ requestId: z.string().uuid() }).strict()
export const closeBlockedSchema = z.object({ message: z.string().min(1).max(1_000) }).strict()

type RequestChannel = (typeof IPC_CHANNELS.requests)[keyof typeof IPC_CHANNELS.requests]

export const IPC_SUCCESS_SCHEMAS = {
  [IPC_CHANNELS.requests.workspaceInspect]: workspaceInspectionSchema,
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
} satisfies Record<RequestChannel, z.ZodType>

export function ipcResultSchema<T>(success: z.ZodType<T>): z.ZodType<IpcResult<T>> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: success }).strict(),
    z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
  ]) as z.ZodType<IpcResult<T>>
}
