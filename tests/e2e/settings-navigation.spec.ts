import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import {
  createSettingsArchive,
  parseSettingsArchive,
} from "../../electron/settings-archive"
import {
  exitApplication,
  openSettingsSection,
  waitForApplicationClose,
} from "./electron-helpers"
import { seedScratchStore } from "./scratch-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const settingsShortcut = process.platform === "darwin" ? "Meta+," : "Control+,"

async function launchApplication(userData: string, ...filePaths: string[]) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, ...filePaths],
    cwd: projectRoot,
  })
}

async function openAdditionalWindow(app: ElectronApplication) {
  const existingWindows = new Set(app.windows())
  const existingWindowIds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.id)
  )
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
  const windowId = await app.evaluate(({ BrowserWindow }, previousIds) => {
    const created = BrowserWindow.getAllWindows().find(
      (candidate) => !previousIds.includes(candidate.id)
    )
    if (!created) throw new Error("The additional native window was not found")
    return created.id
  }, existingWindowIds)
  return { page: window, windowId }
}

async function launchProfileWindow(
  app: ElectronApplication,
  source: Page,
  profileId: string
): Promise<Page> {
  const existingWindows = new Set(app.windows())
  await source.evaluate(
    (id) => window.pulseMd.launchWindowProfile(id),
    profileId
  )
  await expect.poll(() => app.windows().length).toBe(existingWindows.size + 1)
  const profilePage = app
    .windows()
    .find((candidate) => !existingWindows.has(candidate))
  if (!profilePage) {
    throw new Error(`Profile ${profileId} did not open a window`)
  }
  await profilePage.locator(".cm-editor").waitFor()
  return profilePage
}

async function navigateWithMouseButton(
  app: ElectronApplication,
  page: Page,
  direction: "back" | "forward"
) {
  if (process.platform === "darwin") {
    await page.evaluate((requestedDirection) => {
      const button = requestedDirection === "back" ? 3 : 4
      window.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button,
          buttons: button === 3 ? 8 : 16,
          cancelable: true,
          view: window,
        })
      )
    }, direction)
    return
  }

  await app.evaluate(({ BrowserWindow }, requestedDirection) => {
    const window =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error("App window was not found")
    window.emit(
      "app-command",
      { preventDefault() {} } as never,
      requestedDirection === "back" ? "browser-backward" : "browser-forward"
    )
  }, direction)
}

async function routeSettingsDialogs(
  app: ElectronApplication,
  paths: { importPath: string; exportPath: string }
) {
  await app.evaluate(({ dialog }, selectedPaths) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: selectedPaths.exportPath,
    })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [selectedPaths.importPath],
    })) as typeof dialog.showOpenDialog
  }, paths)
}

test("background readiness is opt-in and persists from Settings", async () => {
  test.skip(process.platform !== "darwin", "macOS-only setting")
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-background-readiness-e2e-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    const keepReady = settings.getByRole("switch", {
      name: "Keep ready in background",
    })
    await expect(keepReady).not.toBeChecked()
    await expect(settings).toContainText("keeps it ready after Command-Q")

    await keepReady.click()
    await settings.getByRole("button", { name: "Done" }).click()
    await expect(settings).toHaveCount(0)
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { keepReadyInBackground: boolean }
        return persisted.keepReadyInBackground
      })
      .toBe(true)
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => ({
          close: Menu.getApplicationMenu()?.getMenuItemById(
            "app-close-keep-ready"
          )?.accelerator,
          complete: Menu.getApplicationMenu()?.getMenuItemById(
            "app-quit-completely"
          )?.accelerator,
        }))
      )
      .toEqual({ close: "Cmd+Q", complete: "Alt+Cmd+Q" })

    await page.keyboard.press(settingsShortcut)
    const reopened = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    await expect(
      reopened.getByRole("switch", { name: "Keep ready in background" })
    ).toBeChecked()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("opted-in Command-Q backgrounds the app and complete quit terminates it", async () => {
  test.skip(process.platform !== "darwin", "macOS-only behavior")
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-background-command-quit-e2e-")
  )
  const documentPath = path.join(userData, "keep-ready-cancel.md")
  await writeFile(documentPath, "")
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify({
      ...cloneAppSettings(DEFAULT_APP_SETTINGS),
      keepReadyInBackground: true,
    })}\n`
  )
  const app = await launchApplication(userData, documentPath)
  let terminated = false

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => {
          const menu = Menu.getApplicationMenu()
          const closeReady = menu?.getMenuItemById("app-close-keep-ready")
          const complete = menu?.getMenuItemById("app-quit-completely")
          return {
            closeAccelerator: closeReady?.accelerator,
            closeLabel: closeReady?.label,
            completeAccelerator: complete?.accelerator,
            completeLabel: complete?.label,
          }
        })
      )
      .toEqual({
        closeAccelerator: "Cmd+Q",
        closeLabel: "Close & Keep Ready",
        completeAccelerator: "Alt+Cmd+Q",
        completeLabel: "Quit Pulse MD Development Completely",
      })

    await page.locator(".cm-content").focus()
    await page.keyboard.type("Unsaved work")
    await expect(page.getByLabel("Modified")).toHaveCount(1)
    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        keepReadyCancelObserved?: boolean
      }
      const originalShowMessageBox = dialog.showMessageBox.bind(dialog)
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (
          options.title === "Unsaved Changes" &&
          !testGlobal.keepReadyCancelObserved
        ) {
          testGlobal.keepReadyCancelObserved = true
          return { checkboxChecked: false, response: 2 }
        }
        return await originalShowMessageBox(
          ...(args as Parameters<typeof dialog.showMessageBox>)
        )
      }) as typeof dialog.showMessageBox
    })

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "app-close-keep-ready"
      )
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Close & Keep Ready is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                keepReadyCancelObserved?: boolean
              }
            ).keepReadyCancelObserved
          )
        )
      )
      .toBe(true)
    await expect(page.locator(".cm-editor")).toBeVisible()
    await expect
      .poll(() => app.evaluate(({ app }) => app.isHidden()))
      .toBe(false)

    await page.locator(".cm-content").focus()
    await page.keyboard.press("Meta+A")
    await page.keyboard.press("Backspace")
    await expect(page.getByLabel("Modified")).toHaveCount(0)

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "app-close-keep-ready"
      )
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Close & Keep Ready is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect.poll(() => app.windows().length).toBe(0)
    await expect
      .poll(() => app.evaluate(({ app }) => app.isHidden()))
      .toBe(true)

    const reopenedWindow = app.waitForEvent("window")
    await app.evaluate(({ app }) => app.emit("activate"))
    const reopened = await reopenedWindow
    await reopened.locator(".cm-editor").waitFor()
    await expect
      .poll(() => app.evaluate(({ app }) => app.isHidden()))
      .toBe(false)

    const closed = waitForApplicationClose(app)
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "app-quit-completely"
      )
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Complete quit is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await closed
    terminated = true
  } finally {
    if (!terminated) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Settings export drafts and import previews before a validated replacement", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-transfer-")
  )
  const userData = path.join(testDirectory, "user-data")
  const exportPath = path.join(testDirectory, "exported-settings.zip")
  const importPath = path.join(testDirectory, "imported-settings.zip")
  const invalidPath = path.join(testDirectory, "invalid-settings.json")
  const importedSettings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  importedSettings.maxContentWidth = 1234
  importedSettings.lineWrapping = false
  await Promise.all([
    writeFile(
      importPath,
      await createSettingsArchive({ settings: importedSettings })
    ),
    writeFile(invalidPath, '{"not":"pulse-md-settings"}\n'),
  ])
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    const contentWidth = settings.getByLabel("Maximum content width in pixels")
    await contentWidth.fill("1111")

    await routeSettingsDialogs(app, { exportPath, importPath })
    await settings.getByRole("button", { name: "Export settings" }).click()
    await expect(
      settings
        .getByRole("region", { name: "Import & Export" })
        .getByRole("status")
    ).toContainText("Exported exported-settings.zip")
    const exported = await parseSettingsArchive(await readFile(exportPath))
    expect(exported.settings).toMatchObject({ maxContentWidth: 1111 })

    await routeSettingsDialogs(app, {
      exportPath,
      importPath: invalidPath,
    })
    await settings.getByRole("button", { name: "Import settings" }).click()
    await expect(settings.getByRole("alert")).toContainText(
      "valid Pulse MD settings export"
    )
    await expect(contentWidth).toHaveValue("1111")

    await routeSettingsDialogs(app, { exportPath, importPath })
    await settings.getByRole("button", { name: "Import settings" }).click()
    await expect(
      settings
        .getByRole("region", { name: "Import & Export" })
        .getByRole("status")
    ).toContainText("Review the settings, then choose Done to save")
    await expect(contentWidth).toHaveValue("1234")
    await expect(
      readFile(path.join(userData, "settings.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })

    await settings.getByRole("button", { name: "Cancel" }).click()
    await expect(settings).toHaveCount(0)
    await page.keyboard.press(settingsShortcut)
    const reopened = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    await expect(
      reopened.getByLabel("Maximum content width in pixels")
    ).toHaveValue(String(DEFAULT_APP_SETTINGS.maxContentWidth))

    await routeSettingsDialogs(app, { exportPath, importPath })
    await reopened.getByRole("button", { name: "Import settings" }).click()
    await expect(
      reopened.getByLabel("Maximum content width in pixels")
    ).toHaveValue("1234")
    await reopened.getByRole("button", { name: "Done" }).click()
    await expect(reopened).toHaveCount(0)
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { lineWrapping: boolean; maxContentWidth: number }
        return {
          lineWrapping: persisted.lineWrapping,
          maxContentWidth: persisted.maxContentWidth,
        }
      })
      .toEqual({ lineWrapping: false, maxContentWidth: 1234 })
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Settings X, backdrop, and Escape all discard the current draft", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-dismissal-e2e-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const openAndEditWidth = async (width: string) => {
      await page.keyboard.press(settingsShortcut)
      const settings = page.getByRole("dialog", { name: "Settings" })
      await openSettingsSection(page, "Miscellaneous")
      await settings.getByLabel("Maximum content width in pixels").fill(width)
      return settings
    }
    const expectDefaultWidth = async () => {
      await page.keyboard.press(settingsShortcut)
      const settings = page.getByRole("dialog", { name: "Settings" })
      await openSettingsSection(page, "Miscellaneous")
      await expect(
        settings.getByLabel("Maximum content width in pixels")
      ).toHaveValue(String(DEFAULT_APP_SETTINGS.maxContentWidth))
      return settings
    }

    let settings = await openAndEditWidth("1111")
    await settings.getByRole("button", { name: "Close" }).click()
    settings = await expectDefaultWidth()
    await settings.getByRole("button", { name: "Cancel" }).click()

    settings = await openAndEditWidth("1222")
    await page
      .locator('[data-slot="dialog-overlay"]')
      .click({ position: { x: 1, y: 1 } })
    settings = await expectDefaultWidth()
    await settings.getByRole("button", { name: "Cancel" }).click()

    settings = await openAndEditWidth("1333")
    await page.keyboard.press("Escape")
    settings = await expectDefaultWidth()
    await settings.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Settings search reveals matching controls across collapsed sections", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-search-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    const search = settings.getByRole("searchbox", { name: "Search settings" })
    await expect(search).toBeFocused()

    await search.fill("Mermaid diagrams")
    await expect(
      settings.getByRole("button", { name: "Extensions", exact: true })
    ).toHaveAttribute("aria-expanded", "true")
    await expect(
      settings.getByRole("switch", { name: "Mermaid Diagrams" })
    ).toBeVisible()
    await expect(
      settings.getByRole("button", { name: "Theme", exact: true })
    ).toBeHidden()

    await search.fill(
      process.platform === "win32" ? "top left find" : "top right find"
    )
    await expect(
      settings.getByRole("switch", { name: "Find", exact: true })
    ).toBeVisible()
    for (const unrelatedControl of [
      "All Controls",
      "Back and Forward",
      "View Mode",
      "Document Outline",
      "Formatting Toolbar",
      "Settings",
    ]) {
      await expect(
        settings.getByRole("switch", {
          name: unrelatedControl,
          exact: true,
        })
      ).toBeHidden()
    }
    await expect(settings.getByRole("status")).toHaveText("1 setting found.")
    await expect(
      settings.getByText(
        "Navigate document history when a destination is available."
      )
    ).toHaveCount(0)

    await search.fill("not a real pulse setting")
    await expect(settings.getByText("No matching settings.")).toBeVisible()

    await search.fill("")
    await expect(
      settings.getByRole("button", { name: "Theme", exact: true })
    ).toBeVisible()
    await expect(settings.getByText("No matching settings.")).toBeHidden()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Settings transfers profiles and scratches by default and can omit them", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-resources-")
  )
  const userData = path.join(testDirectory, "user-data")
  const exportPath = path.join(testDirectory, "complete-export.zip")
  const settingsOnlyExportPath = path.join(
    testDirectory,
    "settings-only-export.json"
  )
  const importPath = path.join(testDirectory, "restore.zip")
  const settingsOnlyImportPath = path.join(
    testDirectory,
    "settings-only-restore.zip"
  )
  const existingScratchId = "10000000-0000-4000-8000-000000000101"
  const restoredScratchId = "10000000-0000-4000-8000-000000000102"
  const looseScratchId = "10000000-0000-4000-8000-000000000103"
  const skippedScratchId = "10000000-0000-4000-8000-000000000104"
  const existingProfile = {
    version: 2,
    id: "existing",
    name: "Existing",
    activeTab: "notes",
    tabVisibility: "always",
    tabs: [{ id: "notes", kind: "scratch", scratchId: existingScratchId }],
  } as const
  const restoredProfile = {
    version: 2,
    id: "restored",
    name: "Restored",
    activeTab: "journal",
    tabVisibility: "always",
    tabs: [{ id: "journal", kind: "scratch", scratchId: restoredScratchId }],
  } as const
  const importedSettings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  importedSettings.defaultWindowProfileId = restoredProfile.id
  const skippedProfile = {
    ...restoredProfile,
    id: "skipped",
    name: "Skipped",
    tabs: [{ id: "journal", kind: "scratch", scratchId: skippedScratchId }],
  } as const
  const settingsOnlyImport = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settingsOnlyImport.defaultWindowProfileId = skippedProfile.id

  const [completeImport, settingsOnlyImportArchive] = await Promise.all([
    createSettingsArchive({
      settings: importedSettings,
      profiles: [{ id: restoredProfile.id, data: restoredProfile }],
      scratches: [
        {
          content: Buffer.from("# Restored journal\n"),
          createdAt: 1_725_000_000_000,
          fileName: "restored-journal.md",
          id: restoredScratchId,
          lastOpenedAt: null,
          modifiedAt: 1_725_000_000_100,
          title: "Restored Journal",
        },
        {
          content: Buffer.from("# Restored loose scratch\n"),
          createdAt: 1_725_000_000_200,
          fileName: "restored-loose.md",
          id: looseScratchId,
          lastOpenedAt: null,
          modifiedAt: 1_725_000_000_300,
          title: null,
        },
      ],
    }),
    createSettingsArchive({
      settings: settingsOnlyImport,
      profiles: [{ id: skippedProfile.id, data: skippedProfile }],
      scratches: [
        {
          content: Buffer.from("# Must stay staged\n"),
          createdAt: 1_725_000_000_400,
          fileName: "skipped.md",
          id: skippedScratchId,
          lastOpenedAt: null,
          modifiedAt: 1_725_000_000_500,
          title: null,
        },
      ],
    }),
  ])
  await mkdir(path.join(userData, "cli-profiles"), { recursive: true })
  await seedScratchStore(userData, [
    {
      content: "# Existing notes\n",
      fileName: "existing-notes.md",
      id: existingScratchId,
      title: "Existing Notes",
    },
  ])
  await Promise.all([
    writeFile(importPath, completeImport),
    writeFile(settingsOnlyImportPath, settingsOnlyImportArchive),
    writeFile(
      path.join(userData, "cli-profiles", "existing.json"),
      `${JSON.stringify(existingProfile, null, 2)}\n`
    ),
  ])

  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    const importExportTrigger = settings.getByRole("button", {
      name: "Import & Export",
      exact: true,
    })
    const windowProfilesTrigger = settings.getByRole("button", {
      name: "Window Profiles",
      exact: true,
    })
    const transferContents = settings.getByRole("group", {
      name: "Transfer contents",
    })
    await expect(importExportTrigger).toHaveAttribute("aria-expanded", "false")
    await expect(windowProfilesTrigger).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    await expect(
      settings.getByRole("button", { name: "Import settings" })
    ).toBeVisible()
    await expect(
      settings.getByRole("button", { name: "Export settings" })
    ).toBeVisible()
    await expect(
      settings.getByRole("button", { name: "Launch Window Profile" })
    ).toBeVisible()
    await expect(
      settings.getByRole("button", { name: "Manage Window Profiles" })
    ).toBeVisible()
    await expect(transferContents).toBeHidden()
    await expect(
      settings.getByRole("combobox", { name: "Always Launch With" })
    ).toBeHidden()
    await openSettingsSection(page, "Import & Export")
    const profilesToggle = transferContents.getByRole("switch", {
      name: "Window Profiles",
    })
    const scratchesToggle = transferContents.getByRole("switch", {
      name: "Scratches",
    })
    await expect(profilesToggle).toBeChecked()
    await expect(scratchesToggle).toBeChecked()

    await routeSettingsDialogs(app, { exportPath, importPath })
    await settings.getByRole("button", { name: "Export settings" }).click()
    await expect(
      settings
        .getByRole("region", { name: "Import & Export" })
        .getByRole("status")
    ).toContainText("Exported complete-export.zip")
    const completeExport = await parseSettingsArchive(
      await readFile(exportPath)
    )
    expect(completeExport.profiles.map(({ id }) => id)).toEqual(["existing"])
    expect(completeExport.scratches).toHaveLength(1)
    expect(completeExport.scratches[0]).toMatchObject({
      fileName: "existing-notes.md",
      id: existingScratchId,
      title: "Existing Notes",
    })
    expect(completeExport.scratches[0]!.content.toString("utf8")).toBe(
      "# Existing notes\n"
    )

    await profilesToggle.click()
    await scratchesToggle.click()
    await routeSettingsDialogs(app, {
      exportPath: settingsOnlyExportPath,
      importPath,
    })
    await settings.getByRole("button", { name: "Export settings" }).click()
    await expect(
      settings
        .getByRole("region", { name: "Import & Export" })
        .getByRole("status")
    ).toContainText("Exported settings-only-export.json")
    const settingsOnlyExport = JSON.parse(
      await readFile(settingsOnlyExportPath, "utf8")
    ) as Record<string, unknown>
    expect(settingsOnlyExport).not.toHaveProperty("profiles")
    expect(settingsOnlyExport).not.toHaveProperty("scratches")

    await profilesToggle.click()
    await scratchesToggle.click()
    await routeSettingsDialogs(app, { exportPath, importPath })
    await settings.getByRole("button", { name: "Import settings" }).click()
    await expect(
      settings
        .getByRole("region", { name: "Import & Export" })
        .getByRole("status")
    ).toContainText("1 profile and 2 scratches")
    await expect(
      settings.getByRole("button", { name: "Launch Window Profile" })
    ).toBeDisabled()
    await expect(
      settings.getByRole("button", { name: "Manage Window Profiles" })
    ).toBeDisabled()
    await expect(
      settings.getByRole("button", { name: "Export settings" })
    ).toBeDisabled()
    await expect(
      settings.getByRole("button", { name: "Customize typography" })
    ).toBeDisabled()
    await openSettingsSection(page, "Window Profiles")
    const defaultProfile = settings.getByRole("combobox", {
      name: "Always Launch With",
    })
    await expect(defaultProfile).toContainText("Restored")
    await profilesToggle.click()
    await expect(defaultProfile).toContainText("Standard Empty Window")
    await profilesToggle.click()
    await expect(defaultProfile).toContainText("Restored")
    await expect(
      readFile(path.join(userData, "scratch", "restored-journal.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({
        canceled: true,
        filePaths: [],
      })) as typeof dialog.showOpenDialog
    })
    await settings.getByRole("button", { name: "Import settings" }).click()

    await settings.getByRole("button", { name: "Done" }).click()
    await expect(settings).toHaveCount(0)
    await expect
      .poll(() =>
        readFile(path.join(userData, "scratch", "restored-journal.md"), "utf8")
      )
      .toBe("# Restored journal\n")
    await expect(
      readFile(path.join(userData, "scratch", "restored-loose.md"), "utf8")
    ).resolves.toBe("# Restored loose scratch\n")
    await expect(
      readFile(path.join(userData, "cli-profiles", "restored.json"), "utf8")
    ).resolves.toContain('"id": "restored"')
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { defaultWindowProfileId: string | null }
        return saved.defaultWindowProfileId
      })
      .toBe("restored")

    await page.keyboard.press(settingsShortcut)
    const settingsOnlyDialog = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Import & Export")
    const settingsOnlyContents = settingsOnlyDialog.getByRole("group", {
      name: "Transfer contents",
    })
    await routeSettingsDialogs(app, {
      exportPath,
      importPath: settingsOnlyImportPath,
    })
    await settingsOnlyDialog
      .getByRole("button", { name: "Import settings" })
      .click()
    await settingsOnlyContents
      .getByRole("switch", { name: "Window Profiles" })
      .click()
    await settingsOnlyContents
      .getByRole("switch", { name: "Scratches" })
      .click()
    await settingsOnlyDialog.getByRole("button", { name: "Done" }).click()
    await expect(settingsOnlyDialog).toHaveCount(0)
    await expect(
      readFile(path.join(userData, "cli-profiles", "skipped.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      readFile(path.join(userData, "scratch", "skipped.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { defaultWindowProfileId: string | null }
        return saved.defaultWindowProfileId
      })
      .toBeNull()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("Settings export snapshots unsaved scratches from every owning window", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-live-scratches-")
  )
  const userData = path.join(testDirectory, "user-data")
  const exportPath = path.join(testDirectory, "live-scratches.zip")
  const profileDirectory = path.join(userData, "cli-profiles")
  const scratchDirectory = path.join(userData, "scratch")
  const writingScratchId = "10000000-0000-4000-8000-000000000111"
  const freshScratchId = "10000000-0000-4000-8000-000000000112"
  const storedContent = "# Stored notes\n"
  const liveContent = "# Unsaved editor notes\n"
  const profiles = [
    {
      version: 2,
      id: "writing",
      name: "Writing",
      activeTab: "notes",
      tabVisibility: "always",
      tabs: [
        {
          id: "notes",
          kind: "scratch",
          scratchId: writingScratchId,
          title: "Notes",
        },
      ],
    },
    {
      version: 2,
      id: "fresh",
      name: "Fresh",
      activeTab: "new",
      tabVisibility: "always",
      tabs: [
        {
          id: "new",
          kind: "scratch",
          scratchId: freshScratchId,
          title: "New Scratch",
        },
      ],
    },
  ] as const
  await mkdir(profileDirectory, { recursive: true })
  await seedScratchStore(userData, [
    {
      content: storedContent,
      fileName: "writing-notes.md",
      id: writingScratchId,
      title: "Notes",
    },
    {
      content: "",
      fileName: "fresh-notes.md",
      id: freshScratchId,
      title: "New Scratch",
    },
  ])
  await Promise.all([
    ...profiles.map((profile) =>
      writeFile(
        path.join(profileDirectory, `${profile.id}.json`),
        `${JSON.stringify(profile, null, 2)}\n`
      )
    ),
  ])

  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await source.locator(".cm-content").click()
    await source.keyboard.insertText("Keep this ordinary window")

    const writing = await launchProfileWindow(app, source, "writing")
    const fresh = await launchProfileWindow(app, source, "fresh")
    await expect(fresh.locator(".cm-content")).toHaveText("")
    await expect(
      fresh.locator('.document-tab[data-active] [role="tab"]')
    ).not.toHaveAccessibleName(/modified/i)

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:save-document")
      ipcMain.handle("pulse-md:save-document", async () => null)
    })
    await writing.locator(".cm-content").click()
    await writing.keyboard.press(
      process.platform === "darwin" ? "Meta+a" : "Control+a"
    )
    await writing.keyboard.insertText(liveContent)
    await expect(
      writing.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAccessibleName(/modified/i)
    await writing.evaluate(() => window.pulseMd.getWindowProfiles())

    await source.bringToFront()
    await source.keyboard.press(settingsShortcut)
    const settings = source.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(source, "Miscellaneous")
    await routeSettingsDialogs(app, {
      exportPath,
      importPath: exportPath,
    })
    await settings.getByRole("button", { name: "Export settings" }).click()
    await expect(
      settings
        .getByRole("region", { name: "Import & Export" })
        .getByRole("status")
    ).toContainText("Exported live-scratches.zip")

    const exported = await parseSettingsArchive(await readFile(exportPath))
    expect(
      exported.scratches.map(({ content, id }) => ({
        content: content.toString("utf8"),
        id,
      }))
    ).toEqual([
      { content: "", id: freshScratchId },
      { content: liveContent, id: writingScratchId },
    ])
    await expect(
      readFile(path.join(scratchDirectory, "writing-notes.md"), "utf8")
    ).resolves.toBe(storedContent)
    await expect(
      readFile(path.join(scratchDirectory, "fresh-notes.md"), "utf8")
    ).resolves.toBe("")
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("mouse history traverses Settings and Keyboard Shortcuts", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-mouse-history-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)

    const settings = page.getByRole("dialog", { name: "Settings" })
    const shortcutButton = settings.getByRole("button", {
      name: "View keyboard shortcuts",
    })
    await shortcutButton.scrollIntoViewIfNeeded()
    await shortcutButton.click()
    const shortcuts = page.getByRole("dialog", {
      name: "Keyboard Shortcuts",
    })
    await expect(shortcuts).toBeVisible()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "help-keyboard-shortcuts"
      )
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Keyboard Shortcuts is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect(shortcuts).toBeVisible()

    await navigateWithMouseButton(app, page, "back")
    await expect(settings).toBeVisible()
    await expect(shortcuts).toHaveCount(0)
    await expect(shortcutButton).toBeFocused()

    await navigateWithMouseButton(app, page, "forward")
    await expect(shortcuts).toBeVisible()
    await expect(
      shortcuts.getByRole("searchbox", { name: "Search keyboard shortcuts" })
    ).toBeFocused()
    const findNext = shortcuts
      .locator("dl > div")
      .filter({ hasText: "Find next" })
    const findPrevious = shortcuts
      .locator("dl > div")
      .filter({ hasText: "Find previous" })
    const findAndReplace = shortcuts
      .locator("dl > div")
      .filter({ hasText: "Open Find and Replace" })
    await expect(findNext).toBeVisible()
    await expect(findPrevious).toBeVisible()
    await expect(findAndReplace).toBeVisible()
    await expect(findNext.locator("kbd")).toHaveText(
      process.platform === "darwin" ? ["⌘", "G"] : ["F3"]
    )
    await expect(findPrevious.locator("kbd")).toHaveText(
      process.platform === "darwin" ? ["⇧", "⌘", "G"] : ["Shift", "F3"]
    )
    await expect(findAndReplace.locator("kbd")).toHaveText(
      process.platform === "darwin" ? ["⌘", "⌥", "F"] : ["Ctrl", "H"]
    )
    if (process.platform === "darwin") {
      const selectionForFind = shortcuts
        .locator("dl > div")
        .filter({ hasText: "Use selection for Find" })
      await expect(selectionForFind).toBeVisible()
      await expect(selectionForFind.locator("kbd")).toHaveText(["⌘", "E"])
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("mouse history preserves a Window Profile composer and respects modal guards", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-profile-mouse-history-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)

    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()
    const workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await expect(workspace).toBeVisible()
    await workspace.getByRole("button", { name: "New Profile" }).click()
    const profileName = workspace.getByLabel("Profile Name")
    await profileName.fill("Remember This Draft")

    await navigateWithMouseButton(app, page, "back")
    await expect(
      workspace.getByRole("heading", { name: "Window Profiles" })
    ).toBeVisible()
    await expect(profileName).toHaveCount(0)

    await navigateWithMouseButton(app, page, "back")
    await expect(settings).toBeVisible()
    await expect(workspace).toHaveCount(0)
    await openSettingsSection(page, "Theme")
    const appearanceMode = settings.getByRole("radiogroup", {
      name: "Appearance mode",
    })
    await appearanceMode.getByRole("radio", { name: "Dark" }).click()

    await navigateWithMouseButton(app, page, "forward")
    await expect(workspace).toBeVisible()
    await expect(
      workspace.getByRole("heading", { name: "Window Profiles" })
    ).toBeVisible()

    await navigateWithMouseButton(app, page, "forward")
    await expect(
      workspace.getByRole("heading", { name: "Compose Window Profile" })
    ).toBeVisible()
    await expect(workspace.getByLabel("Profile Name")).toHaveValue(
      "Remember This Draft"
    )

    await navigateWithMouseButton(app, page, "back")
    await workspace.getByRole("button", { name: "New Profile" }).click()
    await expect(workspace.getByLabel("Profile Name")).toHaveValue("")
    await navigateWithMouseButton(app, page, "forward")
    await expect(workspace.getByLabel("Profile Name")).toHaveValue("")

    await workspace.getByLabel("Profile Name").fill("Blocked Profile")
    await workspace.getByRole("button", { name: "Add Tab" }).first().click()
    await workspace.getByRole("button", { name: "Save Profile" }).click()
    await expect(
      workspace.getByRole("heading", { name: "Blocked Profile" })
    ).toBeVisible()

    await workspace
      .getByRole("button", { name: "Delete Profile Blocked Profile" })
      .click()
    const confirmation = page.getByRole("alertdialog", {
      name: "Delete Profile?",
    })
    await expect(confirmation).toBeVisible()
    await navigateWithMouseButton(app, page, "back")
    await expect(confirmation).toBeVisible()
    await expect(
      page.locator('[aria-label="Window Profiles Workspace"]')
    ).toBeAttached()
    await confirmation.getByRole("button", { name: "Cancel" }).click()
    await expect(workspace).toBeVisible()

    await navigateWithMouseButton(app, page, "back")
    await expect(settings).toBeVisible()
    await expect(
      appearanceMode.getByRole("radio", { name: "Dark" })
    ).toHaveAttribute("aria-checked", "true")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a focus refresh completes the initial Window Profiles load", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-profile-focus-refresh-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const snapshot = await page.evaluate(() =>
      window.pulseMd.getWindowProfiles()
    )
    await app.evaluate(({ ipcMain }, profilesSnapshot) => {
      const testGlobal = globalThis as typeof globalThis & {
        windowProfileLoadRequests?: number
      }
      testGlobal.windowProfileLoadRequests = 0
      ipcMain.removeHandler("pulse-md:get-window-profiles")
      ipcMain.handle("pulse-md:get-window-profiles", async () => {
        testGlobal.windowProfileLoadRequests =
          (testGlobal.windowProfileLoadRequests ?? 0) + 1
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        return profilesSnapshot
      })
    }, snapshot)

    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()

    const workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    const newProfile = workspace.getByRole("button", { name: "New Profile" })
    await expect(newProfile).toBeDisabled()
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                windowProfileLoadRequests?: number
              }
            ).windowProfileLoadRequests ?? 0
        )
      )
      .toBeGreaterThanOrEqual(3)
    await expect(newProfile).toBeEnabled({ timeout: 3_000 })
    await expect(
      workspace.getByRole("button", { name: "Back to Settings" })
    ).toBeEnabled()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("the lazy Settings fallback is a body-level modal with a contained focus loop", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-fallback-modal-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ ipcMain, session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        {
          urls: [
            "pulse-md://bundle/assets/SettingsDialog-*",
            "pulse-md://bundle/assets/TypographyPreviewWorkspace-*",
          ],
        },
        (_details, callback) => {
          setTimeout(() => callback({}), 2_000)
        }
      )
      const testGlobal = globalThis as typeof globalThis & {
        settingsFallbackSaveAttempts?: number
      }
      testGlobal.settingsFallbackSaveAttempts = 0
      ipcMain.removeHandler("pulse-md:set-settings")
      ipcMain.handle("pulse-md:set-settings", async (_event, settings) => {
        testGlobal.settingsFallbackSaveAttempts =
          (testGlobal.settingsFallbackSaveAttempts ?? 0) + 1
        await new Promise((resolve) => setTimeout(resolve, 600))
        return { effective: settings, persisted: settings }
      })
    })
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)

    const loadingSurface = page.locator("body > [data-settings-loading]")
    const dialog = loadingSurface.getByRole("dialog", { name: "Settings" })
    const shell = page.locator(".app-shell")
    await expect(loadingSurface).toBeVisible()
    await expect(dialog).toBeFocused()
    await expect
      .poll(() => shell.evaluate((element) => (element as HTMLElement).inert))
      .toBe(true)
    await expect(
      page.locator(".app-shell [data-settings-loading]")
    ).toHaveCount(0)

    const close = dialog.getByRole("button", { name: "Close", exact: true })
    await page.keyboard.press("Tab")
    await expect(close).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(close).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(close).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(loadingSurface).toHaveCount(0)
    await expect
      .poll(() => shell.evaluate((element) => (element as HTMLElement).inert))
      .toBe(false)

    await page.keyboard.press(settingsShortcut)
    await expect(loadingSurface).toBeVisible()
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await expect(loadingSurface).toHaveCount(0)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                settingsFallbackSaveAttempts?: number
              }
            ).settingsFallbackSaveAttempts ?? 0
        )
      )
      .toBe(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("cold Settings replays a native zoom change when its handler mounts", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-cold-zoom-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/SettingsDialog-*"] },
        (_details, callback) => {
          setTimeout(() => callback({}), 1_500)
        }
      )
    })
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    await expect(page.locator("body > [data-settings-loading]")).toBeVisible()

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("zoom-in")
      const window = BrowserWindow.getFocusedWindow()
      if (!item || !window) throw new Error("Zoom In is unavailable")
      item.click(undefined, window, window.webContents)
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 1
        )
      )
      .toBeCloseTo(1.05, 5)

    const settings = page.getByRole("dialog", { name: "Settings" })
    await expect(settings).toBeVisible()
    await settings.getByRole("button", { name: "Miscellaneous" }).click()
    await expect(settings.getByLabel("Zoom percentage")).toHaveValue("105")
    await settings.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a rejected Settings chunk stays local and can be retried", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-load-retry-e2e-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ session }) => {
      let failed = false
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["pulse-md://bundle/assets/SettingsDialog-*"] },
        (_details, callback) => {
          if (!failed) {
            failed = true
            callback({ cancel: true })
          } else {
            callback({})
          }
        }
      )
    })
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)

    const loadingSurface = page.locator("body > [data-settings-loading]")
    await expect(loadingSurface.getByRole("alert")).toHaveText(
      "Settings could not be loaded."
    )
    await loadingSurface.getByRole("button", { name: "Retry" }).click()
    await expect(page.locator("[data-settings-dialog]")).toBeVisible()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("lazy specialized workspaces remain visible, cancelable, and focus-contained", async () => {
  test.skip(
    process.platform !== "darwin",
    "The launch transition workspace is macOS-only"
  )

  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-workspace-loading-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        {
          urls: [
            "pulse-md://bundle/assets/LaunchTransitionPreviewWorkspace-*",
            "pulse-md://bundle/assets/WindowProfilesWorkspace-*",
          ],
        },
        (_details, callback) => {
          setTimeout(() => callback({}), 1_500)
        }
      )
    })
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)

    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Transparency & Blur" }).click()
    await settings.getByRole("switch", { name: "Launch transition" }).click()
    await settings
      .getByRole("button", { name: "Customize launch transition" })
      .click()

    const launchLoading = page.locator(
      '[data-settings-workspace-loading][aria-label="Launch transition preview workspace"]'
    )
    await expect(launchLoading).toBeVisible()
    await expect(launchLoading).toBeFocused()
    await expect(launchLoading.getByRole("status")).toHaveText(
      "Loading Launch Transition Preview…"
    )
    await page.keyboard.press("Tab")
    await expect(
      launchLoading.getByRole("button", { name: "Cancel" })
    ).toBeFocused()

    await expect(launchLoading).toHaveCount(0)
    const launchWorkspace = page.getByRole("region", {
      name: "Launch transition preview workspace",
    })
    await expect(
      launchWorkspace.getByRole("region", {
        name: "Launch transition controls",
      })
    ).toBeVisible()

    await page.locator(".cm-content").evaluate((element) => {
      ;(element as HTMLElement).focus()
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.closest(
              '[aria-label="Launch transition preview workspace"]'
            ) !== null
        )
      )
      .toBe(true)

    await launchWorkspace.getByRole("button", { name: "Cancel" }).click()
    await expect(settings).toBeVisible()
    await settings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()

    const profilesLoading = page.locator(
      '[data-settings-workspace-loading][aria-label="Window Profiles Workspace"]'
    )
    await expect(profilesLoading).toBeVisible()
    await expect(profilesLoading).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(profilesLoading).toHaveCount(0)
    await expect(settings).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("the global Settings owner rebases allowed sibling chrome changes", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-broadcast-draft-")
  )
  const app = await launchApplication(userData)

  try {
    const primary = await app.firstWindow()
    await primary.locator(".cm-editor").waitFor()
    await primary.bringToFront()
    await primary.locator(".cm-content").click()
    const primaryWindowId = await app.evaluate(({ BrowserWindow }) => {
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused) throw new Error("The primary window is not focused")
      return focused.id
    })
    const { page: secondary, windowId: secondaryWindowId } =
      await openAdditionalWindow(app)

    await primary.bringToFront()
    await primary.locator(".cm-content").click()
    await primary.keyboard.press(settingsShortcut)
    const primarySettings = primary.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(primary, "Miscellaneous")
    const primaryWidth = primarySettings.getByLabel(
      "Maximum content width in pixels"
    )
    await primaryWidth.fill("1200")

    await secondary.bringToFront()
    await secondary.locator(".cm-content").click()
    await secondary.keyboard.press(settingsShortcut)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null
        )
      )
      .toBe(primaryWindowId)
    await expect(
      secondary.getByRole("dialog", { name: "Settings" })
    ).toHaveCount(0)
    await expect(primarySettings).toBeVisible()
    await expect(primaryWidth).toHaveValue("1200")

    await primarySettings
      .getByRole("button", { name: "Customize typography" })
      .click()
    const typography = primary.getByRole("region", {
      name: "Typography preview workspace",
    })
    const fontSize = typography.getByLabel("Base font size in pixels")
    await fontSize.fill("22")

    await app.evaluate(({ BrowserWindow, Menu }, windowId) => {
      const window = BrowserWindow.fromId(windowId)
      const statusBar =
        Menu.getApplicationMenu()?.getMenuItemById("view-status-bar")
      if (!window || !statusBar) {
        throw new Error("The sibling Status Bar command is unavailable")
      }
      statusBar.click(undefined, window, window.webContents)
    }, secondaryWindowId)
    await expect(
      secondary.locator(".status-overlay-reveal-region")
    ).toHaveAttribute("data-always-visible", "true")

    await primary.bringToFront()
    await expect(fontSize).toHaveValue("22")
    await typography.getByRole("button", { name: "Cancel" }).click()
    await expect(primarySettings).toBeVisible()
    await expect(primaryWidth).toHaveValue("1200")
    await primarySettings.getByRole("button", { name: "Window Chrome" }).click()
    await expect(
      primarySettings.getByRole("switch", {
        name: "Always show status bar",
      })
    ).not.toBeChecked()

    await primarySettings
      .getByRole("button", { name: "Done", exact: true })
      .click()
    await expect(primarySettings).toHaveCount(0)
    for (const page of [primary, secondary]) {
      await expect(
        page.locator(".status-overlay-reveal-region")
      ).toHaveAttribute("data-always-visible", "true")
    }

    await secondary.bringToFront()
    await secondary.locator(".cm-content").click()
    await secondary.keyboard.press(settingsShortcut)
    const secondarySettings = secondary.getByRole("dialog", {
      name: "Settings",
    })
    await openSettingsSection(secondary, "Miscellaneous")
    await expect(
      secondarySettings.getByLabel("Maximum content width in pixels")
    ).toHaveValue("1200")
    await secondarySettings
      .getByRole("button", { name: "Window Chrome" })
      .click()
    await expect(
      secondarySettings.getByRole("switch", {
        name: "Always show status bar",
      })
    ).toBeChecked()
    await secondarySettings.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("stale settings submissions preserve fields committed by another window", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-stale-submission-")
  )
  const app = await launchApplication(userData)

  try {
    const primary = await app.firstWindow()
    await primary.locator(".cm-editor").waitFor()
    const primaryWindowId = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      if (!window) throw new Error("The primary window is unavailable")
      return window.id
    })
    const { page: secondary, windowId: secondaryWindowId } =
      await openAdditionalWindow(app)

    await app.evaluate(
      ({ BrowserWindow }, windowIds) => {
        for (const windowId of windowIds) {
          const win = BrowserWindow.fromId(windowId)
          if (!win) throw new Error(`Window ${windowId} is unavailable`)
          const originalSend = win.webContents.send.bind(win.webContents)
          win.webContents.send = ((channel: string, ...args: unknown[]) => {
            if (channel !== "pulse-md:settings-changed") {
              originalSend(channel, ...args)
            }
          }) as typeof win.webContents.send
        }
      },
      [primaryWindowId, secondaryWindowId]
    )

    const primarySettings = cloneAppSettings(DEFAULT_APP_SETTINGS)
    primarySettings.chrome.alwaysShowStatusBar = true
    const staleSecondarySettings = cloneAppSettings(DEFAULT_APP_SETTINGS)
    staleSecondarySettings.lineWrapping = false
    const committed = await Promise.all([
      primary.evaluate(
        (settings) => window.pulseMd.setSettings(settings),
        primarySettings
      ),
      secondary.evaluate(
        (settings) => window.pulseMd.setSettings(settings),
        staleSecondarySettings
      ),
    ])

    expect(
      committed.some(
        ({ persisted }) =>
          persisted.chrome.alwaysShowStatusBar && !persisted.lineWrapping
      )
    ).toBe(true)
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as typeof DEFAULT_APP_SETTINGS
        return {
          alwaysShowStatusBar: persisted.chrome.alwaysShowStatusBar,
          lineWrapping: persisted.lineWrapping,
        }
      })
      .toEqual({ alwaysShowStatusBar: true, lineWrapping: false })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
