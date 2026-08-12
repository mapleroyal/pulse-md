const MAX_FONT_SAMPLE_CODE_POINTS = 256
const MAX_FONT_SAMPLE_SOURCE_UNITS = 64 * 1024
const ASCII_FONT_SAMPLE = Array.from({ length: 95 }, (_value, index) =>
  String.fromCharCode(index + 0x20)
).join("")

export interface EditorFontLoader {
  load(font: string, text?: string): Promise<unknown>
}

export interface InitialEditorFontOptions {
  content: string
  monospaceFontSize: number
  monospaceFontStack: string
  samplePositions?: readonly number[]
  regularFontSize: number
  regularFontStack: string
}

export function serializedEditorContent(
  editorSession: { state: unknown } | undefined,
  documentContent: string
) {
  const state = editorSession?.state
  if (typeof state !== "object" || state === null) return documentContent
  const doc = (state as { doc?: unknown }).doc
  return typeof doc === "string" ? doc : documentContent
}

export function serializedEditorFontPositions(
  editorSession: { state: unknown; viewport?: { pos: number } } | undefined,
  initialViewport?: { pos: number }
) {
  const selection = (
    editorSession?.state as
      | {
          selection?: {
            main?: number
            ranges?: { anchor?: number; head?: number }[]
          }
        }
      | undefined
  )?.selection
  const range = selection?.ranges?.[selection.main ?? 0]
  return [
    initialViewport?.pos ?? editorSession?.viewport?.pos,
    range?.anchor,
    range?.head,
  ].filter((position): position is number => typeof position === "number")
}

function contentSampleSegments(
  content: string,
  samplePositions: readonly number[]
) {
  if (content.length <= MAX_FONT_SAMPLE_SOURCE_UNITS) return [content]

  const segmentLength = Math.floor(
    MAX_FONT_SAMPLE_SOURCE_UNITS / (samplePositions.length + 3)
  )
  const middleStart = Math.floor((content.length - segmentLength) / 2)
  return [
    ...samplePositions.map((position) =>
      content.slice(
        Math.max(0, position - segmentLength / 2),
        position + segmentLength / 2
      )
    ),
    content.slice(0, segmentLength),
    content.slice(middleStart, middleStart + segmentLength),
    content.slice(-segmentLength),
  ]
}

/**
 * Builds a small, deterministic glyph sample for FontFaceSet.load(). ASCII is
 * always present because it drives most wrapping, while bounded document
 * samples opt in the unicode-range faces the initial content actually needs.
 */
export function editorFontLoadSample(
  content: string,
  samplePositions: readonly number[] = []
) {
  const codePoints = new Set(ASCII_FONT_SAMPLE)
  const positions = [
    ...new Set(
      samplePositions
        .slice(0, 3)
        .map((position) => Math.max(0, Math.min(content.length - 1, position)))
    ),
  ]

  const priority = positions
    .map((position) => content.slice(Math.max(0, position - 1), position + 2))
    .join("")
  for (const segment of [
    priority,
    ...contentSampleSegments(content, positions),
  ]) {
    for (const character of segment) {
      const codePoint = character.codePointAt(0)!
      if (
        codePoint >= 0x20 &&
        (codePoint < 0x7f || codePoint > 0x9f) &&
        (codePoint < 0xd800 || codePoint > 0xdfff)
      ) {
        codePoints.add(character)
      }
      if (codePoints.size >= MAX_FONT_SAMPLE_CODE_POINTS)
        return [...codePoints].join("")
    }
  }

  return [...codePoints].join("")
}

/** Waits only for faces that can affect the initial editor's text geometry. */
export async function loadInitialEditorFonts(
  fontLoader: EditorFontLoader,
  options: InitialEditorFontOptions
) {
  const sample = editorFontLoadSample(options.content, options.samplePositions)
  const fonts = [
    `normal 400 ${options.regularFontSize}px ${options.regularFontStack}`,
    `italic 400 ${options.regularFontSize}px ${options.regularFontStack}`,
    `normal 700 ${options.regularFontSize}px ${options.regularFontStack}`,
    `normal 400 ${options.monospaceFontSize}px ${options.monospaceFontStack}`,
    `italic 400 ${options.monospaceFontSize}px ${options.monospaceFontStack}`,
    `normal 700 ${options.monospaceFontSize}px ${options.monospaceFontStack}`,
  ]

  await Promise.allSettled(
    fonts.map((font) =>
      Promise.resolve().then(() => fontLoader.load(font, sample))
    )
  )
}
