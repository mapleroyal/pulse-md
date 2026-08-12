import { spawnSync } from "node:child_process"
import { lstat, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const bundleIdentifier = "io.github.mapleroyal.pulse-md"
const installedApp = "/Applications/Pulse MD.app"
const launchServicesTool =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
const projectRoot = path.resolve(import.meta.dirname, "..")
const userHome = os.homedir()
const managedRoots = [
  { depth: 3, path: "/Applications" },
  { depth: 5, path: path.join(projectRoot, "release") },
  {
    depth: 6,
    path: path.join(
      userHome,
      "Library",
      "Application Support",
      "Pulse MD Build Tests"
    ),
  },
  { depth: 7, path: path.join(userHome, ".Trash") },
]

function usage() {
  console.error(
    "Usage: node scripts/macos-app-registrations.mjs <check|clean> [--dry-run]"
  )
}

function capture(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.error?.message || result.stderr || `exit ${result.status}`
      }`
    )
  }
  return result
}

async function pathType(target) {
  try {
    return await lstat(target)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

function managedDuplicate(target) {
  if (target === installedApp) return false
  return managedRoots.some((root) => within(root.path, target))
}

function bundleId(target) {
  const result = capture(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      path.join(target, "Contents", "Info.plist"),
    ],
    { allowFailure: true }
  )
  return result.status === 0 ? result.stdout.trim() : null
}

async function validateProductionBundle(target) {
  const stat = await pathType(target)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unexpected app target: ${target}`)
  }
  if (bundleId(target) !== bundleIdentifier) {
    throw new Error(`Refusing non-Pulse MD bundle: ${target}`)
  }
  return true
}

function registeredProductionApps() {
  const dump = capture(launchServicesTool, ["-dump"]).stdout
  const registrations = new Set()
  let currentPath = null
  for (const line of dump.split("\n")) {
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

function defaultApplicationForUrl(url) {
  const script = [
    'ObjC.import("AppKit")',
    `const url = $.NSURL.URLWithString(${JSON.stringify(url)})`,
    "const application = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url)",
    'application.path ? ObjC.unwrap(application.path) : ""',
  ].join("; ")
  return capture("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
  ]).stdout.trim()
}

async function waitForProtocolApplication(url, expectedApplication) {
  const deadline = Date.now() + 10_000
  let resolved = ""
  while (Date.now() < deadline) {
    resolved = defaultApplicationForUrl(url)
    if (path.resolve(resolved || "/") === expectedApplication) return resolved
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return resolved
}

async function discoverProductionApps() {
  const apps = new Set()

  async function visit(target, remainingDepth) {
    const stat = await pathType(target)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return
    if (target.endsWith(".app")) {
      if (bundleId(target) === bundleIdentifier) apps.add(target)
      return
    }
    if (remainingDepth === 0) return
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      await visit(path.join(target, entry.name), remainingDepth - 1)
    }
  }

  for (const root of managedRoots) {
    await visit(root.path, root.depth)
  }
  return apps
}

function runningPulseProcesses() {
  return capture("/bin/ps", ["-axo", "pid=,command="])
    .stdout.split("\n")
    .filter((line) => /\/Contents\/MacOS\/Pulse MD(?:\s|$)/.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
}

async function inventory() {
  const registered = registeredProductionApps()
  const discovered = await discoverProductionApps()
  const duplicates = [...new Set([...registered, ...discovered])]
    .filter((target) => target !== installedApp)
    .sort()
  return { discovered, duplicates, registered }
}

async function check() {
  if (!(await validateProductionBundle(installedApp))) {
    throw new Error(`Installed Pulse MD bundle is missing: ${installedApp}`)
  }
  const protocolApplication = await waitForProtocolApplication(
    "pulse-md://scratch/11111111-1111-4111-8111-111111111111",
    installedApp
  )
  if (path.resolve(protocolApplication || "/") !== installedApp) {
    throw new Error(
      protocolApplication
        ? `pulse-md URLs resolve to ${protocolApplication}, expected ${installedApp}`
        : `pulse-md URLs do not resolve to ${installedApp}`
    )
  }
  const { discovered, duplicates, registered } = await inventory()
  if (duplicates.length > 0) {
    console.error("Duplicate Pulse MD production bundles or registrations:")
    for (const target of duplicates) {
      const state = [
        registered.has(target) ? "registered" : null,
        discovered.has(target) ? "present" : "missing",
      ]
        .filter(Boolean)
        .join(", ")
      console.error(`- ${target} (${state})`)
    }
    process.exitCode = 1
    return
  }
  console.log(`Sole Pulse MD production bundle: ${installedApp}`)
}

async function clean(dryRun) {
  if (!(await validateProductionBundle(installedApp))) {
    throw new Error(`Installed Pulse MD bundle is missing: ${installedApp}`)
  }
  const processes = runningPulseProcesses()
  if (processes.length > 0) {
    throw new Error(
      `Quit Pulse MD before cleaning registrations:\n${processes.join("\n")}`
    )
  }

  const { duplicates, registered } = await inventory()
  for (const target of duplicates) {
    const stat = await pathType(target)
    if (stat && !managedDuplicate(target)) {
      throw new Error(`Refusing unmanaged duplicate app: ${target}`)
    }
    if (registered.has(target)) {
      console.log(`${dryRun ? "Would unregister" : "Unregistering"}: ${target}`)
      if (!dryRun) capture(launchServicesTool, ["-u", target])
    }
    if (!stat) continue
    await validateProductionBundle(target)
    console.log(`${dryRun ? "Would remove" : "Removing"}: ${target}`)
    if (!dryRun) {
      await rm(target, { recursive: true })
      if (await pathType(target)) {
        throw new Error(`Duplicate app still exists after removal: ${target}`)
      }
    }
  }

  if (dryRun) return
  capture(launchServicesTool, ["-f", installedApp])
  await check()
}

if (process.platform !== "darwin") {
  throw new Error("Pulse MD LaunchServices cleanup is macOS-only")
}

const [command, ...options] = process.argv.slice(2)
const dryRun = options.includes("--dry-run")
if (
  !["check", "clean"].includes(command) ||
  options.some((option) => option !== "--dry-run") ||
  (command === "check" && dryRun)
) {
  usage()
  process.exitCode = 2
} else if (command === "check") {
  await check()
} else {
  await clean(dryRun)
}
