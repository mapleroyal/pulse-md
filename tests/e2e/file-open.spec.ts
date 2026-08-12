import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

async function createTestDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "pulse-md-file-open-"))
}

async function launchApplication(userData: string, ...filePaths: string[]) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, ...filePaths],
    cwd: projectRoot,
  })
}

async function seedRecentDocuments(
  userData: string,
  filePaths: readonly string[]
): Promise<void> {
  await mkdir(userData, { recursive: true })
  await writeFile(
    path.join(userData, "recent-documents.json"),
    `${JSON.stringify({ paths: filePaths, version: 1 }, null, 2)}\n`
  )
}

async function holdNextCliTabsOpenRequest(
  application: ElectronApplication
): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getFocusedWindow()
    if (!target) throw new Error("The target window is unavailable")
    const testGlobal = globalThis as typeof globalThis & {
      heldCliTabsOpenRequest?: boolean
      releaseHeldCliTabsOpenRequest?: () => void
      restoreHeldCliTabsOpenRequest?: () => void
    }
    const originalSend = target.webContents.send
    let captured = false
    testGlobal.heldCliTabsOpenRequest = false
    testGlobal.restoreHeldCliTabsOpenRequest = () => {
      if (!target.isDestroyed()) target.webContents.send = originalSend
      testGlobal.restoreHeldCliTabsOpenRequest = undefined
    }
    target.webContents.send = ((channel: string, ...args: unknown[]): void => {
      if (!captured && channel === "pulse-md:cli-tabs-open-requested") {
        captured = true
        testGlobal.heldCliTabsOpenRequest = true
        testGlobal.releaseHeldCliTabsOpenRequest = () => {
          testGlobal.releaseHeldCliTabsOpenRequest = undefined
          testGlobal.restoreHeldCliTabsOpenRequest?.()
          if (!target.isDestroyed()) {
            originalSend.call(target.webContents, channel, ...args)
          }
        }
        return
      }
      originalSend.call(target.webContents, channel, ...args)
    }) as typeof target.webContents.send
  })
}

async function releaseHeldCliTabsOpenRequest(
  application: ElectronApplication
): Promise<void> {
  await application.evaluate(() => {
    const testGlobal = globalThis as typeof globalThis & {
      releaseHeldCliTabsOpenRequest?: () => void
      restoreHeldCliTabsOpenRequest?: () => void
    }
    if (testGlobal.releaseHeldCliTabsOpenRequest) {
      testGlobal.releaseHeldCliTabsOpenRequest()
    } else {
      testGlobal.restoreHeldCliTabsOpenRequest?.()
    }
  })
}

test("Open preserves a multi-selection's order and records each document", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const firstPath = path.join(testDirectory, "first.md")
  const secondPath = path.join(testDirectory, "second.txt")
  const thirdPath = path.join(testDirectory, "third.markdown")
  const filePaths = [firstPath, secondPath, thirdPath]
  await Promise.all([
    writeFile(firstPath, "First document\n"),
    writeFile(secondPath, `Second document\n${"x".repeat(8 * 1024 * 1024)}`),
    writeFile(thirdPath, "Third document\n"),
  ])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }, selectedPaths) => {
      const testGlobal = globalThis as typeof globalThis & {
        fileOpenRecentDocuments?: string[]
      }
      testGlobal.fileOpenRecentDocuments = []
      app.addRecentDocument = (filePath) => {
        testGlobal.fileOpenRecentDocuments?.push(filePath)
      }
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: selectedPaths,
      })) as typeof dialog.showOpenDialog
    }, filePaths)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+O" : "Control+O"
    )
    const tabs = page.locator(".document-tab [role=tab]")
    await expect(tabs).toHaveCount(3)
    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
      )
      .toEqual(filePaths)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", firstPath)
    await expect(page.locator(".cm-content")).toContainText("First document")
    await expect(page.locator(".cm-content")).toBeFocused()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            fileOpenRecentDocuments?: string[]
          }
          return testGlobal.fileOpenRecentDocuments
        })
      )
      .toEqual(filePaths)

    // The oversized inactive selection must still be a hydration recipe, not
    // a retained eager read. Activation therefore observes the current bytes.
    await writeFile(secondPath, "Second document after deferred open\n")

    await page.keyboard.press("Escape")
    await expect(page.locator(".cm-editor")).not.toHaveClass(
      /cm-md-caret-hidden/
    )
    await expect(page.locator(".cm-cursor").first()).toBeVisible()

    await tabs.nth(1).click()
    await expect(page.locator(".cm-content")).toContainText(
      "Second document after deferred open"
    )
    await expect(page.locator(".cm-content")).toBeFocused()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-caret-hidden/)
    await expect(page.locator(".cm-cursor").first()).not.toBeVisible()
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            fileOpenRecentDocuments?: string[]
          }
          return testGlobal.fileOpenRecentDocuments
        })
      )
      .toEqual(filePaths)

    await tabs.nth(2).click()
    await expect(page.locator(".cm-content")).toContainText("Third document")
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            fileOpenRecentDocuments?: string[]
          }
          return testGlobal.fileOpenRecentDocuments
        })
      )
      .toEqual(filePaths)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open leases the editor read-only until its async load settles", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const openedPath = path.join(testDirectory, "leased-open.md")
  await writeFile(openedPath, "Leased open document\n")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }, selectedPath) => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseLeasedOpen?: () => void
      }
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      dialog.showOpenDialog = (() =>
        new Promise((resolve) => {
          testGlobal.releaseLeasedOpen = () => {
            testGlobal.releaseLeasedOpen = undefined
            resolve({ canceled: false, filePaths: [selectedPath] })
          }
        })) as typeof dialog.showOpenDialog
    }, openedPath)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+O" : "Control+O"
    )
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (
              globalThis as typeof globalThis & {
                releaseLeasedOpen?: () => void
              }
            ).releaseLeasedOpen
        )
      )
      .toBe("function")

    const content = page.locator(".cm-content")
    await expect(content).toHaveAttribute("contenteditable", "false")
    await content.click({ force: true })
    await page.keyboard.insertText("This edit must not race the open.")
    await expect(content).not.toContainText("This edit must not race the open.")
    await expect(
      page.locator(".document-tab[data-active] .tab-dirty-dot")
    ).not.toBeVisible()

    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          releaseLeasedOpen?: () => void
        }
      ).releaseLeasedOpen?.()
    })
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", openedPath)
    await expect(content).toContainText("Leased open document")
    await expect(content).toHaveAttribute("contenteditable", "true")
  } finally {
    await app
      .evaluate(() => {
        ;(
          globalThis as typeof globalThis & {
            releaseLeasedOpen?: () => void
          }
        ).releaseLeasedOpen?.()
      })
      .catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open replaces its original disposable tab after an active-tab switch", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const existingPath = path.join(testDirectory, "existing.md")
  const openedPath = path.join(testDirectory, "opened-after-switch.md")
  await Promise.all([
    writeFile(existingPath, "Existing document\n"),
    writeFile(openedPath, "Opened after switch\n"),
  ])
  const app = await launchApplication(userData, existingPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(page.locator(".document-tab")).toHaveCount(2)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", "Untitled")

    await app.evaluate(({ app, dialog, ipcMain }, selectedPath) => {
      const testGlobal = globalThis as typeof globalThis & {
        activeTabSwitchedDuringOpen?: boolean
        releaseSwitchedOpen?: () => void
      }
      testGlobal.activeTabSwitchedDuringOpen = false
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      ipcMain.once("pulse-md:set-active-tab", () => {
        testGlobal.activeTabSwitchedDuringOpen = true
      })
      dialog.showOpenDialog = (() =>
        new Promise((resolve) => {
          testGlobal.releaseSwitchedOpen = () => {
            testGlobal.releaseSwitchedOpen = undefined
            resolve({ canceled: false, filePaths: [selectedPath] })
          }
        })) as typeof dialog.showOpenDialog
    }, openedPath)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+O" : "Control+O"
    )
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (
              globalThis as typeof globalThis & {
                releaseSwitchedOpen?: () => void
              }
            ).releaseSwitchedOpen
        )
      )
      .toBe("function")

    await page.getByRole("tab", { name: existingPath }).click()
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", existingPath)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                activeTabSwitchedDuringOpen?: boolean
              }
            ).activeTabSwitchedDuringOpen ?? false
        )
      )
      .toBe(true)

    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          releaseSwitchedOpen?: () => void
        }
      ).releaseSwitchedOpen?.()
    })

    const tabs = page.locator(".document-tab [role=tab]")
    await expect(tabs).toHaveCount(2)
    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
      )
      .toEqual([existingPath, openedPath])
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", openedPath)
    await expect(page.locator(".cm-content")).toContainText(
      "Opened after switch"
    )
  } finally {
    await app
      .evaluate(() => {
        ;(
          globalThis as typeof globalThis & {
            releaseSwitchedOpen?: () => void
          }
        ).releaseSwitchedOpen?.()
      })
      .catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("plain text and code stay source-only while Markdown controls remain contextual", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const markdownPath = path.join(testDirectory, "rendered.md")
  const jsonPath = path.join(testDirectory, "data.json")
  await Promise.all([
    writeFile(markdownPath, "# Rendered heading\n"),
    writeFile(jsonPath, '{"answer": 42, "enabled": true}\n'),
  ])
  const app = await launchApplication(userData, markdownPath, jsonPath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Rendered"
    )

    await content.click()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "view-formatting-bar"
      )
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Formatting Toolbar is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()

    await page.getByRole("tab", { name: jsonPath, exact: true }).click()
    await expect(content).toContainText('"answer": 42')
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Plain Text"
    )
    await expect
      .poll(() => page.locator(".cm-line span").count())
      .toBeGreaterThan(0)
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Formatting toolbar", exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Document outline" })
    ).toHaveCount(0)
    const topChrome = page.locator(".top-chrome")
    await expect(topChrome).not.toHaveAttribute(
      "data-markdown-controls",
      "true"
    )
    await expect(page.locator(".top-chrome")).not.toHaveAttribute(
      "data-formatting-bar",
      "true"
    )
    await expect(page.locator(".app-shell")).not.toHaveAttribute(
      "data-formatting-bar",
      "true"
    )
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => {
          const menu = Menu.getApplicationMenu()
          return {
            format: menu?.getMenuItemById("format-menu")?.enabled ?? null,
            formatting:
              menu?.getMenuItemById("view-formatting-bar")?.enabled ?? null,
            mode: menu?.getMenuItemById("view-mode")?.enabled ?? null,
            outline: menu?.getMenuItemById("view-outline")?.enabled ?? null,
          }
        })
      )
      .toEqual({
        format: false,
        formatting: false,
        mode: false,
        outline: false,
      })
    const compactControlGap = await page.evaluate(() => {
      const find = document.querySelector(".top-chrome-find")
      const settings = document.querySelector(".top-chrome-settings")
      const separator = document.querySelector(
        ".top-chrome-navigation-separator"
      )
      if (!find || !settings) {
        throw new Error("Top-chrome controls are unavailable")
      }
      if (separator) throw new Error("Inactive navigation should be hidden")
      const findBounds = find.getBoundingClientRect()
      const settingsBounds = settings.getBoundingClientRect()
      return settingsBounds.left - findBounds.right
    })
    expect(compactControlGap).toBe(4)

    await content.click({ button: "right" })
    const contextMenu = page.getByRole("menu", {
      name: "Editor context menu",
    })
    await expect(contextMenu).toBeVisible()
    await expect(
      contextMenu.getByRole("menuitem", { name: "Formatting", exact: true })
    ).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Save As activates deferred Markdown UI and rendering after a plain launch", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const sourcePath = path.join(testDirectory, "source.txt")
  const destinationPath = path.join(testDirectory, "converted.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.chrome.showFormattingBar = true
  settings.markdownExtensions.latex = true
  await mkdir(userData, { recursive: true })
  await Promise.all([
    writeFile(sourcePath, "Math: $x + y$.\n"),
    writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify(settings, null, 2)
    ),
  ])
  const app = await launchApplication(userData, sourcePath)

  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Plain Text"
    )
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toHaveCount(0)
    await expect(page.locator(".cm-md-math-inline")).toHaveCount(0)

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as typeof dialog.showSaveDialog
    }, destinationPath)
    await content.click()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+S" : "Control+Shift+S"
    )

    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", destinationPath)
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Raw Markdown"
    )
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()
    await content.click()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Rendered"
    )
    await expect(page.locator(".cm-md-math-inline")).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Finder-style file drops open unfamiliar UTF-8 documents in source order", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const existingPath = path.join(testDirectory, "existing.md")
  const firstPath = path.join(testDirectory, "dropped-first.md")
  const rstPath = path.join(testDirectory, "dropped-notes.rst")
  const graphqlPath = path.join(testDirectory, "dropped-schema.graphql")
  const secondPath = path.join(testDirectory, "dropped-second.txt")
  await Promise.all([
    writeFile(existingPath, "Existing document\n"),
    writeFile(firstPath, "Dropped first\n"),
    writeFile(rstPath, "Dropped reStructuredText\n"),
    writeFile(graphqlPath, "type Query { status: String! }\n"),
    writeFile(secondPath, "Dropped second\n"),
  ])
  const app = await launchApplication(userData, existingPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() => {
      const input = document.createElement("input")
      input.id = "finder-drop-files"
      input.type = "file"
      input.multiple = true
      input.hidden = true
      document.body.append(input)
    })
    const input = page.locator("#finder-drop-files")
    await input.setInputFiles([firstPath, rstPath, graphqlPath, secondPath])
    await page.evaluate(() => {
      const input =
        document.querySelector<HTMLInputElement>("#finder-drop-files")
      const target = document.querySelector<HTMLElement>(".editor-mount")
      if (!input?.files || !target) {
        throw new Error("The Finder drop fixture is unavailable")
      }
      const transfer = new DataTransfer()
      for (const file of input.files) transfer.items.add(file)
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        })
      )
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        })
      )
    })

    const tabs = page.locator(".document-tab [role=tab]")
    await expect(tabs).toHaveCount(5)
    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
      )
      .toEqual([existingPath, firstPath, rstPath, graphqlPath, secondPath])
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", firstPath)
    await expect(page.locator(".cm-content")).toContainText("Dropped first")

    await tabs.nth(2).click()
    await expect(page.locator(".cm-content")).toContainText(
      "Dropped reStructuredText"
    )
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Plain Text"
    )
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("the File menu exposes explicit recent-document actions", async () => {
  const testDirectory = await createTestDirectory()
  const app = await launchApplication(path.join(testDirectory, "user-data"))

  try {
    await app.firstWindow()
    const menu = await app.evaluate(({ Menu }) => {
      const openRecent = Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "File")
        ?.submenu?.items.find((item) => item.label === "Open Recent")
      return {
        clearLabel: openRecent?.submenu?.items.at(-1)?.label ?? null,
        clearRole: openRecent?.submenu?.items.at(-1)?.role ?? null,
        role: openRecent?.role ?? null,
      }
    })
    expect(menu).toEqual({
      clearLabel: "Clear Menu",
      clearRole: null,
      role: null,
    })
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open Recent reuses a window, replacing only its active disposable tab", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const recentPath = path.join(testDirectory, "recent-document.md")
  const finderPath = path.join(testDirectory, "finder-document.md")
  await Promise.all([
    writeFile(recentPath, "Recent document body\n"),
    writeFile(finderPath, "Finder document body\n"),
  ])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }, selectedPath) => {
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selectedPath],
      })) as typeof dialog.showOpenDialog
    }, recentPath)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+O" : "Control+O"
    )
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", recentPath)
    await expect
      .poll(() =>
        app.evaluate(({ Menu }, filePath) => {
          const openRecent = Menu.getApplicationMenu()
            ?.items.find((item) => item.label === "File")
            ?.submenu?.items.find((item) => item.label === "Open Recent")
          return Boolean(
            openRecent?.submenu?.items.some(
              (item) => item.toolTip === filePath && item.enabled
            )
          )
        }, recentPath)
      )
      .toBe(true)
    await expect
      .poll(async () => {
        try {
          const saved = JSON.parse(
            await readFile(path.join(userData, "recent-documents.json"), "utf8")
          ) as { paths?: unknown }
          return saved.paths
        } catch {
          return null
        }
      })
      .toEqual([recentPath])

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(page.locator(".document-tab")).toHaveCount(2)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", "Untitled")

    const clickRecent = () =>
      app.evaluate(({ BrowserWindow, Menu }, filePath) => {
        const window = BrowserWindow.getFocusedWindow()
        const item = Menu.getApplicationMenu()
          ?.items.find((candidate) => candidate.label === "File")
          ?.submenu?.items.find(
            (candidate) => candidate.label === "Open Recent"
          )
          ?.submenu?.items.find((candidate) => candidate.toolTip === filePath)
        if (!window || !item) throw new Error("Open Recent item is unavailable")
        item.click(undefined, window, window.webContents)
      }, recentPath)

    await clickRecent()
    await expect(page.locator(".document-tab")).toHaveCount(2)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", recentPath)
    await expect(page.locator(".cm-content")).toContainText(
      "Recent document body"
    )
    await expect.poll(() => app.windows().length).toBe(1)

    await clickRecent()
    await expect(page.locator(".document-tab")).toHaveCount(3)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", recentPath)
    await expect.poll(() => app.windows().length).toBe(1)

    if (process.platform === "darwin") {
      await app.evaluate(({ app }, filePath) => {
        app.emit("open-file", { preventDefault() {} }, filePath)
      }, finderPath)
      await expect.poll(() => app.windows().length).toBe(2)
      const finderWindow = app.windows().find((candidate) => candidate !== page)
      if (!finderWindow) throw new Error("Finder window was not created")
      await expect(
        finderWindow.locator('.document-tab[data-active] [role="tab"]')
      ).toHaveAttribute("aria-label", finderPath)
    }
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open Recent preserves typing that races its replacement request", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const recentPath = path.join(testDirectory, "rejected-recent.md")
  await writeFile(recentPath, "Rejected recent document\n")
  await seedRecentDocuments(userData, [recentPath])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog, ipcMain }) => {
      const testGlobal = globalThis as typeof globalThis & {
        lockedDirtyObserved?: boolean
        openRecentErrorCount?: number
        unsavedClosePromptCount?: number
      }
      testGlobal.lockedDirtyObserved = false
      testGlobal.openRecentErrorCount = 0
      testGlobal.unsavedClosePromptCount = 0
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      ipcMain.once("pulse-md:set-dirty", (_event, _tabId, dirty: unknown) => {
        if (dirty === true) testGlobal.lockedDirtyObserved = true
      })
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title === "Unsaved Changes") {
          testGlobal.unsavedClosePromptCount =
            (testGlobal.unsavedClosePromptCount ?? 0) + 1
          return { checkboxChecked: false, response: 2 }
        }
        testGlobal.openRecentErrorCount =
          (testGlobal.openRecentErrorCount ?? 0) + 1
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })
    await holdNextCliTabsOpenRequest(app)
    await app.evaluate(({ BrowserWindow, Menu }, filePath) => {
      const window = BrowserWindow.getFocusedWindow()
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "Open Recent")
        ?.submenu?.items.find((candidate) => candidate.toolTip === filePath)
      if (!window || !item) throw new Error("Open Recent item is unavailable")
      item.click(undefined, window, window.webContents)
    }, recentPath)

    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                heldCliTabsOpenRequest?: boolean
              }
            ).heldCliTabsOpenRequest ?? false
        )
      )
      .toBe(true)
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await page.locator(".cm-content").click()
    await page.keyboard.insertText("Typing won the replacement race.")
    await expect(page.locator(".cm-content")).toContainText(
      "Typing won the replacement race."
    )
    await expect(
      page.locator(".document-tab[data-active] .tab-dirty-dot")
    ).toBeVisible()
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                lockedDirtyObserved?: boolean
              }
            ).lockedDirtyObserved ?? false
        )
      )
      .toBe(true)

    await releaseHeldCliTabsOpenRequest(app)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                openRecentErrorCount?: number
              }
            ).openRecentErrorCount ?? 0
        )
      )
      .toBe(1)
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", "Untitled, modified")
    await expect(page.locator(".cm-content")).toContainText(
      "Typing won the replacement race."
    )
    await expect(
      page.locator(".document-tab[data-active] .tab-dirty-dot")
    ).toBeVisible()

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+W" : "Control+W"
    )
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                unsavedClosePromptCount?: number
              }
            ).unsavedClosePromptCount ?? 0
        )
      )
      .toBe(1)
    await expect(page.locator(".document-tab")).toHaveCount(1)
  } finally {
    await releaseHeldCliTabsOpenRequest(app).catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open Recent rejects saves that start after replacement is locked", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const recentPath = path.join(testDirectory, "save-after-lock-recent.md")
  await writeFile(recentPath, "Save after lock recent\n")
  await seedRecentDocuments(userData, [recentPath])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        saveAfterLockDialogCount?: number
      }
      testGlobal.saveAfterLockDialogCount = 0
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      dialog.showSaveDialog = (async () => {
        testGlobal.saveAfterLockDialogCount =
          (testGlobal.saveAfterLockDialogCount ?? 0) + 1
        return { canceled: true, filePath: "" }
      }) as typeof dialog.showSaveDialog
    })
    await holdNextCliTabsOpenRequest(app)
    await app.evaluate(({ BrowserWindow, Menu }, filePath) => {
      const window = BrowserWindow.getFocusedWindow()
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "Open Recent")
        ?.submenu?.items.find((candidate) => candidate.toolTip === filePath)
      if (!window || !item) throw new Error("Open Recent item is unavailable")
      item.click(undefined, window, window.webContents)
    }, recentPath)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                heldCliTabsOpenRequest?: boolean
              }
            ).heldCliTabsOpenRequest ?? false
        )
      )
      .toBe(true)

    const saveResult = await page.evaluate(async () => {
      const tabId =
        document.querySelector<HTMLElement>(".document-tab")?.dataset.tabId
      if (!tabId) throw new Error("The disposable tab is unavailable")
      return window.pulseMd.saveDocument({
        tabId,
        content: "",
        filePath: null,
        format: { hasUtf8Bom: false, lineEnding: "\n" },
        revision: 0,
        saveAs: true,
      })
    })
    expect(saveResult).toBeNull()
    expect(
      await app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              saveAfterLockDialogCount?: number
            }
          ).saveAfterLockDialogCount ?? 0
      )
    ).toBe(0)

    await releaseHeldCliTabsOpenRequest(app)
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", recentPath)
    await expect(page.locator(".cm-content")).toContainText(
      "Save after lock recent"
    )
  } finally {
    await releaseHeldCliTabsOpenRequest(app).catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("parallel Open Recent actions serialize in their invoking window", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const firstPath = path.join(testDirectory, "parallel-first.md")
  const secondPath = path.join(testDirectory, "parallel-second.md")
  await Promise.all([
    writeFile(firstPath, "Parallel first\n"),
    writeFile(secondPath, "Parallel second\n"),
  ])
  await seedRecentDocuments(userData, [firstPath, secondPath])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        parallelOpenRecentErrors?: number
      }
      testGlobal.parallelOpenRecentErrors = 0
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      dialog.showMessageBox = (async () => {
        testGlobal.parallelOpenRecentErrors =
          (testGlobal.parallelOpenRecentErrors ?? 0) + 1
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })
    await app.evaluate(
      ({ BrowserWindow, Menu }, filePaths) => {
        const window = BrowserWindow.getFocusedWindow()
        const items = Menu.getApplicationMenu()
          ?.items.find((candidate) => candidate.label === "File")
          ?.submenu?.items.find(
            (candidate) => candidate.label === "Open Recent"
          )?.submenu?.items
        const first = items?.find(
          (candidate) => candidate.toolTip === filePaths[0]
        )
        const second = items?.find(
          (candidate) => candidate.toolTip === filePaths[1]
        )
        if (!window || !first || !second) {
          throw new Error("Open Recent items are unavailable")
        }
        first.click(undefined, window, window.webContents)
        second.click(undefined, window, window.webContents)
      },
      [firstPath, secondPath]
    )

    const tabs = page.locator(".document-tab [role=tab]")
    await expect(tabs).toHaveCount(2)
    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
      )
      .toEqual([firstPath, secondPath])
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", secondPath)
    await expect.poll(() => app.windows().length).toBe(1)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                parallelOpenRecentErrors?: number
              }
            ).parallelOpenRecentErrors ?? 0
        )
      )
      .toBe(0)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open Recent appends while the disposable tab is saving", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const recentPath = path.join(testDirectory, "save-overlap-recent.md")
  await writeFile(recentPath, "Save overlap recent\n")
  await seedRecentDocuments(userData, [recentPath])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseOverlappingSave?: () => void
      }
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      dialog.showSaveDialog = (() =>
        new Promise((resolve) => {
          testGlobal.releaseOverlappingSave = () => {
            testGlobal.releaseOverlappingSave = undefined
            resolve({ canceled: true, filePath: "" })
          }
        })) as typeof dialog.showSaveDialog
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (
              globalThis as typeof globalThis & {
                releaseOverlappingSave?: () => void
              }
            ).releaseOverlappingSave
        )
      )
      .toBe("function")

    await app.evaluate(({ BrowserWindow, Menu }, filePath) => {
      const window = BrowserWindow.getFocusedWindow()
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "Open Recent")
        ?.submenu?.items.find((candidate) => candidate.toolTip === filePath)
      if (!window || !item) throw new Error("Open Recent item is unavailable")
      item.click(undefined, window, window.webContents)
    }, recentPath)

    const tabs = page.locator(".document-tab [role=tab]")
    await expect(tabs).toHaveCount(2)
    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
      )
      .toEqual(["Untitled", recentPath])
    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          releaseOverlappingSave?: () => void
        }
      ).releaseOverlappingSave?.()
    })
    await expect(tabs).toHaveCount(2)
  } finally {
    await app
      .evaluate(() => {
        ;(
          globalThis as typeof globalThis & {
            releaseOverlappingSave?: () => void
          }
        ).releaseOverlappingSave?.()
      })
      .catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open appends while the disposable tab is saving", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const openedPath = path.join(testDirectory, "save-overlap-open.md")
  await writeFile(openedPath, "Save overlap open\n")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, dialog }, selectedPath) => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseOverlappingOpenSave?: () => void
      }
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selectedPath],
      })) as typeof dialog.showOpenDialog
      dialog.showSaveDialog = (() =>
        new Promise((resolve) => {
          testGlobal.releaseOverlappingOpenSave = () => {
            testGlobal.releaseOverlappingOpenSave = undefined
            resolve({ canceled: true, filePath: "" })
          }
        })) as typeof dialog.showSaveDialog
    }, openedPath)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (
              globalThis as typeof globalThis & {
                releaseOverlappingOpenSave?: () => void
              }
            ).releaseOverlappingOpenSave
        )
      )
      .toBe("function")

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+O" : "Control+O"
    )
    const tabs = page.locator(".document-tab [role=tab]")
    await expect(tabs).toHaveCount(2)
    await expect
      .poll(() =>
        tabs.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
      )
      .toEqual(["Untitled", openedPath])
    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          releaseOverlappingOpenSave?: () => void
        }
      ).releaseOverlappingOpenSave?.()
    })
    await expect(tabs).toHaveCount(2)
  } finally {
    await app
      .evaluate(() => {
        ;(
          globalThis as typeof globalThis & {
            releaseOverlappingOpenSave?: () => void
          }
        ).releaseOverlappingOpenSave?.()
      })
      .catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Open Recent waits for its pre-ready invoking window", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const recentPath = path.join(testDirectory, "pre-ready-recent.md")
  await writeFile(recentPath, "Pre-ready recent document\n")
  await seedRecentDocuments(userData, [recentPath])
  const app = await launchApplication(userData)

  try {
    const firstPage = await app.firstWindow()
    await firstPage.locator(".cm-editor").waitFor()
    await app.evaluate(({ app, BrowserWindow, Menu }) => {
      const testGlobal = globalThis as typeof globalThis & {
        preReadyFirstWindowId?: number
        releasePreReadyLoad?: () => void
      }
      app.addRecentDocument = () => {}
      app.clearRecentDocuments = () => {}
      const firstWindow = BrowserWindow.getAllWindows()[0]
      const newWindow =
        Menu.getApplicationMenu()?.getMenuItemById("file-new-window")
      if (!firstWindow || !newWindow) {
        throw new Error("New Window is unavailable")
      }
      testGlobal.preReadyFirstWindowId = firstWindow.id
      const originalLoadURL = BrowserWindow.prototype.loadURL
      let delayNextLoad = true
      const delayedLoadURL: typeof originalLoadURL = function (
        this: InstanceType<typeof BrowserWindow>,
        url,
        options
      ) {
        if (!delayNextLoad) return originalLoadURL.call(this, url, options)
        delayNextLoad = false
        return new Promise((resolve, reject) => {
          testGlobal.releasePreReadyLoad = () => {
            testGlobal.releasePreReadyLoad = undefined
            BrowserWindow.prototype.loadURL = originalLoadURL
            void originalLoadURL.call(this, url, options).then(resolve, reject)
          }
        })
      }
      BrowserWindow.prototype.loadURL = delayedLoadURL
      newWindow.click(undefined, firstWindow, firstWindow.webContents)
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(2)

    await app.evaluate(({ BrowserWindow, Menu }, filePath) => {
      const testGlobal = globalThis as typeof globalThis & {
        preReadyFirstWindowId?: number
      }
      const target = BrowserWindow.getAllWindows().find(
        (window) => window.id !== testGlobal.preReadyFirstWindowId
      )
      const item = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "Open Recent")
        ?.submenu?.items.find((candidate) => candidate.toolTip === filePath)
      if (!target || !item) {
        throw new Error("Pre-ready Open Recent target is unavailable")
      }
      item.click(undefined, target, target.webContents)
    }, recentPath)
    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          releasePreReadyLoad?: () => void
        }
      ).releasePreReadyLoad?.()
    })

    await expect.poll(() => app.windows().length).toBe(2)
    const secondPage = app
      .windows()
      .find((candidate) => candidate !== firstPage)
    if (!secondPage) throw new Error("The second window was not created")
    await secondPage.locator(".cm-editor").waitFor()
    await expect(
      secondPage.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", recentPath)
    await expect(secondPage.locator(".cm-content")).toContainText(
      "Pre-ready recent document"
    )
    await expect(
      firstPage.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", "Untitled")
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(2)
  } finally {
    await app
      .evaluate(() => {
        ;(
          globalThis as typeof globalThis & {
            releasePreReadyLoad?: () => void
          }
        ).releasePreReadyLoad?.()
      })
      .catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})
