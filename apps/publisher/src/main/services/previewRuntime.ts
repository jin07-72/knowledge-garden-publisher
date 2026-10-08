import { execFile, spawn } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import {
  PreviewManager,
  createProcessTreeTerminator,
  type PortRequest,
  type PreviewDependencies,
  type PreviewProcess,
} from "./preview"

function pathIs(kind: "file" | "directory"): (path: string) => Promise<boolean> {
  return async (path) => {
    try {
      const details = await lstat(path)
      if (details.isSymbolicLink()) return false
      return kind === "file" ? details.isFile() : details.isDirectory()
    } catch {
      return false
    }
  }
}

async function allocatePort(request: PortRequest): Promise<number> {
  const candidates = request.preferredPort === undefined ? [0] : [request.preferredPort, 0]
  for (const port of candidates) {
    const selected = await new Promise<number | undefined>((resolve) => {
      const server = createServer()
      const finish = (value: number | undefined): void => {
        server.removeAllListeners()
        resolve(value)
      }
      server.once("error", () => finish(undefined))
      server.listen({ host: request.host, port, exclusive: true }, () => {
        const address = server.address()
        const selectedPort =
          typeof address === "object" && address !== null ? address.port : undefined
        server.close((error) => finish(error ? undefined : selectedPort))
      })
    })
    if (selected !== undefined && !request.exclude.includes(selected)) return selected
  }
  throw new Error("No loopback port available")
}

export async function isPreviewPortAvailable(port = 8080): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    const finish = (available: boolean): void => {
      server.removeAllListeners()
      resolve(available)
    }
    server.once("error", () => finish(false))
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(!error))
    })
  })
}

function probeTcp(port: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host: "127.0.0.1", port })
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      socket.destroy()
      resolve(ready)
    }
    const abort = (): void => finish(false)
    signal.addEventListener("abort", abort, { once: true })
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function runTaskkill(
  executable: "taskkill.exe",
  args: readonly string[],
  options: { readonly shell: false; readonly windowsHide: true },
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error) => (error ? reject(error) : resolve()))
  })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function createProductionProcessTreeTerminator(): ReturnType<
  typeof createProcessTreeTerminator
> {
  const platform = process.platform
  return createProcessTreeTerminator({
    platform,
    isAlive,
    signalGroup: (target, signal) => process.kill(target, signal),
    runTaskkill,
    wait,
    gracefulWaitMs: 1_500,
    forceWaitMs: 1_500,
  })
}

export function createProductionPreviewManager(runtimePath: string): PreviewManager {
  const platform = process.platform
  const terminate = createProductionProcessTreeTerminator()
  const dependencies: PreviewDependencies = {
    resolveWorkspace: (workspace) => realpath(workspace),
    isDirectory: pathIs("directory"),
    isFile: pathIs("file"),
    runtimePath: () => runtimePath,
    spawn: (executable, args, options) =>
      spawn(executable, [...args], options) as unknown as PreviewProcess,
    allocatePort,
    probe: async (url, signal) => {
      try {
        const response = await fetch(url, { method: "GET", signal, redirect: "error" })
        return response.ok
      } catch {
        return false
      }
    },
    probeWs: probeTcp,
    isPortAvailable: isPreviewPortAvailable,
    terminate,
    platform,
    safeEnvironment: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    },
  }
  return new PreviewManager(dependencies)
}
