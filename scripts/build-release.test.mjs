import assert from "node:assert/strict"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  authenticodeArguments,
  electronBuilderArguments,
  hasWindowsSigningCredentials,
  isUnusedUpdateMetadata,
  linuxArtifactExtractionPlan,
  linuxArtifactRuntimeRootCandidates,
  linuxReleaseArtifactNames,
  notarizationAuthorization,
  parseDeveloperIdIdentities,
  pruneReleaseStaging,
  releaseOutputNames,
  resolveLinuxArtifactRuntimeRoot,
  resolveMacSigningEnvironment,
  validateLinuxAppImageHeader,
  validateLinuxDebianMetadata,
  windowsUnpackedDirectoryName,
} from "./build-release.mjs"

test("all release builders explicitly disable publication", () => {
  for (const platform of ["mac", "win", "linux"]) {
    const args = electronBuilderArguments(platform, "/staging/release")
    const configuration = args.indexOf("--config")
    const publish = args.indexOf("--publish")
    assert.notEqual(configuration, -1)
    assert.equal(args[configuration + 1], "electron-builder.config.cjs")
    assert.notEqual(publish, -1)
    assert.equal(args[publish + 1], "never")
    assert.ok(args.includes("--config.directories.output=/staging/release"))
  }
})

test("official output keeps artifacts but removes runnable unpacked packages", (t) => {
  const staging = mkdtempSync(path.join(os.tmpdir(), "pmd-release-prune-"))
  t.after(() => rmSync(staging, { recursive: true, force: true }))
  const artifact = path.join(staging, "Pulse MD-1.0.0-arm64.dmg")
  const unpackedApp = path.join(staging, "mac-arm64", "Pulse MD.app")
  mkdirSync(unpackedApp, { recursive: true })
  writeFileSync(artifact, "release artifact")
  writeFileSync(path.join(unpackedApp, "marker"), "runnable copy")
  const unregistered = []

  pruneReleaseStaging(staging, [artifact], "mac", (appBundle) => {
    unregistered.push(appBundle)
  })

  assert.deepEqual(unregistered, [unpackedApp])
  assert.equal(readFileSync(artifact, "utf8"), "release artifact")
  assert.equal(existsSync(path.join(staging, "mac-arm64")), false)
})

test("official Apple and Windows builders force signing", () => {
  assert.ok(
    electronBuilderArguments("mac").includes("--config.forceCodeSigning=true")
  )
  assert.ok(
    electronBuilderArguments("mac").includes("--config.mac.notarize=true")
  )
  assert.ok(
    electronBuilderArguments("win").includes("--config.forceCodeSigning=true")
  )
})

test("notarization requires one complete credential method", () => {
  assert.equal(
    notarizationAuthorization({
      APPLE_API_ISSUER: "issuer",
      APPLE_API_KEY: "/secure/AuthKey.p8",
      APPLE_API_KEY_ID: "key-id",
    }).kind,
    "api-key"
  )
  assert.equal(
    notarizationAuthorization({ APPLE_KEYCHAIN_PROFILE: "pulse-md" }).kind,
    "keychain-profile"
  )
  assert.throws(() => notarizationAuthorization({}), /require one complete/)
  assert.throws(
    () => notarizationAuthorization({ APPLE_ID: "owner@example.invalid" }),
    /Incomplete notarization credentials/
  )
})

test("macOS identity selection accepts only Developer ID Application", () => {
  const output = `
  1) AAAAA "Apple Development: Example (TEAM)"
  2) BBBBB "Developer ID Application: Example (TEAM)"
     2 valid identities found
  `
  assert.deepEqual(parseDeveloperIdIdentities(output), [
    "Developer ID Application: Example (TEAM)",
  ])
  assert.equal(
    resolveMacSigningEnvironment({}, output).CSC_NAME,
    "Developer ID Application: Example (TEAM)"
  )
  assert.throws(
    () =>
      resolveMacSigningEnvironment(
        { CSC_NAME: "Apple Development: Example (TEAM)" },
        output
      ),
    /must name a Developer ID Application/
  )
})

test("Windows release credentials are explicit", () => {
  assert.equal(hasWindowsSigningCredentials({}), false)
  assert.equal(
    hasWindowsSigningCredentials({ WIN_CSC_LINK: "C:\\secure\\signing.pfx" }),
    true
  )
})

test("Windows Authenticode verification receives every file path", () => {
  const files = [
    "C:\\stage\\Pulse MD.exe",
    "C:\\stage\\pmd.exe",
    "C:\\stage\\Pulse MD Installer.exe",
  ]
  const args = authenticodeArguments("1.0.0", files)
  assert.equal(args.includes("-Files"), false)
  assert.deepEqual(args.slice(-files.length), files)
})

test("Windows runtime verification targets the exact builder unpacked root", () => {
  assert.equal(windowsUnpackedDirectoryName("x64"), "win-unpacked")
  assert.equal(windowsUnpackedDirectoryName("arm64"), "win-arm64-unpacked")
  assert.equal(windowsUnpackedDirectoryName("ia32"), "win-ia32-unpacked")
  assert.throws(
    () => windowsUnpackedDirectoryName("arm"),
    /Unsupported Windows release architecture/
  )
})

test("unused auto-update metadata is excluded from manual releases", () => {
  for (const filename of [
    "artifact.dmg.blockmap",
    "artifact.zip.blockmap",
    "latest-mac.yml",
    "latest.yml",
    "builder-debug.yml",
    "builder-effective-config.yaml",
  ]) {
    assert.equal(isUnusedUpdateMetadata(filename), true, filename)
  }
  for (const filename of [
    "Pulse MD-1.0.0-arm64.dmg",
    "Pulse MD-1.0.0-x64.exe",
    "README.yml",
  ]) {
    assert.equal(isUnusedUpdateMetadata(filename), false, filename)
  }
})

test("official outputs are unique per platform architecture", () => {
  assert.deepEqual(releaseOutputNames("mac", "arm64", "1.0.0"), {
    checksumName: "SHA256SUMS-macos-arm64",
    directoryName: "official-macos-arm64-1.0.0",
  })
  assert.deepEqual(releaseOutputNames("mac", "x64", "1.0.0"), {
    checksumName: "SHA256SUMS-macos-x64",
    directoryName: "official-macos-x64-1.0.0",
  })
})

test("Linux release artifact names follow each package format's architecture", () => {
  assert.deepEqual(linuxReleaseArtifactNames("x64", "1.0.0"), {
    appImage: "Pulse MD-1.0.0-x86_64.AppImage",
    debian: "Pulse MD-1.0.0-amd64.deb",
  })
  assert.deepEqual(linuxReleaseArtifactNames("arm64", "1.0.0"), {
    appImage: "Pulse MD-1.0.0-arm64.AppImage",
    debian: "Pulse MD-1.0.0-arm64.deb",
  })
})

test("Linux release artifacts extract into their canonical payload layouts", () => {
  const artifactDirectory = path.join(os.tmpdir(), "pmd-release-artifacts")
  const extractionDirectory = path.join(os.tmpdir(), "pmd-release-extraction")
  const appImage = path.join(artifactDirectory, "Pulse MD.AppImage")
  const debian = path.join(artifactDirectory, "Pulse MD.deb")

  assert.deepEqual(linuxArtifactExtractionPlan(appImage, extractionDirectory), {
    args: ["--appimage-extract"],
    command: path.resolve(appImage),
    cwd: path.resolve(extractionDirectory),
    format: "appimage",
  })
  assert.deepEqual(linuxArtifactExtractionPlan(debian, extractionDirectory), {
    args: [
      "--extract",
      path.resolve(debian),
      path.resolve(extractionDirectory),
    ],
    command: "dpkg-deb",
    cwd: path.resolve(extractionDirectory),
    format: "debian",
  })
  assert.deepEqual(
    linuxArtifactRuntimeRootCandidates("appimage", extractionDirectory),
    [
      path.join(extractionDirectory, "squashfs-root"),
      path.join(extractionDirectory, "squashfs-root", "usr", "lib", "pulse-md"),
    ]
  )
  assert.deepEqual(
    linuxArtifactRuntimeRootCandidates("debian", extractionDirectory),
    [
      path.join(extractionDirectory, "opt", "Pulse MD"),
      path.join(extractionDirectory, "usr", "lib", "pulse-md"),
    ]
  )
  assert.throws(
    () =>
      linuxArtifactExtractionPlan(
        path.join(artifactDirectory, "Pulse MD.tar.gz"),
        extractionDirectory
      ),
    /Unsupported Linux release artifact/
  )
})

test("Linux payload resolution requires exactly one canonical runtime root", (t) => {
  const extractionDirectory = mkdtempSync(
    path.join(os.tmpdir(), "pmd-linux-payload-")
  )
  t.after(() => rmSync(extractionDirectory, { recursive: true, force: true }))
  const [appImageRoot, nestedRoot] = linuxArtifactRuntimeRootCandidates(
    "appimage",
    extractionDirectory
  )
  const executableFixtures = new Set()
  const fixturePathStat = (target) => {
    let stat
    try {
      stat = lstatSync(target)
    } catch (error) {
      if (error?.code === "ENOENT") return null
      throw error
    }
    if (executableFixtures.has(path.resolve(target))) stat.mode |= 0o111
    else stat.mode &= ~0o111
    return stat
  }
  const resolveFixture = () =>
    resolveLinuxArtifactRuntimeRoot("appimage", extractionDirectory, {
      pathStat: fixturePathStat,
    })

  assert.throws(resolveFixture, /found 0/)
  mkdirSync(path.join(appImageRoot, "resources"), { recursive: true })
  const appImageExecutable = path.join(appImageRoot, "pulse-md")
  writeFileSync(appImageExecutable, "fixture")
  assert.throws(resolveFixture, /found 0/)
  executableFixtures.add(path.resolve(appImageExecutable))
  assert.equal(resolveFixture(), appImageRoot)

  mkdirSync(path.join(nestedRoot, "resources"), { recursive: true })
  const nestedExecutable = path.join(nestedRoot, "pulse-md")
  writeFileSync(nestedExecutable, "fixture")
  executableFixtures.add(path.resolve(nestedExecutable))
  assert.throws(resolveFixture, /found 2/)
})

test("Linux release validation checks Debian and AppImage architectures", () => {
  validateLinuxDebianMetadata(
    { Architecture: "amd64", Package: "pulse-md", Version: "1.0.0" },
    "x64",
    "fixture.deb"
  )
  assert.throws(
    () =>
      validateLinuxDebianMetadata(
        { Architecture: "arm64", Package: "pulse-md", Version: "1.0.0" },
        "x64",
        "fixture.deb"
      ),
    /Architecture is arm64, expected amd64/
  )

  const x64Header = Buffer.alloc(20)
  x64Header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  x64Header.writeUInt16LE(62, 18)
  validateLinuxAppImageHeader(x64Header, "x64", "fixture.AppImage")

  const arm64Header = Buffer.from(x64Header)
  arm64Header.writeUInt16LE(183, 18)
  assert.throws(
    () => validateLinuxAppImageHeader(arm64Header, "x64", "fixture.AppImage"),
    /machine 183; expected class 2, machine 62/
  )
})
