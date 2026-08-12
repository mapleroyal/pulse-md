import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import { DEFAULT_APP_SETTINGS } from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"
import { seedScratchStore } from "./scratch-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

const sourceScratchId = "10000000-0000-4000-8000-000000000011"
const targetScratchId = "10000000-0000-4000-8000-000000000012"

test("a scratch link opens saved external scratch content at its heading", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-scratch-link-routing-")
  )
  const userData = path.join(testDirectory, "user-data")
  const profileDirectory = path.join(userData, "cli-profiles")
  await mkdir(profileDirectory, { recursive: true })
  await seedScratchStore(userData, [
    {
      content: `# Source\n\n[Open target](pulse-md-development://scratch/${targetScratchId}#target-destination)\n`,
      fileName: "source.md",
      id: sourceScratchId,
      title: "Source",
    },
    {
      content: [
        "# Target",
        "",
        ...Array.from(
          { length: 160 },
          (_, index) => `Target filler ${index + 1}\n`
        ),
        "## Target Destination",
        "",
      ].join("\n"),
      fileName: "target.md",
      id: targetScratchId,
      title: "Target",
    },
  ])
  await Promise.all([
    writeFile(
      path.join(profileDirectory, "scratch-links.json"),
      `${JSON.stringify(
        {
          version: 2,
          id: "scratch-links",
          name: "Scratch Links",
          activeTab: "source",
          mode: "live",
          tabVisibility: "always",
          tabs: [
            {
              id: "source",
              kind: "scratch",
              scratchId: sourceScratchId,
              title: "Source",
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
    writeFile(
      path.join(userData, "settings.json"),
      `${JSON.stringify(
        {
          ...DEFAULT_APP_SETTINGS,
          defaultWindowProfileId: "scratch-links",
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
  ])

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const link = page.locator(".cm-md-link").filter({ hasText: "Open target" })
    await expect(link).toBeVisible()
    await link.click({ modifiers: [primary] })

    await expect(page.getByRole("tab")).toHaveCount(2)
    await expect(
      page.locator('.document-tab[data-active] [role="tab"]')
    ).toContainText("Target")
    await expect(
      page.locator(".cm-line").filter({ hasText: "Target Destination" })
    ).toBeVisible()
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})

test("a local link reuses and focuses its tab in another window", async () => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-link-routing-")
  )
  const userData = path.join(testDirectory, "user-data")
  const sourcePath = path.join(testDirectory, "source.md")
  const targetPath = path.join(testDirectory, "target.md")
  const filler = Array.from(
    { length: 180 },
    (_, index) => `Target filler ${index + 1}`
  ).join("\n\n")
  await Promise.all([
    writeFile(sourcePath, "# Source\n\n[Open target](target.md#destination)\n"),
    writeFile(targetPath, `# Target\n\n${filler}\n\n## Destination\n`),
  ])
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, sourcePath],
    cwd: projectRoot,
  })

  try {
    const sourcePage = await app.firstWindow()
    await sourcePage.locator(".cm-editor").waitFor()
    const existingPages = new Set(app.windows())
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("file-new-window")
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("New Window is unavailable")
      item.click(undefined, win, win.webContents)
    })
    await expect.poll(() => app.windows().length).toBe(2)
    const targetPage = app.windows().find((page) => !existingPages.has(page))
    if (!targetPage) throw new Error("The target window was not created")
    await targetPage.locator(".cm-editor").waitFor()
    await targetPage.bringToFront()

    await app.evaluate(({ BrowserWindow, Menu, dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [filePath],
      })) as typeof dialog.showOpenDialog
      const item = Menu.getApplicationMenu()?.getMenuItemById("file-open")
      const win = BrowserWindow.getFocusedWindow()
      if (!item || !win) throw new Error("Open is unavailable")
      item.click(undefined, win, win.webContents)
    }, targetPath)
    await expect(
      targetPage.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAttribute("aria-label", targetPath)
    const targetWindowId = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null
    )
    await unlink(targetPath)

    await sourcePage.bringToFront()
    const primary = process.platform === "darwin" ? "Meta" : "Control"
    const link = sourcePage
      .locator(".cm-md-link")
      .filter({ hasText: "Open target" })
    await expect(link).toBeVisible()
    await link.click({ modifiers: [primary] })

    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null
        )
      )
      .toBe(targetWindowId)
    await expect(
      targetPage.locator(".cm-line").filter({ hasText: "Destination" })
    ).toBeVisible()
    await expect(sourcePage.getByRole("tab")).toHaveCount(1)
    await expect(targetPage.getByRole("tab")).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(testDirectory, { force: true, recursive: true })
  }
})
