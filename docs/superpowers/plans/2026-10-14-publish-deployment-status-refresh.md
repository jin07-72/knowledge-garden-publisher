# Publish Deployment Status Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the publishable-change count after a successful push and replace the permanent waiting message with the final GitHub Actions deployment result for the just-published commit.

**Architecture:** Keep the main-process publish contract unchanged: its `complete` event means the Git push finished. Add a small renderer-side mapper for deployment outcomes, then let `PublisherApp` rescan changes and call the existing history APIs with a per-publication request ID; generation checks and cancellation prevent stale results from a prior blog or publication from updating the UI.

**Tech Stack:** React 19, TypeScript, Electron preload `GardenApi`, Vitest, Testing Library

---

## File structure

- Create `apps/publisher/src/renderer/src/publishDeploymentStatus.ts`: pure conversion from the latest Git commit plus `DeploymentHistory` into a user-facing `PublishProgress` and optional Actions URL.
- Create `apps/publisher/tests/unit/publish-deployment-status.test.ts`: exhaustive unit coverage for the pure status conversion.
- Modify `apps/publisher/src/renderer/src/App.tsx`: orchestrate post-push change refresh, deployment tracking, cancellation, stale-result protection, and the Actions link.
- Modify `apps/publisher/src/renderer/src/app.css`: style the compact Actions control in the status bar.
- Modify `apps/publisher/tests/unit/main-layout.test.tsx`: exercise event subscription, UI transitions, rescanning, cancellation, blog switching, repeated completion events, and stale async results.

### Task 1: Define deployment-result mapping

**Files:**
- Create: `apps/publisher/src/renderer/src/publishDeploymentStatus.ts`
- Create: `apps/publisher/tests/unit/publish-deployment-status.test.ts`

- [ ] **Step 1: Write the failing mapper tests**

Create `apps/publisher/tests/unit/publish-deployment-status.test.ts` with terminal-state, mismatch, and unavailable coverage:

```ts
import { describe, expect, it } from "vitest"
import type { DeploymentHistory, GitCommit } from "../../src/shared/contracts"
import { publishedDeploymentStatus } from "../../src/renderer/src/publishDeploymentStatus"

const commit: GitCommit = {
  id: "a".repeat(40),
  authoredAt: "2026-10-14T10:00:00+08:00",
  subject: "Publish notes",
}

function history(
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled",
  headSha = commit.id,
  unavailableMessage?: string,
): DeploymentHistory {
  return {
    runs: [
      {
        id: "run-1",
        headSha,
        startedAt: "2026-10-14T02:00:00Z",
        status,
        url: "https://github.com/jin07-72/knowledge-garden/actions/runs/1",
      },
    ],
    actionsUrl: "https://github.com/jin07-72/knowledge-garden/actions",
    liveSiteUrl: "https://jin07-72.github.io/knowledge-garden/",
    unavailableMessage,
  }
}

describe("publishedDeploymentStatus", () => {
  it.each([
    ["succeeded", "complete", "发布成功，部署已完成。"],
    ["failed", "failed", "发布已完成，但部署失败。"],
    ["cancelled", "failed", "发布已完成，但部署已取消。"],
  ] as const)("maps %s to an explicit terminal message", (status, phase, message) => {
    expect(publishedDeploymentStatus(commit, history(status))).toEqual({
      progress: { phase, message, percent: 100 },
      actionsUrl: "https://github.com/jin07-72/knowledge-garden/actions/runs/1",
    })
  })

  it.each([
    [undefined, history("succeeded")],
    [commit, history("succeeded", "b".repeat(40))],
    [commit, history("running")],
    [commit, history("running", commit.id, "部署状态检查超时，请通过下面的链接查看。")],
  ] as const)("reports an unknown deployment without changing push success", (latest, deployments) => {
    expect(publishedDeploymentStatus(latest, deployments)).toEqual({
      progress: {
        phase: "complete",
        message: "发布成功，暂时无法确认部署状态。",
        percent: 100,
      },
      actionsUrl: deployments.actionsUrl,
    })
  })
})
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/publish-deployment-status.test.ts
```

Expected: FAIL because `publishDeploymentStatus.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure mapper**

Create `apps/publisher/src/renderer/src/publishDeploymentStatus.ts`:

```ts
import type {
  DeploymentHistory,
  GitCommit,
  PublishProgress,
} from "../../shared/contracts"

export interface PublishedDeploymentStatus {
  readonly progress: PublishProgress
  readonly actionsUrl?: string
}

const unknownProgress: PublishProgress = {
  phase: "complete",
  message: "发布成功，暂时无法确认部署状态。",
  percent: 100,
}

export function publishedDeploymentStatus(
  latestCommit: GitCommit | undefined,
  deployments: DeploymentHistory,
): PublishedDeploymentStatus {
  const run = latestCommit
    ? deployments.runs.find((candidate) => candidate.headSha === latestCommit.id)
    : undefined

  if (!run || run.status === "pending" || run.status === "running") {
    return { progress: unknownProgress, actionsUrl: deployments.actionsUrl }
  }

  if (run.status === "succeeded") {
    return {
      progress: { phase: "complete", message: "发布成功，部署已完成。", percent: 100 },
      actionsUrl: run.url ?? deployments.actionsUrl,
    }
  }

  return {
    progress: {
      phase: "failed",
      message:
        run.status === "cancelled"
          ? "发布已完成，但部署已取消。"
          : "发布已完成，但部署失败。",
      percent: 100,
    },
    actionsUrl: run.url ?? deployments.actionsUrl,
  }
}
```

- [ ] **Step 4: Run the mapper tests and typecheck**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/publish-deployment-status.test.ts
npm --prefix apps/publisher run typecheck
```

Expected: the new test file passes and TypeScript exits with code 0.

- [ ] **Step 5: Commit the mapper**

```powershell
git add -- apps/publisher/src/renderer/src/publishDeploymentStatus.ts apps/publisher/tests/unit/publish-deployment-status.test.ts
git commit -m "feat: map published deployment outcomes"
```

### Task 2: Refresh changes and track the current deployment

**Files:**
- Modify: `apps/publisher/src/renderer/src/App.tsx:196-236`
- Modify: `apps/publisher/src/renderer/src/App.tsx:471-564`
- Modify: `apps/publisher/tests/unit/main-layout.test.tsx:1386-1420`

- [ ] **Step 1: Add a failing successful-publication UI test**

Add `PublishProgress` to the contracts type imports in `main-layout.test.tsx`, then add this test after `starts publication with the selected public changes`:

```tsx
it("rescans changes and reports the deployment result after push completion", async () => {
  let reportProgress: ((progress: PublishProgress) => void) | undefined
  vi.mocked(garden.publish.onProgress).mockImplementation((listener) => {
    reportProgress = listener
    return () => undefined
  })
  vi.mocked(garden.changes.list)
    .mockResolvedValueOnce(
      ok({
        groups: [
          {
            id: "change-1",
            label: "一项变化",
            kind: "modified",
            selection: "default",
            description: "公开文章已修改",
            paths: ["content/technology/a.md"],
            attachments: [],
          },
        ],
      }),
    )
    .mockResolvedValueOnce(ok({ groups: [] }))
  vi.mocked(garden.history.git).mockResolvedValueOnce(
    ok([
      {
        id: "a".repeat(40),
        authoredAt: "2026-10-14T10:00:00+08:00",
        subject: "Publish notes",
      },
    ]),
  )
  vi.mocked(garden.history.deployments).mockResolvedValueOnce(
    ok({
      runs: [
        {
          id: "run-1",
          headSha: "a".repeat(40),
          startedAt: "2026-10-14T02:00:00Z",
          completedAt: "2026-10-14T02:01:00Z",
          status: "succeeded",
          url: "https://github.com/jin07-72/knowledge-garden/actions/runs/1",
        },
      ],
      actionsUrl: "https://github.com/jin07-72/knowledge-garden/actions",
      liveSiteUrl: "https://jin07-72.github.io/knowledge-garden/",
    }),
  )
  render(<App />)

  expect(await screen.findByText("可发布变化：1")).toBeVisible()
  act(() => reportProgress?.({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 }))

  expect(await screen.findByText("可发布变化：0")).toBeVisible()
  expect(await screen.findByText("发布成功，部署已完成。")).toBeVisible()
  const gitRequest = vi.mocked(garden.history.git).mock.calls.at(-1)?.[0]
  expect(gitRequest).toMatchObject({ limit: 1, requestId: expect.stringMatching(/^publish-deployment-/) })
  expect(vi.mocked(garden.history.deployments).mock.calls.at(-1)?.[0]).toEqual({
    limit: 20,
    requestId: gitRequest?.requestId,
  })
})
```

- [ ] **Step 2: Run the focused test to verify the old UI remains stale**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "rescans changes and reports"
```

Expected: FAIL because the count remains 1 and the fixed waiting message remains visible.

- [ ] **Step 3: Add publication-tracking state and request identity**

In `App.tsx`, import `publishedDeploymentStatus` and add module-level request ID generation:

```ts
import { publishedDeploymentStatus } from "./publishDeploymentStatus"

let publishDeploymentRequestSequence = 0

function nextPublishDeploymentRequestId(): string {
  publishDeploymentRequestSequence += 1
  return `publish-deployment-${Date.now().toString(36)}-${publishDeploymentRequestSequence.toString(36)}`
}
```

Beside the current publish state and refs, add:

```ts
const [publishActionsUrl, setPublishActionsUrl] = useState<string>()
const publishDeploymentGeneration = useRef(0)
const publishDeploymentRequest = useRef<string>()
const publishCompletionHandled = useRef(false)
```

Define `cancelPublishDeployment` immediately after these refs, before `switchBlog`, so it is available both to blog switching and to the later tracking callbacks:

```ts
const cancelPublishDeployment = useCallback((): void => {
  publishDeploymentGeneration.current += 1
  const requestId = publishDeploymentRequest.current
  publishDeploymentRequest.current = undefined
  publishCompletionHandled.current = false
  if (requestId) void api.history.cancel({ requestId }).catch(() => undefined)
}, [api])
```

- [ ] **Step 4: Implement cancellation and post-push tracking callbacks**

First extend `loadChanges` with an optional publication generation so a rescan started by an obsolete publication cannot update `changeCount`:

```ts
const loadChanges = useCallback(
  async (expectedPublishGeneration?: number): Promise<void> => {
    const request = ++changesRequest.current
    const stale = (): boolean =>
      request !== changesRequest.current ||
      (expectedPublishGeneration !== undefined &&
        expectedPublishGeneration !== publishDeploymentGeneration.current)
    pendingPublishRequest.current = undefined
    setPublishSubmitError(undefined)
    setChangeReviewState("loading")
    let result: Awaited<ReturnType<GardenApi["changes"]["list"]>>
    try {
      result = await api.changes.list()
    } catch (error) {
      if (stale()) return
      setChangeReview(undefined)
      setChangeCount(undefined)
      setChangeReviewState("error")
      setPublishMessage(error instanceof Error ? error.message : "无法检查可发布变化")
      return
    }
    if (stale()) return
    if (!result.ok) {
      setChangeReview(undefined)
      setChangeCount(undefined)
      setChangeReviewState("error")
      setPublishMessage(messageFor(result.error, "发布检查暂不可用。"))
      return
    }
    setChangeReview(result.value)
    setChangeReviewState("ready")
    const publishable = result.value.groups.filter((group) => group.selection === "default").length
    setChangeCount(publishable)
    setPublishMessage(
      result.value.blockedReason ??
        (result.value.groups.length === 0 ? "当前没有可发布变化" : "可查看并选择要发布的变化"),
    )
  },
  [api],
)
```

Then add the post-push tracking callback after `loadChanges`; it preserves push success on all history errors:

```ts
const trackPublishedDeployment = useCallback(
  async (generation: number): Promise<void> => {
    const requestId = nextPublishDeploymentRequestId()
    publishDeploymentRequest.current = requestId
    setPublishActionsUrl(undefined)
    setPublishProgress({ phase: "deploying", message: "发布成功，正在部署…", percent: 100 })
    void loadChanges(generation)

    try {
      const [git, deployments] = await Promise.all([
        api.history.git({ limit: 1, requestId }),
        api.history.deployments({ limit: 20, requestId }),
      ])
      if (generation !== publishDeploymentGeneration.current || !appMounted.current) return
      if (!git.ok || !deployments.ok) {
        if (deployments.ok) setPublishActionsUrl(deployments.value.actionsUrl)
        setPublishProgress({
          phase: "complete",
          message: "发布成功，暂时无法确认部署状态。",
          percent: 100,
        })
        return
      }
      const result = publishedDeploymentStatus(git.value[0], deployments.value)
      setPublishProgress(result.progress)
      setPublishActionsUrl(result.actionsUrl)
    } catch {
      if (generation !== publishDeploymentGeneration.current || !appMounted.current) return
      setPublishProgress({
        phase: "complete",
        message: "发布成功，暂时无法确认部署状态。",
        percent: 100,
      })
    } finally {
      if (generation === publishDeploymentGeneration.current) {
        publishDeploymentRequest.current = undefined
      }
    }
  },
  [api, loadChanges],
)

const applyPublishProgress = useCallback(
  (next: PublishProgress): void => {
    if (next.phase === "validating") {
      cancelPublishDeployment()
      setPublishActionsUrl(undefined)
    }
    if (next.phase !== "complete") {
      setPublishProgress(next)
      return
    }
    if (publishCompletionHandled.current) return
    publishCompletionHandled.current = true
    const generation = publishDeploymentGeneration.current
    void trackPublishedDeployment(generation)
  },
  [cancelPublishDeployment, trackPublishedDeployment],
)
```

Replace the direct subscription:

```ts
const unsubscribePublish = api.publish.onProgress(applyPublishProgress)
```

and add `applyPublishProgress` to that effect's dependency array.

- [ ] **Step 5: Run the focused test and the related existing publication tests**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "publication|publish|deployment"
```

Expected: the new post-push test and existing publication tests pass.

- [ ] **Step 6: Commit the successful path**

```powershell
git add -- apps/publisher/src/renderer/src/App.tsx apps/publisher/tests/unit/main-layout.test.tsx
git commit -m "feat: refresh status after publication"
```

### Task 3: Protect against failures, switching, unmounting, and stale results

**Files:**
- Modify: `apps/publisher/src/renderer/src/App.tsx:293-310`
- Modify: `apps/publisher/src/renderer/src/App.tsx:339-369`
- Modify: `apps/publisher/src/renderer/src/App.tsx:445-450`
- Modify: `apps/publisher/src/renderer/src/App.tsx:1152-1211`
- Modify: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: Add failing outcome and uncertainty tests**

Add this helper beside the other test helpers in `main-layout.test.tsx`:

```ts
function deploymentHistory(
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled",
  headSha = "a".repeat(40),
): DeploymentHistory {
  return {
    runs: [
      {
        id: `run-${status}`,
        headSha,
        startedAt: "2026-10-14T02:00:00Z",
        status,
        url: `https://github.com/jin07-72/knowledge-garden/actions/runs/${status}`,
      },
    ],
    actionsUrl: "https://github.com/jin07-72/knowledge-garden/actions",
    liveSiteUrl: "https://jin07-72.github.io/knowledge-garden/",
  }
}

function capturePublishProgress(api: GardenApi): {
  emit(progress: PublishProgress): void
} {
  let listener: ((progress: PublishProgress) => void) | undefined
  vi.mocked(api.publish.onProgress).mockImplementation((next) => {
    listener = next
    return () => undefined
  })
  return {
    emit(progress) {
      if (!listener) throw new Error("Publish listener has not subscribed")
      act(() => listener?.(progress))
    },
  }
}
```

Then add the complete table-driven test:

```tsx
it.each([
  ["failed", "发布已完成，但部署失败。"],
  ["cancelled", "发布已完成，但部署已取消。"],
] as const)("reports a %s deployment without hiding push success", async (status, message) => {
  const progress = capturePublishProgress(garden)
  vi.mocked(garden.history.git).mockResolvedValueOnce(
    ok([
      {
        id: "a".repeat(40),
        authoredAt: "2026-10-14T10:00:00+08:00",
        subject: "Publish notes",
      },
    ]),
  )
  vi.mocked(garden.history.deployments).mockResolvedValueOnce(ok(deploymentHistory(status)))
  render(<App />)
  await screen.findByRole("status", { name: "发布状态" })

  progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

  expect(await screen.findByText(message)).toBeVisible()
})

it("keeps publication successful when deployment status is unavailable", async () => {
  const progress = capturePublishProgress(garden)
  vi.mocked(garden.history.git).mockResolvedValueOnce(
    ok([
      {
        id: "a".repeat(40),
        authoredAt: "2026-10-14T10:00:00+08:00",
        subject: "Publish notes",
      },
    ]),
  )
  vi.mocked(garden.history.deployments).mockRejectedValueOnce(new Error("offline"))
  render(<App />)
  await screen.findByRole("status", { name: "发布状态" })

  progress.emit({ phase: "complete", message: "发布成功，正在等待部署。", percent: 100 })

  expect(await screen.findByText("发布成功，暂时无法确认部署状态。")).toBeVisible()
  expect(screen.queryByText(/发布失败/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Add failing cancellation and stale-result tests**

Add this test using the existing `deferred<T>()` helper. It covers unmount cancellation, repeated completion suppression, and rejection of a result made stale by a new publication:

```tsx
it("cancels deployment tracking and ignores duplicate or stale completion", async () => {
  const progress = capturePublishProgress(garden)
  const firstDeployment = deferred<IpcResult<DeploymentHistory>>()
  vi.mocked(garden.history.git).mockResolvedValue(
    ok([
      {
        id: "a".repeat(40),
        authoredAt: "2026-10-14T10:00:00+08:00",
        subject: "Publish notes",
      },
    ]),
  )
  vi.mocked(garden.history.deployments).mockReturnValueOnce(firstDeployment.promise)
  const view = render(<App />)
  await screen.findByRole("status", { name: "发布状态" })

  progress.emit({ phase: "complete", message: "push complete", percent: 100 })
  progress.emit({ phase: "complete", message: "push complete", percent: 100 })
  await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
  const requestId = vi.mocked(garden.history.deployments).mock.calls[0]?.[0]?.requestId

  progress.emit({ phase: "validating", message: "正在验证…", percent: 10 })
  await waitFor(() => expect(garden.history.cancel).toHaveBeenCalledWith({ requestId }))
  firstDeployment.resolve(ok(deploymentHistory("succeeded")))
  await act(async () => void (await firstDeployment.promise))
  expect(screen.getByRole("status", { name: "发布状态" })).toHaveTextContent("正在验证…")

  progress.emit({ phase: "complete", message: "second push complete", percent: 100 })
  await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledTimes(2))
  const secondRequestId = vi.mocked(garden.history.deployments).mock.calls[1]?.[0]?.requestId
  view.unmount()
  await waitFor(() => expect(garden.history.cancel).toHaveBeenCalledWith({ requestId: secondRequestId }))
})
```

Add the explicit blog-switch test:

```tsx
it("cancels deployment tracking before switching blogs", async () => {
  const user = userEvent.setup()
  const progress = capturePublishProgress(garden)
  const pendingDeployment = deferred<IpcResult<DeploymentHistory>>()
  vi.mocked(garden.history.git).mockResolvedValue(
    ok([
      {
        id: "a".repeat(40),
        authoredAt: "2026-10-14T10:00:00+08:00",
        subject: "Publish notes",
      },
    ]),
  )
  vi.mocked(garden.history.deployments).mockReturnValueOnce(pendingDeployment.promise)
  vi.mocked(garden.blogs.switch).mockResolvedValueOnce(ok(undefined))
  render(<App />)
  await screen.findByRole("status", { name: "发布状态" })
  progress.emit({ phase: "complete", message: "push complete", percent: 100 })
  await waitFor(() => expect(garden.history.deployments).toHaveBeenCalledOnce())
  const requestId = vi.mocked(garden.history.deployments).mock.calls[0]?.[0]?.requestId

  await user.click(screen.getByRole("button", { name: "切换博客：Knowledge Garden" }))
  await user.click(screen.getByRole("menuitemradio", { name: /Study Garden/ }))

  await waitFor(() => expect(garden.history.cancel).toHaveBeenCalledWith({ requestId }))
  pendingDeployment.resolve(ok(deploymentHistory("succeeded")))
  await act(async () => void (await pendingDeployment.promise))
  expect(screen.queryByText("发布成功，部署已完成。")).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run the new tests to verify missing cancellation behavior**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "deployment|push completion|stale"
```

Expected: terminal mapping tests may pass after Task 2, while cancellation, repeated-completion, or stale-result assertions fail until lifecycle wiring is complete.

- [ ] **Step 4: Wire cancellation into every invalidation boundary**

Update `App.tsx` with these exact behaviors:

```ts
// At the beginning of onPublish and onRepairAndPublish, before starting a new publication:
cancelPublishDeployment()
setPublishActionsUrl(undefined)

// In switchBlog, after rejecting same-blog/busy requests and before runBlogOperation:
cancelPublishDeployment()
setPublishProgress(undefined)
setPublishActionsUrl(undefined)

// When the active blog changes:
useEffect(() => {
  cancelPublishDeployment()
  setPublishProgress(undefined)
  setPublishActionsUrl(undefined)
}, [cancelPublishDeployment, registry.activeBlogId])

// In the publish-subscription effect cleanup:
cancelPublishDeployment()
```

Add `cancelPublishDeployment` to the `switchBlog` callback dependency array and to every effect dependency array that invokes it.

Keep the generation comparison already present in `trackPublishedDeployment`, and keep the optional generation check added to `loadChanges`. Do not update `publishProgress`, `publishActionsUrl`, or `changeCount` from a completed async operation after its generation has been invalidated. Because `cancelPublishDeployment` resets `publishCompletionHandled`, the next operation can process one new `complete` event while duplicate completion events from the same operation remain ignored.

- [ ] **Step 5: Run cancellation/outcome tests and typecheck**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "deployment|push completion|stale"
npm --prefix apps/publisher run typecheck
```

Expected: all focused tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit the lifecycle safety work**

```powershell
git add -- apps/publisher/src/renderer/src/App.tsx apps/publisher/tests/unit/main-layout.test.tsx
git commit -m "fix: cancel stale deployment tracking"
```

### Task 4: Add the GitHub Actions inspection entry

**Files:**
- Modify: `apps/publisher/src/renderer/src/App.tsx:1095-1099`
- Modify: `apps/publisher/src/renderer/src/app.css:1223-1233`
- Modify: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: Add a failing Actions-link test**

Extend the successful-publication test from Task 2 after the final deployment message appears:

```tsx
const actions = screen.getByRole("button", { name: "查看 Actions" })
await userEvent.setup().click(actions)
expect(garden.history.openLink).toHaveBeenCalledWith({
  url: "https://github.com/jin07-72/knowledge-garden/actions/runs/1",
})
```

Also assert that the button is absent before completion and after a new `validating` event:

```tsx
expect(screen.queryByRole("button", { name: "查看 Actions" })).not.toBeInTheDocument()
```

- [ ] **Step 2: Run the focused test to verify the button is absent**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "rescans changes and reports"
```

Expected: FAIL because there is no “查看 Actions” button.

- [ ] **Step 3: Render and style the inspection control**

Inside `.publish-summary`, after the status message, render:

```tsx
{publishActionsUrl ? (
  <button
    className="publish-actions-link"
    type="button"
    onClick={() => {
      void api.history.openLink({ url: publishActionsUrl })
    }}
  >
    查看 Actions
  </button>
) : null}
```

Add compact status-bar styling in `app.css`:

```css
.publish-actions-link {
  padding: 0;
  border: 0;
  color: #8bd5ca;
  background: transparent;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.publish-actions-link:hover {
  color: #b7eee7;
}
```

In the existing narrow-screen media query that hides `.publish-summary small`, also hide `.publish-actions-link` so the publish button retains space:

```css
.publish-summary small,
.publish-actions-link {
  display: none;
}
```

- [ ] **Step 4: Run the focused UI test**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "rescans changes and reports"
```

Expected: PASS and `history.openLink` receives the exact service-provided URL.

- [ ] **Step 5: Commit the inspection entry**

```powershell
git add -- apps/publisher/src/renderer/src/App.tsx apps/publisher/src/renderer/src/app.css apps/publisher/tests/unit/main-layout.test.tsx
git commit -m "feat: link publication status to actions"
```

### Task 5: Full regression verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run all publisher unit and integration tests**

Run:

```powershell
npm --prefix apps/publisher run test:run
```

Expected: all Vitest suites pass with zero failed tests.

- [ ] **Step 2: Run static checks and the production build**

Run:

```powershell
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run build
```

Expected: both commands exit with code 0; Electron Vite emits the main, preload, and renderer bundles.

- [ ] **Step 3: Inspect the final diff and repository state**

Run:

```powershell
git diff --check
git status --short
git log --oneline -5
```

Expected: `git diff --check` prints nothing, the worktree has no unintended files, and the log contains the focused implementation commits from Tasks 1-4.

- [ ] **Step 4: Perform one non-publishing visual application check**

Start the development app:

```powershell
npm --prefix apps/publisher run dev
```

Open the local app and confirm the status bar remains aligned at normal and narrow window widths and that “检查并发布” still opens its review dialog. Do not perform a real Git push during this visual check; the automated tests above verify the complete post-push sequence and Actions-link call without changing GitHub state.
