import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  type Locator,
  test,
} from "@playwright/test"

import {
  exitApplication,
  openSettingsSection,
  setWindowContentSize,
} from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const samplePath = path.join(projectRoot, "tests/fixtures/sample.md")
const primaryModifier = process.platform === "darwin" ? "Meta" : "Control"

async function expectHorizontallyReachable(surface: Locator) {
  await expect(surface).toBeVisible()
  const geometry = await surface.evaluate((root) => {
    const rootBounds = root.getBoundingClientRect()
    const interactive = [
      ...root.querySelectorAll<HTMLElement>(
        'button, input, [data-slot="select-trigger"], [tabindex="0"]'
      ),
    ]
      .filter((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        )
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().slice(0, 80) ??
            element.tagName,
          left: bounds.left,
          right: bounds.right,
        }
      })
    return {
      clientWidth: root.clientWidth,
      interactive,
      rootLeft: rootBounds.left,
      rootRight: rootBounds.right,
      scrollWidth: root.scrollWidth,
      viewportWidth: innerWidth,
    }
  })

  expect(geometry.rootLeft).toBeGreaterThanOrEqual(-1)
  expect(geometry.rootRight).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  for (const control of geometry.interactive) {
    expect(
      control.left,
      `${control.label} begins outside the viewport`
    ).toBeGreaterThanOrEqual(-1)
    expect(
      control.right,
      `${control.label} ends outside the viewport`
    ).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  }
}

test("search and outline stay below the complete top chrome @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-overlay-position-")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })
  const outlineShortcut = `${primaryModifier}+Shift+O`
  const toolbarShortcut = `${primaryModifier}+Shift+B`

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    const expectBelowTopChrome = async (overlay: Locator) => {
      await expect(overlay).toBeVisible()
      await expect
        .poll(async () =>
          overlay.evaluate((element) => {
            const toolbar = document.querySelector<HTMLElement>(
              ".formatting-toolbar[data-visible]"
            )
            const chrome = document.querySelector<HTMLElement>(".top-chrome")
            const boundary = toolbar ?? chrome
            if (!boundary) throw new Error("Top chrome is unavailable")
            return Math.abs(
              element.getBoundingClientRect().top -
                (boundary.getBoundingClientRect().bottom + 4)
            )
          })
        )
        .toBeLessThanOrEqual(0.75)
      const bottomOverflow = await overlay.evaluate(
        (element) => element.getBoundingClientRect().bottom - innerHeight
      )
      expect(bottomOverflow).toBeLessThanOrEqual(0.75)
    }

    const checkOverlays = async () => {
      await page.keyboard.press(`${primaryModifier}+F`)
      const search = page.getByRole("form", {
        name: "Find and replace in document",
      })
      await expect(search).toHaveAttribute("data-search-overlay-state", "ready")
      await expectBelowTopChrome(search)
      await page.keyboard.press("Escape")
      await expect(search).toHaveCount(0)

      await page.keyboard.press(outlineShortcut)
      const outline = page.locator('[data-slot="popover-content"]')
      await expectBelowTopChrome(outline)
      await page.keyboard.press("Escape")
      await expect(outline).toHaveCount(0)
    }

    await checkOverlays()

    await page.keyboard.press(toolbarShortcut)
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()
    await checkOverlays()

    await setWindowContentSize(app, 480, 320)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480)

    await page.mouse.move(240, 1)
    for (const name of [
      "Switch to Raw Markdown",
      "Find",
      "Document outline",
      "Formatting toolbar",
    ]) {
      await expect(
        page.getByRole("button", { name, exact: true })
      ).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Forward" })).toHaveCount(0)

    const status = page.locator(".status-overlay")
    await page.mouse.move(240, 319)
    await expect(status).toBeVisible()
    const statusLayout = await status.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const values = [
        ...element.querySelectorAll<HTMLElement>("[data-status-item]"),
      ].map((item) => {
        const itemBounds = item.getBoundingClientRect()
        const style = getComputedStyle(item)
        return {
          bottom: itemBounds.bottom,
          flexShrink: style.flexShrink,
          key: item.dataset.statusItem,
          top: itemBounds.top,
          visible: style.display !== "none",
          whiteSpace: style.whiteSpace,
        }
      })
      return { bottom: bounds.bottom, top: bounds.top, values }
    })
    expect(
      statusLayout.values.find(({ key }) => key === "characters")?.visible
    ).toBe(false)
    for (const value of statusLayout.values.filter(({ visible }) => visible)) {
      expect(value.flexShrink).toBe("0")
      expect(value.whiteSpace).toBe("nowrap")
      expect(value.top).toBeGreaterThanOrEqual(statusLayout.top)
      expect(value.bottom).toBeLessThanOrEqual(statusLayout.bottom)
    }

    await checkOverlays()

    await page.mouse.move(240, 1)
    await page
      .getByRole("button", { name: "Formatting toolbar", exact: true })
      .click()
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toHaveCount(0)
    await checkOverlays()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Settings and specialized workspaces remain reachable at minimum size and maximum zoom", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-responsive-polish-")
  )
  const responsivePath = path.join(userData, "responsive.md")
  await writeFile(
    responsivePath,
    [
      "# Start",
      "",
      ...Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`),
      "",
      "## Destination",
      "",
    ].join("\n")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, responsivePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await setWindowContentSize(app, 480, 320)
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(160)

    const documentActions = page.getByRole("button", {
      name: "Document actions",
    })
    await documentActions.focus()
    await expect(documentActions).toBeVisible()
    await documentActions.click()
    const documentActionsMenu = page.locator(
      '[data-slot="dropdown-menu-content"]'
    )
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Back" })
    ).toHaveCount(0)
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Forward" })
    ).toHaveCount(0)
    await expect(
      documentActionsMenu.getByRole("menuitem", {
        name: "Switch to Raw Markdown",
      })
    ).toBeVisible()
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Find", exact: true })
    ).toBeVisible()
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Document outline" })
    ).toBeVisible()
    await expect(
      documentActionsMenu.getByRole("menuitem", {
        name: "Show formatting toolbar",
      })
    ).toBeVisible()
    await page.keyboard.press("Escape")

    await page.locator(".cm-content").focus()
    await page.keyboard.press(`${primaryModifier}+Shift+B`)
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    const toolbarScroller = page.locator(".formatting-toolbar-scroll")
    const scrollRight = page.getByRole("button", {
      name: "Scroll formatting toolbar right",
    })
    await expect(scrollRight).toBeVisible()
    await expect
      .poll(() => toolbarScroller.evaluate((scroller) => scroller.scrollLeft))
      .toBe(0)

    await toolbarScroller.evaluate((scroller) => {
      scroller.scrollLeft = 0
    })
    await expect(
      page.getByRole("button", {
        name: "Scroll formatting toolbar left",
      })
    ).toHaveCount(0)
    await expect(toolbarScroller).toHaveAttribute("data-scrollable", "true")
    await expect(toolbarScroller).toHaveCSS("-webkit-app-region", "no-drag")
    const toolbarPointer = await toolbarScroller.evaluate((scroller) => {
      const bounds = scroller.getBoundingClientRect()
      return { x: bounds.left + 20, y: bounds.top + bounds.height / 2 }
    })
    await page.mouse.move(toolbarPointer.x, toolbarPointer.y)

    // The first horizontal tick mounts the left overflow arrow beneath the
    // stationary pointer. That sibling overlay must not interrupt the gesture.
    await page.mouse.wheel(4, 0)
    await expect
      .poll(() => toolbarScroller.evaluate((scroller) => scroller.scrollLeft))
      .toBeGreaterThan(0)
    await expect(
      page.getByRole("button", {
        name: "Scroll formatting toolbar left",
      })
    ).toBeVisible()
    const overlayUnderPointer = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      return target?.closest("button")?.getAttribute("aria-label") ?? null
    }, toolbarPointer)
    expect(overlayUnderPointer).toBe("Scroll formatting toolbar left")
    const beforeOverlayWheel = await toolbarScroller.evaluate(
      (scroller) => scroller.scrollLeft
    )
    await page.mouse.wheel(80, 0)
    await expect
      .poll(() => toolbarScroller.evaluate((scroller) => scroller.scrollLeft))
      .toBeGreaterThan(beforeOverlayWheel)

    const toolbarActions = page.getByRole("toolbar", {
      name: "Formatting toolbar",
    })
    const firstToolbarAction = toolbarActions.locator("button").first()
    const lastToolbarAction = toolbarActions.locator("button").last()
    await toolbarScroller.evaluate((scroller) => {
      scroller.scrollLeft = Math.max(
        0,
        scroller.scrollWidth - scroller.clientWidth - 4
      )
    })
    await expect(scrollRight).toBeVisible()
    const rightApproach = await lastToolbarAction.boundingBox()
    await toolbarScroller.evaluate((scroller) => {
      scroller.scrollLeft = scroller.scrollWidth
    })
    await expect(scrollRight).toHaveCount(0)
    const rightTerminal = await lastToolbarAction.boundingBox()
    if (!rightApproach || !rightTerminal) {
      throw new Error("Formatting toolbar right-edge actions are unavailable")
    }
    expect(rightTerminal.x + rightTerminal.width).toBeLessThanOrEqual(
      rightApproach.x + rightApproach.width + 1
    )

    const scrollLeft = page.getByRole("button", {
      name: "Scroll formatting toolbar left",
    })
    await toolbarScroller.evaluate((scroller) => {
      scroller.scrollLeft = 4
    })
    await expect(scrollLeft).toBeVisible()
    const leftApproach = await firstToolbarAction.boundingBox()
    await toolbarScroller.evaluate((scroller) => {
      scroller.scrollLeft = 0
    })
    await expect(scrollLeft).toHaveCount(0)
    const leftTerminal = await firstToolbarAction.boundingBox()
    if (!leftApproach || !leftTerminal) {
      throw new Error("Formatting toolbar left-edge actions are unavailable")
    }
    expect(leftTerminal.x).toBeGreaterThanOrEqual(leftApproach.x - 1)

    const editorScroller = page.locator(".cm-scroller")
    const editorScrollTop = await editorScroller.evaluate(
      (scroller) => scroller.scrollTop
    )
    await toolbarScroller.evaluate((scroller) => {
      scroller.scrollLeft = 0
    })
    await page.mouse.move(toolbarPointer.x, toolbarPointer.y)
    await page.mouse.wheel(0, 80)
    await expect
      .poll(() => toolbarScroller.evaluate((scroller) => scroller.scrollLeft))
      .toBeGreaterThan(0)
    await expect
      .poll(() => editorScroller.evaluate((scroller) => scroller.scrollTop))
      .toBe(editorScrollTop)

    const pinchWheel = await toolbarScroller.evaluate((scroller) => {
      const scrollLeft = scroller.scrollLeft
      const allowed = scroller.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: 80,
        })
      )
      return { allowed, nextScrollLeft: scroller.scrollLeft, scrollLeft }
    })
    expect(pinchWheel.allowed).toBe(true)
    expect(pinchWheel.nextScrollLeft).toBe(pinchWheel.scrollLeft)

    await page.keyboard.press(`${primaryModifier}+F`)
    const search = page.getByRole("form", {
      name: "Find and replace in document",
    })
    await expect(search).toHaveAttribute("data-search-overlay-state", "ready")
    await search.getByRole("button", { name: "Show replace" }).click()
    await expect(
      search.getByRole("textbox", { name: "Replace" })
    ).toBeAttached()
    const searchGeometry = await search.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const toolbar = document.querySelector<HTMLElement>(
        ".formatting-toolbar[data-visible]"
      )
      if (!toolbar) throw new Error("Formatting toolbar is unavailable")
      return {
        bottom: bounds.bottom,
        top: bounds.top,
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        viewportHeight: innerHeight,
      }
    })
    expect(searchGeometry.top).toBeCloseTo(searchGeometry.toolbarBottom + 4, 1)
    expect(searchGeometry.bottom).toBeLessThanOrEqual(
      searchGeometry.viewportHeight
    )
    const replaceInput = search.getByRole("textbox", { name: "Replace" })
    await replaceInput.scrollIntoViewIfNeeded()
    await expect(replaceInput).toBeInViewport()
    await expect(
      search.getByRole("button", { name: "Replace all" })
    ).toBeInViewport()
    await page.keyboard.press("Escape")
    await expect(search).toHaveCount(0)

    await page.keyboard.press(`${primaryModifier}+Shift+O`)
    const outline = page.locator('[data-slot="popover-content"]')
    await expect(outline).toBeVisible()
    await expect
      .poll(() =>
        outline.evaluate((element) => element.getBoundingClientRect().top)
      )
      .toBeCloseTo(searchGeometry.top, 1)
    const outlineGeometry = await outline.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return { bottom: bounds.bottom, viewportHeight: innerHeight }
    })
    expect(outlineGeometry.bottom).toBeLessThanOrEqual(
      outlineGeometry.viewportHeight
    )
    await outline
      .getByRole("option", { name: "Heading level 2: Destination" })
      .click()
    await expect(outline).toHaveCount(0)

    await documentActions.focus()
    await documentActions.click()
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Back" })
    ).toBeVisible()
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Forward" })
    ).toHaveCount(0)
    await documentActionsMenu.getByRole("menuitem", { name: "Back" }).click()
    await documentActions.focus()
    await documentActions.click()
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Back" })
    ).toHaveCount(0)
    await expect(
      documentActionsMenu.getByRole("menuitem", { name: "Forward" })
    ).toBeVisible()
    await page.keyboard.press("Escape")

    await page.keyboard.press(`${primaryModifier}+Shift+B`)
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toHaveCount(0)
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    await expect
      .poll(() =>
        page
          .locator(".cm-content")
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingLeft)
          )
      )
      .toBeLessThanOrEqual(12.1)

    await page.keyboard.press(`${primaryModifier}+,`)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    await expectHorizontallyReachable(settings)
    await openSettingsSection(page, "Theme")
    await openSettingsSection(page, "Miscellaneous")
    await expectHorizontallyReachable(settings)

    await page.getByRole("button", { name: "View keyboard shortcuts" }).click()
    const shortcuts = page.locator("[data-keyboard-shortcuts-detail]")
    await expectHorizontallyReachable(shortcuts)
    await expect(
      page.getByRole("region", { name: "Keyboard shortcuts list" })
    ).toBeVisible()
    await page.getByRole("button", { name: "Back to Settings" }).click()

    await page.getByRole("button", { name: "Customize typography" }).click()
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    const typography = page.getByRole("region", {
      name: "Typography preview workspace",
    })
    await expectHorizontallyReachable(typography)
    await expect(
      page.getByRole("region", { name: "Typography controls" })
    ).toBeVisible()
    await typography.getByRole("button", { name: "Cancel" }).click()

    if (process.platform === "darwin") {
      await page.getByRole("button", { name: "Transparency & Blur" }).click()
      await page.getByRole("switch", { name: "Launch transition" }).click()
      await page
        .getByRole("button", { name: "Customize launch transition" })
        .click()
      await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
      const launchTransition = page.getByRole("region", {
        name: "Launch transition preview workspace",
      })
      await expectHorizontallyReachable(launchTransition)
      await expect(
        page.getByRole("region", { name: "Launch transition controls" })
      ).toBeVisible()
      await launchTransition.getByRole("button", { name: "Cancel" }).click()
    }

    await page.getByRole("button", { name: "Manage Window Profiles" }).click()
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    const profiles = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await expectHorizontallyReachable(profiles)
    await profiles.getByRole("button", { name: "Back to Settings" }).click()

    await expectHorizontallyReachable(settings)
    const done = settings.getByRole("button", { name: "Done" })
    await expect(done).toBeInViewport()
    await expect(
      settings.locator("[data-settings-dialog-footer]")
    ).toBeVisible()
    await done.click()
    await expect(settings).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
