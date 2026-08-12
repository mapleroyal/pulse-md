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

async function settleSelectionLayer(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function selectionGeometry(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".cm-content")
    const scroller = document.querySelector<HTMLElement>(".cm-scroller")
    const firstLine = content?.querySelector<HTMLElement>(".cm-line")
    if (!content || !scroller || !firstLine) return null

    const contentRect = content.getBoundingClientRect()
    const contentStyle = getComputedStyle(content)
    const firstLineStyle = getComputedStyle(firstLine)
    const laneLeft =
      contentRect.left + Number.parseFloat(contentStyle.paddingLeft)
    const inferredLeft =
      contentRect.left +
      (Number.parseInt(firstLineStyle.paddingLeft, 10) || 0) +
      Math.min(0, Number.parseInt(firstLineStyle.textIndent, 10) || 0)
    const markers = [
      ...document.querySelectorAll<HTMLElement>(".cm-app-selectionBackground"),
    ].map((marker) => marker.getBoundingClientRect())
    if (markers.length === 0) return null

    const top = Math.min(...markers.map((marker) => marker.top))
    const topMarkers = markers.filter(
      (marker) => Math.abs(marker.top - top) <= 0.5
    )
    const scrollerRect = scroller.getBoundingClientRect()
    const centerY = scrollerRect.top + scroller.clientHeight / 2
    const centerMarker = markers.find(
      (marker) => marker.top <= centerY && marker.bottom >= centerY
    )

    return {
      centerLeft: centerMarker?.left ?? null,
      firstDepthTwo: firstLine.classList.contains("cm-md-list-depth-2"),
      inferredLeft,
      laneLeft,
      topLeft: Math.min(...topMarkers.map((marker) => marker.left)),
    }
  })
}

async function textBoundary(line: ReturnType<Page["locator"]>, offset: number) {
  return line.evaluate((element, requestedOffset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = requestedOffset
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        const range = document.createRange()
        const localOffset = Math.min(remaining, length)
        if (localOffset < length) {
          range.setStart(node, localOffset)
          range.setEnd(node, localOffset + 1)
          const rect = range.getBoundingClientRect()
          return {
            x: rect.left,
            y: rect.top + rect.height / 2,
          }
        }

        range.setStart(node, localOffset)
        range.setEnd(node, localOffset)
        const rect = range.getBoundingClientRect()
        return {
          x: rect.right,
          y:
            element.getBoundingClientRect().top +
            element.getBoundingClientRect().height / 2,
        }
      }
      remaining -= length
      node = walker.nextNode()
    }
    throw new Error(`Text offset ${requestedOffset} is outside the line`)
  }, offset)
}

async function textCharacterRect(
  line: ReturnType<Page["locator"]>,
  offset: number
) {
  return line.evaluate((element, requestedOffset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = requestedOffset
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining < length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.setEnd(node, remaining + 1)
        const rect = range.getBoundingClientRect()
        return {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        }
      }
      remaining -= length
      node = walker.nextNode()
    }
    throw new Error(`Character offset ${requestedOffset} is outside the line`)
  }, offset)
}

async function optionShiftClick(page: Page, point: { x: number; y: number }) {
  await page.keyboard.down("Alt")
  await page.keyboard.down("Shift")
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up("Shift")
  await page.keyboard.up("Alt")
}

async function wrappedVisualRows(line: ReturnType<Page["locator"]>) {
  return line.evaluate((element) => {
    const rows: Array<{
      bottom: number
      end: number
      start: number
      top: number
    }> = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let documentOffset = 0
    let node = walker.nextNode()
    while (node) {
      const length = node.textContent?.length ?? 0
      for (let offset = 0; offset < length; offset += 1) {
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        const rect = range.getBoundingClientRect()
        let row = rows.at(-1)
        if (!row || Math.abs(row.top - rect.top) > 0.5) {
          row = {
            bottom: rect.bottom,
            end: documentOffset + offset + 1,
            start: documentOffset + offset,
            top: rect.top,
          }
          rows.push(row)
        } else {
          row.bottom = Math.max(row.bottom, rect.bottom)
          row.end = documentOffset + offset + 1
        }
      }
      documentOffset += length
      node = walker.nextNode()
    }
    return rows
  })
}

async function editorOffsetsAtVisualRows(
  page: Page,
  line: ReturnType<Page["locator"]>,
  rows: readonly { bottom: number; top: number }[],
  firstX: number,
  secondX: number,
  originalText: string
) {
  const marker = "§"
  const offsetAt = async (x: number, y: number) => {
    await page.mouse.click(x, y)
    await page.keyboard.insertText(marker)
    await expect(line).toContainText(marker)
    const changedText = (await line.textContent()) ?? ""
    const offset = changedText.indexOf(marker)
    expect(offset).toBeGreaterThanOrEqual(0)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(line).toHaveText(originalText)
    return offset
  }

  const offsets: Array<{ first: number; second: number }> = []
  for (const row of rows) {
    const y = (row.top + row.bottom) / 2
    offsets.push({
      first: await offsetAt(firstX, y),
      second: await offsetAt(secondX, y),
    })
  }
  return offsets
}

test("rendered table drags select cell ranges while clicks edit immediately @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-selection-e2e-")
  )
  const documentPath = path.join(userData, "table-selection.md")
  await writeFile(
    documentPath,
    [
      "| A | B | C |",
      "|---|---|---|",
      "| one | two | three |",
      "| four | five | six |",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const rows = page.locator(".cm-md-table-row")
    await expect(rows).toHaveCount(2)
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()

    const firstRowCells = rows.nth(0).locator(":scope > .cm-md-table-cell")
    const secondCell = firstRowCells.nth(1)
    const secondCellCursor = await textBoundary(secondCell, 1)
    await page.mouse.click(secondCellCursor.x, secondCellCursor.y)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await page.keyboard.type("!")
    await expect(secondCell).toHaveText("t!wo")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(secondCell).toHaveText("two")

    const anchorCell = firstRowCells.nth(0)
    const headCell = rows.nth(1).locator(":scope > .cm-md-table-cell").nth(1)
    const [anchorCursor, headBounds] = await Promise.all([
      textBoundary(anchorCell, 1),
      headCell.boundingBox(),
    ])
    if (!headBounds) {
      throw new Error("The table range endpoints are missing")
    }
    await page.mouse.move(anchorCursor.x, anchorCursor.y)
    await page.mouse.down()
    await page.mouse.move(
      headBounds.x + headBounds.width / 2,
      headBounds.y + headBounds.height / 2,
      { steps: 8 }
    )
    await page.mouse.up()

    const selectedCells = page.locator(".cm-md-table-cell-selected")
    await expect(selectedCells).toHaveCount(4)
    await expect(selectedCells).toHaveText(["one", "two", "four", "five"])
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.isCollapsed))
      .toBe(true)
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()

    await page.keyboard.press("Escape")
    await expect(selectedCells).toHaveCount(0)
    await expect(editor).toHaveClass(/cm-focused/)

    await page.mouse.move(anchorCursor.x, anchorCursor.y)
    await page.mouse.down()
    await page.mouse.move(
      headBounds.x + headBounds.width / 2,
      headBounds.y + headBounds.height / 2,
      { steps: 8 }
    )
    await page.mouse.up()
    await expect(selectedCells).toHaveCount(4)

    await page.keyboard.type("Z")
    await expect(page.locator(".cm-md-table-cell-selected")).toHaveCount(0)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await expect(anchorCell).toContainText("Z")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("rendered table ranges copy, cut, and keep their context menu", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-clipboard-e2e-")
  )
  const documentPath = path.join(userData, "table-clipboard.md")
  await writeFile(
    documentPath,
    [
      "| Column A | Column B | Column C |",
      "|---|---|---|",
      "| one | two | three |",
      "| four | five | six |",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const headerCells = page
      .locator(".cm-md-table-header")
      .locator(":scope > .cm-md-table-cell")
    const rows = page.locator(".cm-md-table-row")
    const anchorCell = headerCells.nth(1)
    const headCell = rows.nth(1).locator(":scope > .cm-md-table-cell").nth(2)
    await expect
      .poll(() =>
        headerCells.first().evaluate((cell) => ({
          overflowWrap: getComputedStyle(cell).overflowWrap,
          wordBreak: getComputedStyle(cell).wordBreak,
        }))
      )
      .toEqual({ overflowWrap: "normal", wordBreak: "normal" })
    const [anchor, headBounds] = await Promise.all([
      textBoundary(anchorCell, 1),
      headCell.boundingBox(),
    ])
    if (!headBounds) throw new Error("The table range endpoints are missing")

    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.move(
      headBounds.x + headBounds.width / 2,
      headBounds.y + headBounds.height / 2,
      { steps: 8 }
    )
    await page.mouse.up()

    const selectedCells = page.locator(".cm-md-table-cell-selected")
    await expect(selectedCells).toHaveCount(6)
    await expect(selectedCells).toHaveText([
      "Column B",
      "Column C",
      "two",
      "three",
      "five",
      "six",
    ])

    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const clipboardText = [
      "| Column B | Column C |",
      "| --- | --- |",
      "| two | three |",
      "| five | six |",
    ].join("\n")
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.keyboard.press(`${primary}+C`)
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(clipboardText)
    await expect(selectedCells).toHaveCount(6)

    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.keyboard.press(`${primary}+X`)
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(clipboardText)
    await expect(headerCells).toHaveText(["Column A", "", ""])
    await expect(page.locator(".cm-editor")).not.toHaveClass(
      /cm-md-caret-hidden/
    )
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await page.keyboard.press(`${primary}+Z`)
    await expect(headerCells).toHaveText(["Column A", "Column B", "Column C"])

    const [restoredAnchor, restoredHeadBounds] = await Promise.all([
      textBoundary(anchorCell, 1),
      headCell.boundingBox(),
    ])
    if (!restoredHeadBounds) {
      throw new Error("The restored table range endpoints are missing")
    }
    await page.mouse.move(restoredAnchor.x, restoredAnchor.y)
    await page.mouse.down()
    await page.mouse.move(
      restoredHeadBounds.x + restoredHeadBounds.width / 2,
      restoredHeadBounds.y + restoredHeadBounds.height / 2,
      { steps: 8 }
    )
    await page.mouse.up()
    await expect(selectedCells).toHaveCount(6)

    const selectedTextRect = await textCharacterRect(selectedCells.first(), 2)
    await page.mouse.click(
      (selectedTextRect.left + selectedTextRect.right) / 2,
      (selectedTextRect.top + selectedTextRect.bottom) / 2,
      { button: "right" }
    )
    await expect(selectedCells).toHaveCount(6)
    const menu = page.getByRole("menu", { name: "Editor context menu" })
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute(
      "data-editor-context-menu",
      "table-range"
    )
    await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeEnabled()
    await expect(
      menu.getByRole("menuitem", { name: "Formatting", exact: true })
    ).toHaveCount(0)
    const cut = menu.getByRole("menuitem", { name: /^Cut/ })
    await expect(cut).toBeEnabled()
    await cut.click()

    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(clipboardText)
    await expect(page.locator(".cm-md-table-cell-selected")).toHaveCount(0)
    await expect(headerCells).toHaveText(["Column A", "", ""])
    await expect(rows.nth(0).locator(":scope > .cm-md-table-cell")).toHaveText([
      "one",
      "",
      "",
    ])
    await expect(rows.nth(1).locator(":scope > .cm-md-table-cell")).toHaveText([
      "four",
      "",
      "",
    ])

    const emptyCell = rows.nth(0).locator(":scope > .cm-md-table-cell").nth(1)
    const emptyBounds = await emptyCell.boundingBox()
    if (!emptyBounds) throw new Error("The empty table cell is missing")
    const emptyStartX = emptyBounds.x + Math.min(8, emptyBounds.width / 4)
    const emptyEndX = Math.min(
      emptyBounds.x + emptyBounds.width - 2,
      emptyStartX + 8
    )
    const emptyY = emptyBounds.y + emptyBounds.height / 2
    await page.mouse.move(emptyStartX, emptyY)
    await page.mouse.down()
    await page.mouse.move(emptyEndX, emptyY, { steps: 4 })
    await page.mouse.up()
    await expect(selectedCells).toHaveCount(1)
    await emptyCell.click({ button: "right" })
    await expect(menu).toHaveAttribute(
      "data-editor-context-menu",
      "table-range"
    )
    await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeEnabled()
    await expect(menu.getByRole("menuitem", { name: /^Cut/ })).toBeEnabled()
    await page.keyboard.press("Escape")
    await expect(menu).not.toBeVisible()

    await page.keyboard.press(`${primary}+S`)
    await expect
      .poll(() => readFile(documentPath, "utf8"))
      .toBe(
        [
          "| Column A |  |  |",
          "|---|---|---|",
          "| one |  |  |",
          "| four |  |  |",
        ].join("\n")
      )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a copied table range pastes as cells and expands the destination table", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-paste-e2e-")
  )
  const documentPath = path.join(userData, "table-paste.md")
  await writeFile(
    documentPath,
    ["| A | B |", "|---|---|", "| one | two |", "| three | four |"].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const rows = page.locator(".cm-md-table-row")
    const firstCell = rows.nth(0).locator(":scope > .cm-md-table-cell").nth(0)
    const lastCell = rows.nth(1).locator(":scope > .cm-md-table-cell").nth(1)
    const [anchor, headBounds] = await Promise.all([
      textBoundary(firstCell, 1),
      lastCell.boundingBox(),
    ])
    if (!headBounds) throw new Error("The table range endpoints are missing")

    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.move(
      headBounds.x + headBounds.width / 2,
      headBounds.y + headBounds.height / 2,
      { steps: 8 }
    )
    await page.mouse.up()
    await expect(page.locator(".cm-md-table-cell-selected")).toHaveCount(4)

    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const clipboardText = [
      "| one | two |",
      "| --- | --- |",
      "| three | four |",
    ].join("\n")
    await page.keyboard.press(`${primary}+C`)
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(clipboardText)

    const destination = await textBoundary(lastCell, 2)
    await page.mouse.click(destination.x, destination.y)
    await expect(page.locator(".cm-md-table-cell-selected")).toHaveCount(0)
    await page.keyboard.press(`${primary}+V`)

    const headerCells = page
      .locator(".cm-md-table-header")
      .locator(":scope > .cm-md-table-cell")
    await expect(headerCells).toHaveText(["A", "B", ""])
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).locator(":scope > .cm-md-table-cell")).toHaveText([
      "one",
      "two",
      "",
    ])
    await expect(rows.nth(1).locator(":scope > .cm-md-table-cell")).toHaveText([
      "three",
      "one",
      "two",
    ])
    await expect(rows.nth(2).locator(":scope > .cm-md-table-cell")).toHaveText([
      "",
      "three",
      "four",
    ])
    await expect(page.locator(".cm-editor")).not.toHaveClass(
      /cm-md-caret-hidden/
    )
    await expect(page.locator(".cm-cursor").first()).toBeVisible()

    await page.keyboard.press(`${primary}+S`)
    await expect
      .poll(() => readFile(documentPath, "utf8"))
      .toBe(
        [
          "| A | B |  |",
          "| --- | --- | --- |",
          "| one | two |  |",
          "| three | one | two |",
          "|  | three | four |",
        ].join("\n")
      )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a nested rendered table targets cells and preserves its row prefixes when pasted", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-nested-table-paste-e2e-")
  )
  const documentPath = path.join(userData, "nested-table-paste.md")
  await writeFile(
    documentPath,
    ["- item", "", "  | A | B |", "  | :- | -: |", "  | one | two |"].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const table = page.locator(".cm-md-table-scroll")
    const rows = table.locator(".cm-md-table-row")
    const firstCell = rows.first().locator(":scope > .cm-md-table-cell").first()
    const destinationCell = rows
      .first()
      .locator(":scope > .cm-md-table-cell")
      .nth(1)
    await expect(table.locator(".cm-md-table-header")).toHaveCount(1)
    await expect(destinationCell).toHaveText("two")

    const [anchor, destinationBounds] = await Promise.all([
      textBoundary(firstCell, 1),
      destinationCell.boundingBox(),
    ])
    if (!destinationBounds) {
      throw new Error("The nested table range endpoint is missing")
    }
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.move(
      destinationBounds.x + destinationBounds.width / 2,
      destinationBounds.y + destinationBounds.height / 2,
      { steps: 8 }
    )
    await page.mouse.up()
    await expect(table.locator(".cm-md-table-cell-selected")).toHaveText([
      "one",
      "two",
    ])
    await page.keyboard.press("Escape")
    await expect(table.locator(".cm-md-table-cell-selected")).toHaveCount(0)

    const destination = await textBoundary(destinationCell, 2)
    await page.mouse.click(destination.x, destination.y)
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText(["| X |  |", "| --- | --- |", "| Y | Z |"].join("\n"))
    )
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(`${primary}+V`)

    const headerCells = table
      .locator(".cm-md-table-header")
      .locator(":scope > .cm-md-table-cell")
    await expect(headerCells).toHaveText(["A", "B", ""])
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator(":scope > .cm-md-table-cell")).toHaveText([
      "one",
      "X",
      "",
    ])
    await expect(rows.nth(1).locator(":scope > .cm-md-table-cell")).toHaveText([
      "",
      "Y",
      "Z",
    ])

    await page.keyboard.press(`${primary}+S`)
    await expect
      .poll(() => readFile(documentPath, "utf8"))
      .toBe(
        [
          "- item",
          "",
          "  | A | B |  |",
          "  | :- | -: | --- |",
          "  | one | X |  |",
          "  |  | Y | Z |",
        ].join("\n")
      )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("an awaited table range cut cannot mutate a newly activated tab", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-cut-tab-race-e2e-")
  )
  const firstPath = path.join(userData, "first-table.md")
  const secondPath = path.join(userData, "second-table.md")
  await Promise.all([
    writeFile(
      firstPath,
      ["| A | B |", "|---|---|", "| first | keep |"].join("\n")
    ),
    writeFile(
      secondPath,
      ["| A | B |", "|---|---|", "| secon | stay |"].join("\n")
    ),
  ])

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, firstPath, secondPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const tabs = page.locator(".document-tab")
    const activeTab = page.locator('.document-tab[data-active] [role="tab"]')
    const selectedCells = page.locator(".cm-md-table-cell-selected")
    const selectedCell = () =>
      page
        .locator(".cm-md-table-row")
        .first()
        .locator(":scope > .cm-md-table-cell")
        .nth(1)
    const selectCellRange = async () => {
      const bounds = await selectedCell().boundingBox()
      if (!bounds) throw new Error("The selected table cell is missing")
      const startX = bounds.x + Math.min(8, bounds.width / 4)
      const endX = Math.min(bounds.x + bounds.width - 2, startX + 8)
      const y = bounds.y + bounds.height / 2
      await page.mouse.move(startX, y)
      await page.mouse.down()
      await page.mouse.move(endX, y, { steps: 4 })
      await page.mouse.up()
      await expect(selectedCells).toHaveCount(1)
    }

    await expect(tabs).toHaveCount(2)
    await expect(activeTab).toHaveAttribute("aria-label", firstPath)
    await selectCellRange()
    await tabs.nth(1).getByRole("tab").click()
    await expect(activeTab).toHaveAttribute("aria-label", secondPath)
    await selectCellRange()
    await tabs.nth(0).getByRole("tab").click()
    await expect(activeTab).toHaveAttribute("aria-label", firstPath)
    await expect(selectedCells).toHaveText(["keep"])
    await settleSelectionLayer(page)
    await expect(selectedCells).toHaveText(["keep"])

    await page.evaluate(() => {
      const testWindow = window as Window & {
        releaseTableClipboard?: () => void
        tableClipboardStarted?: boolean
      }
      const clipboard = navigator.clipboard
      if (!clipboard) throw new Error("The Clipboard API is unavailable")
      const pendingWrite = new Promise<void>((resolve) => {
        testWindow.releaseTableClipboard = resolve
      })
      testWindow.tableClipboardStarted = false
      Object.defineProperty(Object.getPrototypeOf(clipboard), "writeText", {
        configurable: true,
        value: () => {
          testWindow.tableClipboardStarted = true
          return pendingWrite
        },
      })
    })

    await page.keyboard.press("Shift+F10")
    const menu = page.getByRole("menu", { name: "Editor context menu" })
    await expect(menu).toHaveAttribute(
      "data-editor-context-menu",
      "table-range"
    )
    const cut = menu.getByRole("menuitem", { name: /^Cut/ })
    await expect(cut).toBeEnabled()
    await cut.click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                tableClipboardStarted?: boolean
              }
            ).tableClipboardStarted
        )
      )
      .toBe(true)
    await expect(menu).not.toBeVisible()

    await tabs.nth(1).getByRole("tab").click()
    await expect(activeTab).toHaveAttribute("aria-label", secondPath)
    await expect(selectedCells).toHaveText(["stay"])
    await page.evaluate(() => {
      const testWindow = window as Window & {
        releaseTableClipboard?: () => void
      }
      testWindow.releaseTableClipboard?.()
    })

    await expect(page.getByRole("alert")).toContainText(
      "Unable to cut the table range."
    )
    await expect(selectedCell()).toHaveText("stay")
    await tabs.nth(0).getByRole("tab").click()
    await expect(activeTab).toHaveAttribute("aria-label", firstPath)
    await expect(selectedCell()).toHaveText("keep")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("rendered table range drags auto-scroll at the viewport edge @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-autoscroll-e2e-")
  )
  const documentPath = path.join(userData, "table-autoscroll.md")
  await writeFile(
    documentPath,
    [
      "| A | B |",
      "|---|---|",
      ...Array.from(
        { length: 120 },
        (_, index) => `| row ${index + 1} | value ${index + 1} |`
      ),
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 620, height: 420 })
    const scroller = page.locator(".cm-scroller")
    const firstCell = page
      .locator(".cm-md-table-row")
      .first()
      .locator(":scope > .cm-md-table-cell")
      .first()
    const [anchor, scrollerBounds] = await Promise.all([
      textBoundary(firstCell, 1),
      scroller.boundingBox(),
    ])
    if (!scrollerBounds) throw new Error("The editor scroller is missing")

    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.move(
      anchor.x,
      scrollerBounds.y + scrollerBounds.height - 2
    )
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(80)
    await expect
      .poll(() =>
        page
          .locator(".cm-md-table-cell-selected")
          .evaluateAll((cells) =>
            cells.some((cell) =>
              /^row \d+$/.test(cell.textContent?.trim() ?? "")
            )
          )
      )
      .toBe(true)
    await page.mouse.up()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("rendered table range auto-scroll stops at the table boundary @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-scroll-boundary-e2e-")
  )
  const documentPath = path.join(userData, "table-scroll-boundary.md")
  await writeFile(
    documentPath,
    [
      "| A | B |",
      "|---|---|",
      "| row 1 | value 1 |",
      "| row 2 | value 2 |",
      "",
      ...Array.from(
        { length: 150 },
        (_, index) => `Paragraph after the table ${index + 1}.`
      ),
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 620, height: 420 })
    const scroller = page.locator(".cm-scroller")
    const firstCell = page
      .locator(".cm-md-table-row")
      .first()
      .locator(":scope > .cm-md-table-cell")
      .first()
    const [anchor, scrollerBounds] = await Promise.all([
      textBoundary(firstCell, 1),
      scroller.boundingBox(),
    ])
    if (!scrollerBounds) throw new Error("The editor scroller is missing")

    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    await page.mouse.move(
      anchor.x,
      scrollerBounds.y + scrollerBounds.height - 2
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0
          const nextFrame = () => {
            frames += 1
            if (frames === 30) resolve()
            else requestAnimationFrame(nextFrame)
          }
          requestAnimationFrame(nextFrame)
        })
    )
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)
    await page.mouse.up()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("raw Markdown uses VS Code multi-cursor mouse gestures", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-rectangle-e2e-")
  )
  const documentPath = path.join(userData, "rectangle.md")
  await writeFile(documentPath, "0123456789\nabcdefghij\nABCDEFGHIJ")

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const lines = page.locator(".cm-line")
    await editor.waitFor()

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(editor).toHaveClass(/cm-md-source/)

    const firstCursor = await textBoundary(lines.nth(0), 2)
    const secondCursor = await textBoundary(lines.nth(1), 3)
    const thirdCursor = await textBoundary(lines.nth(2), 4)
    await page.mouse.click(firstCursor.x, firstCursor.y)
    await page.keyboard.down("Alt")
    await page.mouse.click(secondCursor.x, secondCursor.y)
    await page.mouse.click(thirdCursor.x, thirdCursor.y)
    await page.keyboard.up("Alt")
    await expect(page.locator(".cm-cursor")).toHaveCount(3)

    await page.keyboard.insertText("X")
    await expect(lines).toHaveText([
      "01X23456789",
      "abcXdefghij",
      "ABCDXEFGHIJ",
    ])
    await expect(page.locator(".cm-cursor")).toHaveCount(3)

    const modeShortcut =
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    const undoShortcut = process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    const redoShortcut =
      process.platform === "darwin" ? "Meta+Shift+Z" : "Control+Y"
    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-live/)
    await expect(page.locator(".cm-cursor")).toHaveCount(1)

    await page.keyboard.press(undoShortcut)
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABCDEFGHIJ"])
    await expect(page.locator(".cm-cursor")).toHaveCount(1)
    await expect
      .poll(() =>
        page.locator(".cm-content").evaluate((content) => {
          return (
            content as HTMLElement & {
              cmTile?: {
                view?: { state: { selection: { ranges: unknown[] } } }
              }
            }
          ).cmTile?.view?.state.selection.ranges.length
        })
      )
      .toBe(1)

    await page.keyboard.press(redoShortcut)
    await expect(lines).toHaveText([
      "01X23456789",
      "abcXdefghij",
      "ABCDXEFGHIJ",
    ])
    await expect(page.locator(".cm-cursor")).toHaveCount(1)

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)
    await page.keyboard.press(undoShortcut)
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABCDEFGHIJ"])

    const sameLineAnchor = await textBoundary(lines.nth(0), 2)
    const sameLineHead = await textBoundary(lines.nth(0), 5)
    await page.mouse.click(sameLineAnchor.x, sameLineAnchor.y)
    await optionShiftClick(page, sameLineHead)
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(1)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(1)

    await page.keyboard.insertText("S")
    await expect(lines).toHaveText(["01S56789", "abcdefghij", "ABCDEFGHIJ"])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABCDEFGHIJ"])

    const verticalAnchor = await textBoundary(lines.nth(0), 2)
    const verticalHead = await textBoundary(lines.nth(2), 2)
    await page.mouse.click(verticalAnchor.x, verticalAnchor.y)
    await optionShiftClick(page, verticalHead)
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)

    await page.keyboard.insertText("V")
    await expect(lines).toHaveText([
      "01V23456789",
      "abVcdefghij",
      "ABVCDEFGHIJ",
    ])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABCDEFGHIJ"])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.insertText("0123456789\nabc\nABCDEFGHIJ")
    const alignedPastShortLine = await textBoundary(lines.nth(0), 8)
    const alignedLastLine = await textBoundary(lines.nth(2), 8)
    await page.mouse.click(alignedPastShortLine.x, alignedPastShortLine.y)
    await optionShiftClick(page, {
      x: alignedPastShortLine.x,
      y: alignedLastLine.y,
    })
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)

    await page.keyboard.insertText("V")
    await expect(lines).toHaveText(["01234567V89", "abcV", "ABCDEFGHVIJ"])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.insertText("0123456789\nabcdefghij\nABCDEFGHIJ")

    const rectangleAnchor = await textBoundary(lines.nth(0), 2)
    const rectangleHead = await textBoundary(lines.nth(2), 5)
    await page.mouse.click(rectangleAnchor.x, rectangleAnchor.y)
    await optionShiftClick(page, rectangleHead)
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(3)

    await page.keyboard.insertText("X")
    await expect(lines).toHaveText(["01X56789", "abXfghij", "ABXFGHIJ"])
    await expect(page.locator(".cm-cursor")).toHaveCount(3)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABCDEFGHIJ"])

    await page.mouse.click(rectangleAnchor.x, rectangleAnchor.y)
    await page.keyboard.down("Alt")
    await page.keyboard.down("Shift")
    await page.mouse.move(rectangleAnchor.x, rectangleAnchor.y)
    await page.mouse.down()
    await page.mouse.move(rectangleHead.x, rectangleHead.y, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up("Shift")
    await page.keyboard.up("Alt")
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(3)

    await page.keyboard.insertText("D")
    await expect(lines).toHaveText(["01D56789", "abDfghij", "ABDFGHIJ"])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABCDEFGHIJ"])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.insertText("0123456789\nabcdefghij\nABC")
    const shortLineAnchor = await textBoundary(lines.nth(0), 2)
    const pastShortLineColumn = await textBoundary(lines.nth(0), 5)
    const shortLineEnd = await textBoundary(lines.nth(2), 3)
    await page.mouse.click(shortLineAnchor.x, shortLineAnchor.y)
    await optionShiftClick(page, {
      x: pastShortLineColumn.x,
      y: shortLineEnd.y,
    })
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(3)

    await page.keyboard.insertText("P")
    await expect(lines).toHaveText(["01P56789", "abPfghij", "ABP"])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(lines).toHaveText(["0123456789", "abcdefghij", "ABC"])

    const reverseAnchor = await textBoundary(lines.nth(0), 8)
    await page.mouse.click(reverseAnchor.x, reverseAnchor.y)
    await optionShiftClick(page, {
      x: pastShortLineColumn.x,
      y: shortLineEnd.y,
    })
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(2)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(2)
    const primaryCursor = await page.locator(".cm-cursor-primary").boundingBox()
    const originRetainedLine = await lines.nth(0).boundingBox()
    expect(primaryCursor).not.toBeNull()
    expect(originRetainedLine).not.toBeNull()
    expect(primaryCursor!.y).toBeGreaterThanOrEqual(originRetainedLine!.y)
    expect(primaryCursor!.y).toBeLessThan(
      originRetainedLine!.y + originRetainedLine!.height
    )

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(editor).toHaveClass(/cm-md-live/)
    await expect(page.locator(".cm-cursor")).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("raw Markdown keeps the first cursor as the column-selection origin", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-column-origin-e2e-")
  )
  const documentPath = path.join(userData, "column-origin.md")
  await writeFile(
    documentPath,
    "0123456789\nabcdefghij\nABCDEFGHIJ\nklmnopqrst"
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const lines = page.locator(".cm-line")
    await editor.waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )

    const origin = await textBoundary(lines.nth(0), 2)
    await page.mouse.click(origin.x, origin.y)
    await optionShiftClick(page, await textBoundary(lines.nth(2), 5))
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(3)

    await optionShiftClick(page, await textBoundary(lines.nth(0), 6))
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(1)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(1)

    const extraCursor = await textBoundary(lines.nth(3), 8)
    await page.keyboard.down("Alt")
    await page.mouse.click(extraCursor.x, extraCursor.y)
    await page.keyboard.up("Alt")
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(2)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(1)
    const retainedPrimary = await page
      .locator(".cm-cursor-primary")
      .boundingBox()
    const originLine = await lines.nth(0).boundingBox()
    expect(retainedPrimary).not.toBeNull()
    expect(originLine).not.toBeNull()
    expect(retainedPrimary!.y).toBeGreaterThanOrEqual(originLine!.y)
    expect(retainedPrimary!.y).toBeLessThan(originLine!.y + originLine!.height)

    const dragStart = await textBoundary(lines.nth(3), 1)
    const dragHead = await textBoundary(lines.nth(2), 4)
    await page.keyboard.down("Alt")
    await page.keyboard.down("Shift")
    await page.mouse.move(dragStart.x, dragStart.y)
    await page.mouse.down()
    await page.mouse.move(dragHead.x, dragHead.y, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up("Shift")
    await page.keyboard.up("Alt")
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(3)

    await page.keyboard.insertText("R")
    await expect(lines).toHaveText([
      "01R456789",
      "abRefghij",
      "ABREFGHIJ",
      "klmnopqrst",
    ])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(lines).toHaveText([
      "0123456789",
      "abcdefghij",
      "ABCDEFGHIJ",
      "klmnopqrst",
    ])

    const movedOrigin = await textBoundary(lines.nth(3), 8)
    await page.mouse.click(movedOrigin.x, movedOrigin.y)
    await page.keyboard.press("ArrowLeft")
    await optionShiftClick(page, await textBoundary(lines.nth(1), 5))
    await page.keyboard.insertText("N")
    await expect(lines).toHaveText([
      "0123456789",
      "abcdeNhij",
      "ABCDENHIJ",
      "klmnoNrst",
    ])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("raw Markdown column selection follows wrapped visual rows @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-wrapped-column-e2e-")
  )
  const documentPath = path.join(userData, "wrapped-column.md")
  const initialMiddle = Array.from({ length: 160 }, (_, index) =>
    String.fromCharCode(97 + (index % 26))
  ).join("")
  await writeFile(documentPath, `0123456789\n${initialMiddle}\nABCDEFGHIJ`)

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const lines = page.locator(".cm-line")
    await editor.waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 560)
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(editor).toHaveClass(/cm-md-source/)

    await expect
      .poll(async () => (await wrappedVisualRows(lines.nth(1))).length)
      .toBeGreaterThan(1)
    const initialRows = await wrappedVisualRows(lines.nth(1))
    const rowCapacity = initialRows[1]!.start - initialRows[0]!.start
    expect(rowCapacity).toBeGreaterThan(5)
    const middleText = Array.from(
      { length: rowCapacity * 3 + 10 },
      (_, index) => String.fromCharCode(97 + (index % 26))
    ).join("")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.insertText(`0123456789\n${middleText}\nABCDEFGHIJ`)
    await expect
      .poll(async () => (await wrappedVisualRows(lines.nth(1))).length)
      .toBe(4)
    const middleRows = await wrappedVisualRows(lines.nth(1))
    expect(middleRows.every((row) => row.end - row.start >= 5)).toBe(true)

    const sameLineOrigin = await textBoundary(
      lines.nth(1),
      middleRows[0]!.start + 2
    )
    const sameLineHead = await textBoundary(
      lines.nth(1),
      middleRows[2]!.start + 5
    )
    await page.mouse.click(sameLineOrigin.x, sameLineOrigin.y)
    await optionShiftClick(page, sameLineHead)
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(3)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(3)

    const wrapOffset = middleRows[1]!.start
    const previousCharacter = await textCharacterRect(
      lines.nth(1),
      wrapOffset - 1
    )
    const nextCharacter = await textCharacterRect(lines.nth(1), wrapOffset)
    await page.mouse.click(
      previousCharacter.right,
      (previousCharacter.top + previousCharacter.bottom) / 2
    )
    await page.mouse.click(
      nextCharacter.left,
      (nextCharacter.top + nextCharacter.bottom) / 2
    )
    await optionShiftClick(page, sameLineHead)
    await settleSelectionLayer(page)
    await expect(page.locator(".cm-cursor")).toHaveCount(2)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(2)

    const wrappedAnchor = await textBoundary(lines.nth(0), 2)
    await page.mouse.click(wrappedAnchor.x, wrappedAnchor.y)
    await optionShiftClick(page, await textBoundary(lines.nth(2), 5))
    await settleSelectionLayer(page)
    const expectedRows = middleRows.length + 2
    await expect(page.locator(".cm-cursor")).toHaveCount(expectedRows)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(
      expectedRows
    )

    const markerRects = await page
      .locator(".cm-app-selectionBackground")
      .evaluateAll((markers) =>
        markers.map((marker) => {
          const rect = marker.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        })
      )
    expect(
      Math.max(...markerRects.map((rect) => rect.left))
    ).toBeLessThanOrEqual(Math.min(...markerRects.map((rect) => rect.left)) + 1)
    expect(
      Math.max(...markerRects.map((rect) => rect.right))
    ).toBeLessThanOrEqual(
      Math.min(...markerRects.map((rect) => rect.right)) + 1
    )

    let expectedMiddle = middleText
    for (const row of [...middleRows].reverse()) {
      expectedMiddle =
        expectedMiddle.slice(0, row.start + 2) +
        "W" +
        expectedMiddle.slice(row.start + 5)
    }
    await page.keyboard.insertText("W")
    await expect(lines).toHaveText(["01W56789", expectedMiddle, "ABWFGHIJ"])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("raw Markdown keeps wrapped column geometry across virtualized rows @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-virtual-column-e2e-")
  )
  const documentPath = path.join(userData, "virtual-column.md")
  const wrappedText = Array.from({ length: 180 }, (_, index) =>
    String.fromCharCode(97 + (index % 26))
  ).join("")
  const fillerLines = Array.from(
    { length: 80 },
    (_, index) => `filler-${String(index + 1).padStart(2, "0")}-abcdefghij`
  )
  const targetLine = "ABCDEFGHIJ-target"
  await writeFile(
    documentPath,
    ["0123456789", wrappedText, ...fillerLines, targetLine].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const lines = page.locator(".cm-line")
    await editor.waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 360)
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )

    await expect
      .poll(async () => (await wrappedVisualRows(lines.nth(1))).length)
      .toBeGreaterThan(1)
    const wrappedRows = await wrappedVisualRows(lines.nth(1))
    const origin = await textBoundary(lines.nth(0), 2)
    await page.mouse.click(origin.x, origin.y)

    await page.locator(".cm-scroller").evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight
    })
    await settleSelectionLayer(page)
    const target = page.locator(".cm-line", { hasText: targetLine })
    await expect(target).toBeVisible()
    await optionShiftClick(page, await textBoundary(target, 5))
    await page.keyboard.insertText("Z")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )

    let expectedWrapped = wrappedText
    for (const row of [...wrappedRows].reverse()) {
      expectedWrapped =
        expectedWrapped.slice(0, row.start + 2) +
        "Z" +
        expectedWrapped.slice(row.start + 5)
    }
    const replaceColumn = (line: string) =>
      `${line.slice(0, 2)}Z${line.slice(5)}`
    const expected = [
      replaceColumn("0123456789"),
      expectedWrapped,
      ...fillerLines.map(replaceColumn),
      replaceColumn(targetLine),
    ].join("\n")
    await expect.poll(() => readFile(documentPath, "utf8")).toBe(expected)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("raw Markdown keeps bidi column geometry across virtualized rows @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-bidi-column-e2e-")
  )
  const documentPath = path.join(userData, "bidi-column.md")
  const originLine = "0123456789-origin"
  const wrappedText = "abאבגדefgh".repeat(34)
  const fillerLines = Array.from(
    { length: 70 },
    (_, index) => `filler-${String(index + 1).padStart(2, "0")}-abcdefghij`
  )
  const targetLine = "0123456789-target"
  const original = [originLine, wrappedText, ...fillerLines, targetLine].join(
    "\n"
  )
  await writeFile(documentPath, original)

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const lines = page.locator(".cm-line")
    await editor.waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 900)
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(editor).toHaveClass(/cm-md-source/)

    await expect
      .poll(async () => (await wrappedVisualRows(lines.nth(1))).length)
      .toBeGreaterThan(3)
    const wrappedRows = await wrappedVisualRows(lines.nth(1))
    const origin = await textBoundary(lines.nth(0), 8)
    const headColumn = await textBoundary(lines.nth(0), 12)
    const wrappedOffsets = await editorOffsetsAtVisualRows(
      page,
      lines.nth(1),
      wrappedRows,
      origin.x,
      headColumn.x,
      wrappedText
    )

    await page.mouse.click(origin.x, origin.y)
    await page.locator(".cm-scroller").evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight
    })
    await settleSelectionLayer(page)
    const target = page.locator(".cm-line", { hasText: targetLine })
    await expect(target).toBeVisible()
    await optionShiftClick(page, await textBoundary(target, 12))
    await page.keyboard.insertText("X")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )

    let expectedWrapped = wrappedText
    for (const row of [...wrappedOffsets].reverse()) {
      const from = Math.min(row.first, row.second)
      const to = Math.max(row.first, row.second)
      expectedWrapped =
        expectedWrapped.slice(0, from) + "X" + expectedWrapped.slice(to)
    }
    const replaceColumns = (line: string) =>
      `${line.slice(0, 8)}X${line.slice(12)}`
    const expected = [
      replaceColumns(originLine),
      expectedWrapped,
      ...fillerLines.map(replaceColumns),
      replaceColumns(targetLine),
    ].join("\n")
    await expect.poll(() => readFile(documentPath, "utf8")).toBe(expected)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("two adjacent partial selection rows meet without a full-lane bridge @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-adjacent-selection-e2e-")
  )
  const documentPath = path.join(userData, "adjacent-selection.md")
  await writeFile(
    documentPath,
    ["0123456789ABCDEFGHIJ", "abcdefghijklmnopqrst"].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const lines = page.locator(".cm-line")
    await expect(lines).toHaveCount(2)
    const [firstText, lastText] = await Promise.all([
      textCharacterRect(lines.nth(0), 2),
      textCharacterRect(lines.nth(1), 17),
    ])
    await content.evaluate((element) => {
      const editorContent = element as HTMLElement & {
        cmTile?: {
          view?: {
            dispatch(spec: {
              selection: { anchor: number; head: number }
            }): void
            focus(): void
            state: {
              doc: {
                line(number: number): { from: number }
              }
            }
          }
        }
      }
      const view = editorContent.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      view.dispatch({
        selection: {
          anchor: view.state.doc.line(1).from + 2,
          head: view.state.doc.line(2).from + 18,
        },
      })
      view.focus()
    })
    await settleSelectionLayer(page)

    const geometry = await content.evaluate((element) => {
      const contentBounds = element.getBoundingClientRect()
      const contentStyle = getComputedStyle(element)
      const lane = {
        left: contentBounds.left + Number.parseFloat(contentStyle.paddingLeft),
        right:
          contentBounds.right - Number.parseFloat(contentStyle.paddingRight),
      }
      const markers = [
        ...document.querySelectorAll<HTMLElement>(
          ".cm-app-selectionBackground:not(.cm-app-tableSelectionBackground)"
        ),
      ]
        .map((marker) => {
          const bounds = marker.getBoundingClientRect()
          return {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          }
        })
        .sort((left, right) => left.top - right.top || left.left - right.left)
      return { lane, markers }
    })

    expect(geometry.markers).toHaveLength(2)
    const [first, last] = geometry.markers
    expect(first).toBeDefined()
    expect(last).toBeDefined()
    expect(first!.left).toBeGreaterThan(geometry.lane.left + 4)
    expect(first!.right).toBeCloseTo(geometry.lane.right, 0)
    expect(last!.left).toBeCloseTo(geometry.lane.left, 0)
    expect(last!.right).toBeLessThan(geometry.lane.right - 4)
    const midpoint = (firstText.bottom + lastText.top) / 2
    expect(first!.bottom).toBeCloseTo(midpoint, 0)
    expect(last!.top).toBeCloseTo(midpoint, 0)
    expect(
      geometry.markers.some(
        (marker) =>
          Math.abs(marker.left - geometry.lane.left) <= 0.5 &&
          Math.abs(marker.right - geometry.lane.right) <= 0.5
      )
    ).toBe(false)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("ordinary multiline selection keeps one gapless full-lane body @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-joined-selection-e2e-")
  )
  const documentPath = path.join(userData, "joined-selection.md")
  await writeFile(
    documentPath,
    [
      "Start alpha omega",
      "1. First list row",
      "   - Nested indented row",
      "",
      "> Quoted middle row",
      "",
      "Final tail text",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                dispatch(spec: {
                  selection: { anchor: number; head: number }
                }): void
                focus(): void
                state: {
                  doc: {
                    line(number: number): { from: number }
                  }
                }
              }
            }
          })
        | null
      const view = content?.cmTile?.view
      if (!view) throw new Error("The editor view is unavailable")
      view.dispatch({
        selection: {
          anchor: view.state.doc.line(1).from + 6,
          head: view.state.doc.line(7).from + 5,
        },
      })
      view.focus()
    })
    await settleSelectionLayer(page)

    const geometry = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>(".cm-content")
      if (!content) throw new Error("The editor content is unavailable")
      const contentBounds = content.getBoundingClientRect()
      const contentStyle = getComputedStyle(content)
      const lane = {
        left: contentBounds.left + Number.parseFloat(contentStyle.paddingLeft),
        right:
          contentBounds.right - Number.parseFloat(contentStyle.paddingRight),
      }
      const markers = [
        ...document.querySelectorAll<HTMLElement>(
          ".cm-app-selectionBackground:not(.cm-app-tableSelectionBackground)"
        ),
      ]
        .map((marker) => {
          const bounds = marker.getBoundingClientRect()
          return {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          }
        })
        .sort((left, right) => left.top - right.top || left.left - right.left)
      const intermediateLines = [
        ...content.querySelectorAll<HTMLElement>(".cm-line"),
      ].slice(1, -1)
      const intermediateBounds = intermediateLines.map((line) => {
        const bounds = line.getBoundingClientRect()
        return { bottom: bounds.bottom, top: bounds.top }
      })
      return { intermediateBounds, lane, markers }
    })

    expect(geometry.markers).toHaveLength(3)
    const [first, body, last] = geometry.markers
    expect(first).toBeDefined()
    expect(body).toBeDefined()
    expect(last).toBeDefined()
    expect(first!.left).toBeGreaterThan(geometry.lane.left + 4)
    expect(first!.right).toBeCloseTo(geometry.lane.right, 0)
    expect(body!.left).toBeCloseTo(geometry.lane.left, 0)
    expect(body!.right).toBeCloseTo(geometry.lane.right, 0)
    expect(last!.left).toBeCloseTo(geometry.lane.left, 0)
    expect(last!.right).toBeLessThan(geometry.lane.right - 4)
    expect(body!.top).toBeCloseTo(first!.bottom, 0)
    expect(last!.top).toBeCloseTo(body!.bottom, 0)
    for (const line of geometry.intermediateBounds) {
      expect(body!.top).toBeLessThanOrEqual(line.top)
      expect(body!.bottom).toBeGreaterThanOrEqual(line.bottom)
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("keyboard selection keeps continuing rows on the text lane @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-selection-e2e-")
  )
  const documentPath = path.join(userData, "selection.md")
  const anchorText = "Selection anchor remains ordinary prose."
  await writeFile(
    documentPath,
    [
      ...Array.from(
        { length: 36 },
        (_, index) =>
          `Prelude line ${index + 1} keeps earlier rows virtualized.`
      ),
      "",
      "1. Parent list item",
      ...Array.from(
        { length: 32 },
        (_, index) =>
          `   - Nested option ${index + 1} exercises hanging indentation.`
      ),
      "",
      "2. Following list item",
      ...Array.from({ length: 80 }, () => ""),
      anchorText,
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1_000, 400)
    })
    await page.locator(".cm-scroller").evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight
    })

    const anchor = page.locator(".cm-line", { hasText: anchorText })
    await expect(anchor).toBeVisible()
    await anchor.click()
    await page.keyboard.press("End")

    let initial: Awaited<ReturnType<typeof selectionGeometry>> = null
    for (let index = 0; index < 180; index += 1) {
      await page.keyboard.press("Shift+ArrowUp")
      const firstLineUsesInsetEdge = await page
        .locator(".cm-content")
        .evaluate((content) => {
          const firstLine = content.querySelector<HTMLElement>(".cm-line")
          if (!firstLine?.classList.contains("cm-md-list-depth-2")) return false
          const contentRect = content.getBoundingClientRect()
          const contentStyle = getComputedStyle(content)
          const lineStyle = getComputedStyle(firstLine)
          const laneLeft =
            contentRect.left + Number.parseFloat(contentStyle.paddingLeft)
          const inferredLeft =
            contentRect.left +
            (Number.parseInt(lineStyle.paddingLeft, 10) || 0) +
            Math.min(0, Number.parseInt(lineStyle.textIndent, 10) || 0)
          return inferredLeft > laneLeft + 1
        })
      if (!firstLineUsesInsetEdge) continue

      await settleSelectionLayer(page)
      const candidate = await selectionGeometry(page)
      if (
        candidate?.centerLeft != null &&
        candidate.topLeft > candidate.laneLeft + 4
      ) {
        initial = candidate
        break
      }
    }

    expect(initial).not.toBeNull()
    expect(initial!.firstDepthTwo).toBe(true)
    expect(initial!.inferredLeft).toBeGreaterThan(initial!.laneLeft + 1)
    expect(initial!.topLeft).toBeGreaterThan(initial!.laneLeft + 4)
    expect(
      Math.abs(initial!.centerLeft! - initial!.laneLeft)
    ).toBeLessThanOrEqual(0.5)

    const initialScrollTop = await page
      .locator(".cm-scroller")
      .evaluate((scroller) => scroller.scrollTop)
    await page.locator(".cm-scroller").evaluate((scroller) => {
      scroller.scrollTop += scroller.clientHeight * 3.5
    })
    await settleSelectionLayer(page)
    const scrolled = await selectionGeometry(page)
    expect(scrolled?.centerLeft).not.toBeNull()
    expect(
      Math.abs(scrolled!.centerLeft! - scrolled!.laneLeft)
    ).toBeLessThanOrEqual(0.5)

    await page.locator(".cm-scroller").evaluate((scroller, scrollTop) => {
      scroller.scrollTop = scrollTop
    }, initialScrollTop)
    await settleSelectionLayer(page)
    const restored = await selectionGeometry(page)
    expect(restored?.centerLeft).not.toBeNull()
    expect(
      Math.abs(restored!.centerLeft! - restored!.laneLeft)
    ).toBeLessThanOrEqual(0.5)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
