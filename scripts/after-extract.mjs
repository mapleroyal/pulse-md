import { copyFile, lstat, mkdir } from "node:fs/promises"
import path from "node:path"

async function requireRegularFile(filePath, description) {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} is not a regular file: ${filePath}`)
  }
}

export default async function afterExtract(context) {
  const projectDirectory = context.packager.projectDir
  const isMac = ["darwin", "mas"].includes(context.electronPlatformName)
  const resources = isMac
    ? path.join(
        context.appOutDir,
        context.packager.info.framework.distMacOsAppName,
        "Contents",
        "Resources"
      )
    : path.join(context.appOutDir, "resources")
  const destination = path.join(resources, "licenses", "electron")
  const electronLicense = path.join(
    projectDirectory,
    "node_modules",
    "electron",
    "LICENSE"
  )
  const chromiumCredits = path.join(context.appOutDir, "LICENSES.chromium.html")

  await requireRegularFile(electronLicense, "Electron license")
  await requireRegularFile(chromiumCredits, "Chromium credits")
  await mkdir(destination, { recursive: true })
  await copyFile(
    electronLicense,
    path.join(destination, "LICENSE.electron.txt")
  )
  await copyFile(
    chromiumCredits,
    path.join(destination, "LICENSES.chromium.html")
  )
}
