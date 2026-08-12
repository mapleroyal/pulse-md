import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import afterExtract from "./after-extract.mjs"

for (const electronPlatformName of ["darwin", "win32"]) {
  test(`copies complete Electron notices into ${electronPlatformName} resources`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pulse-md-licenses-"))
    t.after(() => rm(root, { force: true, recursive: true }))

    const projectDir = path.join(root, "project")
    const appOutDir = path.join(root, "app")
    const electronRoot = path.join(projectDir, "node_modules", "electron")
    const resources =
      electronPlatformName === "darwin"
        ? path.join(appOutDir, "Electron.app", "Contents", "Resources")
        : path.join(appOutDir, "resources")
    await mkdir(electronRoot, { recursive: true })
    await mkdir(resources, { recursive: true })
    await writeFile(path.join(electronRoot, "LICENSE"), "electron license\n")
    await writeFile(
      path.join(appOutDir, "LICENSES.chromium.html"),
      "<p>Chromium credits</p>\n"
    )

    await afterExtract({
      appOutDir,
      electronPlatformName,
      packager: {
        info: { framework: { distMacOsAppName: "Electron.app" } },
        projectDir,
      },
    })

    const destination = path.join(resources, "licenses", "electron")
    assert.equal(
      await readFile(path.join(destination, "LICENSE.electron.txt"), "utf8"),
      "electron license\n"
    )
    assert.equal(
      await readFile(path.join(destination, "LICENSES.chromium.html"), "utf8"),
      "<p>Chromium credits</p>\n"
    )
  })
}
