import { markdown } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import {
  buildFootnoteIndex,
  buildFootnotePreviewDecorations,
  canMapFootnoteIndex,
  mapFootnoteIndex,
} from "./footnotes"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"

function footnoteState(doc: string, cursor = 0, head = cursor) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor, head },
    extensions: [
      markdown({
        addKeymap: false,
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions({ footnotes: true }),
      }),
    ],
  })
}

function footnoteDecorations(state: EditorState, selectionActive = true) {
  const values: Array<{
    from: number
    kind: unknown
    text: string
    to: number
  }> = []
  buildFootnotePreviewDecorations(
    state,
    buildFootnoteIndex(state),
    [{ from: 0, to: state.doc.length }],
    selectionActive
  ).between(0, state.doc.length, (from, to, value: Decoration) => {
    values.push({
      from,
      kind: value.spec.markdownPreviewKind ?? value.spec.class,
      text: state.sliceDoc(from, to),
      to,
    })
  })
  return values
}

describe("footnote semantics", () => {
  test("numbers definitions by first resolved reference and normalizes labels", () => {
    const state = footnoteState(
      [
        "Second[^B], first[^a], and second again[^b]. Missing[^none].",
        "",
        "[^a]: Alpha",
        "[^B]: Beta",
        "[^orphan]: Unreferenced",
      ].join("\n")
    )
    const index = buildFootnoteIndex(state)

    expect(
      index.references.map(({ identifier, number }) => ({ identifier, number }))
    ).toEqual([
      { identifier: "b", number: 1 },
      { identifier: "a", number: 2 },
      { identifier: "b", number: 1 },
    ])
    expect(
      index.definitions.map(({ identifier, number }) => ({
        identifier,
        number,
      }))
    ).toEqual([
      { identifier: "a", number: 2 },
      { identifier: "b", number: 1 },
      { identifier: "orphan", number: 3 },
    ])
  })

  test("uses the first duplicate definition and leaves unresolved references literal", () => {
    const doc = [
      "Resolved[^same], unresolved[^missing].",
      "",
      "[^same]: First",
      "[^same]: Duplicate",
    ].join("\n")
    const state = footnoteState(doc)
    const index = buildFootnoteIndex(state)

    expect(index.definitions).toHaveLength(1)
    expect(
      state.doc.lineAt(index.references[0]!.definitionFrom).text
    ).toContain("First")
    expect(index.references).toHaveLength(1)
    expect(index.references[0]!.identifier).toBe("same")
  })

  test("indexes references nested inside definition bodies", () => {
    const doc = ["Outer[^a].", "", "[^a]: Inside [^b].", "", "[^b]: End."].join(
      "\n"
    )
    const state = footnoteState(doc)
    const index = buildFootnoteIndex(state)
    const nestedReferenceFrom = doc.indexOf("[^b]")

    expect(
      index.references.map(({ from, identifier, number }) => ({
        from,
        identifier,
        number,
      }))
    ).toEqual([
      { from: doc.indexOf("[^a]"), identifier: "a", number: 1 },
      { from: nestedReferenceFrom, identifier: "b", number: 2 },
    ])
    expect(
      index.definitions.find(({ identifier }) => identifier === "b")
        ?.firstReferenceFrom
    ).toBe(nestedReferenceFrom)
    expect(
      index.syntaxRanges.every(
        (range, position, ranges) =>
          position === 0 || ranges[position - 1]!.to < range.from
      )
    ).toBe(true)
  })

  test("maps the complete index through ordinary prose edits", () => {
    const state = footnoteState(
      "Intro text.\n\nResolved[^n]. Missing[^missing].\n\n[^n]: Note"
    )
    const index = buildFootnoteIndex(state)
    const transaction = state.update({
      changes: { from: "Intro".length, insert: "ductory" },
    })

    expect(
      canMapFootnoteIndex(state, transaction.state, transaction.changes, index)
    ).toBe(true)
    expect(mapFootnoteIndex(index, transaction.changes)).toEqual(
      buildFootnoteIndex(transaction.state)
    )
  })

  test("maps ordinary prose edits near but outside a citation", () => {
    const state = footnoteState(
      "Nearby prose beside a citation[^n].\n\n[^n]: Note"
    )
    const index = buildFootnoteIndex(state)
    const transaction = state.update({
      changes: { from: "Nearby".length, insert: "ish" },
    })

    expect(
      canMapFootnoteIndex(state, transaction.state, transaction.changes, index)
    ).toBe(true)
    expect(mapFootnoteIndex(index, transaction.changes)).toEqual(
      buildFootnoteIndex(transaction.state)
    )
  })

  test("keeps footnote-affecting edits on the exact parse path", () => {
    const doc = "Intro [^missing] and empty [^].\n\n[^other]: Other"
    const state = footnoteState(doc)
    const index = buildFootnoteIndex(state)
    const cases = [
      {
        from: doc.indexOf("missing") + 2,
        to: doc.indexOf("missing") + 3,
        insert: "x",
      },
      {
        from: doc.indexOf("[^]") + 2,
        insert: "n",
      },
      { from: doc.indexOf(" and") + 1, insert: "[" },
    ]

    for (const changes of cases) {
      const transaction = state.update({ changes })
      expect(
        canMapFootnoteIndex(
          state,
          transaction.state,
          transaction.changes,
          index
        )
      ).toBe(false)
    }
  })

  test("checks dense syntax indexes without changing boundary semantics", () => {
    const state = footnoteState("Ordinary prose for editing.")
    const ranges = Array.from({ length: 100_000 }, (_value, index) => ({
      from: 1_000_000 + index * 10,
      to: 1_000_004 + index * 10,
    }))
    const index: ReturnType<typeof buildFootnoteIndex> = {
      definitions: [],
      references: [],
      syntaxRanges: ranges,
    }
    const ordinaryEdit = state.update({
      changes: { from: "Ordinary".length, insert: "ish" },
    })

    expect(
      canMapFootnoteIndex(
        state,
        ordinaryEdit.state,
        ordinaryEdit.changes,
        index
      )
    ).toBe(true)

    const syntaxDocument = footnoteState(`${"x".repeat(1_000_002)}tail`)
    const touchingEdit = syntaxDocument.update({
      changes: { from: 1_000_002, insert: "y" },
    })
    expect(
      canMapFootnoteIndex(
        syntaxDocument,
        touchingEdit.state,
        touchingEdit.changes,
        index
      )
    ).toBe(false)
  })
})

describe("footnote live preview", () => {
  test("replaces resolved references and definition labels", () => {
    const state = footnoteState("Text[^n].\n\n[^n]: Note body")
    const values = footnoteDecorations(state, false)

    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "footnote-reference",
          text: "[^n]",
        }),
        expect.objectContaining({
          kind: "footnote-definition-label",
          text: "[^n]: ",
        }),
      ])
    )
  })

  test("reveals the complete construct touched by the selection", () => {
    const doc = "Text[^n].\n\n[^n]: Note body"
    const reference = doc.indexOf("[^n]")
    const definition = doc.lastIndexOf("[^n]")

    const atReference = footnoteState(doc, reference + 2)
    expect(
      footnoteDecorations(atReference).some(
        ({ kind }) => kind === "footnote-reference"
      )
    ).toBe(false)

    const atDefinition = footnoteState(doc, definition + 2)
    expect(
      footnoteDecorations(atDefinition).some(
        ({ kind }) => kind === "footnote-definition-label"
      )
    ).toBe(false)
  })

  test("does not decorate definitions outside the visible range", () => {
    const doc = "Text[^n].\n\n[^n]: Note body"
    const state = footnoteState(doc)
    const referenceLine = state.doc.line(1)
    const decorations = buildFootnotePreviewDecorations(
      state,
      buildFootnoteIndex(state),
      [{ from: referenceLine.from, to: referenceLine.to }],
      false
    )
    const kinds: unknown[] = []
    decorations.between(
      0,
      state.doc.length,
      (_from, _to, value: Decoration) => {
        kinds.push(value.spec.markdownPreviewKind ?? value.spec.class)
      }
    )

    expect(kinds).toContain("footnote-reference")
    expect(kinds).not.toContain("footnote-definition-label")
    expect(kinds).not.toContain("cm-md-footnote-definition-line")
  })
})
