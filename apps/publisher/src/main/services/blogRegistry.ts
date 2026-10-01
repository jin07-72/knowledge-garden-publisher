import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { z } from "zod"

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

const identifierSchema = z.string().uuid()
const nameSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Invalid blog name")
const pathSchema = z.string().min(1).max(16_384).refine((value) => !value.includes("\u0000"), "Invalid path")
const timestampSchema = z.string().datetime({ offset: true })

const blogRecordSchema = z
  .object({
    id: identifierSchema,
    name: nameSchema,
    path: pathSchema,
    canonicalPath: pathSchema,
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

export function createBlogRegistry(options: {
  readonly file: string
  readonly legacyPath: string
  readonly now?: () => Date
  readonly uuid?: () => string
}): BlogRegistry {
  const now = options.now ?? (() => new Date())
  const uuid = options.uuid ?? randomUUID
  let operationQueue: Promise<void> = Promise.resolve()

  const timestamp = () => now().toISOString()

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function canonicalize(path: string): Promise<{ readonly path: string; readonly canonicalPath: string }> {
    return { path, canonicalPath: await realpath(path) }
  }

  async function persist(state: BlogRegistryState): Promise<void> {
    const directory = dirname(options.file)
    const temporary = join(directory, `.${basename(options.file)}.${randomUUID()}.tmp`)
    await mkdir(directory, { recursive: true })

    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
      await rename(temporary, options.file)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async function migrateLegacy(): Promise<BlogRegistryState> {
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
    await persist(migrated)
    return migrated
  }

  async function readState(): Promise<BlogRegistryState> {
    let source: string
    try {
      source = await readFile(options.file, "utf8")
    } catch (error) {
      if (isMissingFile(error)) return migrateLegacy()
      throw error
    }

    try {
      const parsed = registryStateSchema.safeParse(JSON.parse(source))
      if (!parsed.success) throw parsed.error
      return parsed.data
    } catch (error) {
      throw new BlogRegistryInvalidError(options.file, error)
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
      return runExclusive(async () => {
        const state = await readState()
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
        await persist(next)
        return next
      })
    },

    async rename(id, name) {
      return runExclusive(async () => {
        const state = await readState()
        const blog = await requireBlog(state, id)
        const next: BlogRegistryState = {
          ...state,
          blogs: state.blogs.map((candidate) => (candidate.id === blog.id ? { ...candidate, name: validName(name) } : candidate)),
        }
        await persist(next)
        return next
      })
    },

    async activate(id) {
      return runExclusive(async () => {
        const state = await readState()
        const blog = await requireBlog(state, id)
        const next: BlogRegistryState = {
          ...state,
          activeBlogId: blog.id,
          blogs: state.blogs.map((candidate) =>
            candidate.id === blog.id ? { ...candidate, lastOpenedAt: timestamp() } : candidate,
          ),
        }
        await persist(next)
        return next
      })
    },

    async remove(id) {
      return runExclusive(async () => {
        const state = await readState()
        const blog = await requireBlog(state, id)
        if (blog.id === state.activeBlogId) throw new Error("Cannot remove the active blog")

        const next: BlogRegistryState = {
          ...state,
          blogs: state.blogs.filter((candidate) => candidate.id !== blog.id),
        }
        await persist(next)
        return next
      })
    },

    async relocate(id, path) {
      return runExclusive(async () => {
        const state = await readState()
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
        await persist(next)
        return next
      })
    },
  }
}
