import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../../src/main/lib/commandRunner"
import {
  createBoundedPublishCommandRunner,
  type BoundedCommandRequest,
  type PublishCommandProcess,
} from "../../src/main/services/publish"
import {
  createDeploymentHistoryService,
  isSafeHistoryUrl,
  parseGitHubRemote,
} from "../../src/main/services/deployments"

class FakeRunner implements CommandRunner {
  readonly requests: CommandRequest[] = []

  constructor(private readonly runCommand: (request: CommandRequest) => CommandResult) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request)
    return this.runCommand(request)
  }
}

function response(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response
}

function githubRun(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 42,
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-09-27T10:00:00Z",
    updated_at: "2026-09-27T10:02:00Z",
    html_url: "https://github.com/octocat/garden/actions/runs/42",
    ...overrides,
  }
}

describe("deployment history", () => {
  it("terminates a command before captured output can exceed its byte limit", async () => {
    const events = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(events, {
      stdout,
      stderr,
      kill: vi.fn(() => true),
      pid: 4242,
      off: events.off.bind(events),
    }) as unknown as PublishCommandProcess
    const terminate = vi.fn(async () => true)
    const runner = createBoundedPublishCommandRunner({
      spawner: () => child,
      terminate,
    })
    const request: BoundedCommandRequest = {
      executable: "git",
      args: ["log"],
      cwd: "C:\\garden",
      maxOutputBytes: 4,
    }
    const result = runner.run(request)

    stdout.write("12345")
    events.emit("close", 0)

    await expect(result).rejects.toThrow(/safe limit/i)
    expect(terminate).toHaveBeenCalledWith(child)
  })

  it.each([
    ["https://github.com/octocat/garden.git", { owner: "octocat", repo: "garden" }],
    ["git@github.com:octocat/garden.git", { owner: "octocat", repo: "garden" }],
    ["ssh://git@github.com/octocat/garden.git", { owner: "octocat", repo: "garden" }],
  ])("parses GitHub remote %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected)
  })

  it.each([
    "https://user:secret@github.com/octocat/garden.git",
    "https://example.com/octocat/garden.git",
    "git@github.com:octocat/../../secret.git",
    "git@github.com:../garden.git",
    "git@github.com:octocat/...git",
  ])("rejects unsafe or credential-bearing remote %s", (remote) => {
    expect(() => parseGitHubRemote(remote)).toThrow()
  })

  it("opens only exact links derived from the currently resolved repository", async () => {
    const openExternal = vi.fn(async () => undefined)
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout:
        args[0] === "remote" ? "https://github.com/octocat/garden.git\n" : `${"a".repeat(40)}\n`,
      stderr: "",
    }))
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher: vi.fn(async () => response(200, { workflow_runs: [githubRun()] })),
      openExternal,
    })
    const actions = "https://github.com/octocat/garden/actions/workflows/deploy.yml"
    const site = "https://octocat.github.io/garden/"
    const run = "https://github.com/octocat/garden/actions/runs/42"

    await service.deployments()
    expect(isSafeHistoryUrl(actions, { owner: "octocat", repo: "garden" })).toBe(true)
    expect(isSafeHistoryUrl(site, { owner: "octocat", repo: "garden" })).toBe(true)
    await service.openLink(actions)
    await service.openLink(site)
    await service.openLink(run)
    for (const unsafe of [
      "https://github.com/other/garden/actions/workflows/deploy.yml",
      "https://other.github.io/garden/",
      "https://github.com/octocat/other/actions/runs/42",
      "https://github.com/octocat/garden/actions/runs/42/attempts/1",
      "https://example.com/steal",
    ]) {
      await expect(service.openLink(unsafe)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" })
    }
    expect(openExternal.mock.calls).toEqual([[actions], [site], [run]])
  })

  it("fails closed instead of reusing repository links after origin becomes invalid", async () => {
    let remote = "https://github.com/octocat/garden.git\n"
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout: args[0] === "remote" ? remote : `${"a".repeat(40)}\n`,
      stderr: "",
    }))
    const openExternal = vi.fn(async () => undefined)
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher: vi.fn(async () => response(200, { workflow_runs: [githubRun()] })),
      openExternal,
    })

    await service.deployments()
    remote = "https://example.com/octocat/garden.git\n"

    await expect(service.deployments()).rejects.toMatchObject({ code: "GIT_STATUS_FAILED" })
    await expect(
      service.openLink("https://github.com/octocat/garden/actions/workflows/deploy.yml"),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("reads bounded Git history using a stable NUL-delimited format", async () => {
    const runner = new FakeRunner(() => ({
      exitCode: 0,
      stdout: `${"a".repeat(40)}\0${"2026-09-27T10:00:00+08:00"}\0Publish note\0Ada\0`,
      stderr: "",
    }))
    const service = createDeploymentHistoryService({ workspace: "C:\\garden", runner })

    await expect(service.git({ limit: 2 })).resolves.toEqual([
      {
        id: "a".repeat(40),
        authoredAt: "2026-09-27T10:00:00+08:00",
        subject: "Publish note",
        author: "Ada",
      },
    ])
    expect(runner.requests).toEqual([
      expect.objectContaining({
        executable: "git",
        args: [
          "log",
          "-z",
          "--max-count=2",
          "--date=iso-strict",
          "--format=%H%x00%aI%x00%s%x00%an",
        ],
        cwd: "C:\\garden",
        maxOutputBytes: 512 * 1024,
      }),
    ])
  })

  it("uses ETags and polls 3, 6, 12, then 20 seconds until the matching SHA is terminal", async () => {
    const sha = "a".repeat(40)
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout: args[0] === "remote" ? "git@github.com:octocat/garden.git\n" : `${sha}\n`,
      stderr: "",
    }))
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { workflow_runs: [] }, { etag: '"one"' }))
      .mockResolvedValueOnce(response(304, ""))
      .mockResolvedValueOnce(
        response(200, {
          workflow_runs: [githubRun({ status: "queued", conclusion: null })],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          workflow_runs: [githubRun({ status: "in_progress", conclusion: null })],
        }),
      )
      .mockResolvedValueOnce(response(200, { workflow_runs: [githubRun()] }))
    const waits: number[] = []
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    const result = await service.deployments({ limit: 10 })

    expect(result.runs[0]).toMatchObject({ headSha: sha, status: "succeeded" })
    expect(waits).toEqual([3_000, 6_000, 12_000, 20_000])
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "If-None-Match": '"one"' }),
    })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it("does not stop for a terminal run belonging to another commit", async () => {
    const sha = "a".repeat(40)
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout: args[0] === "remote" ? "https://github.com/octocat/garden.git\n" : `${sha}\n`,
      stderr: "",
    }))
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(200, { workflow_runs: [githubRun({ head_sha: "b".repeat(40) })] }),
      )
      .mockResolvedValueOnce(response(200, { workflow_runs: [githubRun()] }))
    const wait = vi.fn(async () => undefined)
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher,
      wait,
    })

    await expect(service.deployments()).resolves.toMatchObject({
      runs: [expect.objectContaining({ headSha: sha, status: "succeeded" })],
    })
    expect(wait).toHaveBeenCalledWith(3_000, expect.any(AbortSignal))
  })

  it("does not expose a deployment URL unless it is an exact numeric run URL", async () => {
    const sha = "a".repeat(40)
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout:
        args[0] === "remote" ? "https://github.com/octocat/garden.git\n" : `${sha}\n`,
      stderr: "",
    }))
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher: vi.fn(async () =>
        response(200, {
          workflow_runs: [
            githubRun({ html_url: "https://github.com/octocat/garden/actions/runs/42/attempts/1" }),
          ],
        }),
      ),
    })

    const result = await service.deployments()

    expect(result.runs[0]).not.toHaveProperty("url")
  })

  it.each([403, 429])("falls back to safe public links on HTTP %s", async (status) => {
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout:
        args[0] === "remote" ? "https://github.com/octocat/garden.git\n" : `${"a".repeat(40)}\n`,
      stderr: "",
    }))
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher: vi.fn(async () => response(status, { secret: "must-not-cross" })),
    })

    await expect(service.deployments()).resolves.toEqual({
      runs: [],
      actionsUrl: "https://github.com/octocat/garden/actions/workflows/deploy.yml",
      liveSiteUrl: "https://octocat.github.io/garden/",
      unavailableMessage: "暂时无法读取部署状态，请通过下面的链接查看。",
    })
  })

  it("returns the same in-flight request and aborts polling on dispose", async () => {
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout:
        args[0] === "remote" ? "https://github.com/octocat/garden.git\n" : `${"a".repeat(40)}\n`,
      stderr: "",
    }))
    let release!: () => void
    const wait = vi.fn(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          release = resolve
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        }),
    )
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher: vi.fn(async () => response(200, { workflow_runs: [] })),
      wait,
    })

    const first = service.deployments()
    const second = service.deployments()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
    await service.dispose()
    await expect(first).resolves.toMatchObject({ unavailableMessage: "部署状态检查已停止。" })
    release()
  })

  it("cancels only the deployment request with the matching request id", async () => {
    const runner = new FakeRunner(({ args }) => ({
      exitCode: 0,
      stdout:
        args[0] === "remote" ? "https://github.com/octocat/garden.git\n" : `${"a".repeat(40)}\n`,
      stderr: "",
    }))
    const wait = vi.fn(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        }),
    )
    const service = createDeploymentHistoryService({
      workspace: "C:\\garden",
      runner,
      fetcher: vi.fn(async () => response(200, { workflow_runs: [] })),
      wait,
    })
    const first = service.deployments({ limit: 20, requestId: "history-first" })
    const second = service.deployments({ limit: 20, requestId: "history-second" })
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2))

    await service.cancel({ requestId: "history-first" })

    expect(wait.mock.calls[0]?.[1].aborted).toBe(true)
    expect(wait.mock.calls[1]?.[1].aborted).toBe(false)
    await expect(first).resolves.toMatchObject({ unavailableMessage: expect.any(String) })
    await service.cancel({ requestId: "history-second" })
    await expect(second).resolves.toMatchObject({ unavailableMessage: expect.any(String) })
  })

  it("cancels only the local git request with the matching history request id", async () => {
    const requests: CommandRequest[] = []
    const runner: CommandRunner = {
      run: vi.fn(
        (request: CommandRequest) =>
          new Promise<CommandResult>((_resolve, reject) => {
            requests.push(request)
            request.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            })
          }),
      ),
    }
    const service = createDeploymentHistoryService({ workspace: "C:\\garden", runner })
    const first = service.git({ limit: 20, requestId: "history-first" }).catch((error) => error)
    const second = service.git({ limit: 20, requestId: "history-second" }).catch((error) => error)
    await vi.waitFor(() => expect(requests).toHaveLength(2))

    await service.cancel({ requestId: "history-first" })

    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(requests[1]?.signal?.aborted).toBe(false)
    await expect(first).resolves.toMatchObject({ code: "GIT_STATUS_FAILED" })

    await service.cancel({ requestId: "history-second" })
    expect(requests[1]?.signal?.aborted).toBe(true)
    await expect(second).resolves.toMatchObject({ code: "GIT_STATUS_FAILED" })
  })
})
