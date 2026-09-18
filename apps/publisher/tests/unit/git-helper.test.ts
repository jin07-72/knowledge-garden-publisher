import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createTemporaryGitRepository,
  type GitFixtureDependencies,
  type TemporaryGitRepository
} from "../helpers/git"
import { exists, removeTemporaryDirectory } from "../helpers/fs"

const repositories: TemporaryGitRepository[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.cleanup()))
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory))
})

describe("createTemporaryGitRepository", () => {
  it("uses an isolated configuration and explicit Git initialization options", async () => {
    const requests: Parameters<NonNullable<GitFixtureDependencies["runGit"]>>[0][] = []
    const repository = await createTemporaryGitRepository({
      runGit: async (request) => {
        requests.push(request)
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    })
    repositories.push(repository)

    expect(requests).toHaveLength(5)
    expect(requests[0]).toMatchObject({
      args: ["init", "--bare", "--initial-branch=main", "--object-format=sha1", repository.remote],
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: expect.stringContaining("empty-global.gitconfig")
      }
    })
    expect(requests[1]).toMatchObject({
      args: ["init", "--initial-branch=main", "--object-format=sha1"],
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: expect.stringContaining("empty-global.gitconfig")
      }
    })
  })

  it("cleans its allocated temporary directory when setup fails", async () => {
    const base = await mkdtemp(join(tmpdir(), "garden-git-cleanup-"))
    directories.push(base)
    const repository = createTemporaryGitRepository({
      createTempDirectory: async () => base,
      runGit: async () => ({ exitCode: 1, stdout: "", stderr: "failure" })
    })

    await expect(repository).rejects.toThrow("git init failed")
    expect(await exists(base)).toBe(false)
  })
})
