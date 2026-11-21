import type {
  AppearancePreviewController,
  AppearancePreviewNavigation,
} from "./appearancePreviewController"
import type {
  AppearanceFrameClearRequest,
  AppearanceFramePreviewRequest,
} from "./previewAppearance"

export interface AppearancePreviewNavigationFramePort {
  readonly detached: boolean
  readonly frameTreeNodeId: number
  readonly url: string
}

export interface AppearancePreviewWindowRuntimeHandle<WindowPort> {
  readonly window: WindowPort
  readonly controller: AppearancePreviewController
  dispose(): Promise<void>
}

export interface AppearancePreviewWindowRuntimeManager<WindowPort> {
  activate(window: WindowPort): AppearancePreviewWindowRuntimeHandle<WindowPort>
  dispose(runtime: AppearancePreviewWindowRuntimeHandle<WindowPort>): Promise<void>
  disposeCurrent(): Promise<void>
  install(request: AppearanceFramePreviewRequest): Promise<boolean>
  remove(request: AppearanceFrameClearRequest): Promise<boolean>
}

export function createAppearancePreviewWindowRuntimeManager<WindowPort>(options: {
  readonly createController: (window: WindowPort) => AppearancePreviewController
  readonly installNavigation: (
    window: WindowPort,
    controller: AppearancePreviewController,
  ) => () => void
  readonly isWindowUsable: (window: WindowPort) => boolean
  readonly onError?: (error: unknown) => void
}): AppearancePreviewWindowRuntimeManager<WindowPort> {
  let current: AppearancePreviewWindowRuntimeHandle<WindowPort> | undefined

  function usable(runtime: AppearancePreviewWindowRuntimeHandle<WindowPort>): boolean {
    try {
      return options.isWindowUsable(runtime.window)
    } catch {
      return false
    }
  }

  function createRuntime(window: WindowPort): AppearancePreviewWindowRuntimeHandle<WindowPort> {
    const controller = options.createController(window)
    const removeListeners = options.installNavigation(window, controller)
    let disposal: Promise<void> | undefined
    return {
      window,
      controller,
      dispose() {
        if (disposal) return disposal
        removeListeners()
        disposal = Promise.resolve().then(() => controller.dispose())
        return disposal
      },
    }
  }

  function dispose(runtime: AppearancePreviewWindowRuntimeHandle<WindowPort>): Promise<void> {
    if (current === runtime) current = undefined
    return runtime.dispose()
  }

  return {
    activate(window) {
      const previous = current
      const runtime = createRuntime(window)
      current = runtime
      if (previous) {
        void dispose(previous).catch((error: unknown) => options.onError?.(error))
      }
      return runtime
    },
    dispose,
    disposeCurrent() {
      const runtime = current
      return runtime ? dispose(runtime) : Promise.resolve()
    },
    install(request) {
      const runtime = current
      return runtime && usable(runtime)
        ? runtime.controller.install(request)
        : Promise.resolve(false)
    },
    remove(request) {
      const runtime = current
      return runtime && usable(runtime) ? runtime.controller.remove(request) : Promise.resolve(true)
    },
  }
}

export async function forwardAppearancePreviewNavigation(options: {
  readonly findFrame: () => AppearancePreviewNavigationFramePort | undefined
  readonly controller: Pick<AppearancePreviewController, "didNavigate">
  readonly url?: string
  readonly onError?: (error: unknown) => void
}): Promise<void> {
  let navigation: AppearancePreviewNavigation
  try {
    const frame = options.findFrame()
    if (!frame || frame.detached) return
    const frameTreeNodeId = frame.frameTreeNodeId
    const url = options.url ?? frame.url
    if (!Number.isSafeInteger(frameTreeNodeId) || typeof url !== "string") return
    navigation = { frameTreeNodeId, url, finished: true }
  } catch {
    return
  }
  try {
    await options.controller.didNavigate(navigation)
  } catch (error) {
    options.onError?.(error)
  }
}
