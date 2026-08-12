import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { type Decoration, EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import {
  buildMathPreviewDecorations,
  mathExpressions,
  mathLivePreviewExtension,
  mathMarkdownExtension,
  mathSelectionRangeAt,
  maximumMathSourceLength,
} from "./math"

function mathState(doc: string, cursor = 0, extraExtensions: Extension = []) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({
        addKeymap: false,
        base: markdownLanguage,
        extensions: [mathMarkdownExtension],
      }),
      extraExtensions,
    ],
  })
}

function previewRanges(state: EditorState) {
  const ranges: Array<{
    block: boolean
    display: boolean
    from: number
    source: string
    to: number
  }> = []
  buildMathPreviewDecorations(state).between(
    0,
    state.doc.length,
    (from, to, value: Decoration) => {
      const widget = value.spec.widget as {
        display: boolean
        source: string
      }
      ranges.push({
        block: value.spec.block === true,
        display: widget.display,
        from,
        source: widget.source,
        to,
      })
    }
  )
  return ranges
}

function directMathPreviewRanges(state: EditorState) {
  const ranges: Array<{
    display: boolean
    from: number
    source: string
    to: number
  }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind !== "math") return
      const widget = value.spec.widget as {
        display: boolean
        source: string
      }
      ranges.push({
        display: widget.display,
        from,
        source: widget.source,
        to,
      })
    })
  }
  return ranges.sort((left, right) => left.from - right.from)
}

function directMathDecorationSet(state: EditorState) {
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    let found = false
    source.between(0, state.doc.length, (_from, _to, value) => {
      const widget = value.spec.widget as { display?: boolean } | undefined
      if (
        value.spec.markdownPreviewKind === "math" &&
        widget?.display === true
      ) {
        found = true
      }
    })
    if (found) return source
  }
  throw new Error("Direct display-math decorations are unavailable")
}

function directMathDecoration(state: EditorState, targetSource: string) {
  let result: Decoration | null = null
  directMathDecorationSet(state).between(
    0,
    state.doc.length,
    (_from, _to, value) => {
      const widget = value.spec.widget as { source?: string } | undefined
      if (widget?.source === targetSource) result = value
    }
  )
  if (!result) throw new Error(`Display math is unavailable: ${targetSource}`)
  return result
}

describe("math Markdown parsing", () => {
  test("bounds the source accepted by the renderer", () => {
    const maximumSource = "x".repeat(maximumMathSourceLength)
    expect(mathExpressions(mathState(`$${maximumSource}$`))).toMatchObject([
      { source: maximumSource },
    ])

    const oversizedSource = `${maximumSource}x`
    expect(mathExpressions(mathState(`$${oversizedSource}$`))).toEqual([])
  })

  test("parses inline dollar and parenthesized LaTeX", () => {
    const doc =
      "**Inline Math:** The Pythagorean theorem is $a^2 + b^2 = c^2$ and \\(x + y\\)."
    const expressions = mathExpressions(mathState(doc))

    expect(expressions).toEqual([
      {
        block: false,
        display: false,
        from: doc.indexOf("$a^2"),
        source: "a^2 + b^2 = c^2",
        to: doc.indexOf("$ and") + 1,
      },
      {
        block: false,
        display: false,
        from: doc.indexOf("\\(x"),
        source: "x + y",
        to: doc.indexOf("\\).") + 2,
      },
    ])
  })

  test.each([
    String.raw`\$x$`,
    "$ x$",
    "$x $",
    "$x$2",
    "Cost is $5 and $10.",
    String.raw`\\(x\\)`,
  ])("leaves escaped or invalid delimiters as source: %s", (doc) => {
    expect(mathExpressions(mathState(doc))).toEqual([])
  })

  test("accepts compact numeric math and honors escaped content", () => {
    expect(
      mathExpressions(mathState(String.raw`$5$ and $x + \$5$`))
    ).toMatchObject([
      { display: false, source: "5" },
      { display: false, source: String.raw`x + \$5` },
    ])
  })

  test("leaves long runs of unmatched inline openers as source", () => {
    const doc = `${"$1 ".repeat(5_000)}${String.raw`\(x `.repeat(5_000)}`

    expect(mathExpressions(mathState(doc))).toEqual([])
  })

  test("parses same-line and multiline display math", () => {
    const doc = [
      "$$E = mc^2$$",
      "",
      "\\[",
      "\\begin{aligned}",
      "a &= b \\\\",
      "c &= d",
      "\\end{aligned}",
      "\\]",
    ].join("\n")

    expect(mathExpressions(mathState(doc))).toEqual([
      {
        block: true,
        display: true,
        from: 0,
        source: "E = mc^2",
        to: "$$E = mc^2$$".length,
      },
      {
        block: true,
        display: true,
        from: doc.indexOf("\\["),
        source: [
          "\\begin{aligned}",
          "a &= b \\\\",
          "c &= d",
          "\\end{aligned}",
        ].join("\n"),
        to: doc.length,
      },
    ])
  })

  test("publishes selection bounds inside inline and block delimiters", () => {
    const doc = ["Inline $x + 1$.", "", "$$", "y^2", "$$"].join("\n")
    const state = mathState(doc)
    const inlineFrom = doc.indexOf("$x + 1$")
    const blockFrom = doc.indexOf("$$\ny^2")

    expect(mathSelectionRangeAt(state, inlineFrom)).toEqual({
      from: inlineFrom + 1,
      to: inlineFrom + "$x + 1".length,
    })
    expect(mathSelectionRangeAt(state, blockFrom)).toEqual({
      from: doc.indexOf("y^2"),
      to: doc.indexOf("y^2") + "y^2".length,
    })
  })

  test("strips Markdown container markers from nested display math", () => {
    const doc = ["> $$", "> x + y", "> $$", "", "- \\[", "  z^2", "  \\]"].join(
      "\n"
    )

    expect(mathExpressions(mathState(doc))).toMatchObject([
      { display: true, source: "x + y" },
      { display: true, source: "z^2" },
    ])
  })

  test("parses display math inside a table cell without consuming the table", () => {
    const formula = String.raw`$$\int_a^b f(x)\,dx<br>= F(b) - F(a)$$`
    const doc = [
      "| Formula | Meaning |",
      "| --- | --- |",
      `| ${formula} | Fundamental theorem |`,
    ].join("\n")
    const expressionFrom = doc.indexOf("$$")

    expect(syntaxTree(mathState(doc)).toString()).toContain(
      "TableCell(InlineDisplayMath"
    )
    expect(mathExpressions(mathState(doc))).toContainEqual({
      block: false,
      display: true,
      from: expressionFrom,
      source: String.raw`\int_a^b f(x)\,dx` + "\n= F(b) - F(a)",
      to: expressionFrom + formula.length,
    })
  })

  test("keeps an unfinished display construct visible as source", () => {
    const state = mathState("$$\nx + y")
    expect(syntaxTree(state).toString()).toContain("BlockMath")
    expect(mathExpressions(state)).toEqual([])
    expect(previewRanges(state)).toEqual([])
  })

  test("allows display math to interrupt the preceding paragraph", () => {
    const doc = "Block math:\n$$\nx^2 + y^2\n$$"
    const state = mathState(doc)

    expect(previewRanges(state)).toMatchObject([
      { block: true, display: true, source: "x^2 + y^2" },
    ])
  })
})

describe("math live preview", () => {
  test("consumes only the two boundary newlines around a multiline block", () => {
    const doc = ["Before", "", "$$", "x^2", "$$", "", "After"].join("\n")
    const state = mathState(doc)
    const expressionFrom = doc.indexOf("$$")
    const expressionTo = doc.indexOf("$$", expressionFrom + 2) + 2

    expect(previewRanges(state)).toContainEqual({
      block: true,
      display: true,
      from: expressionFrom - 1,
      source: "x^2",
      to: expressionTo + 1,
    })
    expect(state.sliceDoc(expressionFrom - 2, expressionFrom)).toBe("\n\n")
    expect(state.sliceDoc(expressionTo, expressionTo + 2)).toBe("\n\n")
  })

  test("creates inline and block replacements with safe widget metadata", () => {
    const doc = "Before $x^2$.\n\n$$\ny = mx + b\n$$"
    const ranges = previewRanges(mathState(doc))

    expect(ranges).toMatchObject([
      { block: false, display: false, source: "x^2" },
      { block: true, display: true, source: "y = mx + b" },
    ])
  })

  test("keeps table-cell display math inline in CodeMirror's block model", () => {
    const formula = String.raw`$$\int_a^b f(x)\,dx<br>= F(b) - F(a)$$`
    const doc = ["| Formula |", "| --- |", `| ${formula} |`].join("\n")

    expect(previewRanges(mathState(doc))).toContainEqual(
      expect.objectContaining({
        block: false,
        display: true,
        source: String.raw`\int_a^b f(x)\,dx` + "\n= F(b) - F(a)",
      })
    )
  })

  test("reveals source for an active caret or any nonempty selection", () => {
    const doc = "Before $x^2$ after"
    const inside = doc.indexOf("x^2") + 1
    const activeState = mathState(doc, inside)

    expect(buildMathPreviewDecorations(activeState).size).toBe(0)
    expect(buildMathPreviewDecorations(activeState, false).size).toBe(1)

    const selectedState = activeState.update({
      selection: { anchor: inside - 1, head: inside + 2 },
    }).state
    expect(buildMathPreviewDecorations(selectedState, false).size).toBe(0)
  })

  test("limits inline replacements while retaining every display replacement", () => {
    const doc = "A $x$.\n\nB $y$.\n\n$$\nz\n$$"
    const state = mathState(doc)
    const decorations = buildMathPreviewDecorations(state, false, [
      { from: 0, to: doc.indexOf("B") },
    ])
    const sources: string[] = []
    decorations.between(0, state.doc.length, (_from, _to, value) => {
      sources.push((value.spec.widget as { source: string }).source)
    })
    expect(sources).toEqual(["x", "z"])
  })

  test("keeps complete display replacements direct, mapped, and selection-sensitive", () => {
    const filler = Array.from(
      { length: 4_000 },
      (_, index) => `paragraph ${index}`
    ).join("\n\n")
    const doc = [
      "# Math",
      "",
      "$$",
      "x = 1",
      "$$",
      "",
      filler,
      "",
      "$$",
      "y = 2",
      "$$",
    ].join("\n")
    let state = mathState(doc, 0, mathLivePreviewExtension())

    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)
    expect(directMathPreviewRanges(state)).toMatchObject([
      { display: true, source: "x = 1" },
      { display: true, source: "y = 2" },
    ])

    const secondBefore = directMathPreviewRanges(state)[1]!.from
    const secondDecoration = directMathDecoration(state, "y = 2")
    const prosePosition = state.doc.toString().indexOf("paragraph 2000")
    state = state.update({
      changes: { from: prosePosition + "paragraph".length, insert: " updated" },
    }).state
    expect(directMathPreviewRanges(state).map(({ source }) => source)).toEqual([
      "x = 1",
      "y = 2",
    ])
    expect(directMathPreviewRanges(state)[1]!.from).toBeGreaterThan(
      secondBefore
    )
    expect(directMathDecoration(state, "y = 2")).toBe(secondDecoration)

    const firstSource = state.doc.toString().indexOf("x = 1")
    state = state.update({
      changes: {
        from: firstSource,
        to: firstSource + "x = 1".length,
        insert: "x = 3",
      },
    }).state
    expect(directMathPreviewRanges(state).map(({ source }) => source)).toEqual([
      "x = 3",
      "y = 2",
    ])
    expect(directMathDecoration(state, "y = 2")).toBe(secondDecoration)

    const second = directMathPreviewRanges(state)[1]!
    state = state.update({ selection: { anchor: second.from + 3 } }).state
    expect(directMathPreviewRanges(state).map(({ source }) => source)).toEqual([
      "x = 3",
    ])

    state = state.update({ selection: { anchor: 0 } }).state
    expect(directMathPreviewRanges(state).map(({ source }) => source)).toEqual([
      "x = 3",
      "y = 2",
    ])

    const source = state.doc.toString()
    const opening = source.indexOf("$$")
    const closing = source.indexOf("$$", opening + 2)
    state = state.update({
      changes: { from: closing, to: closing + 2, insert: "$" },
    }).state
    expect(
      directMathPreviewRanges(state).map(({ source: expression }) => expression)
    ).toEqual(
      mathExpressions(state)
        .filter(({ display }) => display)
        .map(({ source: expression }) => expression)
    )

    state = state.update({
      changes: { from: closing, to: closing + 1, insert: "$$" },
    }).state
    expect(directMathPreviewRanges(state).map(({ source }) => source)).toEqual([
      "x = 3",
      "y = 2",
    ])
  })

  test("reuses complete decoration state for selections outside display math", () => {
    const doc = [
      "before one",
      "before two",
      "",
      "$$",
      "x = 1",
      "$$",
      "",
      "after",
    ].join("\n")
    let state = mathState(doc, 0, mathLivePreviewExtension())
    const decorations = directMathDecorationSet(state)

    state = state.update({
      selection: { anchor: doc.indexOf("before two") },
    }).state

    expect(directMathDecorationSet(state)).toBe(decorations)
  })

  test("refreshes edited syntax while retaining distant math", () => {
    let state = mathState("A $x$.\n\nB $y$.")
    const renderedSources = () => {
      const decorations = buildMathPreviewDecorations(state, false)
      const sources: string[] = []
      decorations.between(0, state.doc.length, (_from, _to, value) => {
        sources.push((value.spec.widget as { source: string }).source)
      })
      return sources
    }

    expect(renderedSources()).toEqual(["x", "y"])
    state = state.update({ changes: { from: 0, insert: "New " } }).state
    expect(renderedSources()).toEqual(["x", "y"])

    const source = state.doc.toString()
    const firstClose = source.indexOf("$", source.indexOf("$") + 1)
    state = state.update({
      changes: { from: firstClose, to: firstClose + 1 },
    }).state
    expect(renderedSources()).toEqual(["y"])

    state = state.update({ changes: { from: firstClose, insert: "$" } }).state
    expect(renderedSources()).toEqual(["x", "y"])
  })
})
