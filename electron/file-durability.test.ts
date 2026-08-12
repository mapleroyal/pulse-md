import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  isUnsupportedDirectorySyncError,
  syncParentDirectory,
} from "./file-durability"

describe("file durability", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    )
  })

  it("syncs an existing parent directory and skips Windows directory handles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-fsync-"))
    directories.push(directory)
    await expect(
      syncParentDirectory(path.join(directory, "published.json"))
    ).resolves.toBeUndefined()
    await expect(
      syncParentDirectory(
        path.join(directory, "missing", "published.json"),
        "win32"
      )
    ).resolves.toBeUndefined()
  })

  it("only classifies explicit unsupported-operation errors as ignorable", () => {
    for (const code of ["EINVAL", "ENOSYS", "ENOTSUP"]) {
      expect(isUnsupportedDirectorySyncError({ code })).toBe(true)
    }
    expect(isUnsupportedDirectorySyncError({ code: "EIO" })).toBe(false)
    expect(isUnsupportedDirectorySyncError(new Error("unknown"))).toBe(false)
  })
})
