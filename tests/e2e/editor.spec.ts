import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test"

import {
  DEFAULT_APP_SETTINGS,
  MIN_ZOOM_FACTOR,
} from "../../src/shared/contracts"
import {
  exitApplication,
  openSettingsSection,
  setWindowContentSize,
  waitForApplicationClose,
} from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const samplePath = path.join(projectRoot, "tests/fixtures/sample.md")
const execFileAsync = promisify(execFile)
const WINDOWS_CAPTION_CONTROLS_WIDTH = 138
const TOP_CHROME_CONTENT_GAP = 8
const TOP_CONTROLS_POSITION_LABEL = "Top-Right"

function documentSurfaceColor(opaqueColor: string, translucency = 0) {
  if (process.platform !== "darwin" || translucency <= 0) return opaqueColor
  const opacity = Number((1 - translucency).toFixed(3))
  return opaqueColor.replace(/^rgb\((.+)\)$/, `rgba($1, ${opacity})`)
}

async function createTestUserData() {
  return mkdtemp(path.join(os.tmpdir(), "pulse-md-e2e-"))
}

async function launchApplication(userData: string, ...filePaths: string[]) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, ...filePaths],
    cwd: projectRoot,
  })
}

async function activateWindow(page: Page) {
  await page.bringToFront()
  await page.locator("body").focus()
}

async function deactivateNativeWindow(app: ElectronApplication) {
  await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error("The document window is unavailable")

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("The document window did not deactivate"))
      }, 5_000)
      const finish = () => {
        clearTimeout(timeout)
        window.removeListener("blur", finish)
        resolve()
      }

      window.once("blur", finish)
      if (process.platform === "darwin") electronApp.hide()
      else window.hide()
      setImmediate(() => {
        if (!window.isFocused()) finish()
      })
    })
  })
}

async function focusNativeWindow(app: ElectronApplication) {
  await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error("The document window is unavailable")

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("The document window did not activate"))
      }, 5_000)
      const finish = () => {
        clearTimeout(timeout)
        window.removeListener("focus", finish)
        resolve()
      }

      window.once("focus", finish)
      if (process.platform === "darwin") {
        electronApp.show()
        electronApp.focus({ steal: true })
      }
      window.restore()
      window.show()
      window.focus()
      setImmediate(() => {
        if (window.isFocused()) finish()
      })
    })
  })
}

function settingsSelect(page: Page, label: string) {
  return page.getByRole("combobox", { name: label, exact: true })
}

function activeDocumentTab(page: Page) {
  return page.locator('.document-tab[data-active] [role="tab"]')
}

async function chooseSelectOption(
  page: Page,
  trigger: Locator,
  option: string | RegExp
) {
  await trigger.click()
  const popup = page.locator('[data-slot="select-content"][data-open]')
  await expect(popup).toBeVisible()
  const item =
    typeof option === "string"
      ? popup.getByRole("option", { name: option, exact: true })
      : popup.getByRole("option", { name: option })
  await item.click()
}

async function chooseSettingsOption(page: Page, label: string, option: string) {
  await chooseSelectOption(page, settingsSelect(page, label), option)
}

async function selectAllFromApplicationMenu(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const selectAllItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === "Edit")
      ?.submenu?.items.find((item) => item.label === "Select All")
    const window =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!selectAllItem || !window) {
      throw new Error("Select All menu item is unavailable")
    }
    selectAllItem.click(undefined, window, window.webContents)
  })
}

async function runEditMenuItem(
  app: ElectronApplication,
  label: "Redo" | "Undo"
) {
  await app.evaluate(({ BrowserWindow, Menu }, itemLabel) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((candidate) => candidate.label === "Edit")
      ?.submenu?.items.find((candidate) => candidate.label === itemLabel)
    const window =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!item || !window) {
      throw new Error(`${itemLabel} menu item is unavailable`)
    }
    item.click(undefined, window, window.webContents)
  }, label)
}

async function runViewMenuItem(
  app: ElectronApplication,
  item:
    | "resetzoom"
    | "zoom-in"
    | "zoom-out"
    | "view-text-wrapping"
    | "view-formatting-bar"
    | "view-status-bar"
    | "view-tabs-multiple-tabs"
    | "view-tabs-mouseover"
    | "view-tabs-hidden",
  times = 1
) {
  await app.evaluate(
    ({ BrowserWindow, Menu }, request) => {
      const applicationMenu = Menu.getApplicationMenu()
      const menuItem =
        request.item === "resetzoom"
          ? applicationMenu?.items
              .find((candidate) => candidate.label === "View")
              ?.submenu?.items.find(
                (candidate) => candidate.role?.toLowerCase() === request.item
              )
          : applicationMenu?.getMenuItemById(request.item)
      const window =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed()
        )
      if (!menuItem || !window) {
        throw new Error(`View menu item ${request.item} is unavailable`)
      }
      for (let index = 0; index < request.times; index += 1) {
        menuItem.click(undefined, window, window.webContents)
      }
    },
    { item, times }
  )
}

async function clickVisibleText(page: Page, line: ReturnType<Page["locator"]>) {
  const point = await line.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent?.trim()) node = walker.nextNode()
    if (!node?.textContent) throw new Error("Line has no visible text")

    const offset = node.textContent.search(/\S/)
    const range = document.createRange()
    range.setStart(node, Math.max(0, offset))
    range.setEnd(node, Math.max(0, offset) + 1)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
}

async function waitForSubtreeAnimations(element: ReturnType<Page["locator"]>) {
  await element.evaluate(async (node) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined))
    )
  })
}

interface DrawerCaretSample {
  cursorTop: number
  lineTop: number
}

async function startDrawerCaretTrace(page: Page) {
  await page.evaluate(() => {
    const testWindow = window as Window & {
      __pmdDrawerCaretTrace?: DrawerCaretSample[]
      __pmdDrawerCaretTraceDone?: Promise<void>
    }
    const samples: DrawerCaretSample[] = []
    const startedAt = performance.now()
    testWindow.__pmdDrawerCaretTrace = samples
    testWindow.__pmdDrawerCaretTraceDone = new Promise<void>((resolve) => {
      const sampleAfterPaint = () => {
        requestAnimationFrame(() => {
          window.setTimeout(() => {
            const line = document.querySelector<HTMLElement>(".cm-line")
            const cursor = [
              ...document.querySelectorAll<HTMLElement>(".cm-cursor"),
            ].find((candidate) => candidate.getBoundingClientRect().height > 0)
            if (line && cursor) {
              samples.push({
                cursorTop: cursor.getBoundingClientRect().top,
                lineTop: line.getBoundingClientRect().top,
              })
            }
            if (performance.now() - startedAt < 220) {
              sampleAfterPaint()
            } else {
              resolve()
            }
          }, 0)
        })
      }
      sampleAfterPaint()
    })
  })
}

async function readDrawerCaretTrace(page: Page) {
  return page.evaluate(async () => {
    const testWindow = window as Window & {
      __pmdDrawerCaretTrace?: DrawerCaretSample[]
      __pmdDrawerCaretTraceDone?: Promise<void>
    }
    await testWindow.__pmdDrawerCaretTraceDone
    return testWindow.__pmdDrawerCaretTrace ?? []
  })
}

function expectDrawerCaretToTrackText(samples: DrawerCaretSample[]) {
  expect(samples.length).toBeGreaterThan(3)
  const lineTops = samples.map((sample) => sample.lineTop)
  expect(Math.max(...lineTops) - Math.min(...lineTops)).toBeGreaterThan(20)
  const cursorOffsets = samples.map(
    (sample) => sample.cursorTop - sample.lineTop
  )
  // The line's fractional CSS transition and CodeMirror's separately measured
  // cursor can land on opposite subpixel boundaries without visible drift.
  expect(
    Math.max(...cursorOffsets) - Math.min(...cursorOffsets)
  ).toBeLessThanOrEqual(2)
}

async function openTypographySettings(page: Page) {
  await page.getByRole("button", { name: "Customize typography" }).click()
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Typography preview workspace" })
  ).toBeVisible()
}

async function cancelTypographySettings(page: Page) {
  const workspace = page.getByRole("region", {
    name: "Typography preview workspace",
  })
  await workspace.getByRole("button", { name: "Cancel" }).click()
  await expect(workspace).toHaveCount(0)
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
}

async function saveTypographySettings(page: Page) {
  const workspace = page.getByRole("region", {
    name: "Typography preview workspace",
  })
  await workspace.getByRole("button", { name: "Save" }).click()
  await expect(workspace).toHaveCount(0)
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
}

async function openLaunchTransitionSettings(page: Page) {
  await page
    .getByRole("button", { name: "Customize launch transition" })
    .click()
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
  await expect(
    page.getByRole("region", {
      name: "Launch transition preview workspace",
    })
  ).toBeVisible()
}

function settingsSaveButton(page: Page) {
  return page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Done", exact: true })
}

function themePresetPicker(page: Page, scheme: "light" | "dark") {
  return page.locator(`#${scheme}-appearance-preset`)
}

async function chooseThemePreset(
  page: Page,
  scheme: "light" | "dark",
  label: string
) {
  await themePresetPicker(page, scheme).click()
  await page.getByRole("option", { name: label, exact: true }).click()
}

async function cursorLineText(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const cursor = [...document.querySelectorAll(".cm-cursor")].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.bottom > rect.top
      }
    )
    if (!cursor) return null
    const cursorRect = cursor.getBoundingClientRect()
    const cursorY = (cursorRect.top + cursorRect.bottom) / 2
    let closest: { distance: number; text: string } | null = null
    for (const line of document.querySelectorAll(".cm-line")) {
      const rect = line.getBoundingClientRect()
      const distance = Math.abs((rect.top + rect.bottom) / 2 - cursorY)
      if (!closest || distance < closest.distance) {
        closest = { distance, text: line.textContent ?? "" }
      }
    }
    return closest?.text ?? null
  })
}

test("the frameless surface edits live Markdown and exposes intentional UI", async () => {
  const userData = await createTestUserData()
  const descenderDocument = path.join(
    userData,
    "gypsy-puppy-jogging-display.md"
  )
  await writeFile(descenderDocument, await readFile(samplePath, "utf8"))
  const app = await launchApplication(userData, descenderDocument)
  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await expect(editor).toHaveClass(/cm-md-live/)
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()
    await expect(page.locator(".cm-lineNumbers")).toHaveCount(0)
    const centeredFileLabel = page.locator(
      ".centered-file-label .file-label-content"
    )
    await expect(centeredFileLabel).toHaveCSS("font-size", "14px")
    await expect(centeredFileLabel).toContainText(
      "gypsy-puppy-jogging-display.md"
    )
    const centeredFilenameGeometry = await centeredFileLabel.evaluate(
      (element) => {
        const filename = element.querySelector<HTMLElement>(
          ".path-filename-text"
        )
        if (!filename) throw new Error("Centered filename text is unavailable")
        const range = document.createRange()
        range.selectNodeContents(filename)
        const textBounds = range.getBoundingClientRect()
        const clippingAncestors: Array<{
          bottom: number
          className: string
          top: number
        }> = []
        for (
          let ancestor = filename.parentElement;
          ancestor && element.contains(ancestor);
          ancestor = ancestor.parentElement
        ) {
          const styles = getComputedStyle(ancestor)
          if (
            ["clip", "hidden"].includes(styles.overflowY) ||
            ["clip", "hidden"].includes(styles.overflow)
          ) {
            const bounds = ancestor.getBoundingClientRect()
            clippingAncestors.push({
              bottom: bounds.bottom,
              className: ancestor.className,
              top: bounds.top,
            })
          }
        }
        return {
          clippingAncestors,
          textBounds: {
            bottom: textBounds.bottom,
            top: textBounds.top,
          },
        }
      }
    )
    expect(centeredFilenameGeometry.clippingAncestors.length).toBeGreaterThan(0)
    for (const clippingBounds of centeredFilenameGeometry.clippingAncestors) {
      expect(
        centeredFilenameGeometry.textBounds.bottom,
        `filename descenders should fit inside ${clippingBounds.className}`
      ).toBeLessThanOrEqual(clippingBounds.bottom + 0.5)
      expect(
        centeredFilenameGeometry.textBounds.top,
        `filename ink should fit above ${clippingBounds.className}`
      ).toBeGreaterThanOrEqual(clippingBounds.top - 0.5)
    }
    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-focused/)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()

    const tableGeometry = await page
      .locator(".cm-md-table-header")
      .evaluate((header) => {
        const body = header.parentElement?.querySelector(".cm-md-table-row")
        const headerCells = [
          ...header.querySelectorAll(":scope > .cm-md-table-cell"),
        ]
        const bodyCells = body
          ? [...body.querySelectorAll(":scope > .cm-md-table-cell")]
          : []
        return {
          headerCells: headerCells.map((cell) => {
            const rect = cell.getBoundingClientRect()
            return { left: rect.left, width: rect.width }
          }),
          bodyCells: bodyCells.map((cell) => {
            const rect = cell.getBoundingClientRect()
            return { left: rect.left, width: rect.width }
          }),
          sourcePaddingHidden: [...header.children]
            .filter((child) => !child.classList.contains("cm-md-table-cell"))
            .every((child) => getComputedStyle(child).display === "none"),
          headerTextIsNotUnderlined: [
            ...header.querySelectorAll(".cm-md-table-cell > span"),
          ].every(
            (child) => getComputedStyle(child).textDecorationLine === "none"
          ),
          headerTextUsesRowColor: [
            ...header.querySelectorAll(".cm-md-table-cell > span"),
          ].every(
            (child) =>
              getComputedStyle(child).color === getComputedStyle(header).color
          ),
        }
      })
    expect(tableGeometry.sourcePaddingHidden).toBe(true)
    expect(tableGeometry.headerTextIsNotUnderlined).toBe(true)
    expect(tableGeometry.headerTextUsesRowColor).toBe(true)
    expect(tableGeometry.headerCells).toHaveLength(2)
    expect(tableGeometry.bodyCells).toHaveLength(2)
    for (const [index, headerCell] of tableGeometry.headerCells.entries()) {
      const bodyCell = tableGeometry.bodyCells[index]
      expect(bodyCell).toBeDefined()
      expect(Math.abs(headerCell.left - bodyCell!.left)).toBeLessThanOrEqual(
        0.5
      )
      expect(Math.abs(headerCell.width - bodyCell!.width)).toBeLessThanOrEqual(
        0.5
      )
    }

    const liveTypography = await page.evaluate(() => {
      const editor = document.querySelector(".cm-editor")
      const content = document.querySelector(".cm-content")
      const heading = document.querySelector(".cm-md-heading-1")
      const inlineCode = document.querySelector(".cm-md-inline-code")
      if (!editor || !content || !heading || !inlineCode) {
        throw new Error("Live editor typography is unavailable")
      }
      return {
        bodyFont: getComputedStyle(content).fontFamily,
        bodyFontSize: getComputedStyle(editor).fontSize,
        bodyFontWeight: getComputedStyle(editor).fontWeight,
        bodyLineHeight: getComputedStyle(content).lineHeight,
        headingFontSize: getComputedStyle(heading).fontSize,
        codeFont: getComputedStyle(inlineCode).fontFamily,
        codeFontSize: getComputedStyle(inlineCode).fontSize,
      }
    })
    expect(liveTypography.bodyFont).toContain("-apple-system")
    expect(liveTypography.bodyFontSize).toBe("20px")
    expect(liveTypography.bodyFontWeight).toBe("445")
    expect(liveTypography.bodyLineHeight).toBe("28px")
    expect(liveTypography.headingFontSize).toBe("46px")
    expect(liveTypography.codeFont).toContain("Cascadia Code Variable")
    expect(liveTypography.codeFontSize).toBe("20px")

    const firstLine = page.locator(".cm-line").first()
    await clickVisibleText(page, page.locator(".cm-line").nth(2))
    await expect(firstLine).toHaveText("A quiet Markdown window")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(editor).toHaveClass(/cm-focused/)
    await page.locator(".cm-content").dispatchEvent("pointerdown", {
      button: 0,
      buttons: 1,
      pointerId: 41,
    })
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Home" : "Control+Home"
    )
    await expect(firstLine).toContainText("# A quiet Markdown window")

    await activateWindow(page)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(editor).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-lineNumbers")).toHaveCount(1)
    const sourceTypography = await page.evaluate(() => {
      const content = document.querySelector(".cm-content")
      const gutters = document.querySelector(".cm-gutters")
      const firstLine = document.querySelector(".cm-line")
      const firstLineNumber = [
        ...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
      ].find(
        (element) =>
          getComputedStyle(element).visibility !== "hidden" &&
          element.textContent === "1"
      )
      if (!content || !gutters || !firstLine || !firstLineNumber)
        throw new Error("Source editor typography is unavailable")
      const firstTextTop = (element: Element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node && !node.textContent?.trim()) node = walker.nextNode()
        if (!node?.textContent) throw new Error("Source text is unavailable")
        const offset = node.textContent.search(/\S/)
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        return range.getBoundingClientRect().top
      }
      return {
        contentFont: getComputedStyle(content).fontFamily,
        contentLigatures: getComputedStyle(content).fontVariantLigatures,
        gutterFont: getComputedStyle(gutters).fontFamily,
        gutterNumericVariant:
          getComputedStyle(firstLineNumber).fontVariantNumeric,
        firstLineTextTop: firstTextTop(firstLine),
        firstLineNumberTextTop: firstTextTop(firstLineNumber),
      }
    })
    expect(sourceTypography.contentFont).toContain("Cascadia Code Variable")
    expect(sourceTypography.contentLigatures).toBe("normal")
    expect(sourceTypography.gutterFont).toBe(sourceTypography.contentFont)
    expect(sourceTypography.gutterNumericVariant).toBe("tabular-nums")
    expect(
      Math.abs(
        sourceTypography.firstLineTextTop -
          sourceTypography.firstLineNumberTextTop
      )
    ).toBeLessThanOrEqual(0.1)
    const lineNumberColors = await page.evaluate(() => {
      const active = document.querySelector<HTMLElement>(
        ".cm-lineNumbers .cm-activeLineGutter"
      )
      const inactive = document.querySelector<HTMLElement>(
        ".cm-lineNumbers .cm-gutterElement:not(.cm-activeLineGutter)"
      )
      if (!active || !inactive) {
        throw new Error("Active line-number styling is unavailable")
      }
      return {
        active: getComputedStyle(active).color,
        inactive: getComputedStyle(inactive).color,
      }
    })
    expect(lineNumberColors.active).not.toBe(lineNumberColors.inactive)

    const wrappingBefore = await page
      .locator(".cm-content")
      .evaluate((element) => getComputedStyle(element).whiteSpace)
    await page.keyboard.press("Alt+Z")
    const wrappingAfter = await page
      .locator(".cm-content")
      .evaluate((element) => getComputedStyle(element).whiteSpace)
    expect(wrappingAfter).not.toBe(wrappingBefore)
    await runViewMenuItem(app, "view-text-wrapping")
    await expect
      .poll(() =>
        page
          .locator(".cm-content")
          .evaluate((element) => getComputedStyle(element).whiteSpace)
      )
      .toBe(wrappingBefore)

    await runViewMenuItem(app, "view-formatting-bar")
    await expect(page.locator(".formatting-toolbar")).toBeVisible()
    await runViewMenuItem(app, "view-formatting-bar")
    await expect(page.locator(".formatting-toolbar")).toHaveCount(0)

    const statusRevealRegion = page.locator(".status-overlay-reveal-region")
    await runViewMenuItem(app, "view-status-bar")
    await expect(statusRevealRegion).toHaveAttribute(
      "data-always-visible",
      "true"
    )
    await runViewMenuItem(app, "view-status-bar")
    await expect(statusRevealRegion).not.toHaveAttribute("data-always-visible")

    await runViewMenuItem(app, "view-tabs-hidden")
    await expect(
      page.getByRole("tablist", { name: "Open documents" })
    ).toHaveCount(0)
    await runViewMenuItem(app, "view-tabs-mouseover")
    await expect(
      page.getByRole("tablist", { name: "Open documents" })
    ).toHaveCount(1)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    const findInput = page.getByRole("textbox", { name: "Find" })
    await expect(findInput).toBeFocused()
    await findInput.fill("Markdown")
    await expect(page.locator(".cm-searchMatch").first()).toBeVisible()
    await page.keyboard.press("Escape")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await expect(page.getByRole("dialog")).toBeVisible()
    await openSettingsSection(page, "Miscellaneous")
    await expect(
      page.getByLabel("Maximum content width in pixels")
    ).toHaveValue("960")
    await openTypographySettings(page)
    await expect(page.getByLabel("Base font size in pixels")).toHaveValue("20")
    await expect(page.getByLabel("Monospace font size in pixels")).toHaveValue(
      "20"
    )
    await expect(
      page.getByLabel("Callout Title font size in pixels")
    ).toHaveValue("20")
    await expect(
      page.getByRole("spinbutton", { name: "H1 scale relative to base" })
    ).toHaveValue("2.3")
    await expect(page.getByRole("button", { name: "H1 bold" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect(page.getByRole("button", { name: "H3 bold" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect(
      page.getByRole("switch", { name: "Code ligatures" })
    ).toBeChecked()
    await cancelTypographySettings(page)
    await expect(page.getByLabel("Zoom percentage")).toHaveValue("100")
    await expect(settingsSelect(page, "Raw Markdown Tab key")).toHaveText(
      "Spaces"
    )
    await expect(page.getByLabel("Spaces per Tab")).toHaveValue("2")
    await openSettingsSection(page, "Theme")
    await expect(
      page.getByRole("radiogroup", { name: "Appearance mode" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Theme" }).locator("svg.lucide-palette")
    ).toHaveCount(1)

    if (process.platform === "darwin") {
      const transparencySection = page.getByRole("button", {
        name: "Transparency & Blur",
      })
      await expect(transparencySection.locator("svg.lucide-blend")).toHaveCount(
        1
      )
      await transparencySection.click()
      await expect(
        page.getByText(
          "With no transition, transparency and blur are applied before the window appears.",
          { exact: true }
        )
      ).toHaveCount(0)
      const launchTransitionField = page
        .getByText("Launch Transition", { exact: true })
        .locator('xpath=ancestor::*[@data-slot="field"][1]')
      const launchTransitionCenters = await launchTransitionField.evaluate(
        (field) => {
          const reset = field.querySelector<HTMLElement>(
            'button[aria-label="Reset launch transition"]'
          )
          const toggle = field.querySelector<HTMLElement>(
            '[role="switch"][aria-label="Launch transition"]'
          )
          const customize = field.querySelector<HTMLElement>(
            'button[aria-label="Customize launch transition"]'
          )
          if (!reset || !toggle || !customize) {
            throw new Error("Launch transition controls are unavailable")
          }
          const center = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect()
            return rect.top + rect.height / 2
          }
          return {
            customize: center(customize),
            reset: center(reset),
            toggle: center(toggle),
          }
        }
      )
      expect(
        Math.abs(
          launchTransitionCenters.reset - launchTransitionCenters.customize
        )
      ).toBeLessThanOrEqual(1)
      expect(
        Math.abs(launchTransitionCenters.reset - launchTransitionCenters.toggle)
      ).toBeLessThanOrEqual(1)
    }

    const windowChromeSection = page.getByRole("button", {
      name: "Window Chrome",
    })
    await expect(
      windowChromeSection.locator("svg.lucide-panel-top")
    ).toHaveCount(1)
    await windowChromeSection.click()
    const tabVisibility = settingsSelect(page, "Show tabs")
    await expect(tabVisibility).toHaveText("On Mouseover")
    await tabVisibility.click()
    await expect(
      page.locator('[data-slot="select-content"]:visible').getByRole("option")
    ).toHaveText([
      "Always",
      "With Multiple Tabs",
      "On Mouseover",
      "With Formatting Toolbar",
      "Hidden",
    ])
    await page
      .locator('[data-slot="select-content"]:visible')
      .getByRole("option", { name: "With Multiple Tabs", exact: true })
      .click()
    await expect(tabVisibility).toHaveText("With Multiple Tabs")
    await expect(
      page.getByRole("switch", { name: "Show formatting toolbar" })
    ).not.toBeChecked()
    await expect(
      settingsSelect(page, "Formatting toolbar position")
    ).toHaveText("Center")
    await expect(
      settingsSelect(page, "Tabs and toolbar mouse-wheel direction")
    ).toHaveText("Down Scrolls Right")
    await expect(
      page.getByRole("switch", { name: "Show centered path" })
    ).toBeChecked()
    await expect(settingsSelect(page, "Centered path display")).toHaveText(
      "Full Path"
    )
    await expect(settingsSelect(page, "Tab path display")).toHaveText(
      "Full Path"
    )

    await expect(
      page.getByRole("switch", { name: "Always show status bar" })
    ).not.toBeChecked()
    for (const label of [
      "Words",
      "Lines",
      "Characters",
      "Cursor position",
      "Text encoding",
      "Line ending",
    ]) {
      await expect(page.getByRole("switch", { name: label })).toBeChecked()
    }

    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden()
    await page.mouse.move(400, 400)
    const tabStrip = page.getByRole("tablist", { name: "Open documents" })
    await expect(tabStrip).not.toHaveAttribute("data-visible")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(tabStrip.getByRole("tab")).toHaveCount(2)
    await expect(tabStrip).toHaveAttribute("data-visible", "true")
    await expect(tabStrip.getByRole("tab").first()).toHaveCSS(
      "font-size",
      "12px"
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+W" : "Control+W"
    )
    await expect(tabStrip.getByRole("tab")).toHaveCount(1)
    await expect(tabStrip).not.toHaveAttribute("data-visible")
    const viewMenuItems = await app.evaluate(({ Menu }) => {
      const viewMenu = Menu.getApplicationMenu()?.items.find(
        (item) => item.label === "View"
      )
      const viewItems = viewMenu?.submenu?.items ?? []
      const tabItems =
        viewItems.find((item) => item.label === "Tabs")?.submenu?.items ?? []
      return [...viewItems, ...tabItems].map((item) => ({
        id: item.id,
        role: item.role,
      }))
    })
    expect(viewMenuItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "resetzoom" }),
        expect.objectContaining({ id: "zoom-in" }),
        expect.objectContaining({ id: "zoom-out" }),
        expect.objectContaining({ id: "view-tabs-multiple-tabs" }),
      ])
    )
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
      )
    ).toBe(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("typography customization uses one read-only preview and offers included and installed fonts @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  const settingsShortcut =
    process.platform === "darwin" ? "Meta+," : "Control+,"

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1120, 820)
    })
    const editor = page.locator(".cm-editor")
    await editor.waitFor()
    const editorElement = await editor.elementHandle()
    if (!editorElement) throw new Error("Editor element is unavailable")
    const originalVisibleText = await page.locator(".cm-content").textContent()

    await page.keyboard.press(settingsShortcut)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Customize typography" })
    ).toBeVisible()
    await page.getByRole("button", { name: "Customize typography" }).click()
    const typographySurface = page.getByRole("region", {
      name: "Typography preview workspace",
    })
    await expect(typographySurface).toBeVisible()
    const initialTypographySurface = await page.evaluate(() => {
      const dock = document.querySelector<HTMLElement>(
        'section[aria-label="Typography controls"]'
      )
      const workspace = document.querySelector<HTMLElement>(
        '[aria-label="Typography preview workspace"]'
      )
      return {
        dockHeight: dock?.getBoundingClientRect().height ?? 0,
        loading: workspace?.hasAttribute("data-settings-workspace-loading"),
        reservedDockHeight: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--typography-dock-height"
          )
        ),
        workspaceHeight: workspace?.getBoundingClientRect().height ?? 0,
      }
    })
    expect(initialTypographySurface.workspaceHeight).toBeGreaterThan(0)
    if (initialTypographySurface.loading) {
      expect(initialTypographySurface.dockHeight).toBe(0)
    } else {
      expect(initialTypographySurface.dockHeight).toBeGreaterThan(0)
      expect(initialTypographySurface.reservedDockHeight).toBeGreaterThan(0)
    }
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
    await expect(
      page.getByRole("region", { name: "Typography preview workspace" })
    ).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Typography controls" })
    ).toBeVisible()
    const loadedTypographyGeometry = await page.evaluate(() => {
      const dock = document.querySelector<HTMLElement>(
        'section[aria-label="Typography controls"]'
      )
      return {
        dockHeight: dock?.getBoundingClientRect().height ?? 0,
        reservedDockHeight: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--typography-dock-height"
          )
        ),
      }
    })
    expect(loadedTypographyGeometry.dockHeight).toBeGreaterThan(0)
    expect(loadedTypographyGeometry.reservedDockHeight).toBeGreaterThan(0)

    await expect(
      page.locator(".centered-file-label[data-preview-title]")
    ).toHaveText("Typography Preview")
    expect(
      await page.evaluate(
        (original) => original === document.querySelector(".cm-editor"),
        editorElement
      )
    ).toBe(true)
    await expect(page.locator(".cm-content")).toContainText(
      "An Evening at North Ridge"
    )
    await expect(page.locator(".cm-md-heading-1")).toHaveCount(1)
    await expect(page.locator(".cm-md-inline-code")).toContainText(
      "north-ridge.md"
    )
    const previewScroller = page.locator(".cm-scroller")
    await previewScroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(
      page.locator(".cm-md-code-line", { hasText: "frame.signal >= 0.8" })
    ).toBeVisible()
    await expect(page.locator(".cm-md-callout-title")).toHaveText(
      "Preserve the quiet"
    )
    await previewScroller.evaluate((element) => {
      element.scrollTop = 0
    })
    const revealPreviewHeading = async () => {
      await expect
        .poll(() =>
          previewScroller.evaluate(
            (element) =>
              new Promise<{ headingMounted: boolean; scrollTop: number }>(
                (resolve) => {
                  element.scrollTop = 0
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() =>
                      resolve({
                        headingMounted: Boolean(
                          document.querySelector(".cm-md-heading-1")
                        ),
                        scrollTop: element.scrollTop,
                      })
                    )
                  )
                }
              )
          )
        )
        .toEqual({ headingMounted: true, scrollTop: 0 })
      await expect(page.locator(".cm-md-heading-1")).toBeVisible()
    }
    await revealPreviewHeading()
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false"
    )
    await expect(page.locator(".cm-md-code-tooltip[data-visible]")).toHaveCount(
      0
    )
    await expect(page.getByRole("heading", { name: "Typography" })).toHaveCount(
      0
    )
    await expect(
      page.getByText("Changes appear in the sample above as you make them.")
    ).toHaveCount(0)

    const previewVisibleText = await page.locator(".cm-content").textContent()
    await page.locator(".cm-md-heading-1").click()
    await page.keyboard.type("This must not edit the sample")
    await expect(page.locator(".cm-content")).toHaveText(previewVisibleText!)

    const reservedGeometry = await page.evaluate(() => {
      const editorNode = document.querySelector<HTMLElement>(".cm-editor")
      const dock = document.querySelector<HTMLElement>(
        'section[aria-label="Typography controls"]'
      )
      if (!editorNode || !dock) throw new Error("Preview geometry unavailable")
      return {
        editorBottom: editorNode.getBoundingClientRect().bottom,
        dockTop: dock.getBoundingClientRect().top,
      }
    })
    expect(reservedGeometry.editorBottom).toBeLessThanOrEqual(
      reservedGeometry.dockTop + 1
    )

    const typographyPanelAppearance = await page.evaluate(() => {
      const dock = document.querySelector<HTMLElement>(
        'section[aria-label="Typography controls"]'
      )
      const bold = document.querySelector<HTMLElement>(
        'button[aria-label="H3 bold"]'
      )
      const scaleInput = document.querySelector<HTMLElement>(
        '[role="spinbutton"][aria-label="H1 scale relative to base"]'
      )
      if (!dock || !bold || !scaleInput) {
        throw new Error("Typography panel geometry unavailable")
      }
      const boldStyle = getComputedStyle(bold)
      return {
        boldHeight: bold.getBoundingClientRect().height,
        boldRadii: [
          boldStyle.borderTopLeftRadius,
          boldStyle.borderTopRightRadius,
          boldStyle.borderBottomRightRadius,
          boldStyle.borderBottomLeftRadius,
        ].map(Number.parseFloat),
        boldWidth: bold.getBoundingClientRect().width,
        inputWidth: scaleInput.getBoundingClientRect().width,
        panelShadow: getComputedStyle(dock).boxShadow,
      }
    })
    expect(typographyPanelAppearance.inputWidth).toBeGreaterThanOrEqual(90)
    expect(typographyPanelAppearance.panelShadow).toBe("none")
    expect(typographyPanelAppearance.boldWidth).toBeCloseTo(
      typographyPanelAppearance.boldHeight,
      1
    )
    for (const radius of typographyPanelAppearance.boldRadii) {
      expect(radius).toBeGreaterThanOrEqual(
        typographyPanelAppearance.boldWidth / 2 - 1
      )
    }

    const h1ScaleInput = page.getByRole("spinbutton", {
      name: "H1 scale relative to base",
    })
    await h1ScaleInput.click()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.type("1.9")
    await expect(h1ScaleInput).toHaveValue("1.9")
    await revealPreviewHeading()
    await expect(page.locator(".cm-md-heading-1")).toHaveCSS(
      "font-size",
      "38px"
    )
    await h1ScaleInput.press("Tab")
    await expect(h1ScaleInput).toHaveValue("1.9")

    await h1ScaleInput.fill("3")
    await revealPreviewHeading()
    await expect(page.locator(".cm-md-heading-1")).toHaveCSS(
      "font-size",
      "60px"
    )
    await page.getByLabel("Base font size in pixels").fill("16")
    await revealPreviewHeading()
    await expect(page.locator(".cm-md-heading-1")).toHaveCSS(
      "font-size",
      "48px"
    )
    await expect(page.locator(".cm-md-heading-3")).toHaveCSS(
      "font-weight",
      "700"
    )
    await page.getByRole("button", { name: "H3 bold" }).click()
    await expect(page.locator(".cm-md-heading-3")).toHaveCSS(
      "font-weight",
      "400"
    )
    await page.getByRole("button", { name: "H3 bold" }).click()

    const revealPreviewCallout = async () => {
      await previewScroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect(page.locator(".cm-md-callout-title")).toBeVisible()
    }
    await page.getByLabel("Callout Title font size in pixels").fill("20")
    await page.getByLabel("Base font size in pixels").fill("12")
    await revealPreviewCallout()
    await expect(page.locator(".cm-md-callout-title")).toHaveCSS(
      "font-size",
      "20px"
    )
    await page.getByLabel("Base font size in pixels").fill("40")
    await revealPreviewCallout()
    await expect(page.locator(".cm-md-callout-title")).toHaveCSS(
      "font-size",
      "20px"
    )

    await page.getByLabel("Callout Title font size in pixels").fill("72")
    await revealPreviewCallout()
    await expect(page.locator(".cm-md-callout-title")).toHaveCSS(
      "font-size",
      "72px"
    )

    const regularFont = page.getByRole("combobox", {
      name: "Regular Font",
      exact: true,
    })
    await expect(regularFont).toHaveValue("Inter")
    await regularFont.click()
    await expect(regularFont).toBeFocused()
    await expect(
      page.getByRole("option", { name: /Newsreader Included/ })
    ).toBeVisible()
    await expect(
      page.getByRole("option").filter({ hasText: "Installed" }).first()
    ).toBeVisible()
    await expect(
      page.locator('[role="status"]').filter({
        hasText: /[1-9]\d* installed font (family|families)/,
      })
    ).toBeVisible()
    const fontPopup = page.locator('[data-slot="combobox-content"]')
    const fontList = fontPopup.locator('[data-slot="combobox-list"]')
    await expect(fontPopup.getByRole("combobox")).toHaveCount(0)
    await expect(
      fontPopup.locator(':scope > [data-slot="combobox-list"]')
    ).toHaveCount(1)
    const regularFontGroup = regularFont.locator(
      'xpath=ancestor::*[@data-slot="input-group"]'
    )
    const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
    await expect
      .poll(async () => {
        const regularFontBox = await regularFontGroup.boundingBox()
        const fontPopupBox = await fontPopup.boundingBox()
        if (!regularFontBox || !fontPopupBox) return Number.POSITIVE_INFINITY
        return (
          Math.abs(fontPopupBox.width - regularFontBox.width) * devicePixelRatio
        )
      })
      .toBeLessThanOrEqual(1)
    const fontOptionCount = await page.getByRole("option").count()

    await page.keyboard.press("ArrowDown")
    await expect(regularFont).toHaveValue("Geist")
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /Geist Variable/
    )
    const highlightedGeistOption = page.getByRole("option", {
      name: /Geist Included/,
      selected: true,
    })
    await expect(highlightedGeistOption).toBeVisible()
    await expect(highlightedGeistOption).toHaveAttribute("data-highlighted", "")
    await expect(page.getByRole("option")).toHaveCount(fontOptionCount)

    await page.keyboard.press("ArrowDown")
    await expect(regularFont).toHaveValue("Manrope")
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /Manrope Variable/
    )
    await expect(
      page.getByRole("option", { name: /Manrope Included/, selected: true })
    ).toBeVisible()
    await expect(page.getByRole("option")).toHaveCount(fontOptionCount)

    await page.keyboard.press("ArrowDown")
    await expect(regularFont).toHaveValue("DM Sans")
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /DM Sans Variable/
    )
    await expect(
      page.getByRole("option", { name: /DM Sans Included/, selected: true })
    ).toBeVisible()
    await expect(page.getByRole("option")).toHaveCount(fontOptionCount)

    await expect
      .poll(() =>
        fontList.evaluate(
          (element) => element.scrollHeight > element.clientHeight
        )
      )
      .toBe(true)
    await fontList.hover()
    await page.mouse.wheel(0, 500)
    await expect
      .poll(() => fontList.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)

    await page.keyboard.press("Escape")
    await expect(page.getByRole("listbox")).toHaveCount(0)
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /DM Sans Variable/
    )

    await regularFont.click()
    await expect(regularFont).toBeFocused()

    await regularFont.fill("Newsreader")
    await expect(page.getByRole("option")).toHaveCount(1)
    await page.keyboard.press("ArrowDown")
    await expect(regularFont).toHaveValue("Newsreader")
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /Newsreader Variable/
    )
    await expect(
      page.getByRole("option", {
        name: /Newsreader Included/,
        selected: true,
      })
    ).toBeVisible()
    await expect(page.getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")
    await expect(page.getByRole("listbox")).toHaveCount(0)
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /Newsreader Variable/
    )

    const monospaceFont = page.getByRole("combobox", {
      name: "Monospace Font",
      exact: true,
    })
    await monospaceFont.click()
    await expect(monospaceFont).toBeFocused()
    await monospaceFont.fill("JetBrains Mono")
    await page.getByRole("option", { name: /JetBrains Mono Included/ }).click()
    await previewScroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.35
    })
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-family",
      /JetBrains Mono Variable/
    )
    await previewScroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(
      page.locator(".cm-md-code-line", { hasText: "=>" }).first()
    ).toHaveCSS("font-variant-ligatures", "normal")

    await regularFont.click()
    await expect(
      page.getByRole("option", { name: /Newsreader Included/ })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("option", { name: /Newsreader Included/ })
    ).toHaveCount(0)
    await expect(
      page.getByRole("region", { name: "Typography preview workspace" })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("region", { name: "Typography preview workspace" })
    ).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
    expect(
      await page.evaluate(
        (original) => original === document.querySelector(".cm-editor"),
        editorElement
      )
    ).toBe(true)
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true"
    )
    await expect(page.locator(".cm-content")).toHaveText(
      originalVisibleText!.replace(/^# /, "")
    )
    await page.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("launch transition workspace previews and commits only launch settings", async () => {
  test.skip(
    process.platform !== "darwin",
    "Native launch effects are macOS-only"
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await activateWindow(page)
    await page.keyboard.press("Meta+,")
    await openSettingsSection(page, "Miscellaneous")
    await page.getByLabel("Maximum content width in pixels").fill("1200")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    const initialLaunchTransitionToggle = page.getByRole("switch", {
      name: "Launch transition",
    })
    const customizeLaunchTransition = page.getByRole("button", {
      name: "Customize launch transition",
    })
    await expect(initialLaunchTransitionToggle).not.toBeChecked()
    await expect(customizeLaunchTransition).toBeDisabled()
    await initialLaunchTransitionToggle.click()
    await expect(customizeLaunchTransition).toBeEnabled()
    await openLaunchTransitionSettings(page)

    const workspace = page.getByRole("region", {
      name: "Launch transition preview workspace",
    })
    await expect(page.locator(".centered-file-label")).toHaveText(
      "Launch Transition Preview"
    )
    const previewBackgrounds = await workspace
      .locator(".launch-transition-preview")
      .evaluate((preview) => {
        const comparison = document.createElement("span")
        comparison.style.backgroundColor = "var(--document-background)"
        preview.append(comparison)
        const result = {
          actual: getComputedStyle(preview).backgroundColor,
          expected: getComputedStyle(comparison).backgroundColor,
        }
        comparison.remove()
        return result
      })
    expect(previewBackgrounds.actual).toBe(previewBackgrounds.expected)

    const duration = workspace.getByRole("spinbutton", {
      name: "Duration in milliseconds",
    })
    const delay = workspace.getByRole("spinbutton", {
      name: "Delay in milliseconds",
    })
    await expect(duration).toHaveValue("2,000")
    await expect(delay).toHaveValue("150")
    await expect(
      workspace.getByRole("slider", { name: "Duration" })
    ).toHaveAttribute("max", "10000")
    await expect(
      workspace.getByRole("slider", { name: "Delay" })
    ).toHaveAttribute("max", "10000")
    await expect(
      workspace.getByRole("combobox", { name: "Launch transition easing" })
    ).toContainText("CSS Ease-Out")
    await expect(
      workspace.getByRole("combobox", { name: "Launch transition strategy" })
    ).toContainText("Tint and Blur Together")

    const easing = workspace.getByRole("combobox", {
      name: "Launch transition easing",
    })
    await easing.click()
    const easingPopup = page.locator('[data-slot="select-content"][data-open]')
    await expect(easingPopup).toBeVisible()
    const [easingTriggerWidth, easingMenuGeometry] = await Promise.all([
      easing.evaluate((element) =>
        element instanceof HTMLElement ? element.offsetWidth : Number.NaN
      ),
      easingPopup.evaluate((popup) => {
        const group = popup.querySelector<HTMLElement>(
          '[data-slot="select-group"]'
        )
        if (!group) {
          throw new Error("Launch transition easing group is unavailable")
        }
        const groupStyle = getComputedStyle(group)
        return {
          groupPadding: {
            bottom: Number.parseFloat(groupStyle.paddingBottom),
            left: Number.parseFloat(groupStyle.paddingLeft),
            right: Number.parseFloat(groupStyle.paddingRight),
            top: Number.parseFloat(groupStyle.paddingTop),
          },
          width: popup instanceof HTMLElement ? popup.offsetWidth : Number.NaN,
        }
      }),
    ])
    expect(easingMenuGeometry.width).toBe(easingTriggerWidth)
    expect(easingMenuGeometry.groupPadding.bottom).toBeGreaterThanOrEqual(5)
    expect(easingMenuGeometry.groupPadding.left).toBeGreaterThanOrEqual(5)
    expect(easingMenuGeometry.groupPadding.right).toBeGreaterThanOrEqual(5)
    expect(easingMenuGeometry.groupPadding.top).toBeGreaterThanOrEqual(5)
    await expect(
      easingPopup.getByRole("option", { name: "CSS Ease-Out" })
    ).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(easingPopup).toHaveCount(0)
    await expect(workspace).toBeVisible()

    await chooseSelectOption(page, easing, "Custom Cubic-Bezier")
    await workspace
      .getByRole("textbox", { name: "Custom launch transition easing" })
      .fill("cubic-bezier(0.2, -0.1, 0.8, 1)")
    await expect(workspace.getByRole("button", { name: "Save" })).toBeDisabled()
    await chooseSelectOption(page, easing, "CSS Ease-Out")
    await expect(workspace.getByRole("button", { name: "Save" })).toBeEnabled()

    await duration.fill("2400")
    await duration.press("Enter")
    await delay.fill("350")
    await delay.press("Enter")
    await chooseSelectOption(
      page,
      workspace.getByRole("combobox", {
        name: "Launch transition easing",
      }),
      "Linear"
    )
    await chooseSelectOption(
      page,
      workspace.getByRole("combobox", {
        name: "Launch transition strategy",
      }),
      "Opaque Cover Crossfade"
    )
    await workspace.getByRole("button", { name: "Save" }).click()
    await expect(workspace).toHaveCount(0)
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()

    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({
        backgroundEffect: { enabled: false },
        launchTransition: {
          customEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
          delayMs: 350,
          durationMs: 2400,
          easing: "linear",
          enabled: true,
          strategy: "cover",
        },
        maxContentWidth: 960,
      })

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await openLaunchTransitionSettings(page)
    const reopenedWorkspace = page.getByRole("region", {
      name: "Launch transition preview workspace",
    })
    await expect(
      reopenedWorkspace.getByRole("spinbutton", {
        name: "Duration in milliseconds",
      })
    ).toHaveValue("2,400")
    await expect(
      reopenedWorkspace.getByRole("spinbutton", {
        name: "Delay in milliseconds",
      })
    ).toHaveValue("350")
    await reopenedWorkspace.getByRole("button", { name: "Cancel" }).click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    const launchTransitionToggle = page.getByRole("switch", {
      name: "Launch transition",
    })
    await expect(launchTransitionToggle).toBeChecked()
    await launchTransitionToggle.click()
    await settingsSaveButton(page).click()
    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({ launchTransition: { enabled: false } })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("live headings use the requested scale and upper-level weight @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const temporaryDocument = path.join(userData, "heading-typography.md")
  await writeFile(
    temporaryDocument,
    Array.from(
      { length: 6 },
      (_, index) =>
        `${"#".repeat(index + 1)} Heading ${index + 1}${
          index === 5 ? " with **intentional bold**" : ""
        }`
    ).join("\n\n")
  )
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    await expect(page.locator(".cm-md-heading-6")).toBeVisible()

    const headingTypography = await page.evaluate(() =>
      Array.from({ length: 6 }, (_, index) => {
        const level = index + 1
        const heading = document.querySelector(`.cm-md-heading-${level}`)
        const text = [...(heading?.querySelectorAll("span") ?? [])].find(
          (candidate) => candidate.textContent?.includes(`Heading ${level}`)
        )
        if (!heading || !text) {
          throw new Error(`Heading ${level} typography is unavailable`)
        }

        return {
          fontSize: getComputedStyle(text).fontSize,
          fontWeight: getComputedStyle(text).fontWeight,
        }
      })
    )

    expect(headingTypography).toEqual([
      { fontSize: "46px", fontWeight: "700" },
      { fontSize: "38px", fontWeight: "700" },
      { fontSize: "32px", fontWeight: "700" },
      { fontSize: "26px", fontWeight: "700" },
      { fontSize: "23px", fontWeight: "700" },
      { fontSize: "20px", fontWeight: "700" },
    ])
    await expect(page.locator(".cm-md-heading-6 .cm-md-strong span")).toHaveCSS(
      "font-weight",
      "700"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("document-end navigation keeps the caret above the overlaid status bar @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-document-end-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    Array.from({ length: 200 }, (_, index) => `Line ${index + 1}`).join("\n")
  )
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const status = page.locator(".status-overlay")
    await editor.waitFor()
    await expect(content).toBeFocused()
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()

    const statusHeight = await status.evaluate(
      (element) => element.getBoundingClientRect().height
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End"
    )

    await expect
      .poll(() =>
        page.evaluate((reservedHeight) => {
          const cursor = [...document.querySelectorAll(".cm-cursor")].find(
            (candidate) => {
              const rect = candidate.getBoundingClientRect()
              return rect.height > 0
            }
          )
          const lines = document.querySelectorAll<HTMLElement>(".cm-line")
          const lastLine = lines.item(lines.length - 1)
          if (!cursor || !lastLine) return false
          const cursorRect = cursor.getBoundingClientRect()
          const lastLineRect = lastLine.getBoundingClientRect()
          return (
            lastLine.textContent === "Line 200" &&
            cursorRect.top >= lastLineRect.top &&
            cursorRect.bottom <= lastLineRect.bottom &&
            cursorRect.bottom <= window.innerHeight - reservedHeight
          )
        }, statusHeight)
      )
      .toBe(true)
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("document-start navigation keeps the caret below the overlaid top chrome @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-document-start-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    Array.from({ length: 200 }, (_, index) => `Line ${index + 1}`).join("\n")
  )
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    await editor.waitFor()
    await expect(content).toBeFocused()
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End"
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home"
    )

    await expect
      .poll(() =>
        page.evaluate(() => {
          const chrome = document.querySelector<HTMLElement>(".top-chrome")
          const cursor = [...document.querySelectorAll(".cm-cursor")].find(
            (candidate) => {
              const rect = candidate.getBoundingClientRect()
              return rect.height > 0
            }
          )
          const firstLine = document.querySelector<HTMLElement>(".cm-line")
          if (!chrome || !cursor || !firstLine) return false
          const chromeRect = chrome.getBoundingClientRect()
          const cursorRect = cursor.getBoundingClientRect()
          const firstLineRect = firstLine.getBoundingClientRect()
          return (
            firstLine.textContent === "Line 1" &&
            cursorRect.top >= firstLineRect.top &&
            cursorRect.bottom <= firstLineRect.bottom &&
            firstLineRect.top >= chromeRect.bottom
          )
        })
      )
      .toBe(true)

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()
    const scroller = page.locator(".cm-scroller")
    await expect
      .poll(() =>
        scroller.evaluate(async (element) => {
          element.scrollTop = element.scrollHeight
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
          return element.scrollTop
        })
      )
      .toBeGreaterThan(0)

    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const chrome = document.querySelector<HTMLElement>(".top-chrome")
          const cursor = [...document.querySelectorAll(".cm-cursor")].find(
            (candidate) => candidate.getBoundingClientRect().height > 0
          )
          if (!chrome || !cursor) return false
          return (
            cursor.getBoundingClientRect().top >=
            chrome.getBoundingClientRect().bottom
          )
        })
      )
      .toBe(true)
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("page zoom previews, saves, and persists native changes", async () => {
  const userData = await createTestUserData()
  const settingsShortcut =
    process.platform === "darwin" ? "Meta+," : "Control+,"
  const zoomInShortcut = process.platform === "darwin" ? "Meta+=" : "Control+="
  const zoomOutShortcut = process.platform === "darwin" ? "Meta+-" : "Control+-"
  let app: ElectronApplication | null = await launchApplication(
    userData,
    samplePath
  )

  const currentZoomFactor = () =>
    app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
    )

  try {
    let page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    const zoomInput = page.getByLabel("Zoom percentage")
    await expect(zoomInput).toHaveValue("100")
    await page.getByRole("button", { name: "Increase zoom by 5%" }).click()
    await expect(zoomInput).toHaveValue("105")
    await expect.poll(currentZoomFactor).toBeCloseTo(1.05, 5)
    await page.getByRole("button", { name: "Decrease zoom by 5%" }).click()
    await expect(zoomInput).toHaveValue("100")
    await expect.poll(currentZoomFactor).toBeCloseTo(1, 5)
    await zoomInput.fill("130")
    await expect.poll(currentZoomFactor).toBeCloseTo(1.3, 5)

    await runViewMenuItem(app, "resetzoom")
    await expect.poll(currentZoomFactor).toBeCloseTo(1, 5)
    await expect(zoomInput).toHaveValue("100")

    await zoomInput.fill("130")
    await expect.poll(currentZoomFactor).toBeCloseTo(1.3, 5)

    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect.poll(currentZoomFactor).toBeCloseTo(1, 5)

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await page.getByLabel("Zoom percentage").fill("127")
    await expect.poll(currentZoomFactor).toBeCloseTo(1.27, 5)
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).zoomFactor
      )
      .toBeCloseTo(1.27, 5)

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, samplePath)
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect.poll(currentZoomFactor).toBeCloseTo(1.27, 5)

    await activateWindow(page)
    await page.keyboard.press(zoomInShortcut)
    await expect.poll(currentZoomFactor).toBeCloseTo(1.32, 5)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).zoomFactor
      )
      .toBeCloseTo(1.32, 5)

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    const reopenedZoomInput = page.getByLabel("Zoom percentage")
    const draftFontSize = page.getByLabel("Base font size in pixels")
    await expect(reopenedZoomInput).toHaveValue("132")
    await openTypographySettings(page)
    await draftFontSize.fill("18")
    await page.keyboard.press(zoomOutShortcut)
    await expect.poll(currentZoomFactor).toBeCloseTo(1.32, 5)
    await expect(draftFontSize).toHaveValue("18")
    await cancelTypographySettings(page)
    await page.keyboard.press(zoomOutShortcut)
    await expect.poll(currentZoomFactor).toBeCloseTo(1.27, 5)
    await expect(reopenedZoomInput).toHaveValue("127")
    await page.keyboard.press("Escape")
    await expect.poll(currentZoomFactor).toBeCloseTo(1.27, 5)

    await activateWindow(page)
    await runViewMenuItem(app, "resetzoom")
    await expect.poll(currentZoomFactor).toBeCloseTo(1, 5)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).zoomFactor
      )
      .toBeCloseTo(1, 5)

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, samplePath)
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect.poll(currentZoomFactor).toBeCloseTo(1, 5)

    await activateWindow(page)
    await page.keyboard.press(zoomOutShortcut)
    await expect.poll(currentZoomFactor).toBeCloseTo(0.95, 5)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).zoomFactor
      )
      .toBeCloseTo(0.95, 5)
    await page.keyboard.press(zoomInShortcut)
    await expect.poll(currentZoomFactor).toBeCloseTo(1, 5)
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press(zoomOutShortcut)
    }
    await expect.poll(currentZoomFactor).toBeCloseTo(MIN_ZOOM_FACTOR, 5)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).zoomFactor
      )
      .toBeCloseTo(MIN_ZOOM_FACTOR, 5)
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("pinch gestures visually zoom and pan without changing layout zoom", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  const visualViewport = async (page: Page) =>
    page.evaluate(() => ({
      height: window.visualViewport?.height ?? innerHeight,
      layoutHeight: document.documentElement.clientHeight,
      layoutWidth: document.documentElement.clientWidth,
      offsetLeft: window.visualViewport?.offsetLeft ?? 0,
      offsetTop: window.visualViewport?.offsetTop ?? 0,
      scale: window.visualViewport?.scale ?? 1,
      width: window.visualViewport?.width ?? innerWidth,
    }))
  const pageZoom = () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 1
    )
  const synthesizeGesture = (
    method: "Input.synthesizePinchGesture" | "Input.synthesizeScrollGesture",
    params: Record<string, number | string>
  ) =>
    app.evaluate(
      async ({ BrowserWindow }, gesture) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents
        if (!contents) throw new Error("No web contents are available")
        contents.debugger.attach("1.3")
        try {
          await contents.debugger.sendCommand(gesture.method, gesture.params)
        } finally {
          contents.debugger.detach()
        }
      },
      { method, params }
    )

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await expect(page.getByRole("dialog")).toBeVisible()

    const before = await visualViewport(page)
    const pageZoomBefore = await pageZoom()
    await synthesizeGesture("Input.synthesizePinchGesture", {
      gestureSourceType: "default",
      relativeSpeed: 1_200,
      scaleFactor: 10,
      x: before.layoutWidth / 2,
      y: before.layoutHeight / 2,
    })
    await expect
      .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
      .toBeCloseTo(5, 4)

    const zoomed = await visualViewport(page)
    expect(zoomed.layoutWidth).toBe(before.layoutWidth)
    expect(zoomed.layoutHeight).toBe(before.layoutHeight)
    expect(zoomed.width).toBeCloseTo(before.width / 5, 3)
    expect(zoomed.height).toBeCloseTo(before.height / 5, 3)
    expect(await pageZoom()).toBeCloseTo(pageZoomBefore, 5)

    await synthesizeGesture("Input.synthesizeScrollGesture", {
      gestureSourceType: "default",
      speed: 800,
      x: zoomed.width / 2,
      xDistance: 30,
      y: zoomed.height / 2,
      yDistance: 30,
    })
    const panned = await visualViewport(page)
    expect(panned.offsetLeft).toBeLessThan(zoomed.offsetLeft)
    expect(panned.offsetTop).toBeLessThan(zoomed.offsetTop)
    expect(panned.layoutWidth).toBe(before.layoutWidth)
    expect(panned.layoutHeight).toBe(before.layoutHeight)
    expect(await pageZoom()).toBeCloseTo(pageZoomBefore, 5)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Window Profiles preserves the appearance draft and native zoom", async () => {
  const userData = await createTestUserData()
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify(
      {
        ...DEFAULT_APP_SETTINGS,
        appearanceMode: "light",
        zoomFactor: 1.25,
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData, samplePath)
  const zoomInShortcut = process.platform === "darwin" ? "Meta+=" : "Control+="
  const currentZoomFactor = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
    )

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect.poll(currentZoomFactor).toBeCloseTo(1.25, 5)
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/light/)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    const settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Theme")
    await openSettingsSection(page, "Miscellaneous")
    const appearanceMode = settings.getByRole("radiogroup", {
      name: "Appearance mode",
    })
    await appearanceMode.getByRole("radio", { name: "System" }).click()
    await expect(page.locator("html")).toHaveClass(/dark/)
    await settings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()

    const workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await expect(workspace).toBeVisible()
    await page.keyboard.press(zoomInShortcut)
    await expect.poll(currentZoomFactor).toBeCloseTo(1.25, 5)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).zoomFactor
      )
      .toBeCloseTo(1.25, 5)
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveClass(/light/)
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)

    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    await expect(settings).toBeVisible()
    await expect.poll(currentZoomFactor).toBeCloseTo(1.25, 5)
    await expect(settings.getByLabel("Zoom percentage")).toHaveValue("125")
    await expect(
      appearanceMode.getByRole("radio", { name: "System" })
    ).toHaveAttribute("aria-checked", "true")
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page.keyboard.press("Escape")
    await expect(settings).toHaveCount(0)
    await expect.poll(currentZoomFactor).toBeCloseTo(1.25, 5)
    await expect(page.locator("html")).toHaveClass(/light/)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("settings can reset individual values or restore every default", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )

    const resetAll = page.getByRole("button", { name: "Reset all" })
    await expect(resetAll).toBeDisabled()

    await page.getByRole("button", { name: "Theme" }).click()
    await chooseThemePreset(page, "dark", "Dracula")
    const resetDarkProfile = page.getByRole("button", {
      name: "Reset dark appearance profile",
    })
    await expect(resetDarkProfile).toBeEnabled()
    await page.getByRole("button", { name: "Theme" }).focus()
    await page.mouse.move(1, 1)
    await expect
      .poll(() =>
        resetDarkProfile.evaluate(
          (element) => getComputedStyle(element).opacity
        )
      )
      .toBe("0")
    await resetDarkProfile
      .locator("xpath=ancestor::*[@data-slot='field-set'][1]")
      .hover()
    await expect
      .poll(() =>
        resetDarkProfile.evaluate(
          (element) => getComputedStyle(element).opacity
        )
      )
      .toBe("1")
    await resetDarkProfile.click()
    await expect(themePresetPicker(page, "dark")).toHaveValue(
      "Default (One Dark)"
    )
    await expect(resetDarkProfile).toBeDisabled()

    await openSettingsSection(page, "Miscellaneous")
    const zoomInput = page.getByLabel("Zoom percentage")
    await zoomInput.fill("137")
    await page.getByRole("button", { name: "Reset zoom" }).click()
    await expect(zoomInput).toHaveValue("100")

    await chooseSettingsOption(page, "Raw Markdown Tab key", "Tab Character")
    const resetRawTab = page.getByRole("button", {
      name: "Reset Raw Markdown Tab key",
    })
    await expect(resetRawTab).toBeEnabled()
    await resetRawTab.click()
    await expect(settingsSelect(page, "Raw Markdown Tab key")).toHaveText(
      "Spaces"
    )
    await expect(page.getByLabel("Spaces per Tab")).toHaveValue("2")

    await page.getByRole("button", { name: "Window Chrome" }).click()
    await chooseSettingsOption(page, "Show tabs", "Always")
    await page.getByRole("switch", { name: "Show formatting toolbar" }).click()
    await chooseSettingsOption(page, "Formatting toolbar position", "Right")

    await page.getByRole("switch", { name: "Always show status bar" }).click()
    await page.getByRole("switch", { name: "Words" }).click()

    if (process.platform === "darwin") {
      await page.getByRole("button", { name: "Transparency & Blur" }).click()
      const translucentBackground = page.getByRole("switch", {
        name: "Window transparency & blur",
      })
      const backgroundTranslucency = page.getByLabel(
        "Background translucency percentage"
      )
      const blurRadius = page.getByLabel("Background blur radius value")
      const translucentCallouts = page.getByRole("switch", {
        name: "Callouts",
      })
      const translucentCodeBlocks = page.getByRole("switch", {
        name: "Code blocks",
      })
      const translucentInlineCode = page.getByRole("switch", {
        name: "Inline code",
      })
      await expect(translucentBackground).not.toBeChecked()
      await expect(translucentCallouts).toBeDisabled()
      await expect(translucentCallouts).toBeChecked()
      await expect(translucentCodeBlocks).toBeDisabled()
      await expect(translucentCodeBlocks).toBeChecked()
      await expect(translucentInlineCode).toBeDisabled()
      await expect(translucentInlineCode).not.toBeChecked()
      await expect(backgroundTranslucency).toBeDisabled()
      await expect(backgroundTranslucency).toHaveValue("15")
      await expect(blurRadius).toBeDisabled()
      await expect(blurRadius).toHaveValue("25")
      await translucentBackground.click()
      await translucentCallouts.click()
      await translucentCodeBlocks.click()
      await backgroundTranslucency.fill("65")
      await blurRadius.fill("35")
      await translucentBackground.click()
      await expect(
        page.getByRole("button", { name: "Reset background translucency" })
      ).toBeDisabled()
      await expect(
        page.getByRole("button", { name: "Reset background blur radius" })
      ).toBeDisabled()
    }

    await zoomInput.fill("137")
    await openTypographySettings(page)
    await page.getByLabel("Base font size in pixels").fill("18")
    await page.getByLabel("Monospace font size in pixels").fill("16")
    await page.getByRole("switch", { name: "Code ligatures" }).click()
    await cancelTypographySettings(page)
    await chooseSettingsOption(page, "Raw Markdown Tab key", "Tab Character")
    await page.getByLabel("Maximum content width in pixels").fill("1200")
    await expect(resetAll).toBeEnabled()

    await resetAll.click()
    await expect(resetAll).toBeDisabled()
    await expect(zoomInput).toHaveValue("100")
    await openTypographySettings(page)
    await expect(page.getByLabel("Base font size in pixels")).toHaveValue("20")
    await expect(page.getByLabel("Monospace font size in pixels")).toHaveValue(
      "20"
    )
    await expect(
      page.getByRole("switch", { name: "Code ligatures" })
    ).toBeChecked()
    await cancelTypographySettings(page)
    await expect(
      page.getByLabel("Maximum content width in pixels")
    ).toHaveValue("960")
    await expect(settingsSelect(page, "Raw Markdown Tab key")).toHaveText(
      "Spaces"
    )
    await expect(page.getByLabel("Spaces per Tab")).toHaveValue("2")
    await expect(settingsSelect(page, "Show tabs")).toHaveText(
      "With Multiple Tabs"
    )
    await expect(
      page.getByRole("switch", {
        name: `Always Show ${TOP_CONTROLS_POSITION_LABEL} Controls`,
      })
    ).not.toBeChecked()
    await expect(
      page.getByRole("switch", { name: "Show formatting toolbar" })
    ).not.toBeChecked()
    await expect(
      settingsSelect(page, "Formatting toolbar position")
    ).toHaveText("Center")
    await expect(
      page.getByRole("switch", { name: "Always show status bar" })
    ).not.toBeChecked()
    await expect(page.getByRole("switch", { name: "Words" })).toBeChecked()
    if (process.platform === "darwin") {
      await expect(
        page.getByRole("switch", { name: "Window transparency & blur" })
      ).not.toBeChecked()
      await expect(page.getByRole("switch", { name: "Callouts" })).toBeChecked()
      await expect(
        page.getByRole("switch", { name: "Code blocks" })
      ).toBeChecked()
      await expect(
        page.getByRole("switch", { name: "Inline code" })
      ).not.toBeChecked()
      await expect(
        page.getByLabel("Background translucency percentage")
      ).toHaveValue("15")
      await expect(page.getByLabel("Background blur radius value")).toHaveValue(
        "25"
      )
    }

    await settingsSaveButton(page).click()
    await expect
      .poll(async () => {
        try {
          return JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
      })
      .toEqual(DEFAULT_APP_SETTINGS)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("top controls can remain visible without hovering @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPath = path.join(userData, "top-right-controls.md")
  await writeFile(
    documentPath,
    "# Start\n\n[Jump to destination](#destination)\n\n# Destination\n"
  )
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Window Chrome" }).click()
    const allControls = page.getByRole("switch", {
      name: "All Controls",
    })
    await expect(allControls).toBeChecked()
    await allControls.click()
    for (const name of [
      "Back and Forward",
      "View Mode",
      "Find",
      "Document Outline",
      "Formatting Toolbar",
      "Settings",
    ]) {
      await expect(
        page.getByRole("switch", {
          name,
          exact: true,
        })
      ).not.toBeChecked()
    }
    await allControls.click()
    await page
      .getByRole("switch", {
        name: `Always Show ${TOP_CONTROLS_POSITION_LABEL} Controls`,
      })
      .click()
    await settingsSaveButton(page).click()
    await page.mouse.move(450, 180)

    const topChrome = page.locator(".top-chrome")
    await expect(topChrome).toHaveAttribute("data-always-show-controls", "true")
    await expect(
      page.getByRole("button", { name: "Settings", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Formatting toolbar" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Document outline" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Switch to Raw Markdown" })
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Find" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Forward" })).toHaveCount(0)
    await expect(page.locator(".top-chrome-navigation-separator")).toHaveCount(
      0
    )
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as typeof DEFAULT_APP_SETTINGS
        return saved.chrome.alwaysShowTopControls
      })
      .toBe(true)

    const controlsMenu = page.getByRole("menu", {
      name: /Top-(?:left|right) controls menu/,
    })
    const blankChromePoint = await topChrome.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const y = bounds.top + bounds.height / 2
      for (let x = bounds.left + 100; x < bounds.right - 160; x += 8) {
        const target = document.elementFromPoint(x, y)
        if (!target?.closest("button, [role='tab'], .centered-file-surface"))
          return { x, y }
      }
      throw new Error("The top chrome has no blank point")
    })
    const settingsControl = page.getByRole("button", {
      name: "Settings",
      exact: true,
    })

    await settingsControl.click({ button: "right" })
    await expect(controlsMenu).toBeVisible()
    await expect(page.locator('[data-slot="context-menu-backdrop"]')).toHaveCSS(
      "-webkit-app-region",
      "no-drag"
    )
    await page.mouse.click(blankChromePoint.x, blankChromePoint.y)
    await expect(controlsMenu).toHaveCount(0)

    await settingsControl.click({ button: "right" })
    await expect(controlsMenu).toBeVisible()
    await deactivateNativeWindow(app)
    await focusNativeWindow(app)
    await expect(controlsMenu).toHaveCount(0)

    await settingsControl.click({ button: "right" })
    await expect(controlsMenu).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error("The document window is unavailable")
      const [width, height] = window.getSize()
      window.setSize(width - 20, height)
    })
    await expect(controlsMenu).toHaveCount(0)

    for (const name of [
      "Switch to Raw Markdown",
      "Find",
      "Formatting toolbar",
      "Document outline",
      "Settings",
    ]) {
      const controlBounds = await page
        .getByRole("button", { name, exact: true })
        .boundingBox()
      if (!controlBounds) throw new Error(`${name} control is not visible`)
      await page.mouse.click(
        controlBounds.x + controlBounds.width / 2,
        controlBounds.y + controlBounds.height / 2,
        { button: "right" }
      )
      await expect(controlsMenu).toBeVisible()
      await expect(
        controlsMenu.getByRole("menuitem", { name: "Hide", exact: true })
      ).toBeVisible()
      await expect(controlsMenu.getByRole("menuitem")).toHaveCount(1)
      await page.keyboard.press("Escape")
      await expect(controlsMenu).toHaveCount(0)
    }

    const modeButton = page.getByRole("button", {
      name: "Switch to Raw Markdown",
    })
    await modeButton.click()
    await expect(
      page.getByRole("button", { name: "Switch to Rendered Markdown" })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Switch to Rendered Markdown" })
      .click()

    await page.getByRole("button", { name: "Find" }).click()
    await expect(
      page.getByRole("form", { name: "Find and replace in document" })
    ).toBeVisible()
    await page.keyboard.press("Escape")

    const primaryModifier = process.platform === "darwin" ? "Meta" : "Control"
    await page
      .locator(".cm-md-link")
      .filter({ hasText: "Jump to destination" })
      .click({ modifiers: [primaryModifier] })
    const back = page.getByRole("button", { name: "Back" })
    const forward = page.getByRole("button", { name: "Forward" })
    await expect(back).toBeVisible()
    await expect(forward).toBeVisible()
    await expect(back).toBeEnabled()
    await expect(forward).toBeDisabled()
    await expect(page.locator(".top-chrome-navigation-separator")).toBeVisible()
    for (const control of [back, forward]) {
      const bounds = await control.boundingBox()
      if (!bounds) throw new Error("Navigation control is not visible")
      await page.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        { button: "right" }
      )
      await expect(
        controlsMenu.getByRole("menuitem", { name: "Hide", exact: true })
      ).toBeVisible()
      await page.keyboard.press("Escape")
    }

    await back.click({ button: "right" })
    await controlsMenu
      .getByRole("menuitem", { name: "Hide", exact: true })
      .click()
    await expect(back).toHaveCount(0)
    await expect(forward).toHaveCount(0)
    await expect(page.locator(".top-chrome-navigation-separator")).toHaveCount(
      0
    )
    await expect(topChrome).toHaveAttribute("data-always-show-controls", "true")
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as typeof DEFAULT_APP_SETTINGS
        return saved.chrome.topRightControls.navigation
      })
      .toBe(false)

    await page.getByRole("button", { name: "Find" }).click({
      button: "right",
    })
    await controlsMenu
      .getByRole("menuitem", { name: "Hide", exact: true })
      .click()
    await expect(page.getByRole("button", { name: "Find" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible()
    await expect(topChrome).toHaveAttribute("data-always-show-controls", "true")
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as typeof DEFAULT_APP_SETTINGS
        return {
          always: saved.chrome.alwaysShowTopControls,
          find: saved.chrome.topRightControls.find,
        }
      })
      .toEqual({ always: true, find: false })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Alt+Z persists line wrapping across app restarts @renderer-isolated", async () => {
  const userData = await createTestUserData()
  let app: ElectronApplication | null = await launchApplication(
    userData,
    samplePath
  )

  try {
    let page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    const wrappingBefore = await content.evaluate(
      (element) => getComputedStyle(element).whiteSpace
    )
    await content.click()
    await page.keyboard.press("Alt+Z")
    await expect
      .poll(() =>
        content.evaluate((element) => getComputedStyle(element).whiteSpace)
      )
      .not.toBe(wrappingBefore)
    const wrappingAfter = await content.evaluate(
      (element) => getComputedStyle(element).whiteSpace
    )
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as typeof DEFAULT_APP_SETTINGS
        return saved.lineWrapping
      })
      .toBe(false)

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, samplePath)
    page = await app.firstWindow()
    await expect
      .poll(() =>
        page
          .locator(".cm-content")
          .evaluate((element) => getComputedStyle(element).whiteSpace)
      )
      .toBe(wrappingAfter)
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Escape reveals a hidden caret beyond the horizontal viewport @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const temporaryDocument = path.join(userData, "long-unwrapped-line.md")
  await writeFile(temporaryDocument, "x".repeat(3_000))
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const scroller = page.locator(".cm-scroller")
    await editor.waitFor()
    await expect(content).toBeFocused()
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)

    await page.keyboard.press("Escape")
    const wrappedWhiteSpace = await content.evaluate(
      (element) => getComputedStyle(element).whiteSpace
    )
    await page.keyboard.press("Alt+Z")
    await expect
      .poll(() =>
        content.evaluate((element) => getComputedStyle(element).whiteSpace)
      )
      .not.toBe(wrappedWhiteSpace)
    await page.keyboard.press("End")
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    expect(
      await scroller.evaluate((element) => {
        element.scrollLeft = 0
        return element.scrollLeft
      })
    ).toBe(0)

    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()
    await expect
      .poll(() =>
        Promise.all([
          scroller.evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            return {
              left: bounds.left,
              right: bounds.right,
              scrollLeft: element.scrollLeft,
            }
          }),
          page.locator(".cm-cursor").first().boundingBox(),
        ]).then(([viewport, cursor]) =>
          Boolean(
            cursor &&
            viewport.scrollLeft > 0 &&
            cursor.x >= viewport.left &&
            cursor.x + cursor.width <= viewport.right
          )
        )
      )
      .toBe(true)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("macOS background effects preview, cancel, persist, and keep chrome single-tinted", async () => {
  test.skip(process.platform !== "darwin", "WindowServer blur is macOS-only")

  const userData = await createTestUserData()
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      appearanceMode: "dark",
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        alwaysShowStatusBar: true,
        showFormattingBar: true,
      },
    })
  )
  let app: ElectronApplication | null = await launchApplication(
    userData,
    samplePath
  )

  try {
    let page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const appShell = page.locator(".app-shell")
    const toolbar = page.locator(".formatting-toolbar")
    const status = page.locator(".status-overlay")
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-effect",
      "opaque"
    )
    await expect(appShell).toHaveCSS("background-color", "rgb(24, 24, 24)")
    await expect(toolbar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect
      .poll(() =>
        page.evaluate(() => {
          const editor = document.querySelector<HTMLElement>(".cm-editor")
          if (!editor) return Number.NaN
          return editor.getBoundingClientRect().bottom - innerHeight
        })
      )
      .toBeCloseTo(0, 0)
    await expect
      .poll(() =>
        appShell.evaluate(
          (element) =>
            getComputedStyle(
              element.querySelector<HTMLElement>(".editor-mount")!
            ).clipPath
        )
      )
      .toBe("inset(74px 0px 28px)")

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    const dialogOverlay = page.locator('[data-slot="dialog-overlay"]')
    await expect(dialogOverlay).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)"
    )
    await expect(dialogOverlay).toHaveCSS("backdrop-filter", "none")
    const enabled = page.getByRole("switch", {
      name: "Window transparency & blur",
    })
    const translucentCallouts = page.getByRole("switch", {
      name: "Callouts",
    })
    const translucentCodeBlocks = page.getByRole("switch", {
      name: "Code blocks",
    })
    const translucentInlineCode = page.getByRole("switch", {
      name: "Inline code",
    })
    const translucency = page.getByLabel("Background translucency percentage")
    const blurRadius = page.getByLabel("Background blur radius value")
    await enabled.click()
    const html = page.locator("html")
    await expect(html).toHaveAttribute("data-background-effect", "translucent")
    await expect(html).toHaveAttribute("data-translucent-callouts", "true")
    await expect(html).toHaveAttribute("data-translucent-code-blocks", "true")
    await expect(html).not.toHaveAttribute("data-translucent-inline-code")
    const translucentSurfaces = await page.evaluate(() => ({
      callout: getComputedStyle(document.documentElement).getPropertyValue(
        "--callout-surface-background"
      ),
      code: getComputedStyle(
        document.querySelector<HTMLElement>(".cm-md-code-block")!
      ).backgroundColor,
      inline: getComputedStyle(
        document.querySelector<HTMLElement>(".cm-md-inline-code")!
      ).backgroundColor,
    }))
    await translucentCallouts.click()
    await translucentCodeBlocks.click()
    await translucentInlineCode.click()
    await expect(html).not.toHaveAttribute("data-translucent-callouts")
    await expect(html).not.toHaveAttribute("data-translucent-code-blocks")
    await expect(html).toHaveAttribute("data-translucent-inline-code", "true")
    const opaqueSurfaces = await page.evaluate(() => ({
      callout: getComputedStyle(document.documentElement).getPropertyValue(
        "--callout-surface-background"
      ),
      code: getComputedStyle(
        document.querySelector<HTMLElement>(".cm-md-code-block")!
      ).backgroundColor,
      inline: getComputedStyle(
        document.querySelector<HTMLElement>(".cm-md-inline-code")!
      ).backgroundColor,
    }))
    expect(opaqueSurfaces.callout).not.toBe(translucentSurfaces.callout)
    expect(opaqueSurfaces.code).not.toBe(translucentSurfaces.code)
    expect(opaqueSurfaces.inline).not.toBe(translucentSurfaces.inline)
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/000000/i)
    await expect(appShell).toHaveCSS("background-color", "rgba(24, 24, 24, 0)")
    await expect(html).toHaveCSS("--document-surface-background", "#181818d9")
    await translucency.fill("70")
    await expect(appShell).toHaveCSS("background-color", "rgba(24, 24, 24, 0)")
    await expect(html).toHaveCSS("--document-surface-background", "#1818184d")
    await blurRadius.fill("0")
    await expect(blurRadius).toHaveValue("0")
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/000000/i)
    await blurRadius.fill("35")
    await expect(blurRadius).toHaveValue("35")
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-effect",
      "opaque"
    )
    await expect(html).not.toHaveAttribute("data-translucent-callouts")
    await expect(html).not.toHaveAttribute("data-translucent-code-blocks")
    await expect(html).not.toHaveAttribute("data-translucent-inline-code")
    await expect(appShell).toHaveCSS("background-color", "rgb(24, 24, 24)")
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/181818/i)

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    await page.getByRole("switch", { name: "Callouts" }).click()
    await page.getByRole("switch", { name: "Code blocks" }).click()
    await page.getByRole("switch", { name: "Inline code" }).click()
    await page.getByLabel("Background translucency percentage").fill("70")
    await page.getByLabel("Background blur radius value").fill("35")
    await settingsSaveButton(page).click()
    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({
        backgroundEffect: {
          enabled: true,
          translucentCallouts: false,
          translucentCodeBlocks: false,
          translucentInlineCode: true,
          translucency: 0.7,
          blurRadius: 35,
        },
      })

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, samplePath)
    page = await app.firstWindow()
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-effect",
      "translucent"
    )
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-translucent-callouts"
    )
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-translucent-code-blocks"
    )
    await expect(page.locator("html")).toHaveAttribute(
      "data-translucent-inline-code",
      "true"
    )
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/000000/i)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      "rgba(24, 24, 24, 0)"
    )
    await expect(page.locator("html")).toHaveCSS(
      "--document-surface-background",
      "#1818184d"
    )
    await expect(page.locator(".formatting-toolbar")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)"
    )
    await expect(page.locator(".status-overlay")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)"
    )
    await expect(page.locator(".cm-content")).toBeFocused()
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) => window.isFocused())
              .length
        )
      )
      .toBe(1)
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("centered paths and tabs offer shadcn path actions and a bounded long-path popover", async () => {
  const userData = await createTestUserData()
  const secondPath = path.join(userData, "DISTRIBUTION_DEFERRED_CHANGES.md")
  await writeFile(secondPath, "second")
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabVisibility: "mouseover",
      },
    })
  )
  const app = await launchApplication(userData, samplePath, secondPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ shell }) => {
      const testGlobal = globalThis as typeof globalThis & {
        revealedPathItems?: string[]
      }
      testGlobal.revealedPathItems = []
      shell.showItemInFolder = (filePath) => {
        testGlobal.revealedPathItems?.push(filePath)
      }
    })
    await page.locator(".cm-content").click()
    await page.mouse.move(450, 160)

    const centeredPath = page.locator(".centered-file-surface")
    await expect(centeredPath).toBeVisible()
    await expect(page.locator(".centered-file-label")).not.toHaveAttribute(
      "data-hidden",
      ""
    )
    await expect(centeredPath).not.toHaveAttribute(
      "data-slot",
      "tooltip-trigger"
    )
    const centeredPathBox = await centeredPath.boundingBox()
    expect(centeredPathBox).not.toBeNull()
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.mouse.click(
      centeredPathBox!.x + centeredPathBox!.width + 4,
      centeredPathBox!.y + centeredPathBox!.height / 2,
      { button: "right" }
    )
    const copyPath = page.getByRole("menuitem", {
      name: "Copy Path",
      exact: true,
    })
    await expect(copyPath).toBeVisible()
    await expect(
      page.getByRole("menuitem", {
        name:
          process.platform === "darwin"
            ? "Reveal in Finder"
            : process.platform === "win32"
              ? "Show in File Explorer"
              : "Show in File Manager",
        exact: true,
      })
    ).toBeVisible()
    await copyPath.click()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(samplePath)

    await page.locator(".cm-content").click()
    await page.mouse.move(450, 160)
    await page.mouse.click(
      centeredPathBox!.x + centeredPathBox!.width / 2,
      centeredPathBox!.y + centeredPathBox!.height / 2,
      { button: "right" }
    )
    await page
      .getByRole("menuitem", {
        name:
          process.platform === "darwin"
            ? "Reveal in Finder"
            : process.platform === "win32"
              ? "Show in File Explorer"
              : "Show in File Manager",
        exact: true,
      })
      .click()
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            revealedPathItems?: string[]
          }
          return testGlobal.revealedPathItems
        })
      )
      .toEqual([samplePath])

    await page.locator(".cm-content").click()
    await page.mouse.move(120, 20)
    const secondTab = page.getByRole("tab", {
      name: secondPath,
      exact: true,
    })
    const topChrome = page.locator(".top-chrome")
    const topControls = page.locator(".top-chrome-controls")
    await expect(secondTab).toBeVisible()
    await setWindowContentSize(app, 560, 720)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(560)
    await secondTab.hover()
    const pathPopover = page.locator(
      '[data-slot="popover-content"][data-long-text-popover]'
    )
    await expect(pathPopover).toBeVisible()
    const pathPopoverGeometry = await pathPopover.evaluate((element) => {
      const text = element.querySelector<HTMLElement>(
        "[data-tab-path-popover-text]"
      )
      if (!text) throw new Error("The full tab path was not found")
      const range = document.createRange()
      range.selectNodeContents(text)
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        bounds: {
          left: bounds.left,
          right: bounds.right,
        },
        clientWidth: element.clientWidth,
        lineBounds: [...range.getClientRects()].map((line) => ({
          left: line.left,
          right: line.right,
        })),
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        pointerEvents: style.pointerEvents,
        positionerPointerEvents: element.parentElement
          ? getComputedStyle(element.parentElement).pointerEvents
          : null,
        scrollWidth: element.scrollWidth,
        text: text.textContent,
        viewportWidth: innerWidth,
      }
    })
    expect(pathPopoverGeometry.text).toBe(secondPath)
    expect(pathPopoverGeometry.bounds.left).toBeGreaterThanOrEqual(0)
    expect(pathPopoverGeometry.bounds.right).toBeLessThanOrEqual(
      pathPopoverGeometry.viewportWidth
    )
    expect(pathPopoverGeometry.scrollWidth).toBeLessThanOrEqual(
      pathPopoverGeometry.clientWidth + 1
    )
    expect(pathPopoverGeometry.pointerEvents).toBe("none")
    expect(pathPopoverGeometry.positionerPointerEvents).toBe("none")
    expect(pathPopoverGeometry.lineBounds.length).toBeGreaterThan(0)
    for (const line of pathPopoverGeometry.lineBounds) {
      expect(line.left).toBeGreaterThanOrEqual(
        pathPopoverGeometry.bounds.left + pathPopoverGeometry.paddingLeft - 1
      )
      expect(line.right).toBeLessThanOrEqual(
        pathPopoverGeometry.bounds.right - pathPopoverGeometry.paddingRight + 1
      )
    }
    await page.mouse.move(300, 180)
    await expect(pathPopover).toBeHidden()
    await page.locator("body").focus()
    await page.keyboard.press("Tab")
    await secondTab.focus()
    await expect(secondTab).toBeFocused()
    await expect(pathPopover).toBeVisible()
    await page.locator(".cm-content").click()
    await expect(pathPopover).toBeHidden()
    await setWindowContentSize(app, 900, 720)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900)
    await page.mouse.move(120, 20)
    await expect(secondTab).toBeVisible()
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await secondTab.click({ button: "right" })
    const tabCopyPath = page.getByRole("menuitem", {
      name: "Copy Path",
      exact: true,
    })
    const tabRevealPath = page.getByRole("menuitem", {
      name:
        process.platform === "darwin"
          ? "Reveal in Finder"
          : process.platform === "win32"
            ? "Show in File Explorer"
            : "Show in File Manager",
      exact: true,
    })
    const tabPathMenu = page.locator(
      '[data-slot="context-menu-content"][data-open]'
    )
    await waitForSubtreeAnimations(tabPathMenu)
    await expect(pathPopover).toBeHidden()
    await expect
      .poll(() =>
        tabPathMenu.evaluate((element) => {
          const positioner = element.parentElement
          return positioner
            ? getComputedStyle(positioner).getPropertyValue(
                "-webkit-app-region"
              )
            : null
        })
      )
      .toBe("no-drag")
    await tabRevealPath.hover()
    await expect
      .poll(() =>
        topChrome.evaluate((element) =>
          element.hasAttribute("data-hover-chrome")
        )
      )
      .toBe(false)
    await expect(page.locator(".document-tab[data-popup-open]")).toHaveCount(1)
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")

    const copyPathBands = [
      ["top", 0.12],
      ["middle", 0.5],
      ["bottom", 0.88],
    ] as const
    for (const [band, heightFraction] of copyPathBands) {
      if (band !== "top") {
        await page.mouse.move(120, 20)
        await expect(secondTab).toBeVisible()
        await secondTab.click({ button: "right" })
        await waitForSubtreeAnimations(tabPathMenu)
      }

      await app.evaluate(({ clipboard }) => clipboard.clear())
      const copyPathBox = await tabCopyPath.boundingBox()
      expect(copyPathBox).not.toBeNull()
      const point = {
        x: copyPathBox!.x + copyPathBox!.width * 0.75,
        y: copyPathBox!.y + copyPathBox!.height * heightFraction,
      }
      const hitMenuItem = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        return hit instanceof Element
          ? hit.closest('[role="menuitem"]')?.textContent?.trim()
          : null
      }, point)
      expect(hitMenuItem, `${band} Copy Path hit target`).toBe("Copy Path")
      await page.mouse.move(point.x, point.y)
      await expect(tabCopyPath).toBeFocused()
      await page.mouse.click(point.x, point.y)
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(secondPath)
      await expect(tabCopyPath).toBeHidden()
    }

    await page.mouse.move(450, 180)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-focused/)
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.classList.contains("cm-content")
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await expect(page.locator(".document-tab[data-popup-open]")).toHaveCount(0)

    if (process.platform === "darwin") {
      await page.locator(".cm-content").click()
      await page.mouse.move(120, 20)
      await secondTab.click({ button: "left", modifiers: ["Control"] })
      await tabCopyPath.click()
      await expect(page.locator(".cm-editor")).toHaveClass(/cm-focused/)
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement?.classList.contains("cm-content")
          )
        )
        .toBe(true)
    }

    await page.mouse.move(120, 20)
    await secondTab.click({ button: "right" })
    await tabRevealPath.hover()
    await expect
      .poll(() =>
        topChrome.evaluate((element) =>
          element.hasAttribute("data-hover-chrome")
        )
      )
      .toBe(false)
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await page.mouse.click(450, 180)
    await expect(tabCopyPath).toBeHidden()
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await expect(page.locator(".document-tab[data-popup-open]")).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("tab labels align fitted names left and feather overflowing names @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const shortFilename = "fit.md"
  const longFilename = `${"overflowing-name-".repeat(8)}document.md`
  const shortPath = path.join(userData, shortFilename)
  const longPath = path.join(userData, longFilename)
  const extraPaths = Array.from({ length: 6 }, (_, index) =>
    path.join(userData, `extra-${index + 1}.md`)
  )
  await writeFile(shortPath, "short")
  await writeFile(longPath, "long")
  await Promise.all(extraPaths.map((filePath) => writeFile(filePath, filePath)))
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabVisibility: "always",
        tabDisplay: "filename",
      },
    })
  )
  const app = await launchApplication(
    userData,
    shortPath,
    longPath,
    ...extraPaths
  )

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const shortLabel = page
      .locator(".document-tab")
      .filter({ hasText: shortFilename })
      .locator(".tab-label")
    const longLabel = page
      .locator(".document-tab")
      .filter({ hasText: longFilename })
      .locator(".tab-label")

    await expect(shortLabel).not.toHaveAttribute("data-overflow", "")
    await expect(longLabel).toHaveAttribute("data-overflow", "")

    const labelGeometry = async (label: typeof shortLabel) =>
      label.evaluate((element) => {
        const text = element.querySelector<HTMLElement>(".path-filename-text")
        if (!text) throw new Error("Tab filename text is unavailable")
        const labelBounds = element.getBoundingClientRect()
        const textBounds = text.getBoundingClientRect()
        return {
          labelLeft: labelBounds.left,
          labelRight: labelBounds.right,
          maskImage: getComputedStyle(element).maskImage,
          textLeft: textBounds.left,
          textRight: textBounds.right,
        }
      })

    const [shortGeometry, longGeometry] = await Promise.all([
      labelGeometry(shortLabel),
      labelGeometry(longLabel),
    ])
    expect(shortGeometry.maskImage).toBe("none")
    expect(
      Math.abs(shortGeometry.textLeft - shortGeometry.labelLeft)
    ).toBeLessThanOrEqual(0.5)
    expect(longGeometry.maskImage).not.toBe("none")
    expect(longGeometry.textLeft).toBeLessThan(longGeometry.labelLeft)
    expect(
      Math.abs(longGeometry.textRight - longGeometry.labelRight)
    ).toBeLessThanOrEqual(0.5)

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 320)
    })
    await expect(shortLabel).not.toHaveAttribute("data-overflow", "")
    const compactFittedGeometry = await labelGeometry(shortLabel)
    expect(compactFittedGeometry.textLeft).toBeGreaterThanOrEqual(0)
    expect(compactFittedGeometry.textRight).toBeLessThanOrEqual(480)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 720)
    })

    const tabStrip = page.locator(".document-tab-strip")
    await page.mouse.move(450, 160)
    await expect(page.locator(".top-chrome")).toHaveAttribute(
      "data-platform",
      process.platform
    )
    await expect(page.locator(".window-controls")).toHaveCount(
      process.platform === "linux" ? 1 : 0
    )
    const restingStrip = await tabStrip.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        rightInset: innerWidth - bounds.right,
        scrolls: element.scrollWidth > element.clientWidth,
      }
    })
    expect(restingStrip.scrolls).toBe(true)
    const restingRightInset =
      process.platform === "win32"
        ? WINDOWS_CAPTION_CONTROLS_WIDTH + TOP_CHROME_CONTENT_GAP
        : TOP_CHROME_CONTENT_GAP
    expect(restingStrip.rightInset).toBeCloseTo(restingRightInset, 0)

    await tabStrip.hover({ position: { x: 20, y: 15 } })
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => {
          const controls = document.querySelector<HTMLElement>(
            ".top-chrome-controls"
          )
          if (!controls) return false
          const stripBounds = element.getBoundingClientRect()
          const controlsBounds = controls.getBoundingClientRect()
          return Math.abs(stripBounds.right - (controlsBounds.left - 8)) <= 0.5
        })
      )
      .toBe(true)

    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        tabStrip.evaluate(
          (element) => innerWidth - element.getBoundingClientRect().right
        )
      )
      .toBeCloseTo(restingRightInset, 0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("revealing top controls keeps a covered active tab against their adjacent edge @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPaths = Array.from({ length: 8 }, (_, index) =>
    path.join(userData, `active-tab-visibility-${index + 1}.md`)
  )
  await Promise.all(
    documentPaths.map((filePath) => writeFile(filePath, filePath))
  )
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabDisplay: "filename",
        tabVisibility: "always",
      },
    })
  )
  const app = await launchApplication(userData, ...documentPaths)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const tabStrip = page.locator(".document-tab-strip")
    const activeTab = page.locator(".document-tab").nth(6)
    const restingRightInset =
      process.platform === "win32"
        ? WINDOWS_CAPTION_CONTROLS_WIDTH + TOP_CHROME_CONTENT_GAP
        : TOP_CHROME_CONTENT_GAP
    await activeTab.getByRole("tab").click()
    await page.locator(".cm-content").focus()
    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        tabStrip.evaluate(
          (element) => innerWidth - element.getBoundingClientRect().right
        )
      )
      .toBeCloseTo(restingRightInset, 0)

    const restingGeometry = await tabStrip.evaluate((element) => {
      const active = element.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      if (!active) throw new Error("The active tab is unavailable")
      const stripBounds = element.getBoundingClientRect()
      const activeBounds = active.getBoundingClientRect()
      element.scrollLeft += activeBounds.right - (stripBounds.right - 24)
      const positionedActiveBounds = active.getBoundingClientRect()
      return {
        activeRight: positionedActiveBounds.right,
        scrollLeft: element.scrollLeft,
        stripRight: stripBounds.right,
      }
    })
    expect(restingGeometry.activeRight).toBeCloseTo(
      restingGeometry.stripRight - 24,
      0
    )

    const revealedGeometry = () =>
      tabStrip.evaluate((element) => {
        const active = element.querySelector<HTMLElement>(
          ".document-tab[data-active]"
        )
        const controls = document.querySelector<HTMLElement>(
          ".top-chrome-controls"
        )
        if (!active) throw new Error("The active tab is unavailable")
        if (!controls) throw new Error("The top controls are unavailable")
        const stripBounds = element.getBoundingClientRect()
        const controlsBounds = controls.getBoundingClientRect()
        const activeBounds = active.getBoundingClientRect()
        return {
          activeRight: activeBounds.right,
          aligned:
            Math.abs(stripBounds.right - (controlsBounds.left - 8)) <= 0.5 &&
            Math.abs(activeBounds.right - stripBounds.right) <= 0.5,
          scrollLeft: element.scrollLeft,
          stripRight: stripBounds.right,
        }
      })

    await tabStrip.hover({ position: { x: 20, y: 15 } })
    await expect.poll(async () => (await revealedGeometry()).aligned).toBe(true)
    const firstReveal = await revealedGeometry()
    expect(firstReveal.stripRight).toBeLessThan(restingGeometry.stripRight)
    expect(restingGeometry.activeRight).toBeGreaterThan(firstReveal.stripRight)
    expect(firstReveal.scrollLeft).toBeGreaterThan(restingGeometry.scrollLeft)

    const settingsShortcut =
      process.platform === "darwin" ? "Meta+," : "Control+,"
    await page.keyboard.press(settingsShortcut)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
    await openTypographySettings(page)
    await expect(tabStrip).toHaveCount(0)
    await cancelTypographySettings(page)
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(tabStrip).toBeVisible()

    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        tabStrip.evaluate(
          (element) => innerWidth - element.getBoundingClientRect().right
        )
      )
      .toBeCloseTo(restingRightInset, 0)
    const remountedGeometry = await tabStrip.evaluate((element) => {
      const active = element.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      if (!active) throw new Error("The active tab is unavailable")
      const stripBounds = element.getBoundingClientRect()
      const activeBounds = active.getBoundingClientRect()
      element.scrollLeft += activeBounds.right - (stripBounds.right - 24)
      return {
        activeRight: active.getBoundingClientRect().right,
        scrollLeft: element.scrollLeft,
        stripRight: stripBounds.right,
      }
    })

    await tabStrip.hover({ position: { x: 20, y: 15 } })
    await expect.poll(async () => (await revealedGeometry()).aligned).toBe(true)
    const secondReveal = await revealedGeometry()
    expect(secondReveal.stripRight).toBeLessThan(remountedGeometry.stripRight)
    expect(remountedGeometry.activeRight).toBeGreaterThan(
      secondReveal.stripRight
    )
    expect(secondReveal.scrollLeft).toBeGreaterThan(
      remountedGeometry.scrollLeft
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a newly created overflowing tab is fully revealed without owning later scrolling", async () => {
  const userData = await createTestUserData()
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabDisplay: "filename",
        tabVisibility: "mouseover",
      },
    })
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(560, 420)
    })
    const tabStrip = page.locator(".document-tab-strip")
    const shortcut = process.platform === "darwin" ? "Meta+T" : "Control+T"
    for (let count = 2; count <= 6; count += 1) {
      await page.keyboard.press(shortcut)
      await expect(page.locator(".document-tab")).toHaveCount(count)
    }
    await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
    })

    await page.keyboard.press(shortcut)
    await expect(page.locator(".document-tab")).toHaveCount(7)
    await page.mouse.move(300, 10)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => {
          const active = element.querySelector<HTMLElement>(
            ".document-tab[data-active]"
          )
          if (!active) throw new Error("The active tab is unavailable")
          const stripBounds = element.getBoundingClientRect()
          const activeBounds = active.getBoundingClientRect()
          return (
            element.scrollLeft > 0 &&
            activeBounds.left >= stripBounds.left - 0.5 &&
            activeBounds.right <= stripBounds.right + 0.5
          )
        })
      )
      .toBe(true)
    const revealed = await tabStrip.evaluate((element) => {
      const active = element.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      const inactive = element.querySelector<HTMLElement>(
        ".document-tab:not([data-active])"
      )
      if (!active) throw new Error("The active tab is unavailable")
      if (!inactive) throw new Error("An inactive tab is unavailable")
      const stripBounds = element.getBoundingClientRect()
      const activeBounds = active.getBoundingClientRect()
      return {
        activeLeft: activeBounds.left,
        activeRight: activeBounds.right,
        activeWidth: activeBounds.width,
        inactiveWidth: inactive.getBoundingClientRect().width,
        scrollLeft: element.scrollLeft,
        stripLeft: stripBounds.left,
        stripRight: stripBounds.right,
      }
    })
    expect(revealed.scrollLeft).toBeGreaterThan(0)
    expect(revealed.activeLeft).toBeGreaterThanOrEqual(revealed.stripLeft - 0.5)
    expect(revealed.activeRight).toBeLessThanOrEqual(revealed.stripRight + 0.5)
    expect(revealed.activeWidth).toBeCloseTo(128, 5)
    expect(revealed.activeWidth).toBeCloseTo(revealed.inactiveWidth, 5)

    await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBe(0)

    await runViewMenuItem(app, "view-tabs-hidden")
    await expect(tabStrip).toHaveCount(0)
    await page.keyboard.press(shortcut)
    await runViewMenuItem(app, "view-tabs-mouseover")
    await expect(tabStrip).toHaveCount(1)
    await expect(page.locator(".document-tab")).toHaveCount(8)
    await page.mouse.move(300, 10)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => {
          const active = element.querySelector<HTMLElement>(
            ".document-tab[data-active]"
          )
          if (!active) throw new Error("The active tab is unavailable")
          const stripBounds = element.getBoundingClientRect()
          const activeBounds = active.getBoundingClientRect()
          return (
            element.scrollLeft > 0 &&
            activeBounds.left >= stripBounds.left - 0.5 &&
            activeBounds.right <= stripBounds.right + 0.5
          )
        })
      )
      .toBe(true)

    await setWindowContentSize(app, 480, 320)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeCloseTo(240, 0)
    await page.evaluate(() => {
      const platformGeometry = document.createElement("style")
      platformGeometry.textContent =
        ".top-chrome { --window-controls-safe-inset: 86px !important; }"
      document.head.append(platformGeometry)
    })
    await page.keyboard.press(shortcut)
    await expect(page.locator(".document-tab")).toHaveCount(9)
    await page.mouse.move(120, 10)
    await expect
      .poll(() =>
        page
          .locator(".top-chrome")
          .evaluate((element) =>
            getComputedStyle(element)
              .getPropertyValue("--window-controls-safe-inset")
              .trim()
          )
      )
      .toBe("86px")
    const windowsCaptionInset = await page
      .locator(".top-chrome")
      .evaluate((element) =>
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue(
            "--windows-caption-controls-inset"
          )
        )
      )
    expect(windowsCaptionInset).toBeCloseTo(
      process.platform === "win32" ? WINDOWS_CAPTION_CONTROLS_WIDTH / 2 : 0,
      5
    )
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => {
          const active = element.querySelector<HTMLElement>(
            ".document-tab[data-active]"
          )
          if (!active) throw new Error("The active tab is unavailable")
          const stripBounds = element.getBoundingClientRect()
          const activeBounds = active.getBoundingClientRect()
          return {
            activeFits:
              activeBounds.left >= stripBounds.left - 0.5 &&
              activeBounds.right <= stripBounds.right + 0.5,
            activeWidth: activeBounds.width,
            stripWidth: stripBounds.width,
          }
        })
      )
      .toMatchObject({
        activeFits: true,
        activeWidth: expect.any(Number),
        stripWidth: expect.any(Number),
      })
    const compactGeometry = await tabStrip.evaluate((element) => {
      const active = element.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      const inactive = element.querySelector<HTMLElement>(
        ".document-tab:not([data-active])"
      )
      if (!active) throw new Error("The active tab is unavailable")
      if (!inactive) throw new Error("An inactive tab is unavailable")
      const stripContent = element.querySelector<HTMLElement>(
        ".document-tab-strip-content"
      )
      if (!stripContent) throw new Error("The tab strip content is unavailable")
      return {
        activeWidth: active.getBoundingClientRect().width,
        inactiveWidth: inactive.getBoundingClientRect().width,
        itemGap: Number.parseFloat(getComputedStyle(stripContent).columnGap),
        stripWidth: element.getBoundingClientRect().width,
      }
    })
    expect(compactGeometry.activeWidth).toBeGreaterThan(0)
    expect(
      Math.abs(
        compactGeometry.activeWidth -
          (compactGeometry.stripWidth - compactGeometry.itemGap)
      )
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(compactGeometry.activeWidth - compactGeometry.inactiveWidth)
    ).toBeLessThanOrEqual(0.5)
    expect(compactGeometry.stripWidth).toBeLessThan(128)
    expect(compactGeometry.activeWidth).toBeLessThanOrEqual(
      compactGeometry.stripWidth + 0.5
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("multi-document launch keeps one editor while inactive tabs hydrate @renderer-isolated", async () => {
  test.setTimeout(60_000)
  const userData = await createTestUserData()
  const firstPath = path.join(userData, "active-first.md")
  const secondPath = path.join(userData, "inactive-second.txt")
  const thirdPath = path.join(userData, "inactive-third.txt")
  const oversizedBody = `${"x".repeat(1_023)}\n`.repeat(8 * 1_024)
  await Promise.all([
    writeFile(firstPath, "# Active first\n\nFirst document body."),
    writeFile(secondPath, `Second document body.\n${oversizedBody}`),
    writeFile(thirdPath, `Third document body.\n${oversizedBody}`),
    writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        chrome: {
          ...DEFAULT_APP_SETTINGS.chrome,
          tabVisibility: "always",
        },
      })
    ),
  ])
  const app = await launchApplication(
    userData,
    firstPath,
    secondPath,
    thirdPath
  )

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const tabs = page.getByRole("tab")
    await expect(editor).toHaveCount(1)
    await expect(tabs).toHaveCount(3)
    await expect(content).toContainText("First document body.")

    await tabs.nth(0).focus()
    await page.keyboard.press("ArrowRight")
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
    await expect(content).toContainText("Second document body.")
    await expect(tabs.nth(1)).toBeFocused()
    await expect(editor).toHaveCount(1)

    await tabs.nth(0).click()
    await expect(content).toContainText("First document body.")
    await expect(content).toBeFocused()

    await tabs.nth(2).click()
    const settingsButton = page.getByRole("button", { name: "Settings" })
    await settingsButton.focus()
    await expect(content).toContainText("Third document body.")
    await expect(settingsButton).toBeFocused()
    await expect(editor).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("horizontal tab scrolling continues when a gap passes under the pointer @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPaths = Array.from({ length: 8 }, (_, index) =>
    path.join(userData, `scrolling-tab-${index + 1}.md`)
  )
  await Promise.all(
    documentPaths.map((filePath) => writeFile(filePath, filePath))
  )
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabVisibility: "always",
        tabDisplay: "filename",
      },
    })
  )
  const app = await launchApplication(userData, ...documentPaths)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const tabStrip = page.locator(".document-tab-strip")
    await expect
      .poll(() =>
        tabStrip.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true)

    const pointer = await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
      const secondTab =
        element.querySelectorAll<HTMLElement>(".document-tab")[1]
      if (!secondTab) throw new Error("A second tab is unavailable")
      const bounds = secondTab.getBoundingClientRect()
      return { x: bounds.right - 2, y: bounds.top + bounds.height / 2 }
    })
    await page.mouse.move(pointer.x, pointer.y)

    // The first wheel tick starts over a tab and moves its trailing gap under
    // the stationary pointer. Subsequent ticks must stay in the same gesture.
    await page.mouse.wheel(4, 0)
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    const gapHitRegion = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      if (!target) throw new Error("No element is under the tab-strip pointer")
      return {
        isGap: target.closest(".document-tab") === null,
        appRegion:
          getComputedStyle(target).getPropertyValue("-webkit-app-region"),
      }
    }, pointer)
    expect(gapHitRegion.isGap).toBe(true)
    expect(gapHitRegion.appRegion).toBe("no-drag")

    const beforeGapWheel = await tabStrip.evaluate(
      (element) => element.scrollLeft
    )
    await page.mouse.wheel(80, 0)
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(beforeGapWheel + 40)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("vertical tab scrolling follows the configured mouse-wheel direction @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPaths = Array.from({ length: 8 }, (_, index) =>
    path.join(userData, `wheel-direction-tab-${index + 1}.md`)
  )
  await Promise.all(
    documentPaths.map((filePath) => writeFile(filePath, filePath))
  )
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabVisibility: "always",
        tabDisplay: "filename",
      },
    })
  )
  const app = await launchApplication(userData, ...documentPaths)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const tabStrip = page.locator(".document-tab-strip")
    const pointer = await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
      const bounds = element.getBoundingClientRect()
      return { x: bounds.left + 20, y: bounds.top + bounds.height / 2 }
    })
    await page.mouse.move(pointer.x, pointer.y)
    await page.mouse.wheel(0, 80)
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(40)

    const pinchWheel = await tabStrip.evaluate((element) => {
      const scrollLeft = element.scrollLeft
      const allowed = element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: 80,
        })
      )
      return { allowed, scrollLeft, nextScrollLeft: element.scrollLeft }
    })
    expect(pinchWheel.allowed).toBe(true)
    expect(pinchWheel.nextScrollLeft).toBe(pinchWheel.scrollLeft)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Window Chrome" }).click()
    await chooseSettingsOption(
      page,
      "Tabs and toolbar mouse-wheel direction",
      "Down Scrolls Left"
    )
    await settingsSaveButton(page).click()
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as typeof DEFAULT_APP_SETTINGS
        return saved.chrome.tabWheelScrollDirection
      })
      .toBe("down-left")

    const beforeReverse = await tabStrip.evaluate((element) => {
      element.scrollLeft = Math.min(
        160,
        element.scrollWidth - element.clientWidth
      )
      return element.scrollLeft
    })
    expect(beforeReverse).toBeGreaterThan(80)
    await tabStrip.evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 80,
        })
      )
    })
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeLessThan(beforeReverse - 40)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("top chrome routes wheel gestures to tabs unless the formatting toolbar overflows @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPaths = Array.from({ length: 8 }, (_, index) =>
    path.join(userData, `top-chrome-wheel-tab-${index + 1}.md`)
  )
  await Promise.all(
    documentPaths.map((filePath) => writeFile(filePath, filePath))
  )
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        showFormattingBar: true,
        tabDisplay: "filename",
        tabVisibility: "always",
      },
    })
  )
  const app = await launchApplication(userData, ...documentPaths)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 720)
    })
    const tabStrip = page.locator(".document-tab-strip")
    const toolbar = page.locator(".formatting-toolbar")
    const toolbarScroller = page.locator(".formatting-toolbar-scroll")
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()
    await expect
      .poll(() =>
        tabStrip.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        toolbarScroller.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(false)

    await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
    })
    await page
      .getByRole("button", { name: "Settings" })
      .dispatchEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 80,
      })
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(40)

    await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
    })
    await toolbar.dispatchEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    })
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(40)
    await expect
      .poll(() => toolbarScroller.evaluate((element) => element.scrollLeft))
      .toBe(0)

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 480)
    })
    await expect
      .poll(() =>
        toolbarScroller.evaluate(
          (element) => element.scrollWidth > element.clientWidth
        )
      )
      .toBe(true)
    await tabStrip.evaluate((element) => {
      element.scrollLeft = 0
    })
    await toolbarScroller.evaluate((element) => {
      element.scrollLeft = 0
    })
    await toolbar.dispatchEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    })
    await expect
      .poll(() => toolbarScroller.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(40)
    await expect
      .poll(() => tabStrip.evaluate((element) => element.scrollLeft))
      .toBe(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("opening into a disposable tab keeps the document start below visible tabs @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPath = path.join(userData, "opened-from-empty.md")
  await writeFile(documentPath, "Opened document first line\nSecond line")
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({
      ...DEFAULT_APP_SETTINGS,
      chrome: {
        ...DEFAULT_APP_SETTINGS.chrome,
        tabVisibility: "always",
      },
    })
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [filePath],
      })) as typeof dialog.showOpenDialog
    }, documentPath)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+O" : "Control+O"
    )
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      documentPath
    )
    await expect(page.locator(".cm-line").first()).toHaveText(
      "Opened document first line"
    )
    await page.waitForTimeout(100)

    const geometry = await page.evaluate(() => {
      const chrome = document.querySelector<HTMLElement>(".top-chrome")
      const firstLine = document.querySelector<HTMLElement>(".cm-line")
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")
      const tab = document.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      if (!chrome || !firstLine || !scroller || !tab) {
        throw new Error("The opened document geometry is unavailable")
      }
      return {
        chromeBottom: chrome.getBoundingClientRect().bottom,
        firstLineTop: firstLine.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
        tabBottom: tab.getBoundingClientRect().bottom,
      }
    })
    expect(geometry.scrollTop).toBe(0)
    expect(geometry.firstLineTop).toBeGreaterThanOrEqual(
      Math.max(geometry.chromeBottom, geometry.tabBottom) - 0.5
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("tab-strip hover reveals a top-origin drawer without covering the first line @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const appShell = page.locator(".app-shell")
    const tabStrip = page.locator(".document-tab-strip")
    const shelf = page.locator(".top-chrome-tab-drag-shelf")
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const firstLine = page.locator(".cm-line").first()
    const shelfGeometry = () =>
      shelf.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          appRegion: style.getPropertyValue("-webkit-app-region"),
          bottom: bounds.bottom,
          height: bounds.height,
          lineColor: getComputedStyle(element, "::after").backgroundColor,
          lineOpacity: getComputedStyle(element, "::after").opacity,
          pointerEvents: style.pointerEvents,
          top: bounds.top,
        }
      })

    await page.mouse.move(450, 160)
    await expect(appShell).not.toHaveAttribute("data-tab-drag-shelf", "true")
    await expect(shelf).toHaveCount(1)
    const collapsedShelfGeometry = await shelfGeometry()
    expect(collapsedShelfGeometry).toMatchObject({
      appRegion: "no-drag",
      bottom: 0,
      height: 0,
      lineOpacity: "0",
      pointerEvents: "none",
      top: 0,
    })
    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()

    const firstLineBounds = await firstLine.boundingBox()
    if (!firstLineBounds) throw new Error("The first line is unavailable")
    const firstLinePoint = {
      x: firstLineBounds.x + Math.min(120, firstLineBounds.width / 2),
      y: firstLineBounds.y + firstLineBounds.height / 2,
    }
    await page.mouse.move(firstLinePoint.x, firstLinePoint.y)
    await page.waitForTimeout(250)
    await expect(appShell).not.toHaveAttribute("data-tab-drag-shelf", "true")
    expect(await shelfGeometry()).toMatchObject(collapsedShelfGeometry)
    await page.mouse.click(firstLinePoint.x, firstLinePoint.y)
    await expect(content).toBeFocused()
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)

    await page.mouse.move(450, 160)
    const firstTabBounds = await page
      .locator(".document-tab")
      .first()
      .boundingBox()
    if (!firstTabBounds) throw new Error("The first tab is unavailable")
    const tabPoint = {
      x: firstTabBounds.x + firstTabBounds.width / 2,
      y: firstTabBounds.y + firstTabBounds.height / 2,
    }
    const aboveTabPoint = {
      x: tabPoint.x,
      y: Math.max(3, firstTabBounds.y - 3),
    }

    await page.mouse.move(aboveTabPoint.x, aboveTabPoint.y)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await expect(appShell).not.toHaveAttribute("data-tab-drag-shelf", "true")
    expect(await shelfGeometry()).toMatchObject(collapsedShelfGeometry)

    await startDrawerCaretTrace(page)
    await page.mouse.move(tabPoint.x, tabPoint.y)
    await expect(appShell).toHaveAttribute("data-tab-drag-shelf", "true")
    const shelfAnimation = await shelf.evaluate((element) => {
      const animation = element
        .getAnimations()
        .find((candidate) =>
          (candidate.effect as KeyframeEffect | null)
            ?.getKeyframes()
            .some((keyframe) => keyframe.height != null)
        )
      const effect = animation?.effect as KeyframeEffect | null
      if (!animation || !effect) {
        throw new Error("The drawer height animation is unavailable")
      }
      const duration = Number(effect.getTiming().duration)
      animation.pause()
      const samples = [0, duration / 2, duration].map((currentTime) => {
        animation.currentTime = currentTime
        const bounds = element.getBoundingClientRect()
        const line = getComputedStyle(element, "::after")
        return {
          bottom: bounds.bottom,
          lineBottomOffset: line.bottom,
          lineOpacity: line.opacity,
        }
      })
      animation.play()
      return {
        keyframes: effect.getKeyframes().map((keyframe) => keyframe.height),
        samples,
      }
    })
    expect(shelfAnimation.keyframes.at(0)).toBe("0px")
    expect(shelfAnimation.keyframes.at(-1)).toBe("74px")
    expect(shelfAnimation.samples[0]?.bottom).toBeCloseTo(0, 5)
    expect(shelfAnimation.samples[1]?.bottom).toBeGreaterThan(0)
    expect(shelfAnimation.samples[1]?.bottom).toBeLessThan(74)
    expect(shelfAnimation.samples[2]?.bottom).toBeCloseTo(74, 5)
    for (const sample of shelfAnimation.samples) {
      expect(sample.lineBottomOffset).toBe("0px")
      expect(sample.lineOpacity).toBe("1")
    }
    await waitForSubtreeAnimations(shelf)
    expectDrawerCaretToTrackText(await readDrawerCaretTrace(page))

    const expandedShelfGeometry = await shelfGeometry()
    expect(expandedShelfGeometry).toMatchObject({
      appRegion: "drag",
      bottom: 74,
      height: 74,
      lineOpacity: "1",
      pointerEvents: "auto",
      top: 0,
    })
    expect(expandedShelfGeometry.lineColor).not.toBe("rgba(0, 0, 0, 0)")
    await expect
      .poll(() =>
        page
          .locator(".editor-mount")
          .evaluate((element) => getComputedStyle(element).clipPath)
      )
      .toContain("74px")
    await expect(content).toHaveCSS("padding-top", "86px")
    const revealedFirstLineBounds = await firstLine.boundingBox()
    if (!revealedFirstLineBounds) {
      throw new Error("The revealed first line is unavailable")
    }
    expect(revealedFirstLineBounds.y).toBeGreaterThan(
      expandedShelfGeometry.bottom
    )

    await page.mouse.move(tabPoint.x, expandedShelfGeometry.bottom - 1)
    await expect(appShell).toHaveAttribute("data-tab-drag-shelf", "true")
    await startDrawerCaretTrace(page)
    await page.mouse.move(tabPoint.x, expandedShelfGeometry.bottom + 1)
    await expect(appShell).not.toHaveAttribute("data-tab-drag-shelf", "true")
    await expect(shelf).toHaveCSS("-webkit-app-region", "no-drag")
    await waitForSubtreeAnimations(shelf)
    expectDrawerCaretToTrackText(await readDrawerCaretTrace(page))
    expect(await shelfGeometry()).toMatchObject(collapsedShelfGeometry)
    await expect
      .poll(() =>
        page
          .locator(".editor-mount")
          .evaluate((element) => getComputedStyle(element).clipPath)
      )
      .not.toContain("74px")
    await expect(content).toHaveCSS("padding-top", "46px")

    const formattingShortcut =
      process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B"
    await startDrawerCaretTrace(page)
    await page.keyboard.press(formattingShortcut)
    await expect(appShell).toHaveAttribute("data-formatting-bar", "true")
    await waitForSubtreeAnimations(shelf)
    expectDrawerCaretToTrackText(await readDrawerCaretTrace(page))

    await startDrawerCaretTrace(page)
    await page.keyboard.press(formattingShortcut)
    await expect(appShell).not.toHaveAttribute("data-formatting-bar", "true")
    await waitForSubtreeAnimations(shelf)
    expectDrawerCaretToTrackText(await readDrawerCaretTrace(page))

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Window Chrome" }).click()
    await chooseSettingsOption(page, "Show tabs", "Always")
    await settingsSaveButton(page).click()
    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await expect(appShell).not.toHaveAttribute("data-tab-drag-shelf", "true")
    expect(await shelfGeometry()).toMatchObject(collapsedShelfGeometry)
    const pinnedTabBounds = await page
      .locator(".document-tab")
      .first()
      .boundingBox()
    if (!pinnedTabBounds) throw new Error("The pinned tab is unavailable")
    await page.mouse.move(
      pinnedTabBounds.x + pinnedTabBounds.width / 2,
      Math.max(3, pinnedTabBounds.y - 3)
    )
    await expect(appShell).not.toHaveAttribute("data-tab-drag-shelf", "true")
    await page.mouse.move(
      pinnedTabBounds.x + pinnedTabBounds.width / 2,
      pinnedTabBounds.y + pinnedTabBounds.height / 2
    )
    await expect(appShell).toHaveAttribute("data-tab-drag-shelf", "true")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("formatting drawer overlays a scrolled document without displacing it @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentPath = path.join(userData, "drawer-scroll.md")
  await writeFile(
    documentPath,
    [
      "# Drawer overlay",
      "",
      ...Array.from(
        { length: 180 },
        (_, index) => `Paragraph ${index + 1} keeps the document scrollable.`
      ),
    ].join("\n")
  )
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const appShell = page.locator(".app-shell")
    const content = page.locator(".cm-content")
    const drawer = page.locator(".top-chrome-tab-drag-shelf")
    const editorMount = page.locator(".editor-mount")
    const scroller = page.locator(".cm-scroller")

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.45
    })
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(500)
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".cm-line")].some(
            (line) => {
              const bounds = line.getBoundingClientRect()
              return bounds.top <= 220 && bounds.bottom >= 220
            }
          )
        )
      )
      .toBe(true)
    const before = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")
      const anchor = [
        ...document.querySelectorAll<HTMLElement>(".cm-line"),
      ].find((line) => {
        const bounds = line.getBoundingClientRect()
        return bounds.top <= 220 && bounds.bottom >= 220
      })
      if (!scroller || !anchor) {
        throw new Error("The scrolled drawer anchor is unavailable")
      }
      return {
        anchorTop: anchor.getBoundingClientRect().top,
        anchorText: anchor.textContent,
        scrollTop: scroller.scrollTop,
      }
    })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B"
    )
    await expect(appShell).toHaveAttribute("data-formatting-bar", "true")
    await expect(appShell).not.toHaveAttribute(
      "data-top-drawer-compensated",
      "true"
    )
    const formattingDrawerKeyframes = await drawer.evaluate((element) => {
      const animation = element
        .getAnimations()
        .find((candidate) =>
          (candidate.effect as KeyframeEffect | null)
            ?.getKeyframes()
            .some((keyframe) => keyframe.height != null)
        )
      if (!animation) {
        throw new Error("The formatting drawer height animation is unavailable")
      }
      return (animation.effect as KeyframeEffect)
        .getKeyframes()
        .map((keyframe) => keyframe.height)
    })
    expect(formattingDrawerKeyframes.at(0)).toBe("0px")
    expect(formattingDrawerKeyframes.at(-1)).toBe("74px")
    await waitForSubtreeAnimations(drawer)

    await expect(content).toHaveCSS("padding-top", "46px")
    await expect
      .poll(() =>
        editorMount.evaluate((element) => getComputedStyle(element).clipPath)
      )
      .toContain("74px")
    const after = await page.evaluate((anchorText) => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")
      const anchor = [
        ...document.querySelectorAll<HTMLElement>(".cm-line"),
      ].find((line) => line.textContent === anchorText)
      if (!scroller || !anchor) {
        throw new Error("The scrolled drawer anchor was not preserved")
      }
      return {
        anchorTop: anchor.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
      }
    }, before.anchorText)
    expect(after.scrollTop).toBeCloseTo(before.scrollTop, 5)
    expect(after.anchorTop).toBeCloseTo(before.anchorTop, 5)

    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(appShell).toHaveAttribute(
      "data-top-drawer-compensated",
      "true"
    )
    await expect(content).toHaveCSS("padding-top", "86px")
    const firstLine = page.locator(".cm-line").first()
    await expect
      .poll(async () => (await firstLine.boundingBox())?.y ?? 0)
      .toBeGreaterThan(74)

    await page.mouse.move(450, 160)
    await expect(appShell).toHaveAttribute("data-formatting-bar", "true")
    await expect(appShell).toHaveAttribute(
      "data-top-drawer-compensated",
      "true"
    )
    await expect(content).toHaveCSS("padding-top", "86px")

    await scroller.evaluate((element) => {
      element.scrollTop = 500
    })
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(400)
    // Let CodeMirror replace the pre-scroll viewport and settle its measured
    // height map before attributing any later movement to the drawer close.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect(appShell).toHaveAttribute(
      "data-top-drawer-compensated",
      "true"
    )
    const beforeClose = await page.evaluate(() => {
      const anchor = [
        ...document.querySelectorAll<HTMLElement>(".cm-line"),
      ].find((line) => {
        const bounds = line.getBoundingClientRect()
        return bounds.top <= 220 && bounds.bottom >= 220
      })
      if (!anchor)
        throw new Error("The formatting drawer close anchor is unavailable")
      return {
        text: anchor.textContent,
        top: anchor.getBoundingClientRect().top,
      }
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B"
    )
    await expect(appShell).not.toHaveAttribute("data-formatting-bar", "true")
    await waitForSubtreeAnimations(drawer)
    const afterCloseTop = await page.evaluate((anchorText) => {
      const anchor = [
        ...document.querySelectorAll<HTMLElement>(".cm-line"),
      ].find((line) => line.textContent === anchorText)
      if (!anchor)
        throw new Error("The formatting drawer close anchor was not preserved")
      return anchor.getBoundingClientRect().top
    }, beforeClose.text)
    expect(afterCloseTop).toBeCloseTo(beforeClose.top, 5)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("formatting drawer preview compensates the document before settings are saved @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const appShell = page.locator(".app-shell")
    const content = page.locator(".cm-content")
    const drawer = page.locator(".top-chrome-tab-drag-shelf")
    const firstLine = page.locator(".cm-line").first()
    const scroller = page.locator(".cm-scroller")
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Window Chrome" }).click()
    await page.getByRole("switch", { name: "Show formatting toolbar" }).click()

    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
    await expect(appShell).toHaveAttribute("data-formatting-bar", "true")
    await expect(appShell).toHaveAttribute(
      "data-top-drawer-compensated",
      "true"
    )
    await waitForSubtreeAnimations(drawer)
    await expect(content).toHaveCSS("padding-top", "86px")
    const [drawerBounds, firstLineBounds] = await Promise.all([
      drawer.boundingBox(),
      firstLine.boundingBox(),
    ])
    if (!drawerBounds || !firstLineBounds) {
      throw new Error("The live formatting drawer geometry is unavailable")
    }
    expect(firstLineBounds.y).toBeGreaterThan(
      drawerBounds.y + drawerBounds.height
    )

    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(appShell).not.toHaveAttribute("data-formatting-bar", "true")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("overlay chrome preserves independent tab sessions and exposes configurable status", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.mouse.move(450, 160)

    const centeredPath = page.locator(".centered-file-label")
    await expect
      .poll(() =>
        centeredPath.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    const fileLabel = centeredPath.locator(".file-label-content")
    const pathCenter = await fileLabel.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left + bounds.width / 2
    })
    const viewportWidth = await page.evaluate(() => innerWidth)
    expect(Math.abs(pathCenter - viewportWidth / 2)).toBeLessThanOrEqual(0.5)
    await expect(centeredPath).toContainText("sample.md")

    await expect(fileLabel).not.toHaveAttribute("data-overflow", "")
    await expect
      .poll(() =>
        fileLabel.evaluate((element) => getComputedStyle(element).maskImage)
      )
      .toBe("none")
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 720)
    })
    await expect(fileLabel).toHaveAttribute("data-overflow", "")
    await expect
      .poll(() =>
        fileLabel.evaluate((element) => getComputedStyle(element).maskImage)
      )
      .not.toBe("none")
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 720)
    })
    await expect(fileLabel).not.toHaveAttribute("data-overflow", "")

    const tabStrip = page.locator(".document-tab-strip")
    const topControls = page.locator(".top-chrome-controls")
    const settingsButton = page.getByRole("button", { name: "Settings" })
    await page.mouse.move(450, 52)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")

    // The centered path owns its own hover target for the full-path tooltip.
    // Enter the remaining chrome surface to reveal tabs and controls.
    await page.mouse.move(200, 20)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    const formattingButton = page.getByRole("button", {
      name: "Formatting toolbar",
    })
    const outlineButton = page.getByRole("button", {
      name: "Document outline",
    })
    await formattingButton.hover()
    await expect(
      page.locator('[data-slot="tooltip-content"][data-open]')
    ).toContainText("Toggle formatting toolbar")
    await outlineButton.hover()
    await expect(
      page.locator('[data-slot="tooltip-content"][data-open]')
    ).toContainText("Outline")
    await expect
      .poll(() =>
        centeredPath.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await settingsButton.click()
    const settingsDialog = page.getByRole("dialog")
    await expect(
      settingsDialog.getByRole("searchbox", { name: "Search settings" })
    ).toBeFocused()
    await expect(
      settingsDialog.getByRole("button", { name: "Theme", exact: true })
    ).not.toBeFocused()
    await page.getByRole("button", { name: "Cancel" }).click()
    await page.mouse.move(450, 52)
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await page.mouse.move(450, 4)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")

    if (process.platform === "darwin") {
      for (const zoomFactor of [1, 1.25, 0.8]) {
        await app.evaluate(({ BrowserWindow }, factor) => {
          BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor)
        }, zoomFactor)
        await expect
          .poll(() =>
            tabStrip.evaluate(
              (element, factor) =>
                element.getBoundingClientRect().left * factor,
              zoomFactor
            )
          )
          .toBeCloseTo(86, 0)
      }
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
      })
    }

    await expect(page.locator(".document-tab")).toHaveCount(1)

    await activateWindow(page)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(page.locator(".document-tab")).toHaveCount(2)
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      "Untitled"
    )

    const content = page.locator(".cm-content")
    await expect(content).toBeFocused()
    await page.keyboard.type("temporary")
    await expect(
      page.locator(".document-tab[data-active] .tab-dirty-dot")
    ).toHaveCount(1)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(content).toHaveText("")
    await expect(
      page.locator(".document-tab[data-active] .tab-dirty-dot")
    ).toHaveCount(0)

    const status = page.locator(".status-overlay")
    await page.keyboard.type("x")
    await page.mouse.move(450, 719)
    await expect(status.locator('[data-status-item="words"]')).toHaveText(
      "1 word"
    )
    await expect(status.locator('[data-status-item="lines"]')).toHaveText(
      "1 line"
    )
    await expect(status.locator('[data-status-item="characters"]')).toHaveText(
      "1 character"
    )
    await content.focus()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.press("Backspace")
    await page.keyboard.type("first second\nthird")
    await page.mouse.move(450, 719)
    await expect(status).toContainText("3 words")
    await expect(status).toContainText("2 lines")
    await expect(status).toContainText("18 characters")
    await expect(status).toContainText("Ln 2, Col 6")

    await content.focus()
    await page.keyboard.type(" draft")
    await page.mouse.move(450, 45)
    await page.locator(".document-tab").first().click()
    await expect(content).toContainText("A quiet Markdown window")
    await page.mouse.move(450, 45)
    await page.locator(".document-tab").nth(1).click()
    await expect(content).toContainText("third draft")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(content).toContainText("first second")
    await expect(content).not.toContainText("draft")
    await page.evaluate(() => {
      const activeTab = document.querySelector<HTMLElement>(
        ".document-tab[data-active]"
      )
      const tabId = activeTab?.dataset.tabId
      if (tabId) window.pulseMd.setDirty(tabId, false)
    })

    await page.locator(".document-tab").first().click({ button: "middle" })
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      "Untitled"
    )
    await expect(content).toContainText("first second")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    const windowChromeSettings = page.getByRole("button", {
      name: "Window Chrome",
    })
    await windowChromeSettings.click()
    await chooseSettingsOption(page, "Show tabs", "Always")
    await expect(windowChromeSettings).toHaveAttribute("aria-expanded", "true")
    const statusItemRows = page.locator(
      '[data-slot="collapsible-content"] [data-slot="field"]',
      { has: page.locator('[id^="status-item-"]') }
    )
    await expect(statusItemRows).toHaveCount(6)
    const statusItemRowTops = await statusItemRows.evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().top))
    )
    expect(new Set(statusItemRowTops).size).toBe(6)
    await page.locator('[aria-label="Show characters"]').click()
    await page.getByRole("switch", { name: "Always show status bar" }).click()
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog")).not.toBeVisible()

    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await expect
      .poll(() =>
        status.evaluate((element) => getComputedStyle(element).transform)
      )
      .toBe("matrix(1, 0, 0, 1, 0, 0)")
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await expect(status).not.toContainText("characters")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Window Chrome" }).click()
    await chooseSettingsOption(page, "Show tabs", "On Mouseover")
    await page.getByRole("switch", { name: "Show formatting toolbar" }).click()
    await settingsSaveButton(page).click()

    const formattingToolbar = page.locator(".formatting-toolbar")
    await expect(formattingToolbar).toHaveAttribute("data-visible", "true")
    const topChrome = page.locator(".top-chrome")
    const hoverGeometry = await page.evaluate(() => {
      const chrome = document.querySelector<HTMLElement>(".top-chrome")
      const toolbar = document.querySelector<HTMLElement>(".formatting-toolbar")
      if (!chrome || !toolbar) {
        throw new Error("Top hover geometry is unavailable")
      }
      const chromeBounds = chrome.getBoundingClientRect()
      const toolbarBounds = toolbar.getBoundingClientRect()
      return {
        chromeX: chromeBounds.right - 110,
        chromeY: chromeBounds.top + chromeBounds.height / 2,
        toolbarX: toolbarBounds.right - 110,
        toolbarY: (chromeBounds.bottom + toolbarBounds.bottom) / 2,
        belowY: toolbarBounds.bottom + 80,
      }
    })
    await page.mouse.move(hoverGeometry.toolbarX, hoverGeometry.belowY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await page.mouse.move(hoverGeometry.toolbarX, hoverGeometry.toolbarY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    const topAppRegions = await Promise.all([
      topChrome.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region")
      ),
      formattingToolbar.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region")
      ),
      formattingToolbar
        .getByRole("button")
        .first()
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region")
        ),
    ])
    expect(topAppRegions).toEqual(["drag", "drag", "no-drag"])
    await page.mouse.move(hoverGeometry.chromeX, hoverGeometry.chromeY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await page.mouse.move(hoverGeometry.toolbarX, hoverGeometry.toolbarY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await page.mouse.move(hoverGeometry.toolbarX, hoverGeometry.belowY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B"
    )
    await expect(formattingToolbar).toHaveCount(0)
    await page.mouse.move(hoverGeometry.toolbarX, hoverGeometry.toolbarY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    await page.mouse.move(hoverGeometry.chromeX, hoverGeometry.chromeY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await page.mouse.move(hoverGeometry.toolbarX, hoverGeometry.belowY)
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Window Chrome" }).click()
    await chooseSettingsOption(page, "Show tabs", "With Formatting Toolbar")
    await page.getByRole("switch", { name: "Show formatting toolbar" }).click()
    await settingsSaveButton(page).click()

    await expect(formattingToolbar).toHaveAttribute("data-visible", "true")
    await expect
      .poll(() =>
        tabStrip.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")

    await page.mouse.move(450, 20)
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await page.mouse.move(450, 160)
    await expect
      .poll(() =>
        topControls.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("application Quit saves the parent Settings draft and aborts a specialized draft @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  let closed = false

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openSettingsSection(page, "Miscellaneous")
    await page.getByLabel("Maximum content width in pixels").fill("1200")
    await openTypographySettings(page)
    await page.getByLabel("Base font size in pixels").fill("22")

    const didClose = waitForApplicationClose(app)
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await didClose
    closed = true
    expect(
      JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
    ).toMatchObject({
      baseFontSize: DEFAULT_APP_SETTINGS.baseFontSize,
      maxContentWidth: 1200,
    })
  } finally {
    if (!closed) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("closing a window saves its open Settings draft", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const first = BrowserWindow.getAllWindows()[0]
      const newWindow = Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "File")
        ?.submenu?.items.find((item) => item.label === "New Window")
      if (!first || !newWindow) throw new Error("New Window is unavailable")
      ;(
        globalThis as typeof globalThis & { settingsCloseTargetId?: number }
      ).settingsCloseTargetId = first.id
      newWindow.click(undefined, first, first.webContents)
    })
    await expect.poll(() => app.windows().length).toBe(2)
    await activateWindow(page)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openSettingsSection(page, "Miscellaneous")
    await page.getByLabel("Maximum content width in pixels").fill("1180")

    const pageClosed = page.waitForEvent("close")
    await app.evaluate(({ BrowserWindow }) => {
      const targetId = (
        globalThis as typeof globalThis & { settingsCloseTargetId?: number }
      ).settingsCloseTargetId
      BrowserWindow.fromId(targetId ?? -1)?.close()
    })
    await pageClosed
    await expect.poll(() => app.windows().length).toBe(1)
    expect(
      JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
    ).toMatchObject({ maxContentWidth: 1180 })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a second process opens a focused editor in a new window", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)

  try {
    const firstWindow = await app.firstWindow()
    await firstWindow.locator(".cm-editor").waitFor()
    const executable = await app.evaluate(() => process.execPath)

    await execFileAsync(
      executable,
      [projectRoot, `--user-data-dir=${userData}`],
      { cwd: projectRoot }
    )
    await expect.poll(() => app.windows().length).toBe(2)
    const newWindow = app
      .windows()
      .find((candidate) => candidate !== firstWindow)
    if (!newWindow) throw new Error("The second process did not add a window")

    await expect(newWindow.locator(".cm-content")).toBeFocused()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const windows = BrowserWindow.getAllWindows()
          return {
            focused: windows.filter((window) => window.isFocused()).length,
            total: windows.length,
          }
        })
      )
      .toEqual({ focused: 1, total: 2 })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("new windows and later launches use the most recent window size", async () => {
  const userData = await createTestUserData()
  const expectedSize = { width: 1_137, height: 777 }
  let app: ElectronApplication | null = await launchApplication(userData)

  const normalWindowSizes = () =>
    app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => {
        const { height, width } = window.getNormalBounds()
        return { width, height }
      })
    )

  try {
    let page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    }, expectedSize)
    await expect.poll(normalWindowSizes).toEqual([expectedSize])

    const closed = waitForApplicationClose(app)
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await closed
    app = null
    app = await launchApplication(userData)
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect.poll(normalWindowSizes).toEqual([expectedSize])

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "New Window")
      const window = BrowserWindow.getFocusedWindow()
      if (!item || !window) throw new Error("New Window is unavailable")
      item.click(undefined, window, window.webContents)
    })
    await expect.poll(() => app!.windows().length).toBe(2)
    await expect.poll(normalWindowSizes).toEqual([expectedSize, expectedSize])
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("dragging across any part of an adjacent tab reorders immediately @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    const tabs = page.locator(".document-tab")
    await expect(tabs).toHaveCount(2)
    const initialOrder = await tabs.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.tabId!)
    )

    const dragToken = await tabs.nth(1).evaluate((element) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.effectAllowed = "move"
      element.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        })
      )
      return dataTransfer.getData("application/x-pulse-md-tab")
    })
    expect(dragToken).not.toBe("")

    await page.evaluate((token) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      const leftTab = document.querySelector<HTMLElement>(".document-tab")
      if (!header || !leftTab) throw new Error("Tab strip is unavailable")
      const bounds = leftTab.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      dataTransfer.effectAllowed = "move"
      dataTransfer.setData("application/x-pulse-md-tab", token)
      for (const type of ["dragenter", "dragover"]) {
        header.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: bounds.right - 1,
            clientY: bounds.top + bounds.height / 2,
            dataTransfer,
          })
        )
      }
    }, dragToken)

    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => (element as HTMLElement).dataset.tabId!)
        )
      )
      .toEqual([initialOrder[1], initialOrder[0]])

    await page.evaluate(
      ({ leftTabId, token }) => {
        const header = document.querySelector<HTMLElement>(".top-chrome")
        const targetTab = document.querySelector<HTMLElement>(
          `.document-tab[data-tab-id="${CSS.escape(leftTabId)}"]`
        )
        if (!header || !targetTab) throw new Error("Drop target is unavailable")
        const bounds = targetTab.getBoundingClientRect()
        const dataTransfer = new DataTransfer()
        dataTransfer.effectAllowed = "move"
        dataTransfer.setData("application/x-pulse-md-tab", token)
        header.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.right - 1,
            clientY: bounds.top + bounds.height / 2,
            dataTransfer,
          })
        )
      },
      { leftTabId: initialOrder[0]!, token: dragToken }
    )

    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => (element as HTMLElement).dataset.tabId!)
        )
      )
      .toEqual([initialOrder[1], initialOrder[0]])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a final tab can move transactionally into an existing window", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "New Window")
      const window = BrowserWindow.getFocusedWindow()
      if (!item || !window) throw new Error("New Window is unavailable")
      item.click(undefined, window, window.webContents)
    })

    await expect.poll(() => app.windows().length).toBe(2)
    const target = app.windows().find((candidate) => candidate !== source)
    if (!target) throw new Error("Target window was not created")
    await target.locator(".cm-editor").waitFor()
    await target.locator(".top-chrome .document-tab").waitFor()
    await expect(target.locator(".cm-content")).toBeFocused()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const windows = BrowserWindow.getAllWindows()
          return {
            focused: windows.filter((window) => window.isFocused()).length,
            total: windows.length,
          }
        })
      )
      .toEqual({ focused: 1, total: 2 })

    const sourceTabId = await source
      .locator(".document-tab")
      .getAttribute("data-tab-id")
    if (!sourceTabId) throw new Error("Source tab id is unavailable")
    const dragToken = await source.evaluate(
      (tabId) => window.pulseMd.beginTabDrag(tabId),
      sourceTabId
    )
    expect(dragToken).not.toBe("")

    await target.evaluate((token) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      if (!header) throw new Error("Target tab strip is unavailable")
      const tab = header.querySelector<HTMLElement>(".document-tab")
      if (!tab) throw new Error("Target tab is unavailable")
      const dataTransfer = new DataTransfer()
      dataTransfer.effectAllowed = "move"
      dataTransfer.setData("application/x-pulse-md-tab", token)
      for (const type of ["dragenter", "dragover"]) {
        header.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: tab.getBoundingClientRect().left + 1,
            clientY: 20,
            dataTransfer,
          })
        )
      }
    }, dragToken)

    const placeholder = target.locator(".document-tab-drop-placeholder")
    await expect(placeholder).toHaveCount(1)
    const landingGeometry = await target.evaluate(() => {
      const placeholder = document.querySelector<HTMLElement>(
        ".document-tab-drop-placeholder"
      )
      const tab = document.querySelector<HTMLElement>(".document-tab")
      if (!placeholder || !tab) throw new Error("Drop preview is unavailable")
      return {
        placeholder: placeholder.getBoundingClientRect().toJSON(),
        tab: tab.getBoundingClientRect().toJSON(),
      }
    })
    expect(landingGeometry.placeholder.width).toBe(landingGeometry.tab.width)
    expect(landingGeometry.placeholder.x).toBeLessThan(landingGeometry.tab.x)

    await target.evaluate((token) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      const tab = header?.querySelector<HTMLElement>(".document-tab")
      if (!header || !tab) throw new Error("Target tab strip is unavailable")
      const dataTransfer = new DataTransfer()
      dataTransfer.effectAllowed = "move"
      dataTransfer.setData("application/x-pulse-md-tab", token)
      header.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: tab.getBoundingClientRect().left + 1,
          clientY: 20,
          dataTransfer,
        })
      )
    }, dragToken)

    await expect.poll(() => app.windows().length).toBe(1)
    await expect(target.locator(".document-tab")).toHaveCount(2)
    await expect(target.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("selection and search colors follow window activation rather than editor focus", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await editor.waitFor()
    await focusNativeWindow(app)
    await activateWindow(page)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.isFocused() ?? false
        )
      )
      .toBe(true)
    await expect(editor).not.toHaveClass(/cm-window-inactive/)
    const paragraph = page.locator(".cm-line", { hasText: "This paragraph" })
    await clickVisibleText(page, paragraph)
    await page.keyboard.press("Home")
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press("Shift+ArrowRight")
    }

    const selectionLayer = page.locator(".cm-app-selectionBackground").first()
    const selectedText = page.locator(".cm-app-selection-foreground").first()
    await expect(selectionLayer).toHaveCSS(
      "background-color",
      "rgb(76, 112, 150)"
    )
    await expect(selectedText).toHaveCSS("color", "rgb(248, 250, 252)")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    const findInput = page.getByRole("textbox", { name: "Find" })
    await expect(findInput).toBeFocused()
    await expect(editor).not.toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-window-inactive/)
    await expect(selectionLayer).toHaveCSS(
      "background-color",
      "rgb(76, 112, 150)"
    )

    await findInput.fill("Markdown")
    const ordinaryMatch = page
      .locator(".cm-searchMatch:not(.cm-searchMatch-selected)")
      .first()
    await expect(ordinaryMatch).toHaveCSS(
      "background-color",
      "rgb(255, 238, 46)"
    )
    await expect(ordinaryMatch).toHaveCSS("color", "rgb(17, 19, 24)")

    await page.keyboard.press("Enter")
    const currentMatch = page.locator(".cm-searchMatch-selected").first()
    await expect(currentMatch).toHaveCSS("background-color", "rgb(255, 149, 0)")
    await expect(currentMatch).toHaveCSS("color", "rgb(17, 19, 24)")

    await page.keyboard.press("Escape")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openTypographySettings(page)
    await page.getByLabel("Base font size in pixels").focus()
    await expect(editor).not.toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-window-inactive/)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)

    await deactivateNativeWindow(app)
    await expect(editor).toHaveClass(/cm-window-inactive/)

    await focusNativeWindow(app)
    await expect(editor).not.toHaveClass(/cm-window-inactive/)
    await cancelTypographySettings(page)
    await expect(selectionLayer).toHaveCSS(
      "background-color",
      "rgb(76, 112, 150)"
    )
    await expect(selectedText).toHaveCSS("color", "rgb(248, 250, 252)")
    await page.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("selection paint stays on the selected text and inside the text lane @renderer-isolated", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-selection-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    [
      "**Inline Math:** The Pythagorean theorem is $a^2 + b^2 = c^2$.",
      "A second line makes the full-width selection edges observable.",
    ].join("\n")
  )
  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const line = page.locator(".cm-line").first()

    for (const word of ["The", "Pythagorean", "theorem"]) {
      const point = await line.evaluate((element, text) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const offset = node.textContent?.indexOf(text) ?? -1
          if (offset < 0) continue
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + text.length)
          const bounds = range.getBoundingClientRect()
          return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          }
        }
        throw new Error(`Could not find ${text}`)
      }, word)
      await page.mouse.dblclick(point.x, point.y)

      await expect
        .poll(async () => {
          const marker = await page
            .locator(".cm-app-selectionBackground")
            .first()
            .boundingBox()
          const foreground = await page
            .locator(".cm-app-selection-foreground")
            .first()
            .boundingBox()
          if (!marker || !foreground) return Number.POSITIVE_INFINITY
          return Math.max(
            Math.abs(marker.x - foreground.x),
            Math.abs(marker.width - foreground.width)
          )
        })
        .toBeLessThanOrEqual(1)
    }

    await clickVisibleText(page, line)
    await page.keyboard.press("End")
    await page.keyboard.press("Shift+ArrowRight")
    await expect
      .poll(() => page.locator(".cm-app-selectionBackground").count())
      .toBeGreaterThan(0)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    const contentHandle = await page.locator(".cm-content").elementHandle()
    if (!contentHandle) throw new Error("Editor content is unavailable")
    const laneOverflow = await page
      .locator(".cm-app-selectionBackground")
      .evaluateAll((markers, content) => {
        const contentBounds = content.getBoundingClientRect()
        const style = getComputedStyle(content)
        const left = contentBounds.left + Number.parseFloat(style.paddingLeft)
        const right =
          contentBounds.right - Number.parseFloat(style.paddingRight)
        return markers.reduce((overflow, marker) => {
          const bounds = marker.getBoundingClientRect()
          return Math.max(overflow, left - bounds.left, bounds.right - right, 0)
        }, 0)
      }, contentHandle)
    await contentHandle.dispose()
    expect(laneOverflow).toBeLessThanOrEqual(0.5)
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("the lazy expanded search handoff preserves geometry, typing, and navigation exactly once @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(
    userData,
    path.join(projectRoot, "markdown-test.md")
  )

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    await app.evaluate(({ session }) => {
      const testGlobal = globalThis as typeof globalThis & {
        searchOverlayChunkRequests?: number
      }
      testGlobal.searchOverlayChunkRequests = 0
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/SearchOverlay-*"] },
        (_details, callback) => {
          testGlobal.searchOverlayChunkRequests =
            (testGlobal.searchOverlayChunkRequests ?? 0) + 1
          setTimeout(() => callback({}), 3_000)
        }
      )
    })

    const content = page.locator(".cm-content")
    const documentBefore = await content.evaluate((element) =>
      (
        element as HTMLElement & {
          cmTile?: { view?: { state: { doc: { toString(): string } } } }
        }
      ).cmTile?.view?.state.doc.toString()
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+F" : "Control+H"
    )
    await page.keyboard.insertText("markdown")
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                searchOverlayChunkRequests?: number
              }
            ).searchOverlayChunkRequests ?? 0
        )
      )
      .toBe(1)
    const loadingSearch = page.locator('[data-search-overlay-state="loading"]')
    await expect(loadingSearch).toBeVisible()
    await expect(
      loadingSearch.getByRole("textbox", { name: "Replace" })
    ).toBeVisible()
    const loadingBounds = await loadingSearch.boundingBox()
    if (!loadingBounds) throw new Error("Loading Search bounds are unavailable")
    const find = page.getByRole("textbox", { name: "Find" })
    await expect(find).toHaveValue("markdown", { timeout: 1_000 })
    await expect(find).toBeFocused()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await expect(
      page.locator('[data-search-overlay-state="ready"]')
    ).toBeVisible({ timeout: 5_000 })
    const readyBounds = await page
      .locator('[data-search-overlay-state="ready"]')
      .boundingBox()
    if (!readyBounds) throw new Error("Ready Search bounds are unavailable")
    expect(Math.abs(readyBounds.x - loadingBounds.x)).toBeLessThanOrEqual(1)
    expect(
      Math.abs(readyBounds.width - loadingBounds.width)
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(readyBounds.height - loadingBounds.height)
    ).toBeLessThanOrEqual(1)
    const readyFind = page.getByRole("textbox", { name: "Find" })
    await expect(readyFind).toHaveValue("markdown")
    await expect(readyFind).toBeFocused()
    await expect
      .poll(() =>
        readyFind.evaluate((input: HTMLInputElement) => ({
          end: input.selectionEnd,
          start: input.selectionStart,
        }))
      )
      .toEqual({
        end: "markdown".length,
        start: "markdown".length,
      })
    await expect(page.locator(".search-overlay output")).toHaveText("2/20")
    await expect(page.locator(".cm-searchMatch-selected")).toHaveText(
      "markdown"
    )
    await page.keyboard.insertText(" again")
    await expect(readyFind).toHaveValue("markdown again")
    await page.keyboard.press("Escape")
    await expect(
      page.locator('[data-search-overlay-state="ready"]')
    ).toHaveCount(0)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    await expect(readyFind).toBeFocused()
    await expect
      .poll(() =>
        readyFind.evaluate((input: HTMLInputElement) => ({
          end: input.selectionEnd,
          start: input.selectionStart,
        }))
      )
      .toEqual({
        end: "markdown again".length,
        start: 0,
      })
    await page.keyboard.insertText("replacement")
    await expect(readyFind).toHaveValue("replacement")
    await expect
      .poll(() =>
        content.evaluate((element) =>
          (
            element as HTMLElement & {
              cmTile?: {
                view?: { state: { doc: { toString(): string } } }
              }
            }
          ).cmTile?.view?.state.doc.toString()
        )
      )
      .toBe(documentBefore)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("cold Search retains input when closed before its chunk resolves @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(
    userData,
    path.join(projectRoot, "markdown-test.md")
  )

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ session }) => {
      const testGlobal = globalThis as typeof globalThis & {
        coldSearchChunkRequests?: number
      }
      testGlobal.coldSearchChunkRequests = 0
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/SearchOverlay-*"] },
        (_details, callback) => {
          testGlobal.coldSearchChunkRequests =
            (testGlobal.coldSearchChunkRequests ?? 0) + 1
          setTimeout(() => callback({}), 3_000)
        }
      )
    })
    await page.locator(".cm-editor").waitFor()

    const findShortcut = process.platform === "darwin" ? "Meta+F" : "Control+F"
    await page.keyboard.press(findShortcut)
    await page.keyboard.insertText("markdown")
    const loadingSearch = page.locator('[data-search-overlay-state="loading"]')
    const find = page.getByRole("textbox", { name: "Find" })
    await expect(loadingSearch).toBeVisible()
    await expect(find).toHaveValue("markdown")

    await page.keyboard.press("Escape")
    await expect(loadingSearch).toHaveCount(0)
    await page.keyboard.press(findShortcut)
    await expect(loadingSearch).toBeVisible()
    await expect(find).toHaveValue("markdown")
    await expect(
      page.locator('[data-search-overlay-state="ready"]')
    ).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole("textbox", { name: "Find" })).toHaveValue(
      "markdown"
    )
    await expect(page.locator(".search-overlay output")).toHaveText(/\/20$/u)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                coldSearchChunkRequests?: number
              }
            ).coldSearchChunkRequests ?? 0
        )
      )
      .toBe(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("settings save failures stay visible and can be retried @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ ipcMain }) => {
      let attempts = 0
      ipcMain.removeHandler("pulse-md:set-settings")
      ipcMain.handle("pulse-md:set-settings", (_event, settings) => {
        attempts += 1
        if (attempts === 1) throw new Error("Injected settings write failure")
        return { effective: settings, persisted: settings }
      })
    })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    const dialog = page.getByRole("dialog", { name: "Settings" })
    const save = settingsSaveButton(page)
    await save.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("alert")).toHaveText(
      "Settings could not be saved. Check that the settings folder is writable, then try again."
    )
    await expect(save).toBeEnabled()

    await save.click()
    await expect(dialog).not.toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("edit commands follow focus while Settings isolates document commands", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  const primary = process.platform === "darwin" ? "Meta" : "Control"

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    await editor.waitFor()
    await content.click()
    await page.keyboard.press(`${primary}+End`)
    await page.keyboard.type(" focus-safe")
    const documentBefore = await content.textContent()

    await page.keyboard.press(`${primary}+F`)
    await expect(
      page.locator('[data-search-overlay-state="ready"]')
    ).toBeVisible()
    const find = page.getByRole("textbox", { name: "Find" })
    await find.fill("")
    await find.focus()
    await page.keyboard.insertText("needle")
    await expect(find).toHaveValue("needle")
    await runEditMenuItem(app, "Undo")
    await expect(find).toHaveValue("")
    await expect(content).toHaveText(documentBefore ?? "")
    await runEditMenuItem(app, "Redo")
    await expect(find).toHaveValue("needle")
    await expect(content).toHaveText(documentBefore ?? "")
    await page.keyboard.press("Escape")

    await page.keyboard.press(`${primary}+,`)
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await expect(dialog).toBeVisible()
    await openSettingsSection(page, "Miscellaneous")
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toHaveCount(0)
    const width = dialog.getByLabel("Maximum content width in pixels")
    const initialWidth = await width.inputValue()
    await width.focus()
    await page.keyboard.press(`${primary}+A`)
    await page.keyboard.insertText("1200")
    await expect(width).toHaveValue("1200")
    await runEditMenuItem(app, "Undo")
    await expect(width).toHaveValue(initialWidth)
    await expect(content).toHaveText(documentBefore ?? "")

    const tabs = page.locator(".document-tab")
    const tabCount = await tabs.count()
    await page.keyboard.press(`${primary}+T`)
    await page.keyboard.press(`${primary}+Shift+V`)
    await page.keyboard.press(`${primary}+F`)
    await page.keyboard.press(`${primary}+W`)
    await page.keyboard.press("Alt+Z")
    await expect(dialog).toBeVisible()
    await expect(tabs).toHaveCount(tabCount)
    await expect(editor).not.toHaveClass(/cm-md-source/)
    await expect(page.getByRole("textbox", { name: "Find" })).toHaveCount(0)
    await expect(content).toHaveText(documentBefore ?? "")

    await openTypographySettings(page)
    const typography = page.getByRole("region", {
      name: "Typography preview workspace",
    })
    await content.focus()
    await expect
      .poll(() =>
        typography.evaluate((workspace) =>
          workspace.contains(document.activeElement)
        )
      )
      .toBe(true)
    const fontSize = typography.getByLabel("Base font size in pixels")
    const initialFontSize = await fontSize.inputValue()
    await fontSize.focus()
    await page.keyboard.press(`${primary}+A`)
    await page.keyboard.insertText("22")
    await expect(fontSize).toHaveValue("22")
    await runEditMenuItem(app, "Undo")
    await expect(fontSize).toHaveValue(initialFontSize)
    await runEditMenuItem(app, "Redo")
    await expect(fontSize).toHaveValue("22")

    await page.keyboard.press(`${primary}+T`)
    await page.keyboard.press(`${primary}+Shift+V`)
    await page.keyboard.press(`${primary}+F`)
    await page.keyboard.press(`${primary}+W`)
    await expect(typography).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Find" })).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(dialog).toBeVisible()
    await expect(tabs).toHaveCount(tabCount)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
    await expect(content).toHaveText(documentBefore ?? "")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("find highlights the current callout-title match without moving the caret @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(
    userData,
    path.join(projectRoot, "markdown-test.md")
  )

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const selectionBefore = await page.locator(".cm-content").evaluate(
      (element) =>
        (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  selection: {
                    main: { anchor: number; head: number }
                  }
                }
              }
            }
          }
        ).cmTile?.view?.state.selection.main
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    const find = page.getByRole("textbox", { name: "Find" })
    await find.fill("fenced code inside")
    await page.getByRole("button", { name: "Next match" }).click()

    await expect(find).toBeFocused()
    const selectedMatch = page.locator(
      ".cm-md-callout-title .cm-searchMatch-selected"
    )
    await expect(selectedMatch).toHaveText("Fenced code inside")
    await expect(selectedMatch).toBeVisible()
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    expect(
      await page.locator(".cm-content").evaluate(
        (element) =>
          (
            element as HTMLElement & {
              cmTile?: {
                view?: {
                  state: {
                    selection: {
                      main: { anchor: number; head: number }
                    }
                  }
                }
              }
            }
          ).cmTile?.view?.state.selection.main
      )
    ).toEqual(selectionBefore)
    await expect(
      page.getByRole("button", {
        name: "Collapse Fenced code inside a callout callout",
      })
    ).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("find and replace supports search options, counts, and preserved case", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-search-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    ["alpha Alpha ALPHA alphabet", "", "cat cot cut scat", ""].join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )

    const find = page.getByRole("textbox", { name: "Find" })
    const results = page.locator("output")
    const matchCase = page.getByRole("button", { name: "Match case" })
    const wholeWord = page.getByRole("button", { name: "Match whole word" })
    const regexp = page.getByRole("button", {
      name: "Use regular expression",
    })

    await find.fill("alpha")
    await expect(results).toHaveText("0/4")
    await matchCase.click()
    await expect(find).toBeFocused()
    await matchCase.click()
    await expect(find).toBeFocused()
    await page.getByRole("button", { name: "Next match" }).click()
    await expect(results).toHaveText("1/4")

    await matchCase.click()
    await expect(matchCase).toHaveAttribute("aria-pressed", "true")
    await expect(results).toHaveText("1/2")
    await wholeWord.click()
    await expect(wholeWord).toHaveAttribute("aria-pressed", "true")
    await expect(results).toHaveText("1/1")

    await regexp.click()
    await find.fill("[")
    await expect(find).toHaveAttribute("aria-invalid", "true")
    await expect(results).toHaveText("Invalid")
    await expect(
      page.getByRole("button", { name: "Next match" })
    ).toBeDisabled()
    const disabledNextTooltip = page.locator(
      '[data-search-action-tooltip="Next match"]'
    )
    await expect(disabledNextTooltip).toHaveAttribute("aria-disabled", "true")
    await expect(disabledNextTooltip).toHaveAttribute("tabindex", "0")
    await disabledNextTooltip.hover()
    const openTooltip = page.locator('[data-slot="tooltip-content"][data-open]')
    await expect(openTooltip).toHaveText("Next match")
    const tooltipBounds = await openTooltip.boundingBox()
    if (!tooltipBounds) throw new Error("Tooltip bounds are unavailable")
    await page.mouse.move(
      tooltipBounds.x + tooltipBounds.width / 2,
      tooltipBounds.y + tooltipBounds.height / 2
    )
    await expect(openTooltip).toHaveCount(0)

    await find.fill("^")
    await expect(find).not.toHaveAttribute("aria-invalid", "true")
    await expect(results).toHaveText("0/4")
    await regexp.click()
    await find.fill("alpha")
    await expect(page.locator(".cm-searchMatch").first()).toBeVisible()

    await matchCase.click()
    await wholeWord.click()
    await find.fill("alpha")
    await expect(results).toHaveText("0/4")

    await page.getByRole("button", { name: "Show replace" }).click()
    await expect(find).toBeFocused()
    const replace = page.getByRole("textbox", { name: "Replace" })
    const preserveCase = page.getByRole("button", { name: "Preserve case" })
    await replace.focus()
    await page.getByRole("button", { name: "Hide replace" }).click()
    await expect(find).toBeFocused()
    await page.getByRole("button", { name: "Show replace" }).click()
    await expect(find).toBeFocused()
    await replace.fill("beta")
    await preserveCase.click()
    await expect(replace).toBeFocused()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter"
    )
    await expect(content).toContainText("beta Beta BETA betabet")
    await expect(results).toHaveText("0/0")

    await preserveCase.click()
    await regexp.click()
    await find.fill("c.t")
    await replace.fill("pet")
    await expect(results).toHaveText("0/4")
    await page.getByRole("button", { name: "Next match" }).click()
    await expect(results).toHaveText("1/4")
    await page.getByRole("button", { name: "Replace", exact: true }).click()
    await expect(content).toContainText("pet cot cut scat")
    await expect(results).toHaveText("1/3")

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setSize(480, 600)
    })
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    const searchOverlay = page.getByRole("form", {
      name: "Find and replace in document",
    })
    await expect
      .poll(() => page.evaluate(() => innerWidth))
      .toBeLessThanOrEqual(240)
    const compactGeometry = await searchOverlay.evaluate((overlay) => ({
      clientWidth: overlay.clientWidth,
      controls: [...overlay.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          label: button.getAttribute("aria-label"),
          left: rect.left,
          right: rect.right,
        }
      }),
      scrollWidth: overlay.scrollWidth,
      viewportWidth: innerWidth,
    }))
    expect(compactGeometry.scrollWidth).toBeLessThanOrEqual(
      compactGeometry.clientWidth + 1
    )
    for (const control of compactGeometry.controls) {
      expect(
        control.left,
        `${control.label} starts outside the viewport`
      ).toBeGreaterThanOrEqual(0)
      expect(
        control.right,
        `${control.label} ends outside the viewport`
      ).toBeLessThanOrEqual(compactGeometry.viewportWidth)
    }
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("find navigation centers an offscreen markdown-test match clear of chrome @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(
    userData,
    path.join(projectRoot, "markdown-test.md")
  )

  try {
    const page = await app.firstWindow()
    const scroller = page.locator(".cm-scroller")
    await page.locator(".cm-editor").waitFor()
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    await page
      .getByRole("textbox", { name: "Find" })
      .fill("Sanitized HTML block")
    await page.getByRole("button", { name: "Next match" }).click()

    const selectedMatch = page.locator(".cm-searchMatch-selected").first()
    await expect(selectedMatch).toBeVisible()
    const geometry = await selectedMatch.evaluate((element) => {
      const match = element.getBoundingClientRect()
      const viewport = document
        .querySelector(".cm-scroller")!
        .getBoundingClientRect()
      return {
        matchCenter: (match.top + match.bottom) / 2,
        viewportCenter: (viewport.top + viewport.bottom) / 2,
      }
    })
    expect(
      Math.abs(geometry.matchCenter - geometry.viewportCenter)
    ).toBeLessThan(80)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("live Markdown collapses reference-definition blocks without leaving line gaps @renderer-isolated", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-reference-definitions-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    [
      "Baseline before",
      "",
      "",
      "Baseline after",
      "",
      "Definition before",
      "",
      "[first]: /one",
      "[second]:",
      "  /two",
      '  "Multiline title"',
      "",
      "Definition after",
      "",
      "Inline [lookalike]: /not-a-definition trailing text",
      "",
      "# EOF before",
      "[eof]: /last",
    ].join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()

    await expect(content).not.toContainText("[first]: /one")
    await expect(content).not.toContainText("[second]:")
    await expect(content).toContainText(
      "Inline [lookalike]: /not-a-definition trailing text"
    )
    await expect(page.locator(".cm-line").last()).toHaveText("EOF before")

    const gaps = await page.evaluate(() => {
      const topFor = (text: string) => {
        const line = [...document.querySelectorAll(".cm-line")].find(
          (candidate) => candidate.textContent === text
        )
        if (!line) throw new Error(`Missing rendered line: ${text}`)
        return line.getBoundingClientRect().top
      }
      return {
        baseline: topFor("Baseline after") - topFor("Baseline before"),
        definitions: topFor("Definition after") - topFor("Definition before"),
      }
    })
    expect(Math.abs(gaps.definitions - gaps.baseline)).toBeLessThanOrEqual(0.5)

    const modeShortcut =
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    await page.keyboard.press(modeShortcut)
    await expect(content).toContainText("[first]: /one")
    const firstDefinition = page
      .locator(".cm-line")
      .filter({ hasText: "[first]: /one" })
    await clickVisibleText(page, firstDefinition)

    await page.keyboard.press(modeShortcut)
    await expect(content).toContainText("[first]: /one")
    await expect(content).not.toContainText("[second]:")

    await clickVisibleText(
      page,
      page.locator(".cm-line").filter({ hasText: "Definition after" })
    )
    await expect(content).not.toContainText("[first]: /one")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    await page.getByRole("textbox", { name: "Find" }).fill("[second]")
    await page.getByRole("button", { name: "Next match" }).click()
    await expect(page.locator("output")).toHaveText("1/1")
    await expect(content).not.toContainText("[second]:")
    await expect(content).not.toContainText("[first]: /one")
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("live Markdown exposes semantic rules, editable tasks, and safe web links", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-interactions-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    [
      "---",
      "",
      "- [ ] Pending task",
      "- [x] Completed task",
      "",
      '[Inline](https://example.com/inline "Open example")',
      "[Reference][target]",
      "[Email](mailto:reader@example.com)",
      "[Empty destination]()",
      "",
      "[target]: http://example.com/reference",
      "",
    ].join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page.locator(".cm-content")).toBeFocused()

    const separator = page.getByRole("separator")
    await expect(separator).toHaveCount(1)
    expect(
      await separator.evaluate(
        (element) => getComputedStyle(element).backgroundImage
      )
    ).toContain("linear-gradient")
    await expect(separator).not.toContainText("---")

    const checkboxes = page.locator(".cm-md-task-checkbox")
    await expect(checkboxes).toHaveCount(2)
    await expect(checkboxes.first()).toHaveCSS("cursor", "default")
    await expect(checkboxes.nth(0)).not.toBeChecked()
    await checkboxes.nth(0).click()
    await expect(checkboxes.nth(0)).toBeChecked()

    await checkboxes.nth(1).focus()
    await page.keyboard.press("Space")
    await expect(checkboxes.nth(1)).not.toBeChecked()

    await page.locator("body").focus()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-content")).toContainText(
      "- [x] Pending task"
    )
    await expect(page.locator(".cm-content")).toContainText(
      "- [ ] Completed task"
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)

    await app.evaluate(({ shell: electronShell }) => {
      const testGlobal = globalThis as typeof globalThis & {
        openedExternalLinks?: string[]
      }
      testGlobal.openedExternalLinks = []
      electronShell.openExternal = async (url) => {
        testGlobal.openedExternalLinks?.push(url)
      }
    })

    const modifier = process.platform === "darwin" ? "Meta" : "Control"
    const inlineLink = page.locator(".cm-md-link").filter({ hasText: "Inline" })
    const emailLink = page.locator(".cm-md-link").filter({ hasText: "Email" })
    await expect(
      page.locator(".cm-md-link").filter({ hasText: "Empty destination" })
    ).toBeVisible()
    await inlineLink.hover()
    await expect(inlineLink).toHaveCSS("cursor", "text")
    const linkTooltip = page.locator('[data-slot="tooltip-content"][data-open]')
    await expect(linkTooltip).toHaveText("Open example")
    const modeShortcut =
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(linkTooltip).toHaveCount(0)
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await page.mouse.move(10, 200)
    await inlineLink.hover()
    await expect(linkTooltip).toHaveText("Open example")

    await page.keyboard.down(modifier)
    await expect(inlineLink).toHaveCSS("cursor", "pointer")
    await expect(linkTooltip).toHaveText("https://example.com/inline")
    await emailLink.hover()
    await expect(emailLink).toHaveCSS("cursor", "pointer")
    await expect(linkTooltip).toHaveText("mailto:reader@example.com")
    await page.keyboard.up(modifier)
    await expect(linkTooltip).toHaveCount(0)
    await inlineLink.hover()
    await expect(inlineLink).toHaveCSS("cursor", "text")
    await expect(linkTooltip).toHaveText("Open example")

    await inlineLink.click({ modifiers: [modifier] })
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            openedExternalLinks?: string[]
          }
          return testGlobal.openedExternalLinks
        })
      )
      .toEqual(["https://example.com/inline"])

    await page
      .locator(".cm-md-link")
      .filter({ hasText: "Reference" })
      .click({ modifiers: [modifier] })
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            openedExternalLinks?: string[]
          }
          return testGlobal.openedExternalLinks
        })
      )
      .toEqual(["https://example.com/inline", "http://example.com/reference"])

    await emailLink.click({ modifiers: [modifier] })
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            openedExternalLinks?: string[]
          }
          return testGlobal.openedExternalLinks
        })
      )
      .toEqual([
        "https://example.com/inline",
        "http://example.com/reference",
        "mailto:reader@example.com",
      ])

    const rejectedProtocol = await page.evaluate(async () => {
      try {
        await window.pulseMd.openExternalLink("custom:opaque")
        return null
      } catch (error) {
        return String(error)
      }
    })
    expect(rejectedProtocol).toContain("protocol is not allowed")

    const inlineLine = page.locator(".cm-line").filter({ hasText: "Inline" })
    await inlineLine.click()
    await expect(inlineLine).toContainText("https://example.com/inline")
    const revealedWebLink = page
      .locator(".cm-md-web-link")
      .filter({ hasText: "https://example.com/inline" })
      .first()
    await revealedWebLink.hover()
    await page.keyboard.down(modifier)
    await expect(revealedWebLink).toHaveCSS("cursor", "pointer")
    await page.keyboard.up(modifier)
    expect(
      await app.evaluate(() => {
        const testGlobal = globalThis as typeof globalThis & {
          openedExternalLinks?: string[]
        }
        return testGlobal.openedExternalLinks?.length
      })
    ).toBe(3)
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("a rejected Outline chunk stays local and can be retried @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ session }) => {
      let failed = false
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/OutlinePopover-*"] },
        (_details, callback) => {
          if (!failed) {
            failed = true
            callback({ cancel: true })
          } else {
            callback({})
          }
        }
      )
    })
    await page.locator(".cm-editor").waitFor()
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(`${primary}+Shift+O`)

    const failure = page.locator('[data-slot="popover-content"]', {
      hasText: "Outline unavailable",
    })
    await expect(failure).toBeVisible()
    await failure.getByRole("button", { name: "Retry" }).click()
    await expect(
      page.getByRole("combobox", { name: "Document outline" })
    ).toBeVisible()
    await page.keyboard.press("Escape")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a preloaded outline opens without the first-render lazy throttle @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.waitForEvent("requestfinished", {
      predicate: (request) => request.url().includes("OutlinePopover-"),
      timeout: 10_000,
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    )

    const openedByNextFrame = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const trigger = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Document outline"]'
          )
          if (!trigger) throw new Error("The outline trigger is unavailable")
          trigger.click()
          requestAnimationFrame(() => {
            resolve(
              document.querySelector('[data-slot="popover-content"]') !== null
            )
          })
        })
    )
    expect(openedByNextFrame).toBe(true)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("dismissing the outline preserves a hidden caret @renderer-isolated", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-outline-caret-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    ["# First heading", "", "Body", "", "## Target heading", ""].join("\n")
  )
  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const outlineShortcut =
      process.platform === "darwin" ? "Meta+Shift+O" : "Control+Shift+O"
    const outline = page.locator('[data-slot="popover-content"]')
    await editor.waitFor()
    await expect(content).toBeFocused()
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)

    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()

    await page.keyboard.press(outlineShortcut)
    await expect(outline).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(outline).toHaveCount(0)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()

    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()

    await page.keyboard.press(outlineShortcut)
    await outline
      .getByRole("option", { name: "Heading level 2: Target heading" })
      .click()
    await expect(outline).toHaveCount(0)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()

    await page.keyboard.press(outlineShortcut)
    await expect(
      outline.locator('[data-slot="command-item"][data-selected="true"]')
    ).toContainText("Target heading")
    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(content).not.toBeFocused()
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("large outlines keep a bounded virtual window across full-list navigation @renderer-isolated", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-virtual-outline-${process.pid}.md`
  )
  const headings = Array.from({ length: 600 }, (_, index) => {
    const number = index + 1
    const level = (index % 6) + 1
    return `${"#".repeat(level)} Heading ${number}`
  })
  await writeFile(temporaryDocument, `${headings.join("\n\n")}\n`)
  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(`${primary}+Shift+O`)

    const outline = page.locator('[data-slot="popover-content"]')
    const list = outline.locator('[data-slot="command-list"]')
    const items = outline.locator('[data-slot="command-item"]')
    const outlineSearch = outline.getByPlaceholder("Go to heading…")
    const selected = outline.locator(
      '[data-slot="command-item"][data-selected="true"]'
    )
    await expect(outline).toBeVisible()
    await expect(outlineSearch).toBeFocused()
    await expect(items).toHaveCount(48)

    await page.keyboard.press("End")
    await expect(selected).toContainText("Heading 600")
    await expect(selected).toHaveAttribute("aria-posinset", "600")
    await expect(selected).toHaveAttribute("aria-setsize", "600")
    await expect(items).toHaveCount(48)

    await page.keyboard.press("ArrowUp")
    await expect(selected).toContainText("Heading 599")
    await page.keyboard.press("Home")
    await expect(selected).toContainText("Heading 1")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "End"
    )
    await expect(selected).toContainText("Heading 600")

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.6
    })
    await expect
      .poll(async () =>
        Number(
          await items
            .filter({ visible: true })
            .first()
            .getAttribute("aria-posinset")
        )
      )
      .toBeGreaterThan(200)
    await expect(items).toHaveCount(48)

    await outlineSearch.pressSequentially("Heading 417")
    await expect(outlineSearch).toHaveValue("Heading 417")
    await expect(items).toHaveCount(1)
    await expect(selected).toContainText("Heading 417")
    await page.keyboard.press("Enter")
    await expect(outline).toHaveCount(0)
    await expect(
      page.locator(".cm-line").filter({ hasText: "Heading 417" })
    ).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("outline, heading links, heading shortcuts, and tab shortcuts share navigation state @renderer-isolated", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-navigation-")
  )
  const mainDocument = path.join(testDirectory, "main.md")
  const linkedDocument = path.join(testDirectory, "other document.md")
  const filler = (prefix: string) =>
    Array.from(
      { length: 140 },
      (_, index) => `${prefix} paragraph ${index + 1}`
    ).join("\n\n")

  await writeFile(
    mainDocument,
    [
      "# Intro",
      "",
      "[Jump to target](#target-heading)",
      "[Open linked document](other%20document.md#other-section)",
      "",
      filler("Before target"),
      "",
      "## Target Heading",
      "",
      filler("Between headings"),
      "",
      "## Later Heading",
      "",
    ].join("\n")
  )
  await writeFile(
    linkedDocument,
    [
      "# Other Document",
      "",
      filler("Other filler"),
      "",
      "## Other Section",
      "",
    ].join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, mainDocument)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const outlineShortcut = `${primary}+Shift+O`
    const exactH2Shortcut =
      process.platform === "darwin" ? "Meta+Alt+2" : "Control+Alt+2"
    const previousChord =
      process.platform === "darwin" ? "Control+Meta+P" : "Control+Alt+P"

    await page.keyboard.press(outlineShortcut)
    const outline = page.locator('[data-slot="popover-content"]')
    await expect(outline).toBeVisible()
    await expect(
      outline.getByRole("combobox", { name: "Document outline" })
    ).toBeVisible()
    await expect(outline.getByText("Intro", { exact: true })).toBeVisible()
    await expect(
      outline.getByText("Target Heading", { exact: true })
    ).toBeVisible()

    const selectedOutlineItem = outline.locator(
      '[data-slot="command-item"][data-selected="true"]'
    )
    const targetOutlineItem = outline.getByRole("option", {
      name: "Heading level 2: Target Heading",
    })
    const laterOutlineItem = outline.getByRole("option", {
      name: "Heading level 2: Later Heading",
    })
    const outlineSearch = outline.getByPlaceholder("Go to heading…")
    const itemBackground = (item: Locator) =>
      item.evaluate((element) => getComputedStyle(element).backgroundColor)

    await expect(outlineSearch).toBeFocused()
    await page.keyboard.press("End")
    await expect(selectedOutlineItem).toContainText("Later Heading")
    await expect(laterOutlineItem).toHaveAttribute("aria-selected", "true")
    await expect(targetOutlineItem).toHaveAttribute("aria-selected", "false")
    expect(await itemBackground(laterOutlineItem)).not.toBe(
      await itemBackground(targetOutlineItem)
    )
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+ArrowUp")
    } else {
      await page.keyboard.press("Home")
    }
    await expect(selectedOutlineItem).toContainText("Intro")

    await outlineSearch.fill("target")
    await page.keyboard.press(`${primary}+A`)
    await expect(outlineSearch).toHaveJSProperty("selectionStart", 0)
    await expect(outlineSearch).toHaveJSProperty(
      "selectionEnd",
      "target".length
    )
    await expect(outline.locator('[data-slot="command-item"]')).toHaveCount(1)
    await page.keyboard.press("Enter")
    await expect(outline).toHaveCount(0)
    await expect(
      page.locator(".cm-line").filter({ hasText: "Target Heading" })
    ).toBeVisible()

    await page.mouse.move(200, 20)
    const sameTabBackButton = page.getByRole("button", { name: "Back" })
    const sameTabForwardButton = page.getByRole("button", { name: "Forward" })
    await expect(sameTabBackButton).toBeEnabled()
    await sameTabBackButton.click()
    await expect(
      page.locator(".cm-line").filter({ hasText: "Intro" })
    ).toBeVisible()
    await expect(sameTabForwardButton).toBeEnabled()
    await sameTabForwardButton.click()
    await expect(
      page.locator(".cm-line").filter({ hasText: "Target Heading" })
    ).toBeVisible()

    await page.keyboard.press(exactH2Shortcut)
    await expect(
      page.locator(".cm-line").filter({ hasText: "Later Heading" })
    ).toBeVisible()
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+ArrowUp")
    } else {
      await page.keyboard.press("Control+Home")
    }
    await page.keyboard.insertText("Inserted before saved locations.\n\n")
    await expect(sameTabBackButton).toBeEnabled()
    await sameTabBackButton.click()
    await expect(
      page.locator(".cm-line").filter({ hasText: "Target Heading" })
    ).toBeVisible()
    await page.keyboard.press(exactH2Shortcut)
    await expect(
      page.locator(".cm-line").filter({ hasText: "Later Heading" })
    ).toBeVisible()

    await page.keyboard.press(previousChord)
    await page.keyboard.press("2")
    await expect(
      page.locator(".cm-line").filter({ hasText: "Target Heading" })
    ).toBeVisible()

    await page.keyboard.press(previousChord)
    await page.keyboard.press("H")
    const jumpLink = page
      .locator(".cm-md-link")
      .filter({ hasText: "Jump to target" })
    await expect(jumpLink).toBeVisible()
    await jumpLink.click({ modifiers: [primary] })
    await expect(
      page.locator(".cm-line").filter({ hasText: "Target Heading" })
    ).toBeVisible()

    await page.keyboard.press(`${primary}+S`)
    await expect(page.getByLabel("Modified")).toHaveCount(0)
    await page.keyboard.press(previousChord)
    await page.keyboard.press("H")
    const localLink = page
      .locator(".cm-md-link")
      .filter({ hasText: "Open linked document" })
    await expect(localLink).toBeVisible()
    const originalTabId = await page
      .locator(".document-tab[data-active]")
      .getAttribute("data-tab-id")
    await expect(localLink).not.toHaveAttribute("role", "link")
    await localLink.click()
    await page.keyboard.press("Shift+F10")
    const linkContextMenu = page.getByRole("menu", {
      name: "Editor context menu",
    })
    await expect(linkContextMenu).toBeVisible()
    await linkContextMenu.getByRole("menuitem", { name: "Open Link" }).click()
    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(
      page.locator(".document-tab[data-active]")
    ).not.toHaveAttribute("data-tab-id", originalTabId ?? "")
    const linkedTabId = await page
      .locator(".document-tab[data-active]")
      .getAttribute("data-tab-id")
    await expect(
      page.locator(".cm-line").filter({ hasText: "Other Section" })
    ).toBeVisible()

    await page.mouse.move(200, 20)
    const backButton = page.getByRole("button", { name: "Back" })
    const forwardButton = page.getByRole("button", { name: "Forward" })
    const formattingButton = page.getByRole("button", {
      name: "Formatting toolbar",
    })
    await expect(backButton).toBeEnabled()
    await expect(forwardButton).toBeDisabled()
    const navigationControlGeometry = await Promise.all([
      backButton.boundingBox(),
      forwardButton.boundingBox(),
      page.locator(".top-chrome-navigation-separator").boundingBox(),
      formattingButton.boundingBox(),
    ])
    const [backBounds, forwardBounds, separatorBounds, formattingBounds] =
      navigationControlGeometry
    if (
      !backBounds ||
      !forwardBounds ||
      !separatorBounds ||
      !formattingBounds
    ) {
      throw new Error("Navigation controls are unavailable")
    }
    expect(backBounds.x + backBounds.width).toBeLessThan(forwardBounds.x)
    expect(forwardBounds.x + forwardBounds.width).toBeLessThan(
      separatorBounds.x
    )
    expect(separatorBounds.x + separatorBounds.width).toBeLessThan(
      formattingBounds.x
    )

    await backButton.click()
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      mainDocument
    )
    await expect(localLink).toBeVisible()
    await expect(forwardButton).toBeEnabled()

    if (process.platform === "darwin") {
      await page.evaluate(() => {
        window.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            button: 4,
            cancelable: true,
          })
        )
      })
    } else {
      await forwardButton.click()
    }
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      linkedDocument
    )
    await expect(
      page.locator(".cm-line").filter({ hasText: "Other Section" })
    ).toBeVisible()

    if (process.platform === "darwin") {
      await page.evaluate(() => {
        window.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            button: 3,
            cancelable: true,
          })
        )
      })
      await expect(activeDocumentTab(page)).toHaveAttribute(
        "aria-label",
        mainDocument
      )
      await forwardButton.click()
      await expect(activeDocumentTab(page)).toHaveAttribute(
        "aria-label",
        linkedDocument
      )
    }

    await backButton.click()
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      mainDocument
    )
    await localLink.click({ button: "right", modifiers: [primary] })
    await expect(linkContextMenu).toBeVisible()
    await expect(linkContextMenu.getByRole("menuitem")).toHaveCount(1)
    await linkContextMenu
      .getByRole("menuitem", { name: "Open in New Tab" })
      .click()
    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      linkedDocument
    )
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      linkedTabId ?? ""
    )

    await page.keyboard.press("Control+1")
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      mainDocument
    )
    await page.keyboard.press("Control+2")
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      linkedDocument
    )
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+1")
      await expect(activeDocumentTab(page)).toHaveAttribute(
        "aria-label",
        mainDocument
      )
      await page.keyboard.press("Meta+2")
      await expect(activeDocumentTab(page)).toHaveAttribute(
        "aria-label",
        linkedDocument
      )
    }
    await page.keyboard.press("Control+Shift+Tab")
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      mainDocument
    )
    await page.keyboard.press("Control+Tab")
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      linkedDocument
    )

    await page.keyboard.press(`${primary}+T`)
    await expect(page.getByRole("tab")).toHaveCount(3)
    const absoluteDestination = `${pathToFileURL(linkedDocument).href}?ignored=1#other-section`
    await page.locator(".cm-content").click()
    await page.keyboard.insertText(`[Open absolute](<${absoluteDestination}>)`)
    await page.keyboard.press("Escape")
    const absoluteLink = page
      .locator(".cm-md-link")
      .filter({ hasText: "Open absolute" })
    await expect(absoluteLink).toBeVisible()
    await absoluteLink.click({ button: "right", modifiers: [primary] })
    await linkContextMenu
      .getByRole("menuitem", { name: "Open in New Tab" })
      .click()
    await expect(page.getByRole("tab")).toHaveCount(3)
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      linkedTabId ?? ""
    )
    await expect(
      page.locator(".cm-line").filter({ hasText: "Other Section" })
    ).toBeVisible()

    for (let index = 0; index < 7; index += 1) {
      await page.keyboard.press(`${primary}+T`)
    }
    await expect(page.getByRole("tab")).toHaveCount(10)
    await page.keyboard.press("Control+1")
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      mainDocument
    )
    await page.keyboard.press("Control+0")
    await expect(page.locator(".document-tab").nth(9)).toHaveAttribute(
      "data-active",
      "true"
    )
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+9")
      await expect(page.locator(".document-tab").nth(8)).toHaveAttribute(
        "data-active",
        "true"
      )
    }

    await page.keyboard.press("Control+1")
    await page.keyboard.press(`${primary}+,`)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    const zoomInput = settings.getByLabel("Zoom percentage")
    await zoomInput.focus()
    await page.keyboard.press(exactH2Shortcut)
    await page.keyboard.press("Control+Shift+Tab")
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+2")
    }
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      mainDocument
    )
    await expect(zoomInput).toBeFocused()

    await settings.getByRole("button", { name: "Extensions" }).click()
    const footnotesToggle = settings.getByRole("switch", {
      name: "Footnotes",
    })
    const expectedFootnotesChecked = !(await footnotesToggle.isChecked())
    await footnotesToggle.click()
    await expect(footnotesToggle).toBeChecked({
      checked: expectedFootnotesChecked,
    })
    const settingsShell = page.locator('[data-slot="dialog-content"]')
    const settingsScroll = settings.locator("[data-settings-dialog-scroll]")
    const shortcutButton = settings.getByRole("button", {
      name: "View keyboard shortcuts",
    })
    await shortcutButton.scrollIntoViewIfNeeded()
    const settingsScrollTop = await settingsScroll.evaluate(
      (element) => element.scrollTop
    )
    expect(settingsScrollTop).toBeGreaterThan(0)
    const settingsShellRect = await settingsShell.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { height: rect.height, top: rect.top, width: rect.width }
    })

    await shortcutButton.click()
    const shortcuts = page.getByRole("dialog", {
      name: "Keyboard Shortcuts",
    })
    await expect(shortcuts).toBeVisible()
    await expect(shortcuts.getByRole("button", { name: "Close" })).toBeVisible()
    await expect(settingsShell).toHaveCount(1)
    const shortcutShellRect = await settingsShell.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { height: rect.height, top: rect.top, width: rect.width }
    })
    expect(
      Math.abs(shortcutShellRect.height - settingsShellRect.height)
    ).toBeLessThan(1)
    expect(
      Math.abs(shortcutShellRect.top - settingsShellRect.top)
    ).toBeLessThan(1)
    expect(
      Math.abs(shortcutShellRect.width - settingsShellRect.width)
    ).toBeLessThan(1)
    const shortcutSearch = shortcuts.getByRole("searchbox", {
      name: "Search keyboard shortcuts",
    })
    const shortcutRows = shortcuts.locator("dl > div")
    await expect(shortcutSearch).toBeFocused()
    const searchTop = await shortcutSearch.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    await expect(shortcuts.getByText("Heading navigation")).toBeVisible()
    await expect(shortcuts.getByText("Files and tabs")).toBeVisible()
    const selectTabShortcut = shortcuts
      .locator("dl > div")
      .filter({ hasText: "Select tab 1–10" })
    await expect(selectTabShortcut).toHaveCount(1)
    await expect(selectTabShortcut.locator("kbd")).toHaveText(
      process.platform === "darwin"
        ? ["⌘", "1–9", "⌃", "1–9", "⌃", "0"]
        : ["Ctrl", "1–9", "Ctrl", "0"]
    )
    await expect
      .poll(() =>
        shortcuts
          .locator("kbd")
          .first()
          .evaluate((element) => getComputedStyle(element).fontSize)
      )
      .toBe("18px")

    await shortcutSearch.pressSequentially("next")
    const broadResultCount = await shortcutRows.count()
    expect(broadResultCount).toBeGreaterThan(1)
    await shortcutSearch.pressSequentially(" tab")
    await expect(shortcutRows).toHaveCount(1)
    await expect(shortcuts.getByRole("status")).toHaveText("1 shortcut found.")
    await expect(shortcuts.getByText("Next tab", { exact: true })).toBeVisible()
    await expect(shortcuts.getByText("Files and tabs")).toBeVisible()
    await expect(shortcuts.getByText("Heading navigation")).toHaveCount(0)
    const filteredSearchTop = await shortcutSearch.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    expect(Math.abs(filteredSearchTop - searchTop)).toBeLessThan(1)

    await shortcutSearch.fill("shortcut that does not exist")
    await expect(shortcutRows).toHaveCount(0)
    await expect(shortcuts.getByRole("status")).toHaveText("0 shortcuts found.")
    await expect(shortcuts.getByText("No matching shortcuts.")).toBeVisible()

    await shortcutSearch.fill("")
    await expect(shortcuts.getByText("Heading navigation")).toBeVisible()
    await expect(shortcuts.getByText("Files and tabs")).toBeVisible()

    await shortcuts.getByRole("button", { name: "Back to Settings" }).click()
    await expect(settings).toBeVisible()
    await expect(shortcutButton).toBeFocused()
    await expect(footnotesToggle).toBeChecked({
      checked: expectedFootnotesChecked,
    })
    await expect
      .poll(async () => {
        const restoredScrollTop = await settingsScroll.evaluate(
          (element) => element.scrollTop
        )
        return Math.abs(restoredScrollTop - settingsScrollTop)
      })
      .toBeLessThan(1)

    await shortcutButton.click()
    await expect(shortcutSearch).toBeFocused()
    await expect(shortcutSearch).toHaveValue("")
    await page.keyboard.press("Escape")
    await expect(settings).toBeVisible()
    await expect(shortcutButton).toBeFocused()
    await expect(shortcuts).toHaveCount(0)
    await expect(footnotesToggle).toBeChecked({
      checked: expectedFootnotesChecked,
    })
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("queued local links open each destination and retain their shared origin @renderer-isolated", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-link-queue-")
  )
  const sourceDocumentPath = path.join(testDirectory, "source.md")
  const firstDocumentPath = path.join(testDirectory, "first.md")
  const secondDocumentPath = path.join(testDirectory, "second.md")
  const beforeLinks = Array.from(
    { length: 100 },
    (_, index) => `Before links ${index + 1}`
  ).join("\n\n")
  const sourceDocument = [
    "# Source",
    "",
    beforeLinks,
    "",
    "[Open first](first.md)",
    "[Open second](second.md)",
    "",
    "Selection anchor",
    "",
  ].join("\n")
  await Promise.all([
    writeFile(sourceDocumentPath, sourceDocument),
    writeFile(firstDocumentPath, "# First queued destination\n"),
    writeFile(secondDocumentPath, "# Second queued destination\n"),
  ])

  const userData = await createTestUserData()
  const app = await launchApplication(userData, sourceDocumentPath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await expect(content).toBeFocused()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End"
    )

    const firstLink = page
      .locator(".cm-md-link")
      .filter({ hasText: "Open first" })
    await firstLink.scrollIntoViewIfNeeded()
    await expect(firstLink).toBeVisible()
    await expect(
      page.locator(".cm-md-link").filter({ hasText: "Open second" })
    ).toBeVisible()

    await page.evaluate(
      ({ mac }) => {
        const links = [...document.querySelectorAll<HTMLElement>(".cm-md-link")]
        const first = links.find((link) => link.textContent === "Open first")
        const second = links.find((link) => link.textContent === "Open second")
        if (!first || !second)
          throw new Error("Queued link fixtures are missing")

        const activate = (link: HTMLElement) => {
          const bounds = link.getBoundingClientRect()
          link.dispatchEvent(
            new MouseEvent("mousedown", {
              bubbles: true,
              button: 0,
              buttons: 1,
              cancelable: true,
              clientX: bounds.left + bounds.width / 2,
              clientY: bounds.top + bounds.height / 2,
              ctrlKey: !mac,
              metaKey: mac,
              view: window,
            })
          )
        }

        activate(first)
        activate(second)
      },
      { mac: process.platform === "darwin" }
    )

    await expect(page.getByRole("tab")).toHaveCount(3)
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      secondDocumentPath
    )
    await expect(content).toContainText("Second queued destination")

    await page.mouse.move(200, 20)
    const backButton = page.getByRole("button", { name: "Back" })
    await backButton.click()
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      sourceDocumentPath
    )
    await expect(firstLink).toBeVisible()
    const expectedLine = sourceDocument.split("\n").length
    await expect(page.getByLabel("Document status")).toContainText(
      `Ln ${expectedLine}, Col 1`
    )

    await page.getByRole("tab", { name: firstDocumentPath }).click()
    await expect(content).toContainText("First queued destination")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("local link navigation preserves and later saves its dirty source tab @renderer-isolated", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-link-dirty-")
  )
  const sourceDocumentPath = path.join(testDirectory, "source.md")
  const destinationDocumentPath = path.join(testDirectory, "destination.md")
  const sourceDocument = [
    "# Source",
    "",
    "[Open destination](destination.md)",
    "",
  ].join("\n")
  await Promise.all([
    writeFile(sourceDocumentPath, sourceDocument),
    writeFile(destinationDocumentPath, "# Destination\n"),
  ])

  const userData = await createTestUserData()
  const app = await launchApplication(userData, sourceDocumentPath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const link = page
      .locator(".cm-md-link")
      .filter({ hasText: "Open destination" })
    await content.waitFor()

    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        linkNavigationPrompts?: number
      }
      testGlobal.linkNavigationPrompts = 0
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title === "Unsaved Changes") {
          testGlobal.linkNavigationPrompts =
            (testGlobal.linkNavigationPrompts ?? 0) + 1
        }
        return { checkboxChecked: false, response: 2 }
      }) as typeof dialog.showMessageBox
    })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End"
    )
    await page.keyboard.insertText("Unsaved source content\n")
    await page.keyboard.press("Escape")
    await link.click({ modifiers: [primary] })
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      destinationDocumentPath
    )
    await expect(content).toContainText("Destination")
    expect(await readFile(sourceDocumentPath, "utf8")).toBe(sourceDocument)
    await expect(page.getByRole("tab")).toHaveCount(2)
    expect(
      await app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              linkNavigationPrompts?: number
            }
          ).linkNavigationPrompts ?? 0
      )
    ).toBe(0)

    await page.mouse.move(200, 20)
    await page.getByRole("button", { name: "Back" }).click()
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      `${sourceDocumentPath}, modified`
    )
    await expect(content).toContainText("Unsaved source content")
    await expect(page.getByLabel("Modified")).toBeVisible()

    await page.keyboard.press(`${primary}+S`)
    await expect
      .poll(() => readFile(sourceDocumentPath, "utf8"))
      .toContain("Unsaved source content")
    await link.click({ modifiers: [primary] })
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      destinationDocumentPath
    )
    await expect(page.getByRole("tab")).toHaveCount(2)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("an ordinary untitled tab keeps its source when following an absolute link @renderer-isolated", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-untitled-link-")
  )
  const destinationDocumentPath = path.join(testDirectory, "destination.md")
  await writeFile(destinationDocumentPath, "# Untitled destination\n")
  const userData = await createTestUserData()
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    await content.waitFor()
    const originalTabId = await page
      .locator(".document-tab[data-active]")
      .getAttribute("data-tab-id")

    await content.click()
    await page.keyboard.insertText(
      `[Open absolute](<${pathToFileURL(destinationDocumentPath).href}>)`
    )
    await page.keyboard.press("Escape")
    await page
      .locator(".cm-md-link")
      .filter({ hasText: "Open absolute" })
      .click({ modifiers: [primary] })

    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(
      page.locator(".document-tab[data-active]")
    ).not.toHaveAttribute("data-tab-id", originalTabId ?? "")
    await expect(activeDocumentTab(page)).toHaveAttribute(
      "aria-label",
      destinationDocumentPath
    )
    await expect(content).toContainText("Untitled destination")
    await page.mouse.move(200, 20)
    const backButton = page.getByRole("button", { name: "Back" })
    await expect(backButton).toBeEnabled()
    await backButton.click()
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      originalTabId ?? ""
    )
    await expect(content).toContainText("Open absolute")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("Tab edits the active document and source indentation is configurable @renderer-isolated", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-tab-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    [
      "alpha",
      "",
      "- [ ] First task",
      "- [ ] Second task",
      "",
      "[Web](https://example.com)",
    ].join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const modeShortcut =
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    const documentEnd =
      process.platform === "darwin" ? "Meta+End" : "Control+End"
    const settingsShortcut =
      process.platform === "darwin" ? "Meta+," : "Control+,"

    await editor.waitFor()
    await clickVisibleText(page, page.locator(".cm-line").first())
    await page.keyboard.press("End")
    await page.keyboard.press("Tab")
    await page.keyboard.type("live")
    await expect(content).toBeFocused()
    await expect(page.locator(".cm-md-task-checkbox:focus")).toHaveCount(0)

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)
    expect(await page.locator(".cm-line").first().textContent()).toBe(
      "alpha\tlive"
    )

    await page.keyboard.press(documentEnd)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")
    await page.keyboard.type("default")
    expect((await page.locator(".cm-line").allTextContents()).at(-1)).toBe(
      "  default"
    )

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-live/)
    const checkboxes = page.locator(".cm-md-task-checkbox")
    await expect(checkboxes).toHaveCount(2)
    await checkboxes.first().focus()
    await page.keyboard.press("Tab")
    await expect(checkboxes.nth(1)).toBeFocused()

    await clickVisibleText(
      page,
      page.locator(".cm-line").filter({ hasText: "default" })
    )
    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await page.getByLabel("Spaces per Tab").fill("4")
    await settingsSaveButton(page).click()
    await expect(content).toBeFocused()

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)
    await page.keyboard.press(documentEnd)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Tab")
    await page.keyboard.type("custom")
    expect((await page.locator(".cm-line").allTextContents()).at(-1)).toBe(
      "    custom"
    )

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await chooseSettingsOption(page, "Raw Markdown Tab key", "Tab Character")
    await expect(page.getByLabel("Spaces per Tab")).toBeDisabled()
    await settingsSaveButton(page).click()
    await expect(content).toBeFocused()

    await page.keyboard.press(documentEnd)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Tab")
    await page.keyboard.type("tab")
    expect((await page.locator(".cm-line").allTextContents()).at(-1)).toBe(
      "\ttab"
    )
    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({
        sourceIndentation: "tabs",
        sourceIndentSize: 4,
      })
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("live Markdown renders nested quotes and foldable callout cards", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-callouts-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    [
      "> [!question]+ 1. Multiple Choice",
      "> Which option is correct?",
      "> > [!answer]- Answer details",
      "> > b) ATP production",
      "> > > [!deeper]- Deep detail",
      "> > > Nested callout body",
      "",
      "> [!tip]+ Initially expanded",
      "> Expanded body marker",
      "",
      "> [!warning]- Initially collapsed",
      "> Collapsed body marker",
      "",
      "> [!literallyanything] Authored custom title",
      "> Custom body marker",
      "",
      "> Outer quote",
      "> > Inner quote",
      "> > > Deepest quote",
      "",
    ].join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.locator(".cm-editor").waitFor()
    const content = page.locator(".cm-content")
    await expect(content).toBeFocused()
    const selectedMarkdownSource = () =>
      content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  doc: { sliceString(from: number, to: number): string }
                  selection: { main: { from: number; to: number } }
                }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const { from, to } = view.state.selection.main
        return view.state.doc.sliceString(from, to)
      })
    const questionSource = [
      "> [!question]+ 1. Multiple Choice",
      "> Which option is correct?",
      "> > [!answer]- Answer details",
      "> > b) ATP production",
      "> > > [!deeper]- Deep detail",
      "> > > Nested callout body",
    ].join("\n")
    const deeperSource = [
      "> > > [!deeper]- Deep detail",
      "> > > Nested callout body",
    ].join("\n")
    const expandedSource = [
      "> [!tip]+ Initially expanded",
      "> Expanded body marker",
    ].join("\n")
    const customSource = [
      "> [!literallyanything] Authored custom title",
      "> Custom body marker",
    ].join("\n")

    const question = page.locator(
      '.cm-md-callout[data-callout-type="question"]'
    )
    const answer = page.locator('.cm-md-callout[data-callout-type="answer"]')
    const deeper = page.locator('.cm-md-callout[data-callout-type="deeper"]')
    await expect(question).toHaveCount(1)
    await expect(answer).toHaveCount(1)
    await expect(deeper).toHaveCount(0)
    await expect(question).toHaveAttribute("data-callout-depth", "1")
    await expect(answer).toHaveAttribute("data-callout-depth", "2")
    await expect(question).toHaveAttribute(
      "aria-label",
      "1. Multiple Choice callout"
    )
    await expect(question).toHaveAttribute("role", "note")

    const answerToggle = answer.locator(".cm-md-callout-toggle").first()
    await expect(answerToggle).toHaveAttribute("aria-expanded", "false")
    await answerToggle.click()
    await expect(answerToggle).toHaveAttribute("aria-expanded", "true")
    await expect(deeper).toHaveCount(1)
    await waitForSubtreeAnimations(answer)
    await expect(deeper).toHaveAttribute("data-callout-depth", "3")
    await expect(deeper.locator(".cm-md-callout-toggle")).toHaveAttribute(
      "aria-expanded",
      "false"
    )

    const nestedStructure = await page.evaluate(() => {
      const question = document.querySelector<HTMLElement>(
        '.cm-md-callout[data-callout-type="question"]'
      )
      const answer = document.querySelector<HTMLElement>(
        '.cm-md-callout[data-callout-type="answer"]'
      )
      const deeper = document.querySelector<HTMLElement>(
        '.cm-md-callout[data-callout-type="deeper"]'
      )
      const quotes = [
        ...document.querySelectorAll<HTMLElement>(
          "blockquote.cm-md-quote-block"
        ),
      ]
      if (!question || !answer || !deeper || quotes.length !== 3)
        throw new Error("Nested quote structure is unavailable")

      const hasRail = (element: HTMLElement) =>
        Number.parseFloat(getComputedStyle(element).borderInlineStartWidth) > 0
      const answerBody = answer.querySelector<HTMLElement>(
        ":scope > .cm-md-callout-body > .cm-line"
      )
      if (!answerBody) throw new Error("Nested callout body is unavailable")
      const gaps = [
        ...document.querySelectorAll<HTMLElement>(".cm-md-callout-gap"),
      ]
      const deeperGap = deeper.parentElement
      if (!deeperGap?.classList.contains("cm-md-callout-gap")) {
        throw new Error("Nested callout spacing wrapper is unavailable")
      }
      const answerStyle = getComputedStyle(answer)
      const deeperStyle = getComputedStyle(deeper)
      const deeperRect = deeper.getBoundingClientRect()
      const answerBodyRect = answerBody.getBoundingClientRect()
      const answerBodyStyle = getComputedStyle(answerBody)

      return {
        calloutTags: [question.tagName, answer.tagName, deeper.tagName],
        calloutsAreNested: question.contains(answer) && answer.contains(deeper),
        calloutsHaveRails: [question, answer, deeper].some(hasRail),
        calloutGapDepths: gaps.map((gap) => gap.dataset.calloutGapDepth),
        calloutGapsContainCards: gaps.every((gap) =>
          gap.firstElementChild?.classList.contains("cm-md-callout")
        ),
        nestedPalettes: [
          answer.dataset.calloutPalette,
          deeper.dataset.calloutPalette,
        ],
        nestedOutlines: {
          mixedPalette: {
            style: answerStyle.outlineStyle,
            width: answerStyle.outlineWidth,
          },
          samePalette: {
            style: deeperStyle.outlineStyle,
            width: deeperStyle.outlineWidth,
          },
        },
        nestedOuterGap: deeperRect.top - answerBodyRect.bottom,
        parentLineHeight: Number.parseFloat(answerBodyStyle.lineHeight),
        quoteTags: quotes.map((quote) => quote.tagName),
        quoteDepths: quotes.map((quote) => quote.dataset.quoteDepth),
        quotesAreNested:
          quotes[0]!.contains(quotes[1]!) && quotes[1]!.contains(quotes[2]!),
        quotesHaveRails: quotes.every(hasRail),
      }
    })
    expect(nestedStructure).toMatchObject({
      calloutTags: ["DIV", "DIV", "DIV"],
      calloutsAreNested: true,
      calloutsHaveRails: false,
      calloutGapDepths: ["2", "3"],
      calloutGapsContainCards: true,
      nestedPalettes: ["info", "info"],
      nestedOutlines: {
        mixedPalette: { style: "none" },
        samePalette: { style: "none" },
      },
      quoteTags: ["BLOCKQUOTE", "BLOCKQUOTE", "BLOCKQUOTE"],
      quoteDepths: ["1", "2", "3"],
      quotesAreNested: true,
      quotesHaveRails: true,
    })
    expect(nestedStructure.nestedOuterGap).toBeGreaterThanOrEqual(
      nestedStructure.parentLineHeight - 0.5
    )

    const deeperToggle = deeper.locator(".cm-md-callout-toggle")
    await expect(page.locator(".cm-content")).not.toContainText(
      "Nested callout body"
    )
    await deeperToggle.click()
    await expect(deeperToggle).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(".cm-content")).toContainText(
      "Nested callout body"
    )
    await waitForSubtreeAnimations(deeper)

    const deeperBody = page.locator(".cm-line").filter({
      hasText: "Nested callout body",
    })
    await page.bringToFront()
    await clickVisibleText(page, deeperBody)
    await expect(question).toHaveCount(1)
    await expect(answer).toHaveCount(1)
    await expect(deeper).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText(
      "> > > [!deeper]- Deep detail"
    )
    await expect(
      question.locator(":scope > .cm-line").first()
    ).not.toContainText(">")
    await expect(answer.locator(":scope > .cm-line").first()).not.toContainText(
      ">"
    )
    await expect.poll(selectedMarkdownSource).toBe(deeperSource)

    // Moving focus to an embedded disclosure restores the rendered callout;
    // the prior text selection must not leave an unrelated raw block behind.
    await answerToggle.focus()
    await expect(answerToggle).toBeFocused()
    await expect(deeper).toHaveCount(1)
    await expect(deeperToggle).toHaveAttribute("aria-expanded", "true")

    const questionBody = page.locator(".cm-line").filter({
      hasText: "Which option is correct?",
    })
    await page.bringToFront()
    await clickVisibleText(page, questionBody)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-focused/)
    await expect(question).toHaveCount(0)
    await expect(answer).toHaveCount(0)
    await expect(deeper).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText(
      "> [!question]+ 1. Multiple Choice"
    )
    await expect.poll(selectedMarkdownSource).toBe(questionSource)

    const outerQuoteLine = page.locator(".cm-line").filter({
      hasText: "Outer quote",
    })
    await clickVisibleText(page, outerQuoteLine)
    await expect(question).toHaveCount(1)
    await expect(answer).toHaveCount(1)
    await expect(deeper).toHaveCount(1)
    expect(await cursorLineText(page)).toContain("Outer quote")

    const custom = page.locator(
      '.cm-md-callout[data-callout-type="literallyanything"]'
    )
    await expect(custom).toHaveCount(1)
    await expect(custom).toHaveClass(/cm-md-callout-info/)
    await expect(custom).toHaveAttribute(
      "aria-label",
      "Authored custom title callout"
    )
    await expect(custom.locator(".cm-md-callout-title")).toHaveText(
      "Authored custom title"
    )
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveClass(/light/)
    const calloutAppearance = await page.evaluate(() => {
      const categories = [
        "info",
        "abstract",
        "tip",
        "success",
        "todo",
        "question",
        "warning",
        "danger",
        "failure",
        "bug",
        "important",
        "example",
        "quote",
      ] as const
      const palettes = {
        abstract: "info",
        bug: "danger",
        danger: "danger",
        example: "example",
        failure: "danger",
        important: "example",
        info: "info",
        question: "quote",
        quote: "quote",
        success: "success",
        tip: "tip",
        todo: "success",
        warning: "danger",
      } as const
      const callout = document.querySelector<HTMLElement>(
        '.cm-md-callout[data-callout-type="literallyanything"]'
      )
      if (!callout) throw new Error("Missing sample callout")

      const backgrounds: Record<string, string> = {}
      const titleColors: Record<string, string> = {}
      const title = callout.querySelector<HTMLElement>(".cm-md-callout-title")
      if (!title) throw new Error("Missing sample callout title")
      for (const category of categories) {
        for (const candidate of categories) {
          callout.classList.remove(`cm-md-callout-${candidate}`)
          callout.classList.remove(
            `cm-md-callout-palette-${palettes[candidate]}`
          )
        }
        callout.classList.add(`cm-md-callout-${category}`)
        callout.classList.add(`cm-md-callout-palette-${palettes[category]}`)
        backgrounds[category] = getComputedStyle(callout).backgroundColor
        titleColors[category] = getComputedStyle(title).color
      }
      callout.classList.remove("cm-md-callout-quote")
      callout.classList.remove("cm-md-callout-palette-quote")
      callout.classList.add("cm-md-callout-info")
      callout.classList.add("cm-md-callout-palette-info")

      const style = getComputedStyle(callout)
      const titleStyle = getComputedStyle(title)

      return {
        backgrounds,
        borderWidths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        color: style.color,
        titleColors,
        titleFontRatio:
          Number.parseFloat(titleStyle.fontSize) /
          Number.parseFloat(style.fontSize),
        titleTextTransform: titleStyle.textTransform,
      }
    })
    expect(new Set(Object.values(calloutAppearance.backgrounds)).size).toBe(1)
    expect(new Set(Object.values(calloutAppearance.titleColors)).size).toBe(6)
    expect(calloutAppearance.titleColors).toMatchObject({
      abstract: calloutAppearance.titleColors.info,
      todo: calloutAppearance.titleColors.success,
      question: calloutAppearance.titleColors.quote,
      warning: calloutAppearance.titleColors.danger,
      failure: calloutAppearance.titleColors.danger,
      bug: calloutAppearance.titleColors.danger,
      important: calloutAppearance.titleColors.example,
    })
    const expectedCalloutColor = await page.evaluate(() => {
      const sample = document.createElement("span")
      sample.style.color = "var(--document-foreground)"
      document.body.append(sample)
      const color = getComputedStyle(sample).color
      sample.remove()
      return color
    })
    expect(calloutAppearance).toMatchObject({
      borderWidths: ["0px", "0px", "0px", "0px"],
      color: expectedCalloutColor,
      titleTextTransform: "uppercase",
    })
    expect(calloutAppearance.titleFontRatio).toBeCloseTo(1, 4)

    const lightCalloutSurface = Object.values(calloutAppearance.backgrounds)[0]
    const lightInfoLabel = calloutAppearance.titleColors.info
    expect(lightInfoLabel).toBe("rgb(0, 0, 255)")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    const darkCalloutAppearance = await custom.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      label: getComputedStyle(
        element.querySelector<HTMLElement>(".cm-md-callout-title")!
      ).color,
    }))
    expect(darkCalloutAppearance.background).not.toBe(lightCalloutSurface)
    expect(darkCalloutAppearance.label).toBe("rgb(97, 175, 239)")
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveClass(/light/)
    const calloutAlignment = await page.evaluate(() => {
      const offsets = (selector: string) => {
        const callout = document.querySelector<HTMLElement>(selector)
        const title = callout?.querySelector<HTMLElement>(
          ".cm-md-callout-title"
        )
        const body =
          callout?.querySelector<HTMLElement>(
            ":scope > .cm-md-callout-body > .cm-line"
          ) ?? callout?.querySelectorAll<HTMLElement>(":scope > .cm-line")[1]
        if (!callout || !title || !body)
          throw new Error(`Callout geometry is unavailable for ${selector}`)
        const left = callout.getBoundingClientRect().left
        return {
          body: body.getBoundingClientRect().left - left,
          title: title.getBoundingClientRect().left - left,
          titleTop:
            title.getBoundingClientRect().top -
            callout.getBoundingClientRect().top,
        }
      }
      return {
        nested: offsets('[data-callout-type="deeper"]'),
        regular: offsets('[data-callout-type="literallyanything"]'),
      }
    })
    expect(
      Math.abs(calloutAlignment.nested.title - calloutAlignment.regular.title)
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(calloutAlignment.nested.body - calloutAlignment.regular.body)
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(calloutAlignment.nested.title - calloutAlignment.nested.body)
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(calloutAlignment.regular.title - calloutAlignment.regular.body)
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(
        calloutAlignment.nested.titleTop - calloutAlignment.regular.titleTop
      )
    ).toBeLessThanOrEqual(0.5)

    await custom.locator(".cm-md-callout-header").click()
    await expect(custom).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText(
      "> [!literallyanything] Authored custom title"
    )
    await expect.poll(selectedMarkdownSource).toBe(customSource)
    await clickVisibleText(page, outerQuoteLine)
    await expect(custom).toHaveCount(1)

    const expanded = page.locator('.cm-md-callout[data-callout-type="tip"]')
    const expandedToggle = expanded.locator(".cm-md-callout-toggle")
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(".cm-content")).toContainText(
      "Expanded body marker"
    )
    await waitForSubtreeAnimations(expanded)
    const toggleBackground = await expandedToggle.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    await expanded.locator(".cm-md-callout-title").hover()
    await expect(expandedToggle).toHaveCSS("cursor", "default")
    expect(
      await expandedToggle.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      )
    ).toBe(toggleBackground)
    const expandedChevronGeometry = await expanded
      .locator(".cm-md-callout-chevron")
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          centerX: (rect.left + rect.right) / 2,
          centerY: (rect.top + rect.bottom) / 2,
          height: rect.height,
          width: rect.width,
        }
      })

    await expandedToggle.focus()
    await page.keyboard.press("Space")
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "false")
    const collapseChevronAnimated = await expanded
      .locator(".cm-md-callout-chevron")
      .evaluate((element) =>
        element
          .getAnimations()
          .some((animation) =>
            (animation.effect as KeyframeEffect | null)
              ?.getKeyframes()
              .some((keyframe) => keyframe.transform != null)
          )
      )
    expect(collapseChevronAnimated).toBe(true)
    const bodyTransitionUsesHeight = await expanded
      .locator(".cm-md-callout-body")
      .evaluate((element) =>
        element
          .getAnimations()
          .some((animation) =>
            (animation.effect as KeyframeEffect | null)
              ?.getKeyframes()
              .some((keyframe) => keyframe.height != null)
          )
      )
    expect(bodyTransitionUsesHeight).toBe(true)
    await expanded.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined))
      )
    })
    const collapsedChevronGeometry = await expanded
      .locator(".cm-md-callout-chevron")
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          centerX: (rect.left + rect.right) / 2,
          centerY: (rect.top + rect.bottom) / 2,
          height: rect.height,
          width: rect.width,
        }
      })
    for (const key of ["centerX", "centerY", "height", "width"] as const) {
      expect(
        Math.abs(expandedChevronGeometry[key] - collapsedChevronGeometry[key])
      ).toBeLessThanOrEqual(0.5)
    }
    await expect(page.locator(".cm-content")).not.toContainText(
      "Expanded body marker"
    )
    await expanded.locator(".cm-md-callout-title").click()
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true")
    const expansionChevronAnimated = await expanded
      .locator(".cm-md-callout-chevron")
      .evaluate((element) =>
        element
          .getAnimations()
          .some((animation) =>
            (animation.effect as KeyframeEffect | null)
              ?.getKeyframes()
              .some((keyframe) => keyframe.transform != null)
          )
      )
    expect(expansionChevronAnimated).toBe(true)
    await expect(page.locator(".cm-content")).toContainText(
      "Expanded body marker"
    )
    await waitForSubtreeAnimations(expanded)

    const expandedTopLeft = await expanded.evaluate((element) => {
      const card = element.getBoundingClientRect()
      return { x: card.left + 1, y: card.top + 0.5 }
    })
    await page.mouse.click(expandedTopLeft.x, expandedTopLeft.y)
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(".cm-content")).not.toContainText(
      "Expanded body marker"
    )

    const collapsedBottomRight = await expanded.evaluate((element) => {
      const card = element.getBoundingClientRect()
      return { x: card.right - 0.5, y: card.bottom - 0.5 }
    })
    await page.mouse.click(collapsedBottomRight.x, collapsedBottomRight.y)
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(".cm-content")).toContainText(
      "Expanded body marker"
    )
    await waitForSubtreeAnimations(expanded)

    const expandedBottomRight = await expanded.evaluate((element) => {
      const card = element.getBoundingClientRect()
      const toggle = element
        .querySelector<HTMLElement>(".cm-md-callout-toggle")
        ?.getBoundingClientRect()
      const body = element
        .querySelector<HTMLElement>(":scope > .cm-md-callout-body > .cm-line")
        ?.getBoundingClientRect()
      if (!toggle || !body)
        throw new Error("Expanded callout geometry is unavailable")
      return {
        bodyTop: body.top,
        toggleBottom: toggle.bottom,
        x: card.right - 0.5,
        y: (toggle.bottom + body.top) / 2,
      }
    })
    expect(expandedBottomRight.y).toBeGreaterThan(
      expandedBottomRight.toggleBottom
    )
    expect(expandedBottomRight.y).toBeLessThan(expandedBottomRight.bodyTop)
    await page.mouse.click(expandedBottomRight.x, expandedBottomRight.y)
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "false")
    await waitForSubtreeAnimations(expanded)

    const collapsedBottomLeft = await expanded.evaluate((element) => {
      const card = element.getBoundingClientRect()
      return { x: card.left + 1, y: card.bottom - 0.5 }
    })
    await page.mouse.click(collapsedBottomLeft.x, collapsedBottomLeft.y)
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(".cm-content")).toContainText(
      "Expanded body marker"
    )
    await waitForSubtreeAnimations(expanded)

    await clickVisibleText(
      page,
      page.locator(".cm-line").filter({ hasText: "Expanded body marker" })
    )
    await expect(expanded).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText(
      "> [!tip]+ Initially expanded"
    )
    await expect.poll(selectedMarkdownSource).toBe(expandedSource)
    await clickVisibleText(page, outerQuoteLine)
    await expect(expanded).toHaveCount(1)
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true")

    const collapsed = page.locator(
      '.cm-md-callout[data-callout-type="warning"]'
    )
    const collapsedToggle = collapsed.locator(".cm-md-callout-toggle")
    await expect(collapsedToggle).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(".cm-content")).not.toContainText(
      "Collapsed body marker"
    )

    const modeShortcut =
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    await clickVisibleText(page, questionBody)
    await expect(question).toHaveCount(0)
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-content")).toContainText(
      "[!question]+ 1. Multiple Choice"
    )
    await expect(page.locator(".cm-md-callout")).toHaveCount(0)
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await expect(question).toHaveCount(0)
    await expect.poll(selectedMarkdownSource).toBe(questionSource)

    // The always-present focus state must also survive presentation changes
    // when a non-text surface, rather than the editor content, owns focus.
    await expandedToggle.focus()
    await expect(expandedToggle).toBeFocused()
    await expect(question).toHaveCount(1)
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await expect(question).toHaveCount(1)
    await collapsedToggle.click()
    await expect(collapsedToggle).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(".cm-content")).toContainText(
      "Collapsed body marker"
    )
    await collapsedToggle.click()
    await expect(collapsedToggle).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(".cm-content")).not.toContainText(
      "Collapsed body marker"
    )
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("the native reopen command restores a closed tab to its original window", async () => {
  const userData = await createTestUserData()
  const documentPath = path.join(userData, "reopen-scroll.md")
  await writeFile(
    documentPath,
    Array.from(
      { length: 1_000 },
      (_, index) => `Reopen line ${String(index + 1).padStart(4, "0")}`
    ).join("\n")
  )
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const tabs = page.getByRole("tablist", { name: "Open documents" })
    const primary = process.platform === "darwin" ? "Meta" : "Control"

    const initialMenuItem = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "reopen-closed-document"
      )
      return item
        ? { accelerator: item.accelerator, enabled: item.enabled }
        : null
    })
    expect(initialMenuItem).toEqual({
      accelerator: "CmdOrCtrl+Shift+T",
      enabled: false,
    })

    await page.keyboard.press(`${primary}+T`)
    await expect(tabs.getByRole("tab")).toHaveCount(2)
    await page.keyboard.press("Control+1")
    await expect(page.locator(".cm-content")).toContainText("Reopen line 0001")
    const scroller = page.locator(".cm-scroller")
    await scroller.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.58
      element.dispatchEvent(new Event("scroll"))
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const closedAnchor = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")
      if (!scroller) throw new Error("The editor scroller is unavailable")
      const bounds = scroller.getBoundingClientRect()
      const center = bounds.top + bounds.height / 2
      const anchor = [...document.querySelectorAll<HTMLElement>(".cm-line")]
        .map((line) => ({
          distance: Math.abs(
            line.getBoundingClientRect().top +
              line.getBoundingClientRect().height / 2 -
              center
          ),
          line,
        }))
        .sort((left, right) => left.distance - right.distance)[0]
      if (!anchor) throw new Error("The viewport anchor is unavailable")
      return {
        text: anchor.line.textContent,
        top: anchor.line.getBoundingClientRect().top - bounds.top,
      }
    })
    await page.keyboard.press(`${primary}+W`)
    await expect(tabs.getByRole("tab")).toHaveCount(1)
    await expect(page.locator(".cm-content")).not.toContainText(
      "Reopen line 0001"
    )
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()?.getMenuItemById("reopen-closed-document")
              ?.enabled
        )
      )
      .toBe(true)

    // Playwright and webContents.sendInputEvent inject renderer events rather
    // than native menu accelerators, so exercise the asserted menu callback.
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "reopen-closed-document"
      )
      if (!item)
        throw new Error("Reopen Closed Document menu item was not found")
      item.click()
    })

    await expect(tabs.getByRole("tab")).toHaveCount(2)
    await expect(page.locator(".cm-content")).toContainText("Reopen line 0001")
    await expect
      .poll(() =>
        page.evaluate((anchorText) => {
          const scroller = document.querySelector<HTMLElement>(".cm-scroller")
          const anchor = [
            ...document.querySelectorAll<HTMLElement>(".cm-line"),
          ].find((line) => line.textContent === anchorText)
          return scroller && anchor
            ? anchor.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top
            : null
        }, closedAnchor.text)
      )
      .toBeCloseTo(closedAnchor.top, 0)
    expect(app.windows()).toHaveLength(1)
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()?.getMenuItemById("reopen-closed-document")
              ?.enabled
        )
      )
      .toBe(false)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("the native reopen command creates a window after the original window closes", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)

  try {
    const firstWindow = await app.firstWindow()
    await firstWindow.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "New Window")
      const window =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!item || !window) throw new Error("New Window is unavailable")
      item.click(undefined, window, window.webContents)
    })
    await expect.poll(() => app.windows().length).toBe(2)
    const windows = app.windows()
    await Promise.all(
      windows.map((page) => page.locator(".cm-editor").waitFor())
    )

    let closedPage: Page | undefined
    let remainingPage: Page | undefined
    for (const page of windows) {
      const content = await page.locator(".cm-content").innerText()
      if (content.includes("A quiet Markdown window")) closedPage = page
      if (!content.includes("A quiet Markdown window")) remainingPage = page
    }
    if (!closedPage || !remainingPage)
      throw new Error("The source and keep-alive windows were not created")

    const initialMenuItem = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "reopen-closed-document"
      )
      return item
        ? { accelerator: item.accelerator, enabled: item.enabled }
        : null
    })
    expect(initialMenuItem).toEqual({
      accelerator: "CmdOrCtrl+Shift+T",
      enabled: false,
    })

    const closeMarker = `reopen-test-${process.pid}`
    await closedPage.evaluate((title) => {
      document.title = title
    }, closeMarker)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, title) =>
            BrowserWindow.getAllWindows().some(
              (window) => window.getTitle() === title
            ),
          closeMarker
        )
      )
      .toBe(true)

    const closed = closedPage.waitForEvent("close")
    await app.evaluate(({ BrowserWindow }, title) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === title
      )
      if (!window) throw new Error("Document window was not found")
      window.close()
    }, closeMarker)
    await closed

    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()?.getMenuItemById("reopen-closed-document")
              ?.enabled
        )
      )
      .toBe(true)

    const reopenedWindow = app.waitForEvent("window")
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "reopen-closed-document"
      )
      if (!item)
        throw new Error("Reopen Closed Document menu item was not found")
      item.click()
    })

    const reopenedPage = await reopenedWindow
    await reopenedPage.locator(".cm-editor").waitFor()
    await expect(reopenedPage.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) =>
            Menu.getApplicationMenu()?.getMenuItemById("reopen-closed-document")
              ?.enabled
        )
      )
      .toBe(false)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("mode switching anchors the current cursor or viewport passage", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-scroll-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    Array.from(
      { length: 180 },
      (_, index) =>
        `## Section ${String(index + 1).padStart(3, "0")}\n\n` +
        `Paragraph ${String(index + 1).padStart(3, "0")} with **bold words** and enough text to wrap naturally across the reading measure.\n`
    ).join("\n")
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    await editor.waitFor()
    await expect(content).toBeFocused()
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    const scroller = page.locator(".cm-scroller")
    const waitForScrollToSettle = async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const before = await scroller.evaluate((element) => element.scrollTop)
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              )
            )
        )
        const after = await scroller.evaluate((element) => element.scrollTop)
        if (Math.abs(after - before) <= 0.5) return
      }
    }
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.58
      element.dispatchEvent(new Event("scroll"))
    })
    await waitForScrollToSettle()

    const centerSection = () =>
      page.evaluate(() => {
        for (let offset = 0; offset <= 100; offset += 10) {
          for (const direction of offset === 0 ? [0] : [-1, 1]) {
            const elements = document.elementsFromPoint(
              innerWidth / 2,
              innerHeight / 2 + offset * direction
            )
            const text = elements
              .map((element) => element.closest(".cm-line")?.textContent ?? "")
              .find((line) => /Section \d+/.test(line))
            const section = text?.match(/Section \d+/)?.[0]
            if (section) return section
          }
        }
        return null
      })

    const passageBefore = await centerSection()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await waitForScrollToSettle()
    expect(await centerSection()).toBe(passageBefore)

    // A physical scroll gesture must immediately take ownership from any
    // queued restoration work created by the mode change.
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await scroller.hover()
    const beforeWheel = await scroller.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 420)
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeWheel + 20)
    const afterWheel = await scroller.evaluate((element) => element.scrollTop)
    const postGestureSamples = await scroller.evaluate(async (element) => {
      const samples: number[] = []
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
        samples.push(element.scrollTop)
      }
      return samples
    })
    expect(Math.min(...postGestureSamples)).toBeGreaterThanOrEqual(
      afterWheel - 2
    )

    if (!passageBefore) {
      throw new Error("No passage found near the viewport center")
    }
    await page.bringToFront()
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()
    const cursorPassage = await centerSection()
    if (!cursorPassage) {
      throw new Error("No mounted passage found after the wheel gesture")
    }
    const anchorLine = page
      .locator(".cm-line")
      .filter({ hasText: cursorPassage })
      .first()
    await expect(anchorLine).toBeVisible()
    await anchorLine.click()
    const cursor = page.locator(".cm-cursor").first()
    await expect(cursor).toBeVisible()
    let cursorBefore = await cursor.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    if (
      cursorBefore <= 0 ||
      cursorBefore > (await page.evaluate(() => innerHeight))
    ) {
      // macOS may use the first click only to activate a newly focused app.
      await anchorLine.click()
      await expect(cursor).toBeVisible()
      cursorBefore = await cursor.evaluate(
        (element) => element.getBoundingClientRect().top
      )
    }
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await waitForScrollToSettle()
    const cursorAfter = await cursor.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    expect(
      Math.abs(cursorAfter - cursorBefore),
      `cursor moved from ${cursorBefore}px to ${cursorAfter}px`
    ).toBeLessThanOrEqual(2)
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("wrapped source lines keep their gutters and click geometry aligned after font loading", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-wrapped-source-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    [
      "pmd --mode live \\",
      "  /Users/example/Projects/pulse-md/fixtures/markdown-syntax-showcase-for-testing.md \\",
      "  --ephemeral 1 \\",
      "  /Users/example/Projects/pulse-md/fixtures/markdown-test-fixture-for-testing.md \\",
      "  --active 2 \\",
      "  --tab-mode 2:source",
      "",
      "",
      "",
      "Launch Pulse MD.",
      "Make tabs rendered/live by default.",
      "Open markdown-syntax-showcase.md as tab 1.",
      "Add one disposable tab as tab 2.",
      "Open markdown-test.md as tab 3.",
      "Focus tab 2.",
      "Override tab 2 to raw/source mode.",
    ].join("\n")
  )

  const userData = await createTestUserData()
  await writeFile(
    path.join(userData, "window-state.json"),
    JSON.stringify({ height: 1_000, width: 860 })
  )
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(900)
    await expect
      .poll(() => page.evaluate(() => innerHeight))
      .toBeGreaterThan(900)
    await expect
      .poll(() =>
        page.evaluate(
          () => performance.getEntriesByName("pmd:editor-fonts-ready").length
        )
      )
      .toBe(1)

    await activateWindow(page)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
    })

    const lines = page.locator(".cm-line")
    await expect(lines).toHaveCount(16)
    const gutterNumbers = await page
      .locator(".cm-lineNumbers .cm-gutterElement")
      .evaluateAll((elements) =>
        elements
          .filter(
            (element) =>
              element.getAttribute("aria-hidden") !== "true" &&
              getComputedStyle(element).visibility !== "hidden"
          )
          .map((element) => element.textContent ?? "")
      )
    expect(gutterNumbers).toEqual(
      Array.from({ length: 16 }, (_, index) => String(index + 1))
    )
    const rowAlignment = await page.evaluate(() => {
      const lines = [...document.querySelectorAll<HTMLElement>(".cm-line")]
      const gutters = [
        ...document.querySelectorAll<HTMLElement>(
          ".cm-lineNumbers .cm-gutterElement"
        ),
      ].filter(
        (element) =>
          element.getAttribute("aria-hidden") !== "true" &&
          getComputedStyle(element).visibility !== "hidden"
      )
      return lines.map((line, index) => {
        const lineBounds = line.getBoundingClientRect()
        const gutterBounds = gutters[index]?.getBoundingClientRect()
        return {
          bottom: gutterBounds
            ? Math.abs(lineBounds.bottom - gutterBounds.bottom)
            : Number.POSITIVE_INFINITY,
          top: gutterBounds
            ? Math.abs(lineBounds.top - gutterBounds.top)
            : Number.POSITIVE_INFINITY,
        }
      })
    })
    expect(Math.max(...rowAlignment.map(({ top }) => top))).toBeLessThanOrEqual(
      1
    )
    expect(
      Math.max(...rowAlignment.map(({ bottom }) => bottom))
    ).toBeLessThanOrEqual(1)

    const lineHeights = await lines.evaluateAll((elements) =>
      elements
        .slice(0, 3)
        .map((element) => element.getBoundingClientRect().height)
    )
    expect(Math.max(...lineHeights)).toBeGreaterThan(
      Math.min(...lineHeights) * 1.5
    )

    const expectClickAligned = async (lineNumber: number) => {
      const line = lines.nth(lineNumber - 1)
      await line.scrollIntoViewIfNeeded()
      const lineBox = await line.boundingBox()
      if (!lineBox) throw new Error(`Source line ${lineNumber} is unavailable`)
      const clickPoint = {
        x: lineBox.x + 6,
        y: lineBox.y + lineBox.height / 2,
      }
      await page.mouse.click(clickPoint.x, clickPoint.y)
      await expect(
        page.locator(".cm-lineNumbers .cm-activeLineGutter")
      ).toHaveText(String(lineNumber))
      await expect
        .poll(async () => {
          const cursorBox = await page
            .locator(".cm-cursor")
            .first()
            .boundingBox()
          if (!cursorBox) return Number.POSITIVE_INFINITY
          return Math.abs(cursorBox.y + cursorBox.height / 2 - clickPoint.y)
        })
        .toBeLessThanOrEqual(3)
    }

    for (const lineNumber of [5, 10, 16]) {
      await expectClickAligned(lineNumber)
    }

    const initialFirstLineHeight = await lines
      .first()
      .evaluate((element) => element.getBoundingClientRect().height)
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--font-mono", "serif")
      document.documentElement.style.setProperty(
        "--editor-code-font-size",
        "22px"
      )
      document.fonts.dispatchEvent(new Event("loadingdone"))
    })
    await expect
      .poll(() =>
        lines
          .first()
          .evaluate((element) => element.getBoundingClientRect().height)
      )
      .toBeGreaterThan(initialFirstLineHeight + 2)

    for (const lineNumber of [5, 10, 16]) {
      await expectClickAligned(lineNumber)
    }
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("an empty document exposes editing affordances and dismisses editing intentionally", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.bringToFront()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1_400, 720)
    })
    await expect
      .poll(() => page.evaluate(() => innerWidth))
      .toBeGreaterThan(960)
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    const emptyLine = page.locator(".cm-line").first()

    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await expect(emptyLine).toHaveCSS("cursor", "text")
    await page.keyboard.type("hello")
    await expect(emptyLine).toContainText("hello")

    const contentBox = await content.boundingBox()
    const lineBox = await emptyLine.boundingBox()
    const contentPadding = await content.evaluate((element) => ({
      left: Number.parseFloat(getComputedStyle(element).paddingLeft),
      right: Number.parseFloat(getComputedStyle(element).paddingRight),
    }))
    const statusLaneBox = await page
      .locator(".status-overlay-reveal-region")
      .boundingBox()
    if (!contentBox || !lineBox || !statusLaneBox)
      throw new Error("Editor geometry is unavailable")

    await page.mouse.click(
      lineBox.x + lineBox.width - 8,
      lineBox.y + lineBox.height / 2
    )
    await page.keyboard.type("!")
    await expect(emptyLine).toHaveText("hello!")
    await expect(editor).toHaveClass(/cm-focused/)

    const bottomLanePoint = {
      x: lineBox.x + Math.min(lineBox.width / 2, 100),
      y: statusLaneBox.y + statusLaneBox.height / 2,
    }
    const bottomLaneCursor = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      if (!target) throw new Error("Trailing editor lane is unavailable")
      return getComputedStyle(target).cursor
    }, bottomLanePoint)
    expect(bottomLaneCursor).toBe("default")
    const verticalWhitespacePoint = {
      x: bottomLanePoint.x,
      y: contentBox.y + contentBox.height - 40,
    }
    await page.mouse.move(verticalWhitespacePoint.x, verticalWhitespacePoint.y)
    const verticalWhitespaceCursor = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      if (!target) throw new Error("Vertical editor whitespace is unavailable")
      return getComputedStyle(target).cursor
    }, verticalWhitespacePoint)
    expect(verticalWhitespaceCursor).toBe("text")
    await page.mouse.click(verticalWhitespacePoint.x, verticalWhitespacePoint.y)
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await page.keyboard.type("?")
    await expect(emptyLine).toHaveText("hello!?")

    await page.mouse.click(lineBox.x + Math.min(lineBox.width / 2, 100), 20)
    await expect(editor).not.toHaveClass(/cm-focused/)
    await emptyLine.click()
    await expect(editor).toHaveClass(/cm-focused/)
    await page.keyboard.press("Home")
    await page.keyboard.type("^")
    await expect(emptyLine).toHaveText("^hello!?")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await expect(
      page.locator(".cm-app-selectionBackground").first()
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-focused/)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()

    const hiddenCaretState = await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              state: {
                doc: { toString(): string }
                selection: { main: { head: number } }
              }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      return {
        content: view.state.doc.toString(),
        position: view.state.selection.main.head,
      }
    })
    const contentAfterCaretRestore =
      hiddenCaretState.content.slice(0, hiddenCaretState.position) +
      "$" +
      hiddenCaretState.content.slice(hiddenCaretState.position)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    await expect
      .poll(() =>
        content.evaluate((element) => {
          const view = (
            element as HTMLElement & {
              cmTile?: {
                view?: { state: { selection: { main: { head: number } } } }
              }
            }
          ).cmTile?.view
          if (!view) throw new Error("CodeMirror view is unavailable")
          return view.state.selection.main.head
        })
      )
      .toBe(hiddenCaretState.position)

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    await page.keyboard.type("$")
    await expect(emptyLine).toHaveText(contentAfterCaretRestore)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(emptyLine).toHaveText(hiddenCaretState.content)

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    const findInput = page.getByRole("textbox", { name: "Find" })
    await expect(findInput).toBeFocused()
    await findInput.fill("caret search")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await expect
      .poll(() =>
        findInput.evaluate((element) => {
          if (!(element instanceof HTMLInputElement)) return false
          return (
            element.selectionStart === 0 &&
            element.selectionEnd === element.value.length
          )
        })
      )
      .toBe(true)
    await page.keyboard.press("Escape")
    await expect(findInput).toHaveCount(0)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()
    await content.dispatchEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      key: "Escape",
      keyCode: 27,
      repeat: true,
      which: 27,
    })
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await expect(content).toBeFocused()

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await expect(
      page.locator(".cm-app-selectionBackground").first()
    ).toBeVisible()
    const leftPaddingLineBox = await emptyLine.boundingBox()
    if (!leftPaddingLineBox) throw new Error("Editor line is unavailable")
    const leftPaddingPoint = {
      x: contentBox.x + contentPadding.left / 2,
      y: leftPaddingLineBox.y + leftPaddingLineBox.height / 2,
    }
    await page.mouse.click(leftPaddingPoint.x, leftPaddingPoint.y)

    await expect(editor).toHaveClass(/cm-focused/)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    await expect(page.locator(".cm-cursor").first()).toBeVisible()
    const marginCursor = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      if (!target) throw new Error("Editor margin is unavailable")
      return getComputedStyle(target).cursor
    }, leftPaddingPoint)
    expect(marginCursor).toBe("text")
    await page.keyboard.type("<")
    await expect(emptyLine).toHaveText("<^hello!?")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await expect(
      page.locator(".cm-app-selectionBackground").first()
    ).toBeVisible()
    const rightPaddingLineBox = await emptyLine.boundingBox()
    if (!rightPaddingLineBox) throw new Error("Editor line is unavailable")
    const rightPaddingPoint = {
      x: contentBox.x + contentBox.width - contentPadding.right / 2,
      y: rightPaddingLineBox.y + rightPaddingLineBox.height / 2,
    }
    expect(rightPaddingPoint.x).toBeLessThan(
      await page.evaluate(() => innerWidth)
    )
    await page.mouse.click(rightPaddingPoint.x, rightPaddingPoint.y)
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    const rightMarginCursor = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      if (!target) throw new Error("Editor margin is unavailable")
      return getComputedStyle(target).cursor
    }, rightPaddingPoint)
    expect(rightMarginCursor).toBe("text")
    await page.keyboard.type(">")
    await expect(emptyLine).toHaveText("<^hello!?>")

    const outsideLineBox = await emptyLine.boundingBox()
    if (!outsideLineBox) throw new Error("Editor line is unavailable")
    const outsideContentPoint = {
      x: contentBox.x - 8,
      y: outsideLineBox.y + outsideLineBox.height / 2,
    }
    if (outsideContentPoint.x > 0) {
      await page.mouse.click(outsideContentPoint.x, outsideContentPoint.y)
      await expect(editor).not.toHaveClass(/cm-focused/)
      await expect(editor).toHaveClass(/cm-md-caret-hidden/)

      await page.keyboard.press("Escape")
      await expect(editor).toHaveClass(/cm-focused/)
      await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
      await page.keyboard.type("=")
      await expect(emptyLine).toHaveText("<^hello!?>=")
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("save preserves a UTF-8 BOM and CRLF line endings", async () => {
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-format-${process.pid}.md`
  )
  await writeFile(
    temporaryDocument,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("# One\r\n\r\nTwo\r\n", "utf8"),
    ])
  )

  const userData = await createTestUserData()
  const app = await launchApplication(userData, temporaryDocument)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.bringToFront()
    const firstLine = page.locator(".cm-line").first()
    await clickVisibleText(page, firstLine)
    if (
      !(await page
        .locator(".cm-editor")
        .evaluate((element) => element.classList.contains("cm-focused")))
    ) {
      await clickVisibleText(page, firstLine)
    }
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End"
    )
    await page.keyboard.type("Three")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )

    await expect
      .poll(async () =>
        (await readFile(temporaryDocument)).includes(Buffer.from("Three"))
      )
      .toBe(true)
    const saved = await readFile(temporaryDocument)
    expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const body = saved.subarray(3).toString("utf8")
    expect(body).not.toMatch(/(^|[^\r])\n/)
    expect(body).toContain("\r\n")
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("settings start from active colors, commit explicit saves, and contain Select All", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  const settingsShortcut =
    process.platform === "darwin" ? "Meta+," : "Control+,"

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const fontSize = page.getByLabel("Base font size in pixels")

    await editor.waitFor()
    await activateWindow(page)
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    await activateWindow(page)

    await page.keyboard.press(settingsShortcut)
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect
      .poll(() =>
        page.getByRole("dialog").evaluate((element) => {
          const chromeHeight = Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--window-chrome-height"
            )
          )
          return element.getBoundingClientRect().top >= chromeHeight - 0.5
        })
      )
      .toBe(true)
    const themeTrigger = page.getByRole("button", {
      name: "Theme",
      exact: true,
    })
    await themeTrigger.click()
    await expect(themePresetPicker(page, "dark")).toHaveValue(
      "Default (One Dark)"
    )
    const darkBackground = page.locator("#dark-appearance-background")
    const lightBackground = page.locator("#light-appearance-background")
    await expect(darkBackground).toContainText("Dark")
    await expect(
      page
        .getByLabel("dark theme preview")
        .locator('[data-slot="theme-preview-surface"]')
    ).toHaveCSS("background-color", "rgb(24, 24, 24)")
    await chooseThemePreset(page, "dark", "Dracula")
    await expect(darkBackground).toContainText("Dracula")
    await chooseThemePreset(page, "dark", "Default (One Dark)")
    await expect(darkBackground).toContainText("Dark")
    await expect(
      page
        .getByLabel("dark theme preview")
        .locator('[data-slot="theme-preview-surface"]')
    ).toHaveCSS("background-color", "rgb(24, 24, 24)")
    await chooseSelectOption(page, lightBackground, /Catppuccin Latte/)
    await expect(
      page
        .getByLabel("light theme preview")
        .locator('[data-slot="theme-preview-surface"]')
    ).toHaveCSS("background-color", "rgb(239, 241, 245)")
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)

    await page.keyboard.press(settingsShortcut)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()
    await themeTrigger.click()
    await expect(
      page
        .getByLabel("dark theme preview")
        .locator('[data-slot="theme-preview-surface"]')
    ).toHaveCSS("background-color", "rgb(24, 24, 24)")
    await page.keyboard.press("Escape")

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await page.getByLabel("Maximum content width in pixels").fill("1200")
    await openTypographySettings(page)
    await fontSize.fill("17")
    await expect(editor).toHaveCSS("font-size", "17px")
    await saveTypographySettings(page)
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({ baseFontSize: 17, maxContentWidth: 960 })

    await page.keyboard.press(settingsShortcut)
    await openTypographySettings(page)
    await fontSize.fill("18")
    await expect(editor).toHaveCSS("font-size", "18px")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(editor).toHaveCSS("font-size", "17px")

    await page.keyboard.press(settingsShortcut)
    await openTypographySettings(page)
    await fontSize.focus()
    await selectAllFromApplicationMenu(app)
    await expect(fontSize).toBeFocused()
    await page.keyboard.type("19")
    await expect(fontSize).toHaveValue("19")
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter"
    )
    await expect(
      page.getByRole("region", { name: "Typography preview workspace" })
    ).toHaveCount(0)
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(editor).toHaveCSS("font-size", "19px")
    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({ baseFontSize: 19 })

    await page.keyboard.press(settingsShortcut)
    await themeTrigger.focus()
    await selectAllFromApplicationMenu(app)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const dialog = document.querySelector<HTMLElement>(
            '[data-slot="dialog-content"]'
          )
          const selection = window.getSelection()
          if (!dialog || !selection || selection.rangeCount === 0) return false
          return (
            dialog.contains(selection.anchorNode) &&
            dialog.contains(selection.focusNode) &&
            selection.toString().includes("Settings") &&
            !selection.toString().includes("A quiet Markdown window")
          )
        })
      )
      .toBe(true)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
    await openTypographySettings(page)
    await fontSize.fill("20")
    await cancelTypographySettings(page)
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(editor).toHaveCSS("font-size", "19px")
    expect(
      JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
    ).toMatchObject({ baseFontSize: 19 })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("appearance and typography persist without a mismatched launch surface", async () => {
  test.setTimeout(60_000)
  const userData = await createTestUserData()
  let originalThemeSource: string | null = null
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify(
      {
        appearanceMode: "light",
        themeByScheme: {
          light: {
            backgroundId: "default",
            customBackgroundColor: "#ffffff",
            syntaxThemeId: "default",
          },
          dark: {
            backgroundId: "one-dark",
            customBackgroundColor: "#181818",
            syntaxThemeId: "one-dark",
          },
        },
        zoomFactor: 1,
        baseFontSize: 16,
        codeFontSize: 12,
        headingFontScales: DEFAULT_APP_SETTINGS.headingFontScales,
        headingFontBold: DEFAULT_APP_SETTINGS.headingFontBold,
        fontLigatures: true,
        maxContentWidth: 940,
        sourceIndentation: "spaces",
        sourceIndentSize: 5,
        chrome: {
          tabVisibility: "mouseover",
          showFormattingBar: true,
          formattingBarPosition: "left",
          showCenteredPath: true,
          centeredPathDisplay: "path",
          tabDisplay: "path",
          alwaysShowStatusBar: false,
          statusItems: {
            words: true,
            lines: true,
            characters: true,
            cursorPosition: true,
            encoding: true,
            lineEnding: true,
          },
        },
      },
      null,
      2
    )}\n`
  )
  let app: ElectronApplication | null = await launchApplication(
    userData,
    samplePath
  )

  try {
    let page = await app.firstWindow()
    originalThemeSource = await app.evaluate(
      ({ nativeTheme }) => nativeTheme.themeSource
    )
    await activateWindow(page)
    await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "16px")
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-size",
      "12px"
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    const settingsDialog = page.getByRole("dialog", { name: "Settings" })
    const readShadcnTheme = () =>
      settingsDialog.evaluate((dialog) => {
        const primaryControl = dialog.querySelector<HTMLElement>(
          '[data-slot="appearance-mode-indicator"]'
        )
        if (!primaryControl) {
          throw new Error("Appearance mode indicator missing")
        }
        return {
          accent: getComputedStyle(document.documentElement)
            .getPropertyValue("--syntax-function-color")
            .trim(),
          control: getComputedStyle(primaryControl).backgroundColor,
          foreground: getComputedStyle(dialog).color,
          surface: getComputedStyle(dialog).backgroundColor,
        }
      })
    const themeTrigger = page.getByRole("button", {
      name: "Theme",
      exact: true,
    })
    const miscellaneousTrigger = page.getByRole("button", {
      name: "Miscellaneous",
      exact: true,
    })
    await expect(themeTrigger).toHaveAttribute("aria-expanded", "false")
    await expect(miscellaneousTrigger).toHaveAttribute("aria-expanded", "false")
    await expect(
      page.getByRole("button", { name: "Customize typography" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "View keyboard shortcuts" })
    ).toBeVisible()
    await expect(page.locator("#light-appearance-preset")).toHaveCount(0)
    await expect(settingsSelect(page, "Raw Markdown Tab key")).toHaveCount(0)
    await openSettingsSection(page, "Theme")
    await expect(themeTrigger).toHaveAttribute("aria-expanded", "true")
    const initialShadcnTheme = await readShadcnTheme()
    await openSettingsSection(page, "Miscellaneous")
    await expect(settingsSelect(page, "Raw Markdown Tab key")).toBeVisible()
    await expect(settingsSelect(page, "Raw Markdown Tab key")).toHaveText(
      "Spaces"
    )
    await expect(page.getByLabel("Spaces per Tab")).toHaveValue("5")
    await themePresetPicker(page, "light").click()
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(20)
    await expect(
      page.getByRole("listbox").getByRole("option").first()
    ).toHaveText("Default (CodeMirror)")
    await page.keyboard.press("Escape")
    await themePresetPicker(page, "dark").click()
    await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(20)
    await expect(
      page.getByRole("listbox").getByRole("option").first()
    ).toHaveText("Default (One Dark)")
    await page.keyboard.press("Escape")
    const lightBackground = page.locator("#light-appearance-background")
    const darkBackground = page.locator("#dark-appearance-background")
    await lightBackground.click()
    let backgroundPopup = page.locator(
      '[data-slot="select-content"][data-open]'
    )
    await expect(backgroundPopup).toBeVisible()
    await expect(backgroundPopup.getByRole("option")).toHaveCount(24)
    await expect(
      backgroundPopup.locator('[data-slot="select-group"]')
    ).toHaveCount(3)
    await page.keyboard.press("Escape")
    await darkBackground.click()
    backgroundPopup = page.locator('[data-slot="select-content"][data-open]')
    await expect(backgroundPopup).toBeVisible()
    await expect(backgroundPopup.getByRole("option")).toHaveCount(24)
    await expect(
      backgroundPopup.locator('[data-slot="select-group"]')
    ).toHaveCount(3)
    await page.keyboard.press("Escape")
    await expect(settingsDialog).toBeVisible()
    await expect(themeTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByLabel("light theme preview")).toBeVisible()

    const darkModeButton = page.getByRole("radio", {
      name: "Dark",
      exact: true,
    })
    await expect(
      page.locator('[data-slot="select-content"]:visible')
    ).toHaveCount(0)
    await darkModeButton.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Dark appearance control is unavailable")
      }
      button.click()
    })
    await expect(page.getByLabel("dark theme preview")).toBeVisible()
    await page.getByRole("radio", { name: "Light", exact: true }).click()
    await expect(page.getByLabel("light theme preview")).toBeVisible()

    const systemInitiallyDark = await page.evaluate(
      () => window.matchMedia("(prefers-color-scheme: dark)").matches
    )
    const forcedSystemTheme = systemInitiallyDark ? "light" : "dark"
    await app.evaluate(({ nativeTheme }, themeSource) => {
      nativeTheme.themeSource = themeSource as "dark" | "light"
    }, forcedSystemTheme)
    await page.emulateMedia({ colorScheme: forcedSystemTheme })
    await expect
      .poll(() =>
        page.evaluate(
          () => window.matchMedia("(prefers-color-scheme: dark)").matches
        )
      )
      .toBe(!systemInitiallyDark)
    await page.getByRole("radio", { name: "System" }).click()
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor(
        forcedSystemTheme === "dark" ? "rgb(40, 44, 52)" : "rgb(255, 255, 255)"
      )
    )
    await page.getByRole("radio", { name: "Light", exact: true }).click()
    await page.emulateMedia({ colorScheme: null })
    await app.evaluate(({ nativeTheme }, themeSource) => {
      nativeTheme.themeSource = themeSource as "dark" | "light" | "system"
    }, originalThemeSource)
    const editorElement = await page.locator(".cm-editor").elementHandle()
    if (!editorElement) throw new Error("Editor element is unavailable")
    await chooseSelectOption(page, lightBackground, /Black/)
    await expect(page.locator("html")).toHaveClass(/dark/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(9, 9, 11)")
    )
    const blackShadcnTheme = await readShadcnTheme()
    expect(blackShadcnTheme.surface).not.toBe(initialShadcnTheme.surface)
    expect(blackShadcnTheme.foreground).not.toBe(initialShadcnTheme.foreground)
    expect(blackShadcnTheme.control).not.toBe(initialShadcnTheme.control)
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/09090b/i)
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.locator("html")).toHaveClass(/light/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(255, 255, 255)")
    )
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/ffffff/i)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openSettingsSection(page, "Theme")
    await page.getByRole("radio", { name: "Dark", exact: true }).click()
    await expect(page.locator("html")).toHaveClass(/dark/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(40, 44, 52)")
    )
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/282c34/i)
    const oneDarkShadcnTheme = await readShadcnTheme()
    expect(oneDarkShadcnTheme.accent).toBe("#61afef")
    await expect
      .poll(() =>
        page
          .locator(".cm-md-code-line", { hasText: "const fast" })
          .evaluate((line) => {
            const keyword = [...line.querySelectorAll("span")].find(
              (span) => span.textContent === "const"
            )
            return keyword ? getComputedStyle(keyword).color : null
          })
      )
      .toBe("rgb(201, 126, 222)")
    await chooseThemePreset(page, "dark", "Catppuccin Latte")
    await expect(page.locator("html")).toHaveClass(/light/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(239, 241, 245)")
    )
    await expect(darkBackground).toContainText("Catppuccin Latte")
    await expect
      .poll(() =>
        page
          .locator(".cm-md-code-line", { hasText: "const fast" })
          .evaluate((line) => {
            const keyword = [...line.querySelectorAll("span")].find(
              (span) => span.textContent === "const"
            )
            return keyword ? getComputedStyle(keyword).color : null
          })
      )
      .toBe("rgb(132, 55, 233)")
    const catppuccinShadcnTheme = await readShadcnTheme()
    expect(catppuccinShadcnTheme.accent).toBe("#1b5de1")
    expect(catppuccinShadcnTheme.surface).not.toBe(oneDarkShadcnTheme.surface)
    expect(catppuccinShadcnTheme.foreground).not.toBe(
      oneDarkShadcnTheme.foreground
    )
    await chooseSelectOption(page, darkBackground, /Black/)
    await expect(themePresetPicker(page, "dark")).toHaveValue(
      "Catppuccin Latte"
    )
    await expect(page.locator("html")).toHaveClass(/dark/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(9, 9, 11)")
    )
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
        )
      )
      .toMatch(/09090b/i)
    await chooseSelectOption(page, darkBackground, "Custom…")
    const customBackgroundHex = page.getByLabel("dark custom background hex")
    await expect(page.getByLabel("dark custom background color")).toBeVisible()
    await customBackgroundHex.fill("#f0e6d2")
    await expect(page.locator("html")).toHaveClass(/light/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(240, 230, 210)")
    )
    await expect(
      page
        .getByLabel("dark theme preview")
        .locator('[data-slot="theme-preview-surface"]')
    ).toHaveCSS("background-color", "rgb(240, 230, 210)")
    expect(
      await page.evaluate(
        (original) => original === document.querySelector(".cm-editor"),
        editorElement
      )
    ).toBe(true)
    await openTypographySettings(page)
    const typographyWorkspace = page.getByRole("region", {
      name: "Typography preview workspace",
    })
    const regularFont = typographyWorkspace.getByRole("combobox", {
      name: "Regular Font",
      exact: true,
    })
    const monospaceFont = typographyWorkspace.getByRole("combobox", {
      name: "Monospace Font",
      exact: true,
    })
    await regularFont.click()
    await regularFont.fill("Newsreader")
    await page.getByRole("option", { name: /Newsreader Included/ }).click()
    await monospaceFont.click()
    await monospaceFont.fill("JetBrains Mono")
    await page.getByRole("option", { name: /JetBrains Mono Included/ }).click()
    await page.getByLabel("Base font size in pixels").fill("18")
    await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "18px")
    await page.getByLabel("Monospace font size in pixels").fill("14")
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-size",
      "14px"
    )
    await page.getByLabel("Callout Title font size in pixels").fill("21")
    await page
      .getByRole("spinbutton", { name: "H1 scale relative to base" })
      .fill("2.4")
    await expect(page.locator(".cm-md-heading-1").first()).toHaveCSS(
      "font-size",
      "43.2px"
    )
    await page.getByRole("button", { name: "H3 bold" }).click()
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((element) =>
            getComputedStyle(element)
              .getPropertyValue("--editor-heading-3-font-weight")
              .trim()
          )
      )
      .toBe("400")
    await page.getByRole("switch", { name: "Code ligatures" }).click()
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-variant-ligatures",
      "none"
    )
    await saveTypographySettings(page)
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({
        appearanceMode: "dark",
        backgroundEffect: DEFAULT_APP_SETTINGS.backgroundEffect,
        themeByScheme: {
          light: {
            backgroundId: "default",
            customBackgroundColor: "#ffffff",
            syntaxThemeId: "default",
          },
          dark: {
            backgroundId: "custom",
            customBackgroundColor: "#f0e6d2",
            syntaxThemeId: "catppuccin-latte",
          },
        },
        regularFontFamily: "Newsreader Variable",
        monospaceFontFamily: "JetBrains Mono Variable",
        baseFontSize: 18,
        codeFontSize: 14,
        calloutTitleFontSize: 21,
        headingFontScales: [2.4, 1.9, 1.6, 1.3, 1.15, 1],
        headingFontBold: [true, true, false, true, true, true],
        fontLigatures: false,
        maxContentWidth: 940,
        sourceIndentation: "spaces",
        sourceIndentSize: 5,
      })

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, samplePath)
    page = await app.firstWindow()

    await expect(page.locator("html")).toHaveClass(/light/)
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      documentSurfaceColor("rgb(240, 230, 210)")
    )
    await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "18px")
    await expect(page.locator(".cm-content")).toHaveCSS(
      "font-family",
      /Newsreader Variable/
    )
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-size",
      "14px"
    )
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-family",
      /JetBrains Mono Variable/
    )
    await expect(page.locator(".cm-md-heading-1").first()).toHaveCSS(
      "font-size",
      "43.2px"
    )
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((element) =>
            getComputedStyle(element)
              .getPropertyValue("--editor-heading-3-font-weight")
              .trim()
          )
      )
      .toBe("400")
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue(
              "--editor-callout-title-font-size"
            )
          )
      )
      .toBe("21px")
    await expect(page.locator(".cm-md-inline-code")).toHaveCSS(
      "font-variant-ligatures",
      "none"
    )
    await expect
      .poll(() =>
        page
          .locator(".cm-md-code-line", { hasText: "const fast" })
          .evaluate((line) => {
            const keyword = [...line.querySelectorAll("span")].find(
              (span) => span.textContent === "const"
            )
            return keyword ? getComputedStyle(keyword).color : null
          })
      )
      .toBe("rgb(125, 52, 219)")
    await activateWindow(page)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    const firstLine = page.locator(".cm-line").first()
    await clickVisibleText(page, firstLine)
    await page.keyboard.press("End")
    await page.keyboard.press("Tab")
    await page.keyboard.type("persisted")
    expect(await firstLine.textContent()).toBe(
      "# A quiet Markdown window     persisted"
    )
    const background = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBackgroundColor()
    )
    expect(background).toMatch(/f0e6d2/i)
  } finally {
    if (app && originalThemeSource) {
      await app.evaluate(({ nativeTheme }, themeSource) => {
        nativeTheme.themeSource = themeSource as "dark" | "light" | "system"
      }, originalThemeSource)
    }
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("custom appearance presets can be saved, reused, and deleted", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  const settingsShortcut =
    process.platform === "darwin" ? "Meta+," : "Control+,"

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await activateWindow(page)
    await page.keyboard.press(settingsShortcut)
    await page.getByRole("button", { name: "Theme", exact: true }).click()
    await chooseSelectOption(
      page,
      page.locator("#light-appearance-background"),
      /Black/
    )

    await page.getByRole("button", { name: "Save as preset" }).click()
    const nameInput = page.getByLabel("light preset name")
    const savePreset = nameInput
      .locator("..")
      .getByRole("button", { name: "Save", exact: true })
    await savePreset.click()
    await expect(page.getByRole("alert")).toHaveText("Enter a name.")

    await nameInput.fill("dracula")
    await savePreset.click()
    await expect(page.getByRole("alert")).toHaveText(
      "A preset with that name already exists."
    )

    await nameInput.fill("  Ink Paper  ")
    await savePreset.click()
    await expect(themePresetPicker(page, "light")).toHaveValue("Ink Paper")
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
    await expect
      .poll(async () => {
        try {
          return JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).customThemePresets
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
      })
      .toEqual([
        expect.objectContaining({
          name: "Ink Paper",
          scheme: "light",
          profile: expect.objectContaining({
            backgroundId: "black",
            syntaxThemeId: "default",
          }),
        }),
      ])

    await page.keyboard.press(settingsShortcut)
    await page.getByRole("button", { name: "Theme", exact: true }).click()
    await expect(themePresetPicker(page, "light")).toHaveValue("Ink Paper")
    await page.getByRole("button", { name: "Delete Ink Paper preset" }).click()
    await settingsSaveButton(page).click()
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userData, "settings.json"), "utf8")
          ).customThemePresets
      )
      .toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Markdown view on launch applies to new sessions without changing open tabs", async () => {
  const userData = await createTestUserData()
  let app: ElectronApplication | null = await launchApplication(
    userData,
    samplePath
  )
  const settingsShortcut =
    process.platform === "darwin" ? "Meta+," : "Control+,"
  const newTabShortcut = process.platform === "darwin" ? "Meta+T" : "Control+T"

  try {
    let page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await expect(editor).toHaveClass(/cm-md-live/)

    await activateWindow(page)
    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await chooseSettingsOption(page, "Markdown view on launch", "Raw Markdown")
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(editor).toHaveClass(/cm-md-live/)

    await page.keyboard.press(newTabShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, samplePath)
    page = await app.firstWindow()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)

    await activateWindow(page)
    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await chooseSettingsOption(page, "Markdown view on launch", "Rendered")
    await settingsSaveButton(page).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)

    await page.keyboard.press(newTabShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("open documents follow external saves without replacing local edits @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const documentsDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-external-change-e2e-")
  )
  const activePath = path.join(documentsDirectory, "active.md")
  const inactivePath = path.join(documentsDirectory, "inactive.md")
  await writeFile(activePath, "active initial\n")
  await writeFile(inactivePath, "inactive initial\n")
  const app = await launchApplication(userData, activePath, inactivePath)

  try {
    const page = await app.firstWindow()
    const firstLine = page.locator(".cm-line").first()
    await expect(firstLine).toHaveText("active initial")

    await writeFile(activePath, "active externally changed\n")
    await expect(firstLine).toHaveText("active externally changed")

    const replacementPath = path.join(documentsDirectory, ".active.replacement")
    await writeFile(replacementPath, "active atomically replaced\n")
    if (process.platform === "win32") await rm(activePath)
    await rename(replacementPath, activePath)
    await expect(firstLine).toHaveText("active atomically replaced")

    await writeFile(inactivePath, "inactive externally changed\n")
    await page.waitForTimeout(600)
    await page.locator(".top-chrome").hover()
    await page
      .locator(".document-tab")
      .filter({ hasText: path.basename(inactivePath) })
      .click()
    await expect(firstLine).toHaveText("inactive externally changed")

    await firstLine.click()
    await page.keyboard.press("End")
    await page.keyboard.type(" local edit")
    await expect(firstLine).toHaveText("inactive externally changed local edit")
    await expect(
      page.locator(".document-tab[data-active] .tab-dirty-dot")
    ).toBeVisible()

    await writeFile(inactivePath, "inactive newer disk version\n")
    await page.waitForTimeout(700)
    await expect(firstLine).toHaveText("inactive externally changed local edit")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z"
    )
    await expect(firstLine).toHaveText("inactive newer disk version")
  } finally {
    await exitApplication(app)
    await rm(documentsDirectory, { force: true, recursive: true })
    await rm(userData, { force: true, recursive: true })
  }
})

test("the tablist supports horizontal arrow, Home, and End navigation", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData, samplePath)
  const newTabShortcut = process.platform === "darwin" ? "Meta+T" : "Control+T"

  try {
    const page = await app.firstWindow()
    await activateWindow(page)
    await page.keyboard.press(newTabShortcut)
    await expect(page.getByRole("tab")).toHaveCount(2)
    await page.keyboard.press(newTabShortcut)

    const tabs = page.getByRole("tab")
    await expect(tabs).toHaveCount(3)
    await tabs.nth(2).focus()

    await page.keyboard.press("ArrowLeft")
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
    await expect(tabs.nth(1)).toBeFocused()

    await page.keyboard.press("Home")
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true")
    await expect(tabs.nth(0)).toBeFocused()

    await page.keyboard.press("ArrowLeft")
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true")
    await expect(tabs.nth(2)).toBeFocused()

    await page.keyboard.press("End")
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true")
    await page.keyboard.press("ArrowRight")
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true")
    await expect(tabs.nth(0)).toBeFocused()

    const activeTabId = await tabs.nth(0).getAttribute("id")
    expect(activeTabId).not.toBeNull()
    await expect(page.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      activeTabId!
    )
    const closeButton = page
      .locator(".document-tab")
      .nth(1)
      .locator(".tab-close")
    await expect(
      page.locator(".document-tab[data-active] .tab-close")
    ).toHaveAttribute("tabindex", "0")
    await expect(closeButton).toHaveAttribute("tabindex", "-1")
    expect(
      await closeButton.evaluate(
        (button) => button.closest('[role="tab"]') === null
      )
    ).toBe(true)
    await closeButton.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(page.getByRole("tab").first()).toHaveAttribute(
      "aria-selected",
      "true"
    )
    const remainingCloseButton = page
      .locator(".document-tab")
      .nth(1)
      .locator(".tab-close")
    await remainingCloseButton.focus()
    await page.keyboard.press("Space")
    await expect(page.getByRole("tab")).toHaveCount(1)
    await expect(page.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("tab cycling and closing restore each retained session without a painted scroll jump @renderer-isolated", async () => {
  const userData = await createTestUserData()
  const firstPath = path.join(userData, "first-long.md")
  const secondPath = path.join(userData, "second-long.md")
  const longDocument = (label: string) =>
    Array.from(
      { length: 2_000 },
      (_, index) => `${label} line ${String(index + 1).padStart(4, "0")}`
    ).join("\n")
  await writeFile(firstPath, longDocument("first"))
  await writeFile(secondPath, longDocument("second"))
  const app = await launchApplication(userData, firstPath, secondPath)

  try {
    const page = await app.firstWindow()
    const scroller = page.locator(".cm-scroller")
    const activeTab = activeDocumentTab(page)
    await expect(page.locator(".document-tab")).toHaveCount(2)
    await expect(activeTab).toHaveAttribute("aria-label", firstPath)

    const settleAt = async (ratio: number) => {
      await scroller.evaluate((element, requestedRatio) => {
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
        const maximum = element.scrollHeight - element.clientHeight
        element.scrollTop = maximum * requestedRatio
      }, ratio)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
    }
    const captureViewportAnchor = async () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller")
        if (!scroller) throw new Error("The editor scroller is unavailable")
        const bounds = scroller.getBoundingClientRect()
        const center = bounds.top + bounds.height / 2
        const lines = [...document.querySelectorAll<HTMLElement>(".cm-line")]
        const anchor = lines.reduce(
          (closest, line) => {
            const lineBounds = line.getBoundingClientRect()
            const distance = Math.abs(
              lineBounds.top + lineBounds.height / 2 - center
            )
            return !closest || distance < closest.distance
              ? { distance, line, top: lineBounds.top - bounds.top }
              : closest
          },
          null as { distance: number; line: HTMLElement; top: number } | null
        )
        if (!anchor) throw new Error("No viewport anchor line is available")
        return { text: anchor.line.textContent, top: anchor.top }
      })
    const startPaintTrace = async (
      targetPath: string,
      anchorText: string | null
    ) => {
      await page.evaluate(
        ({ pathLabel, text }) => {
          const testWindow = window as Window & {
            __pmdTabScrollTrace?: Array<{
              active: string | null
              anchorTop: number | null
            }>
          }
          const samples: Array<{
            active: string | null
            anchorTop: number | null
          }> = []
          testWindow.__pmdTabScrollTrace = samples
          let frames = 0
          const sampleAfterPaint = () => {
            requestAnimationFrame(() => {
              window.setTimeout(() => {
                const active = document
                  .querySelector<HTMLElement>(
                    '.document-tab[data-active] [role="tab"]'
                  )
                  ?.getAttribute("aria-label")
                if (active === pathLabel) {
                  const scroller =
                    document.querySelector<HTMLElement>(".cm-scroller")
                  const anchor = [
                    ...document.querySelectorAll<HTMLElement>(".cm-line"),
                  ].find((line) => line.textContent === text)
                  samples.push({
                    active,
                    anchorTop:
                      scroller && anchor
                        ? anchor.getBoundingClientRect().top -
                          scroller.getBoundingClientRect().top
                        : null,
                  })
                }
                frames += 1
                if (frames < 12) sampleAfterPaint()
              }, 0)
            })
          }
          sampleAfterPaint()
        },
        { pathLabel: targetPath, text: anchorText }
      )
    }
    const readPaintTrace = async () => {
      await page.waitForTimeout(250)
      return page.evaluate(() => {
        const testWindow = window as Window & {
          __pmdTabScrollTrace?: Array<{
            active: string | null
            anchorTop: number | null
          }>
        }
        return testWindow.__pmdTabScrollTrace ?? []
      })
    }

    await settleAt(0.31)
    const firstAnchor = await captureViewportAnchor()
    await page.keyboard.press("Control+Tab")
    await expect(activeTab).toHaveAttribute("aria-label", secondPath)
    await settleAt(0.69)

    await startPaintTrace(firstPath, firstAnchor.text)
    await page.keyboard.press("Control+Tab")
    await expect(activeTab).toHaveAttribute("aria-label", firstPath)
    const cycleTrace = await readPaintTrace()
    expect(cycleTrace.length).toBeGreaterThan(0)
    for (const sample of cycleTrace) {
      expect(sample.anchorTop).not.toBeNull()
      expect(sample.anchorTop!).toBeCloseTo(firstAnchor.top, 0)
    }

    await page.keyboard.press("Control+Tab")
    await expect(activeTab).toHaveAttribute("aria-label", secondPath)
    await startPaintTrace(firstPath, firstAnchor.text)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+W" : "Control+W"
    )
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await expect(activeTab).toHaveAttribute("aria-label", firstPath)
    const closeTrace = await readPaintTrace()
    expect(closeTrace.length).toBeGreaterThan(0)
    for (const sample of closeTrace) {
      expect(sample.anchorTop).not.toBeNull()
      expect(sample.anchorTop!).toBeCloseTo(firstAnchor.top, 0)
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
