import assert from "node:assert/strict"
import { test } from "node:test"

import {
  cspScriptHashes,
  inlineScriptHashes,
  verifyInlineScriptCsp,
} from "./verify-csp.mjs"

const inlineSource = '\n      performance.mark("launch")\n    '
const inlineHash = "sha256-j5CbDj7GKMydmX+9ygab7Ms/8FRrfBAJtEOPjRke644="

function htmlWithPolicy(policy) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${inlineSource}</script><script type="module" src="./main.js"></script></head></html>`
}

test("verifies the exact browser-visible bytes of each inline script", () => {
  const html = htmlWithPolicy(
    `default-src 'self'; script-src 'self' '${inlineHash}'`
  )

  assert.deepEqual(inlineScriptHashes(html), [
    inlineHash.slice("sha256-".length),
  ])
  assert.deepEqual(cspScriptHashes(html), [inlineHash])
  assert.deepEqual(verifyInlineScriptCsp(html, "fixture"), [inlineHash])
})

test("rejects a changed inline script when its CSP hash is stale", () => {
  const html = htmlWithPolicy(`script-src 'self' '${inlineHash}'`).replace(
    'performance.mark("launch")',
    'performance.mark("changed")'
  )

  assert.throws(
    () => verifyInlineScriptCsp(html, "fixture"),
    /fixture has invalid inline-script CSP hashes:[\s\S]*inline script is missing sha256-[\w+/]+=*[\s\S]*script-src contains unused sha256-j5CbDj7GKMydmX\+9ygab7Ms\/8FRrfBAJtEOPjRke644=/
  )
})

test("rejects an unused CSP hash without any inline script", () => {
  const html = htmlWithPolicy(`script-src 'self' '${inlineHash}'`).replace(
    `<script>${inlineSource}</script>`,
    ""
  )

  assert.throws(
    () => verifyInlineScriptCsp(html, "fixture"),
    /script-src contains unused sha256-j5CbDj7GKMydmX\+9ygab7Ms\/8FRrfBAJtEOPjRke644=/
  )
})
