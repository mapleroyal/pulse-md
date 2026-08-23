export const TOP_CHROME_HEIGHT = 46
export const NATIVE_WINDOW_CONTROL_SIZE = 14
export const NATIVE_WINDOW_CONTROL_X = 16
export const TAB_TEAR_OUT_DISTANCE = 18

export type WindowsBackgroundMaterial = "acrylic" | "mica"

export interface WindowsTitleBarOverlay {
  color: string
  height: number
  symbolColor: string
}

interface RectangleLike {
  x: number
  y: number
  width: number
  height: number
}

interface SizeLike {
  width: number
  height: number
}

export type CliWindowDisplaySelection = "active-window" | "cursor" | null

export function cliWindowDisplaySelection(
  platform: NodeJS.Platform,
  placement: "active-window" | "mouse",
  activeWindowIsOnConnectedDisplay: boolean
): CliWindowDisplaySelection {
  if (placement === "mouse") return "cursor"
  if (platform !== "darwin") return null
  return activeWindowIsOnConnectedDisplay ? "active-window" : "cursor"
}

export function minimizeWindowAccelerator(
  platform: NodeJS.Platform
): "Cmd+M" | undefined {
  return platform === "darwin" ? "Cmd+M" : undefined
}

export function centeredWindowPosition(
  workArea: RectangleLike,
  windowSize: SizeLike
): { x: number; y: number } {
  return {
    x: Math.round(
      workArea.x + Math.max(0, (workArea.width - windowSize.width) / 2)
    ),
    y: Math.round(
      workArea.y + Math.max(0, (workArea.height - windowSize.height) / 2)
    ),
  }
}

export function rectanglesIntersect(
  left: RectangleLike,
  right: RectangleLike
): boolean {
  return (
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}

export function shouldPrepareTabTearOut(
  point: { x: number; y: number },
  sourceWindow: RectangleLike,
  sourceStrip: RectangleLike,
  distance = TAB_TEAR_OUT_DISTANCE
): boolean {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new TypeError("Tear-out distance must be a non-negative number")
  }
  return (
    point.x < sourceWindow.x - distance ||
    point.x > sourceWindow.x + sourceWindow.width + distance ||
    point.y < sourceStrip.y - distance ||
    point.y > sourceStrip.y + sourceStrip.height + distance
  )
}

export function tabTearOutWindowPosition(
  point: { x: number; y: number },
  cursorOffset: { x: number; y: number }
): { x: number; y: number } {
  return {
    x: Math.round(point.x - cursorOffset.x),
    y: Math.round(point.y - cursorOffset.y),
  }
}

export function macWindowButtonPosition(zoomFactor: number): {
  x: number
  y: number
} {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new TypeError("Window zoom factor must be a positive finite number")
  }

  return {
    x: NATIVE_WINDOW_CONTROL_X,
    y: Math.round(
      (TOP_CHROME_HEIGHT * zoomFactor - NATIVE_WINDOW_CONTROL_SIZE) / 2
    ),
  }
}

export function windowsBackgroundMaterial(
  blurRadius: number
): WindowsBackgroundMaterial {
  if (!Number.isFinite(blurRadius) || blurRadius < 0) {
    throw new TypeError(
      "Background blur radius must be non-negative and finite"
    )
  }
  return blurRadius > 0 ? "acrylic" : "mica"
}

export function windowsBackgroundMaterialSupported(
  platform: NodeJS.Platform,
  release: string
): boolean {
  if (platform !== "win32") return false
  const [major, minor, build] = release.split(".").map(Number)
  return (
    major === 10 && minor === 0 && Number.isInteger(build) && build >= 22621
  )
}

export function windowsTitleBarOverlay(
  symbolColor: string,
  zoomFactor: number
): WindowsTitleBarOverlay {
  if (!/^#[\da-f]{6}$/i.test(symbolColor)) {
    throw new TypeError(
      "Window control symbol color must be a six-digit hex color"
    )
  }
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new TypeError("Window zoom factor must be a positive finite number")
  }
  return {
    color: "#00000000",
    height: Math.round(TOP_CHROME_HEIGHT * zoomFactor),
    symbolColor,
  }
}
