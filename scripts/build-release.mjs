import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const projectRoot = path.resolve(import.meta.dirname, "..")
const releaseDirectory = path.join(projectRoot, "release")
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)
const officialProductName = "Pulse MD"
const officialBundleIdentifier = "io.github.mapleroyal.pulse-md"
const launchServicesTool =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
const linuxArtifactExtractionPrefix = "pulse-md-release-artifact-"

function commandFailure(label, result) {
  const detail = result.error?.message || result.stderr || result.stdout
  const suffix = detail ? `\n${String(detail).trim()}` : ""
  return new Error(
    `${label} failed${result.status === null ? "" : ` (exit ${result.status})`}${suffix}`
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
    throw commandFailure(options.label || command, result)
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
    throw new Error(
      `${options.label || command} failed${
        result.status === null ? "" : ` (exit ${result.status})`
      }`
    )
  }
}

function verifyPackagedRuntime(root, environment, label) {
  runVisible(
    process.execPath,
    [path.join(projectRoot, "scripts", "test-packaged-runtime.mjs")],
    {
      env: { ...environment, PMD_PACKAGED_ROOT: root },
      label,
    }
  )
}

function configuredGroup(environment, names) {
  const present = names.filter((name) => environment[name])
  if (present.length === 0) return false
  if (present.length !== names.length) {
    const missing = names.filter((name) => !environment[name])
    throw new Error(
      `Incomplete notarization credentials; missing ${missing.join(", ")}`
    )
  }
  return true
}

export function notarizationAuthorization(environment) {
  const apiNames = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]
  const appleIdNames = [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]
  const hasApiKey = configuredGroup(environment, apiNames)
  const hasAppleId = configuredGroup(environment, appleIdNames)
  const hasKeychainProfile = Boolean(environment.APPLE_KEYCHAIN_PROFILE)
  const methodCount = [hasApiKey, hasAppleId, hasKeychainProfile].filter(
    Boolean
  ).length

  if (methodCount === 0) {
    throw new Error(
      "Official macOS builds require one complete notarytool credential set: the APPLE_API_* triplet, the APPLE_ID triplet, or APPLE_KEYCHAIN_PROFILE"
    )
  }
  if (methodCount > 1) {
    throw new Error(
      "Configure exactly one notarization credential method for an official macOS build"
    )
  }

  if (hasApiKey) {
    return {
      kind: "api-key",
      notarytoolArgs: [
        "--key",
        environment.APPLE_API_KEY,
        "--key-id",
        environment.APPLE_API_KEY_ID,
        "--issuer",
        environment.APPLE_API_ISSUER,
      ],
    }
  }
  if (hasAppleId) {
    return {
      kind: "apple-id",
      notarytoolArgs: [
        "--apple-id",
        environment.APPLE_ID,
        "--password",
        environment.APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        environment.APPLE_TEAM_ID,
      ],
    }
  }

  return {
    kind: "keychain-profile",
    notarytoolArgs: [
      "--keychain-profile",
      environment.APPLE_KEYCHAIN_PROFILE,
      ...(environment.APPLE_KEYCHAIN
        ? ["--keychain", environment.APPLE_KEYCHAIN]
        : []),
    ],
  }
}

export function parseDeveloperIdIdentities(output) {
  return output
    .split("\n")
    .map((line) => /"(Developer ID Application:[^"]+)"/.exec(line)?.[1])
    .filter(Boolean)
}

export function resolveMacSigningEnvironment(environment, identityOutput) {
  const result = { ...environment }
  const identities = parseDeveloperIdIdentities(identityOutput)
  const requestedIdentity = environment.CSC_NAME?.trim()

  if (requestedIdentity) {
    if (!requestedIdentity.startsWith("Developer ID Application:")) {
      throw new Error(
        "CSC_NAME for an official macOS build must name a Developer ID Application certificate"
      )
    }
    if (!environment.CSC_LINK && !identities.includes(requestedIdentity)) {
      throw new Error(
        `The requested Developer ID Application identity is not available in the keychain: ${requestedIdentity}`
      )
    }
    result.CSC_NAME = requestedIdentity
    return result
  }

  if (environment.CSC_LINK) return result
  if (identities.length === 0) {
    throw new Error(
      "Official macOS builds require a Developer ID Application certificate in the keychain or CSC_LINK"
    )
  }
  if (identities.length > 1) {
    throw new Error(
      "Multiple Developer ID Application certificates are available; set CSC_NAME to the intended exact identity"
    )
  }
  result.CSC_NAME = identities[0]
  return result
}

export function hasWindowsSigningCredentials(environment) {
  return Boolean(environment.WIN_CSC_LINK || environment.CSC_LINK)
}

export function electronBuilderArguments(platform, outputDirectory) {
  const publishNever = ["--publish", "never"]
  const releaseConfiguration = ["--config", "electron-builder.config.cjs"]
  const output = outputDirectory
    ? [`--config.directories.output=${outputDirectory}`]
    : []
  if (platform === "mac") {
    return [
      "--mac",
      ...releaseConfiguration,
      "--config.mac.icon=build/pulse-md.icon",
      "--config.forceCodeSigning=true",
      "--config.mac.notarize=true",
      ...output,
      ...publishNever,
    ]
  }
  if (platform === "win") {
    return [
      "--win",
      ...releaseConfiguration,
      "--config.forceCodeSigning=true",
      ...output,
      ...publishNever,
    ]
  }
  if (platform === "linux")
    return ["--linux", ...releaseConfiguration, ...output, ...publishNever]
  throw new Error(`Unsupported release platform: ${platform}`)
}

function assertReleaseHost(platform) {
  const requiredHost = { linux: "linux", mac: "darwin", win: "win32" }[platform]
  if (!requiredHost)
    throw new Error(`Unsupported release platform: ${platform}`)
  if (process.platform !== requiredHost) {
    throw new Error(
      `Official ${platform} packages must be built on ${requiredHost}; current host is ${process.platform}`
    )
  }
}

function existingDirectory(directory) {
  try {
    const stat = lstatSync(directory)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function discoverAppBundles(directory) {
  if (!existingDirectory(directory)) return []
  const apps = []
  const pending = [directory]
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

function discoverFiles(directory, suffixes) {
  if (!existingDirectory(directory)) return []
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(target)
      } else if (
        entry.isFile() &&
        suffixes.some((suffix) => entry.name.toLowerCase().endsWith(suffix))
      ) {
        files.push(target)
      }
    }
  }
  return files
}

function releaseEntries(directory) {
  if (!existingDirectory(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
}

function validateReleaseDirectory() {
  mkdirSync(releaseDirectory, { recursive: true })
  if (!existingDirectory(releaseDirectory)) {
    throw new Error(
      `Release output is not a regular directory: ${releaseDirectory}`
    )
  }
}

function outputLabel(platform) {
  return { linux: "linux", mac: "macos", win: "windows" }[platform]
}

export function releaseOutputNames(platform, architecture, version) {
  const label = outputLabel(platform)
  if (!label) throw new Error(`Unsupported release platform: ${platform}`)
  if (!/^[a-z0-9_]+$/.test(architecture)) {
    throw new Error(`Unexpected release architecture: ${architecture}`)
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Unexpected release version: ${version}`)
  }
  return {
    checksumName: `SHA256SUMS-${label}-${architecture}`,
    directoryName: `official-${label}-${architecture}-${version}`,
  }
}

function prepareReleaseOutput(platform, architecture) {
  validateReleaseDirectory()
  const names = releaseOutputNames(
    platform,
    architecture,
    packageMetadata.version
  )
  const finalDirectory = path.join(releaseDirectory, names.directoryName)
  if (lstatIfPresent(finalDirectory)) {
    throw new Error(
      `Refusing to overwrite an existing official output. Archive or remove it deliberately, then retry: ${finalDirectory}`
    )
  }
  const stagingPrefix = path.join(
    releaseDirectory,
    `.staging-${outputLabel(platform)}-`
  )
  const stagingDirectory = mkdtempSync(stagingPrefix)
  assertManagedStagingDirectory(stagingDirectory)
  return { finalDirectory, stagingDirectory }
}

function lstatIfPresent(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function assertManagedStagingDirectory(target) {
  const relative = path.relative(releaseDirectory, target)
  if (
    path.dirname(relative) !== "." ||
    !/^\.staging-(?:linux|macos|windows)-[A-Za-z0-9]+$/.test(relative)
  ) {
    throw new Error(`Refusing unmanaged release staging path: ${target}`)
  }
  const stat = lstatIfPresent(target)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(
      `Release staging path is not a regular directory: ${target}`
    )
  }
}

function removeReleaseStaging(target) {
  assertManagedStagingDirectory(target)
  if (!lstatIfPresent(target)) return
  rmSync(target, { recursive: true })
  if (lstatIfPresent(target)) {
    throw new Error(`Release staging cleanup failed: ${target}`)
  }
}

function promoteReleaseStaging(stagingDirectory, finalDirectory) {
  assertManagedStagingDirectory(stagingDirectory)
  if (lstatIfPresent(finalDirectory)) {
    throw new Error(
      `Official output appeared during the build: ${finalDirectory}`
    )
  }
  renameSync(stagingDirectory, finalDirectory)
  if (!existingDirectory(finalDirectory)) {
    throw new Error(`Official output promotion failed: ${finalDirectory}`)
  }
}

export function isUnusedUpdateMetadata(filename) {
  return (
    filename.endsWith(".blockmap") ||
    /^latest(?:-[^.]+)?\.ya?ml$/.test(filename) ||
    filename === "builder-debug.yml" ||
    filename === "builder-effective-config.yaml"
  )
}

export function authenticodeArguments(expectedVersion, files) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(projectRoot, "scripts", "verify-authenticode.ps1"),
    "-ExpectedVersion",
    expectedVersion,
    ...files,
  ]
}

function removeUnusedUpdateMetadata(directory) {
  for (const entry of releaseEntries(directory)) {
    if (!entry.isFile() || !isUnusedUpdateMetadata(entry.name)) continue
    const target = path.join(directory, entry.name)
    const stat = lstatIfPresent(target)
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing unexpected update metadata target: ${target}`)
    }
    rmSync(target)
  }
}

function registeredOfficialMacBundles() {
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

function unregisterOfficialMacBundleIfRegistered(appBundle) {
  if (process.platform !== "darwin") return
  const canonicalAppBundle = canonicalExistingPath(appBundle)
  const registered = [...registeredOfficialMacBundles()].some(
    (candidate) => canonicalExistingPath(candidate) === canonicalAppBundle
  )
  if (!registered) return
  run(launchServicesTool, ["-u", appBundle], {
    label: `unregistering generated official app ${appBundle}`,
  })
}

export function pruneReleaseStaging(
  directory,
  artifacts,
  platform,
  unregisterMacBundle = unregisterOfficialMacBundleIfRegistered
) {
  if (!existingDirectory(directory)) {
    throw new Error(`Release staging directory is missing: ${directory}`)
  }
  const retained = new Set()
  for (const artifact of artifacts) {
    const resolved = path.resolve(artifact)
    if (path.dirname(resolved) !== path.resolve(directory)) {
      throw new Error(`Release artifact is outside staging: ${artifact}`)
    }
    const stat = lstatIfPresent(resolved)
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Release artifact is not a regular file: ${artifact}`)
    }
    retained.add(resolved)
  }

  for (const entry of releaseEntries(directory)) {
    const target = path.join(directory, entry.name)
    if (retained.has(path.resolve(target))) continue
    const stat = lstatIfPresent(target)
    if (!stat || stat.isSymbolicLink()) {
      throw new Error(`Unexpected release staging entry: ${target}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Unexpected release staging file: ${target}`)
    }
    if (platform === "mac") {
      for (const appBundle of discoverAppBundles(target)) {
        unregisterMacBundle(appBundle)
      }
    }
    rmSync(target, { recursive: true })
    if (lstatIfPresent(target)) {
      throw new Error(`Unpacked release cleanup failed: ${target}`)
    }
  }
}

function verifyMacApp(appBundle, architecture) {
  if (path.basename(appBundle) !== `${officialProductName}.app`) {
    throw new Error(`Unexpected app in official release output: ${appBundle}`)
  }
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appBundle,
  ])
  const details = run("/usr/bin/codesign", [
    "--display",
    "--verbose=4",
    appBundle,
  ]).stderr
  if (!/^Authority=Developer ID Application:/m.test(details)) {
    throw new Error(
      `Official app is not signed with Developer ID: ${appBundle}`
    )
  }
  if (!details.split("\n").includes(`Identifier=${officialBundleIdentifier}`)) {
    throw new Error(
      `Official app has the wrong bundle identifier: ${appBundle}`
    )
  }
  const version = run("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    path.join(appBundle, "Contents", "Info.plist"),
  ]).stdout.trim()
  if (version !== packageMetadata.version) {
    throw new Error(
      `Official app version is ${version}, expected ${packageMetadata.version}: ${appBundle}`
    )
  }
  const expectedMacArchitecture =
    architecture === "x64" ? "x86_64" : architecture
  const architectures = run("/usr/bin/lipo", [
    "-archs",
    path.join(appBundle, "Contents", "MacOS", officialProductName),
  ]).stdout.trim()
  if (architectures !== expectedMacArchitecture) {
    throw new Error(
      `Official app architecture is ${architectures}, expected ${expectedMacArchitecture}: ${appBundle}`
    )
  }
  if (!/^CodeDirectory .+flags=.*\bruntime\b/m.test(details)) {
    throw new Error(
      `Official app is missing the hardened runtime: ${appBundle}`
    )
  }
  run(
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", appBundle],
    { label: "Gatekeeper app assessment" }
  )
  run("/usr/bin/xcrun", ["stapler", "validate", appBundle], {
    label: "stapled app ticket validation",
  })
}

function submitAndStapleDmg(dmg, authorization) {
  const submission = run(
    "/usr/bin/xcrun",
    [
      "notarytool",
      "submit",
      dmg,
      ...authorization.notarytoolArgs,
      "--wait",
      "--output-format",
      "json",
    ],
    { label: "DMG notarization" }
  )
  let result
  try {
    result = JSON.parse(submission.stdout)
  } catch (error) {
    throw new Error("notarytool returned invalid JSON for the DMG submission", {
      cause: error,
    })
  }
  if (result.status !== "Accepted") {
    throw new Error(`Apple did not accept the DMG (status: ${result.status})`)
  }
  run("/usr/bin/xcrun", ["stapler", "staple", "-v", dmg], {
    label: "DMG ticket stapling",
  })
  run("/usr/bin/xcrun", ["stapler", "validate", dmg], {
    label: "stapled DMG ticket validation",
  })
  run(
    "/usr/sbin/spctl",
    [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmg,
    ],
    { label: "Gatekeeper DMG assessment" }
  )
}

function verifyMacZip(zip, architecture, environment) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "pulse-md-release-zip-")
  )
  const expectedPrefix = path.join(os.tmpdir(), "pulse-md-release-zip-")
  if (!temporaryDirectory.startsWith(expectedPrefix)) {
    throw new Error(
      `Refusing to use unexpected temporary directory: ${temporaryDirectory}`
    )
  }
  try {
    run("/usr/bin/ditto", ["-x", "-k", zip, temporaryDirectory], {
      label: "release ZIP extraction",
    })
    const apps = discoverAppBundles(temporaryDirectory)
    if (apps.length !== 1) {
      throw new Error(
        `Official release ZIP must contain one app; found ${apps.length}: ${zip}`
      )
    }
    verifyMacApp(apps[0], architecture)
    verifyPackagedRuntime(
      apps[0],
      environment,
      "extracted macOS ZIP runtime verification"
    )
  } finally {
    for (const app of discoverAppBundles(temporaryDirectory)) {
      unregisterOfficialMacBundleIfRegistered(app)
    }
    rmSync(temporaryDirectory, { recursive: true })
  }
}

function verifyMacRelease(directory, architecture, authorization, environment) {
  const entries = releaseEntries(directory)
  const outputDirectories = entries
    .filter((entry) => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
  const apps = outputDirectories.flatMap(discoverAppBundles)
  if (apps.length === 0) {
    throw new Error("No unpacked official macOS app was produced")
  }
  for (const app of apps) verifyMacApp(app, architecture)

  const versionPrefix = `${officialProductName}-${packageMetadata.version}`
  const dmgs = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(versionPrefix) &&
        entry.name.endsWith(".dmg")
    )
    .map((entry) => path.join(directory, entry.name))
  const zips = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(versionPrefix) &&
        entry.name.endsWith(".zip")
    )
    .map((entry) => path.join(directory, entry.name))
  if (dmgs.length === 0 || zips.length === 0) {
    throw new Error(
      "Official macOS release must produce both DMG and ZIP artifacts"
    )
  }
  for (const dmg of dmgs) submitAndStapleDmg(dmg, authorization)
  for (const zip of zips) verifyMacZip(zip, architecture, environment)
  return [...dmgs, ...zips]
}

export function windowsUnpackedDirectoryName(architecture) {
  if (!["arm64", "ia32", "x64"].includes(architecture)) {
    throw new Error(`Unsupported Windows release architecture: ${architecture}`)
  }
  return architecture === "x64"
    ? "win-unpacked"
    : `win-${architecture}-unpacked`
}

function verifyWindowsRelease(directory, architecture, environment) {
  const entries = releaseEntries(directory)
  const expectedUnpackedName = windowsUnpackedDirectoryName(architecture)
  const unpacked = entries
    .filter(
      (entry) => entry.isDirectory() && entry.name === expectedUnpackedName
    )
    .map((entry) => path.join(directory, entry.name))
  const installers = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(
          `${officialProductName}-${packageMetadata.version}-`
        ) &&
        entry.name.endsWith(`-${architecture}.exe`)
    )
    .map((entry) => path.join(directory, entry.name))
  if (unpacked.length === 0 || installers.length === 0) {
    throw new Error(
      "Official Windows release must produce an unpacked app and installer"
    )
  }

  const signedFiles = [...installers]
  for (const directory of unpacked) {
    const discovered = discoverFiles(directory, [".exe", ".dll", ".node"])
    for (const required of [
      path.join(directory, `${officialProductName}.exe`),
      path.join(directory, "resources", "bin", "pmd.exe"),
    ]) {
      if (!discovered.includes(required)) {
        throw new Error(`Required Windows executable is missing: ${required}`)
      }
    }
    signedFiles.push(...discovered)
  }
  runVisible(
    "powershell.exe",
    authenticodeArguments(packageMetadata.version, signedFiles),
    { label: "Authenticode verification" }
  )
  verifyPackagedRuntime(
    unpacked[0],
    environment,
    "staged Windows runtime verification"
  )
  return installers
}

const linuxArchitectures = {
  arm: {
    appImageArtifact: "armv7l",
    debianArtifact: "armv7l",
    debianPackage: "armhf",
    elfClass: 1,
    elfMachine: 40,
  },
  arm64: {
    appImageArtifact: "arm64",
    debianArtifact: "arm64",
    debianPackage: "arm64",
    elfClass: 2,
    elfMachine: 183,
  },
  ia32: {
    appImageArtifact: "i386",
    debianArtifact: "i386",
    debianPackage: "i386",
    elfClass: 1,
    elfMachine: 3,
  },
  x64: {
    appImageArtifact: "x86_64",
    debianArtifact: "amd64",
    debianPackage: "amd64",
    elfClass: 2,
    elfMachine: 62,
  },
}

function linuxArchitecture(architecture) {
  const details = linuxArchitectures[architecture]
  if (!details) {
    throw new Error(`Unsupported Linux release architecture: ${architecture}`)
  }
  return details
}

export function linuxReleaseArtifactNames(
  architecture,
  version = packageMetadata.version
) {
  const details = linuxArchitecture(architecture)
  const prefix = `${officialProductName}-${version}-`
  return {
    appImage: `${prefix}${details.appImageArtifact}.AppImage`,
    debian: `${prefix}${details.debianArtifact}.deb`,
  }
}

function linuxReleaseArtifacts(directory, architecture) {
  const names = linuxReleaseArtifactNames(architecture)
  const artifacts = [names.appImage, names.debian].map((name) =>
    path.join(directory, name)
  )
  for (const artifact of artifacts) {
    const stat = lstatIfPresent(artifact)
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Required Linux release artifact is missing: ${artifact}`)
    }
  }
  return artifacts
}

export function validateLinuxDebianMetadata(
  metadata,
  architecture,
  artifact = "Debian package"
) {
  const expected = {
    Architecture: linuxArchitecture(architecture).debianPackage,
    Package: packageMetadata.name,
    Version: packageMetadata.version,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (metadata[field] !== value) {
      throw new Error(
        `Debian package ${field} is ${metadata[field] || "missing"}, expected ${value}: ${artifact}`
      )
    }
  }
}

function verifyLinuxDebianMetadata(artifact, architecture) {
  const metadata = {}
  for (const field of ["Package", "Version", "Architecture"]) {
    metadata[field] = run("dpkg-deb", ["--field", artifact, field], {
      label: `Debian package ${field} check`,
    }).stdout.trim()
  }
  validateLinuxDebianMetadata(metadata, architecture, artifact)
}

export function validateLinuxAppImageHeader(
  header,
  architecture,
  artifact = "AppImage"
) {
  const bytes = Buffer.isBuffer(header) ? header : Buffer.from(header)
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    throw new Error(`AppImage does not have a valid ELF header: ${artifact}`)
  }
  const byteOrder = bytes[5]
  if (byteOrder !== 1 && byteOrder !== 2) {
    throw new Error(`AppImage has an unsupported ELF byte order: ${artifact}`)
  }

  const details = linuxArchitecture(architecture)
  const elfClass = bytes[4]
  const elfMachine =
    byteOrder === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18)
  if (elfClass !== details.elfClass || elfMachine !== details.elfMachine) {
    throw new Error(
      `AppImage ELF architecture is class ${elfClass}, machine ${elfMachine}; expected class ${details.elfClass}, machine ${details.elfMachine}: ${artifact}`
    )
  }
}

function verifyLinuxAppImageArchitecture(artifact, architecture) {
  const header = Buffer.alloc(20)
  const descriptor = openSync(artifact, "r")
  try {
    const bytesRead = readSync(descriptor, header, 0, header.length, 0)
    validateLinuxAppImageHeader(
      header.subarray(0, bytesRead),
      architecture,
      artifact
    )
  } finally {
    closeSync(descriptor)
  }
}

export function linuxArtifactExtractionPlan(artifact, extractionDirectory) {
  const absoluteArtifact = path.resolve(artifact)
  const absoluteExtractionDirectory = path.resolve(extractionDirectory)
  if (absoluteArtifact.endsWith(".AppImage")) {
    return {
      args: ["--appimage-extract"],
      command: absoluteArtifact,
      cwd: absoluteExtractionDirectory,
      format: "appimage",
    }
  }
  if (absoluteArtifact.endsWith(".deb")) {
    return {
      args: ["--extract", absoluteArtifact, absoluteExtractionDirectory],
      command: "dpkg-deb",
      cwd: absoluteExtractionDirectory,
      format: "debian",
    }
  }
  throw new Error(`Unsupported Linux release artifact: ${artifact}`)
}

export function linuxArtifactRuntimeRootCandidates(
  format,
  extractionDirectory
) {
  const root = path.resolve(extractionDirectory)
  if (format === "appimage") {
    const appImageRoot = path.join(root, "squashfs-root")
    return [
      appImageRoot,
      path.join(appImageRoot, "usr", "lib", packageMetadata.name),
    ]
  }
  if (format === "debian") {
    return [
      path.join(root, "opt", officialProductName),
      path.join(root, "usr", "lib", packageMetadata.name),
    ]
  }
  throw new Error(`Unsupported Linux release artifact format: ${format}`)
}

function isLinuxPackagedRuntimeRoot(root, pathStat) {
  const rootStat = pathStat(root)
  const executableStat = pathStat(path.join(root, "pulse-md"))
  const resourcesStat = pathStat(path.join(root, "resources"))
  return Boolean(
    rootStat?.isDirectory() &&
    !rootStat.isSymbolicLink() &&
    executableStat?.isFile() &&
    !executableStat.isSymbolicLink() &&
    (executableStat.mode & 0o111) !== 0 &&
    resourcesStat?.isDirectory() &&
    !resourcesStat.isSymbolicLink()
  )
}

export function resolveLinuxArtifactRuntimeRoot(
  format,
  extractionDirectory,
  { pathStat = lstatIfPresent } = {}
) {
  const candidates = linuxArtifactRuntimeRootCandidates(
    format,
    extractionDirectory
  )
  const matches = candidates.filter((candidate) =>
    isLinuxPackagedRuntimeRoot(candidate, pathStat)
  )
  if (matches.length !== 1) {
    throw new Error(
      `${format} extraction must contain exactly one canonical Pulse MD runtime root; found ${matches.length}. Checked:\n${candidates
        .map((candidate) => `- ${candidate}`)
        .join("\n")}`
    )
  }
  return matches[0]
}

function assertManagedLinuxArtifactExtraction(target) {
  const absoluteTarget = path.resolve(target)
  const temporaryRoot = path.resolve(os.tmpdir())
  const relative = path.relative(temporaryRoot, absoluteTarget)
  if (
    path.dirname(relative) !== "." ||
    !/^pulse-md-release-artifact-[A-Za-z0-9]{6}$/.test(relative)
  ) {
    throw new Error(
      `Refusing unmanaged Linux artifact extraction path: ${target}`
    )
  }
  const stat = lstatIfPresent(absoluteTarget)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(
      `Linux artifact extraction path is not a regular directory: ${target}`
    )
  }
}

function removeLinuxArtifactExtraction(target) {
  assertManagedLinuxArtifactExtraction(target)
  if (!lstatIfPresent(target)) return
  rmSync(target, { recursive: true })
  if (lstatIfPresent(target)) {
    throw new Error(`Linux artifact extraction cleanup failed: ${target}`)
  }
}

function withEnvironmentPrefix(prefix, value) {
  return value ? `${prefix}:${value}` : prefix
}

function appImageRuntimeEnvironment(extractionDirectory, environment) {
  const appDir = path.join(extractionDirectory, "squashfs-root")
  const shareDirectory = path.join(appDir, "usr", "share")
  return {
    ...environment,
    APPDIR: appDir,
    GSETTINGS_SCHEMA_DIR: withEnvironmentPrefix(
      path.join(shareDirectory, "glib-2.0", "schemas"),
      environment.GSETTINGS_SCHEMA_DIR
    ),
    LD_LIBRARY_PATH: withEnvironmentPrefix(
      path.join(appDir, "usr", "lib"),
      environment.LD_LIBRARY_PATH
    ),
    PATH: withEnvironmentPrefix(
      `${appDir}:${path.join(appDir, "usr", "sbin")}`,
      environment.PATH
    ),
    XDG_DATA_DIRS: withEnvironmentPrefix(
      shareDirectory,
      environment.XDG_DATA_DIRS ||
        "/usr/share/gnome:/usr/local/share/:/usr/share/"
    ),
  }
}

function verifyLinuxArtifactRuntime(artifact, environment) {
  const extractionDirectory = mkdtempSync(
    path.join(os.tmpdir(), linuxArtifactExtractionPrefix)
  )
  assertManagedLinuxArtifactExtraction(extractionDirectory)
  try {
    const plan = linuxArtifactExtractionPlan(artifact, extractionDirectory)
    run(plan.command, plan.args, {
      cwd: plan.cwd,
      env: environment,
      label: `${plan.format} payload extraction`,
    })
    const runtimeRoot = resolveLinuxArtifactRuntimeRoot(
      plan.format,
      extractionDirectory
    )
    const runtimeEnvironment =
      plan.format === "appimage"
        ? appImageRuntimeEnvironment(extractionDirectory, environment)
        : { ...environment }

    verifyPackagedRuntime(
      runtimeRoot,
      runtimeEnvironment,
      `${plan.format} packaged runtime verification`
    )
  } finally {
    removeLinuxArtifactExtraction(extractionDirectory)
  }
}

function verifyLinuxRelease(directory, architecture, environment) {
  const artifacts = linuxReleaseArtifacts(directory, architecture)
  const [appImage, debian] = artifacts
  verifyLinuxAppImageArchitecture(appImage, architecture)
  verifyLinuxDebianMetadata(debian, architecture)
  verifyLinuxArtifactRuntime(appImage, environment)
  verifyLinuxArtifactRuntime(debian, environment)
  return artifacts
}

function writeChecksums(directory, platform, architecture, artifacts) {
  if (artifacts.length === 0) return
  const lines = [...artifacts]
    .sort((left, right) =>
      path.basename(left).localeCompare(path.basename(right))
    )
    .map((artifact) => {
      const digest = createHash("sha256")
        .update(readFileSync(artifact))
        .digest("hex")
      return `${digest}  ${path.basename(artifact)}`
    })
  const checksumFile = path.join(
    directory,
    releaseOutputNames(platform, architecture, packageMetadata.version)
      .checksumName
  )
  writeFileSync(checksumFile, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o644,
  })
  console.log(`Wrote ${checksumFile}`)
}

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    throw new Error("Run official release builds through an npm script")
  }
  return [process.execPath, [npmCli, ...args]]
}

function builderInvocation(args) {
  const builderCli = path.join(
    projectRoot,
    "node_modules",
    "electron-builder",
    "cli.js"
  )
  return [process.execPath, [builderCli, ...args]]
}

async function main() {
  const [platform, ...options] = process.argv.slice(2)
  if (!["linux", "mac", "win"].includes(platform) || options.length !== 0) {
    throw new Error("Usage: node scripts/build-release.mjs <mac|win|linux>")
  }
  assertReleaseHost(platform)

  let childEnvironment = { ...process.env }
  let notarization
  if (platform === "mac") {
    notarization = notarizationAuthorization(childEnvironment)
    const identities = run("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
    ]).stdout
    childEnvironment = resolveMacSigningEnvironment(
      childEnvironment,
      identities
    )
  } else if (platform === "win") {
    if (!hasWindowsSigningCredentials(childEnvironment)) {
      throw new Error(
        "Official Windows builds require WIN_CSC_LINK (or CSC_LINK) signing credentials"
      )
    }
  }

  const architecture = process.arch
  const output = prepareReleaseOutput(platform, architecture)
  let stagingDirectory = output.stagingDirectory
  try {
    if (platform === "mac") {
      const [npm, args] = npmInvocation(["run", "icon:build"])
      runVisible(npm, args, { label: "Icon Composer build" })
    }
    {
      const [npm, args] = npmInvocation(["run", "build"])
      runVisible(npm, args, { label: "application build" })
    }
    if (platform === "mac") childEnvironment.PMD_ICON_COMPOSER_BUILD = "1"
    {
      const [builder, args] = builderInvocation(
        electronBuilderArguments(platform, stagingDirectory)
      )
      runVisible(builder, args, {
        env: childEnvironment,
        label: "electron-builder",
      })
    }

    const artifacts =
      platform === "mac"
        ? verifyMacRelease(
            stagingDirectory,
            architecture,
            notarization,
            childEnvironment
          )
        : platform === "win"
          ? verifyWindowsRelease(
              stagingDirectory,
              architecture,
              childEnvironment
            )
          : verifyLinuxRelease(stagingDirectory, architecture, childEnvironment)
    removeUnusedUpdateMetadata(stagingDirectory)
    pruneReleaseStaging(stagingDirectory, artifacts, platform)
    writeChecksums(stagingDirectory, platform, architecture, artifacts)
    promoteReleaseStaging(stagingDirectory, output.finalDirectory)
    stagingDirectory = null
    console.log(
      `Official ${platform} release build completed with publication disabled: ${output.finalDirectory}`
    )
  } finally {
    if (stagingDirectory) removeReleaseStaging(stagingDirectory)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`Release build failed: ${error.message}`)
    process.exitCode = 1
  })
}

export { officialBundleIdentifier }
