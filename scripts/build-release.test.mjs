import assert from "node:assert/strict"
import {
  existsSync,
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
  notarizationAuthorization,
  parseDeveloperIdIdentities,
  pruneReleaseStaging,
  releaseOutputNames,
  resolveMacSigningEnvironment,
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
