import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { _electron as electron, expect, test } from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

test("bottom scrollbar remains draggable around hidden, hovered, and pinned status chrome @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-bottom-scrollbar-")
  )
  const filePath = path.join(userData, "wide.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.lineWrapping = false
  await Promise.all([
    writeFile(
      filePath,
      Array.from(
        { length: 100 },
        (_, i) => `Line ${i}: ${"wide text ".repeat(100)}`
      ).join("\n")
    ),
    writeFile(path.join(userData, "settings.json"), JSON.stringify(settings)),
  ])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const scroller = page.locator(".editor-mount .cm-scroller")
    const reveal = page.locator(".status-overlay-reveal-region")
    await reveal.waitFor()
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true)
    await page.mouse.move(200, 200)
    const initialBounds = await scroller.boundingBox()

    for (const visibility of ["hidden", "hovered", "pinned"] as const) {
      if (visibility === "hovered") await reveal.hover()
      if (visibility === "pinned") {
        await app.evaluate(({ Menu, BrowserWindow }) => {
          const item =
            Menu.getApplicationMenu()?.getMenuItemById("view-status-bar")
          if (!item) throw new Error("Status Bar menu item is unavailable")
          item.click(undefined, BrowserWindow.getAllWindows()[0], undefined)
        })
        await expect(reveal).toHaveAttribute("data-always-visible")
      }
      if (visibility !== "hidden") {
        await expect
          .poll(() =>
            reveal.evaluate((element) => {
              const bounds = element.getBoundingClientRect()
              return document
                .elementsFromPoint(
                  bounds.width / 2,
                  bounds.y + bounds.height / 2
                )
                .some((candidate) => candidate.closest(".cm-editor"))
            })
          )
          .toBe(false)
      }
      await scroller.evaluate((element) => {
        element.scrollLeft = 0
      })
      const geometry = await scroller.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const gutter =
          (element as HTMLElement).offsetHeight - element.clientHeight
        const x = bounds.x + 20
        const y = bounds.bottom - gutter / 2
        const region = document.querySelector(".status-overlay-reveal-region")!
        return {
          x,
          y,
          gutter,
          hit: document.elementFromPoint(x, y)?.className,
          scrollerBottom: bounds.bottom,
          revealBottom: region.getBoundingClientRect().bottom,
        }
      })
      expect(await scroller.boundingBox(), visibility).toEqual(initialBounds)
      expect(geometry.gutter).toBe(10)
      expect(geometry.hit, visibility).toContain("cm-scroller")
      expect(geometry.revealBottom).toBeLessThanOrEqual(
        geometry.scrollerBottom - geometry.gutter
      )
      await page.mouse.move(geometry.x, geometry.y)
      await page.mouse.down()
      try {
        await page.mouse.move(geometry.x + 120, geometry.y, { steps: 6 })
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0)
      } finally {
        await page.mouse.up()
      }
    }

    // The vertical thumb must also remain reachable above the pinned status.
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const beforeVerticalDrag = await scroller.evaluate(
      (element) => element.scrollTop
    )
    const scrollerBounds = await scroller.boundingBox()
    const statusBounds = await reveal.boundingBox()
    if (!scrollerBounds || !statusBounds)
      throw new Error("Missing editor chrome")
    const verticalX = scrollerBounds.x + scrollerBounds.width - 5
    const verticalY = statusBounds.y - 18
    await page.mouse.move(verticalX, verticalY)
    await page.mouse.down()
    try {
      await page.mouse.move(verticalX, verticalY - 30, { steps: 5 })
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeLessThan(beforeVerticalDrag)
    } finally {
      await page.mouse.up()
    }

    // Removing the horizontal overflow must return status chrome to the edge.
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item =
        Menu.getApplicationMenu()?.getMenuItemById("view-text-wrapping")
      if (!item) throw new Error("Word Wrap menu item is unavailable")
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined)
    })
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        reveal.evaluate((element) => element.getBoundingClientRect().bottom)
      )
      .toBe(await page.evaluate(() => innerHeight))
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
