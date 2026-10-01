// @vitest-environment node
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertSafeArchiveEntries,
  createExtractionRequest,
  downloadNodeRuntime,
  EXPECTED_NODE_ARCHIVE_SHA256,
  NODE_ARCHIVE,
  NODE_VERSION,
  parseExpectedChecksum,
  RUNTIME_MANIFEST,
  runtimeTreeSha256,
  verifySha256,
} from "./download-node-runtime.mjs"

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function runtimeFixture({
  version = NODE_VERSION,
  tamper = false,
  tamperDependency = false,
  forgeManifest = false,
} = {}) {
  const publisherRoot = await mkdtemp(join(tmpdir(), "node-runtime-reuse-"))
  temporaryDirectories.push(publisherRoot)
  const runtime = join(publisherRoot, "vendor", "node")
  const nodePath = join(runtime, "node.exe")
  const npmPath = join(runtime, "node_modules", "npm", "bin", "npm-cli.js")
  const dependencyPath = join(runtime, "node_modules", "npm", "node_modules", "example", "index.js")
  await mkdir(dirname(npmPath), { recursive: true })
  await mkdir(dirname(dependencyPath), { recursive: true })
  const nodeBytes = Buffer.from("verified node")
  const npmBytes = Buffer.from("verified npm")
  const dependencyBytes = Buffer.from("verified dependency")
  const writtenDependencyBytes = tamperDependency
    ? Buffer.from("tampered dependency")
    : dependencyBytes
  await writeFile(nodePath, tamper ? "tampered node" : nodeBytes)
  await writeFile(npmPath, npmBytes)
  await writeFile(dependencyPath, writtenDependencyBytes)
  const expectedFiles = {
    "node.exe": {
      size: nodeBytes.byteLength,
      sha256: createHash("sha256").update(nodeBytes).digest("hex"),
    },
    "node_modules/npm/bin/npm-cli.js": {
      size: npmBytes.byteLength,
      sha256: createHash("sha256").update(npmBytes).digest("hex"),
    },
    "node_modules/npm/node_modules/example/index.js": {
      size: dependencyBytes.byteLength,
      sha256: createHash("sha256").update(dependencyBytes).digest("hex"),
    },
  }
  const manifestFiles = structuredClone(expectedFiles)
  if (forgeManifest) {
    manifestFiles["node_modules/npm/node_modules/example/index.js"] = {
      size: writtenDependencyBytes.byteLength,
      sha256: createHash("sha256").update(writtenDependencyBytes).digest("hex"),
    }
  }
  await writeFile(
    join(runtime, RUNTIME_MANIFEST),
    JSON.stringify({
      schemaVersion: 2,
      nodeVersion: version,
      archive: NODE_ARCHIVE,
      archiveSha256: EXPECTED_NODE_ARCHIVE_SHA256,
      files: manifestFiles,
    }),
  )
  return { publisherRoot, runtime, expectedRuntimeTreeSha256: runtimeTreeSha256(expectedFiles) }
}

describe("portable Node runtime download", () => {
  const filename = "node-v22.16.0-win-x64.zip"
  const checksum = "a".repeat(64)

  it("accepts exactly one checksum entry for the exact archive filename", () => {
    expect(
      parseExpectedChecksum(
        `${"b".repeat(64)}  node-v22.16.0-linux-x64.tar.xz\n${checksum}  ${filename}\n`,
        filename,
      ),
    ).toBe(checksum)
    expect(() => parseExpectedChecksum(`${checksum}  nested/${filename}\n`, filename)).toThrow(
      /exact archive filename/i,
    )
    expect(() =>
      parseExpectedChecksum(`${checksum}  ${filename}\n${checksum}  ${filename}\n`, filename),
    ).toThrow(/exactly one/i)
  })

  it("rejects a checksum mismatch", () => {
    const bytes = Buffer.from("portable node archive")
    expect(() => verifySha256(bytes, "0".repeat(64))).toThrow(/checksum mismatch/i)
    expect(verifySha256(bytes, createHash("sha256").update(bytes).digest("hex"))).toBeUndefined()
  })

  it("rejects traversal, absolute, drive-qualified, and backslash zip entries", () => {
    expect(() =>
      assertSafeArchiveEntries([
        `${filename.slice(0, -4)}/node.exe`,
        `${filename.slice(0, -4)}/node_modules/npm/bin/npm-cli.js`,
      ]),
    ).not.toThrow()
    for (const unsafe of [
      "../node.exe",
      "node/../../node.exe",
      "/node.exe",
      "C:/node.exe",
      "node\\node.exe",
      "node/./node.exe",
      "node//node.exe",
    ]) {
      expect(() => assertSafeArchiveEntries([unsafe]), unsafe).toThrow(/unsafe archive entry/i)
    }
  })

  it("passes extraction paths only through dedicated environment variables", () => {
    const archive = String.raw`C:\Garden Files\runtime $([boom]).zip`
    const destination = String.raw`C:\Garden Files\stage; Remove-Item anything`
    const request = createExtractionRequest(archive, destination, {
      SystemRoot: String.raw`C:\Windows`,
    })

    expect(request.executable).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    )
    expect(request.args.join(" ")).not.toContain(archive)
    expect(request.args.join(" ")).not.toContain(destination)
    expect(request.args.at(-1)).toContain("$env:KGP_NODE_ARCHIVE_PATH")
    expect(request.args.at(-1)).toContain("$env:KGP_NODE_EXTRACT_PATH")
    expect(request.options).toMatchObject({ shell: false, windowsHide: true })
    expect(request.options.env).toMatchObject({
      KGP_NODE_ARCHIVE_PATH: archive,
      KGP_NODE_EXTRACT_PATH: destination,
    })
  })

  it("reuses only a pinned runtime whose manifest and required file hashes match", async () => {
    const fixture = await runtimeFixture()
    const fetchImpl = vi.fn()
    await expect(
      downloadNodeRuntime({
        platform: "win32",
        publisherRoot: fixture.publisherRoot,
        fetchImpl,
        expectedRuntimeTreeSha256: fixture.expectedRuntimeTreeSha256,
      }),
    ).resolves.toBe(fixture.runtime)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ["stale version", { version: "22.15.0" }],
    ["tampered node", { tamper: true }],
    ["tampered transitive npm module", { tamperDependency: true }],
    [
      "tampered transitive npm module with a forged manifest",
      { tamperDependency: true, forgeManifest: true },
    ],
  ])("redownloads instead of reusing a %s runtime", async (_label, options) => {
    const fixture = await runtimeFixture(options)
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from("not the pinned archive"),
    }))
    await expect(
      downloadNodeRuntime({
        platform: "win32",
        publisherRoot: fixture.publisherRoot,
        fetchImpl,
        expectedRuntimeTreeSha256: fixture.expectedRuntimeTreeSha256,
      }),
    ).rejects.toThrow(/checksum|SHASUM/i)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("fails when the downloaded checksum list disagrees with the pinned archive digest", async () => {
    const publisherRoot = await mkdtemp(join(tmpdir(), "node-runtime-mismatch-"))
    temporaryDirectories.push(publisherRoot)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => Buffer.from("archive"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => Buffer.from(`${"0".repeat(64)}  ${NODE_ARCHIVE}\n`),
      })
    await expect(
      downloadNodeRuntime({ platform: "win32", publisherRoot, fetchImpl }),
    ).rejects.toThrow(/pinned checksum/i)
  })
})
