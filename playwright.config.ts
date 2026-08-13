import { defineConfig } from "@playwright/test"

const PARALLEL_E2E_TESTS = [
  "**/extensions.spec.ts",
  "**/math.spec.ts",
  "**/media.spec.ts",
  "**/mermaid.spec.ts",
  "**/no-wrap.spec.ts",
  "**/path-completion.spec.ts",
  "**/reported-selection-regressions.spec.ts",
  "**/table-geometry.spec.ts",
  "**/table-responsive.spec.ts",
  "**/theme-picker.spec.ts",
]
const RENDERER_ISOLATED_TAG = /@renderer-isolated/

const phase = process.env.PMD_E2E_PHASE
if (phase !== undefined && phase !== "parallel" && phase !== "serial") {
  throw new Error(`Unknown PMD_E2E_PHASE: ${phase}`)
}

export default defineConfig({
  projects:
    phase === "parallel"
      ? [
          {
            fullyParallel: true,
            name: "isolated-files",
            testMatch: PARALLEL_E2E_TESTS,
          },
          {
            fullyParallel: true,
            grep: RENDERER_ISOLATED_TAG,
            name: "isolated-tests",
            testIgnore: PARALLEL_E2E_TESTS,
          },
        ]
      : phase === "serial"
        ? [
            {
              grepInvert: RENDERER_ISOLATED_TAG,
              name: "native-serial",
              testIgnore: PARALLEL_E2E_TESTS,
            },
          ]
        : undefined,
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
  // Electron windows compete for macOS activation, application-menu state,
  // the native clipboard, and compositor geometry. The optimized npm runner
  // parallelizes only tests audited not to depend on those global resources,
  // then runs the remainder alone. Keep direct Playwright invocations serial
  // so focused debugging retains the same isolation as before.
  workers: phase === "parallel" ? 4 : 1,
})
