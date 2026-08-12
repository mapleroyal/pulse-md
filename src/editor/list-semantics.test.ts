import { markdown } from "@codemirror/lang-markdown"
import { indentUnit, syntaxTree } from "@codemirror/language"
import { insertNewlineAndIndent } from "@codemirror/commands"
import { EditorSelection, EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, test, vi } from "vitest"

import { applyMarkdownFormatting } from "./formatting"
import {
  createMarkdownParserExtensions,
  markdownBaseLanguage,
} from "./markdown-extensions"
import {
  deleteListMarkupBackward,
  dedentListItems,
  indentListItems,
  insertNewlineContinueList,
  insertNewlineExitList,
  selectionIsInListItem,
} from "./list-editing"

function editor(doc: string, anchor = 0, head = anchor) {
  let state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [
      markdown({
        base: markdownBaseLanguage,
        extensions: createMarkdownParserExtensions(),
      }),
      EditorState.allowMultipleSelections.of(true),
      indentUnit.of("    "),
    ],
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
    get doc() {
      return state.doc.toString()
    },
    select(anchorPosition: number, headPosition = anchorPosition) {
      state = state.update({
        selection: EditorSelection.single(anchorPosition, headPosition),
      }).state
    },
    selectMany(positions: readonly number[], mainIndex = 0) {
      state = state.update({
        selection: EditorSelection.create(
          positions.map((position) => EditorSelection.cursor(position)),
          mainIndex
        ),
      }).state
    },
    selectRanges(
      ranges: ReadonlyArray<readonly [anchor: number, head: number]>,
      mainIndex = 0
    ) {
      state = state.update({
        selection: EditorSelection.create(
          ranges.map(([rangeAnchor, rangeHead]) =>
            EditorSelection.range(rangeAnchor, rangeHead)
          ),
          mainIndex
        ),
      }).state
    },
    view,
  }
}

function listItemDepthAt(state: EditorState, position: number) {
  let depth = 0
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1)
  while (node) {
    if (node.name === "ListItem") depth += 1
    node = node.parent
  }
  return depth
}

describe("list formatting semantics", () => {
  test.each([
    ["bullet-list", "- task"],
    ["ordered-list", "1. task"],
    ["task-list", "task"],
  ] as const)(
    "replaces the complete ordered-task prefix with %s formatting",
    (type, expected) => {
      const source = "1. [x] task"
      const harness = editor(source, source.length)

      expect(applyMarkdownFormatting(harness.view, { type })).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("reuses an existing child branch's authored tab indentation", () => {
    const source = "- parent\n\t- existing\n- candidate"
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("- parent\n\t- existing\n\t- candidate")
    expect(
      listItemDepthAt(harness.view.state, harness.doc.indexOf("candidate"))
    ).toBe(2)
  })

  test.each([
    ["forward", 6, 11],
    ["backward", 11, 6],
  ])(
    "replaces a %s companion selection while continuing a list caret",
    (_direction, anchor, head) => {
      const source = "- one\nplain"
      const harness = editor(source)
      harness.selectRanges(
        [
          [source.indexOf("\n"), source.indexOf("\n")],
          [anchor, head],
        ],
        1
      )

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe("- one\n- \n\n")
      expect(
        harness.view.state.selection.ranges.map((range) => range.head)
      ).toEqual([8, 10])
      expect(harness.view.state.selection.mainIndex).toBe(1)
    }
  )

  test.each([
    ["lowercase alphabetic", "h. PARENT\ni. CHILD"],
    ["uppercase Roman", "IX.  PARENT\nX.  CHILD"],
    ["quoted alphabetic", "> h. PARENT\n> i. CHILD"],
    ["alphabetic inside a bullet", "- wrapper\n  h. PARENT\n  i. CHILD"],
  ])(
    "restores the destination %s sequence after an indent/dedent round trip",
    (_kind, source) => {
      const harness = editor(source, source.indexOf("CHILD") + 1)
      const initialDepth = listItemDepthAt(
        harness.view.state,
        harness.doc.indexOf("CHILD")
      )

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).not.toBe(source)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("CHILD"))
      ).toBe(initialDepth + 1)

      expect(dedentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(source)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("CHILD"))
      ).toBe(initialDepth)
    }
  )

  test("restores every selected sibling in an ambiguous destination sequence", () => {
    const source = "h. PARENT\ni. FIRST\nj. SECOND"
    const harness = editor(source, source.indexOf("FIRST"), source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("h. PARENT\n   a. FIRST\n   j. SECOND")

    expect(dedentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(source)
  })

  test.each([
    ["alphabetic", "a. one\nplain", "a. one\nb. \nplain\n"],
    ["decimal", "1. one\nplain", "1. one\n2. \nplain\n"],
    ["bullet", "- one\nplain", "- one\n- \nplain\n"],
  ])(
    "continues a %s list while a second Enter caret handles plain text",
    (_kind, source, expected) => {
      const firstEnd = source.indexOf("\n")
      const harness = editor(source)
      harness.selectMany([firstEnd, source.length], 1)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      const insertedListEnd = expected.indexOf("\n", firstEnd + 1)
      expect(
        harness.view.state.selection.ranges.map((range) => range.head)
      ).toEqual([insertedListEnd, expected.length])
    }
  )

  test("does not duplicate a checkbox when formatting a fancy ordered task", () => {
    const source = "a) [ ] task"
    const harness = editor(source, source.length)

    expect(applyMarkdownFormatting(harness.view, { type: "task-list" })).toBe(
      true
    )
    expect(harness.doc).toBe("task")
  })

  test("converts a proven multi-letter alphabetic marker as one list item", () => {
    const source = "z. first\naa. second"
    const harness = editor(source, source.indexOf("second"))

    expect(applyMarkdownFormatting(harness.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(harness.doc).toBe("z. first\n- second")
  })

  test("scopes a final-item toolbar conversion in a very large document", () => {
    const prefix = "ordinary prose\n".repeat(200_000)
    const source = `${prefix}- target`
    const harness = editor(source, source.length)
    const lineLookup = vi.spyOn(harness.view.state.doc, "line")

    expect(
      applyMarkdownFormatting(harness.view, { type: "ordered-list" })
    ).toBe(true)
    expect(lineLookup.mock.calls.length).toBeLessThan(100)
    expect(harness.doc.endsWith("1. target")).toBe(true)
  })

  test("converts a cursor's complete subtree and preserves nested numbering", () => {
    const source = [
      "- first",
      "  - child",
      "    continuation",
      "  - second child",
      "- outside",
    ].join("\n")
    const harness = editor(source, source.indexOf("first") + 2)

    applyMarkdownFormatting(harness.view, { type: "ordered-list" })

    expect(harness.doc).toBe(
      [
        "1. first",
        "   1. child",
        "      continuation",
        "   2. second child",
        "- outside",
      ].join("\n")
    )
  })

  test("round-trips marker-width changes and removes a complete subtree", () => {
    const harness = editor("- parent\n  - child", 3)

    applyMarkdownFormatting(harness.view, { type: "task-list" })
    expect(harness.doc).toBe("- [ ] parent\n  - [ ] child")

    applyMarkdownFormatting(harness.view, { type: "bullet-list" })
    expect(harness.doc).toBe("- parent\n  - child")

    applyMarkdownFormatting(harness.view, { type: "bullet-list" })
    expect(harness.doc).toBe("parent\nchild")
  })

  test("numbers each nested branch independently across a selection", () => {
    const source = ["- first", "  - child", "- second", "  - other child"].join(
      "\n"
    )
    const harness = editor(source, 0, source.length)

    applyMarkdownFormatting(harness.view, { type: "ordered-list" })

    expect(harness.doc).toBe(
      ["1. first", "   1. child", "2. second", "   1. other child"].join("\n")
    )
  })

  test("inserts markers after quote prefixes and preserves plain indentation", () => {
    const quoted = editor("> alpha", 2)
    applyMarkdownFormatting(quoted.view, { type: "bullet-list" })
    expect(quoted.doc).toBe("> - alpha")

    const source = "  alpha\n    beta"
    const indented = editor(source, 0, source.length)
    applyMarkdownFormatting(indented.view, { type: "ordered-list" })
    expect(indented.doc).toBe("  1. alpha\n       1. beta")
  })

  test("converts a large selected list without changing its item order", () => {
    const source = Array.from(
      { length: 2_000 },
      (_, index) => `- item ${index}`
    ).join("\n")
    const harness = editor(source, 0, source.length)

    applyMarkdownFormatting(harness.view, { type: "ordered-list" })

    const lines = harness.doc.split("\n")
    expect(lines).toHaveLength(2_000)
    expect(lines[0]).toBe("1. item 0")
    expect(lines.at(-1)).toBe("2000. item 1999")
  })

  test("converts more list items than an argument spread can hold", () => {
    const itemCount = 140_000
    const source = Array.from(
      { length: itemCount },
      (_, index) => `- item ${index}`
    ).join("\n")
    const harness = editor(source, 0, source.length)

    expect(applyMarkdownFormatting(harness.view, { type: "task-list" })).toBe(
      true
    )
    const lines = harness.doc.split("\n")
    expect(lines).toHaveLength(itemCount)
    expect(lines[0]).toBe("- [ ] item 0")
    expect(lines.at(-1)).toBe(`- [ ] item ${itemCount - 1}`)
  }, 20_000)
})

describe("live list indentation semantics", () => {
  test("does not HTML-indent prose ending in slash-separated tag references", () => {
    const source = [
      "However, your concern about completeness is justified. Broader exploratory testing today found real gaps that the green test suite didn’t cover:",
      "Literal text such as &lt;em&gt;literal&lt;/em&gt; can become raw HTML rather than remaining visibly literal.",
      "Nested bold/italic style resets can be lost.",
      "Captions, row spans, and multiple header rows can produce malformed or misaligned tables instead of degrading gracefully.",
      "<details>/<summary> content can be concatenated incorrectly.",
    ].join("\n")
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(`${source}\n`)
    expect(harness.view.state.selection.main.head).toBe(source.length + 1)
  })

  test("retains normal Enter indentation for deliberately nested raw HTML", () => {
    const source = "<details><summary>content"
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(false)
    expect(insertNewlineAndIndent(harness.view)).toBe(true)
    expect(harness.doc).toBe(`${source}\n    `)
  })

  test.each([
    ["- bullet", "- bullet\n- "],
    ["+ bullet", "+ bullet\n+ "],
    ["* bullet", "* bullet\n* "],
    ["- parent\n  - child", "- parent\n  - child\n  - "],
    ["- [ ] task", "- [ ] task\n- [ ] "],
    ["- [x] done", "- [x] done\n- [ ] "],
    ["+  [X]\tdone", "+  [X]\tdone\n+  [ ]\t"],
    ["- [ ] parent\n  - [ ] child", "- [ ] parent\n  - [ ] child\n  - [ ] "],
    ["- [ ] parent\n  - [x] done", "- [ ] parent\n  - [x] done\n  - [ ] "],
    ["- [ ] parent\n  - child", "- [ ] parent\n  - child\n  - "],
    ["9. ordered", "9. ordered\n10. "],
    ["9) ordered", "9) ordered\n10) "],
    ["1. [ ] task", "1. [ ] task\n2. [ ] "],
    ["9) [x] done", "9) [x] done\n10) [ ] "],
    ["- parent\n  1. child", "- parent\n  1. child\n  2. "],
    ["- [ ] parent\n  1. child", "- [ ] parent\n  1. child\n  2. "],
    ["> - bullet", "> - bullet\n> - "],
    ["> - [x] done", "> - [x] done\n> - [ ] "],
    ["> 9. ordered", "> 9. ordered\n> 10. "],
    ["> - parent\n>   - child", "> - parent\n>   - child\n>   - "],
  ])("continues %s at the authored list depth", (source, expected) => {
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(expected)
  })

  test.each([
    ["decimal", "9. \tparent", "9. \tparent\n10. "],
    ["decimal task", "9. \t[ ] parent", "9. \t[ ] parent\n10. [ ] "],
    ["alphabetic", "z. \tparent", "z. \tparent\naa. "],
    [
      "quoted decimal task",
      ">   9. \t[ ] parent",
      ">   9. \t[ ] parent\n>   10. [ ] ",
    ],
  ])(
    "keeps %s continuation padding inside CommonMark's structural range",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.length - 1)
      ).toBeGreaterThan(0)
    }
  )

  test.each([
    [
      "first decimal width boundary",
      "8. before\n9.\t   code",
      "8. before\n9. \n10.     code",
    ],
    [
      "second decimal width boundary",
      "98. before\n99. \tcode",
      "98. before\n99. \n100.     code",
    ],
    [
      "quoted checkbox-looking code",
      "> 8. before\n> 9.\t [ ] code",
      "> 8. before\n> 9. \n> 10.     [ ] code",
    ],
  ])(
    "keeps non-structural padding non-structural across %s",
    (_kind, source, expected) => {
      const firstLineEnd = source.indexOf("\n")
      const harness = editor(source, firstLineEnd)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      const tree = syntaxTree(harness.view.state).toString()
      expect(tree).toContain("CodeBlock")
      expect(tree).not.toContain("TaskMarker")
    }
  )

  test.each([
    ["Enter", "8. before\n9. \n10.\t   text", "8. before\n\n9.    text"],
    ["Backspace", "8. before\n9. \n10.\t   text", "8. before\n   \n9.    text"],
    [
      "quoted Enter task",
      "> 8. before\n> 9. \n> 10.\t [ ] task",
      "> 8. before\n> \n> 9.    [ ] task",
    ],
  ])(
    "keeps structural padding structural when shrinking with %s",
    (action, source, expected) => {
      const emptyEnd = source.indexOf("\n", source.indexOf("\n") + 1)
      const harness = editor(source, emptyEnd)

      expect(
        action.includes("Backspace")
          ? deleteListMarkupBackward(harness.view)
          : insertNewlineContinueList(harness.view)
      ).toBe(true)
      expect(harness.doc).toBe(expected)
      const tree = syntaxTree(harness.view.state).toString()
      expect(tree).not.toContain("CodeBlock")
      if (action.includes("task")) expect(tree).toContain("TaskMarker")
    }
  )

  test.each([
    ["zero-valued decimal", "0. zero", "0. zero\n1. "],
    ["decimal", "999999999. item", "999999999. item\n"],
    [
      "quoted decimal task",
      "> 999999999. [ ] item",
      "> 999999999. [ ] item\n> ",
    ],
  ])(
    "ends a %s sequence before its marker becomes invalid",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(harness.view.state.selection.main.head).toBe(expected.length)
    }
  )

  test("uses an ordinary line rather than overflowing a following decimal marker", () => {
    const source = "999999998. before\n999999999. after"
    const expected = "999999998. before\n\n999999999. after"
    const harness = editor(source, source.indexOf("before") + "before".length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(expected)
    expect(harness.view.state.selection.main.head).toBe(
      expected.indexOf("\n\n") + 1
    )
  })

  test.each([
    ["upper Roman", "IX. item", "IX. item\nX.  "],
    ["quoted upper Roman task", "> IX. [ ] item", "> IX. [ ] item\n> X.  [ ] "],
  ])(
    "keeps a generated single-letter %s marker unambiguous",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.length - 1)
      ).toBeGreaterThan(0)
    }
  )

  test.each([
    ["five spaces", "-     [ ] parent", "-     [ ] parent\n-     "],
    ["two tabs", "-\t\t[ ] parent", "-\t\t[ ] parent\n-\t\t"],
    [
      "five spaces after an ordered marker",
      "1.     [ ] parent",
      "1.     [ ] parent\n2.     ",
    ],
    [
      "two tabs after an ordered marker",
      "1.\t\t[ ] parent",
      "1.\t\t[ ] parent\n2.\t\t",
    ],
    [
      "five spaces after an alphabetic marker",
      "a.     [ ] parent",
      "a.     [ ] parent\nb.     ",
    ],
  ])(
    "does not invent a GFM checkbox after %s of non-structural padding",
    (_padding, source, expected) => {
      const harness = editor(source, source.length)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(syntaxTree(harness.view.state).toString()).not.toContain(
        "TaskMarker"
      )
    }
  )

  test("does not renumber quote-like text inside an indented code block", () => {
    const source = ">1. real\n\n\t>2. code\n\n>2. real"
    const harness = editor(source, source.indexOf("real") + "real".length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(">1. real\n>2. \n\n\t>2. code\n\n>2. real")
  })

  test.each([
    ["decimal", "1. a\n2. b", "1. a\n2. \n3. b\n4. "],
    ["alphabetic", "a. a\nb. b", "a. a\nb. \nc. b\nd. "],
    [
      "ordered task",
      "1. [x] a\n2. [ ] b",
      "1. [x] a\n2. [ ] \n3. [ ] b\n4. [ ] ",
    ],
  ])(
    "renumbers a %s family coherently for multiple Enter carets",
    (_kind, source, expected) => {
      const firstEnd = source.indexOf("\n")
      const harness = editor(source)
      harness.selectMany([firstEnd, source.length], 1)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      const secondLineEnd = expected.indexOf("\n", expected.indexOf("\n") + 1)
      expect(
        harness.view.state.selection.ranges.map((range) => range.head)
      ).toEqual([secondLineEnd, expected.length])
      expect(harness.view.state.selection.mainIndex).toBe(1)
    }
  )

  test.each([
    ["bullet", "- parent\n  > - ", "- parent\n  > "],
    ["decimal", "- parent\n  > 1. ", "- parent\n  > "],
    ["alphabetic", "1. parent\n   > a. ", "1. parent\n   > "],
  ])(
    "exits a root %s list without crossing its item-owned blockquote",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(harness.view.state.selection.main.head).toBe(expected.length)
    }
  )

  test.each([
    ["- alpha beta", "alpha", "- alpha\n-  beta"],
    ["- [x] alpha beta", "alpha", "- [x] alpha\n- [ ]  beta"],
    ["9. alpha beta", "alpha", "9. alpha\n10.  beta"],
    ["> - alpha beta", "alpha", "> - alpha\n> -  beta"],
  ])(
    "splits %s into a same-level item when Enter is pressed mid-content",
    (source, beforeCursor, expected) => {
      const harness = editor(
        source,
        source.indexOf(beforeCursor) + beforeCursor.length
      )

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    ["- ", ""],
    ["- [ ] ", ""],
    ["1. ", ""],
    ["1. [ ] ", ""],
    ["- parent\n  - ", "- parent\n- "],
    ["- [ ] parent\n  - [ ] ", "- [ ] parent\n- [ ] "],
    ["- parent\n  - [ ] ", "- parent\n- "],
    ["- [ ] parent\n  1. first\n  2. ", "- [ ] parent\n  1. first\n- [ ] "],
    ["1. parent\n   - [ ] ", "1. parent\n2. "],
    ["1. parent\n   1. ", "1. parent\n2. "],
    ["1. parent\n   1. [ ] ", "1. parent\n2. "],
    ["a. parent\n   i. [ ] ", "a. parent\nb. "],
    ["> - parent\n>   - ", "> - parent\n> - "],
  ])("exits one empty list level for %s", (source, expected) => {
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(expected)
  })

  test("removes trailing content whitespace before continuing the marker", () => {
    const source = "- item  "
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("- item\n- ")
  })

  test.each([
    ["a. alpha", "b. "],
    ["A. alpha", "B. "],
    ["iv. roman", "v. "],
    ["IV) roman", "V) "],
    ["a. [x] alpha", "b. [ ] "],
    ["iv) [X] roman", "v) [ ] "],
  ])("continues an authored fancy marker: %s", (item, continuation) => {
    const source = `1. parent\n   ${item}`
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(`${source}\n   ${continuation}`)
  })

  test("uses same-depth siblings to disambiguate alphabetic i", () => {
    const source = ["1. parent", "   h. eight", "   i. nine"].join("\n")
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(`${source}\n   j. `)
  })

  test("continues proven uppercase and multi-letter alphabetic sequences", () => {
    const uppercase = "1. parent\n   A. first\n   B. second"
    const uppercaseHarness = editor(uppercase, uppercase.length)
    expect(insertNewlineContinueList(uppercaseHarness.view)).toBe(true)
    expect(uppercaseHarness.doc).toBe(`${uppercase}\n   C. `)

    const rollover = editor("z. last", 7)
    expect(insertNewlineContinueList(rollover.view)).toBe(true)
    expect(rollover.doc).toBe("z. last\naa. ")
    rollover.view.dispatch({
      changes: { from: rollover.doc.length, insert: "next" },
      selection: { anchor: rollover.doc.length + 4 },
      userEvent: "input.type",
    })
    expect(insertNewlineContinueList(rollover.view)).toBe(true)
    expect(rollover.doc).toBe("z. last\naa. next\nab. ")
  })

  test("renumbers sequential fancy siblings around an inserted item", () => {
    const source = ["1. parent", "   h. eight", "   i. nine", "   j. ten"].join(
      "\n"
    )
    const firstEnd = source.indexOf("eight") + "eight".length
    const harness = editor(source, firstEnd)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      ["1. parent", "   h. eight", "   i. ", "   j. nine", "   k. ten"].join(
        "\n"
      )
    )
  })

  test("renumbers mixed plain and task ordered siblings", () => {
    const source = ["1. [x] done", "2. [ ] next", "3. plain"].join("\n")
    const harness = editor(source, "1. [x] done".length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      ["1. [x] done", "2. [ ] ", "3. [ ] next", "4. plain"].join("\n")
    )
  })

  test.each([
    [
      "decimal",
      [
        "8. before",
        "9. target",
        "   continuation",
        "   - child",
        "     child continuation",
        "   > nested quote",
        "   >",
        "   > more",
      ].join("\n"),
      [
        "8. before",
        "9. ",
        "10. target",
        "    continuation",
        "    - child",
        "      child continuation",
        "    > nested quote",
        "    >",
        "    > more",
      ].join("\n"),
    ],
    [
      "alphabetic",
      ["y. before", "z. target", "   continuation", "   - child"].join("\n"),
      [
        "y. before",
        "z. ",
        "aa. target",
        "    continuation",
        "    - child",
      ].join("\n"),
    ],
    [
      "quoted ordered task",
      [
        "> 8. [x] before",
        "> 9. [ ] target",
        ">    continuation",
        ">    - child",
        ">    > nested quote",
      ].join("\n"),
      [
        "> 8. [x] before",
        "> 9. [ ] ",
        "> 10. [ ] target",
        ">     continuation",
        ">     - child",
        ">     > nested quote",
      ].join("\n"),
    ],
  ])(
    "keeps a %s sibling branch nested when Enter grows its ordered marker",
    (_kind, source, expected) => {
      const firstLineEnd = source.indexOf("\n")
      const harness = editor(source, firstLineEnd)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    [
      "alphabetic",
      ["y. before", "z. ", "aa. target", "    continuation"].join("\n"),
      ["y. before", "", "z. target", "   continuation"].join("\n"),
    ],
    [
      "alphabetic ordered task",
      ["y. [x] before", "z. [ ] ", "aa. [ ] target", "    continuation"].join(
        "\n"
      ),
      ["y. [x] before", "", "z. [ ] target", "   continuation"].join("\n"),
    ],
  ])(
    "keeps a %s sibling branch nested when empty-item Enter shrinks its marker",
    (_kind, source, expected) => {
      const emptyItemEnd = source.indexOf("\n", source.indexOf("\n") + 1)
      const harness = editor(source, emptyItemEnd)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("does not invent decimal zero-padding when an empty item closes a gap", () => {
    const source = "8. BEFORE\n9. \n10. FOLLOWING"
    const emptyEnd = source.indexOf("\n", source.indexOf("\n") + 1)
    const harness = editor(source, emptyEnd)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("8. BEFORE\n\n9. FOLLOWING")
  })

  test.each([
    [
      "Enter",
      "8. BEFORE\n9. \n10. FOLLOWING\n    -\tCHILD\n        - GRANDCHILD",
      "8. BEFORE\n\n9. FOLLOWING\n   -\tCHILD\n        - GRANDCHILD",
    ],
    [
      "Backspace",
      "8. BEFORE\n9. \n10. FOLLOWING\n    -\tCHILD\n        - GRANDCHILD",
      "8. BEFORE\n   \n9. FOLLOWING\n   -\tCHILD\n        - GRANDCHILD",
    ],
    [
      "quoted Enter",
      "> 8. BEFORE\n> 9. \n> 10. FOLLOWING\n>     -\tCHILD\n>         - GRANDCHILD",
      "> 8. BEFORE\n> \n> 9. FOLLOWING\n>    -\tCHILD\n>         - GRANDCHILD",
    ],
  ])(
    "preserves every descendant lane through ordered shrink with %s",
    (action, source, expected) => {
      const emptyEnd = source.indexOf("\n", source.indexOf("\n") + 1)
      const harness = editor(source, emptyEnd)

      expect(
        action.includes("Backspace")
          ? deleteListMarkupBackward(harness.view)
          : insertNewlineContinueList(harness.view)
      ).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("GRANDCHILD"))
      ).toBe(3)
    }
  )

  test("keeps a renumbered single-letter upper Roman sibling unambiguous", () => {
    const source = "VIII. before\nIX. after"
    const harness = editor(source, source.indexOf("\n"))

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("VIII. before\nIX. \nX.  after")
    expect(
      listItemDepthAt(harness.view.state, harness.doc.indexOf("after"))
    ).toBe(1)
  })

  test("removes an empty ordered task and closes its numbering gap", () => {
    const source = ["1. [x] done", "2. [ ] ", "3. [ ] later"].join("\n")
    const emptyEnd = source.indexOf("2. [ ] ") + "2. [ ] ".length
    const harness = editor(source, emptyEnd)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(["1. [x] done", "", "2. [ ] later"].join("\n"))
  })

  test("renumbers every sequential sibling beyond the former scan cap", () => {
    const itemCount = 2_100
    const source = Array.from(
      { length: itemCount },
      (_, index) => `${index + 1}. item ${index + 1}`
    ).join("\n")
    const firstLine = "1. item 1"
    const harness = editor(source, firstLine.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    const lines = harness.doc.split("\n")
    expect(lines).toHaveLength(itemCount + 1)
    expect(lines.slice(0, 3)).toEqual([firstLine, "2. ", "3. item 2"])
    expect(lines.at(-1)).toBe(`${itemCount + 1}. item ${itemCount}`)
  })

  test.each([
    ["bullet", "- first\n\n- second", "- first\n\n- second\n- "],
    [
      "task",
      "- [x] first\n\n- [ ] second",
      "- [x] first\n\n- [ ] second\n- [ ] ",
    ],
    ["ordered", "1. first\n\n2. second", "1. first\n\n2. second\n3. "],
    [
      "quoted nested",
      "> - parent\n>   - first\n>\n>   - second",
      "> - parent\n>   - first\n>\n>   - second\n>   - ",
    ],
  ])(
    "continues a %s list without copying old blank separators",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("defaults a newly started i marker to Roman", () => {
    const source = "1. parent\n   i. first"
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(`${source}\n   ii. `)
  })

  test("lifts mixed marker families one structural level at a time", () => {
    const decimalParent = editor("1. parent\n   a. ", 16)
    expect(insertNewlineContinueList(decimalParent.view)).toBe(true)
    expect(decimalParent.doc).toBe("1. parent\n2. ")

    const alphaParent = editor("a. parent\n   1. ", 16)
    expect(insertNewlineContinueList(alphaParent.view)).toBe(true)
    expect(alphaParent.doc).toBe("a. parent\nb. ")

    expect(insertNewlineContinueList(alphaParent.view)).toBe(true)
    expect(alphaParent.doc).toBe("a. parent\n")
  })

  test("renumbers the parent branch after lifting an empty child", () => {
    const source = ["a. first", "   i. ", "b. second"].join("\n")
    const childEnd = source.indexOf("i. ") + 3
    const harness = editor(source, childEnd)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(["a. first", "b. ", "c. second"].join("\n"))
  })

  test("indents and dedents adjacent fancy list items semantically", () => {
    const source = "a. parent\nb. child"
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("a. parent\n   b. child")
    expect(dedentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(source)
  })

  test("indents a loose fancy sibling across an all-blank gap", () => {
    const source = "a. parent\n\nb. child"
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("a. parent\n\n   b. child")
  })

  test("renumbers past an unindented lazy continuation", () => {
    const source = "a. first\nlazy continuation\nb. second"
    const harness = editor(source, "a. first".length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("a. first\nb. \nlazy continuation\nc. second")

    const markerLike = "a. first\nmix. flour\nb. second"
    const markerLikeHarness = editor(markerLike, "a. first".length)
    expect(insertNewlineContinueList(markerLikeHarness.view)).toBe(true)
    expect(markerLikeHarness.doc).toBe("a. first\nb. \nmix. flour\nc. second")
  })

  test("removes an empty fancy marker at its authored content column", () => {
    const source = ["a. one", "b. ", "c. three"].join("\n")
    const markerEnd = source.indexOf("b. ") + 3
    const harness = editor(source, markerEnd)

    expect(deleteListMarkupBackward(harness.view)).toBe(true)
    expect(harness.doc).toBe(["a. one", "   ", "b. three"].join("\n"))
  })

  test("preserves authored decimal zero-padding when Backspace closes a gap", () => {
    const source = "008. before\n009. \n010. after"
    const emptyEnd = source.indexOf("\n", source.indexOf("\n") + 1)
    const harness = editor(source, emptyEnd)

    expect(deleteListMarkupBackward(harness.view)).toBe(true)
    expect(harness.doc).toBe("008. before\n     \n009. after")
  })

  test.each([
    ["uppercase alphabetic", "A.  ", "    "],
    ["uppercase Roman", "IX. before\nX.  ", "IX. before\n    "],
  ])(
    "removes an empty %s marker with valid root padding",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(deleteListMarkupBackward(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    [
      "decimal",
      ["8. one", "9. ", "10. target", "    continuation"].join("\n"),
      ["8. one", "   ", "9. target", "   continuation"].join("\n"),
      "9. ",
    ],
    [
      "alphabetic",
      ["y. one", "z. ", "aa. target", "    continuation"].join("\n"),
      ["y. one", "   ", "z. target", "   continuation"].join("\n"),
      "z. ",
    ],
    [
      "alphabetic ordered task",
      ["y. [x] one", "z. [ ] ", "aa. [ ] target", "    continuation"].join(
        "\n"
      ),
      ["y. [x] one", "       ", "z. [ ] target", "   continuation"].join("\n"),
      "z. [ ] ",
    ],
  ])(
    "keeps the %s sibling branch nested when Backspace shrinks its marker",
    (_kind, source, expected, emptyItem) => {
      const markerEnd = source.indexOf(emptyItem) + emptyItem.length
      const harness = editor(source, markerEnd)

      expect(deleteListMarkupBackward(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    [
      "decimal",
      ["1. one", "2. [ ] ", "3. three"].join("\n"),
      ["1. one", "       ", "2. three"].join("\n"),
      "2. [ ] ",
    ],
    [
      "fancy",
      ["a. one", "b. [x] ", "c. three"].join("\n"),
      ["a. one", "       ", "b. three"].join("\n"),
      "b. [x] ",
    ],
  ])(
    "removes empty %s ordered-task markup and renumbers siblings",
    (_kind, source, expected, emptyItem) => {
      const markerEnd = source.indexOf(emptyItem) + emptyItem.length
      const harness = editor(source, markerEnd)

      expect(deleteListMarkupBackward(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("does not reinterpret ordinary words or initials as fancy lists", () => {
    const word = editor("hello. world", 0)
    expect(selectionIsInListItem(word.view.state)).toBe(false)

    const initial = editor("B. Russell won", 0)
    expect(selectionIsInListItem(initial.view.state)).toBe(false)

    const explicitCapital = editor("B.  deliberate item", 0)
    expect(selectionIsInListItem(explicitCapital.view.state)).toBe(true)

    for (const source of [
      "mix. flour",
      "A. Smith\nB. Russell",
      "A. first\nB. second",
    ]) {
      const harness = editor(source, source.length)
      expect(selectionIsInListItem(harness.view.state), source).toBe(false)
      expect(insertNewlineContinueList(harness.view), source).toBe(false)
      expect(harness.doc).toBe(source)
    }

    for (const source of [
      "1. recipe\n   mix. flour",
      "1. people\n   B. Russell wrote",
    ]) {
      const harness = editor(source, source.length)
      expect(insertNewlineContinueList(harness.view), source).toBe(true)
      expect(harness.doc).toBe(`${source}\n   `)
    }
  })

  test("does not prove a sequence across a different Markdown block", () => {
    for (const source of [
      "z. last\n# heading\naa. prose",
      "z. last\n- bullet\naa. prose",
      "z. last\n```\ncode\n```\naa. prose",
      "z. last\n| h |\n| --- |\n| c |\naa. prose",
      "1. parent\n   A. person\n   # heading\n   B. Russell",
    ]) {
      const harness = editor(source, source.length)
      insertNewlineContinueList(harness.view)
      expect(harness.doc, source).not.toMatch(/\n(?:ab|C)\. $/)
    }
  })

  test("formatting does not strip an indented prose initial", () => {
    const ordered = editor(" B. Russell", 5)
    expect(
      applyMarkdownFormatting(ordered.view, { type: "ordered-list" })
    ).toBe(true)
    expect(ordered.doc).toBe(" 1. B. Russell")

    const bullet = editor(" B. Russell", 5)
    expect(applyMarkdownFormatting(bullet.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(bullet.doc).toBe(" - B. Russell")
  })

  test("rejects Tab in large ordinary prose before building a list model", () => {
    const source = `${"ordinary prose\n".repeat(349_999)}ordinary prose`
    const harness = editor(source, source.length)
    const lineLookup = vi.spyOn(harness.view.state.doc, "line")

    expect(indentListItems(harness.view)).toBe(false)
    // Building the document-wide fallback model calls `doc.line` once per
    // source line. The plain-prose preflight must reject before that work.
    expect(lineLookup).not.toHaveBeenCalled()
    expect(harness.doc).toBe(source)
  })

  test("resolves Tab locally for a final list item in a very large document", () => {
    const prefix = "ordinary prose\n".repeat(200_000)
    const source = `${prefix}- parent\n- child`
    const harness = editor(source, source.length)
    const lineLookup = vi.spyOn(harness.view.state.doc, "line")

    expect(indentListItems(harness.view)).toBe(true)
    expect(lineLookup.mock.calls.length).toBeLessThan(100)
    expect(harness.doc.endsWith("- parent\n  - child")).toBe(true)
  })

  test("restores ordered siblings when an inserted marker becomes a bullet", () => {
    const source = [
      "1. First step",
      "2. Second step",
      "   1. Sub-step 2a",
      "   2. Sub-step 2b",
      "3. Third step",
    ].join("\n")
    const subStepEnd = source.indexOf("Sub-step 2a") + "Sub-step 2a".length
    const harness = editor(source, subStepEnd)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      [
        "1. First step",
        "2. Second step",
        "   1. Sub-step 2a",
        "   2. ",
        "   3. Sub-step 2b",
        "3. Third step",
      ].join("\n")
    )

    expect(deleteListMarkupBackward(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      [
        "1. First step",
        "2. Second step",
        "   1. Sub-step 2a",
        "      ",
        "   2. Sub-step 2b",
        "3. Third step",
      ].join("\n")
    )

    expect(applyMarkdownFormatting(harness.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(harness.doc).toBe(
      [
        "1. First step",
        "2. Second step",
        "   1. Sub-step 2a",
        "      - ",
        "   2. Sub-step 2b",
        "3. Third step",
      ].join("\n")
    )
  })

  test("retains an authored two-space content indent when removing a marker", () => {
    const source = [
      "1.  First step",
      "2.  Second step",
      "    1.  Sub-step 2a",
      "    2.  Sub-step 2b",
      "3.  Third step",
    ].join("\n")
    const subStepEnd = source.indexOf("Sub-step 2a") + "Sub-step 2a".length
    const harness = editor(source, subStepEnd)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      [
        "1.  First step",
        "2.  Second step",
        "    1.  Sub-step 2a",
        "    2.  ",
        "    3.  Sub-step 2b",
        "3.  Third step",
      ].join("\n")
    )

    expect(deleteListMarkupBackward(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      [
        "1.  First step",
        "2.  Second step",
        "    1.  Sub-step 2a",
        "    2. ",
        "    3.  Sub-step 2b",
        "3.  Third step",
      ].join("\n")
    )

    expect(deleteListMarkupBackward(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      [
        "1.  First step",
        "2.  Second step",
        "    1.  Sub-step 2a",
        "        ",
        "    2.  Sub-step 2b",
        "3.  Third step",
      ].join("\n")
    )

    expect(applyMarkdownFormatting(harness.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(harness.doc).toBe(
      [
        "1.  First step",
        "2.  Second step",
        "    1.  Sub-step 2a",
        "        - ",
        "    2.  Sub-step 2b",
        "3.  Third step",
      ].join("\n")
    )
  })

  test("exits every empty nested level without swallowing the next Enter", () => {
    const source = [
      "- one",
      "  - two",
      "    - three",
      "      - four",
      "        - five",
      "          - six",
    ].join("\n")
    const harness = editor(source, source.length)
    const finalLines = []

    for (let press = 0; press < 7; press += 1) {
      expect(insertNewlineContinueList(harness.view)).toBe(true)
      finalLines.push(harness.doc.split("\n").at(-1))
    }

    expect(finalLines).toEqual([
      "          - ",
      "        - ",
      "      - ",
      "    - ",
      "  - ",
      "- ",
      "",
    ])
    expect(insertNewlineContinueList(harness.view)).toBe(false)
  })

  test("a second Enter at the start of split content exits the list", () => {
    const source = [
      "List:",
      "- item 1",
      "- item 2",
      "- item 3 additional content",
    ].join("\n")
    const harness = editor(source, source.indexOf("additional content"))

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      [
        "List:",
        "- item 1",
        "- item 2",
        "- item 3",
        "- additional content",
      ].join("\n")
    )
    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      ["List:", "- item 1", "- item 2", "- item 3", "additional content"].join(
        "\n"
      )
    )
    expect(harness.view.state.selection.main.head).toBe(
      harness.doc.indexOf("additional content")
    )
  })

  test("a second Enter lifts split content by exactly one nested level", () => {
    const source = "- parent\n  - child additional content"
    const harness = editor(source, source.indexOf("additional content"))

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("- parent\n  - child\n  - additional content")
    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("- parent\n  - child\n- additional content")
  })

  test("Shift+Enter exits list indentation while retaining quote containers", () => {
    const source = "> - item additional content"
    const harness = editor(source, source.indexOf("additional content"))

    expect(insertNewlineExitList(harness.view)).toBe(true)
    expect(harness.doc).toBe("> - item\n> additional content")
    expect(harness.view.state.selection.main.head).toBe(
      harness.doc.indexOf("additional content")
    )
  })

  test("uses the previous item's authored content indent and reverses it", () => {
    const source = "-    Parent\n- Child\n  continuation"
    const harness = editor(source, source.indexOf("Child") + 2)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("-    Parent\n     - Child\n       continuation")

    expect(dedentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(source)
  })

  test("continues a task after indenting it beneath a task parent", () => {
    const source = "- [ ] parent\n- [x] child"
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("- [ ] parent\n  - [x] child")
    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("- [ ] parent\n  - [x] child\n  - [ ] ")
  })

  test("handles multi-digit and adjacent mixed list markers", () => {
    const ordered = editor("10. Parent\n11. Child", 16)
    indentListItems(ordered.view)
    expect(ordered.doc).toBe("10. Parent\n    11. Child")

    const mixed = editor("- Parent\n1. Child", 13)
    indentListItems(mixed.view)
    expect(mixed.doc).toBe("- Parent\n  1. Child")
  })

  test.each([
    ["bullet", "- parent\n- child", "- parent\n  - child"],
    ["task", "- [ ] parent\n- [x] child", "- [ ] parent\n  - [x] child"],
    ["decimal", "1. parent\n2. child", "1. parent\n   2. child"],
    ["alphabetic", "a. parent\nb. child", "a. parent\n   b. child"],
    ["two-digit", "10. parent\n11. child", "10. parent\n    11. child"],
    ["three-digit", "100. parent\n101. child", "100. parent\n     101. child"],
    [
      "ordered task",
      "1. [ ] parent\n2. [x] child",
      "1. [ ] parent\n   2. [x] child",
    ],
  ])(
    "uses the CommonMark structural column for a %s parent",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(
          harness.view.state,
          harness.doc.lastIndexOf("child") + 1
        )
      ).toBe(2)
    }
  )

  test.each([
    [
      "decimal marker-width boundary",
      "9. parent\n10. first\n11. second",
      "9. parent\n   10. first\n   11. second",
    ],
    [
      "alphabetic marker-width boundary",
      "y. parent\nz. first\naa. second",
      "y. parent\n   z. first\n   aa. second",
    ],
    [
      "wide decimal marker-width boundary",
      "99. parent\n100. first\n101. second",
      "99. parent\n    100. first\n    101. second",
    ],
  ])(
    "keeps selected siblings aligned across a %s",
    (_kind, source, expected) => {
      const secondLineFrom = source.indexOf("\n") + 1
      const harness = editor(source, secondLineFrom, source.length)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("first"))
      ).toBe(2)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("second"))
      ).toBe(2)
    }
  )

  test.each([
    [
      "spaces",
      "- ROOT\n  -\tFIRST\n  -\tSECOND\n    - CHILD",
      "- ROOT\n  -\tFIRST\n    -\tSECOND\n        - CHILD",
    ],
    [
      "authored tabs",
      "- ROOT\n\t-\tFIRST\n\t-\tSECOND\n\t\t- CHILD",
      "- ROOT\n\t-\tFIRST\n\t\t-\tSECOND\n\t\t\t- CHILD",
    ],
    [
      "quoted spaces",
      "> - ROOT\n>   -\tFIRST\n>   -\tSECOND\n>       - CHILD",
      "> - ROOT\n>   -\tFIRST\n>       -\tSECOND\n>           - CHILD",
    ],
  ])(
    "keeps descendants under a tab-padded marker when indenting with %s",
    (_kind, source, expected) => {
      const harness = editor(
        source,
        source.indexOf("SECOND") + 1,
        source.indexOf("SECOND") + 1
      )

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("SECOND"))
      ).toBe(3)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("CHILD"))
      ).toBe(4)
    }
  )

  test("keeps a first nested multi-letter alphabetic item parseable", () => {
    const source = "z. FIRST\naa. SECOND\n    - CHILD"
    const harness = editor(source, source.indexOf("SECOND") + 1)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("z. FIRST\n   a. SECOND\n      - CHILD")
    expect(
      listItemDepthAt(harness.view.state, harness.doc.indexOf("SECOND"))
    ).toBe(2)
    expect(
      listItemDepthAt(harness.view.state, harness.doc.indexOf("CHILD"))
    ).toBe(3)
  })

  test.each([
    ["ordered parent", "1. parent\n   A. child", "1. parent\nA.  child"],
    ["bullet parent", "- parent\n  A. child", "- parent\nA.  child"],
    [
      "quoted ordered parent",
      "> 1. parent\n>    A. child",
      "> 1. parent\n> A.  child",
    ],
  ])(
    "keeps a dedented uppercase marker parseable at root for an %s",
    (_kind, source, expected) => {
      const harness = editor(source, source.indexOf("child") + 1)

      expect(dedentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("child"))
      ).toBe(1)
    }
  )

  test.each([
    [
      "uppercase Roman",
      "IX.  FIRST\nX.  SECOND",
      "IX.  FIRST\n     I.  SECOND\n     II.  ",
    ],
    [
      "lowercase alphabetic",
      "h. FIRST\ni. SECOND",
      "h. FIRST\n   a. SECOND\n   b. ",
    ],
  ])(
    "keeps an ambiguous %s family when starting a nested branch",
    (_kind, source, expected) => {
      const harness = editor(source, source.indexOf("SECOND") + 1)

      expect(indentListItems(harness.view)).toBe(true)
      harness.select(harness.doc.length)
      expect(insertNewlineContinueList(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    ["plain item", "- ROOT\n- \tSECOND", "- ROOT\n  -   SECOND", false],
    ["task item", "- ROOT\n- \t[ ] SECOND", "- ROOT\n  -   [ ] SECOND", true],
    [
      "quoted task item",
      "> - ROOT\n> -\t  [ ] SECOND",
      "> - ROOT\n>   -   [ ] SECOND",
      true,
    ],
  ])(
    "preserves %s marker-padding semantics across an indent tab stop",
    (_kind, source, expected, task) => {
      const harness = editor(source, source.indexOf("SECOND") + 1)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      const tree = syntaxTree(harness.view.state).toString()
      expect(tree).not.toContain("CodeBlock")
      if (task) expect(tree).toContain("TaskMarker")
    }
  )

  test("normalizes every moved descendant marker at its new tab stop", () => {
    const source = "- ROOT\n- SECOND\n    - \t[ ] CHILD"
    const harness = editor(source, source.indexOf("SECOND") + 1)
    expect(syntaxTree(harness.view.state).toString()).toContain("TaskMarker")

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("- ROOT\n  - SECOND\n      -   [ ] CHILD")
    const tree = syntaxTree(harness.view.state).toString()
    expect(tree).toContain("TaskMarker")
    expect(tree).not.toContain("CodeBlock")
    expect(
      listItemDepthAt(harness.view.state, harness.doc.indexOf("CHILD"))
    ).toBe(3)
  })

  test.each([
    ["bullet", "- parent\n- child", "- parent\n  - child"],
    ["task", "- [ ] parent\n- [x] child", "- [ ] parent\n  - [x] child"],
    ["ordered", "1. parent\n2. child", "1. parent\n   2. child"],
    ["wide ordered", "100. parent\n101. child", "100. parent\n     101. child"],
  ])(
    "automatically emits valid CommonMark indentation beneath a %s parent",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(harness.view.state, harness.doc.indexOf("child"))
      ).toBe(2)
    }
  )

  test.each([
    [
      "spaces after an unpadded quote marker",
      ">- parent\n>- child",
      ">- parent\n>   - child",
    ],
    [
      "authored tabs after a quote-adjacent tab",
      ">\t- parent\n>\t- child",
      ">\t- parent\n> \t\t- child",
    ],
  ])(
    "nests with %s without losing indentation to blockquote padding",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(
          harness.view.state,
          harness.doc.lastIndexOf("child") + 1
        )
      ).toBe(2)

      expect(dedentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(source)
      expect(
        listItemDepthAt(
          harness.view.state,
          harness.doc.lastIndexOf("child") + 1
        )
      ).toBe(1)
    }
  )

  test.each([
    [
      "an item-owned blockquote",
      "- parent\n- child\n  > quote",
      "- parent\n  - child\n    > quote",
    ],
    [
      "an item-owned blockquote inside an outer blockquote",
      "> - parent\n> - child\n>   > quote",
      "> - parent\n>   - child\n>     > quote",
    ],
  ])("shifts %s with the complete list subtree", (_kind, source, expected) => {
    const harness = editor(source, source.indexOf("child") + 1)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(expected)
    expect(
      listItemDepthAt(harness.view.state, harness.doc.lastIndexOf("quote") + 1)
    ).toBe(2)

    expect(dedentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(source)
  })

  test("targets the intended parent's content column instead of adding to a malformed indent", () => {
    const source = "1. parent\n  2. child"
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe("1. parent\n   2. child")
    expect(
      listItemDepthAt(harness.view.state, harness.doc.indexOf("child"))
    ).toBe(2)
  })

  test.each([
    ["nested marker", "  -\tparent\n  - child", "  -\tparent\n    - child"],
    [
      "quoted ordered marker",
      "> 1.\tparent\n> 2. child",
      "> 1.\tparent\n>       2. child",
    ],
  ])(
    "counts tabbed %s spacing from its physical source column",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(
          harness.view.state,
          harness.doc.lastIndexOf("child") + 1
        )
      ).toBe(2)
    }
  )

  test.each([
    [1, "1. parent\n2. child", "1. parent\n   2. child"],
    [2, "1.  parent\n2. child", "1.  parent\n    2. child"],
    [3, "1.   parent\n2. child", "1.   parent\n     2. child"],
    [4, "1.    parent\n2. child", "1.    parent\n      2. child"],
    [5, "1.     parent\n2. child", "1.     parent\n   2. child"],
  ])(
    "normalizes %i post-marker spaces by the CommonMark list-item rule",
    (_spacing, source, expected) => {
      const harness = editor(source, source.length)

      expect(indentListItems(harness.view)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        listItemDepthAt(
          harness.view.state,
          harness.doc.lastIndexOf("child") + 1
        )
      ).toBe(2)
    }
  )

  test("preserves continuation columns while tab-indenting and dedenting", () => {
    const source = "- root\n\t- parent\n\t- child\n\t  continuation"
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      "- root\n\t- parent\n\t\t- child\n\t\t  continuation"
    )

    expect(dedentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(source)
  })

  test("continues and lifts tab-indented list items by one semantic level", () => {
    const source = "- parent\n\t- child"
    const harness = editor(source, source.length)

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("- parent\n\t- child\n\t- ")

    expect(insertNewlineContinueList(harness.view)).toBe(true)
    expect(harness.doc).toBe("- parent\n\t- child\n- ")
  })

  test("edits after blockquote and callout prefixes in one press", () => {
    const source = [
      "> [!note]",
      "> - Parent",
      "> - Child",
      ">   continuation",
    ].join("\n")
    const harness = editor(source, source.indexOf("Child") + 2)

    indentListItems(harness.view)
    expect(harness.doc).toBe(
      ["> [!note]", "> - Parent", ">   - Child", ">     continuation"].join(
        "\n"
      )
    )

    dedentListItems(harness.view)
    expect(harness.doc).toBe(source)
  })

  test("indents a large sibling selection beneath its preceding item", () => {
    const source = Array.from(
      { length: 2_000 },
      (_, index) => `- item ${index}`
    ).join("\n")
    const secondLine = source.indexOf("\n") + 1
    const harness = editor(source, secondLine, source.length)

    expect(indentListItems(harness.view)).toBe(true)

    const lines = harness.doc.split("\n")
    expect(lines).toHaveLength(2_000)
    expect(lines[0]).toBe("- item 0")
    expect(lines[1]).toBe("  - item 1")
    expect(lines.at(-1)).toBe("  - item 1999")
  })

  test("recognizes a continuation beyond the parser's initial fragment", () => {
    const continuation = `  ${"x".repeat(4_000)}`
    const source = `- Parent\n- Child\n${continuation}`
    const harness = editor(source, source.length)

    expect(selectionIsInListItem(harness.view.state)).toBe(true)
    indentListItems(harness.view)
    expect(harness.doc).toBe(`- Parent\n  - Child\n    ${"x".repeat(4_000)}`)
  })

  test("recognizes an unindented lazy continuation beyond an incomplete parse", () => {
    const prefix = `${"x".repeat(2_000_000)}\n\n`
    const continuations = Array.from(
      { length: 129 },
      (_, index) => `lazy continuation ${index + 1}`
    ).join("\n")
    const source = `${prefix}- Parent\n- Child\n${continuations}`
    const harness = editor(source, source.length)

    expect(indentListItems(harness.view)).toBe(true)
    expect(harness.doc).toBe(
      `${prefix}- Parent\n  - Child\n${continuations
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`
    )
  })

  test("does not extend a fallback item over following top-level prose", () => {
    const prefix = `${"x".repeat(2_000_000)}\n\n`
    const source = `${prefix}- parent\n- item\n\nplain`
    const harness = editor(source, source.indexOf("plain", prefix.length))

    expect(selectionIsInListItem(harness.view.state)).toBe(false)
    expect(indentListItems(harness.view)).toBe(false)
    expect(harness.doc).toBe(source)
  })

  test.each(["# heading", "```ts\nconst value = 1\n```", "---"])(
    "does not extend a list over an adjacent block start: %s",
    (following) => {
      const prefix = `${"x".repeat(2_000_000)}\n\n`
      const source = `${prefix}- parent\n- item\n${following}`
      const position = source.indexOf(following, prefix.length)
      const harness = editor(source, position)

      expect(selectionIsInListItem(harness.view.state)).toBe(false)
      expect(indentListItems(harness.view)).toBe(false)
      expect(harness.doc).toBe(source)
    }
  )

  test.each(["* * *", "- - -"])(
    "does not treat a thematic break as a list item: %s",
    (source) => {
      const harness = editor(source, source.length)

      expect(selectionIsInListItem(harness.view.state)).toBe(false)
      expect(indentListItems(harness.view)).toBe(false)
      expect(dedentListItems(harness.view)).toBe(false)
      expect(harness.doc).toBe(source)
    }
  )
})
