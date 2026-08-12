import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import { ACTIVE_TAB_INDICATOR_POSITIONS } from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const samplePath = path.join(projectRoot, "tests/fixtures/sample.md")
const settingsShortcut = process.platform === "darwin" ? "Meta+," : "Control+,"
const positionLabels = {
  top: "Top edge indicator",
  "top-right": "Top-right corner indicator",
  right: "Right edge indicator",
  "bottom-right": "Bottom-right corner indicator",
  bottom: "Bottom edge indicator",
  "bottom-left": "Bottom-left corner indicator",
  left: "Left edge indicator",
  "top-left": "Top-left corner indicator",
} as const

test("active tab indicator playground previews every shape and persists its palette", async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-active-tab-indicator-")
  )
  let app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })
  let running = true

  try {
    let page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )

    const activeTab = page.locator(".document-tab[data-active]")
    const inactiveTab = page.locator(".document-tab:not([data-active])")
    await expect(activeTab.locator(".active-tab-indicator")).toHaveCount(1)
    await expect(inactiveTab.locator(".active-tab-indicator")).toHaveCount(1)
    await expect
      .poll(() =>
        activeTab
          .locator('[data-position="left"]')
          .evaluate((element) => getComputedStyle(element).display)
      )
      .toBe("block")
    await expect
      .poll(() =>
        inactiveTab
          .locator('[data-position="left"]')
          .evaluate((element) => getComputedStyle(element).display)
      )
      .toBe("none")

    await page.keyboard.press(settingsShortcut)
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("button", { name: "Window Chrome" }).click()
    await settings
      .getByRole("button", { name: "Customize active tab indicator" })
      .click()

    const workspace = page.getByRole("region", {
      name: "Active tab indicator preview workspace",
    })
    await expect(workspace).toBeVisible()
    const preview = workspace.getByRole("region", {
      name: "Active tab indicator preview",
    })
    const previewActiveTab = preview.locator(".document-tab[data-active]")
    await expect(
      preview.getByRole("img", { name: "Inactive tab preview: Notes.md" })
    ).toBeVisible()
    await expect(
      preview.getByRole("img", {
        name: "Active tab preview: Current document.md",
      })
    ).toBeVisible()
    await expect(
      preview.getByRole("img", { name: "Inactive tab preview: Scratch" })
    ).toBeVisible()
    await expect(
      workspace.getByRole("button", { name: "Left edge indicator" })
    ).toHaveAttribute("aria-pressed", "true")

    const colorSource = workspace.getByRole("combobox", {
      name: "Active tab indicator color source",
    })
    await expect(colorSource).toContainText("Focus-Ring Color")
    await colorSource.click()
    await expect(page.getByRole("option")).toHaveCount(4)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("option")).toHaveCount(0)
    await expect(workspace).toBeVisible()

    await workspace.getByRole("button", { name: "Top edge indicator" }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.activeTabIndicatorPositions
        )
      )
      .toBe("top left")
    await workspace.getByRole("button", { name: "Reset all" }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.activeTabIndicatorPositions
        )
      )
      .toBe("left")
    await workspace
      .getByRole("button", { name: "Top-right corner indicator" })
      .click()
    await workspace.getByRole("button", { name: "Cancel" }).click()
    await expect(workspace).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.activeTabIndicatorPositions
        )
      )
      .toBe("left")
    await settings
      .getByRole("button", { name: "Customize active tab indicator" })
      .click()
    await expect(workspace).toBeVisible()

    await workspace.getByRole("button", { name: "Left edge indicator" }).click()
    await workspace
      .getByRole("button", { name: "Top-right corner indicator" })
      .click()
    await expect
      .poll(() =>
        previewActiveTab
          .locator('[data-position="top-right"]')
          .evaluate((element) => getComputedStyle(element).display)
      )
      .toBe("block")
    for (const edge of ["top", "right"] as const) {
      await expect
        .poll(() =>
          previewActiveTab
            .locator(`[data-position="${edge}"]`)
            .evaluate((element) => getComputedStyle(element).display)
        )
        .toBe("none")
    }

    await expect(previewActiveTab).toHaveClass(/window-profile-tab-preview/)
    await expect(
      previewActiveTab.locator(".active-tab-indicator-part")
    ).toHaveCount(8)

    const cornerGeometry = await previewActiveTab.evaluate((tab) => {
      const indicator = tab.querySelector<HTMLElement>(".active-tab-indicator")
      const corner = tab.querySelector<HTMLElement>(
        '[data-position="top-right"]'
      )
      if (!indicator || !corner) throw new Error("Indicator corner is missing")
      const indicatorBounds = indicator.getBoundingClientRect()
      const cornerBounds = corner.getBoundingClientRect()
      const radius = Number.parseFloat(
        getComputedStyle(tab).borderTopRightRadius
      )
      const thicknessProbeDistance = (radius + 6.5) / 2
      indicator.style.pointerEvents = "auto"
      corner.style.pointerEvents = "auto"
      const insideHit =
        document.elementFromPoint(
          indicatorBounds.right - radius * 0.3,
          indicatorBounds.top + radius * 0.45
        ) === corner
      const outsideHit =
        document.elementFromPoint(
          indicatorBounds.right - radius * 0.85,
          indicatorBounds.top + radius * 0.85
        ) === corner
      const thicknessSensitiveHit =
        document.elementFromPoint(
          indicatorBounds.right - thicknessProbeDistance,
          indicatorBounds.top + thicknessProbeDistance
        ) === corner
      indicator.style.removeProperty("pointer-events")
      corner.style.removeProperty("pointer-events")
      return {
        clipPath: getComputedStyle(corner).clipPath,
        cornerRight: cornerBounds.right,
        cornerTop: cornerBounds.top,
        indicatorRight: indicatorBounds.right,
        indicatorTop: indicatorBounds.top,
        insideHit,
        outsideHit,
        thicknessSensitiveHit,
        overflow: getComputedStyle(indicator).overflow,
        width: cornerBounds.width,
      }
    })
    expect(cornerGeometry.overflow).toBe("hidden")
    expect(cornerGeometry.clipPath).toContain("polygon")
    expect(cornerGeometry.width).toBeGreaterThan(12)
    expect(cornerGeometry.cornerTop).toBeLessThan(cornerGeometry.indicatorTop)
    expect(cornerGeometry.cornerRight).toBeGreaterThan(
      cornerGeometry.indicatorRight
    )
    expect(cornerGeometry.insideHit).toBe(true)
    expect(cornerGeometry.outsideHit).toBe(false)
    expect(cornerGeometry.thicknessSensitiveHit).toBe(false)

    const thickness = workspace.getByRole("slider", {
      name: "Active tab indicator thickness",
    })
    await expect(thickness).toHaveAttribute("aria-valuenow", "5")
    await thickness.focus()
    await page.keyboard.press("End")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(thickness).toHaveAttribute("aria-valuenow", "8")

    const thickCornerHit = await previewActiveTab.evaluate((tab) => {
      const indicator = tab.querySelector<HTMLElement>(".active-tab-indicator")
      const corner = tab.querySelector<HTMLElement>(
        '[data-position="top-right"]'
      )
      if (!indicator || !corner) throw new Error("Indicator corner is missing")
      const indicatorBounds = indicator.getBoundingClientRect()
      const radius = Number.parseFloat(
        getComputedStyle(tab).borderTopRightRadius
      )
      const thicknessProbeDistance = (radius + 6.5) / 2
      indicator.style.pointerEvents = "auto"
      corner.style.pointerEvents = "auto"
      const hit =
        document.elementFromPoint(
          indicatorBounds.right - thicknessProbeDistance,
          indicatorBounds.top + thicknessProbeDistance
        ) === corner
      indicator.style.removeProperty("pointer-events")
      corner.style.removeProperty("pointer-events")
      return hit
    })
    expect(thickCornerHit).toBe(true)

    await workspace.getByRole("button", { name: "Top edge indicator" }).click()
    await workspace
      .getByRole("button", { name: "Right edge indicator" })
      .click()
    for (const position of ["top", "top-right", "right"] as const) {
      await expect
        .poll(() =>
          previewActiveTab
            .locator(`[data-position="${position}"]`)
            .evaluate((element) => getComputedStyle(element).display)
        )
        .toBe("block")
    }

    for (const position of ACTIVE_TAB_INDICATOR_POSITIONS) {
      const toggle = workspace.getByRole("button", {
        name: positionLabels[position],
      })
      if ((await toggle.getAttribute("aria-pressed")) !== "true") {
        await toggle.click()
      }
    }

    for (const position of ACTIVE_TAB_INDICATOR_POSITIONS) {
      await expect
        .poll(() =>
          previewActiveTab
            .locator(`[data-position="${position}"]`)
            .evaluate((element) => getComputedStyle(element).display)
        )
        .toBe("block")
    }

    const previewIndicator = previewActiveTab.locator(".active-tab-indicator")
    const focusRingColor = await previewIndicator.evaluate(
      (element) => getComputedStyle(element).color
    )
    await colorSource.click()
    await expect(page.getByRole("option")).toHaveText([
      "Theme Accent",
      "Foreground-Derived",
      "Focus-Ring Color",
      "Custom Color",
    ])
    await page.getByRole("option", { name: "Theme Accent" }).click()
    const themeAccentColor = await previewIndicator.evaluate(
      (element) => getComputedStyle(element).color
    )
    expect(focusRingColor).not.toBe(themeAccentColor)

    await colorSource.click()
    await page.getByRole("option", { name: "Custom Color" }).click()
    const customColor = workspace.getByLabel(
      "Active tab indicator custom color"
    )
    await customColor.fill("#ff0066")
    const exactFocusedColor = await previewIndicator.evaluate(
      (element) => getComputedStyle(element).color
    )
    await workspace.getByRole("button", { name: "Inactive" }).click()
    const exactInactiveColor = await previewIndicator.evaluate(
      (element) => getComputedStyle(element).color
    )
    expect(exactInactiveColor).toBe(exactFocusedColor)
    await workspace.getByRole("button", { name: "Focused" }).click()

    const adaptiveCustomColor = workspace.getByRole("switch", {
      name: "Adaptive Custom Color",
    })
    await expect(adaptiveCustomColor).toBeEnabled()
    await adaptiveCustomColor.focus()
    await adaptiveCustomColor.press("Space")
    await expect(adaptiveCustomColor).toBeChecked()

    await expect(thickness).toHaveAttribute("aria-valuenow", "8")

    const focusedColor = await previewIndicator.evaluate(
      (element) => getComputedStyle(element).color
    )
    await workspace.getByRole("button", { name: "Inactive" }).click()
    const inactiveColor = await previewIndicator.evaluate(
      (element) => getComputedStyle(element).color
    )
    expect(inactiveColor).not.toBe(focusedColor)

    await workspace.getByRole("button", { name: "Save" }).click()
    await expect(workspace).toHaveCount(0)
    await settings.getByRole("button", { name: "Done", exact: true }).click()
    await expect(settings).toHaveCount(0)

    const persisted = JSON.parse(
      await readFile(path.join(userData, "settings.json"), "utf8")
    ) as {
      chrome: {
        activeTabIndicator: {
          adaptCustomColor: boolean
          colorSource: string
          customColor: string
          positions: string[]
          thickness: number
        }
      }
    }
    expect(persisted.chrome.activeTabIndicator).toEqual({
      adaptCustomColor: true,
      colorSource: "custom",
      customColor: "#ff0066",
      positions: [...ACTIVE_TAB_INDICATOR_POSITIONS],
      thickness: 8,
    })

    await exitApplication(app)
    running = false
    app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
      cwd: projectRoot,
    })
    running = true
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect
      .poll(() =>
        page.evaluate(() => ({
          adaptive: document.documentElement.dataset.activeTabIndicatorAdaptive,
          colorSource:
            document.documentElement.dataset.activeTabIndicatorColorSource,
          positions:
            document.documentElement.dataset.activeTabIndicatorPositions,
          thickness: document.documentElement.style.getPropertyValue(
            "--active-tab-indicator-thickness"
          ),
        }))
      )
      .toEqual({
        adaptive: "true",
        colorSource: "custom",
        positions: ACTIVE_TAB_INDICATOR_POSITIONS.join(" "),
        thickness: "8px",
      })
  } finally {
    if (running) await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
