import { getSearchQuery } from "@codemirror/search"
import {
  StateEffect,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

import {
  createContextPreservingRegexpSearch,
  regexpMayCrossLines,
} from "./search-cursor"
import { contextPreservingRegexpSearchIssue } from "./search-complexity"
import {
  currentSearchMatch,
  searchMatchStateExtension,
  type SearchMatchRange,
} from "./search-state"

export {
  currentSearchMatch,
  searchMatchStateExtension,
  searchPatternEqual,
  setCurrentSearchMatch,
  type SearchMatchRange,
} from "./search-state"

const matchMark = Decoration.mark({ class: "cm-searchMatch" })
const selectedMatchMark = Decoration.mark({
  class: "cm-searchMatch cm-searchMatch-selected",
})

interface VisibleRange {
  readonly from: number
  readonly to: number
}

const refreshSearchHighlights = StateEffect.define<null>()

function searchMatchRangeEqual(
  left: SearchMatchRange | null,
  right: SearchMatchRange | null
) {
  return (
    left === right || (left?.from === right?.from && left?.to === right?.to)
  )
}

function deferredMultilineQuery(state: EditorState) {
  const query = getSearchQuery(state)
  return (
    query.valid &&
    query.regexp &&
    regexpMayCrossLines(query.search) &&
    contextPreservingRegexpSearchIssue(state, query) === null
  )
}

function orderedVisibleRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRange[]
) {
  return visibleRanges
    .map(({ from, to }) => ({
      from: Math.max(0, Math.min(from, state.doc.length)),
      to: Math.max(0, Math.min(to, state.doc.length)),
    }))
    .filter(({ from, to }) => from < to)
    .sort((left, right) => left.from - right.from || left.to - right.to)
}

function searchHighlightRanges(
  state: EditorState,
  visibleRanges: readonly VisibleRange[]
) {
  const query = getSearchQuery(state)
  if (!query.valid || contextPreservingRegexpSearchIssue(state, query)) {
    return []
  }

  const ranges: SearchMatchRange[] = []
  const seen = new Set<string>()
  const visible = orderedVisibleRanges(state, visibleRanges)
  const multilineRegexp = query.regexp && regexpMayCrossLines(query.search)
  const multilineSearch = multilineRegexp
    ? createContextPreservingRegexpSearch(state, query)
    : null

  for (const part of visible) {
    // Each visible range keeps an independent cursor so folded gaps retain
    // CodeMirror's range-local match phase. The flattened input and regexp
    // configuration are shared across those cursors.
    const cursor = multilineSearch
      ? multilineSearch.cursor(part.from)
      : query.getCursor(state, part.from, part.to)
    let yieldedMatch = false
    let exhausted = false
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      yieldedMatch = true
      const { from, to } = next.value
      if (from >= part.to) break
      // Mark decorations require a non-empty range. Zero-width matches still
      // participate in search navigation and counts, but have no text to mark.
      if (from === to) continue
      const key = `${from}:${to}`
      if (seen.has(key)) continue
      seen.add(key)
      ranges.push({ from, to })
    }
    if (!yieldedMatch && multilineSearch) {
      // This cursor searched the complete suffix and found nothing. Any later
      // visible range starts within that same suffix, so another full scan
      // cannot produce a result. Do not apply this shortcut after a match—the
      // independent cursor phase can then expose overlapping later matches.
      exhausted = true
    }
    if (exhausted) break
  }

  return ranges
}

function decorationsForRanges(
  state: EditorState,
  matches: readonly SearchMatchRange[]
) {
  const current = currentSearchMatch(state)
  const ranges: Range<Decoration>[] = matches.map(({ from, to }) => {
    const selected = current?.from === from && current.to === to
    return (selected ? selectedMatchMark : matchMark).range(from, to)
  })
  return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none
}

export function buildSearchHighlightDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[]
): DecorationSet {
  return decorationsForRanges(
    state,
    searchHighlightRanges(state, visibleRanges)
  )
}

export class SearchHighlighter {
  decorations = Decoration.none
  private destroyed = false
  private matches: readonly SearchMatchRange[] = []
  private matchesCurrentDocument = true
  private pendingFrame: number | null = null
  private pendingFrameWindow: Window | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null

  constructor(view: EditorView) {
    if (deferredMultilineQuery(view.state)) {
      this.matchesCurrentDocument = false
      this.scheduleRefresh(view)
    } else {
      this.rebuild(view)
    }
  }

  private rebuild(view: EditorView) {
    this.matches = searchHighlightRanges(view.state, view.visibleRanges)
    this.matchesCurrentDocument = true
    this.decorations = decorationsForRanges(view.state, this.matches)
  }

  private restyle(state: EditorState) {
    this.decorations = decorationsForRanges(state, this.matches)
  }

  private cancelRefresh() {
    if (this.pendingFrame != null && this.pendingFrameWindow) {
      this.pendingFrameWindow.cancelAnimationFrame(this.pendingFrame)
    }
    if (this.pendingTimer != null) clearTimeout(this.pendingTimer)
    this.pendingFrame = null
    this.pendingFrameWindow = null
    this.pendingTimer = null
  }

  private scheduleRefresh(view: EditorView) {
    if (
      this.destroyed ||
      this.pendingFrame != null ||
      this.pendingTimer != null
    ) {
      return
    }

    const refresh = () => {
      this.pendingFrame = null
      this.pendingFrameWindow = null
      this.pendingTimer = null
      if (this.destroyed) return
      view.dispatch({ effects: refreshSearchHighlights.of(null) })
    }
    const ownerWindow = view.dom.ownerDocument.defaultView
    if (ownerWindow) {
      this.pendingFrameWindow = ownerWindow
      this.pendingFrame = ownerWindow.requestAnimationFrame(refresh)
    } else {
      this.pendingTimer = setTimeout(refresh, 0)
    }
  }

  update(update: ViewUpdate) {
    const refreshRequested = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshSearchHighlights))
    )
    if (refreshRequested) {
      this.cancelRefresh()
      this.rebuild(update.view)
      return
    }

    const queryChanged = !getSearchQuery(update.startState).eq(
      getSearchQuery(update.state)
    )
    const currentMatchChanged = !searchMatchRangeEqual(
      currentSearchMatch(update.startState),
      currentSearchMatch(update.state)
    )
    const deferred = deferredMultilineQuery(update.state)

    if (queryChanged) {
      this.cancelRefresh()
      this.matches = []
      this.matchesCurrentDocument = false
      this.decorations = Decoration.none
      if (deferred) this.scheduleRefresh(update.view)
      else this.rebuild(update.view)
      return
    }

    if (deferred) {
      if (update.docChanged) {
        // Preserve stable paint during a burst of typing. The exact rebuild is
        // coalesced to the next frame because arbitrary multiline regexp
        // context can require a full-document copy and scan.
        this.decorations = this.decorations.map(update.changes)
        this.matches = []
        this.matchesCurrentDocument = false
      } else if (currentMatchChanged && this.matchesCurrentDocument) {
        this.restyle(update.state)
      }
      if (
        update.docChanged ||
        update.viewportChanged ||
        (update.selectionSet && getSearchQuery(update.state).wholeWord)
      ) {
        this.scheduleRefresh(update.view)
      }
      return
    }

    this.cancelRefresh()
    if (
      update.docChanged ||
      update.viewportChanged ||
      (update.selectionSet && getSearchQuery(update.state).wholeWord)
    ) {
      this.rebuild(update.view)
    } else if (currentMatchChanged) {
      this.restyle(update.state)
    }
  }

  destroy() {
    this.destroyed = true
    this.cancelRefresh()
  }
}

const searchHighlighterPlugin = ViewPlugin.fromClass(SearchHighlighter, {
  decorations: (plugin) => plugin.decorations,
})

export const externalSearchHighlighter: Extension = [
  searchMatchStateExtension,
  searchHighlighterPlugin,
]
