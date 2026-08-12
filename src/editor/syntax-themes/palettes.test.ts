import { describe, expect, test } from "vitest"

import {
  BACKGROUND_COLORS,
  colorContrastRatio,
  SYNTAX_THEME_IDS,
} from "../../shared/contracts"
import {
  createPaletteHighlightStyle,
  syntaxCalloutColors,
  syntaxPreviewColors,
} from "./palettes"

describe("independently selectable syntax palettes", () => {
  test("keep every colored token readable on every built-in background", () => {
    for (const themeId of SYNTAX_THEME_IDS) {
      for (const backgroundColor of Object.values(BACKGROUND_COLORS)) {
        const highlighter = createPaletteHighlightStyle(
          themeId,
          backgroundColor
        )
        for (const spec of highlighter.specs) {
          if (!spec.color) continue
          expect(
            colorContrastRatio(spec.color, backgroundColor),
            `${themeId} ${spec.color} on ${backgroundColor}`
          ).toBeGreaterThanOrEqual(5)
        }
      }
    }
  })

  test("keeps palette-derived UI and callout colors readable too", () => {
    for (const themeId of SYNTAX_THEME_IDS) {
      for (const backgroundColor of Object.values(BACKGROUND_COLORS)) {
        const colors = {
          ...syntaxPreviewColors(themeId, backgroundColor),
          ...syntaxCalloutColors(themeId, backgroundColor),
        }
        for (const [role, color] of Object.entries(colors)) {
          expect(
            colorContrastRatio(color, backgroundColor),
            `${themeId} ${role} ${color} on ${backgroundColor}`
          ).toBeGreaterThanOrEqual(5)
        }
      }
    }
  })

  test("falls back to normal-text contrast on custom mid-tone backgrounds", () => {
    for (const themeId of SYNTAX_THEME_IDS) {
      for (const backgroundColor of ["#767676", "#808080"]) {
        const highlighter = createPaletteHighlightStyle(
          themeId,
          backgroundColor
        )
        const colors = [
          ...highlighter.specs.flatMap((spec) =>
            spec.color ? [spec.color] : []
          ),
          ...Object.values(syntaxPreviewColors(themeId, backgroundColor)),
          ...Object.values(syntaxCalloutColors(themeId, backgroundColor)),
        ]
        for (const color of colors) {
          expect(
            colorContrastRatio(color, backgroundColor),
            `${themeId} ${color} on ${backgroundColor}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})
