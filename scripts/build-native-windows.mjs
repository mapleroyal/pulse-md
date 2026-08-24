import { mkdir, rename, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import nodeApiHeaders from "node-api-headers"

import {
  assertWindowsX64NodeArchitecture,
  windowsMsvcArchitecture,
  windowsMsvcComponent,
} from "./windows-msvc.mjs"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const outputDirectory = path.join(projectRoot, "dist-native", "win32")
const outputPath = path.join(outputDirectory, "windows-window-blur.node")

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

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
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
  if (!programFiles) return { command: configuredCompiler, env: process.env }
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
      windowsMsvcComponent(process.arch),
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
  const architecture = windowsMsvcArchitecture(process.arch)
  const environmentOutput = await capture(
    "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      `chcp 65001 >nul && call "${vcvars}" ${architecture} >nul && set`,
    ],
    { windowsVerbatimArguments: true }
  )
  const env = { ...process.env }
  for (const line of environmentOutput.split(/\r?\n/)) {
    const separator = line.indexOf("=")
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return { command: configuredCompiler, env }
}

if (process.platform !== "win32") process.exit(0)

assertWindowsX64NodeArchitecture(process.arch)
await mkdir(outputDirectory, { recursive: true })
const temporaryPath = `${outputPath}.${process.pid}.tmp.node`
const temporaryObjectPath = `${outputPath}.${process.pid}.tmp.obj`
const temporaryDelayLoadObjectPath = `${outputPath}.${process.pid}.delay.obj`
const temporaryNodeLibraryPath = `${outputPath}.${process.pid}.node.lib`

try {
  const compiler = await windowsCompiler()
  await run(
    "lib.exe",
    [
      "/nologo",
      `/def:${nodeApiHeaders.def_paths.node_api_def}`,
      `/out:${temporaryNodeLibraryPath}`,
      "/machine:x64",
    ],
    { env: compiler.env }
  )
  await run(
    compiler.command,
    [
      "/nologo",
      "/c",
      "/TP",
      "/std:c++20",
      "/O2",
      "/MT",
      "/EHsc",
      "/GS",
      "/guard:cf",
      "/permissive-",
      "/W4",
      "/WX",
      "/utf-8",
      "/DNAPI_VERSION=8",
      `/I${nodeApiHeaders.include_dir}`,
      path.join(projectRoot, "native", "windows-window-blur.cpp"),
      `/Fo${temporaryObjectPath}`,
    ],
    { env: compiler.env }
  )
  await run(
    compiler.command,
    [
      "/nologo",
      "/c",
      "/TP",
      "/O2",
      "/MT",
      "/EHsc",
      "/GS",
      "/guard:cf",
      "/W4",
      "/WX",
      "/utf-8",
      '/DHOST_BINARY="node.exe"',
      path.join(
        projectRoot,
        "node_modules",
        "node-gyp",
        "src",
        "win_delay_load_hook.cc"
      ),
      `/Fo${temporaryDelayLoadObjectPath}`,
    ],
    { env: compiler.env }
  )
  await run(
    "link.exe",
    [
      "/NOLOGO",
      temporaryObjectPath,
      temporaryDelayLoadObjectPath,
      `/OUT:${temporaryPath}`,
      "/DLL",
      "/DYNAMICBASE",
      "/NXCOMPAT",
      "/GUARD:CF",
      "/DELAYLOAD:node.exe",
      temporaryNodeLibraryPath,
      "delayimp.lib",
      "d2d1.lib",
      "dwmapi.lib",
      "dxguid.lib",
      "user32.lib",
      "windowsapp.lib",
      "CoreMessaging.lib",
    ],
    { env: compiler.env }
  )
  await rm(outputPath, { force: true })
  await rename(temporaryPath, outputPath)
} finally {
  await rm(temporaryPath, { force: true })
  await rm(temporaryObjectPath, { force: true })
  await rm(temporaryDelayLoadObjectPath, { force: true })
  await rm(temporaryNodeLibraryPath, { force: true })
}
