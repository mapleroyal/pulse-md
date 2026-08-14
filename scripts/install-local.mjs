import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

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

const projectRoot = path.resolve(import.meta.dirname, "..")
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)
const macInstalledApp = "/Applications/Pulse MD.app"
const bundleIdentifier = "io.github.mapleroyal.pulse-md"
const productName = "Pulse MD"
const releaseDirectory = path.join(projectRoot, "release")
const require = createRequire(import.meta.url)
const { extractFile } = require("@electron/asar")

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

function verifyPackagedRuntime(packagedRoot) {
  const [npm, args] = npmInvocation(["run", "test:packaged"])
  runVisible(npm, args, {
    env: { ...process.env, PMD_PACKAGED_ROOT: packagedRoot },
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
    ...(process.platform === "darwin" ? ["dir"] : []),
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

function promoteFileAtomically(source, target) {
  const parent = path.dirname(target)
  requireRegularDirectory(parent, "artifact output directory")
  const token = `${process.pid}-${randomUUID()}`
  const incoming = path.join(parent, `.install-incoming-${token}`)
  const previous = path.join(parent, `.install-previous-${token}`)
  const existing = pathStat(target)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Refusing unexpected artifact target: ${target}`)
  }
  if (pathStat(incoming) || pathStat(previous)) {
    throw new Error("An artifact staging path already exists")
  }
  let movedPrevious = false
  let installedIncoming = false
  try {
    copyFileSync(source, incoming)
    if (existing) {
      renameSync(target, previous)
      movedPrevious = true
    }
    renameSync(incoming, target)
    installedIncoming = true
    if (movedPrevious) rmSync(previous)
  } catch (error) {
    if (installedIncoming && pathStat(target)?.isFile()) rmSync(target)
    if (pathStat(incoming)?.isFile()) rmSync(incoming)
    if (movedPrevious && pathStat(previous)?.isFile() && !pathStat(target)) {
      renameSync(previous, target)
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
      const debs = readdirSync(temporaryDirectory)
        .filter((name) => name.endsWith(".deb"))
        .map((name) => path.join(temporaryDirectory, name))
      if (debs.length !== 1) {
        throw new Error(`Expected one Debian package, found ${debs.length}`)
      }
      mkdirSync(releaseDirectory, { recursive: true })
      requireRegularDirectory(releaseDirectory, "release directory")
      const stableDeb = path.join(releaseDirectory, path.basename(debs[0]))
      promoteFileAtomically(debs[0], stableDeb)
      console.log(`Built ${stableDeb}.`)
      console.log(
        `Install it with: sudo apt install '${stableDeb.replaceAll("'", "'\\''")}'`
      )
      console.log("Then verify it with: pmd doctor")
      return
    }
  } finally {
    if (pathStat(temporaryDirectory)) {
      removeManagedDirectory(temporaryDirectory, os.tmpdir())
    }
  }
}

if (process.platform === "darwin") {
  installMac().catch((error) => {
    console.error(`Installation failed: ${error.message}`)
    process.exitCode = 1
  })
} else {
  installPlatformPackage().catch((error) => {
    console.error(`Installation failed: ${error.message}`)
    process.exitCode = 1
  })
}
