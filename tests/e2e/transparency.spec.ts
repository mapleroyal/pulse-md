import path from "node:path"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { windowsBackgroundMaterialSupported } from "../../electron/window-chrome"
import { exitApplication } from "./electron-helpers"

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, "../..")

function nativeBackgroundEffectsSupported(): boolean {
  return (
    process.platform === "darwin" ||
    windowsBackgroundMaterialSupported(process.platform, os.release())
  )
}

interface CaptureStats {
  colorVariance: number
  cornerColor: [number, number, number]
  meanColor: [number, number, number]
}

async function readCaptureStats(filePath: string): Promise<CaptureStats> {
  const image = await readFile(filePath)
  if (image.toString("ascii", 0, 2) !== "BM") {
    throw new Error("macOS compositor capture is not a BMP")
  }

  const pixelOffset = image.readUInt32LE(10)
  const width = image.readInt32LE(18)
  const rawHeight = image.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0
  const bitsPerPixel = image.readUInt16LE(28)
  if (width <= 0 || height <= 0 || bitsPerPixel !== 32) {
    throw new Error("macOS compositor capture has an unsupported layout")
  }

  const sums = [0, 0, 0]
  const squaredSums = [0, 0, 0]
  let sampleCount = 0
  const xStart = Math.floor(width * 0.15)
  const xEnd = Math.floor(width * 0.85)
  const yStart = Math.floor(height * 0.25)
  const yEnd = Math.floor(height * 0.8)

  for (let y = yStart; y < yEnd; y += 4) {
    const row = topDown ? y : height - 1 - y
    for (let x = xStart; x < xEnd; x += 4) {
      const offset = pixelOffset + (row * width + x) * 4
      const channels = [image[offset + 2], image[offset + 1], image[offset]]
      for (let channel = 0; channel < channels.length; channel += 1) {
        const value = channels[channel]
        sums[channel] += value
        squaredSums[channel] += value * value
      }
      sampleCount += 1
    }
  }

  const colorVariance = sums.reduce((total, sum, channel) => {
    const mean = sum / sampleCount
    return total + squaredSums[channel] / sampleCount - mean * mean
  }, 0)

  const cornerSums = [0, 0, 0]
  let cornerSampleCount = 0
  const cornerSize = Math.max(1, Math.floor(Math.min(width, height) * 0.005))
  const cornerOrigins = [
    [0, 0],
    [width - cornerSize, 0],
    [0, height - cornerSize],
    [width - cornerSize, height - cornerSize],
  ]
  for (const [originX, originY] of cornerOrigins) {
    for (let y = originY; y < originY + cornerSize; y += 1) {
      const row = topDown ? y : height - 1 - y
      for (let x = originX; x < originX + cornerSize; x += 1) {
        const offset = pixelOffset + (row * width + x) * 4
        cornerSums[0] += image[offset + 2]
        cornerSums[1] += image[offset + 1]
        cornerSums[2] += image[offset]
        cornerSampleCount += 1
      }
    }
  }

  return {
    colorVariance,
    cornerColor: cornerSums.map(
      (sum) => sum / cornerSampleCount
    ) as CaptureStats["cornerColor"],
    meanColor: sums.map(
      (sum) => sum / sampleCount
    ) as CaptureStats["meanColor"],
  }
}

function colorDistance(left: number[], right: number[]): number {
  return left.reduce(
    (total, channel, index) => total + Math.abs(channel - right[index]),
    0
  )
}

test("launch reveal keeps focus and first input available while it runs", async () => {
  test.skip(
    !nativeBackgroundEffectsSupported(),
    "Native background effects require macOS or Windows 11 22H2+"
  )

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-launch-reveal-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.backgroundEffect = {
    ...settings.backgroundEffect,
    enabled: true,
    translucency: 0.8,
    blurRadius: 8,
  }
  settings.launchTransition = {
    ...settings.launchTransition,
    durationMs: 3_000,
    enabled: true,
  }
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    test.skip(
      await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ),
      "The product intentionally skips launch animation with Reduce Motion"
    )
    const editor = page.locator(".cm-editor")
    await editor.waitFor()
    await page.waitForFunction(
      () => document.documentElement.dataset.launchTransition === "running"
    )
    await page.waitForFunction(() => {
      const editorElement = document.querySelector(".cm-editor")
      return (
        document.hasFocus() &&
        editorElement instanceof HTMLElement &&
        editorElement.contains(document.activeElement)
      )
    })

    const probe = "typed during launch reveal"
    await page.keyboard.insertText(probe)
    await expect(page.locator(".cm-content")).toContainText(probe)
    await expect(page.locator("html")).toHaveAttribute(
      "data-launch-transition",
      "running"
    )

    await page.waitForFunction(
      () => document.documentElement.dataset.launchTransition === "settled",
      undefined,
      { timeout: 5_000 }
    )
    const marks = await page.evaluate(() => ({
      focused: performance.getEntriesByName("pmd:editor-focused")[0]?.startTime,
      firstChange: performance.getEntriesByName("pmd:first-document-change")[0]
        ?.startTime,
      settled: performance.getEntriesByName("pmd:launch-transition-settled")[0]
        ?.startTime,
      started: performance.getEntriesByName("pmd:launch-transition-started")[0]
        ?.startTime,
    }))
    expect(marks.focused).toBeLessThanOrEqual(marks.started!)
    expect(marks.started).toBeLessThan(marks.firstChange!)
    expect(marks.firstChange).toBeLessThan(marks.settled!)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("disabled launch transition settles without starting an animation", async () => {
  test.skip(
    !nativeBackgroundEffectsSupported(),
    "Native background effects require macOS or Windows 11 22H2+"
  )

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-launch-disabled-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.backgroundEffect = {
    ...settings.backgroundEffect,
    enabled: true,
    translucency: 0.8,
    blurRadius: 8,
  }
  settings.launchTransition = {
    ...settings.launchTransition,
    delayMs: 1_000,
    durationMs: 3_000,
    enabled: false,
  }
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await page.waitForFunction(
      () =>
        performance.getEntriesByName("pmd:launch-transition-settled").length > 0
    )
    await expect(page.locator("html")).toHaveAttribute(
      "data-launch-transition",
      "settled"
    )
    expect(
      await page.evaluate(
        () =>
          performance.getEntriesByName("pmd:launch-transition-started").length
      )
    ).toBe(0)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("disabled launch transition is translucent before the first show", async () => {
  test.skip(
    !nativeBackgroundEffectsSupported(),
    "Native background effects require macOS or Windows 11 22H2+"
  )

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-launch-eager-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.backgroundEffect = {
    ...settings.backgroundEffect,
    enabled: true,
    translucency: 0.8,
    blurRadius: 8,
  }
  settings.launchTransition = {
    ...settings.launchTransition,
    enabled: false,
  }
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, "--pmd-cli-server"],
    cwd: projectRoot,
  })

  try {
    test.skip(
      await app.evaluate(({ nativeTheme }) =>
        Boolean(nativeTheme.prefersReducedTransparency)
      ),
      "The product intentionally stays opaque with Reduce Transparency"
    )

    const firstShowBackground = app.evaluate(
      async ({ app: electronApp, nativeTheme }) => {
        await electronApp.whenReady()
        while (
          electronApp.listenerCount("activate") === 0 ||
          nativeTheme.listenerCount("updated") === 0
        ) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }

        return await new Promise<{
          afterTheme: string | null
          beforeTheme: string | null
          shown: string
        }>((resolve, reject) => {
          let afterTheme: string | null = null
          let beforeTheme: string | null = null
          const timeout = setTimeout(
            () => reject(new Error("The activation window was not shown")),
            5_000
          )
          electronApp.once("browser-window-created", (_event, window) => {
            // Reproduce the launch race: this immediate is registered during
            // construction, so it runs after eager setup but before show.
            setImmediate(() => {
              beforeTheme = window.getBackgroundColor()
              nativeTheme.emit("updated")
              afterTheme = window.getBackgroundColor()
            })
            window.once("show", () => {
              clearTimeout(timeout)
              resolve({
                afterTheme,
                beforeTheme,
                shown: window.getBackgroundColor(),
              })
            })
          })
          electronApp.emit("activate")
        })
      }
    )
    const [, backgrounds] = await Promise.all([
      app.firstWindow(),
      firstShowBackground,
    ])
    // Electron reports the clear native backing as black here; the themed
    // opaque launch backing would be the document color (for example, #181818
    // in dark mode).
    expect(backgrounds).toMatchObject({
      afterTheme: expect.stringMatching(/000000/i),
      beforeTheme: expect.stringMatching(/000000/i),
      shown: expect.stringMatching(/000000/i),
    })
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("Windows background effects preview, cancel, persist, and use OS-managed blur", async () => {
  test.skip(
    process.platform !== "win32" || !nativeBackgroundEffectsSupported(),
    "Windows system backdrops require Windows 11 22H2+"
  )

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-win-effects-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "dark"
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )

  let app: ElectronApplication | null = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    let page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    test.skip(
      await app.evaluate(({ nativeTheme }) =>
        Boolean(nativeTheme.prefersReducedTransparency)
      ),
      "The product intentionally stays opaque with Reduce Transparency"
    )
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error("The document window is unavailable")
      const testGlobal = globalThis as typeof globalThis & {
        __pmdBackgroundMaterials?: string[]
        __pmdTitleBarOverlays?: unknown[]
      }
      const appliedMaterials: string[] = []
      const appliedTitleBarOverlays: unknown[] = []
      const setBackgroundMaterial = window.setBackgroundMaterial.bind(window)
      const setTitleBarOverlay = window.setTitleBarOverlay.bind(window)
      testGlobal.__pmdBackgroundMaterials = appliedMaterials
      testGlobal.__pmdTitleBarOverlays = appliedTitleBarOverlays
      window.setBackgroundMaterial = (material) => {
        appliedMaterials.push(material)
        setBackgroundMaterial(material)
      }
      window.setTitleBarOverlay = (options) => {
        appliedTitleBarOverlays.push(options)
        setTitleBarOverlay(options)
      }
    })
    const appliedMaterials = () =>
      app!.evaluate(() => {
        const testGlobal = globalThis as typeof globalThis & {
          __pmdBackgroundMaterials?: string[]
        }
        return testGlobal.__pmdBackgroundMaterials ?? []
      })
    const backgroundColor = () =>
      app!.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? null
      )
    const titleBarOverlayApplicationCount = () =>
      app!.evaluate(() => {
        const testGlobal = globalThis as typeof globalThis & {
          __pmdTitleBarOverlays?: unknown[]
        }
        return testGlobal.__pmdTitleBarOverlays?.length ?? 0
      })
    const html = page.locator("html")
    const appShell = page.locator(".app-shell")
    await expect(html).toHaveAttribute("data-background-capability", "win32")

    await page.evaluate(() => {
      document.documentElement.dataset.backgroundCapability = "opaque"
    })
    await page.keyboard.press("Control+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await expect(
      page.getByRole("switch", { name: "Window transparency & blur" })
    ).toBeDisabled()
    await expect(
      page.getByText(/System backdrops are unavailable on this Windows release/)
    ).toBeVisible()
    await page.getByRole("button", { name: "Cancel" }).click()
    await page.evaluate(() => {
      document.documentElement.dataset.backgroundCapability = "win32"
    })

    await page.keyboard.press("Control+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await expect(
      page.getByText(/Windows manages blur strength for the system backdrop/)
    ).toBeVisible()
    await expect(page.getByLabel("Background blur radius value")).toHaveCount(0)

    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    await expect(html).toHaveAttribute("data-background-effect", "translucent")
    await expect(appShell).toHaveCSS("background-color", "rgba(24, 24, 24, 0)")
    await expect(html).toHaveCSS("--document-surface-background", "#181818d9")
    await expect.poll(appliedMaterials).toContain("acrylic")
    await expect.poll(backgroundColor).toMatch(/000000/i)

    await page.getByRole("switch", { name: "Launch transition" }).click()
    await page
      .getByRole("button", { name: "Customize launch transition" })
      .click()
    const launchWorkspace = page.getByRole("region", {
      name: "Launch transition preview workspace",
    })
    const launchStrategy = launchWorkspace.getByRole("combobox", {
      name: "Launch transition strategy",
    })
    await expect(launchStrategy).toContainText("Opaque Cover Crossfade")
    await expect(
      launchWorkspace.getByText(/Windows preloads the system-managed backdrop/)
    ).toBeVisible()
    await launchStrategy.click()
    await expect(launchStrategy).toHaveAttribute("aria-expanded", "true")
    await expect(
      page.getByRole("option", { name: "Tint Reveal · Blur Preloaded" })
    ).toBeVisible()
    await expect(
      page.getByRole("option", { name: "Tint and Blur Together" })
    ).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(launchStrategy).toHaveAttribute("aria-expanded", "false")
    await expect(launchStrategy).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(launchWorkspace).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()

    const acrylicApplicationsBeforeTintChange = (
      await appliedMaterials()
    ).filter((material) => material === "acrylic").length
    const overlayApplicationsBeforeTintChange =
      await titleBarOverlayApplicationCount()
    await page.getByLabel("Background translucency percentage").fill("70")
    await expect(html).toHaveCSS("--document-surface-background", "#1818184d")
    await expect
      .poll(
        async () =>
          (await appliedMaterials()).filter(
            (material) => material === "acrylic"
          ).length
      )
      .toBe(acrylicApplicationsBeforeTintChange)
    await expect
      .poll(titleBarOverlayApplicationCount)
      .toBe(overlayApplicationsBeforeTintChange)
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(html).toHaveAttribute("data-background-effect", "opaque")
    await expect(appShell).toHaveCSS("background-color", "rgb(24, 24, 24)")
    await expect
      .poll(appliedMaterials)
      .toEqual(expect.arrayContaining(["acrylic", "none"]))
    await expect.poll(backgroundColor).toMatch(/181818/i)

    await page.keyboard.press("Control+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    await page.getByRole("switch", { name: "Callouts" }).click()
    await page.getByRole("switch", { name: "Code blocks" }).click()
    await page.getByRole("switch", { name: "Inline code" }).click()
    await page.getByLabel("Background translucency percentage").fill("70")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done", exact: true })
      .click()
    await expect
      .poll(async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"))
      )
      .toMatchObject({
        backgroundEffect: {
          blurRadius: DEFAULT_APP_SETTINGS.backgroundEffect.blurRadius,
          enabled: true,
          translucentCallouts: false,
          translucentCodeBlocks: false,
          translucentInlineCode: true,
          translucency: 0.7,
        },
      })

    await exitApplication(app)
    app = null
    app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${userData}`],
      cwd: projectRoot,
    })
    page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page.locator("html")).toHaveAttribute(
      "data-background-effect",
      "translucent"
    )
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-translucent-callouts"
    )
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-translucent-code-blocks"
    )
    await expect(page.locator("html")).toHaveAttribute(
      "data-translucent-inline-code",
      "true"
    )
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      "rgba(24, 24, 24, 0)"
    )
    await expect(page.locator("html")).toHaveCSS(
      "--document-surface-background",
      "#1818184d"
    )
    await expect.poll(backgroundColor).toMatch(/000000/i)
  } finally {
    if (app) await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("macOS compositor exposes and blurs a window behind the editor", async () => {
  test.skip(process.platform !== "darwin", "WindowServer blur is macOS-only")

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-transparency-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "dark"
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    const bounds = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const target = BrowserWindow.getAllWindows()[0]
      const workArea = screen.getPrimaryDisplay().workArea
      const bounds = {
        x: workArea.x + 120,
        y: workArea.y + 80,
        width: 800,
        height: 600,
      }
      target.setBounds(bounds)
      const backdrop = new BrowserWindow({
        ...bounds,
        frame: false,
        show: false,
        backgroundColor: "#ff0066",
      })
      await backdrop.loadURL(
        "data:text/html,<style>html,body{margin:0;width:100%;height:100%;background:repeating-linear-gradient(90deg,%23ff0066 0 24px,%2300ccff 24px 48px)}</style>"
      )
      backdrop.show()
      target.show()
      target.setAlwaysOnTop(true, "screen-saver")
      target.moveTop()
      target.focus()
      return bounds
    })

    const captureStats = async (name: string) => {
      const filePath = path.join(userData, `${name}.bmp`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await execFileAsync("/usr/sbin/screencapture", [
        "-x",
        "-tbmp",
        `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
        filePath,
      ])
      return readCaptureStats(filePath)
    }
    const captureWhen = async (
      name: string,
      predicate: (stats: CaptureStats) => boolean
    ) => {
      const result: { accepted?: CaptureStats } = {}
      await expect
        .poll(
          async () => {
            const stats = await captureStats(name)
            if (predicate(stats)) result.accepted = stats
            return result.accepted !== undefined
          },
          {
            message: `waiting for the ${name} compositor state`,
            timeout: 5_000,
          }
        )
        .toBe(true)
      if (!result.accepted) {
        throw new Error(`The ${name} compositor state was lost`)
      }
      return result.accepted
    }

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    await page.getByLabel("Background translucency percentage").fill("100")
    await page.getByLabel("Background blur radius value").fill("0")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    const clear = await captureWhen(
      "clear",
      ({ colorVariance }) => colorVariance > 20_000
    )

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page.getByLabel("Background blur radius value").fill("35")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    const blurred = await captureWhen(
      "blurred",
      ({ colorVariance, cornerColor }) =>
        colorVariance > 200 &&
        colorVariance < clear.colorVariance * 0.25 &&
        colorDistance(cornerColor, clear.cornerColor) < 10
    )

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page.getByLabel("Background translucency percentage").fill("70")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-color",
      /rgba\(.+, 0\)/
    )
    const tintColor = await page.evaluate(() => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--document-background")
        .trim()
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
      if (!match) throw new Error(`Unsupported document color: ${value}`)
      return match.slice(1).map((channel) => Number.parseInt(channel, 16))
    })
    const tinted = await captureWhen(
      "tinted",
      ({ colorVariance, meanColor }) =>
        colorVariance < blurred.colorVariance * 0.75 &&
        colorDistance(meanColor, tintColor) <
          colorDistance(blurred.meanColor, tintColor)
    )

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page.getByLabel("Background translucency percentage").fill("100")
    await page.getByLabel("Background blur radius value").fill("0")
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    const clearAgain = await captureWhen(
      "clear-again",
      ({ colorVariance, cornerColor }) =>
        colorVariance > 20_000 &&
        colorDistance(cornerColor, clear.cornerColor) < 10
    )

    await page.keyboard.press("Meta+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    const opaque = await captureWhen(
      "opaque",
      ({ colorVariance }) => colorVariance < 10
    )

    expect(clear.colorVariance).toBeGreaterThan(20_000)
    expect(blurred.colorVariance).toBeGreaterThan(200)
    expect(blurred.colorVariance).toBeLessThan(clear.colorVariance * 0.25)
    expect(tinted.colorVariance).toBeLessThan(blurred.colorVariance * 0.75)
    expect(colorDistance(tinted.meanColor, tintColor)).toBeLessThan(
      colorDistance(blurred.meanColor, tintColor)
    )
    expect(colorDistance(blurred.cornerColor, clear.cornerColor)).toBeLessThan(
      10
    )
    expect(clearAgain.colorVariance).toBeGreaterThan(20_000)
    expect(
      colorDistance(clearAgain.cornerColor, clear.cornerColor)
    ).toBeLessThan(10)
    expect(opaque.colorVariance).toBeLessThan(10)
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})
