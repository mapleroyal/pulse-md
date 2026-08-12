import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import os from "node:os"

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test"

import { exitApplication } from "./electron-helpers"
import { seedScratchStore } from "./scratch-helpers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const cliHelperPath = path.join(
  projectRoot,
  "dist-native",
  process.platform,
  "bin",
  "pmd"
)
const electronExecutablePath = createRequire(import.meta.url)(
  "electron"
) as string

interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

interface RunningCli {
  child: ChildProcessWithoutNullStreams
  result: Promise<CliResult>
}

interface OwnedChild {
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
}

function ownChild(child: ChildProcessWithoutNullStreams): OwnedChild {
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          child.once("close", () => resolve())
        })
  return { child, closed }
}

function waitForChildClose(
  child: OwnedChild,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    child.closed,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Timed out waiting for a CLI child to close")),
        timeoutMs
      )
    }),
  ]).finally(() => clearTimeout(timeout))
}

async function stopOwnedChild(owned: OwnedChild | null): Promise<void> {
  if (!owned) return
  const { child } = owned
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM")
    } catch {
      // The child may have exited between the state check and the signal.
    }
  }
  try {
    await waitForChildClose(owned, 3_000)
    return
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL")
      } catch {
        // Awaiting close below remains the authoritative teardown proof.
      }
    }
  }
  await owned.closed
}

function collectChildResult(
  child: ChildProcessWithoutNullStreams
): Promise<CliResult> {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    })
  })
}

function tabIds(page: Page): Promise<string[]> {
  return page
    .getByRole("tab")
    .evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute("data-tab-id") ?? "")
    )
}

function tabNames(page: Page): Promise<string[]> {
  return page.getByRole("tab").locator(".path-filename-text").allTextContents()
}

function activeTabName(page: Page) {
  return page.locator(".document-tab[data-active] .path-filename-text")
}

test("a headless CLI bootstrap exits when its server cannot start", async () => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "pmd-cli-start-failure-")
  )
  const userDataDirectory = path.join(testRoot, "user-data")
  let ownedChild: OwnedChild | null = null

  try {
    const child = spawn(
      electronExecutablePath,
      [projectRoot, `--user-data-dir=${userDataDirectory}`, "--pmd-cli-server"],
      {
        cwd: projectRoot,
        env: { ...process.env, PMD_CLI_ENDPOINT: "" },
      }
    )
    ownedChild = ownChild(child)
    const result = await collectChildResult(child)
    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain("Unable to start the CLI server")
    expect(result.stderr).toContain("PMD_CLI_ENDPOINT cannot be empty")
  } finally {
    await stopOwnedChild(ownedChild)
    await rm(testRoot, { force: true, recursive: true })
  }
})

test("a failed CLI focus acknowledgement destroys its new window", async () => {
  test.skip(
    process.platform === "win32",
    "The POSIX helper is used by this test"
  )
  await access(cliHelperPath)
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "pmd-cli-focus-failure-")
  )
  const endpoint = path.join(testRoot, "cli.sock")
  const userDataDirectory = path.join(testRoot, "user-data")
  const environment = { ...process.env, PMD_CLI_ENDPOINT: endpoint }
  let app: ElectronApplication | null = null
  let helperChild: OwnedChild | null = null

  try {
    app = await electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${userDataDirectory}`,
        "--pmd-cli-server",
      ],
      cwd: projectRoot,
      env: environment,
    })
    await expect
      .poll(async () => {
        try {
          return (await lstat(endpoint)).isSocket()
        } catch {
          return false
        }
      })
      .toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      new BrowserWindow({ show: false })
    })
    await app.evaluate(({ app }) => {
      app.once("browser-window-created", (_event, win) => {
        const originalSend = win.webContents.send.bind(win.webContents)
        win.webContents.send = ((channel: string, ...args: unknown[]) => {
          if (channel === "pulse-md:cli-editor-focus-requested") {
            const request = args[0] as { requestId: string; tabId: string }
            originalSend(channel, {
              ...request,
              tabId: "not-the-active-tab",
            })
            return
          }
          originalSend(channel, ...args)
        }) as typeof win.webContents.send
      })
    })

    const child = spawn(cliHelperPath, ["--blank", "1"], {
      cwd: testRoot,
      env: environment,
    })
    helperChild = ownChild(child)
    const result = await collectChildResult(child)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      "The editor could not establish keyboard focus"
    )
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1)
  } finally {
    await stopOwnedChild(helperChild)
    if (app) await exitApplication(app)
    await rm(testRoot, { force: true, recursive: true })
  }
})

test("a renderer crash settles an in-flight CLI focus request immediately", async () => {
  test.skip(
    process.platform === "win32",
    "The POSIX helper is used by this test"
  )
  await access(cliHelperPath)
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "pmd-cli-focus-crash-"))
  const endpoint = path.join(testRoot, "cli.sock")
  const userDataDirectory = path.join(testRoot, "user-data")
  const environment = { ...process.env, PMD_CLI_ENDPOINT: endpoint }
  let app: ElectronApplication | null = null
  let helperChild: OwnedChild | null = null

  try {
    app = await electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${userDataDirectory}`,
        "--pmd-cli-server",
      ],
      cwd: projectRoot,
      env: environment,
    })
    await expect
      .poll(async () => {
        try {
          return (await lstat(endpoint)).isSocket()
        } catch {
          return false
        }
      })
      .toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      new BrowserWindow({ show: false })
    })
    await app.evaluate(({ app }) => {
      app.once("browser-window-created", (_event, win) => {
        const originalSend = win.webContents.send.bind(win.webContents)
        win.webContents.send = ((channel: string, ...args: unknown[]) => {
          if (channel === "pulse-md:cli-editor-focus-requested") {
            win.webContents.forcefullyCrashRenderer()
            return
          }
          originalSend(channel, ...args)
        }) as typeof win.webContents.send
      })
    })

    const startedAt = Date.now()
    const child = spawn(cliHelperPath, ["--blank", "1"], {
      cwd: testRoot,
      env: environment,
    })
    helperChild = ownChild(child)
    const result = await collectChildResult(child)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      "The editor could not establish keyboard focus"
    )
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1)
  } finally {
    await stopOwnedChild(helperChild)
    if (app) await exitApplication(app)
    await rm(testRoot, { force: true, recursive: true })
  }
})

test("a renderer crash settles an in-flight CLI tabs-open request immediately", async () => {
  test.skip(
    process.platform === "win32",
    "The POSIX helper is used by this test"
  )
  await access(cliHelperPath)
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "pmd-cli-tabs-crash-"))
  const endpoint = path.join(testRoot, "cli.sock")
  const userDataDirectory = path.join(testRoot, "user-data")
  const environment = { ...process.env, PMD_CLI_ENDPOINT: endpoint }
  let app: ElectronApplication | null = null
  let helperChild: OwnedChild | null = null

  try {
    app = await electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${userDataDirectory}`,
        "--pmd-cli-server",
      ],
      cwd: projectRoot,
      env: environment,
    })
    await expect
      .poll(async () => {
        try {
          return (await lstat(endpoint)).isSocket()
        } catch {
          return false
        }
      })
      .toBe(true)

    const initialChild = spawn(cliHelperPath, ["--blank", "1"], {
      cwd: testRoot,
      env: environment,
    })
    helperChild = ownChild(initialChild)
    expect(await collectChildResult(initialChild)).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    const page = await app.firstWindow()
    await page.locator(".cm-editor").waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) throw new Error("The CLI document window is unavailable")
      const originalSend = win.webContents.send.bind(win.webContents)
      win.webContents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === "pulse-md:cli-tabs-open-requested") {
          win.webContents.forcefullyCrashRenderer()
          return
        }
        originalSend(channel, ...args)
      }) as typeof win.webContents.send
    })

    const startedAt = Date.now()
    const child = spawn(cliHelperPath, ["--reuse-window", "--blank", "1"], {
      cwd: testRoot,
      env: environment,
    })
    helperChild = ownChild(child)
    const result = await collectChildResult(child)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("The target window is busy")
  } finally {
    await stopOwnedChild(helperChild)
    if (app) await exitApplication(app)
    await rm(testRoot, { force: true, recursive: true })
  }
})

async function waitForNewWindow(
  app: ElectronApplication,
  previousWindows: ReadonlySet<Page>
): Promise<Page> {
  await expect
    .poll(
      () => app.windows().filter((page) => !previousWindows.has(page)).length
    )
    .toBe(1)
  const page = app
    .windows()
    .find((candidate) => !previousWindows.has(candidate))
  if (!page) throw new Error("The expected CLI window was not created")
  await page.locator(".cm-editor").waitFor()
  return page
}

test("the CLI profile picker avoids busy hosts and refocuses reused profiles", async () => {
  test.skip(
    process.platform === "win32",
    "The POSIX helper is not used on Windows"
  )
  test.setTimeout(30_000)

  await access(cliHelperPath)
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "pmd-cli-profile-picker-e2e-")
  )
  const endpoint = path.join(testRoot, "cli.sock")
  const userDataDirectory = path.join(testRoot, "user-data")
  const profileDirectory = path.join(userDataDirectory, "cli-profiles")
  const environment = { ...process.env, PMD_CLI_ENDPOINT: endpoint }
  const activeChildren = new Set<OwnedChild>()
  let app: ElectronApplication | null = null

  await mkdir(profileDirectory, { recursive: true })
  await writeFile(
    path.join(profileDirectory, "picker-profile.json"),
    `${JSON.stringify(
      {
        version: 2,
        id: "picker-profile",
        name: "Picker Profile",
        activeTab: "notes",
        tabVisibility: "always",
        tabs: [{ id: "notes", kind: "untitled", title: "Picker Notes" }],
      },
      null,
      2
    )}\n`,
    "utf8"
  )

  const startCli = (arguments_: string[]): RunningCli => {
    const child = spawn(cliHelperPath, arguments_, {
      cwd: testRoot,
      env: environment,
    })
    const ownedChild = ownChild(child)
    activeChildren.add(ownedChild)
    void ownedChild.closed.then(() => activeChildren.delete(ownedChild))
    return { child, result: collectChildResult(child) }
  }

  try {
    app = await electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${userDataDirectory}`,
        "--pmd-cli-server",
      ],
      cwd: projectRoot,
      env: environment,
    })
    await expect
      .poll(async () => {
        try {
          return (await lstat(endpoint)).isSocket()
        } catch {
          return false
        }
      })
      .toBe(true)

    const initialWindows = new Set(app.windows())
    expect(await startCli(["--blank", "1"]).result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    const settingsPage = await waitForNewWindow(app, initialWindows)
    await settingsPage.bringToFront()
    await settingsPage.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    const settings = settingsPage.getByRole("dialog", { name: "Settings" })
    await expect(settings).toBeVisible()

    const windowsBeforeBusyPick = new Set(app.windows())
    const busyPick = startCli(["--profile"])
    const profilePage = await waitForNewWindow(app, windowsBeforeBusyPick)
    const picker = profilePage.getByRole("dialog", {
      name: "Launch Window Profile",
    })
    await expect(picker).toBeVisible()
    expect(await startCli(["profile", "list", "--json"]).result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    await expect(picker).toBeVisible()
    await picker.getByRole("option", { name: /Picker Profile/ }).click()
    expect(await busyPick.result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    await expect(profilePage).toHaveTitle("Picker Notes")
    await expect(profilePage.locator(".cm-content")).toBeFocused()

    const settingsWindowMarker = `settings-window-${process.pid}`
    await settingsPage.evaluate((title) => {
      document.title = title
    }, settingsWindowMarker)
    await app.evaluate(({ BrowserWindow }, title) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === title
      )
      if (!win) throw new Error("The Settings host window was not found")
      win.show()
      win.focus()
    }, settingsWindowMarker)
    await expect
      .poll(() => settingsPage.evaluate(() => document.hasFocus()))
      .toBe(true)
    await settings.getByRole("button", { name: "Cancel" }).click()

    await settingsPage.keyboard.press(
      process.platform === "darwin" ? "Meta+," : "Control+,"
    )
    await expect(settings).toBeVisible()
    await expect
      .poll(() =>
        app!.evaluate(({ Menu }) =>
          Boolean(
            Menu.getApplicationMenu()?.getMenuItemById(
              "file-window-profile-picker"
            )?.enabled
          )
        )
      )
      .toBe(false)
    const windowsBeforeExistingPick = new Set(app.windows())
    const existingPick = startCli(["--profile"])
    const disposablePickerPage = await waitForNewWindow(
      app,
      windowsBeforeExistingPick
    )
    const disposablePicker = disposablePickerPage.getByRole("dialog", {
      name: "Launch Window Profile",
    })
    await expect(disposablePicker).toBeVisible()
    const disposableClosed = disposablePickerPage.waitForEvent("close")
    await disposablePicker
      .getByRole("option", { name: /Picker Profile/ })
      .click()
    expect(await existingPick.result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    await disposableClosed
    expect(app.windows()).toHaveLength(windowsBeforeExistingPick.size)
    await settingsPage.bringToFront()
    await settings.getByRole("button", { name: "Cancel" }).click()

    await profilePage.bringToFront()
    const profileWindowCount = app.windows().length
    const sameProfilePick = startCli(["profile", "open"])
    await expect(picker).toBeVisible()
    await picker.getByRole("option", { name: /Picker Profile/ }).click()
    expect(await sameProfilePick.result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    expect(app.windows()).toHaveLength(profileWindowCount)
    await expect(profilePage.locator(".cm-content")).toBeFocused()

    const cancelledPick = startCli(["--profile"])
    await expect(picker).toBeVisible()
    await profilePage.keyboard.press("Escape")
    expect(await cancelledPick.result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    await expect(picker).toBeHidden()
    await profilePage.bringToFront()

    const disconnectedPick = startCli(["--profile"])
    await expect(picker).toBeVisible()
    expect(disconnectedPick.child.kill("SIGTERM")).toBe(true)
    expect(await disconnectedPick.result).toMatchObject({
      code: 130,
      signal: null,
    })
    await expect(picker).toBeHidden()
    expect(await startCli(["profile", "list"]).result).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
  } finally {
    await Promise.all([...activeChildren].map(stopOwnedChild))
    if (app) await exitApplication(app)
    await rm(testRoot, { force: true, recursive: true })
  }
})

test("the built POSIX helper drives the complete CLI workflow", async () => {
  test.skip(
    process.platform === "win32",
    "The POSIX helper is not used on Windows"
  )
  test.setTimeout(60_000)

  await access(cliHelperPath)
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "pmd-cli-e2e-"))
  const endpoint = path.join(testRoot, "cli.sock")
  const userDataDirectory = path.join(testRoot, "user-data")
  const workingDirectory = path.join(testRoot, "workspace")
  const existingPath = path.join(workingDirectory, "existing.md")
  const deferredPath = path.join(workingDirectory, "deferred.md")
  const missingPath = path.join(workingDirectory, "missing.md")
  const reusedPath = path.join(workingDirectory, "reused.md")
  const profileDocumentPath = path.join(workingDirectory, "profile.md")
  const profilePath = path.join(workingDirectory, "cli-profile.json")
  const profileScratchId = "10000000-0000-4000-8000-000000000101"
  const unnamedScratchId = "10000000-0000-4000-8000-000000000102"
  const environment = { ...process.env, PMD_CLI_ENDPOINT: endpoint }
  const activeChildren = new Set<OwnedChild>()
  let app: ElectronApplication | null = null

  await mkdir(workingDirectory, { recursive: true })
  await writeFile(existingPath, "first line\nsecond line\nthird line\n", {
    encoding: "utf8",
    flag: "wx",
  })
  await writeFile(
    deferredPath,
    `Deferred old bytes\n${"x".repeat(8 * 1024 * 1024)}`
  )
  await writeFile(profileDocumentPath, "# Profile file\n", "utf8")
  await writeFile(
    profilePath,
    `${JSON.stringify(
      {
        version: 2,
        id: "cli-profile",
        name: "CLI Profile",
        activeTab: "profile-scratch",
        tabVisibility: "always",
        mode: "source",
        tabs: [
          {
            id: "profile-file",
            kind: "file",
            path: "profile.md",
            title: "Profile File",
            color: "blue",
            mode: "live",
          },
          {
            id: "profile-scratch",
            kind: "scratch",
            scratchId: profileScratchId,
            title: "Profile Scratch",
            color: "orange",
          },
          {
            id: "unnamed-scratch",
            kind: "scratch",
            scratchId: unnamedScratchId,
          },
        ],
      },
      null,
      2
    )}\n`,
    "utf8"
  )

  const startCli = (
    arguments_: string[],
    options: { input?: string } = {}
  ): RunningCli => {
    const child = spawn(cliHelperPath, arguments_, {
      cwd: workingDirectory,
      env: environment,
    })
    const ownedChild = ownChild(child)
    activeChildren.add(ownedChild)
    void ownedChild.closed.then(() => activeChildren.delete(ownedChild))
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    const result = new Promise<CliResult>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => {
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        })
      })
    })
    child.stdin.end(options.input)
    return { child, result }
  }

  const runCli = async (
    arguments_: string[],
    options: { input?: string } = {}
  ) => startCli(arguments_, options).result

  try {
    app = await electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${userDataDirectory}`,
        "--pmd-cli-server",
      ],
      cwd: projectRoot,
      env: environment,
    })
    await expect
      .poll(async () => {
        try {
          return (await lstat(endpoint)).isSocket()
        } catch {
          return false
        }
      })
      .toBe(true)

    const initialWindows = new Set(app.windows())
    const initialOpen = await runCli([
      "open",
      existingPath,
      deferredPath,
      missingPath,
      "--blank",
      "1",
      "--ephemeral",
      "1",
      "--scratch",
      "cli-notes",
      "--active",
      "1",
      "--goto",
      "3:2",
      "--mode",
      "live",
      "--tab-mode",
      "1:source",
      "--tabs",
      "always",
    ])
    expect(initialOpen).toMatchObject({ code: 0, signal: null, stderr: "" })
    const initialPage = await waitForNewWindow(app, initialWindows)
    await expect(initialPage.getByRole("tab")).toHaveCount(6)
    expect(await tabNames(initialPage)).toEqual([
      "existing.md",
      "deferred.md",
      "missing.md",
      "Untitled",
      "Untitled",
      "cli-notes",
    ])
    await expect(activeTabName(initialPage)).toHaveText("existing.md")
    await expect(initialPage.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(
      initialPage.getByRole("tablist", { name: "Open documents" })
    ).toBeVisible()
    await expect(
      initialPage.getByRole("tablist", { name: "Open documents" })
    ).toHaveAttribute("data-visible", "true")
    await expect(initialPage.getByLabel("Document status")).toContainText(
      "Ln 3, Col 2"
    )
    await expect(initialPage.locator(".cm-content")).toBeFocused()
    expect(await initialPage.evaluate(() => document.hasFocus())).toBe(true)
    await initialPage.keyboard.insertText("!")
    await expect(initialPage.locator(".cm-content")).toContainText("t!hird")
    await initialPage.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z"
    )
    await expect(initialPage.locator(".cm-content")).toContainText("third")
    await expect(access(missingPath)).rejects.toMatchObject({ code: "ENOENT" })

    const help = await runCli(["--help"])
    expect(help).toMatchObject({ code: 0, signal: null, stderr: "" })
    expect(help.stdout).toContain(
      "--mouse-monitor       Place a new window on the pointer's monitor"
    )
    expect(app.windows()).toHaveLength(initialWindows.size + 1)

    await writeFile(deferredPath, "Deferred current bytes\n", "utf8")
    await initialPage.getByRole("tab").nth(1).click()
    await expect(initialPage.locator(".cm-content")).toContainText(
      "Deferred current bytes"
    )
    await expect(initialPage.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await initialPage.getByRole("tab").nth(2).click()
    await expect(initialPage.locator(".cm-content")).toHaveText("")
    await initialPage.getByRole("tab").nth(0).click()
    await expect(initialPage.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(initialPage.getByLabel("Document status")).toContainText(
      "Ln 3, Col 2"
    )

    const strictError = await runCli(["--definitely-not-a-real-option"])
    expect(strictError).toEqual({
      code: 2,
      signal: null,
      stdout: "",
      stderr:
        "pmd-dev: Unknown option: --definitely-not-a-real-option\n" +
        "Try 'pmd-dev --help' for usage.\n",
    })

    const scratchWindowCount = app.windows().length
    const scratchFocus = await runCli(["scratch", "open", "cli-notes"])
    expect(scratchFocus).toMatchObject({ code: 0, signal: null, stderr: "" })
    expect(app.windows()).toHaveLength(scratchWindowCount)
    await expect(initialPage.getByRole("tab")).toHaveCount(6)
    await expect(activeTabName(initialPage)).toHaveText("cli-notes")
    await expect(initialPage.locator(".cm-content")).toBeFocused()
    expect(await initialPage.evaluate(() => document.hasFocus())).toBe(true)

    const beforeScratchTransferWindows = new Set(app.windows())
    const scratchTargetOpened = await runCli([
      "open",
      "--mouse-monitor",
      "--blank",
      "1",
      "--tabs",
      "always",
    ])
    expect(scratchTargetOpened).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    const scratchTarget = await waitForNewWindow(
      app,
      beforeScratchTransferWindows
    )
    expect(await runCli(["scratch", "open", "cli-notes"])).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })

    await initialPage.keyboard.insertText("# Managed scratch\n")
    await expect(
      initialPage.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAccessibleName(/modified/i)

    const scratchTabId = await initialPage
      .getByRole("tab", { name: /cli-notes/ })
      .getAttribute("data-tab-id")
    if (!scratchTabId) throw new Error("Scratch tab id is unavailable")
    const scratchDragToken = await initialPage.evaluate(
      (tabId) => window.pulseMd.beginTabDrag(tabId),
      scratchTabId
    )
    await scratchTarget.evaluate((token) => {
      const header = document.querySelector<HTMLElement>(".top-chrome")
      const tab = header?.querySelector<HTMLElement>(".document-tab")
      if (!header || !tab) throw new Error("Target tab strip is unavailable")
      const dataTransfer = new DataTransfer()
      dataTransfer.effectAllowed = "move"
      dataTransfer.setData("application/x-pulse-md-tab", token)
      for (const type of ["dragenter", "dragover", "drop"]) {
        header.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: tab.getBoundingClientRect().right + 1,
            clientY: 20,
            dataTransfer,
          })
        )
      }
    }, scratchDragToken)
    await expect(
      initialPage.getByRole("tab", { name: /cli-notes/ })
    ).toHaveCount(0)
    await expect(activeTabName(scratchTarget)).toHaveText("cli-notes")
    await expect(
      scratchTarget.locator('.document-tab[data-active] [role="tab"]')
    ).not.toHaveAccessibleName(/modified/i)

    const managementWindowCount = app.windows().length
    expect(await runCli(["scratch", "list"])).toEqual({
      code: 0,
      signal: null,
      stdout: "cli-notes\n",
      stderr: "",
    })
    expect(
      JSON.parse((await runCli(["scratch", "list", "--json"])).stdout)
    ).toEqual([{ id: "cli-notes", open: true, scratchId: expect.any(String) }])
    const openExport = await runCli(["scratch", "export", "cli-notes"])
    expect(openExport).toEqual({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "pmd-dev: Close scratch document cli-notes before exporting it\n",
    })
    expect(app.windows()).toHaveLength(managementWindowCount)

    const scratchTab = scratchTarget.getByRole("tab", { name: /cli-notes/ })
    await scratchTarget
      .getByRole("button", { name: "Close cli-notes", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(scratchTab).toHaveCount(0)
    expect(
      JSON.parse((await runCli(["scratch", "list", "--json"])).stdout)
    ).toEqual([{ id: "cli-notes", open: false, scratchId: expect.any(String) }])

    expect(await runCli(["scratch", "export", "cli-notes"])).toEqual({
      code: 0,
      signal: null,
      stdout: "# Managed scratch\n",
      stderr: "",
    })
    const scratchExportPath = path.join(workingDirectory, "scratch-export.md")
    expect(
      await runCli(["scratch", "export", "cli-notes", scratchExportPath])
    ).toEqual({
      code: 0,
      signal: null,
      stdout: `Exported scratch document cli-notes to ${scratchExportPath}.\n`,
      stderr: "",
    })
    expect(await readFile(scratchExportPath, "utf8")).toBe(
      "# Managed scratch\n"
    )
    expect(
      await runCli(["scratch", "export", "cli-notes", scratchExportPath])
    ).toMatchObject({
      code: 1,
      signal: null,
      stdout: "",
      stderr: expect.stringContaining("Refusing to overwrite"),
    })
    expect(await runCli(["scratch", "delete", "cli-notes"])).toEqual({
      code: 0,
      signal: null,
      stdout: "Deleted scratch document cli-notes.\n",
      stderr: "",
    })
    expect(await runCli(["scratch", "list"])).toEqual({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    })
    expect(app.windows()).toHaveLength(managementWindowCount)

    const beforeStdinWindows = new Set(app.windows())
    const stdinResult = await runCli(
      [
        "open",
        "-",
        "--stdin-name",
        "piped.md",
        "--mode",
        "source",
        "--tabs",
        "always",
      ],
      { input: "# Piped input\n\nterminal body\n" }
    )
    expect(stdinResult).toMatchObject({ code: 0, signal: null, stderr: "" })
    const stdinPage = await waitForNewWindow(app, beforeStdinWindows)
    await expect(activeTabName(stdinPage)).toHaveText("piped.md")
    await expect(stdinPage.locator(".cm-content")).toContainText(
      "terminal body"
    )
    await expect(
      stdinPage.locator('.document-tab[data-active] [role="tab"]')
    ).toHaveAccessibleName(/modified/i)
    await expect(stdinPage.locator(".cm-content")).toBeFocused()

    const reuseWindowCount = app.windows().length
    const reuseResult = await runCli([
      "--reuse-window",
      reusedPath,
      "--ephemeral",
      "1",
      "--mode",
      "live",
      "--tab-mode",
      "2:source",
      "--tabs",
      "always",
    ])
    expect(reuseResult).toMatchObject({ code: 0, signal: null, stderr: "" })
    expect(app.windows()).toHaveLength(reuseWindowCount)
    await expect(stdinPage.getByRole("tab")).toHaveCount(3)
    expect(await tabNames(stdinPage)).toEqual([
      "piped.md",
      "reused.md",
      "Untitled",
    ])
    await expect(activeTabName(stdinPage)).toHaveText("reused.md")
    await expect(stdinPage.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await expect(stdinPage.locator(".cm-content")).toBeFocused()
    await expect(access(reusedPath)).rejects.toMatchObject({ code: "ENOENT" })

    await stdinPage.getByRole("tab").nth(2).click()
    await expect(stdinPage.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await stdinPage.getByRole("tab").nth(1).click()
    await expect(stdinPage.locator(".cm-editor")).toHaveClass(/cm-md-live/)

    const idsBeforeWait = new Set(await tabIds(stdinPage))
    const waitingCli = startCli([
      "--reuse-window",
      "--ephemeral",
      "2",
      "--tabs",
      "always",
      "--wait",
    ])
    await expect(stdinPage.getByRole("tab")).toHaveCount(idsBeforeWait.size + 2)
    const waitedTabIds = (await tabIds(stdinPage)).filter(
      (tabId) => !idsBeforeWait.has(tabId)
    )
    expect(waitedTabIds).toHaveLength(2)
    let waitSettled = false
    void waitingCli.result.then(
      () => {
        waitSettled = true
      },
      () => {
        waitSettled = true
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(waitSettled).toBe(false)

    await stdinPage
      .locator(`[data-tab-id="${waitedTabIds[0]}"] .tab-close`)
      .evaluate((button: HTMLButtonElement) => button.click())
    await expect(
      stdinPage.locator(`[data-tab-id="${waitedTabIds[0]}"]`)
    ).toHaveCount(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(waitSettled).toBe(false)

    await stdinPage
      .locator(`[data-tab-id="${waitedTabIds[1]}"] .tab-close`)
      .evaluate((button: HTMLButtonElement) => button.click())
    expect(await waitingCli.result).toEqual({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    })
    await expect(stdinPage.getByRole("tab")).toHaveCount(idsBeforeWait.size)

    await seedScratchStore(userDataDirectory, [
      {
        content: "# Profile scratch\n",
        createdAt: 1_725_000_000_000,
        fileName: "profile-scratch.md",
        id: profileScratchId,
        lastOpenedAt: null,
      },
      {
        content: "",
        createdAt: 1_725_000_000_001,
        fileName: "unnamed-scratch.md",
        id: unnamedScratchId,
        lastOpenedAt: null,
      },
    ])
    const imported = await runCli(["profile", "import", profilePath])
    expect(imported).toEqual({
      code: 0,
      signal: null,
      stdout: "Imported profile cli-profile (CLI Profile).\n",
      stderr: "",
    })
    const beforeProfileWindows = new Set(app.windows())
    const profileOpened = await runCli(["profile", "open", "cli-profile"])
    expect(profileOpened).toMatchObject({ code: 0, signal: null, stderr: "" })
    const profilePage = await waitForNewWindow(app, beforeProfileWindows)
    expect(await tabNames(profilePage)).toEqual([
      "Profile File",
      "Profile Scratch",
      "unnamed-scratch",
    ])
    const profileTabSurfaces = profilePage.locator(".document-tab")
    await expect(profileTabSurfaces.nth(0)).toHaveAttribute(
      "data-tab-color",
      "blue"
    )
    await expect(profileTabSurfaces.nth(1)).toHaveAttribute(
      "data-tab-color",
      "orange"
    )
    await expect(
      profileTabSurfaces.nth(0).locator(".tab-color-mark svg")
    ).toHaveCount(1)
    await expect(
      profileTabSurfaces.nth(1).locator(".tab-color-mark svg")
    ).toHaveCount(1)
    await expect(profileTabSurfaces.nth(2)).not.toHaveAttribute(
      "data-tab-color"
    )
    await expect(
      profileTabSurfaces.nth(2).locator(".tab-color-mark")
    ).toHaveCount(0)
    await expect(activeTabName(profilePage)).toHaveText("Profile Scratch")
    await expect(profilePage.locator(".cm-editor")).toHaveClass(/cm-md-source/)
    await expect(profilePage.locator(".cm-content")).toBeFocused()

    await profilePage.getByRole("tab").nth(0).click()
    await expect(profilePage.locator(".cm-editor")).toHaveClass(/cm-md-live/)
    await profilePage.getByRole("tab").nth(1).click()
    await expect(profilePage.locator(".cm-editor")).toHaveClass(/cm-md-source/)

    const profileWindowCount = app.windows().length
    await stdinPage.bringToFront()
    const profileFocusedAgain = await runCli(["profile", "open", "cli-profile"])
    expect(profileFocusedAgain).toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    })
    expect(app.windows()).toHaveLength(profileWindowCount)
    await expect(profilePage.locator(".cm-content")).toBeFocused()
    expect(await profilePage.evaluate(() => document.hasFocus())).toBe(true)
  } finally {
    await Promise.all([...activeChildren].map(stopOwnedChild))
    if (app) await exitApplication(app)
    await rm(testRoot, { force: true, recursive: true })
  }
})
