import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test"

import { ScratchStore } from "../../electron/scratch-store"
import { DEFAULT_APP_SETTINGS } from "../../src/shared/contracts"
import { exitApplication } from "./electron-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)

async function seedDefaultProfileSettings(userData: string, profileId: string) {
  await new ScratchStore(userData).markLegacyMigrationComplete()
  await writeFile(
    path.join(userData, "settings.json"),
    `${JSON.stringify(
      { ...DEFAULT_APP_SETTINGS, defaultWindowProfileId: profileId },
      null,
      2
    )}\n`,
    "utf8"
  )
}

async function openAdditionalWindow(app: ElectronApplication) {
  const existingWindows = new Set(app.windows())
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((candidate) => candidate.label === "File")
      ?.submenu?.items.find((candidate) => candidate.label === "New Window")
    const window = BrowserWindow.getFocusedWindow()
    if (!item || !window) throw new Error("New Window is unavailable")
    item.click(undefined, window, window.webContents)
  })
  await expect.poll(() => app.windows().length).toBe(existingWindows.size + 1)
  const created = app
    .windows()
    .find((candidate) => !existingWindows.has(candidate))
  if (!created) throw new Error("The additional window was not created")
  await created.locator(".cm-editor").waitFor()
  return created
}

test("a transient default-profile read failure preserves the preference for recovery", async () => {
  test.skip(
    process.platform === "win32",
    "POSIX file permissions provide the transient read failure"
  )
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-default-profile-transient-e2e-")
  )
  const profileId = "recoverable-default"
  const profileDirectory = path.join(userData, "cli-profiles")
  const profilePath = path.join(profileDirectory, `${profileId}.json`)
  await seedDefaultProfileSettings(userData, profileId)
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    profilePath,
    `${JSON.stringify(
      {
        version: 2,
        id: profileId,
        name: "Recoverable Default",
        activeTab: "document",
        tabVisibility: "always",
        tabs: [
          {
            id: "document",
            kind: "untitled",
            title: "Recovered Profile",
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  await chmod(profilePath, 0o000)
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const firstWindow = await app.firstWindow()
    await firstWindow.locator(".cm-editor").waitFor()
    await expect(firstWindow).toHaveTitle("Untitled")
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { defaultWindowProfileId?: string | null }
        return persisted.defaultWindowProfileId
      })
      .toBe(profileId)

    await chmod(profilePath, 0o600)
    const recoveredWindow = await openAdditionalWindow(app)
    await expect(recoveredWindow).toHaveTitle("Recovered Profile")
  } finally {
    await chmod(profilePath, 0o600).catch(() => undefined)
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})

test("a confirmed missing default profile clears the preference", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "pulse-md-default-profile-missing-e2e-")
  )
  await seedDefaultProfileSettings(userData, "missing-default")
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userData}`],
    cwd: projectRoot,
  })

  try {
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await expect(page).toHaveTitle("Untitled")
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(path.join(userData, "settings.json"), "utf8")
        ) as { defaultWindowProfileId?: string | null }
        return persisted.defaultWindowProfileId
      })
      .toBeNull()
  } finally {
    await exitApplication(app)
    await rm(userData, { force: true, recursive: true })
  }
})
