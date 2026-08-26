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

test("Linux transparent chrome exposes functional renderer window controls @renderer-isolated", async () => {
  test.skip(process.platform !== "linux", "Linux renderer window controls only")
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-linux-window-controls-")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const controls = page.getByLabel("Window controls")
    const minimize = page.getByRole("button", { name: "Minimize window" })
    const maximize = page.locator('[data-window-action="toggle-maximize"]')
    const close = page.getByRole("button", { name: "Close window" })

    await expect(controls).toBeVisible()
    await expect(minimize).toBeVisible()
    await expect(maximize).toBeVisible()
    await expect(close).toBeVisible()
    const ordinaryGeometry = await controls.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        height: bounds.height,
        rightInset: innerWidth - bounds.right,
        width: bounds.width,
      }
    })
    expect(ordinaryGeometry.height).toBeCloseTo(46, 0)
    expect(ordinaryGeometry.rightInset).toBeCloseTo(0, 0)
    expect(ordinaryGeometry.width).toBeCloseTo(138, 0)

    const initiallyMaximized = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false
    )
    await expect(maximize).toHaveAccessibleName(
      initiallyMaximized ? "Restore window" : "Maximize window"
    )
    await maximize.click()
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false
        )
      )
      .toBe(!initiallyMaximized)
    await expect(maximize).toHaveAccessibleName(
      initiallyMaximized ? "Maximize window" : "Restore window"
    )
    await maximize.click()
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false
        )
      )
      .toBe(initiallyMaximized)
    await expect(maximize).toHaveAccessibleName(
      initiallyMaximized ? "Restore window" : "Maximize window"
    )

    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect
      .poll(() =>
        controls.evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeCloseTo(69, 0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("desktop application menu supports access mode and sibling navigation @renderer-isolated", async () => {
  test.skip(process.platform === "darwin", "Desktop application chrome only")
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-alt-menu-"))
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const chrome = page.locator(".top-chrome")
    const menu = page.locator(".windows-menu-strip")

    await menu.waitFor({ state: "attached" })
    await expect(menu).toBeHidden()
    await page.keyboard.press("Alt")
    await expect(menu).toBeVisible()
    await expect(chrome).toHaveAttribute("data-windows-menu-open", "true")
    await expect(menu.locator("button[data-active]")).toHaveText("File")

    const editorText = await page.locator(".cm-content").textContent()
    await page.keyboard.press("x")
    await expect(menu).toBeVisible()
    await expect(page.locator(".cm-content")).toHaveText(editorText ?? "")

    await page.keyboard.press("ArrowRight")
    await expect(menu.locator("button[data-active]")).toHaveText("Edit")
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
    await page.keyboard.press("F10")
    await expect(menu).toBeVisible()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+Alt+H")
    await expect(menu).toBeHidden()

    await page.locator(".cm-content").click()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-focused/)
    await page.keyboard.press("Alt+E")
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    const findSubmenu = page
      .locator('[data-slot="menubar-sub-trigger"]')
      .filter({ hasText: "Find" })
    await findSubmenu.hover()
    await expect(findSubmenu).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("ArrowLeft")
    await expect(findSubmenu).toHaveAttribute("aria-expanded", "false")
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await page.keyboard.press("ArrowRight")
    await expect(
      menu.getByRole("menuitem", { name: "Format" })
    ).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("ArrowRight")
    await expect(menu.getByRole("menuitem", { name: "View" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await page.keyboard.press("Escape")
    await page.waitForTimeout(200)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-focused/)

    await page.getByRole("button", { name: "Settings" }).focus()
    await page.evaluate(() => {
      const dispatch = (type: "keydown" | "keyup", key: string) =>
        window.dispatchEvent(
          new KeyboardEvent(type, { bubbles: true, cancelable: true, key })
        )
      dispatch("keydown", "Alt")
      dispatch("keyup", "Alt")
      dispatch("keydown", "ArrowRight")
      dispatch("keydown", "ArrowRight")
    })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: "Format" })).toBeDisabled()
    await expect(menu.locator("button[data-active]")).toHaveText("View")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Alt+E")
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await page.keyboard.press("ArrowRight")
    await expect(menu.getByRole("menuitem", { name: "View" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await page.keyboard.press("Escape")

    await page.keyboard.press("Alt")
    await expect(menu).toBeVisible()
    const blankChromePoint = await menu.evaluate((element) => ({
      x: Math.min(innerWidth - 150, element.getBoundingClientRect().right + 30),
      y: 23,
    }))
    await page.mouse.click(blankChromePoint.x, blankChromePoint.y)
    await expect(menu).toBeHidden()

    await page.locator(".cm-content").click()
    await page.keyboard.press("Alt+E")
    await page
      .locator('[data-slot="menubar-item"]')
      .filter({ hasText: "Select All" })
      .click()
    await expect(menu).toBeHidden()
    const replacement = "Renderer menu focus restored"
    await page.keyboard.insertText(replacement)
    await expect(page.locator(".cm-content")).toHaveText(replacement)

    const zoomBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
    )
    await page.keyboard.press("Alt+V")
    await page
      .locator('[data-slot="menubar-item"]')
      .filter({ hasText: "Zoom In" })
      .click()
    await expect(menu).toBeHidden()
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
        )
      )
      .toBeGreaterThan(zoomBefore ?? 0)

    await setWindowContentSize(app, 480, 320)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeCloseTo(240, 0)
    await page.keyboard.press("Alt")
    await expect(menu).toBeVisible()
    await page.keyboard.press("End")
    const helpMenu = menu.getByRole("menuitem", { name: "Help" })
    await expect(helpMenu).toHaveAttribute("data-active", "true")
    await expect
      .poll(() =>
        menu.evaluate((strip) => {
          const button = strip.querySelector<HTMLElement>(
            ".windows-menu-item[data-active]"
          )
          if (!button) throw new Error("The active menu item is unavailable")
          const stripBounds = strip.getBoundingClientRect()
          const buttonBounds = button.getBoundingClientRect()
          return (
            buttonBounds.left >= stripBounds.left - 0.5 &&
            buttonBounds.right <= stripBounds.right + 0.5
          )
        })
      )
      .toBe(true)

    await page.keyboard.press("Escape")
    await page.keyboard.press("Alt+H")
    await expect(helpMenu).toHaveAttribute("aria-expanded", "true")
    await expect(
      page.locator('[data-slot="menubar-content"][data-open]')
    ).toBeVisible()

    await page.keyboard.press("ArrowLeft")
    const windowMenu = menu.getByRole("menuitem", { name: "Window" })
    await expect(windowMenu).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("ArrowRight")
    await expect(helpMenu).toHaveAttribute("aria-expanded", "true")

    const fileMenu = menu.getByRole("menuitem", { name: "File" })
    await fileMenu.hover()
    await expect(fileMenu).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()

    await page.locator(".cm-content").click()
    await page.keyboard.press("Shift+F10")
    await expect(menu).toBeHidden()
    const editorContextMenu = page.getByRole("menu", {
      name: "Editor context menu",
    })
    await expect(editorContextMenu).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(editorContextMenu).toBeHidden()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("desktop app controls share the narrow formatting lane without covering document chrome @renderer-isolated", async () => {
  test.skip(process.platform === "darwin", "Desktop application chrome only")
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-windows-control-lane-")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const appShell = page.locator(".app-shell")
    const controls = page.locator(".top-chrome-controls")
    const tabStrip = page.locator(".document-tab-strip")

    await page.mouse.move(400, 200)
    await expect(controls).toHaveCSS("opacity", "0")
    const restingTabRightInset = await tabStrip.evaluate(
      (element) => innerWidth - element.getBoundingClientRect().right
    )
    await page.mouse.move(200, 4)
    await expect(controls).toHaveCSS("opacity", "1")
    const wideGeometry = await page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>(
        ".top-chrome-controls"
      )
      const tabs = document.querySelector<HTMLElement>(".document-tab-strip")
      if (!controls || !tabs) throw new Error("Top chrome is unavailable")
      const controlsBounds = controls.getBoundingClientRect()
      const tabBounds = tabs.getBoundingClientRect()
      return {
        controlsBottom: controlsBounds.bottom,
        controlsRightInset: innerWidth - controlsBounds.right,
        tabLeft: tabBounds.left,
        tabRightInset: innerWidth - tabBounds.right,
        tabToControlsGap: controlsBounds.left - tabBounds.right,
      }
    })
    expect(wideGeometry.controlsBottom).toBeLessThanOrEqual(46)
    expect(wideGeometry.controlsRightInset).toBeCloseTo(146, 0)
    expect(wideGeometry.tabLeft).toBeCloseTo(8, 0)
    expect(wideGeometry.tabRightInset).toBeCloseTo(restingTabRightInset, 0)
    expect(wideGeometry.tabToControlsGap).toBeCloseTo(8, 0)

    await setWindowContentSize(app, 480, 320)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480)
    await expect(appShell).toHaveAttribute(
      "data-windows-controls-drawer",
      "true"
    )
    await expect
      .poll(() =>
        page
          .locator(".editor-mount")
          .evaluate((element) => getComputedStyle(element).clipPath)
      )
      .toBe("inset(74px 0px 0px)")
    await page.mouse.move(240, 200)
    await expect(controls).toHaveCSS("opacity", "0")
    await page.mouse.move(160, 60)
    await expect(controls).toHaveCSS("opacity", "1")
    const narrowGeometry = await page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>(
        ".top-chrome-controls"
      )
      const editor = document.querySelector<HTMLElement>(".editor-mount")
      const content = document.querySelector<HTMLElement>(".cm-content")
      const tabs = document.querySelector<HTMLElement>(".document-tab-strip")
      if (!controls || !editor || !content || !tabs) {
        throw new Error("Narrow chrome is unavailable")
      }
      const controlsBounds = controls.getBoundingClientRect()
      const tabBounds = tabs.getBoundingClientRect()
      return {
        contentPaddingTop: Number.parseFloat(
          getComputedStyle(content).paddingTop
        ),
        controlsBottom: controlsBounds.bottom,
        controlsRightInset: innerWidth - controlsBounds.right,
        controlsTop: controlsBounds.top,
        editorClipPath: getComputedStyle(editor).clipPath,
        tabLeft: tabBounds.left,
        tabRightInset: innerWidth - tabBounds.right,
      }
    })
    expect(narrowGeometry.controlsTop).toBeCloseTo(41, 0)
    expect(narrowGeometry.controlsBottom).toBeCloseTo(71, 0)
    expect(narrowGeometry.controlsRightInset).toBeCloseTo(8, 0)
    expect(narrowGeometry.editorClipPath).toBe("inset(74px 0px 0px)")
    expect(narrowGeometry.contentPaddingTop).toBeCloseTo(86, 0)
    expect(narrowGeometry.tabLeft).toBeCloseTo(8, 0)
    expect(narrowGeometry.tabRightInset).toBeCloseTo(146, 0)

    const settingsControl = page.getByRole("button", {
      name: "Settings",
      exact: true,
    })
    const controlsMenu = page.getByRole("menu", {
      name: "Top-right controls menu",
    })
    await settingsControl.click({ button: "right" })
    await expect(controlsMenu).toBeVisible()
    await page.mouse.click(24, 60)
    await expect(controlsMenu).toHaveCount(0)

    await page.keyboard.press(`${primaryModifier}+F`)
    const search = page.getByRole("form", {
      name: "Find and replace in document",
    })
    await expect(search).toHaveAttribute("data-search-overlay-state", "ready")
    await expect
      .poll(() =>
        search.evaluate((element) => element.getBoundingClientRect().top)
      )
      .toBeCloseTo(78, 0)
    await page.keyboard.press("Escape")

    await page.keyboard.press(`${primaryModifier}+Shift+B`)
    const toolbar = page.locator(".formatting-toolbar[data-visible]")
    await expect(toolbar).toBeVisible()
    const sharedLaneGap = await page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>(
        ".top-chrome-controls"
      )
      const toolbar = document.querySelector<HTMLElement>(
        ".formatting-toolbar[data-visible]"
      )
      if (!controls || !toolbar) throw new Error("Shared lane is unavailable")
      return (
        controls.getBoundingClientRect().left -
        toolbar.getBoundingClientRect().right
      )
    })
    expect(sharedLaneGap).toBeCloseTo(8, 0)

    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    await page.mouse.move(80, 4)
    const documentActions = page.getByRole("button", {
      name: "Document actions",
    })
    await expect(documentActions).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Settings", exact: true })
    ).toBeVisible()
    for (const name of [
      "Switch to Raw Markdown",
      "Find",
      "Document outline",
      "Formatting toolbar",
    ]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeHidden()
    }
    const compactGeometry = await page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>(
        ".top-chrome-controls"
      )
      const editor = document.querySelector<HTMLElement>(".editor-mount")
      const toolbar = document.querySelector<HTMLElement>(
        ".formatting-toolbar[data-visible]"
      )
      if (!controls || !editor || !toolbar) {
        throw new Error("Compact shared lane is unavailable")
      }
      const controlsBounds = controls.getBoundingClientRect()
      const toolbarBounds = toolbar.getBoundingClientRect()
      return {
        controlsRightInset: innerWidth - controlsBounds.right,
        editorClipPath: getComputedStyle(editor).clipPath,
        laneGap: controlsBounds.left - toolbarBounds.right,
      }
    })
    expect(compactGeometry.controlsRightInset).toBeCloseTo(8, 0)
    expect(compactGeometry.editorClipPath).toBe("inset(74px 0px 0px)")
    expect(compactGeometry.laneGap).toBeCloseTo(8, 0)

    // Keep the tab strip referenced so a missing responsive tab layout cannot
    // be masked by the control-lane assertions above.
    await expect(tabStrip).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("desktop editor scrollbar clears overlay chrome and stays rail-less @renderer-isolated", async () => {
  test.skip(process.platform === "darwin", "Desktop scrollbar styling only")
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-windows-scrollbar-")
  )
  const documentPath = path.join(userData, "scrollbar.md")
  await writeFile(
    documentPath,
    Array.from({ length: 400 }, (_, index) => `Line ${index + 1}`).join("\n"),
    "utf8"
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const scroller = page.locator(".editor-mount .cm-scroller")
    await scroller.waitFor()
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight > element.clientHeight
        )
      )
      .toBe(true)

    const scrollbarStyles = () =>
      scroller.evaluate((element) => {
        const scrollbar = getComputedStyle(element, "::-webkit-scrollbar")
        const track = getComputedStyle(element, "::-webkit-scrollbar-track")
        const thumb = getComputedStyle(element, "::-webkit-scrollbar-thumb")
        const button = getComputedStyle(element, "::-webkit-scrollbar-button")
        const editorMount = element.closest<HTMLElement>(".editor-mount")
        if (!editorMount) throw new Error("Editor mount is unavailable")
        const elementStyle = getComputedStyle(element)
        const editorStyle = getComputedStyle(editorMount)
        return {
          buttonDisplay: button.display,
          buttonHeight: button.height,
          buttonWidth: button.width,
          clipPath: editorStyle.clipPath,
          scrollbarColor: elementStyle.scrollbarColor,
          scrollbarWidth: elementStyle.scrollbarWidth,
          thumbBackground: thumb.backgroundColor,
          trackBackground: track.backgroundColor,
          width: scrollbar.width,
        }
      })

    const ordinary = await scrollbarStyles()
    expect(ordinary.clipPath).toBe("inset(0px)")
    expect(ordinary.scrollbarColor).toBe("auto")
    expect(ordinary.scrollbarWidth).toBe("auto")
    expect(ordinary.width).toBe("10px")
    expect(ordinary.trackBackground).toBe("rgba(0, 0, 0, 0)")
    expect(ordinary.buttonDisplay).toBe("none")
    expect(ordinary.buttonWidth).toBe("0px")
    expect(ordinary.buttonHeight).toBe("0px")
    expect(ordinary.thumbBackground).not.toBe("rgba(0, 0, 0, 0)")

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const scrollerBounds = await scroller.boundingBox()
    if (!scrollerBounds) throw new Error("Editor scroller is unavailable")
    const scrollbarX = scrollerBounds.x + scrollerBounds.width - 5
    // Stay above the status overlay's bottom reveal lane while grabbing the
    // bottom-positioned native thumb.
    const scrollbarY = scrollerBounds.y + scrollerBounds.height - 34
    const initialScrollTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    await page.mouse.move(scrollbarX, scrollbarY)
    await page.mouse.down()
    await page.mouse.move(scrollbarX, scrollbarY - 30, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(initialScrollTop)
    await expect
      .poll(() =>
        scroller.evaluate((element) => document.activeElement === element)
      )
      .toBe(true)
    await page.keyboard.down("Shift")
    try {
      await expect
        .poll(() =>
          scroller.evaluate((element) => element.matches(":focus-visible"))
        )
        .toBe(true)
      await expect
        .poll(() =>
          scroller.evaluate((element) => getComputedStyle(element).outlineStyle)
        )
        .toBe("none")
    } finally {
      await page.keyboard.up("Shift")
    }

    const scrollbarRules = await page.evaluate(() => {
      const matched: Array<{ cssText: string; selector: string }> = []
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (
            rule instanceof CSSStyleRule &&
            rule.selectorText.includes(".cm-scroller::-webkit-scrollbar")
          ) {
            matched.push({
              cssText: rule.style.cssText,
              selector: rule.selectorText,
            })
          } else if ("cssRules" in rule) {
            try {
              visit((rule as CSSGroupingRule).cssRules)
            } catch {
              // Cross-origin sheets are irrelevant to the packaged renderer.
            }
          }
        }
      }
      for (const sheet of document.styleSheets) {
        try {
          visit(sheet.cssRules)
        } catch {
          // Cross-origin sheets are irrelevant to the packaged renderer.
        }
      }
      return matched
    })
    expect(
      scrollbarRules.find(({ selector }) =>
        selector.endsWith("::-webkit-scrollbar-track:vertical")
      )?.cssText
    ).toContain("var(--window-chrome-height")
    expect(
      scrollbarRules.find(
        ({ selector, cssText }) =>
          selector.endsWith("::-webkit-scrollbar-thumb") &&
          cssText.includes("24%")
      )
    ).toBeDefined()
    expect(
      scrollbarRules.find(
        ({ selector, cssText }) =>
          selector.endsWith("::-webkit-scrollbar-thumb:hover") &&
          cssText.includes("48%")
      )
    ).toBeDefined()

    await setWindowContentSize(app, 600, 320)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(600)
    await scroller.evaluate((element) => {
      element.scrollTo({ behavior: "auto", top: 700 })
    })
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeCloseTo(700, 0)
    await expect
      .poll(() =>
        scroller.evaluate((element) => {
          const targetY = element.getBoundingClientRect().top + 100
          return Array.from(
            element.querySelectorAll<HTMLElement>(".cm-line")
          ).some((candidate) => {
            const bounds = candidate.getBoundingClientRect()
            return bounds.top <= targetY && bounds.bottom > targetY
          })
        })
      )
      .toBe(true)
    const readingAnchor = await scroller.evaluate((element) => {
      const targetY = element.getBoundingClientRect().top + 100
      const line = Array.from(
        element.querySelectorAll<HTMLElement>(".cm-line")
      ).find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return bounds.top <= targetY && bounds.bottom > targetY
      })
      if (!line) throw new Error("No reading-position anchor is mounted")
      return {
        text: line.textContent,
        top: line.getBoundingClientRect().top,
      }
    })

    await setWindowContentSize(app, 480, 320)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480)
    await expect
      .poll(() =>
        scroller.evaluate((element, anchor) => {
          const line = Array.from(
            element.querySelectorAll<HTMLElement>(".cm-line")
          ).find((candidate) => candidate.textContent === anchor.text)
          return line ? line.getBoundingClientRect().top : null
        }, readingAnchor)
      )
      .toBeCloseTo(readingAnchor.top, 0)

    await page.keyboard.press(`${primaryModifier}+Shift+B`)
    await expect(page.locator(".formatting-toolbar")).toBeVisible()
    await expect
      .poll(async () => (await scrollbarStyles()).clipPath)
      .toBe("inset(74px 0px 0px)")

    await page.mouse.move(200, 1)
    const revealRegion = page.locator(".status-overlay-reveal-region")
    const revealBounds = await revealRegion.boundingBox()
    if (!revealBounds) throw new Error("Status reveal region is unavailable")
    await page.mouse.move(
      revealBounds.x + revealBounds.width / 2,
      revealBounds.y + revealBounds.height / 2
    )
    await expect(page.locator(".status-overlay")).toBeVisible()
    await expect
      .poll(async () => (await scrollbarStyles()).clipPath)
      .toBe("inset(74px 0px 28px)")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

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
            const drawer = document.querySelector<HTMLElement>(
              ".top-chrome-tab-drag-shelf"
            )
            const boundary =
              toolbar ??
              (drawer &&
              chrome &&
              drawer.getBoundingClientRect().bottom >
                chrome.getBoundingClientRect().bottom
                ? drawer
                : chrome)
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
