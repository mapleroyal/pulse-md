import path from "node:path"
import { fileURLToPath } from "node:url"
import {
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
  type Page,
  test,
} from "@playwright/test"

import {
  DEFAULT_APP_SETTINGS,
  type WindowProfile,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const originalContent = "# Research notes\nOriginal document contents\n"

async function launchApplication(userData: string) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })
}

async function createProfileFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-md-locate-"))
  const userData = path.join(directory, "user-data")
  const originalDirectory = path.join(directory, "original")
  const relocatedDirectory = path.join(directory, "relocated")
  const documentPath = path.join(originalDirectory, "documents", "notes.md")
  const relocatedPath = path.join(relocatedDirectory, "documents", "notes.md")
  const profilePath = path.join(userData, "cli-profiles", "research.json")
  const profile: WindowProfile = {
    version: 2,
    id: "research",
    name: "Research",
    activeTab: "notes",
    tabVisibility: "always",
    tabs: [
      { id: "other", kind: "untitled", title: "Other tab" },
      {
        id: "notes",
        kind: "file",
        path: documentPath,
        title: "Research Notes",
        color: "blue",
        mode: "source",
      },
    ],
  }
  await mkdir(path.dirname(profilePath), { recursive: true })
  await mkdir(path.dirname(documentPath), { recursive: true })
  await writeFile(documentPath, originalContent)
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify({ ...DEFAULT_APP_SETTINGS, defaultWindowProfileId: profile.id }, null, 2)}\n`
  )
  return {
    directory,
    documentPath,
    originalDirectory,
    profile,
    profilePath,
    relocatedDirectory,
    relocatedPath,
    userData,
  }
}

interface LocateDialogState {
  selectedPath: string | null
  openDialogs: Array<{ title?: string; properties?: string[] }>
  messages: Array<{ title?: string; buttons?: string[] }>
  resolveConfirmation?: (response: number) => void
}

async function stubLocateDialogs(
  app: ElectronApplication,
  selectedPath: string | null
) {
  await app.evaluate(({ dialog }, selectedPath) => {
    const testGlobal = globalThis as typeof globalThis & {
      locateFileTest: LocateDialogState
    }
    const state: LocateDialogState = {
      selectedPath,
      openDialogs: [],
      messages: [],
    }
    testGlobal.locateFileTest = state
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as {
        title?: string
        properties?: string[]
      }
      state.openDialogs.push({
        title: options.title,
        properties: options.properties,
      })
      return {
        canceled: state.selectedPath === null,
        filePaths: state.selectedPath ? [state.selectedPath] : [],
      }
    }) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string; buttons?: string[] }
      state.messages.push({ title: options.title, buttons: options.buttons })
      if (options.title !== "Replace Editor Contents") {
        return { checkboxChecked: false, response: 1 }
      }
      return new Promise((resolve) => {
        state.resolveConfirmation = (response) => {
          delete state.resolveConfirmation
          resolve({ checkboxChecked: false, response })
        }
      })
    }) as typeof dialog.showMessageBox
  }, selectedPath)
}

async function readLocateDialogs(app: ElectronApplication) {
  return app.evaluate(() => {
    const { openDialogs, messages } = (
      globalThis as typeof globalThis & { locateFileTest: LocateDialogState }
    ).locateFileTest
    return { openDialogs, messages }
  })
}

async function resolveLocateConfirmation(
  app: ElectronApplication,
  response: number
) {
  await app.evaluate((_, response) => {
    const state = (
      globalThis as typeof globalThis & { locateFileTest: LocateDialogState }
    ).locateFileTest
    if (!state.resolveConfirmation) {
      throw new Error("The replacement confirmation is not pending")
    }
    state.resolveConfirmation(response)
  }, response)
}

async function tabPresentation(page: Page) {
  return page.locator(".document-tab").evaluateAll((tabs) =>
    tabs.map((tab) => ({
      id: tab.getAttribute("data-tab-id"),
      color: tab.getAttribute("data-tab-color"),
      title: tab.querySelector(".path-filename-text")?.textContent,
      active: tab.hasAttribute("data-active"),
    }))
  )
}

for (const movedItem of ["file", "parent folder"] as const) {
  test(`Locate File repairs a cold profile after its ${movedItem} moved`, async () => {
    const fixture = await createProfileFixture()
    if (movedItem === "parent folder") {
      await rename(fixture.originalDirectory, fixture.relocatedDirectory)
    } else {
      await mkdir(path.dirname(fixture.relocatedPath), { recursive: true })
      await rename(fixture.documentPath, fixture.relocatedPath)
    }
    let app: ElectronApplication | null = await launchApplication(
      fixture.userData
    )

    try {
      let page = await app.firstWindow()
      await page.locator(".cm-editor").waitFor()
      const notice = page.locator('[data-recovery-notice="file-missing"]')
      await expect(notice).toBeVisible()
      await expect(page.getByRole("tab")).toHaveCount(2)
      await expect(page.locator(".cm-content")).toHaveText("")
      await expect(
        notice.getByRole("button", { name: "Recreate File" })
      ).toHaveCount(0)
      await expect(
        notice.getByRole("button", { name: "Save As…" })
      ).toHaveCount(0)
      const originalTabs = await tabPresentation(page)
      expect(originalTabs[1]).toMatchObject({
        active: true,
        color: "blue",
        title: "Research Notes",
      })
      await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)

      // Repair only the saved path, even when the saved definition has changed
      // since this window launched from it.
      const savedProfile: WindowProfile = {
        ...fixture.profile,
        name: "Research, updated",
        tabs: fixture.profile.tabs.map((tab) =>
          tab.id === "other" ? { ...tab, title: "Future other tab" } : tab
        ),
      }
      await page.evaluate(
        (profile) => window.pulseMd.saveWindowProfile(profile, true),
        savedProfile
      )
      await stubLocateDialogs(app, fixture.relocatedPath)
      await notice.getByRole("button", { name: "Locate File…" }).click()

      await expect(page.locator(".cm-content")).toContainText(
        "Original document contents"
      )
      await expect(notice).toHaveCount(0)
      await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
        "aria-label",
        fixture.relocatedPath
      )
      expect(await tabPresentation(page)).toEqual(originalTabs)
      await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
      await expect(page.getByLabel("Modified")).toHaveCount(0)
      expect(await readLocateDialogs(app)).toEqual({
        openDialogs: [{ title: "Locate File", properties: ["openFile"] }],
        messages: [],
      })
      const repairedProfile = {
        ...savedProfile,
        tabs: savedProfile.tabs.map((tab) =>
          tab.kind === "file" ? { ...tab, path: fixture.relocatedPath } : tab
        ),
      }
      await expect
        .poll(async () =>
          JSON.parse(await readFile(fixture.profilePath, "utf8"))
        )
        .toEqual(repairedProfile)
      await expect(readFile(fixture.documentPath)).rejects.toMatchObject({
        code: "ENOENT",
      })
      expect(await readFile(fixture.relocatedPath, "utf8")).toBe(
        originalContent
      )

      await writeFile(fixture.relocatedPath, "# Updated after repair\n")
      await expect(page.locator(".cm-content")).toContainText(
        "Updated after repair"
      )
      await expect(page.getByLabel("Modified")).toHaveCount(0)
      await exitApplication(app)
      app = null
      app = await launchApplication(fixture.userData)
      page = await app.firstWindow()
      await expect(page.locator(".cm-content")).toContainText(
        "Updated after repair"
      )
      await expect(
        page.locator('[data-recovery-notice="file-missing"]')
      ).toHaveCount(0)
      await expect(page.getByRole("tab").nth(0)).toContainText(
        "Future other tab"
      )
      await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
        "aria-label",
        fixture.relocatedPath
      )
      await expect(page.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    } finally {
      if (app) await exitApplication(app)
      await rm(fixture.directory, { force: true, recursive: true })
    }
  })
}

test("Locate File cancellation and invalid UTF-8 preserve a cold missing profile", async () => {
  const fixture = await createProfileFixture()
  await rename(fixture.originalDirectory, fixture.relocatedDirectory)
  const invalidPath = path.join(fixture.directory, "invalid.md")
  const invalidBytes = Buffer.from([0x23, 0x20, 0x80, 0x0a])
  await writeFile(invalidPath, invalidBytes)
  const app = await launchApplication(fixture.userData)

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const notice = page.locator('[data-recovery-notice="file-missing"]')
    const locate = notice.getByRole("button", { name: "Locate File…" })
    await expect(locate).toBeVisible()
    const originalTabs = await tabPresentation(page)
    const savedProfile = await readFile(fixture.profilePath, "utf8")
    await stubLocateDialogs(app, null)
    await locate.click()
    await expect
      .poll(async () => (await readLocateDialogs(app)).openDialogs.length)
      .toBe(1)
    await expect(locate).toBeEnabled()
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true"
    )
    await expect(page.locator(".cm-content")).toHaveText("")
    expect(await tabPresentation(page)).toEqual(originalTabs)
    expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)

    await stubLocateDialogs(app, invalidPath)
    await locate.click()
    await expect(notice).toHaveAttribute("role", "alert")
    await expect(notice).toContainText(/UTF-8|could not be located/i)
    await expect(locate).toBeEnabled()
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true"
    )
    await expect(page.locator(".cm-content")).toHaveText("")
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-label",
      `${fixture.documentPath} — file deleted or moved`
    )
    expect(await tabPresentation(page)).toEqual(originalTabs)
    expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)
    expect(await readFile(invalidPath)).toEqual(invalidBytes)
    expect(await readFile(fixture.relocatedPath, "utf8")).toBe(originalContent)
    expect((await readLocateDialogs(app)).messages).toEqual([])
    await expect(
      notice.getByRole("button", { name: "Recreate File" })
    ).toHaveCount(0)
    await expect(notice.getByRole("button", { name: "Save As…" })).toHaveCount(
      0
    )
  } finally {
    await exitApplication(app)
    await rm(fixture.directory, { force: true, recursive: true })
  }
})

test("Locate File explicitly confirms replacing unsaved retained contents", async () => {
  const fixture = await createProfileFixture()
  const selectedContent = "# Selected file\nThe current contents on disk\n"
  const localContent = "Unsaved local work that must survive cancellation"
  const app = await launchApplication(fixture.userData)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-content")
    await expect(editor).toContainText("Original document contents")
    await mkdir(path.dirname(fixture.relocatedPath), { recursive: true })
    await rename(fixture.documentPath, fixture.relocatedPath)
    await writeFile(fixture.relocatedPath, selectedContent)
    const notice = page.locator('[data-recovery-notice="file-missing"]')
    const locate = notice.getByRole("button", { name: "Locate File…" })
    await expect(locate).toBeVisible()
    await editor.click()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A"
    )
    await page.keyboard.insertText(localContent)
    await expect(page.getByLabel("Modified")).toBeVisible()
    await expect(
      notice.getByRole("button", { name: "Recreate File" })
    ).toBeVisible()
    await expect(notice.getByRole("button", { name: "Save As…" })).toBeVisible()
    const originalTabs = await tabPresentation(page)
    const savedProfile = await readFile(fixture.profilePath, "utf8")
    const invalidPath = path.join(fixture.directory, "invalid.md")
    await writeFile(invalidPath, Buffer.from([0xc3, 0x28]))
    await stubLocateDialogs(app, invalidPath)
    await locate.click()
    await expect(notice).toHaveAttribute("role", "alert")
    await expect(notice).toContainText(/UTF-8|could not be located/i)
    await expect(editor).toHaveAttribute("contenteditable", "true")
    await expect(editor).toContainText(localContent)
    await expect(page.getByLabel("Modified")).toBeVisible()
    expect(await tabPresentation(page)).toEqual(originalTabs)
    expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)
    expect((await readLocateDialogs(app)).messages).toEqual([])
    await stubLocateDialogs(app, fixture.relocatedPath)

    for (const response of [1, 0]) {
      await locate.click()
      await expect
        .poll(async () => (await readLocateDialogs(app)).messages.length)
        .toBe(response === 1 ? 1 : 2)
      await expect(editor).toHaveAttribute("contenteditable", "false")
      await expect(editor).toContainText(localContent)
      expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)
      expect(await readFile(fixture.relocatedPath, "utf8")).toBe(
        selectedContent
      )
      await resolveLocateConfirmation(app, response)
      await expect(editor).toHaveAttribute("contenteditable", "true")
      if (response === 1) {
        await expect(locate).toBeEnabled()
        await expect(editor).toContainText(localContent)
        await expect(page.getByLabel("Modified")).toBeVisible()
        await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
          "aria-label",
          `${fixture.documentPath} — file deleted or moved, modified`
        )
        expect(await tabPresentation(page)).toEqual(originalTabs)
        expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)
      }
    }
    await expect(editor).toContainText("The current contents on disk")
    await expect(notice).toHaveCount(0)
    await expect(page.getByLabel("Modified")).toHaveCount(0)
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-label",
      fixture.relocatedPath
    )
    expect(await tabPresentation(page)).toEqual(originalTabs)
    expect((await readLocateDialogs(app)).messages).toEqual([
      {
        title: "Replace Editor Contents",
        buttons: ["Load Selected File", "Cancel"],
      },
      {
        title: "Replace Editor Contents",
        buttons: ["Load Selected File", "Cancel"],
      },
    ])
    expect(await readFile(fixture.relocatedPath, "utf8")).toBe(selectedContent)
    await expect(readFile(fixture.documentPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect
      .poll(async () => JSON.parse(await readFile(fixture.profilePath, "utf8")))
      .toEqual({
        ...fixture.profile,
        tabs: fixture.profile.tabs.map((tab) =>
          tab.kind === "file" ? { ...tab, path: fixture.relocatedPath } : tab
        ),
      })
  } finally {
    await exitApplication(app)
    await rm(fixture.directory, { force: true, recursive: true })
  }
})

test("a pending Locate File picker does not block managed work or replace a different active tab", async () => {
  const fixture = await createProfileFixture()
  const app = await launchApplication(fixture.userData)

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-content")
    await expect(editor).toContainText("Original document contents")
    await mkdir(path.dirname(fixture.relocatedPath), { recursive: true })
    await rename(fixture.documentPath, fixture.relocatedPath)
    const notice = page.locator('[data-recovery-notice="file-missing"]')
    await expect(notice).toBeVisible()
    const originalTabId = await page
      .getByRole("tab")
      .nth(1)
      .getAttribute("data-tab-id")
    const savedProfile = await readFile(fixture.profilePath, "utf8")
    await stubLocateDialogs(app, fixture.relocatedPath)
    await app.evaluate(({ dialog }, selectedPath) => {
      const testGlobal = globalThis as typeof globalThis & {
        resolveLocateRacePicker?: () => void
      }
      dialog.showOpenDialog = (() =>
        new Promise((resolve) => {
          testGlobal.resolveLocateRacePicker = () => {
            delete testGlobal.resolveLocateRacePicker
            resolve({ canceled: false, filePaths: [selectedPath] })
          }
        })) as typeof dialog.showOpenDialog
    }, fixture.relocatedPath)
    await notice.getByRole("button", { name: "Locate File…" }).click()
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                resolveLocateRacePicker?: () => void
              }
            ).resolveLocateRacePicker
          )
        )
      )
      .toBe(true)
    await expect(editor).toHaveAttribute("contenteditable", "false")
    await expect(editor).toContainText("Original document contents")

    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item =
        Menu.getApplicationMenu()?.getMenuItemById("file-new-scratch")
      const win = BrowserWindow.getAllWindows()[0]
      if (!item || !win) throw new Error("New Scratch is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect(page.getByRole("tab")).toHaveCount(3)
    const scratchTabId = await page
      .locator(".document-tab[data-active]")
      .getAttribute("data-tab-id")
    expect(scratchTabId).not.toBe(originalTabId)

    await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        resolveLocateRacePicker?: () => void
      }
      if (!testGlobal.resolveLocateRacePicker)
        throw new Error("Locate File is not pending")
      testGlobal.resolveLocateRacePicker()
    })
    await expect(editor).toHaveAttribute("contenteditable", "true")
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      scratchTabId!
    )
    await expect(editor).toHaveText("")
    expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)

    await page.getByRole("tab").nth(1).click()
    await expect(editor).toContainText("Original document contents")
    await expect(notice).toBeVisible()
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
      "data-tab-id",
      originalTabId!
    )
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-label",
      `${fixture.documentPath} — file deleted or moved`
    )
    expect(await readFile(fixture.profilePath, "utf8")).toBe(savedProfile)
    expect(await readFile(fixture.relocatedPath, "utf8")).toBe(originalContent)
    expect((await readLocateDialogs(app)).messages).toEqual([])
  } finally {
    await exitApplication(app)
    await rm(fixture.directory, { force: true, recursive: true })
  }
})
