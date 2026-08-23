import { describe, expect, it } from "vitest"

import {
  cliWindowDisplaySelection,
  centeredWindowPosition,
  macWindowButtonPosition,
  minimizeWindowAccelerator,
  rectanglesIntersect,
  shouldPrepareTabTearOut,
  tabTearOutWindowPosition,
  windowsBackgroundMaterial,
  windowsBackgroundMaterialSupported,
  windowsTitleBarOverlay,
} from "./window-chrome"

describe("platform window behavior", () => {
  it("places --mouse-monitor windows on the cursor display on Windows", () => {
    expect(cliWindowDisplaySelection("win32", "mouse", false)).toBe("cursor")
    expect(cliWindowDisplaySelection("win32", "mouse", true)).toBe("cursor")
  })

  it("leaves default Windows placement to the operating system", () => {
    expect(cliWindowDisplaySelection("win32", "active-window", true)).toBeNull()
  })

  it("preserves active-window placement and cursor fallback on macOS", () => {
    expect(cliWindowDisplaySelection("darwin", "active-window", true)).toBe(
      "active-window"
    )
    expect(cliWindowDisplaySelection("darwin", "active-window", false)).toBe(
      "cursor"
    )
  })

  it("reserves the minimize shortcut for macOS", () => {
    expect(minimizeWindowAccelerator("darwin")).toBe("Cmd+M")
    expect(minimizeWindowAccelerator("win32")).toBeUndefined()
    expect(minimizeWindowAccelerator("linux")).toBeUndefined()
  })
})

describe("centeredWindowPosition", () => {
  it("centers a window within an offset display work area", () => {
    expect(
      centeredWindowPosition(
        { x: 1_920, y: 24, width: 1_440, height: 876 },
        { width: 900, height: 720 }
      )
    ).toEqual({ x: 2_190, y: 102 })
  })

  it("keeps the origin on a work area smaller than the window", () => {
    expect(
      centeredWindowPosition(
        { x: -800, y: 0, width: 800, height: 600 },
        { width: 900, height: 720 }
      )
    ).toEqual({ x: -800, y: 0 })
  })
})

describe("rectanglesIntersect", () => {
  it("recognizes an active window on a negative-coordinate display", () => {
    expect(
      rectanglesIntersect(
        { x: -1_440, y: 24, width: 900, height: 720 },
        { x: -1_440, y: 0, width: 1_440, height: 900 }
      )
    ).toBe(true)
  })

  it("rejects stale bounds that only touch or miss every current display", () => {
    const display = { x: 0, y: 0, width: 1_440, height: 900 }
    expect(
      rectanglesIntersect(
        { x: 1_440, y: 100, width: 900, height: 720 },
        display
      )
    ).toBe(false)
    expect(
      rectanglesIntersect(
        { x: 4_000, y: 100, width: 900, height: 720 },
        display
      )
    ).toBe(false)
  })
})

describe("macWindowButtonPosition", () => {
  it.each([
    [0.8, { x: 16, y: 11 }],
    [1, { x: 16, y: 16 }],
    [1.25, { x: 16, y: 22 }],
    [2, { x: 16, y: 39 }],
  ])("centers fixed-size controls at %sx document zoom", (zoom, expected) => {
    expect(macWindowButtonPosition(zoom)).toEqual(expected)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid zoom factor: %s",
    (zoom) => {
      expect(() => macWindowButtonPosition(zoom)).toThrow(TypeError)
    }
  )
})

describe("Windows native chrome", () => {
  it.each([
    ["10.0.22621", true],
    ["10.0.26100", true],
    ["10.0.22000", false],
    ["6.3.9600", false],
    ["invalid", false],
  ])("detects backdrop support for Windows release %s", (release, expected) => {
    expect(windowsBackgroundMaterialSupported("win32", release)).toBe(expected)
  })

  it("does not expose the Windows backdrop on other platforms", () => {
    expect(windowsBackgroundMaterialSupported("darwin", "10.0.26100")).toBe(
      false
    )
  })

  it("maps a zero-radius background to Mica and blurred backgrounds to Acrylic", () => {
    expect(windowsBackgroundMaterial(0)).toBe("mica")
    expect(windowsBackgroundMaterial(1)).toBe("acrylic")
    expect(windowsBackgroundMaterial(80)).toBe("acrylic")
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid Windows blur radius: %s",
    (blurRadius) => {
      expect(() => windowsBackgroundMaterial(blurRadius)).toThrow(TypeError)
    }
  )

  it.each([
    [0.8, 37],
    [1, 46],
    [1.25, 58],
    [2, 92],
  ])("scales the transparent caption overlay at %sx zoom", (zoom, height) => {
    expect(windowsTitleBarOverlay("#171717", zoom)).toEqual({
      color: "#00000000",
      height,
      symbolColor: "#171717",
    })
  })

  it("rejects invalid Windows caption overlay inputs", () => {
    expect(() => windowsTitleBarOverlay("black", 1)).toThrow(TypeError)
    expect(() => windowsTitleBarOverlay("#171717", 0)).toThrow(TypeError)
  })
})

describe("tab tear-out geometry", () => {
  const sourceWindow = { x: 100, y: 80, width: 900, height: 720 }
  const sourceStrip = { x: 186, y: 88, width: 700, height: 30 }

  it("requires a deliberate vertical threshold outside the tab strip", () => {
    expect(
      shouldPrepareTabTearOut({ x: 400, y: 136 }, sourceWindow, sourceStrip)
    ).toBe(false)
    expect(
      shouldPrepareTabTearOut({ x: 400, y: 137 }, sourceWindow, sourceStrip)
    ).toBe(true)
    expect(
      shouldPrepareTabTearOut({ x: 400, y: 70 }, sourceWindow, sourceStrip)
    ).toBe(false)
    expect(
      shouldPrepareTabTearOut({ x: 400, y: 69 }, sourceWindow, sourceStrip)
    ).toBe(true)
  })

  it("does not treat horizontal movement within the source window as a tear-out", () => {
    expect(
      shouldPrepareTabTearOut({ x: 950, y: 100 }, sourceWindow, sourceStrip)
    ).toBe(false)
    expect(
      shouldPrepareTabTearOut({ x: 1_019, y: 100 }, sourceWindow, sourceStrip)
    ).toBe(true)
  })

  it("preserves the pointer's grab offset when positioning the window", () => {
    expect(
      tabTearOutWindowPosition({ x: 743.6, y: 261.4 }, { x: 153.2, y: 19.8 })
    ).toEqual({ x: 590, y: 242 })
  })
})
