import { mkdtemp, open, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  modeForAtomicReplacement,
  preserveExistingFileMode,
} from "./file-permissions"

describe("atomic-save file permissions", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    )
  })

  it.runIf(process.platform !== "win32")(
    "restores existing permission bits after the creation umask is applied",
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "pulse-md-save-mode-")
      )
      temporaryDirectories.push(directory)
      const target = path.join(directory, "temporary.md")
      const previousUmask = process.umask(0o022)
      let handle: Awaited<ReturnType<typeof open>> | null = null

      try {
        handle = await open(target, "wx", 0o666)
        expect((await handle.stat()).mode & 0o777).toBe(0o644)
        await handle.writeFile("replacement")
        await preserveExistingFileMode(handle, 0o102666)
        await handle.close()
        handle = null
      } finally {
        process.umask(previousUmask)
        await handle?.close().catch(() => undefined)
      }

      expect((await stat(target)).mode & 0o7777).toBe(0o2666)
    }
  )

  it("does not invoke POSIX chmod behavior for Windows saves", async () => {
    const chmod = () => {
      throw new Error("chmod should not run")
    }
    await expect(
      preserveExistingFileMode({ chmod } as never, 0o100666, "win32")
    ).resolves.toBeUndefined()
  })

  it("uses commit-adjacent permissions and falls back only for a deleted target", () => {
    expect(modeForAtomicReplacement(undefined, 0o100640)).toBe(0o100640)
    expect(modeForAtomicReplacement(0o100600, 0o100664)).toBe(0o100664)
    expect(modeForAtomicReplacement(0o100600, undefined)).toBe(0o100600)
    expect(modeForAtomicReplacement(undefined, undefined)).toBeUndefined()
  })
})
