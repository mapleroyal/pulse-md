import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"

import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
  expect,
  test,
} from "@playwright/test"

import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../../src/shared/contracts"
import { windowsWindowBlurSupported } from "../../electron/window-chrome"
import { exitApplication } from "./electron-helpers"

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, "../..")
const packagedExecutable = process.env.PMD_E2E_EXECUTABLE?.trim() || null
const packagedLaunchTimeoutMs = 15_000
const packagedShutdownTimeoutMs = 3_000

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

function waitForPackagedDevToolsEndpoint(
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

async function focusWindowsWindow(
  processId: number,
  title: string
): Promise<void> {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PulseMdE2EWindowFocus {
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

  [StructLayout(LayoutKind.Sequential)]
  private struct Point { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")]
  private static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  private static extern bool GetCursorPos(out Point point);
  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")]
  private static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
  private static extern uint GetWindowThread(IntPtr window, IntPtr processId);
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
  private static extern uint GetWindowThreadAndProcess(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool IsChild(IntPtr parent, IntPtr window);
  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")]
  private static extern IntPtr SetActiveWindow(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  private static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")]
  private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")]
  private static extern IntPtr WindowFromPoint(Point point);

  private static IntPtr FindWindow(uint expectedProcessId, string expectedTitle) {
    IntPtr match = IntPtr.Zero;
    EnumWindows((window, parameter) => {
      uint processId;
      GetWindowThreadAndProcess(window, out processId);
      if (processId != expectedProcessId || !IsWindowVisible(window)) return true;
      int length = GetWindowTextLength(window);
      StringBuilder title = new StringBuilder(length + 1);
      GetWindowText(window, title, title.Capacity);
      if (!String.Equals(title.ToString(), expectedTitle, StringComparison.Ordinal)) return true;
      match = window;
      return false;
    }, IntPtr.Zero);
    return match;
  }

  public static bool Focus(uint processId, string title) {
    IntPtr target = IntPtr.Zero;
    for (int attempt = 0; attempt < 100 && target == IntPtr.Zero; attempt++) {
      target = FindWindow(processId, title);
      if (target == IntPtr.Zero) Thread.Sleep(50);
    }
    if (target == IntPtr.Zero) return false;

    ShowWindowAsync(target, 9);
    SetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);

    uint currentThread = GetCurrentThreadId();
    uint targetThread = GetWindowThread(target, IntPtr.Zero);
    uint foregroundThread = GetWindowThread(GetForegroundWindow(), IntPtr.Zero);
    bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    bool attachedTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);
    try {
      BringWindowToTop(target);
      SetActiveWindow(target);
      SetFocus(target);
      SetForegroundWindow(target);
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
    if (GetForegroundWindow() == target) return true;

    Rect bounds;
    Point previous;
    if (!GetWindowRect(target, out bounds) || !GetCursorPos(out previous)) return false;
    int x = bounds.Left + Math.Max(1, (bounds.Right - bounds.Left) / 2);
    int y = bounds.Top + Math.Max(1, (bounds.Bottom - bounds.Top) / 2);
    Point clickPoint = new Point { X = x, Y = y };
    IntPtr hitWindow = WindowFromPoint(clickPoint);
    if (hitWindow != target && !IsChild(target, hitWindow)) return false;
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    SetCursorPos(previous.X, previous.Y);
    Thread.Sleep(100);
    return GetForegroundWindow() == target;
  }
}
'@
$pulseProcessId = [uint32][Environment]::GetEnvironmentVariable('PMD_FOCUS_PROCESS_ID')
$pulseWindowTitle = [Environment]::GetEnvironmentVariable('PMD_FOCUS_WINDOW_TITLE')
if (-not [PulseMdE2EWindowFocus]::Focus($pulseProcessId, $pulseWindowTitle)) {
  throw "Unable to focus Pulse MD window '$pulseWindowTitle'"
}
`
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
    {
      env: {
        ...process.env,
        PMD_FOCUS_PROCESS_ID: String(processId),
        PMD_FOCUS_WINDOW_TITLE: title,
      },
      windowsHide: true,
    }
  )
}

interface PackagedRendererApplication {
  close(): Promise<void>
  page: Page
  processId: number
}

async function launchPackagedRenderer(
  executable: string,
  userData: string
): Promise<PackagedRendererApplication> {
  const child = spawn(
    executable,
    [
      `--user-data-dir=${userData}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--disable-breakpad",
    ],
    {
      cwd: path.dirname(executable),
      env: { ...process.env, PMD_LAUNCH_BENCHMARK: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    }
  )
  const processId = child.pid
  if (processId === undefined) {
    child.kill()
    throw new Error("The packaged application did not start")
  }
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", () => resolve())
  })
  let browser: Browser | undefined
  let page: Page | undefined

  const close = async () => {
    try {
      await stopPackagedApplication(child, childClosed, page)
    } finally {
      await browser?.close().catch(() => undefined)
    }
  }

  try {
    const endpoint = await waitForPackagedDevToolsEndpoint(child)
    browser = await withTimeout(
      chromium.connectOverCDP(endpoint),
      packagedLaunchTimeoutMs,
      "Timed out connecting to the packaged renderer"
    )
    const context = browser.contexts()[0]
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
    return { close, page, processId }
  } catch (error) {
    await close()
    throw error
  }
}

function nativeBackgroundEffectsSupported(): boolean {
  return (
    process.platform === "darwin" ||
    windowsWindowBlurSupported(process.platform, os.release())
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
    throw new Error("Native compositor capture is not a BMP")
  }

  const pixelOffset = image.readUInt32LE(10)
  const width = image.readInt32LE(18)
  const rawHeight = image.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0
  const bitsPerPixel = image.readUInt16LE(28)
  if (width <= 0 || height <= 0 || bitsPerPixel !== 32) {
    throw new Error("Native compositor capture has an unsupported layout")
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

async function captureWindowsRegion(
  filePath: string,
  bounds: { height: number; width: number; x: number; y: number },
  scaleFactor: number
): Promise<void> {
  const physical = {
    height: Math.round(bounds.height * scaleFactor),
    width: Math.round(bounds.width * scaleFactor),
    x: Math.round(bounds.x * scaleFactor),
    y: Math.round(bounds.y * scaleFactor),
  }
  const escapedPath = filePath.replaceAll("'", "''")
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PulseMdCaptureDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[PulseMdCaptureDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(${physical.width}, ${physical.height}, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen(${physical.x}, ${physical.y}, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ])
}

interface WindowsStripedBackdrop {
  close(): Promise<void>
  processId: number
}

async function launchWindowsStripedBackdrop(): Promise<WindowsStripedBackdrop> {
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PulseMdBackdropDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[PulseMdBackdropDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$form = [System.Windows.Forms.Form]::new()
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 102)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Tag = 24
$form.Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$form.Add_Paint({
  param($sender, $eventArgs)
  $stripe = [int]$sender.Tag
  $magenta = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 0, 102))
  $cyan = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(0, 204, 255))
  try {
    for ($x = 0; $x -lt $sender.ClientSize.Width; $x += $stripe * 2) {
      $eventArgs.Graphics.FillRectangle($magenta, $x, 0, $stripe, $sender.ClientSize.Height)
      $eventArgs.Graphics.FillRectangle($cyan, $x + $stripe, 0, $stripe, $sender.ClientSize.Height)
    }
  } finally {
    $magenta.Dispose()
    $cyan.Dispose()
  }
})
$form.Show()
$form.Refresh()
[Console]::Out.WriteLine('PMD_BACKDROP_READY')
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  )
  if (child.pid === undefined || !child.stdout || !child.stderr) {
    child.kill()
    throw new Error("The Windows compositor backdrop did not start")
  }
  const processId = child.pid
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", () => resolve())
  })
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      const cleanup = () => {
        child.stdout?.off("data", onStdout)
        child.stderr?.off("data", onStderr)
        child.off("error", onError)
        child.off("exit", onExit)
      }
      const onStdout = (chunk: Buffer | string) => {
        stdout += chunk.toString()
        if (!stdout.includes("PMD_BACKDROP_READY")) return
        cleanup()
        resolve()
      }
      const onStderr = (chunk: Buffer | string) => {
        stderr += chunk.toString()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(
          new Error("Unable to launch the Windows compositor backdrop", {
            cause: error,
          })
        )
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        reject(
          new Error(
            `Windows compositor backdrop exited before it was ready (${signal ?? code})${stderr ? `:\n${stderr}` : ""}`
          )
        )
      }
      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.once("error", onError)
      child.once("exit", onExit)
    }),
    5_000,
    "Timed out waiting for the Windows compositor backdrop"
  ).catch(async (error) => {
    child.kill()
    await childClosed.catch(() => undefined)
    throw error
  })

  return {
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await withTimeout(
        childClosed,
        packagedShutdownTimeoutMs,
        "Windows compositor backdrop did not stop"
      ).catch(() => undefined)
    },
    processId,
  }
}

function colorDistance(left: number[], right: number[]): number {
  return left.reduce(
    (total, channel, index) => total + Math.abs(channel - right[index]),
    0
  )
}

async function macWindowServerTags(
  app: ElectronApplication
): Promise<[number, number]> {
  const addonPath = path.join(
    projectRoot,
    "dist-native",
    "macos-window-blur.node"
  )
  return app.evaluate(({ BrowserWindow }, nativeAddonPath) => {
    const target = BrowserWindow.getAllWindows()[0]
    if (!target) throw new Error("Pulse window is unavailable")
    const load = process
      .getBuiltinModule("module")
      .createRequire(`${nativeAddonPath}.e2e.cjs`)
    const addon = load(nativeAddonPath) as {
      windowServerTags(nativeHandle: Buffer): unknown
    }
    const tags = addon.windowServerTags(target.getNativeWindowHandle())
    if (
      !Array.isArray(tags) ||
      tags.length !== 2 ||
      tags.some((word) => !Number.isInteger(word))
    ) {
      throw new Error("Native macOS window tags are unavailable")
    }
    return tags as [number, number]
  }, addonPath)
}

test("launch reveal keeps focus and first input available while it runs", async () => {
  test.skip(
    !nativeBackgroundEffectsSupported(),
    "Native background effects require macOS or Windows 11 22H2+"
  )
  test.skip(
    packagedExecutable !== null,
    "The hardened packaged launch cannot expose Electron main-process hooks"
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
    if (process.platform === "darwin") {
      await expect
        .poll(async () => {
          const [, highTags] = await macWindowServerTags(app)
          return {
            neverFlattenDuringSwipes: highTags & 0x00800000,
            spaceExclusion: highTags & 0x00010000,
          }
        })
        .toEqual({
          neverFlattenDuringSwipes: 0x00800000,
          spaceExclusion: 0,
        })
    }
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
          firstPaintReady: boolean
          firstPaintSurface: string | null
          shown: string
        }>((resolve, reject) => {
          let afterTheme: string | null = null
          let beforeTheme: string | null = null
          let firstPaintReady = false
          let firstPaintSurface: Promise<string | null> = Promise.resolve(null)
          const timeout = setTimeout(
            () => reject(new Error("The activation window was not shown")),
            5_000
          )
          electronApp.once("browser-window-created", (_event, window) => {
            window.once("ready-to-show", () => {
              firstPaintReady = true
              firstPaintSurface = window.webContents.executeJavaScript(`
                (() => {
                  const surface = document.querySelector(".app-shell") ?? document.body
                  return getComputedStyle(surface).backgroundColor
                })()
              `)
            })
            // Reproduce the launch race: this immediate is registered during
            // construction, so it runs after eager setup but before show.
            setImmediate(() => {
              beforeTheme = window.getBackgroundColor()
              nativeTheme.emit("updated")
              afterTheme = window.getBackgroundColor()
            })
            window.once("show", async () => {
              clearTimeout(timeout)
              resolve({
                afterTheme,
                beforeTheme,
                firstPaintReady,
                firstPaintSurface: await firstPaintSurface,
                shown: window.getBackgroundColor(),
              })
            })
          })
          electronApp.emit("activate")
        })
      }
    )
    const [page, backgrounds] = await Promise.all([
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
    if (process.platform === "win32") {
      // Pulse intentionally shows the settled native composition surface while
      // Chromium is loading, so ready-to-show may race either side of `show`
      // under load. If the first paint won the race it must already be clear;
      // otherwise verify that same first settled renderer surface directly.
      if (backgrounds.firstPaintReady) {
        expect(backgrounds.firstPaintSurface).toMatch(/rgba\(.+, 0\)/)
      }
      await expect(page.locator(".app-shell")).toHaveCSS(
        "background-color",
        /rgba\(.+, 0\)/
      )
    }
  } finally {
    await exitApplication(app)
    await rm(userData, { recursive: true, force: true })
  }
})

test("Windows background effects preview, cancel, persist, and use native blur", async () => {
  test.skip(
    process.platform !== "win32" || !nativeBackgroundEffectsSupported(),
    "Windows native backdrop blur requires Windows 11 22H2+"
  )

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-win-effects-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "light"
  settings.themeByScheme = {
    ...settings.themeByScheme,
    light: {
      ...settings.themeByScheme.light,
      backgroundId: "custom",
      customBackgroundColor: "#181818",
    },
  }
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
      }
      const appliedMaterials: string[] = []
      const setBackgroundMaterial = window.setBackgroundMaterial.bind(window)
      testGlobal.__pmdBackgroundMaterials = appliedMaterials
      window.setBackgroundMaterial = (material) => {
        appliedMaterials.push(material)
        setBackgroundMaterial(material)
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
      page.getByText(
        /Native backdrop blur is unavailable on this Windows release/
      )
    ).toBeVisible()
    await page.getByRole("button", { name: "Cancel" }).click()
    await page.evaluate(() => {
      document.documentElement.dataset.backgroundCapability = "win32"
    })

    await page.keyboard.press("Control+,")
    await page.getByRole("button", { name: "Transparency & Blur" }).click()
    const blurRadius = page.getByLabel("Background blur radius value")
    await expect(blurRadius).toBeDisabled()

    await page
      .getByRole("switch", { name: "Window transparency & blur" })
      .click()
    await expect(blurRadius).toBeEnabled()
    await blurRadius.fill("35")
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
    await expect(launchStrategy).toContainText("Tint and Blur Together")
    await expect(
      launchWorkspace.getByText(/animates the native blur radius/)
    ).toBeVisible()
    await launchStrategy.click()
    await expect(launchStrategy).toHaveAttribute("aria-expanded", "true")
    await expect(
      page.getByRole("option", { name: "Tint Reveal · Blur Preloaded" })
    ).toBeVisible()
    await expect(
      page.getByRole("option", { name: "Tint and Blur Together" })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(launchStrategy).toHaveAttribute("aria-expanded", "false")
    await expect(launchStrategy).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(launchWorkspace).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible()

    const acrylicApplicationsBeforeTintChange = (
      await appliedMaterials()
    ).filter((material) => material === "acrylic").length
    await page.getByLabel("Background translucency percentage").fill("70")
    await expect(appShell).toHaveCSS("background-color", "rgba(24, 24, 24, 0)")
    await expect(html).toHaveCSS("--document-surface-background", "#1818184d")
    await expect
      .poll(
        async () =>
          (await appliedMaterials()).filter(
            (material) => material === "acrylic"
          ).length
      )
      .toBe(acrylicApplicationsBeforeTintChange)
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
    await page.getByLabel("Background blur radius value").fill("35")
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
          blurRadius: 35,
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

test("native compositor exposes and blurs a window behind the editor while inactive", async () => {
  test.setTimeout(packagedExecutable ? 60_000 : 30_000)
  test.skip(
    !nativeBackgroundEffectsSupported(),
    "Native compositor blur requires macOS or Windows 11 22H2+"
  )
  test.skip(
    packagedExecutable !== null && process.platform !== "win32",
    "Installed compositor verification currently uses a Windows backdrop host"
  )

  const userData = await mkdtemp(path.join(os.tmpdir(), "pmd-transparency-"))
  const settings = cloneAppSettings(DEFAULT_APP_SETTINGS)
  settings.appearanceMode = "dark"
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify(settings, null, 2)
  )
  let app: ElectronApplication | undefined
  let packagedApp: PackagedRendererApplication | undefined
  let windowsBackdrop: WindowsStripedBackdrop | undefined

  try {
    let page: Page
    let compositor: {
      bounds: { height: number; width: number; x: number; y: number }
      scaleFactor: number
    }
    let focusBackdrop: () => Promise<void>
    let focusTarget: () => Promise<void>

    if (packagedExecutable) {
      windowsBackdrop = await launchWindowsStripedBackdrop()
      packagedApp = await launchPackagedRenderer(packagedExecutable, userData)
      page = packagedApp.page
      await page.locator(".cm-editor").waitFor()
      const targetWindowTitle = `pmd-compositor-target-${process.pid}`
      const inactiveWindowTitle = `pmd-compositor-inactive-${process.pid}`
      await page.evaluate((title) => {
        document.title = title
      }, targetWindowTitle)
      compositor = await page.evaluate(() => ({
        bounds: {
          height: window.outerHeight,
          width: window.outerWidth,
          x: window.screenX,
          y: window.screenY,
        },
        scaleFactor: window.devicePixelRatio,
      }))
      expect(compositor.bounds.width).toBeGreaterThanOrEqual(480)
      expect(compositor.bounds.height).toBeGreaterThanOrEqual(320)
      await focusWindowsWindow(packagedApp.processId, targetWindowTitle)
      await expect(page.locator("html")).toHaveAttribute(
        "data-window-active",
        "true"
      )
      let inactiveWindow: Page | undefined
      focusBackdrop = async () => {
        const context = page.context()
        const createdWindow = withTimeout(
          context.waitForEvent("page"),
          packagedLaunchTimeoutMs,
          "The packaged File menu did not create a window"
        )
        await page.keyboard.press("Alt+F")
        await page.getByRole("menuitem", { name: "New Window" }).click()
        inactiveWindow = await createdWindow
        await inactiveWindow.locator(".cm-editor").waitFor()
        await inactiveWindow.evaluate(
          ({ title, x, y }) => {
            document.title = title
            window.moveTo(x, y)
            window.resizeTo(480, 320)
          },
          {
            title: inactiveWindowTitle,
            x:
              compositor.bounds.x >= 500
                ? compositor.bounds.x - 500
                : compositor.bounds.x + compositor.bounds.width + 20,
            y:
              compositor.bounds.y >= 340
                ? compositor.bounds.y - 340
                : compositor.bounds.y + compositor.bounds.height + 20,
          }
        )
        await focusWindowsWindow(packagedApp!.processId, inactiveWindowTitle)
        await expect(page.locator("html")).toHaveAttribute(
          "data-window-active",
          "false"
        )
        await expect(inactiveWindow.locator("html")).toHaveAttribute(
          "data-window-active",
          "true"
        )
      }
      focusTarget = async () => {
        await focusWindowsWindow(packagedApp!.processId, targetWindowTitle)
        await expect(page.locator("html")).toHaveAttribute(
          "data-window-active",
          "true"
        )
      }
    } else {
      app = await electron.launch({
        args: [projectRoot, `--user-data-dir=${userData}`],
        cwd: projectRoot,
      })
      page = await app.firstWindow()
      await page.locator(".cm-editor").waitFor()
      const developmentCompositor = await app.evaluate(
        async ({ BrowserWindow, screen }) => {
          const target = BrowserWindow.getAllWindows()[0]
          if (!target) throw new Error("The document window is unavailable")
          const display = screen.getPrimaryDisplay()
          const workArea = display.workArea
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
          return {
            backdropId: backdrop.id,
            bounds,
            scaleFactor: display.scaleFactor,
            targetId: target.id,
          }
        }
      )
      compositor = developmentCompositor
      focusBackdrop = async () => {
        await app!.evaluate(({ BrowserWindow }, { backdropId }) => {
          const backdrop = BrowserWindow.fromId(backdropId)
          if (!backdrop) throw new Error("The compositor backdrop was lost")
          backdrop.focus()
        }, developmentCompositor)
        await expect
          .poll(() =>
            app!.evaluate(
              ({ BrowserWindow }) =>
                BrowserWindow.getFocusedWindow()?.id ?? null
            )
          )
          .toBe(developmentCompositor.backdropId)
      }
      focusTarget = async () => {
        await app!.evaluate(({ BrowserWindow }, { targetId }) => {
          const target = BrowserWindow.fromId(targetId)
          if (!target) throw new Error("The document window was lost")
          target.focus()
        }, developmentCompositor)
        await expect
          .poll(() =>
            app!.evaluate(
              ({ BrowserWindow }) =>
                BrowserWindow.getFocusedWindow()?.id ?? null
            )
          )
          .toBe(developmentCompositor.targetId)
      }
    }
    const captureStats = async (name: string) => {
      const filePath = path.join(userData, `${name}.bmp`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (process.platform === "darwin") {
        await execFileAsync("/usr/sbin/screencapture", [
          "-x",
          "-tbmp",
          `-R${compositor.bounds.x},${compositor.bounds.y},${compositor.bounds.width},${compositor.bounds.height}`,
          filePath,
        ])
      } else {
        await captureWindowsRegion(
          filePath,
          compositor.bounds,
          compositor.scaleFactor
        )
      }
      const stats = await readCaptureStats(filePath)
      return stats
    }
    const captureWhen = async (
      name: string,
      predicate: (stats: CaptureStats) => boolean
    ) => {
      const result: { accepted?: CaptureStats; latest?: CaptureStats } = {}
      try {
        await expect
          .poll(
            async () => {
              const stats = await captureStats(name)
              result.latest = stats
              if (predicate(stats)) result.accepted = stats
              return result.accepted !== undefined
            },
            {
              message: `waiting for the ${name} compositor state`,
              timeout: 5_000,
            }
          )
          .toBe(true)
      } catch (error) {
        await test.info().attach(`${name}-capture`, {
          contentType: "image/bmp",
          path: path.join(userData, `${name}.bmp`),
        })
        throw new Error(
          `The ${name} compositor state did not settle; latest capture: ${JSON.stringify(result.latest)}`,
          { cause: error }
        )
      }
      if (!result.accepted) {
        throw new Error(`The ${name} compositor state was lost`)
      }
      return result.accepted
    }

    const settingsShortcut =
      process.platform === "darwin" ? "Meta+," : "Control+,"

    await captureWhen(
      "opaque-initial",
      ({ colorVariance }) => colorVariance < 10
    )
    await page.keyboard.press(settingsShortcut)
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

    await page.keyboard.press(settingsShortcut)
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
        colorDistance(cornerColor, clear.cornerColor) < 15
    )

    await focusBackdrop()
    const blurredInactive = await captureWhen(
      "blurred-inactive",
      ({ colorVariance, meanColor }) =>
        colorVariance > blurred.colorVariance * 0.6 &&
        colorVariance < blurred.colorVariance * 1.4 &&
        colorDistance(meanColor, blurred.meanColor) < 12
    )
    await focusTarget()

    await page.keyboard.press(settingsShortcut)
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

    await page.keyboard.press(settingsShortcut)
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

    await page.keyboard.press(settingsShortcut)
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
    expect(blurredInactive.colorVariance).toBeGreaterThan(
      blurred.colorVariance * 0.6
    )
    expect(blurredInactive.colorVariance).toBeLessThan(
      blurred.colorVariance * 1.4
    )
    expect(
      colorDistance(blurredInactive.meanColor, blurred.meanColor)
    ).toBeLessThan(12)
    expect(tinted.colorVariance).toBeLessThan(blurred.colorVariance * 0.75)
    expect(colorDistance(tinted.meanColor, tintColor)).toBeLessThan(
      colorDistance(blurred.meanColor, tintColor)
    )
    expect(colorDistance(blurred.cornerColor, clear.cornerColor)).toBeLessThan(
      15
    )
    expect(clearAgain.colorVariance).toBeGreaterThan(20_000)
    expect(
      colorDistance(clearAgain.cornerColor, clear.cornerColor)
    ).toBeLessThan(10)
    expect(opaque.colorVariance).toBeLessThan(10)
  } finally {
    if (app) await exitApplication(app)
    if (packagedApp) await packagedApp.close()
    if (windowsBackdrop) await windowsBackdrop.close()
    await rm(userData, { recursive: true, force: true })
  }
})
