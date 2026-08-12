import { describe, expect, test } from "vitest"

import { resolveMarkdownImageSource } from "./media"

describe("Markdown image sources", () => {
  test.each([
    [
      "https://example.com/image.png",
      "/tmp/document.md",
      "https://example.com/image.png",
    ],
    [
      "./images/example.png",
      "/Users/reader/notes/document.md",
      "pulse-md-image://local/%2FUsers%2Freader%2Fnotes%2Fimages%2Fexample.png",
    ],
    [
      "../example image.png",
      "/Users/reader/notes/document.md",
      "pulse-md-image://local/%2FUsers%2Freader%2Fexample%20image.png",
    ],
    [
      "/Users/reader/example.png",
      "/Users/reader/notes/document.md",
      "pulse-md-image://local/%2FUsers%2Freader%2Fexample.png",
    ],
    [
      String.raw`C:\Users\reader\example.png`,
      String.raw`C:\Users\reader\notes\document.md`,
      "pulse-md-image://local/C%3A%2FUsers%2Freader%2Fexample.png",
    ],
    [
      "file:///Users/reader/example%20image.png",
      null,
      "pulse-md-image://local/%2FUsers%2Freader%2Fexample%20image.png",
    ],
    [
      "./images/100%.png",
      "/Users/reader/notes/document.md",
      "pulse-md-image://local/%2FUsers%2Freader%2Fnotes%2Fimages%2F100%25.png",
    ],
    [
      "image.png",
      "/Users/reader/100% notes/document.md",
      "pulse-md-image://local/%2FUsers%2Freader%2F100%25%20notes%2Fimage.png",
    ],
    [
      "file:///Users/reader/100%/image.png",
      null,
      "pulse-md-image://local/%2FUsers%2Freader%2F100%25%2Fimage.png",
    ],
    [
      "/Users/reader/My%20Image.png",
      null,
      "pulse-md-image://local/%2FUsers%2Freader%2FMy%20Image.png",
    ],
    [
      "/Users/reader/100%25.png",
      null,
      "pulse-md-image://local/%2FUsers%2Freader%2F100%25.png",
    ],
    [
      "/Users/reader/100%2G.png",
      null,
      "pulse-md-image://local/%2FUsers%2Freader%2F100%252G.png",
    ],
    [
      "image.png",
      "/Users/reader/literal%20directory/document.md",
      "pulse-md-image://local/%2FUsers%2Freader%2Fliteral%2520directory%2Fimage.png",
    ],
  ])("resolves %j relative to %j", (source, documentPath, expected) => {
    expect(resolveMarkdownImageSource(source, documentPath)).toBe(expected)
  })

  test.each([
    ["relative.png", null],
    ["javascript:alert(1)", "/tmp/document.md"],
    ["mailto:reader@example.com", "/tmp/document.md"],
  ])("rejects unsupported image source %j", (source, documentPath) => {
    expect(resolveMarkdownImageSource(source, documentPath)).toBeNull()
  })
})
