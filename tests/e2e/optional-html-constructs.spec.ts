import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { EditorView } from "@codemirror/view"
import { _electron as electron, expect, test } from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(import.meta.dirname, "../..")
type EditorContent = HTMLElement & { cmTile?: { view?: EditorView } }

test("HTML renders within headings, cells, and nested quotes without changing source", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-html-constructs-")
  )
  const filePath = path.join(userData, "html.md")
  const source = [
    "Lead paragraph.",
    "",
    "# ATX <em>heading</em><br>next",
    "",
    "Setext <sup>title</sup>",
    "---------------------",
    "",
    "| <strong>header</strong> | Plain |",
    "| --- | --- |",
    "| <sub>cell</sub><br>next | value |",
    "",
    "> > <pre>",
    "> > > literal",
    "> >   indented",
    "> > </pre>",
    "",
    "End",
  ].join("\n")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions.sanitizedHtml = true
  await Promise.all([
    writeFile(filePath, source),
    writeFile(path.join(userData, "settings.json"), JSON.stringify(settings)),
  ])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    const assertRendered = async () => {
      await expect(page.locator(".cm-md-html-em")).toHaveText("heading")
      await expect(page.locator(".cm-md-html-sup")).toHaveText("title")
      await expect(
        page.locator(".cm-md-table-cell .cm-md-html-strong")
      ).toHaveText("header")
      await expect(
        page.locator(".cm-md-table-cell .cm-md-html-sub")
      ).toHaveText("cell")
      await expect(page.locator(".cm-md-html-break")).toHaveCount(2)
      await expect(page.locator(".cm-md-html-block pre")).toHaveText(
        "> literal\n  indented\n"
      )
    }
    await assertRendered()
    const preview = page.locator(".cm-md-html-block")
    await preview.click()
    await expect(preview).toHaveCount(0)
    const selected = await content.evaluate((element) => {
      const view = (element as EditorContent).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      const { from, to } = view.state.selection.main
      return view.state.sliceDoc(from, to)
    })
    expect(selected).toBe("<pre>\n> > > literal\n> >   indented\n> > </pre>")
    await page.keyboard.press("Escape")
    await assertRendered()
    await page.keyboard.press("ControlOrMeta+Shift+V")
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(
      page.locator(".cm-md-html-inline, .cm-md-html-block")
    ).toHaveCount(0)
    await page.keyboard.press("ControlOrMeta+Shift+V")
    await assertRendered()
    expect(
      await content.evaluate((element) =>
        (element as EditorContent).cmTile?.view?.state.doc.toString()
      )
    ).toBe(source)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
