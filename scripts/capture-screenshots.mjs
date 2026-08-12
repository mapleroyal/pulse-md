import { _electron as electron } from "@playwright/test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const outputDirectory = path.join(projectRoot, "docs", "images")
const viewport = { width: 1440, height: 900 }

async function loadSettingsModule() {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-screenshot-settings-")
  )
  const outfile = path.join(temporaryDirectory, "settings.mjs")
  try {
    await build({
      bundle: true,
      entryPoints: [path.join(projectRoot, "src", "shared", "contracts.ts")],
      format: "esm",
      outfile,
      platform: "node",
    })
    return await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

const { cloneAppSettings, DEFAULT_APP_SETTINGS } = await loadSettingsModule()

async function settle(page) {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready
    await new Promise((resolve) =>
      globalThis.requestAnimationFrame(() =>
        globalThis.requestAnimationFrame(resolve)
      )
    )
  })
}

async function launchCapture({ appearance, documents, mode = "live" }) {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-repository-screenshot-")
  )
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = appearance
  settings.initialEditorMode = mode
  settings.spellCheck = false
  settings.keepReadyInBackground = false
  settings.backgroundEffect.enabled = false
  settings.chrome.alwaysShowTopControls = true
  settings.chrome.alwaysShowStatusBar = false
  settings.chrome.centeredPathDisplay = "filename"
  settings.chrome.tabDisplay = "filename"
  settings.chrome.tabVisibility = "always"
  settings.markdownExtensions.latex = true
  settings.markdownExtensions.mermaid = true
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify(settings)}\n`
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, ...documents],
    cwd: projectRoot,
  })
  const page = await app.firstWindow()
  await page.locator(".cm-editor").waitFor()
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    viewport
  )
  await page.waitForFunction(
    (size) =>
      globalThis.innerWidth === size.width &&
      globalThis.innerHeight === size.height,
    viewport
  )
  return { app, page, userData }
}

async function closeCapture({ app, userData }) {
  const closed = new Promise((resolve) => app.once("close", resolve))
  await app.evaluate(({ app, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit()
  })
  await closed
  await rm(userData, { force: true, recursive: true })
}

async function capture(options, prepare = async () => undefined) {
  const running = await launchCapture(options)
  try {
    await prepare(running.page)
    await settle(running.page)
    await running.page.mouse.move(720, 42)
    const png = await running.page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png",
    })
    const dimensions = [png.readUInt32BE(16), png.readUInt32BE(20)]
    if (dimensions[0] !== viewport.width || dimensions[1] !== viewport.height) {
      throw new Error(
        `Screenshot has unexpected dimensions ${dimensions.join("×")}`
      )
    }
    return png
  } finally {
    await closeCapture(running)
  }
}

const sample = path.join(projectRoot, "tests", "fixtures", "sample.md")
const showcase = path.join(projectRoot, "markdown-test.md")
const screenshots = new Map()

screenshots.set(
  "live-editor.png",
  await capture({
    appearance: "light",
    documents: [sample, showcase],
  })
)

screenshots.set(
  "callouts-dark.png",
  await capture(
    { appearance: "dark", documents: [showcase, sample] },
    async (page) => {
      await page.locator(".cm-content").evaluate((element) => {
        const view = element.cmTile?.view
        if (!view) throw new Error("CodeMirror view is unavailable")
        const source = view.state.doc.toString()
        const position = source.indexOf("## 10. Obsidian-style callouts")
        if (position < 0) {
          throw new Error("Callout fixture heading is unavailable")
        }
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
      })
      const heading = page
        .locator(".cm-content")
        .getByText("10. Obsidian-style callouts", { exact: true })
      await heading.waitFor()
      await heading.evaluate((element) => {
        const scroller = element.closest(".cm-scroller")
        if (!scroller) throw new Error("Editor scroller is unavailable")
        scroller.scrollTop +=
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          72
      })
      await page.keyboard.press("Escape")
    }
  )
)

screenshots.set(
  "raw-markdown.png",
  await capture(
    { appearance: "dark", documents: [showcase, sample], mode: "source" },
    async (page) => {
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+f" : "Control+f"
      )
      const find = page.getByRole("textbox", { name: "Find" })
      await find.waitFor()
      await find.fill("Markdown")
      await find.press("Enter")
      await find.press("Enter")
    }
  )
)

screenshots.set(
  "theme-settings.png",
  await capture(
    { appearance: "light", documents: [sample, showcase] },
    async (page) => {
      await page.getByRole("button", { name: "Settings" }).click()
      const theme = page.getByRole("button", { name: "Theme", exact: true })
      await theme.waitFor()
      if ((await theme.getAttribute("aria-expanded")) !== "true") {
        await theme.click()
      }
    }
  )
)

await mkdir(outputDirectory, { recursive: true })
for (const [filename, png] of screenshots) {
  await writeFile(path.join(outputDirectory, filename), png)
}
