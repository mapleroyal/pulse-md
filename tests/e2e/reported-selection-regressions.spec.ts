import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { _electron as electron, expect, test } from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

test("a focused new tab keeps a trailing callout coherent across modes", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-trailing-callout-")
  )
  const source = [
    "> [!Important] Rendering invariant",
    "> A trailing callout should remain coherent when focus changes between rendered and source modes.",
  ].join("\n")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()
    await expect
      .poll(() =>
        content.evaluate(
          (element) =>
            (
              element as HTMLElement & {
                cmTile?: { view?: { hasFocus: boolean } }
              }
            ).cmTile?.view?.hasFocus ?? false
        )
      )
      .toBe(true)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    const tabs = page.locator(".document-tab")
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveAttribute("data-active", "true")
    await expect(content).toBeFocused()
    await expect
      .poll(() =>
        content.evaluate(
          (element) =>
            (
              element as HTMLElement & {
                cmTile?: {
                  view?: { state: { doc: { toString(): string } } }
                }
              }
            ).cmTile?.view?.state.doc.toString() ?? null
        )
      )
      .toBe("")
    const pastedState = await content.evaluate((element, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", text)
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        })
      )
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              hasFocus: boolean
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
        callouts: element.querySelectorAll(".cm-md-callout").length,
        document: view.state.doc.toString(),
        focused: view.hasFocus,
        head: view.state.selection.main.head,
        lines: Array.from(
          element.querySelectorAll(".cm-line"),
          (line) => line.textContent ?? ""
        ),
      }
    }, source)
    expect(pastedState).toEqual({
      callouts: 0,
      document: source,
      focused: true,
      head: source.length,
      lines: source.split("\n"),
    })
    await expect(
      page.locator('.cm-md-callout[data-callout-type="important"]')
    ).toHaveCount(0)

    const callout = page.locator(
      '.cm-md-callout[data-callout-type="important"]'
    )
    await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: { view?: { contentDOM: HTMLElement } }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.contentDOM.blur()
    })
    await expect(content).not.toBeFocused()
    await expect(callout).toBeVisible()
    const staleFocus = await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              contentDOM: HTMLElement
              hasFocus: boolean
              setState(state: unknown): void
              state: unknown
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const blurredState = view.state
      view.contentDOM.focus()
      view.setState(blurredState)
      return {
        callouts: element.querySelectorAll(".cm-md-callout").length,
        focused: view.hasFocus,
      }
    })
    expect(staleFocus).toEqual({ callouts: 1, focused: true })
    await expect(content).toBeFocused()
    await expect(callout).toHaveCount(0)
    await expect(content.locator(".cm-line")).toHaveText(source.split("\n"))

    await page.keyboard.press("Escape")
    await expect(callout).toBeVisible()
    await expect(callout.locator(".cm-md-callout-header-line")).toHaveText(
      "Rendering invariant"
    )
    await expect(callout.locator(".cm-md-callout-body")).toContainText(
      "A trailing callout should remain coherent"
    )
    const visibleQuoteMarkers = await content.evaluate((element) => {
      const markers: Array<{ lineText: string; text: string }> = []
      const walker = element.ownerDocument.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT
      )
      for (
        let text = walker.nextNode() as Text | null;
        text;
        text = walker.nextNode() as Text | null
      ) {
        if (!text.data.includes(">")) continue
        const parent = text.parentElement
        if (!parent) continue
        const textFillColor = getComputedStyle(parent).webkitTextFillColor
        if (
          textFillColor === "transparent" ||
          textFillColor === "rgba(0, 0, 0, 0)"
        ) {
          continue
        }
        markers.push({
          lineText: parent.closest(".cm-line")?.textContent ?? "",
          text: text.data,
        })
      }
      return markers
    })
    expect(visibleQuoteMarkers).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

const reportedLinkDocument = [
  "1. **[P1] Single-line regex searches can freeze the renderer.**  ",
  "   The complexity guard returns early unless a regex may cross lines, so patterns such as `(?:a+)+$` bypass protection and execute synchronously in CodeMirror. A few dozen repeated characters followed by a non-match already produce exponential delays. Apply the complexity gate to every regex. [search-complexity.ts:230](/Users/example/Projects/pulse-md/src/editor/search-complexity.ts:230), [controller.ts:3218](/Users/example/Projects/pulse-md/src/editor/controller.ts:3218)",
  "",
  "",
].join("\n")

test("rendered link edges map to the complete Markdown source boundary", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-link-edge-"))
  const documentPath = path.join(userData, "link-edge.md")
  await writeFile(documentPath, reportedLinkDocument)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    const link = page
      .locator(".cm-md-link")
      .filter({ hasText: "controller.ts:3218" })
    await expect(link).toBeVisible()
    const snapshot = () =>
      content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                state: {
                  doc: { sliceString(from: number, to: number): string }
                  selection: {
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
        const selection = view.state.selection.main
        return {
          ...selection,
          anchor: selection.anchor,
          empty: selection.from === selection.to,
          head: selection.head,
          source: view.state.doc.sliceString(selection.from, selection.to),
        }
      })
    const startSelectionTransitionLog = () =>
      content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                dispatch(...specs: unknown[]): void
                state: { selection: { main: { head: number } } }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const ownerWindow = element.ownerDocument.defaultView as Window & {
          reportedLinkOriginalDispatch?: (...specs: unknown[]) => void
          reportedLinkTransitionHeads?: number[]
        }
        const heads: number[] = []
        ownerWindow.reportedLinkTransitionHeads = heads
        const originalDispatch = view.dispatch.bind(view)
        ownerWindow.reportedLinkOriginalDispatch = originalDispatch
        view.dispatch = (...specs: unknown[]) => {
          originalDispatch(...specs)
          heads.push(view.state.selection.main.head)
        }
      })
    const stopSelectionTransitionLog = () =>
      content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: { view?: { dispatch(...specs: unknown[]): void } }
          }
        ).cmTile?.view
        const ownerWindow = element.ownerDocument.defaultView as Window & {
          reportedLinkOriginalDispatch?: (...specs: unknown[]) => void
          reportedLinkTransitionHeads?: number[]
        }
        const heads = ownerWindow.reportedLinkTransitionHeads ?? []
        if (view && ownerWindow.reportedLinkOriginalDispatch) {
          view.dispatch = ownerWindow.reportedLinkOriginalDispatch
          delete ownerWindow.reportedLinkOriginalDispatch
        }
        return heads
      })
    const linkFrom = reportedLinkDocument.lastIndexOf("[controller.ts:3218]")
    const visibleLabelEnd = linkFrom + "[controller.ts:3218".length
    const linkEnd = reportedLinkDocument.lastIndexOf(")") + 1

    const outcomes = []
    for (const edgeOffset of [-0.5, 1]) {
      for (const delay of [0, 16, 100, 500]) {
        await page.keyboard.press("Escape")
        await expect(link).toBeVisible()
        const bounds = await link.boundingBox()
        if (!bounds) throw new Error("Rendered link is unavailable")
        await page.mouse.move(
          bounds.x + bounds.width + edgeOffset,
          bounds.y + bounds.height / 2
        )
        await page.mouse.down()
        if (delay > 0) await page.waitForTimeout(delay)
        await page.mouse.up()
        outcomes.push({ delay, edgeOffset, selection: await snapshot() })
      }
    }
    await page.keyboard.press("Escape")
    await expect(link).toBeVisible()
    const precisionBounds = await link.boundingBox()
    if (!precisionBounds) throw new Error("Rendered link is unavailable")
    await page.mouse.click(
      precisionBounds.x + precisionBounds.width / 2,
      precisionBounds.y + precisionBounds.height / 2
    )
    const interior = await snapshot()

    await page.keyboard.press("Escape")
    await expect(link).toBeVisible()
    const openingBounds = await link.boundingBox()
    if (!openingBounds) throw new Error("Rendered link is unavailable")
    await page.mouse.move(
      openingBounds.x - 1,
      openingBounds.y + openingBounds.height / 2
    )
    await page.mouse.down()
    await page.waitForTimeout(100)
    await page.mouse.up()
    const opening = await snapshot()

    await page.keyboard.press("Escape")
    await expect(link).toBeVisible()
    const linkBounds = await link.boundingBox()
    const scrollerBounds = await page.locator(".cm-scroller").boundingBox()
    if (!linkBounds || !scrollerBounds) {
      throw new Error("Link drag geometry is unavailable")
    }
    const linkEdge = {
      x: linkBounds.x + linkBounds.width + 1,
      y: linkBounds.y + linkBounds.height / 2,
    }
    const documentEnd = {
      x: linkEdge.x,
      y: Math.min(
        scrollerBounds.y + scrollerBounds.height - 20,
        linkEdge.y + 100
      ),
    }
    await page.mouse.move(linkEdge.x, linkEdge.y)
    await startSelectionTransitionLog()
    await page.mouse.down()
    await page.mouse.move(documentEnd.x, documentEnd.y, { steps: 8 })
    await page.mouse.up()
    const downward = await snapshot()
    const downwardHeads = await stopSelectionTransitionLog()

    await page.keyboard.press("Escape")
    await expect(link).toBeVisible()
    await page.mouse.move(documentEnd.x, documentEnd.y)
    await startSelectionTransitionLog()
    await page.mouse.down()
    await page.mouse.move(linkEdge.x, linkEdge.y, { steps: 8 })
    await page.mouse.up()
    const upward = await snapshot()
    const upwardHeads = await stopSelectionTransitionLog()

    await page.keyboard.press("Escape")
    await expect(link).toBeVisible()
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
    }, reportedLinkDocument.length)
    const shiftBounds = await link.boundingBox()
    if (!shiftBounds) throw new Error("Rendered link is unavailable")
    await page.keyboard.down("Shift")
    await page.mouse.click(
      shiftBounds.x + shiftBounds.width - 0.5,
      shiftBounds.y + shiftBounds.height / 2
    )
    await page.keyboard.up("Shift")
    const shifted = await snapshot()

    const destinationFrom = reportedLinkDocument.lastIndexOf("(/Users") + 1
    const destinationPosition = Math.floor((destinationFrom + linkEnd - 1) / 2)
    const revealedTarget = await content.evaluate(
      (element, { position, revealPosition }) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                coordsForChar(position: number): DOMRect | null
                dispatch(spec: { selection: { anchor: number } }): void
                posAndSideAtCoords(
                  coords: { x: number; y: number },
                  precise: false
                ): { pos: number }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        view.dispatch({ selection: { anchor: revealPosition } })
        const bounds = view.coordsForChar(position)
        if (!bounds) throw new Error("Revealed link destination is unavailable")
        const x = bounds.left + bounds.width / 4
        const y = (bounds.top + bounds.bottom) / 2
        return {
          expected: view.posAndSideAtCoords({ x, y }, false).pos,
          x,
          y,
        }
      },
      { position: destinationPosition, revealPosition: visibleLabelEnd - 1 }
    )
    expect(revealedTarget.expected).toBeGreaterThan(visibleLabelEnd)
    expect(revealedTarget.expected).toBeLessThan(linkEnd)
    await page.mouse.click(revealedTarget.x, revealedTarget.y)
    const revealedDestination = await snapshot()
    expect(
      outcomes.map(({ selection }) => ({
        empty: selection.empty,
        from: selection.from,
        source: selection.source,
        to: selection.to,
      }))
    ).toEqual(
      outcomes.map(() => ({
        empty: true,
        from: linkEnd,
        source: "",
        to: linkEnd,
      }))
    )
    expect(interior.empty).toBe(true)
    expect(interior.head).toBeGreaterThan(linkFrom)
    expect(interior.head).toBeLessThan(visibleLabelEnd)
    expect(opening).toMatchObject({
      empty: true,
      from: linkFrom,
      source: "",
      to: linkFrom,
    })
    expect(downward).toMatchObject({
      from: linkEnd,
      source: "\n\n",
      to: reportedLinkDocument.length,
    })
    const hiddenDestinationHeads = [...downwardHeads, ...upwardHeads].filter(
      (head) => head >= visibleLabelEnd && head < linkEnd
    )
    expect(hiddenDestinationHeads).toEqual([])
    expect(upward).toMatchObject({
      from: linkEnd,
      source: "\n\n",
      to: reportedLinkDocument.length,
    })
    expect(shifted).toMatchObject({
      anchor: reportedLinkDocument.length,
      from: linkEnd,
      head: linkEnd,
      source: "\n\n",
      to: reportedLinkDocument.length,
    })
    expect(revealedDestination).toMatchObject({
      empty: true,
      head: revealedTarget.expected,
    })
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("rendered link edges follow bidi source geometry", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-bidi-link-"))
  const source = "[שלום](https://example.com/hebrew)\n"
  const documentPath = path.join(userData, "bidi-link.md")
  await writeFile(documentPath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const link = page.locator(".cm-md-link").filter({ hasText: "שלום" })
    await expect(link).toBeVisible()
    const selectionHead = () =>
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
    const bounds = await link.boundingBox()
    if (!bounds) throw new Error("Rendered bidi link is unavailable")
    await page.mouse.click(bounds.x + 0.5, bounds.y + bounds.height / 2)
    expect(await selectionHead()).toBe(source.indexOf(")") + 1)

    await page.keyboard.press("Escape")
    await expect(link).toBeVisible()
    const rerenderedBounds = await link.boundingBox()
    if (!rerenderedBounds) throw new Error("Rendered bidi link is unavailable")
    await page.mouse.click(
      rerenderedBounds.x + rerenderedBounds.width - 0.5,
      rerenderedBounds.y + rerenderedBounds.height / 2
    )
    expect(await selectionHead()).toBe(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("rendered link hit testing stays constant with many mounted links", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-many-links-"))
  const source = Array.from(
    { length: 300 },
    (_, index) => `[Link ${index}](https://example.com/${index})`
  ).join(" ")
  const documentPath = path.join(userData, "many-links.md")
  await writeFile(documentPath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const links = page.locator(".cm-md-link")
    await expect(links).toHaveCount(300)
    await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              posAtDOM(node: Node, offset?: number): number
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const ownerWindow = element.ownerDocument.defaultView as Window & {
        linkEdgePosAtDOMCalls?: number
        linkEdgeOriginalPosAtDOM?: (node: Node, offset?: number) => number
      }
      ownerWindow.linkEdgePosAtDOMCalls = 0
      ownerWindow.linkEdgeOriginalPosAtDOM = view.posAtDOM.bind(view)
      view.posAtDOM = (node, offset) => {
        ownerWindow.linkEdgePosAtDOMCalls! += 1
        return ownerWindow.linkEdgeOriginalPosAtDOM!(node, offset)
      }
    })

    for (const index of [20, 80, 140, 200, 260]) {
      await page.keyboard.press("Escape")
      const link = links.filter({ hasText: `Link ${index}` }).first()
      await link.scrollIntoViewIfNeeded()
      await expect(link).toBeVisible()
      const bounds = await link.boundingBox()
      if (!bounds) throw new Error("Rendered link is unavailable")
      await page.mouse.click(
        bounds.x + bounds.width - 0.5,
        bounds.y + bounds.height / 2
      )
    }
    const calls = await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              posAtDOM(node: Node, offset?: number): number
            }
          }
        }
      ).cmTile?.view
      const ownerWindow = element.ownerDocument.defaultView as Window & {
        linkEdgePosAtDOMCalls?: number
        linkEdgeOriginalPosAtDOM?: (node: Node, offset?: number) => number
      }
      if (view && ownerWindow.linkEdgeOriginalPosAtDOM) {
        view.posAtDOM = ownerWindow.linkEdgeOriginalPosAtDOM
      }
      return ownerWindow.linkEdgePosAtDOMCalls ?? 0
    })
    expect(calls).toBeLessThan(80)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("a source drag tracks nested callout rows and keeps edge autoscrolling", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-callout-autoscroll-")
  )
  const documentPath = path.join(userData, "callout-autoscroll.md")
  const source = [
    "Outside before.",
    "",
    "> [!EXAMPLE] Outer callout",
    "> Intro.",
    ">",
    "> > [!TIP] Nested callout",
    "> > Nested body.",
    ">",
    ...Array.from(
      { length: 56 },
      (_, index) => `> Filler row ${String(index + 1).padStart(3, "0")}.`
    ),
    "",
    "Outside after.",
  ].join("\n")
  await writeFile(documentPath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(480, 420)
    })
    const content = page.locator(".cm-content")
    const scroller = page.locator(".cm-scroller")
    const outer = page.locator('.cm-md-callout[data-callout-type="example"]')
    const nested = outer.locator('.cm-md-callout[data-callout-type="tip"]')
    await expect(outer).toBeVisible()
    await expect(nested).toBeVisible()

    const outside = page
      .locator(".cm-line")
      .filter({ hasText: "Outside before." })
    const outsideBounds = await outside.boundingBox()
    const nestedBounds = await nested
      .locator(".cm-line")
      .filter({ hasText: "Nested body." })
      .boundingBox()
    if (!outsideBounds || !nestedBounds) {
      throw new Error("Nested callout drag geometry is unavailable")
    }
    await page.mouse.move(
      outsideBounds.x + outsideBounds.width - 2,
      outsideBounds.y + outsideBounds.height / 2
    )
    await page.mouse.down()
    // Enter a nested body directly; its endpoint remains the source row.
    await page.mouse.move(
      nestedBounds.x + nestedBounds.width / 2,
      nestedBounds.y + nestedBounds.height / 2
    )
    await expect(outer).not.toHaveAttribute("data-semantic-boundary-target", "")
    await expect(nested).not.toHaveAttribute(
      "data-semantic-boundary-target",
      ""
    )
    const nestedEntrySelection = await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              state: { selection: { main: { head: number } } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      return { head: view.state.selection.main.head }
    })
    expect(nestedEntrySelection.head).toBe(
      source.indexOf("Nested body.") + "Nested body.".length
    )
    const outerBounds = await outer.boundingBox()
    const scrollerBounds = await scroller.boundingBox()
    if (!outerBounds || !scrollerBounds) {
      throw new Error("Callout autoscroll geometry is unavailable")
    }
    expect(outerBounds.height).toBeGreaterThan(scrollerBounds.height * 3)
    const edgePoint = {
      x: outerBounds.x + outerBounds.width / 2,
      y: scrollerBounds.y + scrollerBounds.height - 32,
    }
    await page.mouse.move(edgePoint.x, edgePoint.y)
    expect(
      await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y)
        const outer = document.querySelector<HTMLElement>(
          '.cm-md-callout[data-callout-type="example"]'
        )
        return outer?.contains(target) ?? false
      }, edgePoint)
    ).toBe(true)
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(30)
    await expect
      .poll(
        () =>
          scroller.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop
          ),
        { timeout: 15_000 }
      )
      .toBeLessThanOrEqual(1)
    const outsideAfterFrom = source.lastIndexOf("Outside after.")
    await expect
      .poll(() =>
        content.evaluate((element) => {
          const view = (
            element as HTMLElement & {
              cmTile?: {
                view?: {
                  state: { selection: { main: { head: number } } }
                }
              }
            }
          ).cmTile?.view
          if (!view) throw new Error("CodeMirror view is unavailable")
          return view.state.selection.main.head
        })
      )
      .toBeGreaterThanOrEqual(outsideAfterFrom)
    const autoscrolledTop = await scroller.evaluate(
      (element) => element.scrollTop
    )
    await page.mouse.up()
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThanOrEqual(autoscrolledTop)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("upward drags past trailing inline code keep the line-end endpoint", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-inline-code-line-end-selection-")
  )
  const source = [
    "- Repetitions: `3`",
    "",
    "This packet contains inputs and captured outputs only. Model, runtime, date, timing, and host identity are intentionally omitted.",
  ].join("\n")
  const documentPath = path.join(userData, "inline-code-line-end.md")
  await writeFile(documentPath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await expect(page.locator(".cm-md-inline-code")).toHaveText("3")

    const points = await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              coordsAtPos(position: number, side?: -1 | 1): DOMRect | null
              state: {
                doc: {
                  length: number
                  line(number: number): { to: number }
                }
              }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const firstLineTo = view.state.doc.line(1).to
      const start = view.coordsAtPos(view.state.doc.length, -1)
      const end = view.coordsAtPos(firstLineTo, -1)
      if (!start || !end) {
        throw new Error("Selection endpoint geometry is unavailable")
      }
      return {
        end: { x: end.right + 32, y: (end.top + end.bottom) / 2 },
        firstLineTo,
        start: { x: start.right + 4, y: (start.top + start.bottom) / 2 },
      }
    })

    await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(...specs: unknown[]): void
              state: { selection: { main: { head: number } } }
            }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const ownerWindow = element.ownerDocument.defaultView as Window & {
        inlineCodeSelectionHeads?: number[]
        inlineCodeSelectionOriginalDispatch?: (...specs: unknown[]) => void
      }
      ownerWindow.inlineCodeSelectionHeads = []
      const originalDispatch = view.dispatch.bind(view)
      ownerWindow.inlineCodeSelectionOriginalDispatch = originalDispatch
      view.dispatch = (...specs: unknown[]) => {
        originalDispatch(...specs)
        ownerWindow.inlineCodeSelectionHeads!.push(
          view.state.selection.main.head
        )
      }
    })

    await page.mouse.move(points.start.x, points.start.y)
    await page.mouse.down()
    await page.mouse.move(points.end.x, points.end.y, { steps: 12 })
    for (let offset = -2; offset <= 2; offset += 1) {
      await page.mouse.move(points.end.x + offset, points.end.y)
    }
    await page.mouse.up()

    const outcome = await content.evaluate((element) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: {
              dispatch(...specs: unknown[]): void
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
      const ownerWindow = element.ownerDocument.defaultView as Window & {
        inlineCodeSelectionHeads?: number[]
        inlineCodeSelectionOriginalDispatch?: (...specs: unknown[]) => void
      }
      if (ownerWindow.inlineCodeSelectionOriginalDispatch) {
        view.dispatch = ownerWindow.inlineCodeSelectionOriginalDispatch
      }
      const selection = view.state.selection.main
      return {
        head: selection.head,
        heads: ownerWindow.inlineCodeSelectionHeads ?? [],
        selected: view.state.doc.sliceString(selection.from, selection.to),
      }
    })
    expect(outcome.head).toBe(points.firstLineTo)
    expect(outcome.selected).toBe(source.slice(points.firstLineTo))
    const firstLineEnd = outcome.heads.indexOf(points.firstLineTo)
    expect(firstLineEnd).toBeGreaterThanOrEqual(0)
    expect(
      outcome.heads
        .slice(firstLineEnd)
        .every((head) => head === points.firstLineTo)
    ).toBe(true)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
