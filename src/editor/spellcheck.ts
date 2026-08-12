import {
  StateEffect,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

import {
  isSpellingToken,
  MAX_SPELLING_WORD_LENGTH,
  SPELLING_TOKEN_PATTERN_SOURCE,
} from "../shared/contracts"

export type SpellCheckWords = (
  words: readonly string[]
) => readonly boolean[] | null

export interface SpellingCandidate {
  from: number
  to: number
  word: string
}

const maximumCachedSpellingWords = 8_192
const maximumScanCharacters = 65_536
const maximumWordsPerFrame = 128
const unavailableRetryDelays = [50, 100, 200, 400, 800] as const
const spellingMark = Decoration.mark({ class: "cm-app-spelling-error" })
const spellingWordPattern = new RegExp(SPELLING_TOKEN_PATTERN_SOURCE, "gu")
const spellingWordContinuationPattern = /[\p{L}\p{M}\p{N}.'’_-]/u
const incompleteSpellingJoinerPattern = /['’_-]/u

export function spellingCandidatesInText(
  text: string,
  offset: number
): SpellingCandidate[] {
  const candidates: SpellingCandidate[] = []
  spellingWordPattern.lastIndex = 0
  for (
    let match = spellingWordPattern.exec(text);
    match;
    match = spellingWordPattern.exec(text)
  ) {
    const word = match[0]
    if (!isSpellingToken(word)) continue
    const from = offset + match.index
    candidates.push({ from, to: from + word.length, word })
  }
  return candidates
}

export function spellingCandidateAt(
  state: EditorState,
  position: number
): SpellingCandidate | null {
  const clampedPosition = Math.max(0, Math.min(position, state.doc.length))
  const line = state.doc.lineAt(clampedPosition)
  const from = Math.max(line.from, clampedPosition - MAX_SPELLING_WORD_LENGTH)
  const to = Math.min(line.to, clampedPosition + MAX_SPELLING_WORD_LENGTH)
  for (const candidate of spellingCandidatesInText(
    state.sliceDoc(from, to),
    from
  )) {
    if (
      (candidate.from === from &&
        from > line.from &&
        spellingWordContinuationPattern.test(state.sliceDoc(from - 1, from))) ||
      (candidate.to === to &&
        to < line.to &&
        spellingWordContinuationPattern.test(state.sliceDoc(to, to + 1)))
    ) {
      continue
    }
    if (clampedPosition >= candidate.from && clampedPosition <= candidate.to) {
      return candidate
    }
  }
  return null
}

export const refreshSpellCheck = StateEffect.define<string | null>()
const continueSpellCheck = StateEffect.define<void>()

interface ScanRange {
  from: number
  to: number
}

interface ChangedRange extends ScanRange {
  fromA: number
  toA: number
}

function rangesOverlap(left: ScanRange, right: ScanRange) {
  return left.to > right.from && right.to > left.from
}

function changedRanges(update: ViewUpdate) {
  const ranges: ChangedRange[] = []
  update.changes.iterChangedRanges((fromA, toA, from, to) => {
    ranges.push({ fromA, toA, from, to })
  })
  return ranges
}

function changeTouchesRange(change: ScanRange, range: ScanRange) {
  return change.from === change.to
    ? change.from >= range.from && change.from <= range.to
    : rangesOverlap(change, range)
}

function candidateWasOnlyRelocated(
  update: ViewUpdate,
  changes: readonly ChangedRange[],
  candidate: SpellingCandidate
) {
  const inverse = update.changes.invertedDesc
  const from = inverse.mapPos(candidate.from, 1)
  const to = inverse.mapPos(candidate.to, -1)
  const previous = spellingCandidateAt(update.startState, from)
  return (
    previous?.from === from &&
    previous.to === to &&
    previous.word === candidate.word &&
    !changes.some(
      (change) => change.toA > previous.from && change.fromA < previous.to
    )
  )
}

function mergedScanRanges(
  state: EditorState,
  visibleRanges: readonly ScanRange[]
) {
  const ranges = visibleRanges
    .map(({ from, to }) => ({
      from: Math.max(0, from - MAX_SPELLING_WORD_LENGTH),
      to: Math.min(state.doc.length, to + MAX_SPELLING_WORD_LENGTH),
    }))
    .sort((left, right) => left.from - right.from)
  const merged: ScanRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function visibleSpellingCandidates(
  state: EditorState,
  visibleRanges: readonly ScanRange[]
) {
  const candidates: SpellingCandidate[] = []
  const seenRanges = new Set<string>()
  let remainingCharacters = maximumScanCharacters
  for (const range of mergedScanRanges(state, visibleRanges)) {
    if (remainingCharacters <= 0) break
    const to = Math.min(range.to, range.from + remainingCharacters)
    remainingCharacters -= to - range.from
    for (const candidate of spellingCandidatesInText(
      state.sliceDoc(range.from, to),
      range.from
    )) {
      if (
        (candidate.from === range.from &&
          range.from > 0 &&
          spellingWordContinuationPattern.test(
            state.sliceDoc(range.from - 1, range.from)
          )) ||
        (candidate.to === to &&
          to < state.doc.length &&
          spellingWordContinuationPattern.test(state.sliceDoc(to, to + 1)))
      ) {
        continue
      }
      if (
        !visibleRanges.some(
          (visible) =>
            candidate.to > visible.from && candidate.from < visible.to
        )
      ) {
        continue
      }
      const key = `${candidate.from}:${candidate.to}`
      if (seenRanges.has(key)) continue
      seenRanges.add(key)
      candidates.push(candidate)
    }
  }
  return candidates
}

export class SpellCheckView {
  decorations: DecorationSet = Decoration.none
  private readonly cache = new Map<string, boolean>()
  private readonly view: EditorView
  private readonly checkWords: SpellCheckWords
  private scheduledFrame: number | null = null
  private unavailableRetryAttempt = 0
  private unavailableRetryTimer: number | null = null
  private microtaskScheduled = false
  private wasComposing = false
  private activeEditRanges: ScanRange[] = []
  private destroyed = false

  constructor(view: EditorView, checkWords: SpellCheckWords) {
    this.view = view
    this.checkWords = checkWords
    this.scheduleScan()
  }

  destroy() {
    this.destroyed = true
    if (this.scheduledFrame != null) {
      this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(
        this.scheduledFrame
      )
    }
    this.scheduledFrame = null
    this.cancelUnavailableRetry()
  }

  update(update: ViewUpdate) {
    let refresh = update.docChanged || update.viewportChanged
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(refreshSpellCheck)) {
          refresh = true
          this.resetUnavailableRetry()
          if (effect.value == null) this.cache.clear()
          else this.cache.delete(effect.value)
        } else if (effect.is(continueSpellCheck)) {
          refresh = true
        }
      }
    }
    const composing = update.view.compositionStarted
    if (composing) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes)
        this.updateActiveEditRanges(update)
        this.removeActiveEditDecorations()
      }
      this.wasComposing = true
      return
    }
    const activelyEdited = update.transactions.some(
      (transaction) =>
        transaction.docChanged &&
        (transaction.isUserEvent("input.type") ||
          (transaction.isUserEvent("delete") &&
            !transaction.isUserEvent("delete.cut")))
    )
    if (update.docChanged) {
      if (activelyEdited || this.wasComposing) {
        this.updateActiveEditRanges(update)
      } else {
        this.activeEditRanges = []
      }
    } else if (
      this.activeEditRanges.length > 0 &&
      (update.selectionSet || update.focusChanged)
    ) {
      const retained =
        update.focusChanged && !update.view.hasFocus
          ? []
          : this.activeEditRanges.filter(({ from, to }) =>
              update.state.selection.ranges.some(
                (selection) =>
                  selection.empty &&
                  selection.head >= from &&
                  selection.head <= to
              )
            )
      if (retained.length !== this.activeEditRanges.length) {
        this.activeEditRanges = retained
        refresh = true
      }
    }
    if (refresh || this.wasComposing) {
      this.decorations = this.buildDecorations(update.state)
    }
    this.wasComposing = false
  }

  private updateActiveEditRanges(update: ViewUpdate) {
    const changes = changedRanges(update)
    const active: ScanRange[] = []
    for (const selection of update.state.selection.ranges) {
      if (!selection.empty) continue
      const candidate = spellingCandidateAt(update.state, selection.head)
      if (
        candidate &&
        changes.some((change) => changeTouchesRange(change, candidate)) &&
        !candidateWasOnlyRelocated(update, changes, candidate)
      ) {
        active.push({ from: candidate.from, to: candidate.to })
        continue
      }

      const head = selection.head
      const joiner = head > 0 ? update.state.sliceDoc(head - 1, head) : ""
      const previous = head > 1 ? update.state.sliceDoc(head - 2, head - 1) : ""
      if (
        !incompleteSpellingJoinerPattern.test(joiner) ||
        incompleteSpellingJoinerPattern.test(previous)
      ) {
        continue
      }
      const joinedCandidate = spellingCandidateAt(update.state, head - 1)
      const range = joinedCandidate
        ? { from: joinedCandidate.from, to: head }
        : null
      if (
        range &&
        changes.some((change) => changeTouchesRange(change, range))
      ) {
        active.push(range)
      }
    }
    this.activeEditRanges = active
  }

  private removeActiveEditDecorations() {
    if (this.activeEditRanges.length === 0) return
    this.decorations = this.decorations.update({
      filter: (from, to) =>
        !this.activeEditRanges.some((range) =>
          rangesOverlap({ from, to }, range)
        ),
    })
  }

  private scheduleScan() {
    if (
      this.destroyed ||
      this.scheduledFrame != null ||
      this.microtaskScheduled
    ) {
      return
    }
    const scan = () => {
      this.scheduledFrame = null
      this.microtaskScheduled = false
      if (this.destroyed || !this.view.dom.isConnected) return
      this.view.dispatch({ effects: continueSpellCheck.of() })
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    if (ownerWindow) {
      this.scheduledFrame = ownerWindow.requestAnimationFrame(scan)
    } else {
      this.microtaskScheduled = true
      queueMicrotask(scan)
    }
  }

  private cancelUnavailableRetry() {
    if (this.unavailableRetryTimer == null) return
    this.view.dom.ownerDocument.defaultView?.clearTimeout(
      this.unavailableRetryTimer
    )
    this.unavailableRetryTimer = null
  }

  private resetUnavailableRetry() {
    this.cancelUnavailableRetry()
    this.unavailableRetryAttempt = 0
  }

  private scheduleUnavailableRetry() {
    if (
      this.destroyed ||
      this.unavailableRetryTimer != null ||
      this.unavailableRetryAttempt >= unavailableRetryDelays.length
    ) {
      return
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView
    if (!ownerWindow) return
    const delay = unavailableRetryDelays[this.unavailableRetryAttempt]
    this.unavailableRetryAttempt += 1
    this.unavailableRetryTimer = ownerWindow.setTimeout(() => {
      this.unavailableRetryTimer = null
      if (this.destroyed || !this.view.dom.isConnected) return
      this.view.dispatch({ effects: continueSpellCheck.of() })
    }, delay)
  }

  private remember(word: string, misspelled: boolean) {
    this.cache.delete(word)
    this.cache.set(word, misspelled)
  }

  private prepareCache(activeWords: ReadonlySet<string>) {
    const cacheLimit = Math.max(maximumCachedSpellingWords, activeWords.size)
    let missingActiveWords = 0
    for (const word of activeWords) {
      if (!this.cache.has(word)) missingActiveWords += 1
    }
    if (this.cache.size + missingActiveWords <= cacheLimit) return
    for (const word of this.cache.keys()) {
      if (activeWords.has(word)) continue
      this.cache.delete(word)
      if (this.cache.size + missingActiveWords <= cacheLimit) return
    }
  }

  private buildDecorations(state: EditorState) {
    const candidates = visibleSpellingCandidates(
      state,
      this.view.visibleRanges
    ).filter(
      ({ from, to }) =>
        !this.activeEditRanges.some((range) =>
          rangesOverlap({ from, to }, range)
        )
    )
    const activeWords = new Set(candidates.map(({ word }) => word))
    this.prepareCache(activeWords)
    const uniqueUncheckedWords: string[] = []
    const pendingWords = new Set<string>()
    for (const { word } of candidates) {
      if (this.cache.has(word) || pendingWords.has(word)) continue
      pendingWords.add(word)
      uniqueUncheckedWords.push(word)
    }
    const batch = uniqueUncheckedWords.slice(0, maximumWordsPerFrame)
    if (batch.length > 0) {
      let results: readonly boolean[] | null = null
      try {
        results = this.checkWords(batch)
      } catch {
        // A temporarily unavailable platform dictionary should not interrupt
        // editor updates. A later explicit refresh retries these words.
      }
      for (const [index, word] of batch.entries()) {
        if (typeof results?.[index] !== "boolean") continue
        this.remember(word, results[index])
      }
      if (results?.length !== batch.length) {
        // Enabling Chromium's checker is asynchronous, and macOS provides no
        // dictionary-initialized event for its native service. Do not turn a
        // transient all-correct response into durable cache entries; retry on
        // a bounded backoff so a Settings preview cannot poll indefinitely.
        this.scheduleUnavailableRetry()
      } else {
        this.resetUnavailableRetry()
        if (uniqueUncheckedWords.length > batch.length) this.scheduleScan()
      }
    }
    this.prepareCache(activeWords)

    return Decoration.set(
      candidates.flatMap(({ from, to, word }) =>
        this.cache.get(word) === true ? [spellingMark.range(from, to)] : []
      ),
      true
    )
  }
}

export function spellCheckExtension(checkWords: SpellCheckWords): Extension {
  return ViewPlugin.define((view) => new SpellCheckView(view, checkWords), {
    decorations: (value) => value.decorations,
  })
}
