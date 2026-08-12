import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const tableDemoFixturePath = path.join(
  projectRoot,
  "tests/e2e/fixtures/table-demo.md"
)

const wideTableLines = [
  "| Phase | Items in phase | Cumulative item | Rate / hour | Seconds per item | Phase duration | Cumulative time | Cumulative units |",
  "| ----: | -------------: | --------------: | ----------: | ---------------: | -------------: | --------------: | ---------------: |",
  "|     1 |              7 |               7 |         8.0 |            9.000 |       63.000 s |            1:03 |        140 units |",
  "|     2 |              8 |              15 |         9.0 |            8.000 |       64.000 s |            2:07 |        300 units |",
  "|     3 |              8 |              23 |         9.5 |            7.579 |       60.632 s |            3:08 |        460 units |",
  "|     4 |              9 |              32 |        10.0 |            7.200 |       64.800 s |            4:12 |        640 units |",
  "|     5 |              9 |              41 |        10.5 |            6.857 |       61.714 s |            5:14 |        820 units |",
  "|     6 |              9 |              50 |        11.0 |            6.545 |       58.909 s |            6:13 |      1,000 units |",
  "|     7 |             10 |              60 |        11.5 |            6.261 |       62.609 s |            7:16 |      1,200 units |",
  "|     8 |             10 |              70 |        12.0 |            6.000 |       60.000 s |            8:16 |      1,400 units |",
  "|     9 |             11 |              81 |        12.5 |            5.760 |       63.360 s |            9:19 |      1,620 units |",
  "|    10 |             11 |              92 |        13.0 |            5.538 |       60.923 s |           10:20 |      1,840 units |",
  "|    11 |             12 |             104 |        13.5 |            5.333 |       64.000 s |           11:24 |      2,080 units |",
  "|    12 |             12 |             116 |        14.0 |            5.143 |       61.714 s |           12:26 |      2,320 units |",
  "|    13 |             13 |             129 |        14.5 |            4.966 |       64.552 s |           13:30 |      2,580 units |",
  "|    14 |             13 |             142 |        15.0 |            4.800 |       62.400 s |           14:33 |      2,840 units |",
  "|    15 |             13 |             155 |        15.5 |            4.645 |       60.387 s |           15:33 |      3,100 units |",
] as const

interface BrowserEditorView {
  contentDOM: HTMLElement
  coordsAtPos(
    position: number,
    side?: -1 | 1
  ): { bottom: number; left: number; right: number; top: number } | null
  dispatch(spec: { scrollIntoView?: boolean; selection: unknown }): void
  defaultLineHeight: number
  focus(): void
  hasFocus: boolean
  posAtCoords(coordinates: { x: number; y: number }): number | null
  posAtDOM(node: Node, offset?: number): number
  scrollDOM: HTMLElement
  state: {
    doc: {
      line(number: number): { from: number; to: number }
      lineAt(position: number): {
        from: number
        number: number
        to: number
      }
      sliceString(from: number, to: number): string
      toString(): string
    }
    selection: {
      constructor: {
        create(ranges: readonly unknown[], mainIndex?: number): unknown
        cursor(position: number, assoc?: -1 | 0 | 1): unknown
      }
      main: {
        anchor: number
        assoc: -1 | 0 | 1
        from: number
        head: number
        to: number
      }
      ranges: readonly {
        head: number
      }[]
    }
  }
}

async function settleGeometry(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function textBoundary(
  element: ReturnType<Page["locator"]>,
  offset: number
) {
  return element.evaluate((cell, requestedOffset) => {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    let remaining = requestedOffset
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        const range = document.createRange()
        const localOffset = Math.min(remaining, length)
        range.setStart(node, localOffset)
        range.setEnd(node, localOffset)
        const bounds = range.getBoundingClientRect()
        const cellBounds = cell.getBoundingClientRect()
        return {
          x: bounds.left,
          y:
            bounds.height > 0
              ? bounds.top + bounds.height / 2
              : cellBounds.top + cellBounds.height / 2,
        }
      }
      remaining -= length
      node = walker.nextNode()
    }
    throw new Error(`Text offset ${requestedOffset} is outside the table cell`)
  }, offset)
}

async function placeCaret(page: Page, lineNumber: number) {
  await page.evaluate((targetLine) => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("The editor view is unavailable")
    const line = view.state.doc.line(targetLine)
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    })
    view.focus()
  }, lineNumber)
  await settleGeometry(page)
}

async function placeCaretAtLineEnd(page: Page, lineNumber: number) {
  const anchor = await page.evaluate((targetLine) => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("The editor view is unavailable")
    const line = view.state.doc.line(targetLine)
    const selection = view.state.selection.constructor
    view.dispatch({
      selection: selection.create([selection.cursor(line.to, -1)]),
      scrollIntoView: true,
    })
    view.focus()
    return line.to
  }, lineNumber)
  await settleGeometry(page)
  return anchor
}

async function placeCaretAtColumn(
  page: Page,
  lineNumber: number,
  column: number,
  assoc: -1 | 1
) {
  await page.evaluate(
    ({ targetAssoc, targetColumn, targetLine }) => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(targetLine)
      const selection = view.state.selection.constructor
      view.dispatch({
        selection: selection.create([
          selection.cursor(line.from + targetColumn, targetAssoc),
        ]),
        scrollIntoView: true,
      })
      view.focus()
    },
    { targetAssoc: assoc, targetColumn: column, targetLine: lineNumber }
  )
  await settleGeometry(page)
}

async function tableGeometry(page: Page) {
  return page.evaluate(() => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    const table = document.querySelector<HTMLElement>(".cm-md-table-scroll")
    if (!view || !table) throw new Error("The rendered table is unavailable")

    const selection = view.state.selection.main
    const line = view.state.doc.lineAt(selection.head)
    const side = selection.assoc === 0 ? undefined : selection.assoc
    const coordinates = view.coordsAtPos(selection.head, side)
    const tableBounds = table.getBoundingClientRect()
    const viewportBounds = view.scrollDOM.getBoundingClientRect()

    return {
      anchorLine: view.state.doc.lineAt(selection.anchor).number,
      caretHeight: coordinates ? coordinates.bottom - coordinates.top : 0,
      caretInsideTable:
        coordinates != null &&
        coordinates.left >= tableBounds.left - 0.5 &&
        coordinates.right <= tableBounds.right + 0.5 &&
        coordinates.bottom >= tableBounds.top &&
        coordinates.top <= tableBounds.bottom,
      caretInsideViewport:
        coordinates != null &&
        coordinates.left >= viewportBounds.left &&
        coordinates.right <= viewportBounds.right &&
        coordinates.bottom >= viewportBounds.top &&
        coordinates.top <= viewportBounds.bottom,
      column: selection.head - line.from,
      headLine: line.number,
      rowHeights: [
        ...table.querySelectorAll<HTMLElement>(".cm-md-table-line"),
      ].map(
        (row) => Math.round(row.getBoundingClientRect().height * 100) / 100
      ),
      scrollTop: view.scrollDOM.scrollTop,
      tableClientWidth: table.clientWidth,
      tableScrollLeft: table.scrollLeft,
      tableScrollWidth: table.scrollWidth,
    }
  })
}

async function tableNavigationState(page: Page) {
  return page.evaluate(() => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    const table = document.querySelector<HTMLElement>(".cm-md-table-scroll")
    if (!view || !table) throw new Error("The rendered table is unavailable")

    const range = view.state.selection.main
    const line = view.state.doc.lineAt(range.head)
    const coordinates = view.coordsAtPos(
      range.head,
      range.assoc === 0 ? undefined : range.assoc
    )
    return {
      anchor: range.anchor,
      anchorLine: view.state.doc.lineAt(range.anchor).number,
      assoc: range.assoc,
      column: range.head - line.from,
      coordinatesValid:
        coordinates != null &&
        coordinates.bottom > coordinates.top &&
        !(
          coordinates.left === 0 &&
          coordinates.right === 0 &&
          coordinates.top === 0 &&
          coordinates.bottom === 0
        ),
      head: range.head,
      headLine: line.number,
      lineFrom: line.from,
      lineHeight: view.defaultLineHeight,
      rowHeights: Array.from(
        table.querySelectorAll<HTMLElement>(".cm-md-table-line"),
        (row) => row.getBoundingClientRect().height
      ),
      scrollTop: view.scrollDOM.scrollTop,
      sourceLine: view.state.doc.sliceString(line.from, line.to),
      tableHeight: table.getBoundingClientRect().height,
    }
  })
}

async function selectionAppearanceState(page: Page) {
  return page.evaluate(() => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("The editor view is unavailable")

    const range = view.state.selection.main
    const markerBounds = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-app-selectionBackground"),
      (marker) => {
        const bounds = marker.getBoundingClientRect()
        return {
          bottom: bounds.bottom,
          className: marker.className,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
        }
      }
    )
    const table = document.querySelector<HTMLElement>(".cm-md-table-scroll")
    const rows = table
      ? Array.from(table.querySelectorAll<HTMLElement>(".cm-md-table-line"))
      : []
    const rowBounds = rows.map((row) => {
      const bounds = row.getBoundingClientRect()
      return {
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      }
    })
    const rowHeights = rowBounds.map((bounds) => bounds.height)
    const rowLines = rows.map(
      (row) => view.state.doc.lineAt(view.posAtDOM(row, 0)).number
    )
    const tableBounds = table?.getBoundingClientRect()
    const tableMarkers =
      tableBounds == null
        ? []
        : markerBounds.filter(
            (marker) =>
              marker.right > tableBounds.left &&
              marker.left < tableBounds.right &&
              marker.bottom > tableBounds.top &&
              marker.top < tableBounds.bottom
          )
    const tableCellMarkers = tableMarkers.filter((marker) =>
      marker.className.includes("cm-app-tableSelectionBackground")
    )
    const ordinaryMarkers = markerBounds.filter(
      (marker) => !marker.className.includes("cm-app-tableSelectionBackground")
    )
    const mountedOrdinaryLines = Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")
    ).flatMap((element) => {
      if (
        element.closest(".cm-md-table-scroll") ||
        element.querySelector(".cm-md-table-scroll")
      ) {
        return []
      }
      try {
        const line = view.state.doc.lineAt(view.posAtDOM(element, 0))
        const bounds = element.getBoundingClientRect()
        return [
          {
            bounds: {
              bottom: bounds.bottom,
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
            },
            line: line.number,
          },
        ]
      } catch {
        return []
      }
    })
    const contentBounds = view.contentDOM.getBoundingClientRect()
    const contentStyle = getComputedStyle(view.contentDOM)
    const lane = {
      left:
        contentBounds.left + (Number.parseFloat(contentStyle.paddingLeft) || 0),
      right:
        contentBounds.right -
        (Number.parseFloat(contentStyle.paddingRight) || 0),
    }
    const continuationMarkerBounds = (sourceLine: number | undefined) => {
      if (sourceLine == null) return null
      const lineBounds = mountedOrdinaryLines.find(
        (line) => line.line === sourceLine
      )?.bounds
      if (!lineBounds) return null
      const candidates = ordinaryMarkers.filter(
        (marker) =>
          marker.bottom > lineBounds.top && marker.top < lineBounds.bottom
      )
      if (candidates.length === 0) return null
      return {
        left: Math.min(...candidates.map((marker) => marker.left)),
        right: Math.max(...candidates.map((marker) => marker.right)),
      }
    }
    const firstRowLine =
      rowLines.length === 0 ? undefined : Math.min(...rowLines)
    const lastRowLine =
      rowLines.length === 0 ? undefined : Math.max(...rowLines)
    const beforeContinuation = continuationMarkerBounds(
      firstRowLine == null ? undefined : firstRowLine - 1
    )
    const afterContinuation = continuationMarkerBounds(
      lastRowLine == null ? undefined : lastRowLine + 1
    )
    return {
      anchor: range.anchor,
      anchorLine: view.state.doc.lineAt(range.anchor).number,
      head: range.head,
      headLine: view.state.doc.lineAt(range.head).number,
      markerBounds,
      markerHeights: markerBounds.map((bounds) => bounds.height),
      hasTableWrapperMarker:
        tableBounds != null &&
        markerBounds.some((marker) => {
          const horizontalOverlap =
            Math.max(
              0,
              Math.min(marker.right, tableBounds.right) -
                Math.max(marker.left, tableBounds.left)
            ) / tableBounds.width
          const verticalOverlap =
            Math.max(
              0,
              Math.min(marker.bottom, tableBounds.bottom) -
                Math.max(marker.top, tableBounds.top)
            ) / tableBounds.height
          return horizontalOverlap >= 0.9 && verticalOverlap >= 0.75
        }),
      table: table
        ? {
            afterContinuation,
            beforeContinuation,
            clientWidth: table.clientWidth,
            bounds: {
              bottom: tableBounds!.bottom,
              left: tableBounds!.left,
              right: tableBounds!.right,
              top: tableBounds!.top,
            },
            height: tableBounds!.height,
            lane,
            markerHeights: tableMarkers.map((marker) => marker.height),
            markerBounds: tableMarkers,
            maximumRowHeight:
              rowHeights.length === 0 ? 0 : Math.max(...rowHeights),
            rowBounds,
            rowCellCounts: rows.map(
              (row) => row.querySelectorAll(".cm-md-table-cell").length
            ),
            rowHeights,
            rowLines,
            selectedEdgeCoverage: rows.map((row) => {
              const cells =
                row.querySelectorAll<HTMLElement>(".cm-md-table-cell")
              const edges = [cells[0], cells[cells.length - 1]]
              return edges.map((cell) => {
                if (!cell) return false
                const bounds = cell.getBoundingClientRect()
                return tableCellMarkers.some(
                  (marker) =>
                    marker.right > bounds.left &&
                    marker.left < bounds.right &&
                    marker.bottom > bounds.top &&
                    marker.top < bounds.bottom
                )
              })
            }),
            selectedVisibleCellCoverage: rows.map((row) => {
              const cells = Array.from(
                row.querySelectorAll<HTMLElement>(".cm-md-table-cell")
              )
              return cells.map((cell) => {
                const bounds = cell.getBoundingClientRect()
                const visible = {
                  bottom: Math.min(bounds.bottom, tableBounds!.bottom),
                  left: Math.max(bounds.left, tableBounds!.left),
                  right: Math.min(bounds.right, tableBounds!.right),
                  top: Math.max(bounds.top, tableBounds!.top),
                }
                if (
                  visible.right - visible.left <= 1 ||
                  visible.bottom - visible.top <= 1
                ) {
                  return null
                }
                let paintedWidth = 0
                const intervals = tableCellMarkers
                  .filter(
                    (marker) =>
                      marker.bottom > visible.top &&
                      marker.top < visible.bottom &&
                      marker.right > visible.left &&
                      marker.left < visible.right
                  )
                  .map((marker) => ({
                    from: Math.max(marker.left, visible.left),
                    to: Math.min(marker.right, visible.right),
                  }))
                  .sort((left, right) => left.from - right.from)
                let intervalTo = Number.NEGATIVE_INFINITY
                for (const interval of intervals) {
                  if (interval.to <= intervalTo) continue
                  paintedWidth +=
                    interval.to - Math.max(interval.from, intervalTo)
                  intervalTo = interval.to
                }
                return paintedWidth >= Math.min(2, visible.right - visible.left)
              })
            }),
            scrollLeft: table.scrollLeft,
            scrollWidth: table.scrollWidth,
          }
        : null,
    }
  })
}

async function tableCellSelectionPaint(
  page: Page,
  requestedCellIndex?: number
) {
  return page.evaluate((cellIndex) => {
    const table = document.querySelector<HTMLElement>(".cm-md-table-scroll")
    const row = table?.querySelector<HTMLElement>(".cm-md-table-line")
    if (!table || !row) throw new Error("The rendered table is unavailable")
    const cells = Array.from(
      row.querySelectorAll<HTMLElement>(".cm-md-table-cell")
    )
    const tableBounds = table.getBoundingClientRect()
    const candidates = cells
      .map((cell, index) => {
        const bounds = cell.getBoundingClientRect()
        const visibleWidth =
          Math.min(bounds.right, tableBounds.right) -
          Math.max(bounds.left, tableBounds.left)
        return { bounds, cell, index, visibleWidth }
      })
      .filter(
        ({ index, visibleWidth }) =>
          index > 0 && index < cells.length - 1 && visibleWidth > 24
      )
      .sort((left, right) => right.visibleWidth - left.visibleWidth)
    const candidate =
      cellIndex == null
        ? candidates[0]
        : candidates.find(({ index }) => index === cellIndex)
    if (!candidate) {
      throw new Error(
        `Cell ${cellIndex ?? "interior"} is not visibly trackable`
      )
    }
    const markers = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".cm-app-tableSelectionBackground"
      ),
      (marker) => marker.getBoundingClientRect()
    ).filter(
      (marker) =>
        marker.right > candidate.bounds.left &&
        marker.left < candidate.bounds.right &&
        marker.bottom > candidate.bounds.top &&
        marker.top < candidate.bounds.bottom
    )
    if (markers.length === 0) {
      throw new Error(`Cell ${candidate.index} has no selection marker`)
    }
    return {
      cellIndex: candidate.index,
      cellLeft: candidate.bounds.left,
      cellRight: candidate.bounds.right,
      paintLeft: Math.min(...markers.map((marker) => marker.left)),
      paintRight: Math.max(...markers.map((marker) => marker.right)),
      scrollLeft: table.scrollLeft,
    }
  }, requestedCellIndex)
}

async function beginSelectionPositionLookupCount(page: Page) {
  await page.evaluate(() => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("The editor view is unavailable")
    const instrumented = view as BrowserEditorView & {
      selectionOriginalPosAtDOM?: BrowserEditorView["posAtDOM"]
      selectionPosAtDOMCalls?: number
    }
    if (instrumented.selectionOriginalPosAtDOM) return
    const original = view.posAtDOM
    instrumented.selectionOriginalPosAtDOM = original
    instrumented.selectionPosAtDOMCalls = 0
    view.posAtDOM = (node, offset) => {
      instrumented.selectionPosAtDOMCalls =
        (instrumented.selectionPosAtDOMCalls ?? 0) + 1
      return original.call(view, node, offset)
    }
  })
}

async function finishSelectionPositionLookupCount(page: Page) {
  return page.evaluate(() => {
    const view = (
      document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: { view?: BrowserEditorView }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("The editor view is unavailable")
    const instrumented = view as BrowserEditorView & {
      selectionOriginalPosAtDOM?: BrowserEditorView["posAtDOM"]
      selectionPosAtDOMCalls?: number
    }
    const original = instrumented.selectionOriginalPosAtDOM
    const calls = instrumented.selectionPosAtDOMCalls ?? 0
    if (original) view.posAtDOM = original
    delete instrumented.selectionOriginalPosAtDOM
    delete instrumented.selectionPosAtDOMCalls
    return {
      calls,
      lineCount: document.querySelectorAll(".cm-line").length,
    }
  })
}

type SelectionAppearanceSnapshot = Awaited<
  ReturnType<typeof selectionAppearanceState>
>

function expectTableMarkerGeometry(selection: SelectionAppearanceSnapshot) {
  expect(selection.table).not.toBeNull()
  if (!selection.table) return
  const diagnostic = JSON.stringify({
    headLine: selection.headLine,
    markerBounds: selection.table.markerBounds,
    rowHeights: selection.table.rowHeights,
    rowLines: selection.table.rowLines,
    tableBounds: selection.table.bounds,
  })
  expect(selection.table.markerHeights.length, diagnostic).toBeGreaterThan(0)
  expect(
    Math.max(...selection.table.markerHeights),
    diagnostic
  ).toBeLessThanOrEqual(selection.table.maximumRowHeight + 1)
  for (const marker of selection.table.markerBounds) {
    if (!marker.className.includes("cm-app-tableSelectionBackground")) continue
    expect(marker.top, diagnostic).toBeGreaterThanOrEqual(
      selection.table.bounds.top - 1
    )
    expect(marker.bottom, diagnostic).toBeLessThanOrEqual(
      selection.table.bounds.bottom + 1
    )
  }
}

function expectVisibleTableCellsSelected(
  table: NonNullable<SelectionAppearanceSnapshot["table"]>
) {
  const visibleCoverage = table.selectedVisibleCellCoverage.flatMap((row) =>
    row.filter((covered) => covered != null)
  )
  expect(visibleCoverage.length).toBeGreaterThan(0)
  expect(visibleCoverage.every(Boolean)).toBe(true)
  const interiorCoverage = table.selectedVisibleCellCoverage.flatMap((row) =>
    row.slice(1, -1).filter((covered) => covered != null)
  )
  expect(interiorCoverage.length).toBeGreaterThan(0)
  expect(interiorCoverage.every(Boolean)).toBe(true)
}

test("wide tables keep keyboard selection and caret geometry stable", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-geometry-e2e-")
  )
  const documentPath = path.join(userData, "wide-table.md")
  const bodyRowCount = wideTableLines.length - 2
  await writeFile(
    documentPath,
    ["Before the table", "", ...wideTableLines, "", "After the table"].join(
      "\n"
    )
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 520, height: 1000 })
    await expect(page.locator(".cm-editor")).toBeVisible()

    const headerLine = 3
    const firstBodyLine = 5
    const lastBodyLine = firstBodyLine + bodyRowCount - 1
    const lineBelowTable = lastBodyLine + 1
    await placeCaret(page, lineBelowTable)
    await expect(page.locator(".cm-md-table-scroll")).toBeVisible()

    const initial = await tableGeometry(page)
    expect(initial.tableScrollWidth).toBeGreaterThan(initial.tableClientWidth)
    expect(initial.rowHeights).toHaveLength(bodyRowCount + 1)
    const firstTableCell = page
      .locator(".cm-md-table-row .cm-md-table-cell")
      .first()
    await firstTableCell.scrollIntoViewIfNeeded()
    await settleGeometry(page)
    const firstCellHit = await firstTableCell.evaluate((cell) => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const textRange = document.createRange()
      textRange.selectNodeContents(cell)
      const bounds = [...textRange.getClientRects()].find(
        (rect) => rect.width > 0 && rect.height > 0
      )
      if (!bounds) throw new Error("The first cell has no text geometry")
      const point = {
        x: bounds.left + Math.min(20, bounds.width / 2),
        y: (bounds.top + bounds.bottom) / 2,
      }
      const nativePosition = document.caretPositionFromPoint(point.x, point.y)
      const nativeRange = document.caretRangeFromPoint(point.x, point.y)
      const nativeNode =
        nativePosition?.offsetNode ?? nativeRange?.startContainer
      const position = view.posAtCoords(point)
      if (position == null) throw new Error("The table hit test failed")
      const line = view.state.doc.lineAt(position)
      return {
        column: position - line.from,
        line: line.number,
        nativeInsideCell: nativeNode != null && cell.contains(nativeNode),
      }
    })
    expect(firstCellHit.nativeInsideCell).toBe(true)
    expect(firstCellHit.line).toBe(firstBodyLine)
    expect(firstCellHit.column).toBeGreaterThan(0)
    expect(firstCellHit.column).toBeLessThan(
      wideTableLines[2]?.indexOf("|", 1) ?? 0
    )
    await placeCaret(page, lineBelowTable)

    const expectedUpLines = [
      ...Array.from(
        { length: bodyRowCount },
        (_, index) => lastBodyLine - index
      ),
      headerLine,
    ]
    const observedUpLines: number[] = []
    for (let step = 0; step < expectedUpLines.length; step += 1) {
      await page.keyboard.press("Shift+ArrowUp")
      await settleGeometry(page)
      const geometry = await tableGeometry(page)
      expect(geometry.anchorLine).toBe(lineBelowTable)
      observedUpLines.push(geometry.headLine)
      expect(geometry.rowHeights).toEqual(initial.rowHeights)
    }
    expect(observedUpLines).toEqual(expectedUpLines)

    const expectedDownLines = [
      ...Array.from(
        { length: bodyRowCount },
        (_, index) => firstBodyLine + index
      ),
      lineBelowTable,
    ]
    const observedDownLines: number[] = []
    for (let step = 0; step < expectedDownLines.length; step += 1) {
      await page.keyboard.press("Shift+ArrowDown")
      await settleGeometry(page)
      const geometry = await tableGeometry(page)
      expect(geometry.anchorLine).toBe(lineBelowTable)
      observedDownLines.push(geometry.headLine)
      expect(geometry.rowHeights).toEqual(initial.rowHeights)
    }
    expect(observedDownLines).toEqual(expectedDownLines)

    await placeCaret(page, lineBelowTable)
    const navigationStart = await tableGeometry(page)
    const navigationLines = [lastBodyLine, lastBodyLine, lastBodyLine - 1]
    for (const [index, key] of [
      "ArrowLeft",
      "ArrowLeft",
      "ArrowUp",
    ].entries()) {
      await page.keyboard.press(key)
      await settleGeometry(page)
      const geometry = await tableGeometry(page)
      expect(geometry.headLine).toBe(navigationLines[index])
      expect(geometry.caretHeight).toBeGreaterThan(0)
      expect(geometry.caretInsideTable).toBe(true)
      expect(geometry.caretInsideViewport).toBe(true)
      expect(geometry.scrollTop).toBeCloseTo(navigationStart.scrollTop, 5)
      expect(geometry.rowHeights).toEqual(initial.rowHeights)
    }

    const beforeTyping = await tableGeometry(page)
    expect(beforeTyping.tableScrollLeft).toBeGreaterThan(0)
    for (const [index, character] of [..."ABCDE"].entries()) {
      await page.keyboard.type(character)
      await settleGeometry(page)
      const geometry = await tableGeometry(page)
      expect(geometry.headLine).toBe(lastBodyLine - 1)
      expect(geometry.column).toBe(beforeTyping.column + index + 1)
      expect(geometry.caretHeight).toBeGreaterThan(0)
      expect(geometry.caretInsideTable).toBe(true)
      expect(geometry.caretInsideViewport).toBe(true)
      expect(geometry.scrollTop).toBeCloseTo(beforeTyping.scrollTop, 5)
      expect(geometry.rowHeights).toEqual(initial.rowHeights)
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("table row boundaries and upward selection stay deterministic in table-demo", async () => {
  test.slow()

  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-demo-navigation-e2e-")
  )
  const documentPath = path.join(userData, "table-demo.md")
  await writeFile(documentPath, await readFile(tableDemoFixturePath))

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 800, height: 650 })
    await expect(page.locator(".cm-editor")).toBeVisible()
    await placeCaret(page, 109)
    await page.keyboard.press("ArrowLeft")
    await settleGeometry(page)

    const rowBounds = await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(108)
      const source = view.state.doc.sliceString(line.from, line.to)
      const firstText = "15"
      const lastText = "3,100 units"
      return {
        first: line.from + source.indexOf(firstText),
        last: line.from + source.lastIndexOf(lastText) + lastText.length,
      }
    })

    const optionStart = await tableNavigationState(page)
    const groupLeft =
      process.platform === "darwin" ? "Alt+ArrowLeft" : "Control+ArrowLeft"
    let optionHead = optionStart.head
    for (
      let repetition = 0;
      optionHead !== rowBounds.first && repetition < 64;
      repetition += 1
    ) {
      await page.keyboard.press(groupLeft)
      await settleGeometry(page)
      const state = await tableNavigationState(page)
      expect(state.headLine).toBe(108)
      expect(state.head).toBeLessThan(optionHead)
      expect(state.coordinatesValid).toBe(true)
      expect(state.scrollTop).toBeCloseTo(optionStart.scrollTop, 5)
      expect(state.rowHeights).toEqual(optionStart.rowHeights)
      optionHead = state.head
    }
    expect(optionHead).toBe(rowBounds.first)

    await placeCaret(page, 109)
    await page.keyboard.press("ArrowLeft")
    await settleGeometry(page)
    const optionSelectionStart = await tableNavigationState(page)
    const selectGroupLeft =
      process.platform === "darwin"
        ? "Alt+Shift+ArrowLeft"
        : "Control+Shift+ArrowLeft"
    let optionSelectionHead = optionSelectionStart.head
    for (
      let repetition = 0;
      optionSelectionHead !== rowBounds.first && repetition < 64;
      repetition += 1
    ) {
      await page.keyboard.press(selectGroupLeft)
      await settleGeometry(page)
      const state = await tableNavigationState(page)
      expect(state.anchorLine).toBe(108)
      expect(state.anchor).toBe(optionSelectionStart.anchor)
      expect(state.headLine).toBe(108)
      expect(state.head).toBeLessThan(optionSelectionHead)
      expect(state.coordinatesValid).toBe(true)
      expect(state.scrollTop).toBeCloseTo(optionSelectionStart.scrollTop, 5)
      expect(state.rowHeights).toEqual(optionSelectionStart.rowHeights)
      optionSelectionHead = state.head
    }
    expect(optionSelectionHead).toBe(rowBounds.first)

    await placeCaret(page, 109)
    await page.keyboard.press("ArrowLeft")
    await settleGeometry(page)
    const lineStartKey =
      process.platform === "darwin" ? "Meta+ArrowLeft" : "Home"
    const lineEndKey = process.platform === "darwin" ? "Meta+ArrowRight" : "End"
    for (let repetition = 0; repetition < 3; repetition += 1) {
      await page.keyboard.press(lineStartKey)
      await settleGeometry(page)
      const geometry = await tableGeometry(page)
      expect(geometry.headLine).toBe(108)
      expect(geometry.column).toBeGreaterThan(0)
      expect(geometry.caretInsideViewport).toBe(true)
      const head = await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        return view?.state.selection.main.head
      })
      expect(head).toBe(rowBounds.first)
    }

    for (let repetition = 0; repetition < 3; repetition += 1) {
      await page.keyboard.press(lineEndKey)
      await settleGeometry(page)
      const geometry = await tableGeometry(page)
      expect(geometry.headLine).toBe(108)
      expect(geometry.caretInsideViewport).toBe(true)
      const head = await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        return view?.state.selection.main.head
      })
      expect(head).toBe(rowBounds.last)
    }

    const rowBoundaryStart = await tableNavigationState(page)
    for (let repetition = 0; repetition < 3; repetition += 1) {
      await page.keyboard.press("Shift+Home")
      await settleGeometry(page)
      const state = await tableNavigationState(page)
      expect(state.anchorLine).toBe(108)
      expect(state.headLine).toBe(108)
      expect(state.head).toBe(rowBounds.first)
      expect(state.coordinatesValid).toBe(true)
      expect(state.scrollTop).toBeCloseTo(rowBoundaryStart.scrollTop, 5)
    }
    await page.keyboard.press("End")
    await settleGeometry(page)
    expect((await tableNavigationState(page)).head).toBe(rowBounds.last)

    await placeCaret(page, 109)
    const roundTripStart = await tableNavigationState(page)
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowRight")
    await settleGeometry(page)
    const roundTrip = await tableNavigationState(page)
    expect(roundTrip.headLine).toBe(109)
    expect(roundTrip.column).toBe(0)
    expect(roundTrip.head).toBe(roundTrip.lineFrom)
    expect(roundTrip.coordinatesValid).toBe(true)
    expect(roundTrip.scrollTop).toBeCloseTo(roundTripStart.scrollTop, 5)
    expect(roundTrip.rowHeights).toEqual(roundTripStart.rowHeights)

    for (let step = 0; step < 5; step += 1) {
      await page.keyboard.press("Shift+ArrowUp")
      await settleGeometry(page)
      const state = await tableNavigationState(page)
      expect(state.anchorLine).toBe(109)
      expect(state.headLine).toBe(108 - step)
      expect(state.coordinatesValid).toBe(true)
      expect(state.scrollTop).toBeCloseTo(roundTripStart.scrollTop, 5)
      expect(state.rowHeights).toEqual(roundTripStart.rowHeights)
    }

    await placeCaret(page, 109)
    await page.keyboard.press("ArrowLeft")
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Shift+ArrowUp")
      await settleGeometry(page)
      const selection = await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const range = view.state.selection.main
        const maximumRowHeight = Math.max(
          ...Array.from(
            document.querySelectorAll<HTMLElement>(".cm-md-table-line"),
            (row) => row.getBoundingClientRect().height
          )
        )
        return {
          anchorLine: view.state.doc.lineAt(range.anchor).number,
          headLine: view.state.doc.lineAt(range.head).number,
          markerHeights: Array.from(
            document.querySelectorAll<HTMLElement>(
              ".cm-app-selectionBackground"
            ),
            (marker) => marker.getBoundingClientRect().height
          ),
          maximumRowHeight,
        }
      })
      expect(selection.anchorLine).toBe(108)
      expect(selection.headLine).toBe(107 - step)
      expect(selection.markerHeights.length).toBeGreaterThan(0)
      expect(Math.max(...selection.markerHeights)).toBeLessThanOrEqual(
        selection.maximumRowHeight + 1
      )
    }

    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Shift+ArrowDown")
      await settleGeometry(page)
      const selection = await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const range = view.state.selection.main
        const rowHeights = Array.from(
          document.querySelectorAll<HTMLElement>(".cm-md-table-line"),
          (row) => row.getBoundingClientRect().height
        )
        return {
          anchorLine: view.state.doc.lineAt(range.anchor).number,
          headLine: view.state.doc.lineAt(range.head).number,
          markerHeights: Array.from(
            document.querySelectorAll<HTMLElement>(
              ".cm-app-selectionBackground"
            ),
            (marker) => marker.getBoundingClientRect().height
          ),
          maximumRowHeight: Math.max(...rowHeights),
        }
      })
      expect(selection.anchorLine).toBe(108)
      expect(selection.headLine).toBe(97 + step)
      if (step < 11) {
        expect(selection.markerHeights.length).toBeGreaterThan(0)
        expect(Math.max(...selection.markerHeights)).toBeLessThanOrEqual(
          selection.maximumRowHeight + 1
        )
      } else {
        expect(selection.markerHeights).toHaveLength(0)
      }
    }

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await placeCaret(page, 109)
      const blankLineAnchor = (await selectionAppearanceState(page)).anchor
      for (let step = 0; step < 22; step += 1) {
        await page.keyboard.press("Shift+ArrowUp")
        await settleGeometry(page)
        const selection = await selectionAppearanceState(page)
        expect(selection.anchor).toBe(blankLineAnchor)
        expect(selection.anchorLine).toBe(109)
        expect(selection.markerHeights.length).toBeGreaterThan(0)
        expect(selection.hasTableWrapperMarker).toBe(false)
        expectTableMarkerGeometry(selection)
      }

      for (let step = 0; step < 27; step += 1) {
        await page.keyboard.press("Shift+ArrowDown")
        await settleGeometry(page)
        const selection = await selectionAppearanceState(page)
        expect(selection.anchor).toBe(blankLineAnchor)
        expect(selection.anchorLine).toBe(109)
        if (selection.head === selection.anchor) {
          expect(selection.markerHeights).toHaveLength(0)
        } else {
          expect(selection.markerHeights.length).toBeGreaterThan(0)
          expect(selection.hasTableWrapperMarker).toBe(false)
          if (selection.table?.markerHeights.length) {
            expectTableMarkerGeometry(selection)
          }
        }
      }
      expect((await selectionAppearanceState(page)).headLine).toBe(110)
    }

    for (const [lineNumber, renderedTableRow] of [
      [110, false],
      [108, true],
      [94, true],
      [92, true],
    ] as const) {
      const lineEnd = await placeCaretAtLineEnd(page, lineNumber)
      await page.keyboard.press("Shift+ArrowRight")
      await settleGeometry(page)
      const selection = await selectionAppearanceState(page)
      expect(selection.anchor).toBe(lineEnd)
      expect(selection.anchorLine).toBe(lineNumber)
      expect(selection.head).toBeGreaterThan(lineEnd)
      expect(selection.markerHeights.length).toBeGreaterThan(0)
      expect(Math.max(...selection.markerHeights)).toBeLessThanOrEqual(150)
      expect(selection.hasTableWrapperMarker).toBe(false)
      if (renderedTableRow) {
        const boundaryMarkers =
          selection.table?.markerBounds.filter((marker) =>
            marker.className.includes("cm-app-tableSelectionBackground")
          ) ?? []
        expect(boundaryMarkers.length).toBeGreaterThan(0)
        const rowIndex = selection.table!.rowLines.indexOf(lineNumber)
        expect(rowIndex).toBeGreaterThanOrEqual(0)
        const anchorRow = selection.table!.rowBounds[rowIndex]!
        const selectedLineFrom = Math.min(
          selection.anchorLine,
          selection.headLine
        )
        const selectedLineTo = Math.max(
          selection.anchorLine,
          selection.headLine
        )
        const selectedRows = selection.table!.rowLines.flatMap(
          (sourceLine, index) =>
            sourceLine >= selectedLineFrom && sourceLine <= selectedLineTo
              ? [selection.table!.rowBounds[index]!]
              : []
        )
        expect(selectedRows.length).toBeGreaterThan(0)
        for (const marker of boundaryMarkers) {
          expect(marker.right).toBeGreaterThan(marker.left)
          expect(marker.bottom).toBeGreaterThan(marker.top)
          const containingRow = selectedRows.find(
            (row) =>
              marker.top >= row.top - 1 && marker.bottom <= row.bottom + 1
          )
          expect(containingRow).toBeDefined()
          if (!containingRow) continue
          expect(marker.left).toBeGreaterThanOrEqual(
            Math.max(
              containingRow.left,
              selection.table!.bounds.left,
              selection.table!.lane.left
            ) - 1
          )
          expect(marker.right).toBeLessThanOrEqual(
            Math.min(
              containingRow.right,
              selection.table!.bounds.right,
              selection.table!.lane.right
            ) + 1
          )
        }
        expect(
          boundaryMarkers.some(
            (marker) =>
              marker.top >= anchorRow.top - 1 &&
              marker.bottom <= anchorRow.bottom + 1 &&
              marker.right - marker.left <= 20
          )
        ).toBe(true)
      }
    }

    const paragraphColumn =
      (await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const line = view.state.doc.line(110)
        return view.state.doc.sliceString(line.from, line.to).length
      })) - 16
    await placeCaretAtColumn(page, 110, paragraphColumn, 1)
    const paragraphAnchor = (await selectionAppearanceState(page)).anchor
    for (let step = 0; step < 26; step += 1) {
      await page.keyboard.press("Shift+ArrowUp")
      await settleGeometry(page)
      const selection = await selectionAppearanceState(page)
      expect(selection.anchor).toBe(paragraphAnchor)
      expect(selection.markerHeights.length).toBeGreaterThan(0)
      expect(selection.hasTableWrapperMarker).toBe(false)
      if (selection.table?.markerHeights.length) {
        expectTableMarkerGeometry(selection)
      }
    }
    for (let step = 0; step < 34; step += 1) {
      await page.keyboard.press("Shift+ArrowDown")
      await settleGeometry(page)
      const selection = await selectionAppearanceState(page)
      expect(selection.anchor).toBe(paragraphAnchor)
      if (selection.head !== selection.anchor) {
        expect(selection.markerHeights.length).toBeGreaterThan(0)
        expect(selection.hasTableWrapperMarker).toBe(false)
        if (selection.table?.markerHeights.length) {
          expectTableMarkerGeometry(selection)
        }
      }
    }
    expect((await selectionAppearanceState(page)).head).toBeGreaterThan(
      paragraphAnchor
    )

    await placeCaretAtColumn(page, 246, 8, 1)
    const longRangeAnchor = await selectionAppearanceState(page)
    expect(longRangeAnchor.anchorLine).toBe(246)
    let nearTop = longRangeAnchor
    for (let step = 0; step < 500; step += 1) {
      await page.keyboard.press("Shift+ArrowUp")
      if (step % 12 !== 11 && step < 499) continue
      nearTop = await selectionAppearanceState(page)
      if (nearTop.headLine <= 5) break
    }
    expect(nearTop.anchor).toBe(longRangeAnchor.anchor)
    expect(nearTop.headLine).toBeLessThanOrEqual(5)

    let approachingTable = nearTop
    for (let step = 0; step < 500; step += 1) {
      await page.keyboard.press("Shift+ArrowDown")
      if (step % 4 !== 3 && step < 499) continue
      approachingTable = await selectionAppearanceState(page)
      if (approachingTable.headLine >= 82) break
    }
    expect(approachingTable.anchor).toBe(longRangeAnchor.anchor)
    expect(approachingTable.headLine).toBeGreaterThanOrEqual(82)
    expect(approachingTable.headLine).toBeLessThan(92)

    const seenTableRows = new Set<number>()
    let sawAfterTableContinuation = false
    let sawBeforeTableContinuation = false
    let sawFullTableCoverage = false
    let afterTable = approachingTable
    for (let step = 0; step < 180; step += 1) {
      await page.keyboard.press("Shift+ArrowDown")
      await settleGeometry(page)
      afterTable = await selectionAppearanceState(page)
      expect(afterTable.anchor).toBe(longRangeAnchor.anchor)
      expect(afterTable.hasTableWrapperMarker).toBe(false)
      if (afterTable.table) {
        expect(afterTable.table.rowCellCounts.length).toBeGreaterThan(0)
        expect(
          afterTable.table.rowCellCounts.every((count) => count === 8)
        ).toBe(true)
        for (const [index, line] of afterTable.table.rowLines.entries()) {
          const height = afterTable.table.rowHeights[index]!
          seenTableRows.add(line)
          expect(height).toBeGreaterThan(0)
          expect(height).toBeLessThanOrEqual(150)
        }
        const selectionStartLine = Math.min(
          afterTable.anchorLine,
          afterTable.headLine
        )
        const selectionEndLine = Math.max(
          afterTable.anchorLine,
          afterTable.headLine
        )
        const selectionOverlapsMountedTable = afterTable.table.rowLines.some(
          (line) => line >= selectionStartLine && line <= selectionEndLine
        )
        if (selectionOverlapsMountedTable) {
          expectTableMarkerGeometry(afterTable)
        }
        if (
          selectionOverlapsMountedTable &&
          afterTable.table.rowLines.includes(92) &&
          afterTable.table.beforeContinuation
        ) {
          expect(afterTable.table.beforeContinuation.left).toBeCloseTo(
            afterTable.table.lane.left,
            0
          )
          expect(afterTable.table.beforeContinuation.right).toBeCloseTo(
            afterTable.table.lane.right,
            0
          )
          sawBeforeTableContinuation = true
        }
        if (
          selectionOverlapsMountedTable &&
          afterTable.table.rowLines.includes(108) &&
          afterTable.table.afterContinuation
        ) {
          expect(afterTable.table.afterContinuation.left).toBeCloseTo(
            afterTable.table.lane.left,
            0
          )
          expect(afterTable.table.afterContinuation.right).toBeCloseTo(
            afterTable.table.lane.right,
            0
          )
          sawAfterTableContinuation = true
        }
        if (afterTable.headLine < 92 && !sawFullTableCoverage) {
          await page.evaluate(() => {
            const table = document.querySelector<HTMLElement>(
              ".cm-md-table-scroll"
            )
            if (!table) throw new Error("The rendered table is unavailable")
            table.scrollLeft = 0
          })
          await settleGeometry(page)
          const leftEdgeSelection = await selectionAppearanceState(page)
          const leftEdgeTable = leftEdgeSelection.table
          expect(leftEdgeSelection.anchor).toBe(longRangeAnchor.anchor)
          expect(leftEdgeSelection.hasTableWrapperMarker).toBe(false)
          expect(leftEdgeTable).not.toBeNull()
          if (!leftEdgeTable) {
            throw new Error("The rendered table disappeared while scrolling")
          }
          expectTableMarkerGeometry(leftEdgeSelection)
          expect(leftEdgeTable.scrollWidth).toBeGreaterThan(
            leftEdgeTable.clientWidth
          )
          expect(leftEdgeTable.scrollLeft).toBe(0)
          expectVisibleTableCellsSelected(leftEdgeTable)
          expect(
            leftEdgeTable.selectedEdgeCoverage.every(([first]) => first)
          ).toBe(true)

          expect(leftEdgeTable.beforeContinuation).not.toBeNull()
          if (!leftEdgeTable.beforeContinuation) {
            throw new Error("The before-table continuation is unavailable")
          }
          expect(leftEdgeTable.beforeContinuation.left).toBeCloseTo(
            leftEdgeTable.lane.left,
            0
          )
          expect(leftEdgeTable.beforeContinuation.right).toBeCloseTo(
            leftEdgeTable.lane.right,
            0
          )

          const initialCellPaint = await tableCellSelectionPaint(page)
          await beginSelectionPositionLookupCount(page)
          await page.evaluate(() => {
            const table = document.querySelector<HTMLElement>(
              ".cm-md-table-scroll"
            )
            if (!table) throw new Error("The rendered table is unavailable")
            table.scrollLeft = Math.min(
              32,
              table.scrollWidth - table.clientWidth
            )
          })
          await settleGeometry(page)
          const shiftedCellPaint = await tableCellSelectionPaint(
            page,
            initialCellPaint.cellIndex
          )
          const positionLookups = await finishSelectionPositionLookupCount(page)
          const scrollDelta =
            shiftedCellPaint.scrollLeft - initialCellPaint.scrollLeft
          expect(scrollDelta).toBeGreaterThan(0)
          expect(
            shiftedCellPaint.cellLeft - initialCellPaint.cellLeft
          ).toBeCloseTo(-scrollDelta, 0)
          expect(
            shiftedCellPaint.paintLeft - initialCellPaint.paintLeft
          ).toBeCloseTo(-scrollDelta, 0)
          expect(
            shiftedCellPaint.paintLeft - shiftedCellPaint.cellLeft
          ).toBeCloseTo(
            initialCellPaint.paintLeft - initialCellPaint.cellLeft,
            0
          )
          expect(positionLookups.calls).toBeLessThanOrEqual(
            positionLookups.lineCount + 4
          )

          await page.evaluate(() => {
            const table = document.querySelector<HTMLElement>(
              ".cm-md-table-scroll"
            )
            if (!table) throw new Error("The rendered table is unavailable")
            table.scrollLeft = table.scrollWidth
          })
          await settleGeometry(page)
          const rightEdgeSelection = await selectionAppearanceState(page)
          const rightEdgeTable = rightEdgeSelection.table
          expect(rightEdgeSelection.anchor).toBe(longRangeAnchor.anchor)
          expect(rightEdgeSelection.hasTableWrapperMarker).toBe(false)
          expect(rightEdgeTable).not.toBeNull()
          if (!rightEdgeTable) {
            throw new Error("The rendered table disappeared while scrolling")
          }
          expectTableMarkerGeometry(rightEdgeSelection)
          expect(rightEdgeTable.scrollWidth).toBeGreaterThan(
            rightEdgeTable.clientWidth
          )
          expect(rightEdgeTable.scrollLeft).toBeGreaterThan(0)
          expectVisibleTableCellsSelected(rightEdgeTable)
          expect(
            rightEdgeTable.selectedEdgeCoverage.every(([, last]) => last)
          ).toBe(true)
          await page.evaluate(() => {
            const table = document.querySelector<HTMLElement>(
              ".cm-md-table-scroll"
            )
            if (table) table.scrollLeft = 0
          })
          await settleGeometry(page)
          sawFullTableCoverage = true
        }
      }
      if (afterTable.headLine >= 130) break
    }
    expect(sawBeforeTableContinuation).toBe(true)
    expect(sawAfterTableContinuation).toBe(true)
    expect(sawFullTableCoverage).toBe(true)
    expect(seenTableRows.size).toBe(16)
    expect(afterTable.headLine).toBeGreaterThanOrEqual(130)

    let pastLongRangeAnchor = afterTable
    for (let step = 0; step < 500; step += 1) {
      await page.keyboard.press("Shift+ArrowDown")
      if (step % 8 !== 7 && step < 499) continue
      pastLongRangeAnchor = await selectionAppearanceState(page)
      if (pastLongRangeAnchor.head > longRangeAnchor.anchor) break
    }
    expect(pastLongRangeAnchor.anchor).toBe(longRangeAnchor.anchor)
    expect(pastLongRangeAnchor.head).toBeGreaterThan(longRangeAnchor.anchor)

    await placeCaret(page, 109)
    const directTypingDocument = await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      return view.state.doc.toString()
    })
    const directTypingStart = await tableNavigationState(page)
    await page.keyboard.type("q")
    await settleGeometry(page)
    const directTyping = await tableNavigationState(page)
    expect(directTyping.headLine).toBe(110)
    expect(directTyping.column).toBe(1)
    expect(directTyping.sourceLine).toBe("q")
    expect(directTyping.coordinatesValid).toBe(true)
    expect(directTyping.scrollTop).toBeGreaterThanOrEqual(
      directTypingStart.scrollTop - 1
    )
    expect(directTyping.scrollTop).toBeLessThanOrEqual(
      directTypingStart.scrollTop + directTypingStart.lineHeight + 1
    )
    expect(directTyping.rowHeights).toEqual(directTypingStart.rowHeights)
    expect(directTyping.tableHeight).toBeCloseTo(
      directTypingStart.tableHeight,
      1
    )
    expect(
      await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const line = view.state.doc.line(109)
        return line.to - line.from
      })
    ).toBe(0)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z"
    )
    await settleGeometry(page)
    expect(
      await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        return view.state.doc.toString()
      })
    ).toBe(directTypingDocument)

    await placeCaret(page, 109)
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowRight")
    await settleGeometry(page)
    const typingStart = await tableNavigationState(page)
    let settledTypingScrollTop: number | undefined
    for (const [index, character] of [..."abc"].entries()) {
      await page.keyboard.type(character)
      await settleGeometry(page)
      const state = await tableNavigationState(page)
      expect(state.headLine).toBe(110)
      expect(state.column).toBe(index + 1)
      expect(state.sourceLine).toBe("abc".slice(0, index + 1))
      expect(state.coordinatesValid).toBe(true)
      if (settledTypingScrollTop == null) {
        expect(state.scrollTop).toBeGreaterThanOrEqual(
          typingStart.scrollTop - 1
        )
        expect(state.scrollTop).toBeLessThanOrEqual(
          typingStart.scrollTop + typingStart.lineHeight + 1
        )
        settledTypingScrollTop = state.scrollTop
      } else {
        expect(state.scrollTop).toBeCloseTo(settledTypingScrollTop, 5)
      }
      expect(state.rowHeights).toEqual(typingStart.rowHeights)
      expect(state.tableHeight).toBeCloseTo(typingStart.tableHeight, 1)
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("table cells support empty-cell carets, multi-click selection, select-all, and soft breaks", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-cell-editing-e2e-")
  )
  const documentPath = path.join(userData, "cell-editing.md")
  await writeFile(
    documentPath,
    [
      "| Name | Notes | Value |",
      "| --- | --- | --- |",
      "|  alpha bravo  |     | omega |",
      "|   |     |   |",
      "|a|b|c|",
      "|x|y|z|hidden|",
      "|a|b|c|   ",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 800, height: 650 })
    await expect(page.locator(".cm-editor")).toBeVisible()

    const emptyCell = page
      .locator(".cm-md-table-row")
      .nth(1)
      .locator(".cm-md-table-cell-empty")
      .nth(1)
    await expect(emptyCell).toBeVisible()
    await emptyCell.click()
    await settleGeometry(page)
    const emptyCaret = await emptyCell.evaluate((cell) => {
      const cellBounds = cell.getBoundingClientRect()
      return Array.from(document.querySelectorAll<HTMLElement>(".cm-cursor"))
        .map((caret) => {
          const bounds = caret.getBoundingClientRect()
          const style = getComputedStyle(caret)
          return { bounds, style }
        })
        .some(
          ({ bounds, style }) =>
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            bounds.height > 0 &&
            bounds.left >= cellBounds.left - 1 &&
            bounds.left <= cellBounds.right + 1 &&
            bounds.bottom >= cellBounds.top &&
            bounds.top <= cellBounds.bottom
        )
    })
    expect(emptyCaret).toBe(true)

    const firstCell = page
      .locator(".cm-md-table-row")
      .first()
      .locator(".cm-md-table-cell")
      .first()
    const whitespaceCell = page
      .locator(".cm-md-table-row")
      .first()
      .locator(".cm-md-table-cell")
      .nth(1)
    const alpha = "alpha bravo"
    const [insideAlpha, beforeFinalAlphaCharacter, alphaEnd] =
      await Promise.all([
        textBoundary(firstCell, 2),
        textBoundary(firstCell, alpha.length - 1),
        textBoundary(firstCell, alpha.length),
      ])

    await page.mouse.click(insideAlpha.x, insideAlpha.y)
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await settleGeometry(page)
    expect(
      await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const line = view.state.doc.line(3)
        const source = view.state.doc.sliceString(line.from, line.to)
        return {
          assoc: view.state.selection.main.assoc,
          column: view.state.selection.main.head - line.from,
          expectedColumn: source.indexOf("alpha"),
        }
      })
    ).toEqual({
      assoc: 1,
      column: 3,
      expectedColumn: 3,
    })

    await page.mouse.click(
      beforeFinalAlphaCharacter.x,
      beforeFinalAlphaCharacter.y
    )
    await page.keyboard.press("ArrowRight")
    await settleGeometry(page)
    expect(
      await page.evaluate((expectedText) => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const line = view.state.doc.line(3)
        const source = view.state.doc.sliceString(line.from, line.to)
        return {
          assoc: view.state.selection.main.assoc,
          column: view.state.selection.main.head - line.from,
          expectedColumn: source.indexOf(expectedText) + expectedText.length,
        }
      }, alpha)
    ).toEqual({
      assoc: -1,
      column: 14,
      expectedColumn: 14,
    })

    await page.mouse.click(alphaEnd.x, alphaEnd.y)
    await settleGeometry(page)
    const endCaret = await firstCell.evaluate((cell) => {
      const cellBounds = cell.getBoundingClientRect()
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const visible = Array.from(
        document.querySelectorAll<HTMLElement>(".cm-cursor")
      ).some((caret) => {
        const bounds = caret.getBoundingClientRect()
        const style = getComputedStyle(caret)
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.height > 0 &&
          bounds.left >= cellBounds.left - 1 &&
          bounds.left <= cellBounds.right + 1 &&
          bounds.bottom >= cellBounds.top &&
          bounds.top <= cellBounds.bottom
        )
      })
      return { assoc: view.state.selection.main.assoc, visible }
    })
    expect(endCaret).toEqual({ assoc: -1, visible: true })

    const boundaryColumns = await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(3)
      const source = view.state.doc.sliceString(line.from, line.to)
      const contentStart = source.indexOf("alpha")
      const firstDelimiter = source.indexOf("|", 1)
      const whitespaceStart = firstDelimiter + 1
      const compactLine = view.state.doc.line(5)
      const compactSource = view.state.doc.sliceString(
        compactLine.from,
        compactLine.to
      )
      const excessLine = view.state.doc.line(6)
      const excessSource = view.state.doc.sliceString(
        excessLine.from,
        excessLine.to
      )
      const trailingLine = view.state.doc.line(7)
      const trailingSource = view.state.doc.sliceString(
        trailingLine.from,
        trailingLine.to
      )
      const headerLine = view.state.doc.line(1)
      const headerSource = view.state.doc.sliceString(
        headerLine.from,
        headerLine.to
      )
      return {
        compactFirstStart: compactSource.indexOf("a"),
        compactLastEnd: compactSource.indexOf("c") + 1,
        compactMiddleStart: compactSource.indexOf("b"),
        contentEnd: contentStart + "alpha bravo".length,
        contentStart,
        excessEnd: excessSource.indexOf("hidden") + "hidden".length,
        excessRenderedEnd: excessSource.indexOf("z") + 1,
        finalContentEnd: trailingSource.indexOf("c") + 1,
        headerContentStart: headerSource.indexOf("Name"),
        trailingSpaceStart: trailingSource.lastIndexOf("|") + 1,
        whitespaceEnd: source.indexOf("|", whitespaceStart),
        whitespaceStart,
      }
    })

    await placeCaretAtColumn(page, 1, boundaryColumns.headerContentStart, 1)
    const documentStart = await tableNavigationState(page)
    await page.keyboard.press("ArrowLeft")
    await settleGeometry(page)
    const afterDocumentStart = await tableNavigationState(page)
    expect(afterDocumentStart.head).toBe(documentStart.head)
    expect(afterDocumentStart.assoc).toBe(documentStart.assoc)
    expect(afterDocumentStart.coordinatesValid).toBe(true)
    await page.keyboard.press("ArrowUp")
    await settleGeometry(page)
    const aboveDocumentStart = await tableNavigationState(page)
    expect(aboveDocumentStart.head).toBe(documentStart.head)
    expect(aboveDocumentStart.assoc).toBe(documentStart.assoc)
    expect(aboveDocumentStart.coordinatesValid).toBe(true)

    await placeCaretAtColumn(page, 7, boundaryColumns.finalContentEnd, -1)
    const documentEnd = await tableNavigationState(page)
    await page.keyboard.press("ArrowRight")
    await settleGeometry(page)
    const afterDocumentEnd = await tableNavigationState(page)
    expect(afterDocumentEnd.head).toBe(documentEnd.head)
    expect(afterDocumentEnd.assoc).toBe(documentEnd.assoc)
    expect(afterDocumentEnd.coordinatesValid).toBe(true)
    await page.keyboard.press("ArrowDown")
    await settleGeometry(page)
    const belowDocumentEnd = await tableNavigationState(page)
    expect(belowDocumentEnd.head).toBe(documentEnd.head)
    expect(belowDocumentEnd.assoc).toBe(documentEnd.assoc)
    expect(belowDocumentEnd.coordinatesValid).toBe(true)

    await placeCaretAtColumn(page, 6, 1, 1)
    const excessBoundaryStart = await tableNavigationState(page)
    await page.keyboard.press("End")
    await settleGeometry(page)
    const excessBoundary = await tableNavigationState(page)
    expect(excessBoundary.headLine).toBe(6)
    expect(excessBoundary.column).toBe(boundaryColumns.excessRenderedEnd)
    expect(excessBoundary.coordinatesValid).toBe(true)
    expect(excessBoundary.scrollTop).toBeCloseTo(
      excessBoundaryStart.scrollTop,
      5
    )
    await placeCaretAtColumn(page, 6, 1, 1)
    await page.keyboard.press("Shift+End")
    await settleGeometry(page)
    const selectedExcessBoundary = await tableNavigationState(page)
    expect(selectedExcessBoundary.anchorLine).toBe(6)
    expect(selectedExcessBoundary.headLine).toBe(6)
    expect(selectedExcessBoundary.column).toBe(
      boundaryColumns.excessRenderedEnd
    )
    expect(selectedExcessBoundary.coordinatesValid).toBe(true)
    expect(selectedExcessBoundary.scrollTop).toBeCloseTo(
      excessBoundaryStart.scrollTop,
      5
    )

    const whitespaceSelectionCases = [
      {
        assoc: 1 as const,
        column: boundaryColumns.contentStart,
        key: "Shift+ArrowLeft",
        line: 3,
      },
      {
        assoc: -1 as const,
        column: boundaryColumns.contentEnd,
        key: "Shift+ArrowRight",
        line: 3,
      },
      {
        assoc: -1 as const,
        column: boundaryColumns.contentEnd,
        key: "Shift+ArrowLeft",
        line: 3,
      },
      {
        assoc: 1 as const,
        column: boundaryColumns.whitespaceStart,
        key: "Shift+ArrowLeft",
        line: 3,
      },
      {
        assoc: -1 as const,
        column: boundaryColumns.whitespaceEnd,
        key: "Shift+ArrowRight",
        line: 3,
      },
      {
        assoc: -1 as const,
        column: boundaryColumns.whitespaceEnd,
        key: "Shift+ArrowLeft",
        line: 3,
      },
      {
        assoc: 1 as const,
        column: boundaryColumns.compactFirstStart,
        expectedSource: "|",
        key: "Shift+ArrowLeft",
        line: 5,
      },
      {
        assoc: 1 as const,
        column: boundaryColumns.compactMiddleStart,
        expectedSource: "|",
        key: "Shift+ArrowLeft",
        line: 5,
      },
      {
        assoc: -1 as const,
        column: boundaryColumns.compactLastEnd,
        expectedSource: "|",
        key: "Shift+ArrowRight",
        line: 5,
      },
      {
        assoc: -1 as const,
        column: boundaryColumns.excessEnd,
        key: "Shift+ArrowLeft",
        line: 6,
      },
      {
        assoc: 1 as const,
        column: boundaryColumns.trailingSpaceStart,
        expectedSource: " ",
        key: "Shift+ArrowRight",
        line: 7,
      },
    ]
    for (const selectionCase of whitespaceSelectionCases) {
      await placeCaretAtColumn(
        page,
        selectionCase.line,
        selectionCase.column,
        selectionCase.assoc
      )
      const selectionStart = await tableNavigationState(page)
      await page.keyboard.press(selectionCase.key)
      await settleGeometry(page)
      const selectedState = await tableNavigationState(page)
      expect(selectedState.headLine).toBe(selectionCase.line)
      expect(selectedState.scrollTop).toBeCloseTo(selectionStart.scrollTop, 5)
      const selectionGeometry = await whitespaceCell.evaluate(
        (_cell, renderedRowIndex) => {
          const view = (
            document.querySelector<HTMLElement>(".cm-content") as
              | (HTMLElement & {
                  cmTile?: { view?: BrowserEditorView }
                })
              | null
          )?.cmTile?.view
          const range = view?.state.selection.main
          const row =
            document.querySelectorAll<HTMLElement>(".cm-md-table-row")[
              renderedRowIndex
            ]
          const table = document.querySelector<HTMLElement>(
            ".cm-md-table-scroll"
          )
          if (!view || !range || !row || !table) {
            throw new Error("The rendered table is unavailable")
          }
          const rowBounds = row.getBoundingClientRect()
          const tableBounds = table.getBoundingClientRect()
          return {
            markers: Array.from(
              document.querySelectorAll<HTMLElement>(
                ".cm-app-selectionBackground"
              ),
              (marker) => {
                const bounds = marker.getBoundingClientRect()
                return {
                  bottom: bounds.bottom,
                  left: bounds.left,
                  right: bounds.right,
                  top: bounds.top,
                }
              }
            ),
            selectedSource: view.state.doc.sliceString(range.from, range.to),
            row: {
              bottom: rowBounds.bottom,
              left: rowBounds.left,
              right: rowBounds.right,
              top: rowBounds.top,
            },
            table: {
              bottom: tableBounds.bottom,
              left: tableBounds.left,
              right: tableBounds.right,
              top: tableBounds.top,
            },
          }
        },
        selectionCase.line === 1 ? 0 : selectionCase.line - 3
      )
      expect(selectionGeometry.selectedSource.length).toBeGreaterThan(0)
      if (selectionCase.expectedSource) {
        expect(selectionGeometry.selectedSource).toBe(
          selectionCase.expectedSource
        )
      }
      expect(selectionGeometry.markers.length).toBeGreaterThan(0)
      for (const marker of selectionGeometry.markers) {
        expect(marker.left).toBeGreaterThanOrEqual(selectionGeometry.table.left)
        expect(marker.right).toBeLessThanOrEqual(selectionGeometry.table.right)
        expect(marker.top).toBeGreaterThanOrEqual(selectionGeometry.row.top - 1)
        expect(marker.bottom).toBeLessThanOrEqual(
          selectionGeometry.row.bottom + 1
        )
      }
      if (selectionCase.expectedSource) {
        const beforeCollapse = await tableNavigationState(page)
        await page.keyboard.press(
          selectionCase.key.endsWith("ArrowLeft") ? "ArrowUp" : "ArrowDown"
        )
        await settleGeometry(page)
        const afterCollapse = await tableNavigationState(page)
        expect(afterCollapse.headLine).toBe(selectionCase.line)
        expect(
          afterCollapse.coordinatesValid,
          `collapsed table selection has invalid geometry: ${JSON.stringify(selectionCase)}`
        ).toBe(true)
        expect(afterCollapse.scrollTop).toBeCloseTo(beforeCollapse.scrollTop, 5)
      }
    }

    await firstCell.dblclick({ position: { x: 30, y: 20 } })
    await settleGeometry(page)
    expect(
      await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const range = view.state.selection.main
        return view.state.doc.sliceString(range.from, range.to)
      })
    ).toBe("alpha")

    await firstCell.click({
      clickCount: 3,
      position: { x: 30, y: 20 },
    })
    await settleGeometry(page)
    expect(
      await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const range = view.state.selection.main
        return view.state.doc.sliceString(range.from, range.to)
      })
    ).toBe("alpha bravo")

    await firstCell.click({ position: { x: 65, y: 20 } })
    await page.keyboard.press("Meta+a")
    await settleGeometry(page)
    expect(
      await page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const range = view.state.selection.main
        return view.state.doc.sliceString(range.from, range.to)
      })
    ).toBe("alpha bravo")

    await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(3)
      const source = view.state.doc.sliceString(line.from, line.to)
      view.dispatch({
        selection: { anchor: line.from + source.indexOf("bravo") },
      })
      view.focus()
    })
    await page.keyboard.press("Shift+Enter")
    await settleGeometry(page)
    const content = await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      return view.state.doc.sliceString(
        view.state.doc.line(3).from,
        view.state.doc.line(3).to
      )
    })
    expect(content).toContain("alpha <br>bravo")
    await expect(page.locator(".cm-md-table-scroll")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("multiline plain text stays inside its rendered table cell", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-multiline-paste-e2e-")
  )
  const documentPath = path.join(userData, "multiline-paste.md")
  await writeFile(
    documentPath,
    ["| A | B |", "| --- | --- |", "| keep | replace me |"].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const cells = page.locator(".cm-md-table-row .cm-md-table-cell")
    await expect(cells).toHaveCount(2)
    await cells.nth(1).click({ clickCount: 3 })

    const pasted = String.raw`left | right
next
$$
\int_a^b f(x)\,dx
= F(b) - F(a)
$$r`
    const normalized = String.raw`left \| right<br>next<br>$$<br>\int_a^b f(x)\,dx<br>= F(b) - F(a)<br>$$r`
    await page.locator(".cm-content").evaluate((content, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", text)
      content.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        })
      )
    }, pasted)
    await settleGeometry(page)

    const state = await page.evaluate((expectedInsert) => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(3)
      const source = view.state.doc.sliceString(line.from, line.to)
      return {
        caretColumn: view.state.selection.main.head - line.from,
        expectedCaretColumn:
          source.indexOf(expectedInsert) + expectedInsert.length,
        lineCount: view.state.doc.toString().split("\n").length,
        source,
      }
    }, normalized)
    expect(state.caretColumn).toBe(state.expectedCaretColumn)
    expect(state.lineCount).toBe(3)
    expect(state.source).toBe(`| keep | ${normalized} |`)
    await expect(page.locator(".cm-md-table-row")).toHaveCount(1)
    await expect(cells).toHaveCount(2)
    await expect(cells.first()).toHaveText("keep")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a table inside an ordered-list callout keeps its card width and editable cell geometry", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-callout-table-geometry-e2e-")
  )
  const documentPath = path.join(userData, "combined-nesting.md")
  await writeFile(
    documentPath,
    [
      "## 13. Combined nesting",
      "",
      "1. An ordered item can contain a task list.",
      "   - [x] Completed nested task",
      "   - [ ] Open nested task with **bold text** and `code`",
      "2. It can contain a blockquote.",
      "",
      "   > [!SUCCESS]+ Combined feature card",
      "   > This callout is nested inside an ordered list.",
      "   >",
      "   > | Feature | Result |",
      "   > | --- | --- |",
      "   > | Table | Parsed |",
      "   > | Math | $2^5 = 32$ |",
      "   >",
      "   > ```typescript",
      "   > const combined = true;",
      "   > ```",
      "",
      "3. It can finish with an ordinary paragraph and a footnote reference[^combined-note].",
      "",
      "[^combined-note]: This footnote is referenced from the combined-nesting section.",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const callout = page.locator('.cm-md-callout[data-callout-type="success"]')
    const body = callout.locator(":scope > .cm-md-callout-body")
    const table = body.locator(":scope > .cm-md-table-scroll")
    const codeBlock = body.locator(":scope > .cm-md-code-block")
    const headerCells = table
      .locator(":scope > .cm-md-table-header")
      .locator(":scope > .cm-md-table-cell")
    const bodyRows = table.locator(":scope > .cm-md-table-row")

    await expect(callout).toBeVisible()
    await expect(table).toBeVisible()
    await expect(headerCells).toHaveText(["Feature", "Result"])
    await expect(bodyRows).toHaveCount(2)
    await expect(
      bodyRows.nth(0).locator(":scope > .cm-md-table-cell")
    ).toHaveText(["Table", "Parsed"])
    await expect(
      bodyRows.nth(1).locator(":scope > .cm-md-table-cell")
    ).toHaveText(["Math", "$2^5 = 32$"])
    await expect(codeBlock).toContainText("const combined = true;")

    const layout = await page.evaluate(() => {
      const calloutElement = document.querySelector<HTMLElement>(
        '.cm-md-callout[data-callout-type="success"]'
      )
      const bodyElement = calloutElement?.querySelector<HTMLElement>(
        ":scope > .cm-md-callout-body"
      )
      const tableElement = bodyElement?.querySelector<HTMLElement>(
        ":scope > .cm-md-table-scroll"
      )
      const codeElement = bodyElement?.querySelector<HTMLElement>(
        ":scope > .cm-md-code-block"
      )
      if (!calloutElement || !bodyElement || !tableElement || !codeElement) {
        throw new Error("The combined nesting surface is unavailable")
      }
      const bounds = (element: HTMLElement) => {
        const rectangle = element.getBoundingClientRect()
        return {
          left: rectangle.left,
          right: rectangle.right,
          width: rectangle.width,
        }
      }
      return {
        body: bounds(bodyElement),
        callout: bounds(calloutElement),
        code: bounds(codeElement),
        table: bounds(tableElement),
      }
    })
    expect(layout.table.left).toBeCloseTo(layout.body.left, 0)
    expect(layout.table.right).toBeCloseTo(layout.body.right, 0)
    expect(layout.table.width).toBeCloseTo(layout.body.width, 0)
    expect(layout.table.left).toBeGreaterThanOrEqual(layout.callout.left)
    expect(layout.table.right).toBeLessThanOrEqual(layout.callout.right)
    expect(layout.code.left).toBeGreaterThanOrEqual(layout.body.left)
    expect(layout.code.right).toBeLessThanOrEqual(layout.body.right)

    const caretSnapshot = () =>
      page.evaluate(() => {
        const view = (
          document.querySelector<HTMLElement>(".cm-content") as
            | (HTMLElement & {
                cmTile?: { view?: BrowserEditorView }
              })
            | null
        )?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const range = view.state.selection.main
        const line = view.state.doc.lineAt(range.head)
        const cursor = document.querySelector<HTMLElement>(".cm-cursor-primary")
        const cursorBounds = cursor?.getBoundingClientRect()
        return {
          coordinates: view.coordsAtPos(
            range.head,
            range.assoc === 0 ? undefined : range.assoc
          ),
          cursor: cursorBounds
            ? {
                bottom: cursorBounds.bottom,
                left: cursorBounds.left,
                right: cursorBounds.right,
                top: cursorBounds.top,
              }
            : null,
          line: line.number,
          offset: range.head - line.from,
        }
      })

    await headerCells.first().click()
    await settleGeometry(page)
    await expect(callout).toHaveCount(0)
    await expect(page.locator(".cm-md-table-scroll")).toHaveCount(0)

    const rawHeaderLine = page
      .locator(".cm-line")
      .filter({ hasText: "| Feature | Result |" })
    await expect(rawHeaderLine).toHaveCount(1)
    await expect(rawHeaderLine).not.toHaveClass(/cm-md-table-line/)
    const source = await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(11)
      return view.state.doc.sliceString(line.from, line.to)
    })
    expect(source).toBe("   > | Feature | Result |")

    const rawLineBounds = await rawHeaderLine.boundingBox()
    if (!rawLineBounds) {
      throw new Error("The raw nested table header line is unavailable")
    }
    for (const offset of [5, 15, 24]) {
      const coordinates = await textBoundary(rawHeaderLine, offset)
      await page.mouse.click(coordinates.x, coordinates.y)
      await settleGeometry(page)
      const caret = await caretSnapshot()
      expect(caret.line).toBe(11)
      expect(caret.offset).toBe(offset)
      expect(caret.coordinates).not.toBeNull()
      expect(caret.cursor).not.toBeNull()
      expect(caret.cursor!.top).toBeGreaterThanOrEqual(rawLineBounds.y - 1)
      expect(caret.cursor!.bottom).toBeLessThanOrEqual(
        rawLineBounds.y + rawLineBounds.height + 1
      )
    }

    await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      const line = view.state.doc.line(11)
      view.dispatch({ selection: { anchor: line.from } })
      view.focus()
    })
    for (let offset = 0; offset <= source.length; offset += 1) {
      const caret = await caretSnapshot()
      expect(caret.line).toBe(11)
      expect(caret.offset).toBe(offset)
      if (offset < source.length) await page.keyboard.press("ArrowRight")
    }
    for (let offset = source.length; offset >= 0; offset -= 1) {
      const caret = await caretSnapshot()
      expect(caret.line).toBe(11)
      expect(caret.offset).toBe(offset)
      if (offset > 0) await page.keyboard.press("ArrowLeft")
    }

    await placeCaret(page, 20)
    await expect(callout).toBeVisible()
    await expect(table).toBeVisible()
    const restoredLayout = await table.evaluate((tableElement) => {
      const bodyElement = tableElement.parentElement
      if (!bodyElement?.classList.contains("cm-md-callout-body")) {
        throw new Error("The restored table is outside its callout body")
      }
      const tableBounds = tableElement.getBoundingClientRect()
      const bodyBounds = bodyElement.getBoundingClientRect()
      return {
        bodyLeft: bodyBounds.left,
        bodyRight: bodyBounds.right,
        tableLeft: tableBounds.left,
        tableRight: tableBounds.right,
      }
    })
    expect(restoredLayout.tableLeft).toBeCloseTo(restoredLayout.bodyLeft, 0)
    expect(restoredLayout.tableRight).toBeCloseTo(restoredLayout.bodyRight, 0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("nested wide-table selection stays clipped at both scroll edges", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-nested-table-selection-e2e-")
  )
  const documentPath = path.join(userData, "nested-wide-table.md")
  const header = "| A | B | C | D | E | F | G | H |"
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- |"
  const row =
    "| alpha alpha alpha | bravo bravo bravo | charlie charlie charlie | delta delta delta | echo echo echo | foxtrot foxtrot foxtrot | golf golf golf | hotel hotel hotel |"
  await writeFile(
    documentPath,
    [
      "Start partial text",
      "",
      "> [!NOTE] Wide nested table",
      ">",
      `> ${header}`,
      `> ${separator}`,
      `> ${row}`,
      ">",
      "> trailing callout",
      "",
      "End partial text",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(560, 600)
    })
    const callout = page.locator('.cm-md-callout[data-callout-type="note"]')
    const table = callout.locator(".cm-md-table-scroll")
    await expect(table).toBeVisible()

    await page.evaluate(() => {
      const view = (
        document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: { view?: BrowserEditorView }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      view.dispatch({
        selection: {
          anchor: view.state.doc.line(1).from + 3,
          head: view.state.doc.line(11).from + 3,
        },
      })
      view.focus()
    })
    await settleGeometry(page)
    await expect(callout).toBeVisible()

    const selectionViewport = () =>
      table.evaluate((element) => {
        const tableBounds = element.getBoundingClientRect()
        const markers = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".cm-app-tableSelectionBackground"
          ),
          (marker) => {
            const bounds = marker.getBoundingClientRect()
            return {
              bottom: bounds.bottom,
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
            }
          }
        ).filter(
          (marker) =>
            marker.bottom > tableBounds.top && marker.top < tableBounds.bottom
        )
        return {
          bounds: {
            left: tableBounds.left,
            right: tableBounds.right,
          },
          clientWidth: element.clientWidth,
          markers,
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth,
        }
      })

    const expectClipped = (
      state: Awaited<ReturnType<typeof selectionViewport>>
    ) => {
      expect(state.markers.length).toBeGreaterThan(0)
      for (const marker of state.markers) {
        expect(marker.left).toBeGreaterThanOrEqual(state.bounds.left - 0.5)
        expect(marker.right).toBeLessThanOrEqual(state.bounds.right + 0.5)
      }
    }

    const leftEdge = await selectionViewport()
    expect(leftEdge.scrollWidth).toBeGreaterThan(leftEdge.clientWidth)
    expect(leftEdge.scrollLeft).toBe(0)
    expectClipped(leftEdge)

    await table.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
    })
    await settleGeometry(page)
    const rightEdge = await selectionViewport()
    expect(rightEdge.scrollLeft).toBeGreaterThan(0)
    expectClipped(rightEdge)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
