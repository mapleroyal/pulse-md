import type { DocumentKind } from "./contracts"

export const MARKDOWN_DOCUMENT_EXTENSIONS = [
  "md",
  "markdown",
  "mdown",
  "mkd",
] as const

/**
 * High-confidence text and source extensions Pulse advertises to macOS and
 * follows internally from Markdown links. File > Open remains available for
 * every other UTF-8 file through its All Files filter.
 */
export const COMMON_TEXT_DOCUMENT_EXTENSIONS = [
  "txt",
  "text",
  "log",
  "json",
  "jsonc",
  "jsonl",
  "html",
  "htm",
  "css",
  "xml",
  "xsl",
  "xsd",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "csv",
  "tsv",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "pyw",
  "rb",
  "php",
  "java",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hxx",
  "cs",
  "go",
  "rs",
  "swift",
  "kt",
  "kts",
  "scala",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "lua",
  "pl",
  "pm",
  "r",
  "tex",
  "svg",
  "vue",
  "svelte",
] as const

const markdownExtensions = new Set<string>(MARKDOWN_DOCUMENT_EXTENSIONS)
const commonTextExtensions = new Set<string>(COMMON_TEXT_DOCUMENT_EXTENSIONS)

export function documentExtension(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 || dot === name.length - 1
    ? ""
    : name.slice(dot + 1).toLowerCase()
}

export function documentKindForPath(
  filePath: string | null,
  pathlessKind: DocumentKind = "markdown"
): DocumentKind {
  if (!filePath) return pathlessKind
  return markdownExtensions.has(documentExtension(filePath))
    ? "markdown"
    : "plain-text"
}

export function isInternalTextDocumentPath(filePath: string): boolean {
  const extension = documentExtension(filePath)
  return (
    extension.length === 0 ||
    markdownExtensions.has(extension) ||
    commonTextExtensions.has(extension)
  )
}
