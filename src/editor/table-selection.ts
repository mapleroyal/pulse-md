import { syntaxTree } from "@codemirror/language"
import {
  type ChangeSpec,
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"

const tableRangeSelectionClass = "cm-md-table-range-selection"
const tableCellClass = "cm-md-table-cell"
const tableLineClass = "cm-md-table-line"
const tableDragThreshold = 4

export interface TableCellRangeSelection {
  readonly anchorColumn: number
  readonly anchorRowFrom: number
  readonly headColumn: number
  readonly headRowFrom: number
  readonly tableFrom: number
  readonly tableTo: number
}

export interface TableCellRangeSelectionSnapshot {
  readonly cells: readonly (readonly string[])[]
  readonly columnCount: number
  readonly includesHeader: boolean
  readonly rowCount: number
  readonly text: string
}

interface ParsedTableClipboard {
  readonly cells: readonly (readonly string[])[]
  readonly columnCount: number
}

interface TableCellTarget {
  readonly column: number
  readonly contentFrom: number
  readonly contentTo: number
  readonly cursor: {
    readonly assoc: number
    readonly pos: number
  }
  readonly lastColumn: number
  readonly rowFrom: number
  readonly tableFirstRowFrom: number
  readonly tableFrom: number
  readonly tableLastRowFrom: number
  readonly tableScroller: HTMLElement | null
  readonly tableTo: number
}

interface TableDrag {
  readonly anchor: TableCellTarget
  dragging: boolean
  readonly startX: number
  readonly startY: number
}

interface PendingPointerPosition {
  readonly clientX: number
  readonly clientY: number
}

const tableAutoScrollEdge = 32
const tableAutoScrollMaximum = 24

export interface TableSegment {
  readonly content: SyntaxNode | null
  readonly from: number
  readonly to: number
}

export const setTableCellRangeSelection =
  StateEffect.define<TableCellRangeSelection | null>()

export const tableCellRangeSelectionState =
  StateField.define<TableCellRangeSelection | null>({
    create: () => null,
    update(selection, transaction) {
      let explicitlySet = false
      for (const effect of transaction.effects) {
        if (!effect.is(setTableCellRangeSelection)) continue
        selection = effect.value
        explicitlySet = true
      }

      if (
        transaction.docChanged ||
        (!explicitlySet &&
          !transaction.startState.selection.eq(transaction.state.selection))
      ) {
        return null
      }
      return selection
    },
    provide: (field) =>
      EditorView.editorAttributes.from(field, (selection) => ({
        class: selection ? tableRangeSelectionClass : "",
      })),
  })

function isTableRow(node: SyntaxNode) {
  return node.name === "TableHeader" || node.name === "TableRow"
}

export function tableSegments(row: SyntaxNode): TableSegment[] {
  const delimiters: SyntaxNode[] = []
  const cells: SyntaxNode[] = []
  let child = row.firstChild
  while (child) {
    if (child.name === "TableDelimiter") delimiters.push(child)
    else if (child.name === "TableCell") cells.push(child)
    child = child.nextSibling
  }

  const leadingDelimiter = row.firstChild?.name === "TableDelimiter"
  const trailingDelimiter = row.lastChild?.name === "TableDelimiter"
  const interiorDelimiters = delimiters.filter(
    (_delimiter, index) =>
      !(leadingDelimiter && index === 0) &&
      !(trailingDelimiter && index === delimiters.length - 1)
  )
  const segments: TableSegment[] = []
  let cellIndex = 0
  let from = leadingDelimiter && delimiters[0] ? delimiters[0].to : row.from

  const cellWithin = (segmentFrom: number, segmentTo: number) => {
    while (cells[cellIndex] && cells[cellIndex]!.to <= segmentFrom) {
      cellIndex += 1
    }
    const cell = cells[cellIndex]
    if (!cell || cell.from < segmentFrom || cell.to > segmentTo) return null
    cellIndex += 1
    return cell
  }

  for (const delimiter of interiorDelimiters) {
    segments.push({
      content: cellWithin(from, delimiter.from),
      from,
      to: delimiter.from,
    })
    from = delimiter.to
  }

  const to =
    trailingDelimiter && delimiters.at(-1) ? delimiters.at(-1)!.from : row.to
  segments.push({
    content: cellWithin(from, to),
    from,
    to,
  })
  return segments
}

function syntaxRowForElement(
  view: EditorView,
  element: HTMLElement
): SyntaxNode | null {
  let position: number
  try {
    position = view.posAtDOM(element, 0)
  } catch {
    return null
  }

  const line = view.state.doc.lineAt(position)
  let row: SyntaxNode | null = null
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (!isTableRow(node.node)) return
      row = node.node
      return false
    },
  })
  return row
}

function elementFromTarget(target: EventTarget | null) {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

function targetIsRenderedSelectedTableCell(target: EventTarget | null) {
  return (
    elementFromTarget(target)?.closest(`.${tableCellClass}-selected`) != null
  )
}

function nearestRenderedTableCell(
  view: EditorView,
  clientX: number,
  clientY: number
) {
  let closest: HTMLElement | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (const cell of view.contentDOM.querySelectorAll<HTMLElement>(
    `.${tableCellClass}`
  )) {
    const bounds = cell.getBoundingClientRect()
    const horizontalDistance =
      clientX < bounds.left
        ? bounds.left - clientX
        : clientX > bounds.right
          ? clientX - bounds.right
          : 0
    const verticalDistance =
      clientY < bounds.top
        ? bounds.top - clientY
        : clientY > bounds.bottom
          ? clientY - bounds.bottom
          : 0
    const distance =
      horizontalDistance * horizontalDistance +
      verticalDistance * verticalDistance
    if (distance >= closestDistance) continue
    closest = cell
    closestDistance = distance
  }
  return closest
}

function tableCellTarget(
  view: EditorView,
  target: EventTarget | null,
  clientX: number,
  clientY: number
): TableCellTarget | null {
  const element = elementFromTarget(target)
  const cell = element?.closest<HTMLElement>(`.${tableCellClass}`)
  const rowElement = cell?.closest<HTMLElement>(`.${tableLineClass}`)
  if (!cell || !rowElement || !view.contentDOM.contains(rowElement)) return null

  const row = syntaxRowForElement(view, rowElement)
  const table = row?.parent
  if (!row || table?.name !== "Table") return null

  let firstTableRow = table.firstChild
  while (firstTableRow && !isTableRow(firstTableRow)) {
    firstTableRow = firstTableRow.nextSibling
  }
  let lastTableRow = table.lastChild
  while (lastTableRow && !isTableRow(lastTableRow)) {
    lastTableRow = lastTableRow.prevSibling
  }

  const cells = Array.from(rowElement.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains(tableCellClass)
  )
  const column = cells.indexOf(cell)
  if (column < 0) return null

  const segment = tableSegments(row)[column] ?? {
    content: null,
    from: row.to,
    to: row.to,
  }
  const editableFrom = segment.content?.from ?? segment.from
  const editableTo = segment.content?.to ?? segment.to
  const mappedCursor = view.posAndSideAtCoords(
    { x: clientX, y: clientY },
    false
  )
  const cursorPosition = segment.content
    ? Math.max(editableFrom, Math.min(mappedCursor.pos, editableTo))
    : editableFrom
  return {
    column,
    contentFrom: segment.content?.from ?? segment.from,
    contentTo: segment.content?.to ?? segment.from,
    cursor: {
      assoc:
        cursorPosition === editableFrom
          ? 1
          : cursorPosition === editableTo
            ? -1
            : mappedCursor.assoc,
      pos: cursorPosition,
    },
    lastColumn: cells.length - 1,
    rowFrom: row.from,
    tableFirstRowFrom: firstTableRow?.from ?? row.from,
    tableFrom: table.from,
    tableLastRowFrom: lastTableRow?.from ?? row.from,
    tableScroller: cell.closest<HTMLElement>(".cm-md-table-scroll"),
    tableTo: table.to,
  }
}

function sameCellRange(
  left: TableCellRangeSelection | null,
  right: TableCellRangeSelection
) {
  return (
    left?.anchorColumn === right.anchorColumn &&
    left.anchorRowFrom === right.anchorRowFrom &&
    left.headColumn === right.headColumn &&
    left.headRowFrom === right.headRowFrom &&
    left.tableFrom === right.tableFrom &&
    left.tableTo === right.tableTo
  )
}

function tableCellRangeContainsTarget(
  selection: TableCellRangeSelection,
  target: TableCellTarget
) {
  if (
    selection.tableFrom !== target.tableFrom ||
    selection.tableTo !== target.tableTo
  ) {
    return false
  }
  const firstRowFrom = Math.min(selection.anchorRowFrom, selection.headRowFrom)
  const lastRowFrom = Math.max(selection.anchorRowFrom, selection.headRowFrom)
  const firstColumn = Math.min(selection.anchorColumn, selection.headColumn)
  const lastColumn = Math.max(selection.anchorColumn, selection.headColumn)
  return (
    target.rowFrom >= firstRowFrom &&
    target.rowFrom <= lastRowFrom &&
    target.column >= firstColumn &&
    target.column <= lastColumn
  )
}

export function tableCellRangeSelectionContainsCoordinates(
  view: EditorView,
  clientX: number,
  clientY: number
) {
  const selection = view.state.field(tableCellRangeSelectionState, false)
  if (!selection) return false
  const target = view.dom.ownerDocument.elementFromPoint(clientX, clientY)
  if (targetIsRenderedSelectedTableCell(target)) return true
  const cell = tableCellTarget(view, target, clientX, clientY)
  return cell ? tableCellRangeContainsTarget(selection, cell) : false
}

function tableNodeForSelection(
  state: EditorState,
  selection: TableCellRangeSelection
) {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(
    Math.min(selection.tableFrom + 1, selection.tableTo),
    1
  )
  while (node && node.name !== "Table") node = node.parent
  return node?.from === selection.tableFrom && node.to === selection.tableTo
    ? node
    : null
}

function tableRows(table: SyntaxNode) {
  const rows: SyntaxNode[] = []
  let child = table.firstChild
  while (child) {
    if (isTableRow(child)) rows.push(child)
    child = child.nextSibling
  }
  return rows
}

function tableDelimiter(table: SyntaxNode) {
  let child = table.firstChild
  while (child) {
    if (child.name === "TableDelimiter") return child
    child = child.nextSibling
  }
  return null
}

function selectedTableRows(
  state: EditorState,
  selection: TableCellRangeSelection
) {
  const table = tableNodeForSelection(state, selection)
  if (!table) return []

  const firstRowFrom = Math.min(selection.anchorRowFrom, selection.headRowFrom)
  const lastRowFrom = Math.max(selection.anchorRowFrom, selection.headRowFrom)
  return tableRows(table).filter(
    (row) => row.from >= firstRowFrom && row.from <= lastRowFrom
  )
}

function selectedTableCellSources(
  state: EditorState,
  selection: TableCellRangeSelection
) {
  const firstColumn = Math.min(selection.anchorColumn, selection.headColumn)
  const lastColumn = Math.max(selection.anchorColumn, selection.headColumn)
  return selectedTableRows(state, selection).map((row) => {
    const segments = tableSegments(row)
    return {
      cells: Array.from(
        { length: lastColumn - firstColumn + 1 },
        (_, offset) => {
          const segment = segments[firstColumn + offset]
          return segment?.content
            ? state.sliceDoc(segment.content.from, segment.content.to)
            : ""
        }
      ),
      row,
      segments,
    }
  })
}

function markdownTableRow(cells: readonly string[], columnCount: number) {
  return `| ${Array.from(
    { length: columnCount },
    (_, column) => cells[column] ?? ""
  ).join(" | ")} |`
}

function widestTableRow(cells: readonly (readonly string[])[]) {
  return cells.reduce((width, row) => Math.max(width, row.length), 1)
}

export function markdownTableClipboardText(
  cells: readonly (readonly string[])[]
) {
  const columnCount = widestTableRow(cells)
  const header = markdownTableRow(cells[0] ?? [], columnCount)
  const delimiter = markdownTableRow(
    Array.from({ length: columnCount }, () => "---"),
    columnCount
  )
  return [
    header,
    delimiter,
    ...cells.slice(1).map((row) => markdownTableRow(row, columnCount)),
  ].join("\n")
}

function splitMarkdownTableRow(source: string) {
  const trimmed = source.trim()
  if (!trimmed.includes("|")) return null

  const from = trimmed.startsWith("|") ? 1 : 0
  let to = trimmed.length
  let trailingBackslashes = 0
  for (let index = trimmed.length - 2; index >= 0; index -= 1) {
    if (trimmed[index] !== "\\") break
    trailingBackslashes += 1
  }
  if (trimmed.endsWith("|") && trailingBackslashes % 2 === 0 && to > from) {
    to -= 1
  }

  const cells: string[] = []
  let cellFrom = from
  let backslashes = 0
  for (let index = from; index < to; index += 1) {
    const character = trimmed[index]
    if (character === "\\") {
      backslashes += 1
      continue
    }
    if (character === "|" && backslashes % 2 === 0) {
      cells.push(trimmed.slice(cellFrom, index).trim())
      cellFrom = index + 1
    }
    backslashes = 0
  }
  cells.push(trimmed.slice(cellFrom, to).trim())
  return cells
}

function escapeTabularCell(source: string) {
  return source.trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
}

function normalizedClipboardText(source: string) {
  return source.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "")
}

function isMarkdownTableDelimiter(source: string) {
  return /^:?-+:?$/.test(source)
}

function parseMarkdownTableClipboardText(
  source: string
): ParsedTableClipboard | null {
  const normalized = normalizedClipboardText(source)
  if (!normalized.trim()) return null

  const lines = normalized.split("\n")
  if (lines.length < 2) return null
  const rows = lines.map(splitMarkdownTableRow)
  if (rows.some((row) => row == null)) return null

  const parsedRows = rows as string[][]
  const header = parsedRows[0]!
  const delimiter = parsedRows[1]!
  if (
    header.length === 0 ||
    delimiter.length !== header.length ||
    delimiter.some((cell) => !isMarkdownTableDelimiter(cell))
  ) {
    return null
  }

  const columnCount = header.length
  const cells = [
    header,
    ...parsedRows
      .slice(2)
      .map((row) =>
        Array.from({ length: columnCount }, (_, column) => row[column] ?? "")
      ),
  ]
  return { cells, columnCount }
}

function parseTabSeparatedClipboardText(
  source: string,
  explicit: boolean
): ParsedTableClipboard | null {
  const normalized = normalizedClipboardText(source)
  if (!normalized.trim() || (!explicit && !normalized.includes("\t"))) {
    return null
  }
  const cells = normalized
    .split("\n")
    .map((line) => line.split("\t").map((cell) => escapeTabularCell(cell)))
  return {
    cells,
    columnCount: widestTableRow(cells),
  }
}

export function parseTableClipboardText(
  source: string
): ParsedTableClipboard | null {
  return (
    parseMarkdownTableClipboardText(source) ??
    parseTabSeparatedClipboardText(source, false)
  )
}

export function tableCellRangeSelectionSnapshot(
  state: EditorState
): TableCellRangeSelectionSnapshot | null {
  const selection = state.field(tableCellRangeSelectionState, false)
  if (!selection) return null

  const rows = selectedTableCellSources(state, selection)
  if (rows.length === 0) return null
  const cells = rows.map((row) => row.cells)
  return {
    cells,
    columnCount: cells[0]?.length ?? 0,
    includesHeader: rows.some((row) => row.row.name === "TableHeader"),
    rowCount: cells.length,
    text: markdownTableClipboardText(cells),
  }
}

function selectedTableCellClearChanges(
  state: EditorState,
  selection: TableCellRangeSelection
): ChangeSpec[] {
  const firstColumn = Math.min(selection.anchorColumn, selection.headColumn)
  const lastColumn = Math.max(selection.anchorColumn, selection.headColumn)
  const changes: ChangeSpec[] = []
  for (const { segments } of selectedTableCellSources(state, selection)) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const content = segments[column]?.content
      if (!content) continue
      changes.push({ from: content.from, to: content.to, insert: "" })
    }
  }
  return changes
}

function writeTableCellRangeClipboard(
  view: EditorView,
  event: ClipboardEvent,
  cut: boolean
) {
  const selection = view.state.field(tableCellRangeSelectionState, false)
  const snapshot = tableCellRangeSelectionSnapshot(view.state)
  if (!selection || !snapshot || !event.clipboardData) return false
  if (cut && !view.state.facet(EditorView.editable)) return false

  event.clipboardData.clearData()
  event.clipboardData.setData("text/plain", snapshot.text)
  event.clipboardData.setData("text/markdown", snapshot.text)
  event.preventDefault()

  if (cut) {
    const changes = selectedTableCellClearChanges(view.state, selection)
    view.dispatch({
      changes,
      effects: setTableCellRangeSelection.of(null),
      userEvent: "delete.cut",
    })
  }
  return true
}

interface TablePasteTarget {
  readonly column: number
  readonly row: number
  readonly rows: readonly SyntaxNode[]
  readonly table: SyntaxNode
}

interface SerializedTableRow {
  readonly cellEnds: readonly number[]
  readonly text: string
}

function serializeTableRow(
  cells: readonly string[],
  columnCount: number
): SerializedTableRow {
  let text = "| "
  const cellEnds: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    text += cells[column] ?? ""
    cellEnds.push(text.length)
    text += column === columnCount - 1 ? " |" : " | "
  }
  return { cellEnds, text }
}

function tableNodeAtPosition(
  state: EditorState,
  position: number
): SyntaxNode | null {
  const line = state.doc.lineAt(position)
  let row: SyntaxNode | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (!isTableRow(node.node)) return
      row = node.node
      return false
    },
  })
  return row as SyntaxNode | null
}

function tableColumnAtPosition(
  row: SyntaxNode,
  position: number,
  association: number
) {
  const segments = tableSegments(row)
  const contentMatch = segments.findIndex(
    (segment) =>
      segment.content != null &&
      position >= segment.content.from &&
      position <= segment.content.to
  )
  if (contentMatch >= 0) return contentMatch

  const matches = segments
    .map((segment, column) => ({ column, segment }))
    .filter(({ segment }) => position >= segment.from && position <= segment.to)
  if (matches.length === 0) return null
  return association < 0
    ? matches[0]!.column
    : matches[matches.length - 1]!.column
}

function tablePasteTarget(
  state: EditorState,
  pointerTarget: TableCellTarget | null
): TablePasteTarget | null {
  const rangeSelection = state.field(tableCellRangeSelectionState, false)
  if (rangeSelection) {
    const table = tableNodeForSelection(state, rangeSelection)
    if (!table) return null
    const rows = tableRows(table)
    const rowFrom = Math.min(
      rangeSelection.anchorRowFrom,
      rangeSelection.headRowFrom
    )
    const row = rows.findIndex((candidate) => candidate.from === rowFrom)
    if (row < 0) return null
    return {
      column: Math.min(rangeSelection.anchorColumn, rangeSelection.headColumn),
      row,
      rows,
      table,
    }
  }

  const selection = state.selection.main
  if (
    pointerTarget &&
    selection.head === pointerTarget.cursor.pos &&
    pointerTarget.tableFrom <= selection.head &&
    pointerTarget.tableTo >= selection.head
  ) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(
      Math.min(pointerTarget.tableFrom + 1, pointerTarget.tableTo),
      1
    )
    while (node && node.name !== "Table") node = node.parent
    if (
      node?.from === pointerTarget.tableFrom &&
      node.to === pointerTarget.tableTo
    ) {
      const rows = tableRows(node)
      const row = rows.findIndex(
        (candidate) => candidate.from === pointerTarget.rowFrom
      )
      if (row >= 0) {
        return {
          column: pointerTarget.column,
          row,
          rows,
          table: node,
        }
      }
    }
  }

  const rowNode = tableNodeAtPosition(state, selection.head)
  const table = rowNode?.parent
  if (!rowNode || table?.name !== "Table") return null
  const column = tableColumnAtPosition(rowNode, selection.head, selection.assoc)
  if (column == null) return null
  const rows = tableRows(table)
  const row = rows.findIndex((candidate) => candidate.from === rowNode.from)
  return row < 0 ? null : { column, row, rows, table }
}

function tableSourcePrefix(state: EditorState, node: SyntaxNode) {
  const line = state.doc.lineAt(node.from)
  return state.sliceDoc(line.from, node.from)
}

function tablePasteEdit(
  state: EditorState,
  target: TablePasteTarget,
  clipboard: ParsedTableClipboard
) {
  const delimiter = tableDelimiter(target.table)
  const header = target.rows[0]
  if (!delimiter || !header || clipboard.cells.length === 0) return null

  const cells = target.rows.map((row) =>
    tableSegments(row).map((segment) =>
      segment.content
        ? state.sliceDoc(segment.content.from, segment.content.to)
        : ""
    )
  )
  const headerColumnCount = cells[0]?.length ?? 0
  const finalColumnCount = Math.max(
    1,
    headerColumnCount,
    target.column + clipboard.columnCount
  )
  const finalRowCount = Math.max(
    cells.length,
    target.row + clipboard.cells.length
  )

  while (cells.length < finalRowCount) cells.push([])
  for (let row = 0; row < clipboard.cells.length; row += 1) {
    const destination = cells[target.row + row]!
    const source = clipboard.cells[row]!
    for (let column = 0; column < clipboard.columnCount; column += 1) {
      destination[target.column + column] = source[column] ?? ""
    }
  }

  const delimiterCells =
    splitMarkdownTableRow(state.sliceDoc(delimiter.from, delimiter.to)) ?? []
  const normalizedDelimiter = Array.from(
    { length: finalColumnCount },
    (_, column) => {
      const source = delimiterCells[column]?.trim() ?? ""
      return isMarkdownTableDelimiter(source) ? source : "---"
    }
  )
  const serializedRows = cells.map((row) =>
    serializeTableRow(row, Math.max(finalColumnCount, row.length))
  )
  const serializedDelimiter = serializeTableRow(
    normalizedDelimiter,
    finalColumnCount
  )
  const rowStarts = [0]
  let insert = serializedRows[0]!.text
  const delimiterPrefix = tableSourcePrefix(state, delimiter)
  insert += `\n${delimiterPrefix}${serializedDelimiter.text}`
  const rowPrefixes = target.rows.map((row) => tableSourcePrefix(state, row))
  const continuationPrefix =
    rowPrefixes.length > 1
      ? rowPrefixes.at(-1)!
      : delimiterPrefix || rowPrefixes[0] || ""
  for (let row = 1; row < serializedRows.length; row += 1) {
    const prefix = rowPrefixes[row] ?? continuationPrefix
    insert += `\n${prefix}`
    rowStarts[row] = insert.length
    insert += serializedRows[row]!.text
  }

  const lastRow = target.row + clipboard.cells.length - 1
  const lastColumn = target.column + clipboard.columnCount - 1
  const sourceLastCell = clipboard.cells.at(-1)?.[lastColumn - target.column]
  const cursor =
    target.table.from +
    (rowStarts[lastRow] ?? 0) +
    (serializedRows[lastRow]?.cellEnds[lastColumn] ?? 0)

  return {
    changes: {
      from: target.table.from,
      to: target.table.to,
      insert,
    },
    // Transaction specs preserve a range's boundary association only when
    // supplied as a complete EditorSelection, not as a SelectionRange-shaped
    // selection spec.
    selection: EditorSelection.create([
      EditorSelection.cursor(cursor, sourceLastCell ? -1 : 1),
    ]),
  }
}

function pasteTableCellRange(
  view: EditorView,
  event: ClipboardEvent,
  pointerTarget: TableCellTarget | null
) {
  if (!view.state.facet(EditorView.editable)) return false
  const data = event.clipboardData
  if (!data) return false
  const clipboard =
    parseMarkdownTableClipboardText(data.getData("text/markdown")) ??
    parseTabSeparatedClipboardText(
      data.getData("text/tab-separated-values"),
      data.types.includes("text/tab-separated-values")
    ) ??
    parseTableClipboardText(data.getData("text/plain"))
  if (!clipboard) return false
  const target = tablePasteTarget(view.state, pointerTarget)
  if (!target) return false
  const edit = tablePasteEdit(view.state, target, clipboard)
  if (!edit) return false

  event.preventDefault()
  view.dispatch({
    ...edit,
    effects: setTableCellRangeSelection.of(null),
    scrollIntoView: true,
    userEvent: "input.paste",
  })
  return true
}

async function writeClipboardText(view: EditorView, text: string) {
  const ownerWindow = view.dom.ownerDocument.defaultView
  if (ownerWindow?.navigator.clipboard?.writeText) {
    await ownerWindow.navigator.clipboard.writeText(text)
    return
  }

  const ownerDocument = view.dom.ownerDocument
  const textarea = ownerDocument.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  ownerDocument.body.append(textarea)
  textarea.select()
  const copied = ownerDocument.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("Clipboard copy was rejected")
}

export async function runTableCellRangeClipboardCommand(
  view: EditorView,
  command: "copy" | "cut"
) {
  const sourceDocument = view.state.doc
  const selection = view.state.field(tableCellRangeSelectionState, false)
  const snapshot = tableCellRangeSelectionSnapshot(view.state)
  if (!selection || !snapshot) return false
  if (command === "cut" && !view.state.facet(EditorView.editable)) return false

  await writeClipboardText(view, snapshot.text)
  if (command === "cut") {
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) {
      view.focus()
      return false
    }
    if (view.state.doc !== sourceDocument) {
      view.focus()
      return false
    }
    const currentSelection = view.state.field(
      tableCellRangeSelectionState,
      false
    )
    if (!currentSelection || !sameCellRange(currentSelection, selection)) {
      view.focus()
      return false
    }
    view.dispatch({
      changes: selectedTableCellClearChanges(view.state, currentSelection),
      effects: setTableCellRangeSelection.of(null),
      userEvent: "delete.cut",
    })
  }
  view.focus()
  return true
}

class TableCellRangeSelectionPlugin {
  private activeCell: TableCellTarget | null = null
  private drag: TableDrag | null = null
  private moveFrame: number | null = null
  private pendingPointer: PendingPointerPosition | null = null
  private readonly ownerDocument: Document
  private readonly ownerWindow: Window | null
  private readonly view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.ownerDocument = view.dom.ownerDocument
    this.ownerWindow = this.ownerDocument.defaultView
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      this.activeCell = null
      this.finishDrag()
    }
  }

  destroy() {
    this.finishDrag()
  }

  copy(event: ClipboardEvent) {
    return writeTableCellRangeClipboard(this.view, event, false)
  }

  cut(event: ClipboardEvent) {
    return writeTableCellRangeClipboard(this.view, event, true)
  }

  paste(event: ClipboardEvent) {
    return pasteTableCellRange(this.view, event, this.activeCell)
  }

  mousedown(event: MouseEvent) {
    const secondaryClick =
      event.button === 2 ||
      (event.button === 0 &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey)
    if (secondaryClick) {
      const selection = this.view.state.field(
        tableCellRangeSelectionState,
        false
      )
      const target = selection
        ? tableCellTarget(this.view, event.target, event.clientX, event.clientY)
        : null
      const selectedCell =
        selection != null &&
        (targetIsRenderedSelectedTableCell(event.target) ||
          (target != null && tableCellRangeContainsTarget(selection, target)))
      if (!selectedCell) this.clearSelection()
      else event.preventDefault()
      return selectedCell
    }

    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      this.activeCell = null
      this.clearSelection()
      return false
    }

    const anchor = tableCellTarget(
      this.view,
      event.target,
      event.clientX,
      event.clientY
    )
    if (!anchor) {
      this.activeCell = null
      this.clearSelection()
      return false
    }

    if (event.detail >= 2) {
      this.finishDrag()
      this.activeCell = anchor
      this.clearSelection()

      const word =
        event.detail === 2 ? this.view.state.wordAt(anchor.cursor.pos) : null
      const selection =
        word && word.from >= anchor.contentFrom && word.to <= anchor.contentTo
          ? word
          : EditorSelection.range(anchor.contentFrom, anchor.contentTo)
      this.view.dispatch({
        selection,
        effects: setTableCellRangeSelection.of(null),
        userEvent: "select.pointer",
      })
      this.view.focus()
      event.preventDefault()
      return true
    }

    this.finishDrag()
    this.activeCell = anchor
    this.drag = {
      anchor,
      dragging: false,
      startX: event.clientX,
      startY: event.clientY,
    }
    this.ownerDocument.addEventListener("mousemove", this.handleMouseMove, true)
    this.ownerDocument.addEventListener("mouseup", this.handleMouseUp, true)
    this.ownerWindow?.addEventListener("blur", this.handleWindowBlur)

    this.view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(anchor.cursor.pos, anchor.cursor.assoc),
      ]),
      effects: setTableCellRangeSelection.of(null),
      userEvent: "select.pointer",
    })
    this.view.focus()
    event.preventDefault()
    return true
  }

  private clearSelection() {
    if (!this.view.state.field(tableCellRangeSelectionState, false)) return
    this.view.dispatch({ effects: setTableCellRangeSelection.of(null) })
  }

  private readonly handleMouseMove = (event: MouseEvent) => {
    if (!this.drag) return
    if ((event.buttons & 1) === 0) {
      this.finishDrag()
      return
    }
    this.pendingPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
    }
    this.schedulePointerFlush()
  }

  private schedulePointerFlush() {
    if (this.moveFrame !== null) return
    if (!this.ownerWindow) {
      this.flushPointer()
      return
    }
    const update = () => {
      this.moveFrame = null
      if (this.flushPointer()) this.schedulePointerFlush()
    }
    this.moveFrame = this.ownerWindow.requestAnimationFrame(update)
  }

  private readonly handleMouseUp = (event: MouseEvent) => {
    this.pendingPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
    }
    this.flushPointer()
    this.finishDrag()
  }

  private readonly handleWindowBlur = () => {
    this.finishDrag()
  }

  private flushPointer() {
    const drag = this.drag
    const pointer = this.pendingPointer
    if (!drag || !pointer) return false

    if (!drag.dragging) {
      const horizontalDistance = pointer.clientX - drag.startX
      const verticalDistance = pointer.clientY - drag.startY
      if (
        horizontalDistance * horizontalDistance +
          verticalDistance * verticalDistance <
        tableDragThreshold * tableDragThreshold
      ) {
        return false
      }
      drag.dragging = true
    }

    const scrollBounds = this.view.scrollDOM.getBoundingClientRect()
    const lookupX = Math.max(
      scrollBounds.left + 1,
      Math.min(
        pointer.clientX,
        scrollBounds.left + this.view.scrollDOM.clientWidth - 1
      )
    )
    const lookupY = Math.max(
      scrollBounds.top + 1,
      Math.min(
        pointer.clientY,
        scrollBounds.top + this.view.scrollDOM.clientHeight - 1
      )
    )
    const target = this.ownerDocument.elementFromPoint(lookupX, lookupY)
    let head = tableCellTarget(this.view, target, lookupX, lookupY)
    if (!head) {
      head = tableCellTarget(
        this.view,
        nearestRenderedTableCell(this.view, lookupX, lookupY),
        lookupX,
        lookupY
      )
    }
    if (
      !head ||
      head.tableFrom !== drag.anchor.tableFrom ||
      head.tableTo !== drag.anchor.tableTo
    ) {
      return false
    }

    const selection: TableCellRangeSelection = {
      anchorColumn: drag.anchor.column,
      anchorRowFrom: drag.anchor.rowFrom,
      headColumn: head.column,
      headRowFrom: head.rowFrom,
      tableFrom: head.tableFrom,
      tableTo: head.tableTo,
    }
    if (
      !sameCellRange(
        this.view.state.field(tableCellRangeSelectionState, false) ?? null,
        selection
      )
    ) {
      this.view.dispatch({
        effects: setTableCellRangeSelection.of(selection),
      })
    }

    return this.autoScroll(pointer, scrollBounds, head)
  }

  private autoScroll(
    pointer: PendingPointerPosition,
    bounds: DOMRect,
    head: TableCellTarget
  ): boolean {
    const scrollDelta = (position: number, start: number, end: number) => {
      if (position < start + tableAutoScrollEdge) {
        return -Math.min(
          tableAutoScrollMaximum,
          Math.max(1, Math.ceil((start + tableAutoScrollEdge - position) / 2))
        )
      }
      if (position > end - tableAutoScrollEdge) {
        return Math.min(
          tableAutoScrollMaximum,
          Math.max(1, Math.ceil((position - (end - tableAutoScrollEdge)) / 2))
        )
      }
      return 0
    }
    const verticalScroller = this.view.scrollDOM
    const horizontalScroller = head.tableScroller ?? verticalScroller
    const horizontalBounds = horizontalScroller.getBoundingClientRect()
    const beforeLeft = horizontalScroller.scrollLeft
    const beforeTop = verticalScroller.scrollTop
    const horizontalDelta = scrollDelta(
      pointer.clientX,
      horizontalBounds.left,
      horizontalBounds.left + horizontalScroller.clientWidth
    )
    const verticalDelta = scrollDelta(
      pointer.clientY,
      bounds.top,
      bounds.top + verticalScroller.clientHeight
    )
    if (
      (horizontalDelta < 0 && head.column > 0) ||
      (horizontalDelta > 0 && head.column < head.lastColumn)
    ) {
      horizontalScroller.scrollLeft += horizontalDelta
    }
    if (
      (verticalDelta < 0 && head.rowFrom > head.tableFirstRowFrom) ||
      (verticalDelta > 0 && head.rowFrom < head.tableLastRowFrom)
    ) {
      verticalScroller.scrollTop += verticalDelta
    }
    return (
      horizontalScroller.scrollLeft !== beforeLeft ||
      verticalScroller.scrollTop !== beforeTop
    )
  }

  private finishDrag() {
    this.ownerDocument.removeEventListener(
      "mousemove",
      this.handleMouseMove,
      true
    )
    this.ownerDocument.removeEventListener("mouseup", this.handleMouseUp, true)
    this.ownerWindow?.removeEventListener("blur", this.handleWindowBlur)
    if (this.moveFrame !== null) {
      this.ownerWindow?.cancelAnimationFrame(this.moveFrame)
      this.moveFrame = null
    }
    this.pendingPointer = null
    this.drag = null
  }
}

const tableCellRangeSelectionPlugin = ViewPlugin.fromClass(
  TableCellRangeSelectionPlugin,
  {
    eventHandlers: {
      copy(event) {
        return this.copy(event)
      },
      cut(event) {
        return this.cut(event)
      },
      paste(event) {
        return this.paste(event)
      },
      mousedown(event) {
        return this.mousedown(event)
      },
    },
  }
)

function tableCellRangeSelectionActive(state: EditorState) {
  return state.field(tableCellRangeSelectionState, false) != null
}

function clearTableCellRangeSelection(view: EditorView) {
  if (!tableCellRangeSelectionActive(view.state)) return false
  view.dispatch({ effects: setTableCellRangeSelection.of(null) })
  return true
}

export const tableCellRangeSelectionExtension: Extension = [
  tableCellRangeSelectionState,
  Prec.highest(
    keymap.of([{ key: "Escape", run: clearTableCellRangeSelection }])
  ),
  tableCellRangeSelectionPlugin,
]
