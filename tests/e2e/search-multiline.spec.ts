import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

test("find and replace accept literal line breaks through the lazy search handoff @renderer-isolated", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-e2e-"))
  const temporaryDocument = path.join(
    os.tmpdir(),
    `pulse-md-multiline-search-${process.pid}.md`
  )
  await writeFile(temporaryDocument, "alpha\nbeta\n---\nalpha\nbeta\n")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, temporaryDocument],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/SearchOverlay-*"] },
        (_details, callback) => {
          setTimeout(() => callback({}), 3_000)
        }
      )
    })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+F" : "Control+H"
    )
    const loadingSearch = page.locator('[data-search-overlay-state="loading"]')
    await expect(loadingSearch).toBeVisible()

    const find = page.getByRole("textbox", { name: "Find" })
    await find.focus()
    await page.keyboard.insertText("alpha")
    await page.keyboard.press("Alt+Enter")
    await page.keyboard.insertText("beta")
    await expect(find).toHaveValue("alpha\nbeta")

    const replace = page.getByRole("textbox", { name: "Replace" })
    await replace.focus()
    await page.keyboard.insertText("gamma")
    await page.keyboard.press("Alt+Enter")
    await page.keyboard.insertText("delta")
    await expect(replace).toHaveValue("gamma\ndelta")

    const readySearch = page.locator('[data-search-overlay-state="ready"]')
    await expect(readySearch).toBeVisible({ timeout: 6_000 })
    await expect(find).toHaveValue("alpha\nbeta")
    await expect(replace).toHaveValue("gamma\ndelta")
    await expect(readySearch.locator("output")).toHaveText("0/2")

    await readySearch.getByRole("button", { name: "Replace all" }).click()
    await expect
      .poll(() =>
        page.locator(".cm-content").evaluate((element) =>
          (
            element as HTMLElement & {
              cmTile?: { view?: { state: { doc: { toString(): string } } } }
            }
          ).cmTile?.view?.state.doc.toString()
        )
      )
      .toBe("gamma\ndelta\n---\ngamma\ndelta\n")
  } finally {
    await exitApplication(app)
    await rm(temporaryDocument, { force: true })
    await rm(userData, { force: true, recursive: true })
  }
})
