import { SearchQuery, search, setSearchQuery } from "@codemirror/search"
import {
  EditorSelection,
  EditorState,
  type Text,
  type TransactionSpec,
} from "@codemirror/state"
import { afterEach, describe, expect, test, vi } from "vitest"

import { MarkdownEditorController } from "./controller"
import { maximumRepeatedRegexpPhysicalLineLength } from "./search-complexity"
import {
  contextPreservingRegexpCursor,
  createContextPreservingRegexpSearch,
  maximumContextPreservingRegexpDocumentLength,
} from "./search-cursor"
import {
  currentSearchMatch,
  searchMatchStateExtension,
  setCurrentSearchMatch,
} from "./search-highlighter"
import { editorSearchSupport, type EditorSearchSupport } from "./search-support"
import type { MarkdownSearchStatus } from "./types"

interface SearchControllerInternals {
  cancelSearchScan(): void
  continueSearchScan(matches: NonNullable<this["searchMatchCache"]>): void
  onSearchStatusChange?: (status: MarkdownSearchStatus) => void
  reportSearchStatus(state: EditorState): void
  findNext(): boolean
  findPrevious(): boolean
  replaceNextMatch(query: SearchQuery, preserveCase: boolean): boolean
  searchSupport: EditorSearchSupport
  searchMatchCache?: {
    checkpoints: Float64Array
    complete: boolean
    doc: Text
    total: number
  }
  searchStatus(state: EditorState): MarkdownSearchStatus
  view: {
    dispatch(spec: TransactionSpec): void
    state: EditorState
  }
}

afterEach(() => vi.useRealTimers())

function controllerInternals() {
  const controller = Object.create(
    MarkdownEditorController.prototype
  ) as SearchControllerInternals
  controller.searchSupport = editorSearchSupport
  return controller
}

function collectMatches<T>(cursor: Iterator<T>) {
  const matches: T[] = []
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    matches.push(next.value)
  }
  return matches
}

describe("editor search scaling", () => {
  test("bounds full-context multiline regular expressions on large documents", () => {
    const query = new SearchQuery({ regexp: true, search: "a\\sb" })
    let state = EditorState.create({
      doc: "a".repeat(maximumContextPreservingRegexpDocumentLength + 1),
      extensions: search(),
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    expect(controller.searchStatus(state)).toEqual({
      current: null,
      issue: "multiline-regexp-document-limit",
      pending: false,
      total: 0,
      valid: false,
    })
    expect(() => createContextPreservingRegexpSearch(state, query)).toThrow(
      /limited to 1,000,000/
    )
  })

  test("rejects multiline regular expressions with unbounded nested backtracking", () => {
    const query = new SearchQuery({ regexp: true, search: "(?:a+)+\\s" })
    let state = EditorState.create({
      doc: "a".repeat(64),
      extensions: search(),
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    expect(controller.searchStatus(state)).toEqual({
      current: null,
      issue: "multiline-regexp-complexity-limit",
      pending: false,
      total: 0,
      valid: false,
    })
    expect(editorSearchSupport.queryIssue(state, query)).toBe(
      "multiline-regexp-complexity-limit"
    )
  })

  test("rejects unsafe single-line regular expressions before evaluation", () => {
    const state = EditorState.create({ doc: `${"a".repeat(64)}!` })
    const query = new SearchQuery({ regexp: true, search: "(?:a+)+$" })

    expect(editorSearchSupport.queryIssue(state, query)).toBe(
      "multiline-regexp-complexity-limit"
    )
  })

  test("keeps an invalid nested quantifier classified as invalid", () => {
    const query = new SearchQuery({ regexp: true, search: "a++" })
    let state = EditorState.create({ doc: "aaaa", extensions: search() })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    expect(query.valid).toBe(false)
    expect(editorSearchSupport.queryIssue(state, query)).toBeNull()
    expect(controller.searchStatus(state)).toEqual({
      current: null,
      pending: false,
      total: 0,
      valid: false,
    })
  })

  test.each(["a+A+$", "s+S+ſ+$", "k+K+$", "ß+ẞ+$"])(
    "rejects case-folding overlap in a case-insensitive expression: %s",
    (source) => {
      const state = EditorState.create({ doc: `${"a".repeat(64)}!` })
      const query = new SearchQuery({
        caseSensitive: false,
        regexp: true,
        search: source,
      })

      expect(editorSearchSupport.queryIssue(state, query)).toBe(
        "multiline-regexp-complexity-limit"
      )
    }
  )

  test("keeps literal case distinctions for case-sensitive overlap analysis", () => {
    const state = EditorState.create({ doc: "aaaAAA!" })
    const caseSensitive = new SearchQuery({
      caseSensitive: true,
      regexp: true,
      search: "a+A+$",
    })
    const distinctInsensitive = new SearchQuery({
      caseSensitive: false,
      regexp: true,
      search: "a+b+$",
    })

    expect(editorSearchSupport.queryIssue(state, caseSensitive)).toBeNull()
    expect(
      editorSearchSupport.queryIssue(state, distinctInsensitive)
    ).toBeNull()
    expect(
      editorSearchSupport.queryIssue(
        state,
        new SearchQuery({ regexp: true, search: "a+z" })
      )
    ).toBeNull()
  })

  test.each([
    { caseSensitive: false, source: "a+z" },
    { caseSensitive: false, source: "a+b+$" },
    { caseSensitive: true, source: "a+A+$" },
    { caseSensitive: true, source: "a{10000}z" },
  ])(
    "rejects a repeated scan on an oversized physical line: $source",
    ({ caseSensitive, source }) => {
      const state = EditorState.create({
        doc: `${"a".repeat(maximumRepeatedRegexpPhysicalLineLength + 1)}!`,
      })
      const query = new SearchQuery({
        caseSensitive,
        regexp: true,
        search: source,
      })

      expect(editorSearchSupport.queryIssue(state, query)).toBe(
        "multiline-regexp-complexity-limit"
      )
    }
  )

  test("allows the physical-line limit and caches its immutable Text scan", () => {
    const state = EditorState.create({
      doc: "a".repeat(maximumRepeatedRegexpPhysicalLineLength),
    })
    const lineAt = vi.spyOn(state.doc, "lineAt")

    expect(
      editorSearchSupport.queryIssue(
        state,
        new SearchQuery({ regexp: true, search: "a+z" })
      )
    ).toBeNull()
    expect(
      editorSearchSupport.queryIssue(
        state,
        new SearchQuery({ regexp: true, search: "b+y" })
      )
    ).toBeNull()
    expect(lineAt).toHaveBeenCalledTimes(1)
  })

  test("probes a newline-dense document sparsely", () => {
    const state = EditorState.create({
      doc: "\n".repeat(maximumRepeatedRegexpPhysicalLineLength * 8),
    })
    const lineAt = vi.spyOn(state.doc, "lineAt")

    expect(
      editorSearchSupport.queryIssue(
        state,
        new SearchQuery({ regexp: true, search: "a+z" })
      )
    ).toBeNull()
    expect(lineAt.mock.calls.length).toBeLessThan(10)
  })

  test("finds an oversized physical line between absolute probe boundaries", () => {
    const state = EditorState.create({
      doc: `${"\n".repeat(137)}${"a".repeat(
        maximumRepeatedRegexpPhysicalLineLength + 1
      )}\nend`,
    })

    expect(
      editorSearchSupport.queryIssue(
        state,
        new SearchQuery({ regexp: true, search: "a+z" })
      )
    ).toBe("multiline-regexp-complexity-limit")
  })

  test("does not apply the repeated-scan line limit to non-repeating expressions", () => {
    const state = EditorState.create({
      doc: "a".repeat(maximumRepeatedRegexpPhysicalLineLength + 1),
    })

    expect(
      editorSearchSupport.queryIssue(
        state,
        new SearchQuery({ regexp: true, search: "az$" })
      )
    ).toBeNull()
  })

  test.each(["(?=a+$)", "(?=.*z)"])(
    "rejects a variable-length lookaround before scanning a long line: %s",
    (source) => {
      const state = EditorState.create({ doc: `${"a".repeat(65_000)}!` })
      const query = new SearchQuery({ regexp: true, search: source })

      expect(editorSearchSupport.queryIssue(state, query)).toBe(
        "multiline-regexp-complexity-limit"
      )
    }
  )

  test("rejects compounded fixed repetition of ambiguous alternations on a short line", () => {
    const state = EditorState.create({ doc: `${"a".repeat(49)}!` })
    const query = new SearchQuery({
      caseSensitive: true,
      regexp: true,
      search: "(?:a|aa){8}(?:a|aa){8}(?:a|aa){8}z",
    })

    expect(editorSearchSupport.queryIssue(state, query)).toBe(
      "multiline-regexp-complexity-limit"
    )
  })

  test("bounds compounded adjacent alternations without quantifiers", () => {
    const groups = Array.from({ length: 20 }, () => "(?:a|aa)").join("")
    const state = EditorState.create({ doc: `${"a".repeat(40)}!` })
    const query = new SearchQuery({
      caseSensitive: true,
      regexp: true,
      search: `${groups}z`,
    })

    expect(editorSearchSupport.queryIssue(state, query)).toBe(
      "multiline-regexp-complexity-limit"
    )
  })

  test("rejects a compounded chain of adjacent optional atoms", () => {
    const state = EditorState.create({ doc: `${"a".repeat(31)}!` })
    const query = new SearchQuery({
      caseSensitive: true,
      regexp: true,
      search: `${"a?".repeat(30)}a{30}z`,
    })

    expect(editorSearchSupport.queryIssue(state, query)).toBe(
      "multiline-regexp-complexity-limit"
    )
  })

  test("keeps a single ordinary optional atom available", () => {
    const state = EditorState.create({ doc: "http:// https://" })
    const query = new SearchQuery({ regexp: true, search: "https?" })

    expect(editorSearchSupport.queryIssue(state, query)).toBeNull()
  })

  test.each([
    "foo\\s+bar",
    "(?:foo|bar)\\sbaz",
    "(?<=foo\\n)bar",
    "(?<name>foo)\\sbar",
    "a+b+\\s",
    "(?:ab){2}\\s",
  ])("accepts a predictably bounded multiline expression: %s", (source) => {
    const state = EditorState.create({ doc: "foo\nbar" })
    const query = new SearchQuery({ regexp: true, search: source })

    expect(editorSearchSupport.queryIssue(state, query)).toBeNull()
  })

  test.each([
    "(?:a|aa)+\\s",
    "(?:a*)*\\s",
    "(a)\\1\\s",
    "a{10001}\\s",
    "a+a+\\s",
    "(a+)(a+)\\s",
    "a+b*a+\\s",
    "a+(?=a)a+\\s",
    "[ab]+[bc]+\\s",
    "\\w+\\d+\\s",
    "a{1,10000}a{1,10000}\\s",
    "(a{1,10000}){2}\\s",
  ])("rejects an unpredictable multiline expression: %s", (source) => {
    const state = EditorState.create({ doc: "a a\n" })
    const query = new SearchQuery({ regexp: true, search: source })

    expect(editorSearchSupport.queryIssue(state, query)).toBe(
      "multiline-regexp-complexity-limit"
    )
  })

  test("navigates current highlights without changing the editor selection", () => {
    const query = new SearchQuery({ search: "one" })
    const selection = EditorSelection.create(
      [EditorSelection.range(0, 2), EditorSelection.cursor(4)],
      1
    )
    let state = EditorState.create({
      doc: "one two one",
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        search(),
        searchMatchStateExtension,
      ],
      selection,
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const controller = controllerInternals()
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state
      },
    }
    controller.view = view

    expect(controller.findNext()).toBe(true)
    expect(view.state.selection.eq(selection)).toBe(true)
    expect(currentSearchMatch(view.state)).toEqual({ from: 8, to: 11 })

    expect(controller.findNext()).toBe(true)
    expect(view.state.selection.eq(selection)).toBe(true)
    expect(currentSearchMatch(view.state)).toEqual({ from: 0, to: 3 })

    expect(controller.findPrevious()).toBe(true)
    expect(view.state.selection.eq(selection)).toBe(true)
    expect(currentSearchMatch(view.state)).toEqual({ from: 8, to: 11 })
  })

  test("keeps exact match ordinals using sparse typed checkpoints", async () => {
    vi.useFakeTimers()
    const query = new SearchQuery({ regexp: true, search: "(?=x)" })
    let state = EditorState.create({
      doc: "x".repeat(700),
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.single(510),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: 510, to: 510 }),
      ],
    }).state
    const controller = controllerInternals()
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state
      },
    }
    controller.view = view

    expect(controller.searchStatus(state)).toEqual({
      current: null,
      pending: true,
      total: 0,
      valid: true,
    })
    expect(controller.searchMatchCache?.total).toBe(0)

    await vi.runAllTimersAsync()

    expect(controller.searchStatus(state)).toEqual({
      current: 511,
      pending: false,
      total: 700,
      valid: true,
    })
    expect(controller.searchMatchCache?.checkpoints).toBeInstanceOf(
      Float64Array
    )
    expect(controller.searchMatchCache?.checkpoints).toHaveLength(6)

    state = state.update({
      effects: setCurrentSearchMatch.of({ from: 699, to: 699 }),
    }).state
    view.state = state
    expect(controller.searchStatus(state).current).toBe(700)
  })

  test("bounds each high-match scan turn and finishes with an exact count", async () => {
    vi.useFakeTimers()
    const query = new SearchQuery({ regexp: true, search: "(?=x)" })
    let state = EditorState.create({
      doc: "x".repeat(100_000),
      extensions: search(),
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    expect(controller.searchStatus(state)).toEqual({
      current: null,
      pending: true,
      total: 0,
      valid: true,
    })
    const matches = controller.searchMatchCache!
    controller.cancelSearchScan()
    controller.continueSearchScan(matches)

    expect(matches.complete).toBe(false)
    expect(matches.total).toBeGreaterThan(0)
    expect(matches.total).toBeLessThan(100_000)

    await vi.runAllTimersAsync()
    expect(controller.searchStatus(state).total).toBe(100_000)
    expect(matches.checkpoints.byteLength).toBeLessThan(10_000)
  })

  test("counts literal matches that cross a scan boundary exactly once", async () => {
    vi.useFakeTimers()
    const matchFrom = 64 * 1024 - 2
    const document = `${"z".repeat(matchFrom)}abcde${"z".repeat(10_000)}`
    const query = new SearchQuery({ search: "abcde" })
    let state = EditorState.create({
      doc: document,
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.range(matchFrom, matchFrom + 5),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: matchFrom, to: matchFrom + 5 }),
      ],
    }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    controller.searchStatus(state)
    await vi.runAllTimersAsync()

    expect(controller.searchStatus(state)).toEqual({
      current: 1,
      pending: false,
      total: 1,
      valid: true,
    })
  })

  test("keeps literal non-overlap phase and checkpoints across scan boundaries", async () => {
    vi.useFakeTimers()
    const query = new SearchQuery({ search: "aaa" })
    let state = EditorState.create({
      doc: "a".repeat(70_000),
      extensions: search(),
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }
    const expected = collectMatches(query.getCursor(state, 0, state.doc.length))

    controller.searchStatus(state)
    await vi.runAllTimersAsync()

    expect(controller.searchStatus(state).total).toBe(expected.length)
    expect(controller.searchMatchCache?.checkpoints).toEqual(
      Float64Array.from(
        expected.flatMap((match, index) =>
          index % 256 === 0 ? [match.from, match.to] : []
        )
      )
    )
  })

  test("counts NFKD-contracted astral source spans across a scan boundary", async () => {
    vi.useFakeTimers()
    const matchFrom = 64 * 1024 - 1
    const mathematicalBoldA = "\u{1d400}"
    const document = `${"z".repeat(matchFrom)}${mathematicalBoldA.repeat(2)}${"z".repeat(100)}`
    const query = new SearchQuery({ search: "AA" })
    let state = EditorState.create({
      doc: document,
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.range(matchFrom, matchFrom + 4),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: matchFrom, to: matchFrom + 4 }),
      ],
    }).state
    const expected = collectMatches(query.getCursor(state, 0, state.doc.length))
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    controller.searchStatus(state)
    await vi.runAllTimersAsync()

    expect(expected).toMatchObject([{ from: matchFrom, to: matchFrom + 4 }])
    expect(controller.searchStatus(state)).toEqual({
      current: 1,
      pending: false,
      total: 1,
      valid: true,
    })
    expect(controller.searchMatchCache?.checkpoints).toEqual(
      Float64Array.from([matchFrom, matchFrom + 4])
    )
  })

  test("keeps canonically equivalent literal matches across scan boundaries", async () => {
    vi.useFakeTimers()
    const matchFrom = 64 * 1024 - 1
    const composed = "\u1f82"
    const decomposed = composed.normalize("NFKD")
    const document = `${"z".repeat(matchFrom)}${decomposed}${"z".repeat(100)}`
    const query = new SearchQuery({ search: composed })
    let state = EditorState.create({
      doc: document,
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.range(
        matchFrom,
        matchFrom + decomposed.length
      ),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({
          from: matchFrom,
          to: matchFrom + decomposed.length,
        }),
      ],
    }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    controller.searchStatus(state)
    await vi.runAllTimersAsync()

    expect(controller.searchStatus(state)).toEqual({
      current: 1,
      pending: false,
      total: 1,
      valid: true,
    })
  })

  test("keeps backward regexp navigation and replacement on the canonical phase", async () => {
    vi.useFakeTimers()
    const query = new SearchQuery({
      regexp: true,
      replace: "Z",
      search: "a".repeat(17),
    })
    const document = "a".repeat(17_020)
    const selected = { from: 17_000, to: 17_017 }
    let state = EditorState.create({
      doc: document,
      extensions: [search(), searchMatchStateExtension],
    })
    state = state.update({
      effects: [setSearchQuery.of(query), setCurrentSearchMatch.of(selected)],
    }).state
    const controller = controllerInternals()
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state
      },
    }
    controller.view = view

    controller.searchStatus(state)
    await vi.runAllTimersAsync()
    expect(controller.searchStatus(state).total).toBe(1_001)
    expect(controller.findPrevious()).toBe(true)
    expect(currentSearchMatch(view.state)).toEqual({
      from: 16_983,
      to: 17_000,
    })
    expect(controller.replaceNextMatch(query, false)).toBe(true)
    expect(view.state.sliceDoc(16_983, 16_984)).toBe("Z")
  })

  test.each([
    ["line-local lookbehind", "(?<=a)b", `${"ab\n".repeat(30_000)}ab`, 30_001],
    ["hex newline escape", "\\x0A", "a\nb", 0],
    ["unicode newline escape", "\\u000A", "a\nb", 0],
    ["multiline whitespace", "a\\sb", "a\nb", 1],
  ])(
    "preserves CodeMirror regex semantics for %s",
    async (_, pattern, doc, total) => {
      vi.useFakeTimers()
      const query = new SearchQuery({ regexp: true, search: pattern })
      let state = EditorState.create({ doc, extensions: search() })
      state = state.update({ effects: setSearchQuery.of(query) }).state
      const controller = controllerInternals()
      controller.view = { state, dispatch() {} }

      controller.searchStatus(state)
      await vi.runAllTimersAsync()

      expect(controller.searchStatus(state).total).toBe(total)
    }
  )

  test("cancels stale document counts before they can publish", async () => {
    vi.useFakeTimers()
    const firstQuery = new SearchQuery({ search: "x" })
    let firstState = EditorState.create({
      doc: "x".repeat(100_000),
      extensions: search(),
    })
    firstState = firstState.update({
      effects: setSearchQuery.of(firstQuery),
    }).state
    const secondQuery = new SearchQuery({ search: "y" })
    let secondState = EditorState.create({
      doc: "yyy",
      extensions: search(),
    })
    secondState = secondState.update({
      effects: setSearchQuery.of(secondQuery),
    }).state
    const published: MarkdownSearchStatus[] = []
    const controller = controllerInternals()
    controller.onSearchStatusChange = (status) => published.push(status)
    controller.view = { state: firstState, dispatch() {} }

    controller.searchStatus(firstState)
    controller.view.state = secondState
    controller.searchStatus(secondState)
    await vi.runAllTimersAsync()

    expect(controller.searchMatchCache?.doc).toBe(secondState.doc)
    expect(controller.searchStatus(secondState).total).toBe(3)
    expect(published).toEqual([
      { current: null, pending: false, total: 3, valid: true },
    ])
  })

  test("publishes completion for a pending query with no matches", async () => {
    vi.useFakeTimers()
    const query = new SearchQuery({ search: "missing" })
    let state = EditorState.create({
      doc: "present",
      extensions: search(),
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const published: MarkdownSearchStatus[] = []
    const controller = controllerInternals()
    controller.onSearchStatusChange = (status) => published.push(status)
    controller.view = { state, dispatch() {} }

    controller.reportSearchStatus(state)
    await vi.runAllTimersAsync()

    expect(published).toEqual([
      { current: null, pending: true, total: 0, valid: true },
      { current: null, pending: false, total: 0, valid: true },
    ])
  })

  test("streams regex captures and wraps after preserve-case replace next", () => {
    const query = new SearchQuery({
      caseSensitive: false,
      regexp: true,
      replace: "$2x",
      search: "([a-z])([a-z])([a-z])",
    })
    const controller = controllerInternals()
    let state = EditorState.create({
      doc: "Cat cot",
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.single(1),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: 4, to: 7 }),
      ],
    }).state
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state
      },
    }
    controller.view = view

    expect(controller.replaceNextMatch(query, true)).toBe(true)
    expect(view.state.doc.toString()).toBe("Cat ox")
    expect(view.state.selection.main).toMatchObject({ from: 1, to: 1 })
    expect(currentSearchMatch(view.state)).toEqual({ from: 0, to: 3 })
  })

  test("keeps multiline lookbehind context after a sparse checkpoint", async () => {
    vi.useFakeTimers()
    const query = new SearchQuery({
      regexp: true,
      search: "a|(?<=a\\n)b",
    })
    const document = "a\nb\n".repeat(400)
    const expected = collectMatches(
      query.getCursor(EditorState.create({ doc: document }))
    )
    const selected = expected[257]!
    let state = EditorState.create({
      doc: document,
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.range(selected.from, selected.to),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: selected.from, to: selected.to }),
      ],
    }).state
    const controller = controllerInternals()
    controller.view = { state, dispatch() {} }

    controller.searchStatus(state)
    await vi.runAllTimersAsync()

    expect(controller.searchStatus(state)).toEqual({
      current: 258,
      pending: false,
      total: expected.length,
      valid: true,
    })
  })

  test.each([{ checkpoints: [] }, { checkpoints: [0, 1] }])(
    "navigates backward through lookahead matches with checkpoints $checkpoints",
    ({ checkpoints }) => {
      const state = EditorState.create({ doc: "a\nb\na\nb" })
      const query = new SearchQuery({ regexp: true, search: "a(?=\\nb)|b" })
      let current = { from: 6, to: 7 }
      for (const expectedFrom of [4, 2, 0, 6]) {
        const previous = editorSearchSupport.previousMatch(
          state,
          query,
          current.from,
          current,
          checkpoints,
          0
        )
        expect(previous).toMatchObject({
          from: expectedFrom,
          to: expectedFrom + 1,
        })
        current = { from: previous!.from, to: previous!.to }
      }
    }
  )

  test("bounds returned regexp matches without truncating lookahead context", () => {
    const state = EditorState.create({ doc: "a\nb\na\nb" })
    const ranges = (search: string, to: number) =>
      collectMatches(
        contextPreservingRegexpCursor(
          state,
          new SearchQuery({ regexp: true, search }),
          0,
          to
        )
      ).map(({ from, to }) => ({ from, to }))

    expect(ranges("a(?=\\nb)|b", 6)).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 5 },
    ])
    expect(ranges("a(?!\\nb)|b", 6)).toEqual([{ from: 2, to: 3 }])
    expect(ranges("a\\nb", 6)).toEqual([{ from: 0, to: 3 }])
  })

  test("preserves multiline lookbehind when replacing an active late match", () => {
    const query = new SearchQuery({
      regexp: true,
      replace: "Z",
      search: "(?<=a\\n)b",
    })
    const document = "a\nb\n".repeat(400)
    const expected = collectMatches(
      query.getCursor(EditorState.create({ doc: document }))
    )
    const selected = expected[257]!
    const controller = controllerInternals()
    let state = EditorState.create({
      doc: document,
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.single(0),
    })
    state = state.update({
      effects: [
        setSearchQuery.of(query),
        setCurrentSearchMatch.of({ from: selected.from, to: selected.to }),
      ],
    }).state
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state
      },
    }
    controller.view = view

    expect(controller.replaceNextMatch(query, true)).toBe(true)
    expect(view.state.sliceDoc(selected.from, selected.to)).toBe("z")
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 0 })
  })

  test("matches CodeMirror multiline cursor filters and Unicode advancement", () => {
    const state = EditorState.create({ doc: "\n😀x\nCAT\ncatapult\ntail" })
    const queries = [
      new SearchQuery({ regexp: true, search: "(?<=\\n)(?=😀)|(?<=😀)(?=x)" }),
      new SearchQuery({
        caseSensitive: false,
        regexp: true,
        search: "(?<=\\n)cat",
        wholeWord: true,
      }),
      new SearchQuery({
        regexp: true,
        search: "(?<=\\n)(?:CAT|tail)",
        test: (match) => match !== "tail",
      }),
    ]
    for (const query of queries) {
      const to = state.doc.length - 2
      const expected = collectMatches(query.getCursor(state, 0, to)).map(
        ({ from, to: matchTo }) => ({ from, to: matchTo })
      )
      const actual = collectMatches(
        contextPreservingRegexpCursor(state, query, 0, to)
      ).map(({ from, to: matchTo }) => ({ from, to: matchTo }))
      expect(actual).toEqual(expected)
    }
  })

  test("continues to valid whole-word matches after a filtered regexp match", () => {
    const state = EditorState.create({ doc: "catapult\ncat" })
    const query = new SearchQuery({
      regexp: true,
      search: "cat",
      wholeWord: true,
    })

    expect(
      collectMatches(
        contextPreservingRegexpCursor(state, query, 0, state.doc.length)
      ).map(({ from, to }) => ({ from, to }))
    ).toEqual([{ from: 9, to: 12 }])
  })

  test("continues after a custom regexp filter rejects an earlier match", () => {
    const state = EditorState.create({ doc: "skip\nkeep" })
    const query = new SearchQuery({
      regexp: true,
      search: "[a-z]+",
      test: (match) => match !== "skip",
    })

    expect(
      collectMatches(
        contextPreservingRegexpCursor(state, query, 0, state.doc.length)
      ).map(({ from, to }) => ({ from, to }))
    ).toEqual([{ from: 5, to: 9 }])
  })

  test("activates a sole match without moving the caret before replacing it", () => {
    const query = new SearchQuery({
      replace: "XYZ",
      search: "abc",
    })
    const controller = controllerInternals()
    let state = EditorState.create({
      doc: "abc",
      extensions: [search(), searchMatchStateExtension],
      selection: EditorSelection.single(1),
    })
    state = state.update({ effects: setSearchQuery.of(query) }).state
    const view = {
      state,
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state
      },
    }
    controller.view = view

    expect(controller.replaceNextMatch(query, true)).toBe(true)
    expect(view.state.doc.toString()).toBe("abc")
    expect(view.state.selection.main).toMatchObject({ from: 1, to: 1 })
    expect(currentSearchMatch(view.state)).toEqual({ from: 0, to: 3 })

    expect(controller.replaceNextMatch(query, true)).toBe(true)
    expect(view.state.doc.toString()).toBe("xyz")
  })
})
