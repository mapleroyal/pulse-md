import { describe, expect, test } from "vitest"

import {
  documentExtension,
  documentKindForPath,
  isInternalTextDocumentPath,
} from "./document-kind"

describe("document kind", () => {
  test.each(["note.md", "NOTE.MARKDOWN", "/work/draft.mdown", "C:\\a\\x.mkd"])(
    "classifies %s as Markdown",
    (filePath) => {
      expect(documentKindForPath(filePath)).toBe("markdown")
    }
  )

  test.each(["notes.txt", "data.json", "page.html", "README", "photo.png"])(
    "classifies %s as plain text",
    (filePath) => {
      expect(documentKindForPath(filePath)).toBe("plain-text")
    }
  )

  test("defaults pathless documents to Markdown", () => {
    expect(documentKindForPath(null)).toBe("markdown")
    expect(documentKindForPath(null, "plain-text")).toBe("plain-text")
  })

  test("extracts only a final filename extension", () => {
    expect(documentExtension("/work/archive.test.JSON")).toBe("json")
    expect(documentExtension("/work/folder.with.dots/README")).toBe("")
    expect(documentExtension("/work/.gitignore")).toBe("")
    expect(documentExtension("/work/trailing.")).toBe("")
  })

  test("opens known text and extensionless links internally", () => {
    expect(isInternalTextDocumentPath("data.json")).toBe(true)
    expect(isInternalTextDocumentPath("README")).toBe(true)
    expect(isInternalTextDocumentPath("photo.png")).toBe(false)
  })
})
