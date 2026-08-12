import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  copiedHeadingLinkHtml,
  externalHeadingLinkAddress,
  headingLinkForPaste,
  normalizeCopiedHeadingLinkMetadata,
} from "./heading-link-clipboard"

const sourcePath = path.resolve("/tmp/Pulse Notes/Heading Notes.md")
const targetPath = path.resolve("/tmp/Pulse Notes/Other.md")
const scratchId = "11111111-1111-4111-8111-111111111111"
const metadata = {
  fragment: "café-heading",
  sourcePath,
  sourceScratch: null,
  sourceTabId: "source-tab",
  version: 3 as const,
}

const scratchMetadata = {
  ...metadata,
  sourcePath: null,
  sourceScratch: { scratchId },
}

describe("copied heading links", () => {
  test("use a portable file URL as the external clipboard fallback", () => {
    expect(
      externalHeadingLinkAddress(sourcePath, null, metadata.fragment)
    ).toMatch(/^file:\/\/\/.*Heading%20Notes\.md#caf%C3%A9-heading$/)
    const html = copiedHeadingLinkHtml(
      metadata,
      externalHeadingLinkAddress(sourcePath, null, metadata.fragment)
    )
    expect(html).toContain('data-pulse-md-heading-link="3"')
    expect(html).toContain('data-pulse-md-heading-source-tab="source-tab"')
    expect(html).toContain("Heading%20Notes.md#caf%C3%A9-heading")
  })

  test("normalizes app-owned metadata before resolving a paste", () => {
    expect(normalizeCopiedHeadingLinkMetadata(metadata)).toEqual(metadata)
    expect(() =>
      normalizeCopiedHeadingLinkMetadata({
        ...metadata,
        sourcePath: "relative",
      })
    ).toThrow(/metadata is invalid/)
    expect(() =>
      normalizeCopiedHeadingLinkMetadata({
        ...scratchMetadata,
        sourceScratch: { scratchId: "Bad_ID" },
      })
    ).toThrow(/metadata is invalid/)
  })

  test("collapses same-document pastes and relativizes other documents", () => {
    expect(headingLinkForPaste(sourcePath, null, "target-tab", metadata)).toBe(
      "#caf%C3%A9-heading"
    )
    expect(headingLinkForPaste(null, null, "source-tab", metadata)).toBe(
      "#caf%C3%A9-heading"
    )
    expect(headingLinkForPaste(targetPath, null, "target-tab", metadata)).toBe(
      "Heading%20Notes.md#caf%C3%A9-heading"
    )
    expect(headingLinkForPaste(null, null, "target-tab", metadata)).toBe(
      externalHeadingLinkAddress(sourcePath, null, metadata.fragment)
    )
  })

  test("uses durable identities for links between scratches", () => {
    expect(
      externalHeadingLinkAddress(
        null,
        scratchMetadata.sourceScratch,
        scratchMetadata.fragment
      )
    ).toBe(`pulse-md://scratch/${scratchId}#caf%C3%A9-heading`)
    expect(headingLinkForPaste(null, null, "other-tab", scratchMetadata)).toBe(
      `pulse-md://scratch/${scratchId}#caf%C3%A9-heading`
    )
    expect(
      headingLinkForPaste(
        null,
        null,
        "other-tab",
        scratchMetadata,
        "pulse-md-local"
      )
    ).toBe(`pulse-md-local://scratch/${scratchId}#caf%C3%A9-heading`)
    expect(
      headingLinkForPaste(
        null,
        scratchMetadata.sourceScratch,
        "reopened-tab",
        scratchMetadata
      )
    ).toBe("#caf%C3%A9-heading")
  })
})
