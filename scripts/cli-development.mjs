import { spawn } from "node:child_process"
import path from "node:path"

import electronExecutable from "electron"

import { developmentCheckoutIdentity } from "./development-checkout-identity.mjs"
import {
  developmentCliEnvironment,
  developmentEndpoint,
  ENDPOINT_CONNECT_TIMEOUT_MS,
  endpointIsReady,
} from "./cli-development-support.mjs"

const projectRoot = path.resolve(import.meta.dirname, "..")
const commandArguments = process.argv.slice(2)

const checkoutIdentity = developmentCheckoutIdentity(projectRoot)
const endpoint = developmentEndpoint({
  cliIdentity: checkoutIdentity.cliIdentity,
  environment: process.env,
})
const cliEnvironment = developmentCliEnvironment(process.env, endpoint)

async function waitForEndpoint(endpoint, child) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (
      await endpointIsReady(endpoint, {
        timeoutMs: Math.min(ENDPOINT_CONNECT_TIMEOUT_MS, remainingMs),
      })
    ) {
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        "The Pulse MD development process exited before its CLI was ready"
      )
    }
    const delayMs = Math.min(25, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error("Timed out waiting for the Pulse MD development CLI")
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectRoot,
      env: cliEnvironment,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `Development build failed (${signal ?? `exit ${code ?? "unknown"}`})`
          )
        )
      }
    })
  })
}

if (!(await endpointIsReady(endpoint))) {
  const npmCli = cliEnvironment.npm_execpath
  if (!npmCli) {
    throw new Error("Run the development command through npm run cli:dev")
  }
  await run(process.execPath, [npmCli, "run", "build"])
  const developmentApp = spawn(
    electronExecutable,
    [projectRoot, "--pmd-cli-server"],
    {
      detached: true,
      env: cliEnvironment,
      stdio: "ignore",
    }
  )
  try {
    await waitForEndpoint(endpoint, developmentApp)
  } catch (error) {
    if (
      developmentApp.exitCode === null &&
      developmentApp.signalCode === null
    ) {
      developmentApp.kill("SIGTERM")
    }
    throw error
  } finally {
    developmentApp.unref()
  }
}

const helper = path.join(
  projectRoot,
  "dist-native",
  process.platform,
  "bin",
  process.platform === "win32" ? "pmd-dev.exe" : "pmd-dev"
)
const child = spawn(helper, commandArguments, {
  cwd: process.cwd(),
  env: cliEnvironment,
  stdio: "inherit",
})

child.once("error", (error) => {
  throw error
})
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
