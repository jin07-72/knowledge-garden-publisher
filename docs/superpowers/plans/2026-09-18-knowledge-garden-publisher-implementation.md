# Knowledge Garden Publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable Windows Electron application that edits, previews, privatizes, selectively publishes, and monitors the existing Knowledge Garden without requiring terminal use.

**Architecture:** Add a self-contained Electron application under `apps/publisher/`. Privileged filesystem, Quartz, Git, and network work stays in focused main-process services exposed through a typed allowlisted preload API; the React renderer owns only presentation and editor state. Selective publishing uses a temporary Git index and detached verification worktree so the verified tree is exactly the tree committed and pushed.

**Tech Stack:** Electron 44.4.2, electron-vite 5.0.0, React 19.3.0, TypeScript 7.0.2, CodeMirror 6, Vitest 5.0.1, Testing Library, Playwright 1.63.0, electron-builder 26.15.3, existing Quartz v5 and GitHub Pages workflow.

---

## File Structure

Create the application as an independent package so Quartz's root package and dependency graph remain untouched.

```text
apps/publisher/
  package.json                         # App-only dependencies and commands
  electron.vite.config.ts             # Main/preload/renderer build entries
  electron-builder.yml                # Per-user NSIS packaging
  tsconfig.json                        # Shared strict TypeScript settings
  vitest.config.ts                     # Node and jsdom test projects
  playwright.config.ts                 # Packaged Electron smoke tests
  scripts/download-node-runtime.mjs    # Verified portable Node/npm runtime fetch
  src/shared/contracts.ts              # IPC inputs, results, errors, domain types
  src/main/index.ts                    # Window lifecycle and secure web preferences
  src/main/ipc.ts                      # Allowlisted IPC registration
  src/main/lib/commandRunner.ts        # Spawn/cancel/output adapter
  src/main/services/workspace.ts       # Repository discovery and first-run checks
  src/main/services/noteIndex.ts       # Public/private note scan and metadata
  src/main/services/noteFiles.ts       # Atomic save, recovery, rename, visibility moves
  src/main/services/preview.ts         # Quartz preview lifecycle/readiness
  src/main/services/changes.ts         # Git status parsing and logical change groups
  src/main/services/publish.ts         # Temporary-index snapshot verification and push
  src/main/services/deployments.ts     # Git history and GitHub Actions status
  src/main/services/trash.ts           # Windows recycle-bin deletion boundary
  src/preload/index.ts                 # Frozen typed window.garden API
  src/renderer/index.html              # Renderer entry document
  src/renderer/src/main.tsx            # React bootstrap
  src/renderer/src/App.tsx             # Main application composition
  src/renderer/src/app.css             # Approved dark visual system and pane layout
  src/renderer/src/components/         # Note tree, editor, preview, publish, history
  src/renderer/src/hooks/              # Autosave and async-status hooks
  tests/fixtures/garden/                # Minimal Git/Quartz-like fixture copied per test
  tests/helpers/fs.ts                   # exists/copy/temp-directory helpers
  tests/helpers/git.ts                  # argument-array Git test runner and repo setup
  tests/unit/                           # Pure service and component tests
  tests/integration/                    # Temporary repository behavior tests
  tests/e2e/                            # Electron launch and publish smoke tests
```

Modify:

- `.gitignore` — ignore `.garden-publisher/`, app build output, packaged releases, and downloaded runtime.
- `README.md` — add desktop application development, packaging, and daily-use instructions.

## Task 1: Scaffold the Electron Package and Test Harness

**Files:**
- Create: `apps/publisher/package.json`
- Create: `apps/publisher/electron.vite.config.ts`
- Create: `apps/publisher/tsconfig.json`
- Create: `apps/publisher/vitest.config.ts`
- Create: `apps/publisher/src/main/index.ts`
- Create: `apps/publisher/src/preload/index.ts`
- Create: `apps/publisher/src/renderer/index.html`
- Create: `apps/publisher/src/renderer/src/main.tsx`
- Create: `apps/publisher/src/renderer/src/App.tsx`
- Create: `apps/publisher/tests/unit/app-smoke.test.tsx`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing renderer smoke test**

```tsx
// apps/publisher/tests/unit/app-smoke.test.tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { App } from "../../src/renderer/src/App"

describe("App", () => {
  it("renders the garden identity and three primary panes", () => {
    render(<App />)
    expect(screen.getByText("~/Knowledge Garden")).toBeVisible()
    expect(screen.getByRole("navigation", { name: "笔记" })).toBeVisible()
    expect(screen.getByRole("region", { name: "Markdown 编辑器" })).toBeVisible()
    expect(screen.getByRole("region", { name: "本地预览" })).toBeVisible()
  })
})
```

- [ ] **Step 2: Run the test and verify the scaffold is absent**

Run: `npm --prefix apps/publisher test -- --run tests/unit/app-smoke.test.tsx`

Expected: FAIL because `apps/publisher/package.json` and `App.tsx` do not exist.

- [ ] **Step 3: Create the package and minimal secure shell**

Use exact dependency versions in `apps/publisher/package.json`: Electron `44.4.2`, electron-vite `5.0.0`, electron-builder `26.15.3`, React/React DOM `19.3.0`, TypeScript `7.0.2`, Vite `8.3.0`, Vitest `5.0.1`, jsdom `30.1.0`, Testing Library React `16.3.3`, user-event `14.6.7`, Playwright and `@playwright/test` `1.63.0`, `@types/node` `26.6.1`, `@types/react` `19.3.0`, `@types/react-dom` `19.3.0`, CodeMirror state `6.7.5`, view `6.43.12`, markdown `6.5.2`, commands `6.11.1`, search `6.7.2`, gray-matter `4.0.3`, chokidar `5.0.0`, zod `4.6.5`, and lucide-react `1.47.0`.

Required scripts:

```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run",
    "build": "electron-vite build",
    "prepackage": "node scripts/download-node-runtime.mjs",
    "package:win": "npm run prepackage && npm run build && electron-builder --win nsis",
    "test:e2e": "playwright test"
  }
}
```

Create `App.tsx` with three labeled panes and create `src/main/index.ts` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a preload path resolved from the production bundle. Add these ignore rules:

```gitignore
.garden-publisher/
apps/publisher/dist/
apps/publisher/out/
apps/publisher/release/
apps/publisher/vendor/
```

- [ ] **Step 4: Install and verify the shell**

Run:

```powershell
npm --prefix apps/publisher install
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run test:run
npm --prefix apps/publisher run build
```

Expected: typecheck passes, smoke test passes, and electron-vite creates main/preload/renderer bundles.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore apps/publisher
git commit -m "feat: scaffold garden publisher desktop app"
```

## Task 2: Define Contracts and Workspace Diagnostics

**Files:**
- Create: `apps/publisher/src/shared/contracts.ts`
- Create: `apps/publisher/src/main/lib/commandRunner.ts`
- Create: `apps/publisher/src/main/services/workspace.ts`
- Create: `apps/publisher/tests/unit/workspace.test.ts`
- Create: `apps/publisher/tests/helpers/fs.ts`
- Create: `apps/publisher/tests/helpers/git.ts`

- [ ] **Step 1: Write failing diagnostics tests**

```ts
// apps/publisher/tests/unit/workspace.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { inspectWorkspace } from "../../src/main/services/workspace"

describe("inspectWorkspace", () => {
  it("accepts a garden with required roots and scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "garden-workspace-"))
    await mkdir(join(root, "content"))
    await mkdir(join(root, "private"))
    await mkdir(join(root, "scripts"))
    await writeFile(join(root, "package-lock.json"), "{}")
    await writeFile(join(root, "quartz.config.yaml"), "configuration: {}")
    await writeFile(join(root, "scripts", "validate-content.mjs"), "")
    const result = await inspectWorkspace(root, { checkGit: false })
    expect(result.ok).toBe(true)
    expect(result.capabilities.preview).toBe(true)
  })

  it("returns actionable missing-path errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "garden-workspace-"))
    const result = await inspectWorkspace(root, { checkGit: false })
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("CONTENT_MISSING")
  })
})
```

- [ ] **Step 2: Run the focused test**

Run: `npm --prefix apps/publisher test -- --run tests/unit/workspace.test.ts`

Expected: FAIL because contracts and `inspectWorkspace` are undefined.

- [ ] **Step 3: Implement typed results and diagnostics**

Define discriminated `AppError`, `WorkspaceInspection`, `NoteSummary`, `Visibility`, `ChangeGroup`, `PublishRequest`, `PublishProgress`, and `DeploymentRun` types in `contracts.ts`. Define a narrow `TrashAdapter` with `trashItem(absolutePath: string): Promise<void>` so recovery and note services can depend on deletion behavior without importing Electron. Implement `commandRunner.ts` with argument arrays, explicit cwd, cancellation through `AbortSignal`, separate stdout/stderr capture, and no shell interpolation. Implement `tests/helpers/fs.ts` with `exists(path)` using `access`, and `tests/helpers/git.ts` with an argument-array `git(cwd, args, env?)` helper plus bare-remote/working-repository setup. Implement `inspectWorkspace` using exact required paths and `git rev-parse`, `git remote get-url origin`, and `git status --porcelain=v2` when `checkGit` is true.

The default path constant must be:

```ts
export const DEFAULT_GARDEN_PATH = String.raw`C:\Users\11546\Desktop\web`
```

- [ ] **Step 4: Verify diagnostics**

Run:

```powershell
npm --prefix apps/publisher test -- --run tests/unit/workspace.test.ts
npm --prefix apps/publisher run typecheck
```

Expected: all workspace tests and typecheck pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/shared apps/publisher/src/main/lib apps/publisher/src/main/services/workspace.ts apps/publisher/tests/unit/workspace.test.ts apps/publisher/tests/helpers
git commit -m "feat: add publisher workspace diagnostics"
```

## Task 3: Index Public and Private Notes

**Files:**
- Create: `apps/publisher/src/main/services/noteIndex.ts`
- Create: `apps/publisher/tests/unit/noteIndex.test.ts`
- Create: `apps/publisher/tests/fixtures/garden/content/technology/css-grid.md`
- Create: `apps/publisher/tests/fixtures/garden/private/life/journal.md`

- [ ] **Step 1: Write failing indexing tests**

```ts
// apps/publisher/tests/unit/noteIndex.test.ts
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { scanNotes } from "../../src/main/services/noteIndex"

describe("scanNotes", () => {
  it("indexes public and private notes without leaking private source", async () => {
    const root = resolve("tests/fixtures/garden")
    const notes = await scanNotes(root)
    expect(notes.map((note) => [note.slug, note.visibility])).toEqual([
      ["journal", "private"],
      ["css-grid", "public"],
    ])
    expect(notes.find((note) => note.slug === "journal")).not.toHaveProperty("body")
  })
})
```

- [ ] **Step 2: Confirm the test fails**

Run: `npm --prefix apps/publisher test -- --run tests/unit/noteIndex.test.ts`

Expected: FAIL because `scanNotes` does not exist.

- [ ] **Step 3: Implement deterministic note scanning**

Use `gray-matter` to parse metadata, recurse only under `content/` and `private/`, ignore dotfiles, normalize Windows separators, validate lowercase slugs and the four supported domains, and return summaries sorted by `updatedAt` then title. Reuse the repository's required metadata rules rather than inventing different publication requirements.

- [ ] **Step 4: Verify note indexing**

Run: `npm --prefix apps/publisher test -- --run tests/unit/noteIndex.test.ts`

Expected: PASS for both visibility roots and metadata validation cases.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/noteIndex.ts apps/publisher/tests
git commit -m "feat: index public and private garden notes"
```

## Task 4: Atomic Save, Recovery, and External-Edit Protection

**Files:**
- Create: `apps/publisher/src/main/services/noteFiles.ts`
- Create: `apps/publisher/tests/unit/noteFiles.test.ts`

- [ ] **Step 1: Write failing save tests**

Test that `createNote` writes valid frontmatter only under an allowed domain/visibility root and rejects collisions. Test that `saveNote` rejects a stale expected modification time, preserves the external file, atomically replaces a current file, and writes a recovery copy under `.garden-publisher/recovery/` before replacement.

```ts
await expect(saveNote({ path, markdown: "new", expectedMtimeMs: 1, workspace })).rejects.toMatchObject({ code: "EXTERNAL_EDIT" })
expect(await readFile(path, "utf8")).toBe("external")
```

- [ ] **Step 2: Run and observe RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/noteFiles.test.ts`

Expected: FAIL because `saveNote` and recovery helpers do not exist.

- [ ] **Step 3: Implement save and recovery primitives**

Implement `createNote` for `technology`, `reading`, `language`, and `life`, with lowercase-slug validation and required `title`, `date`, `description`, and `tags` frontmatter. For saves, write the recovery copy first, write a uniquely named sibling temporary file, flush and close it, then rename it over the target. Reject paths that resolve outside `content/` or `private/`. Return the new `mtimeMs` and a content hash. Add `listRecoveries`, `restoreRecovery`, and `discardRecovery`; `discardRecovery` receives the shared `TrashAdapter` and uses it rather than permanently deleting the recovery file.

- [ ] **Step 4: Verify all file tests**

Run: `npm --prefix apps/publisher test -- --run tests/unit/noteFiles.test.ts`

Expected: PASS, including stale-edit and traversal cases.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/noteFiles.ts apps/publisher/tests/unit/noteFiles.test.ts
git commit -m "feat: add safe note saving and recovery"
```

## Task 5: Visibility, Attachments, and Rename Transactions

**Files:**
- Modify: `apps/publisher/src/main/services/noteFiles.ts`
- Create: `apps/publisher/tests/integration/noteTransactions.test.ts`

- [ ] **Step 1: Write failing transaction tests**

Cover public-to-private moves, owned attachment moves, collision rollback, ambiguous shared attachment rejection, pending public deletion reporting, private-to-public moves, slug rename with incoming Wiki-link updates, and alias preservation.

```ts
const result = await changeVisibility({ workspace, path: "content/life/weekly-review.md", visibility: "private" })
expect(result.pendingPublicDeletion).toBe("content/life/weekly-review.md")
expect(await exists(join(workspace, "private/life/weekly-review.md"))).toBe(true)
expect(await exists(join(workspace, "content/_assets/weekly-review/chart.png"))).toBe(false)
```

- [ ] **Step 2: Run and verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/integration/noteTransactions.test.ts`

Expected: FAIL because transaction functions are absent.

- [ ] **Step 3: Implement planned transactions**

Add `planVisibilityChange`, `executeVisibilityChange`, `planRename`, and `executeRename`. Plans contain every source/target pair and Wiki-link edit. Execution writes backups under `.garden-publisher/transactions/<id>/`, applies all moves/edits, and restores from backups on any failure. Never rewrite Git history; return `historyWarning: true` when the public source is tracked by `git ls-files`.

- [ ] **Step 4: Verify transaction safety**

Run: `npm --prefix apps/publisher test -- --run tests/integration/noteTransactions.test.ts`

Expected: PASS with no partial files after injected failures.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/noteFiles.ts apps/publisher/tests/integration/noteTransactions.test.ts
git commit -m "feat: add safe note visibility and rename transactions"
```

## Task 6: Manage Exact Quartz Preview

**Files:**
- Create: `apps/publisher/src/main/services/preview.ts`
- Create: `apps/publisher/tests/unit/preview.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use an injected in-memory `CommandRunner` test double to assert one preview process, readiness detection from the local URL, structured rebuild errors, clean cancellation, and reuse of the active process.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/preview.test.ts`

Expected: FAIL because `PreviewManager` is undefined.

- [ ] **Step 3: Implement `PreviewManager`**

Launch the pinned runtime with `quartz/bootstrap-cli.mjs build --serve --port <available-port>`, parse readiness without depending on ANSI color, emit typed `starting`, `ready`, `building`, and `error` states, and terminate the complete child-process tree on Windows. Bind to `127.0.0.1`; never expose the preview server on the LAN.

- [ ] **Step 4: Verify preview behavior**

Run: `npm --prefix apps/publisher test -- --run tests/unit/preview.test.ts`

Expected: PASS for lifecycle, cancellation, and error parsing.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/preview.ts apps/publisher/tests/unit/preview.test.ts
git commit -m "feat: manage local Quartz preview"
```

## Task 7: Register Secure IPC and Preload API

**Files:**
- Create: `apps/publisher/src/main/ipc.ts`
- Modify: `apps/publisher/src/main/index.ts`
- Modify: `apps/publisher/src/preload/index.ts`
- Create: `apps/publisher/tests/unit/ipc.test.ts`

- [ ] **Step 1: Write failing IPC tests**

Assert every request is Zod-validated, unknown channels are unavailable, workspace-relative paths reject traversal, and the exposed API object is frozen.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/ipc.test.ts`

Expected: FAIL because handlers and preload methods are absent.

- [ ] **Step 3: Implement the allowlisted bridge**

Expose only these renderer methods: `workspace.inspect`, `notes.list/read/save/create/rename/changeVisibility/trash`, `preview.start/stop/status`, `changes.list`, `publish.start/cancel`, `history.git/deployments`, and event subscriptions for preview/publish progress. Return serialized typed errors; never expose `ipcRenderer`, arbitrary paths, shell strings, or command execution.

- [ ] **Step 4: Verify IPC and typecheck**

Run:

```powershell
npm --prefix apps/publisher test -- --run tests/unit/ipc.test.ts
npm --prefix apps/publisher run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main apps/publisher/src/preload apps/publisher/tests/unit/ipc.test.ts
git commit -m "feat: expose secure publisher IPC API"
```

## Task 8: Build the Approved Three-Pane Interface

**Files:**
- Modify: `apps/publisher/src/renderer/src/App.tsx`
- Create: `apps/publisher/src/renderer/src/app.css`
- Create: `apps/publisher/src/renderer/src/components/NoteSidebar.tsx`
- Create: `apps/publisher/src/renderer/src/components/VisibilityMenu.tsx`
- Create: `apps/publisher/src/renderer/src/components/PreviewPane.tsx`
- Create: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Assert the four domain filters, public/private filters, searchable note list, new-note action, selected note path, compact visibility button, editor region, preview region, bottom change count, keyboard focus, `检查并发布` action, and secondary tabs for full local site, live public site, and history.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/main-layout.test.tsx`

Expected: FAIL because approved components are absent.

- [ ] **Step 3: Implement the approved A layout**

Use CSS Grid columns `minmax(190px, 0.22fr) minmax(360px, 0.9fr) minmax(360px, 1fr)`, approved colors `#101318`, `#8bd5ca`, and `#f5a97f`, visible `:focus-visible` outlines, resizable pane separators, and Chinese user-facing labels. The visibility control must match the approved short-label/dropdown interaction and explain each consequence. Keep the primary right pane on the active note's exact Quartz preview; add secondary navigation for the full local site, `https://jin07-72.github.io/knowledge-garden/`, and the history view without replacing the three-pane writing layout.

- [ ] **Step 4: Verify UI behavior**

Run: `npm --prefix apps/publisher test -- --run tests/unit/main-layout.test.tsx`

Expected: PASS for pointer and keyboard flows.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/renderer apps/publisher/tests/unit/main-layout.test.tsx
git commit -m "feat: build publisher three-pane interface"
```

## Task 9: Add CodeMirror Editing, Autosave, and Wiki Completion

**Files:**
- Create: `apps/publisher/src/renderer/src/components/MarkdownEditor.tsx`
- Create: `apps/publisher/src/renderer/src/hooks/useAutosave.ts`
- Create: `apps/publisher/src/renderer/src/editor/wikiCompletion.ts`
- Create: `apps/publisher/tests/unit/editor.test.tsx`

- [ ] **Step 1: Write failing editor tests**

Test raw frontmatter preservation, a 750 ms debounced save, save-state announcements, stale-file conflict UI, recovery prompt, Markdown search, and `[[` Wiki-link completion from note summaries.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/editor.test.tsx`

Expected: FAIL because the editor integration is absent.

- [ ] **Step 3: Implement the editor**

Compose CodeMirror Markdown, search, history, keymap, bracket closing, and a custom Wiki completion source. Keep one editor instance per selected note, cancel pending saves on note changes only after flushing, and preserve the user's buffer on `EXTERNAL_EDIT` while showing compare/reload actions.

- [ ] **Step 4: Verify editor tests**

Run: `npm --prefix apps/publisher test -- --run tests/unit/editor.test.tsx`

Expected: PASS with Vitest timers and no React act warnings.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/renderer/src/components/MarkdownEditor.tsx apps/publisher/src/renderer/src/hooks apps/publisher/src/renderer/src/editor apps/publisher/tests/unit/editor.test.tsx
git commit -m "feat: add Markdown editing and autosave"
```

## Task 10: Group Changes and Build the Publish Review

**Files:**
- Create: `apps/publisher/src/main/services/changes.ts`
- Create: `apps/publisher/src/renderer/src/components/PublishReview.tsx`
- Create: `apps/publisher/tests/unit/changes.test.ts`
- Create: `apps/publisher/tests/unit/publish-review.test.tsx`

- [ ] **Step 1: Write failing service and UI tests**

Cover porcelain-v2 rename/delete parsing, note-plus-attachment grouping, pending unpublish groups, locked private changes, config changes unchecked by default, selection count, and inaccessible private checkboxes.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/changes.test.ts tests/unit/publish-review.test.tsx`

Expected: FAIL because grouping and dialog are absent.

- [ ] **Step 3: Implement logical change groups**

Parse `git status --porcelain=v2 -z` without line splitting. Associate `content/_assets/<slug>/` with its note, convert tracked public deletions caused by privatization into `unpublish` groups, and emit private summaries with no source contents. Render the approved checklist with public changes selected, private rows locked, and a validation summary.

- [ ] **Step 4: Verify grouping and dialog behavior**

Run: `npm --prefix apps/publisher test -- --run tests/unit/changes.test.ts tests/unit/publish-review.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/changes.ts apps/publisher/src/renderer/src/components/PublishReview.tsx apps/publisher/tests/unit/changes.test.ts apps/publisher/tests/unit/publish-review.test.tsx
git commit -m "feat: review selectable publication changes"
```

## Task 11: Implement Exact-Tree Verification and Publishing

**Files:**
- Create: `apps/publisher/src/main/services/publish.ts`
- Create: `apps/publisher/tests/integration/publish.test.ts`

- [ ] **Step 1: Write failing repository integration tests**

Create a bare remote and working repository per test. Assert selected files only, no private paths in the temporary index, synthetic tree equals final commit tree, failed validation creates no commit, unrelated edits remain, existing real staged changes block publishing, remote divergence blocks pushing, and push retry keeps the local commit.

```ts
expect(await git(workspace, ["diff", "--name-only", "HEAD^", "HEAD"])).toContain("content/technology/css-grid.md")
expect(await git(workspace, ["diff", "--name-only", "HEAD^", "HEAD"])).not.toContain("content/life/weekly-review.md")
expect(await git(workspace, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain("private/")
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/integration/publish.test.ts`

Expected: FAIL because `Publisher` does not exist.

- [ ] **Step 3: Implement publication as a state machine**

Implement `preflight-fetch → stage-temporary-index → write-tree → synthetic-commit → verify-worktree → update-local-ref → push → cleanup`. During preflight fetch `origin/main`, capture the symbolic current branch and HEAD, require `origin/main` to be an ancestor of HEAD, and reject a detached HEAD, real staged changes, or any divergence before creating a local commit. Use `GIT_INDEX_FILE`, argument arrays, exact selected paths, `git diff --cached --check`, `git write-tree`, `git commit-tree`, `git worktree add --detach`, and `git update-ref refs/heads/<current>` with the captured old HEAD. Push the new commit as `HEAD:refs/heads/main`; never force-push. In the detached worktree create a Windows directory junction named `node_modules` that targets the already-validated workspace `node_modules`, then run the pinned `apps/publisher/vendor/node/node.exe` with the bundled npm CLI at `apps/publisher/vendor/node/node_modules/npm/bin/npm-cli.js`, arguments `run verify:site`, and the worktree as cwd. Fail preflight with `RUNTIME_MISSING` or `DEPENDENCIES_INVALID` before staging when the verified runtime or matching dependency installation is absent. Always remove only the generated worktree, junction, and index paths after resolving and validating them under `.garden-publisher/publish/`.

- [ ] **Step 4: Verify publication invariants**

Run: `npm --prefix apps/publisher test -- --run tests/integration/publish.test.ts`

Expected: PASS for exact-tree equality, failure cleanup, divergence, and private exclusion.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/publish.ts apps/publisher/tests/integration/publish.test.ts
git commit -m "feat: publish verified selected garden changes"
```

## Task 12: Add Git and GitHub Deployment History

**Files:**
- Create: `apps/publisher/src/main/services/deployments.ts`
- Create: `apps/publisher/src/renderer/src/components/HistoryView.tsx`
- Create: `apps/publisher/tests/unit/deployments.test.ts`
- Create: `apps/publisher/tests/unit/history-view.test.tsx`

- [ ] **Step 1: Write failing history tests**

Test HTTPS and SSH GitHub remote parsing, ETag requests, exponential polling transitions, rate-limit fallback, matching a run by head SHA, and rendering Git commits beside deployment states.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/deployments.test.ts tests/unit/history-view.test.tsx`

Expected: FAIL because deployment history is absent.

- [ ] **Step 3: Implement monitoring and history UI**

Read commits with a NUL-delimited `git log` format. Query `GET /repos/{owner}/{repo}/actions/workflows/deploy.yml/runs`, send `If-None-Match`, poll at 3, 6, 12, then 20 second intervals, stop on terminal state, and fall back to repository Actions/live-site links on 403 or network failure. Never request or persist a token.

- [ ] **Step 4: Verify monitoring**

Run: `npm --prefix apps/publisher test -- --run tests/unit/deployments.test.ts tests/unit/history-view.test.tsx`

Expected: PASS with mocked fetch and Vitest timers.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/deployments.ts apps/publisher/src/renderer/src/components/HistoryView.tsx apps/publisher/tests/unit/deployments.test.ts apps/publisher/tests/unit/history-view.test.tsx
git commit -m "feat: show garden publish history and deployment status"
```

## Task 13: Add Recycle-Bin Deletion and First-Run Repair

**Files:**
- Create: `apps/publisher/src/main/services/trash.ts`
- Create: `apps/publisher/src/renderer/src/components/FirstRun.tsx`
- Create: `apps/publisher/src/renderer/src/components/DeleteNoteDialog.tsx`
- Create: `apps/publisher/tests/unit/first-run.test.tsx`
- Create: `apps/publisher/tests/unit/trash.test.ts`

- [ ] **Step 1: Write failing safety tests**

Assert trash rejects paths outside managed roots, implements the shared `TrashAdapter` with an injected Electron `shell.trashItem`, warns when a tracked public note stays online until publication, and first-run diagnostics provide concrete repair actions for missing Git, dependencies, repository, remote, credentialed fetch access, and preview port.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher test -- --run tests/unit/trash.test.ts tests/unit/first-run.test.tsx`

Expected: FAIL because safety UI and service are absent.

- [ ] **Step 3: Implement recovery-first deletion and diagnostics**

Resolve and validate exact paths, flush the active editor, move the note and owned attachments to the Windows recycle bin, and return a pending public deletion when applicable. First-run repair may run `npm ci` with the bundled Node/npm runtime after explicit user action; it must not install Git, rewrite remotes, or alter credentials automatically.

- [ ] **Step 4: Verify safety behavior**

Run: `npm --prefix apps/publisher test -- --run tests/unit/trash.test.ts tests/unit/first-run.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/publisher/src/main/services/trash.ts apps/publisher/src/renderer/src/components/FirstRun.tsx apps/publisher/src/renderer/src/components/DeleteNoteDialog.tsx apps/publisher/tests/unit
git commit -m "feat: add safe deletion and startup diagnostics"
```

## Task 14: Package the Windows Application and Run End-to-End Tests

**Files:**
- Create: `apps/publisher/electron-builder.yml`
- Create: `apps/publisher/playwright.config.ts`
- Create: `apps/publisher/scripts/download-node-runtime.mjs`
- Create: `apps/publisher/tests/e2e/app.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing Electron smoke test**

Launch Electron through Playwright with a temporary garden path and a local bare Git remote created by `tests/helpers/git.ts`. Test first-run success, opening a note, editing and saving, switching visibility, showing the publish checklist, publishing to that local remote, displaying the injected successful deployment response, and retaining an unselected edit.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/publisher run test:e2e`

Expected: FAIL because packaging/runtime configuration is incomplete.

- [ ] **Step 3: Configure deterministic Windows packaging**

Configure electron-builder NSIS with `perMachine: false`, `oneClick: false`, `allowToChangeInstallationDirectory: true`, application ID `io.github.jin07-72.knowledge-garden-publisher`, icon `../../quartz/static/icon.png`, and output under `apps/publisher/release/`. Reuse the garden's existing 200×200 icon instead of introducing unrelated branding. The runtime download script must fetch Node `22.16.0` Windows x64 from `nodejs.org`, fetch the matching `SHASUMS256.txt`, verify SHA-256 before extraction, and place `node.exe` plus its npm distribution under ignored `apps/publisher/vendor/node/`; a checksum mismatch must fail packaging. Add a `prepackage` script that runs this downloader before `package:win`, and include `vendor/node/**` in electron-builder `extraResources`.

Document:

- development start;
- all tests;
- package creation;
- installer location;
- daily note workflow;
- public/private history warning;
- Git prerequisite and credential behavior;
- recovery and troubleshooting.

- [ ] **Step 4: Run complete verification**

Run:

```powershell
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run test:run
npm --prefix apps/publisher run build
npm --prefix apps/publisher run test:e2e
npm --prefix apps/publisher run package:win
npm run verify:site
git diff --check
```

Expected: all unit/integration/E2E tests pass, Quartz verification passes, and an NSIS installer is created under `apps/publisher/release/`.

- [ ] **Step 5: Perform packaged visual and privacy QA**

Install per-user on Windows, launch without a terminal, verify the approved three-pane layout at 1280×720 and 1920×1080, keyboard navigation, focus indicators, exact local preview, public/private moves, locked private publication rows, recovery after forced close, a real GitHub Pages deployment, and absence of every `private/` path in the pushed commit and built site.

- [ ] **Step 6: Commit**

```powershell
git add apps/publisher/electron-builder.yml apps/publisher/playwright.config.ts apps/publisher/scripts apps/publisher/tests/e2e README.md
git commit -m "feat: package garden publisher for Windows"
```

## Final Review and Delivery

- [ ] Run `npm --prefix apps/publisher run typecheck`, `test:run`, `build`, `test:e2e`, `package:win`, and root `npm run verify:site` again from a clean worktree.
- [ ] Confirm `git status --short` is empty and `git diff --check` passes.
- [ ] Request an independent code review covering IPC security, path containment, private-file exclusion, temporary-index tree equality, destructive operations, and installer behavior.
- [ ] Resolve every blocking finding and rerun the affected focused tests plus the full verification suite.
- [ ] Hand off the installer path, live site, repository link, daily workflow, known first-version exclusions, and exact verification evidence.

## Specification Coverage Check

| Approved requirement | Implemented and verified in |
|---|---|
| Built-in Markdown editor, autosave, Wiki completion, conflict recovery | Tasks 4 and 9 |
| Physical public/private storage and owned attachments | Tasks 3 and 5 |
| Three-pane A layout and compact visibility selector | Task 8 |
| Exact Quartz note preview, full local site, and live site | Tasks 6 and 8 |
| Public changes selected, private changes locked, pending unpublish | Task 10 |
| Exact selected-tree validation with no unrelated/private publication | Task 11 |
| Push to `origin/main` without force/reset and preserve working edits | Task 11 |
| Git history and GitHub Actions deployment status | Task 12 |
| Recycle-bin deletion and guided first-run repair | Task 13 |
| Per-user Windows installer with verified bundled Node/npm | Task 14 |
| End-to-end daily workflow and privacy boundary | Task 14 and Final Review |
