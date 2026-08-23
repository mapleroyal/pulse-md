import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  test,
} from "@playwright/test"

import { ScratchStore } from "../../electron/scratch-store"
import { exitApplication, setWindowContentSize } from "./electron-helpers"
import { seedScratchStore } from "./scratch-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const primaryModifier = process.platform === "darwin" ? "Meta" : "Control"
const settingsShortcut = process.platform === "darwin" ? "Meta+," : "Control+,"
const automaticScratchFileName =
  /^scratch-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.md$/

async function clickMenuItem(app: ElectronApplication, menuItemId: string) {
  await app.evaluate(({ BrowserWindow, Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed()
      )
    if (!item || !win) throw new Error(`${id} is unavailable`)
    item.click(undefined, win, win.webContents)
  }, menuItemId)
}

async function menuItemEnabled(app: ElectronApplication, menuItemId: string) {
  return app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    if (!item) throw new Error(`${id} is unavailable`)
    return item.enabled
  }, menuItemId)
}

async function expectFullyInsideViewport(locator: Locator) {
  const geometry = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return {
      bottom: bounds.bottom,
      height: bounds.height,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      width: bounds.width,
    }
  })
  expect(geometry.width).toBeGreaterThan(0)
  expect(geometry.height).toBeGreaterThan(0)
  expect(geometry.left).toBeGreaterThanOrEqual(-1)
  expect(geometry.top).toBeGreaterThanOrEqual(-1)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1)
}

const scratchFixtures = [
  {
    content: "# Alpha Scratch\n\nFirst scratch notes.\n",
    createdAt: 1_725_000_000_000,
    fileName: "alpha.md",
    id: "10000000-0000-4000-8000-000000000001",
    lastOpenedAt: 1_725_000_000_300,
    title: "Alpha",
  },
  {
    content: "# Beta Scratch\n\nSecond scratch notes.\n",
    createdAt: 1_725_000_000_100,
    fileName: "beta.md",
    id: "10000000-0000-4000-8000-000000000002",
    lastOpenedAt: 1_725_000_000_200,
    title: "Beta",
  },
  {
    content: "# Gamma Scratch\n\nThird scratch notes.\n",
    createdAt: 1_725_000_000_200,
    fileName: "gamma.md",
    id: "10000000-0000-4000-8000-000000000003",
    lastOpenedAt: 1_725_000_000_100,
    title: "Gamma",
  },
] as const

test("scratch inventory marks unavailable profile references without failing metadata updates", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-reference-status-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  await new ScratchStore(userData).markLegacyMigrationComplete()
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(path.join(profileDirectory, "broken.json"), "{broken", "utf8")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()

    const inventory = await page.evaluate(() =>
      window.pulseMd.getScratches("", "last-opened", "scratch-browser")
    )
    expect(inventory.profileReferencesAvailable).toBe(false)
    expect(inventory.entries.map(({ scratchId }) => scratchId)).toEqual([
      alpha.id,
    ])

    await page.evaluate(
      ({ scratchId }) =>
        window.pulseMd.updateScratch(scratchId, { title: "Updated Alpha" }),
      { scratchId: alpha.id }
    )
    const updated = await page.evaluate(() =>
      window.pulseMd.getScratches("", "last-opened", "scratch-browser")
    )
    expect(updated.profileReferencesAvailable).toBe(false)
    expect(updated.entries[0]?.title).toBe("Updated Alpha")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("scratch picker keeps search-first keyboard and pointer interactions", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-picker-e2e-")
  )
  await seedScratchStore(userData, scratchFixtures)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await clickMenuItem(app, "file-open-scratch")

    const picker = page.getByRole("dialog", { name: "Open Scratch" })
    const pickerSurface = picker.locator("[data-scratch-picker]")
    const search = picker.getByRole("combobox", {
      name: "Search scratches",
    })
    const option = (scratchId: string) =>
      picker.locator(`[role="option"][data-scratch-id="${scratchId}"]`)
    const [alpha, beta, gamma] = scratchFixtures

    await expect(picker).toBeVisible()
    const initialSearchNode = await search.elementHandle()
    expect(initialSearchNode).not.toBeNull()
    if (process.platform === "darwin") {
      await app.evaluate(({ BrowserWindow }) => {
        const window =
          BrowserWindow.getFocusedWindow() ??
          BrowserWindow.getAllWindows().find(
            (candidate) => !candidate.isDestroyed() && candidate.isVisible()
          )
        const contents = window?.webContents
        if (!contents) throw new Error("The scratch window is unavailable")
        contents.sendInputEvent({ type: "keyDown", keyCode: "x" })
        contents.sendInputEvent({ type: "char", keyCode: "x" })
        contents.sendInputEvent({ type: "keyUp", keyCode: "x" })
      })
      await expect(search).toHaveValue("x")
      await page.keyboard.press("Backspace")
    }
    await page.keyboard.type("s")
    await expect(search).toHaveValue("s")
    await expect(search).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(option(beta.id)).toHaveAttribute("aria-selected", "true")
    await page.keyboard.type("c")
    await expect(search).toHaveValue("sc")
    await expect(search).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await expect(option(alpha.id)).toHaveAttribute("aria-selected", "true")
    await page.keyboard.type("r")
    await expect(search).toHaveValue("scr")
    await expect(picker).toBeVisible()
    await expect(search).toBeFocused()
    await expect(option(alpha.id)).toHaveAttribute("aria-selected", "true")
    expect(
      await initialSearchNode?.evaluate(
        (node) =>
          node.isConnected &&
          node === document.activeElement &&
          node ===
            document.querySelector(
              '[role="combobox"][aria-label="Search scratches"]'
            )
      )
    ).toBe(true)
    await page.keyboard.press("Escape")
    await expect(search).toHaveValue("")
    await expect(option(alpha.id)).toHaveAttribute("aria-selected", "true")
    const renderedPreviewContent = picker.locator(
      "[data-scratch-markdown-preview] .cm-content"
    )
    await expect(renderedPreviewContent).toHaveAttribute(
      "contenteditable",
      "false"
    )
    const initialPreviewContentNode =
      await renderedPreviewContent.elementHandle()
    expect(initialPreviewContentNode).not.toBeNull()

    const initialTabId = await page
      .locator(".document-tab[data-active]")
      .getAttribute("data-tab-id")
    await page.keyboard.type("Gamma")
    await page.keyboard.press("Enter")
    await expect(picker).toBeVisible()
    await expect(search).toBeFocused()
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      initialTabId ?? ""
    )
    await expect(option(gamma.id)).toBeVisible()
    await expect(pickerSurface).toHaveAttribute("data-results-current", "true")
    await search.press("Escape")
    await expect(search).toHaveValue("")
    await expect(picker.getByRole("option")).toHaveCount(3)
    await option(alpha.id).click()
    await expect(option(alpha.id)).toHaveAttribute("aria-selected", "true")

    await search.press(`${primaryModifier}+T`)
    await expect(page.locator('[role="tab"]')).toHaveCount(1)
    await expect(picker).toBeVisible()
    await expect(search).toBeFocused()

    await search.press("ArrowUp")
    await expect(option(gamma.id)).toHaveAttribute("aria-selected", "true")
    await search.press("ArrowDown")
    await expect(option(alpha.id)).toHaveAttribute("aria-selected", "true")
    await search.press("ArrowDown")
    await expect(option(beta.id)).toHaveAttribute("aria-selected", "true")
    await search.press("ArrowLeft")
    await search.press("ArrowRight")
    await expect(option(beta.id)).toHaveAttribute("aria-selected", "true")

    await option(gamma.id).click()
    await expect(option(gamma.id)).toHaveAttribute("aria-selected", "true")
    await expect(option(gamma.id)).toBeFocused()

    await search.fill("No matching scratch")
    await expect(picker.getByRole("option")).toHaveCount(0)
    expect(
      await initialPreviewContentNode?.evaluate(
        (node) => node.isConnected && node.matches(".cm-content")
      )
    ).toBe(true)
    await search.press("Escape")
    await search.fill("Alpha")
    await expect(picker.getByRole("option")).toHaveCount(1)
    await search.press("Escape")
    await expect(search).toHaveValue("")
    await expect(picker).toBeVisible()
    await expect(search).toBeFocused()
    await expect(picker.getByRole("option")).toHaveCount(3)
    await search.press("Escape")
    await expect(picker).toBeHidden()

    await clickMenuItem(app, "file-open-scratch")
    await search.fill("Alpha")
    await expect(option(alpha.id)).toBeVisible()
    await expect(pickerSurface).toHaveAttribute("data-results-current", "true")
    await search.press("Enter")
    await expect(picker).toBeHidden()
    await expect(page.locator(".document-tab")).toHaveCount(1)
    await expect(page).toHaveTitle("Alpha")

    await clickMenuItem(app, "file-open-scratch")
    await search.fill("Alpha")
    await expect(option(alpha.id)).toBeVisible()
    await expect(pickerSurface).toHaveAttribute("data-results-current", "true")
    await search.press("Enter")
    await expect(picker).toBeHidden()
    await expect(page.getByRole("tab")).toHaveCount(1)
    await expect(page).toHaveTitle("Alpha")

    await clickMenuItem(app, "file-open-scratch")
    await search.fill("Beta")
    await expect(option(beta.id)).toBeVisible()
    await expect(pickerSurface).toHaveAttribute("data-results-current", "true")
    await search.press(`${primaryModifier}+Enter`)
    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(page).toHaveTitle("Beta")
    await expect(picker).toBeHidden()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("scratch picker preserves immediate arrows and search focus while empty previews load", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-picker-focus-e2e-")
  )
  const emptyScratch = {
    content: "",
    createdAt: 1_725_000_000_400,
    fileName: "empty.md",
    id: "10000000-0000-4000-8000-000000000004",
    lastOpenedAt: 1_725_000_000_400,
    title: "Empty",
  }
  await seedScratchStore(userData, [...scratchFixtures, emptyScratch])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  const releaseInventory = () =>
    app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseScratchPickerInventory?: () => void
      }
      testGlobal.releaseScratchPickerInventory?.()
      delete testGlobal.releaseScratchPickerInventory
    })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const inventory = await page.evaluate(() =>
      window.pulseMd.getScratches("", "last-opened", "scratch-browser")
    )
    await app.evaluate(({ ipcMain }, completeInventory) => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseScratchPickerInventory?: () => void
      }
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      testGlobal.releaseScratchPickerInventory = release
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle(
        "pulse-md:get-scratches",
        async (_event, rawQuery: unknown) => {
          await gate
          const query =
            typeof rawQuery === "string" ? rawQuery.trim().toLowerCase() : ""
          return {
            ...completeInventory,
            entries: query
              ? completeInventory.entries.filter((entry) =>
                  [entry.displayTitle, entry.fileName, entry.excerpt].some(
                    (value) => value.toLowerCase().includes(query)
                  )
                )
              : completeInventory.entries,
          }
        }
      )
    }, inventory)

    await clickMenuItem(app, "file-open-scratch")
    const picker = page.getByRole("dialog", { name: "Open Scratch" })
    const search = picker.getByRole("combobox", {
      name: "Search scratches",
    })
    const option = (scratchId: string) =>
      picker.locator(`[role="option"][data-scratch-id="${scratchId}"]`)
    const [, beta, gamma] = scratchFixtures

    await expect(picker).toBeVisible()
    const initialSearchNode = await search.elementHandle()
    expect(initialSearchNode).not.toBeNull()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type("s")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type("c")
    await expect(search).toHaveValue("sc")
    await expect(search).toBeFocused()
    await releaseInventory()
    await expect(option(gamma.id)).toHaveAttribute("aria-selected", "true")
    await expect(search).toBeFocused()
    expect(
      await initialSearchNode?.evaluate(
        (node) => node.isConnected && node === document.activeElement
      )
    ).toBe(true)

    await page.keyboard.press("Escape")
    await page.keyboard.type("Empty")
    await expect(option(emptyScratch.id)).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await picker
      .locator(`[data-scratch-preview-id="${emptyScratch.id}"]`)
      .waitFor()
    await expect(search).toBeFocused()

    await page.keyboard.press("Escape")
    await page.keyboard.type("B")
    await expect(option(beta.id)).toHaveAttribute("aria-selected", "true")
    await expect(search).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type("e")
    await expect(search).toHaveValue("Be")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.type("t")
    await expect(search).toHaveValue("Bet")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Backspace")
    await page.keyboard.type("t")
    await expect(search).toHaveValue("Bet")
    await expect(option(beta.id)).toHaveAttribute("aria-selected", "true")
    await expect(search).toBeFocused()
  } finally {
    await releaseInventory().catch(() => undefined)
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("scratch tabs and preview actions edit metadata and return to their origin", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-picker-edit-e2e-")
  )
  await seedScratchStore(userData, scratchFixtures)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const [, beta, gamma] = scratchFixtures

    await clickMenuItem(app, "file-open-scratch")
    let picker = page.getByRole("dialog", { name: "Open Scratch" })
    const betaOption = picker.locator(
      `[role="option"][data-scratch-id="${beta.id}"]`
    )
    await betaOption.click()
    await picker
      .getByRole("button", { name: "Open Scratch in New Tab" })
      .click()
    await expect(picker).toBeHidden()
    const betaTab = page.locator(".document-tab[data-active]")
    await expect(betaTab.getByRole("tab")).toHaveAccessibleName("Beta")
    await betaTab.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Edit Scratch" }).click()

    let workspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    await expect(workspace.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Beta"
    )
    await expect(
      workspace.locator(`[role="option"][data-scratch-id="${beta.id}"]`)
    ).toHaveAttribute("aria-selected", "true")
    await expect
      .poll(() =>
        workspace.evaluate((element) =>
          element.contains(document.activeElement)
        )
      )
      .toBe(true)

    await page.keyboard.press("Escape")
    await expect(workspace).toBeHidden()
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
    await expect(
      page.getByRole("dialog", { name: "Open Scratch" })
    ).toHaveCount(0)
    await expect(betaTab).toHaveAttribute("data-active", "true")
    await expect(page.locator(".cm-content")).toBeFocused()

    await clickMenuItem(app, "file-open-scratch")
    picker = page.getByRole("dialog", { name: "Open Scratch" })
    const search = picker.getByRole("combobox", { name: "Search scratches" })
    const gammaOption = picker.locator(
      `[role="option"][data-scratch-id="${gamma.id}"]`
    )
    await expect(picker).toBeVisible()
    await expect(search).toBeFocused()
    await page.keyboard.type("Gamma")
    await expect(gammaOption).toHaveAttribute("aria-selected", "true")
    await picker.getByRole("button", { name: "Edit", exact: true }).click()

    workspace = page.getByRole("region", { name: "Scratches Workspace" })
    await expect(workspace.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Gamma"
    )
    await expect(
      workspace.locator(`[role="option"][data-scratch-id="${gamma.id}"]`)
    ).toHaveAttribute("aria-selected", "true")
    await workspace
      .getByRole("button", { name: "Back to Open Scratch" })
      .click()
    await expect(workspace).toBeHidden()
    await expect(picker).toBeVisible()
    await expect(search).toHaveValue("Gamma")
    await expect(search).toBeFocused()
    await expect(gammaOption).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("scratch picker keeps its selected result actions reachable at minimum size and maximum zoom", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-picker-compact-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await setWindowContentSize(app, 480, 320)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480)
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(320)
    await clickMenuItem(app, "file-open-scratch")

    const picker = page.getByRole("dialog", { name: "Open Scratch" })
    const search = picker.getByRole("combobox", {
      name: "Search scratches",
    })
    const sort = picker.getByRole("combobox", { name: "Sort scratches" })
    const selectedResult = picker.locator(
      `[role="option"][data-scratch-id="${alpha.id}"]`
    )
    const open = picker.getByRole("button", { name: "Open", exact: true })
    const openInNewTab = picker.getByRole("button", {
      name: "Open Scratch in New Tab",
    })
    const expectCompactPickerReachable = async () => {
      await expect(picker).toBeVisible()
      await expect(selectedResult).toHaveAttribute("aria-selected", "true")
      await expect(open).toBeEnabled()
      for (const surface of [
        picker,
        search,
        sort,
        selectedResult,
        open,
        openInNewTab,
      ]) {
        await expectFullyInsideViewport(surface)
      }
    }

    await expectCompactPickerReachable()
    await search.press("Escape")
    await expect(picker).toBeHidden()
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(160)
    await clickMenuItem(app, "file-open-scratch")
    await expectCompactPickerReachable()

    await open.click()
    await expect(picker).toBeHidden()
    await expect(page).toHaveTitle("Alpha")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a failed scratch inventory stays distinct from empty and can be retried", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-inventory-retry-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const inventory = await page.evaluate(() =>
      window.pulseMd.getScratches("", "last-opened", "scratch-browser")
    )
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", () => {
        throw new Error("Injected inventory load failure")
      })
    })

    await clickMenuItem(app, "file-open-scratch")
    const browser = page.getByRole("dialog", { name: "Open Scratch" })
    await expect(
      browser.getByRole("alert").filter({
        hasText: "Injected inventory load failure",
      })
    ).toBeVisible()
    await expect(browser.getByText("No scratches yet.")).toHaveCount(0)
    await expect(browser.getByText("Scratch list unavailable.")).toBeVisible()

    await app.evaluate(({ ipcMain }, recoveredInventory) => {
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", () => recoveredInventory)
    }, inventory)
    await browser.getByRole("button", { name: "Retry" }).click()
    await expect(
      browser.locator(`[role="option"][data-scratch-id="${alpha.id}"]`)
    ).toBeVisible()
    await expect(browser.getByRole("alert")).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("scratch creation stays committed when its inventory refresh fails", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-create-refresh-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Manage Scratches" }).click()
    const workspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    const deleteAlpha = workspace.getByRole("button", {
      name: "Delete Alpha",
    })
    await expect(deleteAlpha).toBeEnabled()

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", () => {
        throw new Error("Injected inventory refresh failure")
      })
    })
    await workspace.getByRole("button", { name: "New Scratch" }).click()

    await expect(
      workspace.getByRole("alert").filter({
        hasText:
          "The scratch was created, but the list could not be refreshed.",
      })
    ).toBeVisible()
    await expect(workspace.locator("[data-scratch-picker]")).toHaveAttribute(
      "data-results-current",
      "false"
    )
    await expect(deleteAlpha).toBeDisabled()
    await expect
      .poll(async () => {
        const catalog = JSON.parse(
          await readFile(
            path.join(userData, "scratch", ".catalog.json"),
            "utf8"
          )
        ) as { entries: unknown[] }
        return catalog.entries.length
      })
      .toBe(2)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("unavailable profile references disable only scratch deletion", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-reference-status-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })
  const releaseInventoryRefresh = () =>
    app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseScratchReferenceRefresh?: () => void
      }
      testGlobal.releaseScratchReferenceRefresh?.()
      delete testGlobal.releaseScratchReferenceRefresh
    })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const inventory = await page.evaluate(() =>
      window.pulseMd.getScratches("", "last-opened", "scratch-browser")
    )
    await app.evaluate(({ ipcMain }, degradedInventory) => {
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", () => ({
        ...degradedInventory,
        profileReferencesAvailable: false,
      }))
    }, inventory)

    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Manage Scratches" }).click()
    const workspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    await expect(
      workspace.getByRole("alert").filter({
        hasText: "Profile references could not be checked.",
      })
    ).toBeVisible()
    const open = workspace.getByRole("button", { name: "Open", exact: true })
    await expect(open).toBeEnabled()
    const picker = workspace.locator("[data-scratch-picker]")
    await expect(picker).toHaveAttribute("data-results-current", "true")
    const title = workspace.getByRole("textbox", { name: "Title" })
    await expect(title).toBeEnabled()
    await app.evaluate(({ ipcMain }, degradedInventory) => {
      const testGlobal = globalThis as typeof globalThis & {
        releaseScratchReferenceRefresh?: () => void
      }
      let releaseRefresh: () => void = () => undefined
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      testGlobal.releaseScratchReferenceRefresh = releaseRefresh
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", async () => {
        await refreshGate
        return {
          ...degradedInventory,
          profileReferencesAvailable: false,
        }
      })
    }, inventory)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(picker).toHaveAttribute("data-results-current", "false")
    await expect(open).toBeDisabled()
    await expect(title).toBeEnabled()
    await title.focus()
    await title.press(`${primaryModifier}+A`)
    const updatedTitle = "Editable while references recover"
    await title.pressSequentially(updatedTitle)
    await expect(title).toHaveValue(updatedTitle)
    await expect(
      workspace.getByRole("button", { name: "Save Details" })
    ).toBeEnabled()
    await expect(
      workspace.getByRole("button", { name: "Delete Alpha" })
    ).toBeDisabled()
    await releaseInventoryRefresh()
    await expect(picker).toHaveAttribute("data-results-current", "true")
    await expect(open).toBeEnabled()
    await expect(
      workspace.getByRole("button", { name: "Delete Alpha" })
    ).toBeDisabled()
  } finally {
    await releaseInventoryRefresh().catch(() => undefined)
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("successful scratch deletion closes its confirmation and clears its dirty draft before refresh recovery", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-delete-refresh-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Manage Scratches" }).click()
    const workspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    await workspace.getByRole("textbox", { name: "Title" }).fill("Dirty title")
    await workspace.getByRole("button", { name: "Delete Alpha" }).click()
    const confirmation = page.getByRole("alertdialog", {
      name: "Permanently Delete Scratch?",
    })
    await expect(confirmation).toBeVisible()

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:get-scratches")
      ipcMain.handle("pulse-md:get-scratches", () => {
        throw new Error("Injected inventory refresh failure")
      })
    })
    await confirmation
      .getByRole("button", { name: "Delete Scratch", exact: true })
      .click()

    await expect(confirmation).toHaveCount(0)
    await expect(
      workspace.getByRole("alert").filter({
        hasText:
          "The scratch was deleted, but the list could not be refreshed.",
      })
    ).toBeVisible()
    await expect(
      readFile(path.join(userData, "scratch", alpha.fileName), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" })
    await workspace.getByRole("button", { name: "Back to Settings" }).click()
    await expect(settings).toBeVisible()
    await expect(
      page.getByRole("alertdialog", { name: "Discard Unsaved Details?" })
    ).toHaveCount(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("scratch delete failures stay inside their viewport-bounded confirmation", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-delete-failure-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await setWindowContentSize(app, 480, 320)
    await page.evaluate(() => window.pulseMd.previewWindowZoom(2))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(240)
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(160)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("pulse-md:delete-scratch")
      ipcMain.handle("pulse-md:delete-scratch", () => {
        throw new Error("Injected scratch delete failure")
      })
    })
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Manage Scratches" }).click()
    const workspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    const deleteAlpha = workspace.getByRole("button", {
      name: "Delete Alpha",
    })
    await expect(deleteAlpha).toBeEnabled()
    await deleteAlpha.evaluate((button) => {
      if (!(button instanceof HTMLElement)) {
        throw new Error("Delete Scratch is not an HTML button")
      }
      button.click()
    })

    const confirmation = page.getByRole("alertdialog", {
      name: "Permanently Delete Scratch?",
    })
    await expect(confirmation).toBeVisible()
    await expectFullyInsideViewport(confirmation)
    await expect(confirmation).toHaveCSS("overflow-y", "auto")

    const deleteScratch = confirmation.getByRole("button", {
      name: "Delete Scratch",
      exact: true,
    })
    await deleteScratch.scrollIntoViewIfNeeded()
    await deleteScratch.click()

    const modalError = confirmation.getByRole("alert")
    await modalError.scrollIntoViewIfNeeded()
    await expect(modalError).toContainText("Injected scratch delete failure")
    await expect(confirmation).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a failed scratch open keeps the picker open with an actionable error", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-open-failure-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        checkboxChecked: false,
        response: 0,
      })) as typeof dialog.showMessageBox
    })
    await clickMenuItem(app, "file-open-scratch")

    const picker = page.getByRole("dialog", { name: "Open Scratch" })
    const search = picker.getByRole("combobox", {
      name: "Search scratches",
    })
    await expect(
      picker.locator(`[role="option"][data-scratch-id="${alpha.id}"]`)
    ).toBeVisible()
    await rm(path.join(userData, "scratch", alpha.fileName))
    await search.press("Enter")

    await expect(picker).toBeVisible()
    await expect(search).toBeFocused()
    await expect(
      picker.getByRole("alert").filter({
        hasText:
          "The scratch could not be opened. Refresh the list and try again.",
      })
    ).toBeVisible()
    await expect(page.locator(".document-tab")).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("narrow Scratch settings keep details, profile context, and preview reachable", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-settings-narrow-e2e-")
  )
  const [alpha] = scratchFixtures
  await seedScratchStore(userData, [alpha])
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "quick-notes.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "quick-notes",
        name: "Quick Notes",
        activeTab: "notes",
        tabVisibility: "always",
        tabs: [{ id: "notes", kind: "scratch", scratchId: alpha.id }],
      },
      null,
      2
    )}\n`
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await setWindowContentSize(app, 480, 640)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(480)
    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Manage Scratches" }).click()

    const workspace = page.getByRole("region", {
      name: "Scratches Workspace",
    })
    const detailPane = workspace.getByRole("region", {
      name: "Scratch preview",
    })
    const title = workspace.getByRole("textbox", { name: "Title" })
    await expect(title).toBeVisible()
    await title.fill("Narrow layout draft")

    const profileBadge = workspace.getByText("Quick Notes", { exact: true })
    const profileTooltip = page
      .locator('[data-slot="tooltip-content"][data-open]')
      .filter({ hasText: "Used in the “Quick Notes” window profile" })
    await expect(profileBadge).toBeVisible()
    await profileBadge.hover()
    await expect(profileTooltip).toHaveText(
      "Used in the “Quick Notes” window profile"
    )
    await page.mouse.move(0, 0)
    await expect(profileTooltip).toHaveCount(0)
    await title.focus()
    await title.press("Tab")
    await expect(profileBadge).toBeFocused()
    await expect(profileTooltip).toHaveText(
      "Used in the “Quick Notes” window profile"
    )

    const saveDetails = workspace.getByRole("button", {
      name: "Save Details",
    })
    await saveDetails.scrollIntoViewIfNeeded()
    await expect(saveDetails).toBeVisible()
    await expect(saveDetails).toBeEnabled()
    if (process.env.PULSE_MD_CAPTURE_SCRATCHES_NARROW === "1") {
      await page.screenshot({
        path: "/tmp/pulse-md-scratches-settings-narrow-details.png",
      })
    }

    const preview = workspace.locator(
      `[data-scratch-markdown-preview="${alpha.id}"]`
    )
    await expect(preview).toBeVisible()
    await preview.scrollIntoViewIfNeeded()
    const previewBox = await preview.boundingBox()
    expect(previewBox?.height).toBeGreaterThanOrEqual(180)
    expect(
      await detailPane.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
      }))
    ).toMatchObject({ overflowY: "auto" })
    expect(
      await detailPane.evaluate(
        (element) => element.scrollHeight > element.clientHeight
      )
    ).toBe(true)
    if (process.env.PULSE_MD_CAPTURE_SCRATCHES_NARROW === "1") {
      await page.screenshot({
        path: "/tmp/pulse-md-scratches-settings-narrow-preview.png",
      })
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("File menu creates scratches and backs a dirty pathless tab in place", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-file-menu-e2e-")
  )
  const scratchDirectory = path.join(userData, "scratch")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const initialTabId = await page
      .locator(".document-tab[data-active]")
      .getAttribute("data-tab-id")

    await clickMenuItem(app, "file-new-scratch")
    await expect(page.getByRole("tab")).toHaveCount(1)
    await expect
      .poll(async () => {
        const inventory = await page.evaluate(() =>
          window.pulseMd.getScratches("", "created", "scratch-browser")
        )
        return inventory.entries.length
      })
      .toBe(1)

    const newScratchInventory = await page.evaluate(() =>
      window.pulseMd.getScratches("", "created", "scratch-browser")
    )
    const newScratch = newScratchInventory.entries[0]
    expect(newScratch.fileName).toMatch(automaticScratchFileName)
    expect(newScratch.open).toBe(true)
    expect(
      await page
        .locator(".document-tab[data-active]")
        .getAttribute("data-tab-id")
    ).not.toBe(initialTabId)
    await expect(page.locator(".cm-content")).toHaveText("")
    expect(
      await readFile(path.join(scratchDirectory, newScratch.fileName), "utf8")
    ).toBe("")
    expect(await menuItemEnabled(app, "file-save-as-scratch")).toBe(false)

    await clickMenuItem(app, "file-new-tab")
    await expect(page.getByRole("tab")).toHaveCount(2)
    const pathlessTab = page.locator(".document-tab[data-active]")
    const pathlessTabId = await pathlessTab.getAttribute("data-tab-id")
    if (!pathlessTabId) throw new Error("The pathless tab id is unavailable")

    const marker = `Saved as scratch ${Date.now()}`
    await page.locator(".cm-content").click()
    await page.keyboard.insertText(marker)
    await expect(pathlessTab.getByRole("tab")).toHaveAccessibleName(
      /Untitled, modified/
    )
    await expect
      .poll(() => menuItemEnabled(app, "file-save-as-scratch"))
      .toBe(true)

    await clickMenuItem(app, "file-save-as-scratch")
    await expect
      .poll(async () => {
        const inventory = await page.evaluate(() =>
          window.pulseMd.getScratches("", "created", "scratch-browser")
        )
        return inventory.entries.length
      })
      .toBe(2)
    await expect
      .poll(() => menuItemEnabled(app, "file-save-as-scratch"))
      .toBe(false)
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      pathlessTabId
    )
    await expect(pathlessTab.getByRole("tab")).not.toHaveAccessibleName(
      /modified/
    )

    const finalInventory = await page.evaluate(() =>
      window.pulseMd.getScratches("", "created", "scratch-browser")
    )
    const savedScratch = finalInventory.entries.find(
      ({ scratchId }) => scratchId !== newScratch.scratchId
    )
    if (!savedScratch) throw new Error("The saved scratch is unavailable")
    expect(savedScratch.fileName).toMatch(automaticScratchFileName)
    expect(savedScratch.open).toBe(true)
    await pathlessTab.click({ button: "right" })
    await expect(
      page.getByRole("menuitem", { name: "Edit Scratch" })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect
      .poll(() =>
        readFile(path.join(scratchDirectory, savedScratch.fileName), "utf8")
      )
      .toBe(marker)

    const autosaveMarker = "\nAutosaved through the scratch backing."
    const persistedAutosaveMarker =
      process.platform === "win32"
        ? autosaveMarker.replaceAll("\n", "\r\n")
        : autosaveMarker
    await page.locator(".cm-content").click()
    await page.keyboard.press("End")
    await page.keyboard.insertText(autosaveMarker)
    await expect
      .poll(
        () =>
          readFile(path.join(scratchDirectory, savedScratch.fileName), "utf8"),
        { timeout: 5_000 }
      )
      .toBe(`${marker}${persistedAutosaveMarker}`)
    await expect(page.locator(".document-tab[data-active]")).toHaveAttribute(
      "data-tab-id",
      pathlessTabId
    )

    const catalog = JSON.parse(
      await readFile(path.join(scratchDirectory, ".catalog.json"), "utf8")
    ) as {
      entries: Array<{ fileName: string; id: string }>
      version: number
    }
    expect(catalog.version).toBe(1)
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileName: newScratch.fileName,
          id: newScratch.scratchId,
        }),
        expect.objectContaining({
          fileName: savedScratch.fileName,
          id: savedScratch.scratchId,
        }),
      ])
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
