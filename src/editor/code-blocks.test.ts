import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  type RangeValue,
} from "@codemirror/state"
import { BlockWrapper, type Decoration, EditorView } from "@codemirror/view"
import { describe, expect, test } from "vitest"

import { calloutBlockExtension, calloutEditingRange } from "./callout-blocks"
import {
  analyzeFencedCodeBlocks,
  analyzeMarkdownCodeBlocks,
  buildCodeBlockDecorations,
  codeFenceBoundaryClickSelection,
  codeBlockExtension,
  fencedCodeText,
  markdownCodeBlockText,
  setCodeBlockWrapped,
} from "./code-blocks"
import { refreshLivePreview } from "./interactive-preview"
import { mathMarkdownExtension } from "./math"

function markdownState(doc: string, cursor = 0) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage })],
  })
}

function wrapperAttribute(state: EditorState, name: string) {
  let result: string | undefined
  for (const wrappers of state.facet(EditorView.blockWrappers)) {
    if (typeof wrappers === "function") continue
    wrappers.between(0, state.doc.length, (_from, _to, value: RangeValue) => {
      const attributes = (
        value as unknown as { attributes?: Record<string, string> }
      ).attributes
      result ??= attributes?.[name]
    })
  }
  return result
}

function codeWrappers(state: EditorState) {
  const result: Array<{
    readonly from: number
    readonly to: number
    readonly value: BlockWrapper
    readonly attributes: Record<string, string>
  }> = []
  for (const wrappers of state.facet(EditorView.blockWrappers)) {
    if (typeof wrappers === "function") continue
    wrappers.between(0, state.doc.length, (from, to, value) => {
      const attributes =
        (value as unknown as { attributes?: Record<string, string> })
          .attributes ?? {}
      if (attributes.class !== "cm-md-code-block") return
      result.push({ from, to, value, attributes })
    })
  }
  return result.sort((left, right) => left.from - right.from)
}

function codeTools(state: EditorState) {
  const result: Array<{
    readonly from: number
    readonly to: number
    readonly value: Decoration
  }> = []
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === "function") continue
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind !== "code-tools") return
      result.push({ from, to, value })
    })
  }
  return result.sort((left, right) => left.from - right.from)
}

function codeToolWrapped(state: EditorState) {
  const [tool] = codeTools(state)
  return (tool?.value.spec.widget as { readonly wrapped?: boolean } | undefined)
    ?.wrapped
}

function codeLineDecorations(state: EditorState) {
  const blocks = analyzeMarkdownCodeBlocks(state)
  const decorations = buildCodeBlockDecorations(state, blocks, [
    { from: 0, to: state.doc.length },
  ])
  const lines: Array<{
    className: string
    from: number
    number: string | undefined
    kind: unknown
    to: number
  }> = []
  decorations.between(0, state.doc.length, (from, to, value: Decoration) => {
    lines.push({
      className: String(value.spec.class ?? ""),
      from,
      number: value.spec.attributes?.["data-code-line-number"],
      kind: value.spec.markdownPreviewKind,
      to,
    })
  })
  return lines
}

describe("fenced code blocks", () => {
  test("gives CommonMark indented code the standard language-neutral code card", () => {
    const doc = ["    first()", "      second()", "", "    third()"].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        codeBlockExtension({ include: () => false }),
      ],
    })
    const [block] = analyzeMarkdownCodeBlocks(state)

    expect(block).toMatchObject({
      kind: "indented",
      from: 0,
      wrapperFrom: 0,
      toolAnchor: state.doc.line(2).from,
      toolLineFrom: null,
      firstContentLine: 1,
      lastContentLine: 4,
      info: "",
    })
    expect(markdownCodeBlockText(state, block!)).toBe(
      "first()\n  second()\n\nthird()"
    )
    expect(codeWrappers(state)).toHaveLength(1)
    expect(codeWrappers(state)[0]?.attributes["data-code-kind"]).toBe(
      "indented"
    )
    expect(codeTools(state)).toHaveLength(1)
    expect(codeTools(state)[0]?.from).toBe(state.doc.line(2).from)
    expect(codeTools(state)[0]?.value.spec.block).toBe(true)
    expect(
      codeLineDecorations(state)
        .filter(({ number }) => number)
        .map(({ number }) => number)
    ).toEqual(["1", "2", "3", "4"])
    const codeRows = codeLineDecorations(state).filter(({ number }) => number)
    expect(
      codeRows.every(({ className }) => className.includes("cm-md-code-line"))
    ).toBe(true)
    expect(codeRows[0]?.className).toContain("cm-md-code-line-first")
    expect(codeRows.at(-1)?.className).toContain("cm-md-code-line-last")
    expect(
      codeLineDecorations(state)
        .filter(({ kind }) => kind === "code-indent")
        .map(({ from, to }) => ({ from, to }))
    ).toEqual(
      [1, 2, 4].map((lineNumber) => {
        const line = state.doc.line(lineNumber)
        return { from: line.from, to: line.from + 4 }
      })
    )
    expect(
      codeLineDecorations(state).some(({ className }) =>
        className.includes("cm-md-code-tools-line")
      )
    ).toBe(false)

    state = state.update({ selection: { anchor: 2 } }).state
    expect(
      codeLineDecorations(state)
        .filter(({ kind }) => kind === "code-indent")
        .map(({ from }) => from)
    ).toEqual([
      state.doc.line(1).from,
      state.doc.line(2).from,
      state.doc.line(4).from,
    ])

    state = state.update({
      effects: setCodeBlockWrapped.of({
        from: block!.from,
        signature: block!.signature,
        wrapped: true,
      }),
    }).state
    expect(codeToolWrapped(state)).toBe(true)
  })

  test("can delegate selected fence languages to another renderer", () => {
    const doc = [
      "```mermaid",
      "graph TD",
      "```",
      "",
      "```ts",
      "const answer = 42",
      "```",
    ].join("\n")
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        codeBlockExtension({
          include: (_state, block) => block.info.toLowerCase() !== "mermaid",
        }),
      ],
    })

    expect(codeWrappers(state)).toHaveLength(1)
    expect(codeTools(state)).toHaveLength(1)
    expect(codeWrappers(state)[0]?.from).toBe(doc.indexOf("```ts"))
  })

  test("restores delegated code presentation while its source is selected", () => {
    const doc = [
      "before",
      "",
      "```mermaid",
      "graph TD",
      "```",
      "",
      "after",
    ].join("\n")
    const mermaidFrom = doc.indexOf("```mermaid")
    const mermaidTo = doc.indexOf("```", mermaidFrom + 3) + 3
    const filterKey = (state: EditorState) => state.selection.main.head
    const include = (state: EditorState, block: { from: number; to: number }) =>
      block.from !== mermaidFrom ||
      (state.selection.main.head >= block.from &&
        state.selection.main.head <= block.to)
    let state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ base: markdownLanguage }),
        codeBlockExtension({ filterKey, include }),
      ],
    })

    expect(codeWrappers(state)).toHaveLength(0)
    state = state.update({
      selection: { anchor: doc.indexOf("graph") },
    }).state
    expect(codeWrappers(state)).toHaveLength(1)
    expect(codeTools(state)).toHaveLength(1)

    state = state.update({ selection: { anchor: doc.length } }).state
    expect(codeWrappers(state)).toHaveLength(0)
    expect(codeTools(state)).toHaveLength(0)
    expect(mermaidTo).toBeGreaterThan(mermaidFrom)
  })

  test("keeps delegated code presentation frozen through pointer selection", () => {
    const first = "```mermaid\ngraph TD\n  A --> B\n```"
    const second = "```mermaid\ngraph LR\n  C --> D\n```"
    const doc = [first, "", second].join("\n")
    const selectedFenceKey = (state: EditorState) =>
      state.selection.ranges.map(({ from, to }) => `${from}:${to}`).join(",")
    const include = (state: EditorState, block: { from: number; to: number }) =>
      state.selection.ranges.some(
        (range) => range.from < block.to && range.to > block.from
      )
    let state = EditorState.create({
      doc,
      selection: { anchor: 0, head: first.length },
      extensions: [
        markdown({ base: markdownLanguage }),
        codeBlockExtension({ filterKey: selectedFenceKey, include }),
      ],
    })
    const [firstWrapper] = codeWrappers(state)
    const secondFrom = doc.indexOf(second)

    state = state.update({
      selection: { anchor: secondFrom, head: doc.length },
      userEvent: "select.pointer",
    }).state

    expect(codeWrappers(state)).toMatchObject([
      { from: firstWrapper!.from, to: firstWrapper!.to },
    ])
    expect(codeWrappers(state)[0]?.value).toBe(firstWrapper?.value)

    state = state.update({ effects: refreshLivePreview.of(null) }).state
    expect(codeWrappers(state)).toMatchObject([
      { from: secondFrom, to: doc.length },
    ])
  })

  test("preserves arbitrary info text and copies only parsed code text", () => {
    const doc = ["> ```My Custom mode", "> first", "> second", "> ```"].join(
      "\n"
    )
    const state = markdownState(doc)
    const [block] = analyzeFencedCodeBlocks(state)

    expect(block).toBeDefined()
    expect(block!.info).toBe("My Custom mode")
    expect(block!.toolLineFrom).toBe(state.doc.line(1).from)
    expect(block!.toolAnchor).toBe(state.doc.line(2).from)
    expect(block!.firstContentLine).toBe(2)
    expect(block!.lastContentLine).toBe(3)
    expect(fencedCodeText(state, block!)).toBe("first\nsecond")
  })

  test("retains the parsed info range when its text also occurs in a tilde fence", () => {
    const doc = ["~~~~ ~~~", "value", "~~~~"].join("\n")
    const state = markdownState(doc)
    const [block] = analyzeFencedCodeBlocks(state)

    expect(block).toMatchObject({
      info: "~~~",
      infoFrom: "~~~~ ".length,
      infoTo: "~~~~ ~~~".length,
    })
    expect(state.sliceDoc(block!.infoFrom!, block!.infoTo!)).toBe(block!.info)
  })

  test("keeps block-level controls separate from opening-line geometry", () => {
    const doc = [
      "```js",
      "first()",
      "```",
      "",
      "```Empty",
      "```",
      "",
      "> ```Callout Custom",
      "> insideCallout();",
      "> ```",
    ].join("\n")
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), codeBlockExtension()],
    })
    const blocks = analyzeFencedCodeBlocks(state)
    const tools = codeTools(state)

    expect(tools.map(({ from, to }) => ({ from, to }))).toEqual(
      blocks.map(({ toolAnchor }) => ({ from: toolAnchor, to: toolAnchor }))
    )
    expect(tools.every(({ value }) => value.spec.block === true)).toBe(true)
    const openingLines = codeLineDecorations(state).filter(({ className }) =>
      className.includes("cm-md-code-tools-line")
    )
    expect(openingLines).toHaveLength(3)
    expect(openingLines.every(({ kind }) => kind == null)).toBe(true)
  })

  test("numbers only visible content lines and shades the cursor line", () => {
    const doc = "```odd language\nfirst\nsecond\n```"
    const second = doc.indexOf("second")
    const state = markdownState(doc, second)
    const blocks = analyzeFencedCodeBlocks(state)
    const visibleLine = state.doc.lineAt(second)
    const decorations = buildCodeBlockDecorations(state, blocks, [
      { from: visibleLine.from, to: visibleLine.to },
    ])
    const lines: Array<{
      className: string
      number: string | undefined
      kind: unknown
    }> = []

    decorations.between(
      0,
      state.doc.length,
      (_from, _to, value: Decoration) => {
        lines.push({
          className: String(value.spec.class ?? ""),
          number: value.spec.attributes?.["data-code-line-number"],
          kind: value.spec.markdownPreviewKind,
        })
      }
    )

    expect(
      lines.filter(({ number }) => number).map(({ number }) => number)
    ).toEqual(["2"])
    expect(lines.find(({ number }) => number === "2")?.className).toContain(
      "cm-md-code-active-line"
    )
    expect(lines.some(({ kind }) => kind === "code-tools")).toBe(false)
  })

  test("numbers a trailing empty content line at the visible-range endpoint", () => {
    const doc = "```ts\nfirst\n\n\n```"
    let state = markdownState(doc)
    state = state.update({
      selection: { anchor: state.doc.line(4).from },
    }).state

    const numberedLines = codeLineDecorations(state).filter(
      ({ number }) => number != null
    )

    expect(numberedLines.map(({ number }) => number)).toEqual(["1", "2", "3"])
    expect(numberedLines.at(-1)).toMatchObject({
      from: state.doc.line(4).from,
      number: "3",
    })
    expect(numberedLines.at(-1)?.className).toContain("cm-md-code-active-line")
  })

  test("shades the selection head line for nonempty selections", () => {
    const doc = "```ts\nfirst\nsecond\n```"
    const state = EditorState.create({
      doc,
      selection: {
        anchor: doc.indexOf("first"),
        head: doc.indexOf("second") + 3,
      },
      extensions: [markdown({ base: markdownLanguage })],
    })
    const lines = codeLineDecorations(state)

    expect(lines.find(({ number }) => number === "1")?.className).not.toContain(
      "cm-md-code-active-line"
    )
    expect(lines.find(({ number }) => number === "2")?.className).toContain(
      "cm-md-code-active-line"
    )
  })

  test("keeps code structure and controls while its callout is editing", () => {
    const doc = [
      "> [!note]",
      "> ```Custom Mode",
      "> first",
      "> second",
      "> ```",
    ].join("\n")
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("first") },
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension({ selectionActiveState: () => true }),
        codeBlockExtension(),
      ],
    })

    expect(state.facet(calloutEditingRange)).not.toBeNull()
    expect(codeWrappers(state)).toHaveLength(1)
    const lines = codeLineDecorations(state)
    expect(
      lines.filter(({ number }) => number).map(({ number }) => number)
    ).toEqual(["1", "2"])
    expect(
      lines.find(({ from }) => from === state.doc.line(2).from)?.className
    ).toContain("cm-md-code-line-first")
    expect(
      lines.find(({ from }) => from === state.doc.line(5).from)?.className
    ).toContain("cm-md-code-line-last")
    expect(
      lines.every(({ className }) => className.includes("cm-md-code-line"))
    ).toBe(true)
    expect(codeTools(state)).toHaveLength(1)
  })

  test("preserves extension and multiple ranges when a fence boundary snaps to line end", () => {
    const extended = codeFenceBoundaryClickSelection(
      EditorSelection.single(2),
      10,
      true,
      false
    )
    expect(extended.ranges).toHaveLength(1)
    expect(extended.main.anchor).toBe(2)
    expect(extended.main.head).toBe(10)

    const existing = EditorSelection.create([
      EditorSelection.cursor(2),
      EditorSelection.cursor(6),
    ])
    const multiple = codeFenceBoundaryClickSelection(existing, 10, false, true)
    expect(
      multiple.ranges.map(({ anchor, head }) => ({ anchor, head }))
    ).toEqual([
      { anchor: 2, head: 2 },
      { anchor: 6, head: 6 },
      { anchor: 10, head: 10 },
    ])
    expect(multiple.main.head).toBe(10)
  })

  test("maps unrelated wrappers instead of rebuilding the document-wide set", () => {
    const doc = [
      "intro",
      "",
      "```js",
      "first()",
      "```",
      "",
      "```ts",
      "second()",
      "```",
    ].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), codeBlockExtension()],
    })
    const before = codeWrappers(state)

    state = state.update({ changes: { from: 2, insert: "X" } }).state
    const afterProse = codeWrappers(state)
    expect(afterProse.map(({ value }) => value)).toEqual(
      before.map(({ value }) => value)
    )
    expect(codeTools(state).map(({ from }) => from)).toEqual(
      analyzeFencedCodeBlocks(state).map(({ toolAnchor }) => toolAnchor)
    )

    const firstCode = state.doc.toString().indexOf("first")
    state = state.update({
      changes: { from: firstCode + 2, insert: "X" },
    }).state
    const afterCode = codeWrappers(state)
    expect(afterCode[0]?.value).not.toBe(afterProse[0]?.value)
    expect(afterCode[1]?.value).toBe(afterProse[1]?.value)
  })

  test("retains structure for same-tree reconfiguration and rebuilds for a new parser", () => {
    const syntax = new Compartment()
    const unrelated = new Compartment()
    const enabled = Facet.define<boolean, boolean>({
      combine: (values) => values.at(-1) ?? false,
    })
    const doc = "```js\nfirst()\n```"
    let state = EditorState.create({
      doc,
      extensions: [
        syntax.of(markdown({ base: markdownLanguage })),
        unrelated.of(enabled.of(false)),
        codeBlockExtension(),
      ],
    })
    const initialWrapper = codeWrappers(state)[0]!.value
    const initialTool = codeTools(state)[0]!.value

    state = state.update({
      effects: unrelated.reconfigure(enabled.of(true)),
    }).state
    expect(codeWrappers(state)[0]!.value).toBe(initialWrapper)
    expect(codeTools(state)[0]!.value).toBe(initialTool)

    state = state.update({
      effects: syntax.reconfigure(
        markdown({
          base: markdownLanguage,
          extensions: [mathMarkdownExtension],
        })
      ),
    }).state
    expect(codeWrappers(state)[0]!.value).not.toBe(initialWrapper)
    expect(codeTools(state)[0]!.value).not.toBe(initialTool)
  })

  test("removes a point tool anchored at the end of an incremental refresh", () => {
    const extensions = [
      markdown({ base: markdownLanguage }),
      codeBlockExtension(),
    ]
    const state = EditorState.create({ doc: "    abc", extensions })
    expect(codeWrappers(state)).toHaveLength(1)
    expect(codeTools(state)).toHaveLength(1)

    const incremental = state.update({
      changes: { from: 4, insert: "\n" },
    }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(codeWrappers(incremental)).toEqual(codeWrappers(fresh))
    expect(codeWrappers(incremental)).toEqual([])
    expect(codeTools(incremental)).toEqual(codeTools(fresh))
    expect(codeTools(incremental)).toEqual([])
  })

  test("reparses an indentation-sensitive block after a boundary deletion", () => {
    const extensions = [
      markdown({
        base: markdownLanguage,
        extensions: [mathMarkdownExtension],
      }),
      codeBlockExtension(),
    ]
    const state = EditorState.create({ doc: "    $\nx\n", extensions })
    const incremental = state.update({
      changes: { from: 0, to: 1 },
    }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(codeWrappers(incremental)).toEqual(codeWrappers(fresh))
    expect(codeWrappers(incremental)).toEqual([])
    expect(codeTools(incremental)).toEqual(codeTools(fresh))
    expect(codeTools(incremental)).toEqual([])
  })

  test("locally reconciles fence creation and removal", () => {
    const original = [
      "before",
      "",
      "plain",
      "",
      "```js",
      "existing()",
      "```",
    ].join("\n")
    let state = EditorState.create({
      doc: original,
      extensions: [markdown({ base: markdownLanguage }), codeBlockExtension()],
    })
    const plainFrom = state.doc.toString().indexOf("plain")
    state = state.update({
      changes: {
        from: plainFrom,
        to: plainFrom + "plain".length,
        insert: "```custom\nplain\n```",
      },
    }).state

    expect(codeWrappers(state)).toHaveLength(2)
    const opening = state.doc.toString().indexOf("```custom")
    state = state.update({
      changes: { from: opening, to: opening + "```custom\n".length },
    }).state
    expect(codeWrappers(state).map(({ from, to }) => ({ from, to }))).toEqual(
      analyzeFencedCodeBlocks(state).map(({ wrapperFrom: from, to }) => ({
        from,
        to,
      }))
    )
  })

  test("reconciles fenced blocks inside a changed list subtree", () => {
    const original = [
      "- item",
      "",
      "  plain",
      "",
      "  ```js",
      "  existing()",
      "  ```",
      "",
      "after",
    ].join("\n")
    let state = EditorState.create({
      doc: original,
      extensions: [markdown({ base: markdownLanguage }), codeBlockExtension()],
    })
    const plainLine = state.doc.lineAt(state.doc.toString().indexOf("plain"))
    state = state.update({
      changes: {
        from: plainLine.from,
        to: plainLine.to,
        insert: "  ```nested custom\n  created()\n  ```",
      },
    }).state

    const analyzed = analyzeFencedCodeBlocks(state)
    expect(analyzed.map(({ info }) => info)).toEqual(["nested custom", "js"])
    expect(codeWrappers(state).map(({ from, to }) => ({ from, to }))).toEqual(
      analyzed.map(({ wrapperFrom: from, to }) => ({ from, to }))
    )
  })

  test("stores block-local wrapping independently of document text", () => {
    const doc = "```js\nconst value = 1\n```"
    let state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), codeBlockExtension()],
    })
    const [block] = analyzeFencedCodeBlocks(state)
    const [wrapperBefore] = codeWrappers(state)

    expect(wrapperAttribute(state, "data-code-wrap")).toBe("false")
    expect(codeToolWrapped(state)).toBe(false)
    state = state.update({
      effects: setCodeBlockWrapped.of({
        from: block!.from,
        signature: block!.signature,
        wrapped: true,
      }),
    }).state
    expect(codeWrappers(state)[0]?.value).toBe(wrapperBefore?.value)
    expect(wrapperAttribute(state, "data-code-wrap")).toBe("false")
    expect(codeToolWrapped(state)).toBe(true)

    state = state.update({ changes: { from: 0, insert: "preface\n\n" } }).state
    expect(codeToolWrapped(state)).toBe(true)
    expect(state.doc.toString()).toBe(`preface\n\n${doc}`)
  })

  test("drops a wrap override with its deleted block", () => {
    const block = "```js\nconst value = 1\n```"
    let state = EditorState.create({
      doc: `${block}\n\n${block}`,
      extensions: [markdown({ base: markdownLanguage }), codeBlockExtension()],
    })
    const [first] = analyzeFencedCodeBlocks(state)
    state = state.update({
      effects: setCodeBlockWrapped.of({
        from: first!.from,
        signature: first!.signature,
        wrapped: true,
      }),
    }).state
    expect(codeToolWrapped(state)).toBe(true)

    state = state.update({
      changes: { from: 0, to: block.length + 2 },
    }).state

    expect(state.doc.toString()).toBe(block)
    expect(codeToolWrapped(state)).toBe(false)
  })
})
