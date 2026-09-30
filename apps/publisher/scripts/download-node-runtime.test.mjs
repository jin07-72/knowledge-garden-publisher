// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  assertSafeArchiveEntries,
  parseExpectedChecksum,
  verifySha256,
} from "./download-node-runtime.mjs"

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
})
