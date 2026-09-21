import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  _electron as electron,
  expect,
  test,
  type Locator,
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
const multiSelectionModifier =
  process.platform === "darwin" ? "Meta" : "Control"
const imageFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20"><rect width="32" height="20" fill="#4c7096"/></svg>'

const document = [
  "Lead paragraph for restoring ordinary source navigation.",
  "",
  "Adjacent emoji :rocket::rocket: after.",
  "",
  "Inline math $x + 1$ after.",
  "",
  "Image ![tiny](pixel.svg) after.",
  "",
  "Break before<br>after.",
  "",
  "<br>Leading break.",
  "",
  "Consecutive before<br><br>after.",
  "",
  "---",
  "",
  "A reference[^note].",
  "",
  "[^note]: Footnote body.",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "",
  "<div><strong>HTML block</strong></div>",
  "",
  "Outside before callout.",
  "",
  "> [!EXAMPLE]+ Callout card",
  "> Outer body.",
  ">",
  "> > [!TIP] Nested card",
  "> > Nested body.",
  ">",
  "> ```json",
  '> {"nested": true}',
  "> ```",
  "",
  "Outside after callout.",
  "",
  "```ts",
  "const ordinary = true;",
  "```",
  "",
  "1. Listed fence",
  "",
  "   ```js",
  "   const listed = true;",
  "   ```",
].join("\n")

interface SelectionSnapshot {
  readonly anchor: number
  readonly empty: boolean
  readonly from: number
  readonly head: number
  readonly source: string
  readonly to: number
  readonly ranges: readonly {
    readonly empty: boolean
    readonly from: number
    readonly source: string
    readonly to: number
  }[]
  readonly selectedSource: string
}

test("opaque preview gestures defer source selection and preserve rendered drags", async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-semantic-preview-selection-")
  )
  const filePath = path.join(userData, "semantic-preview-selection.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions = {
    ...settings.markdownExtensions,
    emojiExpansion: true,
    emojiRecognition: true,
    footnotes: true,
    latex: true,
    mermaid: true,
    sanitizedHtml: true,
  }
  await Promise.all([
    writeFile(filePath, document),
    writeFile(path.join(userData, "pixel.svg"), imageFixture),
    writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify(settings, null, 2)
    ),
  ])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()

    const centerInEditor = async (locator: Locator) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await locator.evaluate((element) => {
          const scroller = element.closest<HTMLElement>(".cm-scroller")
          if (!scroller) throw new Error("Editor scroller is unavailable")
          const elementBounds = element.getBoundingClientRect()
          const scrollerBounds = scroller.getBoundingClientRect()
          scroller.scrollTop +=
            elementBounds.top +
            elementBounds.height / 2 -
            (scrollerBounds.top + scrollerBounds.height / 2)
        })
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve())
            )
        )
      }
    }

    const selectionSnapshot = () =>
      content.evaluate((element): SelectionSnapshot => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  doc: { sliceString(from: number, to: number): string }
                  selection: {
                    ranges: readonly {
                      empty: boolean
                      from: number
                      to: number
                    }[]
                    main: {
                      anchor: number
                      empty: boolean
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
        const { anchor, empty, from, head, to } = view.state.selection.main
        const ranges = view.state.selection.ranges.map((range) => ({
          empty: range.empty,
          from: range.from,
          source: view.state.doc.sliceString(range.from, range.to),
          to: range.to,
        }))
        return {
          anchor,
          empty,
          from,
          head,
          source: view.state.doc.sliceString(from, to),
          to,
          ranges,
          selectedSource: ranges
            .filter((range) => !range.empty)
            .map((range) => range.source)
            .join(""),
        }
      })
    const expectSelection = async (from: number, source: string) => {
      await expect.poll(selectionSnapshot).toMatchObject({
        empty: false,
        from,
        source,
        to: from + source.length,
      })
    }

    const inlineMathSource = "$x + 1$"
    const inlineMathFrom = document.indexOf(inlineMathSource)
    const inlineMath = page.locator(".cm-md-math-inline")
    const inlineMathBounds = await inlineMath.boundingBox()
    if (!inlineMathBounds) throw new Error("Inline math is unavailable")
    const initialSelection = await selectionSnapshot()

    // Crossing the drag threshold on atomic math neither creates a rendered
    // DOM selection nor treats the release as a click.
    await page.mouse.move(
      inlineMathBounds.x + inlineMathBounds.width * 0.35,
      inlineMathBounds.y + inlineMathBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      inlineMathBounds.x + inlineMathBounds.width * 0.7,
      inlineMathBounds.y + inlineMathBounds.height / 2,
      { steps: 3 }
    )
    await page.mouse.up()
    expect(await selectionSnapshot()).toEqual(initialSelection)
    await expect(inlineMath).toHaveCount(1)
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(
      true
    )

    // Pointerdown itself is inert. A true click selects only the math body,
    // excluding both authored dollar delimiters, after pointerup.
    await page.mouse.move(
      inlineMathBounds.x + inlineMathBounds.width / 2,
      inlineMathBounds.y + inlineMathBounds.height / 2
    )
    await page.mouse.down()
    await expect.poll(selectionSnapshot).toEqual(initialSelection)
    await expect(inlineMath).toHaveCount(1)
    await page.mouse.up()
    await expectSelection(inlineMathFrom + 1, "x + 1")

    // Once the selected source is revealed, a second click uses ordinary
    // source placement rather than reselecting the semantic unit.
    const inlineMathLine = page
      .locator(".cm-line")
      .filter({ hasText: `Inline math ${inlineMathSource} after.` })
    const inlineMathTextPoint = await inlineMathLine.evaluate((line) => {
      const walker = line.ownerDocument.createTreeWalker(
        line,
        NodeFilter.SHOW_TEXT
      )
      for (
        let text = walker.nextNode() as Text | null;
        text;
        text = walker.nextNode() as Text | null
      ) {
        const offset = text.data.indexOf("x + 1")
        if (offset < 0) continue
        const range = line.ownerDocument.createRange()
        range.setStart(text, offset + 2)
        range.setEnd(text, offset + 3)
        const bounds = range.getBoundingClientRect()
        return {
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        }
      }
      throw new Error("Revealed inline math source is unavailable")
    })
    await page.mouse.click(inlineMathTextPoint.x, inlineMathTextPoint.y)
    const preciseMathSelection = await selectionSnapshot()
    expect(preciseMathSelection.empty).toBe(true)
    expect(preciseMathSelection.head).toBeGreaterThan(inlineMathFrom)
    expect(preciseMathSelection.head).toBeLessThan(
      inlineMathFrom + inlineMathSource.length
    )

    // Moving from one revealed construct into another opaque unit while the
    // caret is active must refresh the frozen pointer presentation.
    const secondEmojiFrom = document.indexOf(":rocket::rocket:") + 8
    await page.locator(".cm-md-emoji").nth(1).click()
    await expectSelection(secondEmojiFrom, ":rocket:")

    const imageSource = "![tiny](pixel.svg)"
    await page.locator(".cm-md-image").click()
    await expectSelection(document.indexOf(imageSource), imageSource)

    const htmlBreak = page
      .locator(".cm-line")
      .filter({ hasText: "Break before" })
      .locator(".cm-md-html-break")
    const htmlBreakPoint = await htmlBreak.evaluate((lineBreak) => {
      const bounds = lineBreak.getBoundingClientRect()
      return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 }
    })
    await page.mouse.click(htmlBreakPoint.x, htmlBreakPoint.y)
    await expectSelection(document.indexOf("<br>"), "<br>")

    const leadingBreak = page
      .locator(".cm-line")
      .filter({ hasText: "Leading break." })
      .locator(".cm-md-html-break")
    const leadingBreakPoint = await leadingBreak.evaluate((lineBreak) => {
      const bounds = lineBreak.getBoundingClientRect()
      return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 }
    })
    await page.mouse.click(leadingBreakPoint.x, leadingBreakPoint.y)
    await expectSelection(document.indexOf("<br>Leading"), "<br>")

    const consecutiveBreak = page
      .locator(".cm-line")
      .filter({ hasText: "Consecutive before" })
      .locator(".cm-md-html-break")
      .nth(1)
    const consecutiveBreakPoint = await consecutiveBreak.evaluate(
      (lineBreak) => {
        const bounds = lineBreak.getBoundingClientRect()
        return { x: bounds.left + 1, y: bounds.top + bounds.height / 2 }
      }
    )
    const consecutiveBreakFrom =
      document.indexOf("<br>", document.indexOf("Consecutive before")) + 4
    await page.mouse.click(consecutiveBreakPoint.x, consecutiveBreakPoint.y)
    await expectSelection(consecutiveBreakFrom, "<br>")

    const horizontalRuleFrom = document.indexOf("\n---\n") + 1
    await page.locator(".cm-md-horizontal-rule-line").click()
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: expect.any(Number),
    })
    const horizontalRuleSelection = await selectionSnapshot()
    expect(horizontalRuleSelection.head).toBeGreaterThanOrEqual(
      horizontalRuleFrom
    )
    expect(horizontalRuleSelection.head).toBeLessThanOrEqual(
      horizontalRuleFrom + 3
    )

    const referenceSource = "[^note]"
    const referenceFrom = document.indexOf(referenceSource)
    await page.locator(".cm-md-footnote-reference").click()
    await expectSelection(referenceFrom, referenceSource)

    const definitionSource = "[^note]: "
    const definitionFrom = document.lastIndexOf("[^note]:")
    await page.locator(".cm-md-footnote-definition-label").click()
    await expectSelection(definitionFrom, definitionSource)

    const displayMath = page.locator(".cm-md-math-block")
    const definitionLine = page
      .locator(".cm-line")
      .filter({ hasText: "Footnote body." })
    await centerInEditor(displayMath)
    const definitionLineBounds = await definitionLine.boundingBox()
    const displayMathBounds = await displayMath.boundingBox()
    if (!definitionLineBounds || !displayMathBounds) {
      throw new Error("Cross-boundary math drag geometry is unavailable")
    }
    const displayMathFrom = document.indexOf("$$\nx^2")
    await page.mouse.move(
      definitionLineBounds.x + definitionLineBounds.width - 3,
      definitionLineBounds.y + definitionLineBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(displayMathBounds.x + 8, displayMathBounds.y + 4, {
      steps: 5,
    })
    await page.mouse.up()
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: false,
      head: displayMathFrom,
    })
    const excludedMathSelection = await selectionSnapshot()
    expect(excludedMathSelection.ranges).toHaveLength(1)
    expect(excludedMathSelection.selectedSource).not.toContain("$$")
    expect(excludedMathSelection.selectedSource).not.toContain("x^2")
    await page.keyboard.press("Escape")
    await expect(displayMath).toHaveCount(1)

    // Keep this gesture distinct from the preceding synthetic drag so
    // Chromium reports a single-click drag rather than a double-click drag.
    await page.waitForTimeout(500)
    const inclusionDefinitionBounds = await definitionLine.boundingBox()
    const inclusionMathBounds = await displayMath.boundingBox()
    if (!inclusionDefinitionBounds || !inclusionMathBounds) {
      throw new Error("Inclusive math drag geometry is unavailable")
    }
    await page.mouse.move(
      inclusionDefinitionBounds.x + inclusionDefinitionBounds.width - 3,
      inclusionDefinitionBounds.y + inclusionDefinitionBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      inclusionMathBounds.x + inclusionMathBounds.width - 8,
      inclusionMathBounds.y + inclusionMathBounds.height - 4,
      { steps: 5 }
    )
    await page.mouse.up()
    // Chromium publishes its ordinary continuous drag selection at mouseup.
    // The semantic boundary replaces it with disjoint source ranges on the
    // following animation frame, and both states have the same head position.
    await expect
      .poll(async () => {
        const selection = await selectionSnapshot()
        return {
          head: selection.head,
          rangeCount: selection.ranges.length,
          source: selection.source,
        }
      })
      .toEqual({
        head: document.indexOf("x^2") + "x^2".length,
        rangeCount: 2,
        source: "x^2",
      })
    const crossMathSelection = await selectionSnapshot()
    expect(crossMathSelection.ranges).toHaveLength(2)
    expect(crossMathSelection.source).toBe("x^2")
    expect(crossMathSelection.selectedSource).not.toContain("$$")
    expect(crossMathSelection.selectedSource).toMatch(/x\^2$/)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+C" : "Control+C"
    )
    const copiedCrossMath = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    )
    expect(copiedCrossMath).toBe(crossMathSelection.selectedSource)
    await page.keyboard.press("Escape")
    await expect(displayMath).toHaveCount(1)

    await displayMath.click()
    await expectSelection(document.indexOf("x^2"), "x^2")
    await expect(content).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(displayMath).toHaveCount(1)

    // The newline consumed by the block presentation remains a real source
    // position: keyboard motion reveals source and advances exactly one unit.
    await content.evaluate((element, position) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: { selection: { anchor: number } }): void
              focus(): void
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({ selection: { anchor: position } })
      view.focus()
    }, displayMathFrom - 1)
    // The fixture focuses CodeMirror directly while the application caret is
    // still dismissed. Restore editing explicitly before testing keyboard
    // motion across the replacement boundary.
    await page.keyboard.press("Escape")
    await expect(content).toBeFocused()
    await page.keyboard.press("ArrowRight")
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: displayMathFrom,
    })
    await expect(displayMath).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(displayMath).toHaveCount(1)

    const mermaidSource = [
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n")
    await expect(page.locator(".cm-md-mermaid svg")).toHaveCount(1)
    await page.locator(".cm-md-mermaid").click()
    await expectSelection(document.indexOf(mermaidSource), mermaidSource)

    const htmlSource = "<div><strong>HTML block</strong></div>"
    const htmlBlock = page.locator(".cm-md-html-block")
    await htmlBlock.scrollIntoViewIfNeeded()
    const htmlTextBounds = await htmlBlock.locator("strong").boundingBox()
    if (!htmlTextBounds) throw new Error("Rendered HTML text is unavailable")
    const selectionBeforeHtmlDrag = await selectionSnapshot()
    await page.mouse.move(
      htmlTextBounds.x + 2,
      htmlTextBounds.y + htmlTextBounds.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      htmlTextBounds.x + htmlTextBounds.width - 2,
      htmlTextBounds.y + htmlTextBounds.height / 2,
      { steps: 3 }
    )
    await page.mouse.up()
    expect(await selectionSnapshot()).toEqual(selectionBeforeHtmlDrag)
    await expect(htmlBlock).toHaveCount(1)
    const htmlNativeSelection = await htmlBlock.evaluate((block) => {
      const selection = block.ownerDocument.getSelection()
      return {
        anchorInside: block.contains(selection?.anchorNode ?? null),
        focusInside: block.contains(selection?.focusNode ?? null),
        text: selection?.toString() ?? "",
      }
    })
    expect(htmlNativeSelection).toMatchObject({
      anchorInside: true,
      focusInside: true,
    })
    expect(htmlNativeSelection.text).toContain("HTML")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+C" : "Control+C"
    )
    const copiedHtml = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    )
    expect(copiedHtml).toContain("HTML")
    expect(copiedHtml).not.toContain("<strong>")

    await htmlBlock.click()
    await expectSelection(document.indexOf(htmlSource), htmlSource)

    const calloutSource = [
      "> [!EXAMPLE]+ Callout card",
      "> Outer body.",
      ">",
      "> > [!TIP] Nested card",
      "> > Nested body.",
      ">",
      "> ```json",
      '> {"nested": true}',
      "> ```",
    ].join("\n")
    const callout = page.locator('.cm-md-callout[data-callout-type="example"]')
    await page.keyboard.press("Escape")
    await centerInEditor(callout)

    // A drag originating in rendered callout text remains a native DOM
    // selection and clamps to the callout when the pointer exits it.
    const outerBody = callout
      .locator(".cm-line")
      .filter({ hasText: "Outer body." })
      .first()
    const outerBodyTextPoint = (textOffset = 1) =>
      outerBody.evaluate((line, requestedOffset) => {
        const walker = line.ownerDocument.createTreeWalker(
          line,
          NodeFilter.SHOW_TEXT
        )
        for (
          let text = walker.nextNode() as Text | null;
          text;
          text = walker.nextNode() as Text | null
        ) {
          const offset = text.data.indexOf("Outer body")
          if (offset < 0) continue
          const range = line.ownerDocument.createRange()
          const pointOffset = Math.min(
            text.data.length - 1,
            offset + requestedOffset
          )
          range.setStart(text, pointOffset)
          range.setEnd(text, pointOffset + 1)
          const bounds = range.getBoundingClientRect()
          return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          }
        }
        throw new Error("Rendered callout body text is unavailable")
      }, textOffset)
    const innerDragStart = await outerBodyTextPoint(1)
    const innerDragEnd = await outerBodyTextPoint(9)
    const selectionBeforeInnerDrag = await selectionSnapshot()
    await page.mouse.move(innerDragStart.x, innerDragStart.y)
    await page.mouse.down()
    await page.mouse.move(innerDragEnd.x, innerDragEnd.y, { steps: 5 })
    await expect(callout).toHaveCount(1)
    await expect(callout).toHaveAttribute("data-semantic-native-selection", "")
    const renderedSelectionPaint = await outerBody.evaluate((line) => ({
      backgroundColor: line.ownerDocument.defaultView?.getComputedStyle(
        line,
        "::selection"
      ).backgroundColor,
      windowInactive:
        line.closest(".cm-editor")?.classList.contains("cm-window-inactive") ??
        false,
    }))
    expect(renderedSelectionPaint.backgroundColor).toBe(
      renderedSelectionPaint.windowInactive
        ? "rgb(89, 97, 106)"
        : "rgb(76, 112, 150)"
    )
    await expect
      .poll(() =>
        callout.evaluate((element) => {
          const selection = element.ownerDocument.getSelection()
          return {
            anchorInside: element.contains(selection?.anchorNode ?? null),
            focusInside: element.contains(selection?.focusNode ?? null),
            text: selection?.toString() ?? "",
          }
        })
      )
      .toMatchObject({
        anchorInside: true,
        focusInside: true,
        text: "uter bod",
      })
    await expect.poll(selectionSnapshot).toEqual(selectionBeforeInnerDrag)
    await page.mouse.up()
    await expect(callout).toHaveCount(1)
    await expect.poll(selectionSnapshot).toEqual(selectionBeforeInnerDrag)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())

    // A rapid second drag still belongs to the rendered callout. Chromium
    // reports this mousedown with a repeated click count even though pointer
    // movement makes it another drag rather than a double-click activation.
    await page.mouse.move(innerDragStart.x, innerDragStart.y)
    await page.mouse.down({ clickCount: 2 })
    await page.mouse.move(innerDragEnd.x, innerDragEnd.y, { steps: 5 })
    await expect
      .poll(() =>
        callout.evaluate(
          (element) => element.ownerDocument.getSelection()?.toString() ?? ""
        )
      )
      .toBe("uter bod")
    await page.mouse.up({ clickCount: 2 })
    await expect(callout).toHaveCount(1)
    await expect.poll(selectionSnapshot).toEqual(selectionBeforeInnerDrag)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())

    const outerBodyPoint = await outerBodyTextPoint()
    await page.waitForTimeout(500)
    const clampedCalloutBounds = await callout.boundingBox()
    if (!clampedCalloutBounds) throw new Error("Callout is unavailable")
    await page.mouse.move(outerBodyPoint.x, outerBodyPoint.y)
    await page.mouse.down()
    await page.mouse.move(
      clampedCalloutBounds.x + clampedCalloutBounds.width / 2,
      clampedCalloutBounds.y + clampedCalloutBounds.height + 40,
      { steps: 5 }
    )
    // A wheel gesture while the primary button remains down must not orphan
    // the native range. Pointerup still claims it for rendered-only copying.
    await page.mouse.wheel(0, 12)
    await page.mouse.up()
    await expect(callout).toHaveCount(1)
    const calloutNativeSelection = await callout.evaluate((element) => {
      const selection = element.ownerDocument.getSelection()
      return {
        anchorInside: element.contains(selection?.anchorNode ?? null),
        focusInside: element.contains(selection?.focusNode ?? null),
        text: selection?.toString() ?? "",
      }
    })
    expect(calloutNativeSelection).toMatchObject({
      anchorInside: true,
      focusInside: true,
    })
    expect(calloutNativeSelection.text).toContain("uter body")
    expect(calloutNativeSelection.text).not.toContain("Outside after callout")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+C" : "Control+C"
    )
    const copiedCallout = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    )
    expect(copiedCallout).toContain("uter body")
    expect(copiedCallout).not.toContain("> [!EXAMPLE]")
    expect(copiedCallout).not.toContain("> ```")
    expect(copiedCallout).not.toContain("Outside after callout")

    const contextMenuPoint = await callout.evaluate((element) => {
      const selection = element.ownerDocument.getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const bounds = range
        ? [...range.getClientRects()].find(
            (candidate) => candidate.width > 2 && candidate.height > 2
          )
        : null
      if (!bounds) throw new Error("Rendered selection geometry is unavailable")
      return {
        x: bounds.left + Math.min(4, bounds.width / 2),
        y: bounds.top + bounds.height / 2,
      }
    })
    await page.mouse.click(contextMenuPoint.x, contextMenuPoint.y, {
      button: "right",
    })
    const calloutContextMenu = page.getByRole("menu", {
      name: "Editor context menu",
    })
    await expect(calloutContextMenu).toBeVisible()
    await expect(
      calloutContextMenu.getByRole("menuitem", { name: "Cut" })
    ).toBeDisabled()
    await calloutContextMenu.getByRole("menuitem", { name: "Copy" }).click()
    await expect(calloutContextMenu).not.toBeVisible()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain("uter body")
    const contextCopiedCallout = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    )
    expect(contextCopiedCallout).toContain("uter body")
    expect(contextCopiedCallout).not.toContain("> [!EXAMPLE]")

    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await expect(callout).toHaveCount(1)

    // A document mutation invalidates every source/DOM endpoint retained by
    // an in-flight semantic press. Its eventual pointerup must be inert.
    const selectionBeforeCanceledGesture = await selectionSnapshot()
    const canceledGesturePoint = await outerBodyTextPoint()
    await page.mouse.move(canceledGesturePoint.x, canceledGesturePoint.y)
    await page.mouse.down()
    await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                changes: { from: number; insert: string }
              }): void
              state: { doc: { length: number } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "\n" },
      })
    })
    await page.mouse.up()
    await expect.poll(selectionSnapshot).toMatchObject({
      anchor: selectionBeforeCanceledGesture.anchor,
      empty: selectionBeforeCanceledGesture.empty,
      head: selectionBeforeCanceledGesture.head,
    })
    await expect(callout).toHaveCount(1)
    await expect(page.locator(".cm-md-semantic-boundary-caret")).toHaveCount(0)
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(
      true
    )

    const nestedCalloutSource = [
      "> > [!TIP] Nested card",
      "> > Nested body.",
    ].join("\n")
    await page.waitForTimeout(500)
    await callout
      .locator('.cm-md-callout[data-callout-type="tip"] .cm-md-callout-body')
      .click()
    await expectSelection(
      document.indexOf(nestedCalloutSource),
      nestedCalloutSource
    )
    await expect(
      callout.locator('.cm-md-callout[data-callout-type="tip"]')
    ).toHaveCount(0)

    await callout.locator(".cm-md-code-content-line").click()
    await expectSelection(document.indexOf(calloutSource), calloutSource)
    await expect(callout).toHaveCount(0)

    const nestedCode = page
      .locator(".cm-md-code-block")
      .filter({ hasText: '"nested"' })
    const nestedRows = nestedCode.locator(":scope > .cm-line")
    await expect(nestedRows).toHaveCount(3)
    const nestedLaneX = await nestedRows.evaluateAll((rows) =>
      rows.map((row) => {
        const walker = row.ownerDocument.createTreeWalker(
          row,
          NodeFilter.SHOW_TEXT
        )
        for (
          let text = walker.nextNode() as Text | null;
          text;
          text = walker.nextNode() as Text | null
        ) {
          const offset = text.data.indexOf(">")
          if (offset < 0) continue
          const range = row.ownerDocument.createRange()
          range.setStart(text, offset)
          range.setEnd(text, offset + 1)
          return range.getBoundingClientRect().left
        }
        throw new Error("A nested code quote marker is unavailable")
      })
    )
    expect(
      Math.max(...nestedLaneX) - Math.min(...nestedLaneX)
    ).toBeLessThanOrEqual(1)
    await expect(nestedRows.nth(0)).toHaveClass(/cm-md-code-line-first/)
    await expect(nestedRows.nth(2)).toHaveClass(/cm-md-code-line-last/)

    await page.keyboard.press("Escape")
    await expect(callout).toHaveCount(1)

    const ordinaryCode = page
      .locator(".cm-md-code-block")
      .filter({ hasText: "ordinary" })
    const opening = ordinaryCode.locator(
      ":scope > .cm-line.cm-md-code-tools-line"
    )
    const contentRow = ordinaryCode.locator(
      ":scope > .cm-line.cm-md-code-content-line"
    )
    const closing = ordinaryCode.locator(
      ":scope > .cm-line.cm-md-code-line-last"
    )
    const ordinaryOpeningFrom = document.indexOf("```ts")
    const ordinaryContentFrom = document.indexOf("const ordinary")
    const ordinaryClosingFrom = document.indexOf("```", ordinaryContentFrom)

    await centerInEditor(ordinaryCode)
    await opening.click({ position: { x: 4, y: 8 } })
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: ordinaryOpeningFrom + "```ts".length,
    })

    const openingBounds = await opening.boundingBox()
    if (!openingBounds) throw new Error("Fence opener geometry is unavailable")
    await page.mouse.move(openingBounds.x + 4, openingBounds.y + 8)
    await page.mouse.down()
    await page.mouse.move(openingBounds.x + 4, openingBounds.y + 22, {
      steps: 3,
    })
    await page.mouse.up()
    await expect.poll(selectionSnapshot).toMatchObject({
      ranges: [
        {
          from: ordinaryOpeningFrom,
          to: ordinaryOpeningFrom,
        },
      ],
    })

    await opening.click({ position: { x: 4, y: 8 } })
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: ordinaryOpeningFrom + "```ts".length,
    })

    const shiftAnchor = document.indexOf("Lead paragraph") + 4
    await content.evaluate((element, position) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: { selection: { anchor: number } }): void
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({ selection: { anchor: position } })
    }, shiftAnchor)
    await opening.click({ modifiers: ["Shift"], position: { x: 4, y: 8 } })
    await expect.poll(selectionSnapshot).toMatchObject({
      anchor: shiftAnchor,
      empty: false,
      head: ordinaryOpeningFrom + "```ts".length,
    })

    await content.evaluate((element, position) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: { selection: { anchor: number } }): void
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({ selection: { anchor: position } })
    }, shiftAnchor)
    await opening.click({
      modifiers: [multiSelectionModifier],
      position: { x: 4, y: 8 },
    })
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: ordinaryOpeningFrom + "```ts".length,
      ranges: [
        {
          empty: true,
          from: shiftAnchor,
          to: shiftAnchor,
        },
        {
          empty: true,
          from: ordinaryOpeningFrom + "```ts".length,
          to: ordinaryOpeningFrom + "```ts".length,
        },
      ],
    })

    await closing.click({ position: { x: 4, y: 8 } })
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: ordinaryClosingFrom + 3,
      ranges: [
        {
          empty: true,
          from: ordinaryClosingFrom + 3,
          to: ordinaryClosingFrom + 3,
        },
      ],
    })
    await contentRow.click({ position: { x: 80, y: 8 } })
    const contentSelection = await selectionSnapshot()
    expect(contentSelection.empty).toBe(true)
    expect(contentSelection.head).toBeGreaterThanOrEqual(ordinaryContentFrom)
    expect(contentSelection.head).toBeLessThan(
      ordinaryContentFrom + "const ordinary = true;".length
    )

    const listedCode = page
      .locator(".cm-md-code-block")
      .filter({ hasText: "listed" })
    const listedOpening = listedCode.locator(
      ":scope > .cm-line.cm-md-code-tools-line"
    )
    const listedOpeningSource = "   ```js"
    const listedOpeningFrom = document.indexOf(listedOpeningSource)
    await listedOpening.click({ position: { x: 4, y: 8 } })
    await expect.poll(selectionSnapshot).toMatchObject({
      empty: true,
      head: listedOpeningFrom + listedOpeningSource.length,
    })

    await content.evaluate((element, position) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(spec: {
                scrollIntoView: boolean
                selection: { anchor: number }
              }): void
              focus(): void
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
      view.focus()
    }, inlineMathFrom - 1)
    await expect(page.locator(".cm-md-math-inline")).toHaveCount(1)
    await page.keyboard.press("ArrowRight")
    await expect
      .poll(selectionSnapshot)
      .toMatchObject({ empty: true, head: inlineMathFrom })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("rendered fenced-code drags keep stable content endpoints at both boundaries", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-rendered-code-selection-")
  )
  const filePath = path.join(userData, "rendered-code-selection.md")
  const source = [
    "Before.",
    "",
    "```ts",
    "const first = 1;",
    "const second = 2;",
    "const third = 3;",
    "```",
    "",
    "Between.",
    "",
    "> ```js",
    "> const quoted = true;",
    "> ```",
    "",
    "After.",
  ].join("\n")
  await writeFile(filePath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    await editor.waitFor()
    await page.keyboard.press("Escape")

    const codeSelectionSnapshot = () =>
      content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  doc: { sliceString(from: number, to: number): string }
                  selection: {
                    main: { from: number; head: number; to: number }
                  }
                }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const selection = view.state.selection.main
        return {
          head: selection.head,
          source: view.state.doc.sliceString(selection.from, selection.to),
        }
      })
    const setCodeCursor = (position: number) =>
      content.evaluate((element, anchor) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                dispatch(spec: { selection: { anchor: number } }): void
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        view.dispatch({ selection: { anchor } })
      }, position)

    const codeBlocks = page.locator(
      '.cm-md-code-block[data-code-kind="fenced"]'
    )
    await expect(codeBlocks).toHaveCount(2)
    const code = codeBlocks.first()
    const opening = code.locator(":scope > .cm-md-code-tools-line")
    const rows = code.locator(":scope > .cm-md-code-content-line")
    await expect(rows).toHaveCount(3)

    const shortDrag = await rows.first().evaluate((row) => {
      const walker = row.ownerDocument.createTreeWalker(
        row,
        NodeFilter.SHOW_TEXT
      )
      for (
        let text = walker.nextNode() as Text | null;
        text;
        text = walker.nextNode() as Text | null
      ) {
        const offset = text.data.indexOf("first")
        if (offset < 0) continue
        const range = row.ownerDocument.createRange()
        range.setStart(text, offset)
        range.setEnd(text, offset + 1)
        const bounds = range.getBoundingClientRect()
        return {
          endX: bounds.left + bounds.width * 0.75,
          startX: bounds.left + bounds.width * 0.25,
          y: bounds.top + bounds.height / 2,
        }
      }
      throw new Error("Rendered code text is unavailable")
    })
    expect(shortDrag.endX - shortDrag.startX).toBeLessThan(10)
    await page.mouse.move(shortDrag.startX, shortDrag.y)
    await page.mouse.down()
    await page.mouse.move(shortDrag.endX, shortDrag.y)
    await page.mouse.up()
    expect(await codeSelectionSnapshot()).toMatchObject({ source: "f" })
    await page.keyboard.press("Escape")
    await page.waitForTimeout(500)

    const openingBounds = await opening.boundingBox()
    const first = await rows.first().boundingBox()
    const third = await rows.last().boundingBox()
    if (!openingBounds || !first || !third) {
      throw new Error("Rendered code rows are unavailable")
    }
    await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(...specs: unknown[]): void
              state: { selection: { main: { anchor: number; head: number } } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const ownerWindow = element.ownerDocument.defaultView as Window & {
        codeSelectionTransitionLog?: { anchor: number; head: number }[]
      }
      const log: { anchor: number; head: number }[] = []
      ownerWindow.codeSelectionTransitionLog = log
      const originalDispatch = view.dispatch.bind(view)
      view.dispatch = (...specs: unknown[]) => {
        originalDispatch(...specs)
        log.push({
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        })
      }
    })

    const x = first.x + 120
    await page.mouse.move(x, third.y + third.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, openingBounds.y + openingBounds.height / 2, {
      steps: 16,
    })
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.move(
        x + (index % 2 === 0 ? 1 : -1),
        openingBounds.y + openingBounds.height / 2
      )
    }

    const firstContentFrom = source.indexOf("const first")
    const heldSelection = await codeSelectionSnapshot()
    const transitions = await page.evaluate(
      () =>
        (
          window as Window & {
            codeSelectionTransitionLog?: { anchor: number; head: number }[]
          }
        ).codeSelectionTransitionLog ?? []
    )
    await page.mouse.up()
    const releasedSelection = await codeSelectionSnapshot()

    expect(heldSelection.head).toBe(firstContentFrom)
    expect(heldSelection.source).not.toContain("```ts")
    expect(releasedSelection.head).toBe(firstContentFrom)
    expect(releasedSelection.source).not.toContain("```ts")
    const openingBoundaryTransition = transitions.findIndex(
      (selection) => selection.head === firstContentFrom
    )
    expect(openingBoundaryTransition).toBeGreaterThanOrEqual(0)
    expect(
      transitions
        .slice(openingBoundaryTransition)
        .every((selection) => selection.head === firstContentFrom)
    ).toBe(true)
    await expect(code).toHaveCount(1)

    await page.keyboard.press("Escape")
    await setCodeCursor(source.indexOf("Before."))
    const refreshedFirst = await rows.first().boundingBox()
    const closing = code.locator(
      ":scope > .cm-md-code-line-last:not(.cm-md-code-content-line)"
    )
    const closingBounds = await closing.boundingBox()
    if (!refreshedFirst || !closingBounds) {
      throw new Error("Rendered code boundary rows are unavailable")
    }
    await page.evaluate(() => {
      const log = (
        window as Window & {
          codeSelectionTransitionLog?: { anchor: number; head: number }[]
        }
      ).codeSelectionTransitionLog
      if (log) log.length = 0
    })
    await page.mouse.move(x, refreshedFirst.y + refreshedFirst.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, closingBounds.y + closingBounds.height / 2, {
      steps: 16,
    })
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.move(
        x + (index % 2 === 0 ? 1 : -1),
        closingBounds.y + closingBounds.height / 2
      )
    }
    const lastContentTo =
      source.indexOf("const third = 3;") + "const third = 3;".length
    const closingHeldSelection = await codeSelectionSnapshot()
    const closingTransitions = await page.evaluate(
      () =>
        (
          window as Window & {
            codeSelectionTransitionLog?: { anchor: number; head: number }[]
          }
        ).codeSelectionTransitionLog ?? []
    )
    await page.mouse.up()
    const closingReleasedSelection = await codeSelectionSnapshot()
    expect(closingHeldSelection.head).toBe(lastContentTo)
    expect(closingHeldSelection.source).not.toContain("```")
    expect(closingReleasedSelection.head).toBe(lastContentTo)
    expect(closingReleasedSelection.source).not.toContain("```")
    const closingBoundaryTransition = closingTransitions.findIndex(
      (selection) => selection.head === lastContentTo
    )
    expect(closingBoundaryTransition).toBeGreaterThanOrEqual(0)
    expect(
      closingTransitions
        .slice(closingBoundaryTransition)
        .every((selection) => selection.head === lastContentTo)
    ).toBe(true)

    await page.keyboard.press("Escape")
    await setCodeCursor(source.indexOf("Before."))
    const quotedCode = codeBlocks.nth(1)
    const quotedOpening = quotedCode.locator(":scope > .cm-md-code-tools-line")
    const refreshedThird = await rows.last().boundingBox()
    if (!refreshedThird) {
      throw new Error("Cross-block code boundary geometry is unavailable")
    }
    await page.evaluate(() => {
      const log = (
        window as Window & {
          codeSelectionTransitionLog?: { anchor: number; head: number }[]
        }
      ).codeSelectionTransitionLog
      if (log) log.length = 0
    })
    await page.mouse.move(x, refreshedThird.y + refreshedThird.height / 2)
    await page.mouse.down()
    const quotedOpeningBounds = await quotedOpening.boundingBox()
    if (!quotedOpeningBounds) {
      throw new Error("Quoted code boundary geometry is unavailable")
    }
    const quotedX = quotedOpeningBounds.x + 120
    await page.mouse.move(
      quotedX,
      quotedOpeningBounds.y + quotedOpeningBounds.height / 2,
      { steps: 16 }
    )
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.move(
        quotedX + (index % 2 === 0 ? 1 : -1),
        quotedOpeningBounds.y + quotedOpeningBounds.height / 2
      )
    }
    const quotedContentFrom = source.indexOf("const quoted")
    const crossBlockHeldSelection = await codeSelectionSnapshot()
    const crossBlockTransitions = await page.evaluate(
      () =>
        (
          window as Window & {
            codeSelectionTransitionLog?: { anchor: number; head: number }[]
          }
        ).codeSelectionTransitionLog ?? []
    )
    await page.mouse.up()
    const crossBlockReleasedSelection = await codeSelectionSnapshot()
    expect(crossBlockHeldSelection.head).toBe(quotedContentFrom)
    expect(crossBlockReleasedSelection.head).toBe(quotedContentFrom)
    const quotedBoundaryTransition = crossBlockTransitions.findIndex(
      (selection) => selection.head === quotedContentFrom
    )
    expect(quotedBoundaryTransition).toBeGreaterThanOrEqual(0)
    expect(
      crossBlockTransitions
        .slice(quotedBoundaryTransition)
        .every((selection) => selection.head === quotedContentFrom)
    ).toBe(true)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
