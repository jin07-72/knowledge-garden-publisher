import { spawn } from "node:child_process"

export interface CommandRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>
}

export interface CommandProcess {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill(): boolean
  on(event: "error", listener: () => void): this
  on(event: "close", listener: (code: number | null) => void): this
}

export type CommandSpawner = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    shell: false
    windowsHide: boolean
  }
) => CommandProcess

export class CommandRunnerError extends Error {
  readonly name = "CommandRunnerError"

  constructor(
    readonly code: "COMMAND_FAILED" | "COMMAND_CANCELLED",
    message: string
  ) {
    super(message)
  }
}

function cancelledError(): CommandRunnerError {
  return new CommandRunnerError("COMMAND_CANCELLED", "Command was cancelled.")
}

function commandSpawner(
  executable: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2]
): CommandProcess {
  return spawn(executable, args, options)
}

export function createCommandRunner(spawner: CommandSpawner = commandSpawner): CommandRunner {
  return {
    run(request: CommandRequest): Promise<CommandResult> {
      if (request.signal?.aborted) {
        return Promise.reject(cancelledError())
      }

      return new Promise<CommandResult>((resolve, reject) => {
        let stdout = ""
        let stderr = ""
        let settled = false
        let cancellationRequested = false
        let child: CommandProcess
        try {
          child = spawner(request.executable, request.args, {
            cwd: request.cwd,
            env: { ...process.env, ...request.env },
            shell: false,
            windowsHide: true
          })
        } catch {
          reject(new CommandRunnerError("COMMAND_FAILED", "Could not start command."))
          return
        }

        const cleanup = (): void => request.signal?.removeEventListener("abort", cancel)
        const fail = (error: CommandRunnerError): void => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
        const cancel = (): void => {
          if (settled || cancellationRequested) return
          cancellationRequested = true
          try {
            // This runner owns only the direct child; process-tree termination belongs to Task 6.
            if (!child.kill()) {
              fail(new CommandRunnerError("COMMAND_FAILED", "Command could not be terminated."))
            }
          } catch {
            fail(new CommandRunnerError("COMMAND_FAILED", "Command could not be terminated."))
          }
        }

        request.signal?.addEventListener("abort", cancel, { once: true })
        const childStdout = child.stdout
        const childStderr = child.stderr
        if (!childStdout || !childStderr) {
          fail(new CommandRunnerError("COMMAND_FAILED", "Command streams were unavailable."))
          return
        }
        childStdout.setEncoding("utf8")
        childStderr.setEncoding("utf8")
        childStdout.on("data", (chunk: string) => {
          stdout += chunk
        })
        childStderr.on("data", (chunk: string) => {
          stderr += chunk
        })
        child.on("error", () => {
          fail(cancellationRequested ? cancelledError() : new CommandRunnerError("COMMAND_FAILED", "Could not start command."))
        })
        child.on("close", (code) => {
          if (settled) return
          if (cancellationRequested) {
            fail(cancelledError())
            return
          }
          if (code === null) {
            fail(new CommandRunnerError("COMMAND_FAILED", "Command did not return an exit code."))
            return
          }
          settled = true
          cleanup()
          resolve({ exitCode: code, stdout, stderr })
        })
      })
    }
  }
}

export const systemCommandRunner = createCommandRunner()

export function runCommand(request: CommandRequest): Promise<CommandResult> {
  return systemCommandRunner.run(request)
}
