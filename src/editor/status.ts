import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state"
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"

import type { EditorStatus } from "./types"

interface TextRange {
  from: number
  to: number
}

const ASYNC_WORD_COUNT_THRESHOLD = 1024 * 1024
const INCREMENTAL_WORD_COUNT_BUDGET = 256 * 1024
const WORD_COUNT_SLICE_CODE_UNITS = 64 * 1024
const unicodeWordCharacter = /[\p{L}\p{M}\p{N}]/u

const WORD_SCAN_OUTSIDE = 0
const WORD_SCAN_IN_WORD = 1
const WORD_SCAN_AFTER_CONNECTOR = 2
type WordScanState =
  | typeof WORD_SCAN_OUTSIDE
  | typeof WORD_SCAN_IN_WORD
  | typeof WORD_SCAN_AFTER_CONNECTOR

function isWordCharacter(character: string) {
  const code = character.charCodeAt(0)
  return code < 128
    ? (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
    : unicodeWordCharacter.test(character)
}

function isWordConnector(character: string) {
  return (
    character === "'" ||
    character === "’" ||
    character === "_" ||
    character === "-"
  )
}

class StreamingWordCounter {
  words = 0
  private state: WordScanState = WORD_SCAN_OUTSIDE

  add(source: string) {
    for (const character of source) {
      if (isWordCharacter(character)) {
        if (this.state === WORD_SCAN_OUTSIDE) this.words += 1
        this.state = WORD_SCAN_IN_WORD
      } else if (isWordConnector(character)) {
        this.state =
          this.state === WORD_SCAN_IN_WORD
            ? WORD_SCAN_AFTER_CONNECTOR
            : WORD_SCAN_OUTSIDE
      } else {
        this.state = WORD_SCAN_OUTSIDE
      }
    }
  }
}

export function countWords(source: string): number {
  const counter = new StreamingWordCounter()
  counter.add(source)
  return counter.words
}

function wholeLineRange(document: Text, from: number, to: number): TextRange {
  const safeFrom = Math.max(0, Math.min(from, document.length))
  const safeTo = Math.max(safeFrom, Math.min(to, document.length))
  return {
    from: document.lineAt(safeFrom).from,
    to: document.lineAt(safeTo).to,
  }
}

function mergedRanges(ranges: TextRange[]): TextRange[] {
  if (ranges.length < 2) return ranges
  ranges.sort((left, right) => left.from - right.from)
  const merged: TextRange[] = [{ ...ranges[0]! }]
  for (const range of ranges.slice(1)) {
    const previous = merged.at(-1)!
    if (range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function countRanges(document: Text, ranges: readonly TextRange[]): number {
  return ranges.reduce(
    (total, range) =>
      total + countWords(document.sliceString(range.from, range.to)),
    0
  )
}

function countDocumentWords(document: Text) {
  let count = 0
  for (const line of document.iterLines()) count += countWords(line)
  return count
}

const setWordCount = StateEffect.define<{ document: Text; words: number }>()

export const wordCountField = StateField.define<number | null>({
  create: (state) =>
    state.doc.length >= ASYNC_WORD_COUNT_THRESHOLD
      ? null
      : countDocumentWords(state.doc),
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (
        effect.is(setWordCount) &&
        effect.value.document === transaction.state.doc
      ) {
        return effect.value.words
      }
    }
    if (!transaction.docChanged) return value
    if (value === null) return null

    const before: TextRange[] = []
    const after: TextRange[] = []
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      before.push(wholeLineRange(transaction.startState.doc, fromA, toA))
      after.push(wholeLineRange(transaction.newDoc, fromB, toB))
    })

    const mergedBefore = mergedRanges(before)
    const mergedAfter = mergedRanges(after)
    const affectedCodeUnits = [...mergedBefore, ...mergedAfter].reduce(
      (total, range) => total + range.to - range.from,
      0
    )
    return affectedCodeUnits > INCREMENTAL_WORD_COUNT_BUDGET
      ? null
      : value -
          countRanges(transaction.startState.doc, mergedBefore) +
          countRanges(transaction.newDoc, mergedAfter)
  },
})

class AsyncWordCounter {
  private cancelScheduledSlice: (() => void) | null = null
  private generation = 0

  constructor(view: EditorView) {
    this.schedule(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.schedule(update.view)
  }

  private schedule(view: EditorView) {
    this.generation += 1
    this.cancelScheduledSlice?.()
    this.cancelScheduledSlice = null
    if (view.state.field(wordCountField) !== null) return
    const generation = this.generation
    const document = view.state.doc
    const counter = new StreamingWordCounter()
    let position = 0
    const runSlice = (deadline?: IdleDeadline) => {
      if (generation !== this.generation || view.state.doc !== document) return
      let processed = 0
      while (
        processed < WORD_COUNT_SLICE_CODE_UNITS &&
        (!deadline || deadline.timeRemaining() > 1 || deadline.didTimeout)
      ) {
        if (position >= document.length) {
          view.dispatch({
            effects: setWordCount.of({ document, words: counter.words }),
          })
          return
        }
        let to = Math.min(
          document.length,
          position + WORD_COUNT_SLICE_CODE_UNITS - processed
        )
        if (
          to < document.length &&
          to > position &&
          /[\uD800-\uDBFF]/u.test(document.sliceString(to - 1, to)) &&
          /[\uDC00-\uDFFF]/u.test(document.sliceString(to, to + 1))
        ) {
          // Keep a surrogate pair together. When only one unit remains in this
          // slice, exceed the soft budget by one rather than making no progress.
          to += to - position === 1 ? 1 : -1
        }
        const source = document.sliceString(position, to)
        counter.add(source)
        processed += to - position
        position = to
      }
      this.scheduleSlice(view, runSlice)
    }
    this.scheduleSlice(view, runSlice)
  }

  private scheduleSlice(
    view: EditorView,
    runSlice: (deadline?: IdleDeadline) => void
  ) {
    const ownerWindow = view.dom.ownerDocument.defaultView
    if (ownerWindow?.requestIdleCallback) {
      const callback = ownerWindow.requestIdleCallback(
        (deadline) => {
          this.cancelScheduledSlice = null
          runSlice(deadline)
        },
        { timeout: 250 }
      )
      this.cancelScheduledSlice = () => ownerWindow.cancelIdleCallback(callback)
    } else {
      const callback = setTimeout(() => {
        this.cancelScheduledSlice = null
        runSlice()
      }, 0)
      this.cancelScheduledSlice = () => clearTimeout(callback)
    }
  }

  destroy() {
    this.generation += 1
    this.cancelScheduledSlice?.()
    this.cancelScheduledSlice = null
  }
}

export const wordCountExtension: Extension = [
  wordCountField,
  ViewPlugin.fromClass(AsyncWordCounter),
]

export function editorStatus(state: EditorState): EditorStatus {
  const position = state.selection.main.head
  const line = state.doc.lineAt(position)
  return {
    words: state.field(wordCountField),
    lines: state.doc.lines,
    characters: state.doc.length,
    line: line.number,
    column: position - line.from + 1,
  }
}
