import {
  SearchQuery,
  getSearchQuery,
  replaceAll,
  search,
  setSearchQuery,
} from "@codemirror/search"
import {
  EditorSelection,
  type EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { externalSearchHighlighter } from "./search-highlighter"
import { contextPreservingRegexpSearchIssue } from "./search-complexity"
import {
  regexpMayCrossLines,
  searchCursorForRange,
  type SearchCursorMatch,
} from "./search-cursor"
import {
  currentSearchMatch,
  setCurrentSearchMatch,
  setEditorSearchIssue,
  setEditorSearchQuery,
  type SearchMatchRange,
} from "./search-state"
import type { MarkdownSearchIssue } from "./types"

export interface SearchQueryConfiguration {
  caseSensitive?: boolean
  regexp?: boolean
  replace?: string
  search: string
  wholeWord?: boolean
}

export interface EditorSearchSupport {
  readonly extension: Extension
  announce(state: EditorState, match: SearchMatchRange): StateEffect<unknown>
  createQuery(configuration: SearchQueryConfiguration): SearchQuery
  canonicalRegexpMatchAt(
    state: EditorState,
    query: SearchQuery,
    range: SearchMatchRange,
    checkpoints: readonly number[] | Float64Array
  ): SearchCursorMatch | null
  currentMatch(state: EditorState): SearchMatchRange | null
  currentMatchEffects(
    match: SearchMatchRange | null
  ): readonly StateEffect<unknown>[]
  nextMatch(
    state: EditorState,
    query: SearchQuery,
    from: number,
    excluded: SearchMatchRange | null
  ): SearchCursorMatch | null
  query(state: EditorState): SearchQuery
  queryIssue(state: EditorState, query: SearchQuery): MarkdownSearchIssue | null
  queryEffects(
    query: SearchQuery,
    issue: MarkdownSearchIssue | null
  ): readonly StateEffect<unknown>[]
  previousMatch(
    state: EditorState,
    query: SearchQuery,
    from: number,
    excluded: SearchMatchRange | null,
    checkpoints: readonly number[] | Float64Array,
    literalOverlap: number
  ): SearchCursorMatch | null
  rangeIsMatch(
    state: EditorState,
    query: SearchQuery,
    range: SearchMatchRange,
    checkpoints: readonly number[] | Float64Array
  ): boolean
  replaceAll(view: EditorView): boolean
  scroll(match: SearchMatchRange): StateEffect<unknown>
}

const announcementMargin = 30
const announcementBreak = /[\s.,:;?!]/

function announce(state: EditorState, match: SearchMatchRange) {
  const line = state.doc.lineAt(match.from)
  const lineEnd = state.doc.lineAt(match.to).to
  const start = Math.max(line.from, match.from - announcementMargin)
  const end = Math.min(lineEnd, match.to + announcementMargin)
  let text = state.sliceDoc(start, end)
  if (start !== line.from) {
    for (let index = 0; index < announcementMargin; index += 1) {
      if (
        !announcementBreak.test(text[index + 1] ?? "") &&
        announcementBreak.test(text[index] ?? "")
      ) {
        text = text.slice(index)
        break
      }
    }
  }
  if (end !== lineEnd) {
    for (
      let index = text.length - 1;
      index > text.length - announcementMargin;
      index -= 1
    ) {
      if (
        !announcementBreak.test(text[index - 1] ?? "") &&
        announcementBreak.test(text[index] ?? "")
      ) {
        text = text.slice(0, index)
        break
      }
    }
  }
  return EditorView.announce.of(
    `${state.phrase("current match")}. ${text} ${state.phrase("on line")} ${line.number}.`
  )
}

function scroll(match: SearchMatchRange) {
  return EditorView.scrollIntoView(
    EditorSelection.range(match.from, match.to),
    { y: "center", yMargin: 12 }
  )
}

function checkpointBefore(
  checkpoints: readonly number[] | Float64Array,
  boundary: SearchMatchRange
) {
  let low = 0
  let high = checkpoints.length / 2 - 1
  let result: SearchMatchRange | null = null
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const from = checkpoints[middle * 2]!
    const to = checkpoints[middle * 2 + 1]!
    if (from < boundary.from || (from === boundary.from && to < boundary.to)) {
      result = { from, to }
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return result
}

function positionAfter(state: EditorState, position: number) {
  if (position >= state.doc.length) return position
  const characters = state.sliceDoc(position, position + 2)
  const first = characters.charCodeAt(0)
  const second = characters.charCodeAt(1)
  return (
    position +
    (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
      ? 2
      : 1)
  )
}

function checkpointEnd(state: EditorState, checkpoint: SearchMatchRange) {
  return checkpoint.from === checkpoint.to
    ? positionAfter(state, checkpoint.to)
    : checkpoint.to
}

function canonicalRegexpMatchAt(
  state: EditorState,
  query: SearchQuery,
  range: SearchMatchRange,
  checkpoints: readonly number[] | Float64Array
) {
  const checkpoint = checkpointBefore(checkpoints, range)
  const start = checkpoint
    ? checkpointEnd(state, checkpoint)
    : regexpMayCrossLines(query.search)
      ? 0
      : state.doc.lineAt(range.from).from
  const cursor = searchCursorForRange(state, query, start, state.doc.length)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (next.value.from === range.from && next.value.to === range.to) {
      return next.value
    }
    if (
      next.value.from > range.from ||
      (next.value.from === range.from && next.value.to > range.to)
    ) {
      break
    }
  }
  return null
}

function previousRegexpMatch(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  excluded: SearchMatchRange | null,
  checkpoints: readonly number[] | Float64Array
) {
  const checkpoint = checkpointBefore(checkpoints, { from: to, to: -1 })
  if (checkpoint && checkpoint.from >= from && checkpoint.to <= to) {
    const cursor = searchCursorForRange(
      state,
      query,
      checkpointEnd(state, checkpoint),
      to
    )
    let candidate: SearchCursorMatch | null =
      excluded?.from === checkpoint.from && excluded.to === checkpoint.to
        ? null
        : checkpoint
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (excluded?.from !== next.value.from || excluded.to !== next.value.to) {
        candidate = next.value
      }
    }
    return candidate
  }

  if (regexpMayCrossLines(query.search)) {
    const cursor = searchCursorForRange(state, query, from, to)
    let candidate: SearchCursorMatch | null = null
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (excluded?.from !== next.value.from || excluded.to !== next.value.to) {
        candidate = next.value
      }
    }
    return candidate
  }

  for (let position = to; ;) {
    const offset = Math.max(from, position - 10_000)
    const start = Math.max(from, state.doc.lineAt(offset).from)
    const cursor = searchCursorForRange(state, query, start, position)
    let candidate: SearchCursorMatch | null = null
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (excluded?.from !== next.value.from || excluded.to !== next.value.to) {
        candidate = next.value
      }
    }
    if (candidate || start === from) return candidate
    position = start
  }
}

function firstMatch(
  cursor: Iterator<SearchCursorMatch>,
  excluded: SearchMatchRange | null
) {
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (excluded?.from !== next.value.from || excluded.to !== next.value.to) {
      return next.value
    }
  }
  return null
}

function nextMatch(
  state: EditorState,
  query: SearchQuery,
  from: number,
  excluded: SearchMatchRange | null
) {
  const next = firstMatch(
    searchCursorForRange(state, query, from, state.doc.length),
    excluded
  )
  return next || from === 0
    ? next
    : firstMatch(
        searchCursorForRange(state, query, 0, state.doc.length),
        excluded
      )
}

function previousMatchInRange(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
  excluded: SearchMatchRange | null,
  checkpoints: readonly number[] | Float64Array,
  literalOverlap: number
) {
  if (query.regexp) {
    return previousRegexpMatch(state, query, from, to, excluded, checkpoints)
  }
  for (let position = to; ;) {
    const start = Math.max(from, position - 10_000 - literalOverlap)
    const cursor = searchCursorForRange(state, query, start, position)
    let candidate: SearchCursorMatch | null = null
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (excluded?.from !== next.value.from || excluded.to !== next.value.to) {
        candidate = next.value
      }
    }
    if (candidate || start === from) return candidate
    position = Math.max(from, position - 10_000)
  }
}

function previousMatch(
  state: EditorState,
  query: SearchQuery,
  from: number,
  excluded: SearchMatchRange | null,
  checkpoints: readonly number[] | Float64Array,
  literalOverlap: number
) {
  return (
    previousMatchInRange(
      state,
      query,
      0,
      from,
      excluded,
      checkpoints,
      literalOverlap
    ) ??
    previousMatchInRange(
      state,
      query,
      0,
      state.doc.length,
      excluded,
      checkpoints,
      literalOverlap
    )
  )
}

function rangeIsMatch(
  state: EditorState,
  query: SearchQuery,
  range: SearchMatchRange,
  checkpoints: readonly number[] | Float64Array
) {
  if (query.regexp) {
    return canonicalRegexpMatchAt(state, query, range, checkpoints) !== null
  }
  const cursor = searchCursorForRange(
    state,
    query,
    range.from === 0 ? 0 : range.from - 1,
    state.doc.length
  )
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from, to } = next.value
    if (from === range.from && to === range.to) return true
    if (from > range.from || (from === range.from && to > range.to)) break
  }
  return false
}

export const editorSearchSupport: EditorSearchSupport = {
  announce,
  extension: [
    search({
      // The document chrome overlays the scroller. Centering a newly found
      // match keeps it genuinely visible instead of letting CodeMirror's
      // minimal scroll stop with the selection underneath that chrome.
      scrollToMatch: scroll,
    }),
    externalSearchHighlighter,
  ],
  canonicalRegexpMatchAt,
  createQuery: (configuration) => new SearchQuery(configuration),
  currentMatch: currentSearchMatch,
  currentMatchEffects: (match) => [setCurrentSearchMatch.of(match)],
  nextMatch,
  query: getSearchQuery,
  queryIssue: contextPreservingRegexpSearchIssue,
  queryEffects: (query, issue) => [
    setSearchQuery.of(query),
    setEditorSearchQuery.of(query),
    setEditorSearchIssue.of(issue),
  ],
  previousMatch,
  replaceAll,
  rangeIsMatch,
  scroll,
}
