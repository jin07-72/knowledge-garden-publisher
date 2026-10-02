import { isAbsolute, join, resolve } from "node:path"
import { parseGitHubRepositoryUrl } from "../shared/contracts"
import type {
  BlogCloneRequest,
  BlogAddLocalRequest,
  BlogCandidateInspection,
  BlogIdRequest,
  BlogImportProgress,
  BlogImportReceipt,
  BlogPathRequest,
  BlogRecord,
  BlogRegistryView,
  BlogRegistryStatus,
  BlogRelocateRequest,
  BlogRenameRequest,
  BlogSwitchRequest,
} from "../shared/contracts"
import type { BlogRegistry } from "./services/blogRegistry"
import { BlogImportError, type BlogImportService } from "./services/blogImport"

export interface BlogRuntime {
  active(): Promise<BlogRecord>
  switchTo(request: { readonly id: string; readonly editorSaved: true }): Promise<void>
}

export interface BlogRuntimeRegistry {
  load(): Promise<BlogRegistryView>
  activate(id: string): Promise<BlogRegistryView>
}

export interface BlogRuntimeDependencies {
  readonly registry: BlogRuntimeRegistry
  readonly inspect: (path: string) => Promise<BlogCandidateInspection>
  readonly assertIdle: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly relaunch: () => void
  readonly quit: () => void
}

function unavailable(): Error & { readonly code: "BLOG_WORKSPACE_UNAVAILABLE" } {
  return Object.assign(new Error("The selected blog workspace is unavailable."), {
    code: "BLOG_WORKSPACE_UNAVAILABLE" as const,
  })
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right
}

async function validate(
  record: BlogRecord,
  inspect: BlogRuntimeDependencies["inspect"],
): Promise<BlogRecord> {
  let inspection: BlogCandidateInspection
  try {
    inspection = await inspect(record.canonicalPath)
  } catch {
    throw unavailable()
  }
  if (
    !inspection.valid ||
    !samePath(resolve(inspection.canonicalPath), resolve(record.canonicalPath))
  ) {
    throw unavailable()
  }
  return record
}

export function createBlogRuntime(dependencies: BlogRuntimeDependencies): BlogRuntime {
  let switchFlight: Promise<void> | undefined

  const terminate = (): void => {
    let failure: { readonly error: unknown } | undefined
    try {
      try {
        dependencies.relaunch()
      } catch (error) {
        failure = { error }
      }
    } finally {
      try {
        dependencies.quit()
      } catch (error) {
        failure ??= { error }
      }
    }
    if (failure) throw failure.error
  }

  const active = async (): Promise<BlogRecord> => {
    const state = await dependencies.registry.load()
    const record = state.blogs.find((blog) => blog.id === state.activeBlogId)
    if (!record) throw unavailable()
    return validate(record, dependencies.inspect)
  }

  return {
    active,
    switchTo(request) {
      if (request.editorSaved !== true) {
        return Promise.reject(
          Object.assign(new Error("Save the editor before switching blogs."), {
            code: "BLOG_EDITOR_UNSAVED" as const,
          }),
        )
      }
      if (switchFlight) return switchFlight
      const operation = (async () => {
        const state = await dependencies.registry.load()
        const target = state.blogs.find((blog) => blog.id === request.id)
        if (!target) throw unavailable()
        await validate(target, dependencies.inspect)
        await dependencies.assertIdle()
        await dependencies.dispose()
        try {
          await dependencies.registry.activate(target.id)
        } catch (error) {
          try {
            terminate()
          } catch {
            // Activation is the primary failure; terminal failures must not conceal it.
          }
          throw error
        }
        terminate()
      })()
      switchFlight = operation.finally(() => {
        if (switchFlight === tracked) switchFlight = undefined
      })
      const tracked = switchFlight
      return switchFlight
    },
  }
}

export function resolveBlogRegistryFile(options: {
  readonly isPackaged: boolean
  readonly e2e: boolean
  readonly userDataPath: string
  readonly override?: string
}): string {
  if (!options.isPackaged && options.e2e && options.override && isAbsolute(options.override)) {
    return resolve(options.override)
  }
  return join(options.userDataPath, "blogs.json")
}

export interface BlogManagementServices {
  list(): Promise<BlogRegistryStatus>
  chooseLocal(): Promise<
    { readonly path: string; readonly inspection: BlogCandidateInspection } | undefined
  >
  addLocal(request: BlogAddLocalRequest): Promise<BlogRegistryView>
  recoverLocal(request: BlogAddLocalRequest): Promise<BlogRegistryView>
  clone(request: BlogCloneRequest): Promise<BlogImportReceipt>
  cancelImport(): Promise<void>
  install(request: BlogPathRequest): Promise<BlogCandidateInspection>
  rename(request: BlogRenameRequest): Promise<BlogRegistryView>
  relocate(request: BlogRelocateRequest): Promise<BlogRegistryView>
  remove(request: BlogIdRequest): Promise<BlogRegistryView>
  openFolder(request: BlogIdRequest): Promise<void>
  switch(request: BlogSwitchRequest): Promise<void>
  subscribeProgress(listener: (progress: BlogImportProgress) => void): () => void
}

export interface BlogManagementAdapter {
  readonly services: BlogManagementServices
  readonly emitProgress: (progress: BlogImportProgress) => void
  readonly prepareForShutdown: () => Promise<void>
  readonly restoreAfterFailedShutdown: () => void
}

export function createBlogManagementAdapter(dependencies: {
  readonly registry: BlogRegistry
  readonly importer: BlogImportService | (() => BlogImportService)
  readonly inspect: (path: string) => Promise<BlogCandidateInspection>
  readonly chooseDirectory: () => Promise<string | undefined>
  readonly openFolder: (path: string) => Promise<void>
  readonly switchTo: (request: { readonly id: string; readonly editorSaved: true }) => Promise<void>
}): BlogManagementAdapter {
  const listeners = new Set<(progress: BlogImportProgress) => void>()
  let activeImport:
    | {
        readonly controller: AbortController
        readonly result: Promise<unknown>
        readonly settled: Promise<void>
      }
    | undefined
  let importsOpen = true
  let terminationUncertain: BlogImportError | undefined
  const importer = (): BlogImportService =>
    typeof dependencies.importer === "function" ? dependencies.importer() : dependencies.importer
  const validWorkspace = async (
    path: string,
  ): Promise<Extract<BlogCandidateInspection, { valid: true }>> => {
    const inspection = await dependencies.inspect(path)
    if (!inspection.valid) {
      throw new BlogImportError("VALIDATION_FAILED", "The selected blog could not be validated.")
    }
    return inspection
  }
  const normalizedClone = (request: BlogCloneRequest): Required<BlogCloneRequest> => {
    const repository = parseGitHubRepositoryUrl(request.url)
    if (!repository) {
      throw new BlogImportError("INVALID_REPOSITORY_URL", "The repository URL is invalid.")
    }
    const requestedName = request.name?.trim() ?? ""
    if (requestedName.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(requestedName)) {
      throw new BlogImportError("VALIDATION_FAILED", "The blog display name is invalid.")
    }
    const name = requestedName || repository.repository.slice(0, 80)
    if (!name) {
      throw new BlogImportError("VALIDATION_FAILED", "The blog display name is invalid.")
    }
    return { ...request, name }
  }
  const runImport = <T>(
    operation: (service: BlogImportService, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!importsOpen) {
      return Promise.reject(
        new BlogImportError(
          "IMPORT_UNAVAILABLE",
          "Blog imports are unavailable while the app is closing.",
        ),
      )
    }
    if (activeImport) {
      return Promise.reject(
        new BlogImportError("IMPORT_ACTIVE", "Another blog import is already running."),
      )
    }
    const controller = new AbortController()
    const result = Promise.resolve().then(() => operation(importer(), controller.signal))
    const settled = result.then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof BlogImportError && error.code === "IMPORT_UNAVAILABLE") {
          terminationUncertain ??= error
        }
      },
    )
    activeImport = { controller, result, settled }
    void settled.then(() => {
      if (activeImport?.controller === controller) activeImport = undefined
    })
    return result
  }

  return {
    async prepareForShutdown() {
      importsOpen = false
      if (terminationUncertain) throw terminationUncertain
      const current = activeImport
      if (!current) return
      current.controller.abort()
      try {
        await current.result
      } catch (error) {
        if (error instanceof BlogImportError && error.code === "IMPORT_UNAVAILABLE") {
          terminationUncertain = error
          throw error
        }
        // All other outcomes settled after the importer confirmed that its child process stopped.
      }
    },
    restoreAfterFailedShutdown() {
      if (terminationUncertain === undefined) importsOpen = true
    },
    emitProgress(progress) {
      for (const listener of listeners) listener(progress)
    },
    services: {
      async list() {
        const state = await dependencies.registry.load()
        const active = state.blogs.find((blog) => blog.id === state.activeBlogId)
        let available = false
        if (active) {
          try {
            const inspection = await dependencies.inspect(active.canonicalPath)
            available =
              inspection.valid &&
              samePath(resolve(inspection.canonicalPath), resolve(active.canonicalPath))
          } catch {
            // Availability is intentionally coarse; inspection errors never cross the IPC boundary.
          }
        }
        return { ...state, activeAvailability: available ? "available" : "unavailable" }
      },
      async chooseLocal() {
        const path = await dependencies.chooseDirectory()
        if (!path) return undefined
        return { path, inspection: await dependencies.inspect(path) }
      },
      async addLocal(request) {
        await validWorkspace(request.path)
        return dependencies.registry.add(request)
      },
      async recoverLocal(request) {
        await validWorkspace(request.path)
        return dependencies.registry.recover(request)
      },
      clone: (request) =>
        runImport(async (service, signal) => {
          const normalized = normalizedClone(request)
          const receipt = await service.clone(normalized, signal)
          await dependencies.registry.add({ name: normalized.name, path: receipt.canonicalPath })
          return receipt
        }),
      async cancelImport() {
        const current = activeImport
        current?.controller.abort()
        await current?.settled
      },
      install: (request) => runImport((service, signal) => service.install(request.path, signal)),
      rename: (request) => dependencies.registry.rename(request.id, request.name),
      async relocate(request) {
        await validWorkspace(request.path)
        return dependencies.registry.relocate(request.id, request.path)
      },
      remove: (request) => dependencies.registry.remove(request.id),
      async openFolder(request) {
        const state = await dependencies.registry.load()
        const blog = state.blogs.find((candidate) => candidate.id === request.id)
        if (!blog) throw new Error("Blog is not registered")
        await dependencies.openFolder(blog.canonicalPath)
      },
      switch: (request) => dependencies.switchTo(request),
      subscribeProgress(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}
