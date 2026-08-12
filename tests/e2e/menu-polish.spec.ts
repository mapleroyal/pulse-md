import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  test,
} from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const samplePath = path.join(projectRoot, "tests/fixtures/sample.md")

async function launchApplication(userData: string, filePath = samplePath) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  })
}

async function menuState(app: ElectronApplication) {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const find = menu?.getMenuItemById("edit-find")
    const shortcuts = menu?.getMenuItemById("help-keyboard-shortcuts")
    return {
      closeTabEnabled: menu?.getMenuItemById("file-close-tab")?.enabled ?? null,
      closeWindowEnabled:
        menu?.getMenuItemById("file-close-window")?.enabled ?? null,
      findEnabled: find?.enabled ?? null,
      findItems:
        find?.submenu?.items
          .filter(({ type }) => type !== "separator")
          .map(({ label }) => label) ?? [],
      licensesEnabled:
        menu?.getMenuItemById("help-software-licenses")?.enabled ?? null,
      formattingToolbarEnabled:
        menu?.getMenuItemById("view-formatting-bar")?.enabled ?? null,
      formatEnabled: menu?.getMenuItemById("format-menu")?.enabled ?? null,
      menuLabels: menu?.items.map(({ label }) => label) ?? [],
      modeEnabled: menu?.getMenuItemById("view-mode")?.enabled ?? null,
      modeLabel: menu?.getMenuItemById("view-mode")?.label ?? null,
      newTabEnabled: menu?.getMenuItemById("file-new-tab")?.enabled ?? null,
      newWindowEnabled:
        menu?.getMenuItemById("file-new-window")?.enabled ?? null,
      openEnabled: menu?.getMenuItemById("file-open")?.enabled ?? null,
      openRecentEnabled:
        menu?.getMenuItemById("file-open-recent")?.enabled ?? null,
      outlineEnabled: menu?.getMenuItemById("view-outline")?.enabled ?? null,
      outlineLabel: menu?.getMenuItemById("view-outline")?.label ?? null,
      redoEnabled: menu?.getMenuItemById("edit-redo")?.enabled ?? null,
      reopenEnabled:
        menu?.getMenuItemById("reopen-closed-document")?.enabled ?? null,
      saveAsEnabled: menu?.getMenuItemById("file-save-as")?.enabled ?? null,
      saveEnabled: menu?.getMenuItemById("file-save")?.enabled ?? null,
      selectAllEnabled:
        menu?.getMenuItemById("edit-select-all")?.enabled ?? null,
      settingsEnabled: menu?.getMenuItemById("app-settings")?.enabled ?? null,
      shortcutsEnabled: shortcuts?.enabled ?? null,
      shortcutsLabel: shortcuts?.label ?? null,
      statusBarEnabled:
        menu?.getMenuItemById("view-status-bar")?.enabled ?? null,
      tabsEnabled: menu?.getMenuItemById("view-tabs")?.enabled ?? null,
      undoEnabled: menu?.getMenuItemById("edit-undo")?.enabled ?? null,
      useSelectionForFindEnabled:
        menu?.getMenuItemById("edit-use-selection-for-find")?.enabled ?? null,
      zoomEnabled: menu?.getMenuItemById("zoom-in")?.enabled ?? null,
      zoomInEnabled: menu?.getMenuItemById("zoom-in")?.enabled ?? null,
      zoomOutEnabled: menu?.getMenuItemById("zoom-out")?.enabled ?? null,
      zoomResetEnabled: menu?.getMenuItemById("zoom-reset")?.enabled ?? null,
    }
  })
}

async function setWindowZoomFactor(
  app: ElectronApplication,
  zoomFactor: number
) {
  await app.evaluate(({ BrowserWindow, Menu }, factor) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) throw new Error("No window is focused")
    win.webContents.setZoomFactor(factor)
    Menu.getApplicationMenu()
      ?.items.find(({ label }) => label === "View")
      ?.submenu?.emit("menu-will-show")
  }, zoomFactor)
}

async function clickMenuItem(app: ElectronApplication, id: string) {
  await app.evaluate(({ BrowserWindow, Menu }, menuItemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(menuItemId)
    if (!item) throw new Error(`${menuItemId} is unavailable`)
    const win = BrowserWindow.getFocusedWindow()
    item.click(
      undefined,
      win ?? (undefined as never),
      win?.webContents ?? (undefined as never)
    )
  }, id)
}

test("application menus expose coherent commands and contextual document state", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-menu-polish-")
  )
  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await content.click()

    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        closeWindowEnabled: true,
        findItems: [
          "Find…",
          "Find Next",
          "Find Previous",
          "Use Selection for Find",
          "Find and Replace…",
        ],
        formatEnabled: true,
        formattingToolbarEnabled: true,
        licensesEnabled: true,
        menuLabels: expect.arrayContaining([
          "File",
          "Edit",
          "Format",
          "View",
          "Window",
          "Help",
        ]),
        modeEnabled: true,
        modeLabel: "Show Raw Markdown",
        newWindowEnabled: true,
        openRecentEnabled: true,
        outlineEnabled: true,
        outlineLabel: "Outline",
        saveAsEnabled: true,
        saveEnabled: false,
        shortcutsLabel: "Keyboard Shortcuts",
        undoEnabled: false,
        zoomEnabled: true,
      })
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Rendered"
    )

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home"
    )
    await page.keyboard.insertText("menu state\n")
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ saveEnabled: true, undoEnabled: true })

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("view-mode")
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Markdown view command is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Raw Markdown"
    )
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        modeLabel: "Show Rendered Markdown",
        undoEnabled: true,
      })

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("edit-undo")
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Undo is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect(content).not.toContainText("menu state")
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ saveEnabled: false, undoEnabled: false })

    const documentBeforeFormattingAttempt = await content.textContent()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+F" : "Control+F"
    )
    const findInput = page.getByRole("textbox", { name: "Find" })
    await expect(findInput).toBeFocused()
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ findEnabled: true, formatEnabled: false })
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.getMenuItemById("format-menu")
        ?.submenu?.items.find(({ label }) => label === "Bold")
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Bold is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect(content).toHaveText(documentBeforeFormattingAttempt ?? "")
    await expect(findInput).toBeFocused()
    await page.keyboard.press("Escape")
    await content.click()

    const primaryModifier = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(`${primaryModifier}+T`)
    await expect(page.getByRole("tab")).toHaveCount(2)
    await page.keyboard.press(`${primaryModifier}+W`)
    await expect(page.getByRole("tab")).toHaveCount(1)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ reopenEnabled: true })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    const settings = page.getByRole("dialog", { name: "Settings" })
    await expect(settings).toBeVisible()
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        closeTabEnabled: false,
        closeWindowEnabled: true,
        findEnabled: false,
        formatEnabled: false,
        formattingToolbarEnabled: false,
        licensesEnabled: false,
        modeEnabled: false,
        newTabEnabled: false,
        newWindowEnabled: false,
        openEnabled: false,
        openRecentEnabled: false,
        outlineEnabled: false,
        reopenEnabled: false,
        saveAsEnabled: false,
        saveEnabled: false,
        selectAllEnabled: true,
        settingsEnabled: false,
        shortcutsEnabled: true,
        statusBarEnabled: false,
        tabsEnabled: false,
        zoomEnabled: true,
      })

    await settings.getByRole("button", { name: "Customize typography" }).click()
    const typography = page.getByRole("region", {
      name: "Typography preview workspace",
    })
    await expect(typography).toBeVisible()
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        closeTabEnabled: false,
        closeWindowEnabled: true,
        findEnabled: false,
        formatEnabled: false,
        newTabEnabled: false,
        newWindowEnabled: false,
        openEnabled: false,
        openRecentEnabled: false,
        reopenEnabled: false,
        saveAsEnabled: false,
        shortcutsEnabled: false,
        zoomEnabled: false,
      })
    await typography.getByRole("button", { name: "Cancel" }).click()
    await settings.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Software Licenses shows app, runtime, and direct package licenses", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-software-licenses-")
  )
  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await content.click()

    await clickMenuItem(app, "help-software-licenses")
    const dialog = page.getByRole("dialog", { name: "Software Licenses" })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByRole("heading", { name: "Pulse MD", exact: true })
    ).toBeVisible()
    await expect(dialog.locator("pre")).toContainText(
      "PolyForm Noncommercial License 1.0.0"
    )
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        licensesEnabled: false,
        settingsEnabled: false,
        shortcutsEnabled: false,
        zoomEnabled: false,
      })

    await dialog
      .getByRole("searchbox", { name: "Filter software licenses" })
      .fill("BoringSSL")
    await expect(dialog.getByText("No matching licenses.")).toBeVisible()

    await dialog
      .getByRole("searchbox", { name: "Filter software licenses" })
      .fill("react")
    await dialog.locator('[data-license-entry^="react@"]').click()
    await expect(
      dialog.getByRole("heading", { name: "react", exact: true })
    ).toBeVisible()
    await expect(dialog.locator("pre")).toContainText("MIT License")

    await dialog.getByRole("button", { name: "Close" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(content).toBeFocused()
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ licensesEnabled: true, settingsEnabled: true })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Find selection and zoom menu items track their exact usable state", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-contextual-menu-")
  )
  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    const content = page.locator(".cm-content")
    await content.waitFor()
    await content.click()
    await setWindowZoomFactor(app, 1)

    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        useSelectionForFindEnabled: false,
        zoomInEnabled: true,
        zoomOutEnabled: true,
        zoomResetEnabled: false,
      })

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home"
    )
    await page.keyboard.press("Shift+ArrowRight")
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ useSelectionForFindEnabled: true })
    await page.keyboard.press("ArrowLeft")
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ useSelectionForFindEnabled: false })

    await setWindowZoomFactor(app, 2)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        zoomInEnabled: false,
        zoomOutEnabled: true,
        zoomResetEnabled: true,
      })

    await setWindowZoomFactor(app, 0.75)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        zoomInEnabled: true,
        zoomOutEnabled: false,
        zoomResetEnabled: true,
      })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Open and Settings create a usable macOS window when none exists", async () => {
  test.skip(
    process.platform !== "darwin",
    "macOS keeps the app open windowless"
  )
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-windowless-menu-")
  )
  const app = await launchApplication(userData)
  try {
    const initialPage = await app.firstWindow()
    await initialPage.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect.poll(() => app.windows().length).toBe(0)

    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selectedPath],
      })) as typeof dialog.showOpenDialog
    }, samplePath)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        closeTabEnabled: false,
        closeWindowEnabled: false,
        findEnabled: false,
        formatEnabled: false,
        formattingToolbarEnabled: false,
        modeEnabled: false,
        newTabEnabled: true,
        newWindowEnabled: true,
        openEnabled: true,
        outlineEnabled: false,
        redoEnabled: false,
        saveAsEnabled: false,
        saveEnabled: false,
        settingsEnabled: true,
        shortcutsEnabled: true,
        statusBarEnabled: false,
        tabsEnabled: false,
        undoEnabled: false,
        zoomEnabled: false,
      })

    await clickMenuItem(app, "file-new-tab")
    await expect.poll(() => app.windows().length).toBe(1)
    const newTabPage = app.windows()[0]!
    await newTabPage.locator(".cm-editor").waitFor()
    await expect(newTabPage.getByRole("tab")).toHaveCount(1)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect.poll(() => app.windows().length).toBe(0)

    await clickMenuItem(app, "file-open")
    await expect.poll(() => app.windows().length).toBe(1)
    const openedPage = app.windows()[0]!
    await expect(openedPage.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect.poll(() => app.windows().length).toBe(0)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ settingsEnabled: true })
    await clickMenuItem(app, "app-settings")
    await expect.poll(() => app.windows().length).toBe(1)
    await expect(
      app.windows()[0]!.getByRole("dialog", { name: "Settings" })
    ).toBeVisible()

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect.poll(() => app.windows().length).toBe(0)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({ shortcutsEnabled: true })
    await clickMenuItem(app, "help-keyboard-shortcuts")
    await expect.poll(() => app.windows().length).toBe(1)
    await expect(
      app.windows()[0]!.locator("[data-keyboard-shortcuts-detail]")
    ).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("recovery disables document commands while Close Window remains truthful", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-recovery-menu-")
  )
  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() =>
      window.pulseMd.showRecovery("Injected menu recovery")
    )
    await expect(page).toHaveURL(/\/recovery\.html/)
    await expect
      .poll(() => menuState(app))
      .toMatchObject({
        closeTabEnabled: false,
        closeWindowEnabled: true,
        findEnabled: false,
        formatEnabled: false,
        modeEnabled: false,
        newTabEnabled: false,
        newWindowEnabled: false,
        openEnabled: false,
        openRecentEnabled: false,
        saveAsEnabled: false,
        settingsEnabled: false,
        shortcutsEnabled: false,
        zoomEnabled: false,
      })
    await clickMenuItem(app, "file-close-window")
    await expect.poll(() => app.windows().length).toBe(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
