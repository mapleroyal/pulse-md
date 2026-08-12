import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { _electron as electron, expect, test } from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication, openSettingsSection } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const settingsShortcut = process.platform === "darwin" ? "Meta+," : "Control+,"

test("Mermaid SVG relationships, geometry, and theme refresh remain intact", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-mermaid-"))
  const filePath = path.join(userData, "mermaid.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "light"
  settings.markdownExtensions.mermaid = true
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  await writeFile(
    filePath,
    [
      "# Mermaid diagrams",
      "",
      "```mermaid",
      "flowchart LR",
      ...Array.from(
        { length: 120 },
        (_, index) => `%% retained source line ${index + 1}`
      ),
      "  Source[Markdown source] --> Parser[Incremental parser]",
      "  Parser --> Live[Live preview]",
      "  Parser --> Raw[Source mode]",
      "  Live --> Output[Static document view]",
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  participant U as User",
      "  participant E as Editor",
      "  participant P as Parser",
      "  U->>E: Edit Markdown",
      "  E->>P: Incremental update",
      "  P-->>E: Updated syntax tree",
      "  E-->>U: Refresh preview",
      "```",
      "",
      "```mermaid",
      "sankey-beta",
      "Source,Parser,10",
      "Source,Editor,6",
      "Parser,Output,10",
      "Editor,Output,6",
      "```",
      "",
      "```mermaid",
      "stateDiagram-v2",
      "  [*] --> Idle",
      "  Idle --> Active",
      "```",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  const pageErrors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on("pageerror", (error) => {
      pageErrors.push(error.message)
    })
    await app.evaluate(({ BrowserWindow }) => {
      // This test compares every occurrence at once. Keep the full fixture in
      // CodeMirror's draw margin instead of depending on cold height guesses.
      BrowserWindow.getAllWindows()[0]?.setSize(1_000, 1_400)
    })
    await page.locator(".cm-editor").waitFor()
    const diagrams = page.locator(".cm-md-mermaid")
    await expect(diagrams).toHaveCount(4)
    await expect(diagrams.locator("svg")).toHaveCount(4)
    await expect(page.locator('.cm-md-mermaid[aria-busy="true"]')).toHaveCount(
      0
    )

    const lightDiagnostics = await diagrams.evaluateAll((elements) =>
      elements.map((element) => {
        const svg = element.querySelector("svg")
        if (!(svg instanceof SVGSVGElement)) {
          throw new Error("Rendered Mermaid SVG is unavailable")
        }
        const markerReferences = [
          ...svg.querySelectorAll<SVGElement>("[marker-end]"),
        ].map((edge) => {
          const value = edge.getAttribute("marker-end") ?? ""
          const id = /^url\(#(.+)\)$/.exec(value)?.[1] ?? ""
          return {
            id,
            resolves:
              id.length > 0 && svg.querySelector(`#${CSS.escape(id)}`) != null,
          }
        })
        const nodes = [...svg.querySelectorAll<SVGGElement>("g.node")].map(
          (node) => {
            const shape = node.querySelector<SVGGraphicsElement>(
              ":scope > rect, :scope > circle, :scope > ellipse, :scope > polygon, :scope > path"
            )
            const label = node.querySelector<SVGGraphicsElement>("text")
            if (!shape || !label) return null
            const shapeBox = shape.getBBox()
            const labelBox = label.getBBox()
            return {
              fits:
                labelBox.x >= shapeBox.x - 1 &&
                labelBox.y >= shapeBox.y - 1 &&
                labelBox.x + labelBox.width <=
                  shapeBox.x + shapeBox.width + 1 &&
                labelBox.y + labelBox.height <=
                  shapeBox.y + shapeBox.height + 1,
            }
          }
        )
        const firstNode = svg.querySelector<SVGGraphicsElement>(
          "g.node > rect, g.node > circle, g.node > ellipse, g.node > polygon, g.node > path"
        )
        const hostBounds = element.getBoundingClientRect()
        const svgBounds = svg.getBoundingClientRect()
        const labelBounds = [
          ...svg.querySelectorAll<SVGGraphicsElement>("g.node text"),
        ].map((label) => {
          const bounds = label.getBoundingClientRect()
          return {
            fits:
              bounds.left >= svgBounds.left - 1 &&
              bounds.right <= svgBounds.right + 1 &&
              bounds.top >= svgBounds.top - 1 &&
              bounds.bottom <= svgBounds.bottom + 1,
          }
        })
        const paintedColors = [
          ...svg.querySelectorAll<SVGElement>("*"),
        ].flatMap((painted) => {
          const styles = getComputedStyle(painted)
          return [styles.color, styles.fill, styles.stroke]
        })
        const maxColorChroma = Math.max(
          0,
          ...paintedColors.map((color) => {
            const channels = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/.exec(
              color
            )
            if (!channels) return 0
            const values = channels.slice(1, 4).map(Number)
            return Math.max(...values) - Math.min(...values)
          })
        )
        return {
          fill: firstNode ? getComputedStyle(firstNode).fill : null,
          height: svg.getAttribute("height"),
          hostFitsViewport:
            hostBounds.left >= -1 &&
            hostBounds.right <= document.documentElement.clientWidth + 1,
          id: svg.id,
          labelBounds,
          markerReferences,
          maxColorChroma,
          nodes: nodes.filter((node) => node != null),
          rootStyleMatches: [...svg.querySelectorAll("style")].some((style) =>
            (style.textContent ?? "").includes(`#${svg.id}`)
          ),
          svgFitsHost:
            svgBounds.left >= hostBounds.left - 1 &&
            svgBounds.right <= hostBounds.right + 1,
          viewBox: svg.getAttribute("viewBox"),
          width: svg.getAttribute("width"),
        }
      })
    )

    expect(
      lightDiagnostics.every(({ id }) => id.startsWith("user-content-"))
    ).toBe(true)
    expect(
      lightDiagnostics.every(({ rootStyleMatches }) => rootStyleMatches)
    ).toBe(true)
    expect(
      lightDiagnostics
        .slice(0, 2)
        .every(
          ({ markerReferences }) =>
            markerReferences.length > 0 &&
            markerReferences.every(({ resolves }) => resolves)
        )
    ).toBe(true)
    expect(
      lightDiagnostics.every(
        ({ height, viewBox, width }) =>
          viewBox != null &&
          Number(width) > 0 &&
          Number(height) > 0 &&
          width !== "100%"
      )
    ).toBe(true)
    expect(lightDiagnostics[0]?.fill).not.toBe("rgb(0, 0, 0)")
    expect(
      lightDiagnostics.every(({ maxColorChroma }) => maxColorChroma <= 1)
    ).toBe(true)
    expect(lightDiagnostics[0]?.nodes.length).toBeGreaterThan(0)
    expect(lightDiagnostics[0]?.nodes.every(({ fits }) => fits)).toBe(true)
    expect(
      lightDiagnostics.every(
        ({ hostFitsViewport, labelBounds, svgFitsHost }) =>
          hostFitsViewport &&
          svgFitsHost &&
          labelBounds.every(({ fits }) => fits)
      )
    ).toBe(true)

    const firstDiagram = diagrams.first()
    const firstSvgId = await firstDiagram.locator("svg").getAttribute("id")
    await firstDiagram.evaluate((element) => {
      element.setAttribute("data-mount-sentinel", "retained")
    })
    await page.locator(".cm-content").evaluate((content) => {
      const view = (
        content as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                changes: { from: number; insert: string }
              }): void
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({ changes: { from: 0, insert: "Preface\n\n" } })
    })
    await expect(
      page.locator('.cm-md-mermaid[data-mount-sentinel="retained"]')
    ).toHaveCount(1)
    await expect(firstDiagram.locator("svg")).toHaveAttribute("id", firstSvgId!)

    await page.evaluate(() => {
      const editor = document.querySelector(".cm-editor")
      const gaps: number[] = []
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll(".cm-md-mermaid svg").length < 4) {
          gaps.push(performance.now())
        }
      })
      if (editor) observer.observe(editor, { childList: true, subtree: true })
      Reflect.set(window, "__mermaidThemeGaps", gaps)
      Reflect.set(window, "__mermaidThemeObserver", observer)
    })

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Theme")
    await page.getByRole("radio", { name: "Dark" }).click()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await expect
      .poll(() =>
        diagrams.locator("svg").evaluateAll((svgs) => svgs.map((svg) => svg.id))
      )
      .not.toEqual(lightDiagnostics.map(({ id }) => id))
    await expect(diagrams.locator("svg")).toHaveCount(4)
    await expect(page.locator('.cm-md-mermaid[aria-busy="true"]')).toHaveCount(
      0
    )
    const darkDiagnostics = await diagrams.evaluateAll((elements) =>
      elements.map((element) => {
        const firstNode = element.querySelector<SVGGraphicsElement>(
          "g.node > rect, g.node > circle, g.node > ellipse, g.node > polygon, g.node > path"
        )
        const paintedColors = [
          ...element.querySelectorAll<SVGElement>("svg *"),
        ].flatMap((painted) => {
          const styles = getComputedStyle(painted)
          return [styles.color, styles.fill, styles.stroke]
        })
        return {
          fill: firstNode ? getComputedStyle(firstNode).fill : null,
          maxColorChroma: Math.max(
            0,
            ...paintedColors.map((color) => {
              const channels =
                /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/.exec(color)
              if (!channels) return 0
              const values = channels.slice(1, 4).map(Number)
              return Math.max(...values) - Math.min(...values)
            })
          ),
        }
      })
    )
    expect(darkDiagnostics[0]?.fill).not.toBe(lightDiagnostics[0]?.fill)
    expect(
      darkDiagnostics.every(({ maxColorChroma }) => maxColorChroma <= 1)
    ).toBe(true)
    expect(
      await page.evaluate(() => {
        const observer = Reflect.get(window, "__mermaidThemeObserver") as
          MutationObserver | undefined
        observer?.disconnect()
        return Reflect.get(window, "__mermaidThemeGaps") as number[]
      })
    ).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("switching between Mermaid diagrams restores the previous preview", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-mermaid-selection-")
  )
  const filePath = path.join(userData, "mermaid-selection.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions.mermaid = true
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  await writeFile(
    filePath,
    [
      "# Diagram selection",
      "",
      "```mermaid",
      "flowchart LR",
      "  FirstAlpha --> FirstOmega",
      "```",
      "",
      "Between the diagrams.",
      "",
      "```mermaid",
      "flowchart LR",
      "  SecondAlpha --> SecondOmega",
      "```",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const diagrams = page.locator(".cm-md-mermaid")
    const first = diagrams.filter({ hasText: "FirstAlpha" })
    const second = diagrams.filter({ hasText: "SecondAlpha" })
    await expect(diagrams.locator("svg")).toHaveCount(2)

    await first.click()
    await expect(first).toHaveCount(0)
    await expect(second.locator("svg")).toHaveCount(1)

    await second.click()
    await expect(first.locator("svg")).toHaveCount(1)
    await expect(second).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("tall Mermaid replacements keep a stable layout while scrolling", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-mermaid-scroll-")
  )
  const filePath = path.join(userData, "mermaid-scroll.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "light"
  settings.markdownExtensions.mermaid = true
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  await writeFile(
    filePath,
    await readFile(
      path.join(projectRoot, "tests/fixtures/complex-mermaid-scroll.md"),
      "utf8"
    )
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  const pageErrors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on("pageerror", (error) => {
      pageErrors.push(error.message)
    })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1_000, 800)
    })
    const content = page.locator(".cm-content")
    await content.waitFor()
    await content.evaluate((element) => {
      interface MermaidScrollDiagnostics {
        dispatches: number
        dispatchesSinceFrame: number
        maximumDispatchesBetweenFrames: number
        runaway: boolean
      }

      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(...specs: unknown[]): void
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")

      const originalDispatch = view.dispatch.bind(view)
      const diagnostics: MermaidScrollDiagnostics = {
        dispatches: 0,
        dispatchesSinceFrame: 0,
        maximumDispatchesBetweenFrames: 0,
        runaway: false,
      }
      view.dispatch = (...specs: unknown[]) => {
        diagnostics.dispatches += 1
        diagnostics.dispatchesSinceFrame += 1
        if (diagnostics.dispatchesSinceFrame > 100) {
          diagnostics.runaway = true
          return
        }
        originalDispatch(...specs)
      }
      Reflect.set(window, "__mermaidScrollDiagnostics", diagnostics)
    })

    const scroller = page.locator(".cm-scroller")
    const scrollResult = await scroller.evaluate(async (element) => {
      interface MermaidScrollDiagnostics {
        dispatches: number
        dispatchesSinceFrame: number
        maximumDispatchesBetweenFrames: number
        runaway: boolean
      }

      const diagnostics = Reflect.get(window, "__mermaidScrollDiagnostics") as
        MermaidScrollDiagnostics | undefined
      if (!diagnostics) throw new Error("Scroll diagnostics are unavailable")

      const checkpointFrame = async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
        diagnostics.maximumDispatchesBetweenFrames = Math.max(
          diagnostics.maximumDispatchesBetweenFrames,
          diagnostics.dispatchesSinceFrame
        )
        diagnostics.dispatchesSinceFrame = 0
      }
      const visibleLineText = () =>
        [...element.querySelectorAll<HTMLElement>(".cm-line")]
          .filter((line) => {
            const lineBounds = line.getBoundingClientRect()
            const scrollerBounds = element.getBoundingClientRect()
            return (
              lineBounds.bottom > scrollerBounds.top &&
              lineBounds.top < scrollerBounds.bottom
            )
          })
          .map((line) => line.textContent ?? "")

      let sawContentAfterDiagrams = false
      let sawOrderLifecycle = false
      let steps = 0
      await checkpointFrame()
      for (; steps < 1_600; steps += 1) {
        const maximum = element.scrollHeight - element.clientHeight
        const previous = element.scrollTop
        element.scrollTop = Math.min(previous + 24, maximum)
        await checkpointFrame()

        const lines = visibleLineText()
        sawOrderLifecycle ||= lines.some((line) =>
          line.includes("3. Order lifecycle state machine")
        )
        sawContentAfterDiagrams ||= lines.some((line) =>
          line.includes("Content after diagrams")
        )
        if (sawContentAfterDiagrams && element.scrollTop >= maximum - 1) break
        if (element.scrollTop <= previous && element.scrollTop >= maximum - 1) {
          break
        }
      }

      return {
        diagnostics,
        sawContentAfterDiagrams,
        sawOrderLifecycle,
        scrollTop: element.scrollTop,
        steps,
      }
    })

    expect(scrollResult.sawOrderLifecycle).toBe(true)
    expect(scrollResult.sawContentAfterDiagrams).toBe(true)
    expect(scrollResult.scrollTop).toBeGreaterThan(0)
    expect(scrollResult.diagnostics).toMatchObject({
      runaway: false,
    })
    expect(scrollResult.steps).toBeLessThan(1_600)

    const editor = page.locator(".cm-editor")
    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-focused/)
    await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
    await page.keyboard.press("Escape")
    await expect(editor).not.toHaveClass(/cm-focused/)
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    const belowDiagramLine = page
      .locator(".cm-line")
      .filter({
        hasText:
          "The renderer remains interactive below all three replacements.",
      })
      .first()
    await expect(belowDiagramLine).toBeVisible()
    await belowDiagramLine.click()
    await expect(editor).toHaveClass(/cm-focused/)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home"
    )
    await expect(
      page
        .locator(".cm-line")
        .filter({ hasText: "Complex Mermaid Demo: Atlas Commerce Platform" })
        .first()
    ).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
