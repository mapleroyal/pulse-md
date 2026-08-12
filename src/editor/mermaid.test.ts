import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown"
import { syntaxTreeAvailable } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import {
  type Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view"
import { describe, expect, test } from "vitest"

import {
  buildMermaidPreviewDecorations,
  invalidateMermaidPreviewGeometry,
  mermaidCacheKey,
  mermaidDiagrams,
  mermaidLivePreviewExtension,
  mermaidStyleRefreshRequested,
  unsafeMermaidSourceReason,
} from "./mermaid"
import { refreshOptionalPreviewGeometry } from "./optional-preview-geometry"

function markdownState(doc: string, cursor = 0, extra: Extension = []) {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({ addKeymap: false, base: commonmarkLanguage }),
      extra,
    ],
  })
}

describe("Mermaid typography refresh", () => {
  test("rerenders when regular typography changes", () => {
    const state = EditorState.create()
    const transaction = state.update({
      effects: refreshOptionalPreviewGeometry.of(null),
    })
    const colors = {
      background: "#fff",
      dark: false,
      fontFamily: "Inter",
      foreground: "#111",
    }

    expect(mermaidStyleRefreshRequested(transaction)).toBe(true)
    expect(mermaidCacheKey("graph TD; A-->B", "0", "default", colors)).not.toBe(
      mermaidCacheKey("graph TD; A-->B", "0", "default", {
        ...colors,
        fontFamily: "Newsreader",
      })
    )
  })

  test("regenerates cached SVG geometry after a font becomes ready", () => {
    const colors = {
      background: "#fff",
      dark: false,
      fontFamily: "Newsreader",
      foreground: "#111",
    }
    const before = mermaidCacheKey("graph TD; A-->B", "0", "default", colors)

    invalidateMermaidPreviewGeometry(false)
    expect(mermaidCacheKey("graph TD; A-->B", "0", "default", colors)).toBe(
      before
    )

    invalidateMermaidPreviewGeometry(true)
    expect(mermaidCacheKey("graph TD; A-->B", "0", "default", colors)).not.toBe(
      before
    )
  })
})

function mermaidDecorationValues(state: EditorState) {
  const values: Array<{
    readonly from: number
    readonly source: string
    readonly to: number
  }> = []
  buildMermaidPreviewDecorations(state, false).between(
    0,
    state.doc.length,
    (from, to, value: Decoration) => {
      const widget = value.spec.widget as {
        readonly source: string
      }
      values.push({
        from,
        source: widget.source,
        to,
      })
    }
  )
  return values
}

function directMermaidPreviewRanges(state: EditorState) {
  const ranges: Array<{
    readonly decoration: Decoration
    readonly from: number
    readonly occurrence: string
    readonly source: string
    readonly to: number
  }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.markdownPreviewKind !== "mermaid") return
      const widget = value.spec.widget as {
        readonly occurrence: string
        readonly source: string
      }
      ranges.push({
        decoration: value,
        from,
        occurrence: widget.occurrence,
        source: widget.source,
        to,
      })
    })
  }
  return ranges.sort((left, right) => left.from - right.from)
}

function directMermaidDecorationSet(state: EditorState) {
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    let found = false
    source.between(0, state.doc.length, (_from, _to, value) => {
      if (value.spec.markdownPreviewKind === "mermaid") found = true
    })
    if (found) return source as DecorationSet
  }
  throw new Error("Direct Mermaid decorations are unavailable")
}

describe("Mermaid fenced-code detection", () => {
  test("extracts closed Mermaid fences without consulting code-language data", () => {
    const doc = [
      "before",
      "",
      "```Mermaid custom metadata",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "> ```mermaid",
      "> sequenceDiagram",
      ">   Alice->>Bob: Hi",
      "> ```",
    ].join("\n")

    expect(mermaidDiagrams(markdownState(doc))).toMatchObject([
      { source: "flowchart TD\n  A --> B" },
      { source: "sequenceDiagram\n  Alice->>Bob: Hi" },
    ])
  })

  test("leaves other, empty, and unfinished fences as source", () => {
    const doc = [
      "```js",
      "graph TD",
      "```",
      "",
      "```mermaid",
      "```",
      "",
      "```mermaid",
      "graph TD",
    ].join("\n")

    expect(mermaidDiagrams(markdownState(doc))).toEqual([])
  })
})

describe("Mermaid input policy", () => {
  test.each([
    ["%%{init: { securityLevel: 'loose' }}%%\ngraph TD", "configuration"],
    ["---\nconfig:\n  securityLevel: loose\n---\ngraph TD", "title metadata"],
    [
      '---\n"config":\n  themeCSS: |\n    rect { fill: url(https://example.com/pixel) }\n---\ngraph TD',
      "title metadata",
    ],
    ["---\n'config': {}\n---\ngraph TD", "title metadata"],
    ["---\n!!str config: {}\n---\ngraph TD", "title metadata"],
    ["---\ntitle: Safe\nconfig: {}\n---\ngraph TD", "title metadata"],
    ["---\ntitle: |\n  Multiline\n---\ngraph TD", "title metadata"],
    ["---\ntitle: Missing close\ngraph TD", "title metadata"],
    ["graph TD\nclick A callback", "click"],
    ['graph TD; click A "https://example.com"', "click"],
    ["graph TD\nA[![alt](https://example.com/a.png)]", "image"],
    ["graph TD\nA[![a\\]](https://example.com/a.png)]", "image"],
    ["graph TD\nA@{ img: 'https://example.com/a.png' }", "node metadata"],
    ['graph TD\nA@{ "img": "https://example.com/a.png" }', "node metadata"],
    ["graph TD\nA@{ 'image': 'https://example.com/a.png' }", "node metadata"],
    ["graph TD\nA@{ shape: rect }", "node metadata"],
    ["graph TD\nclassDef static fill:red", "Mermaid CSS"],
    [
      String.raw`C4Context
UpdateElementStyle(a, $bgColor="u\72l(https://example.com/a.svg)")`,
      "Mermaid CSS",
    ],
    ['C4Context\nUpdateRelStyle(a, $lineColor="red")', "Mermaid CSS"],
    ["graph TD\nA\nstyle A fill:url(https://example.com/a.png)", "Mermaid CSS"],
    ["graph TD\nA[<img src=x>]", "HTML"],
    ["eventmodeling\nevt Start", "HTML labels"],
  ])("rejects active or resource-loading input", (source, reason) => {
    expect(unsafeMermaidSourceReason(source)).toContain(reason)
  })

  test("allows ordinary static diagrams and title metadata", () => {
    expect(
      unsafeMermaidSourceReason(
        "---\ntitle: Request path\n---\nsequenceDiagram\nA->>B: https://example.com"
      )
    ).toBeNull()
    expect(unsafeMermaidSourceReason("---\n\n---\ngraph TD\nA")).toBeNull()
  })

  test("leaves oversized fences to ordinary code presentation", () => {
    const source = `graph TD\n${"A".repeat(50_001)}`
    const doc = `\`\`\`mermaid\n${source}\n\`\`\``

    expect(mermaidDiagrams(markdownState(doc))).toEqual([])
    expect(unsafeMermaidSourceReason(source)).toContain("exceeds")
  })
})

describe("Mermaid live preview", () => {
  test("creates a block replacement without loading the renderer", () => {
    const state = markdownState("```mermaid\ngraph TD\n  A --> B\n```")
    const values = mermaidDecorationValues(state)

    expect(values).toMatchObject([
      {
        source: "graph TD\n  A --> B",
      },
    ])
    expect(values[0]?.from).toBe(0)
    expect(values[0]?.to).toBe(state.doc.length)
  })

  test("reveals source for an active caret or any nonempty selection", () => {
    const doc = "```mermaid\ngraph TD\n  A --> B\n```"
    const inside = doc.indexOf("graph") + 2
    const state = markdownState(doc, inside)

    expect(buildMermaidPreviewDecorations(state).size).toBe(0)
    expect(buildMermaidPreviewDecorations(state, false).size).toBe(1)

    const selected = state.update({
      selection: { anchor: inside, head: inside + 4 },
    }).state
    expect(buildMermaidPreviewDecorations(selected, false).size).toBe(0)
  })

  test("updates one edited diagram while retaining distant diagrams", () => {
    let state = markdownState(
      [
        "```mermaid",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "```mermaid",
        "graph LR",
        "  C --> D",
        "```",
      ].join("\n"),
      0
    )
    const renderedSources = () => {
      const sources: string[] = []
      buildMermaidPreviewDecorations(state, false, "neutral").between(
        0,
        state.doc.length,
        (_from, _to, value) => {
          if (value.spec.markdownPreviewKind !== "mermaid") return
          sources.push((value.spec.widget as { source: string }).source)
        }
      )
      return sources
    }

    expect(renderedSources()).toEqual([
      "graph TD\n  A --> B",
      "graph LR\n  C --> D",
    ])
    const firstB = state.doc.toString().indexOf("B")
    state = state.update({
      changes: { from: firstB, to: firstB + 1, insert: "X" },
    }).state
    expect(renderedSources()).toEqual([
      "graph TD\n  A --> X",
      "graph LR\n  C --> D",
    ])
  })

  test("uses deterministic identities for static decoration snapshots", () => {
    let state = markdownState("```mermaid\ngraph TD\n  A --> B\n```")
    const widget = () => {
      let value: { eq(other: unknown): boolean } | undefined
      buildMermaidPreviewDecorations(state, false).between(
        0,
        state.doc.length,
        (_from, _to, decoration) => {
          if (decoration.spec.markdownPreviewKind === "mermaid") {
            value = decoration.spec.widget as { eq(other: unknown): boolean }
          }
        }
      )
      return value
    }

    const initialWidget = widget()
    expect(initialWidget).toBeDefined()
    state = state.update({ changes: { from: 0, insert: "prefix\n\n" } }).state
    expect(widget()?.eq(initialWidget)).toBe(true)
  })

  test("keeps complete direct replacements mapped across ordinary edits", () => {
    const first = "```mermaid\ngraph TD\n  A --> B\n```"
    const second = "```mermaid\ngraph LR\n  C --> D\n```"
    const filler = Array.from(
      { length: 4_000 },
      (_, index) => `paragraph ${index}`
    ).join("\n\n")
    const doc = [first, "", filler, "", second].join("\n")
    const extension = mermaidLivePreviewExtension({
      selectionActive: () => false,
    })
    let state = markdownState(doc, 0, extension)

    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false)
    expect(
      directMermaidPreviewRanges(state).map(({ source }) => source)
    ).toEqual(["graph TD\n  A --> B", "graph LR\n  C --> D"])

    const initial = directMermaidPreviewRanges(state)
    const prosePosition = state.doc.toString().indexOf("paragraph 2000")
    state = state.update({
      changes: {
        from: prosePosition + "paragraph".length,
        insert: " updated",
      },
    }).state
    const mapped = directMermaidPreviewRanges(state)
    expect(mapped.map(({ occurrence }) => occurrence)).toEqual(
      initial.map(({ occurrence }) => occurrence)
    )
    expect(mapped[1]!.from).toBeGreaterThan(initial[1]!.from)
    expect(mapped[1]!.decoration).toBe(initial[1]!.decoration)

    const firstTarget = state.doc.toString().indexOf("A --> B")
    state = state.update({
      changes: {
        from: firstTarget,
        to: firstTarget + "A --> B".length,
        insert: "A --> X",
      },
    }).state
    const edited = directMermaidPreviewRanges(state)
    expect(edited.map(({ source }) => source)).toEqual([
      "graph TD\n  A --> X",
      "graph LR\n  C --> D",
    ])
    expect(edited[0]!.occurrence).not.toBe(initial[0]!.occurrence)
    expect(edited[1]!.occurrence).toBe(initial[1]!.occurrence)
    expect(edited[1]!.decoration).toBe(initial[1]!.decoration)
  })

  test("reuses complete decoration state for selections outside diagrams", () => {
    const diagram = "```mermaid\ngraph TD\n  A --> B\n```"
    const doc = ["before one", "before two", "", diagram, "", "after"].join(
      "\n"
    )
    let state = markdownState(doc, 0, mermaidLivePreviewExtension())
    const decorations = directMermaidDecorationSet(state)

    state = state.update({
      selection: { anchor: doc.indexOf("before two") },
    }).state

    expect(directMermaidDecorationSet(state)).toBe(decorations)
  })

  test("fully invalidates fence pairing while retaining unaffected occurrences", () => {
    const diagram = (direction: string, edge: string) =>
      ["```mermaid", `graph ${direction}`, `  ${edge}`, "```"].join("\n")
    const first = diagram("TD", "A --> B")
    const second = diagram("LR", "C --> D")
    const third = diagram("TB", "E --> F")
    const doc = [first, "", "between", "", second, "", third].join("\n")
    const extension = mermaidLivePreviewExtension({
      selectionActive: () => false,
    })
    let state = markdownState(doc, 0, extension)
    const initial = directMermaidPreviewRanges(state)
    const thirdOccurrence = initial[2]!.occurrence
    const firstClosing = doc.indexOf("```", "```mermaid".length)

    state = state.update({
      changes: {
        from: firstClosing,
        to: firstClosing + 3,
        insert: "``",
      },
    }).state
    const repairedPairing = directMermaidPreviewRanges(state)
    expect(repairedPairing.map(({ source }) => source)).toEqual(
      mermaidDiagrams(state).map(({ source }) => source)
    )
    expect(
      repairedPairing.find(({ source }) => source === "graph TB\n  E --> F")
        ?.occurrence
    ).toBe(thirdOccurrence)

    state = state.update({
      changes: { from: firstClosing, insert: "`" },
    }).state
    expect(
      directMermaidPreviewRanges(state).map(({ source }) => source)
    ).toEqual([
      "graph TD\n  A --> B",
      "graph LR\n  C --> D",
      "graph TB\n  E --> F",
    ])
    expect(directMermaidPreviewRanges(state)[2]!.occurrence).toBe(
      thirdOccurrence
    )
  })
})
