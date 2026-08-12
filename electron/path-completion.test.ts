import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { filesystemPathCompletions } from "./path-completion"

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-md-paths-"))
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(path.join(root, "docs")),
    mkdir(path.join(root, ".private")),
    writeFile(path.join(root, "draft.md"), ""),
    writeFile(path.join(root, "drawing.png"), ""),
  ])
  await symlink(path.join(root, "docs"), path.join(root, "linked-docs"))
  return root
}

describe("filesystem path completions", () => {
  it("lists relative directories before files and resolves directory links", async () => {
    const root = await fixture()
    const entries = await filesystemPathCompletions({
      homeDirectory: root,
      query: "d",
      sourceFilePath: path.join(root, "document.md"),
    })

    expect(entries).toEqual([
      { kind: "directory", name: "docs" },
      { kind: "file", name: "draft.md" },
      { kind: "file", name: "drawing.png" },
    ])
    await expect(
      filesystemPathCompletions({
        homeDirectory: root,
        query: "linked",
        sourceFilePath: path.join(root, "document.md"),
      })
    ).resolves.toEqual([{ kind: "directory", name: "linked-docs" }])
  })

  it("shows dotfiles only after a dot and supports home-relative paths", async () => {
    const root = await fixture()

    await expect(
      filesystemPathCompletions({
        homeDirectory: root,
        query: "~/",
        sourceFilePath: null,
      })
    ).resolves.not.toContainEqual({ kind: "directory", name: ".private" })
    await expect(
      filesystemPathCompletions({
        homeDirectory: root,
        query: "~/.",
        sourceFilePath: null,
      })
    ).resolves.toContainEqual({ kind: "directory", name: ".private" })
  })

  it("returns no relative suggestions for a pathless document", async () => {
    await expect(
      filesystemPathCompletions({
        homeDirectory: os.homedir(),
        query: "docs/",
        sourceFilePath: null,
      })
    ).resolves.toEqual([])
  })

  it("bounds retained results and stops a superseded directory scan", async () => {
    const root = await fixture()
    await Promise.all(
      Array.from({ length: 225 }, (_, index) =>
        writeFile(
          path.join(root, `bulk-${index.toString().padStart(3, "0")}.md`),
          ""
        )
      )
    )
    await expect(
      filesystemPathCompletions({
        homeDirectory: root,
        query: "bulk-",
        sourceFilePath: path.join(root, "document.md"),
      })
    ).resolves.toHaveLength(200)

    let cancellationChecks = 0
    await expect(
      filesystemPathCompletions({
        cancelled: () => {
          cancellationChecks += 1
          return cancellationChecks > 2
        },
        homeDirectory: root,
        query: "",
        sourceFilePath: path.join(root, "document.md"),
      })
    ).resolves.toEqual([])
    expect(cancellationChecks).toBeGreaterThan(2)
  })
})
