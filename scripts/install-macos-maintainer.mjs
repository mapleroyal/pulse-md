import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

const projectRoot = path.resolve(import.meta.dirname, "..")
const installedApp = "/Applications/Pulse MD.app"
const applicationDirectory = path.dirname(installedApp)
const expectedBundleIdentifier = "io.github.mapleroyal.pulse-md"
const expectedProductName = "Pulse MD"
const launchServicesTool =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)

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
    throw new Error(
      "Run the maintainer install through `npm run install:mac:dev`"
    )
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

function validateBundle(
  appBundle,
  {
    canonicalName = true,
    currentVersion = true,
    requireAdHocSignature = false,
    requireAdaptiveIcon = true,
    requireHelper = true,
  } = {}
) {
  validateBundleShell(appBundle)
  if (
    canonicalName &&
    path.basename(appBundle) !== `${expectedProductName}.app`
  ) {
    throw new Error(`Unexpected app bundle name: ${appBundle}`)
  }
  if (
    currentVersion &&
    plistValue(appBundle, "CFBundleShortVersionString") !==
      packageMetadata.version
  ) {
    throw new Error(`Unexpected app version: ${appBundle}`)
  }
  const requiredExecutables = [
    path.join(appBundle, "Contents", "MacOS", expectedProductName),
    ...(requireHelper
      ? [path.join(appBundle, "Contents", "Resources", "bin", "pmd")]
      : []),
  ]
  for (const required of requiredExecutables) {
    requireRegularFile(required, "Required installed executable")
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
  if (requireAdHocSignature) {
    const signature = run("/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      appBundle,
    ]).stderr
    if (!signature.split("\n").includes("Signature=adhoc")) {
      throw new Error(`Maintainer candidate is not ad-hoc signed: ${appBundle}`)
    }
  }
}

function validateBundleShell(appBundle) {
  requireRegularDirectory(appBundle, "Pulse MD app bundle")
  if (
    plistValue(appBundle, "CFBundleIdentifier") !== expectedBundleIdentifier
  ) {
    throw new Error(`Unexpected bundle identifier: ${appBundle}`)
  }
  const executable = path.join(
    appBundle,
    "Contents",
    "MacOS",
    expectedProductName
  )
  const executableStat = pathStat(executable)
  if (!executableStat?.isFile() || executableStat.isSymbolicLink()) {
    throw new Error(`Required installed executable is missing: ${executable}`)
  }
}

function discoverAppBundles(root) {
  requireRegularDirectory(root, "Maintainer build output")
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

function verifyPackagedRuntime(appBundle) {
  const [npm, args] = npmInvocation(["run", "test:packaged"])
  runVisible(npm, args, {
    env: { ...process.env, PMD_PACKAGED_ROOT: appBundle },
    label: `packaged verification for ${appBundle}`,
  })
}

function verifyDefaultCli(appBundle) {
  const helper = path.join(appBundle, "Contents", "Resources", "bin", "pmd")
  const result = run(helper, ["doctor"], {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["PMD_APP_EXECUTABLE", "PMD_CLI_ENDPOINT"].includes(name)
      )
    ),
    label: "installed pmd doctor",
  })
  if (
    !result.stdout.includes(`${expectedProductName} ${packageMetadata.version}`)
  ) {
    throw new Error(`Installed pmd reached the wrong app:\n${result.stdout}`)
  }
  const expectedExecutable = path.join(
    appBundle,
    "Contents",
    "MacOS",
    expectedProductName
  )
  if (!result.stdout.includes(`Application: ${expectedExecutable}\n`)) {
    throw new Error(`Installed pmd launched another app:\n${result.stdout}`)
  }
  if (!result.stdout.includes("/tmp/pulse-md-")) {
    throw new Error(
      `Installed pmd reported the wrong endpoint:\n${result.stdout}`
    )
  }
}

function registeredProductionApps(launchServicesTool) {
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

function installCandidate(candidate, token) {
  const incoming = path.join(
    applicationDirectory,
    `.Pulse MD.incoming-${token}.app`
  )
  const previous = path.join(
    applicationDirectory,
    `.Pulse MD.previous-${token}`
  )
  if (pathStat(incoming) || pathStat(previous)) {
    throw new Error("A maintainer install staging path already exists")
  }

  const existing = pathStat(installedApp)
  let movedPrevious = false
  let installedIncoming = false
  try {
    run("/usr/bin/ditto", [candidate, incoming], {
      label: "copying the maintainer candidate into Applications",
    })
    validateBundle(incoming, {
      canonicalName: false,
      requireAdHocSignature: true,
    })
    if (existing) {
      try {
        validateBundle(installedApp, {
          currentVersion: false,
          requireAdaptiveIcon: false,
          requireHelper: false,
        })
      } catch (error) {
        throw new Error(
          `Refusing to replace an unexpected app at ${installedApp}: ${error.message}`,
          { cause: error }
        )
      }
    }
    if (existing) {
      renameSync(installedApp, previous)
      movedPrevious = true
    }
    renameSync(incoming, installedApp)
    installedIncoming = true
    validateBundle(installedApp, { requireAdHocSignature: true })
    return { previous: movedPrevious ? previous : null }
  } catch (error) {
    if (installedIncoming && pathStat(installedApp)) {
      removeManagedDirectory(installedApp, applicationDirectory)
    } else if (pathStat(incoming)) {
      removeManagedDirectory(incoming, applicationDirectory)
    }
    if (movedPrevious && pathStat(previous) && !pathStat(installedApp)) {
      renameSync(previous, installedApp)
    }
    throw error
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The maintainer installed-candidate lane is macOS-only")
  }
  requireRegularDirectory(applicationDirectory, "Applications directory")
  assertPulseMdIsNotRunning()

  const managedRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Pulse MD Build Tests"
  )
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 })
  requireRegularDirectory(managedRoot, "Maintainer build-test directory")
  const stagingDirectory = mkdtempSync(path.join(managedRoot, "install-"))
  const token = `${process.pid}-${randomUUID()}`
  const hadInstalledApp = Boolean(pathStat(installedApp))
  let previous = null
  let installed = false

  try {
    if (hadInstalledApp) {
      for (const command of ["clean", "check"]) {
        runVisible(process.execPath, [
          path.join(projectRoot, "scripts", "macos-app-registrations.mjs"),
          command,
        ])
      }
    }
    {
      const [npm, args] = npmInvocation(["run", "icon:build"])
      runVisible(npm, args, { label: "adaptive macOS icon build" })
    }
    {
      const [npm, args] = npmInvocation(["run", "build"])
      runVisible(npm, args, { label: "application build" })
    }
    {
      const [builder, args] = builderInvocation([
        "--mac",
        "dir",
        "--config",
        "electron-builder.maintainer.cjs",
        `--config.directories.output=${stagingDirectory}`,
        "--publish",
        "never",
      ])
      runVisible(builder, args, {
        env: {
          ...process.env,
          CSC_IDENTITY_AUTO_DISCOVERY: "false",
          PMD_ICON_COMPOSER_BUILD: "1",
        },
        label: "maintainer electron-builder package",
      })
    }

    const candidates = discoverAppBundles(stagingDirectory)
    if (candidates.length !== 1) {
      throw new Error(
        `Expected one maintainer app candidate, found ${candidates.length}`
      )
    }
    validateBundle(candidates[0], { requireAdHocSignature: true })
    try {
      verifyPackagedRuntime(candidates[0])
    } finally {
      if (
        registeredSetHasPath(
          registeredProductionApps(launchServicesTool),
          candidates[0]
        )
      ) {
        run(launchServicesTool, ["-u", candidates[0]], {
          label: "unregistering the maintainer staging candidate",
        })
      }
    }
    assertPulseMdIsNotRunning()

    const installation = installCandidate(candidates[0], token)
    previous = installation.previous
    installed = true
    validateBundle(installedApp, { requireAdHocSignature: true })
    verifyPackagedRuntime(installedApp)
    verifyDefaultCli(installedApp)
    await waitForPulseMdToStop()

    removeManagedDirectory(stagingDirectory, managedRoot)
    if (
      previous &&
      registeredSetHasPath(
        registeredProductionApps(launchServicesTool),
        previous
      )
    ) {
      run(launchServicesTool, ["-u", previous], {
        label: "unregistering the previous maintainer candidate",
      })
    }
    run(launchServicesTool, ["-f", installedApp], {
      label: "registering the installed maintainer candidate",
    })
    runVisible(process.execPath, [
      path.join(projectRoot, "scripts", "macos-app-registrations.mjs"),
      hadInstalledApp ? "check" : "clean",
    ])
    installed = false
    if (previous) {
      removeManagedDirectory(previous, applicationDirectory)
      previous = null
    }
    console.log(
      `Installed and verified the non-distributable maintainer candidate at ${installedApp}`
    )
  } catch (error) {
    if (installed && pathStat(installedApp)) {
      validateBundleShell(installedApp)
      removeManagedDirectory(installedApp, applicationDirectory)
    }
    if (previous && pathStat(previous) && !pathStat(installedApp)) {
      validateBundleShell(previous)
      renameSync(previous, installedApp)
      run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-f", installedApp],
        { label: "restoring the previous Launch Services registration" }
      )
    }
    throw error
  } finally {
    if (pathStat(stagingDirectory)) {
      removeManagedDirectory(stagingDirectory, managedRoot)
    }
  }
}

main().catch((error) => {
  console.error(`Maintainer install failed: ${error.message}`)
  process.exitCode = 1
})
