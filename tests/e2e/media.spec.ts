import path from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"

import { _electron as electron, expect, test } from "@playwright/test"

import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

test("remote images wait for trusted document interaction", async () => {
  let requestCount = 0
  const server = createServer((request, response) => {
    if (request.url !== "/tracking.png") {
      response.writeHead(404).end()
      return
    }
    requestCount += 1
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "image/png",
    })
    response.end(pixel)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-media-e2e-"))
  const documentPath = path.join(userData, "remote-on-intent.md")
  const { port } = server.address() as AddressInfo
  await writeFile(
    documentPath,
    `![Remote](http://127.0.0.1:${port}/tracking.png)\n`
  )
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const editor = page.locator(".cm-editor")
    await editor.waitFor()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            performance.getEntriesByName("pmd:launch-transition-settled").length
        )
      )
      .toBeGreaterThan(0)
    await page.waitForTimeout(250)
    expect(requestCount).toBe(0)

    await page.locator(".cm-content").click()
    await expect.poll(() => requestCount).toBe(1)
    await expect(page.locator(".cm-md-image")).toHaveJSProperty(
      "naturalWidth",
      1
    )
  } finally {
    await exitApplication(app)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    await rm(userData, { force: true, recursive: true })
  }
})

test("live preview loads document-relative, absolute, file, and web images", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-media-e2e-"))
  const imagePath = path.join(userData, "pixel image.png")
  const documentPath = path.join(userData, "media.md")
  await writeFile(imagePath, pixel)

  await writeFile(
    documentPath,
    [
      "![Relative](./pixel%20image.png)",
      `![Absolute](${imagePath.replace(/ /g, "%20")})`,
      `![File URL](${pathToFileURL(imagePath).href})`,
    ].join("\n\n")
  )

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`, documentPath],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.route("https://images.example.test/pixel.png", (route) =>
      route.fulfill({ body: pixel, contentType: "image/png" })
    )
    await page.locator(".cm-content").focus()
    const modifier = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Alt+V"
    )
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.insertText(
      "![*Web* &amp;](https://images.example.test/pixel.png)"
    )
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+V" : "Control+Alt+V"
    )
    await page.keyboard.press(`${modifier}+,`)
    const images = page.locator(".cm-md-image")
    await expect(images).toHaveCount(4)
    await expect
      .poll(() =>
        images.evaluateAll((elements) =>
          elements.every(
            (element) =>
              element instanceof HTMLImageElement &&
              element.complete &&
              element.naturalWidth === 1 &&
              element.naturalHeight === 1
          )
        )
      )
      .toBe(true)

    const sources = await images.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLImageElement).src)
    )
    expect(
      sources.filter((source) => source.startsWith("pulse-md-image:"))
    ).toHaveLength(3)
    expect(sources.at(-1)).toBe("https://images.example.test/pixel.png")
    await expect(images.last()).toHaveAttribute("alt", "Web &")
    await page.unrouteAll({ behavior: "ignoreErrors" })
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("switching file tabs resolves relative images with the incoming document path", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "pulse-md-media-tabs-"))
  const firstDirectory = path.join(userData, "first")
  const secondDirectory = path.join(userData, "second")
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])
  await Promise.all([
    writeFile(path.join(firstDirectory, "pixel.png"), pixel),
    writeFile(path.join(secondDirectory, "pixel.png"), pixel),
  ])
  const firstDocument = path.join(firstDirectory, "first.md")
  const secondDocument = path.join(secondDirectory, "second.md")
  await Promise.all([
    writeFile(firstDocument, "First document.\n\n![First](pixel.png)"),
    writeFile(secondDocument, "Second document.\n\n![Second](pixel.png)"),
  ])

  const app = await electron.launch({
    args: [
      projectRoot,
      `--user-data-dir=${userData}`,
      firstDocument,
      secondDocument,
    ],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    const tabs = page.getByRole("tab")
    const image = page.locator(".cm-md-image")
    await expect(tabs).toHaveCount(2)
    await expect(image).toHaveCount(1)
    await expect
      .poll(() =>
        image.evaluate(
          (element) =>
            element instanceof HTMLImageElement &&
            element.complete &&
            element.naturalWidth === 1
        )
      )
      .toBe(true)

    await app.evaluate(({ session }) => {
      const testGlobal = globalThis as typeof globalThis & {
        markdownImageRequests?: string[]
      }
      testGlobal.markdownImageRequests = []
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith("pulse-md-image:")) {
          testGlobal.markdownImageRequests?.push(details.url)
        }
        callback({})
      })
    })

    const firstTab = tabs.filter({ hasText: "first.md" })
    const secondTab = tabs.filter({ hasText: "second.md" })
    const firstIsActive =
      (await firstTab.getAttribute("aria-selected")) === "true"
    const incomingTab = firstIsActive ? secondTab : firstTab
    const incomingImagePath = firstIsActive
      ? path.join(secondDirectory, "pixel.png")
      : path.join(firstDirectory, "pixel.png")
    const incomingUrl = `pulse-md-image://local/${encodeURIComponent(
      incomingImagePath.replace(/\\/g, "/")
    )}`

    await incomingTab.click()
    await expect(image).toHaveAttribute("src", incomingUrl)
    await expect(image).toHaveJSProperty("naturalWidth", 1)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                markdownImageRequests?: string[]
              }
            ).markdownImageRequests ?? []
        )
      )
      .toContain(incomingUrl)
    expect(
      await app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              markdownImageRequests?: string[]
            }
          ).markdownImageRequests ?? []
      )
    ).toEqual([incomingUrl])
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
