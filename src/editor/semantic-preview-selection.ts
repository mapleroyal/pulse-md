import type { EditorView } from "@codemirror/view"

import {
  semanticPreviewSelectionResolvers,
  type SemanticPreviewSelection,
} from "./interactive-preview"

export interface SourceLinePointerPosition {
  readonly assoc: -1 | 1
  readonly clamped: boolean
  readonly pos: number
}

function isEmptyReplacementBoundary(node: Node) {
  return (
    node instanceof Element &&
    (node.classList.contains("cm-widgetBuffer") ||
      (node.getAttribute("contenteditable") === "false" &&
        node.childNodes.length === 0))
  )
}

function trailingSourcePositionAtDOMCaret(
  view: EditorView,
  line: HTMLElement,
  caret: Range | null | undefined
) {
  if (!caret || caret.startContainer !== line) return null
  // Decoration.replace leaves zero-width boundary nodes around collapsed
  // source. Chromium can place a whitespace caret between those nodes rather
  // than after them, which makes a held drag alternate across the hidden
  // closing delimiter as the pointer moves.
  const trailingNodes = Array.from(line.childNodes).slice(caret.startOffset)
  if (
    trailingNodes.length === 0 ||
    !trailingNodes.every(isEmptyReplacementBoundary)
  ) {
    return null
  }
  try {
    return view.posAtDOM(line, line.childNodes.length)
  } catch {
    return null
  }
}

/** Keeps a pointer hit on a mounted source row within that row's DOM range. */
export function sourceLinePointerPosition(
  view: EditorView,
  event: Pick<MouseEvent, "clientX" | "clientY" | "target">
): SourceLinePointerPosition | null {
  const raw = view.posAndSideAtCoords({
    x: event.clientX,
    y: event.clientY,
  })
  if (!raw) return null
  const ownerDocument = view.dom.ownerDocument
  const eventTarget = event.target instanceof Element ? event.target : null
  const eventLine = eventTarget?.closest<HTMLElement>(".cm-line") ?? null
  const coordinateLine =
    typeof ownerDocument.elementsFromPoint === "function"
      ? (ownerDocument
          .elementsFromPoint(event.clientX, event.clientY)
          .map((target) => target.closest<HTMLElement>(".cm-line"))
          .find(
            (candidate): candidate is HTMLElement =>
              candidate != null && view.contentDOM.contains(candidate)
          ) ?? null)
      : null
  const eventLineBounds = eventLine?.getBoundingClientRect()
  const eventLineStillAtPointer =
    eventLine != null &&
    view.contentDOM.contains(eventLine) &&
    eventLineBounds != null &&
    event.clientX >= eventLineBounds.left &&
    event.clientX <= eventLineBounds.right &&
    event.clientY >= eventLineBounds.top &&
    event.clientY <= eventLineBounds.bottom
  // MouseSelection replays its last event after every autoscroll tick. Its
  // target can therefore remain attached to the row that used to occupy the
  // pointer even after that row moved. Resolve the current coordinate first,
  // and accept the event target only while its box still covers the pointer.
  const line = coordinateLine ?? (eventLineStillAtPointer ? eventLine : null)
  if (!line || !view.contentDOM.contains(line)) {
    return { ...raw, clamped: false }
  }
  try {
    const first = view.posAtDOM(line, 0)
    const last = view.posAtDOM(line, line.childNodes.length)
    const from = Math.min(first, last)
    const to = Math.max(first, last)
    const caretDocument = line.ownerDocument as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null
    }
    const caret = caretDocument.caretRangeFromPoint?.(
      event.clientX,
      event.clientY
    )
    const trailingPosition = trailingSourcePositionAtDOMCaret(view, line, caret)
    if (
      trailingPosition != null &&
      trailingPosition >= from &&
      trailingPosition <= to &&
      trailingPosition > raw.pos
    ) {
      return { assoc: -1, clamped: true, pos: trailingPosition }
    }
    if (raw.pos >= from && raw.pos <= to) {
      return { ...raw, clamped: false }
    }

    const caretParent =
      caret?.startContainer instanceof Element
        ? caret.startContainer
        : caret?.startContainer.parentElement
    let pos: number | null = null
    if (
      caret &&
      line.contains(caret.startContainer) &&
      !caretParent?.closest('[aria-hidden="true"]')
    ) {
      try {
        pos = view.posAtDOM(caret.startContainer, caret.startOffset)
      } catch {
        pos = null
      }
    }
    if (pos == null || pos < from || pos > to) {
      const bounds = line.getBoundingClientRect()
      const direction =
        line.ownerDocument.defaultView?.getComputedStyle(line).direction
      const nearStart =
        direction === "rtl"
          ? event.clientX >= bounds.left + bounds.width / 2
          : event.clientX < bounds.left + bounds.width / 2
      pos = nearStart ? from : to
    }
    const assoc = pos === from ? 1 : pos === to ? -1 : raw.assoc
    return { assoc, clamped: true, pos }
  } catch {
    return { ...raw, clamped: false }
  }
}

/**
 * Resolves only opaque rendered units. Source-mapped Markdown deliberately
 * falls through to CodeMirror's ordinary pointer selection.
 */
export function semanticPreviewSelectionAtPointer(
  view: EditorView,
  target: Element,
  position: number,
  pointer: { readonly x: number; readonly y: number },
  origin: "source" | "rendered" = "rendered"
): SemanticPreviewSelection | null {
  for (const resolver of view.state.facet(semanticPreviewSelectionResolvers)) {
    const resolved =
      origin === "source" && resolver.resolveTarget
        ? resolver.resolveTarget(view, target, pointer)
        : resolver.resolve(view, target, position, pointer)
    if (resolved && resolved.from < resolved.to) return resolved
  }
  return null
}

/** Resolves previews that can publish semantics without source hit-testing. */
export function semanticPreviewSelectionAtTarget(
  view: EditorView,
  target: Element,
  pointer: { readonly x: number; readonly y: number }
): SemanticPreviewSelection | null {
  for (const resolver of view.state.facet(semanticPreviewSelectionResolvers)) {
    const resolved = resolver.resolveTarget?.(view, target, pointer)
    if (resolved && resolved.from < resolved.to) return resolved
  }
  return null
}
