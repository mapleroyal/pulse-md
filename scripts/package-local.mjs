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
  unlinkSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

const projectRoot = path.resolve(import.meta.dirname, "..")
const releaseDirectory = path.join(projectRoot, "release")
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)
const launchServicesTool =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

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
const artifactPrefix = `${packageMetadata.productName}-${packageMetadata.version}`
const linuxArtifactArchitectures = {
  arm: { appImage: "armv7l", debian: "armv7l" },
  arm64: { appImage: "arm64", debian: "arm64" },
  ia32: { appImage: "i386", debian: "i386" },
  x64: { appImage: "x86_64", debian: "amd64" },
}

function artifactGroups(platform) {
  if (platform === "darwin") {
    return [
      { label: "DMG", name: `${artifactPrefix}-${process.arch}.dmg` },
      { label: "ZIP", name: `${artifactPrefix}-${process.arch}-mac.zip` },
    ]
  }
  if (platform === "win32") {
    return [
      {
        label: "NSIS installer",
        name: `${artifactPrefix}-${process.arch}.exe`,
      },
    ]
  }
  const architectures = linuxArtifactArchitectures[process.arch]
  if (!architectures) {
    throw new Error(`Unsupported Linux package architecture: ${process.arch}`)
  }
  return [
    {
      label: "AppImage",
      name: `${artifactPrefix}-${architectures.appImage}.AppImage`,
    },
    {
      label: "Debian package",
      name: `${artifactPrefix}-${architectures.debian}.deb`,
    },
  ]
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
  if (!npmCli) throw new Error("Run source packaging through npm")
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
    !path.basename(resolved).startsWith("pulse-md-source-package-")
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

function registeredMacBundles() {
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
      /^identifier:\s+io\.github\.mapleroyal\.pulse-md$/.test(line)
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

function unregisterMacBundleIfRegistered(appBundle) {
  const canonicalAppBundle = canonicalExistingPath(appBundle)
  const registered = [...registeredMacBundles()].some(
    (candidate) => canonicalExistingPath(candidate) === canonicalAppBundle
  )
  if (!registered) return
  run(launchServicesTool, ["-u", appBundle], {
    label: `unregistering generated source app ${appBundle}`,
  })
}

function selectedArtifacts(outputDirectory, platform) {
  const entries = readdirSync(outputDirectory, { withFileTypes: true })
  const artifacts = []
  for (const group of artifactGroups(platform)) {
    const matches = entries.filter(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && entry.name === group.name
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

function generatedMacApps(outputDirectory) {
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

function unregisterGeneratedMacApps(outputDirectory) {
  if (process.platform !== "darwin") return
  for (const appBundle of generatedMacApps(outputDirectory)) {
    unregisterMacBundleIfRegistered(appBundle)
  }
}

function packagedRuntimeRoot(outputDirectory, platform) {
  if (platform === "darwin") {
    const apps = generatedMacApps(outputDirectory).filter(
      (candidate) => path.basename(candidate) === "Pulse MD.app"
    )
    if (apps.length !== 1) {
      throw new Error(
        `Expected one unpacked Pulse MD app, found ${apps.length}`
      )
    }
    return apps[0]
  }

  const executableName = platform === "win32" ? "Pulse MD.exe" : "pulse-md"
  const directoryPattern =
    platform === "win32" ? /^win.*-unpacked$/ : /^linux.*-unpacked$/
  const roots = readdirSync(outputDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.isDirectory() &&
        directoryPattern.test(entry.name)
    )
    .map((entry) => path.join(outputDirectory, entry.name))
    .filter((root) => {
      const executable = pathStat(path.join(root, executableName))
      return executable?.isFile() && !executable.isSymbolicLink()
    })
  if (roots.length !== 1) {
    throw new Error(
      `Expected one unpacked ${platform} Pulse MD runtime, found ${roots.length}`
    )
  }
  return roots[0]
}

function verifyPackagedRuntime(outputDirectory, platform) {
  const root = packagedRuntimeRoot(outputDirectory, platform)
  runVisible(
    process.execPath,
    [path.join(projectRoot, "scripts", "test-packaged-runtime.mjs")],
    {
      env: { ...process.env, PMD_PACKAGED_ROOT: root },
      label: "source packaged-runtime verification",
    }
  )
}

function promoteArtifacts(sources) {
  requireRegularDirectory(releaseDirectory, "release directory")
  const token = `${process.pid}-${randomUUID()}`
  const entries = sources.map((source, index) => ({
    incoming: path.join(releaseDirectory, `.source-incoming-${token}-${index}`),
    installed: false,
    movedPrevious: false,
    previous: path.join(releaseDirectory, `.source-previous-${token}-${index}`),
    source,
    target: path.join(releaseDirectory, path.basename(source)),
  }))
  if (new Set(entries.map(({ target }) => target)).size !== entries.length) {
    throw new Error("Source artifacts resolve to duplicate output names")
  }
  for (const entry of entries) {
    for (const reserved of [entry.incoming, entry.previous]) {
      if (pathStat(reserved)) {
        throw new Error(
          `Source artifact staging path already exists: ${reserved}`
        )
      }
    }
    const existing = pathStat(entry.target)
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error(
        `Refusing unexpected source artifact target: ${entry.target}`
      )
    }
  }

  let committed = false
  try {
    for (const entry of entries) {
      copyFileSync(entry.source, entry.incoming)
      const incomingStat = pathStat(entry.incoming)
      if (!incomingStat?.isFile() || incomingStat.isSymbolicLink()) {
        throw new Error(`Source artifact copy is invalid: ${entry.incoming}`)
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
    throw new Error(`Source ${argument} packages must be built on ${requested}`)
  }
  if (!(requested in builderArgumentByPlatform)) {
    throw new Error(`Pulse MD packaging is unsupported on ${requested}`)
  }
  return requested
}

const platform = selectedPlatform()
const outputDirectory = mkdtempSync(
  path.join(os.tmpdir(), `pulse-md-source-package-${platform}-`)
)

try {
  if (platform === "darwin") {
    const [npm, npmArgs] = npmInvocation(["run", "icon:build"])
    runVisible(npm, npmArgs, { label: "adaptive macOS icon build" })
  }
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
        ? {
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            PMD_ICON_COMPOSER_BUILD: "1",
          }
        : {}),
    },
    label: "source electron-builder package",
  })

  verifyPackagedRuntime(outputDirectory, platform)
  const artifacts = selectedArtifacts(outputDirectory, platform)
  mkdirSync(releaseDirectory, { recursive: true })
  requireRegularDirectory(releaseDirectory, "release directory")
  const promoted = promoteArtifacts(artifacts)
  console.log("Pulse MD source artifacts:")
  for (const artifact of promoted) console.log(`- ${artifact}`)
} finally {
  try {
    unregisterGeneratedMacApps(outputDirectory)
  } finally {
    removeTemporaryDirectory(outputDirectory)
  }
}
