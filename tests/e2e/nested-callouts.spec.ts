import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { EditorView } from "@codemirror/view"
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test"

import { ipcChannels } from "../../electron/channels"
import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(import.meta.dirname, "../..")
const source = [
  "# TODO",
  "",
  "> [!Appointments]",
  "> > [!Dental]-",
  "> > Morning appointment",
  "> > address",
  ">",
  "> > [!TCCC]",
  "> > Afternoon appointment",
  "> > Room 1001",
  "",
  "After",
].join("\n")

type EditorContent = HTMLElement & { cmTile?: { view?: EditorView } }

async function selectionSnapshot(page: Page) {
  return page.locator(".cm-content").evaluate((content) => {
    const view = (content as EditorContent).cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    const { anchor, head, empty, from, to } = view.state.selection.main
    return {
      anchor,
      head,
      empty,
      from,
      to,
      selected: view.state.sliceDoc(from, to),
      document: view.state.doc.toString(),
    }
  })
}

async function sourcePoint(page: Page, position: number) {
  return page.locator(".cm-content").evaluate((content, pos) => {
    const view = (content as EditorContent).cmTile?.view
    const bounds = view?.coordsAtPos(pos)
    if (!bounds) throw new Error("Source caret coordinates are unavailable")
    return { x: bounds.left, y: (bounds.top + bounds.bottom) / 2 }
  }, position)
}

async function clickSourceAt(page: Page, position: number) {
  const point = await sourcePoint(page, position)
  await page.mouse.click(point.x, point.y)
  await expect
    .poll(() => selectionSnapshot(page))
    .toMatchObject({
      anchor: position,
      head: position,
      empty: true,
    })
}

let userData: string
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-nested-callouts-"))
  const filePath = path.join(userData, "appointments.md")
  await writeFile(filePath, source)
  app = await electron.launch({
    args: [
      projectRoot,
      `--user-data-dir=${userData}`,
      ...(process.platform === "linux" && process.env.XDG_SESSION_TYPE === "x11"
        ? ["--ozone-platform=x11"]
        : []),
      filePath,
    ],
    cwd: projectRoot,
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.locator(".cm-editor").waitFor()
  await page.keyboard.press("Escape")
})

test.afterEach(async () => {
  if (app) await exitApplication(app)
  if (userData) await rm(userData, { recursive: true, force: true })
})

test("nested callout source accepts a caret after preview selection @renderer-isolated", async () => {
  const parent = page.locator(
    '.cm-md-callout[data-callout-type="appointments"]'
  )
  const tccc = parent.locator('.cm-md-callout[data-callout-type="tccc"]')
  const nestedFrom = source.indexOf("> > [!TCCC]")
  const calloutTo = source.indexOf("\n\nAfter")
  const caret = source.indexOf("Room 1001") + "Room ".length

  await tccc.locator(".cm-md-callout-body .cm-line").last().click()
  await expect
    .poll(() => selectionSnapshot(page))
    .toMatchObject({
      from: nestedFrom,
      to: calloutTo,
      selected: source.slice(nestedFrom, calloutTo),
    })
  await expect(tccc).toHaveCount(0)
  await expect(parent).toHaveCount(1)

  // The remaining parent card must yield clicks on its child's exposed source.
  await clickSourceAt(page, caret)
  const wordFrom = source.indexOf("Room 1001")
  const dragStart = await sourcePoint(page, wordFrom)
  const dragEnd = await sourcePoint(page, wordFrom + "Room".length)
  await page.mouse.move(dragStart.x, dragStart.y)
  await page.mouse.down()
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(() => selectionSnapshot(page))
    .toMatchObject({ from: wordFrom, to: wordFrom + 4, selected: "Room" })
  await expect(parent).toHaveCount(1)
  await clickSourceAt(page, caret)
  await page.keyboard.type("9")
  await expect
    .poll(() => selectionSnapshot(page))
    .toMatchObject({
      document: source.slice(0, caret) + "9" + source.slice(caret),
      head: caret + 1,
      empty: true,
    })
  await page.keyboard.press("ControlOrMeta+z")
  await expect
    .poll(() => selectionSnapshot(page))
    .toMatchObject({ document: source })
  await page.keyboard.press("Escape")
  await expect(tccc).toHaveCount(1)

  // Both selection directions expose the complete parent, including the last
  // nested child at its endpoint and the initially folded sibling.
  const parentFrom = source.indexOf("> [!Appointments]")
  for (const [anchor, head] of [
    [parentFrom, calloutTo],
    [calloutTo, parentFrom],
  ]) {
    // Escape hides the caret independently of DOM focus. Resume editing
    // through a real source click before selecting the parent range.
    await page
      .locator(".cm-line")
      .filter({ hasText: /^After$/ })
      .click()
    await page.locator(".cm-content").evaluate(
      (content, selection) => {
        const view = (content as EditorContent).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        view.focus()
        view.dispatch({ selection })
      },
      { anchor: anchor!, head: head! }
    )
    await expect(page.locator(".cm-md-callout")).toHaveCount(0)
    await expect
      .poll(() => selectionSnapshot(page))
      .toMatchObject({
        anchor,
        head,
        selected: source.slice(parentFrom, calloutTo),
      })
    await clickSourceAt(page, caret)
    await page.keyboard.press("Escape")
    await expect(tccc).toHaveCount(1)
  }
})

test("nested sibling callouts retain titles, folding, and visible boundaries @renderer-isolated", async () => {
  const parent = page.locator(
    '.cm-md-callout[data-callout-type="appointments"]'
  )
  const dental = parent.locator('.cm-md-callout[data-callout-type="dental"]')
  const tccc = parent.locator('.cm-md-callout[data-callout-type="tccc"]')
  const dentalToggle = dental.getByRole("button", { name: /Dental/ })
  const tcccTitle = tccc.locator(".cm-md-callout-title")
  const expectCompactSpacing = () =>
    expect
      .poll(() =>
        parent.evaluate((element) => {
          const first = element.querySelector('[data-callout-type="dental"]')!
          const second = element.querySelector('[data-callout-type="tccc"]')!
          const header = element.querySelector(
            ":scope > .cm-md-callout-header-line"
          )!
          const inset = Number.parseFloat(getComputedStyle(element).paddingLeft)
          return Math.max(
            Math.abs(
              second.getBoundingClientRect().top -
                first.getBoundingClientRect().bottom -
                inset
            ),
            Math.abs(
              first.getBoundingClientRect().top -
                header.getBoundingClientRect().bottom -
                inset
            )
          )
        })
      )
      .toBeLessThanOrEqual(0.5)

  await expect(tcccTitle).toHaveText(/^TCCC$/i)
  await expect(tcccTitle).toHaveCSS("font-weight", "600")
  await expect(tccc.locator(".cm-md-callout-toggle")).toHaveCount(0)
  await expect(dentalToggle).toHaveAttribute("aria-expanded", "false")
  await expect(dental).not.toContainText("Morning appointment")
  await expect(tccc).toContainText("Room 1001")
  await expectCompactSpacing()

  await dentalToggle.click()
  await expect(dentalToggle).toHaveAttribute("aria-expanded", "true")
  await expect(dental).toContainText("Morning appointment")
  await expect(tccc).toContainText("Room 1001")
  await expect(dental.locator('[data-callout-type="tccc"]')).toHaveCount(0)
  await expectCompactSpacing()
  await dentalToggle.click()
  await expect(dentalToggle).toHaveAttribute("aria-expanded", "false")
  await expect(dental).not.toContainText("Morning appointment")
  await expect(tccc).toContainText("Room 1001")
  await expectCompactSpacing()

  for (const appearanceMode of ["light", "dark"] as const) {
    for (const backgroundEffect of [
      { enabled: false, translucentCallouts: true },
      { enabled: true, translucentCallouts: false },
      { enabled: true, translucentCallouts: true },
    ]) {
      const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
      settings.appearanceMode = appearanceMode
      Object.assign(settings.backgroundEffect, backgroundEffect)
      const snapshot = await page.evaluate(
        (next) => window.pulseMd.setSettings(next),
        settings
      )
      // The Settings UI applies its own returned snapshot. Direct test commits
      // need the same renderer update, since broadcasts skip the source window.
      await app.evaluate(
        ({ BrowserWindow }, { channel, snapshot }) => {
          BrowserWindow.getAllWindows()[0]!.webContents.send(channel, snapshot)
        },
        { channel: ipcChannels.settingsChanged, snapshot }
      )
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`\\b${appearanceMode}\\b`)
      )
      await expect(page.locator("html")).toHaveAttribute(
        "data-background-effect",
        backgroundEffect.enabled ? "translucent" : "opaque"
      )
      for (const child of [tccc, dental]) {
        await expect(child).toHaveCSS("box-shadow", "none")
        await expect(child).toHaveCSS("outline-style", "none")
        await expect(child).toHaveCSS("border-top-width", "0px")
        const layers = await child.evaluate((element) => {
          const parent = element.parentElement!.closest(".cm-md-callout")!
          const canvas = document.createElement("canvas")
          canvas.width = canvas.height = 1
          const context = canvas.getContext("2d")!
          const paint = (color: string) => {
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            return [...context.getImageData(0, 0, 1, 1).data]
          }
          paint(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--document-background"
            )
          )
          const parentPixel = paint(getComputedStyle(parent).backgroundColor)
          const childPixel = paint(getComputedStyle(element).backgroundColor)
          context.clearRect(0, 0, 1, 1)
          const alpha = paint(getComputedStyle(element).backgroundColor)[3]!
          return { alpha, childPixel, parentPixel }
        })
        expect(layers.alpha).toBeGreaterThan(0)
        expect(layers.alpha).toBeLessThan(255)
        expect(layers.childPixel).not.toEqual(layers.parentPixel)
      }
      await expect(tccc).toContainText("Room 1001")
    }
  }
})
