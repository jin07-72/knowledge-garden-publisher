# Custom Domain Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every registered blog create, rename, list, and safely delete its own content-backed domains, and render those domains dynamically in Publisher and on the public Quartz homepage.

**Architecture:** Treat safe top-level `content/<slug>/index.md` pages marked with `gardenDomain: true` as the domain registry. A focused main-process domain service owns discovery and filesystem mutations; notes accept dynamic slugs only after resolving them through that service. Renderer state, IPC schemas, and Quartz cards all consume the same domain metadata shape so switching blogs cannot leak domain state.

**Tech Stack:** TypeScript 7, Electron 44, React 19, Zod 4, gray-matter/YAML, Vitest 5, Playwright 1.63, Quartz/Preact, Node filesystem APIs.

---

## File Structure

### New files

- `apps/publisher/src/main/services/domains.ts` — canonical discovery, validation, creation, title-only rename, empty-domain removal, and operation lifecycle.
- `apps/publisher/src/renderer/src/components/DomainManager.tsx` — accessible create/rename/delete modal.
- `apps/publisher/tests/unit/domains.test.ts` — filesystem safety, mutation, rollback, and concurrency coverage.
- `apps/publisher/tests/unit/domain-manager.test.tsx` — focused renderer behavior coverage.

### Existing files to modify

- `apps/publisher/src/shared/contracts.ts` — dynamic domain types, requests, results, and IPC channels.
- `apps/publisher/src/shared/ipcSchemas.ts` — strict domain request/result schemas and dynamic note-domain validation.
- `apps/publisher/src/preload/gardenApi.ts` — frozen renderer-facing domain API.
- `apps/publisher/src/main/ipc.ts` — trusted domain handlers.
- `apps/publisher/src/main/publisherServices.ts` — workspace-bound domain service wiring and lifecycle disposal.
- `apps/publisher/src/main/index.ts` — domain service lifetime joins switch/quit barriers.
- `apps/publisher/src/main/services/noteIndex.ts` — scan discovered domains rather than a four-value set.
- `apps/publisher/src/main/services/noteFiles.ts` — validate create/read/save paths against current domain pages.
- `apps/publisher/src/main/services/noteTransactions.ts` — dynamic rename/visibility transaction domain validation.
- `apps/publisher/src/main/services/trash.ts` — dynamic cross-domain identity and attachment checks.
- `apps/publisher/src/main/services/trashRecovery.ts` — dynamic recovery path validation.
- `apps/publisher/src/renderer/src/App.tsx` — load and refresh domains, wire manager mutations, and reset stale filters.
- `apps/publisher/src/renderer/src/components/NoteSidebar.tsx` — render live domain filters and selector options.
- `apps/publisher/src/renderer/src/components/MarkdownEditor.tsx` — pass string domain identifiers to Wiki completion.
- `apps/publisher/src/renderer/src/editor/wikiCompletion.ts` — rank against dynamic string slugs.
- `apps/publisher/src/renderer/src/styles.css` — domain manager layout, errors, responsive behavior, and focus states.
- `quartz/components/GardenOverview.tsx` — derive cards, ordering, and counts from domain landing pages.
- `quartz/components/GardenOverview.test.ts` — dynamic-card and malformed-metadata coverage.
- `content/{reading,technology,language,life}/index.md` — mark existing domains and preserve order.
- `apps/publisher/tests/unit/{ipc,ipc-schemas,publisher-services,noteIndex,noteFiles,noteTransactions,trash,trashRecovery,main-layout,app-smoke}.test.*` — update contracts and add regressions.
- `apps/publisher/tests/e2e/app.spec.ts` — custom-domain and multi-blog isolation workflow.

---

### Task 1: Define Dynamic Domain Contracts and IPC Schemas

**Files:**
- Modify: `apps/publisher/src/shared/contracts.ts:188-205,381-430,477-600`
- Modify: `apps/publisher/src/shared/ipcSchemas.ts:1-170,351-391`
- Test: `apps/publisher/tests/unit/ipc-schemas.test.ts`

- [ ] **Step 1: Write failing contract-schema tests**

Add tests that parse a custom domain and reject uppercase, traversal, reserved names, extra fields, oversized labels, and malformed counts:

```ts
const customDomain = {
  slug: "artificial-intelligence",
  name: "人工智能",
  description: "人工智能领域的学习记录。",
  order: 5,
  publicNotes: 2,
  privateNotes: 1,
}

expect(IPC_SUCCESS_SCHEMAS[IPC_CHANNELS.requests.domainsList].parse([customDomain])).toEqual([
  customDomain,
])
expect(() => domainCreateSchema.parse({ name: "人工智能", slug: "../outside" })).toThrow()
expect(() => domainCreateSchema.parse({ name: "人工智能", slug: "Content" })).toThrow()
expect(() => domainCreateSchema.parse({ name: "人工智能", slug: "private" })).toThrow()
expect(() => domainRenameSchema.parse({ slug: "artificial-intelligence", name: "" })).toThrow()
expect(() => domainRemoveSchema.parse({ slug: "artificial-intelligence", force: true })).toThrow()
```

- [ ] **Step 2: Run the schema tests and verify RED**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/ipc-schemas.test.ts
```

Expected: FAIL because the domain schemas and IPC channels do not exist.

- [ ] **Step 3: Add the shared domain types and channels**

Define the public model and requests in `contracts.ts`:

```ts
export type DomainSlug = string

export interface DomainSummary {
  readonly slug: DomainSlug
  readonly name: string
  readonly description: string
  readonly order: number
  readonly publicNotes: number
  readonly privateNotes: number
}

export interface DomainCreateRequest {
  readonly name: string
  readonly slug: DomainSlug
}

export interface DomainRenameRequest {
  readonly slug: DomainSlug
  readonly name: string
}

export interface DomainRemoveRequest {
  readonly slug: DomainSlug
}
```

Change `NoteSummary.domain`, `NoteCreateRequest.domain`, and `NoteRenameRequest.newDomain` to `DomainSlug`. Replace the four-domain managed path expression with the shape-only pattern:

```ts
export const KEBAB_SLUG_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*"
export const MANAGED_NOTE_PATH_PATTERN = new RegExp(
  `^(content|private)/(${KEBAB_SLUG_SOURCE})/(${KEBAB_SLUG_SOURCE})\\.md$`,
)
```

Add `domainsList`, `domainsCreate`, `domainsRename`, and `domainsRemove` request channels. The renderer-facing `GardenApi` group is added with its implementation in Task 4 so intermediate type checking remains green.

- [ ] **Step 4: Implement strict Zod schemas**

Export and reuse schemas rather than duplicating regexes:

```ts
export const domainSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine((slug) => !new Set(["index", "content", "private", "garden-publisher"]).has(slug))

export const domainNameSchema = z.string().trim().min(1).max(80)
export const domainCreateSchema = z
  .object({ name: domainNameSchema, slug: domainSlugSchema })
  .strict()
export const domainRenameSchema = z
  .object({ slug: domainSlugSchema, name: domainNameSchema })
  .strict()
export const domainRemoveSchema = z.object({ slug: domainSlugSchema }).strict()

const domainSummarySchema = z
  .object({
    slug: domainSlugSchema,
    name: domainNameSchema,
    description: z.string().min(1).max(2_000),
    order: z.number().int().nonnegative(),
    publicNotes: z.number().int().nonnegative(),
    privateNotes: z.number().int().nonnegative(),
  })
  .strict()
```

Use `domainSlugSchema` in note summary, create, and rename schemas. Register the four domain success schemas in `IPC_SUCCESS_SCHEMAS`.

- [ ] **Step 5: Run tests and type checking**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/ipc-schemas.test.ts
npm --prefix apps/publisher run typecheck
```

Expected: schema tests and typecheck PASS. The remaining fixed-domain behavior is still covered by its existing tests and is converted test-first in Task 5.

- [ ] **Step 6: Commit the contract slice**

```powershell
git add apps/publisher/src/shared/contracts.ts apps/publisher/src/shared/ipcSchemas.ts apps/publisher/tests/unit/ipc-schemas.test.ts
git commit -m "feat: define dynamic domain contracts"
```

---

### Task 2: Build Safe Domain Discovery

**Files:**
- Create: `apps/publisher/src/main/services/domains.ts`
- Create: `apps/publisher/tests/unit/domains.test.ts`
- Modify: `apps/publisher/src/main/publisherServices.ts`

- [ ] **Step 1: Write failing discovery tests with real fixture directories**

Cover ordered discovery, note counts, malformed metadata exclusion, top-level-only rules, and symlink rejection:

```ts
it("discovers marked top-level domain indexes in stable order", async () => {
  const workspace = await gardenFixture()
  await writeDomain(workspace, "reading", {
    title: "读书与思考",
    description: "阅读记录",
    gardenDomain: true,
    domainOrder: 2,
  })
  await writeDomain(workspace, "ai", {
    title: "人工智能",
    description: "模型与应用",
    gardenDomain: true,
    domainOrder: 1,
  })
  await writeNote(workspace, "content/ai/public-note.md")
  await writeNote(workspace, "private/ai/private-note.md")

  await expect(discoverDomains(workspace)).resolves.toEqual([
    expect.objectContaining({ slug: "ai", publicNotes: 1, privateNotes: 1, order: 1 }),
    expect.objectContaining({ slug: "reading", order: 2 }),
  ])
})
```

Add a junction/symlink test that expects `DOMAIN_UNSAFE_PATH`, and a nested `content/topics/ai/index.md` case that is not discovered.

- [ ] **Step 2: Run discovery tests and verify RED**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/domains.test.ts -t "discovers"
```

Expected: FAIL because `discoverDomains` does not exist.

- [ ] **Step 3: Implement canonical discovery and metadata parsing**

Create focused exports:

```ts
export interface DomainCatalog {
  list(): Promise<readonly DomainSummary[]>
  require(slug: DomainSlug): Promise<DomainSummary>
  create(request: DomainCreateRequest): Promise<readonly DomainSummary[]>
  rename(request: DomainRenameRequest): Promise<readonly DomainSummary[]>
  remove(request: DomainRemoveRequest): Promise<readonly DomainSummary[]>
  assertIdle(): Promise<void>
  dispose(): Promise<void>
}

export async function discoverDomains(workspace: string): Promise<readonly DomainSummary[]>
export async function discoverDomainSlugs(workspace: string): Promise<ReadonlySet<string>>
```

Discovery must canonicalize the workspace and both managed roots, inspect only immediate `content/<slug>/index.md` candidates, reject links, read through file handles, verify identity after reading, parse with `gray-matter`, require `gardenDomain === true`, and validate `title`, `description`, and integer `domainOrder`. Count only direct `*.md` notes other than `index.md`; do not follow directories or links.

- [ ] **Step 4: Add deterministic fallback behavior**

Malformed marked domain pages produce a structured `DOMAIN_METADATA_INVALID` error with their relative path. A missing `domainOrder` on an otherwise valid legacy page sorts after explicit orders by slug. Do not silently include unmarked top-level pages.

- [ ] **Step 5: Run discovery tests**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/domains.test.ts
```

Expected: all discovery and safety tests PASS.

- [ ] **Step 6: Commit discovery**

```powershell
git add apps/publisher/src/main/services/domains.ts apps/publisher/tests/unit/domains.test.ts
git commit -m "feat: discover content-backed domains"
```

---

### Task 3: Implement Domain Create, Rename, and Empty Removal

**Files:**
- Modify: `apps/publisher/src/main/services/domains.ts`
- Modify: `apps/publisher/tests/unit/domains.test.ts`

- [ ] **Step 1: Write failing creation tests**

Test valid output, next order, duplicate slug/name, reserved names, collision with an unmarked directory, and rollback after a simulated second write failure:

```ts
const result = await catalog.create({ name: "人工智能", slug: "artificial-intelligence" })
expect(result.at(-1)).toMatchObject({
  slug: "artificial-intelligence",
  name: "人工智能",
  order: 5,
})
expect(await readFile(join(workspace, "content/artificial-intelligence/index.md"), "utf8"))
  .toContain("gardenDomain: true")
expect(await lstat(join(workspace, "private/artificial-intelligence"))).toBeDirectory()
```

- [ ] **Step 2: Run creation tests and verify RED**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/domains.test.ts -t "create"
```

Expected: FAIL because catalog mutations are not implemented.

- [ ] **Step 3: Implement serialized creation**

Use a per-workspace mutation queue and exclusive `wx` creation. Generate this landing page while preserving UTF-8 and LF output:

```ts
const markdown = matter.stringify(
  `\n这里用于整理${name}领域的学习记录。\n`,
  {
    title: name,
    date: shanghaiCalendarDate(),
    description: `${name}领域的学习记录。`,
    tags: [slug],
    gardenDomain: true,
    domainOrder: nextOrder,
  },
)
```

Create `content/<slug>` and `private/<slug>` only after final parent identity checks. If any later step fails, remove only empty directories and the exact inode created by the operation; otherwise return a rollback failure without touching pre-existing paths.

- [ ] **Step 4: Write failing rename tests**

```ts
const before = await readFile(indexPath, "utf8")
await catalog.rename({ slug: "reading", name: "深度阅读" })
const after = await readFile(indexPath, "utf8")
expect(matter(after).data.title).toBe("深度阅读")
expect(matter(after).content).toBe(matter(before).content)
expect(await exists(join(workspace, "content/reading"))).toBe(true)
```

Also reject duplicate display names and a landing page changed between read and replace.

- [ ] **Step 5: Implement title-only durable rename**

Reuse the project's same-directory temporary-file, sync, identity recheck, rename, and directory-sync pattern. Modify only `frontmatter.title`; keep slug, order, description, tags, and Markdown body unchanged.

- [ ] **Step 6: Write failing removal and concurrency tests**

Test public note, private note, attachment, unexpected file, concurrent creation after inspection, successful empty removal, staging rollback, and trash failure:

```ts
await writeNote(workspace, "private/ai/secret.md")
await expect(catalog.remove({ slug: "ai" })).rejects.toMatchObject({
  code: "DOMAIN_NOT_EMPTY",
})
expect(await exists(join(workspace, "content/ai/index.md"))).toBe(true)
```

- [ ] **Step 7: Implement single-staging-directory removal**

After a final handle-based emptiness and identity check, create `.garden-publisher/domain-transactions/<uuid>/`. Rename `content/<slug>` and `private/<slug>` into that transaction directory, rolling the first rename back if the second fails. Sync all affected parents, write a small manifest, then call the existing `TrashAdapter` once on the transaction directory. On trash failure, restore both paths from the manifest before resolving the operation as failed.

The domain catalog reports busy until staging, trash, and any rollback are durably complete. `assertIdle()` rejects while an operation is active; `dispose()` waits for a known-safe completion and fails closed on an uncertain filesystem outcome.

- [ ] **Step 8: Run domain tests and commit mutations**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/domains.test.ts
git add apps/publisher/src/main/services/domains.ts apps/publisher/tests/unit/domains.test.ts
git commit -m "feat: manage domain lifecycle safely"
```

Expected: all domain tests PASS.

---

### Task 4: Expose Domains Through Trusted IPC and Runtime Lifecycles

**Files:**
- Modify: `apps/publisher/src/preload/gardenApi.ts`
- Modify: `apps/publisher/src/main/ipc.ts`
- Modify: `apps/publisher/src/main/publisherServices.ts`
- Modify: `apps/publisher/src/main/index.ts`
- Test: `apps/publisher/tests/unit/ipc.test.ts`
- Test: `apps/publisher/tests/unit/publisher-services.test.ts`

- [ ] **Step 1: Write failing preload and handler tests**

Verify exact channel/request pairs, response validation, rejected untrusted senders, cleanup, and domain lifecycle participation:

```ts
await api.domains.create({ name: "人工智能", slug: "artificial-intelligence" })
expect(ipc.invocations.at(-1)).toEqual({
  channel: IPC_CHANNELS.requests.domainsCreate,
  request: { name: "人工智能", slug: "artificial-intelligence" },
})
```

Add a service test where `domains.assertIdle()` is pending and confirm blog switch preparation does not dispose preview or relaunch until it resolves.

- [ ] **Step 2: Run IPC tests and verify RED**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/ipc.test.ts tests/unit/publisher-services.test.ts
```

Expected: FAIL because the domain methods are not exposed or registered.

- [ ] **Step 3: Add the frozen preload capability**

```ts
const domains = Object.freeze({
  list: () => invoke<readonly DomainSummary[]>(ipc, IPC_CHANNELS.requests.domainsList),
  create: (request: DomainCreateRequest) =>
    invoke<readonly DomainSummary[]>(ipc, IPC_CHANNELS.requests.domainsCreate, request),
  rename: (request: DomainRenameRequest) =>
    invoke<readonly DomainSummary[]>(ipc, IPC_CHANNELS.requests.domainsRename, request),
  remove: (request: DomainRemoveRequest) =>
    invoke<readonly DomainSummary[]>(ipc, IPC_CHANNELS.requests.domainsRemove, request),
})
```

Return it from `createGardenApi` without exposing Electron objects.

- [ ] **Step 4: Register trusted main handlers**

Extend `PublisherRuntimeServices` with a `domains` port. Register four `secureHandler` entries using `noRequestSchema`, `domainCreateSchema`, `domainRenameSchema`, and `domainRemoveSchema`. Include every new channel in unregister cleanup and duplicate-registration rollback.

- [ ] **Step 5: Wire runtime barriers**

Create one workspace-bound catalog in `createPublisherServices`. Make `assertSwitchSafe()` await both publisher idle state and `domains.assertIdle()`. Make `dispose()` await the domain catalog before preview disposal. A failed domain cleanup restores blog-management operability through the existing recovery boundary.

- [ ] **Step 6: Run IPC, lifecycle, and type checks**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/ipc.test.ts tests/unit/publisher-services.test.ts tests/unit/blog-runtime.test.ts
npm --prefix apps/publisher run typecheck
```

Expected: all listed tests and typecheck PASS after Tasks 1-4 call sites are updated.

- [ ] **Step 7: Commit IPC wiring**

```powershell
git add apps/publisher/src/preload/gardenApi.ts apps/publisher/src/main/ipc.ts apps/publisher/src/main/publisherServices.ts apps/publisher/src/main/index.ts apps/publisher/tests/unit/ipc.test.ts apps/publisher/tests/unit/publisher-services.test.ts
git commit -m "feat: expose workspace domain management"
```

---

### Task 5: Convert the Note Pipeline to Discovered Domains

**Files:**
- Modify: `apps/publisher/src/main/services/noteIndex.ts`
- Modify: `apps/publisher/src/main/services/noteFiles.ts`
- Modify: `apps/publisher/src/main/services/noteTransactions.ts`
- Modify: `apps/publisher/src/main/services/trash.ts`
- Modify: `apps/publisher/src/main/services/trashRecovery.ts`
- Modify: `apps/publisher/tests/unit/noteIndex.test.ts`
- Modify: `apps/publisher/tests/unit/noteFiles.test.ts`
- Modify: `apps/publisher/tests/integration/noteTransactions.test.ts`
- Modify: `apps/publisher/tests/unit/trash.test.ts`
- Modify: `apps/publisher/tests/unit/trashRecovery.test.ts`

- [ ] **Step 1: Write failing dynamic note-index tests**

Create a marked `content/artificial-intelligence/index.md`, then public/private notes below the same slug. Assert they are indexed while a note below an unmarked folder is rejected:

```ts
expect(await scanNotes(workspace)).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      path: "content/artificial-intelligence/models.md",
      domain: "artificial-intelligence",
    }),
  ]),
)
```

- [ ] **Step 2: Run note-index tests and verify RED**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/noteIndex.test.ts
```

Expected: FAIL because the custom directory is outside the fixed domain set.

- [ ] **Step 3: Make indexing domain-catalog driven**

At the start of a scan, call `discoverDomainSlugs(workspace)` once and pass the immutable set through path parsing. Require exactly `<root>/<known-domain>/<slug>.md`; continue excluding every `index.md`. Revalidate the marked domain page identity before returning results so deletion or replacement during the scan fails closed.

- [ ] **Step 4: Write failing create/read/save/rename tests**

Cover custom-domain create, read, save, visibility move, domain move, collision, removal race, and unmarked-domain rejection. The desired custom create is:

```ts
await expect(
  createNote({
    workspace,
    visibility: "public",
    domain: "artificial-intelligence",
    slug: "transformers",
    title: "Transformer",
    date: "2026-10-04",
    description: "模型结构",
    tags: ["ai"],
  }),
).resolves.toMatchObject({ path: "content/artificial-intelligence/transformers.md" })
```

- [ ] **Step 5: Replace fixed sets in note files and transactions**

Remove local `domains`, `validDomains`, and four-value `NoteDomain` declarations. Parse the path shape first, then resolve the domain against the current catalog before opening a note or planning a transaction. Transaction-wide Markdown scans iterate the discovered slug set sorted lexically. Capture one domain snapshot per transaction and revalidate affected domain landing pages before commit.

- [ ] **Step 6: Write failing trash and recovery tests**

Verify attachment ambiguity checks span every discovered domain, recovery accepts custom domains, and recovery rejects a journal whose domain is no longer marked. Include two custom domains sharing one note slug so attachment cleanup remains retained-ambiguous.

- [ ] **Step 7: Convert trash and recovery validation**

Replace `NOTE_DOMAINS` loops and fixed recovery regexes with shape parsing plus `discoverDomainSlugs(workspace)`. Keep the existing path lease, inode, containment, journal, and recovery namespace guarantees unchanged.

- [ ] **Step 8: Run the focused note pipeline**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/noteIndex.test.ts tests/unit/noteFiles.test.ts tests/integration/noteTransactions.test.ts tests/unit/trash.test.ts tests/unit/trashRecovery.test.ts --maxWorkers=2
npm --prefix apps/publisher run typecheck
```

Expected: all focused tests and typecheck PASS.

- [ ] **Step 9: Commit the dynamic note model**

```powershell
git add apps/publisher/src/main/services/noteIndex.ts apps/publisher/src/main/services/noteFiles.ts apps/publisher/src/main/services/noteTransactions.ts apps/publisher/src/main/services/trash.ts apps/publisher/src/main/services/trashRecovery.ts apps/publisher/tests/unit/noteIndex.test.ts apps/publisher/tests/unit/noteFiles.test.ts apps/publisher/tests/integration/noteTransactions.test.ts apps/publisher/tests/unit/trash.test.ts apps/publisher/tests/unit/trashRecovery.test.ts
git commit -m "feat: support notes in discovered domains"
```

---

### Task 6: Add the Domain Manager and Live Renderer State

**Files:**
- Create: `apps/publisher/src/renderer/src/components/DomainManager.tsx`
- Create: `apps/publisher/tests/unit/domain-manager.test.tsx`
- Modify: `apps/publisher/src/renderer/src/App.tsx`
- Modify: `apps/publisher/src/renderer/src/components/NoteSidebar.tsx`
- Modify: `apps/publisher/src/renderer/src/components/MarkdownEditor.tsx`
- Modify: `apps/publisher/src/renderer/src/editor/wikiCompletion.ts`
- Modify: `apps/publisher/src/renderer/src/styles.css`
- Modify: `apps/publisher/tests/unit/main-layout.test.tsx`
- Modify: `apps/publisher/tests/unit/app-smoke.test.tsx`

- [ ] **Step 1: Write failing domain-manager component tests**

Test create, invalid slug feedback, rename, non-empty deletion disablement, confirmation, busy modal behavior, Escape, focus restoration, and failed request recovery:

```tsx
await user.click(screen.getByRole("button", { name: "管理领域" }))
const dialog = screen.getByRole("dialog", { name: "管理领域" })
await user.type(within(dialog).getByRole("textbox", { name: "显示名称" }), "人工智能")
await user.type(within(dialog).getByRole("textbox", { name: "英文路径" }), "artificial-intelligence")
await user.click(within(dialog).getByRole("button", { name: "创建领域" }))
expect(onCreate).toHaveBeenCalledWith({
  name: "人工智能",
  slug: "artificial-intelligence",
})
```

- [ ] **Step 2: Run component tests and verify RED**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/domain-manager.test.tsx
```

Expected: FAIL because `DomainManager` does not exist.

- [ ] **Step 3: Implement the accessible manager**

Build the modal on `ModalShell`. Keep a single explicit mode (`list`, `create`, `rename`, or `confirm-remove`), focus the first relevant field on mode changes, disable close only while a request is in flight, and render service errors with `role="alert"`. Use `publicNotes + privateNotes > 0` to disable delete and show the exact counts.

- [ ] **Step 4: Write failing App and sidebar tests**

Add a `domains.list` mock returning the four existing domains plus `artificial-intelligence`. Assert:

```ts
expect(screen.getByRole("button", { name: "人工智能" })).toBeVisible()
await user.click(screen.getByRole("button", { name: "新建笔记" }))
expect(screen.getByRole("option", { name: "人工智能" })).toHaveValue("artificial-intelligence")
```

After a successful remove response omitting the active filter, assert the sidebar returns to `全部领域`.

- [ ] **Step 5: Load one live domain list in App**

Add `domains`, `domainsState`, and `domainError` state. Load domains alongside notes during bootstrap; pass them to `NoteSidebar`; refresh them after create, rename, remove, recovery reload, and active-blog startup. Domain operation helpers update from the service response rather than locally guessing filesystem state.

- [ ] **Step 6: Make sidebar, preview, and completion use strings**

Replace the hardcoded `domains` array in `NoteSidebar` with:

```ts
const filters = [
  { value: "all", label: "全部领域" },
  ...props.domains.map((domain) => ({ value: domain.slug, label: domain.name })),
]
```

Use the same list for the create selector. Keep preview paths and Wiki completion labels based on stable slugs, while showing display names where available. Reset a selected filter when its slug disappears.

- [ ] **Step 7: Style and verify responsive behavior**

Add manager rows, count badges, inline forms, destructive confirmation, and 620px responsive stacking without altering the existing three-pane grid. Preserve visible focus rings and minimum touch targets.

- [ ] **Step 8: Run renderer tests and commit**

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/domain-manager.test.tsx tests/unit/main-layout.test.tsx tests/unit/app-smoke.test.tsx
npm --prefix apps/publisher run typecheck
git add apps/publisher/src/renderer/src/components/DomainManager.tsx apps/publisher/src/renderer/src/App.tsx apps/publisher/src/renderer/src/components/NoteSidebar.tsx apps/publisher/src/renderer/src/components/MarkdownEditor.tsx apps/publisher/src/renderer/src/editor/wikiCompletion.ts apps/publisher/src/renderer/src/styles.css apps/publisher/tests/unit/domain-manager.test.tsx apps/publisher/tests/unit/main-layout.test.tsx apps/publisher/tests/unit/app-smoke.test.tsx
git commit -m "feat: manage domains from the publisher"
```

Expected: focused renderer tests and typecheck PASS.

---

### Task 7: Render Dynamic Quartz Domain Cards

**Files:**
- Modify: `quartz/components/GardenOverview.tsx`
- Modify: `quartz/components/GardenOverview.test.ts`
- Modify: `content/reading/index.md`
- Modify: `content/technology/index.md`
- Modify: `content/language/index.md`
- Modify: `content/life/index.md`

- [ ] **Step 1: Write failing dynamic overview tests**

Replace fixed-object assertions with a card model:

```ts
const model = buildDomainOverview([
  domainIndex("artificial-intelligence/index", "人工智能", "模型与应用", 5),
  note("artificial-intelligence/transformers"),
  domainIndex("reading/index", "读书与思考", "书籍与观点", 1),
  note("reading/hidden", { unlisted: true }),
])

assert.deepEqual(model, {
  totalNotes: 1,
  domains: [
    { slug: "reading", title: "读书与思考", detail: "书籍与观点", order: 1, count: 0 },
    {
      slug: "artificial-intelligence",
      title: "人工智能",
      detail: "模型与应用",
      order: 5,
      count: 1,
    },
  ],
})
```

Test malformed marked pages, nested indexes, duplicate slugs, missing order fallback, unlisted notes, and domain indexes excluded from counts.

- [ ] **Step 2: Run Quartz component tests and verify RED**

```powershell
node --import tsx --test quartz/components/GardenOverview.test.ts
```

Expected: FAIL because the component still exports fixed four-domain counting.

- [ ] **Step 3: Implement the dynamic overview model**

Export a pure `buildDomainOverview(files)` function. Identify only top-level `<slug>/index` pages with `frontmatter.gardenDomain === true`, a valid title/description, and a safe slug. Sort by integer `domainOrder`, then slug. Count visible non-index files whose first path segment is a discovered domain.

Render:

```tsx
<p class="garden-stats">
  {model.totalNotes} notes · {model.domains.length} domains
</p>
```

Map model entries to the existing card markup and `resolveRelative` links. Format card numbers from the final array index with two digits.

- [ ] **Step 4: Mark the existing four landing pages**

Add these exact values without changing page bodies:

```yaml
gardenDomain: true
domainOrder: 1
```

Use order `1` for reading, `2` for technology, `3` for language, and `4` for life.

- [ ] **Step 5: Run component and site builds**

```powershell
node --import tsx --test quartz/components/GardenOverview.test.ts
npm run check
npx quartz build
```

Expected: tests PASS, repository checks PASS, and `public/index.html` contains `4 domains` plus links to all four marked landing pages.

- [ ] **Step 6: Commit the public-site slice**

```powershell
git add quartz/components/GardenOverview.tsx quartz/components/GardenOverview.test.ts content/reading/index.md content/technology/index.md content/language/index.md content/life/index.md
git commit -m "feat: render dynamic domain cards"
```

---

### Task 8: Prove Custom Domains Across Restarts and Blogs

**Files:**
- Modify: `apps/publisher/tests/e2e/app.spec.ts`
- Modify: `apps/publisher/tests/helpers/git.ts`
- Modify: `apps/publisher/playwright.config.ts` only if the existing 120-second per-test limit is insufficient after measuring the new workflow.

- [ ] **Step 1: Add a failing custom-domain E2E workflow**

Extend the fixture helper so a test can write marked domain indexes. Add a test that:

1. launches Blog A;
2. opens `管理领域`;
3. creates `人工智能 / artificial-intelligence`;
4. creates one public note and one private note in it;
5. filters to the new domain and verifies both note paths;
6. attempts removal and sees the non-empty error;
7. restarts and verifies the domain and notes remain;
8. switches to Blog B and verifies the custom domain is absent;
9. switches back and verifies it returns.

Use role-based selectors:

```ts
await page.getByRole("button", { name: "管理领域" }).click()
await page.getByRole("textbox", { name: "显示名称" }).fill("人工智能")
await page.getByRole("textbox", { name: "英文路径" }).fill("artificial-intelligence")
await page.getByRole("button", { name: "创建领域" }).click()
await expect(page.getByRole("button", { name: "人工智能" })).toBeVisible()
```

- [ ] **Step 2: Run the single test and verify RED**

```powershell
npm --prefix apps/publisher run test:e2e -- --grep "manages custom domains"
```

Expected: FAIL because the manager and runtime flow are not yet connected end to end.

- [ ] **Step 3: Resolve integration gaps only**

Fix only failures revealed at real boundaries: bootstrap ordering, live refresh, relaunch persistence, or blog isolation. Do not add new domain features. Add a unit regression beside the responsible component before each production fix.

- [ ] **Step 4: Add empty-domain deletion coverage**

Create a second empty domain, confirm its removal, assert both managed paths are absent, and verify the trash adapter receipt/fixture contains the staged transaction directory. Do not delete the notes created for the persistence portion of the test.

- [ ] **Step 5: Run all desktop E2E tests**

```powershell
npm --prefix apps/publisher run test:e2e
```

Expected: all existing and new E2E tests PASS with no surviving Electron or bundled Node process.

- [ ] **Step 6: Commit E2E coverage**

```powershell
git add apps/publisher/tests/e2e/app.spec.ts apps/publisher/tests/helpers/git.ts apps/publisher/playwright.config.ts
git commit -m "test: cover custom domains end to end"
```

---

### Task 9: Full Verification, Packaging, Installed Smoke Test, and Delivery

**Files:**
- No source modifications are planned in this task; any regression returns to the responsible earlier task for a failing test and focused fix.
- Build artifact: `apps/publisher/release/Knowledge-Garden-Publisher-0.1.0-Setup.exe`
- Desktop copy: `C:\Users\11546\Desktop\Knowledge-Garden-Publisher-0.1.0-Setup.exe`
- Website checkout: `C:\Users\11546\Desktop\web`

- [ ] **Step 1: Run formatting, static checks, and the complete test suite**

```powershell
npx prettier apps/publisher/src apps/publisher/tests quartz/components --check
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run test:run -- --maxWorkers=2
node --import tsx --test quartz/components/GardenOverview.test.ts
npm run check
```

Expected: every command exits `0`; Vitest reports no failed files or tests.

- [ ] **Step 2: Run desktop E2E again from a clean process state**

Verify no test-owned Electron or bundled Node process remains, then run:

```powershell
npm --prefix apps/publisher run test:e2e
```

Expected: all Playwright tests PASS and port 8080 is free after cleanup.

- [ ] **Step 3: Build the Windows installer**

```powershell
npm --prefix apps/publisher run package:win
```

Expected: exit `0` and a freshly timestamped NSIS installer at the release path. Existing Lucide `use client` bundler notices are warnings, not failures.

- [ ] **Step 4: Install without disrupting an active user session**

Confirm no Publisher process is running. Launch the exact release installer with `/S`, wait for it to exit, and verify the installed `resources/app.asar` hash matches `release/win-unpacked/resources/app.asar`.

- [ ] **Step 5: Run an installed-application smoke test with isolated user data**

Create an untracked temporary Playwright spec through `apply_patch`, and delete it through `apply_patch` after the run. The spec must:

1. seed an isolated blog and registry;
2. launch the installed executable;
3. create a custom domain;
4. create a note within it;
5. verify its live preview route;
6. restart and verify persistence;
7. verify non-empty deletion is blocked;
8. close through `BrowserWindow.close()` and poll until port 8080 is free.

Run:

```powershell
npx playwright test tests/e2e/custom-domain-packaged.temp.spec.ts --workers=1
```

Expected: `1 passed` and no installed Publisher or preview process remains.

- [ ] **Step 6: Copy and hash the verified installer**

```powershell
$source = 'C:\Users\11546\Desktop\web\.worktrees\knowledge-garden-publisher\apps\publisher\release\Knowledge-Garden-Publisher-0.1.0-Setup.exe'
$destination = 'C:\Users\11546\Desktop\Knowledge-Garden-Publisher-0.1.0-Setup.exe'
Copy-Item -LiteralPath $source -Destination $destination -Force
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
if ($sourceHash -ne $destinationHash) { throw 'Installer hash mismatch' }
```

Expected: hashes match exactly.

- [ ] **Step 7: Confirm the feature branch is clean**

```powershell
git status --short
git diff --check
```

Expected: no status output and no whitespace errors. If this is not clean, return to the task that owns the changed file, add a failing regression test, implement the focused fix, rerun that task's checks, and make an explicit-path commit there before repeating Task 9.

- [ ] **Step 8: Push only the Publisher repository and verify the remote**

```powershell
git push publisher HEAD:main
$local = (git rev-parse HEAD).Trim()
$remote = ((git ls-remote publisher refs/heads/main) -split '\s+')[0]
if ($local -ne $remote) { throw 'Remote main does not match local HEAD' }
```

Expected: `publisher/main` equals local HEAD. Do not push the website `origin` remote.

- [ ] **Step 9: Sync only the verified public-site commit to the website repository**

First inspect the website checkout and identify the exact Task 7 commit:

```powershell
$website = 'C:\Users\11546\Desktop\web'
$siteCommit = (git log --format='%H' --grep='^feat: render dynamic domain cards$' -n 1).Trim()
if (-not $siteCommit) { throw 'Dynamic domain site commit was not found' }
git -C $website status --short
git show --stat --oneline $siteCommit
```

Proceed only when tracked website changes do not overlap `quartz/components/GardenOverview.tsx`, its test, or the four domain index pages. Preserve unrelated untracked state such as `.garden-publisher/`. Cherry-pick the site-only commit, verify the website checkout, and push its own origin:

```powershell
git -C $website cherry-pick $siteCommit
Push-Location $website
try {
  npm run check
  if ($LASTEXITCODE -ne 0) { throw 'Website checks failed' }
  npx quartz build
  if ($LASTEXITCODE -ne 0) { throw 'Website build failed' }
} finally {
  Pop-Location
}
git -C $website push origin HEAD:main
$websiteLocal = (git -C $website rev-parse HEAD).Trim()
$websiteRemote = ((git -C $website ls-remote origin refs/heads/main) -split '\s+')[0]
if ($websiteLocal -ne $websiteRemote) { throw 'Website origin/main does not match local HEAD' }
```

Expected: only the Quartz overview, its test, and the four domain landing pages are introduced by the cherry-pick; the live-site repository is not polluted with Publisher application commits.

- [ ] **Step 10: Report the verified boundary**

Report both repository URLs and commits, the installed executable, desktop installer, SHA-256, exact unit/integration and E2E counts, packaged smoke result, website build result, and whether port 8080 is free. Mention any warning that remains, but do not describe an unobserved visual state as verified.
