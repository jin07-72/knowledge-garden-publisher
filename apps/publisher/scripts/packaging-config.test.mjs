// @vitest-environment node
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import YAML from "yaml"

const publisherRoot = resolve(import.meta.dirname, "..")

describe("Windows packaging configuration", () => {
  it("builds a per-user assisted NSIS installer with the verified runtime", async () => {
    const config = YAML.parse(
      await readFile(resolve(publisherRoot, "electron-builder.yml"), "utf8"),
    )
    expect(config.appId).toBe("io.github.jin07-72.knowledge-garden-publisher")
    expect(config.icon).toBe("../../quartz/static/icon.png")
    expect(config.directories.output).toBe("release")
    expect(config.nsis).toMatchObject({
      perMachine: false,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    })
    expect(config.extraResources).toContainEqual(
      expect.objectContaining({
        from: "vendor/node",
        to: "node",
        filter: ["**/*", "!node_modules{,/**/*}"],
      }),
    )
    expect(config.extraResources).toContainEqual(
      expect.objectContaining({
        from: "vendor/node/node_modules",
        to: "node/node_modules",
        filter: ["**/*"],
      }),
    )
  })

  it("keeps generated runtimes and installers out of version control", async () => {
    const ignore = await readFile(resolve(publisherRoot, "../../.gitignore"), "utf8")
    expect(ignore).toContain("apps/publisher/vendor/node/")
    expect(ignore).toContain("apps/publisher/release/")
  })
})
