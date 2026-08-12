import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const { createElectronFrameworkSupport } = require(
  "app-builder-lib/out/electron/ElectronFramework"
)
const { Platform } = require("app-builder-lib")
const builderRequire = createRequire(
  require.resolve("app-builder-lib/out/util/electronGet")
)
const electronGet = builderRequire("@electron/get")
const electronMetadata = require("electron/package.json")
const electronChecksums = require("electron/checksums.json")

async function captureEffectiveDownload(configuration, platformName, arch) {
  const originalDownload = electronGet.downloadArtifact
  const stopAfterCapture = new Error("stop after capturing download options")
  let captured

  try {
    electronGet.downloadArtifact = async (options) => {
      captured = options
      throw stopAfterCapture
    }

    const packager = {
      appInfo: { type: "commonjs" },
      config: {
        ...configuration,
        electronVersion: electronMetadata.version,
      },
      info: { getWorkspaceRoot: async () => process.cwd() },
      platform: Platform.MAC,
      projectDir: process.cwd(),
    }
    const framework = await createElectronFrameworkSupport(
      packager.config,
      packager
    )

    await assert.rejects(
      framework.prepareApplicationStageDirectory({
        appOutDir: path.join(os.tmpdir(), "pulse-md-download-options-test"),
        arch,
        packager,
        platformName,
      }),
      (error) => error === stopAfterCapture
    )
  } finally {
    electronGet.downloadArtifact = originalDownload
  }

  assert.ok(captured, "electron-builder did not reach @electron/get")
  return captured
}

test("official and Local builds pass pinned checksums to @electron/get", async () => {
  for (const configPath of [
    "../electron-builder.config.cjs",
    "../electron-builder.local.cjs",
  ]) {
    for (const [platformName, arch] of [
      ["darwin", "arm64"],
      ["win32", "x64"],
      ["linux", "x64"],
    ]) {
      const effective = await captureEffectiveDownload(
        require(configPath),
        platformName,
        arch
      )
      const filename = `electron-v${electronMetadata.version}-${platformName}-${arch}.zip`

      assert.equal(effective.platform, platformName)
      assert.equal(effective.arch, arch)
      assert.equal(effective.version, electronMetadata.version)
      assert.equal(effective.unsafelyDisableChecksums, false)
      assert.deepEqual(effective.checksums, electronChecksums)
      assert.equal(effective.checksums[filename], electronChecksums[filename])
      assert.match(effective.checksums[filename], /^[a-f0-9]{64}$/)
    }
  }
})
