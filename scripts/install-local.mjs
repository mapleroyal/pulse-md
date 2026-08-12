import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
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

const projectRoot = path.resolve(import.meta.dirname, "..")
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)
const macInstalledApp = "/Applications/Pulse MD Local.app"
const localBundleIdentifier = "io.github.mapleroyal.pulse-md.local"
const localProductName = "Pulse MD Local"
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
    throw new Error("Run Local installation through `npm run install:local`")
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
    requireLocalHelper = true,
  } = {}
) {
  requireRegularDirectory(appBundle, "Pulse MD Local app bundle")
  if (canonicalName && path.basename(appBundle) !== `${localProductName}.app`) {
    throw new Error(`Unexpected Local app bundle name: ${appBundle}`)
  }
  if (plistValue(appBundle, "CFBundleIdentifier") !== localBundleIdentifier) {
    throw new Error(`Unexpected Local bundle identifier: ${appBundle}`)
  }
  if (
    currentVersion &&
    plistValue(appBundle, "CFBundleShortVersionString") !==
      packageMetadata.version
  ) {
    throw new Error(`Unexpected Local app version: ${appBundle}`)
  }
  const requiredExecutables = [
    path.join(appBundle, "Contents", "MacOS", localProductName),
    ...(requireLocalHelper
      ? [path.join(appBundle, "Contents", "Resources", "bin", "pmd-local")]
      : []),
  ]
  for (const required of requiredExecutables) {
    const stat = pathStat(required)
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Required Local executable is missing: ${required}`)
    }
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
  requireRegularDirectory(root, "Local build output")
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

function assertLocalIsNotRunning() {
  const processes = run("/bin/ps", ["-axo", "pid=,command="])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => /\/Contents\/MacOS\/Pulse MD Local(?:\s|$)/.test(line))
  if (processes.length > 0) {
    throw new Error(
      `Quit Pulse MD Local before installing:\n${processes.join("\n")}`
    )
  }
}

async function waitForLocalToStop() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      assertLocalIsNotRunning()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assertLocalIsNotRunning()
}

function verifyPackagedRuntime(appBundle) {
  const [npm, args] = npmInvocation(["run", "test:packaged"])
  runVisible(npm, args, {
    env: { ...process.env, PMD_PACKAGED_ROOT: appBundle },
    label: `packaged verification for ${appBundle}`,
  })
}

function verifyLocalCli(appBundle) {
  const helper = path.join(
    appBundle,
    "Contents",
    "Resources",
    "bin",
    "pmd-local"
  )
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["PMD_APP_EXECUTABLE", "PMD_CLI_ENDPOINT"].includes(name)
    )
  )
  const result = run(helper, ["doctor"], {
    env: cleanEnvironment,
    label: "installed pmd-local doctor",
  })
  if (
    !result.stdout.includes(`${localProductName} ${packageMetadata.version}`)
  ) {
    throw new Error(`pmd-local reached the wrong app:\n${result.stdout}`)
  }
  if (!result.stdout.includes("pulse-md-local-")) {
    throw new Error(`pmd-local reported the wrong endpoint:\n${result.stdout}`)
  }
  const expectedExecutable = path.join(
    appBundle,
    "Contents",
    "MacOS",
    localProductName
  )
  if (!result.stdout.includes(`Application: ${expectedExecutable}\n`)) {
    throw new Error(`pmd-local launched another app:\n${result.stdout}`)
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

function validateLocalBundleOwnership(appBundle) {
  validateLocalBundleShell(appBundle)
  const metadata = JSON.parse(
    extractFile(
      path.join(appBundle, "Contents", "Resources", "app.asar"),
      "package.json"
    ).toString("utf8")
  )
  const currentLocalMetadata =
    metadata.pmdDistributionChannel === "local" &&
    metadata.name === "pulse-md-local" &&
    metadata.productName === localProductName
  const preIdentityLocalMetadata =
    metadata.pmdDistributionChannel === undefined &&
    metadata.name === "pulse-md" &&
    metadata.productName === "Pulse MD"
  if (!currentLocalMetadata && !preIdentityLocalMetadata) {
    throw new Error(`Refusing unverified Local app bundle: ${appBundle}`)
  }
}

function validateLocalBundleShell(appBundle) {
  requireRegularDirectory(appBundle, "Pulse MD Local app bundle")
  if (macBundleIdentifier(appBundle) !== localBundleIdentifier) {
    throw new Error(`Refusing non-Local app bundle: ${appBundle}`)
  }
  const executable = path.join(appBundle, "Contents", "MacOS", localProductName)
  const executableStat = pathStat(executable)
  if (!executableStat?.isFile() || executableStat.isSymbolicLink()) {
    throw new Error(`Local app executable is missing: ${executable}`)
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

function unregisterLocalBundleIfRegistered(launchServicesTool, target) {
  if (
    !registeredSetHasPath(registeredLocalMacBundles(launchServicesTool), target)
  )
    return
  run(launchServicesTool, ["-u", target], {
    label: `unregistering Pulse MD Local bundle ${target}`,
  })
}

function localMacBundlesUnder(root, maximumDepth) {
  const bundles = []
  const pending = [{ depth: 0, target: root }]
  while (pending.length > 0) {
    const { depth, target } = pending.pop()
    const stat = pathStat(target)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue
    if (target.endsWith(".app")) {
      if (macBundleIdentifier(target) === localBundleIdentifier) {
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

function registeredLocalMacBundles(launchServicesTool) {
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
      /^identifier:\s+io\.github\.mapleroyal\.pulse-md\.local$/.test(line)
    ) {
      registrations.add(currentPath)
    }
  }
  return registrations
}

function cleanManagedLocalMacDuplicates(launchServicesTool, managedRoot) {
  const roots = [
    { depth: 5, path: releaseDirectory },
    { depth: 4, path: managedRoot },
    { depth: 7, path: path.join(os.homedir(), ".Trash") },
  ]
  const discovered = new Set(
    roots.flatMap(({ depth, path: root }) => localMacBundlesUnder(root, depth))
  )
  const registered = registeredLocalMacBundles(launchServicesTool)
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
        const legacyTemporaryLocal =
          /^\/private\/tmp\/pmd-local-build\.[A-Za-z0-9]+\/[^/]+\/Pulse MD Local\.app$/.test(
            resolvedTarget
          )
        if (
          resolvedTarget.startsWith(
            `${canonicalPath(os.tmpdir())}${path.sep}`
          ) ||
          legacyTemporaryLocal
        ) {
          // Stale package-verification bundles are never deleted outside the
          // bounded managed roots. Their exact Local shell is enough to
          // safely remove only the Launch Services registration.
          validateLocalBundleShell(target)
          if (registered.has(target)) {
            run(launchServicesTool, ["-u", target], {
              label: `unregistering temporary Pulse MD Local bundle ${target}`,
            })
          }
          if (legacyTemporaryLocal) {
            // These are known pre-wrapper build directories created by this
            // repository's earlier packaged-runtime checks. Remove only the
            // exact app bundle after validating both its outer identity and
            // embedded Local metadata shape.
            validateLocalBundleOwnership(target)
            rmSync(target, { recursive: true })
          }
          continue
        }
        throw new Error(`Unmanaged Pulse MD Local duplicate remains: ${target}`)
      }
      validateLocalBundleOwnership(target)
    }
    if (registered.has(target)) {
      run(launchServicesTool, ["-u", target], {
        label: `unregistering duplicate Pulse MD Local bundle ${target}`,
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

async function waitForLocalProtocolRegistration() {
  const address =
    "pulse-md-local://scratch/11111111-1111-4111-8111-111111111111"
  const deadline = Date.now() + 10_000
  let resolved = ""
  while (Date.now() < deadline) {
    resolved = defaultApplicationForUrl(address)
    if (path.resolve(resolved || "/") === macInstalledApp) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    resolved
      ? `pulse-md-local URLs resolve to ${resolved}, expected ${macInstalledApp}`
      : "pulse-md-local URLs do not resolve to the installed Local app"
  )
}

function assertSoleLocalRegistration(launchServicesTool) {
  const registrations = [...registeredLocalMacBundles(launchServicesTool)]
  const duplicates = registrations.filter(
    (target) => canonicalPath(target) !== canonicalPath(macInstalledApp)
  )
  if (duplicates.length > 0) {
    throw new Error(
      `Stale Pulse MD Local registrations remain:\n${duplicates.join("\n")}`
    )
  }
  if (
    !registrations.some(
      (target) => canonicalPath(target) === canonicalPath(macInstalledApp)
    )
  ) {
    throw new Error(`Pulse MD Local is not registered at ${macInstalledApp}`)
  }
}

function installMacCandidate(candidate, token) {
  const applications = path.dirname(macInstalledApp)
  const incoming = path.join(
    applications,
    `.Pulse MD Local.incoming-${token}.app`
  )
  const previous = path.join(applications, `.Pulse MD Local.previous-${token}`)
  if (pathStat(incoming) || pathStat(previous)) {
    throw new Error("A Local install staging path already exists")
  }

  const existing = pathStat(macInstalledApp)
  let movedPrevious = false
  let installedIncoming = false
  try {
    run("/usr/bin/ditto", [candidate, incoming], {
      label: "copying Pulse MD Local into Applications",
    })
    validateMacBundle(incoming, { canonicalName: false })
    if (existing) {
      try {
        validateMacBundle(macInstalledApp, {
          currentVersion: false,
          requireLocalHelper: false,
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

function buildLocalTo(outputDirectory) {
  const [npm, npmArgs] = npmInvocation(["run", "build"])
  runVisible(npm, npmArgs, { label: "application build" })
  const platformArgument = {
    darwin: "--mac",
    linux: "--linux",
    win32: "--win",
  }[process.platform]
  if (!platformArgument) {
    throw new Error(
      `Pulse MD Local installation is unsupported on ${process.platform}`
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
        ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" }
        : {}),
    },
    label: "Local electron-builder package",
  })
}

async function installMac() {
  const applications = path.dirname(macInstalledApp)
  requireRegularDirectory(applications, "Applications directory")
  assertLocalIsNotRunning()
  const managedRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Pulse MD Local Build Tests"
  )
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 })
  requireRegularDirectory(managedRoot, "Local build-test directory")
  const stagingDirectory = mkdtempSync(path.join(managedRoot, "install-"))
  const token = `${process.pid}-${randomUUID()}`
  let previous = null
  let installed = false

  try {
    const launchServicesTool =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    cleanManagedLocalMacDuplicates(launchServicesTool, managedRoot)
    buildLocalTo(stagingDirectory)
    const candidates = discoverAppBundles(stagingDirectory)
    if (candidates.length !== 1) {
      throw new Error(
        `Expected one Local app candidate, found ${candidates.length}`
      )
    }
    validateMacBundle(candidates[0])
    try {
      verifyPackagedRuntime(candidates[0])
    } finally {
      unregisterLocalBundleIfRegistered(launchServicesTool, candidates[0])
    }
    assertLocalIsNotRunning()

    const installation = installMacCandidate(candidates[0], token)
    previous = installation.previous
    installed = true
    verifyPackagedRuntime(macInstalledApp)
    verifyLocalCli(macInstalledApp)
    await waitForLocalToStop()

    removeManagedDirectory(stagingDirectory, managedRoot)
    if (previous) {
      unregisterLocalBundleIfRegistered(launchServicesTool, previous)
    }
    run(launchServicesTool, ["-f", macInstalledApp], {
      label: "registering Pulse MD Local",
    })
    await waitForLocalProtocolRegistration()
    assertSoleLocalRegistration(launchServicesTool)
    installed = false
    if (previous) {
      removeManagedDirectory(previous, applications)
      previous = null
    }
    console.log(`Installed and verified ${macInstalledApp}`)
  } catch (error) {
    if (installed && pathStat(macInstalledApp)) {
      validateLocalBundleShell(macInstalledApp)
      removeManagedDirectory(macInstalledApp, applications)
    }
    if (previous && pathStat(previous) && !pathStat(macInstalledApp)) {
      validateLocalBundleShell(previous)
      renameSync(previous, macInstalledApp)
      run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-f", macInstalledApp],
        { label: "restoring the previous Local registration" }
      )
    }
    throw error
  } finally {
    if (pathStat(stagingDirectory)) {
      removeManagedDirectory(stagingDirectory, managedRoot)
    }
  }
}

function windowsLocalProcessPaths() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = Get-CimInstance Win32_Process -Filter \"Name = 'Pulse MD Local.exe'\"",
    "$items | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } }",
  ].join("; ")
  return run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { label: "checking running Pulse MD Local processes" }
  )
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function assertWindowsLocalIsNotRunning() {
  const processes = windowsLocalProcessPaths()
  if (processes.length > 0) {
    throw new Error(
      `Quit Pulse MD Local before installing:\n${processes.join("\n")}`
    )
  }
}

async function waitForWindowsLocalToStop() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      assertWindowsLocalIsNotRunning()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assertWindowsLocalIsNotRunning()
}

function windowsLocalInstallLocations() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    "Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Pulse MD Local' } | ForEach-Object { if ($_.InstallLocation) { $_.InstallLocation } }",
  ].join("; ")
  return run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { label: "locating the Pulse MD Local installation" }
  )
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function assertWindowsUserPathContains(expectedDirectory) {
  const script = "[Environment]::GetEnvironmentVariable('Path', 'User')"
  const userPath = run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { label: "reading the Windows user PATH" }
  ).stdout.trim()
  const normalizedExpected = path.resolve(expectedDirectory).toLowerCase()
  const containsExpected = userPath
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .some((entry) => path.resolve(entry).toLowerCase() === normalizedExpected)
  if (!containsExpected) {
    throw new Error(
      `The Windows user PATH does not contain ${expectedDirectory}`
    )
  }
}

function promoteFileAtomically(source, target) {
  const parent = path.dirname(target)
  requireRegularDirectory(parent, "artifact output directory")
  const token = `${process.pid}-${randomUUID()}`
  const incoming = path.join(parent, `.local-incoming-${token}`)
  const previous = path.join(parent, `.local-previous-${token}`)
  const existing = pathStat(target)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Refusing unexpected Local artifact target: ${target}`)
  }
  if (pathStat(incoming) || pathStat(previous)) {
    throw new Error("A Local artifact staging path already exists")
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
    path.join(os.tmpdir(), `pulse-md-local-install-${process.platform}-`)
  )
  try {
    buildLocalTo(temporaryDirectory)
    if (process.platform === "win32") {
      assertWindowsLocalIsNotRunning()
      const installers = readdirSync(temporaryDirectory)
        .filter((name) => name.toLowerCase().endsWith(".exe"))
        .map((name) => path.join(temporaryDirectory, name))
      if (installers.length !== 1) {
        throw new Error(
          `Expected one Local NSIS installer, found ${installers.length}`
        )
      }
      runVisible(installers[0], [], { label: "Pulse MD Local installer" })
      const localAppData = process.env.LOCALAPPDATA
      if (!localAppData) {
        throw new Error("LOCALAPPDATA is unavailable after Local installation")
      }
      const programFilesRoot =
        process.env["ProgramFiles"] || path.join(localAppData, "Programs")
      const candidateRoots = [
        ...windowsLocalInstallLocations(),
        path.join(localAppData, "Programs", "pulse-md-local"),
        path.join(localAppData, "Programs", "Pulse MD Local"),
        path.join(programFilesRoot, "pulse-md-local"),
        path.join(programFilesRoot, "Pulse MD Local"),
      ]
      const installationRoot = candidateRoots.find((candidate) =>
        pathStat(path.join(candidate, "Pulse MD Local.exe"))?.isFile()
      )
      if (!installationRoot) {
        throw new Error(
          `Cannot locate the installed Pulse MD Local app under ${candidateRoots.join(", ")}`
        )
      }
      const installedExecutable = path.join(
        installationRoot,
        "Pulse MD Local.exe"
      )
      const helper = path.join(
        installationRoot,
        "resources",
        "bin",
        "pmd-local.exe"
      )
      for (const required of [installedExecutable, helper]) {
        const stat = pathStat(required)
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Installed Local executable is missing: ${required}`)
        }
      }
      const doctor = run(helper, ["doctor"], {
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              !["PMD_APP_EXECUTABLE", "PMD_CLI_ENDPOINT"].includes(name)
          )
        ),
        label: "installed pmd-local doctor",
      })
      if (
        !doctor.stdout.includes(
          `${localProductName} ${packageMetadata.version}`
        )
      ) {
        throw new Error(`pmd-local reached the wrong app:\n${doctor.stdout}`)
      }
      if (
        !doctor.stdout.includes(`Application: ${installedExecutable}\r\n`) &&
        !doctor.stdout.includes(`Application: ${installedExecutable}\n`)
      ) {
        throw new Error(`pmd-local launched another app:\n${doctor.stdout}`)
      }
      if (!doctor.stdout.includes("Endpoint: \\\\.\\pipe\\pulse-md-local-")) {
        throw new Error(
          `pmd-local reported the wrong endpoint:\n${doctor.stdout}`
        )
      }
      await waitForWindowsLocalToStop()
      assertWindowsUserPathContains(path.dirname(helper))
      console.log(
        "Installed and verified Pulse MD Local with its per-user NSIS installer"
      )
      return
    }
    if (process.platform === "linux") {
      const debs = readdirSync(temporaryDirectory)
        .filter((name) => name.endsWith(".deb"))
        .map((name) => path.join(temporaryDirectory, name))
      if (debs.length !== 1) {
        throw new Error(
          `Expected one Local Debian package, found ${debs.length}`
        )
      }
      mkdirSync(releaseDirectory, { recursive: true })
      requireRegularDirectory(releaseDirectory, "release directory")
      const stableDeb = path.join(releaseDirectory, path.basename(debs[0]))
      promoteFileAtomically(debs[0], stableDeb)
      console.log(`Built ${stableDeb}.`)
      console.log(
        `Install it with: sudo apt install '${stableDeb.replaceAll("'", "'\\''")}'`
      )
      console.log("Then verify it with: pmd-local doctor")
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
    console.error(`Local installation failed: ${error.message}`)
    process.exitCode = 1
  })
} else {
  installPlatformPackage().catch((error) => {
    console.error(`Local installation failed: ${error.message}`)
    process.exitCode = 1
  })
}
