import { SearchQuery, search, setSearchQuery } from "@codemirror/search"
import {
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state"
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view"
import { describe, expect, test, vi } from "vitest"

import {
  buildSearchHighlightDecorations,
  currentSearchMatch,
  searchMatchStateExtension,
  SearchHighlighter,
  setCurrentSearchMatch,
} from "./search-highlighter"
import { maximumContextPreservingRegexpDocumentLength } from "./search-cursor"

function searchState(doc: string, query: SearchQuery) {
  const state = EditorState.create({ doc, extensions: search() })
  return state.update({ effects: setSearchQuery.of(query) }).state
}

function highlightedRanges(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[]
) {
  return decorationRanges(
    buildSearchHighlightDecorations(state, visibleRanges),
    state.doc.length
  )
}

function decorationRanges(decorations: DecorationSet, documentLength: number) {
  const ranges: Array<{ from: number; to: number }> = []
  decorations.between(0, documentLength, (from, to) => {
    ranges.push({ from, to })
  })
  return ranges
}

function decorationClasses(decorations: DecorationSet, documentLength: number) {
  const classes: string[] = []
  decorations.between(0, documentLength, (_from, _to, decoration) => {
    classes.push(String(decoration.spec.class ?? ""))
  })
  return classes
}

function controlledView(initialState: EditorState) {
  let nextFrame = 1
  const frames = new Map<number, FrameRequestCallback>()
  const dispatched: TransactionSpec[] = []
  const ownerWindow = {
    cancelAnimationFrame(frame: number) {
      frames.delete(frame)
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const frame = nextFrame++
      frames.set(frame, callback)
      return frame
    },
  } as unknown as Window
  const mutableView = {
    dispatch(spec: TransactionSpec) {
      dispatched.push(spec)
    },
    dom: { ownerDocument: { defaultView: ownerWindow } },
    state: initialState,
    visibleRanges: [{ from: 0, to: initialState.doc.length }],
  }
  const view = mutableView as unknown as EditorView

  return {
    dispatched,
    flushFrame() {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(0)
    },
    frameCount() {
      return frames.size
    },
    mutableView,
    view,
  }
}

function applyViewUpdate(
  highlighter: SearchHighlighter,
  harness: ReturnType<typeof controlledView>,
  transaction: Transaction,
  selectionSet = false
) {
  const startState = harness.mutableView.state
  harness.mutableView.state = transaction.state
  harness.mutableView.visibleRanges = [
    { from: 0, to: transaction.state.doc.length },
  ]
  highlighter.update({
    changes: transaction.changes,
    docChanged: transaction.docChanged,
    selectionSet,
    startState,
    state: transaction.state,
    transactions: [transaction],
    view: harness.view,
    viewportChanged: false,
  } as unknown as ViewUpdate)
}

function applyDispatchedRefresh(
  highlighter: SearchHighlighter,
  harness: ReturnType<typeof controlledView>
) {
  const spec = harness.dispatched.shift()
  if (!spec) throw new Error("Expected a deferred highlight refresh")
  applyViewUpdate(highlighter, harness, harness.mutableView.state.update(spec))
}

describe("external search highlighting", () => {
  test("does not flatten an oversized document for visible multiline highlights", () => {
    const state = searchState(
      `a\\n${"x".repeat(maximumContextPreservingRegexpDocumentLength)}`,
      new SearchQuery({ regexp: true, search: "a\\s" })
    )

    expect(highlightedRanges(state, [{ from: 0, to: 10 }])).toEqual([])
  })

  test("styles the current match independently of the editor selection", () => {
    const query = new SearchQuery({ search: "one" })
    let state = EditorState.create({
      doc: "one one",
      extensions: [search(), searchMatchStateExtension],
      selection: { anchor: 0, head: 3 },
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: 4, to: 7 }),
      ],
    }).state

    expect(
      decorationClasses(
        buildSearchHighlightDecorations(state, [
          { from: 0, to: state.doc.length },
        ]),
        state.doc.length
      )
    ).toEqual(["cm-searchMatch", "cm-searchMatch cm-searchMatch-selected"])
  })

  test("maps the current match across unrelated edits and clears touched matches", () => {
    const query = new SearchQuery({ search: "two" })
    let state = EditorState.create({
      doc: "one two",
      extensions: [search(), searchMatchStateExtension],
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: 4, to: 7 }),
      ],
    }).state

    state = state.update({ changes: { from: 0, insert: "x " } }).state
    expect(currentSearchMatch(state)).toEqual({ from: 6, to: 9 })

    state = state.update({ changes: { from: 6, to: 9, insert: "three" } }).state
    expect(currentSearchMatch(state)).toBeNull()
  })

  test("preserves multiline lookbehind at a visible-range boundary", () => {
    const state = searchState(
      "foo\nbar\nend",
      new SearchQuery({ regexp: true, search: "(?<=foo\\n)bar" })
    )

    expect(highlightedRanges(state, [{ from: 4, to: 7 }])).toEqual([
      { from: 4, to: 7 },
    ])
  })

  test("finishes multiline matches that start inside the visible range", () => {
    const document = "start\nmiddle\nend"
    const from = document.indexOf("middle")
    const state = searchState(
      document,
      new SearchQuery({ regexp: true, search: "middle\\nend" })
    )

    expect(highlightedRanges(state, [{ from, to: from + 6 }])).toEqual([
      { from, to: document.length },
    ])
  })

  test("shares a completed no-match scan across many visible ranges", () => {
    const document = Array.from(
      { length: 15_000 },
      (_, index) => `line ${index} ${"x".repeat(40)}`
    ).join("\n")
    const query = new SearchQuery({ regexp: true, search: "NEVER_MATCH\\n" })
    const state = searchState(document, query)
    const step = Math.floor(document.length / 32)
    const visible = Array.from({ length: 32 }, (_, index) => ({
      from: index * step,
      to: index * step + 20,
    }))
    const originalExec = RegExp.prototype.exec
    let executions = 0
    const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      input: string
    ) {
      if (this.source === query.search) executions += 1
      return originalExec.call(this, input)
    })

    try {
      expect(highlightedRanges(state, visible)).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(executions).toBe(1)
  })

  test("preserves independent match phases after a visible-range match", () => {
    const state = searchState(
      "aaaa",
      new SearchQuery({ regexp: true, search: "[\\s\\S]+" })
    )

    expect(
      highlightedRanges(state, [
        { from: 0, to: 1 },
        { from: 2, to: 3 },
      ])
    ).toEqual([
      { from: 0, to: 4 },
      { from: 2, to: 4 },
    ])
  })

  test("coalesces edit bursts and retains mapped paint before refresh", () => {
    const initial = searchState(
      "foo\nbar\ntail",
      new SearchQuery({ regexp: true, search: "(?<=foo\\n)bar" })
    )
    const harness = controlledView(initial)
    const highlighter = new SearchHighlighter(harness.view)

    expect(harness.frameCount()).toBe(1)
    harness.flushFrame()
    applyDispatchedRefresh(highlighter, harness)
    expect(
      decorationRanges(highlighter.decorations, initial.doc.length)
    ).toEqual([{ from: 4, to: 7 }])

    for (let index = 0; index < 20; index += 1) {
      applyViewUpdate(
        highlighter,
        harness,
        harness.mutableView.state.update({
          changes: { from: harness.mutableView.state.doc.length, insert: "x" },
        })
      )
    }
    expect(harness.frameCount()).toBe(1)

    applyViewUpdate(
      highlighter,
      harness,
      harness.mutableView.state.update({ selection: { anchor: 1 } }),
      true
    )
    expect(
      decorationRanges(
        highlighter.decorations,
        harness.mutableView.state.doc.length
      )
    ).toEqual([{ from: 4, to: 7 }])
    expect(harness.frameCount()).toBe(1)
    highlighter.destroy()
  })

  test("rebuilds whole-word matches when selection categorization may change", () => {
    const initial = searchState(
      "foo\nbar",
      new SearchQuery({
        regexp: true,
        search: "(?<=foo\\n)bar",
        wholeWord: true,
      })
    )
    const harness = controlledView(initial)
    const highlighter = new SearchHighlighter(harness.view)
    harness.flushFrame()
    applyDispatchedRefresh(highlighter, harness)
    expect(harness.frameCount()).toBe(0)

    applyViewUpdate(
      highlighter,
      harness,
      harness.mutableView.state.update({ selection: { anchor: 2 } }),
      true
    )
    expect(harness.frameCount()).toBe(1)
    expect(
      decorationRanges(highlighter.decorations, initial.doc.length)
    ).toEqual([{ from: 4, to: 7 }])
    highlighter.destroy()
  })
})
