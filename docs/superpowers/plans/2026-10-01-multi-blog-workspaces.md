# Multi-Blog Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe multi-blog registration, local-folder import, GitHub cloning, persistent selection, and restart-based switching to Knowledge Garden Publisher.

**Architecture:** Keep every running Electron process bound to exactly one workspace. A main-process registry persists known blogs under Electron `userData`; switching validates the target, flushes the renderer editor, disposes the current workspace services, commits the new active id, and relaunches the app. Local selection and GitHub cloning are main-process capabilities exposed through narrow, validated IPC contracts.

**Tech Stack:** Electron 44, React 19, TypeScript, Zod, Vitest, Testing Library, Playwright, Node child processes, Git, Quartz 5.

---

## File map

- Create `apps/publisher/src/main/services/blogRegistry.ts`: versioned registry parsing, migration, canonical-path deduplication, atomic persistence, rename/remove/activate operations.
- Create `apps/publisher/src/main/services/blogImport.ts`: Quartz workspace validation, GitHub URL parsing, clone/install/check workflow, cancellation, and safe progress summaries.
- Create `apps/publisher/src/main/blogRuntime.ts`: active-workspace resolution and restart-based switch coordination.
- Create `apps/publisher/src/renderer/src/components/BlogSwitcher.tsx`: current-blog dropdown and add/manage entry points.
- Create `apps/publisher/src/renderer/src/components/BlogManager.tsx`: local import, GitHub import, rename, open-folder, switch, and remove dialogs.
- Create `apps/publisher/tests/unit/blogRegistry.test.ts`: registry persistence and recovery tests.
- Create `apps/publisher/tests/unit/blogImport.test.ts`: URL, validation, clone, dependency, and cancellation tests.
- Create `apps/publisher/tests/unit/blog-runtime.test.ts`: switch ordering and fail-closed tests.
- Create `apps/publisher/tests/unit/blog-manager.test.tsx`: renderer workflow tests.
- Modify `apps/publisher/src/shared/contracts.ts`: blog records, requests, results, progress events, API surface, and IPC channels.
- Modify `apps/publisher/src/shared/ipcSchemas.ts`: Zod validation for all new IPC boundaries.
- Modify `apps/publisher/src/main/ipc.ts`: trusted blog-management handlers.
- Modify `apps/publisher/src/preload/gardenApi.ts`: frozen blog-management bridge.
- Modify `apps/publisher/src/main/index.ts`: registry bootstrap, active workspace selection, dialogs, importer, switch coordinator, and test injection.
- Modify `apps/publisher/src/main/publisherServices.ts`: expose an explicit idle/safe-to-switch check and reuse existing disposal.
- Modify `apps/publisher/src/renderer/src/App.tsx`: load blog state, flush editor, drive import/switch flows, and render the new controls.
- Modify `apps/publisher/src/renderer/src/components/MarkdownEditor.tsx`: expose a deterministic `flushSave()` imperative method.
- Modify `apps/publisher/src/renderer/src/app.css`: switcher and manager styling.
- Modify `apps/publisher/tests/unit/ipc-schemas.test.ts`, `ipc.test.ts`, `renderer-security.test.tsx`, `app-smoke.test.tsx`, and `main-layout.test.tsx`: contract and UI regression coverage.
- Modify `apps/publisher/tests/e2e/app.spec.ts`: migration, local add, clone, switch/relaunch, persistence, and non-destructive removal coverage.

### Task 1: Versioned blog registry

**Files:**
- Create: `apps/publisher/src/main/services/blogRegistry.ts`
- Create: `apps/publisher/tests/unit/blogRegistry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover first-run migration, case-insensitive real-path deduplication, atomic persistence, corrupted-file recovery, rename, activation, and non-destructive removal. Use injected filesystem functions so the tests operate only in temporary directories.

```ts
it("migrates the legacy garden as the first active blog", async () => {
  const root = await fixtureQuartzGarden()
  const registry = createBlogRegistry({ file: join(temp, "blogs.v1.json"), legacyPath: root })

  const state = await registry.load()

  expect(state.version).toBe(1)
  expect(state.blogs).toHaveLength(1)
  expect(state.blogs[0]).toMatchObject({ path: root, canonicalPath: await realpath(root) })
  expect(state.activeBlogId).toBe(state.blogs[0].id)
})

it("keeps a corrupt registry and reports recovery instead of replacing it", async () => {
  await writeFile(file, "{broken")
  const registry = createBlogRegistry({ file, legacyPath })

  await expect(registry.load()).rejects.toMatchObject({ code: "BLOG_REGISTRY_INVALID", path: file })
  await expect(readFile(file, "utf8")).resolves.toBe("{broken")
})

it("removing a blog never removes its workspace", async () => {
  const state = await registry.add({ name: "Second", path: secondGarden })
  await registry.remove(state.blogs.at(-1)!.id)
  await expect(stat(secondGarden)).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm test -- tests/unit/blogRegistry.test.ts`

Expected: FAIL because `blogRegistry.ts` and `createBlogRegistry` do not exist.

- [ ] **Step 3: Implement the minimal registry**

Implement these public types and operations. Parse persisted data with an internal Zod schema, resolve paths with `realpath`, normalize Windows comparisons with `toLocaleLowerCase("en-US")`, and write through a same-directory temporary file followed by `rename`.

```ts
export interface BlogRecord {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly canonicalPath: string
  readonly createdAt: string
  readonly lastOpenedAt: string
}

export interface BlogRegistryState {
  readonly version: 1
  readonly activeBlogId: string
  readonly blogs: readonly BlogRecord[]
}

export interface BlogRegistry {
  load(): Promise<BlogRegistryState>
  add(input: { readonly name: string; readonly path: string }): Promise<BlogRegistryState>
  rename(id: string, name: string): Promise<BlogRegistryState>
  activate(id: string): Promise<BlogRegistryState>
  remove(id: string): Promise<BlogRegistryState>
  relocate(id: string, path: string): Promise<BlogRegistryState>
}

export function createBlogRegistry(options: {
  readonly file: string
  readonly legacyPath: string
  readonly now?: () => Date
  readonly uuid?: () => string
}): BlogRegistry
```

Removal must reject the active blog and must never call filesystem deletion. `add` returns the existing record when the canonical path is already registered.

- [ ] **Step 4: Run registry tests and verify GREEN**

Run: `npm test -- tests/unit/blogRegistry.test.ts`

Expected: PASS with all registry cases green.

- [ ] **Step 5: Commit the registry**

```powershell
git add apps/publisher/src/main/services/blogRegistry.ts apps/publisher/tests/unit/blogRegistry.test.ts
git commit -m "feat: add persistent blog registry"
```

### Task 2: Workspace import and GitHub clone service

**Files:**
- Create: `apps/publisher/src/main/services/blogImport.ts`
- Create: `apps/publisher/tests/unit/blogImport.test.ts`
- Modify: `apps/publisher/src/main/services/workspace.ts`

- [ ] **Step 1: Write failing URL and local-workspace tests**

```ts
it.each([
  ["https://github.com/example/garden", "garden"],
  ["https://github.com/example/garden.git", "garden"],
  ["git@github.com:example/garden.git", "garden"],
])("accepts GitHub repository %s", (url, repository) => {
  expect(parseGitHubRepository(url)).toMatchObject({ url, repository })
})

it.each(["https://example.com/a/b", "file:///tmp/repo", "--upload-pack=evil"])(
  "rejects unsafe repository %s",
  (url) => expect(() => parseGitHubRepository(url)).toThrowError(/GitHub/),
)

it("reports installable when only repository dependencies are missing", async () => {
  const result = await inspectBlogCandidate(quartzWithoutNodeModules, dependencies)
  expect(result).toMatchObject({ valid: true, needsInstall: true })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/unit/blogImport.test.ts`

Expected: FAIL because the import service API is missing.

- [ ] **Step 3: Implement parsing and candidate validation**

Reuse the existing workspace dependency inspection rather than duplicating package-lock rules. The new candidate result must separate structural invalidity from repairable dependency absence.

```ts
export type BlogCandidateInspection =
  | { readonly valid: true; readonly canonicalPath: string; readonly needsInstall: boolean }
  | { readonly valid: false; readonly code: string; readonly message: string }

export function parseGitHubRepository(value: string): {
  readonly url: string
  readonly owner: string
  readonly repository: string
}

export async function inspectBlogCandidate(
  path: string,
  dependencies?: BlogCandidateDependencies,
): Promise<BlogCandidateInspection>
```

- [ ] **Step 4: Add failing clone workflow tests**

Use a fake command runner that records executable, argument array, cwd, and environment. Assert that the service never uses a shell string, refuses an existing destination, emits only safe phase messages, runs bundled `npm ci`, validates the finished clone, supports cancellation, and leaves a failed target untouched.

```ts
it("clones, installs, validates, and reports safe progress", async () => {
  const progress: BlogImportProgress[] = []
  const service = createBlogImportService(dependencies({ onProgress: (event) => progress.push(event) }))

  const result = await service.clone({
    url: "https://github.com/example/garden.git",
    destination,
    name: "Study Garden",
  })

  expect(runner.requests[0]).toMatchObject({ executable: "git", args: ["clone", "--", expect.any(String), destination] })
  expect(runner.requests[1].args).toContain("ci")
  expect(progress.map((item) => item.phase)).toEqual(["cloning", "installing", "validating", "complete"])
  expect(result.canonicalPath).toBe(await realpath(destination))
})
```

- [ ] **Step 5: Run clone tests and verify RED**

Run: `npm test -- tests/unit/blogImport.test.ts`

Expected: FAIL on missing clone service behavior.

- [ ] **Step 6: Implement the clone workflow**

```ts
export type BlogImportPhase = "cloning" | "installing" | "validating" | "complete"

export interface BlogImportService {
  clone(request: BlogCloneRequest, signal?: AbortSignal): Promise<BlogImportReceipt>
  install(path: string, signal?: AbortSignal): Promise<BlogCandidateInspection>
}

export function createBlogImportService(dependencies: {
  readonly gitExecutable: string
  readonly nodePath: string
  readonly npmCliPath: string
  readonly runner: CommandRunner
  readonly inspect: typeof inspectBlogCandidate
  readonly onProgress: (progress: BlogImportProgress) => void
}): BlogImportService
```

Invoke Git with `shell: false` and an argument array. Pass `GIT_TERMINAL_PROMPT=1` so Git Credential Manager can operate. Never include raw stdout/stderr or repository URLs in renderer progress events. On failure, report the exact destination path but do not recursively delete it.

- [ ] **Step 7: Run import tests and the existing workspace suite**

Run: `npm test -- tests/unit/blogImport.test.ts tests/unit/workspace.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit import services**

```powershell
git add apps/publisher/src/main/services/blogImport.ts apps/publisher/src/main/services/workspace.ts apps/publisher/tests/unit/blogImport.test.ts
git commit -m "feat: validate and import blog workspaces"
```

### Task 3: Blog IPC contracts and trusted bridge

**Files:**
- Modify: `apps/publisher/src/shared/contracts.ts`
- Modify: `apps/publisher/src/shared/ipcSchemas.ts`
- Modify: `apps/publisher/src/main/ipc.ts`
- Modify: `apps/publisher/src/preload/gardenApi.ts`
- Modify: `apps/publisher/tests/unit/ipc-schemas.test.ts`
- Modify: `apps/publisher/tests/unit/ipc.test.ts`
- Modify: `apps/publisher/tests/unit/renderer-security.test.tsx`

- [ ] **Step 1: Write failing schema and IPC tests**

Add tests that accept normalized records and valid requests, reject blank names, overlong paths, malformed ids, non-GitHub URLs, unknown object keys, and untrusted renderer events. Verify import progress subscriptions are removed correctly.

```ts
expect(blogCloneRequestSchema.safeParse({
  url: "https://github.com/example/garden.git",
  destination: "C:\\Blogs\\garden",
  name: "Garden",
}).success).toBe(true)

expect(blogCloneRequestSchema.safeParse({
  url: "https://example.com/evil",
  destination: "C:\\Blogs\\garden",
  name: "Garden",
}).success).toBe(false)
```

- [ ] **Step 2: Run contract tests and verify RED**

Run: `npm test -- tests/unit/ipc-schemas.test.ts tests/unit/ipc.test.ts tests/unit/renderer-security.test.tsx`

Expected: FAIL because blog contracts and channels do not exist.

- [ ] **Step 3: Add contracts, schemas, handlers, and preload API**

Add this renderer-facing API. Directory selection returns either a checked candidate or cancellation; it never accepts an arbitrary renderer-supplied path for the picker operation.

```ts
readonly blogs: {
  list(): Promise<IpcResult<BlogRegistryView>>
  chooseLocal(): Promise<IpcResult<BlogCandidateSelection | undefined>>
  addLocal(request: BlogAddLocalRequest): Promise<IpcResult<BlogRegistryView>>
  clone(request: BlogCloneRequest): Promise<IpcResult<BlogImportReceipt>>
  cancelImport(): Promise<IpcResult<void>>
  install(request: BlogPathRequest): Promise<IpcResult<BlogCandidateInspection>>
  rename(request: BlogRenameRequest): Promise<IpcResult<BlogRegistryView>>
  relocate(request: BlogRelocateRequest): Promise<IpcResult<BlogRegistryView>>
  remove(request: BlogIdRequest): Promise<IpcResult<BlogRegistryView>>
  openFolder(request: BlogIdRequest): Promise<IpcResult<void>>
  switch(request: BlogSwitchRequest): Promise<IpcResult<void>>
  onImportProgress(listener: (progress: BlogImportProgress) => void): Unsubscribe
}
```

Freeze the bridge object and route every handler through the existing trusted-sender wrapper. Cap names at 80 UTF-16 code units, paths at 1024 bytes, and URLs at 2048 bytes.

- [ ] **Step 4: Run contract and security tests**

Run: `npm test -- tests/unit/ipc-schemas.test.ts tests/unit/ipc.test.ts tests/unit/renderer-security.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the IPC surface**

```powershell
git add apps/publisher/src/shared/contracts.ts apps/publisher/src/shared/ipcSchemas.ts apps/publisher/src/main/ipc.ts apps/publisher/src/preload/gardenApi.ts apps/publisher/tests/unit/ipc-schemas.test.ts apps/publisher/tests/unit/ipc.test.ts apps/publisher/tests/unit/renderer-security.test.tsx
git commit -m "feat: expose trusted blog management API"
```

### Task 4: Active workspace bootstrap and fail-closed switching

**Files:**
- Create: `apps/publisher/src/main/blogRuntime.ts`
- Create: `apps/publisher/tests/unit/blog-runtime.test.ts`
- Modify: `apps/publisher/src/main/index.ts`
- Modify: `apps/publisher/src/main/publisherServices.ts`
- Modify: `apps/publisher/tests/unit/publisher-services.test.ts`

- [ ] **Step 1: Write failing switch-order tests**

```ts
it("validates and disposes before activating and relaunching", async () => {
  const events: string[] = []
  const runtime = createBlogRuntime(dependenciesThatRecord(events))

  await runtime.switchTo({ id: targetId, editorSaved: true })

  expect(events).toEqual(["validate", "assert-idle", "dispose", "activate", "relaunch", "quit"])
})

it.each(["validate", "assert-idle", "dispose"])(
  "keeps the original active blog when %s fails",
  async (failure) => {
    const registry = registryWithFailure(failure)
    await expect(createBlogRuntime(dependencies({ registry })).switchTo(request)).rejects.toBeDefined()
    expect(registry.activate).not.toHaveBeenCalled()
  },
)
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `npm test -- tests/unit/blog-runtime.test.ts tests/unit/publisher-services.test.ts`

Expected: FAIL because the coordinator and idle check are missing.

- [ ] **Step 3: Implement the runtime coordinator**

```ts
export interface BlogRuntime {
  active(): Promise<BlogRecord>
  switchTo(request: { readonly id: string; readonly editorSaved: true }): Promise<void>
}

export function createBlogRuntime(dependencies: {
  readonly registry: BlogRegistry
  readonly inspect: (path: string) => Promise<BlogCandidateInspection>
  readonly assertIdle: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly relaunch: () => void
  readonly quit: () => void
}): BlogRuntime
```

Expose `publisherServices.assertSwitchSafe()` that rejects while publishing or while a scanner cannot be cancelled. Reuse `disposePublisherRuntime` for ordered cleanup. In `index.ts`, load the registry before creating preview and publisher services, and replace the hard-coded production workspace with `await blogRuntime.active()`.

For E2E only, allow `GARDEN_PUBLISHER_E2E_REGISTRY` to redirect the registry file into a temporary test directory. Do not allow this override in packaged builds. Register the blog-management IPC service independently from workspace-bound publishing services so a corrupted registry or missing active path can still open the recovery manager without constructing preview, note, history, or publishing services.

- [ ] **Step 4: Run focused runtime tests**

Run: `npm test -- tests/unit/blog-runtime.test.ts tests/unit/publisher-services.test.ts tests/unit/main-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit runtime switching**

```powershell
git add apps/publisher/src/main/blogRuntime.ts apps/publisher/src/main/index.ts apps/publisher/src/main/publisherServices.ts apps/publisher/tests/unit/blog-runtime.test.ts apps/publisher/tests/unit/publisher-services.test.ts
git commit -m "feat: switch blogs through safe app relaunch"
```

### Task 5: Blog switcher and manager UI

**Files:**
- Create: `apps/publisher/src/renderer/src/components/BlogSwitcher.tsx`
- Create: `apps/publisher/src/renderer/src/components/BlogManager.tsx`
- Create: `apps/publisher/tests/unit/blog-manager.test.tsx`
- Modify: `apps/publisher/src/renderer/src/app.css`
- Modify: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: Write failing component tests**

Cover dropdown accessibility, current marker, path display, local selection, clone form stages, install-required state, duplicate selection, rename, open-folder, safe removal copy, and disabled switching during a busy operation.

```tsx
render(<BlogSwitcher state={state} onSwitch={onSwitch} onManage={onManage} />)
await user.click(screen.getByRole("button", { name: /Knowledge Garden/ }))
expect(screen.getByRole("menuitemradio", { name: /Study Garden/ })).toHaveAttribute(
  "aria-checked",
  "false",
)

await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))
expect(onSwitch).toHaveBeenCalledWith("study-id")
```

- [ ] **Step 2: Run component tests and verify RED**

Run: `npm test -- tests/unit/blog-manager.test.tsx tests/unit/main-layout.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the switcher and manager components**

`BlogSwitcher` is a keyboard-accessible menu button with `menuitemradio` entries. `BlogManager` uses the existing `ModalShell`, with three views: list, local candidate, and GitHub clone. Keep all asynchronous effects in callbacks passed by `App`; components receive state and emit typed intents.

```ts
export interface BlogSwitcherProps {
  readonly registry: BlogRegistryView
  readonly disabled: boolean
  readonly onSwitch: (id: string) => void
  readonly onAddLocal: () => void
  readonly onClone: () => void
  readonly onManage: () => void
}

export interface BlogManagerProps {
  readonly open: boolean
  readonly registry: BlogRegistryView
  readonly importState: BlogImportUiState
  readonly onClose: () => void
  readonly onChooseLocal: () => void
  readonly onClone: (request: BlogCloneRequest) => void
  readonly onInstall: (path: string) => void
  readonly onRename: (id: string, name: string) => void
  readonly onOpenFolder: (id: string) => void
  readonly onRemove: (id: string) => void
  readonly onSwitch: (id: string) => void
}
```

Style the controls using existing colors, spacing, focus rings, and modal breakpoints. At narrow widths, collapse the path and retain the blog name and switch affordance.

- [ ] **Step 4: Run component tests and verify GREEN**

Run: `npm test -- tests/unit/blog-manager.test.tsx tests/unit/main-layout.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the UI components**

```powershell
git add apps/publisher/src/renderer/src/components/BlogSwitcher.tsx apps/publisher/src/renderer/src/components/BlogManager.tsx apps/publisher/src/renderer/src/app.css apps/publisher/tests/unit/blog-manager.test.tsx apps/publisher/tests/unit/main-layout.test.tsx
git commit -m "feat: add blog switcher and manager UI"
```

### Task 6: Renderer orchestration and deterministic save-before-switch

**Files:**
- Modify: `apps/publisher/src/renderer/src/components/MarkdownEditor.tsx`
- Modify: `apps/publisher/src/renderer/src/App.tsx`
- Modify: `apps/publisher/tests/unit/editor.test.tsx`
- Modify: `apps/publisher/tests/unit/app-smoke.test.tsx`

- [ ] **Step 1: Write failing editor flush tests**

Extend the editor ref with `flushSave(): Promise<boolean>`. Assert that it resolves `true` only after pending markdown has been written, returns `false` after a save failure, and does not duplicate an already in-flight save.

```tsx
await user.type(screen.getByRole("textbox"), " updated")
await expect(ref.current!.flushSave()).resolves.toBe(true)
expect(save).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("updated") }))
```

- [ ] **Step 2: Run editor tests and verify RED**

Run: `npm test -- tests/unit/editor.test.tsx`

Expected: FAIL because `flushSave` is not exposed.

- [ ] **Step 3: Implement `flushSave` using the existing autosave state machine**

Do not create a second save path. Add a flush method to `useAutosave` that clears the debounce timer, awaits the current write, and performs exactly one final write when content is dirty. Forward that method through `MarkdownEditorHandle`.

```ts
export interface MarkdownEditorHandle {
  focus(): void
  flushSave(): Promise<boolean>
}
```

- [ ] **Step 4: Run editor tests and verify GREEN**

Run: `npm test -- tests/unit/editor.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing App orchestration tests**

Assert initial registry loading, legacy blog display, local-add results, clone progress, installation flow, failed-save switch rejection, successful save-before-switch ordering, and error recovery.

```ts
it("flushes the selected editor before requesting a blog switch", async () => {
  const order: string[] = []
  render(<App />, { api: apiThatRecords(order) })
  await user.click(await screen.findByRole("button", { name: /Study Garden/ }))
  expect(order).toEqual(["flush-save", "switch-blog"])
})
```

- [ ] **Step 6: Run App tests and verify RED**

Run: `npm test -- tests/unit/app-smoke.test.tsx`

Expected: FAIL because App does not load or orchestrate blogs.

- [ ] **Step 7: Integrate blog management into App**

Load `api.blogs.list()` before rendering `PublisherStartup`. Render the switcher in the top bar and the manager at the app root. Keep one `switchBusy` guard; call `markdownEditor.current?.flushSave()` and only invoke `api.blogs.switch()` when it returns true. Subscribe to import progress on mount and unsubscribe on cleanup.

When registry recovery is required, render a dedicated manager-first state instead of constructing publisher services for an invalid workspace.

- [ ] **Step 8: Run renderer tests**

Run: `npm test -- tests/unit/editor.test.tsx tests/unit/app-smoke.test.tsx tests/unit/blog-manager.test.tsx tests/unit/renderer-security.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit renderer orchestration**

```powershell
git add apps/publisher/src/renderer/src/App.tsx apps/publisher/src/renderer/src/components/MarkdownEditor.tsx apps/publisher/src/renderer/src/hooks/useAutosave.ts apps/publisher/tests/unit/editor.test.tsx apps/publisher/tests/unit/app-smoke.test.tsx
git commit -m "feat: orchestrate safe blog switching"
```

### Task 7: End-to-end migration, import, persistence, and removal

**Files:**
- Modify: `apps/publisher/tests/e2e/app.spec.ts`
- Modify: `apps/publisher/tests/helpers/fs.ts`
- Modify: `apps/publisher/tests/helpers/git.ts`
- Modify: `apps/publisher/src/main/index.ts`

- [ ] **Step 1: Add failing E2E scenarios**

Create two independent fixture gardens and a temporary registry location. Add tests for:

1. Legacy-path migration shows the existing Knowledge Garden.
2. A local second garden is added and listed.
3. Switching flushes a pending editor change, relaunches, and shows only the second garden's notes.
4. The selected blog persists after another full application restart.
5. Removing the inactive blog leaves its directory and note files intact.
6. A syntactically valid GitHub URL is mapped by the E2E-only main-process adapter to a local bare Git fixture; clone, dependency installation, validation, and registration complete without network access.

```ts
test("switches blogs through relaunch and remembers the selection", async ({ page }) => {
  await page.getByRole("button", { name: /Knowledge Garden/ }).click()
  await page.getByRole("menuitemradio", { name: /Second Garden/ }).click()
  await app.waitForEvent("window")
  await expect(page.getByRole("heading", { name: /Second Garden/ })).toBeVisible()
  await expect(page.getByText("second-only-note.md")).toBeVisible()
})
```

- [ ] **Step 2: Run E2E and verify RED**

Run: `npm run test:e2e`

Expected: the new multi-blog scenarios FAIL while the existing baseline scenarios remain green.

- [ ] **Step 3: Add deterministic E2E adapters**

When and only when `!app.isPackaged && GARDEN_PUBLISHER_E2E === "1"`, allow:

- `GARDEN_PUBLISHER_E2E_REGISTRY` for the registry file.
- `GARDEN_PUBLISHER_E2E_CLONE_SOURCE` to replace the validated GitHub URL after validation but before passing the argument array to Git.

The renderer must never receive these paths and production packaged code must ignore the variables.

- [ ] **Step 4: Run E2E and verify GREEN**

Run: `npm run test:e2e`

Expected: PASS for all existing and new scenarios.

- [ ] **Step 5: Commit E2E coverage**

```powershell
git add apps/publisher/tests/e2e/app.spec.ts apps/publisher/tests/helpers/fs.ts apps/publisher/tests/helpers/git.ts apps/publisher/src/main/index.ts
git commit -m "test: cover multi-blog desktop workflows"
```

### Task 8: Full verification and Windows installer

**Files:**
- Modify only if verification exposes a regression in files already in scope.
- Generated: `apps/publisher/release/Knowledge Garden Publisher Setup 0.1.0.exe`
- Copy: `C:\Users\11546\Desktop\Knowledge-Garden-Publisher-0.1.0-Setup.exe`

- [ ] **Step 1: Run formatting and type checks**

Run from repository root:

```powershell
npx prettier apps/publisher/src apps/publisher/tests --check
npm --prefix apps/publisher run typecheck
```

Expected: both commands exit 0 with no warnings introduced by the feature.

- [ ] **Step 2: Run the complete Publisher unit/integration suite**

Run: `npm --prefix apps/publisher run test:run`

Expected: all tests pass; intentional platform skips are reported separately.

- [ ] **Step 3: Run the complete desktop E2E suite**

Run: `npm --prefix apps/publisher run test:e2e`

Expected: all Playwright tests pass, including restart persistence and non-destructive removal.

- [ ] **Step 4: Build the Electron application**

Run: `npm --prefix apps/publisher run build`

Expected: Electron Vite produces main, preload, and renderer bundles without errors.

- [ ] **Step 5: Package the Windows installer**

Run: `npm --prefix apps/publisher run package:win`

Expected: the pinned bundled Node/npm runtime verifies and electron-builder produces the NSIS installer.

- [ ] **Step 6: Install and perform a packaged smoke test**

Install the generated package, then verify with the packaged application:

- The existing garden appears automatically after upgrade.
- A second local fixture can be added.
- Switching saves, relaunches, and opens the selected garden.
- Closing and reopening remembers the selected garden.
- The local Quartz preview becomes ready.
- Removing the inactive fixture does not delete its files.

Expected: every item passes with no startup dependency or preview error banner.

- [ ] **Step 7: Copy the verified installer to the desktop**

Copy the exact verified installer to `C:\Users\11546\Desktop\Knowledge-Garden-Publisher-0.1.0-Setup.exe`, replacing only the prior installer artifact with the same intended filename.

- [ ] **Step 8: Commit final verification fixes, if any**

```powershell
git status --short
git add -- apps/publisher/src apps/publisher/tests apps/publisher/scripts apps/publisher/package.json
git commit -m "fix: finalize multi-blog workspace support"
```

If no tracked files changed during verification, do not create an empty commit.

- [ ] **Step 9: Push the completed branch after review**

Run:

```powershell
git push publisher HEAD:main
```

Expected: `publisher/main` advances to the fully verified multi-blog implementation without modifying the separate `knowledge-garden` website repository.
