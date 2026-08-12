import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"

import {
  markdownBlockPasteReplacement,
  markdownSelectionAcceptsRenderedPaste,
} from "./rendered-markdown-paste"
import { mathMarkdownExtension } from "./math"
import { yamlFrontMatterMarkdownExtension } from "./markdown-extensions"

function markdownState(
  doc: string,
  anchor: number,
  head = anchor,
  math = false
) {
  return EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: markdown({
      base: markdownLanguage,
      extensions: math ? [mathMarkdownExtension] : [],
    }),
  })
}

describe("rendered Markdown paste targets", () => {
  it("separates converted blocks from surrounding Markdown text", () => {
    const state = markdownState("beforePlainafter", 11)
    expect(
      markdownBlockPasteReplacement(state, { from: 6, to: 11 }, "## Heading")
    ).toBe("\n\n## Heading\n\n")
  })

  it("accepts ordinary Markdown insertion and replacement ranges", () => {
    expect(
      markdownSelectionAcceptsRenderedPaste(markdownState("text", 2))
    ).toBe(true)
    expect(
      markdownSelectionAcceptsRenderedPaste(markdownState("replace me", 0, 7))
    ).toBe(true)
  })

  it("never converts rich clipboard data in a plain-text document", () => {
    const state = EditorState.create({
      doc: "plain text",
      selection: { anchor: 5 },
    })
    expect(markdownSelectionAcceptsRenderedPaste(state)).toBe(false)
  })

  it.each([
    ["inline code", "before `literal` after", 9],
    ["fenced code", "```ts\nliteral\n```", 8],
    ["indented code", "    literal", 6],
    ["link destination", "[label](destination)", 10],
  ])("keeps rich clipboard data literal inside %s", (_name, doc, position) => {
    expect(
      markdownSelectionAcceptsRenderedPaste(markdownState(doc, position))
    ).toBe(false)
  })

  it("keeps rich clipboard data literal inside YAML front matter", () => {
    const doc = "---\ntitle: Draft\n---\nBody"
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("Draft") + 2 },
      extensions: markdown({
        base: markdownLanguage,
        extensions: [yamlFrontMatterMarkdownExtension],
      }),
    })
    expect(markdownSelectionAcceptsRenderedPaste(state)).toBe(false)
  })

  it.each([
    ["inline math", "$formula$", 4],
    ["block math", "$$\nformula\n$$", 5],
  ])("keeps rich clipboard data literal inside %s", (_name, doc, position) => {
    expect(
      markdownSelectionAcceptsRenderedPaste(
        markdownState(doc, position, position, true)
      )
    ).toBe(false)
  })
})
