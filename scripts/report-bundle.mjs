import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { gzipSync } from "node:zlib"

const projectRoot = path.resolve(import.meta.dirname, "..")
const outputRoot = path.resolve(
  process.env.BUNDLE_REPORT_ROOT?.trim() || path.join(projectRoot, "dist")
)
const checkRequested = process.argv.slice(2).includes("--check")
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check")

if (unknownArguments.length > 0) {
  throw new TypeError(
    `Unknown bundle-report argument${unknownArguments.length === 1 ? "" : "s"}: ${unknownArguments.join(", ")}`
  )
}

const budgets = {
  // These raw-byte ceilings leave measured headroom for hash/minifier churn
  // while guarding the resources that affect a local packaged launch. WOFF2
  // files are already compressed, so their raw size is the useful font metric.
  // Filesystem completion activates CodeMirror's existing autocomplete UI in
  // the shared editor graph (about 31 kB raw / 11 kB gzip). Its path-specific
  // source remains deferred; this allowance keeps measured headroom without
  // relaxing the stricter aggregate launch-payload ceiling below.
  initialJavaScriptRawBytes: 1_440_000,
  initialCssRawBytes: 147_000,
  initialFontRawBytes: 1_000_000,
  initialClosureRawBytes: 2_550_000,
  totalOutputRawBytes: 10_500_000,
}

const fontExtensions = new Set([
  ".eot",
  ".otf",
  ".ttc",
  ".ttf",
  ".woff",
  ".woff2",
])
const forbiddenLegacyFontExtensions = new Set([
  ".eot",
  ".otf",
  ".ttc",
  ".ttf",
  ".woff",
])

function normalizeWebPath(reference, importer) {
  const withoutWhitespace = reference.trim()
  if (
    withoutWhitespace === "" ||
    withoutWhitespace.startsWith("#") ||
    withoutWhitespace.startsWith("data:") ||
    withoutWhitespace.startsWith("blob:") ||
    withoutWhitespace.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(withoutWhitespace)
  ) {
    return null
  }

  const withoutQueryOrFragment = withoutWhitespace.split(/[?#]/, 1)[0]
  let decoded
  try {
    decoded = decodeURI(withoutQueryOrFragment)
  } catch (cause) {
    throw new Error(
      `Bundle asset reference is not valid URI text: ${reference} (from ${importer})`,
      { cause }
    )
  }

  const importerDirectory = path.posix.dirname(importer)
  const relativePath = path.posix.normalize(
    decoded.startsWith("/")
      ? decoded.slice(1)
      : path.posix.join(importerDirectory, decoded.replaceAll("\\", "/"))
  )
  const absolutePath = path.resolve(outputRoot, ...relativePath.split("/"))
  const relativeToOutput = path.relative(outputRoot, absolutePath)
  if (
    relativeToOutput === "" ||
    relativeToOutput === ".." ||
    relativeToOutput.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToOutput)
  ) {
    throw new Error(
      `Bundle asset reference escapes the output directory: ${reference} (from ${importer})`
    )
  }

  return relativeToOutput.split(path.sep).join("/")
}

function htmlAssetReferences(source) {
  return [...source.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean)
}

function cssAssetReferences(source) {
  const references = [
    ...source.matchAll(
      /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^'")][^)]*?))\s*\)/gi
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3])
  for (const match of source.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    references.push(match[1] ?? match[2])
  }
  return references.filter(Boolean)
}

async function readBundleFile(relativePath, referencedBy) {
  try {
    return await readFile(path.resolve(outputRoot, ...relativePath.split("/")))
  } catch (cause) {
    throw new Error(
      `Bundle asset does not exist or cannot be read: ${relativePath}${referencedBy ? ` (referenced by ${referencedBy})` : ""}`,
      { cause }
    )
  }
}

async function collectOutputFiles(directory = outputRoot) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (cause) {
    throw new Error(
      `Bundle output is unavailable at ${outputRoot}. Run npm run build first.`,
      { cause }
    )
  }

  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectOutputFiles(absolutePath)))
    } else if (entry.isFile()) {
      files.push(
        path.relative(outputRoot, absolutePath).split(path.sep).join("/")
      )
    }
  }
  return files
}

function totals(files) {
  return {
    files: files.length,
    rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
  }
}

function largestFiles(files, limit = 15) {
  return [...files]
    .sort(
      (left, right) =>
        right.rawBytes - left.rawBytes || left.path.localeCompare(right.path)
    )
    .slice(0, limit)
    .map(({ path: relativePath, rawBytes, gzipBytes }) => ({
      path: relativePath,
      rawBytes,
      gzipBytes,
    }))
}

function breakdown(files) {
  const javascript = files.filter((file) => file.extension === ".js")
  const css = files.filter((file) => file.extension === ".css")
  const fonts = files.filter((file) => fontExtensions.has(file.extension))
  const other = files.filter(
    (file) =>
      file.extension !== ".js" &&
      file.extension !== ".css" &&
      !fontExtensions.has(file.extension)
  )
  return {
    total: totals(files),
    javascript: totals(javascript),
    css: totals(css),
    fonts: totals(fonts),
    other: totals(other),
    largestFiles: largestFiles(files),
  }
}

const indexPath = "index.html"
const indexData = await readBundleFile(indexPath)
const indexHtml = indexData.toString("utf8")
const directInitialPaths = new Set()
for (const reference of htmlAssetReferences(indexHtml)) {
  const relativePath = normalizeWebPath(reference, indexPath)
  if (relativePath) directInitialPaths.add(relativePath)
}

const initialClosurePaths = new Set(directInitialPaths)
const pendingStylesheets = [...directInitialPaths].filter(
  (relativePath) => path.posix.extname(relativePath).toLowerCase() === ".css"
)
const parsedStylesheets = new Set()
const cssReferencedPaths = new Set()
while (pendingStylesheets.length > 0) {
  const stylesheetPath = pendingStylesheets.pop()
  if (!stylesheetPath || parsedStylesheets.has(stylesheetPath)) continue
  parsedStylesheets.add(stylesheetPath)
  const stylesheet = (await readBundleFile(stylesheetPath, indexPath)).toString(
    "utf8"
  )
  for (const reference of cssAssetReferences(stylesheet)) {
    const relativePath = normalizeWebPath(reference, stylesheetPath)
    if (!relativePath) continue
    await readBundleFile(relativePath, stylesheetPath)
    cssReferencedPaths.add(relativePath)
    initialClosurePaths.add(relativePath)
    if (path.posix.extname(relativePath).toLowerCase() === ".css") {
      pendingStylesheets.push(relativePath)
    }
  }
}

const outputPaths = (await collectOutputFiles()).sort()
const outputPathSet = new Set(outputPaths)
for (const relativePath of initialClosurePaths) {
  if (!outputPathSet.has(relativePath)) {
    throw new Error(
      `Initial bundle asset is missing from the output: ${relativePath}`
    )
  }
}

const outputFiles = await Promise.all(
  outputPaths.map(async (relativePath) => {
    const data = await readBundleFile(relativePath)
    return {
      path: relativePath,
      extension: path.posix.extname(relativePath).toLowerCase(),
      rawBytes: data.length,
      gzipBytes: gzipSync(data).length,
    }
  })
)
const outputByPath = new Map(outputFiles.map((file) => [file.path, file]))
const initialClosureFiles = [...initialClosurePaths]
  .sort()
  .map((relativePath) => outputByPath.get(relativePath))
  .filter(Boolean)
const nonInitialFiles = outputFiles.filter(
  (file) => file.path !== indexPath && !initialClosurePaths.has(file.path)
)
const indexFile = outputByPath.get(indexPath)
if (!indexFile) {
  throw new Error(`Bundle entry HTML is missing from the output: ${indexPath}`)
}

const initialBreakdown = breakdown(initialClosureFiles)
const nonInitialBreakdown = breakdown(nonInitialFiles)
const totalBreakdown = breakdown(outputFiles)
const budgetMeasurements = {
  initialJavaScriptRawBytes: initialBreakdown.javascript.rawBytes,
  initialCssRawBytes: initialBreakdown.css.rawBytes,
  initialFontRawBytes: initialBreakdown.fonts.rawBytes,
  initialClosureRawBytes: initialBreakdown.total.rawBytes,
  totalOutputRawBytes: totalBreakdown.total.rawBytes,
}
const failures = Object.entries(budgets).flatMap(([name, limit]) => {
  const actual = budgetMeasurements[name]
  return actual > limit ? [`${name}: ${actual} bytes > ${limit} bytes`] : []
})
const forbiddenLegacyFontFiles = outputFiles
  .filter((file) => forbiddenLegacyFontExtensions.has(file.extension))
  .map((file) => file.path)
if (forbiddenLegacyFontFiles.length > 0) {
  failures.push(
    `legacy font formats are present (WOFF2-only output required): ${forbiddenLegacyFontFiles.join(", ")}`
  )
}

const report = {
  outputRoot,
  entryHtml: {
    path: indexPath,
    rawBytes: indexFile.rawBytes,
    gzipBytes: indexFile.gzipBytes,
  },
  initialHtmlClosure: {
    ...initialBreakdown,
    directAssets: [...directInitialPaths].sort(),
    cssReferencedAssets: [...cssReferencedPaths].sort(),
  },
  nonInitialAssets: nonInitialBreakdown,
  totalOutput: totalBreakdown,
  budgets: {
    forbiddenLegacyFontFiles,
    limits: budgets,
    measurements: budgetMeasurements,
    passed: failures.length === 0,
  },
}

console.log(JSON.stringify(report, null, 2))

if (checkRequested && failures.length > 0) {
  throw new Error(`Bundle budget exceeded:\n- ${failures.join("\n- ")}`)
}
