# Appearance Preview Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the active appearance draft visible when the user navigates between pages inside the local Quartz preview iframe, without weakening the exact loopback security boundary.

**Architecture:** Give the appearance iframe a session-specific query parameter so its initial frame is unambiguous, then bind the successful first injection to Electron's stable `frameTreeNodeId`. A focused main-process controller owns the active session, reinjects the latest CSS after trusted navigation events, and clears the current document by frame identity instead of by the initial URL.

**Tech Stack:** Electron 44 `WebFrameMain`/`webFrameMain`, TypeScript, React, Vitest, Playwright Electron E2E.

---

## File map

- Create `apps/publisher/src/main/appearancePreviewController.ts`: navigation-aware session state, boundary validation, serialized reinjection, and cleanup.
- Create `apps/publisher/tests/unit/appearance-preview-controller.test.ts`: controller behavior without Electron.
- Modify `apps/publisher/src/main/previewAppearance.ts`: expose exact-frame injection/cleanup primitives that accept stable frame ports.
- Modify `apps/publisher/src/main/index.ts`: adapt Electron frames and navigation events to the controller, and dispose listeners with the window/runtime.
- Modify `apps/publisher/src/renderer/src/components/AppearanceDesigner.tsx`: derive one session-tagged iframe/request URL.
- Modify `apps/publisher/src/renderer/src/components/AppearancePreview.tsx`: receive the session-tagged URL unchanged.
- Modify `apps/publisher/tests/unit/appearance-designer.test.tsx`: prove iframe and IPC use the same unique URL.
- Modify `apps/publisher/tests/e2e/app.spec.ts`: preserve the failing real-navigation regression and verify cleanup.

### Task 1: Build the navigation-aware controller with unit tests

**Files:**

- Create: `apps/publisher/src/main/appearancePreviewController.ts`
- Create: `apps/publisher/tests/unit/appearance-preview-controller.test.ts`
- Modify: `apps/publisher/src/main/previewAppearance.ts`

- [ ] **Step 1: Write failing controller tests**

Define test ports with a stable identity and recorded injected CSS:

```ts
type TestFrame = AppearancePreviewFramePort & { styles: Map<string, string> }

function frame(id: number, url: string): TestFrame {
  const styles = new Map<string, string>()
  return {
    frameTreeNodeId: id,
    url,
    detached: false,
    styles,
    executeJavaScript: vi.fn(async (source) => {
      if (source.includes("data-publisher-appearance-preview")) {
        styles.set("active", source)
      }
      return true
    }),
  }
}
```

Cover these behaviors as separate tests:

```ts
it("binds the first exact frame and updates the same frame after trusted navigation", async () => {
  const target = frame(41, "http://127.0.0.1:8081/token/life/note?kgpAppearance=session")
  const controller = createAppearancePreviewController({ frames: () => [target] })
  await expect(controller.install(request("first"))).resolves.toBe(true)

  target.url = "http://127.0.0.1:8081/token/life/"
  await controller.didNavigate({ frameTreeNodeId: 41, url: target.url, finished: true })

  expect(target.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining("first"), true)
})

it.each([
  "http://localhost:8081/token/life/",
  "https://127.0.0.1:8081/token/life/",
  "http://127.0.0.1:8082/token/life/",
  "https://example.com/",
])("does not inject after navigation outside the bound preview origin: %s", async (url) => {
  // Bind frame 41, navigate it to url, emit didNavigate, and assert no additional execution.
})

it("updates the latest CSS on the bound frame after it has navigated", async () => {
  // Install first CSS at the exact session URL, navigate, then install second CSS using
  // the same session ID and assert the current frame receives the second CSS.
})

it("clears the current document and forgets the session idempotently", async () => {
  // Bind, navigate, remove twice, and assert only the matching session is removed.
})

it("ignores stale queued navigation work after remove or a newer install", async () => {
  // Hold executeJavaScript, enqueue navigation, remove/update, release the old call,
  // and assert stale CSS is not restored.
})
```

- [ ] **Step 2: Run the new unit test and verify RED**

Run:

```powershell
cd apps/publisher
npm run test:run -- tests/unit/appearance-preview-controller.test.ts
```

Expected: FAIL because `createAppearancePreviewController` and `AppearancePreviewFramePort` do not exist.

- [ ] **Step 3: Expose stable-frame primitives**

In `previewAppearance.ts`, extend the frame contract and export operations that keep the current exact URL check:

```ts
export interface AppearancePreviewFramePort extends PreviewFramePort {
  readonly frameTreeNodeId: number
  readonly detached: boolean
}

export function installAppearanceStyle(
  frame: PreviewFramePort,
  request: AppearanceFramePreviewRequest,
): Promise<boolean> {
  return executeInFrame(frame, request.url, (expectedUrl) =>
    scriptFor(installPreviewStyle, {
      expectedUrl,
      sessionId: request.sessionId,
      css: request.css,
    }),
  )
}

export function removeAppearanceStyle(
  frame: PreviewFramePort,
  request: AppearanceFrameClearRequest,
): Promise<boolean> {
  return executeInFrame(frame, request.url, (expectedUrl) =>
    scriptFor(clearPreviewStyle, { expectedUrl, sessionId: request.sessionId }),
  )
}
```

Keep `previewAppearance` and `clearAppearancePreview` as compatibility wrappers around these primitives so existing boundary tests remain valid.

- [ ] **Step 4: Implement the minimal controller**

Create `appearancePreviewController.ts` with this public contract:

```ts
export interface AppearancePreviewNavigation {
  readonly frameTreeNodeId: number
  readonly url: string
  readonly finished: boolean
}

export interface AppearancePreviewController {
  install(request: AppearanceFramePreviewRequest): Promise<boolean>
  remove(request: AppearanceFrameClearRequest): Promise<boolean>
  didNavigate(event: AppearancePreviewNavigation): Promise<void>
  dispose(): Promise<void>
}

export function createAppearancePreviewController(options: {
  readonly frames: () => readonly AppearancePreviewFramePort[]
}): AppearancePreviewController
```

The controller must:

1. Bind only after `installAppearanceStyle` succeeds on an exact requested URL.
2. Store `{ sessionId, css, origin, frameTreeNodeId, revision }`.
3. For later installs with the same session, find only the stored frame ID and inject at its current trusted URL.
4. Accept navigation only when frame ID matches and `new URL(event.url).origin` equals the stored `http://127.0.0.1:<port>` origin.
5. Serialize script execution with a promise queue and compare `revision` immediately before and after execution.
6. Clear by current frame ID/current URL, then forget state even if the frame is detached.
7. Make `remove` and `dispose` idempotent.

- [ ] **Step 5: Run focused unit tests and verify GREEN**

Run:

```powershell
npm run test:run -- tests/unit/preview-appearance.test.ts tests/unit/appearance-preview-controller.test.ts tests/unit/appearance-service.test.ts
```

Expected: all tests pass; exact URL and loopback rejection tests remain green.

- [ ] **Step 6: Commit controller work**

```powershell
git add apps/publisher/src/main/previewAppearance.ts apps/publisher/src/main/appearancePreviewController.ts apps/publisher/tests/unit/preview-appearance.test.ts apps/publisher/tests/unit/appearance-preview-controller.test.ts
git commit -m "fix(publisher): retain appearance preview across navigation"
```

### Task 2: Give the appearance iframe a unique initial URL

**Files:**

- Modify: `apps/publisher/src/renderer/src/components/AppearanceDesigner.tsx`
- Modify: `apps/publisher/src/renderer/src/components/AppearancePreview.tsx`
- Modify: `apps/publisher/tests/unit/appearance-designer.test.tsx`

- [ ] **Step 1: Write a failing renderer test**

Add a test that opens the designer and captures both the iframe source and preview request:

```ts
it("uses one session-tagged URL for the iframe and preview request", async () => {
  render(<AppearanceDesigner api={api} previewUrl="http://127.0.0.1:8081/token/life/note" onClose={vi.fn()} />)
  await screen.findByRole("dialog", { name: "外观设置" })
  await waitFor(() => expect(api.preview).toHaveBeenCalled())

  const iframeUrl = new URL(screen.getByTitle("博客外观实时预览").getAttribute("src")!)
  const requestUrl = new URL(vi.mocked(api.preview).mock.calls.at(-1)![0].url)
  expect(iframeUrl.searchParams.get("kgpAppearance")).toMatch(UUID_PATTERN)
  expect(requestUrl.href).toBe(iframeUrl.href)
})
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```powershell
npm run test:run -- tests/unit/appearance-designer.test.tsx
```

Expected: FAIL because the iframe and request still use the untagged preview URL.

- [ ] **Step 3: Derive and use one tagged URL**

In `AppearanceDesigner.tsx`, derive the URL once per active base URL/session:

```ts
const sessionPreviewUrl = useMemo(() => {
  if (!activePreviewUrl) return undefined
  const url = new URL(activePreviewUrl)
  url.searchParams.set("kgpAppearance", sessionId.current)
  return url.href
}, [activePreviewUrl])
```

Use `sessionPreviewUrl` for both `api.preview({ url: ... })` and `<AppearancePreview previewUrl={...} />`. Keep `activePreviewUrl` for the apply availability check only if needed; do not regenerate the session ID during draft changes.

- [ ] **Step 4: Run renderer tests and verify GREEN**

Run:

```powershell
npm run test:run -- tests/unit/appearance-designer.test.tsx tests/unit/main-layout.test.tsx
```

Expected: both files pass, including stale preview request and close cleanup tests.

- [ ] **Step 5: Commit renderer identity work**

```powershell
git add apps/publisher/src/renderer/src/components/AppearanceDesigner.tsx apps/publisher/tests/unit/appearance-designer.test.tsx
git commit -m "fix(publisher): identify the appearance preview frame"
```

### Task 3: Wire Electron navigation events and prove the real workflow

**Files:**

- Modify: `apps/publisher/src/main/index.ts`
- Modify: `apps/publisher/tests/e2e/app.spec.ts`

- [ ] **Step 1: Keep the existing failing E2E regression**

The test already added to `appearance designer previews, applies, persists, and undoes without publishing` must:

1. Insert a same-origin domain link into the appearance iframe.
2. Click it and wait until Electron reports the target URL.
3. Assert the navigated document contains `--publisher-accent: #123456`.
4. Cancel and assert no `style[data-publisher-appearance-preview]` remains.

Run once before wiring:

```powershell
npm run test:e2e -- --grep "appearance designer previews"
```

Expected: FAIL at the post-navigation style assertion. This is the recorded RED state for the production bug.

- [ ] **Step 2: Create one controller per BrowserWindow**

In `index.ts`, import `webFrameMain` and the controller. Replace the standalone frame functions with a controller whose frame adapter exposes stable identity:

```ts
function appearanceFrames(): readonly AppearancePreviewFramePort[] {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return []
  return window.webContents.mainFrame.framesInSubtree.map((frame) => ({
    frameTreeNodeId: frame.frameTreeNodeId,
    get detached() {
      return frame.detached
    },
    get url() {
      return frame.url
    },
    executeJavaScript: (source, userGesture) => frame.executeJavaScript(source, userGesture),
  }))
}
```

Create the controller after the BrowserWindow exists and provide its `install`/`remove` methods to `createPublisherServices`.

- [ ] **Step 3: Forward trusted frame navigation events**

Register listeners on the current window's `webContents`:

```ts
const forwardFrame = (
  frameProcessId: number,
  frameRoutingId: number,
  url: string | undefined,
  finished: boolean,
): void => {
  const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
  if (!frame || frame.detached) return
  void appearancePreviewController?.didNavigate({
    frameTreeNodeId: frame.frameTreeNodeId,
    url: url ?? frame.url,
    finished,
  })
}
```

- `did-frame-finish-load`: resolve the frame and forward `finished: true` with `frame.url`.
- `did-navigate-in-page`: resolve the frame and forward the supplied URL with `finished: true`.
- On window close/runtime disposal: remove both listeners and `await controller.dispose()` before dropping the window reference.

Do not forward main renderer navigation or inject into a frame whose origin no longer matches the bound preview origin.

- [ ] **Step 4: Run the E2E regression and verify GREEN**

Run:

```powershell
npm run test:e2e -- --grep "appearance designer previews"
```

Expected: PASS. The domain target retains the draft CSS, cancel removes it, tracked files and `origin/main` remain unchanged before apply.

- [ ] **Step 5: Run focused main/renderer regression tests**

Run:

```powershell
npm run typecheck
npm run test:run -- --testTimeout=20000 tests/unit/preview-appearance.test.ts tests/unit/appearance-preview-controller.test.ts tests/unit/appearance-service.test.ts tests/unit/appearance-designer.test.tsx tests/unit/main-layout.test.tsx tests/unit/ipc.test.ts tests/unit/publisher-services.test.ts
```

Expected: typecheck succeeds and every listed test passes.

- [ ] **Step 6: Commit Electron wiring and E2E proof**

```powershell
git add apps/publisher/src/main/index.ts apps/publisher/tests/e2e/app.spec.ts
git commit -m "test(publisher): verify navigable appearance previews"
```

### Task 4: Review, package, push, and update the local installation

**Files:**

- Verify only.

- [ ] **Step 1: Run complete appearance regression**

Run:

```powershell
cd apps/publisher
npm run typecheck
npm run test:run -- --testTimeout=20000 tests/unit/app-smoke.test.tsx tests/unit/appearance-assets.test.ts tests/unit/appearance-designer.test.tsx tests/unit/appearance-contracts.test.ts tests/unit/appearance-model.test.ts tests/unit/appearance-preview-controller.test.ts tests/unit/appearance-service.test.ts tests/unit/appearance-transaction.test.ts tests/unit/changes.test.ts tests/unit/ipc-schemas.test.ts tests/unit/ipc.test.ts tests/unit/main-layout.test.tsx tests/unit/preview-appearance.test.ts tests/unit/publish-review.test.tsx tests/unit/publisher-services.test.ts tests/unit/quartz-appearance-adapter.test.ts
npm run test:e2e -- --grep "appearance designer previews"
npm run build
```

Expected: all commands exit 0. Preserve any known unrelated full-suite Windows timeout as a reported limitation rather than changing unrelated code.

- [ ] **Step 2: Request independent review**

Ask the reviewer to inspect frame-identity lifetime, loopback/origin enforcement, stale navigation races, listener disposal, and close cleanup. Resolve every correctness or security finding and rerun the affected tests.

- [ ] **Step 3: Build the final Windows package**

Run:

```powershell
npx electron-builder --win nsis --config.electronDist=node_modules/electron/dist
Get-FileHash -Algorithm SHA256 release/Knowledge-Garden-Publisher-0.1.5-Setup.exe
```

Expected: NSIS installer and unpacked executable are rebuilt, and a SHA-256 value is recorded.

- [ ] **Step 4: Push only after confirming fast-forward safety**

Run from the worktree root:

```powershell
git fetch publisher main
git merge-base --is-ancestor publisher/main HEAD
git push publisher HEAD:main
```

Expected: the ancestor check and push succeed without touching the dirty main blog workspace.

- [ ] **Step 5: Update the local installed files and verify exact bytes**

Ensure no Publisher process is running. Copy the final `release/win-unpacked` tree into the verified installation directory, preserve the existing uninstaller/user data/shortcut, then compare SHA-256 for source and installed `Knowledge Garden Publisher.exe`.

Expected: hashes match, the desktop shortcut still targets the installed executable, the feature worktree is clean, and `publisher/main` equals `HEAD`.

---

## Plan self-review

- Spec coverage: stable frame binding, same-origin navigation, full/in-page navigation, external rejection, latest CSS, cleanup, Electron E2E, packaging, and local update each map to an explicit task.
- Type consistency: `AppearancePreviewFramePort`, `AppearancePreviewNavigation`, `AppearancePreviewController`, `install`, `remove`, `didNavigate`, and `dispose` use the same names throughout.
- Scope: no blog navigation changes, no online injection, no appearance persistence changes, and no unrelated shutdown refactor.
- Placeholder scan: no deferred implementation markers or unspecified test steps remain.
