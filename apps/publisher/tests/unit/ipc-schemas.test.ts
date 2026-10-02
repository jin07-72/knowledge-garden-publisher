import { describe, expect, it } from "vitest"
import { IPC_CHANNELS } from "../../src/shared/contracts"
import {
  IPC_SUCCESS_SCHEMAS,
  blogAddLocalRequestSchema,
  blogCloneRequestSchema,
  blogIdRequestSchema,
  blogImportProgressSchema,
  blogPathRequestSchema,
  blogRelocateRequestSchema,
  blogRenameRequestSchema,
  blogSwitchRequestSchema,
  utf8ByteLength,
} from "../../src/shared/ipcSchemas"

const privateField = { privateSource: "must-not-cross" }
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
const blogId = "11111111-1111-4111-8111-111111111111"
const blog = {
  id: blogId,
  name: "Quartz",
  path: String.raw`C:\\Blogs\\quartz`,
  canonicalPath: String.raw`C:\\Blogs\\quartz`,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastOpenedAt: "2026-10-01T00:00:00.000Z",
  ...privateField,
}
const blogRegistry = { version: 1, activeBlogId: blogId, blogs: [blog], ...privateField }

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
  [IPC_CHANNELS.requests.previewStart]: preview,
  [IPC_CHANNELS.requests.previewStop]: preview,
  [IPC_CHANNELS.requests.previewStatus]: preview,
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
  [IPC_CHANNELS.requests.blogsList]: blogRegistry,
  [IPC_CHANNELS.requests.blogsChooseLocal]: {
    path: String.raw`C:\\Blogs\\quartz`,
    inspection: { valid: true, canonicalPath: String.raw`C:\\Blogs\\quartz`, needsInstall: false },
    ...privateField,
  },
  [IPC_CHANNELS.requests.blogsAddLocal]: blogRegistry,
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
  [IPC_CHANNELS.requests.blogsSwitch]: undefined,
}

describe("IPC success schemas", () => {
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
