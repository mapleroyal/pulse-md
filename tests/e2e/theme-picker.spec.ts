import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import {
  BACKGROUND_COLORS,
  BACKGROUND_SURFACE_SCHEMES,
  type FixedBackgroundId,
  type ResolvedAppearance,
} from "../../src/shared/contracts"
import { SYNTAX_THEMES } from "../../src/editor/syntax-theme"
import { exitApplication, openSettingsSection } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const samplePath = path.join(projectRoot, "tests/fixtures/sample.md")

const TAB_THEME_PRESETS: ReadonlyArray<{
  backgroundId: FixedBackgroundId
  label: string
  scheme: ResolvedAppearance
}> = SYNTAX_THEMES.map((theme) => {
  const scheme = BACKGROUND_SURFACE_SCHEMES[theme.backgroundId]
  return {
    backgroundId:
      scheme === "dark" && theme.id === "one-dark"
        ? "dark"
        : theme.backgroundId,
    label:
      theme.id === "default"
        ? "Default (CodeMirror)"
        : theme.id === "one-dark"
          ? "Default (One Dark)"
          : theme.label,
    scheme,
  }
})

test("theme presets keep the active tab more prominent than inactive tabs", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-light-tab-tones-")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+T" : "Control+T"
    )
    await expect(page.locator(".document-tab")).toHaveCount(2)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const scheme of ["light", "dark"] as const) {
      await page
        .getByRole("radio", {
          name: scheme === "light" ? "Light" : "Dark",
          exact: true,
        })
        .click()
      const picker = page.locator(`#${scheme}-appearance-preset`)

      for (const preset of TAB_THEME_PRESETS.filter(
        (candidate) => candidate.scheme === scheme
      )) {
        await picker.click()
        await picker.fill(preset.label)
        await page
          .getByRole("option", { name: preset.label, exact: true })
          .click()
        await expect(picker).toHaveValue(preset.label)
        await expect
          .poll(() =>
            page.evaluate(() =>
              document.documentElement.style
                .getPropertyValue("--document-background")
                .trim()
            )
          )
          .toBe(BACKGROUND_COLORS[preset.backgroundId])

        const tabTones = await page.evaluate(() => {
          const inactive = document.querySelector<HTMLElement>(
            ".document-tab:not([data-active])"
          )
          const active = document.querySelector<HTMLElement>(
            ".document-tab[data-active]"
          )
          if (!inactive || !active) {
            throw new Error("Expected two document tabs")
          }

          const probe = document.createElement("div")
          probe.style.position = "fixed"
          probe.style.left = "-10000px"
          const inactivePreview = document.createElement("div")
          inactivePreview.className = "document-tab window-profile-tab-preview"
          const activePreview = document.createElement("div")
          activePreview.className = "document-tab window-profile-tab-preview"
          activePreview.dataset.active = ""
          probe.append(inactivePreview, activePreview)
          document.body.append(probe)

          try {
            const backgrounds = [
              getComputedStyle(document.documentElement)
                .getPropertyValue("--document-background")
                .trim(),
              getComputedStyle(inactive).backgroundColor,
              getComputedStyle(active).backgroundColor,
              getComputedStyle(inactivePreview).backgroundColor,
              getComputedStyle(activePreview).backgroundColor,
            ]
            const canvas = document.createElement("canvas")
            canvas.width = backgrounds.length
            canvas.height = 1
            const context = canvas.getContext("2d")
            if (!context) throw new Error("Canvas colors are unavailable")
            for (const [index, background] of backgrounds.entries()) {
              context.fillStyle = background
              context.fillRect(index, 0, 1, 1)
            }
            const pixels = context.getImageData(
              0,
              0,
              backgrounds.length,
              1
            ).data
            const relativeLuminance = (index: number) => {
              const offset = index * 4
              const linear = (channel: number) => {
                const value = channel / 255
                return value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4
              }
              return (
                0.2126 * linear(pixels[offset] ?? 0) +
                0.7152 * linear(pixels[offset + 1] ?? 0) +
                0.0722 * linear(pixels[offset + 2] ?? 0)
              )
            }
            const background = relativeLuminance(0)
            const inactiveLuminance = relativeLuminance(1)
            const activeLuminance = relativeLuminance(2)
            const contrast = (left: number, right: number) =>
              (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
            return {
              activeContrast: contrast(background, activeLuminance),
              activeLuminance,
              activePreviewBackground: backgrounds[4],
              inactiveContrast: contrast(background, inactiveLuminance),
              inactiveLuminance,
              inactivePreviewBackground: backgrounds[3],
              activeBackground: backgrounds[2],
              inactiveBackground: backgrounds[1],
            }
          } finally {
            probe.remove()
          }
        })

        expect(tabTones.activeContrast, preset.label).toBeGreaterThan(
          tabTones.inactiveContrast
        )
        if (scheme === "light") {
          expect(tabTones.activeLuminance, preset.label).toBeLessThan(
            tabTones.inactiveLuminance
          )
        } else {
          expect(tabTones.activeLuminance, preset.label).toBeGreaterThan(
            tabTones.inactiveLuminance
          )
        }
        expect(tabTones.activePreviewBackground, preset.label).toBe(
          tabTones.activeBackground
        )
        expect(tabTones.inactivePreviewBackground, preset.label).toBe(
          tabTones.inactiveBackground
        )
      }
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("theme presets preview while cycling and dismiss without rolling back", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-theme-picker-")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await page.getByRole("button", { name: "Theme", exact: true }).click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .evaluate(async (dialog) =>
        Promise.all(
          dialog
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => undefined))
        )
      )

    const picker = page.locator("#dark-appearance-preset")
    const background = page.locator("#dark-appearance-background")
    await expect(picker).toHaveRole("combobox")
    await expect(picker).toHaveValue("Default (One Dark)")
    await expect(picker).toHaveAttribute("aria-expanded", "false")

    await picker.click()
    const listbox = page.getByRole("listbox")
    const popup = page.locator('[data-slot="combobox-content"]')
    await expect(listbox).toBeVisible()
    await expect(page.locator('[data-slot="combobox-positioner"]')).toHaveCSS(
      "-webkit-app-region",
      "no-drag"
    )
    await expect(listbox.getByRole("option")).toHaveCount(20)
    await expect(picker).toBeFocused()
    await expect(popup.getByRole("combobox")).toHaveCount(0)
    await expect(
      popup.locator(':scope > [data-slot="combobox-list"]')
    ).toHaveCount(1)
    const pickerGroup = picker.locator(
      'xpath=ancestor::*[@data-slot="input-group"]'
    )
    await expect
      .poll(async () => {
        const pickerBox = await pickerGroup.boundingBox()
        const popupBox = await popup.boundingBox()
        if (!pickerBox || !popupBox) return Number.POSITIVE_INFINITY
        return Math.abs(popupBox.width - pickerBox.width)
      })
      .toBeLessThanOrEqual(0.15)

    const optionCount = await listbox.getByRole("option").count()
    await page.keyboard.press("ArrowDown")
    await expect(picker).toHaveValue("CodeMirror Light")
    await expect(background).toContainText("Default")
    await expect(
      listbox.getByRole("option", {
        name: "CodeMirror Light",
        selected: true,
      })
    ).toBeVisible()
    const highlightedTheme = listbox.locator("[data-highlighted]")
    await expect(highlightedTheme).toHaveText("CodeMirror Light")
    await expect
      .poll(() =>
        highlightedTheme.evaluate(
          (element) =>
            getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)"
        )
      )
      .toBe(true)
    await expect(listbox.getByRole("option")).toHaveCount(optionCount)

    await page.keyboard.press("ArrowDown")
    await expect(picker).toHaveValue("Dracula")
    await expect(background).toContainText("Dracula")
    await expect(
      listbox.getByRole("option", { name: "Dracula", selected: true })
    ).toBeVisible()
    await expect(listbox.getByRole("option")).toHaveCount(optionCount)

    await page.keyboard.press("ArrowDown")
    await expect(picker).toHaveValue("Nord")
    await expect(background).toContainText("Nord")
    await expect(
      listbox.getByRole("option", { name: "Nord", selected: true })
    ).toBeVisible()
    await expect(listbox.getByRole("option")).toHaveCount(optionCount)

    await page.keyboard.press("Enter")
    await expect(listbox).toHaveCount(0)
    await expect(picker).toHaveValue("Nord")

    await picker.click()
    await expect(listbox).toBeVisible()
    await picker.fill("Rosé Pine")
    await expect(listbox.getByRole("option")).toHaveCount(2)
    await page.keyboard.press("ArrowDown")
    await expect(picker).toHaveValue("Rosé Pine Dawn")
    await expect(background).toContainText("Rosé Pine Dawn")
    await expect(
      listbox.getByRole("option", {
        name: "Rosé Pine Dawn",
        selected: true,
      })
    ).toBeVisible()
    await expect(listbox.getByRole("option")).toHaveCount(2)

    await page.keyboard.press("ArrowDown")
    await expect(picker).toHaveValue("Rosé Pine Moon")
    await expect(background).toContainText("Rosé Pine Moon")
    await expect(
      listbox.getByRole("option", {
        name: "Rosé Pine Moon",
        selected: true,
      })
    ).toBeVisible()
    await expect(listbox.getByRole("option")).toHaveCount(2)

    await page.keyboard.press("Escape")
    await expect(listbox).toHaveCount(0)
    await expect(picker).toHaveValue("Rosé Pine Moon")
    await expect(picker).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(picker).not.toBeFocused()
    await expect(picker).toHaveValue("Rosé Pine Moon")
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()

    await page.getByRole("heading", { name: "Settings" }).click()
    await expect(listbox).toHaveCount(0)
    await expect(picker).toHaveValue("Rosé Pine Moon")
    await expect(background).toContainText("Rosé Pine Moon")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("appearance mode indicator animates across a surface theme change", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-appearance-mode-")
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.locator(".cm-editor").waitFor()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await openSettingsSection(page, "Theme")

    const selector = page.getByRole("radiogroup", {
      name: "Appearance mode",
    })
    await expect(selector).toHaveCSS("width", "112px")
    const indicator = selector.locator(
      '[data-slot="appearance-mode-indicator"]'
    )
    await expect(
      selector.getByRole("radio", { name: "System" })
    ).toHaveAttribute("aria-checked", "true")
    await expect(selector.locator('[role="radio"][tabindex="0"]')).toHaveCount(
      1
    )
    await expect(
      selector.getByRole("radio", { name: "Light", exact: true })
    ).toHaveAttribute("tabindex", "-1")
    await selector.getByRole("radio", { name: "System" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(selector.getByRole("radio", { name: "Dark" })).toBeFocused()
    await expect(selector.getByRole("radio", { name: "Dark" })).toBeChecked()
    await page.keyboard.press("ArrowLeft")
    await expect(selector.getByRole("radio", { name: "System" })).toBeFocused()
    await expect(selector.getByRole("radio", { name: "System" })).toBeChecked()
    await indicator.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished)
      )
    )

    const initialScheme = await page.evaluate(() =>
      document.documentElement.classList.contains("dark") ? "dark" : "light"
    )
    const targetMode = initialScheme === "dark" ? "Light" : "Dark"
    const targetIndex = targetMode === "Light" ? 0 : 2
    const startX = await indicator.evaluate(
      (element) =>
        new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
    )

    await indicator.evaluate((element) => {
      const state = window as typeof window & {
        appearanceIndicatorTransitionStarted?: boolean
      }
      state.appearanceIndicatorTransitionStarted = false
      element.addEventListener(
        "transitionrun",
        (event) => {
          if ((event as TransitionEvent).propertyName === "transform") {
            state.appearanceIndicatorTransitionStarted = true
          }
        },
        { once: true }
      )
    })
    await selector.getByRole("radio", { name: targetMode }).click()

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                appearanceIndicatorTransitionStarted?: boolean
              }
            ).appearanceIndicatorTransitionStarted
        )
      )
      .toBe(true)

    // System is the center segment, so its computed one-segment translation
    // remains the exact unit even when Electron page zoom is not 100%.
    const targetX = startX * targetIndex
    await expect
      .poll(async () => {
        const x = await indicator.evaluate(
          (element) =>
            new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
        )
        const traveled = Math.abs(x - startX)
        const distance = Math.abs(targetX - startX)
        return traveled > 0.5 && traveled < distance - 0.5
      })
      .toBe(true)

    await expect
      .poll(() =>
        indicator.evaluate(
          (element) =>
            new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
        )
      )
      .toBeCloseTo(targetX, 1)

    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(indicator).toHaveCSS("transition-property", "none")
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("Windows previews System appearance before Settings is saved", async () => {
  test.skip(process.platform !== "win32", "Windows native-theme behavior")
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-system-theme-preview-")
  )
  const settingsPath = path.join(userData, "settings.json")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, samplePath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    // Playwright may emulate a renderer scheme independently of the host OS.
    // Use the page's System result for the surface assertion while separately
    // requiring Electron's process-wide source to return to `system` below.
    const systemScheme = await page.evaluate(() =>
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    )
    const explicitScheme = systemScheme === "dark" ? "light" : "dark"
    const explicitLabel = explicitScheme === "dark" ? "Dark" : "Light"

    await page.keyboard.press("Control+,")
    await openSettingsSection(page, "Theme")
    let settingsDialog = page.getByRole("dialog", { name: "Settings" })
    await settingsDialog
      .getByRole("radio", { name: explicitLabel, exact: true })
      .click()
    await settingsDialog.getByRole("button", { name: "Done" }).click()
    await expect(settingsDialog).toHaveCount(0)
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe(explicitScheme)

    await page.keyboard.press("Control+,")
    await openSettingsSection(page, "Theme")
    settingsDialog = page.getByRole("dialog", { name: "Settings" })
    await settingsDialog.getByRole("radio", { name: "System" }).click()

    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system")
    await expect(page.locator("html")).toHaveClass(new RegExp(systemScheme))

    // Specialized Settings workspaces commit only their own persisted fields
    // while retaining the parent draft, so even a source-window commit must
    // not end this appearance preview.
    const committedExplicitSettings = JSON.parse(
      await readFile(settingsPath, "utf8")
    )
    await page.evaluate(
      (persistedSettings) => window.pulseMd.setSettings(persistedSettings),
      committedExplicitSettings
    )
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system")

    // A resource-only Settings commit and an external launch must not
    // overwrite the process-wide source while this exclusive draft is live.
    await page.evaluate(() => window.pulseMd.setDefaultWindowProfile(null))
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system")
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit(
        "second-instance",
        {} as Electron.Event,
        [],
        process.cwd(),
        { kind: "new-window", filePaths: [] }
      )
    })
    await expect.poll(() => app.windows().length).toBe(2)
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system")
    await expect(
      settingsDialog.getByRole("radio", { name: "System" })
    ).toBeChecked()
    await expect
      .poll(
        async () =>
          (
            JSON.parse(await readFile(settingsPath, "utf8")) as {
              appearanceMode?: string
            }
          ).appearanceMode
      )
      .toBe(explicitScheme)

    await settingsDialog.getByRole("button", { name: "Cancel" }).click()
    await expect(settingsDialog).toHaveCount(0)
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe(explicitScheme)
    await expect(page.locator("html")).toHaveClass(new RegExp(explicitScheme))
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
