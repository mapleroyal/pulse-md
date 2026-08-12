import { EventEmitter } from "node:events"

import type { UtilityProcess } from "electron"
import { describe, expect, it } from "vitest"

import {
  DOCUMENT_UTILITY_BYTE_THRESHOLD,
  DocumentUtilityClient,
} from "./document-utility-client"
import { hashDocumentBytes } from "./document-codec"

interface PostedRequest {
  data?: ArrayBuffer
  filePath?: string
  id: number
  kind: "decode" | "decode-file" | "encode" | "hash"
}

class FakeUtilityProcess extends EventEmitter {
  readonly requests: PostedRequest[] = []

  postMessage(request: PostedRequest) {
    this.requests.push(request)
  }
}

async function waitForPostedRequest(
  utility: FakeUtilityProcess,
  count: number
) {
  await expect
    .poll(() => utility.requests.length, { timeout: 1_000 })
    .toBe(count)
}

describe("document utility client", () => {
  it("decodes a private spool by path without posting its byte contents", async () => {
    const utility = new FakeUtilityProcess()
    const client = new DocumentUtilityClient(
      () => utility as unknown as UtilityProcess
    )

    const decoded = client.decodeFile("/tmp/private-stdin-spool")
    await waitForPostedRequest(utility, 1)
    expect(utility.requests[0]).toMatchObject({
      filePath: "/tmp/private-stdin-spool",
      kind: "decode-file",
    })
    expect(utility.requests[0]?.data).toBeUndefined()

    utility.emit("message", {
      content: "streamed\ninput",
      contentHash: "stdin-hash",
      hasUtf8Bom: false,
      id: utility.requests[0]!.id,
      kind: "decode-file",
      lineEnding: "\n",
    })
    await expect(decoded).resolves.toEqual({
      content: "streamed\ninput",
      contentHash: "stdin-hash",
      hasUtf8Bom: false,
      lineEnding: "\n",
    })
  })

  it("posts only one heavyweight request until the utility completes it", async () => {
    const utility = new FakeUtilityProcess()
    const client = new DocumentUtilityClient(
      () => utility as unknown as UtilityProcess
    )
    const firstBuffer = Buffer.alloc(DOCUMENT_UTILITY_BYTE_THRESHOLD, 1)
    const secondBuffer = Buffer.alloc(DOCUMENT_UTILITY_BYTE_THRESHOLD, 2)

    const firstHash = client.hash(firstBuffer)
    const secondHash = client.hash(secondBuffer)

    await waitForPostedRequest(utility, 1)
    expect(utility.requests[0]?.data?.byteLength).toBe(firstBuffer.byteLength)

    utility.emit("message", {
      contentHash: "first-hash",
      id: utility.requests[0]!.id,
      kind: "hash",
    })
    await expect(firstHash).resolves.toBe("first-hash")

    await waitForPostedRequest(utility, 2)
    expect(utility.requests[1]?.data?.byteLength).toBe(secondBuffer.byteLength)
    utility.emit("message", {
      contentHash: "second-hash",
      id: utility.requests[1]!.id,
      kind: "hash",
    })
    await expect(secondHash).resolves.toBe("second-hash")
  })

  it("falls back for failed work and resumes queued work on a replacement utility", async () => {
    const utilities: FakeUtilityProcess[] = []
    const client = new DocumentUtilityClient(() => {
      const utility = new FakeUtilityProcess()
      utilities.push(utility)
      return utility as unknown as UtilityProcess
    })
    const firstBuffer = Buffer.alloc(DOCUMENT_UTILITY_BYTE_THRESHOLD, 1)
    const secondBuffer = Buffer.alloc(DOCUMENT_UTILITY_BYTE_THRESHOLD, 2)

    const firstHash = client.hash(firstBuffer)
    const secondHash = client.hash(secondBuffer)

    await expect.poll(() => utilities.length).toBe(1)
    const failedUtility = utilities[0]!
    await waitForPostedRequest(failedUtility, 1)
    failedUtility.emit("exit", 9)

    await expect(firstHash).resolves.toBe(hashDocumentBytes(firstBuffer))
    await expect.poll(() => utilities.length).toBe(2)
    expect(failedUtility.requests).toHaveLength(1)

    const replacementUtility = utilities[1]!
    await waitForPostedRequest(replacementUtility, 1)
    replacementUtility.emit("message", {
      contentHash: "replacement-hash",
      id: replacementUtility.requests[0]!.id,
      kind: "hash",
    })
    await expect(secondHash).resolves.toBe("replacement-hash")
  })
})
