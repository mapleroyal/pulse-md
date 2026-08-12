import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import {
  escapedMarkdownLinkDestination,
  markdownLinkSource,
  markdownLinkDestinationForSelection,
  moveSelectionToMarkdownLinkDestination,
  normalizedPastedUrl,
  selectedTextWrapperFor,
} from "./input-wrapping"

function editor(doc: string, anchor: number, head: number) {
  let state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: markdown({ base: markdownLanguage }),
  })
  const view = {
    get state() {
      return state
    },
    dispatch(spec: Parameters<EditorView["dispatch"]>[0]) {
      state = state.update(spec).state
    },
  } as EditorView
  return {
    get selection() {
      return state.selection.main
    },
    view,
  }
}

describe("selected text wrappers", () => {
  test.each([
    ["**", { open: "**", close: "**" }],
    ["***", { open: "***", close: "***" }],
    ["~~", { open: "~~", close: "~~" }],
    ["```", { open: "```", close: "```" }],
  ])("recognizes batched Markdown delimiter %s", (insertedText, expected) => {
    expect(selectedTextWrapperFor(insertedText)).toEqual(expected)
  })

  test("makes repeated asymmetric delimiters match repeated keystrokes", () => {
    expect(selectedTextWrapperFor("[[")).toEqual({ open: "[[", close: "]]" })
    expect(selectedTextWrapperFor("(((")).toEqual({
      open: "(((",
      close: ")))",
    })
  })

  test.each(["", "plain", "*_", "()`"])(
    "rejects non-delimiter input %j",
    (insertedText) => {
      expect(selectedTextWrapperFor(insertedText)).toBeNull()
    }
  )
})

describe("pasted URL targets", () => {
  test.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["  http://example.com/path\n", "http://example.com/path"],
    ["www.example.com", "https://www.example.com/"],
    ["https://example.com/a b", "https://example.com/a%20b"],
    ["mailto:reader@example.com", "mailto:reader@example.com"],
  ])("normalizes %j", (source, expected) => {
    expect(normalizedPastedUrl(source)).toBe(expected)
  })

  test.each(["", "ordinary text", "file:///tmp/document.md", "javascript:x"])(
    "rejects non-link paste %j",
    (source) => {
      expect(normalizedPastedUrl(source)).toBeNull()
    }
  )
})

describe("pasted Markdown links", () => {
  test("escapes a pasted destination without losing URL punctuation", () => {
    expect(escapedMarkdownLinkDestination("https://example.com/folder)")).toBe(
      String.raw`https://example.com/folder\)`
    )
  })

  test("escapes label delimiters and destination parentheses", () => {
    expect(
      markdownLinkSource(
        String.raw`reader [draft] \\ notes`,
        "https://example.com/a(b)"
      )
    ).toBe(
      String.raw`[reader \[draft\] \\\\ notes](https://example.com/a\(b\))`
    )
  })

  test.each([
    ["[text](https://)", 1, 5, 7, 15],
    ["![alt text](https://)", 2, 10, 12, 20],
  ])(
    "moves the selected label in %j to its destination",
    (source, labelFrom, labelTo, urlFrom, urlTo) => {
      const harness = editor(source, labelFrom, labelTo)

      expect(moveSelectionToMarkdownLinkDestination(harness.view)).toBe(true)
      expect(harness.selection.from).toBe(urlFrom)
      expect(harness.selection.to).toBe(urlTo)
      expect(
        markdownLinkDestinationForSelection(
          harness.view.state,
          harness.selection.from,
          harness.selection.to
        )
      ).toEqual({ from: urlFrom, to: urlTo })
    }
  )

  test.each([
    ["[custom label](https://)", 13, 15, 23],
    ["![custom alt](https://)", 12, 14, 22],
  ])(
    "moves the caret after a typed label in %j to its destination",
    (source, caret, urlFrom, urlTo) => {
      const harness = editor(source, caret, caret)

      expect(moveSelectionToMarkdownLinkDestination(harness.view)).toBe(true)
      expect(harness.selection.from).toBe(urlFrom)
      expect(harness.selection.to).toBe(urlTo)
    }
  )

  test("does not treat ordinary selected text as a link destination", () => {
    const harness = editor("plain text", 0, 5)
    expect(moveSelectionToMarkdownLinkDestination(harness.view)).toBe(false)
    expect(
      markdownLinkDestinationForSelection(harness.view.state, 0, 5)
    ).toBeNull()
  })

  test("leaves Tab available when only part of a link label is selected", () => {
    const harness = editor("[text](https://)", 1, 3)
    expect(moveSelectionToMarkdownLinkDestination(harness.view)).toBe(false)
  })
})
