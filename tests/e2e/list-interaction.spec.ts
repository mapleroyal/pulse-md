import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  test,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

interface LaunchedListFixture {
  app: ElectronApplication
  page: Page
  userData: string
}

interface CaretSnapshot {
  bottom: number
  column: number
  head: number
  left: number
  line: number
  top: number
}

interface HorizontalInterval {
  left: number
  right: number
}

interface LineCaretCoordinate {
  bottom: number
  column: number
  left: number
  top: number
}

interface LineSelectionCoverage {
  bottomSpread: number
  intervals: HorizontalInterval[]
  line: number
  topSpread: number
}

interface SelectionCoverage {
  anchor: number
  head: number
  lane: HorizontalInterval
  lines: LineSelectionCoverage[]
}

async function launchListFixture(
  name: string,
  source: string,
  options: { definitionLists?: boolean } = {}
): Promise<LaunchedListFixture> {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), `pulse-md-${name}-e2e-`)
  )
  if (options.definitionLists) {
    const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
    settings.markdownExtensions.definitionLists = true
    await writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify(settings, null, 2)
    )
  }
  const documentPath = path.join(userData, `${name}.md`)
  await writeFile(documentPath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })
  const page = await app.firstWindow()
  await page.locator(".cm-editor").waitFor()
  return { app, page, userData }
}

async function closeListFixture({ app, userData }: LaunchedListFixture) {
  await exitApplication(app)
  await rm(userData, { force: true, recursive: true })
}

async function settleSelectionLayer(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function setCaret(page: Page, lineNumber: number, column: number) {
  await page.evaluate(
    ({ requestedColumn, requestedLine }) => {
      const view = (
        document.querySelector(".cm-content") as
          | (HTMLElement & {
              cmTile?: {
                view?: {
                  dispatch(spec: {
                    scrollIntoView?: boolean
                    selection: { anchor: number }
                  }): void
                  focus(): void
                  state: {
                    doc: {
                      line(lineNumber: number): {
                        from: number
                        length: number
                      }
                    }
                  }
                }
              }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const line = view.state.doc.line(requestedLine)
      if (requestedColumn < 0 || requestedColumn > line.length) {
        throw new Error(
          `Column ${requestedColumn} is outside line ${requestedLine}`
        )
      }
      view.dispatch({
        scrollIntoView: true,
        selection: { anchor: line.from + requestedColumn },
      })
      view.focus()
    },
    { requestedColumn: column, requestedLine: lineNumber }
  )
}

async function lineLength(page: Page, lineNumber: number) {
  return page.evaluate((requestedLine) => {
    const view = (
      document.querySelector(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  doc: {
                    line(lineNumber: number): { length: number }
                  }
                }
              }
            }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    return view.state.doc.line(requestedLine).length
  }, lineNumber)
}

async function caretSnapshot(page: Page): Promise<CaretSnapshot> {
  return page.evaluate(() => {
    const view = (
      document.querySelector(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                coordsAtPos(
                  position: number,
                  side?: number
                ): { bottom: number; left: number; top: number } | null
                state: {
                  doc: {
                    lineAt(position: number): {
                      from: number
                      number: number
                    }
                  }
                  selection: { main: { head: number } }
                }
              }
            }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const coordinates = view.coordsAtPos(head, 1)
    if (!coordinates) throw new Error(`Caret ${head} has no coordinates`)
    return {
      bottom: coordinates.bottom,
      column: head - line.from,
      head,
      left: coordinates.left,
      line: line.number,
      top: coordinates.top,
    }
  })
}

async function caretPoint(page: Page, lineNumber: number, column: number) {
  return page.evaluate(
    ({ requestedColumn, requestedLine }) => {
      const view = (
        document.querySelector(".cm-content") as
          | (HTMLElement & {
              cmTile?: {
                view?: {
                  coordsAtPos(
                    position: number,
                    side?: number
                  ): { bottom: number; left: number; top: number } | null
                  state: {
                    doc: {
                      line(lineNumber: number): { from: number; length: number }
                    }
                  }
                }
              }
            })
          | null
      )?.cmTile?.view
      if (!view) throw new Error("List line is unavailable")
      const line = view.state.doc.line(requestedLine)
      const coordinates = view.coordsAtPos(line.from + requestedColumn, 1)
      if (!coordinates)
        throw new Error("List caret coordinates are unavailable")
      return {
        x: coordinates.left,
        y: (coordinates.top + coordinates.bottom) / 2,
      }
    },
    { requestedColumn: column, requestedLine: lineNumber }
  )
}

async function lineCaretCoordinates(
  page: Page,
  lineNumber: number
): Promise<LineCaretCoordinate[]> {
  return page.evaluate((requestedLine) => {
    const view = (
      document.querySelector(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                coordsAtPos(
                  position: number,
                  side?: number
                ): { bottom: number; left: number; top: number } | null
                state: {
                  doc: {
                    line(lineNumber: number): {
                      from: number
                      length: number
                    }
                  }
                }
              }
            }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    const line = view.state.doc.line(requestedLine)
    return Array.from({ length: line.length + 1 }, (_, column) => {
      const coordinates = view.coordsAtPos(line.from + column, 1)
      if (!coordinates) throw new Error(`Column ${column} has no coordinates`)
      return {
        bottom: coordinates.bottom,
        column,
        left: coordinates.left,
        top: coordinates.top,
      }
    })
  }, lineNumber)
}

async function selectionState(page: Page) {
  return page.evaluate(() => {
    const view = (
      document.querySelector(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  doc: {
                    lineAt(position: number): { from: number; number: number }
                    sliceString(from: number, to: number): string
                  }
                  selection: {
                    main: {
                      anchor: number
                      from: number
                      head: number
                      to: number
                    }
                  }
                }
              }
            }
          })
        | null
    )?.cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    const selection = view.state.selection.main
    const headLine = view.state.doc.lineAt(selection.head)
    return {
      anchor: selection.anchor,
      column: selection.head - headLine.from,
      head: selection.head,
      line: headLine.number,
      text: view.state.doc.sliceString(selection.from, selection.to),
    }
  })
}

async function selectionCoverage(
  page: Page,
  lineNumbers: readonly number[]
): Promise<SelectionCoverage> {
  return page.evaluate((requestedLines) => {
    const content = document.querySelector<HTMLElement>(".cm-content")
    const view = (
      content as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  selection: { main: { anchor: number; head: number } }
                }
              }
            }
          })
        | null
    )?.cmTile?.view
    if (!content || !view) throw new Error("CodeMirror view is unavailable")
    const contentBounds = content.getBoundingClientRect()
    const contentStyle = getComputedStyle(content)
    const lane = {
      left: contentBounds.left + Number.parseFloat(contentStyle.paddingLeft),
      right: contentBounds.right - Number.parseFloat(contentStyle.paddingRight),
    }
    const selectionRectangles = [
      ...document.querySelectorAll<HTMLElement>(".cm-app-selectionBackground"),
    ].map((element) => element.getBoundingClientRect())

    const lines = requestedLines.map((lineNumber) => {
      const line =
        document.querySelectorAll<HTMLElement>(".cm-line")[lineNumber - 1]
      if (!line) throw new Error(`Line ${lineNumber} is unavailable`)
      const bounds = line.getBoundingClientRect()
      const center = (bounds.top + bounds.bottom) / 2
      const atCenter = selectionRectangles.filter(
        (rectangle) => rectangle.top <= center && rectangle.bottom >= center
      )
      const intervals = atCenter
        .map((rectangle) => ({ left: rectangle.left, right: rectangle.right }))
        .sort((left, right) => left.left - right.left)
        .reduce<HorizontalInterval[]>((merged, interval) => {
          const previous = merged.at(-1)
          if (previous && interval.left <= previous.right + 0.5) {
            previous.right = Math.max(previous.right, interval.right)
          } else {
            merged.push({ ...interval })
          }
          return merged
        }, [])
      const tops = atCenter.map((rectangle) => rectangle.top)
      const bottoms = atCenter.map((rectangle) => rectangle.bottom)
      return {
        bottomSpread:
          bottoms.length > 0 ? Math.max(...bottoms) - Math.min(...bottoms) : 0,
        intervals,
        line: lineNumber,
        topSpread: tops.length > 0 ? Math.max(...tops) - Math.min(...tops) : 0,
      }
    })

    return {
      anchor: view.state.selection.main.anchor,
      head: view.state.selection.main.head,
      lane,
      lines,
    }
  }, lineNumbers)
}

function expectCoverageClose(
  before: SelectionCoverage,
  after: SelectionCoverage
) {
  expect(after.anchor).toBe(before.anchor)
  expect(after.head).toBe(before.head)
  expect(after.lines).toHaveLength(before.lines.length)
  for (let index = 0; index < before.lines.length; index += 1) {
    const beforeLine = before.lines[index]!
    const afterLine = after.lines[index]!
    expect(afterLine.line).toBe(beforeLine.line)
    expect(afterLine.intervals).toHaveLength(beforeLine.intervals.length)
    for (
      let intervalIndex = 0;
      intervalIndex < beforeLine.intervals.length;
      intervalIndex += 1
    ) {
      const beforeInterval = beforeLine.intervals[intervalIndex]!
      const afterInterval = afterLine.intervals[intervalIndex]!
      expect(Math.abs(afterInterval.left - beforeInterval.left)).toBeLessThan(1)
      expect(Math.abs(afterInterval.right - beforeInterval.right)).toBeLessThan(
        1
      )
    }
  }
}

test("list arrows visit each source-mapped stop and skip only atomic checkboxes", async () => {
  const fixture = await launchListFixture(
    "list-arrows",
    [
      "1. parent",
      "   a. alpha",
      "   b. beta",
      "",
      "- parent",
      "  - beta",
      "",
      "- d1",
      "  - d2",
      "    - d3",
      "      - delta",
      "",
      "99) ninety-nine",
      "100) hundred",
      "",
      "- [ ] parent",
      "  - [x] beta",
      "",
      "1. [ ] alpha",
      "2. [x] beta",
      "",
      "123456. mixed root",
      "        - [ ] task child",
      "          - bullet child",
      "            123456. ordered child",
      "                    - deep",
      "",
      "- tab root",
      "\t- tab child",
      "\t\t- two tabs",
      "",
      "- > - inner",
      "  >   continuation",
      "",
      "    alpha",
      "",
      "-     code",
      "",
      "- ",
      "1. ",
    ].join("\n")
  )

  try {
    const cases = [
      { columns: [0, 1, 2, 3, 4, 5, 6, 7, 8], line: 3 },
      { columns: [0, 1, 2, 3, 4, 5, 6], line: 6 },
      { columns: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], line: 11 },
      { columns: [0, 1, 2, 3, 4, 5, 6, 7], line: 14 },
      { columns: [0, 1, 2, 8, 9, 10], line: 17 },
      { columns: [0, 1, 2, 3, 7, 8, 9], line: 20 },
      { columns: Array.from({ length: 25 }, (_, column) => column), line: 26 },
      { columns: [0, 1, 2, 3, 4, 5], line: 29 },
      { columns: [0, 1, 2, 3, 4, 5, 6], line: 30 },
      { columns: Array.from({ length: 12 }, (_, column) => column), line: 32 },
      { columns: Array.from({ length: 19 }, (_, column) => column), line: 33 },
      { columns: Array.from({ length: 10 }, (_, column) => column), line: 35 },
      { columns: Array.from({ length: 11 }, (_, column) => column), line: 37 },
      { columns: [0, 1, 2], line: 39 },
      { columns: [0, 1, 2, 3], line: 40 },
    ]

    for (const listCase of cases) {
      const previousLineLength = await lineLength(
        fixture.page,
        listCase.line - 1
      )
      await setCaret(fixture.page, listCase.line - 1, previousLineLength)
      const forward: CaretSnapshot[] = []
      for (const expectedColumn of listCase.columns) {
        await fixture.page.keyboard.press("ArrowRight")
        const snapshot = await caretSnapshot(fixture.page)
        expect(snapshot.line).toBe(listCase.line)
        expect(snapshot.column).toBe(expectedColumn)
        forward.push(snapshot)
      }
      for (let index = 1; index < forward.length; index += 1) {
        expect(forward[index]!.left).toBeGreaterThan(forward[index - 1]!.left)
      }

      const reverseColumns = listCase.columns.slice(0, -1).reverse()
      for (const expectedColumn of reverseColumns) {
        await fixture.page.keyboard.press("ArrowLeft")
        const snapshot = await caretSnapshot(fixture.page)
        const original = forward.find(
          (candidate) => candidate.column === expectedColumn
        )!
        expect(snapshot.line).toBe(listCase.line)
        expect(snapshot.column).toBe(expectedColumn)
        expect(Math.abs(snapshot.left - original.left)).toBeLessThan(0.75)
      }

      await fixture.page.keyboard.press("ArrowLeft")
      const previousLine = await caretSnapshot(fixture.page)
      expect(previousLine.line).toBe(listCase.line - 1)
      expect(previousLine.column).toBe(previousLineLength)
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("variable marker spacing retains a forward caret stop for every source unit", async () => {
  const fixture = await launchListFixture(
    "list-marker-spacing",
    [
      "- root",
      "-   three",
      "",
      "1. root",
      "2.    four",
      "",
      "- root",
      "-\ttabbed",
      "",
      "1. [ ] root",
      "2.    [x] task",
    ].join("\n")
  )

  try {
    const cases = [
      { columns: Array.from({ length: 10 }, (_, column) => column), line: 2 },
      { columns: Array.from({ length: 11 }, (_, column) => column), line: 5 },
      { columns: Array.from({ length: 9 }, (_, column) => column), line: 8 },
      {
        columns: [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14],
        line: 11,
      },
    ]

    for (const listCase of cases) {
      const previousLineLength = await lineLength(
        fixture.page,
        listCase.line - 1
      )
      await setCaret(fixture.page, listCase.line - 1, previousLineLength)
      let previous: CaretSnapshot | null = null
      for (const expectedColumn of listCase.columns) {
        await fixture.page.keyboard.press("ArrowRight")
        const snapshot = await caretSnapshot(fixture.page)
        expect(snapshot.line).toBe(listCase.line)
        expect(snapshot.column).toBe(expectedColumn)
        if (previous) {
          expect(
            snapshot.left,
            `line ${listCase.line}, column ${snapshot.column} must follow column ${previous.column}`
          ).toBeGreaterThan(previous.left)
        }
        previous = snapshot
      }
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("cold list-marker clicks resolve to the same source positions as warm clicks", async () => {
  const fixture = await launchListFixture(
    "list-clicks",
    [
      "1. parent",
      "   a. alpha",
      "   b. bravo",
      "",
      "- root",
      "  - child",
      "    - bravo",
    ].join("\n")
  )

  try {
    const cases = [
      { contentColumn: 6, line: 3, markerColumn: 3 },
      { contentColumn: 6, line: 7, markerColumn: 4 },
    ]
    for (const listCase of cases) {
      const line = fixture.page.locator(".cm-line").nth(listCase.line - 1)
      const marker = line.locator(".cm-md-list-marker-source")
      const separator = line.locator(".cm-md-list-marker-separator-source")
      const coldColumns: number[] = []
      for (const fraction of [0.1, 0.35, 0.65, 0.95]) {
        await setCaret(fixture.page, 1, 0)
        await settleSelectionLayer(fixture.page)
        await expect(marker).toHaveClass(/cm-md-list-marker-rendered/)
        const coldMarkerBounds = await marker.boundingBox()
        const coldSeparatorBounds = await separator.boundingBox()
        if (!coldMarkerBounds || !coldSeparatorBounds) {
          throw new Error("Cold marker bounds are unavailable")
        }
        const coldLeft = Math.min(coldMarkerBounds.x, coldSeparatorBounds.x)
        const coldRight = Math.max(
          coldMarkerBounds.x + coldMarkerBounds.width,
          coldSeparatorBounds.x + coldSeparatorBounds.width
        )
        const x = coldLeft + (coldRight - coldLeft) * fraction
        const y = coldMarkerBounds.y + coldMarkerBounds.height / 2
        await fixture.page.mouse.click(x, y)
        const cold = await caretSnapshot(fixture.page)
        expect(cold.line).toBe(listCase.line)

        await settleSelectionLayer(fixture.page)
        const warmMarkerBounds = await marker.boundingBox()
        const warmSeparatorBounds = await separator.boundingBox()
        if (!warmMarkerBounds || !warmSeparatorBounds) {
          throw new Error("Warm marker bounds are unavailable")
        }
        expect(Math.abs(warmMarkerBounds.x - coldMarkerBounds.x)).toBeLessThan(
          0.75
        )
        expect(
          Math.abs(warmMarkerBounds.width - coldMarkerBounds.width)
        ).toBeLessThan(0.75)
        expect(
          Math.abs(warmSeparatorBounds.x - coldSeparatorBounds.x)
        ).toBeLessThan(0.75)
        expect(
          Math.abs(warmSeparatorBounds.width - coldSeparatorBounds.width)
        ).toBeLessThan(0.75)
        await fixture.page.mouse.click(x, y)
        const warm = await caretSnapshot(fixture.page)
        expect(warm.line).toBe(listCase.line)
        expect(warm.column).toBe(cold.column)
        expect(Math.abs(warm.left - cold.left)).toBeLessThan(0.75)
        coldColumns.push(cold.column)
      }

      expect(coldColumns[0]).toBeGreaterThanOrEqual(listCase.markerColumn)
      expect(coldColumns.at(-1)).toBe(listCase.contentColumn)
      expect(coldColumns).toEqual(
        [...coldColumns].sort((left, right) => left - right)
      )

      await setCaret(fixture.page, 1, 0)
      const lineBounds = await line.boundingBox()
      const markerBounds = await marker.boundingBox()
      if (!lineBounds || !markerBounds)
        throw new Error("List bounds are unavailable")
      await fixture.page.mouse.click(
        lineBounds.x + 1,
        markerBounds.y + markerBounds.height / 2
      )
      const farLeft = await caretSnapshot(fixture.page)
      expect(farLeft.line).toBe(listCase.line)
      expect(farLeft.column).toBe(0)
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("quoted list prefixes keep every caret coordinate stable when activated", async () => {
  const fixture = await launchListFixture(
    "quoted-list-prefixes",
    [
      "intro",
      "> 1. alpha",
      "> 2. beta",
      "",
      "> - root",
      ">    - child",
      "",
      "> > 1. nested",
      "> > 2. beta",
    ].join("\n")
  )

  try {
    for (const lineNumber of [2, 6, 9]) {
      await setCaret(fixture.page, 1, 0)
      await settleSelectionLayer(fixture.page)
      const line = fixture.page.locator(".cm-line").nth(lineNumber - 1)
      const quote = line.locator(".cm-md-list-quote-prefix-source")
      const marker = line.locator(".cm-md-list-marker-source")
      await expect(quote).toHaveClass(/cm-md-list-quote-prefix-rendered/)
      const cold = await lineCaretCoordinates(fixture.page, lineNumber)
      for (let column = 1; column < cold.length; column += 1) {
        expect(cold[column]!.left).toBeGreaterThan(cold[column - 1]!.left)
      }

      const markerBounds = await marker.boundingBox()
      if (!markerBounds) throw new Error("Quoted marker bounds are unavailable")
      await fixture.page.mouse.click(
        markerBounds.x + markerBounds.width / 2,
        markerBounds.y + markerBounds.height / 2
      )
      const clicked = await caretSnapshot(fixture.page)
      expect(clicked.line).toBe(lineNumber)
      await settleSelectionLayer(fixture.page)
      const markerActive = await lineCaretCoordinates(fixture.page, lineNumber)

      await setCaret(fixture.page, lineNumber, 1)
      await settleSelectionLayer(fixture.page)
      await expect(quote).not.toHaveClass(/cm-md-list-quote-prefix-rendered/)
      const quoteActive = await lineCaretCoordinates(fixture.page, lineNumber)

      for (let column = 0; column < cold.length; column += 1) {
        expect(
          Math.abs(markerActive[column]!.left - cold[column]!.left)
        ).toBeLessThan(0.75)
        expect(
          Math.abs(quoteActive[column]!.left - cold[column]!.left)
        ).toBeLessThan(0.75)
      }
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("authored continuations inherit their owning list content column", async () => {
  const fixture = await launchListFixture(
    "list-continuation-columns",
    [
      "- outer",
      "  - inner",
      "    continuation",
      "",
      "1. outer",
      "   1. inner",
      "      continuation",
      "",
      "- > - inner",
      "  >   continuation",
      "",
      "> - > - inner",
      ">   >   continuation",
    ].join("\n")
  )

  try {
    for (const { continuation, continuationColumn, item, itemColumn } of [
      { continuation: 3, continuationColumn: 4, item: 2, itemColumn: 4 },
      { continuation: 7, continuationColumn: 6, item: 6, itemColumn: 6 },
      { continuation: 10, continuationColumn: 6, item: 9, itemColumn: 6 },
      { continuation: 13, continuationColumn: 8, item: 12, itemColumn: 8 },
    ]) {
      const itemX = (await lineCaretCoordinates(fixture.page, item))[
        itemColumn
      ]!.left
      const continuationX = (
        await lineCaretCoordinates(fixture.page, continuation)
      )[continuationColumn]!.left
      expect(Math.abs(continuationX - itemX)).toBeLessThan(1)
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("wide ordered siblings align and list prefixes retain distinct RTL stops", async () => {
  const fixture = await launchListFixture(
    "ordered-list-lanes-and-rtl",
    ["1. one", "999999999. nine", "2. two", "", "12. שלום", "- שלום"].join("\n")
  )

  try {
    const contentColumns = [3, 11, 3]
    const contentCoordinates = await Promise.all(
      contentColumns.map(
        async (column, index) =>
          (await lineCaretCoordinates(fixture.page, index + 1))[column]!.left
      )
    )
    expect(
      Math.max(...contentCoordinates) - Math.min(...contentCoordinates)
    ).toBeLessThan(1)

    await fixture.page.evaluate(() => {
      const content = document.querySelector<HTMLElement>(".cm-content")
      const view = (
        content as
          | (HTMLElement & { cmTile?: { view?: { requestMeasure(): void } } })
          | null
      )?.cmTile?.view
      if (!content || !view) throw new Error("CodeMirror view is unavailable")
      content.dir = "rtl"
      content.style.direction = "rtl"
      view.requestMeasure()
    })
    await settleSelectionLayer(fixture.page)

    for (const { columns, line } of [
      { columns: [0, 1, 2, 3, 4], line: 5 },
      { columns: [0, 1, 2], line: 6 },
    ]) {
      const coordinates = await lineCaretCoordinates(fixture.page, line)
      for (let index = 1; index < columns.length; index += 1) {
        expect(
          Math.abs(
            coordinates[columns[index]!]!.left -
              coordinates[columns[index - 1]!]!.left
          ),
          `line ${line} columns ${columns[index - 1]} and ${columns[index]}`
        ).toBeGreaterThan(0.75)
      }
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("definition-list prefixes preserve arrow, click, and selection geometry", async () => {
  const fixture = await launchListFixture(
    "definition-list-interactions",
    ["Term", ":   alpha", "", "Term two", "  ~\tbeta"].join("\n"),
    { definitionLists: true }
  )

  try {
    for (const lineNumber of [2, 5]) {
      const length = await lineLength(fixture.page, lineNumber)
      const previousLength = await lineLength(fixture.page, lineNumber - 1)
      await setCaret(fixture.page, lineNumber - 1, previousLength)
      const forward: CaretSnapshot[] = []
      for (let column = 0; column <= length; column += 1) {
        await fixture.page.keyboard.press("ArrowRight")
        const snapshot = await caretSnapshot(fixture.page)
        expect(snapshot.line).toBe(lineNumber)
        expect(snapshot.column).toBe(column)
        if (forward.length > 0) {
          expect(snapshot.left).toBeGreaterThan(forward.at(-1)!.left)
        }
        forward.push(snapshot)
      }

      await setCaret(fixture.page, 1, 0)
      await settleSelectionLayer(fixture.page)
      const line = fixture.page.locator(".cm-line").nth(lineNumber - 1)
      const marker = line.locator(".cm-md-definition-source-mark")
      const separator = line.locator(".cm-md-definition-separator-source")
      const markerBounds = await marker.boundingBox()
      const separatorBounds = await separator.boundingBox()
      if (!markerBounds || !separatorBounds) {
        throw new Error("Definition prefix bounds are unavailable")
      }
      const x =
        Math.min(markerBounds.x, separatorBounds.x) +
        (Math.max(
          markerBounds.x + markerBounds.width,
          separatorBounds.x + separatorBounds.width
        ) -
          Math.min(markerBounds.x, separatorBounds.x)) *
          0.7
      const y = markerBounds.y + markerBounds.height / 2
      await fixture.page.mouse.click(x, y)
      const cold = await caretSnapshot(fixture.page)
      expect(cold.line).toBe(lineNumber)
      await settleSelectionLayer(fixture.page)
      await fixture.page.mouse.click(x, y)
      const warm = await caretSnapshot(fixture.page)
      expect(warm.column).toBe(cold.column)
      expect(Math.abs(warm.left - cold.left)).toBeLessThan(0.75)

      await setCaret(fixture.page, lineNumber, length)
      for (let column = length - 1; column >= 0; column -= 1) {
        await fixture.page.keyboard.press("Shift+ArrowLeft")
        const selection = await selectionState(fixture.page)
        expect(selection.column).toBe(column)
      }
      await settleSelectionLayer(fixture.page)
      const coverage = await selectionCoverage(fixture.page, [lineNumber])
      expect(coverage.lines[0]!.topSpread).toBeLessThan(1)
      expect(coverage.lines[0]!.bottomSpread).toBeLessThan(1)
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("held drags keep virtualized ordinary and task prefixes projected", async () => {
  const lines = Array.from({ length: 320 }, (_, index) => `- item ${index + 1}`)
  lines.push("- ordinary tail", "- [ ] task tail")
  const fixture = await launchListFixture(
    "virtualized-list-pointer-selection",
    lines.join("\n")
  )

  try {
    await fixture.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 520)
    })
    const anchor = await caretPoint(fixture.page, 1, 2)
    await fixture.page.mouse.move(anchor.x, anchor.y)
    await fixture.page.mouse.down()

    const scroller = fixture.page.locator(".cm-scroller")
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const ordinaryLine = fixture.page
      .locator(".cm-line")
      .filter({ hasText: "ordinary tail" })
    const taskLine = fixture.page
      .locator(".cm-line")
      .filter({ hasText: "task tail" })
    await ordinaryLine.waitFor()
    await taskLine.waitFor()
    await expect(ordinaryLine.locator(".cm-md-list-marker-source")).toHaveCount(
      1
    )
    await expect(
      ordinaryLine.locator(".cm-md-list-marker-separator-source")
    ).toHaveCount(1)
    await expect(taskLine.locator(".cm-md-task-checkbox-lane")).toHaveCount(1)

    const taskLineNumber = lines.length
    const taskLength = await lineLength(fixture.page, taskLineNumber)
    const target = await caretPoint(fixture.page, taskLineNumber, taskLength)
    await fixture.page.mouse.move(target.x, target.y, { steps: 12 })
    // Exercise a viewport refresh after the selection has expanded. Without
    // the pointer-down presentation snapshot, the remounted marker is rebuilt
    // from the moving selection and incorrectly reveals its source.
    await scroller.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.scrollTop = 0
          requestAnimationFrame(() => {
            element.scrollTop = element.scrollHeight
            requestAnimationFrame(() => resolve())
          })
        })
    )
    await settleSelectionLayer(fixture.page)
    const whileDown = await caretSnapshot(fixture.page)
    expect(whileDown.line).toBe(taskLineNumber)
    expect(whileDown.column).toBeGreaterThanOrEqual(6)
    const heldOrdinaryMarker = ordinaryLine.locator(".cm-md-list-marker-source")
    await expect(heldOrdinaryMarker).toHaveClass(/cm-md-list-marker-rendered/)
    expect(
      await heldOrdinaryMarker.evaluate(
        (element) => getComputedStyle(element, "::selection").color
      )
    ).toBe("rgba(0, 0, 0, 0)")

    await fixture.page.mouse.up()
    await settleSelectionLayer(fixture.page)
    const afterRelease = await caretSnapshot(fixture.page)
    expect(afterRelease.head).toBe(whileDown.head)
    expect(Math.abs(afterRelease.left - whileDown.left)).toBeLessThan(0.75)
    await expect(heldOrdinaryMarker).not.toHaveClass(
      /cm-md-list-marker-rendered/
    )
    await expect(ordinaryLine.locator(".cm-md-list-marker-source")).toHaveCount(
      1
    )
    await expect(taskLine.locator(".cm-md-task-checkbox-lane")).toHaveCount(1)
  } finally {
    await closeListFixture(fixture)
  }
})

test("keyboard list selections paint only the selected source in one visual band", async () => {
  const fixture = await launchListFixture(
    "list-keyboard-selection",
    [
      "1. parent",
      "   a. alpha",
      "   b. bravo",
      "- root",
      "  - alpha",
      "    - bravo",
      "",
      "123456. mixed root",
      "        - [ ] task child",
      "          - bullet child",
      "            123456. ordered child",
      "                    - deep bravo",
    ].join("\n")
  )

  try {
    const cases = [
      { line: 3, source: "   b. bravo" },
      { line: 6, source: "    - bravo" },
      { line: 12, source: "                    - deep bravo" },
    ]
    for (const listCase of cases) {
      await setCaret(fixture.page, listCase.line, listCase.source.length)
      for (let head = listCase.source.length - 1; head >= 0; head -= 1) {
        await fixture.page.keyboard.press("Shift+ArrowLeft")
        await settleSelectionLayer(fixture.page)
        const selection = await selectionState(fixture.page)
        expect(selection.line).toBe(listCase.line)
        expect(selection.column).toBe(head)
        expect(selection.text).toBe(listCase.source.slice(head))
        const coverage = await selectionCoverage(fixture.page, [listCase.line])
        const lineCoverage = coverage.lines[0]!
        expect(lineCoverage.intervals.length).toBeGreaterThan(0)
        expect(lineCoverage.topSpread).toBeLessThan(1)
        expect(lineCoverage.bottomSpread).toBeLessThan(1)
        const selectedLeft = Math.min(
          ...lineCoverage.intervals.map((interval) => interval.left)
        )
        const selectedRight = Math.max(
          ...lineCoverage.intervals.map((interval) => interval.right)
        )
        expect(
          selectedLeft <= coverage.lane.left + 1 &&
            selectedRight >= coverage.lane.right - 1
        ).toBe(false)
      }

      await setCaret(fixture.page, listCase.line, 0)
      for (let head = 1; head <= listCase.source.length; head += 1) {
        await fixture.page.keyboard.press("Shift+ArrowRight")
        const selection = await selectionState(fixture.page)
        expect(selection.line).toBe(listCase.line)
        expect(selection.column).toBe(head)
        expect(selection.text).toBe(listCase.source.slice(0, head))
      }
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("atomic task selections paint the checkbox's complete source lane", async () => {
  const fixture = await launchListFixture(
    "task-prefix-selection",
    ["- [ ] parent", "  - [x] beta", "", "1. [ ] alpha", "2. [x] beta"].join(
      "\n"
    )
  )

  try {
    const cases = [
      { atomEnd: 8, heads: [1, 2, 8], line: 2 },
      { atomEnd: 7, heads: [1, 2, 3, 7], line: 5 },
    ]
    for (const listCase of cases) {
      const coordinates = await lineCaretCoordinates(
        fixture.page,
        listCase.line
      )
      await setCaret(fixture.page, listCase.line, 0)
      for (const expectedHead of listCase.heads) {
        await fixture.page.keyboard.press("Shift+ArrowRight")
        const selection = await selectionState(fixture.page)
        expect(selection.column).toBe(expectedHead)
      }
      await settleSelectionLayer(fixture.page)
      const atomCoverage = await selectionCoverage(fixture.page, [
        listCase.line,
      ])
      const atomIntervals = atomCoverage.lines[0]!.intervals
      expect(atomIntervals).toHaveLength(1)
      expect(
        Math.abs(
          atomIntervals[0]!.left -
            Math.max(coordinates[0]!.left, atomCoverage.lane.left)
        )
      ).toBeLessThan(1)
      expect(
        Math.abs(atomIntervals[0]!.right - coordinates[listCase.atomEnd]!.left)
      ).toBeLessThan(1)

      await fixture.page.keyboard.press("Shift+ArrowRight")
      await settleSelectionLayer(fixture.page)
      const contentCoverage = await selectionCoverage(fixture.page, [
        listCase.line,
      ])
      const contentIntervals = contentCoverage.lines[0]!.intervals
      expect(contentIntervals).toHaveLength(1)
      expect(contentIntervals[0]!.right).toBeGreaterThan(
        coordinates[listCase.atomEnd]!.left
      )
    }
  } finally {
    await closeListFixture(fixture)
  }
})

test("upward list drags keep endpoint and highlight geometry through mouseup", async () => {
  const fixture = await launchListFixture(
    "list-pointer-selection",
    [
      "1. root",
      "   a. alpha",
      "   b. bravo",
      "   c. charlie",
      "",
      "- root",
      "  - alpha",
      "  - bravo",
      "  - charlie",
    ].join("\n")
  )

  try {
    const cases = [
      { anchorColumn: 8, anchorLine: 4, lines: [2, 3, 4] },
      { anchorColumn: 6, anchorLine: 9, lines: [7, 8, 9] },
    ]
    for (const listCase of cases) {
      await setCaret(fixture.page, 1, 0)
      const anchor = await caretPoint(
        fixture.page,
        listCase.anchorLine,
        listCase.anchorColumn
      )
      const headLine = fixture.page
        .locator(".cm-line")
        .nth(listCase.lines[0]! - 1)
      const headBounds = await headLine.boundingBox()
      if (!headBounds) throw new Error("Drag head line is unavailable")

      await fixture.page.mouse.move(anchor.x, anchor.y)
      await fixture.page.mouse.down()
      await fixture.page.mouse.move(
        headBounds.x + 1,
        headBounds.y + headBounds.height / 2,
        { steps: 12 }
      )
      await settleSelectionLayer(fixture.page)
      const whileDown = await selectionCoverage(fixture.page, listCase.lines)
      const whileDownState = await selectionState(fixture.page)
      expect(whileDownState.line).toBe(listCase.lines[0])
      expect(whileDownState.column).toBe(0)

      await fixture.page.mouse.up()
      await settleSelectionLayer(fixture.page)
      const afterRelease = await selectionCoverage(fixture.page, listCase.lines)
      expectCoverageClose(whileDown, afterRelease)

      for (const endpointIndex of [0, 2]) {
        const endpoint = afterRelease.lines[endpointIndex]!
        expect(endpoint.topSpread).toBeLessThan(1)
        expect(endpoint.bottomSpread).toBeLessThan(1)
        const left = Math.min(
          ...endpoint.intervals.map((interval) => interval.left)
        )
        const right = Math.max(
          ...endpoint.intervals.map((interval) => interval.right)
        )
        expect(
          left <= afterRelease.lane.left + 1 &&
            right >= afterRelease.lane.right - 1
        ).toBe(false)
      }

      const interior = afterRelease.lines[1]!
      expect(interior.intervals).toHaveLength(1)
      expect(
        Math.abs(interior.intervals[0]!.left - afterRelease.lane.left)
      ).toBeLessThan(1)
      expect(
        Math.abs(interior.intervals[0]!.right - afterRelease.lane.right)
      ).toBeLessThan(1)
    }
  } finally {
    await closeListFixture(fixture)
  }
})
