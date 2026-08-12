import type { BlockContext, Line, MarkdownConfig } from "@lezer/markdown"

export type OrderedListMarkerFamily =
  "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman"

export interface OrderedListMarker {
  readonly delimiter: "." | ")"
  readonly token: string
}

const fancyOrderedMarkerPattern = /^([A-Za-z]+)([.)])(?=[\t ]|$)/
const decimalOrderedMarkerPattern = /^(\d{1,9})([.)])(?=[\t ]|$)/
const canonicalRomanPattern =
  /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i
const orderedMarkerInitialContextCharacterLimit = 256
const orderedMarkerMaximumContextCharacterLimit = 4_096
const orderedMarkerContextLineLimit = 32

function consistentlyCased(token: string) {
  return token === token.toLowerCase() || token === token.toUpperCase()
}

export function parsePotentialOrderedListMarker(
  source: string
): OrderedListMarker | null {
  const decimal = decimalOrderedMarkerPattern.exec(source)
  if (decimal) {
    return {
      delimiter: decimal[2] as "." | ")",
      token: decimal[1]!,
    }
  }

  const fancy = fancyOrderedMarkerPattern.exec(source)
  if (!fancy || !consistentlyCased(fancy[1]!)) {
    return null
  }
  return {
    delimiter: fancy[2] as "." | ")",
    token: fancy[1]!,
  }
}

export function parseOrderedListMarker(
  source: string
): OrderedListMarker | null {
  const marker = parsePotentialOrderedListMarker(source)
  if (
    marker &&
    !/^\d+$/.test(marker.token) &&
    marker.token.length > 1 &&
    !conventionalRomanFamily(marker.token)
  ) {
    return null
  }
  return marker
}

export function orderedListMarkerLength(source: string) {
  const marker = parseOrderedListMarker(source)
  return marker ? marker.token.length + 1 : 0
}

export function listMarkerPrefixLength(source: string) {
  const orderedLength = orderedListMarkerLength(source)
  if (orderedLength > 0) {
    const marker = parseOrderedListMarker(source)!
    const spacing = /^[\t ]+/.exec(source.slice(orderedLength))?.[0].length ?? 0
    if (
      marker.delimiter === "." &&
      /^[A-Z]$/.test(marker.token) &&
      spacing < 2
    ) {
      return 0
    }
    return orderedLength + spacing
  }
  return /^(?:[-+*])(?:[\t ]+|$)/.exec(source)?.[0].length ?? 0
}

function isCanonicalRoman(token: string) {
  return consistentlyCased(token) && canonicalRomanPattern.test(token)
}

export function orderedListMarkerFamilies(
  token: string
): readonly OrderedListMarkerFamily[] {
  if (/^\d+$/.test(token)) return ["decimal"]
  if (!/^[A-Za-z]+$/.test(token) || !consistentlyCased(token)) return []

  const upper = token === token.toUpperCase()
  const families: OrderedListMarkerFamily[] = [
    upper ? "upper-alpha" : "lower-alpha",
  ]
  if (isCanonicalRoman(token)) {
    families.push(upper ? "upper-roman" : "lower-roman")
  }
  return families
}

function alphaOrdinal(token: string) {
  let value = 0
  for (const character of token.toLowerCase()) {
    value = value * 26 + character.charCodeAt(0) - 96
    if (!Number.isSafeInteger(value)) return null
  }
  return value
}

function romanOrdinal(token: string) {
  if (!isCanonicalRoman(token)) return null
  const values: Readonly<Record<string, number>> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  }
  const source = token.toUpperCase()
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    const current = values[source[index]!]!
    const next = values[source[index + 1]!] ?? 0
    value += current < next ? -current : current
  }
  return value
}

export function orderedListMarkerOrdinal(
  token: string,
  family: OrderedListMarkerFamily
) {
  switch (family) {
    case "decimal": {
      if (!/^\d+$/.test(token)) return null
      const value = Number(token)
      return Number.isSafeInteger(value) ? value : null
    }
    case "lower-alpha":
      return token === token.toLowerCase() && /^[a-z]+$/.test(token)
        ? alphaOrdinal(token)
        : null
    case "upper-alpha":
      return token === token.toUpperCase() && /^[A-Z]+$/.test(token)
        ? alphaOrdinal(token)
        : null
    case "lower-roman":
      return token === token.toLowerCase() ? romanOrdinal(token) : null
    case "upper-roman":
      return token === token.toUpperCase() ? romanOrdinal(token) : null
  }
}

function alphaToken(value: number) {
  let remaining = value
  let token = ""
  while (remaining > 0) {
    remaining -= 1
    token = String.fromCharCode(97 + (remaining % 26)) + token
    remaining = Math.floor(remaining / 26)
  }
  return token
}

function romanToken(value: number) {
  if (value < 1 || value > 3_999) return null
  const numerals: ReadonlyArray<readonly [number, string]> = [
    [1_000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ]
  let remaining = value
  let token = ""
  for (const [number, numeral] of numerals) {
    while (remaining >= number) {
      token += numeral
      remaining -= number
    }
  }
  return token
}

export function orderedListMarkerToken(
  value: number,
  family: OrderedListMarkerFamily,
  minimumWidth = 0
) {
  if (!Number.isSafeInteger(value)) return null
  switch (family) {
    case "decimal": {
      if (value < 0) return null
      const token = String(value).padStart(minimumWidth, "0")
      return token.length <= 9 ? token : null
    }
    case "lower-alpha":
      if (value < 1) return null
      return alphaToken(value)
    case "upper-alpha":
      if (value < 1) return null
      return alphaToken(value).toUpperCase()
    case "lower-roman":
      if (value < 1) return null
      return romanToken(value)?.toLowerCase() ?? null
    case "upper-roman":
      if (value < 1) return null
      return romanToken(value)
  }
}

/**
 * Resolves the few single-letter tokens that can be either alphabetic or
 * Roman from their same-level neighbors. A lone i/I and multi-character
 * canonical numeral default to Roman; other lone letters default to alpha.
 */
export function inferOrderedListMarkerFamily(
  token: string,
  previousToken: string | null,
  nextToken: string | null
) {
  const candidates = orderedListMarkerFamilies(token)
  if (candidates.length <= 1) return candidates[0] ?? null

  let best = candidates[0]!
  let bestScore = -1
  for (const family of candidates) {
    const value = orderedListMarkerOrdinal(token, family)
    if (value == null) continue
    let score = 0
    const previous = previousToken
      ? orderedListMarkerOrdinal(previousToken, family)
      : null
    const next = nextToken ? orderedListMarkerOrdinal(nextToken, family) : null
    if (previous != null && previous + 1 === value) score += 2
    if (next != null && value + 1 === next) score += 2
    if (score > bestScore) {
      best = family
      bestScore = score
    }
  }

  if (bestScore > 0) return best
  if (token.toLowerCase() === "i" || token.length > 1) {
    return candidates.find((family) => family.endsWith("-roman")) ?? best
  }
  return candidates.find((family) => family.endsWith("-alpha")) ?? best
}

function contextIsInsideListItem(context: BlockContext) {
  for (let depth = context.depth - 1; depth >= 0; depth -= 1) {
    if (context.parentType(depth).name === "ListItem") return true
  }
  return false
}

interface SequenceContext {
  readonly absoluteLineStart?: number
  readonly input?: { read(from: number, to: number): string }
}

interface SequenceScanResult {
  readonly conclusive: boolean
  readonly family: OrderedListMarkerFamily | null
}

const precedingSequenceCache = new WeakMap<
  BlockContext,
  {
    readonly delimiter: "." | ")"
    readonly family: OrderedListMarkerFamily | null
    readonly lineStart: number
    readonly prefix: string
    readonly token: string
  }
>()

function startsDifferentBlock(source: string) {
  return (
    /(^|[^\\])\|/.test(source) ||
    /^(?:#{1,6}(?:[\t ]|$)|[-+*](?:[\t ]|$)|>{1,}[\t ]?|`{3,}|~{3,}|<[A-Za-z!/]|(?:={3,}|-{3,}|_{3,})[\t ]*$)/.test(
      source
    )
  )
}

function scanPrecedingSequence(
  preceding: string,
  truncated: boolean,
  prefix: string,
  marker: OrderedListMarker
): SequenceScanResult {
  const lines = preceding.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  let examined = 0
  let blankLines = 0

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (truncated && index === 0) {
      return { conclusive: false, family: null }
    }
    examined += 1
    if (examined > orderedMarkerContextLineLimit) {
      return { conclusive: true, family: null }
    }
    const previousLine = lines[index]!
    if (!previousLine.trim()) {
      blankLines += 1
      if (blankLines > 1) return { conclusive: true, family: null }
      continue
    }
    if (!previousLine.startsWith(prefix)) {
      return { conclusive: true, family: null }
    }
    const source = previousLine.slice(prefix.length)
    if (/^[\t ]/.test(source)) continue
    if (startsDifferentBlock(source)) {
      return { conclusive: true, family: null }
    }

    const previous = parsePotentialOrderedListMarker(source)
    if (!previous) continue
    if (previous.delimiter !== marker.delimiter) {
      return { conclusive: true, family: null }
    }

    for (const family of orderedListMarkerFamilies(marker.token)) {
      const previousValue = orderedListMarkerOrdinal(previous.token, family)
      const value = orderedListMarkerOrdinal(marker.token, family)
      if (previousValue != null && value === previousValue + 1) {
        return { conclusive: true, family }
      }
    }
    if (
      /^\d+$/.test(previous.token) ||
      previous.token.length === 1 ||
      conventionalRomanFamily(previous.token)
    ) {
      return { conclusive: true, family: null }
    }
  }
  return { conclusive: !truncated, family: null }
}

function precedingSequentialFamily(
  context: BlockContext,
  line: Line,
  marker: OrderedListMarker
) {
  // Lezer keeps the original input position alongside its public, gap-adjusted
  // `lineStart`. Reading it lets an incremental parse validate an ambiguous
  // marker against authored source even when the preceding node was reused.
  // Fall back conservatively if a future Lezer version no longer exposes it.
  const sourceContext = context as BlockContext & SequenceContext
  const input = sourceContext.input
  if (!input) return null
  const currentStart =
    typeof sourceContext.absoluteLineStart === "number"
      ? sourceContext.absoluteLineStart
      : context.lineStart
  if (currentStart <= 0) return null
  const prefix = line.text.slice(0, line.pos)
  const cached = precedingSequenceCache.get(context)
  if (
    cached?.lineStart === currentStart &&
    cached.prefix === prefix &&
    cached.token === marker.token &&
    cached.delimiter === marker.delimiter
  ) {
    return cached.family
  }

  let family: OrderedListMarkerFamily | null = null
  for (const limit of [
    orderedMarkerInitialContextCharacterLimit,
    orderedMarkerMaximumContextCharacterLimit,
  ]) {
    const from = Math.max(0, currentStart - limit)
    const result = scanPrecedingSequence(
      input.read(from, currentStart),
      from > 0,
      prefix,
      marker
    )
    if (result.conclusive) {
      family = result.family
      break
    }
  }
  precedingSequenceCache.set(context, {
    delimiter: marker.delimiter,
    family,
    lineStart: currentStart,
    prefix,
    token: marker.token,
  })
  return family
}

function conventionalRomanFamily(token: string) {
  if (token.length <= 1 || !isCanonicalRoman(token)) return null
  const family: OrderedListMarkerFamily =
    token === token.toUpperCase() ? "upper-roman" : "lower-roman"
  const value = orderedListMarkerOrdinal(token, family)
  return value != null && value <= 49 ? family : null
}

function fancyMarkerAt(
  context: BlockContext,
  line: Line,
  nested: boolean,
  needsInterruptionEvidence = false
) {
  const source = line.text.slice(line.pos)
  const marker = parsePotentialOrderedListMarker(source)
  if (!marker || /^\d+$/.test(marker.token)) return null
  const markerTo = line.pos + marker.token.length + 1
  const spacing = line.skipSpace(markerTo) - markerTo
  const romanFamily = conventionalRomanFamily(marker.token)
  const ambiguousUppercasePeriod =
    marker.delimiter === "." && /^[A-Z]$/.test(marker.token) && spacing < 2
  const needsSequence =
    needsInterruptionEvidence ||
    (marker.token.length > 1 && !romanFamily) ||
    (ambiguousUppercasePeriod && marker.token !== "A")
  const sequentialFamily = needsSequence
    ? precedingSequentialFamily(context, line, marker)
    : null
  if (marker.token.length > 1 && !sequentialFamily && !romanFamily) {
    return null
  }
  if (ambiguousUppercasePeriod) {
    if (!nested || (marker.token !== "A" && !sequentialFamily)) return null
  }
  return {
    family:
      sequentialFamily ??
      romanFamily ??
      inferOrderedListMarkerFamily(marker.token, null, null),
    marker,
    markerTo,
    sequential: sequentialFamily != null,
  }
}

function listContentIndent(line: Line, markerTo: number) {
  const markerEndColumn = line.countIndent(markerTo, line.pos, line.indent)
  const contentFrom = line.skipSpace(markerTo)
  const contentColumn = line.countIndent(contentFrom, markerTo, markerEndColumn)
  return contentColumn >= markerEndColumn + 5
    ? markerEndColumn + 1
    : contentColumn
}

/**
 * Adds alphabetic and Roman markers to the same Lezer list structure used by
 * CommonMark. The stock OrderedList context deliberately closes between these
 * non-CommonMark siblings, but their real ListItem/ListMark nodes still give
 * editing and preview one shared structural vocabulary.
 */
export const fancyOrderedListMarkdownExtension: MarkdownConfig = {
  parseBlock: [
    {
      name: "FancyOrderedList",
      before: "OrderedList",
      endLeaf(context, line) {
        const nested = contextIsInsideListItem(context)
        const start = fancyMarkerAt(context, line, nested, !nested)
        if (!start) return false
        return (
          nested ||
          start.sequential ||
          (line.skipSpace(start.markerTo) < line.text.length &&
            start.family != null &&
            orderedListMarkerOrdinal(start.marker.token, start.family) === 1)
        )
      },
      parse(context, line) {
        const start = fancyMarkerAt(
          context,
          line,
          contextIsInsideListItem(context)
        )
        if (!start) return false

        context.startComposite(
          "OrderedList",
          line.basePos,
          start.marker.delimiter.charCodeAt(0)
        )
        const contentIndent = listContentIndent(line, start.markerTo)
        context.startComposite(
          "ListItem",
          line.basePos,
          contentIndent - line.baseIndent
        )
        context.addElement(
          context.elt(
            "ListMark",
            context.lineStart + line.pos,
            context.lineStart + start.markerTo
          )
        )
        line.moveBaseColumn(contentIndent)
        return null
      },
    },
  ],
}
