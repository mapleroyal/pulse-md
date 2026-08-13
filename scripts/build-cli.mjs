import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { developmentCheckoutIdentity } from "./development-checkout-identity.mjs"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const developmentIdentity = developmentCheckoutIdentity(projectRoot)
const outputDirectory = path.join(
  projectRoot,
  "dist-native",
  process.platform,
  "bin"
)
const variants = [
  {
    appExecutableName:
      process.platform === "win32"
        ? "Pulse MD.exe"
        : process.platform === "darwin"
          ? "Pulse MD"
          : "pulse-md",
    cliIdentity: "pulse-md",
    commandName: "pmd",
    outputName: process.platform === "win32" ? "pmd.exe" : "pmd",
  },
  {
    appExecutableName:
      process.platform === "win32"
        ? "electron.exe"
        : process.platform === "darwin"
          ? "Electron"
          : "electron",
    cliIdentity: developmentIdentity.cliIdentity,
    commandName: "pmd-dev",
    outputName: process.platform === "win32" ? "pmd-dev.exe" : "pmd-dev",
  },
]
const sourcePath = path.join(
  projectRoot,
  process.platform === "win32" ? "native/pmd-cli-win.c" : "native/pmd-cli.c"
)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      ...options,
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

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"))
        return
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim()
      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`
        )
      )
    })
  })
}

async function windowsCompiler() {
  const configuredCompiler = process.env.PMD_MSVC_CL || "cl.exe"
  if (process.env.PMD_MSVC_CL) {
    return { command: configuredCompiler, env: process.env }
  }

  try {
    await capture("where.exe", [configuredCompiler])
    return { command: configuredCompiler, env: process.env }
  } catch {
    // A regular Windows terminal does not inherit Visual Studio's build env.
  }

  const programFiles = process.env["ProgramFiles(x86)"]
  if (!programFiles) {
    return { command: configuredCompiler, env: process.env }
  }
  const vswhere = path.join(
    programFiles,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  )
  const installationPath = (
    await capture(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
      "-utf8",
    ])
  ).trim()
  if (!installationPath) {
    throw new Error("MSVC Build Tools with the C/C++ workload are required")
  }

  const vcvars = path.join(
    installationPath,
    "VC",
    "Auxiliary",
    "Build",
    "vcvarsall.bat"
  )
  const architecture =
    { arm64: "arm64", ia32: "x86", x64: "x64" }[process.arch] || "x64"
  const environmentOutput = await capture("cmd.exe", [
    "/d",
    "/s",
    "/c",
    `chcp 65001 >nul && call "${vcvars}" ${architecture} >nul && set`,
  ])
  const env = { ...process.env }
  for (const line of environmentOutput.split(/\r?\n/)) {
    const separator = line.indexOf("=")
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return { command: configuredCompiler, env }
}

if (
  process.platform !== "darwin" &&
  process.platform !== "linux" &&
  process.platform !== "win32"
) {
  process.stdout.write(
    `The native pmd CLI helper is not built on ${process.platform}.\n`
  )
  process.exit(0)
}

await mkdir(outputDirectory, { recursive: true })
await rm(
  path.join(
    outputDirectory,
    process.platform === "win32" ? "pmd-local.exe" : "pmd-local"
  ),
  { force: true }
)

for (const variant of variants) {
  const outputPath = path.join(outputDirectory, variant.outputName)
  const temporaryPath =
    process.platform === "win32"
      ? `${outputPath}.${process.pid}.tmp.exe`
      : `${outputPath}.${process.pid}.tmp`
  const temporaryObjectPath = path.join(
    outputDirectory,
    `${variant.outputName}.${process.pid}.tmp.obj`
  )
  try {
    if (process.platform === "win32") {
      const compiler = await windowsCompiler()
      await run(
        compiler.command,
        [
          "/nologo",
          "/TC",
          "/std:c11",
          "/O2",
          "/MT",
          "/GS",
          "/guard:cf",
          "/W4",
          "/WX",
          "/utf-8",
          "/DUNICODE",
          "/D_UNICODE",
          `/DPMD_CLI_IDENTITY_W=L\\"${variant.cliIdentity}\\"`,
          `/DPMD_COMMAND_NAME=\\"${variant.commandName}\\"`,
          `/DPMD_APP_EXECUTABLE_NAME_W=L\\"${variant.appExecutableName}\\"`,
          sourcePath,
          `/Fo${temporaryObjectPath}`,
          `/Fe${temporaryPath}`,
          "/link",
          "/SUBSYSTEM:CONSOLE",
          "/DYNAMICBASE",
          "/NXCOMPAT",
          "/GUARD:CF",
        ],
        { env: compiler.env }
      )
    } else if (process.platform === "darwin") {
      await run("xcrun", [
        "clang",
        "-x",
        "objective-c",
        sourcePath,
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-DPMD_CLI_IDENTITY="${variant.cliIdentity}"`,
        `-DPMD_COMMAND_NAME="${variant.commandName}"`,
        `-DPMD_APP_EXECUTABLE_NAME="${variant.appExecutableName}"`,
        "-mmacosx-version-min=12.0",
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
        "-framework",
        "CoreGraphics",
        "-framework",
        "CoreFoundation",
        "-framework",
        "ApplicationServices",
        "-framework",
        "AppKit",
        "-o",
        temporaryPath,
      ])
      await run("xcrun", [
        "lipo",
        temporaryPath,
        "-verify_arch",
        "arm64",
        "x86_64",
      ])
    } else {
      await run(process.env.CC || "cc", [
        sourcePath,
        "-std=c11",
        "-O2",
        "-D_FORTIFY_SOURCE=2",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-DPMD_CLI_IDENTITY="${variant.cliIdentity}"`,
        `-DPMD_COMMAND_NAME="${variant.commandName}"`,
        `-DPMD_APP_EXECUTABLE_NAME="${variant.appExecutableName}"`,
        "-fPIE",
        "-pie",
        "-Wl,-z,relro,-z,now",
        "-o",
        temporaryPath,
      ])
    }
    if (process.platform !== "win32") {
      await chmod(temporaryPath, 0o755)
    } else {
      await rm(outputPath, { force: true })
    }
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
    await rm(temporaryObjectPath, { force: true })
  }
}
