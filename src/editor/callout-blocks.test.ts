import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { StreamLanguage } from "@codemirror/language"
import { perl } from "@codemirror/legacy-modes/mode/perl"
import { SearchQuery, search, setSearchQuery } from "@codemirror/search"
import { Compartment, EditorState, Facet } from "@codemirror/state"
import {
  BlockWrapper,
  type Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view"
import { describe, expect, test } from "vitest"

import {
  analyzeMarkdownQuoteBlocks,
  buildCalloutFoldDecorations,
  buildQuoteBlockWrappers,
  calloutAtPosition,
  calloutBlockExtension,
  calloutEditingRange,
  isCalloutHeaderMarker,
  setCalloutCollapsed,
  type CalloutBlock,
} from "./callout-blocks"
import { refreshLivePreview } from "./interactive-preview"
import { mathMarkdownExtension } from "./math"
import { editorSearchSupport } from "./search-support"
import {
  searchMatchStateExtension,
  setCurrentSearchMatch,
  setEditorSearchQuery,
} from "./search-state"

function markdownState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
}

function callouts(doc: string) {
  return analyzeMarkdownQuoteBlocks(markdownState(doc)).filter(
    (block): block is CalloutBlock => block.kind === "callout"
  )
}

function stateFoldRanges(state: EditorState) {
  const ranges: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    ;(source as DecorationSet).between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        if (value.spec.markdownPreviewKind === "callout-fold") {
          ranges.push(`${from}:${to}`)
        }
      }
    )
  }
  return ranges
}

function stateCalloutHeaderRanges(state: EditorState) {
  const ranges: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    ;(source as DecorationSet).between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        if (value.spec.markdownPreviewKind === "callout-header") {
          ranges.push(`${from}:${to}`)
        }
      }
    )
  }
  return ranges
}

function stateCalloutHeaderEntries(state: EditorState) {
  const entries: Array<{
    from: number
    to: number
    value: Decoration
  }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    ;(source as DecorationSet).between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        if (value.spec.markdownPreviewKind === "callout-header") {
          entries.push({ from, to, value })
        }
      }
    )
  }
  return entries
}

function stateCalloutHeaderLineRanges(state: EditorState) {
  const ranges: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    ;(source as DecorationSet).between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        if (
          typeof value.spec.class === "string" &&
          value.spec.class.includes("cm-md-callout-header-line")
        ) {
          ranges.push(`${from}:${to}`)
        }
      }
    )
  }
  return ranges
}

function stateCalloutNestedGapRanges(state: EditorState) {
  const ranges: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue
    ;(source as DecorationSet).between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        if (
          from === to &&
          value.spec.block === true &&
          value.spec.widget != null
        ) {
          ranges.push(`${from}:${to}`)
        }
      }
    )
  }
  return ranges
}

function stateCalloutTitleMatches(state: EditorState) {
  return stateCalloutHeaderEntries(state).map(
    ({ value }) =>
      (
        value.spec.widget as {
          readonly titleMatches: readonly {
            readonly from: number
            readonly selected: boolean
            readonly to: number
          }[]
        }
      ).titleMatches
  )
}

function stateCalloutCardWrappers(state: EditorState) {
  const entries: Array<{
    from: number
    to: number
    type: string
    value: BlockWrapper
  }> = []
  for (const source of state.facet(EditorView.blockWrappers)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (from, to, value) => {
      const wrapper = value as BlockWrapper & {
        attributes: Record<string, string>
      }
      const type = wrapper.attributes["data-callout-type"]
      if (type) entries.push({ from, to, type, value })
    })
  }
  return entries
}

function stateCalloutWrapperRangeSet(state: EditorState) {
  for (const source of state.facet(EditorView.blockWrappers)) {
    if (typeof source === "function") continue
    let containsCallout = false
    source.between(0, state.doc.length, (_from, _to, value) => {
      const wrapper = value as BlockWrapper & {
        attributes: Record<string, string>
      }
      if (wrapper.attributes["data-callout-type"]) containsCallout = true
    })
    if (containsCallout) return source
  }
  throw new Error("Callout wrapper RangeSet is unavailable")
}

function rangeSetChunks(set: unknown) {
  const chunks: object[] = []
  const visited = new Set<object>()
  let layer = set as {
    readonly chunk: readonly object[]
    readonly nextLayer: unknown
  }
  while (!visited.has(layer)) {
    visited.add(layer)
    chunks.push(...layer.chunk)
    layer = layer.nextLayer as typeof layer
  }
  return chunks
}

function stateOrdinaryQuoteWrapperRanges(state: EditorState) {
  const ranges: string[] = []
  for (const source of state.facet(EditorView.blockWrappers)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (from, to, value) => {
      const wrapper = value as BlockWrapper & {
        attributes: Record<string, string>
      }
      if (wrapper.attributes.class === "cm-md-quote-block") {
        ranges.push(`${from}:${to}`)
      }
    })
  }
  return ranges
}

function stateCalloutWrapperTypes(state: EditorState) {
  const types: string[] = []
  for (const source of state.facet(EditorView.blockWrappers)) {
    if (typeof source === "function") continue
    source.between(0, state.doc.length, (_from, _to, wrapper) => {
      const attributes = (
        wrapper as unknown as { attributes: Record<string, string> }
      ).attributes
      const type = attributes["data-callout-type"]
      if (type) types.push(type)
    })
  }
  return types
}

describe("callout block analysis", () => {
  test("accepts arbitrary case-insensitive types and preserves authored titles", () => {
    const doc =
      "> [!QUESTION] 1. Multiple Choice\n> question body\n\n" +
      "> [!LiterallyAnything] Bespoke title\n> custom body"
    const parsed = callouts(doc)

    expect(
      parsed.map(({ type, title, category }) => ({ type, title, category }))
    ).toEqual([
      { type: "question", title: "1. Multiple Choice", category: "question" },
      { type: "literallyanything", title: "Bespoke title", category: "info" },
    ])
    expect(
      parsed.map(({ titleFrom, titleTo }) =>
        titleFrom == null || titleTo == null
          ? null
          : doc.slice(titleFrom, titleTo)
      )
    ).toEqual(["1. Multiple Choice", "Bespoke title"])
  })

  test("distinguishes callout marker links from ordinary shortcut links", () => {
    const doc = "  > > [!answer]- Title\n  > > body\n\n[ordinary]"
    const state = markdownState(doc)
    const markerFrom = doc.indexOf("[!answer]")
    const ordinaryFrom = doc.indexOf("[ordinary]")

    expect(
      isCalloutHeaderMarker(state, markerFrom, markerFrom + "[!answer]".length)
    ).toBe(true)
    expect(
      isCalloutHeaderMarker(
        state,
        ordinaryFrom,
        ordinaryFrom + "[ordinary]".length
      )
    ).toBe(false)
  })

  test("uses the normalized type as the title when no title is authored", () => {
    const [parsed] = callouts("> [!custom-type]\n> body")
    expect(parsed?.title).toBe("Custom Type")
  })

  test("recognizes Obsidian aliases without limiting custom types", () => {
    const parsed = callouts(
      [
        "summary",
        "hint",
        "check",
        "faq",
        "attention",
        "missing",
        "error",
        "cite",
      ]
        .map((type) => `> [!${type}]\n> body`)
        .join("\n\n")
    )

    expect(parsed.map(({ category }) => category)).toEqual([
      "abstract",
      "tip",
      "success",
      "question",
      "warning",
      "failure",
      "danger",
      "quote",
    ])
  })

  test("retains deeply nested callouts as distinct semantic blocks", () => {
    const doc =
      "> [!question] 1. Multiple Choice\n" +
      "> Which answer?\n" +
      "> > [!answer]-\n" +
      "> > b) ATP production\n" +
      "> > > [!deeper]-\n" +
      "> > > deeply nested"
    const parsed = callouts(doc)

    expect(
      parsed.map(({ type, depth, modifier }) => ({ type, depth, modifier }))
    ).toEqual([
      { type: "question", depth: 1, modifier: null },
      { type: "answer", depth: 2, modifier: "-" },
      { type: "deeper", depth: 3, modifier: "-" },
    ])
    expect(parsed[1]!.wrapperFrom).toBe(markdownState(doc).doc.line(3).from)
    expect(parsed[2]!.wrapperFrom).toBe(markdownState(doc).doc.line(5).from)
  })

  test("resolves the deepest callout at nested content", () => {
    const doc = [
      "> [!example] Outer",
      "> outer body",
      "> > [!tip] Nested",
      "> > nested body",
      "> outer tail",
    ].join("\n")
    const state = markdownState(doc)

    expect(calloutAtPosition(state, doc.indexOf("nested body"))).toMatchObject({
      depth: 2,
      type: "tip",
    })
    expect(
      calloutAtPosition(state, doc.indexOf("outer tail"), 1)
    ).toMatchObject({ depth: 1, type: "example" })
  })

  test("implements authored expanded, collapsed, and non-collapsible modes", () => {
    const parsed = callouts(
      "> [!note]+ Expanded\n> body\n\n" +
        "> [!tip]- Collapsed\n> body\n\n" +
        "> [!warning] Fixed\n> body"
    )

    expect(
      parsed.map(({ foldable, initiallyCollapsed }) => ({
        foldable,
        initiallyCollapsed,
      }))
    ).toEqual([
      { foldable: true, initiallyCollapsed: false },
      { foldable: true, initiallyCollapsed: true },
      { foldable: false, initiallyCollapsed: false },
    ])
  })

  test("indexes callouts beyond CodeMirror's initial partial parse", () => {
    const filler = Array.from(
      { length: 1_000 },
      (_value, index) => `Paragraph ${index}. Ordinary text.`
    ).join("\n\n")
    const doc = [
      "> [!note] Near the start",
      "> first body",
      "",
      filler,
      "",
      "> [!success]+ Combined feature card",
      "> body before code",
      ">",
      "> ```typescript",
      "> const combined = true;",
      "> ```",
    ].join("\n")

    const parsed = callouts(doc)

    expect(parsed.map(({ type }) => type)).toEqual(["note", "success"])
    expect(parsed[1]?.foldable).toBe(true)
    expect(parsed[1]?.to).toBe(doc.length)
  })
})

describe("callout block structure", () => {
  test("drops an ordinary quote wrapper when all of its source is deleted", () => {
    let state = EditorState.create({
      doc: "> ",
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })

    expect(stateOrdinaryQuoteWrapperRanges(state)).toEqual(["0:2"])

    state = state.update({ changes: { from: 0, to: state.doc.length } }).state

    expect(analyzeMarkdownQuoteBlocks(state)).toEqual([])
    expect(stateOrdinaryQuoteWrapperRanges(state)).toEqual([])
  })

  test("retains untouched callout header line points across a remote edit", () => {
    const doc = "> [!note] One\n> body\n\nplain\n\n> [!tip] Two\n> body"
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })

    expect(stateCalloutHeaderLineRanges(state)).toEqual(["0:0", "29:29"])

    state = state.update({
      changes: { from: doc.indexOf("plain") + 2, insert: "x" },
    }).state

    expect(stateCalloutHeaderLineRanges(state)).toEqual(["0:0", "30:30"])

    state = state.update({ changes: { from: 0, to: state.doc.length } }).state

    expect(stateCalloutHeaderLineRanges(state)).toEqual([])
  })

  test("creates nested semantic wrappers and gives unknown types the info style", () => {
    const state = markdownState(
      "> ordinary\n> > nested\n\n> [!unknown] Custom\n> body"
    )
    const blocks = analyzeMarkdownQuoteBlocks(state)
    const wrappers = buildQuoteBlockWrappers(blocks)
    const found: Array<{
      from: number
      to: number
      tagName: string
      attributes: Record<string, string>
    }> = []

    wrappers.between(0, state.doc.length, (from, to, value: BlockWrapper) => {
      const wrapper = value as unknown as {
        tagName: string
        attributes: Record<string, string>
      }
      found.push({
        from,
        to,
        tagName: wrapper.tagName,
        attributes: wrapper.attributes,
      })
    })

    expect(found.map(({ tagName }) => tagName).sort()).toEqual([
      "blockquote",
      "blockquote",
      "div",
      "div",
    ])
    const quotes = found
      .filter(({ tagName }) => tagName === "blockquote")
      .sort(
        (left, right) =>
          Number(left.attributes["data-quote-depth"]) -
          Number(right.attributes["data-quote-depth"])
      )
    const callout = found.find(({ attributes }) =>
      attributes.class?.split(" ").includes("cm-md-callout")
    )
    const body = found.find(
      ({ attributes }) => attributes.class === "cm-md-callout-body"
    )
    expect(quotes[0]?.attributes["data-quote-depth"]).toBe("1")
    expect(quotes[1]?.attributes["data-quote-depth"]).toBe("2")
    expect(callout?.attributes.class).toContain("cm-md-callout-info")
    expect(callout?.attributes.class).toContain("cm-md-callout-palette-info")
    expect(callout?.attributes["data-callout-type"]).toBe("unknown")
    expect(callout?.attributes["data-callout-palette"]).toBe("info")
    expect(body?.attributes["data-callout-body-from"]).toBeDefined()
  })

  test("places measured spacing outside nested callout cards", () => {
    const state = markdownState(
      "> [!question] Outer\n" +
        "> body\n" +
        "> > [!answer] Nested\n" +
        "> > nested body"
    )
    const wrappers = buildQuoteBlockWrappers(analyzeMarkdownQuoteBlocks(state))
    const found: Array<{
      from: number
      to: number
      rank: number
      attributes: Record<string, string>
    }> = []

    wrappers.between(0, state.doc.length, (from, to, value: BlockWrapper) => {
      const wrapper = value as unknown as {
        rank: number
        attributes: Record<string, string>
      }
      found.push({
        from,
        to,
        rank: wrapper.rank,
        attributes: wrapper.attributes,
      })
    })

    const outer = found.find(
      ({ attributes }) => attributes["data-callout-depth"] === "1"
    )
    const gap = found.find(
      ({ attributes }) => attributes["data-callout-gap-depth"] === "2"
    )
    const nested = found.find(
      ({ attributes }) => attributes["data-callout-depth"] === "2"
    )

    expect(gap).toBeDefined()
    expect([gap?.from, gap?.to]).toEqual([nested?.from, nested?.to])
    expect(outer!.rank).toBeGreaterThan(gap!.rank)
    expect(gap!.rank).toBeGreaterThan(nested!.rank)
  })

  test("maps semantic categories onto the six visual palettes", () => {
    const state = markdownState(
      [
        "abstract",
        "bug",
        "danger",
        "example",
        "failure",
        "important",
        "info",
        "question",
        "quote",
        "success",
        "tip",
        "todo",
        "warning",
      ]
        .map((type) => `> [!${type}]\n> body`)
        .join("\n\n")
    )
    const wrappers = buildQuoteBlockWrappers(analyzeMarkdownQuoteBlocks(state))
    const palettes: string[] = []

    wrappers.between(0, state.doc.length, (_from, _to, value: BlockWrapper) => {
      const attributes = (
        value as unknown as { attributes: Record<string, string> }
      ).attributes
      if (attributes["data-callout-palette"])
        palettes.push(attributes["data-callout-palette"])
    })

    expect(palettes).toEqual([
      "info",
      "danger",
      "danger",
      "example",
      "danger",
      "example",
      "info",
      "quote",
      "quote",
      "success",
      "tip",
      "success",
      "danger",
    ])
  })

  test("folds only the outermost collapsed callout until its parent expands", () => {
    const parsed = callouts(
      "> [!answer]- Answer\n" +
        "> body\n" +
        "> > [!deeper]- Deep\n" +
        "> > nested body"
    )
    const initiallyFolded = buildCalloutFoldDecorations(parsed)
    const initialRanges: string[] = []

    initiallyFolded.between(
      0,
      Number.MAX_SAFE_INTEGER,
      (from, to, value: Decoration) => {
        if (value.spec.markdownPreviewKind === "callout-fold") {
          initialRanges.push(`${from}:${to}`)
        }
      }
    )
    expect(initialRanges).toEqual([
      `${parsed[0]!.bodyFrom! - 1}:${parsed[0]!.to}`,
    ])
    const initiallyVisibleWrappers = buildQuoteBlockWrappers(parsed, new Map())
    const initialWrapperTypes: string[] = []
    initiallyVisibleWrappers.between(
      0,
      Number.MAX_SAFE_INTEGER,
      (_from, _to, wrapper: BlockWrapper) => {
        const attributes = (
          wrapper as unknown as { attributes: Record<string, string> }
        ).attributes
        const type = attributes["data-callout-type"]
        if (type) initialWrapperTypes.push(type)
      }
    )
    expect(initialWrapperTypes).toEqual(["answer"])

    const overrides = new Map([
      [
        parsed[0]!.headerFrom,
        { collapsed: false, signature: parsed[0]!.signature },
      ],
    ])
    const parentExpanded = buildCalloutFoldDecorations(parsed, overrides)
    const expandedRanges: string[] = []
    parentExpanded.between(
      0,
      Number.MAX_SAFE_INTEGER,
      (from, to, value: Decoration) => {
        if (value.spec.markdownPreviewKind === "callout-fold") {
          expandedRanges.push(`${from}:${to}`)
        }
      }
    )
    expect(expandedRanges).toEqual([
      `${parsed[1]!.bodyFrom! - 1}:${parsed[1]!.to}`,
    ])
    const expandedWrappers = buildQuoteBlockWrappers(parsed, overrides)
    const expandedWrapperTypes: string[] = []
    expandedWrappers.between(
      0,
      Number.MAX_SAFE_INTEGER,
      (_from, _to, wrapper: BlockWrapper) => {
        const attributes = (
          wrapper as unknown as { attributes: Record<string, string> }
        ).attributes
        const type = attributes["data-callout-type"]
        if (type) expandedWrapperTypes.push(type)
      }
    )
    expect(expandedWrapperTypes).toEqual(["answer", "deeper"])
  })

  test("keeps a collapsing body mounted as a measured nested wrapper", () => {
    const doc = "> [!answer]+ Answer\n> body"
    const state = markdownState(doc)
    const [callout] = callouts(doc)
    const overrides = new Map([
      [callout!.headerFrom, { collapsed: true, signature: callout!.signature }],
    ])
    const transitions = new Map([
      [
        callout!.headerFrom,
        {
          collapsed: true,
          from: callout!.headerFrom,
          signature: callout!.signature,
          token: 1,
        },
      ],
    ])

    const transitioningFolds = buildCalloutFoldDecorations(
      [callout!],
      overrides,
      null,
      transitions
    )
    expect(transitioningFolds.size).toBe(0)

    const transitioningWrappers = buildQuoteBlockWrappers(
      [callout!],
      overrides,
      null,
      transitions
    )
    const found: Array<{
      from: number
      to: number
      rank: number
      attributes: Record<string, string>
    }> = []
    transitioningWrappers.between(
      0,
      state.doc.length,
      (from, to, value: BlockWrapper) => {
        const wrapper = value as unknown as {
          rank: number
          attributes: Record<string, string>
        }
        found.push({
          from,
          to,
          rank: wrapper.rank,
          attributes: wrapper.attributes,
        })
      }
    )

    const card = found.find(({ attributes }) => attributes["data-callout-type"])
    const body = found.find(
      ({ attributes }) => attributes["data-callout-body-from"]
    )
    expect(card?.attributes.class).not.toContain("cm-md-callout-collapsed")
    expect([body?.from, body?.to]).toEqual([callout!.bodyFrom, callout!.to])
    expect(body!.rank).toBeLessThan(card!.rank)

    const finishedFolds = buildCalloutFoldDecorations([callout!], overrides)
    const finishedRanges: string[] = []
    finishedFolds.between(
      0,
      state.doc.length,
      (from, to, value: Decoration) => {
        if (value.spec.markdownPreviewKind === "callout-fold") {
          finishedRanges.push(`${from}:${to}`)
        }
      }
    )
    expect(finishedRanges).toEqual([`${callout!.bodyFrom! - 1}:${callout!.to}`])
  })

  test("stores disclosure overrides in CodeMirror state", () => {
    const doc =
      "> [!answer]- Answer\n" +
      "> body\n" +
      "> > [!deeper]- Deep\n" +
      "> > nested body"
    const parsed = callouts(doc)
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })

    expect(stateFoldRanges(state)).toEqual([
      `${parsed[0]!.bodyFrom! - 1}:${parsed[0]!.to}`,
    ])

    state = state.update({
      effects: setCalloutCollapsed.of({
        from: parsed[0]!.headerFrom,
        signature: parsed[0]!.signature,
        collapsed: false,
      }),
    }).state

    expect(stateFoldRanges(state)).toEqual([
      `${parsed[1]!.bodyFrom! - 1}:${parsed[1]!.to}`,
    ])

    state = state.update({ changes: { from: 0, insert: "intro\n\n" } }).state
    const shifted = analyzeMarkdownQuoteBlocks(state).filter(
      (block): block is CalloutBlock => block.kind === "callout"
    )
    expect(stateFoldRanges(state)).toEqual([
      `${shifted[1]!.bodyFrom! - 1}:${shifted[1]!.to}`,
    ])
  })

  test("does not transfer a deleted override to an identical following callout", () => {
    const callout = "> [!answer]- Answer\n> body"
    const doc = `${callout}\n\n${callout}`
    const parsed = callouts(doc)
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })

    state = state.update({
      effects: setCalloutCollapsed.of({
        from: parsed[0]!.headerFrom,
        signature: parsed[0]!.signature,
        collapsed: false,
      }),
    }).state
    state = state.update({
      changes: {
        from: parsed[0]!.headerLineFrom,
        to: parsed[1]!.headerFrom,
        insert: "> ",
      },
    }).state

    const remaining = analyzeMarkdownQuoteBlocks(state).filter(
      (block): block is CalloutBlock => block.kind === "callout"
    )
    expect(remaining).toHaveLength(1)
    expect(stateFoldRanges(state)).toEqual([
      `${remaining[0]!.bodyFrom! - 1}:${remaining[0]!.to}`,
    ])
  })

  test("keeps every layout-affecting header replacement in editor state", () => {
    const filler = Array.from(
      { length: 1_000 },
      (_value, index) => `Paragraph ${index}. Ordinary text.`
    ).join("\n\n")
    const doc = [
      "> [!note] Near header",
      "> body",
      "",
      filler,
      "",
      "> [!tip] Far header",
      "> body",
    ].join("\n")
    const parsed = callouts(doc)
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        search(),
        searchMatchStateExtension,
        calloutBlockExtension(),
      ],
    })
    const expectedRanges = parsed.map(
      ({ headerFrom, headerTo }) => `${headerFrom}:${headerTo}`
    )

    expect(stateCalloutHeaderRanges(state)).toEqual(expectedRanges)

    const query = new SearchQuery({ search: "Far header" })
    state = state.update({
      effects: [setSearchQuery.of(query), setEditorSearchQuery.of(query)],
    }).state
    expect(stateCalloutHeaderRanges(state)).toEqual(expectedRanges)
  })

  test("does not evaluate rejected multiline searches inside callout titles", () => {
    let state = EditorState.create({
      doc: "> [!note] Title Title\n> body",
      extensions: [
        markdown({ base: markdownLanguage }),
        search(),
        searchMatchStateExtension,
        calloutBlockExtension(),
      ],
    })
    const query = new SearchQuery({
      regexp: true,
      search: "(?:Title|Name)+\\s?",
    })
    const issue = editorSearchSupport.queryIssue(state, query)
    expect(issue).toBe("multiline-regexp-complexity-limit")

    state = state.update({
      effects: editorSearchSupport.queryEffects(query, issue),
    }).state

    expect(stateCalloutTitleMatches(state)).toEqual([[]])
  })

  test("refreshes only the previous and next selected search-match headers", () => {
    const doc = [
      "> [!note] Target one",
      "> body",
      "",
      "> [!tip] Target two",
      "> body",
      "",
      "> [!warning] Target three",
      "> body",
    ].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        search(),
        searchMatchStateExtension,
        calloutBlockExtension(),
      ],
    })
    const query = new SearchQuery({ search: "Target" })
    state = state.update({
      effects: [setSearchQuery.of(query), setEditorSearchQuery.of(query)],
    }).state
    const queriedHeaders = stateCalloutHeaderEntries(state)
    const matches = Array.from(doc.matchAll(/Target/g), ({ index }) => ({
      from: index,
      to: index + "Target".length,
    }))

    state = state.update({
      effects: setCurrentSearchMatch.of(matches[0]!),
    }).state
    const firstSelectedHeaders = stateCalloutHeaderEntries(state)
    expect(firstSelectedHeaders[0]!.value).not.toBe(queriedHeaders[0]!.value)
    expect(firstSelectedHeaders[1]!.value).toBe(queriedHeaders[1]!.value)
    expect(firstSelectedHeaders[2]!.value).toBe(queriedHeaders[2]!.value)

    state = state.update({
      effects: setCurrentSearchMatch.of(matches[1]!),
    }).state
    const secondSelectedHeaders = stateCalloutHeaderEntries(state)
    expect(secondSelectedHeaders[0]!.value).not.toBe(
      firstSelectedHeaders[0]!.value
    )
    expect(secondSelectedHeaders[1]!.value).not.toBe(
      firstSelectedHeaders[1]!.value
    )
    expect(secondSelectedHeaders[2]!.value).toBe(firstSelectedHeaders[2]!.value)
  })

  test("rebuilds whole-word title matches when the selection changes language context", () => {
    const doc = ["> [!note] $foo", "> body", "", "```perl", "$foo", "```"].join(
      "\n"
    )
    const perlLanguage = StreamLanguage.define(perl)
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({
          base: markdownLanguage,
          codeLanguages: (info) => (info === "perl" ? perlLanguage : null),
        }),
        search(),
        searchMatchStateExtension,
        calloutBlockExtension(),
      ],
    })
    const query = new SearchQuery({ search: "foo", wholeWord: true })
    state = state.update({
      effects: [setSearchQuery.of(query), setEditorSearchQuery.of(query)],
    }).state

    expect(stateCalloutTitleMatches(state)).toEqual([
      [{ from: 1, selected: false, to: 4 }],
    ])

    state = state.update({
      selection: { anchor: doc.lastIndexOf("$foo") + 2 },
    }).state

    expect(stateCalloutTitleMatches(state)).toEqual([[]])
  })

  test("retains structure for same-tree reconfiguration and rebuilds for a new parser", () => {
    const syntax = new Compartment()
    const unrelated = new Compartment()
    const enabled = Facet.define<boolean, boolean>({
      combine: (values) => values.at(-1) ?? false,
    })
    const doc = "> [!note] Title\n> body"
    let state = EditorState.create({
      doc,
      extensions: [
        syntax.of(markdown({ base: markdownLanguage })),
        unrelated.of(enabled.of(false)),
        calloutBlockExtension(),
      ],
    })
    const initialHeader = stateCalloutHeaderEntries(state)[0]!.value
    const initialWrapper = stateCalloutCardWrappers(state)[0]!.value

    state = state.update({
      effects: unrelated.reconfigure(enabled.of(true)),
    }).state
    expect(stateCalloutHeaderEntries(state)[0]!.value).toBe(initialHeader)
    expect(stateCalloutCardWrappers(state)[0]!.value).toBe(initialWrapper)

    state = state.update({
      effects: syntax.reconfigure(
        markdown({
          base: markdownLanguage,
          extensions: [mathMarkdownExtension],
        })
      ),
    }).state
    expect(stateCalloutHeaderEntries(state)[0]!.value).not.toBe(initialHeader)
    expect(stateCalloutCardWrappers(state)[0]!.value).not.toBe(initialWrapper)
  })

  test("retains distant indexed presentation while incrementally refreshing an edited quote subtree", () => {
    const filler = Array.from(
      { length: 50 },
      (_value, index) => `Paragraph ${index}.`
    ).join("\n\n")
    const doc = [
      "> [!note] Near header",
      "> body",
      "",
      filler,
      "",
      "> [!tip] Far header",
      "> body",
    ].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })
    const previousNearHeader = stateCalloutHeaderEntries(state)[0]!.value
    const previousFarHeader = stateCalloutHeaderEntries(state)[1]!.value
    const previousNearWrapper = stateCalloutCardWrappers(state).find(
      ({ type }) => type === "note"
    )!.value
    const previousFarWrapper = stateCalloutCardWrappers(state).find(
      ({ type }) => type === "tip"
    )!.value
    const titleFrom = doc.indexOf("Near header")

    state = state.update({
      changes: {
        from: titleFrom,
        to: titleFrom + "Near header".length,
        insert: "Changed nearby header",
      },
    }).state

    const parsed = analyzeMarkdownQuoteBlocks(state).filter(
      (block): block is CalloutBlock => block.kind === "callout"
    )
    const nextHeaders = stateCalloutHeaderEntries(state)
    const nextWrappers = stateCalloutCardWrappers(state)
    expect(stateCalloutHeaderRanges(state)).toEqual(
      parsed.map(({ headerFrom, headerTo }) => `${headerFrom}:${headerTo}`)
    )
    expect(nextHeaders[0]!.value).not.toBe(previousNearHeader)
    expect(nextHeaders[1]!.value).toBe(previousFarHeader)
    expect(nextWrappers.find(({ type }) => type === "note")!.value).not.toBe(
      previousNearWrapper
    )
    expect(nextWrappers.find(({ type }) => type === "tip")!.value).toBe(
      previousFarWrapper
    )
  })

  test("reuses distant RangeSet chunks while refreshing nearby callout structure", () => {
    const doc = Array.from(
      { length: 600 },
      (_value, index) => `> [!note] Callout ${index}\n> body ${index}`
    ).join("\n\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })
    const previousChunks = new Set(
      rangeSetChunks(stateCalloutWrapperRangeSet(state))
    )

    const titleFrom = doc.indexOf("Callout 0")
    state = state.update({
      changes: {
        from: titleFrom,
        to: titleFrom + "Callout 0".length,
        insert: "Changed callout",
      },
    }).state

    const retainedChunkCount = rangeSetChunks(
      stateCalloutWrapperRangeSet(state)
    ).filter((chunk) => previousChunks.has(chunk)).length
    expect(retainedChunkCount).toBeGreaterThan(0)
  })

  test("does not duplicate a nested-callout gap at a refresh boundary", () => {
    const doc = "x\n> > [!warning] N\n> q\n- x\n> q"
    const extensions = [
      markdown({ base: markdownLanguage }),
      calloutBlockExtension(),
    ]
    const state = EditorState.create({ doc, extensions })

    const incremental = state.update({
      changes: { from: state.doc.length, insert: "x" },
    }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(stateCalloutNestedGapRanges(incremental)).toEqual(
      stateCalloutNestedGapRanges(fresh)
    )
    expect(stateCalloutNestedGapRanges(incremental)).toHaveLength(1)
    expect(stateCalloutHeaderLineRanges(incremental)).toEqual(
      stateCalloutHeaderLineRanges(fresh)
    )
    expect(stateCalloutHeaderRanges(incremental)).toEqual(
      stateCalloutHeaderRanges(fresh)
    )
  })

  test("matches a fresh quote index when a marker edit splits lazy groups", () => {
    const doc = "> a\n> \nx\n> \nx\n> z"
    const extensions = [
      markdown({ base: markdownLanguage }),
      calloutBlockExtension(),
    ]
    const state = EditorState.create({ doc, extensions })

    const incremental = state.update({ changes: { from: 0, to: 1 } }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(stateOrdinaryQuoteWrapperRanges(incremental)).toEqual(
      stateOrdinaryQuoteWrapperRanges(fresh)
    )
    expect(stateOrdinaryQuoteWrapperRanges(incremental)).toEqual([
      "3:10",
      "13:16",
    ])
  })

  test("matches a fresh quote index when deleting a newline joins quote groups", () => {
    const doc = "> a\n\n> \nx\n> a"
    const extensions = [
      markdown({ base: markdownLanguage }),
      calloutBlockExtension(),
    ]
    const state = EditorState.create({ doc, extensions })

    const incremental = state.update({ changes: { from: 3, to: 4 } }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(stateOrdinaryQuoteWrapperRanges(incremental)).toEqual(
      stateOrdinaryQuoteWrapperRanges(fresh)
    )
    expect(stateOrdinaryQuoteWrapperRanges(incremental)).toEqual([
      "0:6",
      "9:12",
    ])
  })

  test.each([
    {
      label: "a blank separator becomes prose",
      doc: "> a\nx\n\n> [!warning]- Fold\n\nx\n> \nx\n>\tcontent\n$$",
      change: { from: 24, to: 26, insert: ">" },
      expectedLaterQuote: "33:45",
    },
    {
      label: "prose is inserted on a blank line",
      doc: "> [!note] Note\n> > nested\n> a\n>\tcontent\n\nx\n> \n$$\n> ",
      change: { from: 40, insert: "[!note]" },
      expectedLaterQuote: "56:58",
    },
  ])(
    "matches a fresh quote index when $label before a lazy quote",
    ({ doc, change, expectedLaterQuote }) => {
      const extensions = [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ]
      const state = EditorState.create({ doc, extensions })

      const incremental = state.update({ changes: change }).state
      const fresh = EditorState.create({ doc: incremental.doc, extensions })

      expect(stateOrdinaryQuoteWrapperRanges(incremental)).toEqual(
        stateOrdinaryQuoteWrapperRanges(fresh)
      )
      expect(stateOrdinaryQuoteWrapperRanges(incremental)).toContain(
        expectedLaterQuote
      )
    }
  )

  test.each([
    {
      label: "quote content changes from blank to nonblank",
      doc: "> [!note] C\n> \nx\n> \n$$\n> q\n> body",
      change: { from: 12, to: 14, insert: "> body" },
      expectedLaterQuote: "27:37",
    },
    {
      label: "a list block becomes a link definition",
      doc: "---\n> q\n1. item\n    code\n[id]: /url\n> \n$$\n> ",
      change: { from: 8, to: 15, insert: "[id]: /url" },
      expectedLaterQuote: "45:47",
    },
    {
      label: "an HTML block opener exposes a distant quote",
      doc: "<!-- hi -->\n    code\n```\n\n# heading\n> body",
      change: { from: 0, insert: "<div>\n" },
      expectedLaterQuote: "42:48",
    },
  ])(
    "matches a fresh quote index when $label",
    ({ doc, change, expectedLaterQuote }) => {
      const extensions = [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ]
      const state = EditorState.create({ doc, extensions })

      const incremental = state.update({ changes: change }).state
      const fresh = EditorState.create({ doc: incremental.doc, extensions })

      expect(stateOrdinaryQuoteWrapperRanges(incremental)).toEqual(
        stateOrdinaryQuoteWrapperRanges(fresh)
      )
      expect(stateOrdinaryQuoteWrapperRanges(incremental)).toContain(
        expectedLaterQuote
      )
    }
  )

  test("removes a final callout's mapped header point at document end", () => {
    const doc = "x\n> [!note] C"
    const extensions = [
      markdown({ base: markdownLanguage }),
      calloutBlockExtension(),
    ]
    const state = EditorState.create({ doc, extensions })

    const incremental = state.update({ changes: { from: 2, to: 13 } }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(stateCalloutHeaderLineRanges(incremental)).toEqual(
      stateCalloutHeaderLineRanges(fresh)
    )
    expect(stateCalloutHeaderLineRanges(incremental)).toEqual([])
    expect(stateCalloutHeaderRanges(incremental)).toEqual(
      stateCalloutHeaderRanges(fresh)
    )
  })

  test.each([
    {
      label: "fenced code",
      delimiter: "```",
      replaceTo: 1,
      markdownExtensions: [],
    },
    {
      label: "display math",
      delimiter: "$$",
      replaceTo: 4,
      markdownExtensions: [mathMarkdownExtension],
    },
  ])(
    "rebuilds callouts when earlier $label re-pairs later delimiters",
    ({ delimiter, markdownExtensions, replaceTo }) => {
      const doc = [
        "Before",
        "",
        delimiter,
        "content",
        delimiter,
        "",
        "> [!note] Title",
        "> body",
      ].join("\n")
      const extensions = [
        markdown({
          base: markdownLanguage,
          extensions: markdownExtensions,
        }),
        calloutBlockExtension(),
      ]
      const state = EditorState.create({ doc, extensions })
      expect(stateCalloutHeaderRanges(state)).toHaveLength(1)

      const incremental = state.update({
        changes: { from: 0, to: replaceTo, insert: delimiter },
      }).state
      const fresh = EditorState.create({ doc: incremental.doc, extensions })

      expect(stateCalloutHeaderRanges(incremental)).toEqual(
        stateCalloutHeaderRanges(fresh)
      )
      expect(stateCalloutHeaderRanges(incremental)).toEqual([])
      expect(stateCalloutWrapperTypes(incremental)).toEqual(
        stateCalloutWrapperTypes(fresh)
      )
    }
  )

  test("rechecks fence pairing when an info-string edit activates an existing marker", () => {
    const doc = [
      "``` info`",
      "code",
      "```",
      "",
      "> [!note] Title",
      "> body",
    ].join("\n")
    const extensions = [
      markdown({ base: markdownLanguage }),
      calloutBlockExtension(),
    ]
    const state = EditorState.create({ doc, extensions })
    expect(stateCalloutHeaderRanges(state)).toEqual([])

    const trailingBacktick = doc.indexOf("`", 3)
    const incremental = state.update({
      changes: {
        from: trailingBacktick,
        to: trailingBacktick + 1,
        insert: "x",
      },
    }).state
    const fresh = EditorState.create({ doc: incremental.doc, extensions })

    expect(stateCalloutHeaderRanges(incremental)).toEqual(
      stateCalloutHeaderRanges(fresh)
    )
    expect(stateCalloutHeaderRanges(incremental)).toHaveLength(1)
  })

  test("refreshes only headers touched by an active cross-block selection", () => {
    const doc = [
      "> [!note] First",
      "> body",
      "",
      "between one",
      "",
      "> [!tip] Second",
      "> body",
      "",
      "between two",
      "",
      "> [!warning] Third",
      "> body",
    ].join("\n")
    const parsed = callouts(doc)
    let state = EditorState.create({
      doc,
      selection: {
        anchor: parsed[0]!.headerFrom,
        head: doc.indexOf("between one"),
      },
      extensions: [
        markdown({ base: markdownLanguage }),
        search(),
        calloutBlockExtension({ selectionActiveState: () => true }),
      ],
    })
    const previousHeaders = stateCalloutHeaderEntries(state)
    const previousThird = previousHeaders.find(
      ({ from }) => from === parsed[2]!.headerFrom
    )!.value
    expect(
      previousHeaders.some(({ from }) => from === parsed[0]!.headerFrom)
    ).toBe(false)

    state = state.update({
      selection: {
        anchor: parsed[1]!.headerFrom,
        head: doc.indexOf("between two"),
      },
      userEvent: "select.pointer",
    }).state

    const preservedHeaders = stateCalloutHeaderEntries(state)
    expect(
      preservedHeaders.some(({ from }) => from === parsed[0]!.headerFrom)
    ).toBe(false)
    expect(
      preservedHeaders.some(({ from }) => from === parsed[1]!.headerFrom)
    ).toBe(true)

    state = state.update({
      effects: refreshLivePreview.of(null),
    }).state
    const nextHeaders = stateCalloutHeaderEntries(state)
    expect(nextHeaders.some(({ from }) => from === parsed[0]!.headerFrom)).toBe(
      true
    )
    expect(nextHeaders.some(({ from }) => from === parsed[1]!.headerFrom)).toBe(
      false
    )
    expect(
      nextHeaders.find(({ from }) => from === parsed[2]!.headerFrom)!.value
    ).toBe(previousThird)
  })

  test("matches full analysis when an edit merges adjacent quote syntax", () => {
    const doc = [
      "> [!note] First",
      "> body",
      "",
      "> ordinary",
      "",
      "> [!tip] Second",
      "> body",
    ].join("\n")
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        calloutBlockExtension(),
      ],
    })
    const separatorFrom = doc.indexOf("\n\n> [!tip]")

    state = state.update({
      changes: {
        from: separatorFrom,
        to: separatorFrom + 1,
      },
    }).state

    const fullyAnalyzed = analyzeMarkdownQuoteBlocks(state)
    const expectedCallouts = fullyAnalyzed.filter(
      (block): block is CalloutBlock => block.kind === "callout"
    )
    expect(stateCalloutHeaderRanges(state)).toEqual(
      expectedCallouts.map(
        ({ headerFrom, headerTo }) => `${headerFrom}:${headerTo}`
      )
    )
    const expectedWrapperTypes: string[] = []
    buildQuoteBlockWrappers(fullyAnalyzed).between(
      0,
      state.doc.length,
      (_from, _to, wrapper) => {
        const type = (
          wrapper as unknown as { attributes: Record<string, string> }
        ).attributes["data-callout-type"]
        if (type) expectedWrapperTypes.push(type)
      }
    )
    expect(stateCalloutWrapperTypes(state)).toEqual(expectedWrapperTypes)
  })

  test("edits the deepest containing callout without changing disclosure state", () => {
    const selectionEnabled = Facet.define<boolean, boolean>({
      combine: (values) => values.at(-1) ?? false,
    })
    const selectionActivity = new Compartment()
    const doc =
      "intro\n\n" +
      "> [!question]+ Outer\n" +
      "> body\n" +
      "> > [!answer]- Nested\n" +
      "> > secret\n\n" +
      "outro"
    const parsed = callouts(doc)
    const nested = parsed[1]!
    let state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("secret") },
      extensions: [
        markdown({ base: markdownLanguage }),
        selectionActivity.of(selectionEnabled.of(true)),
        calloutBlockExtension({
          selectionActiveState: (current) => current.facet(selectionEnabled),
        }),
      ],
    })
    expect(state.facet(calloutEditingRange)).toEqual({
      from: nested.wrapperFrom,
      to: nested.to,
    })
    expect(stateCalloutWrapperTypes(state)).toEqual(["question"])
    expect(stateFoldRanges(state)).toEqual([])

    const wrappersBeforeCaretMove = state
      .facet(EditorView.blockWrappers)
      .find((source) => typeof source !== "function")
    state = state.update({
      selection: { anchor: doc.indexOf("secret") + 1 },
    }).state
    expect(
      state
        .facet(EditorView.blockWrappers)
        .find((source) => typeof source !== "function")
    ).toBe(wrappersBeforeCaretMove)

    state = state.update({
      effects: selectionActivity.reconfigure(selectionEnabled.of(false)),
    }).state
    expect(state.facet(calloutEditingRange)).toBeNull()
    expect(stateCalloutWrapperTypes(state)).toEqual(["question", "answer"])
    expect(stateFoldRanges(state)).toEqual([
      `${nested.bodyFrom! - 1}:${nested.to}`,
    ])

    state = state.update({
      effects: selectionActivity.reconfigure(selectionEnabled.of(true)),
    }).state
    state = state.update({ selection: { anchor: 0 } }).state
    expect(state.facet(calloutEditingRange)).toBeNull()
    expect(stateCalloutWrapperTypes(state)).toEqual(["question", "answer"])
    expect(stateFoldRanges(state)).toEqual([
      `${nested.bodyFrom! - 1}:${nested.to}`,
    ])
  })
})
