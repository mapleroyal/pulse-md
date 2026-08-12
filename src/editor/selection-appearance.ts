import { syntaxTree } from "@codemirror/language"
import {
  EditorSelection,
  StateEffect,
  StateField,
  type Line,
  type SelectionRange,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  Direction,
  EditorView,
  RectangleMarker,
  layer,
  type LayerMarker,
} from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"

import { tableSegments } from "./table-selection"

const inactiveWindowClass = "cm-window-inactive"
const selectedTextClass = "cm-app-selection-foreground"
const selectedTextMark = Decoration.mark({ class: selectedTextClass })
const selectionBackgroundClass = "cm-app-selectionBackground"

interface PhysicalRectangle {
  bottom: number
  left: number
  right: number
  top: number
}

interface VisualRectangleBand {
  bottom: number
  rectangles: PhysicalRectangle[]
  top: number
}

interface SelectionGeometry {
  base: { left: number; top: number }
  lane: { left: number; right: number }
}

const edgeTolerance = 0.5

function selectionLayerBase(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect()
  const left =
    view.textDirection === Direction.LTR
      ? rect.left
      : rect.right - view.scrollDOM.clientWidth * view.scaleX
  return {
    left: left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  }
}

function textLane(
  view: EditorView,
  rect = view.contentDOM.getBoundingClientRect()
) {
  const content = view.contentDOM
  const style = content.ownerDocument.defaultView?.getComputedStyle(content)
  const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "0") || 0
  const paddingRight = Number.parseFloat(style?.paddingRight ?? "0") || 0
  return {
    left: rect.left + paddingLeft * view.scaleX,
    right: rect.right - paddingRight * view.scaleX,
  }
}

function selectionGeometry(view: EditorView): SelectionGeometry {
  const contentRect = view.contentDOM.getBoundingClientRect()
  return {
    base: selectionLayerBase(view),
    lane: textLane(view, contentRect),
  }
}

function rectangleMarker(
  rectangle: PhysicalRectangle,
  geometry: Pick<SelectionGeometry, "base" | "lane">,
  className = selectionBackgroundClass
): RectangleMarker | null {
  const left = Math.max(rectangle.left, geometry.lane.left)
  const right = Math.min(rectangle.right, geometry.lane.right)
  if (right - left <= 0 || rectangle.bottom - rectangle.top <= 0) return null
  return new RectangleMarker(
    className,
    left - geometry.base.left,
    rectangle.top - geometry.base.top,
    right - left,
    rectangle.bottom - rectangle.top
  )
}

function mergeRectangles(rectangles: PhysicalRectangle[]) {
  const sorted = rectangles
    .filter(
      (rectangle) =>
        rectangle.right > rectangle.left && rectangle.bottom > rectangle.top
    )
    .sort((left, right) => left.top - right.top || left.left - right.left)
  const merged: PhysicalRectangle[] = []
  for (const rectangle of sorted) {
    const previous = merged.at(-1)
    if (
      previous &&
      Math.abs(previous.top - rectangle.top) <= 0.5 &&
      Math.abs(previous.bottom - rectangle.bottom) <= 0.5 &&
      rectangle.left <= previous.right + 0.5
    ) {
      previous.right = Math.max(previous.right, rectangle.right)
    } else {
      merged.push({ ...rectangle })
    }
  }
  return merged
}

function visualRectangleBands(rectangles: PhysicalRectangle[]) {
  // A DOM range may return several vertically overlapping fragments for one
  // bidi or syntax-decorated visual row. Keep those together so the omitted
  // line padding can be shared with the next actual row without widening it.
  const bands: VisualRectangleBand[] = []
  for (const rectangle of [...rectangles].sort(
    (left, right) => left.top - right.top || left.left - right.left
  )) {
    const previous = bands.at(-1)
    const previousHeight = previous
      ? Math.max(edgeTolerance, previous.bottom - previous.top)
      : 0
    const rectangleHeight = Math.max(
      edgeTolerance,
      rectangle.bottom - rectangle.top
    )
    const previousCenter = previous ? (previous.top + previous.bottom) / 2 : 0
    const rectangleCenter = (rectangle.top + rectangle.bottom) / 2
    if (
      previous &&
      rectangle.top < previous.bottom - edgeTolerance &&
      Math.abs(rectangleCenter - previousCenter) <=
        Math.min(previousHeight, rectangleHeight) / 2 + edgeTolerance
    ) {
      previous.bottom = Math.max(previous.bottom, rectangle.bottom)
      previous.top = Math.min(previous.top, rectangle.top)
      previous.rectangles.push(rectangle)
    } else {
      bands.push({
        bottom: rectangle.bottom,
        rectangles: [rectangle],
        top: rectangle.top,
      })
    }
  }
  return bands
}

function joinVerticalBandGap(
  previous: VisualRectangleBand,
  next: VisualRectangleBand
) {
  if (next.top <= previous.bottom + edgeTolerance) return
  // Match CodeMirror's ordinary adjacent-row geometry: close the vertical
  // seam at its midpoint while preserving both rows' horizontal footprints.
  const midpoint = (previous.bottom + next.top) / 2
  for (const rectangle of previous.rectangles) rectangle.bottom = midpoint
  for (const rectangle of next.rectangles) rectangle.top = midpoint
  previous.bottom = midpoint
  next.top = midpoint
}

function mergeVerticallyJoinedRectangles(rectangles: PhysicalRectangle[]) {
  const merged: PhysicalRectangle[] = []
  for (const rectangle of [...rectangles].sort(
    (left, right) =>
      left.left - right.left || left.right - right.right || left.top - right.top
  )) {
    const previous = merged.at(-1)
    if (
      previous &&
      Math.abs(previous.left - rectangle.left) <= edgeTolerance &&
      Math.abs(previous.right - rectangle.right) <= edgeTolerance &&
      rectangle.top <= previous.bottom + edgeTolerance
    ) {
      previous.bottom = Math.max(previous.bottom, rectangle.bottom)
    } else {
      merged.push({ ...rectangle })
    }
  }
  return merged.sort(
    (left, right) => left.top - right.top || left.left - right.left
  )
}

function domRangeRectangles(view: EditorView, selection: SelectionRange) {
  try {
    const start = view.domAtPos(selection.from, 1)
    const end = view.domAtPos(selection.to, -1)
    const range = view.dom.ownerDocument.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return mergeRectangles(
      Array.from(range.getClientRects(), (rectangle) => ({
        bottom: rectangle.bottom,
        left: rectangle.left,
        right: rectangle.right,
        top: rectangle.top,
      }))
    )
  } catch {
    return []
  }
}

const listPrefixSourceSelector = [
  ".cm-md-list-indent-source",
  ".cm-md-list-marker-source",
  ".cm-md-list-marker-separator-source",
  ".cm-md-list-quote-prefix-source",
  ".cm-md-task-checkbox-lane",
  ".cm-md-definition-indent-source",
  ".cm-md-definition-source-mark",
  ".cm-md-definition-separator-source",
].join(",")

function mountedLineAt(view: EditorView, position: number) {
  const mapped = view.domAtPos(position, 1).node
  const element =
    mapped instanceof view.dom.ownerDocument.defaultView!.HTMLElement
      ? mapped
      : mapped.parentElement
  return element?.closest<HTMLElement>(".cm-line") ?? null
}

function listPrefixSourceRange(view: EditorView, element: HTMLElement) {
  try {
    const from = view.posAtDOM(element, 0)
    if (element.classList.contains("cm-md-task-checkbox-lane")) {
      const sourceLength = Number.parseInt(
        element.dataset.sourceLength ?? "",
        10
      )
      return Number.isFinite(sourceLength) && sourceLength > 0
        ? { from, to: from + sourceLength }
        : null
    }
    const to = view.posAtDOM(element, element.childNodes.length)
    return to > from ? { from, to } : null
  } catch {
    return null
  }
}

function listPrefixSelectionRectangles(
  view: EditorView,
  selection: SelectionRange,
  lineBounds: PhysicalRectangle
) {
  const line = mountedLineAt(view, selection.from)
  if (!line) return []
  const rectangles: PhysicalRectangle[] = []
  for (const element of line.querySelectorAll<HTMLElement>(
    listPrefixSourceSelector
  )) {
    const source = listPrefixSourceRange(view, element)
    if (!source) continue
    const from = Math.max(selection.from, source.from)
    const to = Math.min(selection.to, source.to)
    if (from >= to) continue
    const start = view.coordsAtPos(from, 1)
    const end = view.coordsAtPos(to, 1)
    if (!start || !end) continue
    const left = Math.min(start.left, end.left)
    const right = Math.max(start.left, end.left)
    if (right - left <= edgeTolerance) continue
    rectangles.push({
      bottom: Math.min(lineBounds.bottom, Math.max(start.bottom, end.bottom)),
      left,
      right,
      top: Math.max(lineBounds.top, Math.min(start.top, end.top)),
    })
  }
  return rectangles
}

function wrappedSourceRange(
  view: EditorView,
  position: number,
  side: -1 | 1,
  line: Line
) {
  const coordinates = view.coordsAtPos(position, (side * 2) as -1 | 1)
  if (!coordinates) return { from: line.from, to: line.to }
  const bounds = view.dom.getBoundingClientRect()
  const y = (coordinates.top + coordinates.bottom) / 2
  const left = view.posAtCoords({ x: bounds.left + 1, y })
  const right = view.posAtCoords({ x: bounds.right - 1, y })
  if (left == null || right == null) return { from: line.from, to: line.to }
  return {
    from: Math.max(line.from, Math.min(left, right)),
    to: Math.min(line.to, Math.max(left, right)),
  }
}

function bidiSelectionBandRectangles(
  view: EditorView,
  selection: SelectionRange,
  line: Line,
  band: VisualRectangleBand,
  lane: SelectionGeometry["lane"],
  openBefore: boolean,
  openAfter: boolean
) {
  if (openBefore && openAfter) {
    return [
      {
        bottom: band.bottom,
        left: lane.left,
        right: lane.right,
        top: band.top,
      },
    ]
  }

  const row = openBefore
    ? wrappedSourceRange(view, selection.to, -1, line)
    : wrappedSourceRange(view, selection.from, 1, line)
  const from = openBefore ? row.from : Math.max(row.from, selection.from)
  const to = openAfter ? row.to : Math.min(row.to, selection.to)
  const baseDirection = view.textDirectionAt(line.from)
  const rectangles: PhysicalRectangle[] = []

  for (const span of view.bidiSpans(line)) {
    const spanFrom = line.from + span.from
    const spanTo = line.from + span.to
    const selectedFrom = Math.max(from, spanFrom)
    const selectedTo = Math.min(to, spanTo)
    if (selectedFrom >= selectedTo) continue
    const start = view.coordsAtPos(
      selectedFrom,
      (selectedFrom === row.to ? -2 : 2) as -1 | 1
    )
    const end = view.coordsAtPos(
      selectedTo,
      (selectedTo === row.from ? 2 : -2) as -1 | 1
    )
    if (!start || !end) continue
    const fromOpen = openBefore && spanFrom <= row.from
    const toOpen = openAfter && spanTo >= row.to
    const left =
      span.dir === Direction.LTR
        ? baseDirection === Direction.LTR && fromOpen
          ? lane.left
          : start.left
        : baseDirection === Direction.RTL && toOpen
          ? lane.left
          : end.left
    const right =
      span.dir === Direction.LTR
        ? baseDirection === Direction.LTR && toOpen
          ? lane.right
          : end.right
        : baseDirection === Direction.RTL && fromOpen
          ? lane.right
          : start.right
    if (right - left <= edgeTolerance) continue
    rectangles.push({
      bottom: band.bottom,
      left,
      right,
      top: band.top,
    })
  }

  return rectangles
}

function ordinaryLineSelectionRectangles(
  view: EditorView,
  selection: SelectionRange,
  geometry: Pick<SelectionGeometry, "lane">,
  lineBounds: PhysicalRectangle,
  continuesBefore: boolean,
  continuesAfter: boolean
) {
  const rectangles = [
    ...domRangeRectangles(view, selection),
    ...listPrefixSelectionRectangles(view, selection, lineBounds),
  ]
    .map((source) => ({
      ...source,
      bottom: Math.min(source.bottom, lineBounds.bottom),
      top: Math.max(source.top, lineBounds.top),
    }))
    .filter(
      (rectangle) =>
        rectangle.right > rectangle.left && rectangle.bottom > rectangle.top
    )
  if (rectangles.length === 0) return []
  // Inline list markers and syntax spans may report different heights for the
  // same visual row. Establish rows before opening continuation edges so a
  // taller fragment can never masquerade as an intermediate wrapped row.
  const bands = visualRectangleBands(rectangles)
  const line = view.state.doc.lineAt(selection.from)
  const normalized = bands.flatMap((band, bandIndex) =>
    bidiSelectionBandRectangles(
      view,
      selection,
      line,
      band,
      geometry.lane,
      bandIndex > 0 || continuesBefore,
      bandIndex < bands.length - 1 || continuesAfter
    )
  )
  return mergeRectangles(normalized)
}

function ordinaryLineBreakRectangle(
  view: EditorView,
  lineFrom: number,
  lineTo: number,
  geometry: Pick<SelectionGeometry, "lane">,
  lineBounds: PhysicalRectangle
): PhysicalRectangle | null {
  const direction = view.textDirectionAt(lineFrom)
  const caret = view.coordsAtPos(lineTo, -1)
  const fallbackHeight = Math.max(1, view.defaultLineHeight * view.scaleY)
  let top = Math.max(
    lineBounds.top,
    caret?.top ?? lineBounds.bottom - fallbackHeight
  )
  let bottom = Math.min(lineBounds.bottom, caret?.bottom ?? lineBounds.bottom)
  if (bottom <= top) {
    bottom = lineBounds.bottom
    top = Math.max(lineBounds.top, bottom - fallbackHeight)
  }

  const minimumWidth = Math.min(
    geometry.lane.right - geometry.lane.left,
    Math.max(1, view.defaultCharacterWidth * view.scaleX)
  )
  if (direction === Direction.LTR) {
    const right = geometry.lane.right
    const caretLeft = Math.max(
      geometry.lane.left,
      Math.min(caret?.left ?? right - minimumWidth, right)
    )
    return {
      bottom,
      left: Math.min(caretLeft, right - Math.min(1, minimumWidth)),
      right,
      top,
    }
  }

  const left = geometry.lane.left
  const caretRight = Math.min(
    geometry.lane.right,
    Math.max(caret?.right ?? left + minimumWidth, left)
  )
  return {
    bottom,
    left,
    right: Math.max(caretRight, left + Math.min(1, minimumWidth)),
    top,
  }
}

function selectedSourceRectangle(
  selection: SelectionRange,
  source: { from: number; to: number },
  lane: { bottom: number; left: number; right: number; top: number },
  characterWidth: number,
  align: "left" | "right"
): PhysicalRectangle | null {
  const from = Math.max(selection.from, source.from)
  const to = Math.min(selection.to, source.to)
  if (from >= to || lane.right <= lane.left) return null

  const startOffset = from - source.from
  const endOffset = to - source.from
  const left =
    align === "left"
      ? lane.left + startOffset * characterWidth
      : lane.right - (source.to - from) * characterWidth
  const right =
    align === "left"
      ? lane.left + endOffset * characterWidth
      : lane.right - (source.to - to) * characterWidth
  const clippedLeft = Math.max(lane.left, Math.min(left, lane.right))
  const clippedRight = Math.min(lane.right, Math.max(clippedLeft + 1, right))
  if (clippedRight <= clippedLeft) return null
  return {
    bottom: lane.bottom,
    left: clippedLeft,
    right: clippedRight,
    top: lane.top,
  }
}

function selectedBoundaryRectangle(
  selection: SelectionRange,
  source: { from: number; to: number },
  lane: { bottom: number; left: number; right: number; top: number },
  boundary: number,
  characterWidth: number,
  align: "center" | "left" | "right"
): PhysicalRectangle | null {
  const from = Math.max(selection.from, source.from)
  const to = Math.min(selection.to, source.to)
  if (from >= to || lane.right <= lane.left) return null

  const width = Math.min(
    lane.right - lane.left,
    Math.max(1, (to - from) * characterWidth)
  )
  const intendedLeft =
    align === "left"
      ? boundary
      : align === "right"
        ? boundary - width
        : boundary - width / 2
  const left = Math.max(lane.left, Math.min(intendedLeft, lane.right - width))
  return {
    bottom: lane.bottom,
    left,
    right: left + width,
    top: lane.top,
  }
}

function renderedTableCellGeometry(view: EditorView, cell: HTMLElement) {
  const bounds = cell.getBoundingClientRect()
  const style = cell.ownerDocument.defaultView?.getComputedStyle(cell)
  const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "0") || 0
  const paddingRight = Number.parseFloat(style?.paddingRight ?? "0") || 0
  const paddingTop = Number.parseFloat(style?.paddingTop ?? "0") || 0
  const paddingBottom = Number.parseFloat(style?.paddingBottom ?? "0") || 0
  const lane = {
    bottom: Math.max(bounds.top, bounds.bottom - paddingBottom * view.scaleY),
    left: Math.min(bounds.right, bounds.left + paddingLeft * view.scaleX),
    right: Math.max(bounds.left, bounds.right - paddingRight * view.scaleX),
    top: Math.min(bounds.bottom, bounds.top + paddingTop * view.scaleY),
  }
  const lineHeight = Math.min(
    lane.bottom - lane.top,
    view.defaultLineHeight * view.scaleY
  )
  lane.bottom = lane.top + Math.max(1, lineHeight)
  return {
    bounds,
    characterWidth: Math.max(1, view.defaultCharacterWidth * view.scaleX),
    lane,
  }
}

function renderedTableRowRectangles(
  view: EditorView,
  selection: SelectionRange,
  mountedRow: HTMLElement
): PhysicalRectangle[] | null {
  const firstLine = view.state.doc.lineAt(selection.from)
  const lastLine = view.state.doc.lineAt(
    Math.max(selection.from, selection.to - 1)
  )
  if (firstLine.number !== lastLine.number) return null

  let row: SyntaxNode | null = null
  syntaxTree(view.state).iterate({
    from: firstLine.from,
    to: firstLine.to,
    enter(node) {
      if (node.name !== "TableHeader" && node.name !== "TableRow") return
      row = node.node
      return false
    },
  })
  const renderedRow = row as SyntaxNode | null
  if (!renderedRow) return null

  const rowElement = mountedRow
  const cells = Array.from(rowElement.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.classList.contains("cm-md-table-cell")
  )
  const segments = tableSegments(renderedRow)
  const rectangles: PhysicalRectangle[] = []
  for (const [index, segment] of segments.entries()) {
    const cell = cells[index]
    if (selection.from >= segment.to || selection.to <= segment.from) {
      continue
    }
    if (!cell) {
      const lastCell = cells.at(-1)
      if (!lastCell) continue
      const geometry = renderedTableCellGeometry(view, lastCell)
      const rectangle = selectedBoundaryRectangle(
        selection,
        segment,
        {
          ...geometry.lane,
          left: geometry.bounds.left,
          right: geometry.bounds.right,
        },
        geometry.bounds.right,
        geometry.characterWidth,
        "right"
      )
      if (rectangle) rectangles.push(rectangle)
      continue
    }

    const { bounds, characterWidth, lane } = renderedTableCellGeometry(
      view,
      cell
    )

    if (!segment.content) {
      const emptyLane =
        lane.right > lane.left
          ? lane
          : {
              ...lane,
              left: bounds.left,
              right: bounds.right,
            }
      const rectangle = selectedSourceRectangle(
        selection,
        segment,
        emptyLane,
        Math.min(
          characterWidth,
          (emptyLane.right - emptyLane.left) /
            Math.max(1, segment.to - segment.from)
        ),
        "left"
      )
      if (rectangle) rectangles.push(rectangle)
      continue
    }

    const from = Math.max(selection.from, segment.content.from)
    const to = Math.min(selection.to, segment.content.to)
    const contentRectangles =
      from < to
        ? domRangeRectangles(view, EditorSelection.range(from, to))
            .map((rectangle) => ({
              bottom: Math.min(rectangle.bottom, bounds.bottom),
              left: Math.max(rectangle.left, bounds.left),
              right: Math.min(rectangle.right, bounds.right),
              top: Math.max(rectangle.top, bounds.top),
            }))
            .filter(
              (rectangle) =>
                rectangle.right > rectangle.left &&
                rectangle.bottom > rectangle.top
            )
        : []
    if (from < to && contentRectangles.length === 0) {
      const rectangle = selectedSourceRectangle(
        selection,
        segment.content,
        lane,
        Math.min(
          characterWidth,
          (lane.right - lane.left) /
            Math.max(1, segment.content.to - segment.content.from)
        ),
        "left"
      )
      if (rectangle) contentRectangles.push(rectangle)
    }
    rectangles.push(...contentRectangles)

    const wholeContentRectangles = domRangeRectangles(
      view,
      EditorSelection.range(segment.content.from, segment.content.to)
    )
    const firstContent = wholeContentRectangles[0]
    const lastContent = wholeContentRectangles.at(-1)
    const leadingLane = {
      bottom: firstContent?.bottom ?? lane.bottom,
      left: bounds.left,
      right: Math.min(firstContent?.left ?? lane.left, lane.right),
      top: firstContent?.top ?? lane.top,
    }
    const trailingLane = {
      bottom: lastContent?.bottom ?? lane.bottom,
      left: Math.max(lastContent?.right ?? lane.right, lane.left),
      right: bounds.right,
      top: lastContent?.top ?? lane.top,
    }
    const leading = selectedSourceRectangle(
      selection,
      { from: segment.from, to: segment.content.from },
      leadingLane,
      characterWidth,
      "right"
    )
    const trailing = selectedSourceRectangle(
      selection,
      { from: segment.content.to, to: segment.to },
      trailingLane,
      characterWidth,
      "left"
    )
    if (leading) rectangles.push(leading)
    if (trailing) rectangles.push(trailing)
  }

  const delimiters: SyntaxNode[] = []
  let child = renderedRow.firstChild
  while (child) {
    if (child.name === "TableDelimiter") delimiters.push(child)
    child = child.nextSibling
  }
  for (const delimiter of delimiters) {
    if (selection.from >= delimiter.to || selection.to <= delimiter.from) {
      continue
    }

    const leftIndex = segments.findIndex(
      (segment) => segment.to === delimiter.from
    )
    const rightIndex = segments.findIndex(
      (segment) => segment.from === delimiter.to
    )
    const leftCell = leftIndex >= 0 ? cells[leftIndex] : null
    const rightCell = rightIndex >= 0 ? cells[rightIndex] : null
    const fallbackCell = cells.at(-1)
    const referenceCell = leftCell ?? rightCell ?? fallbackCell
    if (!referenceCell) continue

    const reference = renderedTableCellGeometry(view, referenceCell)
    const leftBounds = leftCell?.getBoundingClientRect()
    const rightBounds = rightCell?.getBoundingClientRect()
    const usesFallback = !leftCell && !rightCell
    const boundary = usesFallback
      ? reference.bounds.right
      : leftBounds && rightBounds
        ? (leftBounds.right + rightBounds.left) / 2
        : (leftBounds?.right ?? rightBounds?.left ?? reference.bounds.left)
    const lane = {
      ...reference.lane,
      left:
        leftBounds?.left ??
        rightBounds?.left ??
        (usesFallback ? reference.bounds.left : reference.lane.left),
      right: rightBounds?.right ?? leftBounds?.right ?? reference.bounds.right,
    }
    const rectangle = selectedBoundaryRectangle(
      selection,
      delimiter,
      lane,
      boundary,
      reference.characterWidth,
      usesFallback
        ? "right"
        : leftCell && rightCell
          ? "center"
          : leftCell
            ? "right"
            : "left"
    )
    if (rectangle) rectangles.push(rectangle)
  }

  const firstCell = cells[0]
  if (firstCell && firstLine.from < renderedRow.from) {
    const geometry = renderedTableCellGeometry(view, firstCell)
    const rectangle = selectedBoundaryRectangle(
      selection,
      { from: firstLine.from, to: renderedRow.from },
      {
        ...geometry.lane,
        left: geometry.bounds.left,
        right: geometry.bounds.right,
      },
      geometry.bounds.left,
      geometry.characterWidth,
      "left"
    )
    if (rectangle) rectangles.push(rectangle)
  }

  let mappedTo = renderedRow.from
  for (const segment of segments) mappedTo = Math.max(mappedTo, segment.to)
  for (const delimiter of delimiters) {
    mappedTo = Math.max(mappedTo, delimiter.to)
  }
  const lastCell = cells.at(-1)
  if (lastCell && mappedTo < firstLine.to) {
    const geometry = renderedTableCellGeometry(view, lastCell)
    const rectangle = selectedBoundaryRectangle(
      selection,
      { from: mappedTo, to: firstLine.to },
      {
        ...geometry.lane,
        left: geometry.bounds.left,
        right: geometry.bounds.right,
      },
      geometry.bounds.right,
      geometry.characterWidth,
      "right"
    )
    if (rectangle) rectangles.push(rectangle)
  }

  if (rectangles.length === 0 && firstCell && lastCell) {
    const useLeadingEdge =
      (selection.from + selection.to) / 2 <=
      (segments[0]?.from ?? renderedRow.from)
    const referenceCell = useLeadingEdge ? firstCell : lastCell
    const geometry = renderedTableCellGeometry(view, referenceCell)
    const rectangle = selectedBoundaryRectangle(
      selection,
      selection,
      {
        ...geometry.lane,
        left: geometry.bounds.left,
        right: geometry.bounds.right,
      },
      useLeadingEdge ? geometry.bounds.left : geometry.bounds.right,
      geometry.characterWidth,
      useLeadingEdge ? "left" : "right"
    )
    if (rectangle) rectangles.push(rectangle)
  }

  const rowBounds = rowElement.getBoundingClientRect()
  const tableBounds = rowElement
    .closest<HTMLElement>(".cm-md-table-scroll")
    ?.getBoundingClientRect()
  const visibleLeft = Math.max(
    rowBounds.left,
    tableBounds?.left ?? rowBounds.left
  )
  const visibleRight = Math.min(
    rowBounds.right,
    tableBounds?.right ?? rowBounds.right
  )
  return mergeRectangles(
    rectangles.map((rectangle) => ({
      bottom: Math.min(rectangle.bottom, rowBounds.bottom),
      left: Math.max(rectangle.left, visibleLeft),
      right: Math.min(rectangle.right, visibleRight),
      top: Math.max(rectangle.top, rowBounds.top),
    }))
  )
}

function renderedTableTrailingBoundaryRectangle(
  view: EditorView,
  selection: SelectionRange,
  source: { from: number; to: number },
  rowElement: HTMLElement
) {
  const lastCell = Array.from(rowElement.children).findLast(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.classList.contains("cm-md-table-cell")
  )
  if (!lastCell) return null
  if (selection.from >= source.to || selection.to <= source.from) return null
  const geometry = renderedTableCellGeometry(view, lastCell)
  const rowBounds = rowElement.getBoundingClientRect()
  const tableBounds = rowElement
    .closest<HTMLElement>(".cm-md-table-scroll")
    ?.getBoundingClientRect()
  const visibleLeft = Math.max(
    rowBounds.left,
    tableBounds?.left ?? rowBounds.left
  )
  const visibleRight = Math.min(
    rowBounds.right,
    tableBounds?.right ?? rowBounds.right
  )
  const width = Math.min(
    geometry.characterWidth,
    Math.max(0, visibleRight - visibleLeft)
  )
  if (width <= 0) return null
  const right = Math.min(
    visibleRight,
    Math.max(visibleLeft + width, geometry.bounds.right)
  )
  return {
    bottom: Math.min(geometry.lane.bottom, rowBounds.bottom),
    left: right - width,
    right,
    top: Math.max(geometry.lane.top, rowBounds.top),
  }
}

interface MountedSourceInterval {
  from: number
  to: number
}

interface MountedTableRow extends MountedSourceInterval {
  element: HTMLElement
  line: Line
  table: Element | null
}

interface MountedOrdinaryLine extends MountedSourceInterval {
  bounds: PhysicalRectangle
  line: Line
}

function mountedTableRows(view: EditorView) {
  const rows: Array<Omit<MountedTableRow, "from" | "to">> = []
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>(
    ".cm-md-table-line"
  )) {
    try {
      const line = view.state.doc.lineAt(view.posAtDOM(element, 0))
      rows.push({
        element,
        line,
        table: element.closest(".cm-md-table-scroll"),
      })
    } catch {
      // Viewport redraws can transiently detach a rendered row.
    }
  }
  rows.sort((left, right) => left.line.from - right.line.from)
  return rows.map<MountedTableRow>((row, index) => {
    const nextRow = rows[index + 1]
    return {
      ...row,
      from: row.line.from,
      to:
        row.table != null && nextRow?.table === row.table
          ? nextRow.line.from
          : Math.min(view.state.doc.length, row.line.to + 1),
    }
  })
}

function mountedOrdinaryLines(
  view: EditorView,
  geometry: Pick<SelectionGeometry, "lane">
) {
  const lines: MountedOrdinaryLine[] = []
  const seenLines = new Set<number>()
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>(
    ".cm-line"
  )) {
    if (
      element.closest(".cm-md-table-scroll") ||
      element.querySelector(".cm-md-table-scroll")
    ) {
      continue
    }
    try {
      const line = view.state.doc.lineAt(view.posAtDOM(element, 0))
      if (seenLines.has(line.from)) continue
      seenLines.add(line.from)
      const bounds = element.getBoundingClientRect()
      lines.push({
        bounds: {
          bottom: bounds.bottom,
          left: geometry.lane.left,
          right: geometry.lane.right,
          top: bounds.top,
        },
        from: line.from,
        line,
        to: line.to < view.state.doc.length ? line.to + 1 : line.to,
      })
    } catch {
      // The line can detach between DOM enumeration and source mapping.
    }
  }
  lines.sort((left, right) => left.from - right.from)
  return lines
}

function visitMountedSelectionOverlaps<T extends MountedSourceInterval>(
  selections: readonly SelectionRange[],
  intervals: readonly T[],
  visit: (selection: SelectionRange, interval: T) => void
) {
  let firstSelection = 0
  for (const interval of intervals) {
    while (
      firstSelection < selections.length &&
      selections[firstSelection]!.to <= interval.from
    ) {
      firstSelection += 1
    }
    for (
      let index = firstSelection;
      index < selections.length && selections[index]!.from < interval.to;
      index += 1
    ) {
      const selection = selections[index]!
      if (selection.to > interval.from) visit(selection, interval)
    }
  }
}

function mountedRenderedTableSelectionRectangles(
  view: EditorView,
  selections: readonly SelectionRange[],
  rows: readonly MountedTableRow[]
) {
  const rectangles: PhysicalRectangle[] = []
  visitMountedSelectionOverlaps(selections, rows, (selection, row) => {
    try {
      const { element, line } = row
      const lineFrom = Math.max(selection.from, line.from)
      const lineTo = Math.min(selection.to, line.to)
      if (lineFrom < lineTo) {
        const rowRectangles = renderedTableRowRectangles(
          view,
          EditorSelection.range(lineFrom, lineTo),
          element
        )
        if (rowRectangles) rectangles.push(...rowRectangles)
      }
      if (selection.from < row.to && selection.to > line.to) {
        const boundary = renderedTableTrailingBoundaryRectangle(
          view,
          selection,
          { from: line.to, to: row.to },
          element
        )
        if (boundary) rectangles.push(boundary)
      }
    } catch {
      // Viewport redraws can transiently detach a rendered row.
    }
  })
  return mergeRectangles(rectangles)
}

function mountedOrdinarySelectionRectangles(
  view: EditorView,
  selections: readonly SelectionRange[],
  geometry: Pick<SelectionGeometry, "lane">,
  lines: readonly MountedOrdinaryLine[]
) {
  const rectangles: PhysicalRectangle[] = []
  const rowsBySelection = new Map<
    SelectionRange,
    Array<{
      line: Line
      rectangles: PhysicalRectangle[]
    }>
  >()
  visitMountedSelectionOverlaps(selections, lines, (selection, mountedLine) => {
    const { bounds: lineBounds, line } = mountedLine
    try {
      const lineFrom = Math.max(selection.from, line.from)
      const lineTo = Math.min(selection.to, line.to)
      const continuesBefore = line.from > selection.from
      const continuesAfter = line.to < selection.to
      let lineRectangles: PhysicalRectangle[] = []
      if (lineFrom < lineTo) {
        lineRectangles = ordinaryLineSelectionRectangles(
          view,
          EditorSelection.range(lineFrom, lineTo),
          geometry,
          lineBounds,
          continuesBefore,
          continuesAfter
        )
        if (
          lineRectangles.length === 0 &&
          lineFrom === line.from &&
          lineTo === line.to
        ) {
          lineRectangles.push(lineBounds)
        }
      } else if (continuesBefore && continuesAfter) {
        // An empty intermediate source line has no DOM range to measure, but
        // it is still inside the selection and therefore owns the full lane.
        lineRectangles.push(lineBounds)
      } else if (selection.from <= line.to && selection.to > line.to) {
        const lineBreak = ordinaryLineBreakRectangle(
          view,
          line.from,
          line.to,
          geometry,
          lineBounds
        )
        if (lineBreak) lineRectangles.push(lineBreak)
      }
      if (lineRectangles.length > 0) {
        const rows = rowsBySelection.get(selection)
        const row = { line, rectangles: lineRectangles }
        if (rows) rows.push(row)
        else rowsBySelection.set(selection, [row])
      }
    } catch {
      // The line can detach between DOM enumeration and source mapping.
    }
  })

  for (const selection of selections) {
    const rows = rowsBySelection.get(selection)
    if (!rows) continue
    rows.sort((left, right) => left.line.from - right.line.from)
    const visualRows = rows.map((row) => ({
      bands: visualRectangleBands(mergeRectangles(row.rectangles)),
      line: row.line,
    }))
    for (const row of visualRows) {
      for (let index = 1; index < row.bands.length; index += 1) {
        joinVerticalBandGap(row.bands[index - 1]!, row.bands[index]!)
      }
    }
    for (const [index, row] of visualRows.entries()) {
      const nextRow = visualRows[index + 1]
      if (
        !nextRow ||
        nextRow.line.number !== row.line.number + 1 ||
        selection.to <= row.line.to ||
        selection.from >= nextRow.line.from
      ) {
        continue
      }
      const previous = row.bands.at(-1)
      const next = nextRow.bands[0]
      if (previous && next) joinVerticalBandGap(previous, next)
    }
    const selectionRectangles = visualRows.flatMap((row) =>
      row.bands.flatMap((band) => band.rectangles)
    )
    rectangles.push(
      ...mergeVerticallyJoinedRectangles(mergeRectangles(selectionRectangles))
    )
  }
  return rectangles
}

const refreshSelectionGeometry = StateEffect.define<void>()
const selectionScrollRefreshers = new WeakMap<
  EditorView,
  {
    frame: number | null
    handleScroll: (event: Event) => void
    ownerWindow: Window | null
    scrollLeft: number
  }
>()

function selectionMarkers(view: EditorView): readonly LayerMarker[] {
  const selections = view.state.selection.ranges.filter(
    (selection) => !selection.empty
  )
  if (selections.length === 0) return []
  const geometry = selectionGeometry(view)
  const markers: RectangleMarker[] = []
  for (const rectangle of mountedOrdinarySelectionRectangles(
    view,
    selections,
    geometry,
    mountedOrdinaryLines(view, geometry)
  )) {
    const marker = rectangleMarker(rectangle, geometry)
    if (marker) markers.push(marker)
  }
  for (const rectangle of mountedRenderedTableSelectionRectangles(
    view,
    selections,
    mountedTableRows(view)
  )) {
    const marker = rectangleMarker(
      rectangle,
      geometry,
      `${selectionBackgroundClass} cm-app-tableSelectionBackground`
    )
    if (marker) markers.push(marker)
  }
  return markers
}

const deterministicSelectionLayer = layer({
  above: false,
  class: "cm-app-selectionLayer",
  destroy: (_dom, view) => {
    const refresher = selectionScrollRefreshers.get(view)
    if (!refresher) return
    view.contentDOM.removeEventListener("scroll", refresher.handleScroll, true)
    view.scrollDOM.removeEventListener("scroll", refresher.handleScroll)
    if (refresher.frame != null) {
      refresher.ownerWindow?.cancelAnimationFrame(refresher.frame)
    }
    selectionScrollRefreshers.delete(view)
  },
  markers: selectionMarkers,
  mount: (_dom, view) => {
    const ownerWindow = view.dom.ownerDocument.defaultView
    if (!ownerWindow) return
    const refresher = {
      frame: null as number | null,
      handleScroll(event: Event) {
        const target = event.target
        const HTMLElementConstructor = ownerWindow?.HTMLElement
        const outerScrollerMoved = target === view.scrollDOM
        if (outerScrollerMoved) {
          const scrollLeft = view.scrollDOM.scrollLeft
          if (Math.abs(scrollLeft - refresher.scrollLeft) <= edgeTolerance) {
            return
          }
          refresher.scrollLeft = scrollLeft
        }
        if (
          !outerScrollerMoved &&
          (!HTMLElementConstructor ||
            !(target instanceof HTMLElementConstructor) ||
            !target.matches(
              ".cm-md-table-scroll, .cm-md-callout-body, .cm-md-quote-block, .cm-md-yaml-frontmatter"
            ))
        ) {
          return
        }
        if (
          view.state.selection.ranges.every((range) => range.empty) ||
          refresher.frame != null
        ) {
          return
        }
        refresher.frame = ownerWindow.requestAnimationFrame(() => {
          refresher.frame = null
          if (!view.dom.isConnected) return
          view.dispatch({ effects: refreshSelectionGeometry.of() })
        })
      },
      ownerWindow,
      scrollLeft: view.scrollDOM.scrollLeft,
    }
    selectionScrollRefreshers.set(view, refresher)
    view.contentDOM.addEventListener("scroll", refresher.handleScroll, true)
    view.scrollDOM.addEventListener("scroll", refresher.handleScroll)
  },
  update: (update) =>
    update.docChanged ||
    update.selectionSet ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshSelectionGeometry))
    ),
})

function selectedTextDecorations(state: EditorState) {
  return Decoration.set(
    state.selection.ranges.flatMap((range) =>
      range.empty ? [] : [selectedTextMark.range(range.from, range.to)]
    ),
    true
  )
}

const selectedTextExtension = EditorView.decorations.compute(
  ["doc", "selection"],
  selectedTextDecorations
)

export const setSelectionWindowActive = StateEffect.define<boolean>()

const windowActivationField = StateField.define({
  create: () => true,
  update(active, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSelectionWindowActive)) active = effect.value
    }
    return active
  },
  provide: (field) =>
    EditorView.editorAttributes.from(field, (active) => ({
      class: active ? "" : inactiveWindowClass,
    })),
})

/**
 * Keeps selection foreground readable for the app-owned opaque selection fill.
 * Native activation is supplied by Electron, which owns the window lifecycle.
 */
export const selectionAppearanceExtension: Extension = [
  selectedTextExtension,
  windowActivationField,
  deterministicSelectionLayer,
]
