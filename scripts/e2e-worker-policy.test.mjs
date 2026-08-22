import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_PARALLEL_E2E_WORKERS,
  isWindowsX64OnArm64,
  parallelE2eWorkers,
  WINDOWS_X64_ON_ARM64_E2E_WORKERS,
} from "./e2e-worker-policy.mjs"

test("E2E workers fall back only for x64 Node on Windows-on-Arm", () => {
  const emulatedProcessor = "ARMv8 (64-bit) Family 8 Model 0 Revision 0, Apple"

  assert.equal(isWindowsX64OnArm64("win32", "x64", emulatedProcessor), true)
  assert.equal(
    parallelE2eWorkers("win32", "x64", emulatedProcessor),
    WINDOWS_X64_ON_ARM64_E2E_WORKERS
  )
  assert.equal(
    parallelE2eWorkers(
      "win32",
      "x64",
      "Intel64 Family 6 Model 191 Stepping 2, GenuineIntel"
    ),
    DEFAULT_PARALLEL_E2E_WORKERS
  )
  assert.equal(
    parallelE2eWorkers("win32", "arm64", emulatedProcessor),
    DEFAULT_PARALLEL_E2E_WORKERS
  )
  assert.equal(
    parallelE2eWorkers("darwin", "x64", emulatedProcessor),
    DEFAULT_PARALLEL_E2E_WORKERS
  )
})
