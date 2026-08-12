import { createHash } from "node:crypto"

export interface DocumentEncoding {
  readonly hasUtf8Bom: boolean
  readonly lineEnding: "\n" | "\r\n"
}

export interface DecodedDocumentBytes extends DocumentEncoding {
  readonly content: string
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export function decodeUtf8Bytes(buffer: Buffer): DecodedDocumentBytes {
  const hasUtf8Bom = buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  const source = UTF8_DECODER.decode(
    buffer.subarray(hasUtf8Bom ? UTF8_BOM.length : 0)
  )
  if (!source.includes("\r")) {
    return { content: source, hasUtf8Bom, lineEnding: "\n" }
  }

  let crlfCount = 0
  let loneLfCount = 0
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 13 && source.charCodeAt(index + 1) === 10) {
      crlfCount += 1
      index += 1
    } else if (code === 10) {
      loneLfCount += 1
    }
  }

  return {
    content: source.replace(/\r\n?/g, "\n"),
    hasUtf8Bom,
    lineEnding: crlfCount > loneLfCount ? "\r\n" : "\n",
  }
}

export function encodeUtf8Bytes(
  content: string,
  format: DocumentEncoding
): Buffer {
  const normalized = content.includes("\r")
    ? content.replace(/\r\n?/g, "\n")
    : content
  const withRequestedLineEndings =
    format.lineEnding === "\r\n"
      ? normalized.replace(/\n/g, "\r\n")
      : normalized
  const body = Buffer.from(withRequestedLineEndings, "utf8")
  return format.hasUtf8Bom ? Buffer.concat([UTF8_BOM, body]) : body
}

export function hashDocumentBytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("base64url")
}
