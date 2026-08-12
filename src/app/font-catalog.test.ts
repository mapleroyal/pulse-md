import { describe, expect, it } from "vitest"

import {
  buildFontFamilyOptions,
  dedupeSystemFontFamilies,
  fontFamilyCssStack,
  fontFamilyOptionMatches,
  INCLUDED_FONT_FAMILY_OPTIONS,
} from "./font-catalog"

describe("system font catalog", () => {
  it("deduplicates faces into sorted font families", () => {
    expect(
      dedupeSystemFontFamilies([
        { family: "Zed Sans", style: "Regular" },
        { family: "Alpha Serif", style: "Bold" },
        { family: "zed sans", style: "Italic" },
        { family: "  ", style: "Regular" },
      ])
    ).toEqual([
      { family: "Alpha Serif", faceCount: 1, styles: ["Bold"] },
      {
        family: "Zed Sans",
        faceCount: 2,
        styles: ["Italic", "Regular"],
      },
    ])
  })

  it("keeps relevant included and generic options first", () => {
    const families = dedupeSystemFontFamilies([
      { family: "Inter Variable", style: "Regular" },
      { family: "Menlo", style: "Regular" },
    ])
    const regular = buildFontFamilyOptions(families, "regular")
    const monospace = buildFontFamilyOptions(families, "monospace")

    expect(regular[0]?.value).toBe("Inter Variable")
    expect(monospace[0]?.value).toBe("Cascadia Code Variable")
    expect(
      regular.filter(({ value }) => value === "Inter Variable")
    ).toHaveLength(1)
  })

  it("offers the curated bundled catalog for each font purpose", () => {
    const regular = INCLUDED_FONT_FAMILY_OPTIONS.filter(
      ({ purpose }) => purpose === "regular"
    ).map(({ label }) => label)
    const monospace = INCLUDED_FONT_FAMILY_OPTIONS.filter(
      ({ purpose }) => purpose === "monospace"
    ).map(({ label }) => label)

    expect(regular).toEqual([
      "Inter",
      "Geist",
      "Manrope",
      "DM Sans",
      "Space Grotesk",
      "Atkinson Hyperlegible Next",
      "IBM Plex Sans",
      "Newsreader",
    ])
    expect(monospace).toEqual([
      "Cascadia Code",
      "JetBrains Mono",
      "Fira Code",
      "Geist Mono",
      "Source Code Pro",
      "Google Sans Code",
    ])
  })

  it("searches family and style terms", () => {
    const option = buildFontFamilyOptions(
      [{ family: "Example Sans", faceCount: 2, styles: ["Book", "Italic"] }],
      "regular"
    ).find(({ value }) => value === "Example Sans")!

    expect(fontFamilyOptionMatches(option, "example ita")).toBe(true)
    expect(fontFamilyOptionMatches(option, "serif")).toBe(false)
  })

  it("does not quote CSS generic families", () => {
    expect(fontFamilyCssStack("system-ui", "regular")).toMatch(/^system-ui,/)
    expect(fontFamilyCssStack("Avenir Next", "regular")).toMatch(
      /^"Avenir Next",/
    )
  })
})
