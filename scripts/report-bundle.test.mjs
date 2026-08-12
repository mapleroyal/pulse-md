import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"

const execFileAsync = promisify(execFile)
const reportScript = path.resolve(import.meta.dirname, "report-bundle.mjs")

async function withBundleFixture(run) {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "pmd-bundle-report-test-")
  )
  await mkdir(path.join(outputRoot, "assets"))
  try {
    await run(outputRoot)
  } finally {
    await rm(outputRoot, { force: true, recursive: true })
  }
}

async function runReport(outputRoot, check = false) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [reportScript, ...(check ? ["--check"] : [])],
    {
      env: {
        ...process.env,
        BUNDLE_REPORT_ROOT: outputRoot,
      },
    }
  )
  return JSON.parse(stdout)
}

test("reports CSS dependencies as part of the initial HTML closure", async () => {
  await withBundleFixture(async (outputRoot) => {
    await Promise.all([
      writeFile(
        path.join(outputRoot, "index.html"),
        [
          '<script type="module" src="./assets/index.js"></script>',
          '<link rel="modulepreload" href="./assets/shared.js">',
          '<link rel="stylesheet" href="./assets/index.css">',
        ].join("\n")
      ),
      writeFile(path.join(outputRoot, "assets/index.js"), "export default 1"),
      writeFile(path.join(outputRoot, "assets/shared.js"), "export default 2"),
      writeFile(path.join(outputRoot, "assets/lazy.js"), "export default 3"),
      writeFile(
        path.join(outputRoot, "assets/index.css"),
        '@import "./nested.css";@font-face{src:url("./regular.woff2")}'
      ),
      writeFile(
        path.join(outputRoot, "assets/nested.css"),
        '.icon{background:url("./icon.svg")}'
      ),
      writeFile(path.join(outputRoot, "assets/regular.woff2"), "font"),
      writeFile(path.join(outputRoot, "assets/icon.svg"), "<svg/>"),
    ])

    const report = await runReport(outputRoot)

    assert.deepEqual(report.initialHtmlClosure.directAssets, [
      "assets/index.css",
      "assets/index.js",
      "assets/shared.js",
    ])
    assert.deepEqual(report.initialHtmlClosure.cssReferencedAssets, [
      "assets/icon.svg",
      "assets/nested.css",
      "assets/regular.woff2",
    ])
    assert.equal(report.initialHtmlClosure.total.files, 6)
    assert.equal(report.initialHtmlClosure.fonts.files, 1)
    assert.equal(report.nonInitialAssets.total.files, 1)
    assert.equal(report.nonInitialAssets.javascript.files, 1)
    assert.equal(report.totalOutput.total.files, 8)
  })
})

test("fails clearly when an initial stylesheet dependency is absent", async () => {
  await withBundleFixture(async (outputRoot) => {
    await Promise.all([
      writeFile(
        path.join(outputRoot, "index.html"),
        '<link rel="stylesheet" href="./assets/index.css">'
      ),
      writeFile(
        path.join(outputRoot, "assets/index.css"),
        '@font-face{src:url("./missing.woff2")}'
      ),
    ])

    await assert.rejects(runReport(outputRoot), (error) =>
      error.stderr.includes(
        "Bundle asset does not exist or cannot be read: assets/missing.woff2 (referenced by assets/index.css)"
      )
    )
  })
})

test("rejects legacy font formats even when bundle sizes remain within budget", async () => {
  await withBundleFixture(async (outputRoot) => {
    await Promise.all([
      writeFile(
        path.join(outputRoot, "index.html"),
        '<link rel="stylesheet" href="./assets/index.css">'
      ),
      writeFile(
        path.join(outputRoot, "assets/index.css"),
        '@font-face{src:url("./legacy.woff")}'
      ),
      writeFile(path.join(outputRoot, "assets/legacy.woff"), "font"),
    ])

    await assert.rejects(runReport(outputRoot, true), (error) =>
      error.stderr.includes(
        "legacy font formats are present (WOFF2-only output required): assets/legacy.woff"
      )
    )
  })
})
