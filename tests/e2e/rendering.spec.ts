import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

async function listRowStarts(page: Page, text?: string) {
  let markerLines = page.locator(".cm-md-list-marker-line")
  if (text) markerLines = markerLines.filter({ hasText: text })
  return markerLines.evaluateAll((lines) =>
    lines.map((line) => {
      const rows = new Map<number, number>()
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const parent = node.parentElement
        if (
          !parent?.closest(
            ".cm-md-list-marker, .cm-md-list-marker-source, .cm-md-task-checkbox"
          )
        ) {
          const text = node.textContent ?? ""
          for (let index = 0; index < text.length; index += 1) {
            if (/\s/.test(text[index] ?? "")) continue
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + 1)
            const rect = range.getBoundingClientRect()
            if (rect.width === 0) continue
            const row = Math.round(rect.top * 2) / 2
            rows.set(row, Math.min(rows.get(row) ?? Infinity, rect.left))
          }
        }
        node = walker.nextNode()
      }
      return [...rows.values()]
    })
  )
}

function expectEqualListGeometry(
  rowStarts: number[][],
  depthCount = rowStarts.length
) {
  for (const starts of rowStarts) {
    expect(starts.length).toBeGreaterThan(1)
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(2)
  }
  const listTextStarts = rowStarts
    .slice(0, depthCount)
    .map((starts) => starts[0]!)
  const depthSteps = listTextStarts
    .slice(1)
    .map((start, index) => start - listTextStarts[index]!)
  expect(Math.max(...depthSteps) - Math.min(...depthSteps)).toBeLessThan(1)
}

async function scrollSourceIntoView(page: Page, source: string) {
  await page.locator(".cm-content").evaluate((content, target) => {
    const view = (
      content as HTMLElement & {
        cmTile?: {
          view?: {
            dispatch(spec: {
              scrollIntoView: boolean
              selection: { anchor: number }
            }): void
            state: {
              doc: {
                lineAt(position: number): { from: number }
                toString(): string
              }
            }
          }
        }
      }
    ).cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    const sourceFrom = view.state.doc.toString().indexOf(target)
    if (sourceFrom < 0) throw new Error(`Source is unavailable: ${target}`)
    const lineFrom = view.state.doc.lineAt(sourceFrom).from
    view.dispatch({
      scrollIntoView: true,
      selection: { anchor: Math.max(0, lineFrom - 1) },
    })
  }, source)
}

test("wrapped inline-code backgrounds keep adjacent rows separate @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-inline-code-e2e-")
  )
  const filePath = path.join(userData, "inline-code.md")
  await writeFile(
    filePath,
    "Inline-code wrap geometry: `alpha()` `beta()` `gamma()` `delta()` `epsilon()` `zeta()` `eta()` `theta()` `iota()` `kappa()` `lambda()` `mu()` `nu()` `xi()` `omicron()` `pi()` `rho()` `sigma()` `tau()` `upsilon()` `phi()` `chi()` `psi()` `omega()`."
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(async () => {
      const family = "JetBrains Mono Variable"
      document.documentElement.style.setProperty(
        "--font-mono",
        `"${family}", monospace`
      )
      document.documentElement.style.setProperty(
        "--editor-code-font-size",
        "72px"
      )
      await document.fonts.load(`72px "${family}"`)
    })
    const rows = await page
      .locator(".cm-md-inline-code")
      .evaluateAll((elements) => {
        const grouped: Array<{ bottom: number; top: number }> = []
        for (const element of elements) {
          const bounds = element.getBoundingClientRect()
          const row = grouped.find(
            (candidate) => Math.abs(candidate.top - bounds.top) < 1
          )
          if (row) {
            row.bottom = Math.max(row.bottom, bounds.bottom)
          } else {
            grouped.push({ bottom: bounds.bottom, top: bounds.top })
          }
        }
        return grouped.sort((left, right) => left.top - right.top)
      })

    expect(rows.length).toBeGreaterThan(1)
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]!.top).toBeGreaterThanOrEqual(
        rows[index - 1]!.bottom - 0.2
      )
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("indented code keeps editor hit-testing and card-local controls @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-indented-code-e2e-")
  )
  const filePath = path.join(userData, "indented-code.md")
  await writeFile(
    filePath,
    [
      `    indentedFirst("${"abcdefghij ".repeat(60)}");`,
      "      indentedSecond();",
    ].join("\n")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const block = page.locator('.cm-md-code-block[data-code-kind="indented"]')
    await expect(block).toHaveCount(1)
    await block.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)

    const geometry = await block.evaluate((element) => {
      const host = element.querySelector<HTMLElement>(
        ".cm-md-code-tools-host-indented"
      )
      const tools = element.querySelector<HTMLElement>(".cm-md-code-tools")
      const line = element.querySelector<HTMLElement>(".cm-md-code-line")
      if (!host || !tools || !line) {
        throw new Error("Indented code-card structure is unavailable")
      }
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode && !textNode.textContent?.includes("indentedFirst")) {
        textNode = walker.nextNode()
      }
      if (!textNode) throw new Error("Indented code text is unavailable")
      const textOffset = textNode.textContent!.indexOf("indentedFirst")
      const range = document.createRange()
      range.setStart(textNode, textOffset)
      range.setEnd(textNode, textOffset + 1)
      const lineBounds = line.getBoundingClientRect()
      const lineStyle = getComputedStyle(line)
      return {
        blockRight: element.getBoundingClientRect().right,
        blockTop: element.getBoundingClientRect().top,
        hostPointerEvents: getComputedStyle(host).pointerEvents,
        lineLeft: lineBounds.left,
        linePaddingLeft: Number.parseFloat(lineStyle.paddingLeft),
        textLeft: range.getBoundingClientRect().left,
        toolsBackdrop: getComputedStyle(tools, "::before").content,
        toolsPaddingLeft: Number.parseFloat(
          getComputedStyle(tools).paddingLeft
        ),
        toolsRight: tools.getBoundingClientRect().right,
        toolsTop: tools.getBoundingClientRect().top,
      }
    })
    expect(geometry.hostPointerEvents).toBe("none")
    expect(geometry.textLeft).toBeCloseTo(
      geometry.lineLeft + geometry.linePaddingLeft,
      1
    )
    expect(geometry.toolsBackdrop).toBe("none")
    expect(geometry.toolsPaddingLeft).toBe(0)
    expect(geometry.blockRight - geometry.toolsRight).toBeCloseTo(8, 1)
    expect(geometry.toolsTop - geometry.blockTop).toBeCloseTo(8, 1)

    const clickTarget = await block.evaluate((element) => {
      const line = element.querySelector<HTMLElement>(".cm-md-code-line")
      const content = element.closest<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                posAtCoords(coords: { x: number; y: number }): number | null
              }
            }
          })
        | null
      if (!line || !content?.cmTile?.view) {
        throw new Error("Indented code editor view is unavailable")
      }
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode && !textNode.textContent?.includes("indentedFirst")) {
        textNode = walker.nextNode()
      }
      if (!textNode) throw new Error("Indented code text is unavailable")
      const offset = textNode.textContent!.indexOf("indentedFirst") + 5
      const range = document.createRange()
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset + 1)
      const bounds = range.getBoundingClientRect()
      const x = bounds.left + bounds.width * 0.25
      const y = bounds.top + bounds.height / 2
      const expected = content.cmTile.view.posAtCoords({ x, y })
      if (expected == null)
        throw new Error("Indented code position is unavailable")
      return { expected, x, y }
    })
    await page.mouse.click(clickTarget.x, clickTarget.y)
    await expect
      .poll(() =>
        page.locator(".cm-content").evaluate(
          (content) =>
            (
              content as HTMLElement & {
                cmTile?: {
                  view?: { state: { selection: { main: { head: number } } } }
                }
              }
            ).cmTile?.view?.state.selection.main.head
        )
      )
      .toBe(clickTarget.expected)

    await block.hover()
    const wrap = block.getByRole("button", { name: "Enable word wrap" })
    const copy = block.getByRole("button", { name: "Copy code" })
    await expect(wrap).toBeVisible()
    await expect(copy).toBeVisible()
    await expect
      .poll(() =>
        wrap.evaluate((button) => getComputedStyle(button).backgroundColor)
      )
      .not.toBe("rgba(0, 0, 0, 0)")
    const buttonSurfaces = await block.evaluate((element) =>
      [".cm-md-code-wrap", ".cm-md-code-copy"].map((selector) => {
        const button = element.querySelector<HTMLElement>(selector)!
        const style = getComputedStyle(button)
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          pseudoContent: getComputedStyle(button, "::before").content,
        }
      })
    )
    for (const surface of buttonSurfaces) {
      expect(surface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
      expect(Number.parseFloat(surface.borderRadius)).toBeGreaterThan(0)
      expect(surface.pseudoContent).toBe("none")
    }

    const scrollingControls = await block.evaluate(async (element) => {
      const wrap = element.querySelector<HTMLElement>(".cm-md-code-wrap")!
      const copy = element.querySelector<HTMLElement>(".cm-md-code-copy")!
      const samples: Array<{ copy: number; wrap: number }> = []
      const capture = () => {
        samples.push({
          copy: copy.getBoundingClientRect().left,
          wrap: wrap.getBoundingClientRect().left,
        })
      }
      const maximum = element.scrollWidth - element.clientWidth
      for (const ratio of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
        element.scrollLeft = maximum * ratio
        capture()
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
        capture()
      }
      element.scrollLeft = 0
      return { maximum, samples }
    })
    expect(scrollingControls.maximum).toBeGreaterThan(160)
    for (const key of ["copy", "wrap"] as const) {
      const positions = scrollingControls.samples.map((sample) => sample[key])
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.5)
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("rendering chrome, lists, and fenced-code controls stay structural", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-rendering-e2e-")
  )
  const filePath = path.join(userData, "rendering.md")
  const longCode = `const longValue = "${"abcdefghij ".repeat(60)}";`
  const longIndentedCode = `indentedFirst(${JSON.stringify(
    "abcdefghij ".repeat(60)
  )});`
  const wrapSuffix =
    " A final phrase keeps this row wrapped at the default 100% zoom."
  await writeFile(
    filePath,
    [
      "Prose baseline.",
      "",
      `- This top-level item is deliberately long enough to wrap while its continuation remains aligned with the beginning of its text.${wrapSuffix}`,
      `  - This second-level item is deliberately long enough to wrap while retaining its nested hanging indentation and open marker.${wrapSuffix}`,
      `    - This third-level item is deliberately long enough to wrap while retaining its deeper indentation and square marker.${wrapSuffix}`,
      `      - This fourth-level item is deliberately long enough to wrap while advancing by the same amount and cycling to a solid marker.${wrapSuffix}`,
      `        - This fifth-level item is deliberately long enough to wrap while advancing equally and cycling to an open marker.${wrapSuffix}`,
      `          - This sixth-level item is deliberately long enough to wrap while advancing equally and cycling to a square marker.${wrapSuffix}`,
      `- [ ] This task item is deliberately long enough to wrap while its continuation remains aligned with the text after the checkbox.${wrapSuffix}`,
      "",
      `123456. Mixed depth 1 ordered parent is deliberately long enough to wrap while its large marker grows leftward without moving the fixed text column.${wrapSuffix}`,
      `        - [ ] Mixed depth 2 task child is deliberately long enough to wrap while advancing by exactly one semantic list step.${wrapSuffix}`,
      `          - Mixed depth 3 bullet child follows a task marker and must still advance by exactly one semantic list step.${wrapSuffix}`,
      `            123456. Mixed depth 4 ordered child uses another large marker without shifting its fixed text column.${wrapSuffix}`,
      `                    - Mixed depth 5 bullet child follows the large ordered marker and must never move backward.${wrapSuffix}`,
      "",
      "```custom renderer mode",
      longCode,
      "second();",
      "```",
      "",
      "```Empty",
      "```",
      "",
      `    ${longIndentedCode}`,
      "      indentedSecond();",
      "",
      "> [!note] Ordinary content card",
      "> Ordinary first content.",
      "",
      "> [!example]+ Fenced content card",
      "> ```Callout Custom",
      "> insideCallout();",
      "> ```",
      "",
      "> [!question]+ Nested callout spacing",
      "> > [!answer] Nested card",
      "> > Nested body.",
      "",
      `1. This ordered parent deliberately wraps before its nested callout so its list geometry remains part of the structural fixture.${wrapSuffix}`,
      "",
      "   > [!success]+ Combined feature card",
      "   > This callout is nested inside an ordered list.",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")

    const status = page.locator(".status-overlay")
    const editorMount = page.locator(".editor-mount")
    await expect
      .poll(() =>
        status.evaluate((element) => getComputedStyle(element).borderTopColor)
      )
      .toBe("rgba(0, 0, 0, 0)")
    await expect
      .poll(() =>
        status.evaluate(
          (element) => element.getBoundingClientRect().top - window.innerHeight
        )
      )
      .toBeGreaterThanOrEqual(-0.5)
    await expect
      .poll(() =>
        editorMount.evaluate(
          (element) => element.getBoundingClientRect().bottom - innerHeight
        )
      )
      .toBeCloseTo(0, 0)
    await expect(editorMount).toHaveCSS("clip-path", "inset(0px)")
    const statusRevealRegion = page.locator(".status-overlay-reveal-region")
    const statusRevealBox = await statusRevealRegion.boundingBox()
    expect(statusRevealBox).not.toBeNull()
    await page.mouse.move(
      statusRevealBox!.x + statusRevealBox!.width / 2,
      statusRevealBox!.y + 2
    )
    await expect
      .poll(() =>
        status.evaluate((element) => getComputedStyle(element).borderTopColor)
      )
      .not.toBe("rgba(0, 0, 0, 0)")
    await expect(editorMount).toHaveCSS("clip-path", "inset(0px 0px 28px)")

    await page.mouse.move(400, 1)
    const tab = page.locator(".document-tab").first()
    await expect(tab).toBeVisible()
    const tabRestingBackground = await tab.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    await expect(
      tab.evaluate((element) => getComputedStyle(element).borderTopWidth)
    ).resolves.toBe("0px")
    await tab.hover()
    await expect
      .poll(() =>
        tab.evaluate((element) => getComputedStyle(element).backgroundColor)
      )
      .not.toBe(tabRestingBackground)
    // Leave the transient top drawer and let its near-top compensation settle
    // before testing document clicks. Otherwise the synthetic pointer jump
    // can race the intentional content-padding transition.
    await page.mouse.move(400, 160)
    await expect(page.locator(".top-chrome-tab-drag-shelf")).toHaveCSS(
      "height",
      "0px"
    )
    await expect(page.locator(".cm-content")).toHaveCSS("padding-top", "46px")

    const markers = page.locator(".cm-md-list-marker-unordered")
    await expect(markers).toHaveCount(8)
    const listIndentGeometry = await page.evaluate(() => {
      const prose = document.querySelector<HTMLElement>(".cm-line")
      const markers = [
        ...document.querySelectorAll<HTMLElement>(
          ".cm-md-list-marker-unordered"
        ),
      ].slice(0, 3)
      const proseText = prose?.firstChild
      if (!proseText || markers.length !== 3) {
        throw new Error("List baseline is unavailable")
      }
      const range = document.createRange()
      range.setStart(proseText, 0)
      range.setEnd(proseText, 1)
      const proseStart = range.getBoundingClientRect().left
      const markerStarts = markers.map(
        (marker) => marker.getBoundingClientRect().left
      )
      return {
        depthStep: markerStarts[1]! - markerStarts[0]!,
        firstLevel: markerStarts[0]! - proseStart,
        secondDepthStep: markerStarts[2]! - markerStarts[1]!,
      }
    })
    expect(listIndentGeometry.depthStep).toBeGreaterThan(20)
    expect(
      Math.abs(
        listIndentGeometry.depthStep - listIndentGeometry.secondDepthStep
      )
    ).toBeLessThan(1)
    expect(listIndentGeometry.firstLevel).toBeGreaterThanOrEqual(
      listIndentGeometry.depthStep * 1.2
    )
    expect(
      await markers.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-list-marker"))
      )
    ).toEqual(["•", "◦", "▪", "•", "◦", "▪", "•", "•"])
    await expect(page.locator(".cm-md-list-marker-ordered")).toHaveText([
      "123456.",
      "123456.",
    ])
    const markerGeometry = await markers.evaluateAll((elements) =>
      elements.slice(0, 3).map((element) => {
        const marker = element.getBoundingClientRect()
        const line = element.closest(".cm-line")
        const walker = line
          ? document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
          : null
        let node = walker?.nextNode() ?? null
        let textCenter = Number.NaN
        let textLeft = Number.NaN
        while (node) {
          const text = node.textContent ?? ""
          const index = text.search(/\S/)
          if (
            index >= 0 &&
            !node.parentElement?.closest(
              ".cm-md-list-marker, .cm-md-list-marker-source"
            )
          ) {
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + 1)
            const textRect = range.getBoundingClientRect()
            textCenter = (textRect.top + textRect.bottom) / 2
            textLeft = textRect.left
            break
          }
          node = walker?.nextNode() ?? null
        }
        return {
          center: (marker.top + marker.bottom) / 2,
          height: marker.height,
          rightGap:
            textLeft -
            (marker.left +
              marker.width / 2 +
              Number.parseFloat(getComputedStyle(element, "::before").width) /
                2),
          textCenter,
        }
      })
    )
    for (const marker of markerGeometry) {
      expect(marker.height).toBeLessThanOrEqual(20)
      expect(Math.abs(marker.center - marker.textCenter)).toBeLessThanOrEqual(
        1.5
      )
      expect(marker.rightGap).toBeGreaterThan(3.5)
    }
    const markerGaps = markerGeometry.map((marker) => marker.rightGap)
    expect(Math.max(...markerGaps) - Math.min(...markerGaps)).toBeLessThan(1)

    await page.emulateMedia({ forcedColors: "active" })
    const forcedMarkerStyles = await markers.evaluateAll((elements) =>
      elements.slice(0, 3).map((element) => {
        const marker = getComputedStyle(element, "::before")
        return {
          backgroundColor: marker.backgroundColor,
          forcedColorAdjust: marker.forcedColorAdjust,
        }
      })
    )
    for (const marker of forcedMarkerStyles) {
      expect(marker.forcedColorAdjust).toBe("none")
    }
    expect(forcedMarkerStyles[0].backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
    expect(forcedMarkerStyles[2].backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
    await page.emulateMedia({ forcedColors: "none" })

    expectEqualListGeometry(await listRowStarts(page), 6)
    expectEqualListGeometry(await listRowStarts(page, "Mixed depth"))

    const sixthLevelLine = page.locator(".cm-md-list-marker-line").nth(5)
    await sixthLevelLine.click()
    await expect(
      sixthLevelLine.locator(".cm-md-list-marker-source")
    ).toHaveCount(1)
    await expect(
      sixthLevelLine.locator(".cm-md-list-indent-source")
    ).toHaveCount(1)
    expectEqualListGeometry(await listRowStarts(page), 6)

    const mixedFifthLevelLine = page
      .locator(".cm-md-list-marker-line")
      .filter({ hasText: "Mixed depth 5" })
    await mixedFifthLevelLine.click()
    await expect(
      mixedFifthLevelLine.locator(".cm-md-list-marker-source")
    ).toHaveCount(1)
    await expect(
      mixedFifthLevelLine.locator(".cm-md-list-indent-source")
    ).toHaveCount(1)
    expectEqualListGeometry(await listRowStarts(page, "Mixed depth"))

    const codeBlock = page.locator(".cm-md-code-block").first()
    await expect(codeBlock).toHaveAttribute("data-code-wrap", "false")
    const unwrapped = await codeBlock.evaluate((element) => ({
      clientWidth: element.clientWidth,
      height: element.clientHeight,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }))
    expect(unwrapped.overflowX).toBe("auto")
    expect(unwrapped.scrollWidth).toBeGreaterThan(unwrapped.clientWidth)

    await codeBlock.scrollIntoViewIfNeeded()
    const codeLines = codeBlock.locator(".cm-line")
    await expect(codeLines).toHaveCount(4)
    expect(
      await codeLines.evaluateAll((lines) =>
        lines.map((line) => line.getAttribute("data-code-line-number"))
      )
    ).toEqual([null, "1", "2", null])

    const openingCodeLine = codeLines.first()
    const openingCodeBox = await openingCodeLine.boundingBox()
    const languageLabel = codeBlock.locator(".cm-md-code-language")
    const languageBox = await languageLabel.boundingBox()
    expect(openingCodeBox).not.toBeNull()
    expect(languageBox).not.toBeNull()
    const editor = page.locator(".cm-editor")
    const openingClickPoints = [
      {
        x: openingCodeBox!.x + 20,
        y: openingCodeBox!.y + openingCodeBox!.height / 2,
      },
      {
        x: openingCodeBox!.x + openingCodeBox!.width / 2,
        y: openingCodeBox!.y + openingCodeBox!.height / 2,
      },
      {
        x: languageBox!.x + languageBox!.width / 2,
        y: languageBox!.y + languageBox!.height / 2,
      },
    ]
    for (const point of openingClickPoints) {
      await page.keyboard.press("Escape")
      await expect(editor).toHaveClass(/cm-md-caret-hidden/)
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await page.waitForTimeout(80)
      await expect(editor).toHaveClass(/cm-md-caret-hidden/)
      await page.mouse.up()
      await expect(editor).not.toHaveClass(/cm-md-caret-hidden/)
      await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)
      expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe(
        ""
      )
    }

    const rendererWord = await openingCodeLine.evaluate((line) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const text = node.textContent ?? ""
        const start = text.indexOf("renderer")
        if (start >= 0 && !node.parentElement?.closest(".cm-md-code-tools")) {
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + "renderer".length)
          const rect = range.getBoundingClientRect()
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          }
        }
        node = walker.nextNode()
      }
      throw new Error("Opening fence language source is unavailable")
    })
    await page.mouse.dblclick(rendererWord.x, rendererWord.y, { delay: 90 })
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString() ?? ""))
      .toBe("renderer")
    await openingCodeLine.click({ position: { x: 20, y: 8 } })
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(editor).toHaveClass(/cm-md-caret-hidden/)
    await page.bringToFront()
    if (process.platform === "darwin") {
      await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        electronApp.focus({ steal: true })
        BrowserWindow.getAllWindows()[0]?.focus()
      })
    }
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    await openingCodeLine.scrollIntoViewIfNeeded()
    const languageDrag = await languageLabel.evaluate((element) => {
      const text = element.firstChild
      if (!(text instanceof Text) || text.length < "custom".length) {
        throw new Error("Code language text is unavailable")
      }
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 1)
      const first = range.getBoundingClientRect()
      range.setStart(text, "custom".length - 1)
      range.setEnd(text, "custom".length)
      const last = range.getBoundingClientRect()
      const y = first.top + first.height / 2
      const startX = first.left + Math.min(1, first.width / 4)
      const endX = last.right - Math.min(1, last.width / 4)
      return {
        endX,
        startsOnLanguage:
          document
            .elementFromPoint(startX, y)
            ?.closest(".cm-md-code-language") === element,
        startX,
        y,
      }
    })
    expect(languageDrag.startsOnLanguage).toBe(true)
    await page.mouse.move(languageDrag.startX, languageDrag.y)
    await page.mouse.down()
    await page.mouse.move(languageDrag.endX, languageDrag.y, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.locator(".cm-content").evaluate((content) => {
          const view = (
            content as HTMLElement & {
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
      )
      .toBe("custom")
    await openingCodeLine.click({ position: { x: 20, y: 8 } })
    await page.keyboard.press("Escape")

    const dragOpeningCodeBox = await openingCodeLine.boundingBox()
    expect(dragOpeningCodeBox).not.toBeNull()
    await page.mouse.move(
      dragOpeningCodeBox!.x + 20,
      dragOpeningCodeBox!.y + dragOpeningCodeBox!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      dragOpeningCodeBox!.x + 150,
      dragOpeningCodeBox!.y + dragOpeningCodeBox!.height / 2,
      { steps: 5 }
    )
    await page.mouse.up()
    await expect
      .poll(() =>
        page.locator(".cm-content").evaluate((content) => {
          const view = (
            content as HTMLElement & {
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
      )
      .toBe("```custom")
    await openingCodeLine.click({ position: { x: 20, y: 8 } })
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(0)

    const codeAlignment = await codeBlock.evaluate((block) => {
      const lines = [...block.querySelectorAll<HTMLElement>(".cm-line")]
      const opening = lines[0]
      const closing = lines.at(-1)
      const content = block.querySelector<HTMLElement>(
        ".cm-md-code-content-line"
      )
      const toolsHost = block.querySelector<HTMLElement>(
        ".cm-md-code-tools-host"
      )
      const tools = block.querySelector<HTMLElement>(".cm-md-code-tools")
      const actions = block.querySelector<HTMLElement>(".cm-md-code-actions")
      const language = block.querySelector<HTMLElement>(".cm-md-code-language")
      const wrap = block.querySelector<HTMLElement>(".cm-md-code-wrap")
      const copy = block.querySelector<HTMLElement>(".cm-md-code-copy")
      const wrapIcon = wrap?.querySelector<SVGElement>("svg")
      const copyIcon = copy?.querySelector<SVGElement>("svg")
      if (
        !opening ||
        !closing ||
        !content ||
        !toolsHost ||
        !tools ||
        !actions ||
        !language ||
        !wrap ||
        !copy ||
        !wrapIcon ||
        !copyIcon
      ) {
        throw new Error("Code block structure is unavailable")
      }
      const openingRect = opening.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const toolsHostRect = toolsHost.getBoundingClientRect()
      const toolsRect = tools.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      const languageRect = language.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      const copyRect = copy.getBoundingClientRect()
      const wrapIconRect = wrapIcon.getBoundingClientRect()
      const copyIconRect = copyIcon.getBoundingClientRect()
      const languageTextRange = document.createRange()
      languageTextRange.selectNodeContents(language)
      const languageTextRect = languageTextRange.getBoundingClientRect()
      const gutterStyle = getComputedStyle(content, "::before")
      return {
        actionsBottom: actionsRect.bottom,
        copyBottom: copyRect.bottom,
        copyCenter: (copyRect.top + copyRect.bottom) / 2,
        copyIconCenter: (copyIconRect.top + copyIconRect.bottom) / 2,
        contentTop: contentRect.top,
        contentInset: Number.parseFloat(
          getComputedStyle(content).paddingInlineStart
        ),
        closingInset: Number.parseFloat(
          getComputedStyle(closing).paddingInlineStart
        ),
        gutterInset: Number.parseFloat(gutterStyle.insetInlineStart),
        gutterTextAlign: gutterStyle.textAlign,
        languageBottom: languageRect.bottom,
        languageCenter: (languageRect.top + languageRect.bottom) / 2,
        languageTextBottom: languageTextRect.bottom,
        languageTextTop: languageTextRect.top,
        languageTop: languageRect.top,
        openingBottom: openingRect.bottom,
        openingHeight: openingRect.height,
        openingTop: openingRect.top,
        openingInset: Number.parseFloat(
          getComputedStyle(opening).paddingInlineStart
        ),
        toolHostHeight: toolsHostRect.height,
        toolHostTop: toolsHostRect.top,
        toolsInsideLine: tools.closest(".cm-line") != null,
        toolsCenter: (toolsRect.top + toolsRect.bottom) / 2,
        toolsBottom: toolsRect.bottom,
        toolsTop: toolsRect.top,
        wrapBottom: wrapRect.bottom,
        wrapCenter: (wrapRect.top + wrapRect.bottom) / 2,
        wrapIconCenter: (wrapIconRect.top + wrapIconRect.bottom) / 2,
      }
    })
    expect(codeAlignment.openingInset).toBeCloseTo(
      codeAlignment.contentInset,
      1
    )
    expect(codeAlignment.closingInset).toBeCloseTo(
      codeAlignment.contentInset,
      1
    )
    expect(codeAlignment.gutterInset).toBeLessThan(codeAlignment.contentInset)
    expect(codeAlignment.toolsInsideLine).toBe(false)
    expect(codeAlignment.toolHostHeight).toBeCloseTo(0, 1)
    expect(codeAlignment.toolHostTop).toBeCloseTo(
      codeAlignment.openingBottom,
      1
    )
    expect(codeAlignment.toolsTop).toBeCloseTo(codeAlignment.openingTop + 8, 1)
    expect(codeAlignment.languageCenter).toBeCloseTo(
      codeAlignment.toolsCenter,
      1
    )
    expect(codeAlignment.wrapCenter).toBeCloseTo(codeAlignment.toolsCenter, 1)
    expect(codeAlignment.copyCenter).toBeCloseTo(codeAlignment.toolsCenter, 1)
    expect(codeAlignment.wrapIconCenter).toBeCloseTo(
      codeAlignment.toolsCenter,
      1
    )
    expect(codeAlignment.copyIconCenter).toBeCloseTo(
      codeAlignment.toolsCenter,
      1
    )
    expect(codeAlignment.gutterTextAlign).toBe("start")
    expect(codeAlignment.contentTop).toBeCloseTo(codeAlignment.openingBottom, 1)
    expect(codeAlignment.openingHeight).toBeCloseTo(36, 0)
    expect(codeAlignment.toolsBottom).toBeCloseTo(codeAlignment.contentTop, 1)
    expect(codeAlignment.languageTextTop).toBeGreaterThanOrEqual(
      codeAlignment.languageTop - 0.5
    )
    expect(codeAlignment.languageTextBottom).toBeLessThanOrEqual(
      codeAlignment.languageBottom + 0.5
    )
    expect(codeAlignment.actionsBottom).toBeLessThanOrEqual(
      codeAlignment.contentTop + 0.5
    )
    expect(codeAlignment.wrapBottom).toBeLessThanOrEqual(
      codeAlignment.contentTop + 0.5
    )
    expect(codeAlignment.copyBottom).toBeLessThanOrEqual(
      codeAlignment.contentTop + 0.5
    )

    const firstCodeLine = codeBlock.locator(
      '.cm-line[data-code-line-number="1"]'
    )
    await firstCodeLine.click({ position: { x: 70, y: 8 } })
    await page.keyboard.press("Home")
    if (process.platform === "darwin") {
      const scrollPosition = () =>
        codeBlock.evaluate((element) => ({
          left: element.scrollLeft,
          maximum: element.scrollWidth - element.clientWidth,
        }))

      await page.keyboard.press("Meta+ArrowRight")
      await expect
        .poll(async () => {
          const { left, maximum } = await scrollPosition()
          return Math.abs(left - maximum)
        })
        .toBeLessThan(0.5)
      await page.keyboard.press("Meta+ArrowLeft")
      await expect.poll(async () => (await scrollPosition()).left).toBe(0)

      await page.keyboard.press("Meta+Shift+ArrowRight")
      await expect
        .poll(async () => {
          const { left, maximum } = await scrollPosition()
          return Math.abs(left - maximum)
        })
        .toBeLessThan(0.5)
      await page.keyboard.press("Meta+Shift+ArrowLeft")
      await expect.poll(async () => (await scrollPosition()).left).toBe(0)

      const restoredGutter = await codeBlock.evaluate((block) => {
        const line = block.querySelector<HTMLElement>(
          '.cm-line[data-code-line-number="1"]'
        )
        if (!line) throw new Error("First numbered code line is unavailable")
        const blockRect = block.getBoundingClientRect()
        const lineRect = line.getBoundingClientRect()
        const gutter = getComputedStyle(line, "::before")
        return {
          blockLeft: blockRect.left,
          gutterLeft:
            lineRect.left + Number.parseFloat(gutter.insetInlineStart),
          number: line.getAttribute("data-code-line-number"),
        }
      })
      expect(restoredGutter.number).toBe("1")
      expect(restoredGutter.gutterLeft).toBeGreaterThanOrEqual(
        restoredGutter.blockLeft - 0.5
      )
      expect(
        await page
          .locator(".cm-scroller")
          .evaluate((element) => element.scrollLeft)
      ).toBe(0)
    }

    for (let index = 0; index < 240; index += 1) {
      await page.keyboard.press("ArrowRight")
    }
    await expect
      .poll(() => codeBlock.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    expect(
      await page
        .locator(".cm-scroller")
        .evaluate((element) => element.scrollLeft)
    ).toBe(0)
    await expect(page.locator(".cm-editor")).not.toHaveAttribute(
      "data-code-native-selection",
      ""
    )
    await expect(page.locator(".cm-cursorLayer")).toHaveCSS(
      "visibility",
      "visible"
    )
    await expect
      .poll(async () => {
        const drawnCaret = await page
          .locator(".cm-cursor")
          .first()
          .boundingBox()
        const codeBounds = await codeBlock.boundingBox()
        if (!drawnCaret || !codeBounds) return Number.POSITIVE_INFINITY
        return Math.max(
          codeBounds.x - drawnCaret.x,
          drawnCaret.x - (codeBounds.x + codeBounds.width),
          0
        )
      })
      .toBeLessThanOrEqual(0.5)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+End" : "Control+Shift+End"
    )
    await expect(page.locator(".cm-editor")).toHaveAttribute(
      "data-code-native-selection",
      ""
    )
    await expect(page.locator(".cm-selectionLayer")).toHaveCSS(
      "visibility",
      "hidden"
    )

    await firstCodeLine.click({ position: { x: 70, y: 8 } })
    await codeBlock.evaluate((element) => {
      element.scrollLeft = 0
    })
    const dragBlockBox = await codeBlock.boundingBox()
    const dragLineBox = await firstCodeLine.boundingBox()
    expect(dragBlockBox).not.toBeNull()
    expect(dragLineBox).not.toBeNull()
    const dragY = dragLineBox!.y + dragLineBox!.height / 2
    await page.mouse.move(dragBlockBox!.x + 70, dragY)
    await page.mouse.down()
    await page.mouse.move(
      Math.min(
        (await page.evaluate(() => innerWidth)) - 4,
        dragBlockBox!.x + dragBlockBox!.width + 80
      ),
      dragY,
      { steps: 5 }
    )
    await page.waitForTimeout(300)
    const edgeDrag = await codeBlock.evaluate((element) => ({
      actionsOpacity: getComputedStyle(
        element.querySelector(".cm-md-code-actions")!
      ).opacity,
      pointerSelecting: element.hasAttribute("data-code-pointer-selecting"),
      scrollLeft: element.scrollLeft,
      selectedText: getSelection()?.toString() ?? "",
    }))
    await page.mouse.up()
    expect(edgeDrag.actionsOpacity).toBe("1")
    expect(edgeDrag.pointerSelecting).toBe(true)
    expect(edgeDrag.scrollLeft).toBeGreaterThan(0)
    expect(edgeDrag.selectedText.length).toBeGreaterThan(0)
    await expect(codeBlock).not.toHaveAttribute(
      "data-code-pointer-selecting",
      "true"
    )
    await codeBlock.evaluate((element) => {
      element.scrollLeft = 0
    })
    await firstCodeLine.click({ position: { x: 70, y: 8 } })

    await page.mouse.move(dragBlockBox!.x + 70, dragY)
    await page.mouse.down()
    await page.mouse.move(
      Math.min(
        (await page.evaluate(() => innerWidth)) - 4,
        dragBlockBox!.x + dragBlockBox!.width + 80
      ),
      Math.min(
        (await page.evaluate(() => innerHeight)) - 4,
        dragBlockBox!.y + dragBlockBox!.height + 30
      ),
      { steps: 5 }
    )
    await page.waitForTimeout(300)
    const diagonalDrag = await codeBlock.evaluate((element) => {
      const focusNode = getSelection()?.focusNode
      return {
        focusInsideBlock: focusNode ? element.contains(focusNode) : null,
        nativeSelection: document
          .querySelector(".cm-editor")
          ?.hasAttribute("data-code-native-selection"),
      }
    })
    await page.mouse.up()
    expect(diagonalDrag.focusInsideBlock).toBe(false)
    expect(diagonalDrag.nativeSelection).toBe(true)
    await codeBlock.evaluate((element) => {
      element.scrollLeft = 0
    })

    const tools = codeBlock.locator(".cm-md-code-tools")
    const actions = codeBlock.locator(".cm-md-code-actions")
    const language = codeBlock.locator(".cm-md-code-language")
    await expect(language).toBeVisible()
    await expect
      .poll(() =>
        actions.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")
    const restingLanguage = await codeBlock.evaluate((block) => {
      const actions = block.querySelector<HTMLElement>(".cm-md-code-actions")
      const language = block.querySelector<HTMLElement>(".cm-md-code-language")
      if (!actions || !language) {
        throw new Error("Code controls are unavailable")
      }
      const blockRect = block.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      const languageRect = language.getBoundingClientRect()
      return {
        actionsWidth: actionsRect.width,
        insetInlineEnd: blockRect.right - languageRect.right,
        right: languageRect.right,
      }
    })
    expect(restingLanguage.actionsWidth).toBeCloseTo(0, 1)
    expect(restingLanguage.insetInlineEnd).toBeCloseTo(15, 0)

    await codeBlock.hover()
    await expect
      .poll(() =>
        actions.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("1")
    await expect(tools).toHaveCSS("background-image", "none")
    await expect(tools).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(language).toHaveText("custom renderer mode")
    await expect(language).toHaveCSS("user-select", "none")
    await expect(language).not.toHaveAttribute("title")
    await expect(language).not.toHaveAttribute("aria-describedby")
    await language.hover()
    await expect(
      page.locator('[data-slot="tooltip-content"][data-open]')
    ).toHaveCount(0)
    const enableWrap = codeBlock.getByRole("button", {
      name: "Enable word wrap",
    })
    const copyCode = codeBlock.getByRole("button", { name: "Copy code" })
    const revealedControls = await codeBlock.evaluate((block) => {
      const actions = block.querySelector<HTMLElement>(".cm-md-code-actions")
      const language = block.querySelector<HTMLElement>(".cm-md-code-language")
      const copy = block.querySelector<HTMLElement>(".cm-md-code-copy")
      const copyIcon = copy?.querySelector<SVGElement>("svg")
      if (!actions || !language || !copy || !copyIcon) {
        throw new Error("Code controls are unavailable")
      }
      const blockRect = block.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      const languageRect = language.getBoundingClientRect()
      const copyRect = copy.getBoundingClientRect()
      const copyIconRect = copyIcon.getBoundingClientRect()
      return {
        actionsWidth: actionsRect.width,
        copyButtonInset: blockRect.right - copyRect.right,
        copyIconRight: copyIconRect.right,
        languageRight: languageRect.right,
      }
    })
    expect(revealedControls.actionsWidth).toBeCloseTo(84, 0)
    expect(restingLanguage.right - revealedControls.languageRight).toBeCloseTo(
      81,
      0
    )
    expect(revealedControls.copyButtonInset).toBeCloseTo(8, 0)
    expect(revealedControls.copyIconRight).toBeCloseTo(restingLanguage.right, 0)

    const controlSizes = await codeBlock.evaluate((block) => {
      const language = block.querySelector<HTMLElement>(".cm-md-code-language")
      const button = block.querySelector<HTMLElement>(".cm-md-code-wrap")
      const icon = button?.querySelector<SVGElement>("svg")
      if (!language || !button || !icon) {
        throw new Error("Code controls are unavailable")
      }
      return {
        button: button.getBoundingClientRect().width,
        icon: icon.getBoundingClientRect().width,
        language: Number.parseFloat(getComputedStyle(language).fontSize),
        languageLineHeight: Number.parseFloat(
          getComputedStyle(language).lineHeight
        ),
      }
    })
    expect(controlSizes.button).toBeCloseTo(40, 0)
    expect(controlSizes.icon).toBeCloseTo(26, 0)
    expect(controlSizes.language).toBeCloseTo(20, 0)
    expect(controlSizes.languageLineHeight).toBeCloseTo(24, 0)

    const enableWrapPath = await enableWrap.locator("path").getAttribute("d")
    await codeBlock.evaluate((block) => {
      const host = block.querySelector(".cm-md-code-tools-host")
      const wrap = block.querySelector(".cm-md-code-wrap")
      const copy = block.querySelector(".cm-md-code-copy")
      const wrapIcon = wrap?.querySelector("svg")
      const copyIcon = copy?.querySelector("svg")
      ;(
        window as unknown as {
          codeToolNodesBefore?: Array<Element | null>
        }
      ).codeToolNodesBefore = [
        host,
        wrap,
        copy,
        wrapIcon ?? null,
        copyIcon ?? null,
      ]
    })
    await enableWrap.hover()
    const wrapTooltipId = await enableWrap.getAttribute("aria-describedby")
    expect(wrapTooltipId).not.toBeNull()
    const wrapTooltip = page.locator(`#${wrapTooltipId}`)
    await expect(wrapTooltip).toHaveText("Enable word wrap")
    await expect(wrapTooltip).toHaveCSS("visibility", "visible")
    const blockBox = await codeBlock.boundingBox()
    const wrapButtonBox = await enableWrap.boundingBox()
    const wrapTooltipBox = await wrapTooltip.boundingBox()
    expect(blockBox).not.toBeNull()
    expect(wrapButtonBox).not.toBeNull()
    expect(wrapTooltipBox).not.toBeNull()
    expect(wrapTooltipBox!.y).toBeGreaterThanOrEqual(
      wrapButtonBox!.y + wrapButtonBox!.height
    )
    expect(wrapTooltipBox!.x + wrapTooltipBox!.width).toBeLessThanOrEqual(
      blockBox!.x + blockBox!.width
    )

    await copyCode.hover()
    const copyTooltipId = await copyCode.getAttribute("aria-describedby")
    expect(copyTooltipId).not.toBeNull()
    const copyTooltip = page.locator(`#${copyTooltipId}`)
    await expect(copyTooltip).toHaveText("Copy code")
    await expect(copyTooltip).toHaveCSS("visibility", "visible")
    const toolPlacement = async () =>
      codeBlock.evaluate((block) => {
        const tools = block.querySelector(".cm-md-code-tools")
        if (!tools) throw new Error("Code tools are unavailable")
        const blockRect = block.getBoundingClientRect()
        const toolsRect = tools.getBoundingClientRect()
        return {
          blockLeft: blockRect.left,
          blockRight: blockRect.right,
          toolsLeft: toolsRect.left,
          toolsRight: toolsRect.right,
        }
      })
    const placement = await toolPlacement()
    expect(placement.toolsLeft).toBeGreaterThanOrEqual(placement.blockLeft)
    expect(placement.toolsRight).toBeLessThanOrEqual(placement.blockRight)

    const controlPositions = await codeBlock.evaluate(async (block) => {
      const language = block.querySelector<HTMLElement>(".cm-md-code-language")
      const wrap = block.querySelector<HTMLElement>(".cm-md-code-wrap")
      const copy = block.querySelector<HTMLElement>(".cm-md-code-copy")
      if (!language || !wrap || !copy) {
        throw new Error("Code controls are unavailable")
      }

      const samples: Array<{
        copyLeft: number
        copyRight: number
        languageRight: number
        wrapLeft: number
      }> = []
      const capture = () => {
        const languageRect = language.getBoundingClientRect()
        const wrapRect = wrap.getBoundingClientRect()
        const copyRect = copy.getBoundingClientRect()
        samples.push({
          copyLeft: copyRect.left,
          copyRight: copyRect.right,
          languageRight: languageRect.right,
          wrapLeft: wrapRect.left,
        })
      }
      const maximum = block.scrollWidth - block.clientWidth
      for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
        block.scrollLeft = maximum * ratio
        capture()
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
        capture()
      }
      block.scrollLeft = 0
      return samples
    })
    for (const key of [
      "copyLeft",
      "copyRight",
      "languageRight",
      "wrapLeft",
    ] as const) {
      const positions = controlPositions.map((sample) => sample[key])
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.5)
    }

    await copyCode.click()
    await expect
      .poll(async () =>
        (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(
          /\r\n/g,
          "\n"
        )
      )
      .toBe(`${longCode}\nsecond();`)
    await expect(copyTooltip).toHaveText("Copied code")
    const copiedTooltipBox = await copyTooltip.boundingBox()
    const copiedBlockBox = await codeBlock.boundingBox()
    expect(copiedTooltipBox).not.toBeNull()
    expect(copiedBlockBox).not.toBeNull()
    expect(copiedTooltipBox!.x + copiedTooltipBox!.width).toBeLessThanOrEqual(
      copiedBlockBox!.x + copiedBlockBox!.width
    )

    await codeBlock.hover()
    await enableWrap.click()
    await expect(codeBlock).toHaveAttribute("data-code-wrap", "true")
    const disableWrap = codeBlock.getByRole("button", {
      name: "Disable word wrap",
    })
    const stableCodeTools = await codeBlock.evaluate((block) => {
      const current = [
        block.querySelector(".cm-md-code-tools-host"),
        block.querySelector(".cm-md-code-wrap"),
        block.querySelector(".cm-md-code-copy"),
        block.querySelector(".cm-md-code-wrap svg"),
        block.querySelector(".cm-md-code-copy svg"),
      ]
      const ownerWindow = window as unknown as {
        codeToolNodesBefore?: Array<Element | null>
      }
      const before = ownerWindow.codeToolNodesBefore ?? []
      delete ownerWindow.codeToolNodesBefore
      return {
        actionsOpacity: getComputedStyle(
          block.querySelector(".cm-md-code-actions")!
        ).opacity,
        identities: current.map((node, index) => node === before[index]),
      }
    })
    expect(stableCodeTools.identities).toEqual([true, true, true, true, true])
    expect(stableCodeTools.actionsOpacity).toBe("1")
    await expect(wrapTooltip).toHaveCount(1)
    await expect(wrapTooltip).toHaveText("Disable word wrap")
    expect(await disableWrap.locator("path").getAttribute("d")).not.toBe(
      enableWrapPath
    )
    const wrapped = await codeBlock.evaluate((element) => ({
      clientWidth: element.clientWidth,
      height: element.clientHeight,
      scrollWidth: element.scrollWidth,
    }))
    expect(wrapped.scrollWidth).toBeLessThanOrEqual(wrapped.clientWidth + 1)
    expect(wrapped.height).toBeGreaterThan(unwrapped.height)

    const secondCodeLine = codeBlock.locator(
      '.cm-line[data-code-line-number="2"]'
    )
    await secondCodeLine.click({ position: { x: 100, y: 8 } })
    const numberColors = await codeBlock
      .locator(".cm-md-code-content-line")
      .evaluateAll((lines) =>
        lines.map((line) => getComputedStyle(line, "::before").color)
      )
    expect(numberColors[1]).not.toBe(numberColors[0])

    const indentedCode = page
      .locator('.cm-md-code-block[data-code-kind="indented"]')
      .filter({ hasText: "indentedFirst(" })
    await expect(indentedCode).toHaveCount(1)
    await indentedCode.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await expect(indentedCode.locator(".cm-md-code-language")).toHaveCount(0)
    expect(
      await indentedCode
        .locator(".cm-line")
        .evaluateAll((lines) =>
          lines.map((line) => line.getAttribute("data-code-line-number"))
        )
    ).toEqual(["1", "2"])
    const indentedGeometry = await indentedCode.evaluate((block) => {
      const host = block.querySelector<HTMLElement>(
        ".cm-md-code-tools-host-indented"
      )
      const tools = block.querySelector<HTMLElement>(".cm-md-code-tools")
      const firstLine = block.querySelector<HTMLElement>(".cm-md-code-line")
      const prose = document.querySelector<HTMLElement>(".cm-content")
      if (!host || !tools || !firstLine || !prose) {
        throw new Error("Indented code-card structure is unavailable")
      }
      const blockRect = block.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      const toolsRect = tools.getBoundingClientRect()
      const firstLineRect = firstLine.getBoundingClientRect()
      const firstLineStyle = getComputedStyle(firstLine)
      const walker = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode && !textNode.textContent?.includes("indentedFirst")) {
        textNode = walker.nextNode()
      }
      if (!textNode) throw new Error("Indented code text is unavailable")
      const textStart = textNode.textContent!.indexOf("indentedFirst")
      const textRange = document.createRange()
      textRange.setStart(textNode, textStart)
      textRange.setEnd(textNode, textStart + 1)
      return {
        blockRight: blockRect.right,
        blockTop: blockRect.top,
        codeFont: getComputedStyle(firstLine).fontFamily,
        firstLinePaddingTop: Number.parseFloat(firstLineStyle.paddingTop),
        firstLineTop: firstLineRect.top,
        firstTextLeft: textRange.getBoundingClientRect().left,
        hostHeight: hostRect.height,
        hostPointerEvents: getComputedStyle(host).pointerEvents,
        lineLeft: firstLineRect.left,
        linePaddingLeft: Number.parseFloat(firstLineStyle.paddingLeft),
        proseFont: getComputedStyle(prose).fontFamily,
        toolsBackdropContent: getComputedStyle(tools, "::before").content,
        toolsPaddingLeft: Number.parseFloat(
          getComputedStyle(tools).paddingLeft
        ),
        toolsRight: toolsRect.right,
        toolsTop: toolsRect.top,
      }
    })
    expect(indentedGeometry.codeFont).not.toBe(indentedGeometry.proseFont)
    expect(indentedGeometry.hostHeight).toBeCloseTo(0, 0)
    expect(indentedGeometry.hostPointerEvents).toBe("none")
    expect(indentedGeometry.toolsTop).toBeCloseTo(
      indentedGeometry.blockTop + 8,
      1
    )
    expect(indentedGeometry.toolsRight).toBeCloseTo(
      indentedGeometry.blockRight - 8,
      1
    )
    expect(indentedGeometry.firstLineTop).toBeCloseTo(
      indentedGeometry.blockTop,
      1
    )
    expect(indentedGeometry.firstLinePaddingTop).toBeCloseTo(2, 0)
    expect(indentedGeometry.firstTextLeft).toBeCloseTo(
      indentedGeometry.lineLeft + indentedGeometry.linePaddingLeft,
      1
    )
    expect(indentedGeometry.toolsBackdropContent).toBe("none")
    expect(indentedGeometry.toolsPaddingLeft).toBe(0)

    const clickTarget = await indentedCode.evaluate((block) => {
      const line = block.querySelector<HTMLElement>(".cm-md-code-line")
      const content = block.closest<HTMLElement>(".cm-content") as
        | (HTMLElement & {
            cmTile?: {
              view?: {
                posAtCoords(coords: { x: number; y: number }): number | null
              }
            }
          })
        | null
      if (!line || !content?.cmTile?.view) {
        throw new Error("Indented code editor view is unavailable")
      }
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode && !textNode.textContent?.includes("indentedFirst")) {
        textNode = walker.nextNode()
      }
      if (!textNode) throw new Error("Indented code text is unavailable")
      const offset = textNode.textContent!.indexOf("indentedFirst") + 5
      const range = document.createRange()
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset + 1)
      const bounds = range.getBoundingClientRect()
      const x = bounds.left + bounds.width * 0.25
      const y = bounds.top + bounds.height / 2
      const expected = content.cmTile.view.posAtCoords({ x, y })
      if (expected == null)
        throw new Error("Indented code position is unavailable")
      return { expected, x, y }
    })
    await page.mouse.click(clickTarget.x, clickTarget.y)
    await expect
      .poll(() =>
        page.locator(".cm-content").evaluate(
          (content) =>
            (
              content as HTMLElement & {
                cmTile?: {
                  view?: { state: { selection: { main: { head: number } } } }
                }
              }
            ).cmTile?.view?.state.selection.main.head
        )
      )
      .toBe(clickTarget.expected)

    await indentedCode.hover()
    const indentedWrap = indentedCode.getByRole("button", {
      name: "Enable word wrap",
    })
    const indentedCopy = indentedCode.getByRole("button", {
      name: "Copy code",
    })
    await expect(indentedWrap).toBeVisible()
    await expect(indentedCopy).toBeVisible()
    await expect
      .poll(() =>
        indentedWrap.evaluate(
          (button) => getComputedStyle(button).backgroundColor
        )
      )
      .not.toBe("rgba(0, 0, 0, 0)")
    const indentedSurfaces = await indentedCode.evaluate((block) => {
      const wrap = block.querySelector<HTMLElement>(".cm-md-code-wrap")!
      const copy = block.querySelector<HTMLElement>(".cm-md-code-copy")!
      const style = (button: HTMLElement) => {
        const computed = getComputedStyle(button)
        return {
          backgroundColor: computed.backgroundColor,
          borderRadius: computed.borderRadius,
          pseudoContent: getComputedStyle(button, "::before").content,
        }
      }
      return { copy: style(copy), wrap: style(wrap) }
    })
    for (const surface of [indentedSurfaces.wrap, indentedSurfaces.copy]) {
      expect(surface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
      expect(Number.parseFloat(surface.borderRadius)).toBeGreaterThan(0)
      expect(surface.pseudoContent).toBe("none")
    }

    const buttonPositions = await indentedCode.evaluate((block) => {
      const rect = (selector: string) =>
        block.querySelector<HTMLElement>(selector)!.getBoundingClientRect().left
      return {
        copy: rect(".cm-md-code-copy"),
        wrap: rect(".cm-md-code-wrap"),
      }
    })
    await indentedCode.evaluate((block) => {
      block.scrollLeft = 160
    })
    await expect
      .poll(async () => {
        const current = await indentedCode.evaluate((block) => ({
          copy: block
            .querySelector<HTMLElement>(".cm-md-code-copy")!
            .getBoundingClientRect().left,
          scrollLeft: block.scrollLeft,
          wrap: block
            .querySelector<HTMLElement>(".cm-md-code-wrap")!
            .getBoundingClientRect().left,
        }))
        return {
          copyDelta: Math.abs(current.copy - buttonPositions.copy),
          scrollLeft: current.scrollLeft,
          wrapDelta: Math.abs(current.wrap - buttonPositions.wrap),
        }
      })
      .toEqual({ copyDelta: 0, scrollLeft: 160, wrapDelta: 0 })

    await indentedCopy.click()
    await expect
      .poll(async () =>
        (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(
          /\r\n/g,
          "\n"
        )
      )
      .toBe(`${longIndentedCode}\n  indentedSecond();`)
    await indentedCode.hover()
    await indentedWrap.click()
    await expect(indentedCode).toHaveAttribute("data-code-wrap", "true")

    await scrollSourceIntoView(page, "> [!example]+ Fenced content card")
    const calloutCode = page.locator(".cm-md-code-block").filter({
      has: page.locator(".cm-md-code-language", {
        hasText: "Callout Custom",
      }),
    })
    await expect(calloutCode).toHaveCount(1)
    await calloutCode.scrollIntoViewIfNeeded()
    const ordinaryCallout = page.locator(
      '.cm-md-callout[data-callout-type="note"]'
    )
    const fencedCallout = page.locator(
      '.cm-md-callout[data-callout-type="example"]'
    )
    const nestedCallout = page.locator(
      '.cm-md-callout[data-callout-type="answer"]'
    )
    const combinedCallout = page.locator(
      '.cm-md-callout[data-callout-type="success"]'
    )
    await scrollSourceIntoView(page, "> [!success]+ Combined feature card")
    await expect(combinedCallout).toHaveCount(1)
    await combinedCallout.scrollIntoViewIfNeeded()
    await expect(ordinaryCallout).toHaveCount(1)
    await expect(fencedCallout).toHaveCount(1)
    await expect(nestedCallout).toHaveCount(1)
    await expect(
      combinedCallout.locator(":scope > .cm-md-callout-body > .cm-line")
    ).toHaveCount(1)

    const calloutGeometry = await page.evaluate(() => {
      const callout = (type: string) => {
        const element = document.querySelector<HTMLElement>(
          `.cm-md-callout[data-callout-type="${type}"]`
        )
        if (!element) throw new Error(`${type} callout is unavailable`)
        return element
      }
      const headerLine = (element: HTMLElement) => {
        const header = element.querySelector<HTMLElement>(
          ":scope > .cm-md-callout-header-line"
        )
        if (!header) throw new Error("Callout header is unavailable")
        return header
      }
      const headerContent = (element: HTMLElement) => {
        const header = element.querySelector<HTMLElement>(
          ":scope > .cm-md-callout-header-line .cm-md-callout-header"
        )
        if (!header) throw new Error("Callout header content is unavailable")
        return header
      }
      const firstBodyChild = (element: HTMLElement) => {
        const child = element.querySelector<HTMLElement>(
          ":scope > .cm-md-callout-body > :first-child"
        )
        if (!child) throw new Error("Callout body is unavailable")
        return child
      }
      const firstTextLeft = (element: HTMLElement) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const text = node.textContent ?? ""
          const index = text.search(/\S/)
          if (index >= 0) {
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + 1)
            const rect = range.getBoundingClientRect()
            if (rect.width > 0) return rect.left
          }
          node = walker.nextNode()
        }
        throw new Error("Visible callout body text is unavailable")
      }
      const offsets = (element: HTMLElement) => {
        const left = element.getBoundingClientRect().left
        const title = element.querySelector<HTMLElement>(
          ":scope > .cm-md-callout-header-line .cm-md-callout-title"
        )
        const bodyLine = element.querySelector<HTMLElement>(
          ":scope > .cm-md-callout-body > .cm-line"
        )
        if (!title || !bodyLine) {
          throw new Error("Callout alignment geometry is unavailable")
        }
        return {
          body: firstTextLeft(bodyLine) - left,
          headerHeight: headerLine(element).getBoundingClientRect().height,
          title: title.getBoundingClientRect().left - left,
        }
      }

      const ordinary = callout("note")
      const fenced = callout("example")
      const nestedContainer = callout("question")
      const nested = callout("answer")
      const combined = callout("success")
      const ordinaryHeader = headerContent(ordinary).getBoundingClientRect()
      const fencedHeader = headerContent(fenced).getBoundingClientRect()
      const nestedHeader = headerLine(nestedContainer).getBoundingClientRect()

      return {
        combined: offsets(combined),
        fencedGap:
          firstBodyChild(fenced).getBoundingClientRect().top -
          fencedHeader.bottom,
        nestedGap: nested.getBoundingClientRect().top - nestedHeader.bottom,
        nestedLineHeight: Number.parseFloat(
          getComputedStyle(nestedContainer).lineHeight
        ),
        nestedOutlineStyle: getComputedStyle(nested).outlineStyle,
        ordinary: offsets(ordinary),
        ordinaryGap:
          firstBodyChild(ordinary).getBoundingClientRect().top -
          ordinaryHeader.bottom,
      }
    })
    expect(calloutGeometry.ordinaryGap).toBeGreaterThan(5)
    expect(
      Math.abs(calloutGeometry.fencedGap - calloutGeometry.ordinaryGap)
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(calloutGeometry.nestedGap - calloutGeometry.nestedLineHeight)
    ).toBeLessThanOrEqual(0.5)
    expect(calloutGeometry.nestedGap).toBeGreaterThan(
      calloutGeometry.ordinaryGap + 10
    )
    expect(calloutGeometry.nestedOutlineStyle).toBe("none")
    for (const key of ["body", "title", "headerHeight"] as const) {
      expect(
        Math.abs(calloutGeometry.combined[key] - calloutGeometry.ordinary[key])
      ).toBeLessThanOrEqual(0.5)
    }
    expect(
      Math.abs(calloutGeometry.ordinary.title - calloutGeometry.ordinary.body)
    ).toBeLessThanOrEqual(0.5)

    await calloutCode
      .locator('.cm-line[data-code-line-number="1"]')
      .click({ position: { x: 100, y: 8 } })
    await expect(fencedCallout).toHaveCount(0)
    await expect(calloutCode).toHaveAttribute("data-code-wrap", "false")
    await expect(calloutCode.locator(".cm-md-code-tools-host")).toHaveCount(1)
    await expect(
      calloutCode.locator('.cm-line[data-code-line-number="1"]')
    ).toBeVisible()
    await calloutCode.hover()
    await expect(
      calloutCode.getByRole("button", { name: "Copy code" })
    ).toBeVisible()

    await scrollSourceIntoView(page, "```Empty")
    const emptyCode = page.locator(".cm-md-code-block").filter({
      has: page.locator(".cm-md-code-language", { hasText: "Empty" }),
    })
    await expect(emptyCode).toHaveCount(1)
    await expect(emptyCode.locator(".cm-md-code-tools-host")).toHaveCount(1)
    await emptyCode.evaluate((element) =>
      element.scrollIntoView({ block: "center" })
    )
    await emptyCode.hover()
    const emptyCopy = emptyCode.getByRole("button", { name: "Copy code" })
    const emptyTooltipId = await emptyCopy.getAttribute("aria-describedby")
    expect(emptyTooltipId).not.toBeNull()
    const emptyTooltip = page.locator(`#${emptyTooltipId}`)
    await emptyCopy.hover()
    await expect(emptyTooltip).toHaveCSS("visibility", "visible")
    await emptyCopy.focus()
    await page.mouse.move(0, 0)
    await expect(emptyTooltip).toHaveCSS("visibility", "visible")

    const emptyBlockBox = await emptyCode.boundingBox()
    const emptyButtonBox = await emptyCopy.boundingBox()
    const emptyTooltipBox = await emptyTooltip.boundingBox()
    expect(emptyBlockBox).not.toBeNull()
    expect(emptyButtonBox).not.toBeNull()
    expect(emptyTooltipBox).not.toBeNull()
    expect(emptyBlockBox!.height).toBeGreaterThanOrEqual(emptyButtonBox!.height)
    expect(emptyButtonBox!.y).toBeGreaterThanOrEqual(emptyBlockBox!.y - 0.5)
    expect(emptyButtonBox!.y + emptyButtonBox!.height).toBeLessThanOrEqual(
      emptyBlockBox!.y + emptyBlockBox!.height + 0.5
    )
    expect(emptyTooltipBox!.y).toBeGreaterThanOrEqual(
      emptyButtonBox!.y + emptyButtonBox!.height
    )
    expect(emptyTooltipBox!.x).toBeGreaterThanOrEqual(emptyBlockBox!.x)
    expect(emptyTooltipBox!.x + emptyTooltipBox!.width).toBeLessThanOrEqual(
      emptyBlockBox!.x + emptyBlockBox!.width
    )
    expect(
      await emptyTooltip.evaluate(
        (tooltip) =>
          new Promise<number>((resolve) => {
            const observer = new IntersectionObserver(([entry]) => {
              observer.disconnect()
              resolve(entry?.intersectionRatio ?? 0)
            })
            observer.observe(tooltip)
          })
      )
    ).toBeCloseTo(1, 5)
    expect(
      await emptyTooltip.evaluate((tooltip) =>
        tooltip.parentElement?.classList.contains("cm-editor")
      )
    ).toBe(true)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    const sourceGutter = await page.evaluate(() => {
      const active = document.querySelector<HTMLElement>(
        ".cm-lineNumbers .cm-activeLineGutter"
      )
      const inactive = document.querySelector<HTMLElement>(
        ".cm-lineNumbers .cm-gutterElement:not(.cm-activeLineGutter)"
      )
      if (!active || !inactive) {
        throw new Error("Source line-number gutters are unavailable")
      }
      const colorAlpha = (color: string) => {
        const canvas = document.createElement("canvas")
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext("2d", { willReadFrequently: true })
        if (!context) throw new Error("Canvas color parsing is unavailable")
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return context.getImageData(0, 0, 1, 1).data[3] ?? 0
      }
      const activeColor = getComputedStyle(active).color
      const inactiveColor = getComputedStyle(inactive).color
      const content = document.querySelector<HTMLElement>(".cm-content")
      if (!content) throw new Error("Source content is unavailable")
      return {
        activeBackground: getComputedStyle(active).backgroundColor,
        activeAlpha: colorAlpha(activeColor),
        activeColor,
        contentAlpha: colorAlpha(getComputedStyle(content).color),
        contentColor: getComputedStyle(content).color,
        inactiveBackground: getComputedStyle(inactive).backgroundColor,
        inactiveAlpha: colorAlpha(inactiveColor),
        inactiveColor,
      }
    })
    expect(sourceGutter.activeBackground).toBe(sourceGutter.inactiveBackground)
    expect(sourceGutter.activeColor).not.toBe(sourceGutter.contentColor)
    expect(sourceGutter.activeColor).not.toBe(sourceGutter.inactiveColor)
    expect(sourceGutter.activeAlpha).toBeGreaterThan(sourceGutter.inactiveAlpha)
    expect(sourceGutter.activeAlpha).toBeLessThan(sourceGutter.contentAlpha)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("nested callout code keeps the same edit-mode content inset @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-callout-code-inset-")
  )
  const filePath = path.join(userData, "callout-code-inset.md")
  await writeFile(
    filePath,
    [
      "Intro.",
      "",
      "> [!example]+ Top-level code",
      "> ```json",
      "> topLevelValue();",
      "> ```",
      "",
      "1. Parent item",
      "",
      "   > [!success]+ List-nested code",
      "   > ```typescript",
      "   > nestedValue();",
      "   > ```",
      "",
      "> [!note]+ Outer quote",
      "> 1. Quoted parent",
      ">",
      ">    > [!warning]+ Alternating containers",
      ">    > ```typescript",
      ">    > alternatingValue();",
      ">    > ````",
    ].join("\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")

    const codeBlock = (source: string) =>
      page.locator(".cm-md-code-block").filter({ hasText: source })
    const contentInset = (source: string) =>
      codeBlock(source).evaluate((element, target) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node && !node.textContent?.includes(target)) {
          node = walker.nextNode()
        }
        if (!(node instanceof Text)) {
          throw new Error(`Code source is unavailable: ${target}`)
        }
        const offset = node.textContent!.indexOf(target)
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        return (
          range.getBoundingClientRect().left -
          element.getBoundingClientRect().left
        )
      }, source)
    const activateCode = async (source: string, calloutType: string) => {
      const block = codeBlock(source)
      const callout = page.locator(
        `.cm-md-callout[data-callout-type="${calloutType}"]`
      )
      await expect(block).toHaveCount(1)
      await expect(callout).toHaveCount(1)
      await block.scrollIntoViewIfNeeded()
      await block
        .locator('.cm-line[data-code-line-number="1"]')
        .click({ position: { x: 100, y: 8 } })
      await expect(callout).toHaveCount(0)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
      )
    }

    await activateCode("topLevelValue", "example")
    const topLevelInset = await contentInset("topLevelValue")
    await activateCode("nestedValue", "success")
    await expect
      .poll(async () =>
        Math.abs((await contentInset("nestedValue")) - topLevelInset)
      )
      .toBeLessThanOrEqual(0.5)
    await activateCode("alternatingValue", "warning")
    await expect
      .poll(async () =>
        Math.abs((await contentInset("alternatingValue")) - topLevelInset)
      )
      .toBeLessThanOrEqual(0.5)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("fenced language drag keeps ZWJ grapheme endpoints intact @renderer-isolated", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-code-info-unicode-e2e-")
  )
  const filePath = path.join(userData, "code-info-unicode.md")
  const grapheme = "👩‍💻"
  const source = `\`\`\`${grapheme} mode\nvalue\n\`\`\`\n`
  await writeFile(filePath, source)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")

    const language = page.locator(".cm-md-code-language")
    await expect(language).toHaveText(`${grapheme} mode`)
    await language.evaluate((element) => {
      element.style.fontSize = "72px"
      element.style.letterSpacing = "0"
      element.style.maxWidth = "none"
    })
    await language.hover()
    await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible()

    const drag = await language.evaluate((element, clusterLength) => {
      const text = element.firstChild
      if (!(text instanceof Text)) {
        throw new Error("Code-info text is unavailable")
      }
      const cluster = element.ownerDocument.createRange()
      cluster.setStart(text, 0)
      cluster.setEnd(text, clusterLength)
      const bounds = cluster.getBoundingClientRect()
      const distance = Math.min(18, bounds.width / 3)
      return {
        clusterWidth: bounds.width,
        endX: bounds.left + 1 + distance,
        startX: bounds.left + 1,
        y: bounds.top + bounds.height / 2,
      }
    }, grapheme.length)
    expect(drag.clusterWidth).toBeGreaterThan(36)
    expect(drag.endX - drag.startX).toBeGreaterThan(10)
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest(".cm-md-code-language") !=
          null,
        { x: drag.startX, y: drag.y }
      )
    ).toBe(true)

    await page.mouse.move(drag.startX, drag.y)
    await page.mouse.down()
    await page.mouse.move(drag.endX, drag.y, { steps: 3 })
    await page.mouse.up()

    const selection = await page.locator(".cm-content").evaluate((content) => {
      const view = (
        content as HTMLElement & {
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
      return {
        from,
        text: view.state.doc.sliceString(from, to),
        to,
      }
    })
    const graphemeFrom = source.indexOf(grapheme)
    expect(selection.from).toBe(graphemeFrom)
    expect(selection.to).toBe(graphemeFrom + grapheme.length)
    expect(selection.to - selection.from).toBe(grapheme.length)
    expect(selection.text).toBe(grapheme)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
