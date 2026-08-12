import { countColumn } from "@codemirror/state"

export function sourceColumn(text: string, to: number, tabSize: number) {
  return countColumn(text.slice(0, to), tabSize)
}

export function sourceColumnWidth(
  text: string,
  from: number,
  to: number,
  tabSize: number
) {
  return sourceColumn(text, to, tabSize) - sourceColumn(text, from, tabSize)
}

/**
 * Parse only CommonMark blockquote containers. Indentation before each `>` is
 * measured in physical columns, so a root tab (four columns) remains code
 * while a tab that reaches a quote-relative third column can still be valid.
 * CommonMark consumes one optional literal space after `>`; a tab is content.
 */
export function markdownContainerPrefix(
  text: string,
  tabSize: number,
  maximumQuoteDepth = Number.POSITIVE_INFINITY
) {
  let length = 0
  let quoteDepth = 0
  let hasTrailingPadding = false
  while (length < text.length && quoteDepth < maximumQuoteDepth) {
    const baseColumn = sourceColumn(text, length, tabSize)
    let marker = length
    let column = baseColumn
    while (marker < text.length && /[\t ]/.test(text[marker]!)) {
      const nextColumn =
        text[marker] === "\t"
          ? column +
            (column % tabSize === 0 ? tabSize : tabSize - (column % tabSize))
          : column + 1
      if (nextColumn - baseColumn > 3) break
      column = nextColumn
      marker += 1
    }
    if (text[marker] !== ">") break

    length = marker + 1
    quoteDepth += 1
    hasTrailingPadding = text[length] === " "
    if (hasTrailingPadding) length += 1
  }
  return {
    length,
    quoteDepth,
    trailingPaddingLength: quoteDepth > 0 && hasTrailingPadding ? 1 : 0,
    containerNeedsCanonicalPadding: quoteDepth > 0 && !hasTrailingPadding,
  }
}
