import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  parseWindowsInstallInventory,
  parseWindowsPathInventory,
  parseWindowsShellInventory,
  requireCanonicalWindowsCliPath,
  requireCanonicalWindowsInstallation,
  requireCanonicalWindowsShellRegistrations,
  windowsInstallerIdentity,
  windowsInstallerInvocation,
  windowsInstallInventoryInvocation,
  windowsPathInventoryInvocation,
  windowsShellInventoryInvocation,
} from "./windows-installer-launch.mjs"
import {
  archIconSizes,
  archPackageIconPath,
  archPackageLayout,
  archPackageVersion,
  packageArchRuntime,
} from "./package-arch.mjs"

const projectRoot = path.resolve(import.meta.dirname, "..")
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)
const macInstalledApp = "/Applications/Pulse MD.app"
const bundleIdentifier = "io.github.mapleroyal.pulse-md"
const linuxDesktopName = `${bundleIdentifier}.desktop`
const linuxIconSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512]
const productName = "Pulse MD"
const releaseDirectory = path.join(projectRoot, "release")
const require = createRequire(import.meta.url)
const { extractFile, uncache } = require("@electron/asar")

function failure(label, result) {
  const detail = result.error?.message || result.stderr || result.stdout
  return new Error(
    `${label} failed${result.status === null ? "" : ` (exit ${result.status})`}${
      detail ? `\n${String(detail).trim()}` : ""
    }`
  )
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error || result.status !== 0) {
    throw failure(options.label || command, result)
  }
  return result
}

function runVisible(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: options.env,
    stdio: "inherit",
  })
  if (result.error || result.status !== 0) {
    throw failure(options.label || command, result)
  }
}

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    throw new Error("Run installation through `npm run install:local`")
  }
  return [process.execPath, [npmCli, ...args]]
}

function builderInvocation(args) {
  return [
    process.execPath,
    [
      path.join(projectRoot, "node_modules", "electron-builder", "cli.js"),
      ...args,
    ],
  ]
}

export function isArchLinuxRelease(osRelease) {
  const values = new Map()
  for (const line of String(osRelease).split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return [values.get("ID"), ...(values.get("ID_LIKE") || "").split(/\s+/)]
    .filter(Boolean)
    .includes("arch")
}

function isArchLinuxHost() {
  if (process.platform !== "linux") return false
  try {
    return isArchLinuxRelease(readFileSync("/etc/os-release", "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function pathStat(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function requireRegularDirectory(target, description) {
  const stat = pathStat(target)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${description} is not a regular directory: ${target}`)
  }
}

function requireRegularFile(target, description) {
  const stat = pathStat(target)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${description} is not a regular file: ${target}`)
  }
}

function fileSha256(target, description) {
  requireRegularFile(target, description)
  return createHash("sha256").update(readFileSync(target)).digest("hex")
}

function assertMatchingFile(source, installed, description) {
  if (
    fileSha256(source, `Packaged ${description}`) !==
    fileSha256(installed, `Installed ${description}`)
  ) {
    throw new Error(`Installed ${description} does not match ${source}`)
  }
}

function plistValue(appBundle, key) {
  return run("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(appBundle, "Contents", "Info.plist"),
  ]).stdout.trim()
}

function validateMacBundle(
  appBundle,
  {
    canonicalName = true,
    currentVersion = true,
    requireAdaptiveIcon = true,
    requireHelper = true,
  } = {}
) {
  requireRegularDirectory(appBundle, "Pulse MD app bundle")
  if (canonicalName && path.basename(appBundle) !== `${productName}.app`) {
    throw new Error(`Unexpected app bundle name: ${appBundle}`)
  }
  if (plistValue(appBundle, "CFBundleIdentifier") !== bundleIdentifier) {
    throw new Error(`Unexpected bundle identifier: ${appBundle}`)
  }
  if (
    currentVersion &&
    plistValue(appBundle, "CFBundleShortVersionString") !==
      packageMetadata.version
  ) {
    throw new Error(`Unexpected app version: ${appBundle}`)
  }
  const requiredExecutables = [
    path.join(appBundle, "Contents", "MacOS", productName),
    ...(requireHelper
      ? [path.join(appBundle, "Contents", "Resources", "bin", "pmd")]
      : []),
  ]
  for (const required of requiredExecutables) {
    requireRegularFile(required, "Required executable")
  }
  if (requireAdaptiveIcon) {
    if (plistValue(appBundle, "CFBundleIconName") !== "Icon") {
      throw new Error(
        `Packaged app does not declare its adaptive icon: ${appBundle}`
      )
    }
    const configuredIconFile = plistValue(appBundle, "CFBundleIconFile")
    if (!configuredIconFile) {
      throw new Error(
        `Packaged app does not declare its fallback icon: ${appBundle}`
      )
    }
    const fallbackIconName = configuredIconFile.endsWith(".icns")
      ? configuredIconFile
      : `${configuredIconFile}.icns`
    const resources = path.join(appBundle, "Contents", "Resources")
    requireRegularFile(
      path.join(resources, "Assets.car"),
      "Icon Composer asset catalog"
    )
    requireRegularFile(
      path.join(resources, fallbackIconName),
      "Legacy icon fallback"
    )
  }
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appBundle,
  ])
}

function discoverAppBundles(root) {
  requireRegularDirectory(root, "package build output")
  const apps = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const target = path.join(current, entry.name)
      if (entry.name.endsWith(".app")) apps.push(target)
      else pending.push(target)
    }
  }
  return apps
}

function assertPulseMdIsNotRunning() {
  const processes = run("/bin/ps", ["-axo", "pid=,command="])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => /\/Contents\/MacOS\/Pulse MD(?:\s|$)/.test(line))
  if (processes.length > 0) {
    throw new Error(`Quit Pulse MD before installing:\n${processes.join("\n")}`)
  }
}

async function waitForPulseMdToStop() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      assertPulseMdIsNotRunning()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assertPulseMdIsNotRunning()
}

function verifyPackagedRuntime(packagedRoot, environment = {}) {
  const [npm, args] = npmInvocation(["run", "test:packaged"])
  runVisible(npm, args, {
    env: { ...process.env, ...environment, PMD_PACKAGED_ROOT: packagedRoot },
    label: `packaged verification for ${packagedRoot}`,
  })
}

function verifyDefaultCli(appBundle) {
  const helper = path.join(appBundle, "Contents", "Resources", "bin", "pmd")
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["PMD_APP_EXECUTABLE", "PMD_CLI_ENDPOINT"].includes(name)
    )
  )
  const result = run(helper, ["doctor"], {
    env: cleanEnvironment,
    label: "installed pmd doctor",
  })
  if (!result.stdout.includes(`${productName} ${packageMetadata.version}`)) {
    throw new Error(`pmd reached the wrong app:\n${result.stdout}`)
  }
  if (!result.stdout.includes("pulse-md-")) {
    throw new Error(`pmd reported the wrong endpoint:\n${result.stdout}`)
  }
  const expectedExecutable = path.join(
    appBundle,
    "Contents",
    "MacOS",
    productName
  )
  if (!result.stdout.includes(`Application: ${expectedExecutable}\n`)) {
    throw new Error(`pmd launched another app:\n${result.stdout}`)
  }
}

function removeManagedDirectory(target, expectedParent) {
  if (!target || path.dirname(target) !== expectedParent) {
    throw new Error(`Refusing unmanaged cleanup target: ${target}`)
  }
  const stat = pathStat(target)
  if (!stat) return
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unexpected cleanup target: ${target}`)
  }
  rmSync(target, { recursive: true })
}

function macBundleIdentifier(appBundle) {
  try {
    return plistValue(appBundle, "CFBundleIdentifier")
  } catch {
    return null
  }
}

function validateBundleOwnership(appBundle) {
  validateBundleShell(appBundle)
  const metadata = JSON.parse(
    extractFile(
      path.join(appBundle, "Contents", "Resources", "app.asar"),
      "package.json"
    ).toString("utf8")
  )
  const canonicalMetadata =
    metadata.pmdDistributionChannel === "canonical" &&
    metadata.name === "pulse-md" &&
    metadata.productName === productName
  if (!canonicalMetadata) {
    throw new Error(`Refusing unverified Pulse MD app bundle: ${appBundle}`)
  }
}

function validateBundleShell(appBundle) {
  requireRegularDirectory(appBundle, "Pulse MD app bundle")
  if (macBundleIdentifier(appBundle) !== bundleIdentifier) {
    throw new Error(`Refusing non-Pulse MD app bundle: ${appBundle}`)
  }
  const executable = path.join(appBundle, "Contents", "MacOS", productName)
  const executableStat = pathStat(executable)
  if (!executableStat?.isFile() || executableStat.isSymbolicLink()) {
    throw new Error(`Pulse MD executable is missing: ${executable}`)
  }
}

function canonicalPath(target) {
  try {
    return realpathSync.native(target)
  } catch (error) {
    if (error?.code === "ENOENT") return path.resolve(target)
    throw error
  }
}

function registeredSetHasPath(registrations, target) {
  const canonicalTarget = canonicalPath(target)
  return [...registrations].some(
    (candidate) => canonicalPath(candidate) === canonicalTarget
  )
}

function unregisterBundleIfRegistered(launchServicesTool, target) {
  if (
    !registeredSetHasPath(
      registeredPulseMdMacBundles(launchServicesTool),
      target
    )
  )
    return
  run(launchServicesTool, ["-u", target], {
    label: `unregistering Pulse MD bundle ${target}`,
  })
}

function pulseMdMacBundlesUnder(root, maximumDepth) {
  const bundles = []
  const pending = [{ depth: 0, target: root }]
  while (pending.length > 0) {
    const { depth, target } = pending.pop()
    const stat = pathStat(target)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue
    if (target.endsWith(".app")) {
      if (macBundleIdentifier(target) === bundleIdentifier) {
        bundles.push(target)
      }
      continue
    }
    if (depth >= maximumDepth) continue
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      pending.push({ depth: depth + 1, target: path.join(target, entry.name) })
    }
  }
  return bundles
}

function registeredPulseMdMacBundles(launchServicesTool) {
  const registrations = new Set()
  let currentPath = null
  for (const line of run(launchServicesTool, ["-dump"]).stdout.split("\n")) {
    const pathMatch = /^path:\s+(.+?)(?: \(0x[0-9a-f]+\))?$/.exec(line)
    if (pathMatch) {
      currentPath = pathMatch[1]
      continue
    }
    if (
      currentPath &&
      /^identifier:\s+io\.github\.mapleroyal\.pulse-md$/.test(line)
    ) {
      registrations.add(currentPath)
    }
  }
  return registrations
}

function cleanManagedMacDuplicates(launchServicesTool, managedRoot) {
  const roots = [
    { depth: 5, path: releaseDirectory },
    { depth: 4, path: managedRoot },
    { depth: 7, path: path.join(os.homedir(), ".Trash") },
  ]
  const discovered = new Set(
    roots.flatMap(({ depth, path: root }) =>
      pulseMdMacBundlesUnder(root, depth)
    )
  )
  const registered = registeredPulseMdMacBundles(launchServicesTool)
  const candidates = [...new Set([...discovered, ...registered])]
    .filter(
      (target) => canonicalPath(target) !== canonicalPath(macInstalledApp)
    )
    .sort()

  for (const target of candidates) {
    const stat = pathStat(target)
    if (stat) {
      const managed = roots.some(({ path: root }) => {
        const relative = path.relative(
          canonicalPath(root),
          canonicalPath(target)
        )
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        )
      })
      if (!managed) {
        const resolvedTarget = canonicalPath(target)
        if (
          resolvedTarget.startsWith(`${canonicalPath(os.tmpdir())}${path.sep}`)
        ) {
          // Stale package-verification bundles are never deleted outside the
          // bounded managed roots. Their exact Pulse MD shell is enough to
          // safely remove only the Launch Services registration.
          validateBundleShell(target)
          if (registered.has(target)) {
            run(launchServicesTool, ["-u", target], {
              label: `unregistering temporary Pulse MD bundle ${target}`,
            })
          }
          continue
        }
        throw new Error(`Unmanaged Pulse MD duplicate remains: ${target}`)
      }
      validateBundleOwnership(target)
    }
    if (registered.has(target)) {
      run(launchServicesTool, ["-u", target], {
        label: `unregistering duplicate Pulse MD bundle ${target}`,
      })
    }
    if (stat) rmSync(target, { recursive: true })
  }
}

function defaultApplicationForUrl(url) {
  const script = [
    'ObjC.import("AppKit")',
    `const url = $.NSURL.URLWithString(${JSON.stringify(url)})`,
    "const application = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url)",
    'application.path ? ObjC.unwrap(application.path) : ""',
  ].join("; ")
  return run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
  ]).stdout.trim()
}

async function waitForProtocolRegistration() {
  const address = "pulse-md://scratch/11111111-1111-4111-8111-111111111111"
  const deadline = Date.now() + 10_000
  let resolved = ""
  while (Date.now() < deadline) {
    resolved = defaultApplicationForUrl(address)
    if (path.resolve(resolved || "/") === macInstalledApp) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    resolved
      ? `pulse-md URLs resolve to ${resolved}, expected ${macInstalledApp}`
      : "pulse-md URLs do not resolve to the installed app"
  )
}

function assertSoleRegistration(launchServicesTool) {
  const registrations = [...registeredPulseMdMacBundles(launchServicesTool)]
  const duplicates = registrations.filter(
    (target) => canonicalPath(target) !== canonicalPath(macInstalledApp)
  )
  if (duplicates.length > 0) {
    throw new Error(
      `Stale Pulse MD registrations remain:\n${duplicates.join("\n")}`
    )
  }
  if (
    !registrations.some(
      (target) => canonicalPath(target) === canonicalPath(macInstalledApp)
    )
  ) {
    throw new Error(`Pulse MD is not registered at ${macInstalledApp}`)
  }
}

function installMacCandidate(candidate, token) {
  const applications = path.dirname(macInstalledApp)
  const incoming = path.join(applications, `.Pulse MD.incoming-${token}.app`)
  const previous = path.join(applications, `.Pulse MD.previous-${token}`)
  if (pathStat(incoming) || pathStat(previous)) {
    throw new Error("An install staging path already exists")
  }

  const existing = pathStat(macInstalledApp)
  let movedPrevious = false
  let installedIncoming = false
  try {
    run("/usr/bin/ditto", [candidate, incoming], {
      label: "copying Pulse MD into Applications",
    })
    validateMacBundle(incoming, { canonicalName: false })
    if (existing) {
      try {
        validateMacBundle(macInstalledApp, {
          currentVersion: false,
          requireAdaptiveIcon: false,
          requireHelper: false,
        })
      } catch (error) {
        throw new Error(
          `Refusing to replace an unexpected app at ${macInstalledApp}: ${error.message}`,
          { cause: error }
        )
      }
    }
    if (existing) {
      renameSync(macInstalledApp, previous)
      movedPrevious = true
    }
    renameSync(incoming, macInstalledApp)
    installedIncoming = true
    validateMacBundle(macInstalledApp)
    return { previous: movedPrevious ? previous : null }
  } catch (error) {
    if (installedIncoming && pathStat(macInstalledApp)) {
      removeManagedDirectory(macInstalledApp, applications)
    } else if (pathStat(incoming)) {
      removeManagedDirectory(incoming, applications)
    }
    if (movedPrevious && pathStat(previous) && !pathStat(macInstalledApp)) {
      renameSync(previous, macInstalledApp)
    }
    throw error
  }
}

function buildPackageTo(outputDirectory) {
  if (process.platform === "darwin") {
    const [npm, npmArgs] = npmInvocation(["run", "icon:build"])
    runVisible(npm, npmArgs, { label: "adaptive macOS icon build" })
  }
  const [npm, npmArgs] = npmInvocation(["run", "build"])
  runVisible(npm, npmArgs, { label: "application build" })
  const platformArgument = {
    darwin: "--mac",
    linux: "--linux",
    win32: "--win",
  }[process.platform]
  if (!platformArgument) {
    throw new Error(
      `Pulse MD installation is unsupported on ${process.platform}`
    )
  }
  const [builder, builderArgs] = builderInvocation([
    platformArgument,
    ...(process.platform === "darwin" || process.platform === "linux"
      ? ["dir"]
      : []),
    "--config",
    "electron-builder.local.cjs",
    `--config.directories.output=${outputDirectory}`,
    "--publish",
    "never",
  ])
  runVisible(builder, builderArgs, {
    env: {
      ...process.env,
      ...(process.platform === "darwin"
        ? {
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            PMD_ICON_COMPOSER_BUILD: "1",
          }
        : {}),
    },
    label: "Pulse MD electron-builder package",
  })
}

async function installMac() {
  const applications = path.dirname(macInstalledApp)
  requireRegularDirectory(applications, "Applications directory")
  assertPulseMdIsNotRunning()
  const managedRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Pulse MD Build Tests"
  )
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 })
  requireRegularDirectory(managedRoot, "build-test directory")
  const stagingDirectory = mkdtempSync(path.join(managedRoot, "install-"))
  const token = `${process.pid}-${randomUUID()}`
  let previous = null
  let installed = false

  try {
    const launchServicesTool =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    cleanManagedMacDuplicates(launchServicesTool, managedRoot)
    buildPackageTo(stagingDirectory)
    const candidates = discoverAppBundles(stagingDirectory)
    if (candidates.length !== 1) {
      throw new Error(`Expected one app candidate, found ${candidates.length}`)
    }
    validateMacBundle(candidates[0])
    try {
      verifyPackagedRuntime(candidates[0])
    } finally {
      unregisterBundleIfRegistered(launchServicesTool, candidates[0])
    }
    assertPulseMdIsNotRunning()

    const installation = installMacCandidate(candidates[0], token)
    previous = installation.previous
    installed = true
    verifyPackagedRuntime(macInstalledApp)
    verifyDefaultCli(macInstalledApp)
    await waitForPulseMdToStop()

    removeManagedDirectory(stagingDirectory, managedRoot)
    if (previous) {
      unregisterBundleIfRegistered(launchServicesTool, previous)
    }
    run(launchServicesTool, ["-f", macInstalledApp], {
      label: "registering Pulse MD",
    })
    await waitForProtocolRegistration()
    assertSoleRegistration(launchServicesTool)
    installed = false
    if (previous) {
      removeManagedDirectory(previous, applications)
      previous = null
    }
    console.log(`Installed and verified ${macInstalledApp}`)
  } catch (error) {
    if (installed && pathStat(macInstalledApp)) {
      validateBundleShell(macInstalledApp)
      removeManagedDirectory(macInstalledApp, applications)
    }
    if (previous && pathStat(previous) && !pathStat(macInstalledApp)) {
      validateBundleShell(previous)
      renameSync(previous, macInstalledApp)
      run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-f", macInstalledApp],
        { label: "restoring the previous Pulse MD registration" }
      )
    }
    throw error
  } finally {
    if (pathStat(stagingDirectory)) {
      removeManagedDirectory(stagingDirectory, managedRoot)
    }
  }
}

function windowsProcessPaths() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = Get-CimInstance Win32_Process -Filter \"Name = 'Pulse MD.exe'\"",
    "$items | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } }",
  ].join("; ")
  return run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { label: "checking running Pulse MD processes" }
  )
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function assertWindowsPulseMdIsNotRunning() {
  const processes = windowsProcessPaths()
  if (processes.length > 0) {
    throw new Error(`Quit Pulse MD before installing:\n${processes.join("\n")}`)
  }
}

async function waitForWindowsPulseMdToStop() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      assertWindowsPulseMdIsNotRunning()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assertWindowsPulseMdIsNotRunning()
}

function windowsInstallation(identity) {
  const invocation = windowsInstallInventoryInvocation({ identity })
  const result = run(invocation.command, invocation.args, {
    env: invocation.env,
    label: "inventorying Pulse MD installations",
  })
  return requireCanonicalWindowsInstallation(
    parseWindowsInstallInventory(result.stdout),
    identity
  )
}

function assertCanonicalWindowsPath(expectedDirectory) {
  const invocation = windowsPathInventoryInvocation()
  const result = run(invocation.command, invocation.args, {
    env: invocation.env,
    label: "inventorying the Windows PATH",
  })
  requireCanonicalWindowsCliPath(
    parseWindowsPathInventory(result.stdout),
    expectedDirectory
  )
}

function assertCanonicalWindowsShell(installationRoot, identity) {
  const invocation = windowsShellInventoryInvocation({ identity })
  const result = run(invocation.command, invocation.args, {
    env: invocation.env,
    label: "inventorying Windows shell registrations",
  })
  requireCanonicalWindowsShellRegistrations(
    parseWindowsShellInventory(result.stdout),
    installationRoot,
    identity
  )
}

function windowsPackagedRuntimeRoot(outputDirectory) {
  requireRegularDirectory(outputDirectory, "package build output")
  const roots = readdirSync(outputDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.isDirectory() &&
        /^win.*-unpacked$/.test(entry.name)
    )
    .map((entry) => path.join(outputDirectory, entry.name))
    .filter((root) => pathStat(path.join(root, `${productName}.exe`))?.isFile())
  if (roots.length !== 1) {
    throw new Error(
      `Expected one unpacked Windows Pulse MD runtime, found ${roots.length}`
    )
  }
  return roots[0]
}

function absoluteXdgDirectory(configured, fallback, description) {
  const target = configured || fallback
  if (!path.isAbsolute(target)) {
    throw new Error(`${description} must be an absolute path: ${target}`)
  }
  return path.normalize(target)
}

export function linuxInstallLayout({
  configHome,
  dataHome,
  homeDirectory = os.homedir(),
} = {}) {
  if (!path.isAbsolute(homeDirectory)) {
    throw new Error(`Home directory must be an absolute path: ${homeDirectory}`)
  }
  const normalizedHome = path.normalize(homeDirectory)
  const resolvedConfigHome = absoluteXdgDirectory(
    configHome ?? process.env.XDG_CONFIG_HOME,
    path.join(normalizedHome, ".config"),
    "XDG_CONFIG_HOME"
  )
  const resolvedDataHome = absoluteXdgDirectory(
    dataHome ?? process.env.XDG_DATA_HOME,
    path.join(normalizedHome, ".local", "share"),
    "XDG_DATA_HOME"
  )
  const installationRoot = path.join(
    normalizedHome,
    ".local",
    "lib",
    "pulse-md"
  )
  const iconThemeRoot = path.join(resolvedDataHome, "icons", "hicolor")
  return {
    applicationsDirectory: path.join(resolvedDataHome, "applications"),
    cli: path.join(normalizedHome, ".local", "bin", "pmd"),
    configHome: resolvedConfigHome,
    desktop: path.join(resolvedDataHome, "applications", linuxDesktopName),
    executable: path.join(installationRoot, "pulse-md"),
    helper: path.join(installationRoot, "resources", "bin", "pmd"),
    iconThemeRoot,
    icons: new Map(
      linuxIconSizes.map((size) => [
        size,
        path.join(iconThemeRoot, `${size}x${size}`, "apps", "pulse-md.png"),
      ])
    ),
    installationRoot,
    mimeApps: path.join(resolvedConfigHome, "mimeapps.list"),
    mimePackage: path.join(
      resolvedDataHome,
      "mime",
      "packages",
      `${bundleIdentifier}.xml`
    ),
    mimeRoot: path.join(resolvedDataHome, "mime"),
  }
}

export function archLinuxInstallLayout() {
  const iconThemeRoot = "/usr/share/icons/hicolor"
  return {
    applicationsDirectory: "/usr/share/applications",
    cli: archPackageLayout.cli,
    command: archPackageLayout.guiCommand,
    desktop: archPackageLayout.desktop,
    executable: archPackageLayout.executable,
    helper: archPackageLayout.helper,
    iconThemeRoot,
    icons: new Map(
      archIconSizes.map((size) => [size, archPackageIconPath(size)])
    ),
    installationRoot: archPackageLayout.runtimeRoot,
    license: archPackageLayout.license,
    mimePackage: archPackageLayout.mime,
    mimeRoot: "/usr/share/mime",
  }
}

function quoteDesktopExecArgument(value) {
  if (!path.isAbsolute(value) || /[\n\r\0]/.test(value)) {
    throw new Error(`Invalid desktop executable path: ${value}`)
  }
  const escapedPercent = value.replaceAll("%", "%%")
  if (/^[A-Za-z0-9_./:@+-]+$/.test(escapedPercent)) return escapedPercent
  return `"${escapedPercent
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")}"`
}

export function linuxDesktopEntry(executable) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${productName}`,
    "GenericName=Markdown Reader and Editor",
    `Comment=${packageMetadata.description}`,
    `Exec=${quoteDesktopExecArgument(executable)} %U`,
    "Icon=pulse-md",
    "Terminal=false",
    "StartupNotify=true",
    `StartupWMClass=${bundleIdentifier}`,
    "Categories=Utility;TextEditor;",
    "Keywords=markdown;read;write;notes;text;editor;",
    "MimeType=text/markdown;x-scheme-handler/pulse-md;",
    "",
  ].join("\n")
}

export function linuxMimePackage() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    '  <mime-type type="text/markdown">',
    "    <comment>Markdown document</comment>",
    '    <glob pattern="*.mdown" weight="80"/>',
    "  </mime-type>",
    "</mime-info>",
    "",
  ].join("\n")
}

function requireExecutableFile(target, description) {
  requireRegularFile(target, description)
  if ((lstatSync(target).mode & 0o111) === 0) {
    throw new Error(`${description} is not executable: ${target}`)
  }
}

function linuxRuntimeMetadata(installationRoot) {
  const asar = path.join(installationRoot, "resources", "app.asar")
  requireRegularFile(asar, "Pulse MD app.asar")
  uncache(asar)
  try {
    return JSON.parse(extractFile(asar, "package.json").toString("utf8"))
  } catch (error) {
    throw new Error(`Invalid packaged metadata in ${asar}: ${error.message}`, {
      cause: error,
    })
  } finally {
    uncache(asar)
  }
}

function validateLinuxRuntime(
  installationRoot,
  { currentVersion = true } = {}
) {
  requireRegularDirectory(installationRoot, "Pulse MD Linux runtime")
  requireExecutableFile(
    path.join(installationRoot, "pulse-md"),
    "Pulse MD executable"
  )
  requireExecutableFile(
    path.join(installationRoot, "resources", "bin", "pmd"),
    "Pulse MD CLI helper"
  )
  const metadata = linuxRuntimeMetadata(installationRoot)
  if (
    metadata.pmdDistributionChannel !== "canonical" ||
    metadata.name !== "pulse-md" ||
    metadata.productName !== productName
  ) {
    throw new Error(`Refusing unverified Pulse MD runtime: ${installationRoot}`)
  }
  if (currentVersion && metadata.version !== packageMetadata.version) {
    throw new Error(
      `Unexpected Pulse MD version ${String(metadata.version)} at ${installationRoot}`
    )
  }
}

function linuxPackagedRuntimeRoot(outputDirectory) {
  requireRegularDirectory(outputDirectory, "package build output")
  const roots = readdirSync(outputDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.isDirectory() &&
        /^linux.*-unpacked$/.test(entry.name)
    )
    .map((entry) => path.join(outputDirectory, entry.name))
    .filter((root) => pathStat(path.join(root, "pulse-md"))?.isFile())
  if (roots.length !== 1) {
    throw new Error(
      `Expected one unpacked Linux Pulse MD runtime, found ${roots.length}`
    )
  }
  validateLinuxRuntime(roots[0])
  return roots[0]
}

function ownedAppImageCliWrapper(target, helper) {
  const stat = pathStat(target)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    return false
  }
  const source = readFileSync(target, "utf8")
  return (
    source.includes(`# ${productName} pmd AppImage launcher`) &&
    source.includes(helper)
  )
}

function validateExistingLinuxInstall(installationRoot, cli) {
  const asar = path.join(installationRoot, "resources", "app.asar")
  if (pathStat(asar)) {
    validateLinuxRuntime(installationRoot, { currentVersion: false })
    return
  }

  requireRegularDirectory(installationRoot, "existing Linux install target")
  const entries = readdirSync(installationRoot)
  const appImageHelper = path.join(installationRoot, "pmd-helper")
  if (
    entries.length !== 1 ||
    entries[0] !== "pmd-helper" ||
    !ownedAppImageCliWrapper(cli, appImageHelper)
  ) {
    throw new Error(
      `Refusing to replace an unverified directory: ${installationRoot}`
    )
  }
  requireExecutableFile(appImageHelper, "AppImage CLI helper")
}

function validateExistingLinuxRuntimePath(installationRoot) {
  const asar = path.join(installationRoot, "resources", "app.asar")
  if (pathStat(asar)) {
    validateLinuxRuntime(installationRoot, { currentVersion: false })
    return
  }
  requireRegularDirectory(installationRoot, "existing Linux install target")
  const entries = readdirSync(installationRoot)
  const helper = path.join(installationRoot, "pmd-helper")
  if (entries.length !== 1 || entries[0] !== "pmd-helper") {
    throw new Error(
      `Refusing to replace an unverified directory: ${installationRoot}`
    )
  }
  requireExecutableFile(helper, "AppImage CLI helper")
}

function validateExistingLinuxCli(target, layout) {
  const stat = pathStat(target)
  if (!stat) return
  if (stat.isFile() && !stat.isSymbolicLink()) {
    if (
      !ownedAppImageCliWrapper(
        target,
        path.join(layout.installationRoot, "pmd-helper")
      )
    ) {
      throw new Error(`Refusing to replace an unverified command: ${target}`)
    }
    return
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`Refusing unexpected command target: ${target}`)
  }

  const resolved = path.resolve(path.dirname(target), readlinkSync(target))
  if (resolved === layout.helper) return
  const binDirectory = path.dirname(resolved)
  const resourcesDirectory = path.dirname(binDirectory)
  if (
    path.basename(resolved) !== "pmd" ||
    path.basename(binDirectory) !== "bin" ||
    path.basename(resourcesDirectory) !== "resources"
  ) {
    throw new Error(`Refusing to replace an unverified command link: ${target}`)
  }
  validateLinuxRuntime(path.dirname(resourcesDirectory), {
    currentVersion: false,
  })
}

function validateReplaceableFile(target, description) {
  const stat = pathStat(target)
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} is not a regular file: ${target}`)
  }
}

function validateExactTextFile(target, expected, description) {
  validateReplaceableFile(target, description)
  if (readFileSync(target, "utf8") !== expected) {
    throw new Error(`Refusing to replace a modified ${description}: ${target}`)
  }
}

function stageLegacyLinuxRemoval(layout, transaction) {
  const targets = []
  if (pathStat(layout.installationRoot)) {
    validateExistingLinuxInstall(layout.installationRoot, layout.cli)
  }
  const stage = (target, validateExisting) => {
    if (transaction.stage({ target, validateExisting })) targets.push(target)
  }

  stage(layout.cli, (target) => validateExistingLinuxCli(target, layout))
  stage(layout.desktop, (target) =>
    validateExactTextFile(
      target,
      linuxDesktopEntry(layout.executable),
      "Pulse MD desktop entry"
    )
  )
  stage(layout.mimePackage, (target) =>
    validateExactTextFile(target, linuxMimePackage(), "Pulse MD MIME package")
  )
  for (const [size, target] of layout.icons) {
    const source = path.join(
      projectRoot,
      "build",
      "icons",
      "linux",
      `${size}x${size}.png`
    )
    stage(target, (existing) =>
      assertMatchingFile(source, existing, `${size}px Linux icon`)
    )
  }
  stage(layout.installationRoot, validateExistingLinuxRuntimePath)
  return targets
}

function removeManagedPath(target, expectedParent) {
  if (!target || path.dirname(target) !== expectedParent) {
    throw new Error(`Refusing unmanaged cleanup target: ${target}`)
  }
  const stat = pathStat(target)
  if (!stat) return
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(target, { recursive: true })
  } else {
    rmSync(target)
  }
}

export class LinuxInstallTransaction {
  constructor(token) {
    this.entries = []
    this.token = token
    this.committed = false
  }

  stage({ create, target, validateExisting, validateIncoming }) {
    const parent = path.dirname(target)
    mkdirSync(parent, { mode: 0o755, recursive: true })
    requireRegularDirectory(parent, "Linux install directory")
    const extension = path.extname(target)
    const stem = path.basename(target, extension)
    const incoming = path.join(
      parent,
      `.${stem}.incoming-${this.token}${extension}`
    )
    const previous = path.join(
      parent,
      `.${path.basename(target)}.previous-${this.token}`
    )
    if (pathStat(incoming) || pathStat(previous)) {
      throw new Error(`An install staging path already exists for ${target}`)
    }
    const hadExisting = Boolean(pathStat(target))
    if (hadExisting) validateExisting(target)
    try {
      create(incoming)
      validateIncoming(incoming)
    } catch (error) {
      removeManagedPath(incoming, parent)
      throw error
    }
    this.entries.push({
      hadExisting,
      incoming,
      installed: false,
      movedPrevious: false,
      parent,
      previous,
      target,
      validateExisting,
    })
    return incoming
  }

  apply() {
    try {
      for (const entry of this.entries) {
        const existing = pathStat(entry.target)
        if (Boolean(existing) !== entry.hadExisting) {
          throw new Error(
            `Install target changed while staging: ${entry.target}`
          )
        }
        if (existing) {
          entry.validateExisting(entry.target)
          renameSync(entry.target, entry.previous)
          entry.movedPrevious = true
        }
        renameSync(entry.incoming, entry.target)
        entry.installed = true
      }
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  rollback() {
    if (this.committed) return
    for (const entry of [...this.entries].reverse()) {
      if (entry.installed) {
        removeManagedPath(entry.target, entry.parent)
        entry.installed = false
      }
      if (entry.movedPrevious) {
        if (pathStat(entry.target)) {
          throw new Error(
            `Cannot restore occupied install target: ${entry.target}`
          )
        }
        renameSync(entry.previous, entry.target)
        entry.movedPrevious = false
      }
      removeManagedPath(entry.incoming, entry.parent)
    }
  }

  commit() {
    if (this.entries.some((entry) => !entry.installed)) {
      throw new Error(
        "Cannot commit an installation that was not fully applied"
      )
    }
    // Removing the rollback copies is the point of no return. Mark the
    // installation committed first so a later cleanup failure can never
    // delete new targets whose previous copies are already gone.
    this.committed = true
    const cleanupErrors = []
    for (const entry of this.entries) {
      try {
        removeManagedPath(entry.previous, entry.parent)
        entry.movedPrevious = false
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        removeManagedPath(entry.incoming, entry.parent)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Committed installation cleanup failed:\n${cleanupErrors
          .map((error) => error.message)
          .join("\n")}`,
        { cause: cleanupErrors[0] }
      )
    }
  }
}

export class LinuxRemovalTransaction {
  constructor(token) {
    this.entries = []
    this.token = token
    this.committed = false
  }

  stage({ target, validateExisting }) {
    const stat = pathStat(target)
    if (!stat) return false
    const parent = path.dirname(target)
    requireRegularDirectory(parent, "Linux install directory")
    validateExisting(target)
    const previous = path.join(
      parent,
      `.${path.basename(target)}.previous-${this.token}`
    )
    if (pathStat(previous)) {
      throw new Error(`A removal staging path already exists for ${target}`)
    }
    this.entries.push({
      moved: false,
      parent,
      previous,
      target,
      validateExisting,
    })
    return true
  }

  apply() {
    try {
      for (const entry of this.entries) {
        if (!pathStat(entry.target)) {
          throw new Error(
            `Removal target changed while staging: ${entry.target}`
          )
        }
        entry.validateExisting(entry.target)
        renameSync(entry.target, entry.previous)
        entry.moved = true
      }
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  rollback() {
    if (this.committed) return
    for (const entry of [...this.entries].reverse()) {
      if (!entry.moved) continue
      if (pathStat(entry.target)) {
        throw new Error(
          `Cannot restore occupied removal target: ${entry.target}`
        )
      }
      renameSync(entry.previous, entry.target)
      entry.moved = false
    }
  }

  commit() {
    if (this.entries.some((entry) => !entry.moved)) {
      throw new Error("Cannot commit a removal that was not fully applied")
    }
    this.committed = true
    const cleanupErrors = []
    for (const entry of this.entries) {
      try {
        removeManagedPath(entry.previous, entry.parent)
        entry.moved = false
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Committed removal cleanup failed:\n${cleanupErrors
          .map((error) => error.message)
          .join("\n")}`,
        { cause: cleanupErrors[0] }
      )
    }
  }
}

function linuxExecutableProcessIds(executable) {
  if (!pathStat(executable)) return []
  const expected = canonicalPath(executable)
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .filter((entry) => {
      try {
        return canonicalPath(path.join("/proc", entry.name, "exe")) === expected
      } catch {
        return false
      }
    })
    .map((entry) => entry.name)
}

function assertLinuxPulseMdIsNotRunning(executable) {
  const processIds = linuxExecutableProcessIds(executable)
  if (processIds.length > 0) {
    throw new Error(
      `Quit Pulse MD before installing (processes ${processIds.join(", ")})`
    )
  }
}

async function waitForLinuxPulseMdToStop(executable) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (linuxExecutableProcessIds(executable).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assertLinuxPulseMdIsNotRunning(executable)
}

function snapshotFile(target) {
  let snapshotTarget = target
  const initial = pathStat(target)
  if (initial?.isSymbolicLink()) snapshotTarget = realpathSync.native(target)
  const stat = pathStat(snapshotTarget)
  if (!stat) return { existed: false, target: snapshotTarget }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Cannot snapshot non-file preference: ${snapshotTarget}`)
  }
  return {
    contents: readFileSync(snapshotTarget),
    existed: true,
    mode: stat.mode & 0o777,
    target: snapshotTarget,
  }
}

function restoreFileSnapshot(snapshot) {
  const parent = path.dirname(snapshot.target)
  mkdirSync(parent, { mode: 0o755, recursive: true })
  requireRegularDirectory(parent, "preference directory")
  if (!snapshot.existed) {
    const stat = pathStat(snapshot.target)
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Cannot restore preference: ${snapshot.target}`)
      }
      rmSync(snapshot.target)
    }
    return
  }
  const incoming = path.join(
    parent,
    `.${path.basename(snapshot.target)}.restore-${process.pid}-${randomUUID()}`
  )
  try {
    writeFileSync(incoming, snapshot.contents, { mode: snapshot.mode })
    chmodSync(incoming, snapshot.mode)
    renameSync(incoming, snapshot.target)
  } finally {
    if (pathStat(incoming)) rmSync(incoming)
  }
}

function refreshLinuxDesktopIntegration(layout) {
  const mimePackages = path.join(layout.mimeRoot, "packages")
  if (pathStat(mimePackages)) {
    requireRegularDirectory(mimePackages, "user MIME package directory")
    run("update-mime-database", [layout.mimeRoot], {
      label: "refreshing the user MIME database",
    })
  }
  if (pathStat(layout.applicationsDirectory)) {
    requireRegularDirectory(
      layout.applicationsDirectory,
      "user application directory"
    )
    run("update-desktop-database", [layout.applicationsDirectory], {
      label: "refreshing desktop applications",
    })
  }
  if (pathStat(layout.iconThemeRoot)) {
    requireRegularDirectory(layout.iconThemeRoot, "user icon theme directory")
    run("gtk-update-icon-cache", ["-f", "-t", layout.iconThemeRoot], {
      label: "refreshing the user icon cache",
    })
  }
}

function xdgMimeDefault(mimeType) {
  return run("xdg-mime", ["query", "default", mimeType], {
    label: `querying the ${mimeType} default`,
  }).stdout.trim()
}

function installLinuxDefaults() {
  for (const mimeType of ["text/markdown", "x-scheme-handler/pulse-md"]) {
    run("xdg-mime", ["default", linuxDesktopName, mimeType], {
      label: `setting the ${mimeType} default`,
    })
    const resolved = xdgMimeDefault(mimeType)
    if (resolved !== linuxDesktopName) {
      throw new Error(
        `${mimeType} resolves to ${resolved || "nothing"}, expected ${linuxDesktopName}`
      )
    }
  }
  const protocolCheck = run(
    "xdg-settings",
    ["check", "default-url-scheme-handler", "pulse-md", linuxDesktopName],
    { label: "verifying the pulse-md URL handler" }
  ).stdout.trim()
  if (protocolCheck !== "yes") {
    throw new Error(
      `xdg-settings did not recognize ${linuxDesktopName} as the pulse-md URL handler`
    )
  }
}

function cleanCliEnvironment(environment = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...environment }).filter(
      ([name]) => !["PMD_APP_EXECUTABLE", "PMD_CLI_ENDPOINT"].includes(name)
    )
  )
}

function verifyInstalledLinuxCli(layout, environment) {
  const cliStat = pathStat(layout.cli)
  if (!cliStat?.isSymbolicLink()) {
    throw new Error(`Installed pmd is not a symbolic link: ${layout.cli}`)
  }
  if (
    canonicalPath(layout.cli) !== canonicalPath(layout.helper) ||
    path.resolve(path.dirname(layout.cli), readlinkSync(layout.cli)) !==
      layout.helper
  ) {
    throw new Error(`Installed pmd does not target ${layout.helper}`)
  }
  const result = run(layout.cli, ["doctor"], {
    env: cleanCliEnvironment(environment),
    label: "installed Linux pmd doctor",
    timeout: 20_000,
  })
  const lines = result.stdout.trimEnd().split(/\r?\n/)
  const value = (label) =>
    lines.find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2)
  if (
    !result.stdout.startsWith(`${productName} ${packageMetadata.version}\n`) ||
    canonicalPath(value("Application") || "/") !==
      canonicalPath(layout.executable) ||
    canonicalPath(value("Helper") || "/") !== canonicalPath(layout.helper) ||
    value("Packaged") !== "yes" ||
    !value("Endpoint")?.includes("pulse-md-") ||
    value("Status") !== "ready"
  ) {
    throw new Error(`Installed pmd reached the wrong app:\n${result.stdout}`)
  }
}

function linuxVerificationEnvironment(temporaryDirectory) {
  const root = path.join(temporaryDirectory, "verification-home")
  const environment = {
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  for (const target of Object.values(environment)) {
    mkdirSync(target, { mode: 0o700, recursive: true })
  }
  return environment
}

export function archPacmanInstallInvocation(
  artifact,
  {
    effectiveUserId = process.geteuid?.(),
    environment = process.env,
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  } = {}
) {
  if (!path.isAbsolute(artifact)) {
    throw new Error(`Arch package path must be absolute: ${artifact}`)
  }
  const args = ["-U", "--noconfirm", artifact]
  if (effectiveUserId === 0) return ["/usr/bin/pacman", args]
  if (
    !interactive &&
    (environment.WAYLAND_DISPLAY || environment.DISPLAY) &&
    pathStat("/usr/bin/pkexec")?.isFile()
  ) {
    return ["/usr/bin/pkexec", ["/usr/bin/pacman", ...args]]
  }
  return ["/usr/bin/sudo", ["/usr/bin/pacman", ...args]]
}

function verifyArchPackageOwnership(layout) {
  const environment = { ...process.env, LC_ALL: "C" }
  const expectedVersion = `${archPackageVersion(packageMetadata.version)}-1`
  const installed = run("/usr/bin/pacman", ["-Q", "pulse-md"], {
    env: environment,
    label: "querying the installed Arch package",
  }).stdout.trim()
  if (installed !== `pulse-md ${expectedVersion}`) {
    throw new Error(
      `Unexpected installed Arch package: ${installed || "not installed"}`
    )
  }
  const integrityResult = run("/usr/bin/pacman", ["-Qkk", "pulse-md"], {
    env: environment,
    label: "checking the installed Arch package",
  })
  const integrity = integrityResult.stdout.trim()
  if (integrityResult.stderr.trim() || !/\b0 altered files\b/.test(integrity)) {
    throw new Error(
      `Installed Arch package is altered:\n${[
        integrity,
        integrityResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")}`
    )
  }

  const ownedPaths = [
    layout.installationRoot,
    layout.executable,
    path.join(layout.installationRoot, "resources", "app.asar"),
    layout.helper,
    layout.command,
    layout.cli,
    layout.desktop,
    layout.license,
    layout.mimePackage,
    ...layout.icons.values(),
  ]
  for (const target of ownedPaths) {
    const owner = run("/usr/bin/pacman", ["-Qqo", target], {
      env: environment,
      label: `checking package ownership of ${target}`,
    }).stdout.trim()
    if (owner !== "pulse-md") {
      throw new Error(`${target} is owned by ${owner || "no package"}`)
    }
  }

  validateLinuxRuntime(layout.installationRoot)
  verifyPackagedSymlink(layout.command, layout.executable)
  verifyPackagedSymlink(layout.cli, layout.helper)
  validateExactTextFile(
    layout.desktop,
    linuxDesktopEntry(layout.command),
    "installed Pulse MD desktop entry"
  )
  validateExactTextFile(
    layout.mimePackage,
    linuxMimePackage(),
    "installed Pulse MD MIME package"
  )
  run("desktop-file-validate", [layout.desktop], {
    label: "validating the installed Pulse MD desktop entry",
  })
  run("xmllint", ["--noout", layout.mimePackage], {
    label: "validating the installed Pulse MD MIME package",
  })
  for (const [size, target] of layout.icons) {
    assertMatchingFile(
      path.join(projectRoot, "build", "icons", "linux", `${size}x${size}.png`),
      target,
      `${size}px installed Linux icon`
    )
  }
}

function verifyPackagedSymlink(target, expected) {
  const stat = pathStat(target)
  if (!stat?.isSymbolicLink() || readlinkSync(target) !== expected) {
    throw new Error(`Unexpected installed symbolic link: ${target}`)
  }
}

async function installArchLinux(temporaryDirectory) {
  const packagedRoot = linuxPackagedRuntimeRoot(temporaryDirectory)
  const verificationEnvironment =
    linuxVerificationEnvironment(temporaryDirectory)
  verifyPackagedRuntime(packagedRoot, verificationEnvironment)

  const packageDirectory = path.join(temporaryDirectory, "arch-package")
  mkdirSync(packageDirectory)
  const artifact = packageArchRuntime(packagedRoot, packageDirectory)
  const nativeLayout = archLinuxInstallLayout()
  const legacyLayout = linuxInstallLayout()
  assertLinuxPulseMdIsNotRunning(legacyLayout.executable)
  assertLinuxPulseMdIsNotRunning(nativeLayout.executable)

  const removal = new LinuxRemovalTransaction(`${process.pid}-${randomUUID()}`)
  const legacyTargets = stageLegacyLinuxRemoval(legacyLayout, removal)
  const [packageManager, packageManagerArgs] =
    archPacmanInstallInvocation(artifact)
  runVisible(packageManager, packageManagerArgs, {
    label: "installing the native Arch package",
  })

  let removalApplied = false
  let mimeAppsSnapshot = null
  try {
    verifyArchPackageOwnership(nativeLayout)
    assertMatchingFile(
      path.join(packagedRoot, "resources", "app.asar"),
      path.join(nativeLayout.installationRoot, "resources", "app.asar"),
      "installed Arch app.asar"
    )
    assertMatchingFile(
      path.join(packagedRoot, "resources", "bin", "pmd"),
      nativeLayout.helper,
      "installed Arch pmd"
    )
    verifyPackagedRuntime(
      nativeLayout.installationRoot,
      verificationEnvironment
    )
    verifyInstalledLinuxCli(nativeLayout, verificationEnvironment)
    await waitForLinuxPulseMdToStop(nativeLayout.executable)

    if (legacyTargets.length > 0) {
      assertLinuxPulseMdIsNotRunning(legacyLayout.executable)
      removal.apply()
      removalApplied = true
      refreshLinuxDesktopIntegration(legacyLayout)
    }
    mkdirSync(legacyLayout.configHome, { mode: 0o755, recursive: true })
    requireRegularDirectory(
      legacyLayout.configHome,
      "XDG configuration directory"
    )
    mimeAppsSnapshot = snapshotFile(legacyLayout.mimeApps)
    installLinuxDefaults()
    for (const target of legacyTargets) {
      if (pathStat(target)) {
        throw new Error(
          `Legacy Pulse MD target remains after migration: ${target}`
        )
      }
    }
    verifyArchPackageOwnership(nativeLayout)
    removal.commit()
    console.log(`Installed and verified ${artifact}`)
    console.log(`Pacman owns ${nativeLayout.installationRoot}`)
    console.log(`Installed pmd at ${nativeLayout.cli}`)
  } catch (error) {
    if (removal.committed) throw error
    const rollbackErrors = []
    try {
      await waitForLinuxPulseMdToStop(nativeLayout.executable)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (mimeAppsSnapshot) {
      try {
        restoreFileSnapshot(mimeAppsSnapshot)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (removalApplied && !removal.committed) {
      try {
        removal.rollback()
        refreshLinuxDesktopIntegration(legacyLayout)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${error.message}\nMigration rollback also failed:\n${rollbackErrors
          .map((rollbackError) => rollbackError.message)
          .join("\n")}`,
        { cause: error }
      )
    }
    throw error
  }
}

async function installLinux(temporaryDirectory) {
  const layout = linuxInstallLayout()
  assertLinuxPulseMdIsNotRunning(layout.executable)
  const packagedRoot = linuxPackagedRuntimeRoot(temporaryDirectory)
  const verificationEnvironment =
    linuxVerificationEnvironment(temporaryDirectory)
  verifyPackagedRuntime(packagedRoot, verificationEnvironment)
  assertLinuxPulseMdIsNotRunning(layout.executable)

  const transaction = new LinuxInstallTransaction(
    `${process.pid}-${randomUUID()}`
  )
  const desktopSource = linuxDesktopEntry(layout.executable)
  const mimeSource = linuxMimePackage()
  let transactionApplied = false
  let mimeAppsSnapshot = null
  let preferencesMayHaveChanged = false

  try {
    transaction.stage({
      create: (incoming) =>
        cpSync(packagedRoot, incoming, {
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          recursive: true,
          verbatimSymlinks: true,
        }),
      target: layout.installationRoot,
      validateExisting: () =>
        validateExistingLinuxInstall(layout.installationRoot, layout.cli),
      validateIncoming: (incoming) => validateLinuxRuntime(incoming),
    })
    transaction.stage({
      create: (incoming) => symlinkSync(layout.helper, incoming),
      target: layout.cli,
      validateExisting: (target) => validateExistingLinuxCli(target, layout),
      validateIncoming: (incoming) => {
        if (!pathStat(incoming)?.isSymbolicLink()) {
          throw new Error(`Failed to stage the pmd link: ${incoming}`)
        }
      },
    })
    const incomingDesktop = transaction.stage({
      create: (incoming) =>
        writeFileSync(incoming, desktopSource, { mode: 0o644 }),
      target: layout.desktop,
      validateExisting: (target) =>
        validateReplaceableFile(target, "existing Pulse MD desktop entry"),
      validateIncoming: (incoming) =>
        requireRegularFile(incoming, "staged Pulse MD desktop entry"),
    })
    run("desktop-file-validate", [incomingDesktop], {
      label: "validating the Pulse MD desktop entry",
    })
    transaction.stage({
      create: (incoming) =>
        writeFileSync(incoming, mimeSource, { mode: 0o644 }),
      target: layout.mimePackage,
      validateExisting: (target) =>
        validateReplaceableFile(target, "existing Pulse MD MIME package"),
      validateIncoming: (incoming) =>
        requireRegularFile(incoming, "staged Pulse MD MIME package"),
    })
    for (const [size, target] of layout.icons) {
      const source = path.join(
        projectRoot,
        "build",
        "icons",
        "linux",
        `${size}x${size}.png`
      )
      requireRegularFile(source, `${size}px Linux icon source`)
      transaction.stage({
        create: (incoming) => {
          copyFileSync(source, incoming)
          chmodSync(incoming, 0o644)
        },
        target,
        validateExisting: (existing) =>
          validateReplaceableFile(existing, `existing ${size}px Pulse MD icon`),
        validateIncoming: (incoming) =>
          assertMatchingFile(source, incoming, `${size}px Linux icon`),
      })
    }

    transaction.apply()
    transactionApplied = true
    validateLinuxRuntime(layout.installationRoot)
    assertMatchingFile(
      path.join(packagedRoot, "resources", "app.asar"),
      path.join(layout.installationRoot, "resources", "app.asar"),
      "app.asar"
    )
    assertMatchingFile(
      path.join(packagedRoot, "resources", "bin", "pmd"),
      layout.helper,
      "pmd"
    )
    verifyPackagedRuntime(layout.installationRoot, verificationEnvironment)
    verifyInstalledLinuxCli(layout, verificationEnvironment)
    await waitForLinuxPulseMdToStop(layout.executable)

    refreshLinuxDesktopIntegration(layout)
    mkdirSync(layout.configHome, { mode: 0o755, recursive: true })
    requireRegularDirectory(layout.configHome, "XDG configuration directory")
    mimeAppsSnapshot = snapshotFile(layout.mimeApps)
    preferencesMayHaveChanged = true
    installLinuxDefaults()

    transaction.commit()
    console.log(`Installed and verified ${layout.installationRoot}`)
    console.log(`Installed pmd at ${layout.cli}`)
    console.log(`Registered ${layout.desktop}`)
  } catch (error) {
    if (transaction.committed) throw error
    const rollbackErrors = []
    try {
      await waitForLinuxPulseMdToStop(layout.executable)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (preferencesMayHaveChanged && mimeAppsSnapshot) {
      try {
        restoreFileSnapshot(mimeAppsSnapshot)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    try {
      transaction.rollback()
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (transactionApplied) {
      try {
        refreshLinuxDesktopIntegration(layout)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${error.message}\nRollback also failed:\n${rollbackErrors
          .map((rollbackError) => rollbackError.message)
          .join("\n")}`,
        { cause: error }
      )
    }
    throw error
  }
}

async function installPlatformPackage() {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), `pulse-md-install-${process.platform}-`)
  )
  try {
    buildPackageTo(temporaryDirectory)
    if (process.platform === "win32") {
      assertWindowsPulseMdIsNotRunning()
      const packagedRoot = windowsPackagedRuntimeRoot(temporaryDirectory)
      verifyPackagedRuntime(packagedRoot)
      assertWindowsPulseMdIsNotRunning()
      const installers = readdirSync(temporaryDirectory)
        .filter((name) => name.toLowerCase().endsWith(".exe"))
        .map((name) => path.join(temporaryDirectory, name))
      if (installers.length !== 1) {
        throw new Error(
          `Expected one NSIS installer, found ${installers.length}`
        )
      }
      const installerInvocation = windowsInstallerInvocation(installers[0])
      runVisible(installerInvocation.command, installerInvocation.args, {
        env: installerInvocation.env,
        label: "Pulse MD installer",
      })
      const identity = windowsInstallerIdentity()
      const { installationRoot } = windowsInstallation(identity)
      const installedExecutable = path.join(
        installationRoot,
        `${productName}.exe`
      )
      const helper = path.join(installationRoot, "resources", "bin", "pmd.exe")
      const installedAsar = path.join(installationRoot, "resources", "app.asar")
      for (const required of [installedExecutable, helper, installedAsar]) {
        const stat = pathStat(required)
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Installed executable is missing: ${required}`)
        }
      }
      assertMatchingFile(
        path.join(packagedRoot, "resources", "app.asar"),
        installedAsar,
        "app.asar"
      )
      assertMatchingFile(
        path.join(packagedRoot, "resources", "bin", "pmd.exe"),
        helper,
        "pmd.exe"
      )
      verifyPackagedRuntime(installationRoot)
      const doctor = run(helper, ["doctor"], {
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              !["PMD_APP_EXECUTABLE", "PMD_CLI_ENDPOINT"].includes(name)
          )
        ),
        label: "installed pmd doctor",
      })
      if (
        !doctor.stdout.includes(`${productName} ${packageMetadata.version}`)
      ) {
        throw new Error(`pmd reached the wrong app:\n${doctor.stdout}`)
      }
      if (
        !doctor.stdout.includes(`Application: ${installedExecutable}\r\n`) &&
        !doctor.stdout.includes(`Application: ${installedExecutable}\n`)
      ) {
        throw new Error(`pmd launched another app:\n${doctor.stdout}`)
      }
      if (!doctor.stdout.includes("Endpoint: \\\\.\\pipe\\pulse-md-")) {
        throw new Error(`pmd reported the wrong endpoint:\n${doctor.stdout}`)
      }
      await waitForWindowsPulseMdToStop()
      assertCanonicalWindowsPath(path.dirname(helper))
      assertCanonicalWindowsShell(installationRoot, identity)
      console.log(
        "Installed and verified Pulse MD with its all-users NSIS installer"
      )
      return
    }
    if (process.platform === "linux") {
      if (isArchLinuxHost()) await installArchLinux(temporaryDirectory)
      else await installLinux(temporaryDirectory)
      return
    }
  } finally {
    if (pathStat(temporaryDirectory)) {
      removeManagedDirectory(temporaryDirectory, os.tmpdir())
    }
  }
}

const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  const installation =
    process.platform === "darwin" ? installMac() : installPlatformPackage()
  installation.catch((error) => {
    console.error(`Installation failed: ${error.message}`)
    process.exitCode = 1
  })
}
