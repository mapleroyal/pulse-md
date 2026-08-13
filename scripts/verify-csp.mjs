import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

import domino from "@mixmark-io/domino"

const CSP_META_SELECTOR = 'meta[http-equiv="Content-Security-Policy" i]'
const HASH_SOURCE_PATTERN = /^sha(256|384|512)-(.+)$/

export function inlineScriptHashes(html) {
  const document = domino.createWindow(html).document
  return Array.from(document.querySelectorAll("script:not([src])"), (script) =>
    createHash("sha256").update(script.textContent).digest("base64")
  )
}

export function cspScriptHashes(html) {
  const document = domino.createWindow(html).document
  const policy = document
    .querySelector(CSP_META_SELECTOR)
    ?.getAttribute("content")
  if (!policy) throw new Error("Content-Security-Policy meta tag is missing")

  const scriptDirective = policy
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => /^script-src(?:\s|$)/i.test(directive))
  if (!scriptDirective) {
    throw new Error("Content-Security-Policy has no script-src directive")
  }

  return scriptDirective
    .split(/\s+/)
    .slice(1)
    .map((source) => source.replace(/^'|'$/g, ""))
    .filter((source) => HASH_SOURCE_PATTERN.test(source))
}

export function verifyInlineScriptCsp(html, label = "HTML") {
  const inlineHashes = inlineScriptHashes(html).map((hash) => `sha256-${hash}`)
  const cspHashes = cspScriptHashes(html)
  const missingHashes = inlineHashes.filter((hash) => !cspHashes.includes(hash))
  const staleHashes = cspHashes.filter((hash) => !inlineHashes.includes(hash))

  if (missingHashes.length > 0 || staleHashes.length > 0) {
    const details = [
      ...missingHashes.map((hash) => `inline script is missing ${hash}`),
      ...staleHashes.map((hash) => `script-src contains unused ${hash}`),
    ]
    throw new Error(
      `${label} has invalid inline-script CSP hashes:\n- ${details.join("\n- ")}`
    )
  }

  return inlineHashes
}

async function verifyFile(filePath) {
  const html = await readFile(filePath, "utf8")
  const hashes = verifyInlineScriptCsp(html, filePath)
  console.log(
    `${path.relative(process.cwd(), filePath) || path.basename(filePath)}: ${hashes.length} inline script hash${hashes.length === 1 ? "" : "es"} verified`
  )
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const filePaths = process.argv
    .slice(2)
    .map((filePath) => path.resolve(filePath))
  if (filePaths.length === 0) {
    throw new TypeError(
      "Usage: node scripts/verify-csp.mjs <html-file> [...html-files]"
    )
  }
  for (const filePath of filePaths) await verifyFile(filePath)
}
