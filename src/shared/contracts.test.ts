import { describe, expect, it } from "vitest"

import {
  activeTabIndicatorAdaptiveColor,
  BACKGROUND_COLORS,
  colorContrastRatio,
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  ensureColorContrast,
  isSpellingToken,
  launchTransitionBezier,
  launchTransitionCssEasing,
  launchTransitionHasAnimation,
  MAX_SPELLING_WORD_LENGTH,
  parseLaunchTransitionCubicBezier,
  rebaseAppSettings,
  resolveAppearanceProfile,
} from "./contracts"

describe("Markdown extension settings", () => {
  it("keeps every optional extension disabled by default", () => {
    expect(DEFAULT_APP_SETTINGS.markdownExtensions).toEqual({
      definitionLists: false,
      emojiExpansion: false,
      emojiRecognition: false,
      footnotes: false,
      latex: false,
      mermaid: false,
      sanitizedHtml: false,
      superscriptAndSubscript: false,
      yamlFrontMatter: false,
    })
  })

  it("clones extension settings independently", () => {
    const clone = cloneAppSettings(DEFAULT_APP_SETTINGS)
    clone.markdownExtensions.footnotes = true

    expect(DEFAULT_APP_SETTINGS.markdownExtensions.footnotes).toBe(false)
  })
})

describe("editor settings", () => {
  it("keeps background readiness opt-in", () => {
    expect(DEFAULT_APP_SETTINGS.keepReadyInBackground).toBe(false)
  })

  it("enables spell checking by default", () => {
    expect(DEFAULT_APP_SETTINGS.spellCheck).toBe(true)
  })

  it("enables line wrapping by default", () => {
    expect(DEFAULT_APP_SETTINGS.lineWrapping).toBe(true)
  })

  it("gives every default heading level a distinct visual scale", () => {
    expect(DEFAULT_APP_SETTINGS.headingFontScales).toEqual([
      2.3, 1.9, 1.6, 1.3, 1.15, 1,
    ])
    expect(
      DEFAULT_APP_SETTINGS.headingFontScales.every(
        (scale, index, scales) => index === 0 || scales[index - 1]! > scale
      )
    ).toBe(true)
  })

  it("rebases stale renderer changes without losing sibling settings", () => {
    const baseline = cloneAppSettings(DEFAULT_APP_SETTINGS)
    const firstWindow = cloneAppSettings(baseline)
    firstWindow.chrome.alwaysShowStatusBar = true
    firstWindow.headingFontScales = [
      2.5,
      firstWindow.headingFontScales[1],
      firstWindow.headingFontScales[2],
      firstWindow.headingFontScales[3],
      firstWindow.headingFontScales[4],
      firstWindow.headingFontScales[5],
    ]
    const secondWindow = cloneAppSettings(baseline)
    secondWindow.lineWrapping = false
    secondWindow.chrome.topRightControls.find = false

    const afterFirst = rebaseAppSettings(baseline, baseline, firstWindow)
    const afterSecond = rebaseAppSettings(afterFirst, baseline, secondWindow)

    expect(afterSecond.chrome.alwaysShowStatusBar).toBe(true)
    expect(afterSecond.headingFontScales[0]).toBe(2.5)
    expect(afterSecond.lineWrapping).toBe(false)
    expect(afterSecond.chrome.topRightControls.find).toBe(false)
  })

  it("uses the later submitted value for the same settings field", () => {
    const baseline = cloneAppSettings(DEFAULT_APP_SETTINGS)
    const current = cloneAppSettings(baseline)
    current.maxContentWidth = 1_200
    const submitted = cloneAppSettings(baseline)
    submitted.maxContentWidth = 1_100

    expect(
      rebaseAppSettings(current, baseline, submitted).maxContentWidth
    ).toBe(1_100)
  })
})

describe("spelling tokens", () => {
  it("accepts the compounds emitted by the editor spelling scanner", () => {
    for (const token of [
      "retranscribing",
      "Qwen3-TTS",
      "Qwen3-TTS-12Hz-0.6B-Base-4bit",
      "l’esprit",
      "cafe\u0301",
      `Q${"x".repeat(MAX_SPELLING_WORD_LENGTH - 1)}`,
    ]) {
      expect(isSpellingToken(token), token).toBe(true)
    }
  })

  it("rejects values outside the editor spelling-token grammar", () => {
    for (const value of [
      null,
      "",
      "a",
      "1234",
      "0.6",
      "two words",
      "_word",
      "word-",
      "word..more",
      "word/name",
      `Q${"x".repeat(MAX_SPELLING_WORD_LENGTH)}`,
    ]) {
      expect(isSpellingToken(value), String(value)).toBe(false)
    }
  })
})

describe("window chrome settings", () => {
  it("shows tabs by default when the window has multiple tabs", () => {
    expect(DEFAULT_APP_SETTINGS.chrome.tabVisibility).toBe("multiple-tabs")
  })

  it("reveals top controls on demand by default", () => {
    expect(DEFAULT_APP_SETTINGS.chrome.alwaysShowTopControls).toBe(false)
    expect(DEFAULT_APP_SETTINGS.chrome.topRightControls).toEqual({
      find: true,
      formattingToolbar: true,
      navigation: true,
      outline: true,
      settings: true,
      viewMode: true,
    })
  })

  it("uses a focus-ring indicator on the active tab's left edge", () => {
    expect(DEFAULT_APP_SETTINGS.chrome.activeTabIndicator).toEqual({
      adaptCustomColor: false,
      colorSource: "focus-ring",
      customColor: "#3b82f6",
      positions: ["left"],
      thickness: 5,
    })
  })

  it("clones active tab indicator positions independently", () => {
    const clone = cloneAppSettings(DEFAULT_APP_SETTINGS)
    clone.chrome.activeTabIndicator.positions.push("top-right")

    expect(DEFAULT_APP_SETTINGS.chrome.activeTabIndicator.positions).toEqual([
      "left",
    ])
  })

  it("clones top-right control visibility independently", () => {
    const clone = cloneAppSettings(DEFAULT_APP_SETTINGS)
    clone.chrome.topRightControls.find = false

    expect(DEFAULT_APP_SETTINGS.chrome.topRightControls.find).toBe(true)
  })

  it("contrast-resolves adaptive custom indicators across light and dark surfaces", () => {
    for (const [color, activeTabSurface] of [
      ["#ffffff", "#e8e8e8"],
      ["#000000", "#3b3b3b"],
      ["#181818", "#3b3b3b"],
    ] as const) {
      const adapted = activeTabIndicatorAdaptiveColor(color, activeTabSurface)
      expect(
        colorContrastRatio(adapted, activeTabSurface)
      ).toBeGreaterThanOrEqual(3)
    }

    expect(activeTabIndicatorAdaptiveColor("#ff0066", "#e8e8e8")).toBe(
      "#ff0066"
    )
  })
})

describe("appearance contrast", () => {
  it("keeps every built-in document foreground readable", () => {
    for (const backgroundId of Object.keys(BACKGROUND_COLORS)) {
      const appearance = resolveAppearanceProfile({
        backgroundId: backgroundId as keyof typeof BACKGROUND_COLORS,
        customBackgroundColor: "#ffffff",
        syntaxThemeId: "default",
      })
      expect(
        colorContrastRatio(
          appearance.foregroundColor,
          appearance.backgroundColor
        ),
        backgroundId
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        colorContrastRatio(
          appearance.mutedForegroundColor,
          appearance.backgroundColor
        ),
        `${backgroundId} muted`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("chooses readable foregrounds and contrast-preserving tints for custom backgrounds", () => {
    for (const customBackgroundColor of [
      "#000000",
      "#181818",
      "#767676",
      "#808080",
      "#fdf6e3",
      "#ffffff",
    ]) {
      const appearance = resolveAppearanceProfile({
        backgroundId: "custom",
        customBackgroundColor,
        syntaxThemeId: "default",
      })
      expect(
        colorContrastRatio(
          appearance.foregroundColor,
          appearance.backgroundColor
        ),
        customBackgroundColor
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        colorContrastRatio(
          appearance.mutedForegroundColor,
          appearance.backgroundColor
        ),
        `${customBackgroundColor} muted`
      ).toBeGreaterThanOrEqual(4.5)
      const baseContrast = colorContrastRatio(
        appearance.foregroundColor,
        appearance.backgroundColor
      )
      if (baseContrast >= 7) {
        expect(appearance.surfaceTintColor).toBe(appearance.foregroundColor)
      } else {
        expect(
          colorContrastRatio(
            appearance.foregroundColor,
            appearance.surfaceTintColor
          ),
          customBackgroundColor
        ).toBeGreaterThan(baseContrast)
      }
    }
  })

  it("changes a palette color only when its requested contrast needs it", () => {
    expect(ensureColorContrast("#171717", "#ffffff")).toBe("#171717")
    const correctedRed = ensureColorContrast("#ff0000", "#ffffff")
    expect(correctedRed).not.toBe("#ff0000")
    expect(colorContrastRatio(correctedRed, "#ffffff")).toBeGreaterThanOrEqual(
      4.5
    )
  })
})

describe("launch transition easing", () => {
  it("uses the launch reveal defaults", () => {
    expect(DEFAULT_APP_SETTINGS.launchTransition).toMatchObject({
      delayMs: 150,
      durationMs: 2_000,
      easing: "ease-out",
      enabled: false,
      strategy: "tint-blur",
    })
  })

  it("only configures an animation when enabled with a positive duration", () => {
    expect(
      launchTransitionHasAnimation(DEFAULT_APP_SETTINGS.launchTransition)
    ).toBe(false)
    expect(
      launchTransitionHasAnimation({
        ...DEFAULT_APP_SETTINGS.launchTransition,
        enabled: true,
      })
    ).toBe(true)
    expect(
      launchTransitionHasAnimation({
        ...DEFAULT_APP_SETTINGS.launchTransition,
        durationMs: 0,
        enabled: true,
      })
    ).toBe(false)
  })

  it("maps the CSS presets to the same cubic bezier used by native blur", () => {
    const expected = {
      "gentle-ease-out": [0.22, 1, 0.36, 1],
      "material-ease-out": [0.2, 0, 0, 1],
      "ease-out": [0, 0, 0.58, 1],
      "ease-in-out": [0.42, 0, 0.58, 1],
      ease: [0.25, 0.1, 0.25, 1],
      linear: [0, 0, 1, 1],
    } as const

    for (const [easing, curve] of Object.entries(expected)) {
      expect(
        launchTransitionBezier({
          ...DEFAULT_APP_SETTINGS.launchTransition,
          easing: easing as keyof typeof expected,
        })
      ).toEqual(curve)
    }
  })

  it("accepts native-safe custom curves and rejects overshooting points", () => {
    const customEasing = "cubic-bezier(0.12, 0.3, 0.84, 0.95)"
    expect(parseLaunchTransitionCubicBezier(customEasing)).toEqual([
      0.12, 0.3, 0.84, 0.95,
    ])
    expect(
      parseLaunchTransitionCubicBezier("cubic-bezier(-0.1, 0, 1, 1)")
    ).toBeNull()
    expect(
      parseLaunchTransitionCubicBezier("cubic-bezier(0, 0, 1.1, 1)")
    ).toBeNull()
    expect(
      parseLaunchTransitionCubicBezier("cubic-bezier(0.1, -0.1, 0.9, 1)")
    ).toBeNull()
    expect(
      parseLaunchTransitionCubicBezier("cubic-bezier(0.1, 0, 0.9, 1.1)")
    ).toBeNull()
    expect(
      launchTransitionCssEasing({
        ...DEFAULT_APP_SETTINGS.launchTransition,
        customEasing,
        easing: "custom",
      })
    ).toBe("cubic-bezier(0.12, 0.3, 0.84, 0.95)")
  })
})
