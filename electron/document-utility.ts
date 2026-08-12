import { readFile } from "node:fs/promises"

import {
  decodeUtf8Bytes,
  encodeUtf8Bytes,
  hashDocumentBytes,
  type DocumentEncoding,
} from "./document-codec"

interface DocumentUtilityRequest {
  readonly data?: ArrayBuffer
  readonly filePath?: string
  readonly format?: DocumentEncoding
  readonly id: number
  readonly kind: "decode" | "decode-file" | "encode" | "hash"
  readonly text?: string
}

const port = process.parentPort
if (!port) {
  throw new Error("The document utility requires a utility-process parent")
}

port.on(
  "message",
  async ({ data: request }: { data: DocumentUtilityRequest }) => {
    try {
      if (request.kind === "encode") {
        if (request.text === undefined || !request.format) {
          throw new TypeError("The encode request is incomplete")
        }
        const buffer = encodeUtf8Bytes(request.text, request.format)
        const data = Uint8Array.from(buffer).buffer
        port.postMessage({
          contentHash: hashDocumentBytes(buffer),
          data,
          id: request.id,
          kind: request.kind,
        })
        return
      }

      let buffer: Buffer
      if (request.kind === "decode-file") {
        if (!request.filePath) {
          throw new TypeError("The document utility request has no file path")
        }
        buffer = await readFile(request.filePath)
      } else if (request.data) {
        buffer = Buffer.from(request.data)
      } else {
        throw new TypeError("The document utility request has no byte payload")
      }
      if (request.kind === "hash") {
        port.postMessage({
          contentHash: hashDocumentBytes(buffer),
          id: request.id,
          kind: request.kind,
        })
        return
      }

      const decoded = decodeUtf8Bytes(buffer)
      port.postMessage({
        ...decoded,
        contentHash: hashDocumentBytes(buffer),
        id: request.id,
        kind: request.kind,
      })
    } catch (error) {
      port.postMessage({
        error: error instanceof Error ? error.message : String(error),
        id: request.id,
        kind: request.kind,
      })
    }
  }
)
