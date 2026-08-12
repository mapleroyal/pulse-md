import { describe, expect, it } from "vitest"

import {
  decodeUtf8Bytes,
  encodeUtf8Bytes,
  hashDocumentBytes,
} from "./document-codec"

describe("document byte codec", () => {
  it("preserves the dominant line ending while normalizing editor content", () => {
    expect(decodeUtf8Bytes(Buffer.from("a\r\nb\r\nc\n"))).toEqual({
      content: "a\nb\nc\n",
      hasUtf8Bom: false,
      lineEnding: "\r\n",
    })
    expect(decodeUtf8Bytes(Buffer.from("a\r\nb\nc\n"))).toEqual({
      content: "a\nb\nc\n",
      hasUtf8Bom: false,
      lineEnding: "\n",
    })
  })

  it("round trips UTF-8 BOM and requested CRLF output", () => {
    const encoded = encodeUtf8Bytes("one\ntwo\n", {
      hasUtf8Bom: true,
      lineEnding: "\r\n",
    })
    expect([...encoded.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(decodeUtf8Bytes(encoded)).toEqual({
      content: "one\ntwo\n",
      hasUtf8Bom: true,
      lineEnding: "\r\n",
    })
  })

  it("rejects invalid UTF-8 and hashes exact encoded bytes", () => {
    expect(() => decodeUtf8Bytes(Buffer.from([0xc3, 0x28]))).toThrow()
    expect(hashDocumentBytes(Buffer.from("same"))).toBe(
      hashDocumentBytes(Buffer.from("same"))
    )
    expect(hashDocumentBytes(Buffer.from("same"))).not.toBe(
      hashDocumentBytes(Buffer.from("different"))
    )
  })
})
