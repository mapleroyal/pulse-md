import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import net from "node:net"
import path from "node:path"

import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses"

import { assertAdaptiveMacIconAssetInfo } from "./macos-icon-assets.mjs"
import { sameCanonicalPath } from "./canonical-path.mjs"

const projectRoot = path.resolve(import.meta.dirname, "..")
const releaseDirectory = path.join(projectRoot, "release")
const require = createRequire(import.meta.url)

async function isFile(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function packagedLayout() {
  const explicitRoot = process.env.PMD_PACKAGED_ROOT
    ? path.resolve(process.env.PMD_PACKAGED_ROOT)
    : null
  const entries = explicitRoot
    ? []
    : await readdir(releaseDirectory, { withFileTypes: true })
  const directories = explicitRoot
    ? []
    : entries.filter((entry) => entry.isDirectory())
  let candidates

  if (process.platform === "darwin") {
    candidates = directories.filter((entry) => /^mac(?:-|$)/.test(entry.name))
  } else if (process.platform === "win32") {
    candidates = directories.filter((entry) =>
      /^win.*unpacked$/.test(entry.name)
    )
  } else if (process.platform === "linux") {
    candidates = directories.filter((entry) =>
      /^linux.*unpacked$/.test(entry.name)
    )
  } else {
    throw new Error(`Packaged runtime tests do not support ${process.platform}`)
  }

  const roots = explicitRoot
    ? [explicitRoot]
    : candidates.map((candidate) => path.join(releaseDirectory, candidate.name))
  const layouts = []
  for (const root of roots) {
    if (process.platform === "darwin") {
      const appBundles = root.endsWith(".app")
        ? [root]
        : (await readdir(root, { withFileTypes: true }))
            .filter(
              (entry) => entry.isDirectory() && entry.name.endsWith(".app")
            )
            .map((entry) => path.join(root, entry.name))
      for (const appBundle of appBundles) {
        const infoPlist = path.join(appBundle, "Contents", "Info.plist")
        const executableName = await capture("/usr/bin/plutil", [
          "-extract",
          "CFBundleExecutable",
          "raw",
          "-o",
          "-",
          infoPlist,
        ])
        if (executableName.error || executableName.code !== 0) continue
        if (executableName.stdout.trim() !== "Pulse MD") continue
        const executable = path.join(
          appBundle,
          "Contents",
          "MacOS",
          executableName.stdout.trim()
        )
        if (!(await isFile(executable))) continue
        layouts.push({
          executable,
          productName: executableName.stdout.trim(),
          resources: path.join(appBundle, "Contents", "Resources"),
        })
      }
      continue
    }

    const names = process.platform === "win32" ? ["Pulse MD.exe"] : ["pulse-md"]
    for (const name of names) {
      const executable = path.join(root, name)
      if (!(await isFile(executable))) continue
      layouts.push({
        executable,
        productName: "Pulse MD",
        resources: path.join(root, "resources"),
      })
    }
  }

  if (layouts.length === 1) return layouts[0]
  if (layouts.length > 1) {
    throw new Error(
      `Multiple unpacked ${process.platform} applications were found; set PMD_PACKAGED_ROOT to the package just built:\n${layouts
        .map((layout) => `- ${layout.executable}`)
        .join("\n")}`
    )
  }

  throw new Error(
    explicitRoot
      ? `No unpacked ${process.platform} application was found at ${explicitRoot}`
      : `No unpacked ${process.platform} application was found in ${releaseDirectory}`
  )
}

async function verifyPackagedResources(resources) {
  const cli = path.join(
    resources,
    "bin",
    process.platform === "win32" ? "pmd.exe" : "pmd"
  )
  const nativeAddon =
    process.platform === "darwin"
      ? path.join(resources, "native", "macos-window-blur.node")
      : process.platform === "win32"
        ? path.join(resources, "native", "windows-window-blur.node")
        : null
  const electronLicenseDirectory = path.join(resources, "licenses", "electron")
  const required = [path.join(resources, "app.asar")]
  required.push(cli)
  required.push(
    path.join(electronLicenseDirectory, "LICENSE.electron.txt"),
    path.join(electronLicenseDirectory, "LICENSES.chromium.html")
  )
  if (nativeAddon) {
    required.push(nativeAddon)
  }
  if (process.platform === "linux") {
    required.push(path.join(resources, "icons", "pulse-md.png"))
  }

  for (const resource of required) {
    if (!(await isFile(resource))) {
      throw new Error(`Required packaged resource is missing: ${resource}`)
    }
  }
  const competingCli = path.join(
    resources,
    "bin",
    process.platform === "win32" ? "pmd-local.exe" : "pmd-local"
  )
  if (await isFile(competingCli)) {
    throw new Error(`Package contains another channel's CLI: ${competingCli}`)
  }
  return { cli, nativeAddon }
}

async function verifyPackagedMetadata(resources) {
  const { extractFile } = require("@electron/asar")
  const metadata = JSON.parse(
    extractFile(path.join(resources, "app.asar"), "package.json").toString(
      "utf8"
    )
  )
  const expected = {
    name: "pulse-md",
    pmdDistributionChannel: "canonical",
    productName: "Pulse MD",
  }
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(
        `Packaged metadata ${key} is ${JSON.stringify(metadata[key])}; expected ${JSON.stringify(value)}`
      )
    }
  }
}

async function verifyElectronFuses(executable) {
  const fuseWire = await getCurrentFuseWire(executable)
  if (fuseWire.version !== "1") {
    throw new Error(
      `Unexpected Electron fuse wire version: ${fuseWire.version}`
    )
  }
  const disabled = "0".charCodeAt(0)
  const enabled = "1".charCodeAt(0)
  const expected = new Map([
    [FuseV1Options.RunAsNode, disabled],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, disabled],
    [FuseV1Options.EnableNodeCliInspectArguments, disabled],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, enabled],
    [FuseV1Options.OnlyLoadAppFromAsar, enabled],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, disabled],
  ])
  for (const [option, state] of expected) {
    if (fuseWire[option] !== state) {
      throw new Error(
        `Packaged Electron fuse ${FuseV1Options[option]} is ${fuseWire[option]}, expected ${state}`
      )
    }
  }
}

async function verifyMacProtocolRegistration(executable) {
  if (process.platform !== "darwin") return

  const infoPlist = path.resolve(path.dirname(executable), "..", "Info.plist")
  const result = await capture("/usr/bin/plutil", [
    "-extract",
    "CFBundleURLTypes",
    "json",
    "-o",
    "-",
    infoPlist,
  ])
  if (result.error || result.code !== 0) {
    throw new Error(
      `Packaged app URL registrations could not be read (${describeChildResult(result)}):\n${
        result.stderr || result.stdout
      }`
    )
  }

  let urlTypes
  try {
    urlTypes = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error("Packaged app CFBundleURLTypes is not valid JSON", {
      cause: error,
    })
  }
  const schemes = Array.isArray(urlTypes)
    ? urlTypes.flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray(entry.CFBundleURLSchemes)
          ? entry.CFBundleURLSchemes
          : []
      )
    : []
  const expectedScheme = "pulse-md"
  if (!schemes.includes(expectedScheme)) {
    throw new Error(
      `Packaged app does not register the ${expectedScheme} URL scheme: ${infoPlist}`
    )
  }
  const competingSchemes = ["pulse-md-local", "pulse-md-development"].filter(
    (scheme) => schemes.includes(scheme)
  )
  if (competingSchemes.length > 0) {
    throw new Error(
      `Packaged app registers another channel's URL scheme (${competingSchemes.join(", ")}): ${infoPlist}`
    )
  }
}

async function verifyMacIdentity(executable) {
  if (process.platform !== "darwin") return
  const infoPlist = path.resolve(path.dirname(executable), "..", "Info.plist")
  const bundleIdentifier = await capture("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    infoPlist,
  ])
  if (
    bundleIdentifier.error ||
    bundleIdentifier.code !== 0 ||
    bundleIdentifier.stdout.trim() !== "io.github.mapleroyal.pulse-md"
  ) {
    throw new Error(
      `Packaged app has the wrong bundle identifier (${describeChildResult(bundleIdentifier)}):\n${
        bundleIdentifier.stderr || bundleIdentifier.stdout
      }`
    )
  }
}

async function verifyMacIconPackaging(executable, resources) {
  if (process.platform !== "darwin") return

  const infoPlist = path.resolve(path.dirname(executable), "..", "Info.plist")
  const iconName = await capture("/usr/bin/plutil", [
    "-extract",
    "CFBundleIconName",
    "raw",
    "-o",
    "-",
    infoPlist,
  ])
  if (
    iconName.error ||
    iconName.code !== 0 ||
    iconName.stdout.trim() !== "Icon"
  ) {
    throw new Error(
      `Packaged app does not declare its adaptive icon (${describeChildResult(iconName)}):\n${iconName.stderr || iconName.stdout}`
    )
  }

  const iconFile = await capture("/usr/bin/plutil", [
    "-extract",
    "CFBundleIconFile",
    "raw",
    "-o",
    "-",
    infoPlist,
  ])
  if (iconFile.error || iconFile.code !== 0 || !iconFile.stdout.trim()) {
    throw new Error(
      `Packaged app does not declare its legacy icon (${describeChildResult(iconFile)}):\n${
        iconFile.stderr || iconFile.stdout
      }`
    )
  }

  const legacyIconName = iconFile.stdout.trim().endsWith(".icns")
    ? iconFile.stdout.trim()
    : `${iconFile.stdout.trim()}.icns`
  const legacyIcon = path.join(resources, legacyIconName)
  const iconResources = [legacyIcon, path.join(resources, "Assets.car")]
  for (const resource of iconResources) {
    if (!(await isFile(resource))) {
      throw new Error(`Packaged icon resource is missing: ${resource}`)
    }
  }
  const assetCatalog = path.join(resources, "Assets.car")
  const assetInfoResult = await capture("/usr/bin/assetutil", [
    "--info",
    assetCatalog,
  ])
  if (
    assetInfoResult.error ||
    assetInfoResult.code !== 0 ||
    assetInfoResult.signal
  ) {
    throw new Error(
      `Packaged adaptive icon metadata could not be read (${describeChildResult(assetInfoResult)}):\n${assetInfoResult.stderr || assetInfoResult.stdout}`
    )
  }
  let assetInfo
  try {
    assetInfo = JSON.parse(assetInfoResult.stdout)
  } catch (error) {
    throw new Error(`Packaged adaptive icon metadata is not valid JSON`, {
      cause: error,
    })
  }
  assertAdaptiveMacIconAssetInfo(assetInfo, assetCatalog)
  const [expectedFallback, packagedFallback] = await Promise.all([
    readFile(path.join(projectRoot, "build", "pulse-md.icns")),
    readFile(legacyIcon),
  ])
  if (!packagedFallback.equals(expectedFallback)) {
    throw new Error(
      `Packaged legacy icon does not match build/pulse-md.icns: ${legacyIcon}`
    )
  }
}

async function verifyMacPrivacyMetadata(executable) {
  if (process.platform !== "darwin") return

  const infoPlist = path.resolve(path.dirname(executable), "..", "Info.plist")
  for (const key of [
    "NSAppTransportSecurity",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    const result = await capture("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      infoPlist,
    ])
    if (!result.error && result.code === 0) {
      throw new Error(`Packaged app declares an unused privacy key: ${key}`)
    }
  }
}

function verifyNativeAddon(nativeAddon) {
  if (!nativeAddon) return
  const addon = require(nativeAddon)
  const methods = [
    "animateWindowBackgroundBlur",
    ...(process.platform === "win32"
      ? ["clearWindowBackgroundEffect"]
      : ["tabDragEscapeKeyPressed", "windowServerTags"]),
    "setWindowBackgroundEffect",
  ]
  for (const method of methods) {
    if (typeof addon[method] !== "function") {
      throw new Error(`Packaged native addon is missing ${method}()`)
    }
  }
  if (
    process.platform === "darwin" &&
    typeof addon.tabDragEscapeKeyPressed() !== "boolean"
  ) {
    throw new Error("Packaged native addon returned an invalid key state")
  }
}

function capture(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
  return observeChild(child).result
}

function observeChild(child) {
  const stdout = []
  const stderr = []
  child.stdout?.on("data", (chunk) => stdout.push(chunk))
  child.stderr?.on("data", (chunk) => stderr.push(chunk))
  const output = () => ({
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  })
  const result = new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve({ ...value, ...output() })
    }
    child.once("error", (error) => {
      finish({ code: null, error, signal: null })
    })
    child.once("close", (code, signal) => {
      finish({
        code,
        error: null,
        signal,
      })
    })
  })
  return { output, result }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function waitForChild(result, milliseconds, description) {
  let timeout
  try {
    return await Promise.race([
      result,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description}`))
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function stopOwnedChild(child, result) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return result
  }

  child.kill("SIGTERM")
  try {
    return await waitForChild(result, 3_000, "the packaged app to terminate")
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
    return waitForChild(
      result,
      3_000,
      "the packaged app to terminate after SIGKILL"
    )
  }
}

function describeChildResult(result) {
  if (result.error) {
    return result.error instanceof Error
      ? result.error.message
      : String(result.error)
  }
  return result.signal ?? `exit ${result.code ?? "unknown"}`
}

async function verifyPackagedCli(cli, executable, expectedProductName) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pmd-packaged-cli-")
  )
  const expectedCliIdentity = "pulse-md"
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${expectedCliIdentity}-packaged-${process.pid}-${Date.now()}`
      : path.join(temporaryDirectory, `${expectedCliIdentity}-cli.sock`)
  const userDataDirectory = path.join(temporaryDirectory, "user-data")
  const impossibleAppExecutable = path.join(
    temporaryDirectory,
    "helper-must-not-launch-an-app"
  )
  let packagedApp = null
  let packagedAppObservation = null

  try {
    packagedApp = spawn(
      executable,
      [
        `--user-data-dir=${userDataDirectory}`,
        "--pmd-cli-server",
        "--disable-breakpad",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PMD_CLI_ENDPOINT: endpoint,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    packagedAppObservation = observeChild(packagedApp)

    let packagedAppResult = null
    void packagedAppObservation.result.then((result) => {
      packagedAppResult = result
    })

    const deadline = Date.now() + 20_000
    let doctor = null
    while (Date.now() < deadline) {
      if (packagedAppResult) {
        throw new Error(
          `Packaged app exited before its CLI server was ready (${describeChildResult(packagedAppResult)}):\n${
            packagedAppResult.stderr || packagedAppResult.stdout
          }`
        )
      }
      doctor = await capture(cli, ["doctor"], {
        env: {
          ...process.env,
          PMD_APP_EXECUTABLE: impossibleAppExecutable,
          PMD_CLI_ENDPOINT: endpoint,
        },
        timeout: 5_000,
      })
      if (
        doctor.code === 0 &&
        doctor.stdout.startsWith(`${expectedProductName} `)
      ) {
        break
      }
      await delay(50)
    }

    if (
      !doctor ||
      doctor.code !== 0 ||
      !doctor.stdout.startsWith(`${expectedProductName} `)
    ) {
      const appOutput = packagedAppObservation.output()
      throw new Error(
        `Packaged CLI smoke failed (${doctor ? describeChildResult(doctor) : "no helper result"}):\n${
          doctor?.stderr ||
          doctor?.stdout ||
          appOutput.stderr ||
          appOutput.stdout
        }`
      )
    }

    if (
      !doctor.stdout.includes(`Endpoint: ${endpoint}`) ||
      doctor.stdout.includes("Pulse MD Local") ||
      doctor.stdout.includes("pulse-md-local")
    ) {
      throw new Error(
        `Packaged runtime identity is wrong (${describeChildResult(doctor)}):\n${doctor.stderr || doctor.stdout}`
      )
    }

    const appResult = await waitForChild(
      packagedAppObservation.result,
      10_000,
      "the packaged CLI bootstrap to exit"
    )
    if (appResult.code !== 0) {
      throw new Error(
        `Packaged CLI bootstrap failed (${describeChildResult(appResult)}):\n${
          appResult.stderr || appResult.stdout
        }`
      )
    }
  } finally {
    try {
      if (packagedApp && packagedAppObservation) {
        await stopOwnedChild(packagedApp, packagedAppObservation.result)
      }
    } finally {
      await rm(temporaryDirectory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      })
    }
  }
}

function windowsCliIdentityHash(value) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    hash ^= BigInt(codeUnit & 0xff)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    hash ^= BigInt(codeUnit >>> 8)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

function defaultCliEndpoint(cliIdentity, environment) {
  if (process.platform === "win32") {
    const seed =
      environment.APPDATA ||
      environment.USERPROFILE ||
      [environment.USERDOMAIN, environment.USERNAME]
        .filter(Boolean)
        .join("\\") ||
      "unknown-user"
    return `\\\\.\\pipe\\${cliIdentity}-${windowsCliIdentityHash(seed)}-cli-v3`
  }
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error("The packaged CLI smoke requires a numeric user id")
  }
  return path.join("/tmp", `${cliIdentity}-${uid}`, "cli-v3.sock")
}

async function endpointIsLive(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(true)
    }, 500)
    socket.once("connect", () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })
    socket.once("error", (error) => {
      clearTimeout(timeout)
      socket.destroy()
      if (
        error.code === "ECONNREFUSED" ||
        error.code === "ENOENT" ||
        error.code === "ENXIO"
      ) {
        resolve(false)
      } else {
        reject(error)
      }
    })
  })
}

async function waitForEndpointShutdown(endpoint) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await endpointIsLive(endpoint))) return
    await delay(50)
  }
  throw new Error(`Packaged CLI bootstrap did not stop: ${endpoint}`)
}

async function verifyDefaultPackagedCliIdentity(
  cli,
  executable,
  expectedProductName
) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pmd-default-identity-")
  )
  const cliIdentity = "pulse-md"
  const environment = {
    ...process.env,
    APPDATA: path.join(temporaryDirectory, "AppData", "Roaming"),
    HOME: temporaryDirectory,
    LOCALAPPDATA: path.join(temporaryDirectory, "AppData", "Local"),
    USERPROFILE: temporaryDirectory,
    XDG_CONFIG_HOME: path.join(temporaryDirectory, ".config"),
  }
  delete environment.PMD_APP_EXECUTABLE
  delete environment.PMD_CLI_ENDPOINT
  const endpoint = defaultCliEndpoint(cliIdentity, environment)
  await Promise.all([
    mkdir(environment.APPDATA, { recursive: true }),
    mkdir(environment.LOCALAPPDATA, { recursive: true }),
  ])

  const expectedUserDataDirectory =
    process.platform === "win32"
      ? path.join(environment.APPDATA, expectedProductName)
      : process.platform === "darwin"
        ? path.join(
            os.homedir(),
            "Library",
            "Application Support",
            expectedProductName
          )
        : path.join(environment.XDG_CONFIG_HOME, expectedProductName)

  try {
    if (await endpointIsLive(endpoint)) {
      throw new Error(
        `Close the running ${expectedProductName} CLI service before packaged verification: ${endpoint}`
      )
    }

    const doctor = await capture(cli, ["doctor"], {
      env: environment,
      timeout: 20_000,
    })
    if (doctor.code !== 0) {
      throw new Error(
        `Default packaged CLI failed (${describeChildResult(doctor)}):\n${doctor.stderr || doctor.stdout}`
      )
    }

    const lines = doctor.stdout.trimEnd().split(/\r?\n/)
    const value = (label) =>
      lines
        .find((line) => line.startsWith(`${label}: `))
        ?.slice(label.length + 2)
    const profileDirectory = value("Profiles")
    const scratchDirectory = value("Scratch")
    const applicationMatches = await sameCanonicalPath(
      value("Application"),
      executable
    )
    if (
      !doctor.stdout.startsWith(`${expectedProductName} `) ||
      !applicationMatches ||
      value("Packaged") !== "yes" ||
      value("Endpoint") !== endpoint ||
      path.resolve(profileDirectory ?? "") !==
        path.resolve(expectedUserDataDirectory, "cli-profiles") ||
      path.resolve(scratchDirectory ?? "") !==
        path.resolve(expectedUserDataDirectory, "scratch")
    ) {
      throw new Error(
        `Default packaged runtime identity is wrong:\n${doctor.stdout}`
      )
    }

    await waitForEndpointShutdown(endpoint)
  } finally {
    await rm(temporaryDirectory, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    })
  }
}

function runPlaywright(executable) {
  const child = spawn(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "test",
      "tests/e2e/extensions.spec.ts",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, PMD_E2E_EXECUTABLE: executable },
      stdio: "inherit",
    }
  )

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `Packaged Playwright tests failed (${signal ?? `exit ${code ?? "unknown"}`})`
          )
        )
      }
    })
  })
}

const layout = await packagedLayout()
const resources = await verifyPackagedResources(layout.resources)
await verifyPackagedMetadata(layout.resources)
await verifyMacIconPackaging(layout.executable, layout.resources)
await verifyMacPrivacyMetadata(layout.executable)
await verifyMacProtocolRegistration(layout.executable)
await verifyMacIdentity(layout.executable)
await verifyElectronFuses(layout.executable)
verifyNativeAddon(resources.nativeAddon)
await verifyPackagedCli(resources.cli, layout.executable, layout.productName)
await verifyDefaultPackagedCliIdentity(
  resources.cli,
  layout.executable,
  layout.productName
)
await runPlaywright(layout.executable)
