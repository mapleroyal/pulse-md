import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication } from "./electron-helpers"
import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const samplePath = path.join(projectRoot, "tests/fixtures/sample.md")

async function createTestUserData() {
  return mkdtemp(path.join(os.tmpdir(), "pulse-md-tearout-"))
}

async function launchApplication(userData: string) {
  return electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })
}

async function createSecondTab(page: Page) {
  await page.bringToFront()
  await page.locator(".cm-content").click()
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+T" : "Control+T"
  )
  await expect(page.locator(".document-tab")).toHaveCount(2)
}

async function activateFirstTab(page: Page) {
  await page.bringToFront()
  await page.keyboard.press("Control+1")
  await expect(
    page.locator(".document-tab").first().getByRole("tab")
  ).toHaveAttribute("aria-selected", "true")
}

async function moveHeaderAwayFromCursor(app: ElectronApplication, page: Page) {
  await page.bringToFront()
  const { cursor, workArea } = await app.evaluate(({ screen }) => {
    const cursor = screen.getCursorScreenPoint()
    return {
      cursor,
      workArea: screen.getDisplayNearestPoint(cursor).workArea,
    }
  })
  const sourceWindow = await app.browserWindow(page)
  await sourceWindow.evaluate(
    (win, placement) => {
      const { cursor, workArea } = placement
      const bounds = win.getBounds()
      const roomBelow = workArea.y + workArea.height - cursor.y
      const y =
        roomBelow > workArea.height / 2
          ? Math.max(workArea.y, workArea.y + workArea.height - bounds.height)
          : workArea.y
      win.setPosition(bounds.x, y, false)
    },
    { cursor, workArea }
  )
  await sourceWindow.dispose()
  await page.waitForTimeout(50)
}

async function beginTearOut(page: Page, tabIndex = 0) {
  return page.evaluate((index) => {
    const strip = document.querySelector<HTMLElement>(".document-tab-strip")
    const tab = document.querySelectorAll<HTMLElement>(".document-tab")[index]
    if (!strip || !tab) throw new Error("Tab drag geometry is unavailable")
    const stripBounds = strip.getBoundingClientRect()
    const tabBounds = tab.getBoundingClientRect()
    const tabId = tab.dataset.tabId
    if (!tabId) throw new Error("Dragged tab has no id")
    return window.pulseMd.beginTabDrag(tabId, {
      cursorOffset: {
        x: stripBounds.left + Math.min(16, tabBounds.width / 2),
        y: tabBounds.top + tabBounds.height / 2,
      },
      sourceStripBounds: {
        x: window.screenX + stripBounds.left,
        y: window.screenY + stripBounds.top,
        width: stripBounds.width,
        height: stripBounds.height,
      },
    })
  }, tabIndex)
}

async function beginUntrackedTabDrag(page: Page, tabIndex = 0) {
  return page.evaluate((index) => {
    const tab = document.querySelectorAll<HTMLElement>(".document-tab")[index]
    const tabId = tab?.dataset.tabId
    if (!tabId) throw new Error("Dragged tab has no id")
    return window.pulseMd.beginTabDrag(tabId)
  }, tabIndex)
}

async function dispatchTabDrag(
  page: Page,
  dragToken: string,
  eventTypes: readonly ("dragenter" | "dragover" | "dragleave" | "drop")[]
) {
  await page.locator(".top-chrome").waitFor()
  await page.evaluate(
    ({ eventTypes, token }) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      if (!header) throw new Error("Target chrome is unavailable")
      const transfer = new DataTransfer()
      transfer.effectAllowed = "move"
      transfer.setData("application/x-pulse-md-tab", token)
      for (const type of eventTypes) {
        header.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: 200,
            clientY: 20,
            dataTransfer: transfer,
          })
        )
      }
    },
    { eventTypes, token: dragToken }
  )
}

async function waitForNewWindow(
  app: ElectronApplication,
  existing: ReadonlySet<Page>
) {
  await expect.poll(() => app.windows().length).toBe(existing.size + 1)
  const created = app.windows().find((candidate) => !existing.has(candidate))
  if (!created) throw new Error("Tear-out window was not created")
  await created.locator(".cm-editor").waitFor()
  return created
}

async function openAdditionalWindow(app: ElectronApplication, source: Page) {
  const existing = new Set(app.windows())
  await source.bringToFront()
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((candidate) => candidate.label === "File")
      ?.submenu?.items.find((candidate) => candidate.label === "New Window")
    const win = BrowserWindow.getFocusedWindow()
    if (!item || !win) throw new Error("New Window is unavailable")
    item.click(undefined, win, win.webContents)
  })
  return waitForNewWindow(app, existing)
}

async function setTabVisibility(
  app: ElectronApplication,
  page: Page,
  visibility: "always" | "hidden"
) {
  await page.bringToFront()
  await app.evaluate(({ BrowserWindow, Menu }, menuItemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(menuItemId)
    const win = BrowserWindow.getFocusedWindow()
    if (!item || !win) throw new Error("Tab visibility menu is unavailable")
    item.click(undefined, win, win.webContents)
  }, `view-tabs-${visibility}`)
}

test("a hidden tab strip reveals a real receiver during an inter-window drag", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    const target = await openAdditionalWindow(app, source)
    const sourceTabId = await source
      .locator(".document-tab")
      .first()
      .getAttribute("data-tab-id")
    if (!sourceTabId) throw new Error("The source tab id is unavailable")

    await setTabVisibility(app, target, "hidden")
    await expect(source.locator(".document-tab-strip")).toHaveCount(0)
    await expect(target.locator(".document-tab-strip")).toHaveCount(0)

    const dragToken = await source.evaluate((tabId) => {
      return window.pulseMd.beginTabDrag(tabId)
    }, sourceTabId)

    await expect(target.locator(".top-chrome")).toHaveAttribute(
      "data-tab-drag-active",
      "true"
    )
    await expect(target.locator(".document-tab-strip")).toBeVisible()
    await dispatchTabDrag(target, dragToken, ["dragenter", "dragover", "drop"])

    await expect(target.locator(".document-tab-strip")).toHaveCount(0)
    await setTabVisibility(app, target, "always")
    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(target.locator(".document-tab")).toHaveCount(2)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("an accepted external-style drop still commits the prepared tear-out", async () => {
  const userData = await createTestUserData()
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.backgroundEffect.enabled = true
  settings.launchTransition = {
    ...settings.launchTransition,
    delayMs: 0,
    durationMs: 3_000,
    enabled: true,
  }
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    await moveHeaderAwayFromCursor(app, source)

    const before = new Set(app.windows())
    const dragToken = await beginTearOut(source)
    expect(dragToken).not.toBe("")
    const target = await waitForNewWindow(app, before)
    await target.waitForFunction(
      () =>
        performance.getEntriesByName("pmd:launch-transition-settled").length > 0
    )
    await expect(target.locator("html")).toHaveAttribute(
      "data-launch-transition",
      "settled"
    )
    expect(
      await target.evaluate(
        () =>
          performance.getEntriesByName("pmd:launch-transition-started").length
      )
    ).toBe(0)

    await expect(source.locator(".document-tab")).toHaveCount(2)
    await expect(target.locator(".document-tab")).toHaveCount(1)
    await expect(target.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )
    const provisionalActivation = await target.evaluate(async () => {
      const tabId =
        document.querySelector<HTMLElement>(".document-tab")?.dataset.tabId
      if (!tabId) throw new Error("The provisional tab id is unavailable")
      try {
        await window.pulseMd.activateTab(tabId)
        return null
      } catch (error) {
        return String(error)
      }
    })
    expect(provisionalActivation).toContain(
      "Provisional windows cannot mutate application state"
    )
    const provisionalClose = await target.evaluate(async () => {
      const tabId =
        document.querySelector<HTMLElement>(".document-tab")?.dataset.tabId
      if (!tabId) throw new Error("The provisional tab id is unavailable")
      try {
        await window.pulseMd.requestCloseTab(tabId)
        return null
      } catch (error) {
        return String(error)
      }
    })
    expect(provisionalClose).toContain(
      "Tab does not belong to the sender window"
    )
    const provisionalCreation = await target.evaluate(async () => {
      try {
        await window.pulseMd.newTab()
        return null
      } catch (error) {
        return String(error)
      }
    })
    expect(provisionalCreation).toContain(
      "Provisional windows cannot mutate application state"
    )
    await expect(
      target.evaluate(
        (token) => window.pulseMd.requestTabTransfer(token, 0),
        dragToken
      )
    ).resolves.toBeNull()
    const previewTabBeforeDragOver = await target
      .locator(".document-tab")
      .boundingBox()
    if (!previewTabBeforeDragOver) {
      throw new Error("Provisional tab geometry is unavailable")
    }
    await dispatchTabDrag(target, dragToken, ["dragenter", "dragover"])
    await target.waitForTimeout(50)
    await expect(target.locator(".document-tab-drop-placeholder")).toHaveCount(
      0
    )
    expect(
      await target.locator(".top-chrome").getAttribute("data-drag-over")
    ).toBeNull()
    const previewTabAfterDragOver = await target
      .locator(".document-tab")
      .boundingBox()
    expect(previewTabAfterDragOver).not.toBeNull()
    expect(
      Math.abs(previewTabAfterDragOver!.x - previewTabBeforeDragOver.x)
    ).toBeLessThan(0.5)
    await target.evaluate(() => {
      document.documentElement.dataset.tearOutTestTarget = "true"
      const dispose = window.pulseMd.onTabsChanged((snapshot) => {
        if (snapshot.tabDragSink) return
        document.documentElement.dataset.tearOutTestPromoted = "true"
        dispose()
      })
    })
    expect(
      await app.evaluate(async ({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          const marked = await win.webContents.executeJavaScript(
            "document.documentElement.dataset.tearOutTestTarget === 'true'"
          )
          if (marked) return win.isFocused()
        }
        throw new Error("Provisional window marker was not found")
      })
    ).toBe(false)

    await dispatchTabDrag(target, dragToken, ["drop"])

    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: false,
        dragToken: token,
        dropped: true,
        screenPoint: { x: 0, y: 0 },
      })
    }, dragToken)

    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(target.locator(".document-tab")).toHaveCount(1)
    await expect(target.locator("html")).toHaveAttribute(
      "data-tear-out-test-promoted",
      "true"
    )
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((win) => win.isFocused())
              .length
        )
      )
      .toBe(1)

    const laterDragToken = await beginUntrackedTabDrag(source)
    await dispatchTabDrag(target, laterDragToken, ["dragenter", "dragover"])
    await expect(target.locator(".document-tab-drop-placeholder")).toHaveCount(
      1
    )
    await expect(target.locator(".top-chrome")).toHaveAttribute(
      "data-drag-over",
      "true"
    )
    await dispatchTabDrag(target, laterDragToken, ["dragleave"])
    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: true,
        dragToken: token,
        dropped: false,
        screenPoint: { x: 0, y: 0 },
      })
    }, laterDragToken)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Escape-style cancellation destroys the provisional window and retains source", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    await activateFirstTab(source)
    await moveHeaderAwayFromCursor(app, source)

    const before = new Set(app.windows())
    const dragToken = await beginTearOut(source)
    await waitForNewWindow(app, before)
    await expect(source.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false"
    )
    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: true,
        dragToken: token,
        dropped: false,
        screenPoint: { x: 0, y: 0 },
      })
    }, dragToken)

    await expect.poll(() => app.windows().length).toBe(1)
    await expect(source.locator(".document-tab")).toHaveCount(2)
    await expect(source.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true"
    )
    await expect(source.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a released source retires immediately and restores after validation failure", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    await activateFirstTab(source)
    const neighborTabId = await source
      .locator(".document-tab")
      .nth(1)
      .getAttribute("data-tab-id")
    if (!neighborTabId) throw new Error("Neighbor tab id is unavailable")
    await expect(source.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )
    await moveHeaderAwayFromCursor(app, source)

    await app.evaluate(({ BrowserWindow }) => {
      const testGlobal = globalThis as typeof globalThis & {
        tearOutIgnoreMouseEvents?: Array<{ ignore: boolean; windowId: number }>
      }
      testGlobal.tearOutIgnoreMouseEvents = []
      const prototype = BrowserWindow.prototype
      const original = prototype.setIgnoreMouseEvents
      prototype.setIgnoreMouseEvents = function (ignore, options) {
        testGlobal.tearOutIgnoreMouseEvents?.push({
          ignore,
          windowId: this.id,
        })
        return original.call(this, ignore, options)
      }
    })

    await source.evaluate(() => {
      window.pulseMd.onTabExportRequested(() => {
        const content = document.querySelector<HTMLElement>(".cm-content")
        if (!content) throw new Error("Editor content is unavailable")
        content.focus()
        document.execCommand("insertText", false, "validation-race ")
      })
    })

    const before = new Set(app.windows())
    const dragToken = await beginTearOut(source)
    const target = await waitForNewWindow(app, before)
    await expect(target.locator(".cm-content")).not.toContainText(
      "validation-race"
    )

    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: false,
        dragToken: token,
        dropped: false,
        screenPoint: { x: 0, y: 0 },
      })
    }, dragToken)

    await expect(source.locator(".document-tab")).toHaveCount(1, {
      timeout: 500,
    })
    expect(app.windows()).toHaveLength(2)
    await source.evaluate((tabId) => {
      window.pulseMd.setDirty(tabId, true)
    }, neighborTabId)
    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(source.locator(".cm-content")).not.toContainText(
      "A quiet Markdown window"
    )
    await source.evaluate((tabId) => {
      window.pulseMd.setDirty(tabId, false)
    }, neighborTabId)
    expect(
      await app.evaluate(() => {
        const events = (
          globalThis as typeof globalThis & {
            tearOutIgnoreMouseEvents?: Array<{
              ignore: boolean
              windowId: number
            }>
          }
        ).tearOutIgnoreMouseEvents
        return events?.at(-1)?.ignore
      })
    ).toBe(true)

    await expect.poll(() => app.windows().length, { timeout: 3_000 }).toBe(1)
    await expect(source.locator(".document-tab")).toHaveCount(2)
    await expect(source.locator(".cm-content")).toContainText("validation-race")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("an existing target wins a provisional race without a second export", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    const existingTarget = await openAdditionalWindow(app, source)
    await moveHeaderAwayFromCursor(app, source)
    await source.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        tearOutExports?: number
      }
      state.tearOutExports = 0
      window.pulseMd.onTabExportRequested(() => {
        state.tearOutExports = (state.tearOutExports ?? 0) + 1
      })
    })

    const before = new Set(app.windows())
    const dragToken = await beginTearOut(source)
    await waitForNewWindow(app, before)

    await existingTarget.evaluate((token) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      if (!header) throw new Error("Target chrome is unavailable")
      const transfer = new DataTransfer()
      transfer.effectAllowed = "move"
      transfer.setData("application/x-pulse-md-tab", token)
      for (const type of ["dragenter", "dragover", "drop"]) {
        header.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: 200,
            clientY: 20,
            dataTransfer: transfer,
          })
        )
      }
    }, dragToken)

    await expect.poll(() => app.windows().length).toBe(2)
    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(existingTarget.locator(".document-tab")).toHaveCount(2)
    expect(
      await source.evaluate(
        () =>
          (globalThis as typeof globalThis & { tearOutExports?: number })
            .tearOutExports
      )
    ).toBe(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("an inactive transfer lease remains read-only if its tab is activated", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    const target = await openAdditionalWindow(app, source)

    await source.evaluate(() => {
      window.pulseMd.onTabTransferCommitRequested(({ tabId }) => {
        const tab = document.querySelector<HTMLButtonElement>(
          `.document-tab[data-tab-id="${CSS.escape(tabId)}"] [role="tab"]`
        )
        const content = document.querySelector<HTMLElement>(".cm-content")
        if (!tab || !content) throw new Error("Transfer source is unavailable")
        tab.click()
        content.focus()
        document.execCommand("insertText", false, "lease-race-edit")
        document.documentElement.dataset.transferLeaseEditable =
          content.getAttribute("contenteditable") ?? "missing"
        document.documentElement.dataset.transferLeaseInserted = String(
          content.textContent?.includes("lease-race-edit") ?? false
        )
      })
    })

    const dragToken = await beginUntrackedTabDrag(source, 0)
    await dispatchTabDrag(target, dragToken, ["dragenter", "dragover", "drop"])

    await expect(source.locator("html")).toHaveAttribute(
      "data-transfer-lease-editable",
      "false"
    )
    await expect(source.locator("html")).toHaveAttribute(
      "data-transfer-lease-inserted",
      "false"
    )
    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(source.locator(".cm-content")).not.toContainText(
      "lease-race-edit"
    )
    await expect(target.locator(".document-tab")).toHaveCount(2)
    await expect(target.locator(".cm-content")).not.toContainText(
      "lease-race-edit"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("transfer settlement keeps a settings preview read-only", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    const target = await openAdditionalWindow(app, source)

    await source.evaluate(() => {
      document.documentElement.dataset.settlementPreviewSource = "true"

      window.pulseMd.onTabTransferCommitRequested(() => {
        const settings = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Settings"]'
        )
        if (!settings) throw new Error("Settings button is unavailable")
        settings.click()

        let observer: MutationObserver | null = null
        const openTypographyPreview = () => {
          const customize = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Customize typography"]'
          )
          if (!customize) return false
          observer?.disconnect()
          customize.click()
          return true
        }
        if (!openTypographyPreview()) {
          observer = new MutationObserver(openTypographyPreview)
          observer.observe(document.body, { childList: true, subtree: true })
        }
      })

      window.pulseMd.onTabTransferCommitSettled(() => {
        const content = document.querySelector<HTMLElement>(".cm-content")
        if (!content) throw new Error("Typography preview is unavailable")
        content.focus()
        document.execCommand("insertText", false, "settlement-preview-edit")
        document.documentElement.dataset.settlementPreviewEditable =
          content.getAttribute("contenteditable") ?? "missing"
        document.documentElement.dataset.settlementPreviewInserted = String(
          content.textContent?.includes("settlement-preview-edit") ?? false
        )
      })
    })
    await app.evaluate(async ({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        const marked = await win.webContents.executeJavaScript(
          "document.documentElement.dataset.settlementPreviewSource === 'true'"
        )
        if (!marked) continue
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = (channel, ...args) => {
          if (channel !== "pulse-md:tab-transfer-commit-settled") {
            send(channel, ...args)
            return
          }
          void (async () => {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const previewOpen = await win.webContents.executeJavaScript(
                "Boolean(document.querySelector('[aria-label=\"Typography preview workspace\"]'))"
              )
              if (previewOpen) {
                send(channel, ...args)
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
            send(channel, ...args)
          })()
        }
        return
      }
      throw new Error("Settlement-preview source was not found")
    })

    const dragToken = await beginUntrackedTabDrag(source, 0)
    await dispatchTabDrag(target, dragToken, ["dragenter", "dragover", "drop"])

    await expect(
      source.getByRole("region", { name: "Typography preview workspace" })
    ).toBeVisible()
    await expect(source.locator("html")).toHaveAttribute(
      "data-settlement-preview-editable",
      "false"
    )
    await expect(source.locator("html")).toHaveAttribute(
      "data-settlement-preview-inserted",
      "false"
    )
    await expect(source.locator(".cm-content")).not.toContainText(
      "settlement-preview-edit"
    )
    await expect(target.locator(".document-tab")).toHaveCount(2)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("an internal drop claim survives source drag-end while export is pending", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    const existingTarget = await openAdditionalWindow(app, source)
    await source.evaluate(() => {
      document.documentElement.dataset.delayedExportSource = "true"
    })
    await app.evaluate(async ({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        const marked = await win.webContents.executeJavaScript(
          "document.documentElement.dataset.delayedExportSource === 'true'"
        )
        if (!marked) continue
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = (channel, ...args) => {
          if (channel === "pulse-md:tab-export-requested") {
            setTimeout(() => send(channel, ...args), 250)
            return
          }
          send(channel, ...args)
        }
        return
      }
      throw new Error("Delayed-export source was not found")
    })

    const dragToken = await beginUntrackedTabDrag(source)
    await dispatchTabDrag(existingTarget, dragToken, [
      "dragenter",
      "dragover",
      "drop",
    ])
    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: false,
        dragToken: token,
        dropped: true,
        screenPoint: { x: 0, y: 0 },
      })
    }, dragToken)

    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(existingTarget.locator(".document-tab")).toHaveCount(2)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("overlapping app geometry does not override the native drop claimant", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await createSecondTab(source)
    const existingTarget = await openAdditionalWindow(app, source)
    await existingTarget.evaluate(() => {
      document.documentElement.dataset.tearOutOverlapTarget = "true"
    })
    await moveHeaderAwayFromCursor(app, source)
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      const cursor = screen.getCursorScreenPoint()
      for (const win of BrowserWindow.getAllWindows()) {
        const marked = await win.webContents.executeJavaScript(
          "document.documentElement.dataset.tearOutOverlapTarget === 'true'"
        )
        if (!marked) continue
        const bounds = win.getBounds()
        win.setPosition(cursor.x - 200, cursor.y - 20, false)
        win.setSize(bounds.width, bounds.height, false)
        return
      }
      throw new Error("Overlap target was not found")
    })

    const before = new Set(app.windows())
    const dragToken = await beginTearOut(source)
    const detached = await waitForNewWindow(app, before)
    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: false,
        dragToken: token,
        dropped: true,
        screenPoint: { x: 0, y: 0 },
      })
    }, dragToken)

    await expect.poll(() => app.windows().length).toBe(3)
    await expect(source.locator(".document-tab")).toHaveCount(1)
    await expect(existingTarget.locator(".document-tab")).toHaveCount(1)
    await expect(detached.locator(".cm-content")).toContainText(
      "A quiet Markdown window"
    )
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("the final tab never creates a provisional tear-out window", async () => {
  const userData = await createTestUserData()
  const app = await launchApplication(userData)
  try {
    const source = await app.firstWindow()
    await source.locator(".cm-editor").waitFor()
    await moveHeaderAwayFromCursor(app, source)
    const dragToken = await beginTearOut(source)

    await source.waitForTimeout(250)
    expect(app.windows()).toHaveLength(1)
    await source.evaluate((token) => {
      window.pulseMd.endTabDrag({
        cancelled: false,
        dragToken: token,
        dropped: false,
        screenPoint: { x: 0, y: 0 },
      })
    }, dragToken)
    await source.waitForTimeout(100)
    expect(app.windows()).toHaveLength(1)
    await expect(source.locator(".document-tab")).toHaveCount(1)
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
