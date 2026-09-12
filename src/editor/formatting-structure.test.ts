import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { EditorSelection, EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import { applyMarkdownFormatting, createMarkdownTable } from "./formatting"

const largePartialTreePrefix = "plain text\n".repeat(310_000)

function editor(doc: string, anchor = 0, head = anchor) {
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
    get doc() {
      return state.doc.toString()
    },
    get selection() {
      return state.selection
    },
    view,
  }
}

describe("structural Markdown formatting", () => {
  test("normalizes unequal adjacent inline-code runs", () => {
    const harness = editor("``foo`", 2, 5)

    expect(applyMarkdownFormatting(harness.view, { type: "inline-code" })).toBe(
      true
    )
    expect(harness.doc).toBe("`foo`")
  })

  test("formats selected words while leaving boundary whitespace outside emphasis", () => {
    for (const [source, command, expected, nodeName] of [
      ["foo ", "bold", "**foo** ", "StrongEmphasis"],
      [" foo", "italic", " *foo*", "Emphasis"],
      [" foo ", "strikethrough", " ~~foo~~ ", "Strikethrough"],
    ] as const) {
      const harness = editor(source, 0, source.length)
      applyMarkdownFormatting(harness.view, { type: command })
      expect(harness.doc).toBe(expected)
      expect(syntaxTree(harness.view.state).toString()).toContain(nodeName)
      expect(syntaxTree(harness.view.state).toString()).not.toContain(
        "ListItem"
      )
      applyMarkdownFormatting(harness.view, { type: command })
      expect(harness.doc).toBe(source)
    }
  })

  test("round-trips inline code with significant spaces and boundary backticks", () => {
    for (const source of [" foo ", "`foo`", "  "]) {
      const harness = editor(source, 0, source.length)
      applyMarkdownFormatting(harness.view, { type: "inline-code" })
      expect(syntaxTree(harness.view.state).toString()).toBe(
        "Document(Paragraph(InlineCode(CodeMark,CodeMark)))"
      )
      if (source === "  ") expect(harness.doc).toBe("`  `")
      applyMarkdownFormatting(harness.view, { type: "inline-code" })
      expect(harness.doc).toBe(source)
      expect(harness.selection.main).toMatchObject({
        from: 0,
        to: source.length,
      })
    }
  })

  test.each([
    [{ type: "bullet-list" }, "- "],
    [{ type: "ordered-list" }, "1. "],
    [{ type: "task-list" }, "- [ ] "],
    [{ type: "blockquote" }, "> "],
  ] as const)(
    "inserts %s before the caret on an empty document",
    (command, marker) => {
      const harness = editor("")

      expect(applyMarkdownFormatting(harness.view, command)).toBe(true)
      expect(harness.doc).toBe(marker)
      expect(harness.selection.main).toMatchObject({
        anchor: marker.length,
        head: marker.length,
      })
    }
  )

  test.each([
    [{ type: "bullet-list" }, "- "],
    [{ type: "ordered-list" }, "1. "],
    [{ type: "task-list" }, "- [ ] "],
    [{ type: "blockquote" }, "> "],
  ] as const)(
    "keeps a %s caret at the same logical content boundary",
    (command, marker) => {
      const harness = editor("alpha")

      expect(applyMarkdownFormatting(harness.view, command)).toBe(true)
      expect(harness.doc).toBe(`${marker}alpha`)
      expect(harness.selection.main.head).toBe(marker.length)
    }
  )

  test.each([
    [
      "space-padded bullet to ordered",
      "-     [ ] parent",
      { type: "ordered-list" } as const,
      "1.     [ ] parent",
    ],
    [
      "space-padded ordered to bullet",
      "1.     [ ] parent",
      { type: "bullet-list" } as const,
      "-     [ ] parent",
    ],
    [
      "invalid checkbox lookalike to task",
      "-     [ ] parent",
      { type: "task-list" } as const,
      "- [ ]     [ ] parent",
    ],
    [
      "tab-padded checkbox lookalike to ordered",
      "-\t\t[ ] parent",
      { type: "ordered-list" } as const,
      "1.       [ ] parent",
    ],
    [
      "space-padded bullet removal",
      "-     [ ] parent",
      { type: "bullet-list" } as const,
      "    [ ] parent",
    ],
  ])(
    "preserves literal content and block indentation for %s",
    (_kind, source, command, expected) => {
      const harness = editor(source, source.length)

      expect(applyMarkdownFormatting(harness.view, command)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(harness.doc).toContain("[ ] parent")
    }
  )

  test.each([
    ["space-indented bullet", "    - literal", { type: "bullet-list" }],
    ["tab-indented ordered", "\t1. literal", { type: "ordered-list" }],
    ["space-indented task", "    - [ ] literal", { type: "task-list" }],
  ] as const)(
    "does not rewrite %s text in a code block",
    (_kind, source, command) => {
      const harness = editor(source, source.length)

      expect(applyMarkdownFormatting(harness.view, command)).toBe(true)
      expect(harness.doc).toBe(source)
    }
  )

  test.each([
    ["quoted tab content", ">\tcode", "\tcode"],
    ["tab-indented fake quote", "\t> code", "> \t> code"],
    ["space-indented fake quote", "    > code", ">     > code"],
  ])(
    "preserves source characters when toggling a %s",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(
        applyMarkdownFormatting(harness.view, { type: "blockquote" })
      ).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("targets a caret-only blank line instead of its surrounding list", () => {
    const source = "- existing\n  \nafter"
    const harness = editor(source, source.indexOf("\n") + 2)

    expect(applyMarkdownFormatting(harness.view, { type: "task-list" })).toBe(
      true
    )
    expect(harness.doc).toBe("- existing\n  - [ ] \nafter")
  })

  test.each([
    [
      "fenced code",
      ["- parent", "  ```", "  - literal", "  ```", "  - child"].join("\n"),
      ["1. parent", "   ```", "   - literal", "   ```", "   1. child"].join(
        "\n"
      ),
    ],
    [
      "indented code",
      ["- parent", "", "      - literal", "  - child"].join("\n"),
      ["1. parent", "", "       - literal", "   1. child"].join("\n"),
    ],
  ])(
    "does not treat marker-looking %s content as nested list items",
    (_, source, expected) => {
      const harness = editor(source, source.indexOf("parent"))

      expect(
        applyMarkdownFormatting(harness.view, { type: "ordered-list" })
      ).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    ["decimal", "\t>1. code", "\t>1. code"],
    ["alphabetic", "\t>a. code", "\t>a. code"],
  ])(
    "leaves quote-like %s text inside an indented code line untouched",
    (_kind, source, expected) => {
      const harness = editor(source, source.length)

      expect(
        applyMarkdownFormatting(harness.view, { type: "bullet-list" })
      ).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("does not classify a ten-digit CommonMark-like marker as a list item", () => {
    const source = "1234567890. prose"
    const harness = editor(source, source.length)

    expect(applyMarkdownFormatting(harness.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(harness.doc).toBe(`- ${source}`)
  })

  test("retains the textual fallback for an ordered marker that cannot interrupt a paragraph", () => {
    const source = "- parent\n  2. malformed child"
    const harness = editor(source, source.indexOf("parent"))

    expect(
      applyMarkdownFormatting(harness.view, { type: "ordered-list" })
    ).toBe(true)
    expect(harness.doc).toBe("1. parent\n   1. malformed child")
  })

  test.each([
    [
      "fenced code",
      ["- [ ] parent", "  ```", "  - literal", "  ```", "  - [ ] child"].join(
        "\n"
      ),
      ["- parent", "  ```", "  - literal", "  ```", "  - child"].join("\n"),
    ],
    [
      "indented code",
      ["- [ ] parent", "", "      - literal", "  - [ ] child"].join("\n"),
      ["- parent", "", "      - literal", "  - child"].join("\n"),
    ],
  ])("distinguishes a semantic task child from %s", (_, source, expected) => {
    const harness = editor(source, source.indexOf("parent"))

    expect(applyMarkdownFormatting(harness.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(harness.doc).toBe(expected)
  })

  test("formats prose after a partial-tree list without changing the list", () => {
    const prefix = `${"x".repeat(2_000_000)}\n\n`
    const source = `${prefix}- parent\n- item\nplain`
    const harness = editor(source, source.indexOf("plain", prefix.length))

    expect(applyMarkdownFormatting(harness.view, { type: "bullet-list" })).toBe(
      true
    )
    expect(harness.doc).toBe(`${prefix}- parent\n- item\n- plain`)
  })

  test("places headings after quote, list, and task prefixes", () => {
    const source = ["> quote", "- item", "- [ ] task"].join("\n")
    const harness = editor(source, 0, source.length)

    expect(
      applyMarkdownFormatting(harness.view, { type: "heading", level: 2 })
    ).toBe(true)
    expect(harness.doc).toBe(
      ["> ## quote", "- ## item", "- [ ] ## task"].join("\n")
    )
  })

  test.each([
    ["content line", "Title\n=====", 2, 2, "## Title"],
    ["underline line", "Title\n=====", 8, 0, "Title"],
    ["quoted Setext heading", "> Title\n> =====", 12, 3, "> ### Title"],
    ["list-nested Setext heading", "- Title\n  =====", 12, 4, "- #### Title"],
  ] as const)(
    "converts a complete %s",
    (_kind, source, caret, level, expected) => {
      const harness = editor(source, caret)

      expect(
        applyMarkdownFormatting(harness.view, { type: "heading", level })
      ).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test("converts a selected Setext heading exactly once", () => {
    const source = "Title\n=====\nafter"
    const harness = editor(source, 0, source.indexOf("after") - 1)

    expect(
      applyMarkdownFormatting(harness.view, { type: "heading", level: 2 })
    ).toBe(true)
    expect(harness.doc).toBe("## Title\nafter")
  })

  test.each([
    ["plain", "First\nsecond\n---", 7, 2, "## First\nsecond"],
    ["quoted", "> First\n> second\n> ---", 13, 3, "> ### First\n> second"],
    [
      "list-nested",
      "- First\n  second\n  ---",
      13,
      4,
      "- #### First\n  second",
    ],
    ["paragraph", "First\nsecond\n---", 7, 0, "First\nsecond"],
  ] as const)(
    "preserves every content line in a multiline %s Setext conversion",
    (_kind, source, caret, level, expected) => {
      const harness = editor(source, caret)

      expect(
        applyMarkdownFormatting(harness.view, { type: "heading", level })
      ).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    [0, "Title"],
    [4, "#### Title"],
  ] as const)(
    "removes complete closing ATX syntax while converting to level %i",
    (level, expected) => {
      const harness = editor("## Title ##   ", 5)

      expect(
        applyMarkdownFormatting(harness.view, { type: "heading", level })
      ).toBe(true)
      expect(harness.doc).toBe(expected)
    }
  )

  test.each([
    ["link", { type: "link" } as const, "[a\\]b](https://)"],
    ["image", { type: "image" } as const, "![a\\]b](https://)"],
  ])(
    "escapes a selected %s label and selects its destination",
    (_, command, expected) => {
      const harness = editor("a]b", 3, 0)

      expect(applyMarkdownFormatting(harness.view, command)).toBe(true)
      expect(harness.doc).toBe(expected)
      expect(
        harness.view.state.sliceDoc(
          harness.selection.main.from,
          harness.selection.main.to
        )
      ).toBe("https://")
      expect(harness.selection.main.anchor).toBeGreaterThan(
        harness.selection.main.head
      )
    }
  )

  test("escapes a selected URL destination and selects the generated label", () => {
    const source = "https://example.test/a)"
    const harness = editor(source, 0, source.length)

    expect(applyMarkdownFormatting(harness.view, { type: "link" })).toBe(true)
    expect(harness.doc).toBe("[link](https://example.test/a\\))")
    expect(
      harness.view.state.sliceDoc(
        harness.selection.main.from,
        harness.selection.main.to
      )
    ).toBe("link")
  })

  test("keeps nested block actions from corrupting their container", () => {
    for (const command of [
      { type: "code-block" },
      { type: "horizontal-rule" },
      { type: "table", columns: 2, rows: 2 },
    ] as const) {
      const harness = editor("> - nested", 4, 10)
      expect(applyMarkdownFormatting(harness.view, command)).toBe(false)
      expect(harness.doc).toBe("> - nested")
    }
  })

  test("inserts empty block actions after a nested container", () => {
    const table = editor("- nested", 4)
    expect(
      applyMarkdownFormatting(table.view, {
        type: "table",
        columns: 2,
        rows: 2,
      })
    ).toBe(true)
    expect(table.doc).toBe(
      ["- nested", "| Header 1 | Header 2 |", "| --- | --- |", "|  |  |"].join(
        "\n"
      )
    )
  })

  test("resolves a nested insertion beyond the initial syntax fragment", () => {
    const suffix = "- item\n  continuation"
    const source = `${largePartialTreePrefix}${suffix}`
    const caret = source.indexOf("item", largePartialTreePrefix.length)
    const harness = editor(source, caret)

    expect(syntaxTreeAvailable(harness.view.state, caret)).toBe(false)
    expect(
      applyMarkdownFormatting(harness.view, {
        type: "table",
        columns: 2,
        rows: 2,
      })
    ).toBe(true)
    expect(harness.doc).toBe(
      `${source}\n| Header 1 | Header 2 |\n| --- | --- |\n|  |  |`
    )
  })

  test("computes nested behavior independently for multiple carets", () => {
    const source = "plain\n\n- nested"
    let state = EditorState.create({
      doc: source,
      selection: EditorSelection.create([
        EditorSelection.cursor(source.indexOf("\n") + 1),
        EditorSelection.cursor(source.indexOf("nested") + 2),
      ]),
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
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

    expect(applyMarkdownFormatting(view, { type: "horizontal-rule" })).toBe(
      true
    )
    expect(state.doc.toString()).toBe("plain\n***\n- nested\n***")
  })

  test("turns a current top-level line into a fenced code block", () => {
    const harness = editor("alpha", 2)
    applyMarkdownFormatting(harness.view, { type: "code-block" })
    expect(harness.doc).toBe("```\nalpha\n```")
  })

  test.each([
    ["a caret", "```Custom mode\nalpha\nbeta\n```", 16, 16],
    ["selected content", "```Custom mode\nalpha\nbeta\n```", 15, 25],
    ["an entire fence", "```Custom mode\nalpha\nbeta\n```", 0, 29],
    ["a tilde fence", "~~~unorthodox\nalpha\n~~~", 17, 22],
    ["a quoted fence", "> ```odd\n> alpha\n> ```", 13, 13],
    ["a list-nested fence", "- item\n  ```odd\n  alpha\n  ```", 20, 20],
  ])("is idempotent for %s inside fenced code", (_, source, anchor, head) => {
    const harness = editor(source, anchor, head)

    expect(applyMarkdownFormatting(harness.view, { type: "code-block" })).toBe(
      true
    )
    expect(harness.doc).toBe(source)
  })

  test("still creates a block on the line after an existing fence", () => {
    const source = "```\nalpha\n```\nafter"
    const harness = editor(source, source.indexOf("after") + 2)

    expect(applyMarkdownFormatting(harness.view, { type: "code-block" })).toBe(
      true
    )
    expect(harness.doc).toBe("```\nalpha\n```\n```\nafter\n```")
  })

  test.each([
    [
      "a custom top-level fence",
      "````Custom mode\nalpha\n```\n````not a close\nbeta\n````",
    ],
    ["a quoted fence", "> ~~~odd mode\n> alpha\n> beta\n> ~~~"],
    ["a list-nested fence", "- item\n  ```unorthodox\n  alpha\n  beta\n  ```"],
  ])("stays idempotent beyond a partial syntax tree for %s", (_, suffix) => {
    const source = `${largePartialTreePrefix}${suffix}`
    const caret = source.indexOf("beta", largePartialTreePrefix.length) + 2
    const harness = editor(source, caret)

    expect(syntaxTreeAvailable(harness.view.state, caret)).toBe(false)
    expect(applyMarkdownFormatting(harness.view, { type: "code-block" })).toBe(
      true
    )
    expect(harness.doc).toBe(source)
  })

  test("pairs ambiguous fences by forward state beyond a partial tree", () => {
    const suffix = "```\nold code\n```\nafter"
    const source = `${largePartialTreePrefix}${suffix}`
    const caret = source.indexOf("after", largePartialTreePrefix.length) + 2
    const harness = editor(source, caret)

    expect(syntaxTreeAvailable(harness.view.state, caret)).toBe(false)
    expect(applyMarkdownFormatting(harness.view, { type: "code-block" })).toBe(
      true
    )
    expect(harness.doc).toBe(
      `${largePartialTreePrefix}\`\`\`\nold code\n\`\`\`\n\`\`\`\nafter\n\`\`\``
    )
  })

  test("inserts top-level rules and tables after non-empty lines", () => {
    const rule = editor("alpha", 2)
    applyMarkdownFormatting(rule.view, { type: "horizontal-rule" })
    expect(rule.doc).toBe("alpha\n***")
    expect(syntaxTree(rule.view.state).toString()).toBe(
      "Document(Paragraph,HorizontalRule)"
    )

    const table = editor("alpha", 2)
    applyMarkdownFormatting(table.view, {
      type: "table",
      columns: 2,
      rows: 2,
    })
    expect(table.doc).toBe(
      ["alpha", "| Header 1 | Header 2 |", "| --- | --- |", "|  |  |"].join(
        "\n"
      )
    )
  })

  test("creates a table from more source rows than an argument spread can hold", () => {
    const sourceRowCount = 140_000
    const table = createMarkdownTable(
      1,
      1,
      Array.from({ length: sourceRowCount }, () => "cell").join("\n")
    )

    expect(table.split("\n")).toHaveLength(sourceRowCount + 1)
    expect(table.startsWith("| cell |\n| --- |\n")).toBe(true)
    expect(table.endsWith("| cell |")).toBe(true)
  }, 20_000)
})
