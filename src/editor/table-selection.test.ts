import { markdown } from "@codemirror/lang-markdown"
import { syntaxTree } from "@codemirror/language"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, test, vi } from "vitest"

import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"
import {
  markdownTableClipboardText,
  parseTableClipboardText,
  runTableCellRangeClipboardCommand,
  setTableCellRangeSelection,
  tableCellRangeSelectionSnapshot,
  tableCellRangeSelectionState,
} from "./table-selection"

function tableRows(state: EditorState) {
  let table: SyntaxNode | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return
      table = node.node
      return false
    },
  })
  if (!table) throw new Error("The test document did not parse as a table")

  const rows: SyntaxNode[] = []
  let child = (table as SyntaxNode).firstChild
  while (child) {
    if (child.name === "TableHeader" || child.name === "TableRow") {
      rows.push(child)
    }
    child = child.nextSibling
  }
  return { rows, table: table as SyntaxNode }
}

describe("rendered table cell ranges", () => {
  test("does not clear cells if the editor becomes read-only during an async cut", async () => {
    const readOnly = new Compartment()
    let state = EditorState.create({
      doc: ["| A | B |", "| --- | --- |", "| one | two |"].join("\n"),
      extensions: [
        markdown({
          addKeymap: false,
          base: markdownBaseLanguage,
          extensions: createMarkdownParserExtensions(),
        }),
        tableCellRangeSelectionState,
        readOnly.of(EditorState.readOnly.of(false)),
      ],
    })
    const { rows, table } = tableRows(state)
    state = state.update({
      effects: setTableCellRangeSelection.of({
        anchorColumn: 0,
        anchorRowFrom: rows[1]!.from,
        headColumn: 1,
        headRowFrom: rows[1]!.from,
        tableFrom: table.from,
        tableTo: table.to,
      }),
    }).state

    let releaseClipboard!: () => void
    const clipboardWrite = new Promise<void>((resolve) => {
      releaseClipboard = resolve
    })
    const writeText = vi.fn(() => clipboardWrite)
    const focus = vi.fn()
    const dispatch = vi.fn()
    const view = {
      get state() {
        return state
      },
      dom: {
        ownerDocument: {
          defaultView: { navigator: { clipboard: { writeText } } },
        },
      },
      dispatch,
      focus,
    } as unknown as EditorView

    const pendingCut = runTableCellRangeClipboardCommand(view, "cut")
    expect(writeText).toHaveBeenCalledOnce()
    state = state.update({
      effects: readOnly.reconfigure(EditorState.readOnly.of(true)),
    }).state
    releaseClipboard()

    await expect(pendingCut).resolves.toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledOnce()
    expect(state.doc.toString()).toContain("| one | two |")
  })

  test("serializes the exact rectangular range as a Markdown table", () => {
    const initialState = EditorState.create({
      doc: [
        "| Heading One | Heading Two | Heading Three |",
        "| --- | --- | --- |",
        "| one | two | three |",
        "| four | five |",
      ].join("\n"),
      extensions: [
        markdown({
          addKeymap: false,
          base: markdownBaseLanguage,
          extensions: createMarkdownParserExtensions(),
        }),
        tableCellRangeSelectionState,
      ],
    })
    const { rows, table } = tableRows(initialState)
    const state = initialState.update({
      effects: setTableCellRangeSelection.of({
        anchorColumn: 2,
        anchorRowFrom: rows[2]!.from,
        headColumn: 1,
        headRowFrom: rows[0]!.from,
        tableFrom: table.from,
        tableTo: table.to,
      }),
    }).state

    expect(tableCellRangeSelectionSnapshot(state)).toEqual({
      cells: [
        ["Heading Two", "Heading Three"],
        ["two", "three"],
        ["five", ""],
      ],
      columnCount: 2,
      includesHeader: true,
      rowCount: 3,
      text: [
        "| Heading Two | Heading Three |",
        "| --- | --- |",
        "| two | three |",
        "| five |  |",
      ].join("\n"),
    })
  })

  test("serializes portable Markdown and parses it back as cell data", () => {
    const cells = [
      ["First", "Second"],
      ["one", String.raw`two \| three`],
    ]
    const markdown = markdownTableClipboardText(cells)

    expect(markdown).toBe(
      [
        "| First | Second |",
        "| --- | --- |",
        String.raw`| one | two \| three |`,
      ].join("\n")
    )
    expect(parseTableClipboardText(markdown)).toEqual({
      cells,
      columnCount: 2,
    })
  })

  test("accepts tabular clipboard text without mistaking its first row for metadata", () => {
    expect(parseTableClipboardText("one\ttwo\t\nthree\tfour\t")).toEqual({
      cells: [
        ["one", "two", ""],
        ["three", "four", ""],
      ],
      columnCount: 3,
    })
    expect(parseTableClipboardText("ordinary pasted text")).toBeNull()
  })

  test("matches GFM delimiter widths and ignores excess body cells", () => {
    expect(
      parseTableClipboardText(
        ["| A | B |", "| :-: | - |", "| one | two | excess |"].join("\n")
      )
    ).toEqual({
      cells: [
        ["A", "B"],
        ["one", "two"],
      ],
      columnCount: 2,
    })
    expect(
      parseTableClipboardText(["| A | B |", "| - |"].join("\n"))
    ).toBeNull()
  })
})
