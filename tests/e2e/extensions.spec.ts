import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  _electron as electron,
  chromium,
  expect,
  test,
  type Browser,
  type Page,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const packagedExecutable = process.env.PMD_E2E_EXECUTABLE?.trim()
const settingsShortcut = process.platform === "darwin" ? "Meta+," : "Control+,"
const packagedLaunchTimeoutMs = 15_000
const packagedShutdownTimeoutMs = 3_000
const extensionSwitchNames = [
  "Superscript and subscript",
  "Emoji shortcode recognition",
  "Emoji shortcode expansion",
  "Footnotes",
  "Definition lists",
  "LaTeX math",
  "Mermaid diagrams",
  "YAML front matter",
  "Sanitized HTML",
] as const

function launchArguments(userData: string, filePath: string) {
  return {
    args: [projectRoot, `--user-data-dir=${userData}`, filePath],
    cwd: projectRoot,
  }
}

interface LaunchedTestApplication {
  close(): Promise<void>
  page: Page
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout))
}

function waitForDevToolsEndpoint(
  child: ReturnType<typeof spawn>
): Promise<string> {
  const stderr = child.stderr
  if (!stderr) {
    return Promise.reject(
      new Error("Packaged application stderr was not captured")
    )
  }

  return new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for the packaged renderer DevTools endpoint${output ? `:\n${output}` : ""}`
        )
      )
    }, packagedLaunchTimeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      stderr.off("data", onData)
      child.off("error", onError)
      child.off("exit", onExit)
      stderr.resume()
    }
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString()
      const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1]
      if (!endpoint) return
      cleanup()
      resolve(endpoint)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(
        new Error("Unable to launch the packaged application", { cause: error })
      )
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(
        new Error(
          `Packaged application exited before its renderer was inspectable (${signal ?? code})${output ? `:\n${output}` : ""}`
        )
      )
    }

    stderr.setEncoding("utf8")
    stderr.on("data", onData)
    child.once("error", onError)
    child.once("exit", onExit)
  })
}

async function stopPackagedApplication(
  child: ReturnType<typeof spawn>,
  childClosed: Promise<void>,
  page?: Page
): Promise<void> {
  const stopped = () => child.exitCode !== null || child.signalCode !== null
  if (stopped()) {
    await withTimeout(
      childClosed,
      packagedShutdownTimeoutMs,
      "Packaged application did not finish closing"
    )
    return
  }

  if (page && !page.isClosed()) {
    try {
      await withTimeout(
        Promise.all([
          page.evaluate(() => window.pulseMd.exitLaunchBenchmark()),
          childClosed,
        ]),
        packagedShutdownTimeoutMs,
        "Packaged application did not exit cleanly"
      )
      return
    } catch {
      if (stopped()) {
        await withTimeout(
          childClosed,
          packagedShutdownTimeoutMs,
          "Packaged application did not finish closing"
        )
        return
      }
    }
  }

  child.kill("SIGTERM")
  try {
    await withTimeout(
      childClosed,
      packagedShutdownTimeoutMs,
      "Packaged application did not stop after SIGTERM"
    )
    return
  } catch {
    if (stopped()) {
      await withTimeout(
        childClosed,
        packagedShutdownTimeoutMs,
        "Packaged application did not finish closing after SIGTERM"
      )
      return
    }
  }

  child.kill("SIGKILL")
  await withTimeout(
    childClosed,
    packagedShutdownTimeoutMs,
    "Packaged application did not stop after SIGKILL"
  )
}

async function cleanupPackagedApplication(
  browser: Browser | undefined,
  child: ReturnType<typeof spawn>,
  childClosed: Promise<void>,
  page?: Page
): Promise<void> {
  try {
    await stopPackagedApplication(child, childClosed, page)
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

async function launchTestApplication(
  userData: string,
  filePath: string
): Promise<LaunchedTestApplication> {
  if (!packagedExecutable) {
    const application = await electron.launch(
      launchArguments(userData, filePath)
    )
    return {
      close: () => exitApplication(application),
      page: await application.firstWindow(),
    }
  }

  const child = spawn(
    packagedExecutable,
    [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      "--disable-breakpad",
      filePath,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, PMD_LAUNCH_BENCHMARK: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    }
  )
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", () => resolve())
  })
  let browser: Browser | undefined
  let page: Page | undefined
  try {
    const endpoint = await waitForDevToolsEndpoint(child)
    browser = await withTimeout(
      chromium.connectOverCDP(endpoint),
      packagedLaunchTimeoutMs,
      "Timed out connecting to the packaged renderer"
    )
    const connectedBrowser = browser
    const context = connectedBrowser.contexts()[0]
    if (!context) {
      throw new Error("Packaged application did not create a browser context")
    }
    page =
      context.pages()[0] ??
      (await withTimeout(
        context.waitForEvent("page"),
        packagedLaunchTimeoutMs,
        "Packaged application did not create a renderer page"
      ))
    return {
      close: () =>
        cleanupPackagedApplication(connectedBrowser, child, childClosed, page),
      page,
    }
  } catch (error) {
    await cleanupPackagedApplication(browser, child, childClosed, page)
    throw error
  }
}

test("Markdown extensions remain disabled by default", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-extension-defaults-")
  )
  const filePath = path.join(userData, "extension-defaults.md")
  await writeFile(
    filePath,
    [
      "---",
      "title: Raw front matter",
      "---",
      "",
      "H~2~O, x^2^, and :rocket:.",
      "",
      "Text[^note].",
      "",
      "Term",
      ": Definition",
      "",
      "Inline math $x + y$.",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "<p>Raw HTML</p>",
      "",
      "[^note]: Footnote body.",
    ].join("\n")
  )

  const app = await launchTestApplication(userData, filePath)
  try {
    const { page } = app
    await page.locator(".cm-editor").waitFor()

    await expect(
      page.locator(
        [
          ".cm-md-yaml-frontmatter-line",
          ".cm-md-subscript",
          ".cm-md-superscript",
          ".cm-md-emoji",
          ".cm-md-footnote-reference",
          ".cm-md-definition-term",
          ".cm-md-math",
          ".cm-md-mermaid",
          ".cm-md-html-block",
        ].join(", ")
      )
    ).toHaveCount(0)
    await expect(page.locator(".cm-md-code-block")).toHaveCount(1)

    await page.keyboard.press(settingsShortcut)
    const extensionsSection = page.getByRole("button", { name: "Extensions" })
    await expect(extensionsSection.locator("svg.lucide-blocks")).toHaveCount(1)
    await extensionsSection.click()
    await expect(
      page.getByText("Turn every Markdown extension on or off together.", {
        exact: true,
      })
    ).toHaveCount(0)
    const allExtensions = page.getByRole("switch", {
      name: "All extensions",
    })
    await expect(allExtensions).not.toBeChecked()
    for (const name of extensionSwitchNames) {
      await expect(page.getByRole("switch", { name })).not.toBeChecked()
    }
    await allExtensions.click()
    await expect(allExtensions).toBeChecked()
    for (const name of extensionSwitchNames) {
      await expect(page.getByRole("switch", { name })).toBeChecked()
    }
    await allExtensions.click()
    await expect(allExtensions).not.toBeChecked()
    for (const name of extensionSwitchNames) {
      await expect(page.getByRole("switch", { name })).not.toBeChecked()
    }
  } finally {
    await app.close()
    await rm(userData, { force: true, recursive: true })
  }
})

test("selection activation composes across direct preview schedulers", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-preview-focus-")
  )
  const filePath = path.join(userData, "preview-focus.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions = {
    ...settings.markdownExtensions,
    latex: true,
    mermaid: true,
    sanitizedHtml: true,
  }
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  await writeFile(
    filePath,
    [
      "Math $x + y$.",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "<p>Rendered HTML</p>",
    ].join("\n")
  )

  const app = await launchTestApplication(userData, filePath)
  try {
    const { page } = app
    const diagram = page.locator(".cm-md-mermaid")
    await expect(page.locator(".cm-md-math-inline")).toHaveCount(1)
    await expect(diagram.locator("svg")).toHaveCount(1)
    await expect(page.locator(".cm-md-html-block")).toHaveCount(1)

    await diagram.click()
    await expect(diagram).toHaveCount(0)
    await expect(page.locator(".cm-md-code-block")).toHaveCount(1)
    await expect(page.locator(".cm-editor")).not.toHaveClass(
      /cm-md-caret-hidden/
    )
    await expect(page.locator(".cm-md-math-inline")).toHaveCount(1)
    await expect(page.locator(".cm-md-html-block")).toHaveCount(1)
  } finally {
    await app.close()
    await rm(userData, { force: true, recursive: true })
  }
})

test("sanitized div wrappers do not add blank boundary rows", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-html-div-boundaries-")
  )
  const filePath = path.join(userData, "html-div-boundaries.md")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions = {
    ...settings.markdownExtensions,
    sanitizedHtml: true,
  }
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  await writeFile(
    filePath,
    [
      "Before.",
      "",
      "<div>",
      "  <h3>Sanitized HTML block</h3>",
      "  <p>Static formatting survives.</p>",
      "  <ul>",
      "    <li>List content remains.</li>",
      "  </ul>",
      "</div>",
      "",
      "After.",
    ].join("\n")
  )

  const app = await launchTestApplication(userData, filePath)
  try {
    const { page } = app
    const html = page.locator(".cm-md-html-block")
    await expect(html).toHaveCount(1)
    await expect(html).not.toHaveClass(/cm-md-html-loading/)
    const boundaries = await html.evaluate((element) => {
      const content = element.parentElement
      if (!content?.classList.contains("cm-content")) {
        throw new Error("Sanitized HTML block is outside the editor content")
      }
      const children = [...content.children]
      const blockIndex = children.indexOf(element)
      const emptyLines = (step: -1 | 1) => {
        let count = 0
        for (
          let index = blockIndex + step;
          index >= 0 && index < children.length;
          index += step
        ) {
          const sibling = children[index]!
          if (
            !sibling.classList.contains("cm-line") ||
            sibling.textContent !== ""
          ) {
            break
          }
          count += 1
        }
        return count
      }
      return {
        after: emptyLines(1),
        before: emptyLines(-1),
      }
    })

    expect(boundaries).toEqual({
      after: 1,
      before: 1,
    })

    await html.locator("p").click()
    await expect(html).toHaveCount(0)
    await expect(page.locator(".cm-content")).toBeFocused()
    await expect(page.locator(".cm-content")).toContainText("<div>")
  } finally {
    await app.close()
    await rm(userData, { force: true, recursive: true })
  }
})

test("optional Markdown extensions preview safely and remain settings-controlled", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-extensions-"))
  const filePath = path.join(userData, "extensions.md")
  const settingsPath = path.join(userData, "settings.json")
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.markdownExtensions = {
    definitionLists: true,
    emojiExpansion: true,
    emojiRecognition: true,
    footnotes: true,
    latex: true,
    mermaid: true,
    sanitizedHtml: true,
    superscriptAndSubscript: true,
    yamlFrontMatter: true,
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2))
  await writeFile(
    filePath,
    [
      "---",
      "title: Extension preview",
      "---",
      "",
      "Chemistry H~2~O and power x^2^.",
      "Emoji :rocket:, unknown :definitely_not_an_emoji:, and inherited :constructor:.",
      "A cited statement[^note].",
      "Math $x + y$.",
      "",
      "Term",
      "",
      ": A definition.",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```mermaid",
      "---",
      '"config":',
      "  themeCSS: |",
      "    rect { fill: url(https://example.com/tracker.png) }",
      "---",
      "flowchart TD",
      "  Blocked",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "  Styled",
      "  classDef remote fill:url(https://example.com/tracker.png)",
      "  class Styled remote",
      "```",
      "",
      '<p onclick="window.__unsafeMarkdownHtml = true">Safe <strong>formatting</strong><script>window.__unsafeMarkdownScript = true</script><img src="https://example.com/tracker.png"></p>',
      "",
      "[^note]: Footnote body.",
    ].join("\n")
  )

  const app = await launchTestApplication(userData, filePath)

  try {
    const { page } = app
    await page.locator(".cm-editor").waitFor()

    await expect(page.locator(".cm-md-yaml-frontmatter-line")).toHaveCount(3)
    await expect(page.locator(".cm-md-subscript")).toHaveText("2")
    await expect(page.locator(".cm-md-superscript")).toHaveText("2")
    await expect(
      page.locator('.cm-md-emoji-expanded[data-emoji-alias="rocket"]')
    ).toHaveText("🚀")
    await expect(
      page.locator(
        '.cm-md-emoji-unknown[data-emoji-alias="definitely_not_an_emoji"]'
      )
    ).toHaveText(":definitely_not_an_emoji:")
    await expect(
      page.locator('.cm-md-emoji-unknown[data-emoji-alias="constructor"]')
    ).toHaveText(":constructor:")
    await expect(page.locator(".cm-md-footnote-reference")).toHaveText("1")
    await expect(page.locator(".cm-md-math-inline")).toHaveCount(1)
    await expect(page.locator(".cm-md-definition-term")).toContainText("Term")
    await expect(page.locator(".cm-md-definition-description")).toContainText(
      "A definition."
    )

    const diagram = page
      .locator(".cm-md-mermaid")
      .filter({ has: page.locator("svg") })
    await diagram.scrollIntoViewIfNeeded()
    await expect(diagram.locator("svg")).toHaveCount(1)
    await expect(
      diagram.locator("a, foreignObject, image, script")
    ).toHaveCount(0)
    await expect(diagram.locator("[href], [src], [xlink\\:href]")).toHaveCount(
      0
    )
    await expect(page.locator(".cm-md-code-block")).toHaveCount(0)

    await diagram.click()
    await expect(diagram).toHaveCount(0)
    await expect(page.locator(".cm-md-code-block")).toHaveCount(1)
    await page.locator(".cm-md-definition-term").click()
    await expect(page.locator(".cm-md-mermaid svg")).toHaveCount(1)
    await expect(page.locator(".cm-md-code-block")).toHaveCount(0)

    const blockedDiagram = page.locator(".cm-md-mermaid-error")
    const observedBlockedMessages = new Set<string>()
    await expect
      .poll(async () => {
        for (const message of await blockedDiagram.allTextContents()) {
          observedBlockedMessages.add(message)
        }
        await page.locator(".cm-scroller").evaluate((scroller) => {
          scroller.scrollTop = Math.min(
            scroller.scrollHeight,
            scroller.scrollTop + scroller.clientHeight * 0.6
          )
        })
        return {
          css: [...observedBlockedMessages].some((message) =>
            message.includes("User-defined Mermaid CSS is not rendered")
          ),
          frontMatter: [...observedBlockedMessages].some((message) =>
            message.includes("Only simple title metadata is rendered")
          ),
        }
      })
      .toEqual({ css: true, frontMatter: true })
    await expect(blockedDiagram.locator("svg")).toHaveCount(0)

    const html = page.locator(".cm-md-html-block")
    await expect
      .poll(async () => {
        await page.locator(".cm-scroller").evaluate((scroller) => {
          scroller.scrollTop = scroller.scrollHeight
        })
        return html.count()
      })
      .toBe(1)
    await expect(html.locator("p")).toContainText("Safe formatting")
    await expect(html.locator("[onclick], script, img")).toHaveCount(0)
    expect(
      await page.evaluate(() => ({
        html: Reflect.get(window, "__unsafeMarkdownHtml"),
        script: Reflect.get(window, "__unsafeMarkdownScript"),
      }))
    ).toEqual({ html: undefined, script: undefined })

    await page.keyboard.press(settingsShortcut)
    await page.getByRole("button", { name: "Extensions", exact: true }).click()
    const recognition = page.getByRole("switch", {
      name: "Emoji shortcode recognition",
    })
    const expansion = page.getByRole("switch", {
      name: "Emoji shortcode expansion",
    })
    await expect(recognition).toBeChecked()
    await expect(expansion).toBeChecked()
    await recognition.click()
    await expect(recognition).not.toBeChecked()
    await expect(expansion).not.toBeChecked()
    await expect(expansion).toBeDisabled()
    await expect(page.locator(".cm-md-emoji")).toHaveCount(0)
    await page.getByRole("button", { name: "Cancel" }).click()
    const restoredEmoji = page.locator(
      '.cm-md-emoji-expanded[data-emoji-alias="rocket"]'
    )
    await expect
      .poll(async () => {
        await page
          .locator(".cm-scroller")
          .evaluate((scroller) => (scroller.scrollTop = 0))
        return restoredEmoji.textContent()
      })
      .toBe("🚀")

    await page.keyboard.press(settingsShortcut)
    await page.getByRole("button", { name: "Extensions", exact: true }).click()
    await page.getByRole("switch", { name: "Sanitized HTML" }).click()
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Done" })
      .click()
    await expect(page.locator(".cm-md-html-block")).toHaveCount(0)
    await expect
      .poll(async () => {
        const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
          markdownExtensions?: { sanitizedHtml?: boolean }
        }
        return persisted.markdownExtensions?.sanitizedHtml
      })
      .toBe(false)
  } finally {
    await app.close()
    await rm(userData, { force: true, recursive: true })
  }
})
