import { describe, expect, it } from "vitest"
import { IPC_CHANNELS } from "../../src/shared/contracts"
import { IPC_SUCCESS_SCHEMAS } from "../../src/shared/ipcSchemas"

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

const validByChannel: Record<string, unknown> = {
  [IPC_CHANNELS.requests.workspaceInspect]: {
    ok: true,
    root: "C:/garden",
    capabilities,
    issues: [],
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
  [IPC_CHANNELS.requests.changesList]: [
    { id: "note:daily", label: "Daily", paths: ["content/life/daily.md"], ...privateField },
  ],
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
  [IPC_CHANNELS.requests.historyDeployments]: [
    {
      id: "deploy-1",
      startedAt: "2026-09-24T00:00:00.000Z",
      status: "succeeded",
      ...privateField,
    },
  ],
}

describe("IPC success schemas", () => {
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
})
