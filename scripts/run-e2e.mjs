import { spawn } from "node:child_process"
import { createRequire } from "node:module"

import { parallelE2eWorkers } from "./e2e-worker-policy.mjs"

const require = createRequire(import.meta.url)
const playwrightCli = require.resolve("@playwright/test/cli")
const forwardedArguments = process.argv.slice(2)
const parallelWorkers = parallelE2eWorkers()

const phases = [
  {
    description: `isolated renderer tests (${parallelWorkers} ${parallelWorkers === 1 ? "worker" : "workers"})`,
    name: "parallel",
    workers: parallelWorkers,
  },
  {
    description: "native OS and shared-resource tests (1 worker)",
    name: "serial",
    workers: 1,
  },
]

let interrupted = false
let runningChild

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true
    runningChild?.kill(signal)
  })
}

function runPhase({ description, name, workers }) {
  console.log(`\nE2E phase: ${description}`)
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        playwrightCli,
        "test",
        ...forwardedArguments,
        "--pass-with-no-tests",
        `--output=test-results/${name}`,
        `--workers=${workers}`,
      ],
      {
        env: { ...process.env, PMD_E2E_PHASE: name },
        stdio: "inherit",
      }
    )
    runningChild = child
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      runningChild = undefined
      resolve({ code: code ?? 1, signal })
    })
  })
}

let failed = false
for (const phase of phases) {
  const result = await runPhase(phase)
  if (result.code !== 0 || result.signal !== null) failed = true
  if (interrupted) break
}

process.exitCode = failed || interrupted ? 1 : 0
