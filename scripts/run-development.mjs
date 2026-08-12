import { spawn } from "node:child_process"
import net from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

import electronExecutable from "electron"

import {
  developmentCliEnvironment,
  developmentEndpoint,
} from "./cli-development-support.mjs"
import {
  developmentCheckoutIdentity,
  developmentServerPort,
} from "./development-checkout-identity.mjs"

const projectRoot = path.resolve(import.meta.dirname, "..")
const checkoutIdentity = developmentCheckoutIdentity(projectRoot)
const endpoint = developmentEndpoint({
  cliIdentity: checkoutIdentity.cliIdentity,
  environment: process.env,
})
const developmentEnvironment = developmentCliEnvironment(process.env, endpoint)
const host = "127.0.0.1"
const port = developmentServerPort(checkoutIdentity.checkoutHash)
const serverUrl = `http://${host}:${port}`
const viteExecutable = path.join(
  projectRoot,
  "node_modules",
  "vite",
  "bin",
  "vite.js"
)

export function developmentViteArguments({ executable, host, port }) {
  return [
    executable,
    "--host",
    host,
    "--port",
    String(port),
    "--strictPort",
    "--clearScreen",
    "false",
  ]
}

export function developmentElectronEnvironment(environment, url) {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("The development renderer URL must be provided")
  }
  return { ...environment, VITE_DEV_SERVER_URL: url }
}

function childExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      label,
      signal: child.signalCode,
    })
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, label, signal }))
  })
}

function run(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    cwd: projectRoot,
    env: developmentEnvironment,
    stdio: "inherit",
    ...options,
  })
  return childExit(child, command).then(({ code, signal }) => {
    if (code === 0) return
    throw new Error(
      `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`
    )
  })
}

function portIsInUse() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const finish = (inUse) => {
      socket.destroy()
      resolve(inUse)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function waitForVite(vite) {
  const expectedUrl = `${serverUrl}/`
  return new Promise((resolve, reject) => {
    let output = ""
    let ready = false
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for Vite at ${expectedUrl}`))
    }, 15_000)
    const cleanup = () => {
      clearTimeout(timeout)
      vite.off("error", failed)
      vite.off("exit", exited)
    }
    const receivedStdout = (chunk) => {
      process.stdout.write(chunk)
      if (ready) return
      output = `${output}${chunk.toString("utf8")}`.slice(-4_096)
      if (output.includes(expectedUrl)) {
        ready = true
        cleanup()
        resolve()
      }
    }
    const failed = (error) => {
      cleanup()
      reject(error)
    }
    const exited = (code, signal) => {
      cleanup()
      reject(
        new Error(
          `Vite exited before serving this checkout${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`
        )
      )
    }
    vite.stdout?.on("data", receivedStdout)
    vite.once("error", failed)
    vite.once("exit", exited)
  })
}

function terminate(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
  }
}

async function main() {
  if (await portIsInUse()) {
    throw new Error(
      `Checkout ${checkoutIdentity.checkoutHash} cannot start because its development port ${port} is already in use.`
    )
  }

  const npmCli = developmentEnvironment.npm_execpath
  if (!npmCli) throw new Error("Run development through npm run dev")
  await run(process.execPath, [npmCli, "run", "build:electron"])

  const vite = spawn(
    process.execPath,
    developmentViteArguments({ executable: viteExecutable, host, port }),
    {
      cwd: projectRoot,
      env: developmentEnvironment,
      stdio: ["inherit", "pipe", "inherit"],
    }
  )

  let electron
  try {
    await waitForVite(vite)
    electron = spawn(electronExecutable, [projectRoot], {
      cwd: projectRoot,
      env: developmentElectronEnvironment(developmentEnvironment, serverUrl),
      stdio: "inherit",
    })

    const stopped = await Promise.race([
      childExit(vite, "Vite"),
      childExit(electron, "Electron"),
    ])
    terminate(stopped.label === "Vite" ? electron : vite)
    if (stopped.signal) process.kill(process.pid, stopped.signal)
    process.exitCode = stopped.code ?? 1
  } finally {
    terminate(electron)
    terminate(vite)
  }
}

const launchedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (launchedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(
      `Pulse MD development: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
