import {
  Facet,
  StateEffect,
  type EditorState,
  type Transaction,
} from "@codemirror/state"
import type { DecorationSet, EditorView } from "@codemirror/view"

export interface PreviewDocumentRange {
  readonly from: number
  readonly to: number
}

export interface SemanticPreviewSelection {
  readonly element: HTMLElement
  readonly from: number
  readonly to: number
  /** Rendered text can keep a native DOM selection instead of revealing source. */
  readonly dragSelection: "atomic" | "rendered"
  /** Optional inner source bounds for selection-only syntax such as math marks. */
  readonly selectionFrom?: number
  readonly selectionTo?: number
}

export interface SemanticPreviewSelectionResolver {
  /** Higher-priority semantic containers own anything rendered inside them. */
  readonly priority: number
  /** Optional fast path for source drags before CodeMirror handles mousemove. */
  resolveTarget?(
    view: EditorView,
    target: Element,
    pointer: { readonly x: number; readonly y: number }
  ): SemanticPreviewSelection | null
  resolve(
    view: EditorView,
    target: Element,
    position: number,
    pointer: { readonly x: number; readonly y: number }
  ): SemanticPreviewSelection | null
}

/** Optional preview chunks publish pointer semantics without entering core. */
export const semanticPreviewSelectionResolvers = Facet.define<
  SemanticPreviewSelectionResolver,
  readonly SemanticPreviewSelectionResolver[]
>({
  combine: (resolvers) =>
    [...resolvers].sort((left, right) => right.priority - left.priority),
})

export function nearbyPreviewPositions(state: EditorState, position: number) {
  const bounded = Math.max(0, Math.min(position, state.doc.length))
  return [
    ...new Set([
      bounded,
      Math.max(0, bounded - 1),
      Math.min(state.doc.length, bounded + 1),
    ]),
  ]
}

export function firstNearbyPreviewRange<T extends PreviewDocumentRange>(
  state: EditorState,
  position: number,
  resolve: (position: number) => T | null
) {
  for (const candidate of nearbyPreviewPositions(state, position)) {
    const range = resolve(candidate)
    if (range) return range
  }
  return null
}

/** CodeMirror maps a replacement widget's DOM node to its current source edge. */
export function previewPositionAtDOM(
  view: EditorView,
  element: HTMLElement,
  fallback: number
) {
  try {
    return view.posAtDOM(element)
  } catch {
    return Math.max(0, Math.min(fallback, view.state.doc.length))
  }
}

/** Keep materialized replacements in the scan set when CodeMirror omits their source. */
export function previewScanRanges(
  visibleRanges: readonly PreviewDocumentRange[],
  viewport: PreviewDocumentRange,
  decorations: DecorationSet
) {
  const candidates = [...visibleRanges]
  decorations.between(viewport.from, viewport.to, (from, to) => {
    candidates.push({ from, to })
  })
  candidates.sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: PreviewDocumentRange[] = []
  for (const range of candidates) {
    const previous = merged.at(-1)
    if (!previous || range.from > previous.to) {
      merged.push(range)
    } else {
      merged[merged.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, range.to),
      }
    }
  }
  return merged
}

/** Rebuild selection-sensitive preview decorations after pointer selection. */
export const refreshLivePreview = StateEffect.define<null>()

export function livePreviewRefreshRequested(transaction: Transaction) {
  return transaction.effects.some((effect) => effect.is(refreshLivePreview))
}

/**
 * Let CodeMirror dispatch state effects queued by the current view update
 * before a preview field starts its own transaction. In particular, focus
 * effects are queued at the end of an update and are discarded if another
 * transaction changes the state first.
 */
export function queuePreviewRebuild(rebuild: () => void) {
  queueMicrotask(() => queueMicrotask(rebuild))
}

/**
 * Pointer selection must resolve against the DOM that received pointerdown.
 * Keep layout-changing previews intact until the shared pointer-end refresh.
 */
export function preservePreviewDuringPointerSelection(
  transaction: Transaction
) {
  return (
    !transaction.docChanged &&
    !livePreviewRefreshRequested(transaction) &&
    !transaction.startState.selection.eq(transaction.state.selection) &&
    transaction.isUserEvent("select.pointer")
  )
}

/**
 * Preview controls whose native pointer activation must not be captured by
 * selection-refresh plugins. Keep this list shared so independently enabled
 * preview extensions continue to compose without disabling one another.
 */
export const interactivePreviewWidgetSelector = [
  ".cm-md-task-checkbox",
  ".cm-md-callout-toggle",
  ".cm-md-code-tool",
  ".cm-md-html-block summary",
  ".cm-md-footnote-navigation",
  ".cm-md-footnote-definition-label",
  ".cm-md-heading-anchor",
].join(", ")
