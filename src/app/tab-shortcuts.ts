import type { AppPlatform } from "@/shared/contracts"

export function tabIndexForDigitShortcut(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
  platform: AppPlatform | null
): number | null {
  if (event.altKey || event.shiftKey) return null

  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1]
  if (digit === undefined) return null

  const controlPressed = event.ctrlKey && !event.metaKey
  const metaPressed =
    event.metaKey &&
    !event.ctrlKey &&
    (platform === "linux" || (platform === "darwin" && digit !== "0"))
  if (!controlPressed && !metaPressed) return null

  return digit === "0" ? 9 : Number(digit) - 1
}
