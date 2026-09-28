import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { inspectWorkspace, repairWorkspace } from "../../src/main/services/workspace"
import { App } from "../../src/renderer/src/App"
import { FirstRun } from "../../src/renderer/src/components/FirstRun"
import type { GardenApi, WorkspaceInspection } from "../../src/shared/contracts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "garden-first-run-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "content"))
  await mkdir(join(root, "private"))
  await mkdir(join(root, "scripts"))
  await writeFile(join(root, "package-lock.json"), "{}")
  await writeFile(join(root, "quartz.config.yaml"), "configuration: {}")
  await writeFile(join(root, "scripts", "validate-content.mjs"), "")
  return root
}

const diagnostics: WorkspaceInspection = {
  ok: false,
  root: "C:/garden",
  capabilities: { files: false, preview: false, git: false, publish: false },
  issues: [
    { code: "GIT_UNAVAILABLE", message: "Git is unavailable." },
    { code: "GIT_NOT_REPOSITORY", message: "Not a repository." },
    { code: "GIT_ORIGIN_MISSING", message: "Origin is missing." },
    { code: "GIT_FETCH_AUTH_FAILED", message: "Credentialed fetch failed." },
    {
      code: "DEPENDENCIES_MISSING",
      message: "Dependencies are missing.",
      repair: "install-dependencies",
    },
    { code: "PREVIEW_PORT_UNAVAILABLE", message: "Preview port is unavailable." },
  ],
}

describe("first-run diagnostics", () => {
  it("shows concrete, non-secret repair guidance for every startup boundary", () => {
    render(
      <FirstRun inspection={diagnostics} busy={false} onRetry={vi.fn()} onRepair={vi.fn()} />,
    )

    const region = screen.getByRole("region", { name: "启动检查" })
    expect(within(region).getByText(/安装 Git/)).toBeVisible()
    expect(within(region).getByText(/Git 仓库/)).toBeVisible()
    expect(within(region).getByText(/origin/)).toBeVisible()
    expect(within(region).getByText(/Windows 凭据管理器/)).toBeVisible()
    expect(within(region).getByText(/关闭占用预览端口/)).toBeVisible()
    expect(region).not.toHaveTextContent(/粘贴.*token|输入.*令牌/i)
  })

  it("runs dependency installation only after the explicit repair button is pressed", async () => {
    const user = userEvent.setup()
    const onRepair = vi.fn(async () => undefined)
    render(
      <FirstRun inspection={diagnostics} busy={false} onRetry={vi.fn()} onRepair={onRepair} />,
    )

    expect(onRepair).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "安装仓库依赖" }))
    expect(onRepair).toHaveBeenCalledWith("install-dependencies")
  })

  it("checks dependencies, credentialed origin/main access, and the preview port", async () => {
    const root = await repository()
    const runner = { run: vi.fn(async ({ args }: { args: readonly string[] }) => {
      if (args.includes("--show-toplevel")) return { exitCode: 0, stdout: root, stderr: "" }
      if (args[0] === "remote" && args.length === 1) return { exitCode: 0, stdout: "origin\n", stderr: "" }
      if (args.includes("get-url")) return { exitCode: 0, stdout: "https://github.com/a/b.git\n", stderr: "" }
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" }
      if (args[0] === "ls-remote") return { exitCode: 128, stdout: "", stderr: "Authentication failed" }
      if (args.includes("ls")) return { exitCode: 1, stdout: "", stderr: "missing" }
      throw new Error(`unexpected ${args.join(" ")}`)
    }) }

    const inspection = await inspectWorkspace(root, {
      checkGit: true,
      runner,
      runtime: { nodePath: "bundled-node.exe", npmCliPath: "bundled-npm-cli.js" },
      previewPortAvailable: async () => false,
      checkRemote: true,
    })
    expect(inspection.ok).toBe(false)
    if (inspection.ok) throw new Error("expected startup issues")
    expect(inspection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DEPENDENCIES_MISSING", repair: "install-dependencies" }),
      expect.objectContaining({ code: "GIT_FETCH_AUTH_FAILED" }),
      expect.objectContaining({ code: "PREVIEW_PORT_UNAVAILABLE" }),
    ]))
  })

  it("repairs dependencies only through the injected bundled Node/npm runtime", async () => {
    const root = await repository()
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    await expect(repairWorkspace(root, { action: "install-dependencies" }, {
      runner: { run },
      runtime: { nodePath: "C:/app/node/node.exe", npmCliPath: "C:/app/node/npm-cli.js" },
    })).resolves.toEqual({ action: "install-dependencies", message: expect.stringContaining("installed") })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "C:/app/node/node.exe",
      args: ["C:/app/node/npm-cli.js", "ci", "--no-audit", "--no-fund"],
      cwd: root,
    }))
  })

  it("rejects a semver-compatible installed tree whose hidden lock differs from package-lock", async () => {
    const root = await repository()
    await mkdir(join(root, "node_modules"))
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/example": { version: "1.2.3" } } }),
    )
    await writeFile(
      join(root, "node_modules", ".package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/example": { version: "1.2.4" } } }),
    )
    const runner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })) }

    const inspection = await inspectWorkspace(root, {
      checkGit: false,
      runner,
      runtime: { nodePath: "bundled-node.exe", npmCliPath: "bundled-npm-cli.js" },
    })

    expect(inspection.ok).toBe(false)
    if (inspection.ok) throw new Error("expected dependency mismatch")
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      code: "DEPENDENCIES_INVALID",
      repair: "install-dependencies",
    }))
  })

  it("gates production renderer operations behind the startup inspection", async () => {
    const inspect = vi.fn(async () => ({ ok: true as const, value: diagnostics }))
    const list = vi.fn()
    Object.defineProperty(window, "garden", {
      configurable: true,
      value: { workspace: { inspect, repair: vi.fn() }, notes: { list } } as unknown as GardenApi,
    })

    render(<App />)

    expect(await screen.findByRole("region", { name: "启动检查" })).toBeVisible()
    expect(inspect).toHaveBeenCalledOnce()
    expect(list).not.toHaveBeenCalled()
  })
})
