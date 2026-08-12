import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const projectRoot = path.resolve(import.meta.dirname, "..")
const releaseDirectory = path.join(projectRoot, "release")
const launchServicesTool =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
const require = createRequire(import.meta.url)
const { extractFile } = require("@electron/asar")

const platformByArgument = {
  linux: "linux",
  mac: "darwin",
  win: "win32",
}
const builderArgumentByPlatform = {
  darwin: "--mac",
  linux: "--linux",
  win32: "--win",
}
const artifactGroupsByPlatform = {
  darwin: [
    { label: "DMG", matches: (name) => name.endsWith(".dmg") },
    { label: "ZIP", matches: (name) => name.endsWith(".zip") },
  ],
  linux: [
    { label: "AppImage", matches: (name) => name.endsWith(".AppImage") },
    { label: "Debian package", matches: (name) => name.endsWith(".deb") },
  ],
  win32: [
    { label: "NSIS installer", matches: (name) => name.endsWith(".exe") },
  ],
}

function failure(label, result) {
  const detail = result.error?.message || result.stderr || result.stdout
  return new Error(
    `${label} failed${result.status === null ? "" : ` (exit ${result.status})`}${
      detail ? `\n${String(detail).trim()}` : ""
    }`
  )
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

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error("Run Local packaging through npm")
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

function removeTemporaryDirectory(target) {
  const temporaryRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(target)
  if (
    path.dirname(resolved) !== temporaryRoot ||
    !path.basename(resolved).startsWith("pulse-md-local-package-")
  ) {
    throw new Error(`Refusing unexpected temporary package path: ${target}`)
  }
  const stat = pathStat(resolved)
  if (!stat) return
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unexpected temporary package target: ${target}`)
  }
  rmSync(resolved, { recursive: true })
}

function localMetadataAt(asarPath) {
  const stat = pathStat(asarPath)
  if (!stat?.isFile() || stat.isSymbolicLink()) return null
  try {
    return JSON.parse(extractFile(asarPath, "package.json").toString("utf8"))
  } catch {
    return null
  }
}

function registeredLocalMacBundles() {
  if (process.platform !== "darwin") return new Set()
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

function canonicalExistingPath(target) {
  try {
    return realpathSync.native(target)
  } catch (error) {
    if (error?.code === "ENOENT") return path.resolve(target)
    throw error
  }
}

function unregisterLocalMacBundleIfRegistered(appBundle) {
  const canonicalAppBundle = canonicalExistingPath(appBundle)
  const registered = [...registeredLocalMacBundles()].some(
    (candidate) => canonicalExistingPath(candidate) === canonicalAppBundle
  )
  if (!registered) return
  run(launchServicesTool, ["-u", appBundle], {
    label: `unregistering generated Local app ${appBundle}`,
  })
}

function removeLegacyUnpackedOutputs() {
  const releaseStat = pathStat(releaseDirectory)
  if (!releaseStat) return
  requireRegularDirectory(releaseDirectory, "release directory")
  const unpackedName =
    /^(?:mac(?:-(?:arm64|x64|universal))?|win(?:-(?:arm64|ia32))?-unpacked|linux(?:-(?:arm64|ia32))?-unpacked)$/

  for (const entry of readdirSync(releaseDirectory, { withFileTypes: true })) {
    if (!unpackedName.test(entry.name)) continue
    const target = path.join(releaseDirectory, entry.name)
    const stat = pathStat(target)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing unexpected unpacked Local target: ${target}`)
    }
    const asarCandidates = entry.name.startsWith("mac")
      ? [
          path.join(
            target,
            "Pulse MD Local.app",
            "Contents",
            "Resources",
            "app.asar"
          ),
        ]
      : [path.join(target, "resources", "app.asar")]
    const metadata = asarCandidates.map(localMetadataAt).find(Boolean)
    if (
      metadata?.pmdDistributionChannel !== "local" ||
      metadata?.name !== "pulse-md-local" ||
      metadata?.productName !== "Pulse MD Local"
    ) {
      throw new Error(
        `Refusing to remove unverified unpacked output: ${target}`
      )
    }
    if (entry.name.startsWith("mac")) {
      unregisterLocalMacBundleIfRegistered(
        path.join(target, "Pulse MD Local.app")
      )
    }
    rmSync(target, { recursive: true })
    console.log(`Removed obsolete runnable package output ${target}`)
  }
}

function selectedArtifacts(outputDirectory, platform) {
  const entries = readdirSync(outputDirectory, { withFileTypes: true })
  const artifacts = []
  for (const group of artifactGroupsByPlatform[platform]) {
    const matches = entries.filter(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && group.matches(entry.name)
    )
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${group.label} artifact, found ${matches.length}`
      )
    }
    artifacts.push(path.join(outputDirectory, matches[0].name))
  }
  return artifacts
}

function generatedLocalMacApps(outputDirectory) {
  const apps = []
  const pending = [outputDirectory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const target = path.join(current, entry.name)
      if (entry.name.endsWith(".app")) {
        apps.push(target)
      } else {
        pending.push(target)
      }
    }
  }
  return apps
}

function unregisterGeneratedLocalMacApps(outputDirectory) {
  if (process.platform !== "darwin") return
  for (const appBundle of generatedLocalMacApps(outputDirectory)) {
    unregisterLocalMacBundleIfRegistered(appBundle)
  }
}

function promoteArtifacts(sources) {
  requireRegularDirectory(releaseDirectory, "release directory")
  const token = `${process.pid}-${randomUUID()}`
  const entries = sources.map((source, index) => ({
    incoming: path.join(releaseDirectory, `.local-incoming-${token}-${index}`),
    installed: false,
    movedPrevious: false,
    previous: path.join(releaseDirectory, `.local-previous-${token}-${index}`),
    source,
    target: path.join(releaseDirectory, path.basename(source)),
  }))
  if (new Set(entries.map(({ target }) => target)).size !== entries.length) {
    throw new Error("Local artifacts resolve to duplicate output names")
  }
  for (const entry of entries) {
    for (const reserved of [entry.incoming, entry.previous]) {
      if (pathStat(reserved)) {
        throw new Error(
          `Local artifact staging path already exists: ${reserved}`
        )
      }
    }
    const existing = pathStat(entry.target)
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error(
        `Refusing unexpected Local artifact target: ${entry.target}`
      )
    }
  }

  let committed = false
  try {
    for (const entry of entries) {
      copyFileSync(entry.source, entry.incoming)
      const incomingStat = pathStat(entry.incoming)
      if (!incomingStat?.isFile() || incomingStat.isSymbolicLink()) {
        throw new Error(`Local artifact copy is invalid: ${entry.incoming}`)
      }
    }
    for (const entry of entries) {
      if (pathStat(entry.target)) {
        renameSync(entry.target, entry.previous)
        entry.movedPrevious = true
      }
    }
    for (const entry of entries) {
      renameSync(entry.incoming, entry.target)
      entry.installed = true
    }
    committed = true
    for (const entry of entries) {
      if (entry.movedPrevious) unlinkSync(entry.previous)
    }
    return entries.map(({ target }) => target)
  } catch (error) {
    for (const entry of entries) {
      if (pathStat(entry.incoming)?.isFile()) unlinkSync(entry.incoming)
    }
    if (!committed) {
      for (const entry of [...entries].reverse()) {
        if (entry.installed && pathStat(entry.target)?.isFile()) {
          unlinkSync(entry.target)
        }
        if (
          entry.movedPrevious &&
          pathStat(entry.previous)?.isFile() &&
          !pathStat(entry.target)
        ) {
          renameSync(entry.previous, entry.target)
        }
      }
    }
    throw error
  }
}

function selectedPlatform() {
  const [argument, ...unexpected] = process.argv.slice(2)
  if (
    unexpected.length > 0 ||
    (argument && !(argument in platformByArgument))
  ) {
    throw new Error("Usage: node scripts/package-local.mjs [mac|win|linux]")
  }
  const requested = argument ? platformByArgument[argument] : process.platform
  if (requested !== process.platform) {
    throw new Error(`Local ${argument} packages must be built on ${requested}`)
  }
  if (!(requested in builderArgumentByPlatform)) {
    throw new Error(`Pulse MD Local packaging is unsupported on ${requested}`)
  }
  return requested
}

const platform = selectedPlatform()
const outputDirectory = mkdtempSync(
  path.join(os.tmpdir(), `pulse-md-local-package-${platform}-`)
)

try {
  const [npm, npmArgs] = npmInvocation(["run", "build"])
  runVisible(npm, npmArgs, { label: "application build" })
  const [builder, builderArgs] = builderInvocation([
    builderArgumentByPlatform[platform],
    "--config",
    "electron-builder.local.cjs",
    `--config.directories.output=${outputDirectory}`,
    "--publish",
    "never",
  ])
  runVisible(builder, builderArgs, {
    env: {
      ...process.env,
      ...(platform === "darwin"
        ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" }
        : {}),
    },
    label: "Local electron-builder package",
  })

  const artifacts = selectedArtifacts(outputDirectory, platform)
  mkdirSync(releaseDirectory, { recursive: true })
  requireRegularDirectory(releaseDirectory, "release directory")
  removeLegacyUnpackedOutputs()
  const promoted = promoteArtifacts(artifacts)
  console.log("Pulse MD Local artifacts:")
  for (const artifact of promoted) console.log(`- ${artifact}`)
} finally {
  try {
    unregisterGeneratedLocalMacApps(outputDirectory)
  } finally {
    removeTemporaryDirectory(outputDirectory)
  }
}
