import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { _electron as electron, expect, test } from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

test("a 21k-line paste keeps its collapsed code caret editable", async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-large-input-e2e-")
  )
  const finalLine = `session record payload ${"abcdefghij ".repeat(100)}`
  const source = [
    ...Array.from({ length: 20_998 }, (_, index) => `record line ${index}`),
    "```text",
    finalLine,
  ].join("\n")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await editor.waitFor()
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      source
    )
    await page.locator(".cm-content").click()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+V" : "Control+V"
    )
    await expect(page.locator(".status-overlay")).toContainText("21,000 lines")

    const codeBlock = page.locator(".cm-md-code-block").last()
    await expect(codeBlock).toBeVisible()
    await expect(editor).not.toHaveAttribute("data-code-native-selection", "")
    await expect(page.locator(".cm-cursorLayer")).toHaveCSS(
      "visibility",
      "visible"
    )
    await expect
      .poll(async () => {
        const caret = await page.locator(".cm-cursor").first().boundingBox()
        const block = await codeBlock.boundingBox()
        if (!caret || !block) return Number.POSITIVE_INFINITY
        return Math.max(
          block.x - caret.x,
          caret.x - (block.x + block.width),
          block.y - caret.y,
          caret.y - (block.y + block.height),
          0
        )
      })
      .toBeLessThanOrEqual(0.5)

    await page.keyboard.insertText("abc")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.insertText("X")
    await expect(page.locator(".cm-line").last()).toHaveText(`${finalLine}aXbc`)
    await expect(editor).not.toHaveAttribute("data-code-native-selection", "")
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
