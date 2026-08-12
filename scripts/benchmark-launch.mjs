/* global document, HTMLElement, PerformanceNavigationTiming, requestAnimationFrame, cancelAnimationFrame, window */

import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { performance } from "node:perf_hooks"

import { chromium, expect } from "@playwright/test"

const LAUNCH_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const MAX_CAPTURED_STDERR_BYTES = 256 * 1024

function appendLogTail(current, chunk) {
  const combined = current + chunk
  return combined.length > MAX_CAPTURED_STDERR_BYTES
    ? combined.slice(-MAX_CAPTURED_STDERR_BYTES)
    : combined
}

function withTimeout(promise, timeoutMs, message) {
  let timeout
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout))
}

function waitForDevToolsEndpoint(child) {
  return new Promise((resolve, reject) => {
    let stderr = ""
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for the packaged renderer DevTools endpoint${stderr ? `:\n${stderr}` : ""}`
        )
      )
    }, LAUNCH_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeout)
      child.stderr.off("data", onData)
      child.off("error", onError)
      child.off("exit", onExit)
      child.stderr.resume()
    }
    const onData = (chunk) => {
      stderr = appendLogTail(stderr, chunk)
      const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1]
      if (!endpoint) return
      cleanup()
      resolve(endpoint)
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(
        new Error(
          `Packaged application exited before its renderer was inspectable (${signal ?? code})${stderr ? `:\n${stderr}` : ""}`
        )
      )
    }
    const onError = (error) => {
      cleanup()
      reject(
        new Error("Unable to launch the packaged application", { cause: error })
      )
    }

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", onData)
    child.once("error", onError)
    child.once("exit", onExit)
  })
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const gracefulExit = once(child, "exit")
  const signalDelivered = child.kill("SIGTERM")
  if (
    !signalDelivered &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    return new Error(
      `Unable to signal packaged application process ${child.pid ?? "unknown"}`
    )
  }
  try {
    await withTimeout(
      gracefulExit,
      SHUTDOWN_TIMEOUT_MS,
      "Packaged application did not stop after SIGTERM"
    )
    return null
  } catch (cause) {
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = once(child, "exit")
      child.kill("SIGKILL")
      await withTimeout(
        forcedExit,
        SHUTDOWN_TIMEOUT_MS,
        "Packaged application did not stop after SIGKILL"
      ).catch(() => undefined)
    }
    return new Error(
      `Packaged application process ${child.pid ?? "unknown"} did not stop cleanly`,
      { cause }
    )
  }
}

async function startPostInputObservation(page) {
  await page.evaluate(() => {
    const existing = window.__pmdBenchmarkObservation
    existing?.finish()

    const frameTimes = []
    const longTasks = []
    const startedAt = performance.now()
    const memoryAtStart =
      typeof performance.memory?.usedJSHeapSize === "number"
        ? performance.memory.usedJSHeapSize
        : null
    let frame = requestAnimationFrame(function tick(now) {
      frameTimes.push(now)
      frame = requestAnimationFrame(tick)
    })
    let longTaskSupported =
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask") === true
    let observer = longTaskSupported
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({
              duration: entry.duration,
              startTime: entry.startTime,
            })
          }
        })
      : null
    try {
      observer?.observe({ type: "longtask" })
    } catch {
      observer?.disconnect()
      observer = null
      longTaskSupported = false
    }

    window.__pmdBenchmarkObservation = {
      finish() {
        const finishedAt = performance.now()
        cancelAnimationFrame(frame)
        observer?.takeRecords().forEach((entry) => {
          longTasks.push({
            duration: entry.duration,
            startTime: entry.startTime,
          })
        })
        observer?.disconnect()

        const observedFrames = frameTimes.filter(
          (time) => time >= startedAt && time <= finishedAt
        )
        const intervalBoundaries = [startedAt, ...observedFrames, finishedAt]
        const frameGaps = intervalBoundaries
          .slice(1)
          .map((time, index) => time - intervalBoundaries[index])
        const observedLongTasks = longTasks.filter(
          (entry) =>
            entry.startTime < finishedAt &&
            entry.startTime + entry.duration > startedAt
        )
        const memoryAtEnd =
          typeof performance.memory?.usedJSHeapSize === "number"
            ? performance.memory.usedJSHeapSize
            : null
        const result = {
          observedDurationMs: finishedAt - startedAt,
          frameCount: observedFrames.length,
          frameGapMaximumMs: Math.max(0, ...frameGaps),
          frameGapsOver20Ms: frameGaps.filter((gap) => gap > 20).length,
          frameGapsOver50Ms: frameGaps.filter((gap) => gap > 50).length,
          longTaskSupported,
          longTaskCount: observedLongTasks.length,
          longTaskMaximumMs: Math.max(
            0,
            ...observedLongTasks.map((entry) => entry.duration)
          ),
          longTaskTotalMs: observedLongTasks.reduce(
            (total, entry) => total + entry.duration,
            0
          ),
          usedJsHeapBytesAtStart: memoryAtStart,
          usedJsHeapBytesAtEnd: memoryAtEnd,
          usedJsHeapDeltaBytes:
            memoryAtStart === null || memoryAtEnd === null
              ? null
              : memoryAtEnd - memoryAtStart,
        }
        delete window.__pmdBenchmarkObservation
        return result
      },
      startedAt,
    }
  })
}

async function finishPostInputObservation(page, durationMs) {
  return page.evaluate(async (requestedDurationMs) => {
    const observation = window.__pmdBenchmarkObservation
    if (!observation) {
      throw new Error("Post-input observation was not initialized")
    }
    const remainingMs = Math.max(
      0,
      observation.startedAt + requestedDurationMs - performance.now()
    )
    await new Promise((resolve) => window.setTimeout(resolve, remainingMs))
    return observation.finish()
  }, durationMs)
}

async function measurePostLaunchInactiveTabActivation(page) {
  const inactiveTab = page
    .locator('[role="tab"]:not([aria-selected="true"])')
    .first()
  if ((await inactiveTab.count()) === 0) {
    throw new Error(
      "Multi-document benchmark did not expose an inactive document tab"
    )
  }
  const tabId = await inactiveTab.getAttribute("data-tab-id")
  if (!tabId) {
    throw new Error(
      "Multi-document benchmark did not expose an inactive document tab"
    )
  }

  await inactiveTab.evaluate((tab, activationTimeoutMs) => {
    window.__pmdBenchmarkTabActivation = new Promise((resolve) => {
      let settled = false
      let timeout = 0
      const finishWithError = (message) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        resolve({ error: message })
      }
      tab.addEventListener(
        "click",
        () => {
          const startedAt = performance.now()
          timeout = window.setTimeout(
            () =>
              finishWithError(
                "Inactive tab did not become the focused editor in time"
              ),
            activationTimeoutMs
          )
          const checkFocused = () => {
            if (settled) return
            const editor = document.querySelector(".cm-editor")
            if (
              tab.getAttribute("aria-selected") === "true" &&
              editor instanceof HTMLElement &&
              editor.contains(document.activeElement)
            ) {
              const focusedAt = performance.now()
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (settled) return
                  settled = true
                  window.clearTimeout(timeout)
                  resolve({
                    focusedMs: focusedAt - startedAt,
                    paintedMs: performance.now() - startedAt,
                  })
                })
              })
              return
            }
            requestAnimationFrame(checkFocused)
          }
          requestAnimationFrame(checkFocused)
        },
        { capture: true, once: true }
      )
    })
  }, LAUNCH_TIMEOUT_MS - 500)

  await inactiveTab.click()
  const measurement = await withTimeout(
    page.evaluate(() => window.__pmdBenchmarkTabActivation),
    LAUNCH_TIMEOUT_MS,
    "Timed out measuring inactive-tab activation"
  )
  await page.evaluate(() => {
    delete window.__pmdBenchmarkTabActivation
  })
  if (measurement.error) throw new Error(measurement.error)
  return measurement
}

async function prepareBenchmarkWindowForClose(page) {
  if (!page || page.isClosed()) return
  await page
    .evaluate(async () => {
      window.__pmdBenchmarkObservation?.finish()
      delete window.__pmdBenchmarkTabActivation
      const activeTab = document.querySelector(
        '[role="tab"][aria-selected="true"]'
      )
      if (!(activeTab instanceof HTMLElement) || !activeTab.dataset.tabId)
        return

      // The typed probe deliberately dirties the disposable benchmark tab.
      // Multi-document runs may have activated another tab afterward, so clear
      // every benchmark tab. Follow the sends with an invoke as an IPC ordering
      // barrier so an interrupted run can never open a save sheet.
      for (const tab of document.querySelectorAll("[role=tab][data-tab-id]")) {
        if (tab instanceof HTMLElement && tab.dataset.tabId) {
          window.pulseMd.setDirty(tab.dataset.tabId, false)
        }
      }
      await window.pulseMd.activateTab(activeTab.dataset.tabId)
    })
    .catch(() => undefined)
}

function positiveInteger(name, value) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a safe positive integer`)
  }
  return parsed
}

const runs = positiveInteger(
  "BENCHMARK_RUNS",
  process.env.BENCHMARK_RUNS ?? "10"
)
const visualModeArgument = process.env.BENCHMARK_LAUNCH_VISUAL_MODES?.trim()
const visualModes = visualModeArgument
  ? visualModeArgument.split(",").map((value) => value.trim())
  : []
const validVisualModes = new Set(["opaque", "deferred", "eager"])
if (
  visualModes.some((mode) => !validVisualModes.has(mode)) ||
  new Set(visualModes).size !== visualModes.length
) {
  throw new TypeError(
    "BENCHMARK_LAUNCH_VISUAL_MODES must contain unique opaque, deferred, or eager values"
  )
}
if (visualModes.length > 0 && process.platform !== "darwin") {
  throw new Error("The launch visual-effect experiment requires macOS")
}
const warmupRuns = visualModes.length
  ? positiveInteger(
      "BENCHMARK_WARMUP_RUNS",
      process.env.BENCHMARK_WARMUP_RUNS ?? "3"
    )
  : 0
const executableArgument = process.env.BENCHMARK_EXECUTABLE?.trim()
if (!executableArgument) {
  throw new Error(
    "BENCHMARK_EXECUTABLE must point to a packaged application executable"
  )
}

const executablePath = path.resolve(executableArgument)
let executableStats
try {
  executableStats = await stat(executablePath)
} catch (cause) {
  throw new Error(`Packaged executable does not exist: ${executablePath}`, {
    cause,
  })
}
if (!executableStats.isFile()) {
  throw new Error(`Packaged executable is not a file: ${executablePath}`)
}

const documentsArgument = process.env.BENCHMARK_DOCUMENTS?.trim()
const documentArgument = process.env.BENCHMARK_DOCUMENT?.trim()
if (documentsArgument && documentArgument) {
  throw new Error("Use BENCHMARK_DOCUMENT or BENCHMARK_DOCUMENTS, not both")
}
let documentArguments = []
if (documentsArgument) {
  let parsed
  try {
    parsed = JSON.parse(documentsArgument)
  } catch (cause) {
    throw new Error("BENCHMARK_DOCUMENTS must be a JSON array of paths", {
      cause,
    })
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new TypeError(
      "BENCHMARK_DOCUMENTS must be a non-empty JSON array of paths"
    )
  }
  documentArguments = parsed.map((value) => value.trim())
} else if (documentArgument) {
  documentArguments = [documentArgument]
}
const documentPaths = documentArguments.map((value) => path.resolve(value))
for (const documentPath of documentPaths) {
  let documentStats
  try {
    documentStats = await stat(documentPath)
  } catch (cause) {
    throw new Error(`Benchmark document does not exist: ${documentPath}`, {
      cause,
    })
  }
  if (!documentStats.isFile()) {
    throw new Error(`Benchmark document is not a file: ${documentPath}`)
  }
}
const settleArgument = process.env.BENCHMARK_POST_INPUT_MS?.trim() ?? "0"
if (!/^\d+$/.test(settleArgument)) {
  throw new TypeError("BENCHMARK_POST_INPUT_MS must be a non-negative integer")
}
const postInputObservationMs = Number(settleArgument)
if (
  !Number.isSafeInteger(postInputObservationMs) ||
  postInputObservationMs > 60_000
) {
  throw new TypeError(
    "BENCHMARK_POST_INPUT_MS must be a safe integer no greater than 60000"
  )
}

const userDataArgument = process.env.BENCHMARK_USER_DATA_DIR?.trim()
const persistentUserDataPath = userDataArgument
  ? path.resolve(userDataArgument)
  : null
if (persistentUserDataPath) {
  let userDataStats
  try {
    userDataStats = await stat(persistentUserDataPath)
  } catch (cause) {
    throw new Error(
      `Benchmark user-data directory does not exist: ${persistentUserDataPath}`,
      { cause }
    )
  }
  if (!userDataStats.isDirectory()) {
    throw new Error(
      `Benchmark user-data path is not a directory: ${persistentUserDataPath}`
    )
  }
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (value) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]
  const rounded = (value) => Math.round(value * 100) / 100
  return {
    min: rounded(sorted[0]),
    median: rounded(percentile(0.5)),
    p95: rounded(percentile(0.95)),
    max: rounded(sorted.at(-1)),
  }
}

const samples = []

const visualModePermutations = [
  ["opaque", "deferred", "eager"],
  ["opaque", "eager", "deferred"],
  ["deferred", "opaque", "eager"],
  ["deferred", "eager", "opaque"],
  ["eager", "opaque", "deferred"],
  ["eager", "deferred", "opaque"],
]
const selectedModeSet = new Set(visualModes)
const scheduledLaunches = []
if (visualModes.length > 0) {
  for (let pairIndex = -warmupRuns; pairIndex < runs; pairIndex += 1) {
    const permutation =
      visualModePermutations[
        ((pairIndex + warmupRuns) * 5 + 1) % visualModePermutations.length
      ]
    for (const mode of permutation) {
      if (selectedModeSet.has(mode)) {
        scheduledLaunches.push({
          measured: pairIndex >= 0,
          mode,
          pairIndex,
        })
      }
    }
  }
} else {
  for (let run = 0; run < runs; run += 1) {
    scheduledLaunches.push({ measured: true, mode: null, pairIndex: run })
  }
}

for (let sequence = 0; sequence < scheduledLaunches.length; sequence += 1) {
  const launch = scheduledLaunches[sequence]
  const userData =
    persistentUserDataPath ??
    (await mkdtemp(path.join(os.tmpdir(), "pulse-md-benchmark-")))
  let browser
  let child
  let cleanupError
  let page
  let processStderr = ""
  let sample
  let startedAtEpoch
  let postInputMetrics

  try {
    startedAtEpoch = performance.timeOrigin + performance.now()
    const startedAt = performance.now()
    const elapsed = () => performance.now() - startedAt
    child = spawn(
      executablePath,
      [
        `--user-data-dir=${userData}`,
        "--remote-debugging-port=0",
        "--disable-breakpad",
        ...documentPaths,
      ],
      {
        env: {
          ...process.env,
          PMD_LAUNCH_BENCHMARK: "1",
          ...(launch.mode ? { PMD_LAUNCH_VISUAL_MODE: launch.mode } : {}),
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    )
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      processStderr = appendLogTail(processStderr, chunk)
    })
    const endpoint = await waitForDevToolsEndpoint(child)
    const endpointMs = elapsed()
    browser = await withTimeout(
      chromium.connectOverCDP(endpoint),
      LAUNCH_TIMEOUT_MS,
      "Timed out connecting to the packaged renderer"
    )
    const connectedMs = elapsed()
    const context = browser.contexts()[0]
    if (!context) {
      throw new Error("Packaged application did not create a browser context")
    }
    page =
      context.pages()[0] ??
      (await withTimeout(
        context.waitForEvent("page"),
        LAUNCH_TIMEOUT_MS,
        "Packaged application did not create a renderer page"
      ))
    const pageMs = elapsed()
    await page.locator(".cm-editor").waitFor({
      state: "visible",
      timeout: LAUNCH_TIMEOUT_MS,
    })
    const editorVisibleMs = elapsed()
    await page.waitForFunction(
      () => {
        const editor = document.querySelector(".cm-editor")
        return (
          document.hasFocus() &&
          editor instanceof HTMLElement &&
          editor.contains(document.activeElement)
        )
      },
      undefined,
      { timeout: LAUNCH_TIMEOUT_MS }
    )
    const editorFocusedMs = elapsed()

    if (sequence === 0) {
      const rendererUrl = new URL(page.url())
      if (
        rendererUrl.protocol !== "pulse-md:" ||
        rendererUrl.host !== "bundle" ||
        rendererUrl.pathname !== "/index.html"
      ) {
        throw new Error(
          `Packaged renderer did not use the trusted bundle URL: ${page.url()}`
        )
      }
    }

    const inputProbe = `benchmark-${process.pid}-${sequence}`
    const editorContent = page.locator(".cm-content")
    if (postInputObservationMs > 0) {
      await startPostInputObservation(page)
    }
    await page.keyboard.insertText(inputProbe)
    await expect(editorContent).toContainText(inputProbe, {
      timeout: LAUNCH_TIMEOUT_MS,
    })
    const inputAcceptedMs = elapsed()
    if (postInputObservationMs > 0) {
      const observation = await finishPostInputObservation(
        page,
        postInputObservationMs
      )
      postInputMetrics = {
        postInputLongTaskSupported: observation.longTaskSupported,
        postInputObservedDurationMs: observation.observedDurationMs,
        postInputFrameCount: observation.frameCount,
        postInputFrameGapMaximumMs: observation.frameGapMaximumMs,
        postInputFrameGapsOver20Ms: observation.frameGapsOver20Ms,
        postInputFrameGapsOver50Ms: observation.frameGapsOver50Ms,
        postInputLongTaskCount: observation.longTaskCount,
        postInputLongTaskMaximumMs: observation.longTaskMaximumMs,
        postInputLongTaskTotalMs: observation.longTaskTotalMs,
        postInputUsedJsHeapBytesAtStart: observation.usedJsHeapBytesAtStart,
        postInputUsedJsHeapBytesAtEnd: observation.usedJsHeapBytesAtEnd,
        postInputUsedJsHeapDeltaBytes: observation.usedJsHeapDeltaBytes,
      }
    }

    const rendererTiming = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0]
      const marks = Object.fromEntries(
        performance
          .getEntriesByType("mark")
          .filter((entry) => entry.name.startsWith("pmd:"))
          .map((entry) => [entry.name, entry.startTime])
      )
      const paints = Object.fromEntries(
        performance
          .getEntriesByType("paint")
          .map((entry) => [entry.name, entry.startTime])
      )
      return {
        timeOrigin: performance.timeOrigin,
        domContentLoaded:
          navigation instanceof PerformanceNavigationTiming
            ? navigation.domContentLoadedEventEnd
            : null,
        loadEvent:
          navigation instanceof PerformanceNavigationTiming
            ? navigation.loadEventEnd
            : null,
        marks,
        paints,
      }
    })
    const rendererOriginMs = rendererTiming.timeOrigin - startedAtEpoch
    const absoluteMark = (name) => {
      const mark = rendererTiming.marks[name]
      return typeof mark === "number" ? rendererOriginMs + mark : null
    }
    sample = {
      mode: launch.mode,
      pairIndex: launch.pairIndex,
      endpointMs,
      connectedMs,
      pageMs,
      editorVisibleMs,
      editorFocusedMs,
      inputAcceptedMs,
      rendererOriginMs,
      domContentLoadedMs:
        rendererTiming.domContentLoaded === null
          ? null
          : rendererOriginMs + rendererTiming.domContentLoaded,
      loadEventMs:
        rendererTiming.loadEvent === null
          ? null
          : rendererOriginMs + rendererTiming.loadEvent,
      themeBootstrapMs: absoluteMark("pmd:theme-bootstrap"),
      rendererEntryMs: absoluteMark("pmd:renderer-entry"),
      bootstrapRequestMs: absoluteMark("pmd:bootstrap-request"),
      bootstrapReceivedMs: absoluteMark("pmd:bootstrap-received"),
      editorFontsReadyMs: absoluteMark("pmd:editor-fonts-ready"),
      editorCreateStartMs: absoluteMark("pmd:editor-create-start"),
      editorCreatedMs: absoluteMark("pmd:editor-created"),
      editorFocusedMarkMs: absoluteMark("pmd:editor-focused"),
      firstDocumentChangeMs: absoluteMark("pmd:first-document-change"),
      firstPaintMs:
        typeof rendererTiming.paints["first-paint"] === "number"
          ? rendererOriginMs + rendererTiming.paints["first-paint"]
          : null,
      firstContentfulPaintMs:
        typeof rendererTiming.paints["first-contentful-paint"] === "number"
          ? rendererOriginMs + rendererTiming.paints["first-contentful-paint"]
          : null,
      ...(postInputMetrics ?? {}),
    }

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z"
    )
    await expect(editorContent).not.toContainText(inputProbe, {
      timeout: LAUNCH_TIMEOUT_MS,
    })

    if (documentPaths.length > 1) {
      const activation = await measurePostLaunchInactiveTabActivation(page)
      // Idle hydration intentionally runs after readiness, so this measures
      // the practical post-launch click path rather than claiming a forced
      // cold, on-demand file hydration.
      sample.postLaunchInactiveTabActivationFocusedMs = activation.focusedMs
      sample.postLaunchInactiveTabActivationPaintedMs = activation.paintedMs
    }
  } finally {
    if (page && !page.isClosed()) {
      await prepareBenchmarkWindowForClose(page)
      await page
        .evaluate(() => window.pulseMd.exitLaunchBenchmark())
        .catch(() => undefined)
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      await withTimeout(
        once(child, "exit"),
        SHUTDOWN_TIMEOUT_MS,
        "Packaged application did not exit after closing its benchmark window"
      ).catch(() => undefined)
    }
    if (browser) {
      await withTimeout(
        browser.close(),
        SHUTDOWN_TIMEOUT_MS,
        "Timed out closing the renderer debugging connection"
      ).catch(() => undefined)
    }
    const stopError = child ? await stopProcess(child) : null
    if (!persistentUserDataPath) {
      await rm(userData, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 100,
      })
    }
    cleanupError = stopError
  }
  if (cleanupError) throw cleanupError

  if (!sample || startedAtEpoch === undefined) {
    throw new Error("Launch completed without a benchmark sample")
  }
  if (launch.mode) {
    const matches = [
      ...processStderr.matchAll(/^PMD_LAUNCH_VISUAL_BENCHMARK (.+)$/gm),
    ]
    const serializedMainTiming = matches.at(-1)?.[1]
    if (!serializedMainTiming) {
      throw new Error(
        `Launch ${sequence + 1} (${launch.mode}) did not emit native visual-effect timing:\n${processStderr}`
      )
    }
    const mainTiming = JSON.parse(serializedMainTiming)
    if (mainTiming.mode !== launch.mode) {
      throw new Error(
        `Launch ${sequence + 1} requested ${launch.mode} but measured ${mainTiming.mode}`
      )
    }
    if (
      (launch.mode === "deferred" || launch.mode === "eager") &&
      mainTiming.visualEffectApplied !== true
    ) {
      throw new Error(
        `Native blur was not applied for launch ${sequence + 1} (${launch.mode}); check Reduce Transparency and the native addon`
      )
    }

    const fromEpoch = (value) =>
      typeof value === "number" ? value - startedAtEpoch : null
    sample = {
      ...sample,
      browserWindowCreateStartedMs: fromEpoch(
        mainTiming.browserWindowCreateStartedEpochMs
      ),
      browserWindowCreatedMs: fromEpoch(mainTiming.browserWindowCreatedEpochMs),
      browserWindowCreateDurationMs:
        mainTiming.browserWindowCreatedEpochMs -
        mainTiming.browserWindowCreateStartedEpochMs,
      mainEditorReadyMs: fromEpoch(mainTiming.editorReadyEpochMs),
      nativeAddonLoadStartedMs: fromEpoch(
        mainTiming.nativeAddonLoadStartedEpochMs
      ),
      nativeAddonLoadReadyMs: fromEpoch(mainTiming.nativeAddonLoadReadyEpochMs),
      nativeAddonLoadDurationMs:
        typeof mainTiming.nativeAddonLoadStartedEpochMs === "number" &&
        typeof mainTiming.nativeAddonLoadReadyEpochMs === "number"
          ? mainTiming.nativeAddonLoadReadyEpochMs -
            mainTiming.nativeAddonLoadStartedEpochMs
          : null,
      showRequestedMs: fromEpoch(mainTiming.showRequestedEpochMs),
      shownMs: fromEpoch(mainTiming.shownEpochMs),
      visualEffectStartedMs: fromEpoch(mainTiming.visualEffectStartedEpochMs),
      visualEffectReadyMs: fromEpoch(mainTiming.visualEffectReadyEpochMs),
      visualEffectSetupDurationMs:
        mainTiming.visualEffectReadyEpochMs -
        mainTiming.visualEffectStartedEpochMs,
      visualEffectLeadToShowMs:
        mainTiming.visualEffectReadyEpochMs - mainTiming.shownEpochMs,
      solidVisibleMs:
        launch.mode === "opaque"
          ? null
          : Math.max(
              0,
              mainTiming.visualEffectReadyEpochMs - mainTiming.shownEpochMs
            ),
    }
  }
  if (launch.measured) samples.push(sample)
}

function metricsFor(inputSamples) {
  const metricNames = [
    ...new Set(inputSamples.flatMap((sample) => Object.keys(sample))),
  ].filter((name) => name !== "pairIndex")
  return Object.fromEntries(
    metricNames.flatMap((name) => {
      const values = inputSamples
        .map((sample) => sample[name])
        .filter((value) => typeof value === "number" && Number.isFinite(value))
      return values.length === inputSamples.length
        ? [[name, summarize(values)]]
        : []
    })
  )
}

const metrics = visualModes.length ? null : metricsFor(samples)
const postInputCapabilities =
  postInputObservationMs > 0
    ? {
        longTasks: samples.every(
          (sample) => sample.postInputLongTaskSupported === true
        ),
        usedJsHeap: samples.every(
          (sample) => typeof sample.postInputUsedJsHeapBytesAtEnd === "number"
        ),
      }
    : null
const metricsByMode = visualModes.length
  ? Object.fromEntries(
      visualModes.map((mode) => [
        mode,
        metricsFor(samples.filter((sample) => sample.mode === mode)),
      ])
    )
  : null
const comparisonsToOpaque =
  visualModes.length && selectedModeSet.has("opaque")
    ? Object.fromEntries(
        visualModes
          .filter((mode) => mode !== "opaque")
          .map((mode) => {
            const modeSamples = samples.filter((sample) => sample.mode === mode)
            const opaqueByPair = new Map(
              samples
                .filter((sample) => sample.mode === "opaque")
                .map((sample) => [sample.pairIndex, sample])
            )
            const sharedMetricNames = [
              ...new Set(modeSamples.flatMap((sample) => Object.keys(sample))),
            ].filter((name) => name !== "pairIndex")
            const comparisons = Object.fromEntries(
              sharedMetricNames.flatMap((name) => {
                const deltas = modeSamples.flatMap((sample) => {
                  const opaque = opaqueByPair.get(sample.pairIndex)
                  const value = sample[name]
                  const baseline = opaque?.[name]
                  return typeof value === "number" &&
                    Number.isFinite(value) &&
                    typeof baseline === "number" &&
                    Number.isFinite(baseline)
                    ? [value - baseline]
                    : []
                })
                return deltas.length === modeSamples.length
                  ? [[name, summarize(deltas)]]
                  : []
              })
            )
            return [mode, comparisons]
          })
      )
    : null

console.log(
  JSON.stringify(
    {
      runs,
      ...(visualModes.length
        ? { warmupRunsPerMode: warmupRuns, visualModes }
        : {}),
      scenario:
        documentPaths.length > 1
          ? "multi-document"
          : documentPaths.length === 1
            ? "document"
            : "empty",
      profile: persistentUserDataPath ? "persistent" : "fresh-per-run",
      ...(documentPaths.length === 1
        ? { documentPath: documentPaths[0] }
        : documentPaths.length > 1
          ? { documentPaths }
          : {}),
      ...(postInputObservationMs > 0 ? { postInputObservationMs } : {}),
      ...(postInputCapabilities ? { postInputCapabilities } : {}),
      ...(metrics ? { metrics } : {}),
      ...(metricsByMode ? { metricsByMode } : {}),
      ...(comparisonsToOpaque ? { comparisonsToOpaque } : {}),
      ...(process.env.BENCHMARK_RAW === "1"
        ? {
            samples: samples.map((sample) =>
              Object.fromEntries(
                Object.entries(sample).map(([name, value]) => [
                  name,
                  typeof value === "number"
                    ? Math.round(value * 1_000) / 1_000
                    : value,
                ])
              )
            ),
          }
        : {}),
    },
    null,
    2
  )
)
