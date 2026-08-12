import type { UtilityProcess } from "electron"

import {
  decodeUtf8Bytes,
  encodeUtf8Bytes,
  hashDocumentBytes,
  type DecodedDocumentBytes,
  type DocumentEncoding,
} from "./document-codec"

export const DOCUMENT_UTILITY_BYTE_THRESHOLD = 16 * 1024 * 1024
export const DOCUMENT_UTILITY_TEXT_THRESHOLD = 8 * 1024 * 1024

interface DecodedDocumentResult extends DecodedDocumentBytes {
  readonly contentHash: string
}

interface EncodedDocumentResult {
  readonly buffer: Buffer
  readonly contentHash: string
}

interface UtilityResponse {
  readonly content?: string
  readonly contentHash?: string
  readonly data?: ArrayBuffer
  readonly error?: string
  readonly hasUtf8Bom?: boolean
  readonly id: number
  readonly kind: "decode" | "decode-file" | "encode" | "hash"
  readonly lineEnding?: "\n" | "\r\n"
}

interface UtilityRequest {
  readonly data?: ArrayBuffer
  readonly filePath?: string
  readonly format?: DocumentEncoding
  readonly kind: UtilityResponse["kind"]
  readonly text?: string
}

type PendingUtilityRequest = {
  reject(error: Error): void
  resolve(response: UtilityResponse): void
}

function cloneableArrayBuffer(buffer: Buffer): ArrayBuffer {
  if (
    buffer.byteOffset === 0 &&
    buffer.byteLength === buffer.buffer.byteLength &&
    buffer.buffer instanceof ArrayBuffer
  ) {
    return buffer.buffer
  }
  return Uint8Array.from(buffer).buffer
}

export class DocumentUtilityClient {
  readonly #createUtility: () => UtilityProcess
  #nextRequestId = 1
  #pending = new Map<number, PendingUtilityRequest>()
  #requestQueue: Promise<void> = Promise.resolve()
  #utility: UtilityProcess | null = null

  constructor(createUtility: () => UtilityProcess) {
    this.#createUtility = createUtility
  }

  async decode(buffer: Buffer): Promise<DecodedDocumentResult> {
    if (buffer.byteLength < DOCUMENT_UTILITY_BYTE_THRESHOLD) {
      return {
        ...decodeUtf8Bytes(buffer),
        contentHash: hashDocumentBytes(buffer),
      }
    }
    let response: UtilityResponse
    try {
      response = await this.#request(() => ({
        data: cloneableArrayBuffer(buffer),
        kind: "decode",
      }))
    } catch {
      return {
        ...decodeUtf8Bytes(buffer),
        contentHash: hashDocumentBytes(buffer),
      }
    }
    if (
      typeof response.content !== "string" ||
      typeof response.contentHash !== "string" ||
      typeof response.hasUtf8Bom !== "boolean" ||
      (response.lineEnding !== "\n" && response.lineEnding !== "\r\n")
    ) {
      throw new Error("The document utility returned an invalid decode result")
    }
    return {
      content: response.content,
      contentHash: response.contentHash,
      hasUtf8Bom: response.hasUtf8Bom,
      lineEnding: response.lineEnding,
    }
  }

  async decodeFile(filePath: string): Promise<DecodedDocumentResult> {
    if (!pathIsSafeForUtility(filePath)) {
      throw new TypeError("Document utility file paths must be absolute")
    }
    const response = await this.#request(() => ({
      filePath,
      kind: "decode-file",
    }))
    if (
      typeof response.content !== "string" ||
      typeof response.contentHash !== "string" ||
      typeof response.hasUtf8Bom !== "boolean" ||
      (response.lineEnding !== "\n" && response.lineEnding !== "\r\n")
    ) {
      throw new Error("The document utility returned an invalid decode result")
    }
    return {
      content: response.content,
      contentHash: response.contentHash,
      hasUtf8Bom: response.hasUtf8Bom,
      lineEnding: response.lineEnding,
    }
  }

  async encode(
    content: string,
    format: DocumentEncoding
  ): Promise<EncodedDocumentResult> {
    if (content.length < DOCUMENT_UTILITY_TEXT_THRESHOLD) {
      const buffer = encodeUtf8Bytes(content, format)
      return { buffer, contentHash: hashDocumentBytes(buffer) }
    }
    let response: UtilityResponse
    try {
      response = await this.#request(() => ({
        format,
        kind: "encode",
        text: content,
      }))
    } catch {
      const buffer = encodeUtf8Bytes(content, format)
      return { buffer, contentHash: hashDocumentBytes(buffer) }
    }
    if (
      !(response.data instanceof ArrayBuffer) ||
      typeof response.contentHash !== "string"
    ) {
      throw new Error("The document utility returned an invalid encode result")
    }
    return {
      buffer: Buffer.from(response.data),
      contentHash: response.contentHash,
    }
  }

  async hash(buffer: Buffer): Promise<string> {
    if (buffer.byteLength < DOCUMENT_UTILITY_BYTE_THRESHOLD) {
      return hashDocumentBytes(buffer)
    }
    let response: UtilityResponse
    try {
      response = await this.#request(() => ({
        data: cloneableArrayBuffer(buffer),
        kind: "hash",
      }))
    } catch {
      return hashDocumentBytes(buffer)
    }
    if (typeof response.contentHash !== "string") {
      throw new Error("The document utility returned an invalid hash result")
    }
    return response.contentHash
  }

  #request(createRequest: () => UtilityRequest): Promise<UtilityResponse> {
    const response = this.#requestQueue.then(() =>
      this.#postRequest(createRequest())
    )
    this.#requestQueue = response.then(
      () => undefined,
      () => undefined
    )
    return response
  }

  #postRequest(request: UtilityRequest): Promise<UtilityResponse> {
    const utility = this.#ensureUtility()
    const id = this.#nextRequestId
    this.#nextRequestId += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve })
      try {
        utility.postMessage({ ...request, id })
      } catch (error) {
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  #ensureUtility(): UtilityProcess {
    if (this.#utility) return this.#utility
    const utility = this.#createUtility()
    utility.on("message", (response: UtilityResponse) => {
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)
      if (response.error) {
        pending.reject(new Error(response.error))
      } else {
        pending.resolve(response)
      }
    })
    utility.on("error", (type, location, report) => {
      this.#failUtility(
        utility,
        new Error(
          `The document utility failed (${type} at ${location}): ${report}`
        )
      )
    })
    utility.on("exit", (code) => {
      this.#failUtility(
        utility,
        new Error(`The document utility exited with code ${code}`)
      )
    })
    this.#utility = utility
    return utility
  }

  #failUtility(utility: UtilityProcess, error: Error): void {
    if (this.#utility !== utility) return
    this.#utility = null
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function pathIsSafeForUtility(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    // POSIX roots and Windows drive/UNC roots are both recognized by Node on
    // their native host. The path originates from the private CLI spool.
    (filePath.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(filePath) ||
      filePath.startsWith("\\\\"))
  )
}
