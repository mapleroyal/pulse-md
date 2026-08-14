import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication, openSettingsSection } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const commandModifier = process.platform === "darwin" ? "Meta" : "Control"
const documentStart = `${commandModifier}+Home`
const documentEnd = `${commandModifier}+End`
const modeShortcut = `${commandModifier}+Shift+V`
const settingsShortcut = `${commandModifier}+,`
const toolbarShortcut = `${commandModifier}+Shift+B`

async function createDocument(source: string) {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-formatting-e2e-")
  )
  const filePath = path.join(userData, "formatting.md")
  await writeFile(filePath, source)
  return { filePath, userData }
}

async function launchApplication(userData: string, filePath: string) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
}

async function selectRight(page: Page, characters: number) {
  for (let index = 0; index < characters; index += 1) {
    await page.keyboard.press("Shift+ArrowRight")
  }
}

function settingsSelect(page: Page, label: string) {
  return page.getByRole("combobox", { name: label, exact: true })
}

async function chooseSelectOption(
  page: Page,
  trigger: Locator,
  option: string
) {
  await trigger.click()
  const popup = page.locator('[data-slot="select-content"]:visible')
  await expect(popup).toBeVisible()
  await popup.getByRole("option", { name: option, exact: true }).click()
}

async function expectSelectionPaintMatchesForeground(page: Page) {
  await expect
    .poll(async () => {
      const marker = await page
        .locator(".cm-app-selectionBackground")
        .first()
        .boundingBox()
      const foreground = await page
        .locator(".cm-app-selection-foreground")
        .first()
        .boundingBox()
      if (!marker || !foreground) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(marker.x - foreground.x),
        Math.abs(marker.width - foreground.width)
      )
    })
    .toBeLessThanOrEqual(1)
}

async function pasteText(page: Page, text: string) {
  await page.locator(".cm-content").evaluate((element, pastedText) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", pastedText)
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      })
    )
  }, text)
}

async function persistedSettings(userData: string) {
  try {
    return JSON.parse(
      await readFile(path.join(userData, "settings.json"), "utf8")
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function editorDocumentSelection(page: Page) {
  return page.locator(".cm-content").evaluate((element) => {
    const view = (
      element as HTMLElement & {
        cmTile?: {
          view?: {
            state: {
              doc: { toString(): string }
              selection: { main: { anchor: number; head: number } }
            }
          }
        }
      }
    ).cmTile?.view
    if (!view) throw new Error("CodeMirror view is unavailable")
    return {
      anchor: view.state.selection.main.anchor,
      doc: view.state.doc.toString(),
      head: view.state.selection.main.head,
    }
  })
}

test("typed delimiters repeatedly wrap a selection but stay literal without one @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("above\nalpha\nbelow")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const lines = page.locator(".cm-line")
    const line = lines.nth(1)
    await editor.waitFor()
    await page.locator(".cm-content").focus()

    await page.keyboard.press(documentStart)
    await page.keyboard.press("ArrowDown")
    await selectRight(page, "alpha".length)
    await page.keyboard.type("**")
    await expect(line).toHaveText("**alpha**")
    await expect(lines).toHaveText(["above", "**alpha**", "below"])
    await page.keyboard.press(`${commandModifier}+Z`)
    await expect(line).toHaveText("alpha")

    for (const [typed, expected] of [
      ["~", "~alpha~"],
      ["(", "(alpha)"],
    ] as const) {
      await page.keyboard.press(documentStart)
      await page.keyboard.press("ArrowDown")
      await selectRight(page, "alpha".length)
      await page.keyboard.type(typed)
      await expect(lines).toHaveText(["above", expected, "below"])
      await expectSelectionPaintMatchesForeground(page)
      await page.keyboard.press(`${commandModifier}+Z`)
    }

    await page.keyboard.press("End")
    await page.keyboard.insertText("~(")
    await expect(lines).toHaveText(["above", "alpha~(", "below"])
    await page.keyboard.press(`${commandModifier}+Z`)
    await expect(line).toHaveText("alpha")

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)

    const wrappingCases = [
      ["'", "'alpha'"],
      ['"', '"alpha"'],
      ["(", "(alpha)"],
      ["{", "{alpha}"],
      ["[", "[alpha]"],
      ["<", "<alpha>"],
      ["`", "`alpha`"],
      ["```", "```alpha```"],
      ["~", "~alpha~"],
      ["**", "**alpha**"],
      ["***", "***alpha***"],
      ["~~", "~~alpha~~"],
    ] as const
    for (const [typed, expected] of wrappingCases) {
      await page.keyboard.press(documentStart)
      await page.keyboard.press("ArrowDown")
      await selectRight(page, "alpha".length)
      await page.keyboard.type(typed)
      await expect(line).toHaveText(expected)
      if (typed === "~" || typed === "(") {
        await expect(lines).toHaveText(["above", expected, "below"])
        await expectSelectionPaintMatchesForeground(page)
      }
      await page.keyboard.press(`${commandModifier}+Z`)
      await expect(line).toHaveText("alpha")
    }

    const batchedWrappingCases = [
      ["**", "**alpha**"],
      ["***", "***alpha***"],
      ["~~", "~~alpha~~"],
      ["```", "```alpha```"],
    ] as const
    for (const [inserted, expected] of batchedWrappingCases) {
      await page.keyboard.press(documentStart)
      await page.keyboard.press("ArrowDown")
      await selectRight(page, "alpha".length)
      await page.keyboard.insertText(inserted)
      await expect(line).toHaveText(expected)
      await page.keyboard.press(`${commandModifier}+Z`)
      await expect(line).toHaveText("alpha")
    }

    const content = page.locator(".cm-content")
    await page.keyboard.press(documentStart)
    await page.keyboard.press("ArrowDown")
    await selectRight(page, "alpha".length)
    await content.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      )
    })
    await page.keyboard.insertText("**")
    await content.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true })
      )
    })
    await expect(line).toHaveText("**")
    await page.keyboard.press(`${commandModifier}+Z`)
    await expect(line).toHaveText("alpha")

    await page.keyboard.press(documentStart)
    await page.keyboard.press("ArrowDown")
    await selectRight(page, "alpha".length)
    await content.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      )
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true })
      )
    })
    await page.keyboard.insertText("~~")
    await expect(line).toHaveText("~~alpha~~")
    await page.keyboard.press(`${commandModifier}+Z`)
    await expect(line).toHaveText("alpha")

    await page.keyboard.press("End")
    await page.keyboard.insertText("**")
    await expect(line).toHaveText("alpha**")
    await page.keyboard.insertText('("')
    await expect(line).toHaveText('alpha**("')
    await page.keyboard.insertText("~")
    await expect(lines).toHaveText(["above", 'alpha**("~', "below"])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("pasting a URL over highlighted text creates a Markdown link @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("alpha")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await editor.waitFor()
    await page.locator(".cm-content").focus()
    await expect(page.locator(".cm-content")).toBeFocused()

    await page.keyboard.press(documentStart)
    await selectRight(page, "alpha".length)
    await page.locator(".cm-content").evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", "https://example.com/docs\n")
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        })
      )
    })

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-line").first()).toHaveText(
      "[alpha](https://example.com/docs)"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("pasting rendered content preserves its Markdown structure @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()

    const plain = "Imported\nText with bold and a link.\nDraft Yes"
    const immediate = await content.evaluate(
      (element, clipboard) => {
        const data = new DataTransfer()
        data.setData("text/plain", clipboard.plain)
        data.setData("text/html", clipboard.html)
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          })
        )
        const view = (
          element as HTMLElement & {
            cmTile?: { view?: { state: { doc: { toString(): string } } } }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        return view.state.doc.toString()
      },
      {
        plain,
        html: [
          "<h2>Imported</h2>",
          '<p>Text with <strong>bold</strong> and <a href="https://example.com">a link</a>.</p>',
          "<table><thead><tr><th>Draft</th><th>Done</th></tr></thead>",
          "<tbody><tr><td>One</td><td>Yes</td></tr></tbody></table>",
          "<script>not pasted</script>",
        ].join(""),
      }
    )
    expect(immediate).toBe(plain)

    const converted = [
      "## Imported",
      "",
      "Text with **bold** and [a link](https://example.com).",
      "",
      "| Draft | Done |",
      "| --- | --- |",
      "| One | Yes |",
    ].join("\n")
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe(converted)

    await page.keyboard.press(`${commandModifier}+Z`)
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe("")

    const explicitMarkdown = await content.evaluate((element) => {
      const data = new DataTransfer()
      data.setData("text/plain", "Wrong plain text")
      data.setData("text/html", "<p>Wrong HTML</p>")
      data.setData("text/markdown", "# Exact Markdown")
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
      )
      const view = (
        element as HTMLElement & {
          cmTile?: { view?: { state: { doc: { toString(): string } } } }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      return view.state.doc.toString()
    })
    expect(explicitMarkdown).toBe("# Exact Markdown")

    await content.focus()
    await page.keyboard.press(`${commandModifier}+A`)
    await page.keyboard.type("beforeafter")
    await page.keyboard.press(documentStart)
    for (let index = 0; index < "before".length; index += 1) {
      await page.keyboard.press("ArrowRight")
    }
    const inlineFallback = await content.evaluate((element) => {
      const data = new DataTransfer()
      data.setData("text/plain", "Middle")
      data.setData(
        "text/html",
        '<b style="font-weight:normal"><p><strong>Middle</strong></p></b>'
      )
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
      )
      const view = (
        element as HTMLElement & {
          cmTile?: { view?: { state: { doc: { toString(): string } } } }
        }
      ).cmTile?.view
      if (!view) throw new Error("CodeMirror view is unavailable")
      return view.state.doc.toString()
    })
    expect(inlineFallback).toBe("beforeMiddleafter")
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe("before\n\n**Middle**\n\nafter")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("the native clipboard converts rendered document content to Markdown", async () => {
  const { filePath, userData } = await createDocument("")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()

    await app.evaluate(({ BrowserWindow, clipboard }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) throw new Error("No focused window is available for paste")
      clipboard.write({
        text: "Imported\nBold normal bold and <em>literal</em>.\nMore\nBody",
        html: [
          "<h2>Imported</h2>",
          '<p><strong>Bold <span style="font-weight:normal">normal</span> bold</strong> and &lt;em&gt;literal&lt;/em&gt;.</p>',
          "<details><summary>More</summary><p>Body</p></details>",
        ].join(""),
      })
      win.webContents.paste()
    })

    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe(
        [
          "## Imported",
          "",
          "**Bold** normal **bold** and \\<em>literal\\</em>.",
          "",
          "**More**",
          "",
          "Body",
        ].join("\n")
      )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Paste and Match Style inserts the native plain clipboard representation", async () => {
  const { filePath, userData } = await createDocument("")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()

    const menuItem = await app.evaluate(
      ({ BrowserWindow, Menu, clipboard }) => {
        const win = BrowserWindow.getFocusedWindow()
        const item =
          Menu.getApplicationMenu()?.getMenuItemById("edit-paste-plain")
        if (!win || !item) {
          throw new Error("Paste and Match Style is unavailable")
        }
        clipboard.write({
          text: "# Exact **Markdown**",
          html: "<h1>Rendered <strong>HTML</strong></h1>",
        })
        return {
          accelerator: item.accelerator,
          label: item.label,
          role: item.role,
        }
      }
    )

    expect(menuItem).toEqual({
      accelerator:
        process.platform === "darwin"
          ? "Cmd+Alt+Shift+V"
          : "Shift+CommandOrControl+V",
      label:
        process.platform === "darwin"
          ? "Paste and Match Style"
          : "Paste as Plain Text",
      role: "pasteandmatchstyle",
    })
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) throw new Error("Plain paste is unavailable")
      win.webContents.pasteAndMatchStyle()
    })
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe("# Exact **Markdown**")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("slash-separated HTML tag references do not indent the next prose line @renderer-isolated", async () => {
  const source = [
    "However, your concern about completeness is justified. Broader exploratory testing today found real gaps that the green test suite didn’t cover:",
    "Literal text such as &lt;em&gt;literal&lt;/em&gt; can become raw HTML rather than remaining visibly literal.",
    "Nested bold/italic style resets can be lost.",
    "Captions, row spans, and multiple header rows can produce malformed or misaligned tables instead of degrading gracefully.",
    "<details>/<summary> content can be concatenated incorrectly.",
  ].join("\n")
  const { filePath, userData } = await createDocument(source)
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()

    for (const toggleBeforeEnter of [null, "Alt+Z", modeShortcut, "Alt+Z"]) {
      if (toggleBeforeEnter) await page.keyboard.press(toggleBeforeEnter)
      await content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                dispatch(spec: { selection: { anchor: number } }): void
                state: { doc: { length: number } }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        view.dispatch({ selection: { anchor: view.state.doc.length } })
      })
      await page.keyboard.press("Enter")
      await expect
        .poll(() => editorDocumentSelection(page))
        .toEqual({
          anchor: source.length + 1,
          doc: `${source}\n`,
          head: source.length + 1,
        })
      await page.keyboard.press(`${commandModifier}+Z`)
    }

    const rawHtml = "<details><summary>content"
    await page.keyboard.press(`${commandModifier}+A`)
    await page.keyboard.insertText(rawHtml)
    await page.keyboard.press("Enter")
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe(`${rawHtml}\n  `)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("link and image destinations accept Tab and URL paste as fields @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("alpha\nbeta")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.route("https://example.com/*.png", (route) => route.abort())
    await page.locator(".cm-editor").waitFor()
    await content.focus()
    await page.keyboard.press(toolbarShortcut)
    await expect(page.locator(".formatting-toolbar")).toBeVisible()

    await page.keyboard.press(documentStart)
    await selectRight(page, "alpha".length)
    await page.getByRole("button", { name: "Link", exact: true }).click()
    await pasteText(page, "https://example.com/alpha")

    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Home")
    await selectRight(page, "beta".length)
    await page.getByRole("button", { name: "Image", exact: true }).click()
    await pasteText(page, "https://example.com/beta.png")

    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Link", exact: true }).click()
    await page.keyboard.press("Tab")
    await pasteText(page, "https://example.com/empty-link)")

    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Image", exact: true }).click()
    await page.keyboard.press("Tab")
    await pasteText(page, "https://example.com/empty-image.png")

    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Link", exact: true }).click()
    await page.keyboard.type("typed link")
    await page.keyboard.press("Tab")
    await pasteText(page, "https://example.com/typed-link")

    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Image", exact: true }).click()
    await page.keyboard.type("typed alt")
    await page.keyboard.press("Tab")
    await pasteText(page, "https://example.com/typed-image.png")

    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-line")).toHaveText([
      "[alpha](https://example.com/alpha)",
      "![beta](https://example.com/beta.png)",
      String.raw`[text](https://example.com/empty-link\))`,
      "![alt text](https://example.com/empty-image.png)",
      "[typed link](https://example.com/typed-link)",
      "![typed alt](https://example.com/typed-image.png)",
    ])
    await page.unrouteAll({ behavior: "ignoreErrors" })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("strikethrough styling excludes its source delimiters @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("~~gone~~")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page.locator(".cm-content")).toBeFocused()
    const line = page.locator(".cm-line").first()
    const decorationState = () =>
      line.evaluate((element) => {
        const states: Record<string, boolean[]> = { gone: [], "~~": [] }
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? ""
          if (!(text in states)) continue
          let struck = false
          for (
            let parent = node.parentElement;
            parent && parent !== element;
            parent = parent.parentElement
          ) {
            if (
              getComputedStyle(parent).textDecorationLine.includes(
                "line-through"
              )
            ) {
              struck = true
              break
            }
          }
          states[text]!.push(struck)
        }
        return states
      })

    await page.keyboard.press("Escape")
    await expect
      .poll(decorationState)
      .toEqual({ gone: [true], "~~": [false, false] })
    await page.keyboard.press(modeShortcut)
    await expect
      .poll(decorationState)
      .toEqual({ gone: [true], "~~": [false, false] })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("repeated Enter exits every nested list level and starts a plain line @renderer-isolated", async () => {
  const nestedList = [
    "- one",
    "  - two",
    "    - three",
    "      - four",
    "        - five",
    "          - six",
  ].join("\n")
  const { filePath, userData } = await createDocument(nestedList)
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()
    await page.keyboard.press(documentEnd)

    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press("Enter")
    }

    await page.keyboard.press(modeShortcut)
    const lines = await page.locator(".cm-line").allTextContents()
    expect(lines.slice(-3)).toEqual(["          - six", "", ""])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Enter twice and Shift+Enter escape split list content cleanly @renderer-isolated", async () => {
  const source = [
    "List:",
    "- item 1",
    "- item 2",
    "- item 3 additional content",
  ].join("\n")
  const { filePath, userData } = await createDocument(source)
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    const setSplitCaret = () =>
      content.evaluate((element) => {
        const view = (
          element as HTMLElement & {
            cmTile?: {
              view?: {
                dispatch(spec: { selection: { anchor: number } }): void
                focus(): void
                state: { doc: { toString(): string } }
              }
            }
          }
        ).cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const position = view.state.doc.toString().indexOf("additional content")
        view.dispatch({ selection: { anchor: position } })
        view.focus()
      })

    await setSplitCaret()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    expect((await editorDocumentSelection(page)).doc).toBe(
      ["List:", "- item 1", "- item 2", "- item 3", "additional content"].join(
        "\n"
      )
    )

    await page.keyboard.press(`${commandModifier}+Z`)
    await page.keyboard.press(`${commandModifier}+Z`)
    await setSplitCaret()
    await page.keyboard.press("Shift+Enter")
    const shifted = await editorDocumentSelection(page)
    expect(shifted.doc).toBe(
      ["List:", "- item 1", "- item 2", "- item 3", "additional content"].join(
        "\n"
      )
    )
    expect(shifted.head).toBe(shifted.doc.indexOf("additional content"))
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a list started after exiting another list continues without inherited blank spacing @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("- existing")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()
    await page.keyboard.press(documentEnd)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")

    await page.keyboard.press(toolbarShortcut)
    await page
      .getByRole("button", { name: "Bulleted list", exact: true })
      .click()
    await page.keyboard.type("new")
    await page.keyboard.press("Enter")
    await page.keyboard.type("next")

    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-line")).toHaveText([
      "- existing",
      "",
      "- new",
      "- next",
    ])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Enter continues a checklist at the level created by Tab @renderer-isolated", async () => {
  const source = "- [ ] Parent\n- [x] Child"
  const { filePath, userData } = await createDocument(source)
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await editor.waitFor()

    await page.locator(".cm-line").filter({ hasText: "Child" }).click()
    await page.keyboard.press("End")
    await page.keyboard.press("Tab")
    await page.keyboard.press("Enter")
    await page.keyboard.press(modeShortcut)

    await expect(page.locator(".cm-line")).toHaveText([
      "- [ ] Parent",
      "  - [x] Child",
      "  - [ ] ",
    ])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("replacing an inserted ordered item with bullets preserves order and depth @renderer-isolated", async () => {
  const source = [
    "1.  First step",
    "2.  Second step",
    "    1.  Sub-step 2a",
    "    2.  Sub-step 2b",
    "3.  Third step",
  ].join("\n")
  const { filePath, userData } = await createDocument(source)
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await editor.waitFor()

    await page.locator(".cm-line").filter({ hasText: "Sub-step 2a" }).click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Backspace")
    await page.keyboard.type("- first bullet")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")
    await page.keyboard.type("second bullet")
    await page.keyboard.press("Escape")

    const textStart = (label: string) =>
      page
        .locator(".cm-md-list-marker-line")
        .filter({ hasText: label })
        .evaluate((line) => {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
          let node = walker.nextNode()
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
              return range.getBoundingClientRect().left
            }
            node = walker.nextNode()
          }
          throw new Error(`Text start is unavailable for ${label}`)
        })

    const [subStepStart, bulletStart, nestedBulletStart, nextSubStepStart] =
      await Promise.all([
        textStart("Sub-step 2a"),
        textStart("first bullet"),
        textStart("second bullet"),
        textStart("Sub-step 2b"),
      ])
    const firstDepthStep = bulletStart - subStepStart
    const secondDepthStep = nestedBulletStart - bulletStart
    expect(firstDepthStep).toBeGreaterThan(20)
    expect(Math.abs(firstDepthStep - secondDepthStep)).toBeLessThan(1)
    expect(Math.abs(nextSubStepStart - subStepStart)).toBeLessThan(1)
    await expect
      .poll(() =>
        page
          .locator(".cm-md-list-marker-unordered")
          .evaluateAll((markers) =>
            markers.map((marker) => marker.getAttribute("data-list-marker"))
          )
      )
      .toEqual(["•", "◦"])

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-line")).toHaveText([
      "1.  First step",
      "2.  Second step",
      "    1.  Sub-step 2a",
      "        - first bullet",
      "          - second bullet",
      "    2.  Sub-step 2b",
      "3.  Third step",
    ])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("block-prefix toolbar actions put the caret after their marker and remove empty quote rails @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("")
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await page.locator(".cm-editor").waitFor()
    await content.focus()
    await page.keyboard.press(toolbarShortcut)
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()

    for (const { button, marker, text } of [
      { button: "Bulleted list", marker: "- ", text: "bullet" },
      { button: "Numbered list", marker: "1. ", text: "ordered" },
      { button: "Task list", marker: "- [ ] ", text: "task" },
      { button: "Blockquote", marker: "> ", text: "quote" },
    ]) {
      await page.getByRole("button", { name: button, exact: true }).click()
      await expect(content).toBeFocused()
      await expect
        .poll(() => editorDocumentSelection(page))
        .toEqual({
          anchor: marker.length,
          doc: marker,
          head: marker.length,
        })

      await page.keyboard.type(text)
      await expect
        .poll(() => editorDocumentSelection(page))
        .toEqual({
          anchor: marker.length + text.length,
          doc: marker + text,
          head: marker.length + text.length,
        })

      await page.keyboard.press(`${commandModifier}+A`)
      await page.keyboard.press("Backspace")
      await expect
        .poll(() => editorDocumentSelection(page))
        .toEqual({
          anchor: 0,
          doc: "",
          head: 0,
        })
      await expect(page.locator("blockquote.cm-md-quote-block")).toHaveCount(0)
    }

    const quote = page.getByRole("button", {
      name: "Blockquote",
      exact: true,
    })
    await quote.click()
    await expect(page.locator("blockquote.cm-md-quote-block")).toHaveCount(1)
    await quote.click()
    await expect
      .poll(() => editorDocumentSelection(page))
      .toEqual({
        anchor: 0,
        doc: "",
        head: 0,
      })
    await expect(page.locator("blockquote.cm-md-quote-block")).toHaveCount(0)

    await quote.click()
    await expect(page.locator("blockquote.cm-md-quote-block")).toHaveCount(1)
    await page.keyboard.press(`${commandModifier}+A`)
    await page.keyboard.press("Backspace")
    await expect(page.locator("blockquote.cm-md-quote-block")).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("the formatting toolbar applies common actions and its visibility persists @renderer-isolated", async () => {
  const { filePath, userData } = await createDocument("alpha")
  let app: ElectronApplication | null = await launchApplication(
    userData,
    filePath
  )

  try {
    let page = await app.firstWindow()
    let toolbar = page.getByRole("toolbar", { name: "Formatting toolbar" })
    let toolbarSurface = page.locator(".formatting-toolbar")
    const content = page.locator(".cm-content")
    await expect(toolbar).toHaveCount(0)
    await expect(toolbarSurface).toHaveCount(0)
    await content.focus()

    await page.keyboard.press(toolbarShortcut)
    await expect(toolbar).toBeVisible()
    await expect(toolbarSurface).toHaveCSS("opacity", "1")
    await expect(toolbarSurface).toHaveCSS(
      "transition-property",
      "opacity, transform"
    )
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.showFormattingBar
      )
      .toBe(true)
    await content.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined))
      )
    })

    const [toolbarBox, firstLineBox] = await Promise.all([
      toolbar.boundingBox(),
      page.locator(".cm-line").first().boundingBox(),
    ])
    expect(toolbarBox).not.toBeNull()
    expect(firstLineBox).not.toBeNull()
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(
      firstLineBox!.y
    )

    await page.mouse.move(120, 20)
    const formattingToolbarToggle = page.getByRole("button", {
      name: "Formatting toolbar",
      exact: true,
    })
    await expect(formattingToolbarToggle).toBeVisible()
    await expect(formattingToolbarToggle).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await toolbarSurface.evaluate((element) => {
      element.addEventListener("transitionrun", (event) => {
        if (
          event instanceof TransitionEvent &&
          event.propertyName === "opacity"
        ) {
          document.documentElement.dataset.toolbarExitStarted = "true"
        }
      })
      element.addEventListener("transitionend", (event) => {
        if (
          event instanceof TransitionEvent &&
          event.propertyName === "opacity"
        ) {
          document.documentElement.dataset.toolbarExitFinished = "true"
        }
      })
    })
    await formattingToolbarToggle.click()
    await expect(toolbar).toHaveCount(0)
    await expect(page.locator("html")).toHaveAttribute(
      "data-toolbar-exit-started",
      "true"
    )
    await expect(page.locator("html")).toHaveAttribute(
      "data-toolbar-exit-finished",
      "true"
    )
    await expect(toolbarSurface).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.showFormattingBar
      )
      .toBe(false)
    await formattingToolbarToggle.click()
    await expect(toolbar).toBeVisible()
    await expect(toolbarSurface).toHaveCSS(
      "transform",
      "matrix(1, 0, 0, 1, 0, 0)"
    )
    await expect(formattingToolbarToggle).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.showFormattingBar
      )
      .toBe(true)

    const headingStyle = page.getByRole("button", { name: "Heading style" })
    const appRegions = await Promise.all([
      toolbarSurface.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region")
      ),
      headingStyle.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region")
      ),
    ])
    expect(appRegions).toEqual(["drag", "no-drag"])
    const toolbarItems = toolbar.locator("button[data-toolbar-item]")
    await expect(toolbarItems).toHaveCount(14)
    await expect(
      toolbar.locator('button[data-toolbar-item][tabindex="0"]')
    ).toHaveCount(1)
    await expect(headingStyle).toHaveAttribute("tabindex", "0")

    await headingStyle.focus()
    await page.keyboard.press("ArrowRight")
    await expect(page.getByRole("button", { name: "Bold" })).toBeFocused()
    await expect(
      toolbar.locator('button[data-toolbar-item][tabindex="0"]')
    ).toHaveCount(1)
    await page.keyboard.press("End")
    await expect(
      page.getByRole("button", { name: "Insert table" })
    ).toBeFocused()
    await page.keyboard.press("ArrowRight")
    await expect(headingStyle).toBeFocused()
    await page.keyboard.press("Home")
    await expect(headingStyle).toBeFocused()

    expect(
      Number.parseFloat(
        await toolbarSurface.evaluate(
          (element) => getComputedStyle(element).height
        )
      )
    ).toBeCloseTo(36, 1)
    expect(
      Number.parseFloat(
        await headingStyle
          .locator("svg")
          .evaluate((element) => getComputedStyle(element).width)
      )
    ).toBeCloseTo(17.6, 1)

    const toolbarSpacing = await page.evaluate(() => {
      const tab = document.querySelector<HTMLElement>(".document-tab")
      const toolbar = document.querySelector<HTMLElement>(".formatting-toolbar")
      const icon = toolbar?.querySelector<SVGElement>("svg")
      if (!tab || !toolbar || !icon) {
        throw new Error("Formatting toolbar spacing targets are unavailable")
      }

      const tabRect = tab.getBoundingClientRect()
      const toolbarRect = toolbar.getBoundingClientRect()
      const iconRect = icon.getBoundingClientRect()
      return {
        belowIcons: toolbarRect.bottom - 1 - iconRect.bottom,
        aboveIcons: iconRect.top - tabRect.bottom,
      }
    })
    expect(toolbarSpacing.aboveIcons).toBeGreaterThan(0)
    expect(
      Math.abs(toolbarSpacing.aboveIcons - toolbarSpacing.belowIcons)
    ).toBeLessThanOrEqual(1.1)
    await headingStyle.hover()
    await expect(
      page.locator('[data-slot="tooltip-content"][data-open]')
    ).toHaveText("Heading style")
    await expect
      .poll(() =>
        headingStyle.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        )
      )
      .toBe("rgba(0, 0, 0, 0)")
    await headingStyle.click()
    await expect(
      page.locator('[data-slot="dropdown-menu-positioner"]')
    ).toHaveCSS("-webkit-app-region", "no-drag")
    await page.getByRole("menuitem", { name: "Heading 2" }).click()
    await expect(page.locator(".cm-line").first()).toHaveClass(
      /cm-md-heading-2/
    )
    await headingStyle.click()
    await page.getByRole("menuitem", { name: "Paragraph" }).click()
    await expect(page.locator(".cm-line").first()).not.toHaveClass(
      /cm-md-heading/
    )

    const insertTable = page.getByRole("button", { name: "Insert table" })
    await insertTable.hover()
    await expect(
      page.locator('[data-slot="tooltip-content"][data-open]')
    ).toHaveText("Insert table")

    await page.keyboard.press(toolbarShortcut)
    await expect(toolbar).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.showFormattingBar
      )
      .toBe(false)

    await page.keyboard.press(toolbarShortcut)
    await expect(toolbar).toBeVisible()
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.showFormattingBar
      )
      .toBe(true)

    await content.focus()
    await page.keyboard.press(documentStart)
    await selectRight(page, "alpha".length)
    await page.getByRole("button", { name: "Bold" }).click()
    await expect(content).toBeFocused()
    await page.getByRole("button", { name: "Bulleted list" }).click()
    await expect(content).toBeFocused()

    await page.keyboard.press(documentEnd)
    await page.getByRole("button", { name: "Insert table" }).click()
    await expect(insertTable).toHaveAttribute("aria-expanded", "true")
    await expect
      .poll(() =>
        insertTable.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        )
      )
      .toBe("rgba(0, 0, 0, 0)")
    const tableGrid = page.getByRole("grid", { name: "Table size" })
    await expect(tableGrid.getByRole("row")).toHaveCount(6)
    await expect(tableGrid.getByRole("gridcell")).toHaveCount(36)
    const initialTableSize = tableGrid.getByRole("gridcell", {
      name: "2 columns by 2 rows",
    })
    await expect(initialTableSize).toBeFocused()
    await expect(initialTableSize).toHaveAttribute("tabindex", "0")
    await expect(
      tableGrid.locator('[role="gridcell"][tabindex="0"]')
    ).toHaveCount(1)
    const tablePopover = page.locator('[data-slot="popover-content"]')
    const tablePickerCenters = await Promise.all([
      tableGrid.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left + bounds.width / 2
      }),
      tablePopover.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left + bounds.width / 2
      }),
    ])
    expect(
      Math.abs(tablePickerCenters[0] - tablePickerCenters[1])
    ).toBeLessThan(1)
    await page.keyboard.press("ArrowRight")
    const keyboardTableSize = tableGrid.getByRole("gridcell", {
      name: "3 columns by 2 rows",
    })
    await expect(keyboardTableSize).toBeFocused()
    await expect(keyboardTableSize).toHaveAttribute("tabindex", "0")
    await expect(initialTableSize).toHaveAttribute("tabindex", "-1")
    await page.keyboard.press("Enter")
    await expect(content).toBeFocused()

    await page.keyboard.press(documentEnd)
    await page.getByRole("button", { name: "Insert table" }).click()
    const customColumns = page.getByLabel("Columns", { exact: true })
    await expect(customColumns).toHaveAttribute("placeholder", "Cols")
    await customColumns.fill("2")
    const customRows = page.getByLabel("Rows", { exact: true })
    await customRows.fill("3")
    await customRows.press("Enter")
    await expect(content).toBeFocused()

    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    expect(await page.locator(".cm-line").allTextContents()).toEqual([
      "- **alpha**",
      "| Header 1 | Header 2 | Header 3 |",
      "| --- | --- | --- |",
      "|  |  |  |",
      "| Header 1 | Header 2 |",
      "| --- | --- |",
      "|  |  |",
      "|  |  |",
    ])

    await page.keyboard.press(settingsShortcut)
    await page.getByRole("button", { name: "Customize typography" }).click()
    const baseFontSize = page.getByLabel("Base font size in pixels")
    await baseFontSize.fill("19")
    await expect(
      page.locator("style[data-theme-transition-guard]")
    ).toHaveCount(0)
    await page.keyboard.press(toolbarShortcut)
    await expect(baseFontSize).toHaveValue("19")
    // The preview owns the full document canvas, so document chrome stays
    // hidden and its application shortcut is ignored until preview exit.
    await expect(page.locator(".formatting-toolbar")).toHaveCount(0)

    const typographyWorkspace = page.getByRole("region", {
      name: "Typography preview workspace",
    })
    await typographyWorkspace.getByRole("button", { name: "Save" }).click()
    await expect(typographyWorkspace).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()

    await page.getByRole("button", { name: "Window Chrome" }).click()
    const formattingBarSetting = page.getByRole("switch", {
      name: "Show formatting toolbar",
    })
    await expect(formattingBarSetting).toBeChecked()
    const formattingBarPosition = settingsSelect(
      page,
      "Formatting toolbar position"
    )
    await formattingBarPosition.click()
    const selectPopup = page.locator('[data-slot="select-content"]:visible')
    await expect(selectPopup).toBeVisible()
    await expect(page.locator('[data-slot="select-positioner"]')).toHaveCSS(
      "-webkit-app-region",
      "no-drag"
    )
    await selectPopup.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map(async (animation) => {
          try {
            await animation.finished
          } catch {
            // A closing animation is irrelevant to this settled geometry check.
          }
        })
      )
    })
    const [triggerGeometry, popupGeometry] = await Promise.all([
      formattingBarPosition.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, width: rect.width }
      }),
      selectPopup.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, width: rect.width }
      }),
    ])
    expect(popupGeometry.width).toBeCloseTo(triggerGeometry.width, 0)
    expect(popupGeometry.left).toBeCloseTo(triggerGeometry.left, 0)
    const edgeInsets = await selectPopup.evaluate((popup) => {
      const options = popup.querySelectorAll<HTMLElement>(
        '[data-slot="select-item"]'
      )
      const popupRect = popup.getBoundingClientRect()
      const firstRect = options[0]?.getBoundingClientRect()
      const lastRect = options[options.length - 1]?.getBoundingClientRect()
      if (!firstRect || !lastRect) {
        throw new Error("Select edge options are unavailable")
      }
      return {
        bottom: popupRect.bottom - lastRect.bottom,
        top: firstRect.top - popupRect.top,
      }
    })
    expect(edgeInsets.top).toBeGreaterThanOrEqual(5)
    expect(edgeInsets.bottom).toBeGreaterThanOrEqual(5)
    await selectPopup
      .getByRole("option", { name: "Right", exact: true })
      .click()
    await expect(
      page.locator('.formatting-toolbar [role="toolbar"]')
    ).toHaveAttribute("data-position", "right")
    await formattingBarSetting.click()
    await expect(formattingBarSetting).not.toBeChecked()
    await expect(toolbar).toHaveCount(0)
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    await expect(toolbar).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.showFormattingBar
      )
      .toBe(false)
    await expect
      .poll(async () => (await persistedSettings(userData))?.baseFontSize)
      .toBe(19)
    await expect
      .poll(
        async () =>
          (await persistedSettings(userData))?.chrome.formattingBarPosition
      )
      .toBe("right")

    await exitApplication(app)
    app = null
    app = await launchApplication(userData, filePath)
    page = await app.firstWindow()
    toolbar = page.getByRole("toolbar", { name: "Formatting toolbar" })
    toolbarSurface = page.locator(".formatting-toolbar")
    await page.locator(".cm-editor").waitFor()
    await expect(toolbar).toHaveCount(0)
    await expect(toolbarSurface).toHaveCount(0)

    await page.keyboard.press(settingsShortcut)
    await page.getByRole("button", { name: "Window Chrome" }).click()
    await expect(
      page.getByRole("switch", { name: "Show formatting toolbar" })
    ).not.toBeChecked()
    await expect(
      settingsSelect(page, "Formatting toolbar position")
    ).toHaveText("Right")
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("live list Tab commands indent items while source Tab follows settings @renderer-isolated", async () => {
  const source = ["- Parent", "- Child", "  continuation", "", "plain"].join(
    "\n"
  )
  const { filePath, userData } = await createDocument(source)
  const app = await launchApplication(userData, filePath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    const content = page.locator(".cm-content")
    await editor.waitFor()
    await expect(editor).toHaveClass(/cm-md-live/)

    await page.locator(".cm-line").filter({ hasText: "continuation" }).click()
    await page.keyboard.press("End")
    await page.keyboard.press("Tab")

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-line").nth(1)).toHaveText("  - Child")
    await expect(page.locator(".cm-line").nth(2)).toHaveText("    continuation")

    await page.keyboard.press(modeShortcut)
    await expect(editor).toHaveClass(/cm-md-live/)
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-line").nth(1)).toHaveText("- Child")
    await expect(page.locator(".cm-line").nth(2)).toHaveText("  continuation")

    await page.keyboard.press(modeShortcut)
    await page.locator(".cm-line").filter({ hasText: "Parent" }).click()
    await page.keyboard.press("Tab")
    await page.keyboard.press(modeShortcut)
    await expect(page.locator(".cm-line").first()).toHaveText("- Parent")

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    const rawTabSelect = settingsSelect(page, "Raw Markdown Tab key")
    const rawTabAlignment = await rawTabSelect.evaluate((element) => {
      const content = element.closest('[data-slot="field-content"]')
      if (!content) throw new Error("Raw Markdown field content is unavailable")
      return {
        contentLeft: content.getBoundingClientRect().left,
        selectLeft: element.getBoundingClientRect().left,
      }
    })
    expect(rawTabAlignment.selectLeft).toBeCloseTo(
      rawTabAlignment.contentLeft,
      0
    )
    await page.getByLabel("Spaces per Tab").fill("4")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    await expect(content).toBeFocused()

    await page.keyboard.press(documentEnd)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")
    await page.keyboard.type("spaces")
    const spaceIndentedSource = `${source}\n    spaces`
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe(spaceIndentedSource)

    await page.keyboard.press(settingsShortcut)
    await openSettingsSection(page, "Miscellaneous")
    await chooseSelectOption(page, rawTabSelect, "Tab Character")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    await expect(content).toBeFocused()
    await page.keyboard.press(documentEnd)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Tab")
    await page.keyboard.type("tab")
    await expect
      .poll(async () => (await editorDocumentSelection(page)).doc)
      .toBe(`${spaceIndentedSource}\n\ttab`)

    await expect
      .poll(async () => persistedSettings(userData))
      .toMatchObject({
        sourceIndentation: "tabs",
        sourceIndentSize: 4,
      })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
