import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  MAX_DROPPED_DOCUMENT_COUNT,
  normalizeDroppedDocumentPaths,
} from "./dropped-documents"

describe("dropped document validation", () => {
  it("preserves every absolute path for the ordinary open and decode path", () => {
    const filePaths = [
      path.resolve("document.rst"),
      path.resolve("schema.graphql"),
      path.resolve("missing-or-invalid-input"),
    ]

    expect(normalizeDroppedDocumentPaths(filePaths)).toEqual(filePaths)
  })

  it("rejects malformed or oversized path lists", () => {
    expect(() => normalizeDroppedDocumentPaths(["relative.md"])).toThrow(
      "Invalid dropped document path"
    )
    expect(() =>
      normalizeDroppedDocumentPaths([
        ...Array.from({ length: MAX_DROPPED_DOCUMENT_COUNT }, (_value, index) =>
          path.resolve(`document-${index}.md`)
        ),
        path.resolve("one-too-many.md"),
      ])
    ).toThrow("Invalid dropped document list")
  })
})
