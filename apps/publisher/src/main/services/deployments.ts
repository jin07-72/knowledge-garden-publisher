import type {
  DeploymentHistoryRequest,
  DeploymentHistory,
  DeploymentRun,
  GitCommit,
  HistoryCancelRequest,
  HistoryRequest,
} from "../../shared/contracts"
import {
  createSystemBoundedCommandRunner,
  type BoundedCommandRunner,
} from "./publish"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const GIT_LOG_OUTPUT_LIMIT = 512 * 1024
const GIT_VALUE_OUTPUT_LIMIT = 8 * 1024
const API_OUTPUT_LIMIT = 1024 * 1024
const POLL_DELAYS = [3_000, 6_000, 12_000, 20_000] as const
const DEFAULT_TIMEOUT_MS = 60_000
const SHA_PATTERN = /^[a-f0-9]{40,64}$/
const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface GitHubRepository {
  readonly owner: string
  readonly repo: string
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>

export interface DeploymentHistoryService {
  git(request?: HistoryRequest): Promise<readonly GitCommit[]>
  deployments(request?: DeploymentHistoryRequest): Promise<DeploymentHistory>
  cancel(request: HistoryCancelRequest): Promise<void>
  openLink(url: string): Promise<void>
  dispose(): Promise<void>
}

export interface DeploymentHistoryDependencies {
  readonly workspace: string
  readonly runner?: BoundedCommandRunner
  readonly fetcher?: Fetcher
  readonly wait?: Wait
  readonly timeoutMs?: number
  readonly openExternal?: (url: string) => Promise<void>
}

interface CachedRuns {
  readonly repositoryKey: string
  readonly etag?: string
  readonly runs: readonly DeploymentRun[]
}

interface ResolvedRepository {
  readonly repository: GitHubRepository
  readonly repositoryKey: string
  readonly links: Pick<DeploymentHistory, "actionsUrl" | "liveSiteUrl">
}

interface DeploymentFlight {
  readonly controller: AbortController
  readonly promise: Promise<DeploymentHistory>
}

const anonymousFlight = Symbol("anonymous-deployment-history-flight")

function normalizedLimit(request?: HistoryRequest): number {
  return Math.min(MAX_LIMIT, Math.max(1, request?.limit ?? DEFAULT_LIMIT))
}

function repository(owner: string, repo: string): GitHubRepository {
  const normalizedRepo = repo.replace(/\.git$/i, "")
  if (
    owner === "." ||
    owner === ".." ||
    normalizedRepo === "." ||
    normalizedRepo === ".." ||
    !SEGMENT_PATTERN.test(owner) ||
    !SEGMENT_PATTERN.test(normalizedRepo)
  ) {
    throw new Error("The GitHub origin is invalid.")
  }
  return { owner, repo: normalizedRepo }
}

export function parseGitHubRemote(remote: string): GitHubRepository {
  const value = remote.trim()
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value)
  if (scp) return repository(scp[1], scp[2])

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("The GitHub origin is invalid.")
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "ssh:") ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.password ||
    (url.protocol === "https:" && url.username) ||
    (url.protocol === "ssh:" && url.username !== "git") ||
    url.search ||
    url.hash
  ) {
    throw new Error("The GitHub origin is invalid.")
  }
  const parts = url.pathname.replace(/^\//, "").split("/")
  if (parts.length !== 2) throw new Error("The GitHub origin is invalid.")
  return repository(parts[0], parts[1])
}

function publicLinks(
  repo: GitHubRepository,
): Pick<DeploymentHistory, "actionsUrl" | "liveSiteUrl"> {
  const owner = encodeURIComponent(repo.owner)
  const name = encodeURIComponent(repo.repo)
  return {
    actionsUrl: `https://github.com/${owner}/${name}/actions/workflows/deploy.yml`,
    liveSiteUrl:
      repo.repo.toLowerCase() === `${repo.owner.toLowerCase()}.github.io`
        ? `https://${repo.owner}.github.io/`
        : `https://${repo.owner}.github.io/${name}/`,
  }
}

function isExactRunUrl(value: string, repo: GitHubRepository): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  )
    return false
  const prefix = `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/runs/`
  return (
    url.hostname.toLowerCase() === "github.com" &&
    url.pathname.startsWith(prefix) &&
    /^\d+$/.test(url.pathname.slice(prefix.length))
  )
}

export function isSafeHistoryUrl(value: string, repo: GitHubRepository): boolean {
  const links = publicLinks(repo)
  return value === links.actionsUrl || value === links.liveSiteUrl || isExactRunUrl(value, repo)
}

function gitFailure(message: string): never {
  throw { code: "GIT_STATUS_FAILED", message }
}

function parseGitLog(output: string, limit: number): readonly GitCommit[] {
  if (output === "") return []
  const fields = output.split("\0")
  if (fields.at(-1) === "") fields.pop()
  if (fields.length % 4 !== 0) gitFailure("无法读取本地发布历史。")
  const commits: GitCommit[] = []
  for (let index = 0; index < fields.length && commits.length < limit; index += 4) {
    const [id, authoredAt, subject, author] = fields.slice(index, index + 4)
    if (
      !SHA_PATTERN.test(id) ||
      !authoredAt ||
      !subject ||
      subject.length > 1_000 ||
      !author ||
      author.length > 256
    ) {
      gitFailure("无法读取本地发布历史。")
    }
    commits.push({ id, authoredAt, subject, author })
  }
  return commits
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

function stringField(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined
}

function deploymentStatus(
  status: unknown,
  conclusion: unknown,
): DeploymentRun["status"] | undefined {
  if (status === "queued" || status === "waiting" || status === "requested" || status === "pending")
    return "pending"
  if (status === "in_progress") return "running"
  if (status !== "completed") return undefined
  if (conclusion === "success") return "succeeded"
  if (conclusion === "cancelled" || conclusion === "skipped") return "cancelled"
  return "failed"
}

function parseRuns(body: string, limit: number, repo: GitHubRepository): readonly DeploymentRun[] {
  if (Buffer.byteLength(body, "utf8") > API_OUTPUT_LIMIT) throw new Error("response too large")
  const parsed = JSON.parse(body) as { readonly workflow_runs?: unknown }
  if (!Array.isArray(parsed.workflow_runs)) throw new Error("invalid response")
  const runs: DeploymentRun[] = []
  for (const candidate of parsed.workflow_runs.slice(0, limit)) {
    if (!candidate || typeof candidate !== "object") continue
    const value = candidate as Readonly<Record<string, unknown>>
    const headSha = stringField(value.head_sha, 64)
    const startedAt = stringField(value.run_started_at, 64) ?? stringField(value.created_at, 64)
    const status = deploymentStatus(value.status, value.conclusion)
    const rawId =
      typeof value.id === "number" || typeof value.id === "string" ? String(value.id) : ""
    const rawUrl = stringField(value.html_url, 2_048)
    if (!headSha || !SHA_PATTERN.test(headSha) || !startedAt || !status || !/^\d+$/.test(rawId))
      continue
    const url = rawUrl && isExactRunUrl(rawUrl, repo) ? rawUrl : undefined
    const completedAt =
      status === "pending" || status === "running" ? undefined : stringField(value.updated_at, 64)
    runs.push({
      id: rawId,
      headSha,
      startedAt,
      status,
      ...(completedAt ? { completedAt } : {}),
      ...(url ? { url } : {}),
    })
  }
  return runs
}

async function boundedResponseText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > API_OUTPUT_LIMIT) throw new Error("response too large")
  const reader = response.body?.getReader()
  if (!reader) {
    const body = await response.text()
    if (Buffer.byteLength(body, "utf8") > API_OUTPUT_LIMIT) throw new Error("response too large")
    return body
  }
  const chunks: Buffer[] = []
  let bytes = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    const chunk = Buffer.from(item.value)
    bytes += chunk.byteLength
    if (bytes > API_OUTPUT_LIMIT) {
      await reader.cancel().catch(() => undefined)
      throw new Error("response too large")
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes).toString("utf8")
}

function isTerminal(status: DeploymentRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled"
}

class DeploymentHistoryServiceImpl implements DeploymentHistoryService {
  readonly #workspace: string
  readonly #runner: BoundedCommandRunner
  readonly #fetcher: Fetcher
  readonly #wait: Wait
  readonly #timeoutMs: number
  readonly #openExternal?: (url: string) => Promise<void>
  #disposed = false
  #cache?: CachedRuns
  #currentRepository?: GitHubRepository
  #resolutionGeneration = 0
  readonly #flights = new Map<string | symbol, DeploymentFlight>()

  constructor(dependencies: DeploymentHistoryDependencies) {
    this.#workspace = dependencies.workspace
    this.#runner = dependencies.runner ?? createSystemBoundedCommandRunner()
    this.#fetcher = dependencies.fetcher ?? fetch
    this.#wait = dependencies.wait ?? defaultWait
    this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#openExternal = dependencies.openExternal
  }

  async git(request?: HistoryRequest): Promise<readonly GitCommit[]> {
    if (this.#disposed) gitFailure("发布历史服务已停止。")
    const controller = new AbortController()
    this.#controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    const limit = normalizedLimit(request)
    let settled: Promise<void> | undefined
    try {
      const execution = this.#runner.run({
        executable: "git",
        args: [
          "log",
          "-z",
          `--max-count=${limit}`,
          "--date=iso-strict",
          "--format=%H%x00%aI%x00%s%x00%an",
        ],
        cwd: this.#workspace,
        signal: controller.signal,
        maxOutputBytes: GIT_LOG_OUTPUT_LIMIT,
      })
      settled = execution.then(
        () => undefined,
        () => undefined,
      )
      this.#gitFlights.add(settled)
      const result = await execution
      if (result.exitCode !== 0) gitFailure("无法读取本地发布历史。")
      return parseGitLog(result.stdout, limit)
    } catch {
      gitFailure("无法读取本地发布历史。")
    } finally {
      clearTimeout(timer)
      this.#controllers.delete(controller)
      if (settled) this.#gitFlights.delete(settled)
    }
    throw new Error("unreachable")
  }

  deployments(request?: DeploymentHistoryRequest): Promise<DeploymentHistory> {
    const key = request?.requestId ?? anonymousFlight
    const existing = this.#flights.get(key)
    if (existing) return existing.promise
    if (this.#disposed)
      return Promise.reject({ code: "SERVICE_UNAVAILABLE", message: "发布历史服务已停止。" })
    const generation = ++this.#resolutionGeneration
    this.#currentRepository = undefined
    const controller = new AbortController()
    let timedOut = false
    let resolved: ResolvedRepository | undefined
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)
    const operation = this.#loadDeployments(
      normalizedLimit(request),
      controller.signal,
      (current) => {
        resolved = current
        if (this.#resolutionGeneration === generation)
          this.#currentRepository = current.repository
      },
    ).catch(() => {
      if (!resolved) throw { code: "GIT_STATUS_FAILED", message: "无法识别 GitHub 仓库。" }
      const cache = this.#cache
      return {
        runs: cache && cache.repositoryKey === resolved.repositoryKey ? cache.runs : [],
        ...resolved.links,
        unavailableMessage: this.#disposed
          ? "部署状态检查已停止。"
          : timedOut
            ? "部署状态检查超时，请通过下面的链接查看。"
            : "暂时无法读取部署状态，请通过下面的链接查看。",
      }
    })
    const tracked = operation.finally(() => {
      clearTimeout(timer)
      if (this.#flights.get(key)?.promise === tracked) this.#flights.delete(key)
    })
    this.#flights.set(key, { controller, promise: tracked })
    return tracked
  }

  async cancel(request: HistoryCancelRequest): Promise<void> {
    const flight = this.#flights.get(request.requestId)
    if (!flight) return
    flight.controller.abort()
    await flight.promise.catch(() => undefined)
  }

  async openLink(url: string): Promise<void> {
    if (this.#disposed || !this.#openExternal)
      throw { code: "SERVICE_UNAVAILABLE", message: "暂时无法打开外部链接。" }
    if (!this.#currentRepository || !isSafeHistoryUrl(url, this.#currentRepository))
      throw { code: "SERVICE_UNAVAILABLE", message: "这个历史链接不安全，已阻止打开。" }
    await this.#openExternal(url)
  }

  readonly #controllers = new Set<AbortController>()
  readonly #gitFlights = new Set<Promise<void>>()

  async #gitValue(args: readonly string[], signal: AbortSignal): Promise<string> {
    const result = await this.#runner.run({
      executable: "git",
      args,
      cwd: this.#workspace,
      signal,
      maxOutputBytes: GIT_VALUE_OUTPUT_LIMIT,
    })
    if (result.exitCode !== 0) gitFailure("无法识别 GitHub 仓库。")
    return result.stdout.trim()
  }

  async #loadDeployments(
    limit: number,
    signal: AbortSignal,
    onResolved: (repository: ResolvedRepository) => void,
  ): Promise<DeploymentHistory> {
    const remote = await this.#gitValue(["remote", "get-url", "origin"], signal)
    const repo = parseGitHubRemote(remote)
    const links = publicLinks(repo)
    const repositoryKey = `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
    onResolved({ repository: repo, repositoryKey, links })
    const headSha = await this.#gitValue(["rev-parse", "--verify", "HEAD"], signal)
    if (!SHA_PATTERN.test(headSha)) gitFailure("无法识别当前发布版本。")
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/workflows/deploy.yml/runs?per_page=${limit}`
    let elapsed = 0
    let poll = 0
    while (true) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }
      if (this.#cache?.repositoryKey === repositoryKey && this.#cache.etag)
        headers["If-None-Match"] = this.#cache.etag
      const response = await this.#fetcher(endpoint, { method: "GET", headers, signal })
      if (response.status === 403 || response.status === 429) {
        return {
          runs: this.#cache?.repositoryKey === repositoryKey ? this.#cache.runs : [],
          ...links,
          unavailableMessage: "暂时无法读取部署状态，请通过下面的链接查看。",
        }
      }
      if (response.status === 304) {
        if (!this.#cache || this.#cache.repositoryKey !== repositoryKey)
          throw new Error("invalid cache response")
      } else {
        if (!response.ok) throw new Error("deployment request failed")
        const runs = parseRuns(await boundedResponseText(response), limit, repo)
        this.#cache = {
          repositoryKey,
          runs,
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        }
      }
      const runs = this.#cache?.runs ?? []
      const matching = runs.find((run) => run.headSha === headSha)
      if (matching && isTerminal(matching.status)) return { runs, ...links }

      const delay = POLL_DELAYS[Math.min(poll, POLL_DELAYS.length - 1)]
      if (elapsed + delay > this.#timeoutMs) {
        return {
          runs,
          ...links,
          unavailableMessage: "部署状态仍在更新，请稍后重新读取。",
        }
      }
      await this.#wait(delay, signal)
      elapsed += delay
      poll += 1
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const controller of this.#controllers) controller.abort()
    for (const flight of this.#flights.values()) flight.controller.abort()
    await Promise.all([
      ...[...this.#flights.values()].map((flight) => flight.promise.catch(() => undefined)),
      ...[...this.#gitFlights].map((flight) => flight.catch(() => undefined)),
    ])
  }
}

export function createDeploymentHistoryService(
  dependencies: DeploymentHistoryDependencies,
): DeploymentHistoryService {
  return new DeploymentHistoryServiceImpl(dependencies)
}
