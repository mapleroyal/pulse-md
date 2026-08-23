import type * as React from "react"

export function insertSearchInputLineBreak(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  onValueChange: (value: string) => void
) {
  if (
    event.key !== "Enter" ||
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false
  }

  event.preventDefault()
  const input = event.currentTarget
  const selectionStart = input.selectionStart
  const selectionEnd = input.selectionEnd
  const caret = selectionStart + 1
  onValueChange(
    `${input.value.slice(0, selectionStart)}\n${input.value.slice(selectionEnd)}`
  )
  requestAnimationFrame(() => {
    if (input.isConnected) input.setSelectionRange(caret, caret)
  })
  return true
}
