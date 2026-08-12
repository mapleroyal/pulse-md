import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  loadSettingsFile,
  preserveSettingsFileForReset,
  resetSettingsFilePreservingOriginal,
} from "./settings-load-recovery"

describe("Settings load recovery", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    )
  })

  it("reports invalid data without mutating the source", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-settings-"))
    directories.push(directory)
    const filePath = path.join(directory, "settings.json")
    const original = Buffer.from("{ definitely-not-json", "utf8")
    await writeFile(filePath, original)

    const result = await loadSettingsFile(filePath, (value) => value)

    expect(result.kind).toBe("failed")
    expect(await readFile(filePath)).toEqual(original)
  })

  it("preserves exact failed bytes before an explicit reset", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-settings-"))
    directories.push(directory)
    const filePath = path.join(directory, "settings.json")
    const original = Buffer.from([0xff, 0x00, 0x7b])
    await writeFile(filePath, original)

    const preservedPath = await preserveSettingsFileForReset(
      filePath,
      123,
      "20000000-0000-4000-8000-000000000001"
    )

    expect(preservedPath).toBe(
      path.join(
        directory,
        "settings.preserved-123-20000000-0000-4000-8000-000000000001.json"
      )
    )
    expect(await readFile(preservedPath!)).toEqual(original)
    expect(await readFile(filePath)).toEqual(original)
  })

  it("keeps the canonical original intact when the reset write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-settings-"))
    directories.push(directory)
    const filePath = path.join(directory, "settings.json")
    const original = Buffer.from("{ invalid but important", "utf8")
    await writeFile(filePath, original)

    await expect(
      resetSettingsFilePreservingOriginal(filePath, async () => {
        throw new Error("default write failed")
      })
    ).rejects.toThrow("default write failed")

    expect(await readFile(filePath)).toEqual(original)
  })
})
