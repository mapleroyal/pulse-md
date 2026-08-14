import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  isUnsupportedDirectorySyncError,
  openFileForSync,
  renameReplacingFile,
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

  it("only requests write access for Windows regular-file sync handles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-fsync-"))
    directories.push(directory)
    const filePath = path.join(directory, "published.json")
    await writeFile(filePath, "original")

    const windowsHandle = await openFileForSync(filePath, "win32")
    try {
      await expect(windowsHandle.sync()).resolves.toBeUndefined()
    } finally {
      await windowsHandle.close()
    }

    const unixHandle = await openFileForSync(filePath, "linux")
    try {
      await expect(unixHandle.write("replacement", 0)).rejects.toMatchObject({
        code: "EBADF",
      })
    } finally {
      await unixHandle.close()
    }
  })

  it("retries only bounded Windows sharing failures without removing the destination", async () => {
    const delays: number[] = []
    let revalidations = 0
    const errors = ["EPERM", "EACCES", "EBUSY"].map((code) =>
      Object.assign(new Error(code), { code })
    )
    let attempts = 0

    await expect(
      renameReplacingFile("next", "current", {
        beforeRetryAttempt: async () => {
          revalidations += 1
        },
        platform: "win32",
        renameFile: async () => {
          const error = errors[attempts]
          attempts += 1
          if (error) throw error
        },
        wait: async (milliseconds) => {
          delays.push(milliseconds)
        },
      })
    ).resolves.toBeUndefined()
    expect(attempts).toBe(4)
    expect(delays).toEqual([10, 20, 40])
    expect(revalidations).toBe(3)
  })

  it("cancels before a Windows retry when replacement revalidation fails", async () => {
    const cancellation = new Error("replacement no longer approved")
    const failure = Object.assign(new Error("EPERM"), { code: "EPERM" })
    const delays: number[] = []
    let attempts = 0

    await expect(
      renameReplacingFile("next", "current", {
        beforeRetryAttempt: async () => {
          throw cancellation
        },
        platform: "win32",
        renameFile: async () => {
          attempts += 1
          throw failure
        },
        wait: async (milliseconds) => {
          delays.push(milliseconds)
        },
      })
    ).rejects.toBe(cancellation)
    expect(attempts).toBe(1)
    expect(delays).toEqual([10])
  })

  it("does not retry non-Windows, unrelated, or persistent rename failures", async () => {
    const scenarios = [
      { code: "EPERM", expectedAttempts: 1, platform: "linux" as const },
      { code: "ENOENT", expectedAttempts: 1, platform: "win32" as const },
      { code: "EPERM", expectedAttempts: 10, platform: "win32" as const },
    ]

    for (const scenario of scenarios) {
      const failure = Object.assign(new Error(scenario.code), {
        code: scenario.code,
      })
      let attempts = 0
      const delays: number[] = []
      await expect(
        renameReplacingFile("next", "current", {
          platform: scenario.platform,
          renameFile: async () => {
            attempts += 1
            throw failure
          },
          wait: async (milliseconds) => {
            delays.push(milliseconds)
          },
        })
      ).rejects.toBe(failure)
      expect(attempts).toBe(scenario.expectedAttempts)
      expect(delays).toHaveLength(scenario.expectedAttempts - 1)
    }
  })

  it("atomically replaces an existing file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-rename-"))
    directories.push(directory)
    const sourcePath = path.join(directory, "next.json")
    const destinationPath = path.join(directory, "current.json")
    await writeFile(sourcePath, "new")
    await writeFile(destinationPath, "old")

    await renameReplacingFile(sourcePath, destinationPath)

    await expect(readFile(destinationPath, "utf8")).resolves.toBe("new")
    await expect(readFile(sourcePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
