import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { EditorView } from "@codemirror/view"
import { _electron as electron, expect, test } from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
type EditorContent = HTMLElement & { cmTile: { view: EditorView } }

test("inline tokens render while retaining source editing and fragment links", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-inline-tokens-")
  )
  const filePath = path.join(userData, "inline.md")
  const doc = [
    String.raw`Escaped \* and &amp; &#65;.`,
    "",
    "hard\\",
    "break",
    "",
    "[&amp;](#target)",
    "",
    "Code: ` code ` and `&amp; \\`.",
    "",
    "# target",
  ].join("\n")
  await writeFile(filePath, doc)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")
    await expect(page.locator(".cm-line").first()).toHaveText(
      "Escaped * and & A."
    )
    await expect(
      page.locator(".cm-line").filter({ hasText: /^hard/ })
    ).toHaveText("hard")
    await expect(page.locator(".cm-md-inline-code").first()).toHaveText("code")
    const link = page.locator(".cm-md-link").filter({ hasText: "&" })
    await expect(link).toHaveText("&")
    await link.click({
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    })
    await expect
      .poll(() =>
        page
          .locator(".cm-content")
          .evaluate(
            (content) =>
              (content as EditorContent).cmTile.view.state.selection.main.head
          )
      )
      .toBe(doc.indexOf("# target"))

    await page.keyboard.press("Escape")
    const entity = page.locator(".cm-md-character-reference").first()
    await entity.click()
    await expect(page.locator(".cm-line").first()).toContainText("&amp;")
    const unchanged = await page
      .locator(".cm-content")
      .evaluate((content) =>
        (content as EditorContent).cmTile.view.state.doc.toString()
      )
    expect(unchanged).toBe(doc)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("multiline code keeps rendered text, precise clicks, and mode-switch source", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-inline-code-")
  )
  const filePath = path.join(userData, "inline-code.md")
  const doc = [
    "Begin `alpha",
    "beta` end.",
    "",
    "- List `first",
    "  second` tail.",
    "",
    "> Quote `one",
    "> two` tail.",
    "",
    "Last paragraph.",
  ].join("\n")
  await writeFile(filePath, doc)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")
    const codes = page.locator(".cm-md-inline-code")
    await expect
      .poll(() => codes.allTextContents())
      .toEqual(["alpha beta", "first second", "one two"])
    await expect(page.locator(".cm-line").first()).toHaveText(
      "Begin alpha beta end."
    )

    const beta = await codes.first().evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const from = node.textContent?.indexOf("beta") ?? -1
        if (from < 0) continue
        const range = document.createRange()
        range.setStart(node, from)
        range.setEnd(node, from + 1)
        const rect = range.getBoundingClientRect()
        return {
          x: rect.left + rect.width * 0.75,
          y: (rect.top + rect.bottom) / 2,
        }
      }
      throw new Error("Rendered code source text was not found")
    })
    await page.mouse.click(beta.x, beta.y)
    const head = await page
      .locator(".cm-content")
      .evaluate(
        (content) =>
          (content as EditorContent).cmTile.view.state.selection.main.head
      )
    expect(head).toBe(doc.indexOf("beta") + 1)
    await expect(codes.first()).toContainText("`alpha")

    await page.locator(".cm-content").evaluate(
      (content, anchor) => {
        const view = (content as EditorContent).cmTile.view
        view.dispatch({ selection: { anchor } })
        view.focus()
      },
      doc.indexOf("beta") - 1
    )
    await page.keyboard.press("ArrowRight")
    await expect
      .poll(() =>
        page
          .locator(".cm-content")
          .evaluate(
            (content) =>
              (content as EditorContent).cmTile.view.state.selection.main.head
          )
      )
      .toBe(doc.indexOf("beta"))

    await page.locator(".top-chrome-hover-sensor-top").hover()
    await page.getByRole("button", { name: "Switch to Raw Markdown" }).click()
    await expect(page.locator(".cm-editor")).not.toHaveClass(/cm-md-live/)
    await page
      .getByRole("button", { name: "Switch to Rendered Markdown" })
      .click()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await page.keyboard.press("Escape")
    await expect
      .poll(() => codes.allTextContents())
      .toEqual(["alpha beta", "first second", "one two"])
    expect(
      await page
        .locator(".cm-content")
        .evaluate((content) =>
          (content as EditorContent).cmTile.view.state.doc.toString()
        )
    ).toBe(doc)
    expect(errors).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("offscreen multiline code stays normalized through forward and reverse scrolling", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-inline-scroll-")
  )
  const filePath = path.join(userData, "inline-scroll.md")
  const doc = Array.from(
    { length: 700 },
    (_, index) => `Paragraph ${index}: \`token${index}\ncontinued\` tail.\n\n`
  ).join("")
  await writeFile(filePath, doc)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press("Escape")
    for (const fraction of [0, 0.25, 0.75, 1, 0.5, 0]) {
      await page.locator(".cm-scroller").evaluate((scroller, position) => {
        scroller.scrollTop =
          position * (scroller.scrollHeight - scroller.clientHeight)
      }, fraction)
      await page.evaluate(async () => {
        for (let frame = 0; frame < 4; frame++) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
      })
      await expect
        .poll(async () => {
          const code = await page
            .locator(".cm-md-inline-code")
            .allTextContents()
          return (
            code.length > 0 &&
            code.every((text) => /^token\d+ continued$/.test(text))
          )
        })
        .toBe(true)
    }
    expect(errors).toEqual([])
    expect(
      await page
        .locator(".cm-content")
        .evaluate((content) =>
          (content as EditorContent).cmTile.view.state.doc.toString()
        )
    ).toBe(doc)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
