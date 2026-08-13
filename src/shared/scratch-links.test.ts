import { describe, expect, test } from "vitest"

import {
  MAX_SCRATCH_LINK_FRAGMENT_LENGTH,
  parseScratchLinkAddress,
  scratchLinkAddress,
} from "./scratch-links"

const scratchId = "11111111-1111-4111-8111-111111111111"

describe("scratch links", () => {
  test("round-trips standalone scratch identities with fragments", () => {
    const scratch = { scratchId }

    expect(scratchLinkAddress(scratch, "Today & Tomorrow")).toBe(
      `pulse-md://scratch/${scratchId}#Today%20%26%20Tomorrow`
    )
    expect(
      parseScratchLinkAddress(scratchLinkAddress(scratch, "Today & Tomorrow"))
    ).toEqual({
      fragment: "Today & Tomorrow",
      href: `pulse-md://scratch/${scratchId}#Today%20%26%20Tomorrow`,
      identity: scratch,
      scheme: "pulse-md",
    })

    expect(scratchLinkAddress(scratch, null, "pulse-md-development")).toBe(
      `pulse-md-development://scratch/${scratchId}`
    )
    expect(
      parseScratchLinkAddress(`pulse-md-development://scratch/${scratchId}`)
        ?.scheme
    ).toBe("pulse-md-development")
  })

  test("rejects other app routes and malformed scratch identities", () => {
    for (const address of [
      "pulse-md://bundle/index.html",
      "pulse-md://scratch",
      "pulse-md://scratch/a/b",
      "pulse-md://scratch/notes?query=1",
      "pulse-md://scratch/notes?",
      "pulse-md://user@scratch/notes",
      "pulse-md://scratch//notes",
      "pulse-md://scratch/notes/",
      "pulse-md://scratch/Bad_ID",
      "pulse-md://scratch/con",
      "pulse-md://scratch/foo%2Fbar",
      `pulse-md://scratch/${"a".repeat(65)}`,
      "https://scratch/notes",
      `pulse-md-preview://scratch/${scratchId}`,
    ]) {
      expect(parseScratchLinkAddress(address), address).toBeNull()
    }
  })

  test("rejects fragments the main process cannot route", () => {
    expect(
      parseScratchLinkAddress(`pulse-md://scratch/${scratchId}#good%0Abad`)
    ).toBeNull()
    expect(
      parseScratchLinkAddress(
        `pulse-md://scratch/${scratchId}#${"a".repeat(
          MAX_SCRATCH_LINK_FRAGMENT_LENGTH + 1
        )}`
      )
    ).toBeNull()
  })

  test("refuses to generate addresses outside the durable identity grammar", () => {
    expect(() => scratchLinkAddress({ scratchId: "Bad_ID" }, null)).toThrow(
      /identity is invalid/
    )
    expect(() => scratchLinkAddress({ scratchId }, "bad\nfragment")).toThrow(
      /fragment is invalid/
    )
  })
})
