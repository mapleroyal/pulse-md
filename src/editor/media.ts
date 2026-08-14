import { Facet } from "@codemirror/state"

const pulseMdImageScheme = "pulse-md-image:"

export const markdownDocumentPath = Facet.define<string | null, string | null>({
  combine: (values) => values.at(-1) ?? null,
})

export const markdownRemoteImagesEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
})

export function markdownImageSourceIsRemote(source: string) {
  try {
    const protocol = new URL(source).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function localImageUrl(filePath: string) {
  return `${pulseMdImageScheme}//local/${encodeURIComponent(filePath)}`
}

function fileUrlForPath(filePath: string, literalPath = false) {
  const normalized = filePath.replace(/\\/g, "/")
  const windowsDrive = /^[A-Za-z]:\//.test(normalized)
  const url = new URL("file:///")
  const pathname = windowsDrive ? `/${normalized}` : normalized
  // A document path comes from the filesystem, where `%20` is a literal name.
  // Markdown destinations still use URL escapes, so encode percents only for
  // the document base rather than for the destination itself.
  url.pathname = literalPath ? pathname.replaceAll("%", "%25") : pathname
  return url
}

function pathFromFileUrl(url: URL) {
  // URL accepts malformed percent escapes such as a literal `%` in a file
  // name. Preserve those bytes while still decoding valid URL escapes.
  let filePath = decodeURIComponent(
    url.pathname.replace(/%(?![\da-f]{2})/gi, "%25")
  )
  if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
    filePath = `//${url.hostname}${filePath}`
  }
  if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
  return filePath
}

export function resolveMarkdownImageSource(
  source: string,
  documentPath: string | null
) {
  const candidate = source.trim()
  if (!candidate) return null

  const absolutePath =
    candidate.startsWith("/") ||
    candidate.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(candidate)

  if (!absolutePath) {
    try {
      const explicit = new URL(candidate)
      if (explicit.protocol === "http:" || explicit.protocol === "https:") {
        return explicit.href
      }
      if (explicit.protocol === "data:" || explicit.protocol === "blob:") {
        return explicit.href
      }
      if (explicit.protocol === "file:") {
        return localImageUrl(pathFromFileUrl(explicit))
      }
      return null
    } catch {
      // A Markdown image destination is commonly a filesystem path rather
      // than a URL. Resolve it against the document, never the packaged app.
    }
  }

  if (!absolutePath && !documentPath) return null

  try {
    const resolved = absolutePath
      ? fileUrlForPath(candidate)
      : new URL(candidate, fileUrlForPath(documentPath!, true))
    return localImageUrl(pathFromFileUrl(resolved))
  } catch {
    return null
  }
}
