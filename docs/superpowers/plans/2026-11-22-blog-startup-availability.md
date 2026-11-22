# Blog Startup Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a registered, locally safe blog even when Git or remote inspection is unavailable, while preserving strict validation for adding, recovering, relocating, and cloning blogs.

**Architecture:** Add a focused local-availability inspector backed by `inspectWorkspaceSafety`. Inject it separately into the existing blog runtime and management adapter so startup/listing use filesystem safety while registration and link/import operations retain the strict `inspectBlogCandidate` path.

**Tech Stack:** Electron 44, TypeScript, Node filesystem APIs, React 19, Vitest 5, Playwright Electron E2E

---

## File Map

- Create `apps/publisher/src/main/services/blogAvailability.ts`: translate workspace safety inspection into an explicit local availability result.
- Create `apps/publisher/tests/unit/blog-availability.test.ts`: verify real filesystem safety and canonical paths without invoking Git.
- Modify `apps/publisher/src/main/blogRuntime.ts`: separate local availability inspection from strict candidate inspection.
- Modify `apps/publisher/tests/unit/blog-runtime.test.ts`: lock the separation at runtime and management-adapter boundaries.
- Modify `apps/publisher/src/main/index.ts`: wire local availability to startup/listing while preserving strict candidate validation elsewhere.
- Modify `apps/publisher/tests/e2e/app.spec.ts`: prove a locally valid garden without an `origin` reaches diagnostics/editor rather than blog recovery.

### Task 1: Add the local blog availability inspector

**Files:**

- Create: `apps/publisher/src/main/services/blogAvailability.ts`
- Create: `apps/publisher/tests/unit/blog-availability.test.ts`

- [ ] **Step 1: Write the failing filesystem regression tests**

Create `apps/publisher/tests/unit/blog-availability.test.ts` with real temporary directories:

```ts
// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { inspectBlogAvailability } from "../../src/main/services/blogAvailability"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function localBlog(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blog-availability-"))
  roots.push(root)
  await mkdir(join(root, "content"))
  await mkdir(join(root, "private"))
  return root
}

describe("inspectBlogAvailability", () => {
  it("accepts the local editing structure without consulting Git", async () => {
    const root = await localBlog()

    await expect(inspectBlogAvailability(root)).resolves.toEqual({
      available: true,
      canonicalPath: await realpath(resolve(root)),
    })
  })

  it("rejects a blog whose private editing directory is missing", async () => {
    const root = await localBlog()
    await rm(join(root, "private"), { recursive: true })

    await expect(inspectBlogAvailability(root)).resolves.toEqual({ available: false })
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
cd apps/publisher
npx vitest run tests/unit/blog-availability.test.ts
```

Expected: FAIL because `services/blogAvailability` does not exist.

- [ ] **Step 3: Implement the minimal availability adapter**

Create `apps/publisher/src/main/services/blogAvailability.ts`:

```ts
import { inspectWorkspaceSafety } from "./workspace"

export type BlogAvailabilityInspection =
  { readonly available: true; readonly canonicalPath: string } | { readonly available: false }

export async function inspectBlogAvailability(path: string): Promise<BlogAvailabilityInspection> {
  const inspection = await inspectWorkspaceSafety(path)
  return inspection.ok ? { available: true, canonicalPath: inspection.root } : { available: false }
}
```

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```powershell
npx vitest run tests/unit/blog-availability.test.ts tests/unit/workspace.test.ts
npm run typecheck
```

Expected: both test files pass and TypeScript exits with code 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add apps/publisher/src/main/services/blogAvailability.ts apps/publisher/tests/unit/blog-availability.test.ts
git commit -m "feat(publisher): inspect local blog availability"
```

### Task 2: Separate availability from strict candidate validation

**Files:**

- Modify: `apps/publisher/src/main/blogRuntime.ts`
- Modify: `apps/publisher/tests/unit/blog-runtime.test.ts`

- [ ] **Step 1: Add failing runtime and adapter tests**

In `apps/publisher/tests/unit/blog-runtime.test.ts`, import `BlogAvailabilityInspection`, add an `inspectAvailability` mock to `managementFixture`, and add these tests:

```ts
it("uses local availability rather than strict candidate validation for the active blog", async () => {
  const inspectAvailability = vi.fn(async () => ({
    available: true as const,
    canonicalPath: first.canonicalPath,
  }))
  const runtime = createBlogRuntime({
    registry: { load: async () => state(), activate: vi.fn() },
    inspectAvailability,
    assertIdle: vi.fn(),
    dispose: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(),
  })

  await expect(runtime.active()).resolves.toEqual(first)
  expect(inspectAvailability).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
})

it("lists a locally available blog when strict candidate inspection fails", async () => {
  const fixture = managementFixture()
  fixture.inspect.mockResolvedValue({
    valid: false,
    code: "GIT_UNAVAILABLE",
    message: "Git unavailable",
  })
  fixture.inspectAvailability.mockResolvedValue({
    available: true,
    canonicalPath: first.canonicalPath,
  })

  await expect(fixture.services.list()).resolves.toMatchObject({
    activeAvailability: "available",
  })
  expect(fixture.inspect).not.toHaveBeenCalled()
  expect(fixture.inspectAvailability).toHaveBeenCalledExactlyOnceWith(first.canonicalPath)
})

it("keeps strict candidate validation for registering a local blog", async () => {
  const fixture = managementFixture()
  fixture.inspect.mockResolvedValue({
    valid: false,
    code: "GIT_ORIGIN_MISSING",
    message: "origin missing",
  })

  await expect(
    fixture.services.addLocal({ name: "Local", path: first.canonicalPath }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" })
  expect(fixture.inspectAvailability).not.toHaveBeenCalled()
})
```

Update existing runtime constructor fixtures to use `inspectAvailability` instead of `inspect`; keep `managementFixture.inspect` as the strict candidate inspector.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run tests/unit/blog-runtime.test.ts
```

Expected: FAIL because `BlogRuntimeDependencies` and `createBlogManagementAdapter` do not accept or use `inspectAvailability`.

- [ ] **Step 3: Split the runtime dependency**

In `apps/publisher/src/main/blogRuntime.ts`, import `BlogAvailabilityInspection` and change the runtime dependency and validator:

```ts
export interface BlogRuntimeDependencies {
  readonly registry: BlogRuntimeRegistry
  readonly inspectAvailability: (path: string) => Promise<BlogAvailabilityInspection>
  readonly assertIdle: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly relaunch: () => void
  readonly quit: () => void
}

async function validateAvailability(
  record: BlogRecord,
  inspect: BlogRuntimeDependencies["inspectAvailability"],
): Promise<BlogRecord> {
  let inspection: BlogAvailabilityInspection
  try {
    inspection = await inspect(record.canonicalPath)
  } catch {
    throw unavailable()
  }
  if (
    !inspection.available ||
    !samePath(resolve(inspection.canonicalPath), resolve(record.canonicalPath))
  ) {
    throw unavailable()
  }
  return record
}
```

Use `validateAvailability(record, dependencies.inspectAvailability)` in both `active()` and the pre-switch target validation.

- [ ] **Step 4: Split management listing from strict operations**

Add this dependency to `createBlogManagementAdapter`:

```ts
readonly inspectAvailability: (path: string) => Promise<BlogAvailabilityInspection>
```

Change only `services.list()` to call `dependencies.inspectAvailability` and test `inspection.available`. Keep `validWorkspace`, `chooseLocal`, `addLocal`, `recoverLocal`, `relocate`, and `openLink` on the existing strict `dependencies.inspect` path.

- [ ] **Step 5: Run focused and related tests**

Run:

```powershell
npx vitest run tests/unit/blog-availability.test.ts tests/unit/blog-runtime.test.ts tests/unit/blog-import.test.ts tests/unit/app-smoke.test.tsx tests/unit/main-layout.test.tsx
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit Task 2**

```powershell
git add apps/publisher/src/main/blogRuntime.ts apps/publisher/tests/unit/blog-runtime.test.ts
git commit -m "fix(publisher): separate blog availability from Git"
```

### Task 3: Wire production startup and prove the Electron workflow

**Files:**

- Modify: `apps/publisher/src/main/index.ts`
- Modify: `apps/publisher/tests/e2e/app.spec.ts`

- [ ] **Step 1: Add an Electron E2E that removes `origin` before launch**

Add a focused test near the blog-recovery E2E cases:

```ts
test("opens a locally safe blog when Git publishing diagnostics fail", async () => {
  const garden = await createQuartzGardenFixture({
    directoryName: "Local Editing Garden",
    noteTitle: "Local Note",
    noteBody: "editable without origin",
  })
  const stateRoot = await createTemporaryDirectory("garden-publisher-local-availability-")
  let application: ElectronApplication | undefined
  try {
    expect((await git(garden.root, ["remote", "remove", "origin"])).exitCode).toBe(0)
    application = await launchApplication(stateRoot, {
      ...process.env,
      GARDEN_PUBLISHER_E2E: "1",
      GARDEN_PUBLISHER_E2E_WORKSPACE: garden.root,
      GARDEN_PUBLISHER_E2E_RUNTIME: await createE2eRuntime(stateRoot),
      GARDEN_PUBLISHER_E2E_REGISTRY: join(stateRoot, "blogs.json"),
    })
    const page = await application.firstWindow()

    await expect(page.getByRole("dialog", { name: "博客恢复" })).toHaveCount(0)
    await expect(page.getByText("Local Note", { exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "启动检查" })).toContainText(/Git|origin|仓库/)
  } finally {
    await closeApplication(application)
    await Promise.all([garden.cleanup(), removeTemporaryDirectory(stateRoot)])
  }
})
```

- [ ] **Step 2: Run the E2E and verify RED**

Run:

```powershell
npx playwright test tests/e2e/app.spec.ts --grep "opens a locally safe blog"
```

Expected: FAIL because startup still uses strict `inspectBlogCandidate` and displays “博客恢复”.

- [ ] **Step 3: Wire both inspection paths in `index.ts`**

Import `inspectBlogAvailability` from `./services/blogAvailability`.

Pass it to the runtime:

```ts
const blogRuntime = createBlogRuntime({
  registry,
  inspectAvailability: inspectBlogAvailability,
  // existing lifecycle dependencies remain unchanged
})
```

Pass both dependencies to management:

```ts
blogManagement = createBlogManagementAdapter({
  registry,
  addresses,
  inspectAvailability: inspectBlogAvailability,
  inspect: (path) => inspectBlogCandidate(path, { runner: importRunner }),
  // existing dependencies remain unchanged
})
```

Do not alter importer validation or `inspectWorkspace` startup diagnostics.

- [ ] **Step 4: Run E2E, unit tests, typecheck, and build**

Run:

```powershell
npx playwright test tests/e2e/app.spec.ts --grep "opens a locally safe blog"
npx vitest run tests/unit/blog-availability.test.ts tests/unit/blog-runtime.test.ts tests/unit/first-run.test.tsx tests/unit/app-smoke.test.tsx
npm run typecheck
npm run build
```

Expected: the E2E passes, all selected unit tests pass, and both build commands exit with code 0.

- [ ] **Step 5: Commit Task 3**

```powershell
git add apps/publisher/src/main/index.ts apps/publisher/tests/e2e/app.spec.ts
git commit -m "fix(publisher): keep local blogs open during Git failures"
```

### Task 4: Review, package, push, and update the installed app

**Files:**

- Verify only.

- [ ] **Step 1: Run the complete focused regression**

```powershell
cd apps/publisher
npx vitest run tests/unit/blog-availability.test.ts tests/unit/blog-runtime.test.ts tests/unit/blog-import.test.ts tests/unit/workspace.test.ts tests/unit/first-run.test.tsx tests/unit/app-smoke.test.tsx tests/unit/main-layout.test.tsx --maxWorkers=4
npx playwright test tests/e2e/app.spec.ts --grep "opens a locally safe blog"
npm run typecheck
npm run build
```

Expected: zero failures.

- [ ] **Step 2: Request independent code review**

Ask the reviewer to verify that local availability is filesystem-only, strict registration/import trust is unchanged, and no Git failure can select recovery UI.

- [ ] **Step 3: Check formatting and repository state**

```powershell
cd ../..
npx prettier apps/publisher/src/main/services/blogAvailability.ts apps/publisher/src/main/blogRuntime.ts apps/publisher/src/main/index.ts apps/publisher/tests/unit/blog-availability.test.ts apps/publisher/tests/unit/blog-runtime.test.ts apps/publisher/tests/e2e/app.spec.ts docs/superpowers/specs/2026-11-22-blog-startup-availability-design.md docs/superpowers/plans/2026-11-22-blog-startup-availability.md --check
git diff --check
git status --short --branch
```

Expected: formatting passes, diff check is empty, and only intended committed changes exist.

- [ ] **Step 4: Build the Windows installer**

```powershell
cd apps/publisher
npx electron-builder --win nsis --config.electronDist=node_modules/electron/dist
Get-FileHash -Algorithm SHA256 -LiteralPath 'release/Knowledge-Garden-Publisher-0.1.5-Setup.exe'
```

Expected: NSIS build exits with code 0 and prints a SHA-256 hash.

- [ ] **Step 5: Push only by fast-forward**

```powershell
cd ../..
git fetch publisher main
git merge-base --is-ancestor publisher/main HEAD
git push publisher HEAD:main
git ls-remote publisher refs/heads/main
git rev-parse HEAD
```

Expected: the ancestor check exits with code 0 and remote `main` equals local `HEAD`.

- [ ] **Step 6: Update and verify the installed application**

Confirm no Publisher process is running, copy the verified `release/win-unpacked` tree into `C:\Users\11546\AppData\Local\Programs\Knowledge Garden Publisher`, and compare every source file SHA-256 with its installed counterpart. Preserve `C:\Users\11546\Desktop\Knowledge Garden Publisher.lnk`.

Launch the installed executable with a temporary remote-debugging port, read the real renderer body, and verify it contains `个人知识花园` and the registered note list while it does not contain `博客恢复`. Close the diagnostic instance afterward.

- [ ] **Step 7: Record delivery evidence**

Report the pushed commit, installer path and hash, installed-tree comparison count, shortcut target, focused test totals, and real packaged-app UI assertion.
