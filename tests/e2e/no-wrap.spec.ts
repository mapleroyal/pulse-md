import type { EditorView } from "@codemirror/view"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const selectToLineEndKey =
  process.platform === "darwin" ? "Meta+Shift+ArrowRight" : "Shift+End"
const imageSource =
  '![Embedded](<data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%223000%22%20height=%22300%22%3E%3Crect%20width=%223000%22%20height=%22300%22%20fill=%22%232563eb%22/%3E%3C/svg%3E> "Embedded image")'
const yamlValue = "WideYamlValue".repeat(160)
const longText = "0123456789".repeat(500)
const calloutTail = " selection feedback stays visible".repeat(30)
const calloutBody = `A callout body with **strong syntax** whose${calloutTail}.`
const quoteBody = `A plain quote with ${"unwrapped quoted text ".repeat(60)}`
const markdown = [
  "---",
  `title: ${yamlValue}`,
  "category: no-wrap",
  "---",
  "",
  `An intentionally long unwrapped prose line ${longText}`,
  "",
  "---",
  "",
  imageSource,
  "",
  `| Feature | ${"WideResult".repeat(80)} |`,
  "| --- | --- |",
  "| Callouts | Bounded |",
  "",
  "$$",
  String.raw`\int_a^b f(x)\,dx`,
  "= F(b) - F(a)",
  "$$",
  "",
  "> [!NOTE] Bounded callout",
  `> ${calloutBody}`,
  ">",
  "> ```json",
  '> {"nested": true}',
  "> ```",
  "",
  `> ${quoteBody}`,
  "",
  "<div><strong>Bounded HTML</strong></div>",
  "",
  "```mermaid",
  "flowchart LR",
  "  Source --> Preview",
  "```",
].join("\n")

async function launchNoWrapEditor(content = markdown, lineWrapping = false) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-no-wrap-"))
  const filePath = path.join(userData, "no-wrap.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.lineWrapping = lineWrapping
  settings.markdownExtensions.latex = true
  settings.markdownExtensions.mermaid = true
  settings.markdownExtensions.sanitizedHtml = true
  settings.markdownExtensions.yamlFrontMatter = true
  settings.maxContentWidth = 720
  await Promise.all([
    writeFile(filePath, content),
    writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify(settings, null, 2)
    ),
  ])

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1_000, 900)
  })
  await page.locator(".cm-editor").waitFor()
  return { app, page, userData }
}

test("no-wrap mode switching keeps the active rendered table cell in place", async () => {
  const fixture = await readFile(
    path.join(projectRoot, "markdown-test.md"),
    "utf8"
  )
  const { app, page, userData } = await launchNoWrapEditor(fixture)

  try {
    await page.locator(".cm-content").evaluate((element) => {
      const view = (
        element as HTMLElement & {
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
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const anchor = view.state.doc
        .toString()
        .indexOf("The parser accepts alignment colons")
      if (anchor < 0) throw new Error("The GFM table passage is unavailable")
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
    })
    await settleGeometry(page)
    const cell = page
      .locator(".cm-md-table-cell")
      .filter({ hasText: /^Two$/ })
      .first()
    await cell.scrollIntoViewIfNeeded()
    await expect(cell).toBeVisible()
    const target = await cell.evaluate((element) => {
      const text = [...element.childNodes].find(
        (node): node is Text =>
          node.nodeType === Node.TEXT_NODE &&
          node.textContent?.includes("Two") === true
      )
      if (!text) throw new Error("The rendered Two cell text is unavailable")
      const offset = text.data.indexOf("Two")
      const range = element.ownerDocument.createRange()
      range.setStart(text, offset)
      range.setEnd(text, offset + "Two".length)
      const textBounds = range.getBoundingClientRect()
      const cellBounds = element.getBoundingClientRect()
      return {
        x: Math.min(textBounds.right + 2, cellBounds.right - 1),
        y: textBounds.top + textBounds.height / 2,
      }
    })
    await page.mouse.click(target.x, target.y)
    await settleGeometry(page, 12)

    const anchorSnapshot = () =>
      page.locator(".cm-content").evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                coordsAtPos(position: number, side?: number): DOMRect | null
                state: {
                  doc: {
                    lineAt(position: number): { text: string }
                    sliceString(from: number, to: number): string
                  }
                  selection: {
                    main: {
                      assoc: number
                      from: number
                      head: number
                      to: number
                    }
                  }
                }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const selection = view.state.selection.main
        const coordinates = view.coordsAtPos(
          selection.head,
          selection.assoc === 0 ? undefined : selection.assoc
        )
        const scroller =
          element.ownerDocument.querySelector<HTMLElement>(".cm-scroller")
        if (!coordinates || !scroller) {
          throw new Error("The table selection anchor is unavailable")
        }
        return {
          assoc: selection.assoc,
          line: view.state.doc.lineAt(selection.head).text,
          mode: element.closest(".cm-editor")?.classList.contains("cm-md-live")
            ? "live"
            : "source",
          screenTop: coordinates.top - scroller.getBoundingClientRect().top,
          selected: view.state.doc.sliceString(selection.from, selection.to),
          selectionHead: selection.head,
          scrollTop: scroller.scrollTop,
        }
      })

    const renderedBefore = await anchorSnapshot()
    expect(renderedBefore.line).toContain("| One | Two | Three |")
    expect(renderedBefore.assoc).toBe(-1)

    await page.locator(".top-chrome-hover-sensor-top").hover()
    await page.getByRole("button", { name: "Switch to Raw Markdown" }).click()
    await expect(page.locator(".cm-editor")).not.toHaveClass(/cm-md-live/)
    await settleGeometry(page, 12)
    const source = await anchorSnapshot()
    expect(source.selectionHead).toBe(renderedBefore.selectionHead)
    expect(
      Math.abs(source.screenTop - renderedBefore.screenTop),
      JSON.stringify({ renderedBefore, source })
    ).toBeLessThanOrEqual(2)

    await page
      .getByRole("button", { name: "Switch to Rendered Markdown" })
      .click()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await settleGeometry(page, 12)
    const renderedAfter = await anchorSnapshot()
    expect(renderedAfter.selectionHead).toBe(renderedBefore.selectionHead)
    expect(
      Math.abs(renderedAfter.screenTop - renderedBefore.screenTop),
      JSON.stringify({ renderedAfter, renderedBefore, source })
    ).toBeLessThanOrEqual(2)
  } finally {
    await closeNoWrapEditor(app, userData)
  }
})

async function closeNoWrapEditor(
  app: Awaited<ReturnType<typeof launchNoWrapEditor>>["app"],
  userData: string
) {
  await exitApplication(app)
  await rm(userData, { force: true, recursive: true })
}

async function settleGeometry(page: Page, frames = 2) {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
    }
  }, frames)
}

test("no-wrap bounds rendered blocks while prose and rules stay intrinsic", async () => {
  const { app, page, userData } = await launchNoWrapEditor()

  try {
    await expect(page.locator(".cm-md-math-block .katex")).toHaveCount(1)
    await expect(page.locator(".cm-md-mermaid svg")).toHaveCount(1)
    await expect(page.locator(".cm-md-yaml-frontmatter")).toHaveCount(1)

    const layout = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")
      const content = document.querySelector<HTMLElement>(".cm-content")
      if (!scroller || !content) throw new Error("Editor layout is unavailable")
      const scrollerBounds = scroller.getBoundingClientRect()
      const selectors = [
        ".cm-md-yaml-frontmatter",
        ".cm-md-image",
        ".cm-md-table-scroll",
        ".cm-md-math-block",
        ".cm-md-callout",
        ".cm-md-callout-body",
        ".cm-md-code-block",
        ".cm-md-quote-block",
        ".cm-md-html-block",
        ".cm-md-mermaid",
      ]
      const blocks = selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) throw new Error(`${selector} is unavailable`)
        const bounds = element.getBoundingClientRect()
        return {
          clientWidth: element.clientWidth,
          left: bounds.left,
          right: bounds.right,
          scrollWidth: element.scrollWidth,
          selector,
          width: bounds.width,
        }
      })
      const math = document
        .querySelector<HTMLElement>(".cm-md-math-block .katex-html")
        ?.getBoundingClientRect()
      const mermaid = document
        .querySelector<SVGElement>(".cm-md-mermaid svg")
        ?.getBoundingClientRect()
      const rule = document
        .querySelector<HTMLElement>(".cm-md-horizontal-rule-line")
        ?.getBoundingClientRect()
      if (!math || !mermaid || !rule) {
        throw new Error("Rendered block geometry is unavailable")
      }
      return {
        blocks,
        contentWidth: content.getBoundingClientRect().width,
        math: { left: math.left, right: math.right },
        mermaid: { left: mermaid.left, right: mermaid.right },
        ruleWidth: rule.width,
        scroller: {
          left: scrollerBounds.left,
          right: scrollerBounds.right,
          width: scroller.clientWidth,
        },
      }
    })

    expect(layout.contentWidth).toBeGreaterThan(layout.scroller.width * 5)
    expect(layout.ruleWidth).toBeGreaterThan(layout.scroller.width * 5)
    for (const block of layout.blocks) {
      expect(block.width, block.selector).toBeLessThan(layout.scroller.width)
      expect(block.left, block.selector).toBeGreaterThanOrEqual(
        layout.scroller.left - 1
      )
      expect(block.right, block.selector).toBeLessThanOrEqual(
        layout.scroller.right + 1
      )
    }
    expect(
      layout.blocks.find(
        ({ selector }) => selector === ".cm-md-yaml-frontmatter"
      )!.scrollWidth
    ).toBeGreaterThan(
      layout.blocks.find(
        ({ selector }) => selector === ".cm-md-yaml-frontmatter"
      )!.clientWidth
    )
    expect(
      layout.blocks.find(({ selector }) => selector === ".cm-md-table-scroll")!
        .scrollWidth
    ).toBeGreaterThan(
      layout.blocks.find(({ selector }) => selector === ".cm-md-table-scroll")!
        .clientWidth
    )
    expect(
      layout.blocks.find(({ selector }) => selector === ".cm-md-callout-body")!
        .scrollWidth
    ).toBeGreaterThan(
      layout.blocks.find(({ selector }) => selector === ".cm-md-callout-body")!
        .clientWidth
    )
    expect(
      layout.blocks.find(({ selector }) => selector === ".cm-md-quote-block")!
        .scrollWidth
    ).toBeGreaterThan(
      layout.blocks.find(({ selector }) => selector === ".cm-md-quote-block")!
        .clientWidth
    )
    expect(layout.math.left).toBeGreaterThanOrEqual(layout.scroller.left - 1)
    expect(layout.math.right).toBeLessThanOrEqual(layout.scroller.right + 1)
    expect(layout.mermaid.left).toBeGreaterThanOrEqual(layout.scroller.left - 1)
    expect(layout.mermaid.right).toBeLessThanOrEqual(layout.scroller.right + 1)

    const image = page.locator(".cm-md-image")
    await image.scrollIntoViewIfNeeded()
    await image.click()
    const selectedImageSource = await page
      .locator(".cm-content")
      .evaluate((element) => {
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
    expect(selectedImageSource).toBe(imageSource)

    await page.locator(".cm-scroller").evaluate((element) => {
      element.scrollLeft = Math.min(
        element.scrollWidth - element.clientWidth,
        element.clientWidth
      )
    })
    const selectionGeometry = () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".cm-scroller")
        if (!scroller) throw new Error("Editor scroller is unavailable")
        const scrollerBounds = scroller.getBoundingClientRect()
        const scrollerScale = scrollerBounds.width / scroller.offsetWidth
        const visibleLeft =
          scrollerBounds.left + scroller.clientLeft * scrollerScale
        const visibleRight = visibleLeft + scroller.clientWidth * scrollerScale
        const markers = [
          ...document.querySelectorAll<HTMLElement>(
            ".cm-app-selectionBackground"
          ),
        ].map((element) => element.getBoundingClientRect())
        return {
          reachesVisibleEnd: markers.some(
            (marker) => marker.right >= visibleRight - 4
          ),
          scrollLeft: scroller.scrollLeft,
          visible: markers.some(
            (marker) => marker.right > visibleLeft && marker.left < visibleRight
          ),
        }
      })
    await expect
      .poll(selectionGeometry)
      .toMatchObject({ reachesVisibleEnd: true, visible: true })
    const scrolledSelection = await selectionGeometry()
    expect(scrolledSelection.scrollLeft).toBeGreaterThan(0)
    expect(scrolledSelection.visible).toBe(true)
    expect(scrolledSelection.reachesVisibleEnd).toBe(true)
  } finally {
    await closeNoWrapEditor(app, userData)
  }
})

test("no-wrap gives YAML one keyboard-aware horizontal surface", async () => {
  const { app, page, userData } = await launchNoWrapEditor()

  try {
    const yaml = page.locator(".cm-md-yaml-frontmatter")
    await expect(yaml).toHaveCount(1)
    await yaml.scrollIntoViewIfNeeded()

    const yamlSurface = await yaml.evaluate((element) => {
      const lines = [
        ...element.querySelectorAll<HTMLElement>(
          ":scope > .cm-md-yaml-frontmatter-line"
        ),
      ]
      return {
        allLinesShareSurface: lines.every(
          (line) => line.closest(".cm-md-yaml-frontmatter") === element
        ),
        hasPerLineScroller: lines.some((line) =>
          ["auto", "scroll"].includes(getComputedStyle(line).overflowX)
        ),
        lineCount: lines.length,
        surfaceIsScrollable: element.scrollWidth > element.clientWidth,
      }
    })
    expect(yamlSurface).toEqual({
      allLinesShareSurface: true,
      hasPerLineScroller: false,
      lineCount: 4,
      surfaceIsScrollable: true,
    })

    await page.locator(".cm-content").evaluate((element, value) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                scrollIntoView: boolean
                selection: { anchor: number }
                userEvent: string
              }): void
              focus(): void
              state: { doc: { toString(): string } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const anchor = view.state.doc.toString().indexOf(value)
      if (anchor < 0) throw new Error("YAML value source is unavailable")
      view.focus()
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
        userEvent: "select",
      })
    }, yamlValue)
    await settleGeometry(page)
    await page.keyboard.press(selectToLineEndKey)
    await settleGeometry(page)

    const yamlSelectionGeometry = () =>
      page.locator(".cm-content").evaluate((element) => {
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
        const surface = element.querySelector<HTMLElement>(
          ".cm-md-yaml-frontmatter"
        )
        const outer =
          element.ownerDocument.querySelector<HTMLElement>(".cm-scroller")
        if (!surface || !outer) throw new Error("YAML geometry is unavailable")
        const bounds = surface.getBoundingClientRect()
        const selectedRuns = [
          ...surface.querySelectorAll<HTMLElement>(
            ".cm-app-selection-foreground"
          ),
        ].map((run) => run.getBoundingClientRect())
        const { from, to } = view.state.selection.main
        return {
          outerScrollLeft: outer.scrollLeft,
          selectedSource: view.state.doc.sliceString(from, to),
          surfaceScrollLeft: surface.scrollLeft,
          visibleRun: selectedRuns.some(
            (run) => run.right > bounds.left && run.left < bounds.right
          ),
        }
      })

    await expect
      .poll(async () => (await yamlSelectionGeometry()).surfaceScrollLeft)
      .toBeGreaterThan(0)
    const selection = await yamlSelectionGeometry()
    expect(selection.selectedSource).toBe(yamlValue)
    expect(selection.surfaceScrollLeft).toBeGreaterThan(0)
    expect(selection.outerScrollLeft).toBeLessThan(2)
    expect(selection.visibleRun).toBe(true)
  } finally {
    await closeNoWrapEditor(app, userData)
  }
})

test("no-wrap keeps callout keyboard selection visible", async () => {
  const { app, page, userData } = await launchNoWrapEditor()

  try {
    const callout = page.locator(".cm-md-callout")
    await expect(callout).toBeVisible()
    await callout.scrollIntoViewIfNeeded()
    await page.locator(".cm-content").evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                scrollIntoView: boolean
                selection: { anchor: number }
                userEvent: string
              }): void
              focus(): void
              state: { doc: { toString(): string } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const anchor = view.state.doc.toString().indexOf("A callout body")
      if (anchor < 0) throw new Error("Callout body source is unavailable")
      view.focus()
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
        userEvent: "select.pointer",
      })
    })
    await settleGeometry(page)
    await expect(callout).toBeVisible()
    const caret = await page.locator(".cm-content").evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              state: {
                doc: {
                  lineAt(position: number): { from: number; text: string }
                }
                selection: { main: { empty: boolean; head: number } }
              }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const { empty, head } = view.state.selection.main
      const line = view.state.doc.lineAt(head)
      return { empty, lineOffset: head - line.from, lineText: line.text }
    })
    expect(caret.empty).toBe(true)
    expect(caret.lineText).toContain("A callout body")
    expect(caret.lineOffset).toBeLessThan(5)

    await page.keyboard.press(selectToLineEndKey)
    await settleGeometry(page)
    await expect(callout).toBeVisible()

    const calloutSelection = await page
      .locator(".cm-content")
      .evaluate((element) => {
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
        const callout = element.querySelector<HTMLElement>(".cm-md-callout")
        if (!callout) throw new Error("Rendered callout is unavailable")
        const body = callout.querySelector<HTMLElement>(".cm-md-callout-body")
        if (!body) throw new Error("Rendered callout body is unavailable")
        const bodyBounds = body.getBoundingClientRect()
        const selectedRuns = [
          ...body.querySelectorAll<HTMLElement>(".cm-app-selection-foreground"),
        ].map((run) => {
          const bounds = run.getBoundingClientRect()
          return {
            background: getComputedStyle(run).backgroundColor,
            left: bounds.left,
            right: bounds.right,
          }
        })
        const { from, to } = view.state.selection.main
        return {
          bodyScrollLeft: body.scrollLeft,
          markerCount: element.ownerDocument.querySelectorAll(
            ".cm-app-selectionBackground"
          ).length,
          outerScrollLeft:
            element.ownerDocument.querySelector<HTMLElement>(".cm-scroller")
              ?.scrollLeft ?? -1,
          selectedRuns,
          selectedSource: view.state.doc.sliceString(from, to),
          visibleRun: selectedRuns.some(
            (run) => run.right > bodyBounds.left && run.left < bodyBounds.right
          ),
        }
      })
    expect(calloutSelection.selectedSource.length).toBeGreaterThan(100)
    expect(calloutSelection.selectedSource).toContain("selection feedback")
    expect(calloutSelection.bodyScrollLeft).toBeGreaterThan(0)
    expect(calloutSelection.outerScrollLeft).toBeLessThan(2)
    expect(calloutSelection.markerCount).toBeGreaterThan(0)
    expect(calloutSelection.selectedRuns.length).toBeGreaterThan(0)
    expect(
      calloutSelection.selectedRuns.every(
        ({ background }) =>
          background !== "transparent" && background !== "rgba(0, 0, 0, 0)"
      )
    ).toBe(true)
    expect(calloutSelection.visibleRun).toBe(true)

    await page.locator(".cm-content").evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                scrollIntoView: boolean
                selection: { anchor: number }
                userEvent: string
              }): void
              state: { doc: { toString(): string } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const anchor = view.state.doc.toString().indexOf('{"nested": true}')
      if (anchor < 0) throw new Error("Nested code source is unavailable")
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
        userEvent: "select",
      })
    })
    await settleGeometry(page)
    const nestedCodeReveal = await callout.evaluate((element) => {
      const body = element.querySelector<HTMLElement>(".cm-md-callout-body")
      const code = element.querySelector<HTMLElement>(".cm-md-code-block")
      const outer =
        element.ownerDocument.querySelector<HTMLElement>(".cm-scroller")
      if (!body || !code || !outer) {
        throw new Error("Nested callout geometry is unavailable")
      }
      const bodyBounds = body.getBoundingClientRect()
      const codeBounds = code.getBoundingClientRect()
      return {
        bodyScrollLeft: body.scrollLeft,
        codeLeft: codeBounds.left,
        codeRight: codeBounds.right,
        laneLeft: bodyBounds.left,
        laneRight: bodyBounds.right,
        outerScrollLeft: outer.scrollLeft,
      }
    })
    expect(nestedCodeReveal.bodyScrollLeft).toBeLessThan(2)
    expect(nestedCodeReveal.outerScrollLeft).toBeLessThan(2)
    expect(nestedCodeReveal.codeLeft).toBeGreaterThanOrEqual(
      nestedCodeReveal.laneLeft - 1
    )
    expect(nestedCodeReveal.codeRight).toBeLessThanOrEqual(
      nestedCodeReveal.laneRight + 1
    )
  } finally {
    await closeNoWrapEditor(app, userData)
  }
})

for (const { lineWrapping, length } of [
  { lineWrapping: false, length: 2400 },
  { lineWrapping: false, length: 20000 },
  { lineWrapping: true, length: 2400 },
  { lineWrapping: true, length: 20000 },
]) {
  test(`code line boundaries keep the caret inside the block (${length} characters, document wrapping ${lineWrapping})`, async () => {
    const code = `const value = "${"0123456789".repeat(length / 10)}";`
    const content = [
      "before",
      "",
      "```ts",
      code,
      "short",
      "```",
      "",
      "after",
    ].join("\n")
    const { app, page, userData } = await launchNoWrapEditor(
      content,
      lineWrapping
    )

    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.focus()
      })
      await page
        .locator(".cm-md-code-content-line")
        .first()
        .click({
          position: { x: 100, y: 10 },
        })
      const start = content.indexOf(code)
      const end = start + code.length
      const middle = start + 450
      const selectMiddle = async () => {
        await page.locator(".cm-content").evaluate((element, anchor) => {
          const view = (
            element as HTMLElement & {
              cmTile?: { view?: EditorView }
            }
          ).cmTile?.view
          if (!view) throw new Error("CodeMirror view is unavailable")
          view.dispatch({ selection: { anchor }, scrollIntoView: true })
          view.focus()
        }, middle)
        await settleGeometry(page, 6)
      }
      const selection = () =>
        page.locator(".cm-content").evaluate((element) => {
          const view = (
            element as HTMLElement & {
              cmTile?: { view?: EditorView }
            }
          ).cmTile?.view
          if (!view) throw new Error("CodeMirror view is unavailable")
          const { anchor, head } = view.state.selection.main
          return { anchor, head }
        })
      const pressAndSampleCaret = async (key: string) => {
        const frames = page.evaluate(
          () =>
            new Promise<
              Array<{
                cursorLeft: number | null
                cursorRight: number | null
                blockLeft: number
                blockRight: number
              }>
            >((resolve) => {
              document.addEventListener(
                "keydown",
                function onKeyDown(event) {
                  if (
                    !["Home", "End", "ArrowLeft", "ArrowRight"].includes(
                      event.key
                    )
                  )
                    return
                  document.removeEventListener("keydown", onKeyDown, true)
                  const samples: Array<{
                    cursorLeft: number | null
                    cursorRight: number | null
                    blockLeft: number
                    blockRight: number
                  }> = []
                  const sample = () => {
                    const block = document
                      .querySelector(".cm-md-code-block")!
                      .getBoundingClientRect()
                    const cursor = document
                      .querySelector(".cm-cursor-primary")!
                      .getBoundingClientRect()
                    const layer = document.querySelector(".cm-cursorLayer")!
                    const layerStyle = getComputedStyle(layer)
                    const insets = layerStyle.clipPath
                      .match(/^inset\((.*)\)$/)?.[1]
                      .split(" ")
                      .map(Number.parseFloat)
                    const layerBounds = layer.getBoundingClientRect()
                    const clipLeft =
                      insets && layerStyle.overflow === "clip"
                        ? layerBounds.left +
                          (insets[3] ?? insets[1] ?? insets[0]!)
                        : -Infinity
                    const clipRight =
                      insets && layerStyle.overflow === "clip"
                        ? layerBounds.right - (insets[1] ?? insets[0]!)
                        : Infinity
                    const left = Math.max(cursor.left, clipLeft)
                    const right = Math.min(cursor.right, clipRight)
                    samples.push({
                      cursorLeft: right > left ? left : null,
                      cursorRight: right > left ? right : null,
                      blockLeft: block.left,
                      blockRight: block.right,
                    })
                    if (samples.length < 8) requestAnimationFrame(sample)
                    else resolve(samples)
                  }
                  requestAnimationFrame(sample)
                },
                { capture: true }
              )
            })
        )
        await page.keyboard.press(key)
        return frames
      }
      const keys = [
        { start: "Home", end: "End" },
        ...(process.platform === "darwin"
          ? [{ start: "Meta+ArrowLeft", end: "Meta+ArrowRight" }]
          : []),
      ]
      for (const boundary of keys) {
        await selectMiddle()
        for (const target of [
          { key: boundary.end, position: end },
          { key: boundary.start, position: start },
        ]) {
          const frames = await pressAndSampleCaret(target.key)
          expect(await selection()).toEqual({
            anchor: target.position,
            head: target.position,
          })
          for (const frame of frames) {
            if (frame.cursorLeft == null) continue
            expect(frame.cursorLeft).toBeGreaterThanOrEqual(frame.blockLeft - 1)
            expect(frame.cursorRight).toBeLessThanOrEqual(frame.blockRight + 1)
          }
          const block = page.locator(".cm-md-code-block")
          await expect
            .poll(() =>
              page.evaluate(() => {
                const cursor = document
                  .querySelector(".cm-cursor-primary")!
                  .getBoundingClientRect()
                const block = document
                  .querySelector(".cm-md-code-block")!
                  .getBoundingClientRect()
                return (
                  cursor.left >= block.left - 1 &&
                  cursor.right <= block.right + 1
                )
              })
            )
            .toBe(true)
          const scrollLeft = await block.evaluate(
            (element) => element.scrollLeft
          )
          await settleGeometry(page, 12)
          expect(await block.evaluate((element) => element.scrollLeft)).toBe(
            scrollLeft
          )
          await block.evaluate((element, atEnd) => {
            element.scrollLeft = atEnd ? 0 : element.scrollWidth
          }, target.position === end)
          await settleGeometry(page, 4)
          await page.keyboard.press(target.key)
          await expect
            .poll(() => block.evaluate((element) => element.scrollLeft))
            .toBe(scrollLeft)
          await settleGeometry(page, 6)
        }
        for (const target of [
          { key: boundary.end, position: end },
          { key: boundary.start, position: start },
        ]) {
          await selectMiddle()
          await page.keyboard.press(`Shift+${target.key}`)
          expect(await selection()).toEqual({
            anchor: middle,
            head: target.position,
          })
        }
      }
    } finally {
      await exitApplication(app)
      await rm(userData, { recursive: true, force: true })
    }
  })
}

for (const lineWrapping of [false, true]) {
  test(`manual code scrolling clips the caret and keeps the chosen viewport (document wrapping ${lineWrapping})`, async () => {
    const code = `const value = "${"0123456789".repeat(240)}";`
    const content = ["before", "", "```ts", code, "```", "", "after"].join("\n")
    const { app, page, userData } = await launchNoWrapEditor(
      content,
      lineWrapping
    )

    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.focus()
      })
      const line = page.locator(".cm-md-code-content-line")
      await line.click({ position: { x: 100, y: 10 } })
      const head = content.indexOf(code) + 450
      await page.locator(".cm-content").evaluate((element, anchor) => {
        const view = (
          element as HTMLElement & { cmTile?: { view?: EditorView } }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        view.dispatch({ selection: { anchor }, scrollIntoView: true })
        view.focus()
      }, head)
      await settleGeometry(page, 8)

      const snapshot = () =>
        page.locator(".cm-content").evaluate((element) => {
          const view = (
            element as HTMLElement & { cmTile?: { view?: EditorView } }
          ).cmTile?.view
          if (!view) throw new Error("CodeMirror view is unavailable")
          const block = element.querySelector<HTMLElement>(".cm-md-code-block")!
          const bounds = block.getBoundingClientRect()
          const cursor = view.scrollDOM
            .querySelector(".cm-cursor-primary")!
            .getBoundingClientRect()
          return {
            head: view.state.selection.main.head,
            scrollLeft: block.scrollLeft,
            outerWidth: view.scrollDOM.scrollWidth,
            outerScroll: view.scrollDOM.scrollLeft,
            left: bounds.left,
            right: bounds.right,
            cursorLeft: cursor.left,
            cursorRight: cursor.right,
          }
        })
      const caretPainted = async () => {
        const layer = page.locator(".cm-cursorLayer")
        await layer.evaluate((element) => {
          const style = (element as HTMLElement).style
          style.animation = "none"
          style.opacity = "1"
        })
        const caretBounds = await page
          .locator(".cm-cursor-primary")
          .boundingBox()
        if (!caretBounds) throw new Error("Caret geometry is unavailable")
        const clip = {
          x: 0,
          y: Math.floor(caretBounds.y),
          width: await page.evaluate(() => innerWidth),
          height: Math.ceil(caretBounds.height),
        }
        const visible = await page.screenshot({ clip })
        await layer.evaluate((element) => {
          ;(element as HTMLElement).style.visibility = "hidden"
        })
        const hidden = await page.screenshot({ clip })
        await layer.evaluate((element) => {
          ;(element as HTMLElement).style.visibility = ""
        })
        return !visible.equals(hidden)
      }
      const baseline = await snapshot()
      expect(await caretPainted()).toBe(true)
      const lineBounds = await line.boundingBox()
      if (!lineBounds) throw new Error("Code line geometry is unavailable")
      await page.mouse.move(
        (baseline.left + baseline.right) / 2,
        lineBounds.y + lineBounds.height / 2
      )

      for (const target of [
        baseline.scrollLeft - (baseline.right + 20 - baseline.cursorLeft),
        baseline.scrollLeft - 500,
        baseline.scrollLeft + (baseline.cursorLeft - baseline.left + 20),
        baseline.scrollLeft,
      ]) {
        const before = await snapshot()
        await page.mouse.wheel(target - before.scrollLeft, 0)
        await expect
          .poll(async () => Math.abs((await snapshot()).scrollLeft - target))
          .toBeLessThanOrEqual(1)
        await settleGeometry(page, 20)
        const after = await snapshot()
        expect(Math.abs(after.scrollLeft - target)).toBeLessThanOrEqual(1)
        expect(after.head).toBe(head)
        expect(after.outerWidth).toBe(baseline.outerWidth)
        expect(after.outerScroll).toBe(baseline.outerScroll)
        expect(await caretPainted()).toBe(target === baseline.scrollLeft)
      }

      await page.mouse.wheel(-500, 0)
      await settleGeometry(page, 8)
      await page.keyboard.press("ArrowRight")
      await settleGeometry(page, 8)
      const moved = await snapshot()
      expect(moved.head).toBe(head + 1)
      expect(moved.cursorLeft).toBeGreaterThanOrEqual(moved.left - 1)
      expect(moved.cursorRight).toBeLessThanOrEqual(moved.right + 1)
      expect(await caretPainted()).toBe(true)

      await page.mouse.wheel(-500, 0)
      await settleGeometry(page, 8)
      await page.keyboard.type("x")
      await settleGeometry(page, 8)
      const typed = await snapshot()
      expect(typed.head).toBe(head + 2)
      expect(typed.cursorLeft).toBeGreaterThanOrEqual(typed.left - 1)
      expect(typed.cursorRight).toBeLessThanOrEqual(typed.right + 1)
      expect(await caretPainted()).toBe(true)

      await page.locator(".cm-content").evaluate((element) => {
        const view = (
          element as HTMLElement & { cmTile?: { view?: EditorView } }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        view.dispatch({ selection: { anchor: 2 }, scrollIntoView: true })
      })
      await settleGeometry(page, 8)
      expect(await caretPainted()).toBe(true)
    } finally {
      await exitApplication(app)
      await rm(userData, { recursive: true, force: true })
    }
  })
}
