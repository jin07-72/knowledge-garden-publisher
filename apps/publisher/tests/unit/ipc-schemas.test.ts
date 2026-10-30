import { describe, expect, it } from "vitest"
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance"
import {
  type AppError,
  IMAGE_LIBRARY_MAX_GALLERY_THUMBNAIL_TOTAL_LENGTH,
  IMAGE_LIBRARY_MAX_ITEMS,
  IMAGE_LIBRARY_MAX_NAME_LENGTH,
  IMAGE_LIBRARY_MAX_PREVIEW_DATA_URL_LENGTH,
  IMAGE_LIBRARY_MAX_PREVIEW_DECODED_BYTES,
  IMAGE_LIBRARY_MAX_SELECTION_ITEMS,
  IMAGE_LIBRARY_MAX_SELECTION_THUMBNAIL_TOTAL_LENGTH,
  IMAGE_LIBRARY_MAX_THUMBNAIL_DATA_URL_LENGTH,
  IMAGE_LIBRARY_MAX_THUMBNAIL_DECODED_BYTES,
  IPC_CHANNELS,
} from "../../src/shared/contracts"
import {
  IPC_SUCCESS_SCHEMAS,
  appErrorSchema,
  blogAddLocalRequestSchema,
  blogCloneRequestSchema,
  blogIdRequestSchema,
  blogImportProgressSchema,
  blogLinkOpenRequestSchema,
  blogPathRequestSchema,
  blogRelocateRequestSchema,
  blogRenameRequestSchema,
  blogSwitchRequestSchema,
  blogWebsiteUpdateRequestSchema,
  domainCreateSchema,
  domainRemoveSchema,
  domainRenameSchema,
  domainUpdateMetadataSchema,
  imageLibraryCommitRequestSchema,
  imageLibraryDeleteRequestSchema,
  imageLibraryItemRequestSchema,
  imageLibraryPathRequestSchema,
  noteCreateSchema,
  noteRenameSchema,
  utf8ByteLength,
} from "../../src/shared/ipcSchemas"

const privateField = { privateSource: "must-not-cross" }

describe("public blog address failures", () => {
  it("accepts the unavailable link error", () => {
    const failure = {
      code: "BLOG_LINK_UNAVAILABLE",
      message: "The requested blog link is unavailable.",
    } as const satisfies AppError
    expect(appErrorSchema.safeParse(failure)).toEqual({ success: true, data: failure })
  })
})

const publishBranchRepairErrors = [
  { code: "PUBLISH_BRANCH_REPAIR_REQUIRED", message: "Branch repair is required." },
  { code: "PUBLISH_BRANCH_REPAIR_BLOCKED", message: "Branch repair is blocked." },
  { code: "PUBLISH_BRANCH_REPAIR_FAILED", message: "Branch repair failed." },
  { code: "PUBLISH_BRANCH_REPAIR_UNCERTAIN", message: "Branch repair is uncertain." },
] as const satisfies readonly AppError[]

describe("publish branch repair failures", () => {
  it.each(publishBranchRepairErrors)("accepts $code as a public application error", (failure) => {
    expect(appErrorSchema.safeParse(failure).success).toBe(true)
  })
})

describe("public domain failures", () => {
  it.each([
    ["DOMAIN_ALREADY_EXISTS", "A domain with that name or path already exists."],
    ["DOMAIN_BUSY", "A domain operation is still in progress. Try again when it finishes."],
    ["DOMAIN_DISPOSED", "Domain management is unavailable. Reopen the workspace."],
    ["DOMAIN_NOT_FOUND", "The requested domain no longer exists. Refresh the domain list."],
    ["DOMAIN_NOT_EMPTY", "The domain contents changed. Review them and try again."],
    ["DOMAIN_ORDER_EXHAUSTED", "No safe domain order remains for a new domain."],
    [
      "DOMAIN_ROLLBACK_UNCERTAIN",
      "The domain operation could not be safely recovered. Review the workspace before retrying.",
    ],
    ["DOMAIN_METADATA_INVALID", "A domain page has invalid metadata. Correct it before retrying."],
    ["DOMAIN_UNSAFE_PATH", "An unsafe or changed domain path was rejected."],
  ])("accepts %s with a fixed message and no private diagnostics", (code, message) => {
    const failure = Object.assign(new Error("C:/private/secret.md contains private note text"), {
      code,
      details: { path: "C:/private/secret.md", source: "private note text" },
      cause: new Error("private cause"),
    })
    expect(appErrorSchema.safeParse(failure)).toEqual({ success: true, data: { code, message } })
  })

  it("rejects an unknown domain failure code", () => {
    expect(
      appErrorSchema.safeParse({ code: "DOMAIN_INTERNAL_SECRET", message: "private" }).success,
    ).toBe(false)
  })
})
const capabilities = { files: true, preview: true, git: false, publish: false }
const note = {
  path: "content/life/daily.md",
  domain: "life",
  slug: "daily",
  title: "Daily",
  date: "2026-09-24",
  description: "Daily note",
  visibility: "public",
  updatedAt: "2026-09-24T00:00:00.000Z",
  tags: ["life"],
  ...privateField,
}
const write = {
  path: "content/life/daily.md",
  updatedAt: "2026-09-24T00:00:00.000Z",
  mtimeMs: 1,
  contentHash: "a".repeat(64),
  ...privateField,
}
const transaction = {
  id: "transaction-1",
  changedPaths: ["content/life/daily.md"],
  historyWarning: false,
  warnings: [],
  ...privateField,
}
const preview = { state: "stopped", generation: 0, ...privateField }
const appearanceSessionId = "22222222-2222-4222-8222-222222222222"
const appearanceSnapshot = {
  framework: "quartz",
  supported: true,
  settings: DEFAULT_APPEARANCE,
  baselineHash: "d".repeat(64),
  canUndo: true,
  ...privateField,
}
const blogId = "11111111-1111-4111-8111-111111111111"
const blog = {
  id: blogId,
  name: "Quartz",
  path: String.raw`C:\\Blogs\\quartz`,
  canonicalPath: String.raw`C:\\Blogs\\quartz`,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastOpenedAt: "2026-10-01T00:00:00.000Z",
  repository: { display: "openai/quartz", url: "https://github.com/openai/quartz" },
  website: { source: "manual", url: "https://example.com/garden/" },
  ...privateField,
}
const blogRegistry = { version: 1, activeBlogId: blogId, blogs: [blog], ...privateField }
const customDomain = {
  slug: "artificial-intelligence",
  name: "人工智能",
  description: "人工智能领域的学习记录。",
  tags: ["ai", "learning"],
  order: 5,
  publicNotes: 2,
  privateNotes: 1,
}

const imageItem = {
  name: "garden.webp",
  sizeBytes: 12_345,
  width: 800,
  height: 600,
  contentHash: "c".repeat(64),
  thumbnailDataUrl: "data:image/webp;base64,AAAA",
  markdown: "![garden](garden.webp)",
}

function imageDataUrlNearLimit(limit: number): string {
  const prefix = "data:image/png;base64,"
  return prefix + "A".repeat(Math.floor((limit - prefix.length) / 4) * 4)
}

const validByChannel: Record<string, unknown> = {
  [IPC_CHANNELS.requests.workspaceInspectSafety]: {
    ok: true,
    root: "C:/garden",
    capabilities,
    issues: [],
    ...privateField,
  },
  [IPC_CHANNELS.requests.workspaceInspect]: {
    ok: true,
    root: "C:/garden",
    capabilities,
    issues: [],
    ...privateField,
  },
  [IPC_CHANNELS.requests.workspaceRepair]: {
    action: "install-dependencies",
    message: "Repository dependencies were installed.",
    ...privateField,
  },
  [IPC_CHANNELS.requests.domainsList]: [customDomain],
  [IPC_CHANNELS.requests.domainsCreate]: [customDomain],
  [IPC_CHANNELS.requests.domainsRename]: [customDomain],
  [IPC_CHANNELS.requests.domainsUpdateMetadata]: [customDomain],
  [IPC_CHANNELS.requests.domainsRemove]: [customDomain],
  [IPC_CHANNELS.requests.notesList]: [note],
  [IPC_CHANNELS.requests.notesRead]: {
    path: "content/life/daily.md",
    markdown: "# Daily",
    mtimeMs: 1,
    contentHash: "a".repeat(64),
    ...privateField,
  },
  [IPC_CHANNELS.requests.notesSave]: write,
  [IPC_CHANNELS.requests.notesCreate]: write,
  [IPC_CHANNELS.requests.notesRename]: transaction,
  [IPC_CHANNELS.requests.notesChangeVisibility]: transaction,
  [IPC_CHANNELS.requests.notesTrash]: {
    path: "content/life/daily.md",
    historyWarning: false,
    attachmentCleanup: { status: "not-found" },
    ...privateField,
  },
  [IPC_CHANNELS.requests.notesRecoveryGet]: {
    path: "content/life/daily.md",
    markdown: "# Unsaved",
    baseMtimeMs: 1,
    baseContentHash: "a".repeat(64),
    createdAt: "2026-09-24T00:00:00.000Z",
    contentHash: "b".repeat(64),
    ...privateField,
  },
  [IPC_CHANNELS.requests.notesRecoveryWrite]: { contentHash: "b".repeat(64), ...privateField },
  [IPC_CHANNELS.requests.notesRecoveryDiscard]: undefined,
  [IPC_CHANNELS.requests.imagesOpen]: {
    path: "content/life/daily.md",
    images: [imageItem],
    ...privateField,
  },
  [IPC_CHANNELS.requests.imagesSelect]: {
    cancelled: false,
    selectionId: "11111111-1111-4111-8111-111111111111",
    images: [{ ...imageItem, conflict: false }],
    conflicts: [],
    ...privateField,
  },
  [IPC_CHANNELS.requests.imagesCommit]: { path: "content/life/daily.md", images: [imageItem] },
  [IPC_CHANNELS.requests.imagesPreview]: {
    name: imageItem.name,
    sizeBytes: imageItem.sizeBytes,
    width: imageItem.width,
    height: imageItem.height,
    contentHash: imageItem.contentHash,
    markdown: imageItem.markdown,
    dataUrl: "data:image/webp;base64,AAAA",
    ...privateField,
  },
  [IPC_CHANNELS.requests.imagesDelete]: { path: "content/life/daily.md", images: [] },
  [IPC_CHANNELS.requests.imagesCopyMarkdown]: undefined,
  [IPC_CHANNELS.requests.previewStart]: preview,
  [IPC_CHANNELS.requests.previewStop]: preview,
  [IPC_CHANNELS.requests.previewStatus]: preview,
  [IPC_CHANNELS.requests.previewRevealSelection]: "found",
  [IPC_CHANNELS.requests.appearanceRead]: appearanceSnapshot,
  [IPC_CHANNELS.requests.appearanceChooseBackground]: {
    source: "staged",
    token: appearanceSessionId,
    name: "background.webp",
    ...privateField,
  },
  [IPC_CHANNELS.requests.appearancePreview]: {
    sessionId: appearanceSessionId,
    ...privateField,
  },
  [IPC_CHANNELS.requests.appearanceClearPreview]: undefined,
  [IPC_CHANNELS.requests.appearanceApply]: { snapshot: appearanceSnapshot, ...privateField },
  [IPC_CHANNELS.requests.appearanceUndo]: { snapshot: appearanceSnapshot, ...privateField },
  [IPC_CHANNELS.requests.changesList]: {
    groups: [
      {
        id: "note:daily",
        label: "Daily",
        kind: "modified",
        selection: "default",
        description: "公开文章已修改",
        paths: ["content/life/daily.md"],
        attachments: [],
        ...privateField,
      },
    ],
    ...privateField,
  },
  [IPC_CHANNELS.requests.publishStart]: { operationId: "publish-1", ...privateField },
  [IPC_CHANNELS.requests.publishRepairBranch]: {
    branch: "main",
    upstream: "origin/main",
    head: "a".repeat(40),
    ...privateField,
  },
  [IPC_CHANNELS.requests.publishCancel]: undefined,
  [IPC_CHANNELS.requests.historyGit]: [
    {
      id: "abcdef",
      authoredAt: "2026-09-24T00:00:00.000Z",
      subject: "Publish",
      ...privateField,
    },
  ],
  [IPC_CHANNELS.requests.historyDeployments]: {
    runs: [
      {
        id: "deploy-1",
        headSha: "a".repeat(40),
        startedAt: "2026-09-24T00:00:00.000Z",
        status: "succeeded",
        ...privateField,
      },
    ],
    actionsUrl: "https://github.com/example/garden/actions/workflows/deploy.yml",
    liveSiteUrl: "https://example.github.io/garden/",
    ...privateField,
  },
  [IPC_CHANNELS.requests.historyCancel]: undefined,
  [IPC_CHANNELS.requests.historyOpenLink]: undefined,
  [IPC_CHANNELS.requests.lifecycleCloseAck]: undefined,
  [IPC_CHANNELS.requests.blogsList]: { ...blogRegistry, activeAvailability: "available" },
  [IPC_CHANNELS.requests.blogsChooseLocal]: {
    path: String.raw`C:\\Blogs\\quartz`,
    inspection: { valid: true, canonicalPath: String.raw`C:\\Blogs\\quartz`, needsInstall: false },
    ...privateField,
  },
  [IPC_CHANNELS.requests.blogsAddLocal]: blogRegistry,
  [IPC_CHANNELS.requests.blogsRecoverLocal]: blogRegistry,
  [IPC_CHANNELS.requests.blogsClone]: {
    canonicalPath: String.raw`C:\\Blogs\\quartz`,
    owner: "openai",
    repository: "quartz",
    ...privateField,
  },
  [IPC_CHANNELS.requests.blogsCancelImport]: undefined,
  [IPC_CHANNELS.requests.blogsInstall]: {
    valid: true,
    canonicalPath: String.raw`C:\\Blogs\\quartz`,
    needsInstall: false,
    ...privateField,
  },
  [IPC_CHANNELS.requests.blogsRename]: blogRegistry,
  [IPC_CHANNELS.requests.blogsRelocate]: blogRegistry,
  [IPC_CHANNELS.requests.blogsRemove]: blogRegistry,
  [IPC_CHANNELS.requests.blogsOpenFolder]: undefined,
  [IPC_CHANNELS.requests.blogsUpdateWebsite]: blogRegistry,
  [IPC_CHANNELS.requests.blogsOpenLink]: undefined,
  [IPC_CHANNELS.requests.blogsSwitch]: undefined,
}

describe("image library IPC schemas", () => {
  it("exports shared image library count and payload limits", () => {
    expect(IMAGE_LIBRARY_MAX_NAME_LENGTH).toBe(255)
    expect(IMAGE_LIBRARY_MAX_ITEMS).toBe(500)
    expect(IMAGE_LIBRARY_MAX_SELECTION_ITEMS).toBe(50)
    expect(IMAGE_LIBRARY_MAX_THUMBNAIL_DATA_URL_LENGTH).toBe(512 * 1024)
    expect(IMAGE_LIBRARY_MAX_PREVIEW_DATA_URL_LENGTH).toBe(36 * 1024 * 1024)
    expect(IMAGE_LIBRARY_MAX_THUMBNAIL_DECODED_BYTES).toBe(512 * 1024)
    expect(IMAGE_LIBRARY_MAX_PREVIEW_DECODED_BYTES).toBe(36 * 1024 * 1024)
    expect(IMAGE_LIBRARY_MAX_GALLERY_THUMBNAIL_TOTAL_LENGTH).toBe(16 * 1024 * 1024)
    expect(IMAGE_LIBRARY_MAX_SELECTION_THUMBNAIL_TOTAL_LENGTH).toBe(8 * 1024 * 1024)
  })

  it("defines one allowlisted request channel for every image capability", () => {
    expect({
      open: IPC_CHANNELS.requests.imagesOpen,
      select: IPC_CHANNELS.requests.imagesSelect,
      commit: IPC_CHANNELS.requests.imagesCommit,
      preview: IPC_CHANNELS.requests.imagesPreview,
      delete: IPC_CHANNELS.requests.imagesDelete,
      copyMarkdown: IPC_CHANNELS.requests.imagesCopyMarkdown,
    }).toEqual({
      open: "garden:images:open",
      select: "garden:images:select",
      commit: "garden:images:commit",
      preview: "garden:images:preview",
      delete: "garden:images:delete",
      copyMarkdown: "garden:images:copy-markdown",
    })
  })

  it("accepts only exact managed note paths in image requests", () => {
    const pathRequest = imageLibraryPathRequestSchema

    expect(pathRequest.safeParse({ path: "content/life/daily.md" }).success).toBe(true)
    expect(pathRequest.safeParse({ path: "private/life/daily.md" }).success).toBe(true)
    for (const path of [
      "content/life/daily.txt",
      "content/life/../daily.md",
      "content//daily.md",
      "C:/garden/content/life/daily.md",
      "content\\life\\daily.md",
      "content/life/daily.md/extra",
    ]) {
      expect(pathRequest.safeParse({ path }).success, path).toBe(false)
    }
    expect(pathRequest.safeParse({ path: "content/life/daily.md", extra: true }).success).toBe(
      false,
    )
  })

  it("accepts safe base image names and rejects traversal, separators, controls, and markup", () => {
    const itemRequest = imageLibraryItemRequestSchema

    expect(
      itemRequest.safeParse({
        path: "content/life/daily.md",
        name: "hero image-01.webp",
        expectedContentHash: "a".repeat(64),
      }).success,
    ).toBe(true)
    for (const name of [
      "",
      ".",
      "..",
      "../hero.png",
      "folder/hero.png",
      "folder\\hero.png",
      "hero\n.png",
      "hero\r.png",
      "hero\0.png",
      "hero>.png",
      "a".repeat(256),
    ]) {
      expect(
        itemRequest.safeParse({ path: "content/life/daily.md", name }).success,
        JSON.stringify(name),
      ).toBe(false)
    }
    expect(
      itemRequest.safeParse({
        path: "content/life/daily.md",
        name: "hero.png",
        expectedContentHash: "A".repeat(64),
      }).success,
    ).toBe(false)
  })

  it("allows only supported image extensions and Windows-safe non-device names", () => {
    const request = (name: string) =>
      imageLibraryItemRequestSchema.safeParse({ path: "content/life/daily.md", name }).success

    for (const name of [
      "photo.png",
      "photo.JPG",
      "photo.JpEg",
      "animation.gif",
      "photo.webp",
      "photo.AVIF",
    ])
      expect(request(name), name).toBe(true)

    for (const name of [
      "photo.svg",
      "photo.png.exe",
      "photo",
      "bad<name.png",
      "bad:name.png",
      'bad"name.png',
      "bad|name.png",
      "bad?name.png",
      "bad*name.png",
      "trailing .png ",
      "trailing..png.",
      "CON.png",
      "con.backup.png",
      "PRN.JPG",
      "aux.gif",
      "NUL.webp",
      "com1.avif",
      "COM9.png",
      "lpt1.jpeg",
      "LPT9.gif",
      "COM¹.png",
      "com².JPG",
      "CoM³.gif",
      "LPT¹.webp",
      "lpt².AVIF",
      "LpT³.jpeg",
    ])
      expect(request(name), name).toBe(false)
  })

  it("requires an exact content hash for permanent deletion requests", () => {
    const request = {
      path: "content/life/daily.md",
      name: "hero.png",
      expectedContentHash: "a".repeat(64),
    }
    expect(imageLibraryDeleteRequestSchema.safeParse(request).success).toBe(true)
    expect(
      imageLibraryDeleteRequestSchema.safeParse({ path: request.path, name: request.name }).success,
    ).toBe(false)
    expect(imageLibraryDeleteRequestSchema.safeParse({ ...request, extra: true }).success).toBe(
      false,
    )
  })

  it("requires UUID selections and bounded, duplicate-free safe include and overwrite lists", () => {
    const commit = imageLibraryCommitRequestSchema

    const valid = {
      path: "content/life/daily.md",
      selectionId: "11111111-1111-4111-8111-111111111111",
      include: ["hero.png", "diagram.avif"],
      overwrite: ["hero.png", "diagram.avif"],
    }
    expect(commit.safeParse(valid).success).toBe(true)
    expect(commit.safeParse({ ...valid, selectionId: "selection-1" }).success).toBe(false)
    expect(commit.safeParse({ ...valid, include: [] }).success).toBe(false)
    expect(commit.safeParse({ ...valid, include: ["hero.png", "HERO.PNG"] }).success).toBe(false)
    expect(commit.safeParse({ ...valid, include: ["../hero.png"] }).success).toBe(false)
    expect(
      commit.safeParse({ ...valid, include: Array.from({ length: 51 }, (_, i) => `${i}.png`) })
        .success,
    ).toBe(false)
    expect(
      commit.safeParse({
        ...valid,
        include: Array.from(
          { length: 50 },
          (_, index) => `${String(index).padStart(3, "0")}-${"a".repeat(247)}.png`,
        ),
      }).success,
    ).toBe(false)
    const { include: _include, ...withoutInclude } = valid
    expect(commit.safeParse(withoutInclude).success).toBe(false)
    expect(commit.safeParse({ ...valid, overwrite: ["hero.png", "hero.png"] }).success).toBe(false)
    expect(
      commit.safeParse({ ...valid, include: ["hero.png"], overwrite: ["HERO.PNG"] }).success,
    ).toBe(true)
    expect(commit.safeParse({ ...valid, overwrite: ["missing.png"] }).success).toBe(false)
    expect(
      commit.safeParse({ ...valid, overwrite: Array.from({ length: 51 }, (_, i) => `${i}.png`) })
        .success,
    ).toBe(false)
    expect(commit.safeParse({ ...valid, overwrite: ["../hero.png"] }).success).toBe(false)
    expect(commit.safeParse({ ...valid, extra: true }).success).toBe(false)
  })

  it("validates bounded library responses and strips private response fields", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesOpen]

    const value = {
      path: "content/life/daily.md",
      images: [{ ...imageItem, privateSourcePath: "C:/garden/content/life/images/garden.webp" }],
      privateSourcePath: "C:/garden/content/life/images",
    }
    expect(schema.safeParse(value)).toEqual({
      success: true,
      data: { path: value.path, images: [imageItem] },
    })
    expect(schema.safeParse({ ...value, path: "content/life/daily.txt" }).success).toBe(false)
    expect(schema.safeParse({ ...value, images: Array(501).fill(imageItem) }).success).toBe(false)
    expect(
      schema.safeParse({ ...value, images: [{ ...imageItem, contentHash: "c".repeat(63) }] })
        .success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...value,
        images: [
          { ...imageItem, thumbnailDataUrl: `data:image/png;base64,${"A".repeat(512 * 1024)}` },
        ],
      }).success,
    ).toBe(false)
  })

  it("bounds aggregate encoded thumbnails in gallery responses", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesOpen]
    const thumbnailDataUrl = imageDataUrlNearLimit(512 * 1024)
    const makeImages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...imageItem,
        name: `${index}.png`,
        thumbnailDataUrl,
      }))

    expect(
      schema.safeParse({ path: "content/life/daily.md", images: makeImages(32) }).success,
    ).toBe(true)
    expect(
      schema.safeParse({ path: "content/life/daily.md", images: makeImages(33) }).success,
    ).toBe(false)
  })

  it("enforces cancelled and active image selection invariants", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesSelect]

    expect(schema.safeParse({ cancelled: true, images: [], conflicts: [] }).success).toBe(true)
    expect(
      schema.safeParse({
        cancelled: true,
        selectionId: undefined,
        images: [],
        conflicts: [],
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        cancelled: true,
        selectionId: "11111111-1111-4111-8111-111111111111",
        images: [],
        conflicts: [],
      }).success,
    ).toBe(false)
    const selected = {
      cancelled: false,
      selectionId: "11111111-1111-4111-8111-111111111111",
      images: [{ ...imageItem, conflict: false }],
      conflicts: [],
    }
    expect(schema.safeParse(selected).success).toBe(true)
    expect(schema.safeParse({ ...selected, selectionId: undefined }).success).toBe(false)
    expect(schema.safeParse({ ...selected, images: [] }).success).toBe(false)
    expect(
      schema.safeParse({ ...selected, images: [selected.images[0], selected.images[0]] }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...selected,
        images: [{ ...selected.images[0], conflict: true }],
        conflicts: [],
      }).success,
    ).toBe(false)
    expect(schema.safeParse({ ...selected, conflicts: ["garden.webp"] }).success).toBe(false)

    const conflictedImages = [
      { ...imageItem, name: "first.png", conflict: true },
      { ...imageItem, name: "middle.png", conflict: false },
      { ...imageItem, name: "last.png", conflict: true },
    ]
    expect(
      schema.safeParse({
        ...selected,
        images: conflictedImages,
        conflicts: ["first.png", "last.png"],
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        ...selected,
        images: conflictedImages,
        conflicts: ["last.png", "first.png"],
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ ...selected, images: Array(51).fill(selected.images[0]) }).success,
    ).toBe(false)
    expect(schema.safeParse({ ...selected, conflicts: Array(51).fill("hero.png") }).success).toBe(
      false,
    )
  })

  it("bounds aggregate encoded thumbnails in active selections", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesSelect]
    const thumbnailDataUrl = imageDataUrlNearLimit(512 * 1024)
    const makeImages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...imageItem,
        name: `${index}.png`,
        thumbnailDataUrl,
        conflict: false,
      }))
    const selection = {
      cancelled: false as const,
      selectionId: "11111111-1111-4111-8111-111111111111",
      conflicts: [],
    }

    expect(schema.safeParse({ ...selection, images: makeImages(16) }).success).toBe(true)
    expect(schema.safeParse({ ...selection, images: makeImages(17) }).success).toBe(false)
  })

  it("rejects oversized raw thumbnail arrays before detailed item access", () => {
    const thumbnailDataUrl = imageDataUrlNearLimit(512 * 1024)
    let detailedReads = 0
    const makeImages = (count: number, selection: boolean) =>
      Array.from({ length: count }, (_, index) => {
        const item: Record<string, unknown> = {
          ...imageItem,
          name: `${index}.png`,
          thumbnailDataUrl,
          ...(selection ? { conflict: false } : {}),
        }
        if (index === 0)
          Object.defineProperty(item, "name", {
            enumerable: true,
            get: () => {
              detailedReads += 1
              throw new Error("detailed item schema ran")
            },
          })
        return item
      })

    const gallery = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesOpen]
    let galleryResult: ReturnType<typeof gallery.safeParse> | undefined
    expect(() => {
      galleryResult = gallery.safeParse({
        path: "content/life/daily.md",
        images: makeImages(33, false),
      })
    }).not.toThrow()
    expect(galleryResult?.success).toBe(false)
    expect(detailedReads).toBe(0)

    const selection = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesSelect]
    let selectionResult: ReturnType<typeof selection.safeParse> | undefined
    expect(() => {
      selectionResult = selection.safeParse({
        cancelled: false,
        selectionId: "11111111-1111-4111-8111-111111111111",
        images: makeImages(17, true),
        conflicts: [],
      })
    }).not.toThrow()
    expect(selectionResult?.success).toBe(false)
    expect(detailedReads).toBe(0)

    const accessorItem = { ...imageItem }
    Object.defineProperty(accessorItem, "thumbnailDataUrl", {
      enumerable: true,
      get: () => {
        detailedReads += 1
        throw new Error("thumbnail getter ran")
      },
    })
    let accessorResult: ReturnType<typeof gallery.safeParse> | undefined
    expect(() => {
      accessorResult = gallery.safeParse({
        path: "content/life/daily.md",
        images: [accessorItem],
      })
    }).not.toThrow()
    expect(accessorResult?.success).toBe(false)
    expect(detailedReads).toBe(0)
  })

  it("requires canonical padded Base64 in image data URLs", () => {
    const gallery = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesOpen]
    const previewSchema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesPreview]
    const { thumbnailDataUrl: _thumbnail, ...previewItem } = imageItem

    for (const payload of ["A", "AAA", "AAAA=", "A===", "AA=A", "AB==", "AAB=", "AAAA\n"]) {
      expect(
        gallery.safeParse({
          path: "content/life/daily.md",
          images: [{ ...imageItem, thumbnailDataUrl: `data:image/png;base64,${payload}` }],
        }).success,
        payload,
      ).toBe(false)
      expect(
        previewSchema.safeParse({
          ...previewItem,
          dataUrl: `data:image/png;base64,${payload}`,
        }).success,
        payload,
      ).toBe(false)
    }
    for (const payload of ["AA==", "AAA=", "AAAA"]) {
      expect(
        gallery.safeParse({
          path: "content/life/daily.md",
          images: [{ ...imageItem, thumbnailDataUrl: `data:image/png;base64,${payload}` }],
        }).success,
        payload,
      ).toBe(true)
    }
  })

  it("accepts only bounded image preview data URLs and strips source paths", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.imagesPreview]

    const { thumbnailDataUrl: _thumbnail, ...previewItem } = imageItem
    const previewValue = {
      ...previewItem,
      dataUrl: "data:image/jpeg;base64,AAAA",
      sourcePath: "C:/garden/content/life/images/garden.webp",
    }
    expect(schema.safeParse(previewValue)).toEqual({
      success: true,
      data: { ...previewItem, dataUrl: previewValue.dataUrl },
    })
    expect(
      schema.safeParse({ ...previewValue, dataUrl: "data:image/svg+xml;base64,AAAA" }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...previewValue,
        dataUrl: `data:image/png;base64,${"A".repeat(36 * 1024 * 1024)}`,
      }).success,
    ).toBe(false)
  })
})

describe("IPC success schemas", () => {
  it("defines the publish branch repair request channel", () => {
    expect(IPC_CHANNELS.requests.publishRepairBranch).toBe("garden:publish:repair-branch")
  })

  it("strips extra fields from a valid publish branch repair receipt", () => {
    const entry = Object.entries(IPC_SUCCESS_SCHEMAS).find(
      ([channel]) => channel === "garden:publish:repair-branch",
    )
    expect(entry, "publish branch repair schema").toBeDefined()
    if (entry === undefined) return

    expect(
      entry[1].safeParse({
        branch: "main",
        upstream: "origin/main",
        head: "a".repeat(40),
        privateSource: "must-not-cross",
      }),
    ).toEqual({
      success: true,
      data: { branch: "main", upstream: "origin/main", head: "a".repeat(40) },
    })
    expect(
      entry[1].safeParse({
        branch: "main",
        upstream: "origin/main",
        head: "a".repeat(64),
      }).success,
    ).toBe(true)
  })

  it("rejects master and invalid upstreams in publish branch repair receipts", () => {
    const entry = Object.entries(IPC_SUCCESS_SCHEMAS).find(
      ([channel]) => channel === "garden:publish:repair-branch",
    )
    expect(entry, "publish branch repair schema").toBeDefined()
    if (entry === undefined) return
    const receipt = { branch: "main", upstream: "origin/main", head: "a".repeat(40) }

    expect(entry[1].safeParse({ ...receipt, branch: "master" }).success).toBe(false)
    expect(entry[1].safeParse({ ...receipt, upstream: "origin/master" }).success).toBe(false)
  })

  it("rejects invalid publish branch repair commit hashes", () => {
    const entry = Object.entries(IPC_SUCCESS_SCHEMAS).find(
      ([channel]) => channel === "garden:publish:repair-branch",
    )
    expect(entry, "publish branch repair schema").toBeDefined()
    if (entry === undefined) return
    const receipt = { branch: "main", upstream: "origin/main", head: "a".repeat(40) }

    for (const head of ["a".repeat(39), "a".repeat(65), "A".repeat(40), "g".repeat(40)])
      expect(entry[1].safeParse({ ...receipt, head }).success, head).toBe(false)
  })

  it("validates dynamic domain contracts and rejects unsafe requests", () => {
    expect(IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.domainsList].parse([customDomain])).toEqual([
      customDomain,
    ])
    expect(() => domainCreateSchema.parse({ name: "人工智能", slug: "../outside" })).toThrow()
    expect(() => domainCreateSchema.parse({ name: "人工智能", slug: "Content" })).toThrow()
    for (const slug of ["index", "content", "private", "garden-publisher"])
      expect(() => domainCreateSchema.parse({ name: "人工智能", slug })).toThrow()
    expect(() => domainCreateSchema.parse({ name: "x".repeat(81), slug: "custom" })).toThrow()
    expect(() =>
      domainCreateSchema.parse({ name: "人工智能", slug: "custom", extra: true }),
    ).toThrow()
    expect(() => domainRenameSchema.parse({ slug: "artificial-intelligence", name: "" })).toThrow()
    expect(() =>
      domainRenameSchema.parse({ slug: "artificial-intelligence", name: "重命名", extra: true }),
    ).toThrow()
    expect(() =>
      domainRemoveSchema.parse({ slug: "artificial-intelligence", force: true }),
    ).toThrow()
    expect(
      IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.domainsList].safeParse([
        { ...customDomain, extra: true },
      ]).success,
    ).toBe(false)
    for (const [field, value] of [
      ["publicNotes", -1],
      ["privateNotes", -1],
      ["publicNotes", 1.5],
      ["privateNotes", 1.5],
      ["publicNotes", "2"],
      ["privateNotes", "1"],
    ] as const) {
      expect(
        IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.domainsList].safeParse([
          { ...customDomain, [field]: value },
        ]).success,
        `${field}=${String(value)}`,
      ).toBe(false)
    }
    expect(
      IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.domainsList].safeParse([
        { ...customDomain, order: -1 },
      ]).success,
    ).toBe(false)
  })

  it("defines the domain metadata update channel and accepts empty metadata", () => {
    expect(IPC_CHANNELS.requests.domainsUpdateMetadata).toBe("garden:domains:update-metadata")
    expect(
      domainUpdateMetadataSchema.parse({
        slug: "artificial-intelligence",
        description: "",
        tags: [],
      }),
    ).toEqual({ slug: "artificial-intelligence", description: "", tags: [] })
    expect(
      IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.domainsUpdateMetadata].parse([
        { ...customDomain, description: "", tags: [] },
      ]),
    ).toEqual([{ ...customDomain, description: "", tags: [] }])
  })

  it("accepts valid trimmed domain metadata updates", () => {
    const request = {
      slug: "artificial-intelligence",
      description: "Models, systems, and practical experiments.",
      tags: ["ai", "machine-learning"],
    }

    expect(domainUpdateMetadataSchema.parse(request)).toEqual(request)
  })

  it("rejects duplicate and whitespace-padded domain metadata", () => {
    const request = {
      slug: "artificial-intelligence",
      description: "Models and systems.",
      tags: ["ai", "machine-learning"],
    }

    expect(domainUpdateMetadataSchema.safeParse({ ...request, tags: ["ai", "ai"] }).success).toBe(
      false,
    )
    expect(
      domainUpdateMetadataSchema.safeParse({ ...request, description: " Models and systems." })
        .success,
    ).toBe(false)
    expect(
      domainUpdateMetadataSchema.safeParse({ ...request, description: "Models and systems. " })
        .success,
    ).toBe(false)
    for (const tag of [" ai", "ai ", "", " "]) {
      expect(
        domainUpdateMetadataSchema.safeParse({ ...request, tags: [tag] }).success,
        JSON.stringify(tag),
      ).toBe(false)
    }
  })

  it("rejects oversized and unknown domain metadata fields", () => {
    const request = {
      slug: "artificial-intelligence",
      description: "Models and systems.",
      tags: ["ai"],
    }

    expect(
      domainUpdateMetadataSchema.safeParse({ ...request, description: "x".repeat(2_001) }).success,
    ).toBe(false)
    expect(
      domainUpdateMetadataSchema.safeParse({ ...request, tags: ["x".repeat(129)] }).success,
    ).toBe(false)
    expect(
      domainUpdateMetadataSchema.safeParse({
        ...request,
        tags: Array.from({ length: 101 }, (_, index) => `tag-${index}`),
      }).success,
    ).toBe(false)
    expect(domainUpdateMetadataSchema.safeParse({ ...request, extra: true }).success).toBe(false)
  })

  it("preserves strict note request constraints for custom domains", () => {
    const createRequest = {
      visibility: "public" as const,
      domain: "artificial-intelligence",
      slug: "transformers",
      title: "Transformers",
      date: "2026-10-04",
      description: "A note about transformers.",
      tags: ["ai"],
    }
    expect(noteCreateSchema.parse(createRequest)).toEqual(createRequest)
    expect(
      noteRenameSchema.parse({
        path: "content/artificial-intelligence/transformers.md",
        newDomain: "artificial-intelligence",
        newSlug: "attention-models",
      }),
    ).toEqual({
      path: "content/artificial-intelligence/transformers.md",
      newDomain: "artificial-intelligence",
      newSlug: "attention-models",
    })
    for (const slug of ["../outside", "Content", "bad_slug"])
      expect(() => noteCreateSchema.parse({ ...createRequest, slug })).toThrow()
    for (const slug of ["../outside", "Content", "bad_slug"])
      expect(() =>
        noteRenameSchema.parse({
          path: "content/artificial-intelligence/transformers.md",
          newSlug: slug,
        }),
      ).toThrow()
    for (const path of [
      "content/../outside/transformers.md",
      "content/Artificial-Intelligence/transformers.md",
      "content/artificial-intelligence/Bad_slug.md",
    ])
      expect(() => noteRenameSchema.parse({ path, newSlug: "renamed" })).toThrow()
    for (const date of ["2026-1-4", "2026/10/04", "not-a-date"])
      expect(() => noteCreateSchema.parse({ ...createRequest, date })).toThrow()
  })

  it("strictly validates safe blog management requests", () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const absolutePath = String.raw`C:\\Blogs\\quartz`
    expect(blogIdRequestSchema.safeParse({ id }).success).toBe(true)
    expect(blogPathRequestSchema.safeParse({ path: absolutePath }).success).toBe(true)
    expect(
      blogAddLocalRequestSchema.safeParse({ path: absolutePath, name: "Quartz" }).success,
    ).toBe(true)
    expect(
      blogCloneRequestSchema.safeParse({
        url: "https://github.com/openai/quartz.git",
        destination: absolutePath,
        name: "Quartz",
      }).success,
    ).toBe(true)
    expect(blogRenameRequestSchema.safeParse({ id, name: "Renamed" }).success).toBe(true)
    expect(blogRelocateRequestSchema.safeParse({ id, path: absolutePath }).success).toBe(true)
    expect(blogSwitchRequestSchema.safeParse({ id, editorSaved: true }).success).toBe(true)
    expect(blogSwitchRequestSchema.safeParse({ id }).success).toBe(false)
    expect(blogSwitchRequestSchema.safeParse({ id, editorSaved: false }).success).toBe(false)
  })

  it("strictly validates manual blog website updates", () => {
    const id = "11111111-1111-4111-8111-111111111111"

    expect(blogWebsiteUpdateRequestSchema.safeParse({ id, websiteUrl: null }).success).toBe(true)
    expect(
      blogWebsiteUpdateRequestSchema.safeParse({
        id,
        websiteUrl: "https://example.com/garden/",
      }).success,
    ).toBe(true)
    expect(
      blogWebsiteUpdateRequestSchema.safeParse({ id, websiteUrl: null, extra: true }).success,
    ).toBe(false)
  })

  it("allows only repository and website blog links", () => {
    const id = "11111111-1111-4111-8111-111111111111"

    expect(blogLinkOpenRequestSchema.safeParse({ id, kind: "repository" }).success).toBe(true)
    expect(blogLinkOpenRequestSchema.safeParse({ id, kind: "local" }).success).toBe(false)
  })

  it("strips unknown display address fields and requires configured website URLs", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.blogsList]
    const displayBlog = {
      ...blog,
      repository: {
        display: "openai/quartz",
        url: "https://github.com/openai/quartz",
        privateToken: "must-not-cross",
      },
      website: {
        source: "manual",
        url: "https://example.com/garden/",
        privateToken: "must-not-cross",
      },
      privateToken: "must-not-cross",
    }

    expect(
      schema.parse({ ...blogRegistry, blogs: [displayBlog], activeAvailability: "available" }),
    ).toEqual({
      version: 1,
      activeBlogId: blogId,
      activeAvailability: "available",
      blogs: [
        {
          id: blogId,
          name: "Quartz",
          path: String.raw`C:\\Blogs\\quartz`,
          canonicalPath: String.raw`C:\\Blogs\\quartz`,
          createdAt: "2026-10-01T00:00:00.000Z",
          lastOpenedAt: "2026-10-01T00:00:00.000Z",
          repository: { display: "openai/quartz", url: "https://github.com/openai/quartz" },
          website: { source: "manual", url: "https://example.com/garden/" },
        },
      ],
    })
    expect(
      schema.safeParse({
        ...blogRegistry,
        blogs: [{ ...blog, website: { source: "manual" } }],
        activeAvailability: "available",
      }).success,
    ).toBe(false)
  })

  it("fails closed when blog response paths or names are unsafe", () => {
    const responsePaths = [
      "relative\\quartz",
      "/tmp/quartz",
      "C:\\bad\u0001path",
      "C:\\bad\u0085path",
      `C:\\${"界".repeat(400)}`,
    ]
    const registrySchema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.blogsList]
    const candidateSchema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.blogsChooseLocal]
    const receiptSchema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.blogsClone]
    expect(registrySchema.safeParse(blogRegistry).success).toBe(false)
    expect(
      registrySchema.safeParse({ ...blogRegistry, activeAvailability: "unavailable" }).success,
    ).toBe(true)
    expect(
      registrySchema.safeParse({ ...blogRegistry, activeAvailability: "unknown" }).success,
    ).toBe(false)
    for (const path of responsePaths) {
      expect(
        registrySchema.safeParse({ ...blogRegistry, blogs: [{ ...blog, path }] }).success,
        path,
      ).toBe(false)
      expect(
        registrySchema.safeParse({ ...blogRegistry, blogs: [{ ...blog, canonicalPath: path }] })
          .success,
        path,
      ).toBe(false)
      expect(
        candidateSchema.safeParse({
          path,
          inspection: {
            valid: true,
            canonicalPath: String.raw`C:\\Blogs\\quartz`,
            needsInstall: false,
          },
        }).success,
        path,
      ).toBe(false)
      expect(
        candidateSchema.safeParse({
          path: String.raw`C:\\Blogs\\quartz`,
          inspection: { valid: true, canonicalPath: path, needsInstall: false },
        }).success,
        path,
      ).toBe(false)
      expect(
        receiptSchema.safeParse({ canonicalPath: path, owner: "openai", repository: "quartz" })
          .success,
        path,
      ).toBe(false)
    }
    for (const name of [" ", " Quartz ", "bad\u0001name", "bad\u0085name", "x".repeat(81)]) {
      expect(
        registrySchema.safeParse({ ...blogRegistry, blogs: [{ ...blog, name }] }).success,
        name,
      ).toBe(false)
    }
  })

  it("maps corrupt-registry recovery to the strict registry response schema", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.blogsRecoverLocal]

    expect(schema.safeParse(blogRegistry).success).toBe(true)
    expect(
      schema.parse({ ...blogRegistry, leakedRegistryPath: String.raw`C:\\private` }),
    ).not.toHaveProperty("leakedRegistryPath")
  })

  it("rejects unsafe blog request fields and unknown keys", () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const absolutePath = String.raw`C:\\Blogs\\quartz`
    for (const name of ["", "   ", "bad\u0000name", "bad\nname", "x".repeat(81)]) {
      expect(blogAddLocalRequestSchema.safeParse({ path: absolutePath, name }).success, name).toBe(
        false,
      )
    }
    for (const path of [
      "relative\\quartz",
      ".\\quartz",
      "C:\\bad\u0000path",
      "C:\\bad\npath",
      `C:\\${"x".repeat(1_025)}`,
    ]) {
      expect(blogPathRequestSchema.safeParse({ path }).success, path).toBe(false)
    }
    for (const url of [
      "http://github.com/openai/quartz",
      "https://gitlab.com/openai/quartz",
      "https://user:secret@github.com/openai/quartz",
      "https://github.com/openai/quartz?token=secret",
      "https://github.com/openai/quartz#readme",
      "https://github.com/openai/quartz/extra",
      `https://github.com/openai/${"x".repeat(2_049)}`,
    ]) {
      expect(
        blogCloneRequestSchema.safeParse({ url, destination: absolutePath, name: "Quartz" })
          .success,
        url,
      ).toBe(false)
    }
    for (const [schema, request] of [
      [blogIdRequestSchema, { id, extra: true }],
      [blogPathRequestSchema, { path: absolutePath, extra: true }],
      [blogAddLocalRequestSchema, { path: absolutePath, name: "Quartz", extra: true }],
      [
        blogCloneRequestSchema,
        {
          url: "https://github.com/openai/quartz",
          destination: absolutePath,
          name: "Quartz",
          extra: true,
        },
      ],
      [blogRenameRequestSchema, { id, name: "Quartz", extra: true }],
      [blogRelocateRequestSchema, { id, path: absolutePath, extra: true }],
      [blogSwitchRequestSchema, { id, extra: true }],
    ] as const)
      expect(schema.safeParse(request).success).toBe(false)
  })

  it("allows only bounded application-generated blog progress", () => {
    expect(
      blogImportProgressSchema.safeParse({ phase: "cloning", message: "Cloning blog." }).success,
    ).toBe(true)
    expect(
      blogImportProgressSchema.safeParse({ phase: "cloning", message: "x".repeat(1_001) }).success,
    ).toBe(false)
    expect(
      blogImportProgressSchema.safeParse({ phase: "cloning", message: "Cloning", stdout: "secret" })
        .success,
    ).toBe(false)
  })
  it("accepts an omitted or blank clone display name but still rejects unsafe clone input", () => {
    expect(
      blogCloneRequestSchema.parse({
        url: "https://github.com/openai/quartz",
        destination: String.raw`C:\Blogs\quartz`,
      }),
    ).toEqual({
      url: "https://github.com/openai/quartz",
      destination: String.raw`C:\Blogs\quartz`,
    })
    expect(
      blogCloneRequestSchema.parse({
        url: "git@github.com:openai/quartz.git",
        destination: String.raw`C:\Blogs\quartz`,
        name: "   ",
      }),
    ).toEqual({
      url: "git@github.com:openai/quartz.git",
      destination: String.raw`C:\Blogs\quartz`,
      name: "",
    })
    for (const input of [
      { url: "https://example.com/openai/quartz", destination: String.raw`C:\Blogs\quartz` },
      {
        url: "https://github.com/openai/quartz",
        destination: String.raw`C:\Blogs\quartz`,
        name: "x".repeat(81),
      },
      {
        url: "https://github.com/openai/quartz",
        destination: String.raw`C:\Blogs\quartz`,
        name: "bad\u0001name",
      },
    ]) {
      expect(blogCloneRequestSchema.safeParse(input).success).toBe(false)
    }
  })
  it("matches Node UTF-8 byte length for BMP, surrogate pairs, and isolated surrogates", () => {
    const samples = ["", "ASCII", "中文", "😀", "\ud800", "\udc00", "a\ud800b", "\ud83d\ude00"]
    let seed = 0x5eed1234
    for (let sample = 0; sample < 200; sample += 1) {
      let value = ""
      for (let length = 0; length < 64; length += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        value += String.fromCharCode(seed & 0xffff)
      }
      samples.push(value)
    }
    for (const value of samples)
      expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, "utf8"))
  })

  it("covers every request channel with valid, stripping schemas", () => {
    expect(Object.keys(IPC_SUCCESS_SCHEMAS).sort()).toEqual(
      Object.values(IPC_CHANNELS.requests).sort(),
    )
    for (const [channel, schema] of Object.entries(IPC_SUCCESS_SCHEMAS)) {
      const parsed = schema.safeParse(validByChannel[channel])
      expect(parsed.success, channel).toBe(true)
      const serialized = JSON.stringify(parsed.success ? parsed.data : null)
      if (serialized !== undefined) expect(serialized, channel).not.toContain("privateSource")
    }
  })

  it("rejects a wrong success shape on every request channel", () => {
    for (const [channel, schema] of Object.entries(IPC_SUCCESS_SCHEMAS)) {
      expect(schema.safeParse("wrong output").success, channel).toBe(false)
    }
  })

  it("enforces workspace success and failure invariants", () => {
    const schema = IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.workspaceInspect]
    expect(
      schema.safeParse({
        ok: true,
        root: "C:/garden",
        capabilities,
        issues: [{ code: "GIT_UNAVAILABLE", message: "Git unavailable." }],
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ ok: false, root: "C:/garden", capabilities, issues: [] }).success,
    ).toBe(true)
  })

  it("rejects note and recovery output whose Markdown exceeds 16 MiB in UTF-8", () => {
    const markdown = "界".repeat(Math.floor((16 * 1024 * 1024) / 3) + 1)
    expect(
      IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.notesRead].safeParse({
        path: "content/life/daily.md",
        markdown,
        mtimeMs: 1,
        contentHash: "a".repeat(64),
      }).success,
    ).toBe(false)
    expect(
      IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.notesRecoveryGet].safeParse({
        path: "content/life/daily.md",
        markdown,
        baseMtimeMs: 1,
        baseContentHash: "a".repeat(64),
        createdAt: "2026-09-24T00:00:00.000Z",
        contentHash: "b".repeat(64),
      }).success,
    ).toBe(false)
  })
})
