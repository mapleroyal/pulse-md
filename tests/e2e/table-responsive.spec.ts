import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

test("table columns wrap at words, retain readable prose floors, and scroll at min-content", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-table-responsive-e2e-")
  )
  const documentPath = path.join(userData, "responsive.md")
  const prose =
    "This deliberately long sentence should wrap at ordinary word boundaries while retaining a readable column width."
  await writeFile(
    documentPath,
    [
      "| ID | Status label | Notes and observations |",
      "| ---: | --- | --- |",
      `| 1 | Ready now | ${prose} |`,
      `| 20 | Waiting | ${prose} More context follows here. |`,
      "",
      "| Cumulative level | Shuttle count | Speed value | Interval time | Level duration | Running time | Total distance | Final status |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 15 | 155 | 15.5 | 4.645 | 60.387s | 15:33 | 3100m | Complete |",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 440, height: 520 })
    const tables = page.locator(".cm-md-table-scroll")
    await expect(tables).toHaveCount(2)

    const geometry = await page.evaluate(() => {
      const lineCount = (cell: HTMLElement) => {
        const range = document.createRange()
        range.selectNodeContents(cell)
        return new Set(
          [...range.getClientRects()]
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => Math.round(rect.top * 2) / 2)
        ).size
      }
      const wordFragmentCounts = (cell: HTMLElement) => {
        const counts: number[] = []
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? ""
          for (const match of text.matchAll(/\S+/g)) {
            const range = document.createRange()
            range.setStart(node, match.index)
            range.setEnd(node, match.index + match[0].length)
            counts.push(
              [...range.getClientRects()].filter(
                (rect) => rect.width > 0 && rect.height > 0
              ).length
            )
          }
        }
        return counts
      }
      return [
        ...document.querySelectorAll<HTMLElement>(".cm-md-table-scroll"),
      ].map((table) => {
        const headers = [
          ...table.querySelectorAll<HTMLElement>(
            ".cm-md-table-header .cm-md-table-cell"
          ),
        ]
        const bodyCells = [
          ...table.querySelectorAll<HTMLElement>(
            ".cm-md-table-row .cm-md-table-cell"
          ),
        ]
        const styles = [...headers, ...bodyCells].map((cell) => {
          const style = getComputedStyle(cell)
          return {
            overflowWrap: style.overflowWrap,
            whiteSpace: style.whiteSpace,
            wordBreak: style.wordBreak,
          }
        })
        return {
          bodyLineCounts: bodyCells.map(lineCount),
          bodyWidths: bodyCells.map(
            (cell) => cell.getBoundingClientRect().width
          ),
          clientWidth: table.clientWidth,
          headerLineCounts: headers.map(lineCount),
          scrollWidth: table.scrollWidth,
          styles,
          wordFragmentCounts: bodyCells.flatMap(wordFragmentCounts),
        }
      })
    })

    const [adaptive, wide] = geometry
    expect(adaptive).toBeDefined()
    expect(wide).toBeDefined()
    expect(adaptive!.scrollWidth).toBeLessThanOrEqual(adaptive!.clientWidth + 1)
    expect(adaptive!.bodyLineCounts[2]).toBeGreaterThan(1)
    expect(adaptive!.bodyWidths[0]).toBeLessThan(adaptive!.bodyWidths[2]!)
    expect(adaptive!.wordFragmentCounts.every((count) => count === 1)).toBe(
      true
    )

    expect(wide!.scrollWidth).toBeGreaterThan(wide!.clientWidth)
    expect(wide!.headerLineCounts.some((count) => count > 1)).toBe(true)
    expect(wide!.bodyLineCounts.every((count) => count === 1)).toBe(true)
    expect(wide!.wordFragmentCounts.every((count) => count === 1)).toBe(true)

    for (const table of geometry) {
      expect(
        table.styles.every(
          ({ overflowWrap, whiteSpace, wordBreak }) =>
            overflowWrap === "normal" &&
            ["normal", "pre-wrap"].includes(whiteSpace) &&
            wordBreak === "normal"
        )
      ).toBe(true)
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
