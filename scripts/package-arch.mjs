import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

const require = createRequire(import.meta.url)
const { extractFile } = require("@electron/asar")

const projectRoot = path.resolve(import.meta.dirname, "..")
const archPackagingDirectory = path.join(projectRoot, "packaging", "arch")
const pkgbuildTemplatePath = path.join(archPackagingDirectory, "PKGBUILD.in")
const desktopSourcePath = path.join(
  archPackagingDirectory,
  "io.github.mapleroyal.pulse-md.desktop"
)
const mimeSourcePath = path.join(
  archPackagingDirectory,
  "io.github.mapleroyal.pulse-md.xml"
)
const licenseSourcePath = path.join(projectRoot, "LICENSE")
const iconSourceDirectory = path.join(projectRoot, "build", "icons", "linux")
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
)

export const archIconSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512]
export const archRuntimeDependencies = [
  "alsa-lib",
  "at-spi2-core",
  "cairo",
  "dbus",
  "expat",
  "glib2",
  "glibc",
  "gtk3",
  "hicolor-icon-theme",
  "libgcc",
  "libcups",
  "libx11",
  "libxcb",
  "libxcomposite",
  "libxdamage",
  "libxext",
  "libxfixes",
  "libxkbcommon",
  "libxrandr",
  "mesa",
  "nspr",
  "nss",
  "pango",
  "systemd-libs",
  "xdg-utils",
]

function commandFailure(label, result) {
  const detail = result.error?.message || result.stderr || result.stdout
  const suffix = detail ? `\n${String(detail).trim()}` : ""
  return new Error(
    `${label} failed${
      result.status === null ? "" : ` (exit ${result.status})`
    }${suffix}`
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
    cwd: options.cwd || projectRoot,
    env: options.env,
    stdio: "inherit",
  })
  if (result.error || result.status !== 0) {
    throw commandFailure(options.label || command, result)
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

function requireExecutableFile(target, description) {
  requireRegularFile(target, description)
  if ((lstatSync(target).mode & 0o111) === 0) {
    throw new Error(`${description} is not executable: ${target}`)
  }
}

function requireSafeRuntimeTree(current) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (/\p{Cc}/u.test(entry.name)) {
      throw new Error(
        `Prepared Linux runtime has an unsafe name: ${entry.name}`
      )
    }
    const target = path.join(current, entry.name)
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) {
      throw new Error(`Prepared Linux runtime contains a symlink: ${target}`)
    }
    if (stat.isDirectory()) {
      requireSafeRuntimeTree(target)
    } else if (!stat.isFile()) {
      throw new Error(
        `Prepared Linux runtime contains a special file: ${target}`
      )
    }
  }
}

function sha256(target) {
  requireRegularFile(target, "SHA-256 input")
  const digest = createHash("sha256")
  const descriptor = openSync(target, "r")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null))) {
      digest.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(descriptor)
  }
  return digest.digest("hex")
}

export const archPackageLayout = Object.freeze({
  cli: "/usr/bin/pmd",
  desktop: "/usr/share/applications/io.github.mapleroyal.pulse-md.desktop",
  executable: "/opt/pulse-md/pulse-md",
  guiCommand: "/usr/bin/pulse-md",
  helper: "/opt/pulse-md/resources/bin/pmd",
  license: "/usr/share/licenses/pulse-md/LICENSE",
  mime: "/usr/share/mime/packages/io.github.mapleroyal.pulse-md.xml",
  runtimeRoot: "/opt/pulse-md",
})

export function archPackageIconPath(size) {
  if (!archIconSizes.includes(size)) {
    throw new Error(`Unsupported Arch application icon size: ${size}`)
  }
  return `/usr/share/icons/hicolor/${size}x${size}/apps/pulse-md.png`
}

export function archPackageVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Arch package version must be a non-empty string")
  }
  const normalized = version.replaceAll("-", "_")
  if (!/^[A-Za-z0-9][A-Za-z0-9._+]*$/.test(normalized)) {
    throw new Error(`Unsupported Arch package version: ${version}`)
  }
  return normalized
}

export function archArchitectureFromElfHeader(header) {
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46
  ) {
    throw new Error("Prepared Pulse MD executable is not an ELF binary")
  }
  if (header[4] !== 2 || header[5] !== 1) {
    throw new Error(
      "Prepared Pulse MD executable is not 64-bit little-endian ELF"
    )
  }
  const machine = header.readUInt16LE(18)
  if (machine === 62) return "x86_64"
  if (machine === 183) return "aarch64"
  throw new Error(`Unsupported Arch ELF machine: ${machine}`)
}

function archArchitecture(executable) {
  const descriptor = openSync(executable, "r")
  try {
    const header = Buffer.alloc(20)
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(
        `Prepared Pulse MD executable is truncated: ${executable}`
      )
    }
    return archArchitectureFromElfHeader(header)
  } finally {
    closeSync(descriptor)
  }
}

export function archArtifactName(version, architecture) {
  const normalizedVersion = archPackageVersion(version)
  if (!new Set(["aarch64", "x86_64"]).has(architecture)) {
    throw new Error(`Unsupported Arch package architecture: ${architecture}`)
  }
  return `pulse-md-${normalizedVersion}-1-${architecture}.pkg.tar.zst`
}

export function renderArchPkgbuild({
  architecture,
  packagingSha256,
  runtimeSha256,
  template = readFileSync(pkgbuildTemplatePath, "utf8"),
  version,
}) {
  if (!new Set(["aarch64", "x86_64"]).has(architecture)) {
    throw new Error(`Unsupported Arch package architecture: ${architecture}`)
  }
  for (const [label, value] of [
    ["packaging", packagingSha256],
    ["runtime", runtimeSha256],
  ]) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Invalid ${label} archive SHA-256: ${value}`)
    }
  }
  const values = {
    "@ARCH@": architecture,
    "@PACKAGING_SHA256@": packagingSha256,
    "@PKGVER@": archPackageVersion(version),
    "@RUNTIME_SHA256@": runtimeSha256,
  }
  for (const [token, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9._+]+$/.test(value)) {
      throw new Error(`Invalid PKGBUILD value for ${token}: ${value}`)
    }
    template = template.replaceAll(token, value)
  }
  const unresolved = template.match(/@[A-Z0-9_]+@/g)
  if (unresolved) {
    throw new Error(`Unresolved PKGBUILD tokens: ${unresolved.join(", ")}`)
  }
  return template
}

function validatePreparedRuntime(runtimeRoot) {
  requireRegularDirectory(runtimeRoot, "prepared Linux runtime")
  requireSafeRuntimeTree(runtimeRoot)
  const executable = path.join(runtimeRoot, "pulse-md")
  const resources = path.join(runtimeRoot, "resources")
  const asar = path.join(resources, "app.asar")
  const helper = path.join(resources, "bin", "pmd")
  requireExecutableFile(executable, "prepared Pulse MD executable")
  requireRegularDirectory(resources, "prepared Pulse MD resources")
  requireRegularFile(asar, "prepared Pulse MD app.asar")
  requireExecutableFile(helper, "prepared Pulse MD CLI helper")

  let metadata
  try {
    metadata = JSON.parse(extractFile(asar, "package.json").toString("utf8"))
  } catch (error) {
    throw new Error(`Prepared Pulse MD metadata is invalid: ${error.message}`, {
      cause: error,
    })
  }
  const expected = {
    name: "pulse-md",
    pmdDistributionChannel: "canonical",
    productName: "Pulse MD",
    version: packageMetadata.version,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(
        `Prepared Pulse MD metadata ${key} is ${JSON.stringify(metadata[key])}; expected ${JSON.stringify(value)}`
      )
    }
  }

  return {
    architecture: archArchitecture(executable),
    asar,
    executable,
    helper,
  }
}

function archiveDirectory(source, destination, rootName) {
  requireRegularDirectory(source, `archive source ${rootName}`)
  run(
    "tar",
    [
      "--create",
      "--zstd",
      "--file",
      destination,
      "--transform",
      `s,^\\.,${rootName},`,
      "--directory",
      source,
      ".",
    ],
    { label: `archiving ${rootName}` }
  )
  requireRegularFile(destination, `${rootName} archive`)
}

function stagePackagingSources(target) {
  mkdirSync(path.join(target, "icons"), { recursive: true })
  copyFileSync(
    desktopSourcePath,
    path.join(target, path.basename(desktopSourcePath))
  )
  copyFileSync(mimeSourcePath, path.join(target, path.basename(mimeSourcePath)))
  copyFileSync(licenseSourcePath, path.join(target, "LICENSE"))
  for (const size of archIconSizes) {
    const name = `${size}x${size}.png`
    const source = path.join(iconSourceDirectory, name)
    requireRegularFile(source, `${size}px Linux application icon`)
    copyFileSync(source, path.join(target, "icons", name))
  }
}

export function safeArchPackageEntries(artifact) {
  const entries = run("bsdtar", ["-tf", artifact], {
    label: "listing Arch package",
  })
    .stdout.split(/\r?\n/)
    .filter(Boolean)
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "")
    const components = normalized.split("/")
    if (
      path.posix.isAbsolute(entry) ||
      /\p{Cc}/u.test(normalized) ||
      components.some(
        (component) =>
          component.length === 0 || component === "." || component === ".."
      )
    ) {
      throw new Error(`Arch package contains an unsafe path: ${entry}`)
    }
  }
  return entries.map((entry) => entry.replace(/\/$/, ""))
}

export function archPackageEntryAllowed(entry) {
  if (entry === "opt" || entry === "opt/pulse-md") return true
  if (entry.startsWith("opt/pulse-md/")) return true

  const exact = new Set([
    ".BUILDINFO",
    ".MTREE",
    ".PKGINFO",
    "usr",
    "usr/bin",
    archPackageLayout.cli.slice(1),
    archPackageLayout.guiCommand.slice(1),
    "usr/share",
    "usr/share/applications",
    archPackageLayout.desktop.slice(1),
    "usr/share/icons",
    "usr/share/icons/hicolor",
    "usr/share/licenses",
    "usr/share/licenses/pulse-md",
    archPackageLayout.license.slice(1),
    "usr/share/mime",
    "usr/share/mime/packages",
    archPackageLayout.mime.slice(1),
  ])
  for (const size of archIconSizes) {
    const root = `usr/share/icons/hicolor/${size}x${size}`
    exact.add(root)
    exact.add(`${root}/apps`)
    exact.add(archPackageIconPath(size).slice(1))
  }
  return exact.has(entry)
}

function assertMatchingFile(first, second, description) {
  requireRegularFile(first, `${description} source`)
  requireRegularFile(second, `${description} package copy`)
  if (sha256(first) !== sha256(second)) {
    throw new Error(`${description} changed while creating the Arch package`)
  }
}

function verifyPackagedSymlink(target, expected) {
  const stat = pathStat(target)
  if (!stat?.isSymbolicLink() || readlinkSync(target) !== expected) {
    throw new Error(`Unexpected packaged symlink: ${target}`)
  }
}

function pkgInfoValue(packageInfo, name) {
  return packageInfo
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name} = `))
    ?.slice(name.length + 3)
}

function verifyArchMtree(artifact) {
  const compressed = run("bsdtar", ["-xOf", artifact, ".MTREE"], {
    encoding: null,
    label: "reading Arch .MTREE",
  }).stdout
  let mtree
  try {
    mtree = gunzipSync(compressed).toString("utf8")
  } catch (error) {
    throw new Error(`Arch package .MTREE is invalid: ${error.message}`, {
      cause: error,
    })
  }
  if (!mtree.startsWith("#mtree\n/set type=file uid=0 gid=0 ")) {
    throw new Error("Arch package payload is not owned by root")
  }
  const links = mtree
    .split(/\r?\n/)
    .filter((line) => line.includes(" type=link "))
  const expected = [
    `./${archPackageLayout.cli.slice(1)} time=`,
    `./${archPackageLayout.guiCommand.slice(1)} time=`,
  ]
  if (
    links.length !== 2 ||
    !links.some(
      (line) =>
        line.startsWith(expected[0]) &&
        line.endsWith(` link=${archPackageLayout.helper}`)
    ) ||
    !links.some(
      (line) =>
        line.startsWith(expected[1]) &&
        line.endsWith(` link=${archPackageLayout.executable}`)
    )
  ) {
    throw new Error(
      `Arch package contains unexpected symlinks:\n${links.join("\n")}`
    )
  }
}

export function verifyArchPackageArtifact(
  artifact,
  { architecture, version = packageMetadata.version } = {}
) {
  requireRegularFile(artifact, "Arch package artifact")
  const packageInfo = run("bsdtar", ["-xOf", artifact, ".PKGINFO"], {
    label: "reading Arch .PKGINFO",
  }).stdout
  const packagedArchitecture = pkgInfoValue(packageInfo, "arch")
  if (!new Set(["aarch64", "x86_64"]).has(packagedArchitecture)) {
    throw new Error(
      `Arch package has unsupported architecture: ${packagedArchitecture || "missing"}`
    )
  }
  if (architecture && architecture !== packagedArchitecture) {
    throw new Error(
      `Arch package architecture is ${packagedArchitecture}; expected ${architecture}`
    )
  }
  if (
    path.basename(artifact) !== archArtifactName(version, packagedArchitecture)
  ) {
    throw new Error(`Unexpected Arch package name: ${artifact}`)
  }

  run("pacman", ["-Qip", artifact], { label: "reading Arch package metadata" })
  run("pacman", ["-Qlp", artifact], { label: "reading Arch package files" })
  verifyArchMtree(artifact)
  const manifest = safeArchPackageEntries(artifact)
  const entries = new Set(manifest)
  if (entries.size !== manifest.length) {
    throw new Error("Arch package contains duplicate manifest paths")
  }
  for (const entry of entries) {
    if (!archPackageEntryAllowed(entry)) {
      throw new Error(`Arch package contains an unexpected path: ${entry}`)
    }
  }
  const required = [
    ".BUILDINFO",
    ".MTREE",
    ".PKGINFO",
    archPackageLayout.executable.slice(1),
    "opt/pulse-md/resources/app.asar",
    archPackageLayout.helper.slice(1),
    archPackageLayout.cli.slice(1),
    archPackageLayout.guiCommand.slice(1),
    archPackageLayout.desktop.slice(1),
    archPackageLayout.license.slice(1),
    archPackageLayout.mime.slice(1),
    ...archIconSizes.map((size) => archPackageIconPath(size).slice(1)),
  ]
  for (const entry of required) {
    if (!entries.has(entry)) {
      throw new Error(`Arch package is missing ${entry}`)
    }
  }
  if (
    [...entries].some(
      (entry) =>
        entry.startsWith("usr/share/icons/hicolor/") &&
        entry.includes("/mimetypes/")
    )
  ) {
    throw new Error(
      "Arch package must leave Markdown document icons theme-owned"
    )
  }

  for (const field of [
    "pkgname = pulse-md",
    `pkgver = ${archPackageVersion(version)}-1`,
    `arch = ${packagedArchitecture}`,
    "pkgdesc = A fast, local-first Markdown reader and editor for the desktop",
    "license = LicenseRef-PolyForm-Noncommercial-1.0.0",
  ]) {
    if (!packageInfo.split(/\r?\n/).includes(field)) {
      throw new Error(`Arch package metadata is missing: ${field}`)
    }
  }
  const dependencies = packageInfo
    .split(/\r?\n/)
    .filter((line) => line.startsWith("depend = "))
    .map((line) => line.slice("depend = ".length))
  if (
    dependencies.length !== archRuntimeDependencies.length ||
    dependencies.some(
      (dependency, index) => dependency !== archRuntimeDependencies[index]
    )
  ) {
    throw new Error(
      `Arch package dependencies are unexpected: ${dependencies.join(", ")}`
    )
  }

  return {
    architecture: packagedArchitecture,
    entries,
    packageInfo,
  }
}

function verifyArchPackage(
  artifact,
  runtimeRoot,
  verificationRoot,
  version,
  architecture
) {
  verifyArchPackageArtifact(artifact, { architecture, version })

  mkdirSync(verificationRoot, { recursive: true })
  run("bsdtar", ["-xf", artifact, "-C", verificationRoot], {
    label: "extracting Arch package for verification",
  })
  const packagedRuntime = path.join(verificationRoot, "opt", "pulse-md")
  assertMatchingFile(
    path.join(runtimeRoot, "pulse-md"),
    path.join(packagedRuntime, "pulse-md"),
    "Pulse MD executable"
  )
  assertMatchingFile(
    path.join(runtimeRoot, "resources", "app.asar"),
    path.join(packagedRuntime, "resources", "app.asar"),
    "Pulse MD app.asar"
  )
  assertMatchingFile(
    path.join(runtimeRoot, "resources", "bin", "pmd"),
    path.join(packagedRuntime, "resources", "bin", "pmd"),
    "Pulse MD CLI helper"
  )
  verifyPackagedSymlink(
    path.join(verificationRoot, "usr", "bin", "pulse-md"),
    "/opt/pulse-md/pulse-md"
  )
  verifyPackagedSymlink(
    path.join(verificationRoot, "usr", "bin", "pmd"),
    "/opt/pulse-md/resources/bin/pmd"
  )

  for (const [source, relative] of [
    [desktopSourcePath, archPackageLayout.desktop.slice(1)],
    [licenseSourcePath, archPackageLayout.license.slice(1)],
    [mimeSourcePath, archPackageLayout.mime.slice(1)],
  ]) {
    assertMatchingFile(
      source,
      path.join(verificationRoot, relative),
      path.basename(source)
    )
  }
  for (const size of archIconSizes) {
    assertMatchingFile(
      path.join(iconSourceDirectory, `${size}x${size}.png`),
      path.join(
        verificationRoot,
        "usr",
        "share",
        "icons",
        "hicolor",
        `${size}x${size}`,
        "apps",
        "pulse-md.png"
      ),
      `${size}px Pulse MD icon`
    )
  }

  const packagedMime = readFileSync(
    path.join(
      verificationRoot,
      "usr",
      "share",
      "mime",
      "packages",
      "io.github.mapleroyal.pulse-md.xml"
    ),
    "utf8"
  )
  if (/<icon(?:\s|>)/.test(packagedMime)) {
    throw new Error("Arch MIME registration must not override document icons")
  }
}

function promoteArtifact(source, outputDirectory) {
  requireRegularDirectory(outputDirectory, "Arch package output directory")
  const target = path.join(outputDirectory, path.basename(source))
  const existing = pathStat(target)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Refusing unexpected Arch package target: ${target}`)
  }
  const incoming = path.join(
    outputDirectory,
    `.${path.basename(source)}.${process.pid}-${randomUUID()}.incoming`
  )
  try {
    copyFileSync(source, incoming, constants.COPYFILE_EXCL)
    renameSync(incoming, target)
  } finally {
    if (pathStat(incoming)) unlinkSync(incoming)
  }
  return target
}

function removeTemporaryDirectory(target) {
  const resolved = path.resolve(target)
  const temporaryRoot = path.resolve(os.tmpdir())
  if (
    path.dirname(resolved) !== temporaryRoot ||
    !path.basename(resolved).startsWith("pulse-md-arch-package-")
  ) {
    throw new Error(`Refusing unexpected Arch package cleanup: ${target}`)
  }
  if (pathStat(resolved)) rmSync(resolved, { recursive: true })
}

export function packageArchRuntime(runtimeArgument, outputArgument) {
  if (process.platform !== "linux") {
    throw new Error("Arch packages must be built on Linux")
  }
  const runtimeRoot = path.resolve(runtimeArgument)
  const outputDirectory = path.resolve(
    outputArgument || path.join(projectRoot, "release")
  )
  const runtime = validatePreparedRuntime(runtimeRoot)
  const hostArchitecture = { arm64: "aarch64", x64: "x86_64" }[process.arch]
  if (runtime.architecture !== hostArchitecture) {
    throw new Error(
      `Prepared runtime architecture ${runtime.architecture} does not match this ${hostArchitecture || process.arch} host`
    )
  }
  mkdirSync(outputDirectory, { recursive: true })
  requireRegularDirectory(outputDirectory, "Arch package output directory")

  run("desktop-file-validate", [desktopSourcePath], {
    label: "validating the Arch desktop entry",
  })
  run("xmllint", ["--noout", mimeSourcePath], {
    label: "validating the Arch MIME package",
  })
  if (/<icon(?:\s|>)/.test(readFileSync(mimeSourcePath, "utf8"))) {
    throw new Error(
      "Arch MIME registration must leave document icons theme-owned"
    )
  }

  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "pulse-md-arch-package-")
  )
  try {
    const runtimeArchive = path.join(
      temporaryDirectory,
      "pulse-md-runtime.tar.zst"
    )
    const packagingArchive = path.join(
      temporaryDirectory,
      "pulse-md-packaging.tar.zst"
    )
    const packagingRoot = path.join(
      temporaryDirectory,
      "pulse-md-packaging-source"
    )
    mkdirSync(packagingRoot)
    stagePackagingSources(packagingRoot)
    archiveDirectory(runtimeRoot, runtimeArchive, "pulse-md-runtime")
    archiveDirectory(packagingRoot, packagingArchive, "pulse-md-packaging")

    writeFileSync(
      path.join(temporaryDirectory, "PKGBUILD"),
      renderArchPkgbuild({
        architecture: runtime.architecture,
        packagingSha256: sha256(packagingArchive),
        runtimeSha256: sha256(runtimeArchive),
        version: packageMetadata.version,
      }),
      { mode: 0o644 }
    )

    const packageOutput = path.join(temporaryDirectory, "artifacts")
    const buildDirectory = path.join(temporaryDirectory, "build")
    mkdirSync(packageOutput)
    mkdirSync(buildDirectory)
    runVisible(
      "makepkg",
      ["--cleanbuild", "--force", "--noconfirm", "--nosign"],
      {
        cwd: temporaryDirectory,
        env: {
          ...process.env,
          BUILDDIR: buildDirectory,
          PKGDEST: packageOutput,
          PKGEXT: ".pkg.tar.zst",
          SRCDEST: temporaryDirectory,
        },
        label: "building the Arch package",
      }
    )

    const expectedName = archArtifactName(
      packageMetadata.version,
      runtime.architecture
    )
    const artifacts = readdirSync(packageOutput).filter((name) =>
      name.endsWith(".pkg.tar.zst")
    )
    if (artifacts.length !== 1 || artifacts[0] !== expectedName) {
      throw new Error(
        `Expected one Arch package named ${expectedName}, found ${artifacts.join(", ") || "none"}`
      )
    }
    const artifact = path.join(packageOutput, expectedName)
    verifyArchPackage(
      artifact,
      runtimeRoot,
      path.join(temporaryDirectory, "verification"),
      packageMetadata.version,
      runtime.architecture
    )
    return promoteArtifact(artifact, outputDirectory)
  } finally {
    removeTemporaryDirectory(temporaryDirectory)
  }
}

const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  if (process.argv.length < 3 || process.argv.length > 4) {
    console.error(
      "Usage: node scripts/package-arch.mjs <linux-unpacked-directory> [output-directory]"
    )
    process.exitCode = 1
  } else {
    try {
      const artifact = packageArchRuntime(process.argv[2], process.argv[3])
      console.log(`Created and verified ${artifact}`)
    } catch (error) {
      console.error(`Arch packaging failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
