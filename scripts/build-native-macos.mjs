import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import nodeApiHeaders from "node-api-headers"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const outputDirectory = path.join(projectRoot, "dist-native")
const outputPath = path.join(outputDirectory, "macos-window-blur.node")

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
        )
      )
    })
  })
}

if (process.platform !== "darwin") {
  process.exit(0)
}

await mkdir(outputDirectory, { recursive: true })
const temporaryPath = `${outputPath}.${process.pid}.tmp`

try {
  await run("xcrun", [
    "clang++",
    path.join(projectRoot, "native/macos-window-blur.mm"),
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-fobjc-arc",
    "-std=c++20",
    "-O2",
    "-mmacosx-version-min=12.0",
    "-DNAPI_VERSION=8",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-I",
    nodeApiHeaders.include_dir,
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
    "-framework",
    "QuartzCore",
    "-o",
    temporaryPath,
  ])
  await run("xcrun", ["lipo", temporaryPath, "-verify_arch", "arm64", "x86_64"])
  await rename(temporaryPath, outputPath)
} finally {
  await rm(temporaryPath, { force: true })
}
