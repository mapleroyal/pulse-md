import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication, openSettingsSection } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

async function createTestDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "pulse-md-context-menu-"))
}

async function launchApplication(userData: string, ...filePaths: string[]) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, ...filePaths],
    cwd: projectRoot,
  })
}

function editorMenu(page: Page) {
  return page.getByRole("menu", { name: "Editor context menu" })
}

function headingLinkMenu(page: Page) {
  return page.getByRole("menu", { name: "Heading link menu" })
}

async function textCenter(line: ReturnType<Page["locator"]>, text: string) {
  return line.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const value = node.nodeValue ?? ""
      const offset = value.indexOf(target)
      if (offset >= 0) {
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + target.length)
        const bounds = range.getBoundingClientRect()
        return {
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        }
      }
      node = walker.nextNode()
    }
    throw new Error(`Unable to find ${target} in the rendered line`)
  }, text)
}

test("the shadcn editor menu preserves selection for clipboard and formatting actions", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "context.md")
  await writeFile(documentPath, "alpha beta")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await content.click()
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(`${primary}+A`)
    await app.evaluate(({ clipboard }) => clipboard.clear())

    await content.click({ button: "right" })
    const menu = editorMenu(page)
    await expect(menu).toBeVisible()
    for (const item of [
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Select All",
      "Formatting",
    ]) {
      await expect(
        menu.getByRole("menuitem", { name: new RegExp(`^${item}`) })
      ).toBeVisible()
    }
    await menu.getByRole("menuitem", { name: /^Copy/ }).click()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("alpha beta")
    await expect(content).toBeFocused()

    await page.keyboard.press(`${primary}+A`)
    await content.click({ button: "right" })
    await editorMenu(page).getByRole("menuitem", { name: /^Cut/ }).click()
    await expect(content).toHaveText("")

    await content.click({ button: "right" })
    const paste = editorMenu(page).getByRole("menuitem", { name: /^Paste/ })
    await expect(paste).toBeEnabled()
    await paste.click()
    await expect(content).toContainText("alpha beta")

    await page.keyboard.press(`${primary}+A`)
    await content.click({ button: "right" })
    await editorMenu(page)
      .getByRole("menuitem", { name: "Formatting", exact: true })
      .hover()
    await page.getByRole("menuitem", { name: /^Bold/ }).click()
    await page.keyboard.press(`${primary}+A`)
    await page.keyboard.press(`${primary}+C`)
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("**alpha beta**")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("the editor context menu keeps an active Markdown construct in source @renderer-isolated", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "active-construct.md")
  const calloutSource = [
    "> [!NOTE] Active callout",
    "> Source body with **strong words**.",
  ].join("\n")
  await writeFile(documentPath, `Before.\n\n${calloutSource}\n\nAfter.\n`)
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    const callout = page.locator(".cm-md-callout")
    await expect(callout).toBeVisible()
    await callout.locator(".cm-md-callout-body").click()
    await expect(callout).toHaveCount(0)

    const sourceLine = content
      .locator(".cm-line")
      .filter({ hasText: "Source body with" })
    const target = await textCenter(sourceLine, "Source")
    await page.mouse.click(target.x, target.y)
    await expect(callout).toHaveCount(0)
    await page.mouse.click(target.x, target.y, { button: "right" })
    const menu = editorMenu(page)
    await expect(menu).toBeVisible()
    await expect
      .poll(() =>
        content.evaluate(
          (element) =>
            (
              element as HTMLElement & {
                cmTile?: { view?: { hasFocus: boolean } }
              }
            ).cmTile?.view?.hasFocus ?? true
        )
      )
      .toBe(false)
    await expect(callout).toHaveCount(0)
    await expect(content.locator(".cm-line")).toContainText([
      "> [!NOTE] Active callout",
      "> Source body with **strong words**.",
    ])

    const activeSelection = await content.evaluate((element) => {
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
    expect(activeSelection).toBe("Source")

    await page.keyboard.press("Escape")
    await expect(menu).not.toBeVisible()
    await expect(content).toBeFocused()
    await expect(callout).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("heading anchors reveal on hover and expose a copyable fragment link", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "headings.md")
  const otherDocumentPath = path.join(testDirectory, "other.md")
  const headingText =
    "Copy This Heading Across More Than One Visual Row While Keeping Its Link Beside The First Row"
  await Promise.all([
    writeFile(documentPath, `# ${headingText}\n\nBody\n`),
    writeFile(otherDocumentPath, "# Other Document\n"),
  ])
  const app = await launchApplication(userData, documentPath, otherDocumentPath)

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(520, 500)
    })
    await page.getByRole("tab", { name: documentPath, exact: true }).click()
    const heading = page
      .locator(".cm-line.cm-md-heading")
      .filter({ hasText: headingText })
    const anchor = heading.getByRole("button", { name: "Link to heading" })
    await heading.waitFor()
    await expect(anchor).toHaveCount(1)
    await expect
      .poll(() =>
        anchor.evaluate((element) => getComputedStyle(element).opacity)
      )
      .toBe("0")

    await heading.hover()
    await expect
      .poll(() =>
        anchor.evaluate((element) => Number(getComputedStyle(element).opacity))
      )
      .toBeGreaterThan(0.75)

    const geometry = await heading.evaluate((element) => {
      const anchor = element.querySelector<HTMLElement>(".cm-md-heading-anchor")
      if (!anchor) throw new Error("Heading anchor is unavailable")
      const headingBounds = element.getBoundingClientRect()
      const anchorBounds = anchor.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        anchorCenterY: anchorBounds.top + anchorBounds.height / 2,
        anchorLeft: anchorBounds.left,
        anchorRight: anchorBounds.right,
        firstLineCenterY:
          headingBounds.top +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.lineHeight) / 2,
        headingCenterY: headingBounds.top + headingBounds.height / 2,
        headingHeight: headingBounds.height,
        headingLeft: headingBounds.left,
        lineHeight: Number.parseFloat(style.lineHeight),
      }
    })
    expect(geometry.headingHeight).toBeGreaterThan(geometry.lineHeight * 1.5)
    expect(
      Math.abs(geometry.anchorCenterY - geometry.firstLineCenterY)
    ).toBeLessThan(1)
    expect(
      Math.abs(geometry.anchorCenterY - geometry.headingCenterY)
    ).toBeGreaterThan(geometry.lineHeight / 2)
    expect(Math.abs(geometry.anchorRight - geometry.headingLeft)).toBeLessThan(
      1
    )

    await page.mouse.move(geometry.anchorRight - 2, geometry.anchorCenterY)
    await expect
      .poll(() =>
        anchor.evaluate((element) => Number(getComputedStyle(element).opacity))
      )
      .toBeGreaterThan(0.75)

    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const content = page.locator(".cm-content")
    await content.focus()
    await page.keyboard.press(`${primary}+End`)
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await anchor.dispatchEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX: geometry.anchorRight - 2,
      clientY: geometry.anchorCenterY,
      detail: 0,
    })
    const menu = headingLinkMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem")).toHaveCount(2)
    await expect(
      menu.getByRole("menuitem", { name: "Open Link" })
    ).toBeVisible()
    await expect(editorMenu(page)).not.toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu).not.toBeVisible()

    await anchor.focus()
    await expect
      .poll(() =>
        anchor.evaluate((element) => Number(getComputedStyle(element).opacity))
      )
      .toBeGreaterThan(0.75)
    await page.keyboard.press("Enter")
    await expect(menu).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu).not.toBeVisible()

    // Reopening the same generated anchor must keep using its direct event
    // target instead of an approximate CodeMirror position under the widget.
    await anchor.click({ button: "right" })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem")).toHaveCount(2)
    await menu.getByRole("menuitem", { name: "Copy Link" }).click()
    const fragment =
      "copy-this-heading-across-more-than-one-visual-row-while-keeping-its-link-beside-the-first-row"
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(`${pathToFileURL(documentPath).href}#${fragment}`)
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readHTML()))
      .toContain('data-pulse-md-heading-link="3"')

    await content.focus()
    await page.keyboard.press(`${primary}+End`)
    await page.keyboard.insertText("\n")
    await page.keyboard.press(`${primary}+V`)
    await expect.poll(() => content.textContent()).toContain(`#${fragment}`)

    await page
      .getByRole("tab", { name: otherDocumentPath, exact: true })
      .click()
    await content.focus()
    await page.keyboard.press(`${primary}+End`)
    await page.keyboard.insertText("\n")
    await page.keyboard.press(`${primary}+V`)
    await expect
      .poll(() => content.textContent())
      .toContain(`headings.md#${fragment}`)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("the real Electron context-menu event delivers spelling actions to the shadcn menu", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "spelling.md")
  const spellingLine = `anotherwrng ${"ordinary ".repeat(8)}mispell`
  await writeFile(documentPath, spellingLine)
  const app = await launchApplication(userData, documentPath)

  const installSpellingContextStub = (
    firstTargetX: number,
    secondTargetX: number
  ) =>
    app.evaluate(
      ({ BrowserWindow }, targetXs) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error("The spelling test window is unavailable")
        const testGlobal = globalThis as typeof globalThis & {
          editorSpellingActions?: string[]
        }
        testGlobal.editorSpellingActions ??= []
        win.webContents.prependListener("context-menu", (_event, params) => {
          const secondWord =
            Math.abs(params.x - targetXs.second) <
            Math.abs(params.x - targetXs.first)
          params.dictionarySuggestions = secondWord
            ? ["anotherwrong"]
            : ["misspell", "mis-spell"]
          params.misspelledWord = secondWord ? "anotherwrng" : "mispell"
        })
        win.webContents.session.addWordToSpellCheckerDictionary = (word) => {
          testGlobal.editorSpellingActions?.push(`dictionary:${word}`)
          return true
        }
      },
      { first: firstTargetX, second: secondTargetX }
    )

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    const lines = page.locator(".cm-line")
    const [firstWord, secondWord] = await Promise.all([
      textCenter(lines.nth(0), "mispell"),
      textCenter(lines.nth(0), "anotherwrng"),
    ])
    await installSpellingContextStub(firstWord.x, secondWord.x)

    await page.mouse.click(firstWord.x, firstWord.y, { button: "right" })
    const dismissedMenu = editorMenu(page)
    await expect(dismissedMenu).toBeVisible()
    await page.mouse.click(500, 400)
    await expect(dismissedMenu).toBeHidden()
    await expect(content).toBeFocused()

    await page.mouse.click(firstWord.x, firstWord.y, { button: "right" })
    const menu = editorMenu(page)
    await expect(
      menu.getByRole("menuitem", { name: "misspell", exact: true })
    ).toBeVisible()
    await expect(
      menu.getByRole("menuitem", {
        name: "Add to Dictionary",
        exact: true,
      })
    ).toBeVisible()
    await menu.getByRole("menuitem", { name: "misspell", exact: true }).click()
    await expect(lines.nth(0)).toHaveText(
      spellingLine.replace("mispell", "misspell")
    )
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            editorSpellingActions?: string[]
          }
          return testGlobal.editorSpellingActions
        })
      )
      .toEqual([])

    await page.mouse.click(secondWord.x, secondWord.y, { button: "right" })
    await editorMenu(page)
      .getByRole("menuitem", {
        name: "Add to Dictionary",
        exact: true,
      })
      .click()
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            editorSpellingActions?: string[]
          }
          return testGlobal.editorSpellingActions
        })
      )
      .toEqual(["dictionary:anotherwrng"])

    const correctedFirstWord = await textCenter(lines.nth(0), "misspell")
    await page.mouse.click(correctedFirstWord.x, correctedFirstWord.y, {
      button: "right",
    })
    await expect(editorMenu(page)).toBeVisible()
    await page.mouse.click(secondWord.x, secondWord.y, { button: "right" })
    await expect(
      editorMenu(page).getByRole("menuitem", {
        name: "anotherwrong",
        exact: true,
      })
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe("anotherwrng")

    await app.evaluate(({ clipboard }) => clipboard.clear())
    await editorMenu(page).getByRole("menuitem", { name: /^Copy/ }).click()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("anotherwrng")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("spell checking persists disabled and can be re-enabled live after restart @renderer-isolated", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "spelling-setting.md")
  await writeFile(documentPath, "zzzxqvblorp")
  let app: ElectronApplication | null = await launchApplication(
    userData,
    documentPath
  )

  const spellCheckerEnabled = () =>
    app!.evaluate(({ session }) =>
      session.defaultSession.isSpellCheckerEnabled()
    )

  try {
    let page = await app.firstWindow()
    await page.locator(".cm-content").waitFor()
    await expect.poll(spellCheckerEnabled).toBe(true)
    await expect(page.locator(".cm-app-spelling-error")).toHaveText(
      "zzzxqvblorp"
    )

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openSettingsSection(page, "Miscellaneous")
    const settings = page.getByRole("dialog", { name: "Settings" })
    const spellCheck = settings.getByRole("switch", {
      name: "Spell checking",
    })
    await expect(spellCheck).toBeChecked()
    await spellCheck.click()
    await settings.getByRole("button", { name: "Done", exact: true }).click()

    await expect.poll(spellCheckerEnabled).toBe(false)
    await expect(page.locator(".cm-app-spelling-error")).toHaveCount(0)
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { spellCheck?: unknown }
        return saved.spellCheck
      })
      .toBe(false)

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, documentPath)
    page = await app.firstWindow()
    const restartedContent = page.locator(".cm-content")
    await restartedContent.waitFor()
    await expect.poll(spellCheckerEnabled).toBe(false)
    await expect(restartedContent).toHaveAttribute("spellcheck", "false")
    await expect(page.locator(".cm-app-spelling-error")).toHaveCount(0)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openSettingsSection(page, "Miscellaneous")
    const restartedSettings = page.getByRole("dialog", { name: "Settings" })
    const restartedSpellCheck = restartedSettings.getByRole("switch", {
      name: "Spell checking",
    })
    await expect(restartedSpellCheck).not.toBeChecked()
    await restartedSpellCheck.click()
    await restartedSettings
      .getByRole("button", { name: "Done", exact: true })
      .click()

    await expect.poll(spellCheckerEnabled).toBe(true)
    await expect(page.locator(".cm-app-spelling-error")).toHaveText(
      "zzzxqvblorp"
    )
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { spellCheck?: unknown }
        return saved.spellCheck
      })
      .toBe(true)
  } finally {
    if (app) await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("spelling ranges survive context clicks and viewport recycling @renderer-isolated", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "spelling-viewport.md")
  const misspelledWord = "Qwen3-TTS-12Hz-0.6B-Base-4bit"
  await writeFile(
    documentPath,
    [
      `A durable ${misspelledWord} spelling range.`,
      ...Array.from(
        { length: 160 },
        (_, index) => `Ordinary filler line number ${index + 1}.`
      ),
    ].join("\n")
  )
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    const spellingMarker = page
      .locator(".cm-app-spelling-error")
      .filter({ hasText: misspelledWord })
    await expect(spellingMarker).toHaveCount(1)

    const largerSelection = `durable ${misspelledWord} spelling`
    await page.evaluate(
      ({ selectedText }) => {
        const content = document.querySelector<HTMLElement>(".cm-content") as
          | (HTMLElement & {
              cmTile?: {
                view?: {
                  dispatch(spec: {
                    selection: { anchor: number; head: number }
                  }): void
                  state: {
                    doc: {
                      line(number: number): { from: number; text: string }
                    }
                  }
                }
              }
            })
          | null
        const view = content?.cmTile?.view
        if (!view) throw new Error("The editor view is unavailable")
        const line = view.state.doc.line(1)
        const from = line.from + line.text.indexOf(selectedText)
        view.dispatch({
          selection: { anchor: from, head: from + selectedText.length },
        })
      },
      { selectedText: largerSelection }
    )
    const target = await textCenter(
      page.locator(".cm-line").first(),
      misspelledWord
    )
    await page.mouse.click(target.x, target.y, { button: "right" })
    const menu = editorMenu(page)
    await expect(menu).toBeVisible()
    await expect(
      menu.getByRole("menuitem", {
        name: "Add to Dictionary",
        exact: true,
      })
    ).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe(largerSelection)
    await page.mouse.click(500, 400)

    await page.mouse.click(target.x, target.y)
    await page.mouse.click(target.x, target.y, { button: "right" })
    await expect(
      editorMenu(page).getByRole("menuitem", {
        name: "Add to Dictionary",
        exact: true,
      })
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe(misspelledWord)
    await expect(spellingMarker).toHaveCount(1)
    await page.mouse.click(500, 400)

    const scroller = page.locator(".cm-scroller")
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(spellingMarker).toHaveCount(0)
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(spellingMarker).toHaveCount(1, { timeout: 1_000 })
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("fenced code spelling actions target the complete compound token @renderer-isolated", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "spelling-code.md")
  const misspelledWord = "Qwen3-TTS-12Hz-0.6B-Base-4bit"
  await writeFile(
    documentPath,
    ["```text", `mlx-community/${misspelledWord}`, "```"].join("\n")
  )
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    const spellingMarker = page
      .locator(".cm-app-spelling-error")
      .filter({ hasText: misspelledWord })
    await expect(spellingMarker).toHaveCount(1)

    const target = await textCenter(
      page.locator(".cm-md-code-content-line"),
      misspelledWord
    )
    await page.mouse.click(target.x, target.y, { button: "right" })
    await expect(
      editorMenu(page).getByRole("menuitem", {
        name: "Add to Dictionary",
        exact: true,
      })
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.getSelection()?.toString()))
      .toBe(misspelledWord)
    await expect(spellingMarker).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Command-right-click on a local document link shows only Open in New Tab", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const sourcePath = path.join(testDirectory, "source.md")
  const destinationPath = path.join(testDirectory, "destination.md")
  await Promise.all([
    writeFile(sourcePath, "[Open destination](destination.md)\n"),
    writeFile(destinationPath, "# Destination\n"),
  ])
  const app = await launchApplication(userData, sourcePath)

  try {
    const page = await app.firstWindow()
    const link = page
      .locator(".cm-md-link")
      .filter({ hasText: "Open destination" })
    await expect(link).toBeVisible()

    await link.click({ button: "right" })
    await expect(
      editorMenu(page).getByRole("menuitem", {
        name: "Open Link",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      editorMenu(page).getByRole("menuitem", {
        name: "Copy Link",
        exact: true,
      })
    ).toBeVisible()
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await editorMenu(page)
      .getByRole("menuitem", { name: "Copy Link", exact: true })
      .click()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("destination.md")

    await link.click({
      button: "right",
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    })
    const menu = editorMenu(page)
    await expect(menu).toHaveAttribute(
      "data-editor-context-menu",
      "link-new-tab"
    )
    await expect(menu.getByRole("menuitem")).toHaveCount(1)
    await menu
      .getByRole("menuitem", { name: "Open in New Tab", exact: true })
      .click()
    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", destinationPath)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})
