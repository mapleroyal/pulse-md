const TOP_CONTROL_SIZE = 30
const TOP_CONTROL_GAP = 4

export function topControlGroupWidth(
  buttonCount: number,
  hasSeparator: boolean
) {
  const itemCount = buttonCount + (hasSeparator ? 1 : 0)
  if (itemCount === 0) return 0
  return (
    buttonCount * TOP_CONTROL_SIZE +
    (hasSeparator ? 1 : 0) +
    (itemCount - 1) * TOP_CONTROL_GAP
  )
}
