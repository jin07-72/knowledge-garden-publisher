import { z } from "zod"
import { APP_ERROR_CODES, IPC_CHANNELS, type AppError, type IpcResult } from "./contracts"

const MAX_DETAILS_BYTES = 4_096
const MAX_DETAILS_DEPTH = 4
const MAX_DETAILS_KEYS = 32
const MAX_DETAILS_ARRAY = 32
const MAX_DETAILS_STRING_BYTES = 512
const OMITTED = Symbol("omitted")
const unsafeDetailKeys = new Set([
  "command",
  "cwd",
  "env",
  "stack",
  "stderr",
  "stdout",
  "token",
  "password",
  "secret",
])

interface DetailBudget {
  remainingBytes: number
  remainingKeys: number
  readonly ancestors: WeakSet<object>
}

function boundedString(value: string, budget: DetailBudget): string | typeof OMITTED {
  if (budget.remainingBytes <= 0) return OMITTED
  const bytes = Buffer.from(value, "utf8")
  const maximum = Math.min(MAX_DETAILS_STRING_BYTES, budget.remainingBytes)
  const sliced = bytes
    .subarray(0, maximum)
    .toString("utf8")
    .replace(/\uFFFD+$/, "")
  budget.remainingBytes -= Buffer.byteLength(sliced, "utf8")
  return sliced
}

function safeDetailValue(
  value: unknown,
  budget: DetailBudget,
  depth: number,
): unknown | typeof OMITTED {
  if (depth > MAX_DETAILS_DEPTH || budget.remainingBytes <= 0) return OMITTED
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : OMITTED
  if (typeof value === "string") return boundedString(value, budget)
  if (typeof value !== "object") return OMITTED
  if (budget.ancestors.has(value)) return "[circular]"
  budget.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const entry of value.slice(0, MAX_DETAILS_ARRAY)) {
        const safe = safeDetailValue(entry, budget, depth + 1)
        if (safe !== OMITTED) result.push(safe)
      }
      return result
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (
        budget.remainingKeys <= 0 ||
        !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) ||
        unsafeDetailKeys.has(key.toLowerCase())
      ) {
        continue
      }
      const safeKey = boundedString(key, budget)
      if (safeKey === OMITTED) break
      let entry: unknown
      try {
        entry = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const safe = safeDetailValue(entry, budget, depth + 1)
      if (safe === OMITTED) continue
      budget.remainingKeys -= 1
      result[safeKey] = safe
    }
    return result
  } finally {
    budget.ancestors.delete(value)
  }
}

function safeDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  try {
    const safe = safeDetailValue(
      value,
      {
        remainingBytes: MAX_DETAILS_BYTES,
        remainingKeys: MAX_DETAILS_KEYS,
        ancestors: new WeakSet(),
      },
      0,
    )
    if (safe === OMITTED || typeof safe !== "object" || safe === null || Array.isArray(safe))
      return undefined
    const record = safe as Readonly<Record<string, unknown>>
    return Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_DETAILS_BYTES
      ? record
      : { truncated: true }
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
    const sanitized = safeDetails(details)
    return sanitized === undefined || Object.keys(sanitized).length === 0
      ? ({ code, message } as AppError)
      : ({ code, message, details: sanitized } as AppError)
  })

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
  .transform(({ code, message, details, path }) => {
    const sanitized = safeDetails(details)
    return {
      code,
      message,
      ...(sanitized === undefined || Object.keys(sanitized).length === 0
        ? {}
        : { details: sanitized }),
      ...(path === undefined ? {} : { path }),
    }
  })
const workspaceInspectionSchema = z
  .object({
    ok: z.boolean(),
    root: pathSchema,
    capabilities: capabilitiesSchema,
    issues: z.array(workspaceIssueSchema).max(100),
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
    markdown: z.string().max(16 * 1024 * 1024),
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
    paths: z.array(pathSchema).max(10_000),
  })
  .strip()
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
    startedAt: z.string().min(1).max(64),
    completedAt: z.string().min(1).max(64).optional(),
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    url: z.string().url().max(2_048).optional(),
    error: appErrorSchema.optional(),
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
  [IPC_CHANNELS.requests.previewStart]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewStop]: previewStatusSchema,
  [IPC_CHANNELS.requests.previewStatus]: previewStatusSchema,
  [IPC_CHANNELS.requests.changesList]: z.array(changeGroupSchema).max(10_000),
  [IPC_CHANNELS.requests.publishStart]: publishStartReceiptSchema,
  [IPC_CHANNELS.requests.publishCancel]: z.undefined(),
  [IPC_CHANNELS.requests.historyGit]: z.array(gitCommitSchema).max(500),
  [IPC_CHANNELS.requests.historyDeployments]: z.array(deploymentRunSchema).max(500),
} satisfies Record<RequestChannel, z.ZodType>

export function ipcResultSchema<T>(success: z.ZodType<T>): z.ZodType<IpcResult<T>> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: success }).strict(),
    z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
  ]) as z.ZodType<IpcResult<T>>
}
