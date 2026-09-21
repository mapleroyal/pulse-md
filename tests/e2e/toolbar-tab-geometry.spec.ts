import type { EditorView } from "@codemirror/view"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test"

import { DEFAULT_APP_SETTINGS } from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const longDocument = [
  "# Project notebook",
  "",
  ...Array.from({ length: 24 }, (_, index) =>
    [
      `## Work session ${index + 1}`,
      "",
      `Reading marker ${index + 1}: keep this paragraph steady while changing tabs.`,
      "",
      "> [!Note] Session checklist",
      "> - [x] Collect the materials",
      "> - [ ] Review the draft",
      ">",
      "> > [!Tip] Follow-up",
      "> > Keep the next step small.",
      "",
      `Closing paragraph ${index + 1} with enough text to exercise the document viewport.`,
      "",
    ].join("\n")
  ),
].join("\n")
const shortDocument = "# Quick note\n\nRemember the next step.\n"

type GeometrySample = {
  anchorTop: number | null
  firstLineTop: number | null
  paddingTop: number
  paddingAnimating: boolean
  toolbarBottom: number | null
}

async function launchNotebook(toolbarInitiallyVisible = true) {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-toolbar-geometry-e2e-")
  )
  const notebook = path.join(userData, "notebook.md")
  const note = path.join(userData, "note.md")
  await Promise.all([
    writeFile(notebook, longDocument),
    writeFile(note, shortDocument),
    writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        chrome: {
          ...DEFAULT_APP_SETTINGS.chrome,
          showFormattingBar: toolbarInitiallyVisible,
          tabVisibility: "always",
        },
      })
    ),
  ])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, notebook, note],
    cwd: projectRoot,
  })
  const page = await app.firstWindow()
  if (toolbarInitiallyVisible) {
    await expect(page.locator(".formatting-toolbar")).toHaveCSS("opacity", "1")
  }
  await expect(page.getByRole("tab")).toHaveCount(2)
  await page
    .getByRole("tab")
    .first()
    .evaluate((element) => {
      ;(element as HTMLElement).click()
    })
  await expect(page.locator(".cm-content")).toContainText("Project notebook")
  await expect(page.locator(".cm-md-callout").first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  return { app, page, userData }
}

async function captureReadingAnchor(page: Page, scrollTop: number | "bottom") {
  return page.locator(".cm-content").evaluate(async (element, target) => {
    const view = (element as HTMLElement & { cmTile?: { view?: EditorView } })
      .cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    view.scrollDOM.scrollTop =
      target === "bottom" ? view.scrollDOM.scrollHeight : target
    // Let CodeMirror materialize the target viewport before retaining a line.
    for (let frame = 0; frame < 4; frame += 1) {
      if (target === "bottom") {
        view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
    }
    const bounds = view.scrollDOM.getBoundingClientRect()
    const position =
      target === "bottom"
        ? view.state.doc.length - 2
        : view.posAtCoords({
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          })
    if (position == null) throw new Error("Reading position is unavailable")
    const coordinates = view.coordsAtPos(position)
    if (!coordinates) throw new Error("Reading line is unavailable")
    return {
      position,
      top: coordinates.top,
      scrollTop: view.scrollDOM.scrollTop,
      maxScrollTop: view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight,
    }
  }, scrollTop)
}

async function beginGeometrySampling(
  page: Page,
  targetTitle: string,
  position: number
) {
  await page.evaluate(
    ({ targetTitle, position }) => {
      const testWindow = window as typeof window & {
        toolbarGeometrySamples?: Promise<GeometrySample[]>
      }
      testWindow.toolbarGeometrySamples = new Promise((resolve, reject) => {
        const samples: GeometrySample[] = []
        const deadline = performance.now() + 5_000
        let started: number | null = null
        const sample = (time: number) => {
          const content = document.querySelector<HTMLElement>(".cm-content")
          const view = (
            content as (HTMLElement & { cmTile?: { view?: EditorView } }) | null
          )?.cmTile?.view
          if (content && view?.state.doc.line(1).text === targetTitle) {
            started ??= time
            const toolbar = document.querySelector<HTMLElement>(
              ".formatting-toolbar[data-visible]"
            )
            samples.push({
              anchorTop: view.coordsAtPos(position)?.top ?? null,
              firstLineTop:
                content.querySelector(".cm-line")?.getBoundingClientRect()
                  .top ?? null,
              paddingTop: Number.parseFloat(
                getComputedStyle(content).paddingTop
              ),
              paddingAnimating: content
                .getAnimations()
                .some((animation) =>
                  (animation.effect as KeyframeEffect | null)
                    ?.getKeyframes()
                    .some((keyframe) => keyframe.paddingTop != null)
                ),
              toolbarBottom: toolbar?.getBoundingClientRect().bottom ?? null,
            })
            // Cover the former 150 ms transition at any display refresh rate.
            if (time - started >= 300 && samples.length >= 10) {
              resolve(samples)
              return
            }
          }
          if (time > deadline) {
            reject(
              new Error("The target document did not produce geometry samples")
            )
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
    },
    { targetTitle, position }
  )
}

async function collectedGeometry(page: Page) {
  return page.evaluate(async () => {
    const samples = (
      window as typeof window & {
        toolbarGeometrySamples?: Promise<GeometrySample[]>
      }
    ).toolbarGeometrySamples
    if (!samples) throw new Error("Geometry sampling was not started")
    return samples
  })
}

async function activateTab(tab: Locator) {
  await tab.click()
}

function expectStableReadingLine(
  samples: GeometrySample[],
  expectedTop: number
) {
  expect(samples.length).toBeGreaterThanOrEqual(10)
  expect(samples.some((sample) => sample.paddingAnimating)).toBe(false)
  // The initial CM measurement can materialize a replacement; subsequent
  // animation frames must preserve the same source line, including its offset.
  for (const sample of samples.slice(1)) {
    expect(sample.anchorTop).not.toBeNull()
    expect(Math.abs(sample.anchorTop! - expectedTop)).toBeLessThanOrEqual(1.5)
  }
}

async function toggleFormattingBar(app: ElectronApplication) {
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(
      "view-formatting-bar"
    )
    const window = BrowserWindow.getAllWindows()[0]
    if (!item || !window)
      throw new Error("Formatting toolbar command is unavailable")
    item.click(undefined, window, undefined)
  })
}

for (const toolbarInitiallyVisible of [true, false]) {
  test(`returning to a scrolled notebook retains its reading line with the toolbar ${toolbarInitiallyVisible ? "open at launch" : "enabled after launch"}`, async () => {
    const { app, page, userData } = await launchNotebook(
      toolbarInitiallyVisible
    )
    try {
      if (!toolbarInitiallyVisible) {
        await toggleFormattingBar(app)
        await expect(page.locator(".formatting-toolbar")).toHaveCSS(
          "opacity",
          "1"
        )
      }
      for (const scrollTop of [300, 900]) {
        const anchor = await captureReadingAnchor(page, scrollTop)
        expect(anchor.scrollTop).toBeGreaterThan(0)
        await activateTab(page.getByRole("tab").nth(1))
        await expect(page.locator(".cm-content")).toContainText(
          "Remember the next step"
        )
        await beginGeometrySampling(page, "# Project notebook", anchor.position)
        await activateTab(page.getByRole("tab").first())
        const samples = await collectedGeometry(page)
        expectStableReadingLine(samples, anchor.top)
        const padding = samples.map((sample) => sample.paddingTop)
        expect(Math.max(...padding) - Math.min(...padding)).toBeLessThanOrEqual(
          0.5
        )
      }
    } finally {
      await exitApplication(app)
      await rm(userData, { recursive: true, force: true })
    }
  })
}

test("returning to a short note clears the toolbar and collapsing it preserves the scrolled notebook", async () => {
  const { app, page, userData } = await launchNotebook(false)
  try {
    // Retain the note while the toolbar is off, without opening the hover
    // shelf. A previously uncompensated top edge needs space when revisited.
    await page.mouse.move(400, 400)
    await page.locator(".cm-content").focus()
    await page.keyboard.press("Control+Tab")
    await expect(page.locator(".cm-content")).toContainText(
      "Remember the next step"
    )
    await expect(page.locator(".app-shell")).not.toHaveAttribute(
      "data-top-drawer-compensated"
    )
    await page.keyboard.press("Control+Shift+Tab")
    await expect(page.locator(".cm-content")).toContainText("Project notebook")
    await toggleFormattingBar(app)
    await expect(page.locator(".formatting-toolbar")).toHaveCSS("opacity", "1")
    const anchor = await captureReadingAnchor(page, 500)

    await beginGeometrySampling(page, "# Quick note", 0)
    await activateTab(page.getByRole("tab").nth(1))
    const noteSamples = await collectedGeometry(page)
    expect(noteSamples.length).toBeGreaterThanOrEqual(10)
    for (const sample of noteSamples) {
      expect(sample.paddingAnimating).toBe(false)
      expect(sample.firstLineTop).not.toBeNull()
      expect(sample.toolbarBottom).not.toBeNull()
      expect(sample.firstLineTop!).toBeGreaterThanOrEqual(sample.toolbarBottom!)
    }

    await activateTab(page.getByRole("tab").first())
    await expect(page.locator(".cm-content")).toContainText("Project notebook")
    await beginGeometrySampling(page, "# Project notebook", anchor.position)
    await toggleFormattingBar(app)
    expectStableReadingLine(await collectedGeometry(page), anchor.top)
    await expect(page.locator(".formatting-toolbar")).toHaveCount(0)

    // At the exact bottom Chromium clamps scrollTop as the padding shrinks.
    // Collapse must not subtract the removed padding a second time.
    await captureReadingAnchor(page, 0)
    await toggleFormattingBar(app)
    await expect(page.locator(".formatting-toolbar")).toHaveCSS("opacity", "1")
    const bottomAnchor = await captureReadingAnchor(page, "bottom")
    expect(
      Math.abs(bottomAnchor.scrollTop - bottomAnchor.maxScrollTop)
    ).toBeLessThanOrEqual(0.5)
    await beginGeometrySampling(
      page,
      "# Project notebook",
      bottomAnchor.position
    )
    await toggleFormattingBar(app)
    expectStableReadingLine(await collectedGeometry(page), bottomAnchor.top)
    await expect(page.locator(".formatting-toolbar")).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
