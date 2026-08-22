import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test"

import { DEFAULT_APP_SETTINGS } from "../../src/shared/contracts"
import {
  exitApplication,
  openSettingsSection,
  setWindowContentSize,
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

async function openAdditionalWindow(app: ElectronApplication, source: Page) {
  const existingWindows = new Set(app.windows())
  await source.bringToFront()
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((candidate) => candidate.label === "File")
      ?.submenu?.items.find((candidate) => candidate.label === "New Window")
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed()
      )
    if (!item || !win) throw new Error("New Window is unavailable")
    item.click(undefined, win, win.webContents)
  })
  await expect.poll(() => app.windows().length).toBe(existingWindows.size + 1)
  const created = app
    .windows()
    .find((candidate) => !existingWindows.has(candidate))
  if (!created) throw new Error("The additional window was not created")
  await created.locator(".cm-editor").waitFor()
  return created
}

async function setOrdinaryWindowSize(
  app: ElectronApplication,
  width: number,
  height: number
) {
  return app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error("App window was not found")
      window.setFullScreen(false)
      window.unmaximize()
      window.setSize(size.width, size.height)
      return {
        bounds: window.getBounds(),
        fullScreen: window.isFullScreen(),
      }
    },
    { height, width }
  )
}

async function maximizeOrdinaryWindow(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error("App window was not found")
    window.setFullScreen(false)
    window.maximize()
    return {
      bounds: window.getBounds(),
      fullScreen: window.isFullScreen(),
    }
  })
}

async function expectCollapsedSettingsSectionsToStayIntrinsic(page: Page) {
  const collapsedSections = page
    .getByRole("dialog", { name: "Settings" })
    .locator('[data-slot="collapsible"]')
  if ((await collapsedSections.count()) > 1) {
    const firstBox = await collapsedSections.nth(0).boundingBox()
    const secondBox = await collapsedSections.nth(1).boundingBox()
    expect(firstBox?.height).toBeLessThan(80)
    expect(secondBox?.height).toBeLessThan(80)
  }
}

async function openWindowProfiles(page: Page) {
  await page.keyboard.press(settingsShortcut)
  const settingsDialog = page.getByRole("dialog", { name: "Settings" })
  await expect(settingsDialog).toBeVisible()
  await expect(
    settingsDialog.getByRole("button", {
      name: "Window Profiles",
      exact: true,
    })
  ).toBeVisible()
  await settingsDialog
    .getByRole("button", { name: "Manage Window Profiles" })
    .click()
  const workspace = page.getByRole("region", {
    name: "Window Profiles Workspace",
  })
  await expect(workspace).toBeVisible()
  return workspace
}

async function chooseOption(trigger: Locator, name: string) {
  const popup = trigger
    .page()
    .locator('[data-slot="select-content"][data-open]')
  await expect(popup).toHaveCount(0)
  await trigger.click()
  await expect(popup).toBeVisible()
  await popup.getByRole("option", { name, exact: true }).click()
  await expect(popup).toHaveCount(0)
}

async function profileHeaderButtonGeometry(button: Locator) {
  return button.evaluate((element) => {
    const icon = element.querySelector("svg")
    if (!icon) throw new Error("Profile header action icon was not found")
    const buttonBounds = element.getBoundingClientRect()
    const iconBounds = icon.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      buttonHeight: buttonBounds.height,
      buttonWidth: buttonBounds.width,
      centerOffset:
        iconBounds.left +
        iconBounds.width / 2 -
        (buttonBounds.left + buttonBounds.width / 2),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
    }
  })
}

async function readIfPresent(filePath: string) {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

test("window profiles remain usable when scratch choices fail to load", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-profile-scratch-load-failure-e2e-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", () => {
        throw new Error("Injected scratch choices failure")
      })
    })

    const workspace = await openWindowProfiles(page)
    await expect(
      workspace.getByRole("alert").filter({
        hasText: "Scratch choices could not be loaded.",
      })
    ).toBeVisible()
    const newProfile = workspace.getByRole("button", { name: "New Profile" })
    await expect(newProfile).toBeEnabled()
    await newProfile.click()
    await expect(
      workspace.getByRole("heading", { name: "Profile Details" })
    ).toBeVisible()
    await expect(
      workspace.getByRole("button", { name: "Add Tab" })
    ).toBeEnabled()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Settings clears a recovered window-profile fetch error within one session", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-settings-profile-recovery-e2e-")
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ ipcMain }) => {
      let requests = 0
      ipcMain.removeHandler("pulse-md:get-window-profiles")
      ipcMain.handle("pulse-md:get-window-profiles", () => {
        requests += 1
        if (requests === 1) throw new Error("Injected profile load failure")
        return { currentProfileId: null, defaultProfileId: null, profiles: [] }
      })
    })

    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await expect(settings).toBeVisible()
    await expect(
      settings.getByRole("alert").filter({
        hasText: "Window profiles could not be loaded.",
      })
    ).toBeVisible()
    await settings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()
    const workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    const back = workspace.getByRole("button", { name: "Back to Settings" })
    await expect(back).toBeEnabled()
    await back.click()

    await expect(settings).toBeVisible()
    await expect(
      settings.getByText("Window profiles could not be loaded.")
    ).toHaveCount(0)
    await openSettingsSection(page, "Window Profiles")
    await expect(
      settings.getByRole("combobox", { name: "Always Launch With" })
    ).toBeEnabled()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("profile delete failures stay inside the active confirmation", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-profile-delete-failure-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "delete-failure.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "delete-failure",
        name: "Delete Failure",
        activeTab: "notes",
        tabVisibility: "always",
        tabs: [{ id: "notes", kind: "untitled", title: "Notes" }],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:delete-window-profile")
      ipcMain.handle("pulse-md:delete-window-profile", () => {
        throw new Error("Injected profile delete failure")
      })
    })

    const workspace = await openWindowProfiles(page)
    await workspace
      .getByRole("button", { name: "Delete Profile Delete Failure" })
      .click()
    const confirmation = page.getByRole("alertdialog", {
      name: "Delete Profile?",
    })
    await confirmation
      .getByRole("button", { name: "Delete Profile", exact: true })
      .click()

    await expect(confirmation).toBeVisible()
    await expect(confirmation.getByRole("alert")).toContainText(
      "Injected profile delete failure"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("profile picker and capture actions preserve their modal transactions", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-actions-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  const deferredPath = path.join(userData, "deferred.md")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(deferredPath, "# Deferred\n" + "x".repeat(8 * 1024 * 1024))
  await writeFile(
    path.join(profileDirectory, "focus-workspace.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "focus-workspace",
        name: "Focus Workspace",
        activeTab: "notes",
        tabVisibility: "always",
        tabs: [
          {
            id: "notes",
            kind: "untitled",
            title: "Focus Notes",
          },
          {
            id: "deferred",
            kind: "file",
            path: deferredPath,
            title: "Deferred Notes",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )

  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    await page.keyboard.press(settingsShortcut)
    let settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Window Profiles")
    const launchDefault = settings.getByRole("combobox", {
      name: "Always Launch With",
    })
    await chooseOption(launchDefault, "Focus Workspace")
    await settings
      .getByRole("button", { name: "Launch Window Profile" })
      .click()

    const picker = page.getByRole("dialog", {
      name: "Launch Window Profile",
    })
    await expect(picker).toBeVisible()
    await expect(picker).toHaveAttribute("data-nested", "")
    await expect(
      page.getByRole("dialog", { name: "Settings", includeHidden: true })
    ).toHaveAttribute("data-nested-dialog-open", "")
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
    await expect(settings).toBeVisible()
    await expect(launchDefault).toContainText("Focus Workspace")

    await settings.getByRole("button", { name: "Cancel" }).click()
    await page.keyboard.press(settingsShortcut)
    settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Window Profiles")
    await expect(
      settings.getByRole("combobox", { name: "Always Launch With" })
    ).toContainText("Standard Empty Window")
    await openSettingsSection(page, "Miscellaneous")
    await chooseOption(
      settings.getByRole("combobox", { name: "Markdown view on launch" }),
      "Raw Markdown"
    )

    await settings
      .getByRole("button", { name: "Launch Window Profile" })
      .click()
    await picker.getByRole("option", { name: /Focus Workspace/ }).click()
    await expect(picker).toBeHidden()
    await expect(settings).toBeHidden()
    await expect(page).toHaveTitle("Focus Notes")
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(page.locator(".cm-content")).toBeFocused()

    await page.keyboard.press(settingsShortcut)
    settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    await chooseOption(
      settings.getByRole("combobox", { name: "Markdown view on launch" }),
      "Rendered"
    )
    await settings.getByRole("button", { name: "Done", exact: true }).click()
    await expect(settings).toBeHidden()
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)

    const workspace = await openWindowProfiles(page)
    const profileCard = workspace
      .getByRole("heading", { name: "Focus Workspace" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    const editCurrentProfile = profileCard.getByRole("button", {
      name: "Edit",
      exact: true,
    })
    await expect(editCurrentProfile).toBeEnabled()
    await editCurrentProfile.click()
    await expect(
      workspace.getByText("Edit Saved Profile", { exact: true })
    ).toBeVisible()
    await workspace
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Future Notes")
    await workspace.getByRole("button", { name: "Save Profile" }).click()
    await expect(
      workspace.getByRole("heading", { name: "Focus Workspace" })
    ).toBeVisible()
    await expect(page).toHaveTitle("Focus Notes")
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    const currentDeleteGuidanceId = await profileCard
      .getByRole("button", { name: "Delete Profile Focus Workspace" })
      .getAttribute("aria-describedby")
    expect(currentDeleteGuidanceId).toBeTruthy()
    await expect(page.locator(`#${currentDeleteGuidanceId}`)).toHaveText(
      "Close this profile’s window before deleting it."
    )
    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()

    await page.bringToFront()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getFocusedWindow()
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "file-window-profile-update"
      )
      if (!win || !item?.enabled) {
        throw new Error("Update Current Profile from Tabs is unavailable")
      }
      item.click(undefined, win, win.webContents)
    })
    const capture = page.getByRole("dialog", {
      name: "Update Current Profile?",
    })
    await expect(capture).toBeVisible()
    await capture.getByRole("button", { name: /Review & Edit/ }).click()
    const reviewedWorkspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await expect(
      reviewedWorkspace.getByText("Edit Saved Profile", { exact: true })
    ).toBeVisible()
    await expect(reviewedWorkspace.getByLabel("Profile Name")).toHaveValue(
      "Focus Workspace"
    )
    await expect(
      reviewedWorkspace.getByRole("textbox", { name: "Title", exact: true })
    ).toHaveValue("Focus Notes")
    await expect(
      reviewedWorkspace.getByRole("combobox", { name: "Mode", exact: true })
    ).toContainText("Inherit")
    await reviewedWorkspace
      .getByRole("button", { name: "Edit 2: Deferred Notes" })
      .click()
    await expect(
      reviewedWorkspace.getByRole("combobox", { name: "Mode", exact: true })
    ).toContainText("Inherit")

    await reviewedWorkspace
      .getByRole("button", { name: "Back to Window Profiles" })
      .click()
    await reviewedWorkspace
      .getByRole("button", { name: "Back to Settings" })
      .click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()

    await page.bringToFront()
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getFocusedWindow()
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "file-window-profile-create"
      )
      if (!win || !item?.enabled) {
        throw new Error("Create New Profile from Tabs is unavailable")
      }
      item.click(undefined, win, win.webContents)
    })
    const createCapture = page.getByRole("dialog", {
      name: "Create Profile from Current Tabs?",
    })
    await expect(createCapture).toBeVisible()
    await expect(
      createCapture.getByRole("button", { name: /Review & Edit/ })
    ).toBeDisabled()
    await expect(
      createCapture.getByRole("button", { name: "Create", exact: true })
    ).toBeDisabled()
    await createCapture.getByLabel("Profile Name").fill("Captured Session")
    await createCapture.getByRole("button", { name: /Review & Edit/ }).click()
    const createdWorkspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await expect(
      createdWorkspace.getByText("New Profile", { exact: true })
    ).toBeVisible()
    await expect(createdWorkspace.getByLabel("Profile Name")).toHaveValue(
      "Captured Session"
    )
    await createdWorkspace.getByRole("button", { name: "Save Profile" }).click()
    await expect(
      createdWorkspace.getByRole("heading", { name: "Captured Session" })
    ).toBeVisible()
    await createdWorkspace
      .getByRole("button", { name: "Back to Settings" })
      .click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()

    const standardPage = await openAdditionalWindow(app, page)
    await page.close()
    await standardPage.bringToFront()
    await standardPage.locator(".cm-content").click()
    await standardPage.keyboard.insertText("# Keep this window")
    const existingWindows = new Set(app.windows())
    await standardPage.evaluate(() =>
      window.pulseMd.launchWindowProfile("focus-workspace")
    )
    await expect.poll(() => app.windows().length).toBe(existingWindows.size + 1)
    const launchedProfilePage = app
      .windows()
      .find((candidate) => !existingWindows.has(candidate))
    if (!launchedProfilePage) {
      throw new Error("The profile window was not created")
    }
    await launchedProfilePage.locator(".cm-editor").waitFor()
    await expect(launchedProfilePage).toHaveTitle("Future Notes")
    await expect(launchedProfilePage.locator(".cm-editor")).toHaveClass(
      /cm-md-live/
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("profile header actions compact symmetrically and open-profile guidance uses a natural-width popover", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-responsive-actions-e2e-")
  )
  const sourcePath = path.join(userData, "source.md")
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(sourcePath, "# Source\n", "utf8")
  await writeFile(
    path.join(profileDirectory, "open-profile.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "open-profile",
        name: "Open Profile",
        activeTab: "notes",
        tabVisibility: "always",
        tabs: [{ id: "notes", kind: "untitled", title: "Notes" }],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData, sourcePath)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await setWindowContentSize(app, 900, 700)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900)

    const initialWindowCount = app.windows().length
    await page.evaluate(() =>
      window.pulseMd.launchWindowProfile("open-profile")
    )
    await expect.poll(() => app.windows().length).toBe(initialWindowCount + 1)
    await page.bringToFront()

    const workspace = await openWindowProfiles(page)
    const profileCard = workspace
      .getByRole("heading", { name: "Open Profile" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    const editButton = profileCard.getByRole("button", {
      name: "Edit",
      exact: true,
    })
    await expect(editButton).toBeDisabled()
    await expect(editButton).toHaveAttribute("tabindex", "0")
    await expect(editButton).toHaveAttribute(
      "aria-describedby",
      /profile-open-profile-open-guidance/
    )
    await expect(
      page.locator("#profile-open-profile-open-guidance")
    ).toHaveText(
      "Switch to this profile’s window to edit it. Close that window before deleting it."
    )
    await expect(
      profileCard.getByRole("button", {
        name: "Delete Profile Open Profile",
      })
    ).toHaveAttribute("aria-describedby", "profile-open-profile-open-guidance")
    await profileCard
      .getByRole("button", { name: "Launch", exact: true })
      .focus()
    await page.keyboard.press("Tab")
    await expect(editButton).toBeFocused()

    const guidancePopover = page
      .locator('[data-slot="popover-content"][data-long-text-popover]')
      .filter({
        hasText:
          "Switch to this profile’s window to edit it. Close that window before deleting it.",
      })
    await expect(guidancePopover).toBeVisible()
    await expect(editButton).toBeFocused()
    // `getBoundingClientRect()` includes the opening scale transform whereas
    // computed padding remains in untransformed CSS pixels. Measure natural
    // width only after the tooltip's short entrance animation has settled.
    await guidancePopover.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined))
      )
    })
    const popoverGeometry = await guidancePopover.evaluate((element) => {
      const text = element.querySelector<HTMLElement>(
        "[data-profile-open-popover-text]"
      )
      if (!text) throw new Error("Open-profile guidance text was not found")
      const textRange = document.createRange()
      textRange.selectNodeContents(text)
      const lineWidths = [...textRange.getClientRects()]
        .filter((bounds) => bounds.width > 0 && bounds.height > 0)
        .map((bounds) => bounds.width)
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        bounds: {
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
        },
        lineWidths,
        padding:
          Number.parseFloat(style.paddingLeft) +
          Number.parseFloat(style.paddingRight),
        text: text.textContent,
        viewportWidth: innerWidth,
      }
    })
    expect(popoverGeometry.text).toBe(
      "Switch to this profile’s window to edit it. Close that window before deleting it."
    )
    expect(popoverGeometry.lineWidths).toHaveLength(1)
    expect(
      Math.abs(
        popoverGeometry.bounds.width -
          popoverGeometry.padding -
          popoverGeometry.lineWidths[0]!
      )
    ).toBeLessThanOrEqual(1)
    expect(popoverGeometry.bounds.left).toBeGreaterThanOrEqual(0)
    expect(popoverGeometry.bounds.right).toBeLessThanOrEqual(
      popoverGeometry.viewportWidth
    )
    await profileCard
      .getByRole("button", { name: "Launch", exact: true })
      .focus()
    await expect(guidancePopover).toBeHidden()
    await editButton.hover()
    await expect(guidancePopover).toBeVisible()
    await page.mouse.move(20, 100)
    await expect(guidancePopover).toBeHidden()

    const newProfile = workspace.getByRole("button", {
      name: "New Profile",
    })
    await expect(newProfile.locator("span")).toBeVisible()
    expect(
      (await profileHeaderButtonGeometry(newProfile)).buttonWidth
    ).toBeGreaterThan(
      (await profileHeaderButtonGeometry(newProfile)).buttonHeight
    )

    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(450)
    await editButton.hover()
    await expect(guidancePopover).toBeVisible()
    const zoomedPopoverBounds = await guidancePopover.boundingBox()
    expect(zoomedPopoverBounds).not.toBeNull()
    expect(zoomedPopoverBounds!.x).toBeGreaterThanOrEqual(0)
    expect(
      zoomedPopoverBounds!.x + zoomedPopoverBounds!.width
    ).toBeLessThanOrEqual(450)
    await expect(newProfile.locator("span")).toBeHidden()
    await expect
      .poll(async () => {
        const geometry = await profileHeaderButtonGeometry(newProfile)
        return Math.max(geometry.paddingLeft, geometry.paddingRight)
      })
      .toBeLessThanOrEqual(0.1)
    const compactNewProfile = await profileHeaderButtonGeometry(newProfile)
    expect(
      Math.abs(compactNewProfile.buttonWidth - compactNewProfile.buttonHeight)
    ).toBeLessThanOrEqual(0.5)
    expect(Math.abs(compactNewProfile.centerOffset)).toBeLessThanOrEqual(0.5)
    expect(compactNewProfile.paddingLeft).toBeLessThanOrEqual(0.1)
    expect(compactNewProfile.paddingRight).toBeLessThanOrEqual(0.1)

    await newProfile.click()
    const saveProfile = workspace.getByRole("button", {
      name: "Save Profile",
    })
    await expect(saveProfile.locator("span")).toBeHidden()
    const compactSaveProfile = await profileHeaderButtonGeometry(saveProfile)
    expect(
      Math.abs(compactSaveProfile.buttonWidth - compactSaveProfile.buttonHeight)
    ).toBeLessThanOrEqual(0.5)
    expect(Math.abs(compactSaveProfile.centerOffset)).toBeLessThanOrEqual(0.5)
    expect(compactSaveProfile.paddingLeft).toBeLessThanOrEqual(0.1)
    expect(compactSaveProfile.paddingRight).toBeLessThanOrEqual(0.1)

    await page.evaluate(() => window.pulseMd.previewWindowZoom(1))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900)
    await expect(saveProfile.locator("span")).toBeVisible()
    const expandedSaveProfile = await profileHeaderButtonGeometry(saveProfile)
    expect(expandedSaveProfile.buttonWidth).toBeGreaterThan(
      expandedSaveProfile.buttonHeight
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("profile temporary tabs use their fallback title and save an explicitly typed extension", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-temporary-title-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  const destinationPath = path.join(userData, "quick-notes.json")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "temporary-tabs.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "temporary-tabs",
        name: "Temporary Tabs",
        activeTab: "default-title",
        tabVisibility: "always",
        tabs: [
          { id: "default-title", kind: "ephemeral" },
          {
            id: "custom-title",
            kind: "ephemeral",
            title: "Named Temporary",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() =>
      window.pulseMd.launchWindowProfile("temporary-tabs")
    )

    await expect(page.getByRole("tab")).toHaveText([
      "Temporary",
      "Named Temporary",
    ])
    await expect(page).toHaveTitle("Temporary")

    await app.evaluate(({ dialog }, filePath) => {
      const testGlobal = globalThis as typeof globalThis & {
        temporarySaveDialogOptions?: {
          defaultPath: string | undefined
          hasFilters: boolean
        }
      }
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.SaveDialogOptions
        testGlobal.temporarySaveDialogOptions = {
          defaultPath: options.defaultPath,
          hasFilters: Object.hasOwn(options, "filters"),
        }
        return { canceled: false, filePath }
      }) as typeof dialog.showSaveDialog
    }, destinationPath)
    const content = page.locator(".cm-content")
    await content.click()
    await page.keyboard.insertText('{"answer": 42}\n')
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S"
    )

    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                temporarySaveDialogOptions?: {
                  defaultPath: string | undefined
                  hasFilters: boolean
                }
              }
            ).temporarySaveDialogOptions ?? null
        )
      )
      .toEqual({
        defaultPath: "Temporary.md",
        hasFilters: false,
      })
    await expect
      .poll(() => readIfPresent(destinationPath))
      .toBe(`{"answer": 42}${os.EOL}`)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", destinationPath)
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.locator(".document-tab[data-active]").click({ button: "right" })
    await page.getByRole("menuitem", { name: "Copy Path", exact: true }).click()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(destinationPath)
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Plain Text"
    )
    await expect(
      page.getByRole("button", { name: "Document outline" })
    ).toHaveCount(0)
    expect(await readIfPresent(`${destinationPath}.md`)).toBeNull()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("profile launch rejects file aliases introduced after the profile was saved", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-alias-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  const firstPath = path.join(userData, "first.md")
  const secondPath = path.join(userData, "second.md")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(firstPath, "First\n", "utf8")
  await writeFile(secondPath, "Second\n", "utf8")
  await writeFile(
    path.join(profileDirectory, "late-alias.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "late-alias",
        name: "Late Alias",
        activeTab: "first",
        tabVisibility: "always",
        tabs: [
          { id: "first", kind: "file", path: firstPath },
          { id: "second", kind: "file", path: secondPath },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await rm(secondPath)
    await link(firstPath, secondPath)

    await expect(
      page.evaluate(() => window.pulseMd.launchWindowProfile("late-alias"))
    ).rejects.toThrow(/refer to the same file/i)
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await expect(page.locator(".document-tab")).toContainText("Untitled")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("an invalid inactive profile file is deferred and cannot replace the visible session", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-deferred-failure-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  const activePath = path.join(userData, "active.md")
  const invalidPath = path.join(userData, "invalid.md")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(activePath, "# Active profile document\n", "utf8")
  await writeFile(invalidPath, Buffer.from([0xc3, 0x28]))
  await writeFile(
    path.join(profileDirectory, "deferred-failure.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "deferred-failure",
        name: "Deferred Failure",
        activeTab: "active",
        tabVisibility: "always",
        tabs: [
          { id: "active", kind: "file", path: activePath },
          { id: "invalid", kind: "file", path: invalidPath },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() =>
      window.pulseMd.launchWindowProfile("deferred-failure")
    )

    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(page.locator(".cm-content")).toContainText(
      "Active profile document"
    )
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        checkboxChecked: false,
        response: 0,
      })
    })
    await page.getByRole("tab", { name: "invalid.md" }).click()
    await expect(page.getByRole("tab", { name: "active.md" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await expect(page.locator(".cm-content")).toContainText(
      "Active profile document"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("recovery reload preserves deferred profile scratch semantics", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-profile-recovery-deferred-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  const missingScratchId = "10000000-0000-4000-8000-000000000021"
  const sourceScratchId = "10000000-0000-4000-8000-000000000022"
  await mkdir(profileDirectory, { recursive: true })
  await seedScratchStore(userData, [
    {
      content: `# Deferred source\n${"x".repeat(8 * 1024 * 1024)}`,
      fileName: "deferred-source.md",
      id: sourceScratchId,
      title: "Deferred Source",
    },
  ])
  await writeFile(
    path.join(profileDirectory, "recovery-deferred.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "recovery-deferred",
        name: "Recovery Deferred",
        activeTab: "active",
        mode: "live",
        tabVisibility: "always",
        tabs: [
          { id: "active", kind: "untitled", title: "Active" },
          {
            id: "missing",
            kind: "scratch",
            scratchId: missingScratchId,
            title: "Missing Reference",
          },
          {
            id: "source",
            kind: "scratch",
            mode: "source",
            scratchId: sourceScratchId,
            title: "Deferred Source",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() =>
      window.pulseMd.launchWindowProfile("recovery-deferred")
    )
    await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute(
      "aria-selected",
      "true"
    )

    await page.evaluate(() =>
      window.pulseMd.showRecovery("Injected deferred profile recovery")
    )
    await expect(page).toHaveURL(/\/recovery\.html/)
    await page.getByRole("button", { name: "Reload Window" }).click()
    await expect(page).toHaveURL(/\/index\.html/)
    await page.locator(".cm-editor").waitFor()

    await app.evaluate(({ dialog }) => {
      const testGlobal = globalThis as typeof globalThis & {
        deferredRecoveryPrompts?: string[]
      }
      testGlobal.deferredRecoveryPrompts = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title) {
          testGlobal.deferredRecoveryPrompts?.push(options.title)
        }
        return { checkboxChecked: false, response: 0 }
      }) as typeof dialog.showMessageBox
    })
    await page.getByRole("tab", { name: "Missing Reference" }).click()
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                deferredRecoveryPrompts?: string[]
              }
            ).deferredRecoveryPrompts
        )
      )
      .toEqual(["Open Failed"])
    await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute(
      "aria-selected",
      "true"
    )

    await page.getByRole("tab", { name: "Deferred Source" }).click()
    await expect(
      page.getByRole("tab", { name: "Deferred Source" })
    ).toHaveAttribute("aria-selected", "true")
    await expect(page.locator('[data-status-item="mode"]')).toHaveText(
      "Raw Markdown"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("new-tab requests wait for disposable-window profile replacement", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-mutation-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "mutation-race.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "mutation-race",
        name: "Mutation Race",
        activeTab: "first",
        tabVisibility: "always",
        tabs: [
          { id: "first", kind: "untitled", title: "First" },
          { id: "second", kind: "untitled", title: "Second" },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const originalTabId = await page
      .locator(".document-tab")
      .getAttribute("data-tab-id")
    if (!originalTabId) throw new Error("The original tab id is unavailable")
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await app.evaluate(({ BrowserWindow }) => {
      const testGlobal = globalThis as typeof globalThis & {
        profileMutationRequestDelayed?: boolean
      }
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error("The profile test window is unavailable")
      const originalSend = win.webContents.send.bind(win.webContents)
      win.webContents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === "pulse-md:cli-tabs-open-requested") {
          testGlobal.profileMutationRequestDelayed = true
          win.webContents.send = originalSend
          setTimeout(() => originalSend(channel, ...args), 250)
          return
        }
        originalSend(channel, ...args)
      }) as typeof win.webContents.send
    })
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        profileMutationLaunch?: Promise<unknown>
      }
      testWindow.profileMutationLaunch =
        window.pulseMd.launchWindowProfile("mutation-race")
    })
    await expect
      .poll(() =>
        app.evaluate(() => {
          const testGlobal = globalThis as typeof globalThis & {
            profileMutationRequestDelayed?: boolean
          }
          return testGlobal.profileMutationRequestDelayed
        })
      )
      .toBe(true)

    await page.evaluate((tabId) => {
      window.pulseMd.setActiveTab(tabId)
    }, originalTabId)

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await page.evaluate(async () => {
      const testWindow = window as typeof window & {
        profileMutationLaunch?: Promise<unknown>
      }
      await testWindow.profileMutationLaunch
    })

    await expect(page.getByRole("tab")).toHaveCount(3)
    await expect(page.getByRole("tab").nth(0)).toContainText("First")
    await expect(page.getByRole("tab").nth(1)).toContainText("Second")
    await expect(page.getByRole("tab").nth(2)).toContainText("Untitled")
    expect(pageErrors).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("later empty-window launches observe a changed default profile", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-default-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  for (const [id, name] of [
    ["first-default", "First Default"],
    ["second-default", "Second Default"],
  ] as const) {
    await writeFile(
      path.join(profileDirectory, `${id}.json`),
      `${JSON.stringify(
        {
          version: 2,
          id,
          name,
          activeTab: "document",
          tabVisibility: "always",
          tabs: [{ id: "document", kind: "untitled", title: name }],
        },
        null,
        2
      )}\n`,
      "utf8"
    )
  }
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify(
      {
        ...DEFAULT_APP_SETTINGS,
        defaultWindowProfileId: "first-default",
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const firstWindow = await app.firstWindow()
    await firstWindow.locator(".cm-editor").waitFor()
    await expect(firstWindow).toHaveTitle("First Default")

    await firstWindow.evaluate(() =>
      window.pulseMd.setDefaultWindowProfile("second-default")
    )
    const secondWindow = await openAdditionalWindow(app, firstWindow)
    await expect(secondWindow).toHaveTitle("Second Default")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a failed Settings save does not partially commit the launch profile", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-atomic-settings-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "atomic-profile.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "atomic-profile",
        name: "Atomic Profile",
        activeTab: "document",
        tabVisibility: "always",
        tabs: [
          {
            id: "document",
            kind: "untitled",
            title: "Atomic Profile",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:set-settings")
      ipcMain.handle("pulse-md:set-settings", () => {
        throw new Error("Injected atomic Settings failure")
      })
    })

    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Window Profiles")
    const launchProfile = settings.getByRole("combobox", {
      name: "Always Launch With",
    })
    await chooseOption(launchProfile, "Atomic Profile")
    await settings.getByRole("button", { name: "Done", exact: true }).click()
    await expect(settings).toBeVisible()
    const saveAlert = settings.getByRole("alert")
    await expect(saveAlert).toContainText("Settings could not be saved")
    await expect(saveAlert).toBeInViewport()
    await expect(
      settings.locator("[data-settings-dialog-footer]")
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.pulseMd.getWindowProfiles()).defaultProfileId
        )
      )
      .toBeNull()

    await settings.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(settings).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.pulseMd.getWindowProfiles()).defaultProfileId
        )
      )
      .toBeNull()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("launching a profile saves the parent Settings transaction first", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-launch-settings-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "launch-settings.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "launch-settings",
        name: "Launch Settings",
        activeTab: "document",
        tabVisibility: "always",
        tabs: [
          {
            id: "document",
            kind: "untitled",
            title: "Launched Settings",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await openSettingsSection(page, "Miscellaneous")
    await openSettingsSection(page, "Window Profiles")
    await settings.getByLabel("Maximum content width in pixels").fill("1111")
    await chooseOption(
      settings.getByRole("combobox", { name: "Always Launch With" }),
      "Launch Settings"
    )
    await settings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()

    const workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    const profileCard = workspace
      .getByRole("heading", { name: "Launch Settings" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    await profileCard
      .getByRole("button", { name: "Launch", exact: true })
      .click()
    await expect(workspace).toHaveCount(0)
    await expect(page).toHaveTitle("Launched Settings")
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as {
          defaultWindowProfileId?: string | null
          maxContentWidth?: number
        }
        return {
          defaultWindowProfileId: saved.defaultWindowProfileId,
          maxContentWidth: saved.maxContentWidth,
        }
      })
      .toEqual({
        defaultWindowProfileId: "launch-settings",
        maxContentWidth: 1111,
      })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("in-place profile launch keeps the editor read-only until replacement settles", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-readonly-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "read-only-launch.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "read-only-launch",
        name: "Read Only Launch",
        activeTab: "profile-tab",
        tabVisibility: "always",
        tabs: [
          {
            id: "profile-tab",
            kind: "untitled",
            title: "Profile Tab",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(() => {
      window.pulseMd.onCliTabsOpenRequested(() => {
        const content = document.querySelector<HTMLElement>(".cm-content")
        document.documentElement.dataset.profileLaunchRequestEditable =
          content?.getAttribute("contenteditable") ?? "missing"
      })
    })
    const workspace = await openWindowProfiles(page)

    await app.evaluate(({ BrowserWindow }) => {
      const testGlobal = globalThis as typeof globalThis & {
        profileLaunchRequestDelayed?: boolean
      }
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error("The profile test window is unavailable")
      const originalSend = win.webContents.send.bind(win.webContents)
      win.webContents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === "pulse-md:cli-tabs-open-requested") {
          testGlobal.profileLaunchRequestDelayed = true
          win.webContents.send = originalSend
          setTimeout(() => originalSend(channel, ...args), 350)
          return
        }
        originalSend(channel, ...args)
      }) as typeof win.webContents.send
    })

    await workspace.getByRole("button", { name: "Launch", exact: true }).click()
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                profileLaunchRequestDelayed?: boolean
              }
            ).profileLaunchRequestDelayed ?? false
        )
      )
      .toBe(true)
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false"
    )
    await expect(page.locator("html")).toHaveAttribute(
      "data-profile-launch-request-editable",
      "false"
    )

    await expect(workspace).toHaveCount(0)
    await expect(page).toHaveTitle("Profile Tab")
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("profile replacement aborts a transfer already admitted by its target", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-transfer-race-e2e-")
  )
  const profileDirectory = path.join(userData, "cli-profiles")
  const sourcePath = path.join(userData, "transfer-source.md")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(sourcePath, "Transfer source\n", "utf8")
  await writeFile(
    path.join(profileDirectory, "transfer-target.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "transfer-target",
        name: "Transfer Target",
        activeTab: "first",
        tabVisibility: "always",
        tabs: [
          { id: "first", kind: "untitled", title: "Profile First" },
          { id: "second", kind: "untitled", title: "Profile Second" },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  const app = await launchApplication(userData, sourcePath)

  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    const target = await openAdditionalWindow(app, source)
    const pageErrors: string[] = []
    source.on("pageerror", (error) => pageErrors.push(String(error)))
    target.on("pageerror", (error) => pageErrors.push(String(error)))

    await app.evaluate(({ BrowserWindow }) => {
      const testGlobal = globalThis as typeof globalThis & {
        profileTransferExportDelayed?: boolean
        profileTransferOpenDelayed?: boolean
      }
      const windows = BrowserWindow.getAllWindows()
      if (windows.length !== 2) {
        throw new Error("The transfer participant windows are unavailable")
      }
      for (const win of windows) {
        const originalSend = win.webContents.send.bind(win.webContents)
        win.webContents.send = ((channel: string, ...args: unknown[]) => {
          if (
            channel === "pulse-md:tab-export-requested" &&
            !testGlobal.profileTransferExportDelayed
          ) {
            testGlobal.profileTransferExportDelayed = true
            setTimeout(() => originalSend(channel, ...args), 250)
            return
          }
          if (
            channel === "pulse-md:cli-tabs-open-requested" &&
            !testGlobal.profileTransferOpenDelayed
          ) {
            testGlobal.profileTransferOpenDelayed = true
            setTimeout(() => originalSend(channel, ...args), 500)
            return
          }
          originalSend(channel, ...args)
        }) as typeof win.webContents.send
      }
    })

    const sourceTabId = await source
      .locator(".document-tab")
      .getAttribute("data-tab-id")
    if (!sourceTabId) throw new Error("The transfer source tab is unavailable")
    const dragToken = await source.evaluate(
      (tabId) => window.pulseMd.beginTabDrag(tabId),
      sourceTabId
    )
    if (!dragToken) throw new Error("The transfer token is unavailable")
    await target.evaluate((token) => {
      const testWindow = window as typeof window & {
        profileTransferRequest?: Promise<unknown>
      }
      testWindow.profileTransferRequest = window.pulseMd.requestTabTransfer(
        token,
        0
      )
    }, dragToken)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                profileTransferExportDelayed?: boolean
              }
            ).profileTransferExportDelayed ?? false
        )
      )
      .toBe(true)

    await target.evaluate(() => {
      const testWindow = window as typeof window & {
        profileTransferLaunch?: Promise<unknown>
      }
      testWindow.profileTransferLaunch =
        window.pulseMd.launchWindowProfile("transfer-target")
    })
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                profileTransferOpenDelayed?: boolean
              }
            ).profileTransferOpenDelayed ?? false
        )
      )
      .toBe(true)

    const transferResult = await target.evaluate(async () => {
      const testWindow = window as typeof window & {
        profileTransferRequest?: Promise<unknown>
      }
      return testWindow.profileTransferRequest
    })
    expect(transferResult).toBeNull()
    await target.evaluate(async () => {
      const testWindow = window as typeof window & {
        profileTransferLaunch?: Promise<unknown>
      }
      await testWindow.profileTransferLaunch
    })

    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(source.locator(".document-tab")).toContainText(
      "transfer-source.md"
    )
    await expect(target.locator(".document-tab")).toHaveCount(2)
    await expect(target.locator(".document-tab").nth(0)).toContainText(
      "Profile First"
    )
    await expect(target.locator(".document-tab").nth(1)).toContainText(
      "Profile Second"
    )
    expect(pageErrors).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

async function expectCompactAlertDialog(dialog: Locator) {
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box?.width).toBeLessThan(400)
  expect(box?.height).toBeLessThan(400)
}

async function readTabSurfaceStyle(tab: Locator) {
  return tab.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      appearance: style.appearance,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      color: style.color,
      fontSize: style.fontSize,
      height: style.height,
      padding: style.padding,
      textAlign: style.textAlign,
      textRendering: style.textRendering,
      unicodeBidi: style.unicodeBidi,
      width: style.width,
    }
  })
}

test("canceling scratch Save As re-arms ordinary autosave", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-save-cancel-e2e-")
  )
  const profileId = "autosave-cancel"
  const tabId = "notes"
  const scratchId = "10000000-0000-4000-8000-000000000031"
  const profileDirectory = path.join(userData, "cli-profiles")
  const scratchPath = path.join(userData, "scratch", "autosave-cancel.md")
  await mkdir(profileDirectory, { recursive: true })
  await seedScratchStore(userData, [
    {
      content: "x".repeat(2 * 1024 * 1024),
      fileName: "autosave-cancel.md",
      id: scratchId,
      title: "Notes",
    },
  ])
  await writeFile(
    path.join(profileDirectory, `${profileId}.json`),
    `${JSON.stringify(
      {
        version: 2,
        id: profileId,
        name: "Autosave Cancel",
        activeTab: tabId,
        tabVisibility: "always",
        tabs: [{ id: tabId, kind: "scratch", scratchId, title: "Notes" }],
      },
      null,
      2
    )}\n`,
    "utf8"
  )

  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(
      (id) => window.pulseMd.launchWindowProfile(id),
      profileId
    )
    await expect(page).toHaveTitle("Notes")
    await expect(page.locator(".cm-content")).toBeFocused()
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({
        canceled: true,
        filePath: "",
      })) as typeof dialog.showSaveDialog
    })

    const marker = `scratch-save-cancel-${Date.now()}`
    await page.locator(".cm-content").click()
    await page.keyboard.insertText(marker)
    expect(
      await page
        .locator(".cm-content")
        .evaluate(
          (element, value) => element.textContent?.includes(value),
          marker
        )
    ).toBe(true)
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const saveAs = Menu.getApplicationMenu()
        ?.items.find((candidate) => candidate.label === "File")
        ?.submenu?.items.find((candidate) => candidate.label === "Save As…")
      // A real native menu activation supplies its owning window. Synthetic
      // E2E activation must do the same instead of relying on global OS focus,
      // which another Electron test process can briefly take.
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed()
      )
      if (!saveAs || !window) throw new Error("Save As is unavailable")
      saveAs.click(undefined, window, window.webContents)
    })

    await expect
      .poll(
        async () => (await readFile(scratchPath, "utf8")).includes(marker),
        { timeout: 5_000 }
      )
      .toBe(true)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("repeated scratch autosave failures show a recoverable not-saved state", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-autosave-failure-e2e-")
  )
  const profileId = "autosave-failure"
  const tabId = "notes"
  const scratchId = "10000000-0000-4000-8000-000000000032"
  const profileDirectory = path.join(userData, "cli-profiles")
  const scratchPath = path.join(userData, "scratch", "autosave-failure.md")
  const blockedScratchPath = `${scratchPath}.blocked`
  await mkdir(profileDirectory, { recursive: true })
  await seedScratchStore(userData, [
    {
      content: "Saved scratch\n",
      fileName: "autosave-failure.md",
      id: scratchId,
      title: "Notes",
    },
  ])
  await writeFile(
    path.join(profileDirectory, `${profileId}.json`),
    `${JSON.stringify(
      {
        version: 2,
        id: profileId,
        name: "Autosave Failure",
        activeTab: tabId,
        tabVisibility: "always",
        tabs: [{ id: tabId, kind: "scratch", scratchId, title: "Notes" }],
      },
      null,
      2
    )}\n`,
    "utf8"
  )

  const app = await launchApplication(userData)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.evaluate(
      (id) => window.pulseMd.launchWindowProfile(id),
      profileId
    )
    await expect(page).toHaveTitle("Notes")
    await rename(scratchPath, blockedScratchPath)
    await mkdir(scratchPath)

    const marker = `scratch-autosave-failure-${Date.now()}`
    await page.locator(".cm-content").click()
    await page.keyboard.insertText(marker)

    const notice = page.getByRole("alert").filter({
      hasText: "have not been saved",
    })
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(
      notice.getByRole("button", { name: "Retry Now" })
    ).toBeVisible()
    await expect(
      notice.getByRole("button", { name: "Save a Copy…" })
    ).toBeVisible()

    await notice.getByRole("button", { name: "Retry Now" }).click()
    await expect(notice).toContainText(
      "The scratch still could not be saved. Fix the storage problem, then retry or save a copy."
    )
    await expect(
      notice.getByRole("button", { name: "Retry Now" })
    ).toBeEnabled()

    await rm(scratchPath, { force: true, recursive: true })
    await rename(blockedScratchPath, scratchPath)
    await notice.getByRole("button", { name: "Retry Now" }).click()
    await expect(notice).not.toBeVisible()
    await expect.poll(() => readFile(scratchPath, "utf8")).toContain(marker)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("window profiles compose, launch, persist, and keep scratch deletion separate", async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profiles-e2e-")
  )
  const sourcePath = path.join(userData, "source.md")
  const profilePath = path.join(
    userData,
    "cli-profiles",
    "writing-workspace.json"
  )
  const reuseProfilePath = path.join(
    userData,
    "cli-profiles",
    "reuse-scratch.json"
  )
  const scratchId = "10000000-0000-4000-8000-000000000041"
  const scratchPath = path.join(userData, "scratch", "profile-notes.md")
  await Promise.all([
    writeFile(sourcePath, "# Source document\n", "utf8"),
    seedScratchStore(userData, [
      {
        content: "",
        fileName: "profile-notes.md",
        id: scratchId,
        title: "Profile Notes",
      },
    ]),
  ])

  let app: ElectronApplication | null = await launchApplication(userData)
  try {
    let page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page).toHaveTitle("Untitled")

    let workspace = await openWindowProfiles(page)
    await workspace.getByRole("button", { name: "New Profile" }).click()
    await expect(workspace.getByLabel("Profile Name")).toBeFocused()
    await workspace.getByLabel("Profile Name").fill("Writing Workspace")
    await expect(
      workspace.getByText("Profile ID", { exact: true })
    ).toHaveCount(0)
    await expect(
      workspace.getByRole("button", {
        name: "Use Current Window’s Tabs",
        exact: true,
      })
    ).toBeVisible()
    await chooseOption(
      workspace.getByRole("combobox", {
        name: "Tabs Visibility",
        exact: true,
      }),
      "With Multiple Tabs"
    )
    await workspace
      .getByRole("button", {
        name: "Use Current Window’s Tabs",
        exact: true,
      })
      .click()
    await chooseOption(
      workspace.getByRole("combobox", { name: "Type", exact: true }),
      "Scratch"
    )
    await workspace
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Profile Notes")
    await workspace.getByRole("button", { name: "Save Profile" }).click()

    await expect(
      workspace.getByRole("heading", { name: "Writing Workspace" })
    ).toBeVisible()
    let profileCard = workspace
      .getByRole("heading", { name: "Writing Workspace" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    await expect(
      profileCard.getByText("Default Mode: App Setting", { exact: true })
    ).toBeVisible()
    await expect(
      profileCard.getByText("Tabs Visibility: With Multiple Tabs", {
        exact: true,
      })
    ).toBeVisible()
    await expect(
      profileCard.getByRole("img", {
        name: "1. Profile Notes, starting tab",
      })
    ).toHaveAttribute("data-active", "true")
    await expect(profileCard.getByText("1 Tab", { exact: true })).toHaveCount(0)
    await expect.poll(() => readIfPresent(profilePath)).not.toBeNull()
    expect(
      (
        JSON.parse(await readFile(profilePath, "utf8")) as {
          tabVisibility?: string
        }
      ).tabVisibility
    ).toBe("multiple-tabs")
    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    const settingsDialog = page.getByRole("dialog", { name: "Settings" })
    await expect(settingsDialog).toBeVisible()
    await openSettingsSection(page, "Window Profiles")
    const launchProfileTrigger = settingsDialog.getByRole("combobox", {
      name: "Always Launch With",
    })
    await expect(launchProfileTrigger).toBeEnabled()
    await chooseOption(launchProfileTrigger, "Writing Workspace")
    await settingsDialog.getByRole("button", { name: "Cancel" }).click()
    await page.keyboard.press(settingsShortcut)
    await expect(settingsDialog).toBeVisible()
    await openSettingsSection(page, "Window Profiles")
    await expect(launchProfileTrigger).toContainText("Standard Empty Window")
    await expect(launchProfileTrigger).toBeEnabled()
    await chooseOption(launchProfileTrigger, "Writing Workspace")
    await settingsDialog
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()
    workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    await expect(settingsDialog).toBeVisible()
    await openSettingsSection(page, "Window Profiles")
    await expect(launchProfileTrigger).toContainText("Writing Workspace")
    await settingsDialog
      .getByRole("button", { name: "Done", exact: true })
      .click()
    await expect(settingsDialog).toBeHidden()
    workspace = await openWindowProfiles(page)

    const windowCount = app.windows().length
    await workspace.getByRole("button", { name: "Launch" }).click()
    await expect(workspace).toHaveCount(0)
    await expect.poll(() => app?.windows().length ?? 0).toBe(windowCount)
    await expect(page).toHaveTitle("Profile Notes")
    await expect(page.locator(".cm-content")).toBeFocused()
    await page.keyboard.press(settingsShortcut)
    const launchedSettingsDialog = page.getByRole("dialog", {
      name: "Settings",
    })
    const windowProfilesSection = launchedSettingsDialog
      .getByRole("heading", { name: "Window Profiles" })
      .locator("xpath=ancestor::section[1]")
    await expect(
      windowProfilesSection.getByText("Current Window", { exact: true })
    ).toBeVisible()
    await expect(
      windowProfilesSection
        .locator("[data-current-window-profile]")
        .getByText("Writing Workspace", { exact: true })
    ).toBeVisible()
    await launchedSettingsDialog
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()
    workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await expect(workspace).toBeVisible()
    profileCard = workspace
      .getByRole("heading", { name: "Writing Workspace" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    await expect(
      profileCard.getByText("Current Window", { exact: true })
    ).toBeVisible()
    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Cancel" })
      .click()
    await page.keyboard.insertText("Remembered scratch text")
    await expect
      .poll(() => readIfPresent(scratchPath))
      .toContain("Remembered scratch text")

    await exitApplication(app)
    app = await launchApplication(userData)
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page).toHaveTitle("Profile Notes")
    await expect(page.locator(".cm-content")).toContainText(
      "Remembered scratch text"
    )

    await exitApplication(app)
    app = await launchApplication(userData, sourcePath)
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page).toHaveTitle("source.md")

    workspace = await openWindowProfiles(page)
    await workspace.getByRole("button", { name: "New Profile" }).click()
    await workspace.getByLabel("Profile Name").fill("Reuse Scratch")
    await workspace.getByRole("button", { name: "Add Tab" }).click()
    await chooseOption(
      workspace.getByRole("combobox", { name: "Type", exact: true }),
      "Scratch"
    )
    await workspace
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Reused Profile Notes")
    const scratchContent = workspace.getByRole("combobox", {
      name: "Scratch Content",
      exact: true,
    })
    await expect(scratchContent).toBeVisible()
    await chooseOption(scratchContent, "Profile Notes")
    await expect(scratchContent).toContainText("Profile Notes")
    await workspace.getByRole("button", { name: "Save Profile" }).click()
    await expect.poll(() => readIfPresent(reuseProfilePath)).not.toBeNull()

    const reuseProfile = JSON.parse(
      await readFile(reuseProfilePath, "utf8")
    ) as {
      tabs: Array<{
        scratchId?: string
      }>
    }
    expect(reuseProfile.tabs[0]?.scratchId).toBe(scratchId)

    const reuseCard = workspace
      .getByRole("heading", { name: "Reuse Scratch" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    const reuseWindowCount = app.windows().length
    await reuseCard.getByRole("button", { name: "Launch" }).click()
    await expect(workspace).toHaveCount(0)
    await expect
      .poll(() => app?.windows().length ?? 0)
      .toBe(reuseWindowCount + 1)
    const reusePage = app.windows().find((candidate) => candidate !== page)
    if (!reusePage) throw new Error("Reused scratch window was not created")
    await expect(reusePage).toHaveTitle("Reused Profile Notes")
    await expect(reusePage.locator(".cm-content")).toContainText(
      "Remembered scratch text"
    )
    await reusePage.close()
    await expect.poll(() => app?.windows().length ?? 0).toBe(reuseWindowCount)
    await page.bringToFront()

    workspace = await openWindowProfiles(page)
    const savedReuseCard = workspace
      .getByRole("heading", { name: "Reuse Scratch" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    await savedReuseCard
      .getByRole("button", { name: "Delete Profile Reuse Scratch" })
      .click()
    await page
      .getByRole("alertdialog", { name: "Delete Profile?" })
      .getByRole("button", { name: "Delete Profile", exact: true })
      .click()
    await expect.poll(() => readIfPresent(reuseProfilePath)).toBeNull()

    profileCard = workspace
      .getByRole("heading", { name: "Writing Workspace" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')

    const sourceWindowCount = app.windows().length
    await profileCard
      .getByRole("button", { name: "Launch", exact: true })
      .click()
    await expect(workspace).toHaveCount(0)
    await expect
      .poll(() => app?.windows().length ?? 0)
      .toBe(sourceWindowCount + 1)
    const profilePage = app.windows().find((candidate) => candidate !== page)
    if (!profilePage) throw new Error("Profile window was not created")
    await expect(profilePage).toHaveTitle("Profile Notes")
    await expect(page).toHaveTitle("source.md")

    await page.bringToFront()
    await page.keyboard.press(settingsShortcut)
    const sourceSettings = page.getByRole("dialog", { name: "Settings" })
    await expect(sourceSettings).toBeVisible()
    await expect(
      sourceSettings.locator("[data-current-window-profile]")
    ).toHaveCount(0)
    await sourceSettings
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()
    const sourceWorkspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    const sourceProfileCard = sourceWorkspace
      .getByRole("heading", { name: "Writing Workspace" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    await expect(
      sourceProfileCard.getByText("Open", { exact: true })
    ).toBeVisible()
    await expect(
      sourceProfileCard.getByText("Current Window", { exact: true })
    ).toHaveCount(0)
    const sourceEditButton = sourceProfileCard.getByRole("button", {
      name: "Edit",
      exact: true,
    })
    await expect(sourceEditButton).toBeDisabled()
    const sourceGuidanceId =
      await sourceEditButton.getAttribute("aria-describedby")
    expect(sourceGuidanceId).toBeTruthy()
    const sourceGuidance = page.locator(`#${sourceGuidanceId}`)
    await expect(sourceGuidance).toHaveText(
      "Switch to this profile’s window to edit it. Close that window before deleting it."
    )
    await expect(sourceGuidance).toHaveClass(/\bsr-only\b/)
    await sourceEditButton.hover()
    await expect(
      page
        .locator('[data-slot="popover-content"][data-long-text-popover]')
        .filter({
          hasText:
            "Switch to this profile’s window to edit it. Close that window before deleting it.",
        })
    ).toBeVisible()
    await sourceWorkspace
      .getByRole("button", { name: "Back to Settings" })
      .click()
    await sourceSettings.getByRole("button", { name: "Cancel" }).click()

    await profilePage.bringToFront()
    await profilePage.keyboard.press(settingsShortcut)
    const launchedProfileSettings = profilePage.getByRole("dialog", {
      name: "Settings",
    })
    const launchedProfileIndicator = launchedProfileSettings.locator(
      "[data-current-window-profile]"
    )
    await expect(
      launchedProfileIndicator.getByText("Current Window", { exact: true })
    ).toBeVisible()
    await expect(
      launchedProfileIndicator.getByText("Writing Workspace", { exact: true })
    ).toBeVisible()
    await launchedProfileSettings
      .getByRole("button", { name: "Cancel" })
      .click()

    const profileWindowMarker = `profile-window-${process.pid}`
    await profilePage.evaluate((title) => {
      document.title = title
    }, profileWindowMarker)
    await expect
      .poll(() =>
        app?.evaluate(
          ({ BrowserWindow }, title) =>
            BrowserWindow.getAllWindows().some(
              (candidate) => candidate.getTitle() === title
            ),
          profileWindowMarker
        )
      )
      .toBe(true)
    const profileWindowClosed = profilePage.waitForEvent("close")
    await app.evaluate(({ BrowserWindow }, title) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === title
      )
      if (!window) throw new Error("Profile window was not found")
      window.close()
    }, profileWindowMarker)
    await profileWindowClosed
    await expect.poll(() => app?.windows().length ?? 0).toBe(sourceWindowCount)
    await page.bringToFront()

    workspace = await openWindowProfiles(page)
    profileCard = workspace
      .getByRole("heading", { name: "Writing Workspace" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    const deleteProfile = profileCard.getByRole("button", {
      name: "Delete Profile Writing Workspace",
    })
    await expect(deleteProfile).toBeEnabled()
    await deleteProfile.click()
    const profileDialog = page.getByRole("alertdialog", {
      name: "Delete Profile?",
    })
    await expectCompactAlertDialog(profileDialog)
    await expect(profileDialog).toContainText(
      "Documents and scratches are kept."
    )
    await profileDialog
      .getByRole("button", { name: "Delete Profile", exact: true })
      .click()
    await expect(profileCard).toHaveCount(0)
    await expect.poll(() => readIfPresent(profilePath)).toBeNull()
    await expect
      .poll(() => readIfPresent(sourcePath))
      .toBe("# Source document\n")
    await expect
      .poll(() => readIfPresent(scratchPath))
      .toContain("Remembered scratch text")

    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Manage Scratches" }).click()
    const scratchesWorkspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    const scratchOption = scratchesWorkspace.locator(
      `[role="option"][data-scratch-id="${scratchId}"]`
    )
    await expect(scratchOption).toContainText("Profile Notes")
    await scratchOption.click()
    const deleteScratch = scratchesWorkspace.getByRole("button", {
      name: "Delete Profile Notes",
    })
    await expect(deleteScratch).toBeEnabled()
    await deleteScratch.click()
    const scratchDialog = page.getByRole("alertdialog", {
      name: "Permanently Delete Scratch?",
    })
    await expectCompactAlertDialog(scratchDialog)
    await expect(scratchDialog).toContainText("This cannot be undone.")
    await scratchDialog
      .getByRole("button", { name: "Delete Scratch", exact: true })
      .click()
    await expect.poll(() => readIfPresent(scratchPath)).toBeNull()
    await expect(
      scratchesWorkspace.getByText("No scratches yet.")
    ).toBeVisible()

    await exitApplication(app)
    app = await launchApplication(userData)
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page).toHaveTitle("Untitled")
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("current-window composition preserves tab order, modes, and starting tab", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-seed-e2e-")
  )
  const firstPath = path.join(userData, "first.md")
  const secondPath = path.join(userData, "second.md")
  const profilePath = path.join(userData, "cli-profiles", "current-window.json")
  await Promise.all([
    writeFile(firstPath, "# First\n", "utf8"),
    writeFile(secondPath, "# Second\n", "utf8"),
  ])

  const app = await launchApplication(userData, firstPath, secondPath)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(
      page.getByRole("tablist", { name: "Open documents" }).getByRole("tab")
    ).toHaveCount(2)
    await expect(
      page
        .getByRole("tablist", { name: "Open documents" })
        .getByRole("tab")
        .first()
    ).toHaveCSS("font-size", "12px")
    await page.keyboard.press("Control+2")
    await expect(page).toHaveTitle("second.md")
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Shift+V"
    )
    await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await page.mouse.move(0, 0)
    const actualActiveTabStyle = await readTabSurfaceStyle(
      page.locator(".document-tab[data-active]")
    )

    const workspace = await openWindowProfiles(page)
    await workspace.getByRole("button", { name: "New Profile" }).click()
    await workspace.getByLabel("Profile Name").fill("Current Window")
    await workspace
      .getByRole("button", {
        name: "Use Current Window’s Tabs",
        exact: true,
      })
      .click()
    await expect(
      workspace.getByRole("textbox", { name: "Title", exact: true })
    ).toBeEnabled()
    await expect(
      workspace.getByRole("button", {
        name: "Starting Tab: second.md",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      workspace.getByRole("button", { name: "Edit 2: second.md" })
    ).toHaveAttribute("data-active", "true")
    await page.mouse.move(0, 0)
    expect(
      await readTabSurfaceStyle(
        workspace.getByRole("button", { name: "Edit 2: second.md" })
      )
    ).toEqual(actualActiveTabStyle)
    await workspace.getByRole("button", { name: "Save Profile" }).click()
    await expect.poll(() => readIfPresent(profilePath)).not.toBeNull()

    const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
      activeTab: string
      tabs: Array<{
        id: string
        kind: string
        mode: string
        path: string
      }>
    }
    expect(profile.tabs).toEqual([
      expect.objectContaining({
        kind: "file",
        mode: "live",
        path: firstPath,
      }),
      expect.objectContaining({
        kind: "file",
        mode: "source",
        path: secondPath,
      }),
    ])
    expect(profile.activeTab).toBe(profile.tabs[1]?.id)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("window profile navigation and composer controls stay compact and accessible", async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-window-profile-ui-e2e-")
  )
  const profilePath = path.join(userData, "cli-profiles", "ui-profile.json")
  const referenceTabPaths = [
    path.join(userData, "reference-one.md"),
    path.join(userData, "reference-two.md"),
  ]
  await Promise.all(
    referenceTabPaths.map((filePath, index) =>
      writeFile(filePath, `# Reference tab ${index + 1}\n`)
    )
  )

  const app = await launchApplication(userData, ...referenceTabPaths)
  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const realTabContent = page
      .locator(".document-tab-strip .document-tab-activation")
      .first()
    await expect(realTabContent).toHaveCount(1)
    const realTabContentStyles = await realTabContent.evaluate((element) => {
      const styles = getComputedStyle(element)
      return {
        alignItems: styles.alignItems,
        gap: styles.gap,
        paddingBottom: styles.paddingBottom,
        paddingLeft: styles.paddingLeft,
        paddingRight: styles.paddingRight,
        paddingTop: styles.paddingTop,
      }
    })

    const compactWindow = await setOrdinaryWindowSize(app, 900, 720)
    expect(compactWindow.fullScreen).toBe(false)
    expect(compactWindow.bounds.width).toBe(900)
    expect(compactWindow.bounds.height).toBe(720)

    let workspace = await openWindowProfiles(page)
    await expect(
      workspace.getByRole("button", { name: "Back to Settings" }).locator("svg")
    ).toHaveCount(1)
    await workspace.getByRole("button", { name: "New Profile" }).click()
    await expect(
      workspace.getByText(
        "Name this reusable window configuration and choose its defaults.",
        { exact: true }
      )
    ).toHaveCount(0)
    await expect(
      workspace.getByText(
        "Arrange the tabs this profile opens and choose the starting tab.",
        { exact: true }
      )
    ).toHaveCount(0)
    await expect(
      workspace.getByRole("button", { name: "Add Files", exact: true })
    ).toHaveCount(0)
    await expect(
      workspace
        .getByRole("button", { name: "Back to Window Profiles" })
        .locator("svg")
    ).toHaveCount(1)
    const composerColumns = workspace.locator("[data-profile-composer-columns]")
    const composerColumnsBox = await composerColumns.boundingBox()
    const workspaceBox = await workspace.boundingBox()
    expect(
      Math.abs(
        (composerColumnsBox?.x ?? 0) +
          (composerColumnsBox?.width ?? 0) / 2 -
          ((workspaceBox?.x ?? 0) + (workspaceBox?.width ?? 0) / 2)
      )
    ).toBeLessThan(3)
    await page.keyboard.press("Escape")
    await expect(
      workspace.getByRole("heading", { name: "Window Profiles" })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    const settingsDialog = page.getByRole("dialog", { name: "Settings" })
    await expect(settingsDialog).toBeVisible()
    await expectCollapsedSettingsSectionsToStayIntrinsic(page)

    const maximizedWindow = await maximizeOrdinaryWindow(app)
    expect(maximizedWindow.fullScreen).toBe(false)
    await expectCollapsedSettingsSectionsToStayIntrinsic(page)
    const maximizedSettingsGeometry = await settingsDialog.evaluate(
      (dialog) => ({
        dialogHeight: dialog.getBoundingClientRect().height,
        maximumHeight:
          window.innerHeight -
          2 *
            Number.parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue(
                "--window-chrome-height"
              )
            ),
      })
    )
    expect(maximizedSettingsGeometry.dialogHeight).toBeLessThan(
      maximizedSettingsGeometry.maximumHeight - 20
    )

    await settingsDialog
      .getByRole("button", { name: "View keyboard shortcuts" })
      .click()
    const keyboardShortcutsDialog = page.getByRole("dialog", {
      name: "Keyboard Shortcuts",
    })
    await expect(keyboardShortcutsDialog).toBeVisible()
    const keyboardShortcutsHeight = await keyboardShortcutsDialog.evaluate(
      (dialog) => dialog.getBoundingClientRect().height
    )
    expect(keyboardShortcutsHeight).toBeLessThanOrEqual(720.5)
    expect(keyboardShortcutsHeight).toBeLessThan(
      maximizedSettingsGeometry.maximumHeight - 20
    )
    await keyboardShortcutsDialog
      .getByRole("button", { name: "Back to Settings" })
      .click()
    await expect(settingsDialog).toBeVisible()

    await settingsDialog
      .getByRole("button", { name: "Manage Window Profiles" })
      .click()
    workspace = page.getByRole("region", {
      name: "Window Profiles Workspace",
    })
    await workspace.getByRole("button", { name: "New Profile" }).click()
    await workspace.getByLabel("Profile Name").fill("UI Profile")
    await expect(
      workspace.getByRole("combobox", {
        name: "Tabs Visibility",
        exact: true,
      })
    ).toBeVisible()
    const profileTabVisibility = workspace.getByRole("combobox", {
      name: "Tabs Visibility",
      exact: true,
    })
    await profileTabVisibility.click()
    await expect(
      page.locator('[data-slot="select-content"]:visible').getByRole("option")
    ).toHaveText([
      "App Setting",
      "Always",
      "With Multiple Tabs",
      "On Mouseover",
      "With Formatting Toolbar",
      "Hidden",
    ])
    await page.keyboard.press("Escape")
    await expect(
      workspace.getByRole("combobox", {
        name: "Tab Visibility",
        exact: true,
      })
    ).toHaveCount(0)
    await expect(
      workspace
        .getByRole("heading", { name: "Profile Details" })
        .locator('xpath=ancestor::*[@data-slot="card"]')
    ).toHaveCount(0)
    await expect(
      workspace
        .getByRole("heading", { name: "Tab Inspector" })
        .locator('xpath=ancestor::*[@data-slot="card"]')
    ).toHaveCount(0)

    const tabActions = workspace.locator("[data-profile-tab-actions]")
    const addTab = tabActions.getByRole("button", { name: "Add Tab" })
    const removeTab = tabActions.getByRole("button", { name: "Remove Tab" })
    const useCurrentTabs = workspace.getByRole("button", {
      name: "Use Current Window’s Tabs",
      exact: true,
    })
    await expect(tabActions.getByRole("button")).toHaveCount(2)
    await expect(useCurrentTabs).toHaveAttribute("data-variant", "outline")
    await expect(useCurrentTabs.locator("svg")).toHaveCount(0)
    await expect(useCurrentTabs).toHaveCSS(
      "color",
      await addTab.evaluate((button) => getComputedStyle(button).color)
    )
    await expect(removeTab).toBeDisabled()
    await expect(
      workspace.getByRole("textbox", { name: "Title", exact: true })
    ).toBeDisabled()
    await expect(
      workspace.getByRole("combobox", { name: "Type", exact: true })
    ).toBeDisabled()

    const addBox = await addTab.boundingBox()
    const removeBox = await removeTab.boundingBox()
    expect(Math.abs((addBox?.y ?? 0) - (removeBox?.y ?? 0))).toBeLessThan(2)
    expect(removeBox?.x).toBeGreaterThan(addBox?.x ?? Infinity)

    await addTab.click()
    await expect(removeTab).toBeEnabled()
    await workspace
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("First")
    await addTab.click()
    await workspace
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Second")

    await expect(
      workspace.getByRole("button", { name: "Edit 1: First" })
    ).toHaveAttribute("data-active", "true")
    const startingTab = workspace.getByRole("button", {
      name: "Starting Tab: First",
      exact: true,
    })
    await startingTab.hover()
    await expect(
      page
        .locator('[data-slot="tooltip-content"]')
        .filter({ hasText: "Starting Tab" })
    ).toBeVisible()
    await startingTab.press("ArrowDown")
    await expect(
      workspace.getByRole("button", {
        name: "Starting Tab: Second",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      workspace.getByRole("button", { name: "Edit 2: Second" })
    ).toHaveAttribute("data-active", "true")

    const composeTabsHeading = workspace.getByRole("heading", {
      name: "Compose Tabs",
    })
    const inspectorTitle = workspace.getByRole("textbox", {
      name: "Title",
      exact: true,
    })
    await inspectorTitle.focus()
    await expect(inspectorTitle).toBeFocused()
    await composeTabsHeading.click()
    await expect(inspectorTitle).not.toBeFocused()
    await expect(inspectorTitle).toBeEnabled()
    await expect(
      workspace.getByRole("button", { name: "Edit 2: Second" })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(removeTab).toBeEnabled()
    await composeTabsHeading.click()
    await expect(
      workspace.getByRole("textbox", { name: "Title", exact: true })
    ).toBeDisabled()
    await expect(
      workspace.getByRole("combobox", { name: "Type", exact: true })
    ).toBeDisabled()
    await expect(
      workspace.getByRole("combobox", { name: "Mode", exact: true })
    ).toBeDisabled()
    await expect(
      workspace.getByRole("combobox", { name: "Color", exact: true })
    ).toBeDisabled()
    await expect(removeTab).toBeDisabled()

    const firstTab = workspace.getByRole("button", { name: "Edit 1: First" })
    const secondTab = workspace.getByRole("button", {
      name: "Edit 2: Second",
    })
    await firstTab.click()
    await expect(firstTab).toHaveAttribute("aria-pressed", "true")
    await expect(firstTab.locator(".window-profile-tab-mark")).toHaveCount(0)
    await expect(secondTab.locator(".window-profile-tab-mark")).toHaveCount(0)
    await expect(removeTab).toBeEnabled()
    await expect(
      workspace.getByRole("button", { name: "Save Profile" })
    ).toBeEnabled()
    await expect(
      workspace.getByRole("button", { name: /Start Typing Here/ })
    ).toHaveCount(0)
    await expect(
      workspace.getByRole("button", { name: /Move (Left|Right)/ })
    ).toHaveCount(0)

    const colorTrigger = workspace.getByRole("combobox", {
      name: "Color",
      exact: true,
    })
    await expect(colorTrigger.locator(".window-profile-tab-mark")).toHaveCount(
      0
    )
    await colorTrigger.click()
    const colorPopup = page.locator('[data-slot="select-content"]:visible')
    const normalColorOption = colorPopup.getByRole("option", {
      name: "Normal",
      exact: true,
    })
    const redColorOption = colorPopup.getByRole("option", {
      name: "red",
      exact: true,
    })
    await expect(normalColorOption).toBeVisible()
    await expect(
      normalColorOption.locator(".window-profile-tab-mark")
    ).toHaveCount(0)
    await expect(redColorOption.locator("svg")).toHaveCount(1)
    const composeTabsHeadingBox = await composeTabsHeading.boundingBox()
    if (!composeTabsHeadingBox) {
      throw new Error("Compose Tabs heading was not laid out")
    }
    await page.mouse.click(
      composeTabsHeadingBox.x + composeTabsHeadingBox.width / 2,
      composeTabsHeadingBox.y + composeTabsHeadingBox.height / 2
    )
    await expect(colorPopup).toBeHidden()
    await expect(colorTrigger).not.toBeFocused()
    await expect(firstTab).toHaveAttribute("aria-pressed", "true")
    await expect(colorTrigger).toBeEnabled()
    await composeTabsHeading.click()
    await expect(colorTrigger).toBeDisabled()
    await firstTab.click()
    await colorTrigger.click()
    await page
      .locator('[data-slot="select-content"]:visible')
      .getByRole("option", { name: "red", exact: true })
      .click()
    await expect(
      colorTrigger.locator(".window-profile-tab-mark svg")
    ).toHaveCount(1)
    await expect(firstTab.locator(".window-profile-tab-mark svg")).toHaveCount(
      1
    )
    const expectTabContentToMatchRealTab = async (tabContent: Locator) => {
      await expect(tabContent).toHaveCSS(
        "align-items",
        realTabContentStyles.alignItems
      )
      await expect(tabContent).toHaveCSS("gap", realTabContentStyles.gap)
      await expect(tabContent).toHaveCSS(
        "padding-bottom",
        realTabContentStyles.paddingBottom
      )
      await expect(tabContent).toHaveCSS(
        "padding-left",
        realTabContentStyles.paddingLeft
      )
      await expect(tabContent).toHaveCSS(
        "padding-right",
        realTabContentStyles.paddingRight
      )
      await expect(tabContent).toHaveCSS(
        "padding-top",
        realTabContentStyles.paddingTop
      )
    }
    const composedTabContent = firstTab.locator(".document-tab-content")
    await expectTabContentToMatchRealTab(composedTabContent)
    await expect(colorTrigger.locator("[data-profile-color-value]")).toHaveCSS(
      "gap",
      "8px"
    )

    const profileTabs = workspace.getByRole("list", { name: "Profile tabs" })
    const secondTabBox = await secondTab.boundingBox()
    if (!secondTabBox) throw new Error("Second profile tab was not laid out")
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    await firstTab.dispatchEvent("dragstart", { dataTransfer })
    await secondTab.dispatchEvent("dragover", {
      clientY: secondTabBox.y + secondTabBox.height - 1,
      dataTransfer,
    })
    await expect(
      workspace.getByRole("button", { name: "Edit 1: Second" })
    ).toBeVisible()
    await expect(
      workspace.getByRole("button", { name: "Edit 2: First" })
    ).toBeVisible()
    await profileTabs.dispatchEvent("drop", {
      clientY: secondTabBox.y + secondTabBox.height - 1,
      dataTransfer,
    })
    await dataTransfer.dispose()
    await workspace.getByRole("button", { name: "Save Profile" }).click()
    await expect.poll(() => readIfPresent(profilePath)).not.toBeNull()

    const profileCard = workspace
      .getByRole("heading", { name: "UI Profile" })
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
    await expect(workspace.locator("[data-saved-profile-list]")).toHaveCSS(
      "flex-wrap",
      "wrap"
    )
    const profileCardBox = await profileCard.boundingBox()
    expect(profileCardBox?.width).toBeLessThan(400)
    await expect(
      profileCard.getByText("Default Mode: App Setting", { exact: true })
    ).toBeVisible()
    await expect(
      profileCard.getByText("Tabs Visibility: App Setting", { exact: true })
    ).toBeVisible()
    await expect(
      profileCard.getByRole("img", {
        name: "1. Second, starting tab",
      })
    ).toHaveAttribute("data-active", "true")
    const savedProfileTabs = profileCard.getByRole("list", {
      name: "UI Profile tabs",
    })
    const savedFirstTab = profileCard.getByRole("img", {
      name: "1. Second, starting tab",
    })
    const savedColoredTabContent = savedProfileTabs
      .getByRole("img", { name: "2. First" })
      .locator(".document-tab-content")
    await expectTabContentToMatchRealTab(savedColoredTabContent)
    const savedTabIndexes = savedProfileTabs.locator(
      "[data-saved-profile-tab-index]"
    )
    await expect(savedTabIndexes).toHaveText(["1", "2"])
    const profileHeading = profileCard.getByRole("heading", {
      name: "UI Profile",
    })
    const savedFirstIndex = savedTabIndexes.first()
    await expect(savedFirstIndex).toHaveCSS("text-align", "left")
    const [
      savedProfileTabsBox,
      savedFirstIndexBox,
      savedFirstTabBox,
      profileHeadingBox,
    ] = await Promise.all([
      savedProfileTabs.boundingBox(),
      savedFirstIndex.boundingBox(),
      savedFirstTab.boundingBox(),
      profileHeading.boundingBox(),
    ])
    const savedFirstIndexTextX = await savedFirstIndex.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().x
    })
    expect(savedProfileTabsBox?.x).toBe(profileHeadingBox?.x)
    expect(savedFirstIndexBox?.x).toBe(savedProfileTabsBox?.x)
    expect(savedFirstIndexTextX).toBe(profileHeadingBox?.x)
    expect(savedFirstTabBox?.x).toBeGreaterThan(
      (savedProfileTabsBox?.x ?? Infinity) + 24
    )
    await expect(profileCard.locator("[data-saved-profile-actions]")).toHaveCSS(
      "justify-content",
      "flex-end"
    )
    await expect(
      profileCard.getByRole("button", { name: "Launch" }).locator("svg")
    ).toHaveCount(0)
    await expect(
      profileCard.getByRole("button", { name: "Edit" }).locator("svg")
    ).toHaveCount(0)

    const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
      activeTab: string
      tabs: Array<{ id: string }>
    }
    expect(profile.tabs.map((tab) => tab.id)).toEqual([
      "untitled-2",
      "untitled",
    ])
    expect(profile.activeTab).toBe("untitled-2")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
