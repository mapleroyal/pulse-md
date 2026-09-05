import {
  type ChangeDesc,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  Transaction,
} from "@codemirror/state"
import { isolateHistory } from "@codemirror/commands"
import { EditorView, type ViewUpdate } from "@codemirror/view"

import { normalizeEditorContent } from "./content"

export interface PendingAsyncPaste {
  readonly canJoinOriginalHistory: boolean
  readonly historyTime: number
  readonly ranges: readonly { readonly from: number; readonly to: number }[]
  readonly source: string
}

export interface AsyncPasteRange {
  readonly from: number
  readonly to: number
}

export type AsyncPasteReplacement =
  string | ((range: AsyncPasteRange) => string)

/** Inserts a safe clipboard representation before asynchronous enrichment. */
export function asyncPasteFallbackTransaction(
  state: EditorState,
  source: string
) {
  source = normalizeEditorContent(source)
  const changes = state.changeByRange((range) => ({
    changes: { from: range.from, insert: source, to: range.to },
    range: EditorSelection.cursor(range.from + source.length),
  }))
  const transaction = state.update(changes, { userEvent: "input.paste" })
  return {
    pending: {
      canJoinOriginalHistory: true,
      historyTime: transaction.annotation(Transaction.time) ?? Date.now(),
      ranges: transaction.state.selection.ranges.map((range) => ({
        from: range.head - source.length,
        to: range.head,
      })),
      source,
    } satisfies PendingAsyncPaste,
    transaction,
  }
}

/** Maps an already-inserted fallback through unrelated document edits. */
export function mapPendingAsyncPaste(
  pending: PendingAsyncPaste,
  changes: ChangeDesc
): PendingAsyncPaste {
  return {
    canJoinOriginalHistory: false,
    historyTime: pending.historyTime,
    source: pending.source,
    ranges: pending.ranges.flatMap((range) => {
      let touched = false
      changes.iterChangedRanges((from, to) => {
        touched ||=
          range.from === range.to
            ? from <= range.from && to >= range.to
            : (from < range.to && to > range.from) ||
              (from === to && from > range.from && from < range.to)
      })
      // Once authored input touches a fallback, even an undo that restores its
      // exact bytes must not let delayed clipboard work overwrite that input.
      if (touched) return []
      if (range.from === range.to) {
        const position = changes.mapPos(range.from, -1)
        return [{ from: position, to: position }]
      }
      const from = changes.mapPos(range.from, 1)
      const to = changes.mapPos(range.to, -1)
      return from <= to ? [{ from, to }] : []
    }),
  }
}

/** Replaces only fallback ranges that remain byte-for-byte unchanged. */
export function resolvedAsyncPasteChanges(
  state: EditorState,
  pending: PendingAsyncPaste,
  replacement: AsyncPasteReplacement
): ChangeSpec[] {
  if (typeof replacement === "string" && replacement === pending.source) {
    return []
  }
  return pending.ranges.flatMap((range) => {
    if (state.sliceDoc(range.from, range.to) !== pending.source) return []
    const insert =
      typeof replacement === "string" ? replacement : replacement(range)
    return insert === pending.source
      ? []
      : [{ from: range.from, to: range.to, insert }]
  })
}

/**
 * Keeps an untouched fallback and its async replacement in one undo step.
 * Once another edit intervenes, the replacement becomes an isolated step so
 * CodeMirror's stored inverse cannot overlap later history.
 */
export function resolvedAsyncPasteTransaction(
  state: EditorState,
  pending: PendingAsyncPaste,
  replacement: AsyncPasteReplacement
) {
  if (state.readOnly || !state.facet(EditorView.editable)) return null
  const changes = resolvedAsyncPasteChanges(state, pending, replacement)
  if (changes.length === 0) return null
  return state.update({
    changes,
    ...(pending.canJoinOriginalHistory
      ? { annotations: Transaction.time.of(pending.historyTime) }
      : {
          annotations: isolateHistory.of("full"),
          userEvent: "input.paste.resolve",
        }),
  })
}

export class AsyncPasteTracker {
  readonly pastes = new Map<object, PendingAsyncPaste>()

  update(update: ViewUpdate) {
    if (update.state.readOnly || !update.state.facet(EditorView.editable)) {
      this.pastes.clear()
      return
    }
    if (!update.docChanged && !update.selectionSet) return
    for (const [token, pending] of this.pastes) {
      this.pastes.set(token, {
        ...(update.docChanged
          ? mapPendingAsyncPaste(pending, update.changes)
          : pending),
        canJoinOriginalHistory: false,
      })
    }
  }

  destroy() {
    this.pastes.clear()
  }
}
