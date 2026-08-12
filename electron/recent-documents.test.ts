import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  addRecentDocumentPath,
  MAX_RECENT_DOCUMENT_PATH_LENGTH,
  MAX_RECENT_DOCUMENTS,
  normalizeRecentDocumentPaths,
  normalizeRecentDocuments,
  recentDocumentsFile,
} from "./recent-documents"

describe("recent documents", () => {
  it("rejects unknown file schemas", () => {
    expect(normalizeRecentDocuments(null, "linux")).toEqual([])
    expect(normalizeRecentDocuments([], "linux")).toEqual([])
    expect(normalizeRecentDocuments({ paths: ["/notes.md"] }, "linux")).toEqual(
      []
    )
    expect(
      normalizeRecentDocuments({ paths: ["/notes.md"], version: 2 }, "linux")
    ).toEqual([])
  })

  it("filters invalid paths, normalizes them, and preserves MRU order", () => {
    expect(
      normalizeRecentDocuments(
        {
          version: 1,
          paths: [
            "/work/first.md",
            "",
            "relative.md",
            "/work/section/../second.md",
            "/work/first.md",
            `/work/${"x".repeat(MAX_RECENT_DOCUMENT_PATH_LENGTH)}`,
            "/work/bad\0path.md",
          ],
        },
        "linux"
      )
    ).toEqual(["/work/first.md", "/work/second.md"])
  })

  it("uses Windows path rules and deduplicates case-insensitively", () => {
    expect(
      normalizeRecentDocumentPaths(
        [
          String.raw`C:\Work\First.md`,
          String.raw`c:\work\first.md`,
          String.raw`C:\Work\section\..\Second.md`,
          String.raw`relative\document.md`,
        ],
        "win32"
      )
    ).toEqual([String.raw`C:\Work\First.md`, String.raw`C:\Work\Second.md`])
  })

  it("moves an existing path to the front and caps retained entries", () => {
    const paths = Array.from(
      { length: MAX_RECENT_DOCUMENTS },
      (_, index) => `/work/document-${index}.md`
    )
    expect(addRecentDocumentPath(paths, paths[10]!, "linux")).toEqual([
      paths[10],
      ...paths.slice(0, 10),
      ...paths.slice(11),
    ])

    const newPath = path.posix.join("/work", "new.md")
    const withNewPath = addRecentDocumentPath(paths, newPath, "linux")
    expect(withNewPath).toHaveLength(MAX_RECENT_DOCUMENTS)
    expect(withNewPath[0]).toBe(newPath)
    expect(withNewPath.at(-1)).toBe(paths.at(-2))
  })

  it("serializes only normalized entries", () => {
    expect(
      recentDocumentsFile(
        ["/work/a/../first.md", "relative.md", "/work/second.md"],
        "linux"
      )
    ).toEqual({
      paths: ["/work/first.md", "/work/second.md"],
      version: 1,
    })
  })
})
