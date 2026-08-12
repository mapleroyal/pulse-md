import { markdown } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import { buildEmojiPreviewDecorations, emojiShortcodes } from "./emoji-preview"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

function emojiState(doc: string, cursor = 0, head = cursor) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor, head },
    extensions: [
      markdown({
        addKeymap: false,
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions({
          emojiRecognition: true,
        }),
      }),
    ],
  })
}

function emojiDecorations(state: EditorState, selectionActive = true) {
  const values: Array<{
    alias: string
    from: number
    source: string
    to: number
  }> = []
  buildEmojiPreviewDecorations(
    state,
    [{ from: 0, to: state.doc.length }],
    selectionActive
  ).between(0, state.doc.length, (from, to, value: Decoration) => {
    const widget = value.spec.widget as { alias: string; source: string }
    values.push({ alias: widget.alias, from, source: widget.source, to })
  })
  return values
}

describe("emoji expansion preview", () => {
  test("extracts recognized tokens without validating aliases eagerly", () => {
    const state = emojiState("Known :smile:, numeric :+1:, unknown :not_real:.")

    expect(
      emojiShortcodes(state).map(({ alias, source }) => ({ alias, source }))
    ).toEqual([
      { alias: "smile", source: ":smile:" },
      { alias: "+1", source: ":+1:" },
      { alias: "not_real", source: ":not_real:" },
    ])
  })

  test("replaces only visible, inactive tokens", () => {
    const doc = ":smile: middle :rocket:"
    const firstEnd = doc.indexOf(" ")
    const state = emojiState(doc, 2)

    expect(emojiDecorations(state).map(({ source }) => source)).toEqual([
      ":rocket:",
    ])
    expect(emojiDecorations(state, false).map(({ source }) => source)).toEqual([
      ":smile:",
      ":rocket:",
    ])
    expect(
      buildEmojiPreviewDecorations(state, [{ from: 0, to: firstEnd }]).size
    ).toBe(0)
  })

  test("reveals a token touched by a nonempty selection even when inactive", () => {
    const doc = ":smile: :rocket:"
    const rocket = doc.indexOf(":rocket:")
    const state = emojiState(doc, rocket + 1, rocket + 4)

    expect(emojiDecorations(state, false).map(({ source }) => source)).toEqual([
      ":smile:",
    ])
  })
})
