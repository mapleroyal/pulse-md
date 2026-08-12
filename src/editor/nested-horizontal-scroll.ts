import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"

interface NestedHorizontalScrollMeasurement {
  readonly element: HTMLElement
  readonly scrollLeft: number
}

const nestedHorizontalScrollerSelector = [
  ".cm-md-callout-body",
  ".cm-md-quote-block",
  ".cm-md-yaml-frontmatter",
].join(", ")

function nestedHorizontalScrollMeasurement(
  view: EditorView
): NestedHorizontalScrollMeasurement | null {
  const selection = view.state.selection.main
  const side: -1 | 1 =
    selection.assoc || (selection.head > selection.anchor ? -1 : 1)
  let position: ReturnType<EditorView["domAtPos"]>
  try {
    position = view.domAtPos(selection.head, side)
  } catch {
    return null
  }

  const { node, offset } = position
  const parent = node instanceof Element ? node : node.parentElement
  const element = parent?.closest<HTMLElement>(nestedHorizontalScrollerSelector)
  if (!element || element.scrollWidth <= element.clientWidth) return null

  const nestedScroller = parent?.closest<HTMLElement>(
    ".cm-md-code-block, .cm-md-table-scroll"
  )
  if (nestedScroller && element.contains(nestedScroller)) {
    const bounds = element.getBoundingClientRect()
    const nestedBounds = nestedScroller.getBoundingClientRect()
    const scale =
      element.offsetWidth > 0 ? bounds.width / element.offsetWidth : 1
    const left = bounds.left + element.clientLeft * scale
    const right = left + element.clientWidth * scale
    const screenDelta =
      nestedBounds.left < left
        ? nestedBounds.left - left
        : nestedBounds.right > right
          ? nestedBounds.right - right
          : 0
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth)
    return {
      element,
      scrollLeft: Math.max(
        0,
        Math.min(maximum, element.scrollLeft + screenDelta / scale)
      ),
    }
  }

  const range = node.ownerDocument?.createRange()
  if (!range) return null
  range.setStart(node, offset)
  range.collapse(true)
  let caret = range.getBoundingClientRect()

  if (caret.height === 0 && node instanceof Text && node.length > 0) {
    const from =
      side < 0
        ? Math.max(0, Math.min(node.length - 1, offset - 1))
        : Math.max(0, Math.min(node.length - 1, offset))
    range.setStart(node, from)
    range.setEnd(node, from + 1)
    const character = range.getBoundingClientRect()
    const x = side < 0 ? character.right : character.left
    caret = DOMRect.fromRect({
      x,
      y: character.top,
      width: 0,
      height: character.height,
    })
  }

  const bounds = element.getBoundingClientRect()
  const scale = element.offsetWidth > 0 ? bounds.width / element.offsetWidth : 1
  const left = bounds.left + element.clientLeft * scale
  const right = left + element.clientWidth * scale
  const maximum = Math.max(0, element.scrollWidth - element.clientWidth)
  const line = view.state.doc.lineAt(selection.head)
  if (selection.head === line.from) {
    return { element, scrollLeft: 0 }
  }
  if (selection.head === line.to) {
    const contentX = (caret.right - left) / scale + element.scrollLeft
    if (contentX >= element.scrollWidth - 1) {
      return { element, scrollLeft: maximum }
    }
  }

  const margin = 5
  const screenDelta =
    caret.right > right - margin
      ? caret.right - (right - margin)
      : caret.left < left + margin
        ? caret.left - (left + margin)
        : 0
  return {
    element,
    scrollLeft: Math.max(
      0,
      Math.min(maximum, element.scrollLeft + screenDelta / scale)
    ),
  }
}

class NestedHorizontalSelectionScrollPlugin {
  private readonly view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.requestReveal()
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      update.viewportChanged
    ) {
      this.requestReveal()
    }
  }

  private requestReveal() {
    this.view.requestMeasure(this.revealSelectionMeasure)
  }

  private readonly revealSelectionMeasure = {
    key: this,
    read: (view: EditorView) => nestedHorizontalScrollMeasurement(view),
    write: (measurement: NestedHorizontalScrollMeasurement | null) => {
      if (!measurement) return
      const previousScrollLeft = measurement.element.scrollLeft
      measurement.element.scrollLeft = measurement.scrollLeft
      if (
        Math.abs(measurement.element.scrollLeft - previousScrollLeft) >= 0.5
      ) {
        this.requestReveal()
      }
    },
  }
}

export const nestedHorizontalSelectionScrollExtension = ViewPlugin.define(
  (view) => new NestedHorizontalSelectionScrollPlugin(view)
)
