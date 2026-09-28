import { describe, expect, it, vi } from "vitest"
import * as trashRecovery from "../../src/main/services/trashRecovery"

describe("trash recovery directory bounds", () => {
  it("stops after the limit plus one entry and closes the directory handle", async () => {
    let yielded = 0
    const close = vi.fn(async () => undefined)
    const handle = {
      async *[Symbol.asyncIterator]() {
        while (yielded < 50_000) {
          yielded += 1
          yield { name: `entry-${yielded}` }
        }
      },
      close,
    }
    const readBoundedDirectoryNames = (
      trashRecovery as typeof trashRecovery & {
        readBoundedDirectoryNames?: (
          path: string,
          maximumEntries: number,
          opener: () => Promise<typeof handle>,
        ) => Promise<readonly string[]>
      }
    ).readBoundedDirectoryNames

    expect(readBoundedDirectoryNames).toBeTypeOf("function")
    await expect(readBoundedDirectoryNames!("ignored", 10_000, async () => handle)).rejects.toThrow(
      /too many entries/i,
    )
    expect(yielded).toBe(10_001)
    expect(close).toHaveBeenCalledOnce()
  })
})
