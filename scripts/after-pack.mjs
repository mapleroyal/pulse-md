import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { assertAdaptiveMacIconAssetInfo } from "./macos-icon-assets.mjs"

const execFileAsync = promisify(execFile)

async function requireRegularFile(filePath, description) {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} is not a regular file: ${filePath}`)
  }
}

async function plistValue(infoPlist, key) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ])
  return stdout.trim()
}

async function removePlistValue(infoPlist, key) {
  try {
    await execFileAsync("/usr/bin/plutil", ["-remove", key, infoPlist])
  } catch (error) {
    const stderr = String(error?.stderr ?? "")
    if (!stderr.includes("No value at that key path")) throw error
  }
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex")
}

async function verifyAdaptiveIconAssetCatalog(assetCatalog) {
  const { stdout } = await execFileAsync(
    "/usr/bin/assetutil",
    ["--info", assetCatalog],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  let assetInfo
  try {
    assetInfo = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Icon Composer asset metadata is not valid JSON`, {
      cause: error,
    })
  }
  assertAdaptiveMacIconAssetInfo(assetInfo, assetCatalog)
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return

  const projectDirectory = context.packager.projectDir
  const appName = context.packager.appInfo.productFilename
  const appBundle = path.join(context.appOutDir, `${appName}.app`)
  const contents = path.join(appBundle, "Contents")
  const resources = path.join(contents, "Resources")
  const infoPlist = path.join(contents, "Info.plist")
  const sourceIcon = path.join(projectDirectory, "build", "pulse-md.icns")
  const assetCatalog = path.join(resources, "Assets.car")

  for (const key of [
    "NSAppTransportSecurity",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    await removePlistValue(infoPlist, key)
  }

  if (process.env.PMD_ICON_COMPOSER_BUILD !== "1") return

  await requireRegularFile(sourceIcon, "Legacy icon fallback")
  await requireRegularFile(assetCatalog, "Icon Composer asset catalog")
  await verifyAdaptiveIconAssetCatalog(assetCatalog)
  if ((await plistValue(infoPlist, "CFBundleIconName")) !== "Icon") {
    throw new Error(
      `Packaged app does not declare CFBundleIconName=Icon: ${infoPlist}`
    )
  }

  const configuredIconFile = await plistValue(infoPlist, "CFBundleIconFile")
  if (!configuredIconFile) {
    throw new Error(
      `Packaged app does not declare CFBundleIconFile: ${infoPlist}`
    )
  }
  const legacyIconName = configuredIconFile.endsWith(".icns")
    ? configuredIconFile
    : `${configuredIconFile}.icns`
  const packagedIcon = path.join(resources, legacyIconName)
  await requireRegularFile(packagedIcon, "electron-builder icon fallback")

  await copyFile(sourceIcon, packagedIcon)
  if ((await sha256(sourceIcon)) !== (await sha256(packagedIcon))) {
    throw new Error(`Packaged legacy icon did not match ${sourceIcon}`)
  }
}
