import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
const documentEnd = `${process.platform === "darwin" ? "Meta" : "Control"}+End`

async function editorSource(page: Page) {
  return page.locator(".cm-content").evaluate((element) => {
    const view = (
      element as HTMLElement & {
        cmTile?: { view?: { state: { doc: { toString(): string } } } }
      }
    ).cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    return view.state.doc.toString()
  })
}

test("path completion traverses folders by keyboard and selects scrolled files by mouse", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-path-completion-")
  )
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "paths.md")
  const docsDirectory = path.join(testDirectory, "docs")
  const manyDirectory = path.join(testDirectory, "many")
  const nestedDirectory = path.join(
    testDirectory,
    "nested",
    "level one",
    "level two"
  )
  await Promise.all([
    mkdir(docsDirectory),
    mkdir(manyDirectory),
    mkdir(nestedDirectory, { recursive: true }),
  ])
  await Promise.all([
    writeFile(documentPath, "# Paths\n"),
    writeFile(path.join(docsDirectory, "chapter one.md"), "# One\n"),
    writeFile(path.join(docsDirectory, "chapter two.md"), "# Two\n"),
    writeFile(
      path.join(testDirectory, "nested", "level one", "nearby.md"),
      "# Nearby\n"
    ),
    writeFile(path.join(nestedDirectory, "deep one.md"), "# Deep one\n"),
    writeFile(path.join(nestedDirectory, "deep two.md"), "# Deep two\n"),
    ...Array.from({ length: 40 }, (_, index) =>
      writeFile(
        path.join(manyDirectory, `item ${index + 1}.md`),
        `# Item ${index + 1}\n`
      )
    ),
  ])

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const completion = page.locator(".cm-tooltip-autocomplete")
    await page.locator(".cm-editor").waitFor()
    await content.focus()
    await page.keyboard.press(documentEnd)
    await page.keyboard.insertText("\n[Read](./do")

    await expect(completion).toBeVisible()
    const appearance = await completion.evaluate((element) => {
      const list = element.querySelector("ul")
      const item = element.querySelector("li")
      const icon = element.querySelector(".cm-completionIcon")
      if (!list || !item || !icon)
        throw new Error("Completion UI is incomplete")

      const tokenProbe = document.createElement("span")
      tokenProbe.style.cssText =
        "position:fixed;visibility:hidden;background:var(--popover);color:var(--popover-foreground)"
      document.body.append(tokenProbe)
      const expectedPopover = getComputedStyle(tokenProbe)
      const popoverBackground = expectedPopover.backgroundColor
      const popoverForeground = expectedPopover.color
      tokenProbe.style.backgroundColor = "var(--accent)"
      tokenProbe.style.color = "var(--accent-foreground)"
      const expectedAccent = getComputedStyle(tokenProbe)
      const accentBackground = expectedAccent.backgroundColor
      const accentForeground = expectedAccent.color
      tokenProbe.remove()

      const popupStyle = getComputedStyle(element)
      const listStyle = getComputedStyle(list)
      const itemStyle = getComputedStyle(item)
      const iconStyle = getComputedStyle(icon, "::after")
      return {
        accentBackground,
        accentForeground,
        hasScopedClass: element.classList.contains("cm-path-completion-popup"),
        iconMask: iconStyle.maskImage,
        itemFontWeight: itemStyle.fontWeight,
        itemMinHeight: itemStyle.minHeight,
        itemPadding: itemStyle.padding,
        itemRadius: Number.parseFloat(itemStyle.borderRadius),
        listFontFamily: listStyle.fontFamily,
        listOverflow: listStyle.overflowY,
        listScrollbar: listStyle.scrollbarWidth,
        popupBackground: popupStyle.backgroundColor,
        popupBorder: popupStyle.borderTopWidth,
        popupColor: popupStyle.color,
        popupRadius: Number.parseFloat(popupStyle.borderRadius),
        popupShadow: popupStyle.boxShadow,
        popoverBackground,
        popoverForeground,
      }
    })
    expect(appearance).toMatchObject({
      hasScopedClass: true,
      itemFontWeight: "500",
      itemMinHeight: "36px",
      itemPadding: "8px 12px",
      listOverflow: "auto",
      listScrollbar: "none",
      popupBorder: "0px",
      popupShadow: expect.not.stringMatching(/^none$/),
    })
    expect(appearance.popupBackground).toBe(appearance.popoverBackground)
    expect(appearance.popupColor).toBe(appearance.popoverForeground)
    expect(appearance.popupRadius).toBeGreaterThanOrEqual(16)
    expect(appearance.itemRadius).toBeGreaterThanOrEqual(12)
    expect(appearance.listFontFamily).toContain("Inter")
    expect(appearance.iconMask).not.toBe("none")
    await expect(
      completion.locator('[role="option"][aria-selected="true"]')
    ).toHaveCSS("background-color", appearance.accentBackground)
    await expect(
      completion.locator('[role="option"][aria-selected="true"]')
    ).toHaveCSS("color", appearance.accentForeground)
    await expect(completion.locator(".cm-completionDetail")).toHaveCount(0)
    await expect(
      completion.getByRole("option").filter({ hasText: "docs" })
    ).toHaveCount(1)
    await page.keyboard.press("Tab")
    await expect.poll(() => editorSource(page)).toContain("[Read](./docs/")

    await expect(completion).toBeVisible()
    const selected = completion.locator('[role="option"][aria-selected="true"]')
    await expect(selected).toContainText("chapter one.md")
    await page.keyboard.press("ArrowDown")
    await expect(selected).toContainText("chapter two.md")
    await page.keyboard.press("Enter")
    await expect(completion).toHaveCount(0)
    await expect
      .poll(() => editorSource(page))
      .toContain("[Read](./docs/chapter%20two.md")

    await page.keyboard.insertText(`)\n[Deep](${testDirectory}/ne`)
    await expect(completion).toBeVisible()
    await page.keyboard.press("Tab")
    await expect.poll(() => editorSource(page)).toContain("/nested/")
    await expect(completion).toBeVisible()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Tab")
    await expect.poll(() => editorSource(page)).toContain("/level%20one/")
    await expect(completion).toBeVisible()
    await page.keyboard.press("Tab")
    await expect.poll(() => editorSource(page)).toContain("/level%20two/")
    await expect(completion).toBeVisible()
    await page.keyboard.press("ArrowDown")
    await expect(
      completion.locator('[role="option"][aria-selected="true"]')
    ).toContainText("deep two.md")
    await page.keyboard.press("Enter")
    await expect.poll(() => editorSource(page)).toContain("deep%20two.md")

    await page.keyboard.insertText(")\n[Pick](./ma")
    await expect(completion).toBeVisible()
    await page.keyboard.press("Tab")
    await expect(completion).toBeVisible()
    const list = completion.getByRole("listbox")
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight > element.clientHeight)
      )
      .toBe(true)
    const selectedHasListInsets = () =>
      list.evaluate((element) => {
        const selected = element.querySelector<HTMLElement>(
          ':scope > li[aria-selected="true"]'
        )
        if (!selected) return false
        const listBounds = element.getBoundingClientRect()
        const selectedBounds = selected.getBoundingClientRect()
        const style = getComputedStyle(element)
        const topInset = Number.parseFloat(style.paddingTop)
        const bottomInset = Number.parseFloat(style.paddingBottom)
        return (
          selectedBounds.top >= listBounds.top + topInset - 1 &&
          selectedBounds.bottom <= listBounds.bottom - bottomInset + 1
        )
      })
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press("ArrowDown")
      await expect.poll(selectedHasListInsets).toBe(true)
    }

    const hoverChoice = completion
      .getByRole("option")
      .filter({ hasText: "item 20.md" })
    await hoverChoice.scrollIntoViewIfNeeded()
    await hoverChoice.hover()
    await expect(hoverChoice).toHaveAttribute("aria-selected", "true")
    await page.keyboard.press("ArrowDown")
    await expect(hoverChoice).not.toHaveAttribute("aria-selected", "true")
    await expect.poll(selectedHasListInsets).toBe(true)
    const mouseChoice = completion
      .getByRole("option")
      .filter({ hasText: "item 35.md" })
    await mouseChoice.scrollIntoViewIfNeeded()
    await mouseChoice.click()
    await expect(completion).toHaveCount(0)
    await expect
      .poll(() => editorSource(page))
      .toContain("[Pick](./many/item%2035.md")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})
