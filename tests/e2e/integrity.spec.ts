import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

async function createTestDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "pulse-md-integrity-"))
}

async function launchApplication(userData: string, ...filePaths: string[]) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, ...filePaths],
    cwd: projectRoot,
  })
}

async function openAdditionalWindow(app: ElectronApplication) {
  const existingWindows = new Set(app.windows())
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((candidate) => candidate.label === "File")
      ?.submenu?.items.find((candidate) => candidate.label === "New Window")
    const window = BrowserWindow.getFocusedWindow()
    if (!item || !window) throw new Error("New Window is unavailable")
    item.click(undefined, window, window.webContents)
  })
  await expect.poll(() => app.windows().length).toBe(existingWindows.size + 1)
  const window = app
    .windows()
    .find((candidate) => !existingWindows.has(candidate))
  if (!window) throw new Error("The additional window was not created")
  await window.locator(".cm-editor").waitFor()
  return window
}

async function replaceEditorDocument(page: Page, content: string) {
  const editor = page.locator(".cm-content")
  await editor.waitFor()
  await editor.click()
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A"
  )
  await page.keyboard.insertText(content)
  await expect(page.getByLabel("Modified")).toBeVisible()
}

test("the dark e2e theme is resolved before the first window is created", async () => {
  test.skip(
    process.env.PMD_E2E_FORCE_DARK_MODE !== "1",
    "The optimized e2e runner owns the default dark appearance"
  )
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    const nativeAppearance = await app.evaluate(
      ({ BrowserWindow, nativeTheme }) => ({
        backgroundColor:
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? null,
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        themeSource: nativeTheme.themeSource,
      })
    )

    expect(nativeAppearance).toMatchObject({
      shouldUseDarkColors: true,
      themeSource: "dark",
    })
    expect(nativeAppearance.backgroundColor).toMatch(/^#181818(?:ff)?$/i)
    expect(new URL(page.url()).searchParams.get("appearanceMode")).toBe(
      "system"
    )
    expect(
      await page.evaluate(
        () => window.matchMedia("(prefers-color-scheme: dark)").matches
      )
    ).toBe(true)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("the renderer uses its private scheme and IPC rejects a changed main-frame path", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const rendererUrl = new URL(page.url())
    expect(rendererUrl.protocol).toBe("pulse-md:")
    expect(rendererUrl.host).toBe("bundle")
    expect(rendererUrl.pathname).toBe("/index.html")

    await app.evaluate(({ shell }) => {
      const testGlobal = globalThis as typeof globalThis & {
        openedIntegrityTestLinks?: string[]
      }
      testGlobal.openedIntegrityTestLinks = []
      shell.openExternal = async (url) => {
        testGlobal.openedIntegrityTestLinks?.push(url)
      }
    })

    const error = await page.evaluate(async () => {
      history.replaceState(null, "", "/not-the-app.html")
      try {
        await window.pulseMd.openExternalLink(
          "https://example.com/should-not-open"
        )
        return null
      } catch (caught) {
        return String(caught)
      }
    })
    expect(error).toContain("trusted application renderer")
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            openedIntegrityTestLinks?: string[]
          }
          return testGlobal.openedIntegrityTestLinks
        })
      )
      .toEqual([])
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("an operating-system external-link failure is surfaced in the window", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ dialog, shell }) => {
      const testGlobal = globalThis as typeof globalThis & {
        externalLinkFailureDialog?: { message?: string; title?: string }
      }
      shell.openExternal = async () => {
        throw new Error("Injected operating-system launch failure")
      }
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message?: string; title?: string }
        testGlobal.externalLinkFailureDialog = {
          message: options.message,
          title: options.title,
        }
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })

    await page.evaluate(() =>
      window.pulseMd.openExternalLink("https://example.com/failure")
    )
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                externalLinkFailureDialog?: {
                  message?: string
                  title?: string
                }
              }
            ).externalLinkFailureDialog
        )
      )
      .toEqual({
        message: "The link could not be opened.",
        title: "Open Link Failed",
      })
    await expect(page.locator(".cm-editor")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a renderer bootstrap failure can hand off to the in-window recovery surface", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "bootstrap-recovery.md")
  await writeFile(documentPath, "Saved bootstrap content\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() =>
      window.pulseMd.showRecovery("Injected bootstrap failure")
    )

    await expect(page).toHaveURL(/\/recovery\.html/)
    await expect(
      page.getByRole("heading", { name: "The editor could not start" })
    ).toBeVisible()
    await page.getByRole("button", { name: "Reload Window" }).click()
    await expect(page).toHaveURL(/\/index\.html/)
    await page.locator(".cm-editor").waitFor()
    await expect(page.locator(".cm-content")).toContainText(
      "Saved bootstrap content"
    )
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("canceling a dirty sibling's quit prompt keeps recovery actionable", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const recovery = await app.firstWindow()
    await recovery.locator(".cm-editor").waitFor()
    const healthy = await openAdditionalWindow(app)
    await replaceEditorDocument(healthy, "Unsaved sibling content\n")
    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        recoveryQuitPromptCount?: number
      }
      testGlobal.recoveryQuitPromptCount = 0
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title === "Unsaved Changes") {
          testGlobal.recoveryQuitPromptCount =
            (testGlobal.recoveryQuitPromptCount ?? 0) + 1
          return { checkboxChecked: false, response: 2 }
        }
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })

    await recovery.evaluate(() =>
      window.pulseMd.showRecovery("Injected sibling quit test")
    )
    await expect(recovery).toHaveURL(/\/recovery\.html/)
    await recovery.getByRole("button", { name: "Quit", exact: true }).click()

    await expect(recovery.getByRole("status")).toContainText(
      "Quit was canceled."
    )
    await expect.poll(() => app.windows().length).toBe(2)
    await expect(recovery).toHaveURL(/\/recovery\.html/)
    await expect(healthy).toHaveURL(/\/index\.html/)
    await expect(healthy.locator(".cm-content")).toContainText(
      "Unsaved sibling content"
    )
    await expect(healthy.getByLabel("Modified")).toBeVisible()
    for (const label of ["Reload Window", "Reopen App", "Quit"]) {
      await expect(
        recovery.getByRole("button", { name: label, exact: true })
      ).toBeEnabled()
    }
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                recoveryQuitPromptCount?: number
              }
            ).recoveryQuitPromptCount
        )
      )
      .toBe(1)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a chrome-setting write failure reverts visibly and can be retried", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const pageWindow = await app.browserWindow(page)
    const pageWindowId = await pageWindow.evaluate((window) => window.id)
    await pageWindow.dispose()
    await app.evaluate(({ BrowserWindow, ipcMain, Menu }, windowId) => {
      let attempts = 0
      ipcMain.removeHandler("pulse-md:set-settings")
      ipcMain.handle("pulse-md:set-settings", (_event, settings) => {
        attempts += 1
        if (attempts === 1) throw new Error("Injected settings write failure")
        return { effective: settings, persisted: settings }
      })
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "view-formatting-bar"
      )
      const window = BrowserWindow.fromId(windowId)
      if (!item || !window) throw new Error("Formatting Toolbar is unavailable")
      item.click(undefined, window, window.webContents)
    }, pageWindowId)

    const notice = page.getByRole("alert").filter({
      hasText: "The Formatting Toolbar setting could not be saved.",
    })
    await expect(notice).toBeVisible()
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toHaveCount(0)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    const search = page.getByRole("form", {
      name: "Find and replace in document",
    })
    await expect(search).toBeVisible()
    await expect(notice).toBeVisible()
    const [noticeBounds, searchBounds] = await Promise.all(
      [notice, search].map((surface) =>
        surface.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return {
            height: bounds.height,
            width: bounds.width,
            x: bounds.x,
            y: bounds.y,
          }
        })
      )
    )
    expect(
      noticeBounds.x + noticeBounds.width <= searchBounds.x ||
        searchBounds.x + searchBounds.width <= noticeBounds.x ||
        noticeBounds.y >= searchBounds.y + searchBounds.height ||
        searchBounds.y >= noticeBounds.y + noticeBounds.height
    ).toBe(true)
    await page.keyboard.press("Escape")
    await notice.getByRole("button", { name: "Retry" }).click()
    await expect(notice).not.toBeVisible()
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a native zoom write failure reverts visibly and can be retried", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const settingsFile = path.join(userData, "settings.json")
  const settingsBackup = path.join(userData, "settings.backup.json")
  const app = await launchApplication(userData)
  let hadSettingsFile = false

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    try {
      await rename(settingsFile, settingsBackup)
      hadSettingsFile = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(settingsFile)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+=" : "Control+="
    )

    const notice = page.getByRole("alert").filter({
      hasText: "The zoom change could not be saved and was reverted.",
    })
    // Windows retries sharing-style atomic rename failures for about 5.1s
    // before surfacing the durable-write error to the renderer.
    await expect(notice).toBeVisible({ timeout: 8_000 })
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
        )
      )
      .toBeCloseTo(1, 5)

    await rm(settingsFile, { force: true, recursive: true })
    if (hadSettingsFile) {
      await rename(settingsBackup, settingsFile)
      hadSettingsFile = false
    }
    await notice.getByRole("button", { name: "Retry" }).click()
    await expect(notice).not.toBeVisible()
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(settingsFile, "utf8")).zoomFactor
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
      })
      .toBeCloseTo(1.05, 5)
  } finally {
    await rm(settingsFile, { force: true, recursive: true }).catch(
      () => undefined
    )
    if (hadSettingsFile) {
      await rename(settingsBackup, settingsFile).catch(() => undefined)
    }
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("the first Formatting Toolbar request has an immediate loading surface", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ session }) => {
      const testGlobal = globalThis as typeof globalThis & {
        formattingToolbarChunkRequests?: number
      }
      testGlobal.formattingToolbarChunkRequests = 0
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/FormattingToolbar-*"] },
        (_details, callback) => {
          testGlobal.formattingToolbarChunkRequests =
            (testGlobal.formattingToolbarChunkRequests ?? 0) + 1
          setTimeout(() => callback({}), 2_000)
        }
      )
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B"
    )

    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                formattingToolbarChunkRequests?: number
              }
            ).formattingToolbarChunkRequests ?? 0
        )
      )
      .toBe(1)
    await expect(page.getByText("Loading formatting tools…")).toBeVisible()
    await expect(
      page.getByRole("toolbar", { name: "Formatting toolbar" })
    ).toBeVisible({ timeout: 5_000 })
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("an invalid one-way window action is contained and the window stays usable", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityUncaughtExceptions?: string[]
      }
      testGlobal.integrityUncaughtExceptions = []
      process.on("uncaughtException", (error) => {
        testGlobal.integrityUncaughtExceptions?.push(String(error))
      })
    })

    await page.evaluate(() => {
      const sendInvalidAction = window.pulseMd.windowAction as (
        action: unknown
      ) => void
      sendInvalidAction({ contaminated: true })
    })
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(page.getByRole("tab")).toHaveCount(2)
    const uncaughtExceptions = await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityUncaughtExceptions?: string[]
      }
      return testGlobal.integrityUncaughtExceptions
    })
    expect(uncaughtExceptions).toEqual([])
    await replaceEditorDocument(page, "Still usable after invalid IPC\n")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("opening invalid UTF-8 reports an error without decoding replacement characters", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const invalidDocument = path.join(testDirectory, "invalid.md")
  const invalidBytes = Buffer.from([0x23, 0x20, 0x80, 0x0a])
  await writeFile(invalidDocument, invalidBytes)
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ dialog }, filePath) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityOperationErrors?: Array<{
          detail?: string
          title?: string
        }>
      }
      testGlobal.integrityOperationErrors = []
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [filePath],
      })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string; title?: string }
        testGlobal.integrityOperationErrors?.push({
          detail: options.detail,
          title: options.title,
        })
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    }, invalidDocument)

    const result = await page.evaluate(() => window.pulseMd.openDocument(true))
    expect(result).toBeNull()
    const errors = await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityOperationErrors?: Array<{
          detail?: string
          title?: string
        }>
      }
      return testGlobal.integrityOperationErrors
    })
    expect(errors).toHaveLength(1)
    expect(errors?.[0]?.title).toBe("Open Failed")
    expect(errors?.[0]?.detail).toMatch(/encoded data|utf-?8/i)
    expect(await readFile(invalidDocument)).toEqual(invalidBytes)
    await expect(page.getByRole("tab")).toHaveCount(1)
    await expect(page.getByRole("tab")).toContainText("Untitled")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("opening a non-regular file rejects it before reading", async () => {
  test.skip(process.platform === "win32", "Windows does not expose /dev/zero")
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityOperationErrors?: Array<{
          detail?: string
          title?: string
        }>
      }
      testGlobal.integrityOperationErrors = []
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: ["/dev/zero"],
      })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string; title?: string }
        testGlobal.integrityOperationErrors?.push({
          detail: options.detail,
          title: options.title,
        })
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })

    const result = await page.evaluate(() => window.pulseMd.openDocument(true))
    expect(result).toBeNull()
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            integrityOperationErrors?: Array<{
              detail?: string
              title?: string
            }>
          }
          return testGlobal.integrityOperationErrors
        })
      )
      .toEqual([
        expect.objectContaining({
          detail: expect.stringMatching(/not a file/i),
          title: "Open Failed",
        }),
      ])
    await expect(page.getByRole("tab")).toContainText("Untitled")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("save requires confirmation before recreating an externally deleted file", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "deleted.md")
  await writeFile(documentPath, "Original\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await rm(documentPath)
    await replaceEditorDocument(page, "Application edit\n")
    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityOverwritePrompts?: string[]
      }
      testGlobal.integrityOverwritePrompts = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title) {
          testGlobal.integrityOverwritePrompts?.push(options.title)
        }
        return { checkboxChecked: false, response: 1 }
      }) as typeof dialog.showMessageBox
    })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )

    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            integrityOverwritePrompts?: string[]
          }
          return testGlobal.integrityOverwritePrompts
        })
      )
      .toEqual(["Document Deleted on Disk"])
    await expect(stat(documentPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(page.getByLabel("Modified")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("an externally moved clean file stays visible and can be recreated", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "moved.md")
  const movedPath = path.join(testDirectory, "moved-elsewhere.md")
  await writeFile(documentPath, "Keep this text\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await rename(documentPath, movedPath)

    await expect(page.getByRole("tab")).toHaveAttribute(
      "aria-label",
      /file deleted or moved/
    )
    await expect(page.getByRole("status")).toContainText(
      "moved.md was deleted or moved."
    )

    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        movedFilePrompts?: string[]
      }
      testGlobal.movedFilePrompts = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title) testGlobal.movedFilePrompts?.push(options.title)
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })
    await page.getByRole("button", { name: "Recreate File" }).click()

    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            movedFilePrompts?: string[]
          }
          return testGlobal.movedFilePrompts
        })
      )
      .toEqual(["Document Deleted on Disk"])
    await expect
      .poll(() => readFile(documentPath, "utf8"))
      .toBe("Keep this text\n")
    expect(await readFile(movedPath, "utf8")).toBe("Keep this text\n")
    await expect(page.getByRole("status")).toHaveCount(0)
    await expect(page.getByRole("tab")).toHaveAttribute(
      "aria-label",
      documentPath
    )
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("duplicate file tabs retain independent lifecycle state across windows", async () => {
  test.setTimeout(45_000)
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "duplicate.md")
  const savedAsPath = path.join(testDirectory, "duplicate-copy.md")
  await writeFile(documentPath, "Initial duplicate text\n")
  const app = await launchApplication(userData, documentPath, documentPath)

  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    const sourceTabs = source.getByRole("tab")
    await expect(sourceTabs).toHaveCount(2)
    await source.locator(".top-chrome").hover()
    await sourceTabs.nth(1).click()
    const movedTabId = await sourceTabs.nth(1).getAttribute("data-tab-id")
    if (!movedTabId) throw new Error("The duplicate tab has no id")

    const target = await openAdditionalWindow(app)
    await target.locator(".top-chrome").waitFor()
    await target.locator(".document-tab").first().waitFor()
    const dragToken = await source.evaluate(
      (tabId) => window.pulseMd.beginTabDrag(tabId),
      movedTabId
    )
    expect(dragToken).not.toBe("")
    await target.evaluate((token) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      const tab = header?.querySelector<HTMLElement>(".document-tab")
      if (!header || !tab)
        throw new Error("The target tab strip is unavailable")
      const bounds = tab.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      dataTransfer.effectAllowed = "move"
      dataTransfer.setData("application/x-pulse-md-tab", token)
      for (const type of ["dragenter", "dragover", "drop"]) {
        header.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: bounds.right - 1,
            clientY: bounds.top + bounds.height / 2,
            dataTransfer,
          })
        )
      }
    }, dragToken)

    await expect(source.getByRole("tab")).toHaveCount(1)
    await expect(target.getByRole("tab")).toHaveCount(2)
    await expect(source.locator(".cm-content")).toContainText(
      "Initial duplicate text"
    )
    await expect(target.locator(".cm-content")).toContainText(
      "Initial duplicate text"
    )

    await writeFile(documentPath, "Shared external refresh\n")
    await expect(source.locator(".cm-content")).toContainText(
      "Shared external refresh"
    )
    await expect(target.locator(".cm-content")).toContainText(
      "Shared external refresh"
    )

    await replaceEditorDocument(target, "Local duplicate edit\n")
    await writeFile(documentPath, "Newer disk version\n")
    await expect(source.locator(".cm-content")).toContainText(
      "Newer disk version"
    )
    await expect(target.locator(".cm-content")).toContainText(
      "Local duplicate edit"
    )

    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        duplicateConflictPrompts?: string[]
      }
      testGlobal.duplicateConflictPrompts = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title) {
          testGlobal.duplicateConflictPrompts?.push(options.title)
        }
        return { checkboxChecked: false, response: 1 }
      }) as typeof dialog.showMessageBox
    })
    await target.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            duplicateConflictPrompts?: string[]
          }
          return testGlobal.duplicateConflictPrompts
        })
      )
      .toEqual(["Document Changed on Disk"])
    expect(await readFile(documentPath, "utf8")).toBe("Newer disk version\n")
    await expect(target.getByLabel("Modified")).toBeVisible()

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as typeof dialog.showSaveDialog
    }, savedAsPath)
    await target.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+S" : "Control+Shift+S"
    )
    await expect
      .poll(() => readFile(savedAsPath, "utf8").catch(() => null))
      .toBe("Local duplicate edit\n")
    await expect(target.getByRole("tab", { selected: true })).toHaveAttribute(
      "aria-label",
      savedAsPath
    )
    await expect(source.getByRole("tab")).toHaveAttribute(
      "aria-label",
      documentPath
    )

    await writeFile(documentPath, "Original path after Save As\n")
    await expect(source.locator(".cm-content")).toContainText(
      "Original path after Save As"
    )
    await expect(target.locator(".cm-content")).toContainText(
      "Local duplicate edit"
    )

    await target.locator(".top-chrome").hover()
    await target
      .getByRole("button", { name: "Close duplicate-copy.md" })
      .click()
    await expect(target.getByRole("tab")).toHaveCount(1)
    await writeFile(documentPath, "Original path after duplicate close\n")
    await expect(source.locator(".cm-content")).toContainText(
      "Original path after duplicate close"
    )
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a renderer crash leaves an in-window recovery path that can reload saved content", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "renderer-crash.md")
  await writeFile(documentPath, "Original\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await replaceEditorDocument(page, "Unsaved after renderer crash\n")
    await app.evaluate(({ BrowserWindow, dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityClosePromptCount?: number
        integrityRendererGone?: boolean
        integrityTestWindowId?: number
      }
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error("The test window is unavailable")
      new BrowserWindow({ show: false })
      testGlobal.integrityClosePromptCount = 0
      testGlobal.integrityRendererGone = false
      testGlobal.integrityTestWindowId = win.id
      const rendererGone = new Promise<void>((resolve) => {
        win.webContents.once("render-process-gone", () => {
          testGlobal.integrityRendererGone = true
          resolve()
        })
      })
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title !== "Unsaved Changes") {
          return { checkboxChecked: false, response: 0 }
        }
        testGlobal.integrityClosePromptCount =
          (testGlobal.integrityClosePromptCount ?? 0) + 1
        if (testGlobal.integrityClosePromptCount === 1) {
          win.webContents.forcefullyCrashRenderer()
          await rendererGone
          return { checkboxChecked: false, response: 2 }
        }
        return { checkboxChecked: false, response: 1 }
      }) as typeof dialog.showMessageBox
      win.close()
    })

    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            integrityRendererGone?: boolean
          }
          return testGlobal.integrityRendererGone
        })
      )
      .toBe(true)
    await expect.poll(() => readFile(documentPath, "utf8")).toBe("Original\n")

    await expect
      .poll(async () => {
        return app.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) =>
              candidate.id ===
              (
                globalThis as typeof globalThis & {
                  integrityTestWindowId?: number
                }
              ).integrityTestWindowId
          )
          if (!window || window.webContents.isCrashed()) return false
          return window.webContents
            .executeJavaScript(
              `Boolean(
                document.querySelector("#recovery-title")?.textContent ===
                  "The editor needs to recover" &&
                document.querySelector('[data-action="reload"]') &&
                document.querySelector('[data-action="reopen"]') &&
                document.querySelector('[data-action="quit"]')
              )`
            )
            .catch(() => false)
        })
      })
      .toBe(true)
    await app.evaluate(async ({ BrowserWindow }) => {
      const windowId = (
        globalThis as typeof globalThis & { integrityTestWindowId?: number }
      ).integrityTestWindowId
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.id === windowId
      )
      if (!window) throw new Error("The recovery window is unavailable")
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-action="reload"]')?.click()`
      )
    })
    await expect
      .poll(() =>
        app.evaluate(async ({ BrowserWindow }) => {
          const windowId = (
            globalThis as typeof globalThis & { integrityTestWindowId?: number }
          ).integrityTestWindowId
          const window = BrowserWindow.getAllWindows().find(
            (candidate) => candidate.id === windowId
          )
          if (
            !window ||
            window.webContents.isCrashed() ||
            !/\/index\.html/.test(window.webContents.getURL())
          ) {
            return null
          }
          return window.webContents
            .executeJavaScript(
              `({
                content: document.querySelector(".cm-content")?.textContent,
                modified: Boolean(document.querySelector('[aria-label="Modified"]'))
              })`
            )
            .catch(() => null)
        })
      )
      .toEqual({
        content: expect.stringContaining("Original"),
        modified: false,
      })

    await app.evaluate(({ BrowserWindow }) => {
      const testWindowId = (
        globalThis as typeof globalThis & { integrityTestWindowId?: number }
      ).integrityTestWindowId
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.id === testWindowId)
        ?.close()
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1)
    expect(
      await app.evaluate(() => {
        const testGlobal = globalThis as typeof globalThis & {
          integrityClosePromptCount?: number
        }
        return testGlobal.integrityClosePromptCount
      })
    ).toBe(1)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a missing renderer close acknowledgement times out without stranding the window", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "close-timeout.md")
  await writeFile(documentPath, "Original\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await replaceEditorDocument(page, "Unsaved without acknowledgement\n")
    await app.evaluate(({ BrowserWindow, dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityClosePromptCount?: number
        integrityTestWindowId?: number
        restoreIntegrityTimeout?: () => void
      }
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error("The test window is unavailable")
      new BrowserWindow({ show: false })
      testGlobal.integrityClosePromptCount = 0
      testGlobal.integrityTestWindowId = win.id
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title !== "Unsaved Changes") {
          return { checkboxChecked: false, response: 0 }
        }
        testGlobal.integrityClosePromptCount =
          (testGlobal.integrityClosePromptCount ?? 0) + 1
        return {
          checkboxChecked: false,
          response: testGlobal.integrityClosePromptCount === 1 ? 0 : 1,
        }
      }) as typeof dialog.showMessageBox

      const originalSend = win.webContents.send.bind(win.webContents)
      win.webContents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === "pulse-md:command" && args[0] === "save-and-close") {
          win.webContents.send = originalSend
          return
        }
        originalSend(channel, ...args)
      }) as typeof win.webContents.send

      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) =>
        originalSetTimeout(
          handler,
          timeout === 10_000 ? 25 : timeout,
          ...args
        )) as typeof globalThis.setTimeout
      testGlobal.restoreIntegrityTimeout = () => {
        globalThis.setTimeout = originalSetTimeout
      }
      win.close()
    })

    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            integrityClosePromptCount?: number
          }
          return testGlobal.integrityClosePromptCount
        })
      )
      .toBe(1)
    await page.waitForTimeout(100)
    await app.evaluate(({ BrowserWindow }) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityTestWindowId?: number
        restoreIntegrityTimeout?: () => void
      }
      testGlobal.restoreIntegrityTimeout?.()
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.id === testGlobal.integrityTestWindowId)
        ?.close()
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1)
    expect(
      await app.evaluate(() => {
        const testGlobal = globalThis as typeof globalThis & {
          integrityClosePromptCount?: number
        }
        return testGlobal.integrityClosePromptCount
      })
    ).toBe(2)
  } finally {
    await app
      .evaluate(() => {
        const testGlobal = globalThis as typeof globalThis & {
          restoreIntegrityTimeout?: () => void
        }
        testGlobal.restoreIntegrityTimeout?.()
      })
      .catch(() => undefined)
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("save detects an external content change even when its mtime is restored", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "same-mtime.md")
  await writeFile(documentPath, "Original\n")
  const originalStats = await stat(documentPath)
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await replaceEditorDocument(page, "Application edit\n")
    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        integrityOverwritePrompts?: string[]
      }
      testGlobal.integrityOverwritePrompts = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title) {
          testGlobal.integrityOverwritePrompts?.push(options.title)
        }
        return { checkboxChecked: false, response: 1 }
      }) as typeof dialog.showMessageBox
    })

    await writeFile(documentPath, "External edit\n")
    await utimes(documentPath, originalStats.atime, originalStats.mtime)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )

    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            integrityOverwritePrompts?: string[]
          }
          return testGlobal.integrityOverwritePrompts
        })
      )
      .toEqual(["Document Changed on Disk"])
    expect(await readFile(documentPath, "utf8")).toBe("External edit\n")
    await expect(page.getByLabel("Modified")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("saving an opened symlink preserves the link and writes its target", async () => {
  test.skip(process.platform === "win32", "Symlink creation is not portable")
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const targetPath = path.join(testDirectory, "target.md")
  const linkPath = path.join(testDirectory, "link.md")
  await writeFile(targetPath, "Before\n")
  await symlink(targetPath, linkPath)
  const app = await launchApplication(userData, linkPath)

  try {
    const page = await app.firstWindow()
    await expect(page.getByRole("tab")).toHaveAttribute("aria-label", linkPath)
    await replaceEditorDocument(page, "Saved through the link\n")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )
    await expect
      .poll(() => readFile(targetPath, "utf8"))
      .toBe("Saved through the link\n")
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    await expect(page.getByRole("tab")).toHaveAttribute("aria-label", linkPath)
    await expect(page.getByLabel("Modified")).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a case-aliased macOS path watches the canonical filename", async () => {
  test.skip(process.platform !== "darwin", "Case aliases are a macOS concern")
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const canonicalPath = path.join(testDirectory, "case.md")
  const aliasedPath = path.join(testDirectory, "CASE.md")
  await writeFile(canonicalPath, "Initial text\n")
  const aliasStats = await stat(aliasedPath).catch(() => null)
  test.skip(!aliasStats, "The test volume is case-sensitive")
  const app = await launchApplication(userData, aliasedPath)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-content")
    await expect(page.getByRole("tab")).toHaveAttribute(
      "aria-label",
      aliasedPath
    )
    await expect(editor).toContainText("Initial text")
    await writeFile(canonicalPath, "Refreshed canonical text\n")
    await expect(editor).toContainText("Refreshed canonical text")
    await expect(page.getByRole("tab")).toHaveAttribute(
      "aria-label",
      aliasedPath
    )
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a clean tab close approval cannot discard a later edit", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "close-approval.md")
  await writeFile(documentPath, "Initially clean\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const tabId = await page.getByRole("tab").getAttribute("data-tab-id")
    if (!tabId) throw new Error("The active tab has no id")

    const decision = await page.evaluate(
      (id) => window.pulseMd.requestCloseTab(id),
      tabId
    )
    expect(decision).toBe("close")
    await page.evaluate((id) => window.pulseMd.setDirty(id, true), tabId)
    await expect(page.getByLabel("Modified")).toBeVisible()
    const error = await page.evaluate(async (id) => {
      try {
        await window.pulseMd.finalizeCloseTab(id, {
          pos: 0,
          screenOffset: 0,
          scrollLeft: 0,
          scrollTop: 0,
        })
        return null
      } catch (caught) {
        return String(caught)
      }
    }, tabId)

    expect(error).toContain("changed after its close was approved")
    await expect(page.locator(".cm-editor")).toBeVisible()
    await expect(page.getByLabel("Modified")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("window close rescans tabs dirtied while a later prompt is pending", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "first-tab.md")
  await writeFile(documentPath, "Clean first tab\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(page.getByRole("tab")).toHaveCount(2)
    await replaceEditorDocument(page, "Dirty second tab\n")
    const tabIds = await page
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id")))
    const firstTabId = tabIds[0]
    if (!firstTabId) throw new Error("The first tab has no id")

    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        closePromptCount?: number
        resolveClosePrompt?: (response: number) => void
      }
      testGlobal.closePromptCount = 0
      dialog.showMessageBox = (() => {
        testGlobal.closePromptCount = (testGlobal.closePromptCount ?? 0) + 1
        return new Promise((resolve) => {
          testGlobal.resolveClosePrompt = (response) => {
            testGlobal.resolveClosePrompt = undefined
            resolve({ checkboxChecked: false, response })
          }
        })
      }) as typeof dialog.showMessageBox
    })

    await page.evaluate(() => window.pulseMd.windowAction("close"))
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            closePromptCount?: number
            resolveClosePrompt?: (response: number) => void
          }
          return {
            count: testGlobal.closePromptCount,
            waiting: Boolean(testGlobal.resolveClosePrompt),
          }
        })
      )
      .toEqual({ count: 1, waiting: true })

    await page.evaluate((id) => window.pulseMd.setDirty(id, true), firstTabId)
    await expect(page.getByLabel("Modified")).toHaveCount(2)
    await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        resolveClosePrompt?: (response: number) => void
      }
      testGlobal.resolveClosePrompt?.(1)
    })
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            closePromptCount?: number
            resolveClosePrompt?: (response: number) => void
          }
          return {
            count: testGlobal.closePromptCount,
            waiting: Boolean(testGlobal.resolveClosePrompt),
          }
        })
      )
      .toEqual({ count: 2, waiting: true })

    await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        resolveClosePrompt?: (response: number) => void
      }
      testGlobal.resolveClosePrompt?.(2)
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1)
    await expect(page.locator(".cm-editor")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("application quit revalidates clean windows after asynchronous preparation", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "quit-revalidation.md")
  await writeFile(documentPath, "Initially clean\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const editable = await app.firstWindow()
    await editable.locator(".cm-editor").waitFor()
    const delayed = await openAdditionalWindow(app)
    const delayedWindow = await app.browserWindow(delayed)
    await delayedWindow.evaluate((win) => {
      const testGlobal = globalThis as typeof globalThis & {
        quitPreparationHeld?: boolean
        releaseQuitPreparation?: () => void
      }
      const originalSend = win.webContents.send
      win.webContents.send = ((channel: string, ...args: unknown[]) => {
        if (
          !testGlobal.quitPreparationHeld &&
          channel === "pulse-md:command" &&
          args[0] === "prepare-window-close"
        ) {
          testGlobal.quitPreparationHeld = true
          testGlobal.releaseQuitPreparation = () => {
            testGlobal.releaseQuitPreparation = undefined
            if (!win.isDestroyed()) {
              originalSend.call(win.webContents, channel, ...args)
            }
          }
          return
        }
        originalSend.call(win.webContents, channel, ...args)
      }) as typeof win.webContents.send
    })
    await delayedWindow.dispose()
    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        quitRevalidationPromptCount?: number
      }
      testGlobal.quitRevalidationPromptCount = 0
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title === "Unsaved Changes") {
          testGlobal.quitRevalidationPromptCount =
            (testGlobal.quitRevalidationPromptCount ?? 0) + 1
          return { checkboxChecked: false, response: 2 }
        }
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })

    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                quitPreparationHeld?: boolean
              }
            ).quitPreparationHeld
        )
      )
      .toBe(true)

    await replaceEditorDocument(editable, "Edited during quit preparation\n")
    await app.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          releaseQuitPreparation?: () => void
        }
      ).releaseQuitPreparation?.()
    })

    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                quitRevalidationPromptCount?: number
              }
            ).quitRevalidationPromptCount
        )
      )
      .toBe(1)
    await expect.poll(() => app.windows().length).toBe(2)
    await expect(editable.locator(".cm-content")).toContainText(
      "Edited during quit preparation"
    )
    await expect(editable.getByLabel("Modified")).toBeVisible()
    expect(await readFile(documentPath, "utf8")).toBe("Initially clean\n")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a Save As started during transfer aborts the stale import", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const sourcePath = path.join(testDirectory, "transfer-source.md")
  const savedPath = path.join(testDirectory, "saved-during-transfer.md")
  await writeFile(sourcePath, "Transfer source\n")
  const app = await launchApplication(userData, sourcePath)

  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    const target = await openAdditionalWindow(app)
    const sourceTabId = await source
      .getByRole("tab")
      .getAttribute("data-tab-id")
    const targetTabId = await target
      .getByRole("tab")
      .getAttribute("data-tab-id")
    if (!sourceTabId || !targetTabId) {
      throw new Error("Transfer participants have no tab ids")
    }

    const dragToken = await source.evaluate(
      (tabId) => window.pulseMd.beginTabDrag(tabId),
      sourceTabId
    )
    const imported = await target.evaluate(
      ({ token }) => window.pulseMd.requestTabTransfer(token, 0),
      { token: dragToken }
    )
    if (!imported) throw new Error("The pending transfer was not exported")

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as typeof dialog.showSaveDialog
    }, savedPath)
    const saveResult = await source.evaluate(
      ({ filePath, revision, tabId }) =>
        window.pulseMd.saveDocument({
          tabId,
          content: "Saved while transfer was pending\n",
          filePath,
          format: { hasUtf8Bom: false, lineEnding: "\n" },
          revision,
          saveAs: true,
        }),
      {
        filePath: sourcePath,
        revision: imported.editorSession.revision,
        tabId: sourceTabId,
      }
    )
    if (!saveResult) throw new Error("Save As did not complete")
    await source.evaluate(
      ({ result, tabId }) =>
        window.pulseMd.acknowledgeDocumentSave({
          current: false,
          revision: result.revision,
          saveToken: result.saveToken,
          tabId,
        }),
      { result: saveResult, tabId: sourceTabId }
    )
    await expect(source.getByRole("tab")).toHaveAttribute(
      "aria-label",
      savedPath
    )
    expect(await readFile(savedPath, "utf8")).toBe(
      "Saved while transfer was pending\n"
    )

    const targetSnapshot = await target.evaluate(
      async ({ tabId, transferId }) => {
        window.pulseMd.confirmTabTransfer(transferId, true)
        return window.pulseMd.activateTab(tabId)
      },
      { tabId: targetTabId, transferId: imported.transferId }
    )
    expect(targetSnapshot.tabs.map((tab) => tab.id)).toEqual([targetTabId])
    await expect(source.getByRole("tab")).toHaveCount(1)
    await expect(target.getByRole("tab")).toHaveCount(1)
    expect(app.windows()).toHaveLength(2)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("an external refresh during transfer aborts the stale import", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const sourcePath = path.join(testDirectory, "external-transfer.md")
  await writeFile(sourcePath, "Before external refresh\n")
  const app = await launchApplication(userData, sourcePath)

  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    const target = await openAdditionalWindow(app)
    const sourceTabId = await source
      .getByRole("tab")
      .getAttribute("data-tab-id")
    const targetTabId = await target
      .getByRole("tab")
      .getAttribute("data-tab-id")
    if (!sourceTabId || !targetTabId) {
      throw new Error("Transfer participants have no tab ids")
    }

    const dragToken = await source.evaluate(
      (tabId) => window.pulseMd.beginTabDrag(tabId),
      sourceTabId
    )
    const imported = await target.evaluate(
      ({ token }) => window.pulseMd.requestTabTransfer(token, 0),
      { token: dragToken }
    )
    if (!imported) throw new Error("The pending transfer was not exported")

    await writeFile(sourcePath, "After external refresh\n")
    await expect(source.locator(".cm-content")).toContainText(
      "After external refresh"
    )
    const targetSnapshot = await target.evaluate(
      async ({ tabId, transferId }) => {
        window.pulseMd.confirmTabTransfer(transferId, true)
        return window.pulseMd.activateTab(tabId)
      },
      { tabId: targetTabId, transferId: imported.transferId }
    )

    expect(targetSnapshot.tabs.map((tab) => tab.id)).toEqual([targetTabId])
    await expect(source.getByRole("tab")).toHaveCount(1)
    await expect(target.getByRole("tab")).toHaveCount(1)
    expect(app.windows()).toHaveLength(2)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("overlapping saves are serialized and remain dirty until acknowledged", async () => {
  const testDirectory = await createTestDirectory()
  const userData = path.join(testDirectory, "user-data")
  const documentPath = path.join(testDirectory, "serialized.md")
  await writeFile(documentPath, "Before\n")
  const app = await launchApplication(userData, documentPath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const tabId = await page.getByRole("tab").getAttribute("data-tab-id")
    if (!tabId) throw new Error("The active tab has no id")
    await page.evaluate((id) => window.pulseMd.setDirty(id, true), tabId)
    await expect(page.getByLabel("Modified")).toBeVisible()

    const saved = await page.evaluate(
      async ({ filePath, id }) => {
        const first = window.pulseMd.saveDocument({
          tabId: id,
          content: "A".repeat(8 * 1024 * 1024),
          filePath,
          format: { hasUtf8Bom: false, lineEnding: "\n" },
          revision: 0,
        })
        const second = window.pulseMd.saveDocument({
          tabId: id,
          content: "Last save wins\n",
          filePath,
          format: { hasUtf8Bom: false, lineEnding: "\n" },
          revision: 1,
        })
        const results = await Promise.all([first, second])
        for (const result of results) {
          if (!result) continue
          window.pulseMd.acknowledgeDocumentSave({
            current: false,
            revision: result.revision,
            saveToken: result.saveToken,
            tabId: id,
          })
        }
        return results.map((result) => result !== null)
      },
      { filePath: documentPath, id: tabId }
    )

    expect(saved).toEqual([true, true])
    expect(await readFile(documentPath, "utf8")).toBe("Last save wins\n")
    await expect(page.getByLabel("Modified")).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})
