import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"

import { countWords, editorStatus, wordCountField } from "./status"

describe("editor status", () => {
  it("updates word totals from changed line ranges", () => {
    let state = EditorState.create({
      doc: "one two\nthree café\nfive",
      extensions: [wordCountField],
      selection: { anchor: 4 },
    })

    expect(editorStatus(state)).toEqual({
      words: 5,
      lines: 3,
      characters: 23,
      line: 1,
      column: 5,
    })

    state = state.update({
      changes: { from: 4, to: 7, insert: "two-and-a-half" },
      selection: { anchor: 18 },
    }).state

    expect(editorStatus(state)).toMatchObject({
      words: 5,
      lines: 3,
      line: 1,
      column: 19,
    })

    state = state.update({
      changes: {
        from: 0,
        to: state.doc.line(2).to,
        insert: "replacement words",
      },
    }).state

    expect(editorStatus(state).words).toBe(3)
  })

  it("defers the initial count for documents large enough to block startup", () => {
    const state = EditorState.create({
      doc: "word ".repeat(210_000),
      extensions: [wordCountField],
    })

    expect(editorStatus(state).words).toBeNull()
  })

  it("defers recounting when one edit introduces a large synchronous range", () => {
    const state = EditorState.create({
      doc: "before",
      extensions: [wordCountField],
    }).update({
      changes: {
        from: 6,
        insert: ` ${"large-word ".repeat(30_000)}`,
      },
    }).state

    expect(editorStatus(state).words).toBeNull()
  })

  it("matches the word grammar across connectors and Unicode code points", () => {
    const samples = [
      "one two-three four_five six's seven’s",
      "one--two _three_ four-'five",
      "café Ελληνικά 𐐀𐐁 combining\u0301",
      " punctuation…between\twords\nand lines ",
    ]
    const reference = /[\p{L}\p{M}\p{N}]+(?:['’_-][\p{L}\p{M}\p{N}]+)*/gu

    for (const sample of samples) {
      expect(countWords(sample)).toBe([...sample.matchAll(reference)].length)
    }
  })
})
