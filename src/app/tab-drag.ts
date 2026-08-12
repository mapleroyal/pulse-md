export interface TabDropGeometry {
  id: string
  left: number
  right: number
}

export interface AxisDropGeometry {
  end: number
  id: string
  start: number
}

function insertionIndex<T extends { id: string }>(
  items: readonly T[],
  draggingItemId: string | null,
  pointer: number,
  start: (item: T) => number,
  end: (item: T) => number
) {
  const draggedItem = draggingItemId
    ? items.find((item) => item.id === draggingItemId)
    : undefined
  const targets = items.filter((item) => item.id !== draggingItemId)

  if (draggedItem) {
    const hoveredIndex = targets.findIndex(
      (item) => pointer >= start(item) && pointer <= end(item)
    )
    const hoveredItem = targets[hoveredIndex]
    if (hoveredItem) {
      return start(hoveredItem) < start(draggedItem)
        ? hoveredIndex
        : hoveredIndex + 1
    }
  }

  const midpointIndex = targets.findIndex(
    (item) => pointer < start(item) + (end(item) - start(item)) / 2
  )
  return midpointIndex < 0 ? targets.length : midpointIndex
}

export function axisInsertionIndex(
  items: readonly AxisDropGeometry[],
  draggingItemId: string | null,
  pointer: number
) {
  return insertionIndex(
    items,
    draggingItemId,
    pointer,
    (item) => item.start,
    (item) => item.end
  )
}

export function tabInsertionIndex(
  chips: readonly TabDropGeometry[],
  draggingTabId: string | null,
  pointerX: number
) {
  return insertionIndex(
    chips,
    draggingTabId,
    pointerX,
    (chip) => chip.left,
    (chip) => chip.right
  )
}
