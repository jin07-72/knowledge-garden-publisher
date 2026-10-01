import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import type { BlogRecord, BlogRegistryView } from "../../shared/contracts"

export type { BlogRecord } from "../../shared/contracts"
export type BlogRegistryState = BlogRegistryView

export interface BlogRegistry {
  load(): Promise<BlogRegistryState>
  add(input: { readonly name: string; readonly path: string }): Promise<BlogRegistryState>
  rename(id: string, name: string): Promise<BlogRegistryState>
  activate(id: string): Promise<BlogRegistryState>
  remove(id: string): Promise<BlogRegistryState>
  relocate(id: string, path: string): Promise<BlogRegistryState>
}

const identifierSchema = z.string().uuid()
const nameSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Invalid blog name")
const pathSchema = z.string().min(1).max(16_384).refine((value) => !value.includes("\u0000"), "Invalid path")
const timestampSchema = z.string().datetime({ offset: true })
const leaseSchema = z
  .object({
    version: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    expiresAt: z.number().finite(),
  })
  .strict()

interface RegistryFileHandle {
  writeFile(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

interface RegistryFileSystem {
  readonly open?: (path: string, flags: "r" | "wx", mode?: number) => Promise<RegistryFileHandle>
  readonly rename?: (source: string, destination: string) => Promise<void>
}

type RegistryOpen = NonNullable<RegistryFileSystem["open"]>

const registryFileQueues = new Map<string, Promise<void>>()
const registryLeaseMs = 1_000
const registryLeaseWaitMs = 10_000

const blogRecordSchema = z
  .object({
    id: identifierSchema,
    name: nameSchema,
    path: pathSchema,
    canonicalPath: pathSchema.refine(isAbsolute, "Canonical path must be absolute"),
    createdAt: timestampSchema,
    lastOpenedAt: timestampSchema,
  })
  .strict()

const registryStateSchema = z
  .object({
    version: z.literal(1),
    activeBlogId: identifierSchema,
    blogs: z.array(blogRecordSchema).min(1),
  })
  .strict()
  .superRefine((state, context) => {
    if (!state.blogs.some((blog) => blog.id === state.activeBlogId)) {
      context.addIssue({ code: "custom", message: "Active blog is not registered" })
    }

    const ids = new Set<string>()
    const paths = new Set<string>()
    for (const blog of state.blogs) {
      if (ids.has(blog.id)) {
        context.addIssue({ code: "custom", message: "Duplicate blog id" })
      }
      ids.add(blog.id)

      const key = canonicalKey(blog.canonicalPath)
      if (paths.has(key)) {
        context.addIssue({ code: "custom", message: "Duplicate canonical blog path" })
      }
      paths.add(key)
    }
  })

class BlogRegistryInvalidError extends Error {
  readonly code = "BLOG_REGISTRY_INVALID"

  constructor(readonly path: string, cause: unknown) {
    super(`Blog registry is invalid: ${path}`, { cause })
    this.name = "BlogRegistryInvalidError"
  }
}

function canonicalKey(path: string): string {
  return path.toLocaleLowerCase("en-US")
}

function validName(name: string): string {
  const parsed = nameSchema.safeParse(name)
  if (!parsed.success) throw new Error("Invalid blog name")
  return name.trim()
}

function validIdentifier(id: string): string {
  const parsed = identifierSchema.safeParse(id)
  if (!parsed.success) throw new Error("Invalid blog id")
  return id
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function isUnavailablePath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

function registryFileKey(file: string): string {
  return resolve(file).toLocaleLowerCase("en-US")
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function cleanupStaleArtifacts(file: string): Promise<void> {
  const directory = dirname(file)
  const filename = escapedPattern(basename(file))
  const artifact = new RegExp(
    `^\\.${filename}(?:\\.lock(?:\\.reclaim)?\\.candidate-[0-9a-f-]{36}|\\.[0-9a-f-]{36}\\.tmp)$`,
    "i",
  )
  const staleBefore = Date.now() - registryLeaseMs

  for (const name of await readdir(directory)) {
    if (!artifact.test(name)) continue
    const path = join(directory, name)
    try {
      const details = await lstat(path)
      if (details.isFile() && details.mtimeMs <= staleBefore) await unlink(path)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }
}

async function canonicalRegistryFile(file: string): Promise<string> {
  const absolute = resolve(file)
  try {
    return await realpath(absolute)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const directory = dirname(absolute)
  await mkdir(directory, { recursive: true })
  return join(await realpath(directory), basename(absolute))
}

function runForRegistryFile<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = registryFileKey(file)
  const previous = registryFileQueues.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  registryFileQueues.set(key, tail)
  void tail.then(() => {
    if (registryFileQueues.get(key) === tail) registryFileQueues.delete(key)
  })
  return result
}

async function syncDirectory(directory: string, openFile: RegistryOpen = open): Promise<void> {
  let handle: RegistryFileHandle | undefined
  try {
    handle = await openFile(directory, "r")
    await handle.sync()
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function lockIsStale(lock: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(lock, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }

  try {
    const lease = leaseSchema.safeParse(JSON.parse(source))
    if (lease.success) return Date.now() >= lease.data.expiresAt && !isProcessAlive(lease.data.pid)
  } catch {
    // Leases are published only after their candidate file is fully synced. An
    // unrecognized lock is therefore never reclaimed by this registry.
  }
  return false
}

async function hasReclaimClaim(claim: string): Promise<boolean> {
  try {
    await readFile(claim, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }

  if (!await lockIsStale(claim)) return true
  await unlink(claim).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  return false
}

async function createLease(lock: string, openFile: RegistryOpen): Promise<string> {
  const token = randomUUID()
  const candidate = `${lock}.candidate-${token}`
  let handle: RegistryFileHandle | undefined
  let createdCandidate = false
  try {
    handle = await openFile(candidate, "wx", 0o600)
    createdCandidate = true
    await handle.writeFile(
      JSON.stringify({ version: 1, token, pid: process.pid, expiresAt: Date.now() + registryLeaseMs }),
    )
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(candidate, lock)
    return token
  } catch (error) {
    await handle?.close().catch(() => undefined)
    throw error
  } finally {
    if (createdCandidate) await unlink(candidate).catch(() => undefined)
  }
}

async function acquireLease(file: string, openFile: RegistryOpen): Promise<{ readonly lock: string; readonly token: string }> {
  const directory = dirname(file)
  const lock = join(directory, `.${basename(file)}.lock`)
  const reclaim = `${lock}.reclaim`
  const deadline = Date.now() + registryLeaseWaitMs
  await mkdir(directory, { recursive: true })

  for (;;) {
    if (await hasReclaimClaim(reclaim)) {
      if (Date.now() >= deadline) throw new Error("Blog registry is locked")
      await delay(10)
      continue
    }

    try {
      return { lock, token: await createLease(lock, openFile) }
    } catch (error) {
      if (isMissingFile(error)) {
        if (Date.now() >= deadline) throw new Error("Blog registry is locked")
        await mkdir(directory, { recursive: true })
        await delay(10)
        continue
      }
      if (!isAlreadyExists(error)) throw error
    }

    if (!(await lockIsStale(lock))) {
      if (Date.now() >= deadline) throw new Error("Blog registry is locked")
      await delay(10)
      continue
    }

    let reclaimToken: string | undefined
    let claimed = false
    try {
      reclaimToken = await createLease(reclaim, openFile)
      claimed = true
      if (await lockIsStale(lock)) await unlink(lock)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    } finally {
      if (claimed) await releaseLease(reclaim, reclaimToken!)
    }
  }
}

async function releaseLease(lock: string, token: string): Promise<void> {
  try {
    const lease = leaseSchema.safeParse(JSON.parse(await readFile(lock, "utf8")))
    if (lease.success && lease.data.token === token) await unlink(lock)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

export function createBlogRegistry(options: {
  readonly file: string
  readonly legacyPath: string
  readonly now?: () => Date
  readonly uuid?: () => string
  readonly fileSystem?: RegistryFileSystem
}): BlogRegistry {
  const now = options.now ?? (() => new Date())
  const uuid = options.uuid ?? randomUUID
  const openFile = options.fileSystem?.open ?? open
  const renameFile = options.fileSystem?.rename ?? rename

  const timestamp = () => now().toISOString()

  function runExclusive<T>(operation: (file: string) => Promise<T>): Promise<T> {
    return canonicalRegistryFile(options.file).then((file) => runForRegistryFile(file, async () => {
      const lease = await acquireLease(file, openFile)
      try {
        await cleanupStaleArtifacts(file)
        return await operation(file)
      } finally {
        await releaseLease(lease.lock, lease.token)
      }
    }))
  }

  async function canonicalize(path: string): Promise<{ readonly path: string; readonly canonicalPath: string }> {
    return { path, canonicalPath: await realpath(path) }
  }

  async function persist(file: string, state: BlogRegistryState): Promise<void> {
    const directory = dirname(file)
    const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`)
    await mkdir(directory, { recursive: true })
    let handle: RegistryFileHandle | undefined
    let createdTemporary = false
    let published = false

    try {
      handle = await openFile(temporary, "wx", 0o600)
      createdTemporary = true
      await handle.writeFile(JSON.stringify(state))
      await handle.sync()
      await handle.close()
      handle = undefined
      await renameFile(temporary, file)
      published = true
      await syncDirectory(directory, openFile)
    } finally {
      await handle?.close().catch(() => undefined)
      if (createdTemporary && !published) await unlink(temporary).catch(() => undefined)
    }
  }

  async function migrateLegacy(file: string): Promise<BlogRegistryState> {
    const location = await canonicalize(options.legacyPath)
    const createdAt = timestamp()
    const id = validIdentifier(uuid())
    const migrated: BlogRegistryState = {
      version: 1,
      activeBlogId: id,
      blogs: [
        {
          id,
          name: basename(location.path) || "Knowledge Garden",
          path: location.path,
          canonicalPath: location.canonicalPath,
          createdAt,
          lastOpenedAt: createdAt,
        },
      ],
    }
    await persist(file, migrated)
    return migrated
  }

  async function readState(file: string): Promise<BlogRegistryState> {
    let source: string
    try {
      source = await readFile(file, "utf8")
    } catch (error) {
      if (isMissingFile(error)) return migrateLegacy(file)
      throw error
    }

    try {
      const parsed = registryStateSchema.safeParse(JSON.parse(source))
      if (!parsed.success) throw parsed.error
      await Promise.all(
        parsed.data.blogs.map(async (blog) => {
          // `path` is display-only and may be relative. An available absolute
          // display path is nevertheless strong evidence that its canonical
          // locator must still resolve to the same workspace.
          const displayTarget = isAbsolute(blog.path)
            ? await realpath(blog.path).catch((error: unknown) => {
                if (isUnavailablePath(error)) return undefined
                throw error
              })
            : undefined
          const canonicalTarget = await realpath(blog.canonicalPath).catch((error: unknown) => {
            if (isUnavailablePath(error)) return undefined
            throw error
          })
          if (displayTarget !== undefined && canonicalTarget === undefined)
            throw new Error("Stored canonical path is unavailable while display path exists")
          if (canonicalTarget !== undefined && canonicalKey(canonicalTarget) !== canonicalKey(blog.canonicalPath))
            throw new Error("Stored canonical path does not match its target")
          if (displayTarget !== undefined && canonicalKey(displayTarget) !== canonicalKey(canonicalTarget!))
            throw new Error("Stored canonical path does not match display path")
        }),
      )
      return parsed.data
    } catch (error) {
      throw new BlogRegistryInvalidError(file, error)
    }
  }

  async function requireBlog(state: BlogRegistryState, id: string): Promise<BlogRecord> {
    const safeId = validIdentifier(id)
    const blog = state.blogs.find((candidate) => candidate.id === safeId)
    if (!blog) throw new Error("Blog is not registered")
    return blog
  }

  return {
    load: () => runExclusive(readState),

    async add(input) {
      return runExclusive(async (file) => {
        const state = await readState(file)
        const name = validName(input.name)
        const location = await canonicalize(input.path)
        if (state.blogs.some((blog) => canonicalKey(blog.canonicalPath) === canonicalKey(location.canonicalPath))) {
          return state
        }

        const createdAt = timestamp()
        const id = validIdentifier(uuid())
        if (state.blogs.some((blog) => blog.id === id)) {
          throw new Error("Generated blog id collision")
        }
        const added: BlogRecord = {
          id,
          name,
          path: location.path,
          canonicalPath: location.canonicalPath,
          createdAt,
          lastOpenedAt: createdAt,
        }
        const next: BlogRegistryState = { ...state, blogs: [...state.blogs, added] }
        await persist(file, next)
        return next
      })
    },

    async rename(id, name) {
      return runExclusive(async (file) => {
        const state = await readState(file)
        const blog = await requireBlog(state, id)
        const next: BlogRegistryState = {
          ...state,
          blogs: state.blogs.map((candidate) => (candidate.id === blog.id ? { ...candidate, name: validName(name) } : candidate)),
        }
        await persist(file, next)
        return next
      })
    },

    async activate(id) {
      return runExclusive(async (file) => {
        const state = await readState(file)
        const blog = await requireBlog(state, id)
        const next: BlogRegistryState = {
          ...state,
          activeBlogId: blog.id,
          blogs: state.blogs.map((candidate) =>
            candidate.id === blog.id ? { ...candidate, lastOpenedAt: timestamp() } : candidate,
          ),
        }
        await persist(file, next)
        return next
      })
    },

    async remove(id) {
      return runExclusive(async (file) => {
        const state = await readState(file)
        const blog = await requireBlog(state, id)
        if (blog.id === state.activeBlogId) throw new Error("Cannot remove the active blog")

        const next: BlogRegistryState = {
          ...state,
          blogs: state.blogs.filter((candidate) => candidate.id !== blog.id),
        }
        await persist(file, next)
        return next
      })
    },

    async relocate(id, path) {
      return runExclusive(async (file) => {
        const state = await readState(file)
        const blog = await requireBlog(state, id)
        const location = await canonicalize(path)
        if (
          state.blogs.some(
            (candidate) =>
              candidate.id !== blog.id && canonicalKey(candidate.canonicalPath) === canonicalKey(location.canonicalPath),
          )
        ) {
          throw new Error("Workspace path is already registered")
        }

        const next: BlogRegistryState = {
          ...state,
          blogs: state.blogs.map((candidate) =>
            candidate.id === blog.id ? { ...candidate, ...location } : candidate,
          ),
        }
        await persist(file, next)
        return next
      })
    },
  }
}
