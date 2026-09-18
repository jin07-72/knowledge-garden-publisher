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

export function runCommand(request: CommandRequest): Promise<CommandResult> {
  if (request.signal?.aborted) {
    return Promise.reject(cancelledError())
  }

  return new Promise<CommandResult>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let child
    try {
      child = spawn(request.executable, request.args, {
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
      child.kill()
      fail(cancelledError())
    }

    request.signal?.addEventListener("abort", cancel, { once: true })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", () => fail(new CommandRunnerError("COMMAND_FAILED", "Could not start command.")))
    child.on("close", (code) => {
      if (settled) return
      cleanup()
      if (code === null) {
        fail(new CommandRunnerError("COMMAND_FAILED", "Command did not return an exit code."))
        return
      }
      settled = true
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}

export const systemCommandRunner: CommandRunner = { run: runCommand }
