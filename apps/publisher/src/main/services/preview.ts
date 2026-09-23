import { posix, win32 } from "node:path"
import type { AppError, PreviewStatus, SerializableValue } from "../../shared/contracts"

export type { PreviewStatus } from "../../shared/contracts"

export interface PreviewProcess {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "error", listener: (error?: Error) => void): this
  on(event: "close", listener: (code: number | null, signal?: string | null) => void): this
  off(event: "error" | "close", listener: (...args: any[]) => void): this
}

export interface PreviewSpawnOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly shell: false
  readonly windowsHide: true
  readonly detached: boolean
}

export interface PortRequest {
  readonly host: "127.0.0.1"
  readonly preferredPort: number | undefined
  readonly exclude: readonly number[]
}

export interface PreviewDependencies {
  readonly resolveWorkspace: (workspace: string) => Promise<string>
  readonly isDirectory: (path: string) => Promise<boolean>
  readonly isFile: (path: string) => Promise<boolean>
  readonly runtimePath: () => string | undefined
  readonly spawn: (
    executable: string,
    args: readonly string[],
    options: PreviewSpawnOptions,
  ) => PreviewProcess
  readonly allocatePort: (request: PortRequest) => Promise<number>
  readonly probe: (url: string, signal: AbortSignal) => Promise<boolean>
  readonly probeWs: (port: number, signal: AbortSignal) => Promise<boolean>
  readonly terminate: (child: PreviewProcess) => Promise<boolean>
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly readinessTimeoutMs?: number
  readonly readinessPollMs?: number
  readonly maxPortRetries?: number
  readonly safeEnvironment?: Readonly<Record<string, string | undefined>>
}

export interface PreviewStartRequest {
  readonly workspace: string
  readonly preferredPort?: number
  readonly signal?: AbortSignal
}

export interface TreeTerminationDependencies {
  readonly platform: NodeJS.Platform
  readonly isAlive: (target: number) => boolean
  readonly signalGroup: (target: number, signal: "SIGTERM" | "SIGKILL") => void
  readonly runTaskkill: (
    executable: "taskkill.exe",
    args: readonly string[],
    options: { readonly shell: false; readonly windowsHide: true },
  ) => Promise<void>
  readonly wait: (milliseconds: number) => Promise<void>
  readonly gracefulWaitMs: number
  readonly forceWaitMs: number
}

type Listener = (status: PreviewStatus) => void
type AttemptEvent =
  | { readonly kind: "port-race" }
  | { readonly kind: "build-error" }
  | { readonly kind: "process-error"; readonly noChild: boolean }
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null }
type WaitOutcome =
  | AttemptEvent
  | { readonly kind: "ready" }
  | { readonly kind: "aborted" }
  | { readonly kind: "timeout" }
type ReadinessRound = WaitOutcome | { readonly kind: "not-ready" } | { readonly kind: "tick" }

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface ProcessAttempt {
  readonly child: PreviewProcess
  readonly port: number
  readonly wsPort: number
  readonly events: Deferred<AttemptEvent>
  readonly onStdout: (chunk: unknown) => void
  readonly onStderr: (chunk: unknown) => void
  readonly onError: () => void
  readonly onClose: (code: number | null, signal?: string | null) => void
  stdoutRemainder: string
  stderrRemainder: string
  settled: boolean
  inStartup: boolean
  startupWaitActive: boolean
  stopping: boolean
  buildFailed: boolean
  closeObserved: boolean
}

interface PreviewSession {
  readonly canonicalKey: string
  readonly workspace: string
  readonly generation: number
  readonly ordinal: number
  readonly controller: AbortController
  attempt?: ProcessAttempt
  lastSuccessfulUrl?: string
}

const LOOPBACK_HOST = "127.0.0.1" as const
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g
const URL = /https?:\/\/[^\s]+/gi
const WINDOWS_FILE_PATH =
  /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*?\.(?:md|markdown|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|ini|css|scss|html|vue|svelte)\b/gi
const WINDOWS_PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`()<>]+/g
const POSIX_FILE_PATH =
  /\/[^\r\n]*?\.(?:md|markdown|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|ini|css|scss|html|vue|svelte)\b/gi
const POSIX_PATH_TOKEN = /\/[^\s"'`()<>]+/g
const RELATIVE_FILE =
  /(^|[\s"'`(])(?:(?:\.{1,2}[\\/])?(?:[^\\/\s"'`()<>:]+[\\/])*)?[^\\/\s"'`()<>:]+\.(?:md|markdown|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|ini|css|scss|html|vue|svelte)\b/gi
const MAX_LOG_LINES = 80
const MAX_LOG_BYTES = 8_192
const MAX_LOG_ENTRY_BYTES = 512
const MAX_PARTIAL_BYTES = 512
const TRUNCATION_MARKER = "[truncated] "

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function appError(
  code: AppError["code"],
  message: string,
  details?: Readonly<Record<string, SerializableValue>>,
): AppError {
  return details === undefined
    ? ({ code, message } as AppError)
    : ({ code, message, details } as AppError)
}

function publicUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}/`
}

function normalized(line: string): string {
  return line.replace(ANSI, "")
}

function boundedUtf8Tail(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= maximumBytes) return value
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8")
  const tail = bytes
    .subarray(bytes.byteLength - Math.max(0, maximumBytes - markerBytes))
    .toString("utf8")
    .replace(/^\uFFFD+/, "")
  return `${TRUNCATION_MARKER}${tail}`
}

function scrub(line: string): string {
  const redacted = normalized(line)
    .replace(URL, "[url]")
    .replace(WINDOWS_FILE_PATH, "[path]")
    .replace(WINDOWS_PATH_TOKEN, "[path]")
    .replace(RELATIVE_FILE, (_match, prefix: string) => `${prefix}[file]`)
    .replace(POSIX_FILE_PATH, "[path]")
    .replace(POSIX_PATH_TOKEN, "[path]")
  return boundedUtf8Tail(redacted, MAX_LOG_ENTRY_BYTES)
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })
}

function safeAlive(dependencies: TreeTerminationDependencies, target: number): boolean | undefined {
  try {
    return dependencies.isAlive(target)
  } catch {
    return undefined
  }
}

/** Builds a verified process-tree terminator with all platform effects injectable for tests. */
export function createProcessTreeTerminator(
  dependencies: TreeTerminationDependencies,
): (child: PreviewProcess) => Promise<boolean> {
  return async (child): Promise<boolean> => {
    const pid = child.pid
    if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) return false

    if (dependencies.platform === "win32") {
      const initiallyAlive = safeAlive(dependencies, pid)
      if (initiallyAlive === undefined) return false
      if (!initiallyAlive) return false
      let taskkillFailed = false
      try {
        await dependencies.runTaskkill("taskkill.exe", ["/PID", String(pid), "/T"], {
          shell: false,
          windowsHide: true,
        })
      } catch {
        taskkillFailed = true
      }
      await dependencies.wait(dependencies.gracefulWaitMs)
      const aliveAfterGrace = safeAlive(dependencies, pid)
      if (aliveAfterGrace === undefined) return false
      if (!aliveAfterGrace) return !taskkillFailed
      try {
        await dependencies.runTaskkill("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
        })
      } catch {
        taskkillFailed = true
      }
      await dependencies.wait(dependencies.forceWaitMs)
      const aliveAfterForce = safeAlive(dependencies, pid)
      return !taskkillFailed && aliveAfterForce === false
    }

    const group = -pid
    const initiallyAlive = safeAlive(dependencies, group)
    if (initiallyAlive === undefined) return false
    if (!initiallyAlive) return true
    try {
      dependencies.signalGroup(group, "SIGTERM")
    } catch {
      // The group may have exited between checks.
    }
    await dependencies.wait(dependencies.gracefulWaitMs)
    const aliveAfterGrace = safeAlive(dependencies, group)
    if (aliveAfterGrace === undefined) return false
    if (!aliveAfterGrace) return true
    try {
      dependencies.signalGroup(group, "SIGKILL")
    } catch {
      // The final group liveness check remains authoritative.
    }
    await dependencies.wait(dependencies.forceWaitMs)
    const aliveAfterForce = safeAlive(dependencies, group)
    return aliveAfterForce === false
  }
}

export class PreviewDisposeError extends Error {
  readonly name = "PreviewDisposeError"

  constructor(readonly error: AppError) {
    super(error.message)
  }
}

/** Manages one Quartz preview process and exposes only redacted, loopback-safe status. */
export class PreviewManager {
  private status: PreviewStatus = { state: "stopped", generation: 0 }
  private session: PreviewSession | undefined
  private operationTail: Promise<void> = Promise.resolve()
  private stopFlight: Promise<PreviewStatus> | undefined
  private rawFlights = new Map<
    string,
    { readonly epoch: number; readonly flight: Promise<PreviewStatus> }
  >()
  private canonicalFlights = new Map<
    string,
    { readonly epoch: number; readonly flight: Promise<PreviewStatus> }
  >()
  private latestPrepared: { readonly ordinal: number; readonly canonicalKey: string } | undefined
  private nextOrdinal = 0
  private lifecycleEpoch = 0
  private disposed = false
  private disposeFlight: Promise<void> | undefined
  private listeners = new Set<Listener>()
  private tail: string[] = []
  private tailBytes = 0

  constructor(private readonly dependencies: PreviewDependencies) {}

  getStatus(): PreviewStatus {
    return this.status
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(request: PreviewStartRequest): Promise<PreviewStatus> {
    if (this.disposed || this.disposeFlight !== undefined) return Promise.resolve(this.status)
    const rawKey = this.key(this.pathApi().normalize(request.workspace))
    const epoch = this.lifecycleEpoch
    const existing = this.rawFlights.get(rawKey)
    if (existing?.epoch === epoch) return existing.flight

    const ordinal = ++this.nextOrdinal
    const flight = this.prepareStart(request, rawKey, ordinal, epoch)
    this.rawFlights.set(rawKey, { epoch, flight })
    const cleanup = (): void => {
      if (this.rawFlights.get(rawKey)?.flight === flight) this.rawFlights.delete(rawKey)
    }
    void flight.then(cleanup, cleanup)
    return flight
  }

  stop(): Promise<PreviewStatus> {
    this.lifecycleEpoch += 1
    this.session?.controller.abort()
    if (this.stopFlight !== undefined) return this.stopFlight
    if (this.session === undefined && this.status.state === "stopped")
      return Promise.resolve(this.status)

    const flight = this.enqueue(async () => {
      const session = this.session
      if (session === undefined)
        return this.transition({ state: "stopped", generation: this.status.generation })
      return this.stopSession(session)
    })
    this.stopFlight = flight
    const cleanup = (): void => {
      if (this.stopFlight === flight) this.stopFlight = undefined
    }
    void flight.then(cleanup, cleanup)
    return flight
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.disposeFlight !== undefined) return this.disposeFlight

    const flight = this.performDispose()
    this.disposeFlight = flight
    const releaseFailedFlight = (): void => {
      if (this.disposeFlight === flight) this.disposeFlight = undefined
    }
    void flight.catch(releaseFailedFlight)
    return flight
  }

  private async performDispose(): Promise<void> {
    const status = await this.stop()
    if (this.session !== undefined || status.state !== "stopped") {
      const failure =
        status.error?.code === "PREVIEW_STOP_FAILED"
          ? status.error
          : appError("PREVIEW_STOP_FAILED", "Local preview could not be stopped safely.")
      throw new PreviewDisposeError(failure)
    }

    this.disposed = true
    this.rawFlights.clear()
    this.canonicalFlights.clear()
    this.listeners.clear()
  }

  private async prepareStart(
    request: PreviewStartRequest,
    _rawKey: string,
    ordinal: number,
    epoch: number,
  ): Promise<PreviewStatus> {
    if (request.signal?.aborted) return this.status
    if (epoch !== this.lifecycleEpoch) {
      await this.operationTail
      return this.status
    }

    let workspace: string
    try {
      workspace = await this.dependencies.resolveWorkspace(request.workspace)
    } catch {
      return this.enqueueStartError(
        epoch,
        ordinal,
        "WORKSPACE_INVALID",
        "Select an existing workspace directory.",
      )
    }
    if (request.signal?.aborted) return this.status
    if (epoch !== this.lifecycleEpoch) {
      await this.operationTail
      return this.status
    }

    const canonicalKey = this.key(this.pathApi().normalize(workspace))
    const canonical = this.canonicalFlights.get(canonicalKey)
    if (canonical?.epoch === epoch) return canonical.flight

    if (this.latestPrepared === undefined || ordinal > this.latestPrepared.ordinal) {
      this.latestPrepared = { ordinal, canonicalKey }
    } else if (
      ordinal < this.latestPrepared.ordinal &&
      canonicalKey !== this.latestPrepared.canonicalKey
    ) {
      await this.operationTail
      return this.status
    }

    if (
      this.session !== undefined &&
      this.session.canonicalKey !== canonicalKey &&
      ordinal > this.session.ordinal
    ) {
      this.session.controller.abort()
    }

    const flight = this.enqueue(() =>
      this.beginStart(request, workspace, canonicalKey, ordinal, epoch),
    )
    this.canonicalFlights.set(canonicalKey, { epoch, flight })
    const cleanup = (): void => {
      if (this.canonicalFlights.get(canonicalKey)?.flight === flight)
        this.canonicalFlights.delete(canonicalKey)
    }
    void flight.then(cleanup, cleanup)
    return flight
  }

  private enqueueStartError(
    epoch: number,
    ordinal: number,
    code: "WORKSPACE_INVALID",
    message: string,
  ): Promise<PreviewStatus> {
    return this.enqueue(async () => {
      if (epoch !== this.lifecycleEpoch || ordinal < this.nextOrdinal) return this.status
      const generation = this.status.generation + 1
      return this.transition({ state: "error", generation, error: appError(code, message) })
    })
  }

  private async beginStart(
    request: PreviewStartRequest,
    workspace: string,
    canonicalKey: string,
    ordinal: number,
    epoch: number,
  ): Promise<PreviewStatus> {
    if (epoch !== this.lifecycleEpoch || request.signal?.aborted || this.disposed)
      return this.status
    if (
      this.latestPrepared !== undefined &&
      ordinal < this.latestPrepared.ordinal &&
      canonicalKey !== this.latestPrepared.canonicalKey
    ) {
      return this.status
    }
    if (this.session?.canonicalKey === canonicalKey && this.session.attempt !== undefined)
      return this.status
    if (this.session !== undefined) {
      const stopped = await this.stopSession(this.session)
      if (stopped.state === "error") return stopped
    }

    const generation = this.status.generation + 1
    const controller = new AbortController()
    const session: PreviewSession = { canonicalKey, workspace, generation, ordinal, controller }
    this.session = session
    const onRequestAbort = (): void => controller.abort()
    request.signal?.addEventListener("abort", onRequestAbort, { once: true })

    try {
      if (!(await this.dependencies.isDirectory(workspace))) {
        return this.failSession(
          session,
          "WORKSPACE_INVALID",
          "Select an existing workspace directory.",
        )
      }
      const path = this.pathApi()
      const quartzCli = path.join(workspace, "quartz", "bootstrap-cli.mjs")
      if (!(await this.dependencies.isFile(quartzCli))) {
        return this.failSession(session, "QUARTZ_MISSING", "Quartz preview files are unavailable.")
      }
      const runtime = this.dependencies.runtimePath()
      if (runtime === undefined || !(await this.dependencies.isFile(runtime))) {
        return this.failSession(
          session,
          "RUNTIME_MISSING",
          "Bundled preview runtime is unavailable.",
        )
      }
      if (controller.signal.aborted || epoch !== this.lifecycleEpoch)
        return this.stopSession(session)

      this.resetTail()
      const excludedPorts: number[] = []
      const maxRetries = Math.max(0, this.dependencies.maxPortRetries ?? 2)
      for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
        if (controller.signal.aborted || epoch !== this.lifecycleEpoch)
          return this.stopSession(session)
        let port: number
        let wsPort: number
        try {
          port = await this.dependencies.allocatePort({
            host: LOOPBACK_HOST,
            preferredPort: attemptIndex === 0 ? request.preferredPort : undefined,
            exclude: [...excludedPorts],
          })
          if (!validPort(port) || excludedPorts.includes(port)) throw new Error("invalid port")
          excludedPorts.push(port)
          wsPort = await this.dependencies.allocatePort({
            host: LOOPBACK_HOST,
            preferredPort: undefined,
            exclude: [...excludedPorts],
          })
          if (!validPort(wsPort) || excludedPorts.includes(wsPort)) throw new Error("invalid port")
          excludedPorts.push(wsPort)
        } catch {
          return this.failSession(
            session,
            "PORT_UNAVAILABLE",
            "A local preview port could not be reserved.",
          )
        }
        if (controller.signal.aborted || epoch !== this.lifecycleEpoch)
          return this.stopSession(session)

        this.transition({ state: "starting", generation, port })
        let child: PreviewProcess
        try {
          child = this.dependencies.spawn(
            runtime,
            [quartzCli, "build", "--serve", "--port", String(port), "--wsPort", String(wsPort)],
            {
              cwd: workspace,
              env: {
                ...this.dependencies.safeEnvironment,
                QUARTZ_PREVIEW_LOOPBACK: LOOPBACK_HOST,
              },
              shell: false,
              windowsHide: true,
              detached: (this.dependencies.platform ?? process.platform) !== "win32",
            },
          )
        } catch {
          return this.failSession(session, "PREVIEW_START_FAILED", "Could not start local preview.")
        }

        const attempt = this.attachAttempt(session, child, port, wsPort)
        session.attempt = attempt
        let outcome = await this.waitForReady(session, attempt)
        attempt.startupWaitActive = false
        if (outcome.kind === "ready" && attempt.settled) {
          outcome = await attempt.events.promise
        }
        if (outcome.kind === "ready") {
          attempt.inStartup = false
          session.lastSuccessfulUrl = publicUrl(port)
          return this.transition({
            state: "ready",
            generation,
            port,
            url: session.lastSuccessfulUrl,
            lastSuccessfulUrl: session.lastSuccessfulUrl,
          })
        }
        if (outcome.kind === "aborted") return this.stopSession(session)
        if (outcome.kind === "port-race") {
          const terminated = await this.terminateAttempt(session, attempt)
          if (!terminated) return this.stopFailure(session, port)
          if (attemptIndex < maxRetries) continue
          this.clearSession(session)
          return this.transition({
            state: "error",
            generation,
            port,
            error: appError(
              "PORT_UNAVAILABLE",
              "A local preview port could not be reserved.",
              this.logDetails(),
            ),
          })
        }
        if (outcome.kind === "build-error") {
          const terminated = await this.terminateAttempt(session, attempt)
          if (!terminated) return this.stopFailure(session, attempt.port)
          this.clearSession(session)
          return this.status
        }
        if (outcome.kind === "timeout") {
          const terminated = await this.terminateAttempt(session, attempt)
          if (!terminated) return this.stopFailure(session, attempt.port)
          this.clearSession(session)
          return this.transition({
            state: "error",
            generation,
            port,
            error: appError(
              "PREVIEW_TIMEOUT",
              "Local preview did not become ready.",
              this.logDetails(),
            ),
          })
        }
        if (outcome.kind === "process-error") {
          const failure = this.transition({
            state: "error",
            generation,
            port,
            error: appError(
              "PREVIEW_START_FAILED",
              "Local preview reported a process error.",
              this.logDetails(),
            ),
          })
          if (outcome.noChild) {
            this.detachAttempt(attempt)
            attempt.inStartup = false
            session.attempt = undefined
            this.clearSession(session)
            return failure
          }

          const terminated = await this.terminateAttempt(session, attempt)
          if (!terminated) return this.stopFailure(session, attempt.port)
          this.clearSession(session)
          return failure
        }

        this.detachAttempt(attempt)
        session.attempt = undefined
        this.clearSession(session)
        return this.transition({
          state: "error",
          generation,
          port,
          error: appError(
            "PREVIEW_START_FAILED",
            "Local preview exited unexpectedly.",
            this.logDetails(),
          ),
        })
      }
      return this.status
    } catch {
      return this.failSession(session, "PREVIEW_START_FAILED", "Could not start local preview.")
    } finally {
      request.signal?.removeEventListener("abort", onRequestAbort)
    }
  }

  private async waitForReady(
    session: PreviewSession,
    attempt: ProcessAttempt,
  ): Promise<WaitOutcome> {
    const signal = session.controller.signal
    const aborted = deferred<WaitOutcome>()
    const onAbort = (): void => aborted.resolve({ kind: "aborted" })
    signal.addEventListener("abort", onAbort, { once: true })
    const now = this.dependencies.now ?? Date.now
    const delay = this.dependencies.delay ?? defaultDelay
    const deadline = now() + Math.max(1, this.dependencies.readinessTimeoutMs ?? 30_000)

    try {
      while (this.session === session && session.attempt === attempt) {
        if (signal.aborted) return { kind: "aborted" }
        const pollController = new AbortController()
        const cancelPoll = (): void => pollController.abort()
        signal.addEventListener("abort", cancelPoll, { once: true })
        const probe = Promise.all([
          this.dependencies.probe(publicUrl(attempt.port), pollController.signal),
          this.dependencies.probeWs(attempt.wsPort, pollController.signal),
        ])
          .then<ReadinessRound>((readiness) =>
            readiness.every(Boolean) ? { kind: "ready" } : { kind: "not-ready" },
          )
          .catch<ReadinessRound>(() => ({ kind: "not-ready" }))
        const poll = delay(
          Math.max(1, this.dependencies.readinessPollMs ?? 150),
          pollController.signal,
        ).then<ReadinessRound>(() => ({ kind: "tick" }))
        try {
          let result = await Promise.race<ReadinessRound>([
            probe,
            poll,
            attempt.events.promise,
            aborted.promise,
          ])
          if (result.kind === "not-ready") {
            result = await Promise.race<ReadinessRound>([
              poll,
              attempt.events.promise,
              aborted.promise,
            ])
          }
          if (result.kind === "not-ready") continue
          if (result.kind !== "tick") return result
          if (now() >= deadline) return { kind: "timeout" }
        } finally {
          signal.removeEventListener("abort", cancelPoll)
          pollController.abort()
        }
      }
      return { kind: "aborted" }
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  private attachAttempt(
    session: PreviewSession,
    child: PreviewProcess,
    port: number,
    wsPort: number,
  ): ProcessAttempt {
    const events = deferred<AttemptEvent>()
    const attempt = {
      child,
      port,
      wsPort,
      events,
      stdoutRemainder: "",
      stderrRemainder: "",
      settled: false,
      inStartup: true,
      startupWaitActive: true,
      stopping: false,
      buildFailed: false,
      closeObserved: false,
      onStdout: (chunk: unknown): void =>
        this.consumeChunk(session, attempt, String(chunk), "stdout"),
      onStderr: (chunk: unknown): void =>
        this.consumeChunk(session, attempt, String(chunk), "stderr"),
      onError: (): void =>
        this.processEvent(session, attempt, {
          kind: "process-error",
          noChild: child.pid === undefined,
        }),
      onClose: (code: number | null, signal?: string | null): void => {
        this.processEvent(session, attempt, { kind: "exit", code, signal: signal ?? null })
      },
    } satisfies ProcessAttempt

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", attempt.onStdout)
    child.stderr?.on("data", attempt.onStderr)
    child.on("error", attempt.onError)
    child.on("close", attempt.onClose)
    return attempt
  }

  private processEvent(
    session: PreviewSession,
    attempt: ProcessAttempt,
    event: Extract<AttemptEvent, { readonly kind: "process-error" | "exit" }>,
  ): void {
    if (this.session !== session || session.attempt !== attempt) return
    const confirmedClose = event.kind === "exit"
    if (confirmedClose) attempt.closeObserved = true
    this.flushRemainders(session, attempt)
    this.settleAttempt(attempt, event)
    if (attempt.stopping || (attempt.inStartup && attempt.startupWaitActive)) return
    if (!confirmedClose) {
      if (
        attempt.buildFailed ||
        (this.status.state === "error" && this.status.error?.code === "PREVIEW_STOP_FAILED")
      ) {
        return
      }
      this.transition({
        state: "error",
        generation: session.generation,
        port: attempt.port,
        lastSuccessfulUrl: session.lastSuccessfulUrl,
        error: appError(
          "PREVIEW_START_FAILED",
          "Local preview reported a process error.",
          this.logDetails(),
        ),
      })
      return
    }

    this.detachAttempt(attempt)
    attempt.inStartup = false
    session.attempt = undefined
    this.clearSession(session)
    if (
      attempt.buildFailed ||
      (this.status.state === "error" && this.status.error?.code === "PREVIEW_STOP_FAILED")
    ) {
      return
    }
    this.transition({
      state: "error",
      generation: session.generation,
      port: attempt.port,
      lastSuccessfulUrl: session.lastSuccessfulUrl,
      error: appError("PREVIEW_EXITED", "Local preview stopped unexpectedly.", this.logDetails()),
    })
  }

  private consumeChunk(
    session: PreviewSession,
    attempt: ProcessAttempt,
    chunk: string,
    source: "stdout" | "stderr",
  ): void {
    if (this.session !== session || session.attempt !== attempt || attempt.stopping) return
    const buffered =
      (source === "stdout" ? attempt.stdoutRemainder : attempt.stderrRemainder) + chunk
    const lines = buffered.split(/\r\n|\n|\r/)
    const remainder = boundedUtf8Tail(lines.pop() ?? "", MAX_PARTIAL_BYTES)
    if (source === "stdout") attempt.stdoutRemainder = remainder
    else attempt.stderrRemainder = remainder
    for (const line of lines) {
      if (line !== "") this.consumeLine(session, attempt, line)
    }
  }

  private flushRemainders(session: PreviewSession, attempt: ProcessAttempt): void {
    for (const line of [attempt.stdoutRemainder, attempt.stderrRemainder]) {
      if (line !== "") this.consumeLine(session, attempt, line)
    }
    attempt.stdoutRemainder = ""
    attempt.stderrRemainder = ""
  }

  private consumeLine(session: PreviewSession, attempt: ProcessAttempt, raw: string): void {
    if (this.session !== session || session.attempt !== attempt || attempt.stopping) return
    this.appendTail(raw)
    const line = normalized(raw).toLowerCase()
    if (/eaddrinuse|address already in use|port .*already in use/i.test(line)) {
      this.settleAttempt(attempt, { kind: "port-race" })
      return
    }

    const initialBuildFailure = line.includes("failed to build quartz")
    const rebuildFailure = line.includes("rebuild failed:")
    if (initialBuildFailure || rebuildFailure) {
      attempt.buildFailed = true
      this.transition({
        state: "error",
        generation: session.generation,
        port: attempt.port,
        lastSuccessfulUrl: session.lastSuccessfulUrl,
        error: appError(
          "PREVIEW_BUILD_FAILED",
          "Quartz could not build the preview.",
          this.logDetails(),
        ),
      })
      if (attempt.inStartup) this.settleAttempt(attempt, { kind: "build-error" })
      return
    }

    const rebuildStarted =
      line.includes("detected change, rebuilding") || line.includes("detected a source code change")
    if (
      rebuildStarted &&
      session.lastSuccessfulUrl !== undefined &&
      (this.status.state === "ready" || this.status.state === "error")
    ) {
      attempt.buildFailed = false
      this.transition({
        state: "building",
        generation: session.generation,
        port: attempt.port,
        lastSuccessfulUrl: session.lastSuccessfulUrl,
      })
      return
    }

    if (this.status.state === "building" && line.includes("done rebuilding")) {
      attempt.buildFailed = false
      this.transition({
        state: "ready",
        generation: session.generation,
        port: attempt.port,
        url: session.lastSuccessfulUrl,
        lastSuccessfulUrl: session.lastSuccessfulUrl,
      })
    }
  }

  private settleAttempt(attempt: ProcessAttempt, event: AttemptEvent): void {
    if (attempt.settled) return
    attempt.settled = true
    attempt.events.resolve(event)
  }

  private async stopSession(session: PreviewSession): Promise<PreviewStatus> {
    if (this.session !== session) return this.status
    session.controller.abort()
    const attempt = session.attempt
    this.transition({
      state: "stopping",
      generation: session.generation,
      port: attempt?.port ?? this.status.port,
      lastSuccessfulUrl: session.lastSuccessfulUrl,
    })
    if (attempt === undefined) {
      this.clearSession(session)
      return this.transition({ state: "stopped", generation: session.generation })
    }

    const terminated = await this.terminateAttempt(session, attempt)
    if (!terminated) return this.stopFailure(session, attempt.port)
    this.clearSession(session)
    return this.transition({ state: "stopped", generation: session.generation })
  }

  private async terminateAttempt(
    session: PreviewSession,
    attempt: ProcessAttempt,
  ): Promise<boolean> {
    if (this.session !== session || session.attempt !== attempt) return true
    attempt.stopping = true
    let terminated = false
    try {
      terminated = await this.dependencies.terminate(attempt.child)
    } catch {
      terminated = false
    }
    if (!terminated) {
      if (attempt.closeObserved) {
        this.detachAttempt(attempt)
        if (session.attempt === attempt) session.attempt = undefined
        return true
      }
      attempt.stopping = false
      return false
    }
    this.detachAttempt(attempt)
    if (session.attempt === attempt) session.attempt = undefined
    return true
  }

  private stopFailure(session: PreviewSession, port: number): PreviewStatus {
    return this.transition({
      state: "error",
      generation: session.generation,
      port,
      lastSuccessfulUrl: session.lastSuccessfulUrl,
      error: appError(
        "PREVIEW_STOP_FAILED",
        "Local preview could not be stopped safely.",
        this.logDetails(),
      ),
    })
  }

  private failSession(
    session: PreviewSession,
    code: AppError["code"],
    message: string,
  ): PreviewStatus {
    this.clearSession(session)
    return this.transition({
      state: "error",
      generation: session.generation,
      error: appError(code, message),
    })
  }

  private clearSession(session: PreviewSession): void {
    if (this.session === session && session.attempt === undefined) this.session = undefined
  }

  private detachAttempt(attempt: ProcessAttempt): void {
    attempt.child.stdout?.removeListener("data", attempt.onStdout)
    attempt.child.stderr?.removeListener("data", attempt.onStderr)
    attempt.child.off("error", attempt.onError)
    attempt.child.off("close", attempt.onClose)
  }

  private appendTail(line: string): void {
    const entry = scrub(line)
    this.tail.push(entry)
    this.tailBytes += Buffer.byteLength(entry)
    while (this.tail.length > MAX_LOG_LINES || this.tailBytes > MAX_LOG_BYTES) {
      const removed = this.tail.shift()
      if (removed !== undefined) this.tailBytes -= Buffer.byteLength(removed)
    }
  }

  private resetTail(): void {
    this.tail = []
    this.tailBytes = 0
  }

  private logDetails(): Readonly<Record<string, SerializableValue>> {
    return { logTail: [...this.tail] }
  }

  private transition(status: PreviewStatus): PreviewStatus {
    this.status = status
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch {
        // One renderer subscriber cannot break lifecycle delivery to the others.
      }
    }
    return status
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.operationTail.then(operation, operation)
    this.operationTail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }

  private key(workspace: string): string {
    return (this.dependencies.platform ?? process.platform) === "win32"
      ? workspace.toLowerCase()
      : workspace
  }

  private pathApi(): typeof posix | typeof win32 {
    return (this.dependencies.platform ?? process.platform) === "win32" ? win32 : posix
  }
}
