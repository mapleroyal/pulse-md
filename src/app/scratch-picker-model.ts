import type {
  ScratchEntry,
  ScratchOpenDisposition as SharedScratchOpenDisposition,
  ScratchPreview,
  ScratchProfileReference as SharedScratchProfileReference,
  ScratchSortOrder,
} from "@/shared/contracts"

export const SCRATCH_SORT_OPTIONS = [
  "last-opened",
  "last-edited",
  "created",
  "title",
  "filename",
] as const satisfies readonly ScratchSortOrder[]

export type ScratchSort = ScratchSortOrder
export type ScratchSummary = ScratchEntry
export type ScratchProfileReference = SharedScratchProfileReference
export type ScratchPreviewDocument = ScratchPreview
export type ScratchOpenDisposition = SharedScratchOpenDisposition

export type ScratchPickerKeyAction =
  | { kind: "activate"; disposition: ScratchOpenDisposition }
  | { kind: "clear-query" }
  | { kind: "close" }
  | { direction: 1 | -1; kind: "cycle" }

export function scratchPickerActionAllowed(
  action: ScratchPickerKeyAction,
  resultsCurrent: boolean
) {
  return (
    resultsCurrent || action.kind === "clear-query" || action.kind === "close"
  )
}

export function scratchPreviewRevisionMatches(
  scratchRevision: string,
  cached:
    { previewRevision: string; requestedRevision: string } | null | undefined
) {
  return (
    cached?.requestedRevision === scratchRevision ||
    cached?.previewRevision === scratchRevision
  )
}

export interface ScratchPickerKeyStroke {
  altKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export const SCRATCH_SORT_LABELS: Record<ScratchSort, string> = {
  "last-opened": "Recently Opened",
  "last-edited": "Recently Edited",
  created: "Recently Created",
  title: "Title",
  filename: "Filename",
}

const markdownExtensionPattern = /\.md$/i
const reservedFileNamePattern =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const forbiddenFileNamePattern = /[<>:"/\\|?*\p{Cc}]/u

export function scratchPickerKeyAction(
  event: ScratchPickerKeyStroke,
  hasQuery: boolean
): ScratchPickerKeyAction | null {
  if (event.isComposing) return null
  if (
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return {
      direction: event.key === "ArrowDown" ? 1 : -1,
      kind: "cycle",
    }
  }
  if (event.key === "Escape" && !event.altKey && !event.ctrlKey) {
    return { kind: hasQuery ? "clear-query" : "close" }
  }
  if (event.key === "Enter" && !event.altKey && !event.shiftKey) {
    return {
      disposition: event.metaKey || event.ctrlKey ? "new-tab" : "default",
      kind: "activate",
    }
  }
  return null
}

export function nextScratchIndex(
  entryCount: number,
  selectedIndex: number,
  direction: 1 | -1
) {
  if (entryCount <= 0) return -1
  if (selectedIndex < 0 || selectedIndex >= entryCount) {
    return direction === 1 ? 0 : entryCount - 1
  }
  return (selectedIndex + direction + entryCount) % entryCount
}

function normalizedText(value: string | null | undefined) {
  return value?.trim() ?? ""
}

export function scratchTitle(scratch: ScratchSummary) {
  const title = normalizedText(scratch.title)
  if (title) return title

  const firstHeading = normalizedText(scratch.firstHeading)
  if (firstHeading) return firstHeading

  const displayTitle = normalizedText(scratch.displayTitle)
  if (displayTitle) return displayTitle

  const filenameStem = scratch.fileName.replace(markdownExtensionPattern, "")
  return filenameStem.trim() || "Untitled Scratch"
}

export function normalizedScratchFilename(value: string) {
  const filename = value.trim().normalize("NFC")
  if (!filename) return ""
  return markdownExtensionPattern.test(filename)
    ? `${filename.slice(0, -3)}.md`
    : `${filename}.md`
}

export function scratchFilenameError(value: string) {
  const filename = normalizedScratchFilename(value)
  if (!filename) return "Enter a filename."
  if (forbiddenFileNamePattern.test(filename)) {
    return "Remove reserved filename characters."
  }
  const stem = filename.slice(0, -3)
  if (
    !stem ||
    stem === "." ||
    stem === ".." ||
    stem.endsWith(".") ||
    stem.endsWith(" ") ||
    reservedFileNamePattern.test(stem)
  ) {
    return "Enter a portable filename."
  }
  if (new TextEncoder().encode(filename).byteLength > 255) {
    return "Use a filename no larger than 255 UTF-8 bytes."
  }
  return null
}
