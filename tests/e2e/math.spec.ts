import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const modifier = process.platform === "darwin" ? "Meta" : "Control"

test("live preview renders inline and multiline LaTeX and reveals its source", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-math-e2e-"))
  const filePath = path.join(userData, "math.md")
  const lines = [
    "**Inline Math:** The Pythagorean theorem is $a^2 + b^2 = c^2$.",
    "",
    "> > - So can inline math: $u^2 + v^2 = w^2$.",
    "",
    "| Feature | Result |",
    "| --- | --- |",
    "| Math | $2^5 = 32$ |",
    String.raw`| Display | $$\int_a^b f(x)\,dx<br>= F(b) - F(a)$$ |`,
    "",
    "**Block Math:**",
    "$$",
    String.raw`\int_a^b x^2 \, dx = \frac{b^3-a^3}{3}`,
    "$$",
    "",
    "An unfinished expression stays editable: $x + y",
  ]
  await writeFile(filePath, lines.join("\n"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions.latex = true
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const inline = page.locator(
      '.cm-md-math-inline[data-math-source="a^2 + b^2 = c^2"]'
    )
    const nestedInline = page.locator(
      '.cm-md-math-inline[data-math-source="u^2 + v^2 = w^2"]'
    )
    const tableInline = page.locator(
      '.cm-md-math-inline[data-math-source="2^5 = 32"]'
    )
    const displayMath = page.locator(".cm-md-math-block")
    const tableDisplay = displayMath.first()
    const block = displayMath.nth(1)
    await expect(inline).toHaveAttribute("data-math-source", "a^2 + b^2 = c^2")
    await expect(block).toHaveAttribute(
      "data-math-source",
      String.raw`\int_a^b x^2 \, dx = \frac{b^3-a^3}{3}`
    )
    await expect(page.locator(".cm-md-math .katex")).toHaveCount(5)
    await expect(block).toHaveCSS("overflow-x", "auto")
    expect(
      await nestedInline.evaluate((element) => {
        const widgetLeft = element.getBoundingClientRect().left
        const renderedLeft = element
          .querySelector(".katex-html")!
          .getBoundingClientRect().left
        return renderedLeft - widgetLeft
      })
    ).toBeGreaterThanOrEqual(-0.5)
    expect(
      await tableInline.evaluate(
        (element) => element.closest(".cm-md-table-cell") != null
      )
    ).toBe(true)
    await expect(tableDisplay).toHaveCount(1)
    await expect(tableDisplay).toHaveAttribute(
      "data-math-source",
      String.raw`\int_a^b f(x)\,dx` + "\n= F(b) - F(a)"
    )
    expect(
      await tableDisplay.evaluate(
        (element) =>
          element.closest(".cm-md-table-cell") != null &&
          element
            .closest(".cm-md-table-scroll")
            ?.querySelectorAll(".cm-md-table-row").length === 2
      )
    ).toBe(true)

    await inline.click()
    await expect(inline).toHaveCount(0)
    await expect(page.locator(".cm-line").first()).toContainText(
      "$a^2 + b^2 = c^2$"
    )

    await page.keyboard.press("Home")
    for (let index = 0; index < lines[0]!.indexOf("a^2"); index += 1) {
      await page.keyboard.press("ArrowRight")
    }
    for (let index = 0; index < "a^2".length; index += 1) {
      await page.keyboard.press("Shift+ArrowRight")
    }
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(1)
    await page.keyboard.press(`${modifier}+,`)
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible()
    await expect(inline).toHaveCount(0)
    await expect(page.locator(".cm-app-selectionBackground")).toHaveCount(1)
    await page.getByRole("button", { name: "Cancel" }).click()

    await page
      .locator(".cm-line")
      .first()
      .click({ position: { x: 8, y: 8 } })
    await expect(inline).toHaveCount(1)
    await tableInline.click()
    await expect(tableInline).toHaveCount(0)
    await expect(
      page.locator(".cm-md-table-row").locator(".cm-md-table-cell").nth(1)
    ).toContainText("$2^5 = 32$")
    await block.click()
    await expect(block).toHaveCount(0)
    await expect(page.locator(".cm-content")).toContainText(
      String.raw`\int_a^b x^2 \, dx = \frac{b^3-a^3}{3}`
    )

    await page.keyboard.press(`${modifier}+Shift+V`)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-md-math")).toHaveCount(0)
    await expect(page.locator(".cm-line")).toHaveText(lines)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("display delimiter whitespace keeps rendered geometry and source navigation", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-math-whitespace-")
  )
  const filePath = path.join(userData, "math.md")
  const source = [
    "Intro",
    "",
    "Before plain",
    "$$",
    "x^2",
    "$$",
    "After plain",
    "",
    "Before padded",
    "  $$",
    "x^2",
    "$$   \t  ",
    "After padded",
    "",
    "End",
  ].join("\n")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions.latex = true
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
    const assertGeometry = async () => {
      await expect(page.locator(".cm-md-math-block .katex")).toHaveCount(2)
      await expect
        .poll(() =>
          content.evaluate((element) => {
            const formulas = [...element.querySelectorAll(".cm-md-math-block")]
            return Math.max(
              ...formulas.flatMap((formula) => {
                const before =
                  formula.previousElementSibling!.getBoundingClientRect()
                const after =
                  formula.nextElementSibling!.getBoundingClientRect()
                const bounds = formula.getBoundingClientRect()
                return [
                  Math.abs(bounds.top - before.bottom),
                  Math.abs(after.top - bounds.bottom),
                ]
              })
            )
          })
        )
        .toBeLessThanOrEqual(0.5)
      for (const [index, kind] of ["plain", "padded"].entries()) {
        const formula = page.locator(".cm-md-math-block").nth(index)
        expect(
          await formula.evaluate(
            (element) => element.previousElementSibling?.textContent
          )
        ).toBe(`Before ${kind}`)
        expect(
          await formula.evaluate(
            (element) => element.nextElementSibling?.textContent
          )
        ).toBe(`After ${kind}`)
      }
    }
    await assertGeometry()
    await page.locator(".cm-line").filter({ hasText: /^End$/ }).click()
    const paddedEnd = source.indexOf("$$   \t  ") + "$$   \t  ".length
    await content.evaluate((element, position) => {
      const view = (
        element as HTMLElement & {
          cmTile?: {
            view?: { dispatch(spec: { selection: { anchor: number } }): void }
          }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      view.dispatch({ selection: { anchor: position } })
    }, paddedEnd)
    await expect(page.locator(".cm-md-math-block")).toHaveCount(1)
    expect(
      await page
        .locator(".cm-line")
        .evaluateAll(
          (lines) =>
            lines.filter((line) => line.textContent === "$$   \t  ").length
        )
    ).toBe(1)
    await page.keyboard.press("Escape")
    await assertGeometry()
    await page.keyboard.press(`${modifier}+Shift+V`)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-line")).toHaveText(source.split("\n"))
    await page.keyboard.press(`${modifier}+Shift+V`)
    await assertGeometry()
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
