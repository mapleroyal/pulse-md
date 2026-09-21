import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { _electron as electron, expect, test } from "@playwright/test"

import { SANITIZED_HTML_MARK_THEME } from "../../src/editor/html-preview"
import { syntaxPreviewColors } from "../../src/editor/syntax-themes/palettes"
import {
  BACKGROUND_COLORS,
  BACKGROUND_SURFACE_SCHEMES,
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  SYNTAX_THEME_IDS,
} from "../../src/shared/contracts"
import {
  exitApplication,
  openSettingsSection,
  setWindowContentSize,
} from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const modifier = process.platform === "darwin" ? "Meta" : "Control"
const settingsShortcut = process.platform === "darwin" ? "Meta+," : "Control+,"

async function extensionFixture(
  name: string,
  document: string,
  enabled: Partial<typeof DEFAULT_APP_SETTINGS.markdownExtensions>,
  configure?: (settings: ReturnType<typeof cloneAppSettings>) => void
) {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), `pulse-md-renderer-${name}-`)
  )
  const filePath = path.join(userData, `${name}.md`)
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "light"
  settings.markdownExtensions = {
    ...settings.markdownExtensions,
    ...enabled,
  }
  configure?.(settings)
  await Promise.all([
    writeFile(filePath, document),
    writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify(settings, null, 2)
    ),
  ])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
  return { app, userData }
}

test("sanitized HTML uses theme colors and preserves native disclosure behavior @renderer-isolated", async () => {
  const fixture = await extensionFixture(
    "html",
    [
      "Introductory paragraph above the interactive preview.",
      "",
      "A second paragraph keeps this fixture clear of the window-drag reveal zone.",
      "",
      "Inline <mark>highlight</mark> beside `inline code`.",
      "",
      '<details open onclick="window.__unsafeDetails = true">',
      '  <summary onclick="window.__unsafeSummary = true">More</summary>',
      "  <p>Disclosure <mark>block highlight</mark></p>",
      "</details>",
    ].join("\n"),
    { sanitizedHtml: true },
    (settings) => {
      // Exercise syntax palettes against the opposite surface family rather
      // than relying on their canonical light/dark pairings.
      settings.themeByScheme.light.syntaxThemeId = "one-dark"
      settings.themeByScheme.dark.backgroundId = "catppuccin-frappe"
      settings.themeByScheme.dark.syntaxThemeId = "default"
    }
  )

  try {
    const page = await fixture.app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    const mark = page.locator(".cm-md-html-mark")
    const details = page.locator(".cm-md-html-block details")
    const blockMark = details.locator("mark")
    const summary = details.locator("summary")
    const markContrastRatios = (locator: typeof mark) =>
      locator.evaluate((element) => {
        const canvas = element.ownerDocument.createElement("canvas")
        canvas.width = 3
        canvas.height = 1
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Canvas colors are unavailable")
        const documentProbe = element.ownerDocument.createElement("span")
        documentProbe.style.backgroundColor = "var(--document-background)"
        element.ownerDocument.body.append(documentProbe)
        const colors = [
          getComputedStyle(element).backgroundColor,
          getComputedStyle(element).color,
          getComputedStyle(documentProbe).backgroundColor,
        ]
        documentProbe.remove()
        colors.forEach((color, index) => {
          context.fillStyle = color
          context.fillRect(index, 0, 1, 1)
        })
        const pixels = context.getImageData(0, 0, 3, 1).data
        const luminance = (offset: number) => {
          const channels = [0, 1, 2].map((channel) => {
            const value = pixels[offset + channel]! / 255
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4
          })
          return (
            0.2126 * channels[0]! +
            0.7152 * channels[1]! +
            0.0722 * channels[2]!
          )
        }
        const background = luminance(0)
        const foreground = luminance(4)
        const documentBackground = luminance(8)
        const ratio = (left: number, right: number) =>
          (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
        return {
          surface: ratio(background, documentBackground),
          text: ratio(background, foreground),
        }
      })
    await expect(mark).toHaveText("highlight")
    await expect(blockMark).toHaveText("block highlight")
    await expect(details).toHaveAttribute("open", "")
    await expect(details.locator("[onclick]")).toHaveCount(0)

    const lightColors = await mark.evaluate((element, theme) => {
      const style = getComputedStyle(element)
      const probe = element.ownerDocument.createElement("span")
      probe.style.backgroundColor = theme.background
      probe.style.color = theme.foreground
      element.ownerDocument.body.append(probe)
      const expectedBackground = getComputedStyle(probe).backgroundColor
      const expectedColor = getComputedStyle(probe).color
      probe.remove()
      return {
        background: style.backgroundColor,
        color: style.color,
        documentBackground: getComputedStyle(
          element.ownerDocument.documentElement
        ).getPropertyValue("--document-background"),
        expectedBackground,
        expectedColor,
        inlineCodeBackground: getComputedStyle(
          element.ownerDocument.querySelector(".cm-md-inline-code")!
        ).backgroundColor,
        syntaxNumber: getComputedStyle(
          element.ownerDocument.documentElement
        ).getPropertyValue("--syntax-number-color"),
      }
    }, SANITIZED_HTML_MARK_THEME.light)
    expect(lightColors.background).not.toBe("rgba(0, 0, 0, 0)")
    expect(lightColors.background).not.toBe(lightColors.inlineCodeBackground)
    expect(lightColors.documentBackground.trim()).toBe("#ffffff")
    expect(lightColors.syntaxNumber.trim()).toBe(
      syntaxPreviewColors("one-dark", "#ffffff").number
    )
    expect(lightColors.background).toBe(lightColors.expectedBackground)
    expect(lightColors.color).toBe(lightColors.expectedColor)
    const lightContrast = await markContrastRatios(mark)
    expect(lightContrast.text).toBeGreaterThanOrEqual(4.5)
    expect(lightContrast.surface).toBeGreaterThanOrEqual(3)
    await expect
      .poll(() =>
        blockMark.evaluate((element) => {
          const style = getComputedStyle(element)
          return [style.backgroundColor, style.color]
        })
      )
      .toEqual([lightColors.background, lightColors.color])

    await summary.click()
    await expect(details).not.toHaveAttribute("open", "")
    await expect(page.locator(".cm-md-html-block")).toHaveCount(1)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-caret-hidden/)

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Theme")
    await page.getByRole("radio", { name: "Dark" }).click()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    const darkColors = await mark.evaluate((element, theme) => {
      const style = getComputedStyle(element)
      const probe = element.ownerDocument.createElement("span")
      probe.style.backgroundColor = theme.background
      probe.style.color = theme.foreground
      element.ownerDocument.body.append(probe)
      const expectedBackground = getComputedStyle(probe).backgroundColor
      const expectedColor = getComputedStyle(probe).color
      probe.remove()
      return {
        background: style.backgroundColor,
        color: style.color,
        documentBackground: getComputedStyle(
          element.ownerDocument.documentElement
        ).getPropertyValue("--document-background"),
        expectedBackground,
        expectedColor,
        inlineCodeBackground: getComputedStyle(
          element.ownerDocument.querySelector(".cm-md-inline-code")!
        ).backgroundColor,
        syntaxNumber: getComputedStyle(
          element.ownerDocument.documentElement
        ).getPropertyValue("--syntax-number-color"),
      }
    }, SANITIZED_HTML_MARK_THEME.dark)
    expect(darkColors.background).not.toBe(lightColors.background)
    expect(darkColors.background).not.toBe(darkColors.inlineCodeBackground)
    expect(darkColors.documentBackground.trim()).toBe("#303446")
    expect(darkColors.syntaxNumber.trim()).toBe(
      syntaxPreviewColors("default", "#303446").number
    )
    expect(darkColors.background).toBe(darkColors.expectedBackground)
    expect(darkColors.color).toBe(darkColors.expectedColor)
    const darkContrast = await markContrastRatios(mark)
    expect(darkContrast.text).toBeGreaterThanOrEqual(4.5)
    expect(darkContrast.surface).toBeGreaterThanOrEqual(3)

    const auditBackgrounds = Object.entries(BACKGROUND_COLORS).map(
      ([id, background]) => ({
        background,
        id,
        scheme:
          BACKGROUND_SURFACE_SCHEMES[
            id as keyof typeof BACKGROUND_SURFACE_SCHEMES
          ],
      })
    )
    const auditSyntaxes = SYNTAX_THEME_IDS.map((id) => ({
      id,
      number: syntaxPreviewColors(id, BACKGROUND_COLORS[id]).number,
    }))
    const markAudit = await page.evaluate(
      ({ backgrounds, syntaxes, theme }) => {
        const canvas = document.createElement("canvas")
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Canvas colors are unavailable")
        const channels = (color: string) => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = "#000000"
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]
        }
        const luminance = (color: string) => {
          const values = channels(color).map((channel) => {
            const value = channel / 255
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!
        }
        const contrast = (left: number, right: number) =>
          (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
        const probe = document.createElement("span")
        document.body.append(probe)
        const root = document.documentElement
        const previousSyntaxNumber = root.style.getPropertyValue(
          "--syntax-number-color"
        )
        const failures: {
          readonly background: string
          readonly kind:
            "custom-boundary" | "custom-direction" | "surface" | "text"
          readonly ratio: number
          readonly scheme: "dark" | "light"
          readonly syntax: string
        }[] = []
        const minimum = {
          customBoundary: Number.POSITIVE_INFINITY,
          surface: Number.POSITIVE_INFINITY,
          text: Number.POSITIVE_INFINITY,
        }
        try {
          for (const syntax of syntaxes) {
            root.style.setProperty("--syntax-number-color", syntax.number)
            for (const scheme of ["light", "dark"] as const) {
              probe.style.backgroundColor = ""
              probe.style.color = ""
              probe.style.backgroundColor = theme[scheme].background
              probe.style.color = theme[scheme].foreground
              const style = getComputedStyle(probe)
              const markLuminance = luminance(style.backgroundColor)
              const textRatio = contrast(markLuminance, luminance(style.color))
              minimum.text = Math.min(minimum.text, textRatio)
              if (textRatio < 4.5) {
                failures.push({
                  background: "all",
                  kind: "text",
                  ratio: textRatio,
                  scheme,
                  syntax: syntax.id,
                })
              }

              // Custom backgrounds switch scheme at relative luminance 0.19.
              // Since the mark is independent of the chosen background hue,
              // this threshold is the worst possible custom surface in both
              // directions and covers every valid custom color.
              const boundaryRatio = contrast(markLuminance, 0.19)
              minimum.customBoundary = Math.min(
                minimum.customBoundary,
                boundaryRatio
              )
              if (boundaryRatio < 3) {
                failures.push({
                  background: "custom@0.19",
                  kind: "custom-boundary",
                  ratio: boundaryRatio,
                  scheme,
                  syntax: syntax.id,
                })
              }
              const pointsAwayFromBoundary =
                scheme === "light" ? markLuminance < 0.19 : markLuminance > 0.19
              if (!pointsAwayFromBoundary) {
                failures.push({
                  background: "custom@0.19",
                  kind: "custom-direction",
                  ratio: boundaryRatio,
                  scheme,
                  syntax: syntax.id,
                })
              }

              for (const surface of backgrounds) {
                if (surface.scheme !== scheme) continue
                const surfaceRatio = contrast(
                  markLuminance,
                  luminance(surface.background)
                )
                minimum.surface = Math.min(minimum.surface, surfaceRatio)
                if (surfaceRatio < 3) {
                  failures.push({
                    background: surface.id,
                    kind: "surface",
                    ratio: surfaceRatio,
                    scheme,
                    syntax: syntax.id,
                  })
                }
              }
            }
          }
        } finally {
          if (previousSyntaxNumber) {
            root.style.setProperty(
              "--syntax-number-color",
              previousSyntaxNumber
            )
          } else {
            root.style.removeProperty("--syntax-number-color")
          }
          probe.remove()
        }
        return {
          checkedPairings: backgrounds.length * syntaxes.length,
          failures,
          minimum,
          relativeColorSupported: CSS.supports(
            "color",
            "oklch(from red 25% calc(c * 0.65) h)"
          ),
        }
      },
      {
        backgrounds: auditBackgrounds,
        syntaxes: auditSyntaxes,
        theme: SANITIZED_HTML_MARK_THEME,
      }
    )
    expect(markAudit.relativeColorSupported).toBe(true)
    expect(markAudit.checkedPairings).toBe(
      Object.keys(BACKGROUND_COLORS).length * SYNTAX_THEME_IDS.length
    )
    expect(markAudit.failures).toEqual([])
    expect(markAudit.minimum.text).toBeGreaterThanOrEqual(4.5)
    expect(markAudit.minimum.surface).toBeGreaterThanOrEqual(3)
    expect(markAudit.minimum.customBoundary).toBeGreaterThanOrEqual(3)
    expect(
      await page.evaluate(() => ({
        details: Reflect.get(window, "__unsafeDetails"),
        summary: Reflect.get(window, "__unsafeSummary"),
      }))
    ).toEqual({ details: undefined, summary: undefined })
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("warmed rendered blocks remount without scroll-anchor jumps @renderer-isolated", async () => {
  test.setTimeout(45_000)
  const filler = (label: string, count = 40) =>
    Array.from(
      { length: count },
      (_value, index) =>
        `${label} filler ${index + 1}. Ordinary text keeps rendered sections outside one another's viewport.`
    ).join("\n\n")
  const fixture = await extensionFixture(
    "rendered-scroll-stability",
    [
      "# Top stability anchor",
      "",
      filler("Before math"),
      "",
      "## LaTeX stability anchor",
      "",
      "$$",
      String.raw`\begin{aligned} E &= mc^2 \\ F &= ma \\ a^2 + b^2 &= c^2 \end{aligned}`,
      "$$",
      "",
      "Plain math target.",
      "",
      filler("Between math and Mermaid"),
      "",
      "## Mermaid stability anchor",
      "",
      "```mermaid",
      "flowchart TD",
      "  Start[Markdown] --> Parse[Parse syntax]",
      "  Parse --> Preview[Build preview]",
      "  Preview --> Math[LaTeX]",
      "  Preview --> Diagram[Mermaid]",
      "  Preview --> Html[Sanitized HTML]",
      "  Math --> Stable[Stable viewport]",
      "  Diagram --> Stable",
      "  Html --> Stable",
      "```",
      "",
      "Plain Mermaid target.",
      "",
      filler("Between Mermaid and HTML"),
      "",
      "## HTML stability anchor",
      "",
      "<details open>",
      "  <summary>Stability disclosure</summary>",
      "  <p>Sanitized content stays ready when its viewport is restored.</p>",
      "  <ul>",
      "    <li>First stable row</li>",
      "    <li>Second stable row</li>",
      "    <li>Third stable row</li>",
      "  </ul>",
      "</details>",
      "",
      "Plain HTML target.",
      "",
      filler("Between HTML and callout"),
      "",
      "## Callout stability anchor",
      "",
      "> [!TIP] Stable callout",
      "> Stable callout body remains visually anchored.",
      ">",
      "> A second callout paragraph gives the rendered card meaningful height.",
      "",
      "Plain callout target.",
      "",
      filler("After callout"),
      "",
      "# Bottom stability anchor",
    ].join("\n"),
    { latex: true, mermaid: true, sanitizedHtml: true }
  )

  try {
    const page = await fixture.app.firstWindow()
    const content = page.locator(".cm-content")
    const scroller = page.locator(".cm-scroller")
    const math = page.locator(".cm-md-math-block")
    const mermaid = page.locator(".cm-md-mermaid")
    const html = page.locator(".cm-md-html-block")
    const callout = page.locator('.cm-md-callout[data-callout-type="tip"]')
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")

    const waitForFrames = (count = 2) =>
      page.evaluate(async (frameCount) => {
        for (let frame = 0; frame < frameCount; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      }, count)
    const revealMarker = async (marker: string) => {
      await content.evaluate((element, text) => {
        const editorContent = element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                scrollIntoView: boolean
                selection: { anchor: number }
              }): void
              state: { doc: { toString(): string } }
            }
          }
        }
        const view = editorContent.cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const position = view.state.doc.toString().indexOf(text)
        if (position < 0) throw new Error(`Marker is unavailable: ${text}`)
        view.dispatch({
          selection: { anchor: position },
          scrollIntoView: true,
        })
      }, marker)
      await waitForFrames()
    }
    const renderedHeight = (locator: typeof math) =>
      locator.evaluate((element) => element.getBoundingClientRect().height)

    await revealMarker("LaTeX stability anchor")
    await expect(math.locator(".katex")).toHaveCount(1)
    await expect(math).not.toHaveClass(/cm-md-math-loading/)
    const mathHeight = await renderedHeight(math)

    await revealMarker("Mermaid stability anchor")
    await expect(mermaid.locator("svg")).toHaveCount(1)
    await expect(mermaid).not.toHaveClass(/cm-md-mermaid-loading/)
    await expect(mermaid).not.toHaveAttribute("aria-busy", "true")
    const mermaidHeight = await renderedHeight(mermaid)

    await revealMarker("HTML stability anchor")
    await expect(html.locator("details")).toHaveCount(1)
    await expect(html).not.toHaveClass(/cm-md-html-loading/)
    const htmlHeight = await renderedHeight(html)

    await revealMarker("Callout stability anchor")
    await expect(callout).toHaveCount(1)
    await expect(callout.locator(".cm-md-callout-header-line")).toHaveText(
      "Stable callout"
    )
    const calloutHeight = await renderedHeight(callout)

    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await waitForFrames(3)
    await expect(math).toHaveCount(0)
    await expect(mermaid).toHaveCount(0)
    await expect(html).toHaveCount(0)
    await expect(callout).toHaveCount(0)

    await page.evaluate(() => {
      type PreviewKind = "html" | "math" | "mermaid"
      interface PreviewSnapshot {
        ariaBusy: boolean
        height: number
        kind: PreviewKind
        loading: boolean
        ready: boolean
      }
      const stats = {
        attributeLoadingStates: [] as PreviewKind[],
        snapshots: [] as PreviewSnapshot[],
      }
      const selector = ".cm-md-html-block, .cm-md-math-block, .cm-md-mermaid"
      const observed = new WeakSet<Element>()
      const kindFor = (element: Element): PreviewKind =>
        element.classList.contains("cm-md-html-block")
          ? "html"
          : element.classList.contains("cm-md-math-block")
            ? "math"
            : "mermaid"
      const inspect = (element: Element) => {
        if (!(element instanceof HTMLElement) || observed.has(element)) return
        observed.add(element)
        const kind = kindFor(element)
        const loading = element.classList.contains(`cm-md-${kind}-loading`)
        const ariaBusy = element.getAttribute("aria-busy") === "true"
        stats.snapshots.push({
          ariaBusy,
          height: element.getBoundingClientRect().height,
          kind,
          loading,
          ready:
            kind === "html"
              ? element.querySelector("details") != null
              : kind === "math"
                ? element.querySelector(".katex") != null
                : element.querySelector("svg") != null,
        })
      }
      const inspectTree = (node: Node) => {
        if (!(node instanceof Element)) return
        if (node.matches(selector)) inspect(node)
        for (const element of node.querySelectorAll(selector)) inspect(element)
      }
      const editor = document.querySelector(".cm-editor")
      if (!editor) throw new Error("Editor is unavailable")
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "childList") {
            for (const node of record.addedNodes) inspectTree(node)
            continue
          }
          const target = record.target
          if (!(target instanceof Element)) continue
          const preview = target.matches(selector)
            ? target
            : target.closest(selector)
          if (!preview) continue
          const kind = kindFor(preview)
          if (
            preview.classList.contains(`cm-md-${kind}-loading`) ||
            preview.getAttribute("aria-busy") === "true"
          ) {
            stats.attributeLoadingStates.push(kind)
          }
        }
      })
      observer.observe(editor, {
        attributeFilter: ["aria-busy", "class"],
        attributes: true,
        childList: true,
        subtree: true,
      })
      Reflect.set(window, "__renderedScrollObserver", observer)
      Reflect.set(window, "__renderedScrollStats", stats)
    })

    await scroller.hover()
    const assertWheelStep = async (deltaY: number) => {
      const before = await scroller.evaluate((element) => element.scrollTop)
      await page.mouse.wheel(0, deltaY)
      if (deltaY > 0) {
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(before + 0.5)
      } else {
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollTop))
          .toBeLessThan(before - 0.5)
      }
      const after = await scroller.evaluate((element) => element.scrollTop)
      expect(Math.abs(after - before)).toBeLessThanOrEqual(
        Math.abs(deltaY) + 64
      )
      const samples = await scroller.evaluate(async (element) => {
        const values: number[] = []
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
          values.push(element.scrollTop)
        }
        return values
      })
      if (deltaY > 0) {
        expect(Math.min(...samples)).toBeGreaterThanOrEqual(after - 2)
        expect(Math.max(...samples)).toBeLessThanOrEqual(after + 24)
      } else {
        expect(Math.max(...samples)).toBeLessThanOrEqual(after + 2)
        expect(Math.min(...samples)).toBeGreaterThanOrEqual(after - 24)
      }
    }

    for (let step = 0; step < 40; step += 1) {
      const { maximum, top } = await scroller.evaluate((element) => ({
        maximum: element.scrollHeight - element.clientHeight,
        top: element.scrollTop,
      }))
      if (maximum - top <= 1) break
      await assertWheelStep(Math.min(640, maximum - top))
    }
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop
        )
      )
      .toBeLessThanOrEqual(1)

    for (let step = 0; step < 40; step += 1) {
      const top = await scroller.evaluate((element) => element.scrollTop)
      if (top <= 1) break
      await assertWheelStep(-Math.min(640, top))
    }
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(1)

    const remountStats = await page.evaluate(() => {
      const observer = Reflect.get(
        window,
        "__renderedScrollObserver"
      ) as MutationObserver
      observer.disconnect()
      return Reflect.get(window, "__renderedScrollStats") as {
        attributeLoadingStates: string[]
        snapshots: Array<{
          ariaBusy: boolean
          height: number
          kind: "html" | "math" | "mermaid"
          loading: boolean
          ready: boolean
        }>
      }
    })
    expect(remountStats.attributeLoadingStates).toEqual([])
    for (const [kind, expectedHeight] of [
      ["math", mathHeight],
      ["mermaid", mermaidHeight],
      ["html", htmlHeight],
    ] as const) {
      const snapshots = remountStats.snapshots.filter(
        (snapshot) => snapshot.kind === kind
      )
      expect(
        snapshots.length,
        `${kind} did not remount during the sweep`
      ).toBeGreaterThan(0)
      expect(
        snapshots.every(
          (snapshot) =>
            !snapshot.ariaBusy &&
            !snapshot.loading &&
            snapshot.ready &&
            Math.abs(snapshot.height - expectedHeight) <= 1
        )
      ).toBe(true)
    }

    const anchorTop = (marker: string) =>
      page
        .locator(".cm-line")
        .filter({ hasText: marker })
        .first()
        .evaluate((element) => element.getBoundingClientRect().top)
    const assertAnchorSettled = async (
      marker: string,
      beforeTop: number,
      beforeScrollTop: number
    ) => {
      const samples = await scroller.evaluate(async (element) => {
        const values: number[] = []
        for (let frame = 0; frame < 8; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
          values.push(element.scrollTop)
        }
        return values
      })
      expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(2)
      expect(Math.abs(samples.at(-1)! - beforeScrollTop)).toBeLessThanOrEqual(2)
      expect(
        Math.abs((await anchorTop(marker)) - beforeTop)
      ).toBeLessThanOrEqual(2)
    }

    await revealMarker("HTML stability anchor")
    const details = html.locator("details")
    const summary = details.locator("summary")
    await expect(details).toHaveAttribute("open", "")
    await summary.scrollIntoViewIfNeeded()
    await waitForFrames()
    let beforeTop = await anchorTop("HTML stability anchor")
    let beforeScrollTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    await summary.click()
    await expect(details).not.toHaveAttribute("open", "")
    await assertAnchorSettled(
      "HTML stability anchor",
      beforeTop,
      beforeScrollTop
    )

    await summary.click()
    await expect(details).toHaveAttribute("open", "")
    const htmlBody = details.locator("p")
    await htmlBody.scrollIntoViewIfNeeded()
    await waitForFrames()
    beforeTop = await anchorTop("HTML stability anchor")
    beforeScrollTop = await scroller.evaluate((element) => element.scrollTop)
    await htmlBody.click()
    await expect(html).toHaveCount(0)
    await assertAnchorSettled(
      "HTML stability anchor",
      beforeTop,
      beforeScrollTop
    )
    await page.keyboard.press("Escape")
    await expect(html).toHaveCount(1)
    await assertAnchorSettled(
      "HTML stability anchor",
      beforeTop,
      beforeScrollTop
    )

    await revealMarker("LaTeX stability anchor")
    await expect(math.locator(".katex")).toHaveCount(1)
    await math.scrollIntoViewIfNeeded()
    await waitForFrames()
    beforeTop = await anchorTop("LaTeX stability anchor")
    beforeScrollTop = await scroller.evaluate((element) => element.scrollTop)
    await math.click()
    await expect(math).toHaveCount(0)
    await assertAnchorSettled(
      "LaTeX stability anchor",
      beforeTop,
      beforeScrollTop
    )
    const mathTarget = page
      .locator(".cm-line")
      .filter({ hasText: "Plain math target." })
      .first()
    await mathTarget.scrollIntoViewIfNeeded()
    await waitForFrames()
    beforeTop = await anchorTop("LaTeX stability anchor")
    beforeScrollTop = await scroller.evaluate((element) => element.scrollTop)
    await mathTarget.click()
    await waitForFrames()
    const restoredMath = await math.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      loading: element.classList.contains("cm-md-math-loading"),
      ready: element.querySelector(".katex") != null,
    }))
    expect(restoredMath).toMatchObject({ loading: false, ready: true })
    expect(Math.abs(restoredMath.height - mathHeight)).toBeLessThanOrEqual(1)
    await assertAnchorSettled(
      "LaTeX stability anchor",
      beforeTop,
      beforeScrollTop
    )

    await revealMarker("Callout stability anchor")
    const calloutHeader = callout.locator(".cm-md-callout-header")
    await expect(calloutHeader).toBeVisible()
    await calloutHeader.scrollIntoViewIfNeeded()
    await waitForFrames()
    beforeTop = await anchorTop("Callout stability anchor")
    beforeScrollTop = await scroller.evaluate((element) => element.scrollTop)
    await calloutHeader.click()
    await expect(callout).toHaveCount(0)
    await assertAnchorSettled(
      "Callout stability anchor",
      beforeTop,
      beforeScrollTop
    )
    const calloutTarget = page
      .locator(".cm-line")
      .filter({ hasText: "Plain callout target." })
      .first()
    await calloutTarget.scrollIntoViewIfNeeded()
    await waitForFrames()
    beforeTop = await anchorTop("Callout stability anchor")
    beforeScrollTop = await scroller.evaluate((element) => element.scrollTop)
    await calloutTarget.click()
    await waitForFrames()
    await expect(callout).toHaveCount(1)
    expect(
      Math.abs((await renderedHeight(callout)) - calloutHeight)
    ).toBeLessThanOrEqual(1)
    await assertAnchorSettled(
      "Callout stability anchor",
      beforeTop,
      beforeScrollTop
    )
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("cold forward and reverse scrolling through rendered extensions keeps visible content anchored @renderer-isolated", async () => {
  test.setTimeout(90_000)
  const markdownDocument = await readFile(
    path.join(projectRoot, "markdown-test.md"),
    "utf8"
  )
  const fixture = await extensionFixture(
    "rendered-extension-reverse-scroll-stability",
    markdownDocument,
    {
      definitionLists: true,
      emojiExpansion: true,
      emojiRecognition: true,
      footnotes: true,
      latex: true,
      mermaid: true,
      sanitizedHtml: true,
      superscriptAndSubscript: true,
      yamlFrontMatter: true,
    }
  )

  try {
    const page = await fixture.app.firstWindow()
    await setWindowContentSize(fixture.app, 1200, 900)
    const scroller = page.locator(".cm-scroller")
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")

    const result = await scroller.evaluate(async (element) => {
      interface VisibleLineAnchor {
        readonly position: number
        readonly top: number
      }

      interface ScrollSnapshot {
        readonly anchors: readonly VisibleLineAnchor[]
        readonly firstPosition: number | null
        readonly scrollHeight: number
        readonly scrollTop: number
      }

      interface ScrollAnomaly {
        readonly after: Pick<
          ScrollSnapshot,
          "firstPosition" | "scrollHeight" | "scrollTop"
        >
        readonly before: Pick<
          ScrollSnapshot,
          "firstPosition" | "scrollHeight" | "scrollTop"
        >
        readonly commonAnchors: number
        readonly direction: "down" | "up"
        readonly expectedTranslation: number
        readonly maximumAnchorError: number | null
        readonly medianAnchorTranslation: number | null
        readonly outlierAnchors: readonly {
          readonly position: number
          readonly translation: number
        }[]
        readonly reason: string
        readonly step: number
        readonly visibleHeadings: readonly string[]
        readonly visibleWidgets: readonly {
          readonly className: string
          readonly height: number
          readonly loading: boolean
        }[]
      }

      const waitForFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await waitForFrame()

      const snapshot = (): ScrollSnapshot => {
        const content = element.querySelector<HTMLElement>(".cm-content")
        const editorContent = content as HTMLElement & {
          cmTile?: {
            view?: {
              posAtDOM(node: Node, offset?: number): number
              state: {
                doc: {
                  lineAt(position: number): { from: number; number: number }
                  toString(): string
                }
              }
            }
          }
        }
        const view = editorContent.cmTile?.view
        if (!view || !content) throw new Error("CodeMirror view is unavailable")

        const scrollerBounds = element.getBoundingClientRect()
        const blockReplacementStarts = new Set<number>()
        for (const widget of content.querySelectorAll(
          ".cm-md-math-block, .cm-md-mermaid, .cm-md-html-block"
        )) {
          try {
            blockReplacementStarts.add(
              view.state.doc.lineAt(view.posAtDOM(widget, 0)).from
            )
          } catch {
            // A widget can be detached between the DOM query and position read.
          }
        }
        const anchorByPosition = new Map<number, VisibleLineAnchor>()
        for (const lineElement of content.querySelectorAll(".cm-line")) {
          const bounds = lineElement.getBoundingClientRect()
          if (
            bounds.bottom <= scrollerBounds.top ||
            bounds.top >= scrollerBounds.bottom
          ) {
            continue
          }
          const line = view.state.doc.lineAt(view.posAtDOM(lineElement, 0))
          if (blockReplacementStarts.has(line.from)) continue
          const anchor = {
            position: line.from,
            top: bounds.top - scrollerBounds.top,
          }
          const previous = anchorByPosition.get(line.from)
          if (!previous || anchor.top < previous.top) {
            anchorByPosition.set(line.from, anchor)
          }
        }
        const anchors = [...anchorByPosition.values()]
        anchors.sort((left, right) => left.top - right.top)
        const first = anchors[0]
        return {
          anchors,
          firstPosition: first?.position ?? null,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        }
      }

      const diagnostics = () => {
        const bounds = element.getBoundingClientRect()
        const visible = (target: Element) => {
          const targetBounds = target.getBoundingClientRect()
          return (
            targetBounds.bottom > bounds.top && targetBounds.top < bounds.bottom
          )
        }
        return {
          visibleHeadings: [
            ...element.querySelectorAll<HTMLElement>(".cm-md-heading"),
          ]
            .filter(visible)
            .map((heading) => heading.textContent ?? ""),
          visibleWidgets: [
            ...element.querySelectorAll<HTMLElement>(
              ".cm-md-math-block, .cm-md-mermaid, .cm-md-html-block"
            ),
          ]
            .filter(visible)
            .map((widget) => ({
              className: widget.className,
              height: widget.getBoundingClientRect().height,
              loading:
                widget.classList.contains("cm-md-math-loading") ||
                widget.classList.contains("cm-md-mermaid-loading") ||
                widget.classList.contains("cm-md-html-loading"),
            })),
        }
      }

      const anomalies: ScrollAnomaly[] = []
      const compare = (
        before: ScrollSnapshot,
        after: ScrollSnapshot,
        expectedTranslation: number,
        direction: "down" | "up",
        step: number
      ) => {
        const afterAnchors = new Map(
          after.anchors.map((anchor) => [anchor.position, anchor] as const)
        )
        const translations = before.anchors.flatMap((anchor) => {
          const matching = afterAnchors.get(anchor.position)
          return matching
            ? [
                {
                  position: anchor.position,
                  translation: matching.top - anchor.top,
                },
              ]
            : []
        })
        const sortedTranslations = translations
          .map(({ translation }) => translation)
          .sort((left, right) => left - right)
        const medianTranslation =
          sortedTranslations[Math.floor(sortedTranslations.length / 2)] ?? null
        const maximumAnchorError =
          translations.length === 0
            ? null
            : Math.max(
                ...translations.map((translation) =>
                  Math.abs(translation.translation - expectedTranslation)
                )
              )
        const diagnostic = {
          after: {
            firstPosition: after.firstPosition,
            scrollHeight: after.scrollHeight,
            scrollTop: after.scrollTop,
          },
          before: {
            firstPosition: before.firstPosition,
            scrollHeight: before.scrollHeight,
            scrollTop: before.scrollTop,
          },
          commonAnchors: translations.length,
          direction,
          expectedTranslation,
          maximumAnchorError,
          medianAnchorTranslation: medianTranslation,
          outlierAnchors: translations.filter(
            ({ translation }) => Math.abs(translation - expectedTranslation) > 2
          ),
          step,
        }
        const recordAnomaly = (reason: string) => {
          anomalies.push({ ...diagnostic, ...diagnostics(), reason })
        }

        if (translations.length === 0) {
          recordAnomaly("no common visible line")
        } else {
          if (Math.abs(medianTranslation! - expectedTranslation) > 2) {
            recordAnomaly(
              "median visible-line movement did not match the scroll"
            )
          }
          if (maximumAnchorError! > 2) {
            recordAnomaly("a visible line jumped independently of the scroll")
          }
        }

        if (
          before.firstPosition != null &&
          after.firstPosition != null &&
          (direction === "down"
            ? after.firstPosition < before.firstPosition
            : after.firstPosition > before.firstPosition)
        ) {
          recordAnomaly(
            `the first visible source position moved ${direction === "down" ? "backward" : "forward"}`
          )
        }
      }

      const content = element.querySelector<HTMLElement>(".cm-content")
      const view = (
        content as HTMLElement & {
          cmTile?: {
            view?: {
              state: { doc: { toString(): string } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const mathSection = view.state.doc.toString().indexOf("## 9. Mathematics")
      if (mathSection < 0) throw new Error("Math section is unavailable")

      const stepSize = 32
      let current = snapshot()
      const initial = current
      let downSteps = 0
      for (; downSteps < 2_000; downSteps += 1) {
        const maximum = current.scrollHeight - element.clientHeight
        const requested = Math.min(stepSize, maximum - current.scrollTop)
        if (requested < 1) break
        element.scrollTop += requested
        await waitForFrame()
        const after = snapshot()
        compare(current, after, -requested, "down", downSteps)
        current = after
      }
      const bottom = current

      let upSteps = 0
      for (; upSteps < 2_000; upSteps += 1) {
        if (
          current.firstPosition != null &&
          current.firstPosition <= mathSection
        ) {
          break
        }
        const requested = Math.min(stepSize, current.scrollTop)
        if (requested < 1) break
        element.scrollTop -= requested
        await waitForFrame()
        const after = snapshot()
        compare(current, after, requested, "up", upSteps)
        current = after
      }

      return {
        anomalies,
        bottom,
        downSteps,
        final: current,
        initial,
        mathSection,
        upSteps,
      }
    })

    expect(result.initial.scrollTop).toBe(0)
    expect(result.bottom.scrollTop).toBeGreaterThan(0)
    expect(
      result.bottom.scrollHeight -
        result.bottom.scrollTop -
        (await scroller.evaluate((element) => element.clientHeight))
    ).toBeLessThanOrEqual(1)
    expect(result.final.firstPosition).not.toBeNull()
    expect(result.final.firstPosition!).toBeLessThanOrEqual(result.mathSection)
    expect(result.downSteps).toBeLessThan(2_000)
    expect(result.upSteps).toBeLessThan(2_000)
    expect(result.anomalies).toEqual([])
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("partially clipped HTML preview stays anchored through editing @renderer-isolated", async () => {
  test.setTimeout(60_000)
  const markdownDocument = await readFile(
    path.join(projectRoot, "markdown-test.md"),
    "utf8"
  )
  const fixture = await extensionFixture(
    "clipped-html-scroll-stability",
    markdownDocument,
    { mermaid: true, sanitizedHtml: true }
  )

  try {
    const page = await fixture.app.firstWindow()
    await fixture.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    const content = page.locator(".cm-content")
    const scroller = page.locator(".cm-scroller")
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")
    await content.evaluate((element) => {
      const editorContent = element as HTMLElement & {
        cmTile?: {
          view?: {
            dispatch(spec: {
              scrollIntoView: boolean
              selection: { anchor: number }
            }): void
            state: { doc: { toString(): string } }
          }
        }
      }
      const view = editorContent.cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const position = view.state.doc
        .toString()
        .lastIndexOf("### Sanitized HTML")
      if (position < 0) throw new Error("HTML fixture heading is unavailable")
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
    })
    const html = page.locator(".cm-md-html-block")
    await expect(html).toBeVisible()
    const htmlHeight = await html.evaluate(
      (element) => element.getBoundingClientRect().height
    )
    const clipDepth = Math.min(100, Math.max(24, htmlHeight / 3))
    // A large programmatic jump materializes and measures a new CodeMirror
    // viewport. Reapply the target after those measurements so this test's
    // precondition is independent of estimated offscreen line heights. Derive
    // the clipping depth from the rendered block so normal HTML whitespace
    // remains testable without pushing the entire preview out of the viewport.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await html.evaluate((target, depth) => {
        const element = target.closest(".cm-scroller")
        if (!element) {
          throw new Error("Editor scroller is unavailable")
        }
        const scroller = element as HTMLElement
        const scrollRect = element.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        scroller.scrollTop += targetRect.top - scrollRect.top + depth
      }, clipDepth)
      await page.evaluate(async () => {
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      })
    }
    const htmlBounds = await html.evaluate((element) => {
      const scroller = element.closest(".cm-scroller")
      if (!scroller) throw new Error("Editor scroller is unavailable")
      const targetBounds = element.getBoundingClientRect()
      const scrollerBounds = scroller.getBoundingClientRect()
      return {
        absoluteTop: targetBounds.top,
        relativeBottom: targetBounds.bottom - scrollerBounds.top,
        relativeTop: targetBounds.top - scrollerBounds.top,
      }
    })
    expect(Math.abs(htmlBounds.relativeTop + clipDepth)).toBeLessThanOrEqual(2)
    expect(htmlBounds.relativeBottom).toBeGreaterThan(0)
    expect(htmlBounds.relativeBottom).toBeLessThan(htmlHeight)
    const markBounds = await html.locator("mark").boundingBox()
    if (!markBounds) throw new Error("HTML mark is unavailable")
    const scrollerBounds = await scroller.boundingBox()
    if (!scrollerBounds) throw new Error("Editor scroller is unavailable")
    expect(markBounds.y).toBeGreaterThan(scrollerBounds.y)
    expect(markBounds.y + markBounds.height).toBeLessThan(
      scrollerBounds.y + scrollerBounds.height
    )
    const beforeTop = htmlBounds.absoluteTop
    const beforeScrollTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    await page.evaluate(() => {
      const scroller = document.querySelector(".cm-scroller")
      if (!(scroller instanceof HTMLElement)) {
        throw new Error("Editor scroller is unavailable")
      }
      const trace = { active: true, samples: [] as number[] }
      const sample = () => {
        trace.samples.push(scroller.scrollTop)
        if (trace.active) requestAnimationFrame(sample)
      }
      Reflect.set(window, "__clippedHtmlScrollTrace", trace)
      requestAnimationFrame(sample)
    })
    await page.mouse.click(
      markBounds.x + markBounds.width / 2,
      markBounds.y + markBounds.height / 2
    )
    await expect(html).toHaveCount(0)
    await expect(
      page.locator(".cm-line").filter({ hasText: "</div>" }).first()
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(html).toHaveCount(1)
    await expect(html).not.toHaveClass(/cm-md-html-loading/)
    expect(
      Math.abs(
        (await html.evaluate(
          (element) => element.getBoundingClientRect().height
        )) - htmlHeight
      )
    ).toBeLessThanOrEqual(1)
    const samples = await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      }
      const trace = Reflect.get(window, "__clippedHtmlScrollTrace") as {
        active: boolean
        samples: number[]
      }
      trace.active = false
      return trace.samples
    })
    const afterTop = await html.evaluate(
      (element) => element.getBoundingClientRect().top
    )
    const afterScrollTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(2)
    expect(
      Math.max(...samples.map((sample) => Math.abs(sample - beforeScrollTop)))
    ).toBeLessThanOrEqual(2)
    expect(Math.abs(afterScrollTop - beforeScrollTop)).toBeLessThanOrEqual(2)
    expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(2)
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("partially clipped display math stays anchored through editing @renderer-isolated", async () => {
  const markdownDocument = await readFile(
    path.join(projectRoot, "markdown-test.md"),
    "utf8"
  )
  const fixture = await extensionFixture(
    "clipped-math-scroll-stability",
    markdownDocument,
    { latex: true }
  )

  try {
    const page = await fixture.app.firstWindow()
    await fixture.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    const content = page.locator(".cm-content")
    const scroller = page.locator(".cm-scroller")
    await page.locator(".cm-editor").waitFor()
    await content.evaluate((element) => {
      const editorContent = element as HTMLElement & {
        cmTile?: {
          view?: {
            dispatch(spec: {
              scrollIntoView: boolean
              selection: { anchor: number }
            }): void
            state: { doc: { toString(): string } }
          }
        }
      }
      const view = editorContent.cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const position = view.state.doc
        .toString()
        .lastIndexOf("\\[\n\\begin{aligned}")
      if (position < 0) throw new Error("Math fixture is unavailable")
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
    })

    const math = page.locator(
      '.cm-md-math-block[data-math-source*="begin{aligned}"]'
    )
    await expect(math.locator(".katex")).toHaveCount(1)
    // Reapply the target after CodeMirror materializes and measures the distant
    // viewport so the clipping precondition does not depend on estimated line
    // heights elsewhere in the syntax fixture.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await math.evaluate((target) => {
        const element = target.closest(".cm-scroller")
        if (!element) throw new Error("Editor scroller is unavailable")
        const scroller = element as HTMLElement
        const scrollRect = element.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        scroller.scrollTop += targetRect.top - scrollRect.top + 15
      })
      await page.evaluate(async () => {
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      })
    }

    const mathBounds = await math.boundingBox()
    if (!mathBounds) throw new Error("Math preview is unavailable")
    expect(Math.abs(mathBounds.y + 15)).toBeLessThanOrEqual(2)
    expect(mathBounds.y + mathBounds.height).toBeGreaterThan(50)
    const mathHeight = mathBounds.height
    const beforeScrollTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    await page.evaluate(() => {
      const scroller = document.querySelector(".cm-scroller")
      if (!(scroller instanceof HTMLElement)) {
        throw new Error("Editor scroller is unavailable")
      }
      const trace = { active: true, samples: [] as number[] }
      const sample = () => {
        trace.samples.push(scroller.scrollTop)
        if (trace.active) requestAnimationFrame(sample)
      }
      Reflect.set(window, "__clippedMathScrollTrace", trace)
      requestAnimationFrame(sample)
    })
    await page.mouse.click(
      mathBounds.x + mathBounds.width / 2,
      Math.min(150, mathBounds.y + mathBounds.height - 10)
    )
    await expect(math).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(math.locator(".katex")).toHaveCount(1)
    await expect(math).not.toHaveClass(/cm-md-math-loading/)
    expect(
      Math.abs(
        (await math.evaluate(
          (element) => element.getBoundingClientRect().height
        )) - mathHeight
      )
    ).toBeLessThanOrEqual(1)
    const samples = await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      }
      const trace = Reflect.get(window, "__clippedMathScrollTrace") as {
        active: boolean
        samples: number[]
      }
      trace.active = false
      return trace.samples
    })
    const afterBounds = await math.boundingBox()
    if (!afterBounds) throw new Error("Restored math preview is unavailable")
    const afterScrollTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(2)
    expect(
      Math.max(...samples.map((sample) => Math.abs(sample - beforeScrollTop)))
    ).toBeLessThanOrEqual(2)
    expect(Math.abs(afterScrollTop - beforeScrollTop)).toBeLessThanOrEqual(2)
    expect(Math.abs(afterBounds.y - mathBounds.y)).toBeLessThanOrEqual(2)
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("footnotes use the shared tooltip and Mod-click navigation policy", async () => {
  const filler = Array.from(
    { length: 80 },
    (_value, index) => `Filler paragraph ${index}.`
  ).join("\n\n")
  const fixture = await extensionFixture(
    "footnotes",
    [
      "Task interaction fixture.",
      "",
      "This paragraph keeps the checkbox clear of the window-drag reveal zone.",
      "",
      "- [ ] Interactive task",
      "",
      "A cited statement[^note].",
      "",
      filler,
      "",
      "[^note]: Footnote body.",
    ].join("\n"),
    { footnotes: true }
  )

  try {
    const page = await fixture.app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    const checkbox = page.locator(".cm-md-task-checkbox")
    await checkbox.click()
    await expect(checkbox).toBeChecked()
    const modeShortcut =
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Alt+V"
    await page.locator("body").focus()
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-content")).toContainText(
      "- [x] Interactive task"
    )
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)

    const reference = page.locator(".cm-md-footnote-navigation")
    const linkTooltip = page.locator('[data-slot="tooltip-content"][data-open]')
    await expect(reference).not.toHaveAttribute("title")
    await page.mouse.move(10, 200)
    await reference.hover()
    await expect(reference).toHaveCSS("cursor", "text")
    await expect(linkTooltip).toHaveText("Go to footnote 1: note")

    await page.keyboard.down(modifier)
    await expect(reference).toHaveCSS("cursor", "pointer")
    await expect(linkTooltip).toHaveText("Go to footnote 1: note")
    await page.keyboard.up(modifier)
    await expect(reference).toHaveCSS("cursor", "text")

    await reference.click()
    await expect(reference).toHaveCount(0)
    await expect(linkTooltip).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText("[^note]")
    await page.keyboard.press("Escape")
    await expect(reference).toHaveCount(1)

    const scroller = page.locator(".cm-scroller")
    await reference.click({ modifiers: [modifier] })
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100)
    await expect(page.locator(".cm-content")).toBeFocused()

    const definition = page.locator("button.cm-md-footnote-definition-label")
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-caret-hidden/)
    await expect(definition).toBeVisible()
    await expect(definition).not.toHaveAttribute("title")
    await expect(definition).toHaveCSS("cursor", "text")
    const definitionGeometry = await definition.evaluate((label) => {
      const line = label.closest<HTMLElement>(".cm-line")
      if (!line) throw new Error("Footnote definition line is unavailable")
      return {
        labelLeft: label.getBoundingClientRect().left,
        lineLeft: line.getBoundingClientRect().left,
        linePaddingLeft: Number.parseFloat(getComputedStyle(line).paddingLeft),
      }
    })
    expect(definitionGeometry.linePaddingLeft).toBeGreaterThan(0)
    expect(definitionGeometry.labelLeft).toBeGreaterThanOrEqual(
      definitionGeometry.lineLeft - 0.5
    )
    await page.keyboard.down(modifier)
    await expect(definition).toHaveCSS("cursor", "pointer")
    await page.keyboard.up(modifier)
    await expect(definition).toHaveCSS("cursor", "text")
    await definition.click()
    await expect(definition).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText("[^note]:")
    await expect(page.locator(".cm-editor")).not.toHaveClass(
      /cm-md-caret-hidden/
    )
    await page.keyboard.press("Escape")
    await expect(definition).toHaveCount(1)
    await definition.click({ modifiers: [modifier] })
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(100)
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("tall nested callout virtualization keeps wheel anchors and document height stable @renderer-isolated", async () => {
  test.setTimeout(45_000)
  const before = Array.from(
    { length: 120 },
    (_value, index) => `Before paragraph ${index}.`
  ).join("\n\n")
  const nestedBody = Array.from(
    { length: 500 },
    (_value, index) =>
      `> > Nested body ${index}. Ordinary text remains rendered.`
  ).join("\n> >\n")
  const after = Array.from(
    { length: 80 },
    (_value, index) => `After paragraph ${index}.`
  ).join("\n\n")
  const fixture = await extensionFixture(
    "tall-nested-callout-scroll-stability",
    [
      before,
      "",
      "> [!NOTE] Outer callout",
      "> Outer lead.",
      ">",
      "> > [!TIP] Tall nested callout",
      nestedBody,
      ">",
      "> Outer tail.",
      "",
      after,
    ].join("\n"),
    {}
  )

  try {
    const page = await fixture.app.firstWindow()
    await fixture.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    const content = page.locator(".cm-content")
    const scroller = page.locator(".cm-scroller")
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")
    await content.evaluate((element) => {
      const editorContent = element as HTMLElement & {
        cmTile?: {
          view?: {
            dispatch(spec: {
              scrollIntoView: boolean
              selection: { anchor: number }
            }): void
            state: { doc: { toString(): string } }
          }
        }
      }
      const view = editorContent.cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const position = view.state.doc.toString().indexOf("Nested body 250.")
      if (position < 0) throw new Error("Nested callout target is unavailable")
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
    })

    const waitForFrames = (count = 2) =>
      page.evaluate(async (frameCount) => {
        for (let frame = 0; frame < frameCount; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      }, count)
    await waitForFrames(5)

    interface VisibleLineAnchor {
      readonly position: number
      readonly top: number
    }

    interface NestedCalloutSnapshot {
      readonly anchors: readonly VisibleLineAnchor[]
      readonly scrollHeight: number
    }

    const snapshot = () =>
      scroller.evaluate((element): NestedCalloutSnapshot => {
        const content = element.querySelector<HTMLElement>(".cm-content")
        const editorContent = content as HTMLElement & {
          cmTile?: {
            view?: {
              posAtDOM(node: Node, offset?: number): number
              state: {
                doc: {
                  lineAt(position: number): { from: number }
                }
              }
            }
          }
        }
        const view = editorContent.cmTile?.view
        if (!view || !content) throw new Error("CodeMirror view is unavailable")

        const bounds = element.getBoundingClientRect()
        const anchors = [...content.querySelectorAll(".cm-line")]
          .map((line) => {
            const lineBounds = line.getBoundingClientRect()
            const position = view.posAtDOM(line, 0)
            return {
              position: view.state.doc.lineAt(position).from,
              top: lineBounds.top - bounds.top,
            }
          })
          .filter(
            (anchor) => anchor.top > -100 && anchor.top < bounds.height + 100
          )
        return { anchors, scrollHeight: element.scrollHeight }
      })

    await scroller.hover()
    let previous = await snapshot()
    const initialScrollHeight = previous.scrollHeight
    const anomalies: Array<{
      maximumError: number | null
      medianTranslation: number | null
      step: number
    }> = []

    for (let step = 0; step < 80; step += 1) {
      await page.mouse.wheel(0, 32)
      await waitForFrames()
      const next = await snapshot()
      const nextAnchors = new Map(
        next.anchors.map((anchor) => [anchor.position, anchor] as const)
      )
      const translations = previous.anchors.flatMap((anchor) => {
        const matching = nextAnchors.get(anchor.position)
        return matching ? [matching.top - anchor.top] : []
      })
      const sorted = [...translations].sort((left, right) => left - right)
      const medianTranslation = sorted[Math.floor(sorted.length / 2)] ?? null
      const maximumError =
        translations.length === 0
          ? null
          : Math.max(
              ...translations.map((translation) => Math.abs(translation + 32))
            )
      if (
        medianTranslation == null ||
        maximumError == null ||
        Math.abs(medianTranslation + 32) > 2 ||
        maximumError > 2 ||
        next.scrollHeight !== initialScrollHeight
      ) {
        anomalies.push({ maximumError, medianTranslation, step })
      }
      previous = next
    }

    expect(anomalies).toEqual([])
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})

test("a far-down expanded callout owns and collapses its nested code block @renderer-isolated", async () => {
  const filler = Array.from(
    { length: 1_000 },
    (_value, index) => `Paragraph ${index}. Ordinary text.`
  ).join("\n\n")
  const fixture = await extensionFixture(
    "callout",
    [
      filler,
      "",
      "> [!SUCCESS]+ Combined feature card",
      "> This callout is below the initial parse window.",
      ">",
      "> ```typescript",
      "> const combined = true;",
      "> ```",
    ].join("\n"),
    {}
  )

  try {
    const page = await fixture.app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")
    await page.locator(".cm-scroller").evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })

    const callout = page.locator('.cm-md-callout[data-callout-type="success"]')
    const collapse = callout.getByRole("button", {
      name: "Collapse Combined feature card callout",
    })
    await expect(collapse).toBeVisible()
    await page.locator(".cm-scroller").evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(callout.locator(".cm-md-code-block")).toHaveCount(1)

    await collapse.click()
    const expand = callout.getByRole("button", {
      name: "Expand Combined feature card callout",
    })
    await expect(expand).toBeVisible()
    await expect(callout.locator(".cm-md-code-block")).toHaveCount(0)

    await expand.click()
    await expect(collapse).toBeVisible()
    await expect(callout.locator(".cm-md-code-block")).toHaveCount(1)
  } finally {
    await exitApplication(fixture.app)
    await rm(fixture.userData, { force: true, recursive: true })
  }
})
