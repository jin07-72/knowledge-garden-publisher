import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  PreviewManager,
  createProcessTreeTerminator,
  type PortRequest,
  type PreviewDependencies,
  type PreviewProcess,
  type PreviewStatus,
  type TreeTerminationDependencies,
} from "../../src/main/services/preview"

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve
    })
  }
}

class ManualClock {
  private time = 0
  private waiters = new Set<{
    readonly deadline: number
    readonly signal: AbortSignal
    readonly resolve: () => void
    readonly onAbort: () => void
  }>()

  readonly now = (): number => this.time

  readonly delay = (milliseconds: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiter = {
        deadline: this.time + milliseconds,
        signal,
        resolve: (): void => {
          signal.removeEventListener("abort", waiter.onAbort)
          this.waiters.delete(waiter)
          resolve()
        },
        onAbort: (): void => waiter.resolve(),
      }
      this.waiters.add(waiter)
      signal.addEventListener("abort", waiter.onAbort, { once: true })
    })
  }

  async advance(milliseconds: number): Promise<void> {
    this.time += milliseconds
    for (const waiter of [...this.waiters]) {
      if (waiter.deadline <= this.time) waiter.resolve()
    }
    await flushMicrotasks()
  }
}

class FakeProcess extends EventEmitter implements PreviewProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid = 4242
  alive = true
  readonly signals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal)
    return true
  }

  close(code: number | null = 0, signal: string | null = null): void {
    if (!this.alive) return
    this.alive = false
    this.emit("close", code, signal)
  }
}

type TestDependencies = PreviewDependencies & {
  readonly children: FakeProcess[]
  readonly clock: ManualClock
  readonly portRequests: PortRequest[]
}

function dependencies(overrides: Partial<PreviewDependencies> = {}): TestDependencies {
  const children: FakeProcess[] = []
  const clock = new ManualClock()
  const portRequests: PortRequest[] = []
  let nextPort = 43120
  return {
    children,
    clock,
    portRequests,
    resolveWorkspace: async (path) => path,
    isDirectory: async () => true,
    isFile: async () => true,
    runtimePath: () => "C:\\Program Files\\Knowledge Garden\\resources\\node\\node.exe",
    spawn: () => {
      const child = new FakeProcess()
      child.pid += children.length
      children.push(child)
      return child
    },
    allocatePort: async (request) => {
      portRequests.push(request)
      if (request.preferredPort !== undefined && !request.exclude.includes(request.preferredPort)) {
        return request.preferredPort
      }
      while (request.exclude.includes(nextPort)) nextPort += 1
      return nextPort++
    },
    probe: async () => false,
    terminate: async (child) => {
      ;(child as FakeProcess).close()
      return true
    },
    platform: "win32",
    now: clock.now,
    delay: clock.delay,
    readinessTimeoutMs: 1_000,
    readinessPollMs: 10,
    maxPortRetries: 2,
    ...overrides,
  }
}

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

async function until(assertion: () => void, label: string): Promise<void> {
  let lastError: unknown
  for (let index = 0; index < 80; index += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await Promise.resolve()
    }
  }
  throw new Error(`Condition did not settle: ${label}`, { cause: lastError })
}

describe("PreviewManager", () => {
  it("reports a stopped serializable state before preview exists", () => {
    const manager = new PreviewManager(dependencies())

    expect(manager.getStatus()).toEqual({ state: "stopped", generation: 0 })
    expect(() => JSON.stringify(manager.getStatus())).not.toThrow()
  })

  it("uses the bundled runtime and Quartz-supported ports with explicit loopback binding", async () => {
    const spawn = vi.fn<PreviewDependencies["spawn"]>()
    const deps = dependencies({
      probe: async () => true,
      spawn: (executable, args, options) => {
        const child = new FakeProcess()
        deps.children.push(child)
        spawn(executable, args, options)
        return child
      },
    })
    const manager = new PreviewManager(deps)

    await expect(manager.start({ workspace: "C:\\Garden", preferredPort: 43120 })).resolves.toEqual(
      {
        state: "ready",
        generation: 1,
        port: 43120,
        url: "http://127.0.0.1:43120/",
        lastSuccessfulUrl: "http://127.0.0.1:43120/",
      },
    )

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Program Files\\Knowledge Garden\\resources\\node\\node.exe",
      [
        "C:\\Garden\\quartz\\bootstrap-cli.mjs",
        "build",
        "--serve",
        "--port",
        "43120",
        "--wsPort",
        "43121",
      ],
      expect.objectContaining({
        cwd: "C:\\Garden",
        shell: false,
        windowsHide: true,
        detached: false,
        env: expect.objectContaining({ QUARTZ_PREVIEW_LOOPBACK: "127.0.0.1" }),
      }),
    )
    expect(deps.portRequests).toEqual([
      { host: "127.0.0.1", preferredPort: 43120, exclude: [] },
      { host: "127.0.0.1", preferredPort: undefined, exclude: [43120] },
    ])
  })

  it("starts POSIX previews in a detached process group for safe tree signalling", async () => {
    const spawn = vi.fn<PreviewDependencies["spawn"]>()
    const deps = dependencies({
      platform: "linux",
      resolveWorkspace: async () => "/garden",
      runtimePath: () => "/app/resources/node/bin/node",
      probe: async () => true,
      spawn: (executable, args, options) => {
        const child = new FakeProcess()
        deps.children.push(child)
        spawn(executable, args, options)
        return child
      },
    })

    await new PreviewManager(deps).start({ workspace: "/garden" })

    expect(spawn).toHaveBeenCalledWith(
      "/app/resources/node/bin/node",
      expect.arrayContaining(["/garden/quartz/bootstrap-cli.mjs", "build", "--serve"]),
      expect.objectContaining({ cwd: "/garden", shell: false, detached: true }),
    )
  })

  it.each([
    {
      name: "unresolvable workspace",
      overrides: {
        resolveWorkspace: async (): Promise<string> => {
          throw new Error("C:\\private\\garden")
        },
      },
      code: "WORKSPACE_INVALID",
    },
    {
      name: "missing workspace",
      overrides: { isDirectory: async (): Promise<boolean> => false },
      code: "WORKSPACE_INVALID",
    },
    {
      name: "missing Quartz CLI",
      overrides: {
        isFile: async (path: string): Promise<boolean> => !path.endsWith("bootstrap-cli.mjs"),
      },
      code: "QUARTZ_MISSING",
    },
    {
      name: "missing bundled runtime",
      overrides: { runtimePath: (): undefined => undefined },
      code: "RUNTIME_MISSING",
    },
  ])("fails before spawn for $name without exposing paths", async ({ overrides, code }) => {
    const deps = dependencies(overrides)
    const manager = new PreviewManager(deps)

    const status = await manager.start({ workspace: "C:\\private\\garden" })

    expect(status).toMatchObject({ state: "error", error: { code } })
    expect(deps.children).toHaveLength(0)
    expect(JSON.stringify(status)).not.toMatch(/private|garden|Program Files/i)
  })

  it("reuses one process for concurrent starts resolving to the same canonical workspace", async () => {
    const deps = dependencies({
      resolveWorkspace: async () => "C:\\Garden",
      probe: async () => true,
    })
    const manager = new PreviewManager(deps)

    const first = manager.start({ workspace: "C:\\Garden" })
    const second = manager.start({ workspace: "c:\\garden\\." })

    await expect(first).resolves.toMatchObject({ state: "ready", generation: 1 })
    await expect(second).resolves.toMatchObject({ state: "ready", generation: 1 })
    expect(deps.children).toHaveLength(1)
  })

  it("stops the old workspace before starting a different canonical workspace", async () => {
    const terminate = vi.fn<PreviewDependencies["terminate"]>(async (child) => {
      ;(child as FakeProcess).close()
      return true
    })
    const deps = dependencies({ probe: async () => true, terminate })
    const manager = new PreviewManager(deps)

    await manager.start({ workspace: "C:\\Garden" })
    const old = deps.children[0]
    await expect(manager.start({ workspace: "C:\\Other" })).resolves.toMatchObject({
      state: "ready",
      generation: 2,
    })

    expect(terminate).toHaveBeenCalledWith(old)
    expect(deps.children).toHaveLength(2)
    expect(old.alive).toBe(false)
  })

  it("uses HTTP readiness without depending on an English log line", async () => {
    const manager = new PreviewManager(dependencies({ probe: async () => true }))

    await expect(manager.start({ workspace: "C:\\Garden" })).resolves.toMatchObject({
      state: "ready",
      url: "http://127.0.0.1:43120/",
    })
  })

  it("parses ANSI and chunk-split rebuild logs and recovers after a build error", async () => {
    const deps = dependencies({ probe: async () => true })
    const manager = new PreviewManager(deps)
    await manager.start({ workspace: "C:\\Garden" })
    const child = deps.children[0]

    child.stdout.write("\u001b[33mDetected ch")
    child.stdout.write("ange, rebuilding...\u001b[0m\n")
    expect(manager.getStatus()).toMatchObject({
      state: "building",
      lastSuccessfulUrl: "http://127.0.0.1:43120/",
    })

    child.stderr.write("\u001b[31mRebuild fai")
    child.stderr.write("led: C:\\private\\secret.md\u001b[0m\n")
    expect(manager.getStatus()).toMatchObject({
      state: "error",
      lastSuccessfulUrl: "http://127.0.0.1:43120/",
      error: {
        code: "PREVIEW_BUILD_FAILED",
        message: expect.any(String),
        details: expect.any(Object),
      },
    })
    expect(JSON.stringify(manager.getStatus())).not.toContain("secret.md")

    child.stdout.write("Detected a source code change, doing a hard rebuild...\n")
    expect(manager.getStatus()).toMatchObject({ state: "building" })
    child.stdout.write("Done rebuilding in 1ms\n")
    expect(manager.getStatus()).toMatchObject({
      state: "ready",
      url: "http://127.0.0.1:43120/",
      lastSuccessfulUrl: "http://127.0.0.1:43120/",
    })
  })

  it("reports an initial Quartz build failure without leaking its source path", async () => {
    const deps = dependencies()
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    await until(() => expect(deps.children).toHaveLength(1), "initial-build preview spawn")
    deps.children[0].stderr.write("Failed to build Quartz. C:\\private\\quartz.config.ts\n")
    const status = await starting

    expect(status).toMatchObject({ state: "error", error: { code: "PREVIEW_BUILD_FAILED" } })
    expect(JSON.stringify(status)).not.toMatch(/private|quartz\.config\.ts/i)
    expect(deps.children[0].alive).toBe(false)
  })

  it("retains the last successful URL when a ready process exits unexpectedly", async () => {
    const deps = dependencies({ probe: async () => true })
    const manager = new PreviewManager(deps)
    await manager.start({ workspace: "C:\\Garden" })

    deps.children[0].close(1)

    expect(manager.getStatus()).toMatchObject({
      state: "error",
      lastSuccessfulUrl: "http://127.0.0.1:43120/",
      error: { code: "PREVIEW_START_FAILED" },
    })
  })

  it("preserves a hard-rebuild failure when Quartz exits immediately afterward", async () => {
    const deps = dependencies({ probe: async () => true })
    const manager = new PreviewManager(deps)
    await manager.start({ workspace: "C:\\Garden" })

    deps.children[0].stderr.write("Failed to build Quartz. C:\\private\\plugin.ts\n")
    deps.children[0].close(1)

    expect(manager.getStatus()).toMatchObject({
      state: "error",
      lastSuccessfulUrl: "http://127.0.0.1:43120/",
      error: { code: "PREVIEW_BUILD_FAILED" },
    })
  })

  it("redacts complete Windows and UNC paths containing spaces", async () => {
    const deps = dependencies({ probe: async () => true })
    const manager = new PreviewManager(deps)
    await manager.start({ workspace: "C:\\Garden" })

    deps.children[0].stderr.write("Rebuild failed: C:\\Users\\Jane Doe\\garden\\secret.md\n")
    deps.children[0].stderr.write("Rebuild failed: \\\\server\\Jane Doe\\garden\\secret.md\n")

    expect(JSON.stringify(manager.getStatus())).not.toMatch(/Jane|Doe|garden|secret\.md|server/i)
  })

  it("retries complete address-in-use lines and incomplete final lines only up to the bound", async () => {
    const ports = [43120, 43121, 43122, 43123, 43124, 43125]
    let portIndex = 0
    const deps = dependencies({
      allocatePort: async (request) => {
        deps.portRequests.push(request)
        return ports[portIndex++]
      },
      maxPortRetries: 2,
    })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden", preferredPort: 43120 })

    await until(() => expect(deps.children).toHaveLength(1), "first preview spawn")
    deps.children[0].stderr.write("Port 43120 is already in use\n")
    deps.children[0].close(1)
    await until(() => expect(deps.children).toHaveLength(2), "second preview spawn")
    deps.children[1].stderr.write("EADDR")
    deps.children[1].stderr.write("INUSE")
    deps.children[1].close(1)
    await until(() => expect(deps.children).toHaveLength(3), "third preview spawn")
    deps.children[2].stderr.write("address already in use")
    deps.children[2].close(1)

    await expect(starting).resolves.toMatchObject({
      state: "error",
      error: { code: "PORT_UNAVAILABLE" },
    })
    expect(deps.children).toHaveLength(3)
    expect(deps.portRequests.every((request) => request.host === "127.0.0.1")).toBe(true)
  })

  it("ignores output and exits from a stale retry attempt", async () => {
    let probeCalls = 0
    const deps = dependencies({ probe: async () => ++probeCalls >= 2 })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    await until(() => expect(deps.children).toHaveLength(1), "first attempt")
    const old = deps.children[0]
    old.stderr.write("EADDRINUSE\n")
    old.close(1)
    await until(() => expect(deps.children).toHaveLength(2), "retry attempt")
    await deps.clock.advance(10)
    await expect(starting).resolves.toMatchObject({ state: "ready" })

    old.stderr.write("Failed to build Quartz. C:\\private\\old.md\n")
    old.emit("close", 1, null)
    expect(manager.getStatus()).toMatchObject({ state: "ready", generation: 1 })
  })

  it("times out deterministically, terminates the child, and exposes only a bounded redacted tail", async () => {
    const terminate = vi.fn<PreviewDependencies["terminate"]>(async (child) => {
      ;(child as FakeProcess).close()
      return true
    })
    const deps = dependencies({ terminate, readinessTimeoutMs: 20, readinessPollMs: 10 })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    await until(() => expect(deps.children).toHaveLength(1), "preview spawn")
    for (let index = 0; index < 100; index += 1) {
      deps.children[0].stderr.write(`C:\\private\\secret-${index}.md failed\n`)
    }
    await deps.clock.advance(10)
    await deps.clock.advance(10)
    const status = await starting

    expect(status).toMatchObject({
      state: "error",
      error: { code: "PREVIEW_TIMEOUT", details: { logTail: expect.any(Array) } },
    })
    const tail = (status.error?.details?.logTail ?? []) as readonly string[]
    expect(tail.length).toBeLessThanOrEqual(80)
    expect(JSON.stringify(status)).not.toMatch(/private|secret-|C:\\/i)
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it("enforces the readiness deadline even when an injected HTTP probe never settles", async () => {
    const never = new Promise<boolean>(() => undefined)
    const probeSignals: AbortSignal[] = []
    const deps = dependencies({
      probe: async (_url, signal) => {
        probeSignals.push(signal)
        return never
      },
      readinessTimeoutMs: 20,
      readinessPollMs: 10,
    })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })
    let settled: PreviewStatus | undefined
    void starting.then((status) => {
      settled = status
    })

    await until(() => expect(deps.children).toHaveLength(1), "hung-probe preview spawn")
    await deps.clock.advance(10)
    await deps.clock.advance(10)

    expect(settled).toMatchObject({ state: "error", error: { code: "PREVIEW_TIMEOUT" } })
    expect(probeSignals.length).toBeGreaterThanOrEqual(2)
    expect(probeSignals.every((signal) => signal.aborted)).toBe(true)
    await manager.stop()
  })

  it("reports a termination failure truthfully when timeout cleanup cannot stop the child", async () => {
    const deps = dependencies({
      terminate: async () => false,
      readinessTimeoutMs: 10,
      readinessPollMs: 10,
    })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    await until(() => expect(deps.children).toHaveLength(1), "unstoppable timeout spawn")
    await deps.clock.advance(10)

    await expect(starting).resolves.toMatchObject({
      state: "error",
      error: { code: "PREVIEW_STOP_FAILED" },
    })
    expect(deps.children[0].alive).toBe(true)
  })

  it("reports a termination failure truthfully when failed initial-build cleanup cannot stop", async () => {
    const deps = dependencies({ terminate: async () => false })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    await until(() => expect(deps.children).toHaveLength(1), "unstoppable build-error spawn")
    deps.children[0].stderr.write("Failed to build Quartz. C:\\private\\plugin.ts\n")

    await expect(starting).resolves.toMatchObject({
      state: "error",
      error: { code: "PREVIEW_STOP_FAILED" },
    })
    expect(deps.children[0].alive).toBe(true)
  })

  it("rejects an invalid allocated port before spawn", async () => {
    const deps = dependencies({ allocatePort: async () => 70_000 })
    const manager = new PreviewManager(deps)

    await expect(manager.start({ workspace: "C:\\Garden" })).resolves.toMatchObject({
      state: "error",
      error: { code: "PORT_UNAVAILABLE" },
    })
    expect(deps.children).toHaveLength(0)
  })

  it("cancels validation before spawn when stop wins", async () => {
    const resolved = new Deferred<string>()
    const deps = dependencies({ resolveWorkspace: async () => resolved.promise })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    const stopping = manager.stop()
    resolved.resolve("C:\\Garden")

    await expect(stopping).resolves.toEqual({ state: "stopped", generation: 0 })
    await expect(starting).resolves.toEqual({ state: "stopped", generation: 0 })
    expect(deps.children).toHaveLength(0)
  })

  it("starts a fresh same-workspace process when restart is requested during stop", async () => {
    const termination = new Deferred<boolean>()
    let terminationCalls = 0
    const deps = dependencies({
      probe: async () => deps.children.length >= 2,
      terminate: async (child) => {
        terminationCalls += 1
        if (terminationCalls === 1) await termination.promise
        ;(child as FakeProcess).close()
        return true
      },
    })
    const manager = new PreviewManager(deps)
    const firstStart = manager.start({ workspace: "C:\\Garden" })
    await until(() => expect(deps.children).toHaveLength(1), "first restart-race spawn")

    const stopping = manager.stop()
    const restarted = manager.start({ workspace: "C:\\Garden" })
    termination.resolve(true)

    await expect(firstStart).resolves.toEqual({ state: "stopped", generation: 1 })
    await expect(stopping).resolves.toEqual({ state: "stopped", generation: 1 })
    await expect(restarted).resolves.toMatchObject({ state: "ready", generation: 2 })
    expect(deps.children).toHaveLength(2)
  })

  it("does not publish readiness when the process closes as the probe succeeds", async () => {
    const probed = new Deferred<boolean>()
    const deps = dependencies({ probe: async () => probed.promise })
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden" })

    await until(() => expect(deps.children).toHaveLength(1), "probe-close race spawn")
    probed.resolve(true)
    queueMicrotask(() => deps.children[0].close(1))

    await expect(starting).resolves.toMatchObject({
      state: "error",
      error: { code: "PREVIEW_START_FAILED" },
    })
    expect(manager.getStatus().url).toBeUndefined()
  })

  it("honors request cancellation during readiness and cleans up the process", async () => {
    const terminate = vi.fn<PreviewDependencies["terminate"]>(async (child) => {
      ;(child as FakeProcess).close()
      return true
    })
    const deps = dependencies({ terminate })
    const controller = new AbortController()
    const manager = new PreviewManager(deps)
    const starting = manager.start({ workspace: "C:\\Garden", signal: controller.signal })

    await until(() => expect(deps.children).toHaveLength(1), "cancelled preview spawn")
    controller.abort()

    await expect(starting).resolves.toEqual({ state: "stopped", generation: 1 })
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(deps.children[0].listenerCount("close")).toBe(0)
  })

  it("coalesces concurrent stop calls, removes owned listeners, and disposes subscribers", async () => {
    const termination = new Deferred<boolean>()
    const terminate = vi.fn<PreviewDependencies["terminate"]>(() => termination.promise)
    const deps = dependencies({ probe: async () => true, terminate })
    const manager = new PreviewManager(deps)
    const isolated = vi.fn(() => {
      throw new Error("subscriber failure")
    })
    const observed = vi.fn()
    manager.subscribe(isolated)
    const unsubscribe = manager.subscribe(observed)
    await manager.start({ workspace: "C:\\Garden" })
    const child = deps.children[0]

    const first = manager.stop()
    const second = manager.stop()

    expect(first).toBe(second)
    await until(
      () => expect(manager.getStatus()).toMatchObject({ state: "stopping" }),
      "stopping state",
    )
    termination.resolve(true)
    child.close()
    await expect(first).resolves.toEqual({ state: "stopped", generation: 1 })
    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.stderr.listenerCount("data")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)

    unsubscribe()
    const calls = observed.mock.calls.length
    await manager.dispose()
    expect(observed).toHaveBeenCalledTimes(calls)
  })

  it("keeps a failed-to-stop child tracked so a later stop can retry truthfully", async () => {
    const outcomes = [false, true]
    const terminate = vi.fn<PreviewDependencies["terminate"]>(async (child) => {
      const result = outcomes.shift() ?? false
      if (result) (child as FakeProcess).close()
      return result
    })
    const deps = dependencies({ probe: async () => true, terminate })
    const manager = new PreviewManager(deps)
    await manager.start({ workspace: "C:\\Garden" })

    await expect(manager.stop()).resolves.toMatchObject({
      state: "error",
      error: { code: "PREVIEW_STOP_FAILED" },
    })
    await expect(manager.stop()).resolves.toEqual({ state: "stopped", generation: 1 })
    expect(terminate).toHaveBeenCalledTimes(2)
  })
})

describe("createProcessTreeTerminator", () => {
  function treeDependencies(
    overrides: Partial<TreeTerminationDependencies> = {},
  ): TreeTerminationDependencies {
    return {
      platform: "win32",
      isAlive: () => true,
      signalGroup: () => undefined,
      runTaskkill: async () => undefined,
      wait: async () => undefined,
      gracefulWaitMs: 50,
      forceWaitMs: 50,
      ...overrides,
    }
  }

  it("uses graceful Windows tree termination and exact forced taskkill only while alive", async () => {
    const alive = [true, true, false]
    const runTaskkill = vi.fn<TreeTerminationDependencies["runTaskkill"]>(async () => undefined)
    const terminate = createProcessTreeTerminator(
      treeDependencies({ isAlive: () => alive.shift() ?? false, runTaskkill }),
    )
    const child = new FakeProcess()
    child.pid = 9876

    await expect(terminate(child)).resolves.toBe(true)
    expect(runTaskkill).toHaveBeenNthCalledWith(1, "taskkill.exe", ["/PID", "9876", "/T"], {
      shell: false,
      windowsHide: true,
    })
    expect(runTaskkill).toHaveBeenNthCalledWith(2, "taskkill.exe", ["/PID", "9876", "/T", "/F"], {
      shell: false,
      windowsHide: true,
    })
  })

  it("does not invoke taskkill when the Windows process is already gone", async () => {
    const runTaskkill = vi.fn<TreeTerminationDependencies["runTaskkill"]>()
    const terminate = createProcessTreeTerminator(
      treeDependencies({ isAlive: () => false, runTaskkill }),
    )

    await expect(terminate(new FakeProcess())).resolves.toBe(true)
    expect(runTaskkill).not.toHaveBeenCalled()
  })

  it("treats an uncertain liveness check as termination failure", async () => {
    const runTaskkill = vi.fn<TreeTerminationDependencies["runTaskkill"]>()
    const terminate = createProcessTreeTerminator(
      treeDependencies({
        isAlive: () => {
          throw new Error("access denied")
        },
        runTaskkill,
      }),
    )

    await expect(terminate(new FakeProcess())).resolves.toBe(false)
    expect(runTaskkill).not.toHaveBeenCalled()
  })

  it("signals only the detached POSIX process group and escalates if it remains alive", async () => {
    const alive = [true, true, false]
    const signalGroup = vi.fn<TreeTerminationDependencies["signalGroup"]>()
    const terminate = createProcessTreeTerminator(
      treeDependencies({
        platform: "linux",
        isAlive: () => alive.shift() ?? false,
        signalGroup,
      }),
    )
    const child = new FakeProcess()
    child.pid = 2468

    await expect(terminate(child)).resolves.toBe(true)
    expect(signalGroup).toHaveBeenNthCalledWith(1, -2468, "SIGTERM")
    expect(signalGroup).toHaveBeenNthCalledWith(2, -2468, "SIGKILL")
  })

  it("refuses unsafe or missing process identifiers", async () => {
    const signalGroup = vi.fn<TreeTerminationDependencies["signalGroup"]>()
    const runTaskkill = vi.fn<TreeTerminationDependencies["runTaskkill"]>()
    const terminate = createProcessTreeTerminator(treeDependencies({ signalGroup, runTaskkill }))
    const child = new FakeProcess()
    child.pid = 0

    await expect(terminate(child)).resolves.toBe(false)
    expect(signalGroup).not.toHaveBeenCalled()
    expect(runTaskkill).not.toHaveBeenCalled()
  })
})
