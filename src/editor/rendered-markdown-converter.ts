import TurndownService from "turndown"
import { tables, taskListItems } from "joplin-turndown-plugin-gfm"

import { sanitizedFragment } from "./sanitized-dom"

const discardedTags = [
  "head",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "script",
  "style",
  "template",
] as const

const blockTags = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "AUDIO",
  "BLOCKQUOTE",
  "BODY",
  "CANVAS",
  "CENTER",
  "DD",
  "DETAILS",
  "DIR",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "FRAMESET",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HGROUP",
  "HTML",
  "HR",
  "ISINDEX",
  "LI",
  "MAIN",
  "MENU",
  "NAV",
  "NOFRAMES",
  "NOSCRIPT",
  "OL",
  "OUTPUT",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
])

const htmlTagLikeText = /<\/?[A-Za-z][^<>]*>|<!--[\s\S]*?-->|<![A-Za-z][^<>]*>/g
const complexTableFeatures = new Set(["CAPTION", "COLGROUP", "TFOOT"])
const placeholderAttribute = "data-pulse-md-conversion-placeholder"

type InlineFormat = "bold" | "italic" | "strike"

interface ConversionContext {
  readonly literalPlaceholder: string
  readonly placeholderRoot: string
  readonly tables: Map<string, string>
}

function longestBacktickRun(source: string) {
  let longest = 0
  for (const match of source.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length)
  }
  return longest
}

function codeLanguage(node: HTMLElement) {
  const code = node.firstElementChild
  if (!code || code.nodeName !== "CODE") return ""
  for (const className of (code.getAttribute("class") ?? "").split(/\s+/)) {
    const language = /^language-([\w+-]+)$/i.exec(className)?.[1]
    if (language) return language
  }
  return ""
}

const inlineFormats: readonly InlineFormat[] = ["strike", "italic", "bold"]

const inlineDelimiters: Readonly<Record<InlineFormat, string>> = {
  bold: "**",
  italic: "*",
  strike: "~~",
}

function explicitInlineFormat(
  node: HTMLElement,
  format: InlineFormat
): boolean | null {
  const style = node.getAttribute("style") ?? ""
  if (format === "bold") {
    const value = /(?:^|;)\s*font-weight\s*:\s*([^;]+)/i.exec(style)?.[1]
    if (!value) return null
    if (/^(?:bold|bolder|[6-9]00)\b/i.test(value.trim())) return true
    if (/^(?:normal|lighter|[1-5]00)\b/i.test(value.trim())) return false
    return null
  }
  if (format === "italic") {
    const value = /(?:^|;)\s*font-style\s*:\s*([^;]+)/i.exec(style)?.[1]
    if (!value) return null
    if (/^(?:italic|oblique)\b/i.test(value.trim())) return true
    if (/^normal\b/i.test(value.trim())) return false
    return null
  }
  const value = /(?:^|;)\s*text-decoration(?:-line)?\s*:\s*([^;]+)/i.exec(
    style
  )?.[1]
  if (!value) return null
  if (/\bline-through\b/i.test(value)) return true
  if (/^(?:none|initial|unset)\b/i.test(value.trim())) return false
  return null
}

function semanticInlineFormat(node: HTMLElement, format: InlineFormat) {
  if (format === "bold") return ["B", "STRONG"].includes(node.nodeName)
  if (format === "italic") return ["EM", "I"].includes(node.nodeName)
  return ["DEL", "S", "STRIKE"].includes(node.nodeName)
}

function elementInlineFormat(node: HTMLElement, format: InlineFormat) {
  return (
    explicitInlineFormat(node, format) ?? semanticInlineFormat(node, format)
  )
}

function inheritedInlineFormat(node: HTMLElement, format: InlineFormat) {
  for (
    let ancestor = node.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const explicit = explicitInlineFormat(ancestor, format)
    if (explicit !== null) return explicit
    if (semanticInlineFormat(ancestor, format)) return true
  }
  return false
}

function introducesInlineFormat(node: HTMLElement, format: InlineFormat) {
  return (
    elementInlineFormat(node, format) && !inheritedInlineFormat(node, format)
  )
}

function resetsInheritedInlineFormat(node: HTMLElement, format: InlineFormat) {
  return (
    explicitInlineFormat(node, format) === false &&
    inheritedInlineFormat(node, format)
  )
}

function wrapInline(content: string, delimiter: string) {
  return content.trim() ? `${delimiter}${content}${delimiter}` : ""
}

function styledSpanMarkdown(content: string, node: HTMLElement) {
  let replacement = content
  for (const format of inlineFormats) {
    if (introducesInlineFormat(node, format)) {
      replacement = wrapInline(replacement, inlineDelimiters[format])
    }
  }
  return replacement
}

function semanticFormatAncestor(
  node: HTMLElement,
  format: InlineFormat,
  root: ParentNode
) {
  for (
    let ancestor = node.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor === root) return null
    const explicit = explicitInlineFormat(ancestor, format)
    if (explicit !== null) return explicit ? ancestor : null
    if (semanticInlineFormat(ancestor, format)) return ancestor
  }
  return null
}

function normalizeSemanticFormatsAcrossBlocks(root: ParentNode) {
  for (const node of Array.from(
    root.querySelectorAll<HTMLElement>("b, strong, em, i, del, s, strike")
  ).reverse()) {
    if (
      !Array.from(node.children).some((child) => blockTags.has(child.nodeName))
    ) {
      continue
    }
    const format = ["B", "STRONG"].includes(node.nodeName)
      ? "bold"
      : ["EM", "I"].includes(node.nodeName)
        ? "italic"
        : "strike"

    const wrapInlineRuns = (container: HTMLElement) => {
      if (explicitInlineFormat(container, format) === false) return
      for (const child of Array.from(container.children)) {
        const element = child as HTMLElement
        if (explicitInlineFormat(element, format) === false) continue
        if (blockTags.has(element.nodeName)) wrapInlineRuns(element)
      }
      const runs: Node[][] = []
      let run: Node[] = []
      const flush = () => {
        if (run.some((child) => child.textContent?.trim())) runs.push(run)
        run = []
      }
      for (const child of Array.from(container.childNodes)) {
        if (child.nodeType === 1 && blockTags.has(child.nodeName)) flush()
        else run.push(child)
      }
      flush()
      for (const children of runs) {
        const wrapper = node.cloneNode(false) as HTMLElement
        container.insertBefore(wrapper, children[0] ?? null)
        for (const child of children) wrapper.appendChild(child)
      }
    }

    wrapInlineRuns(node)
    node.replaceWith(...Array.from(node.childNodes))
  }
}

function splitAncestorAroundNode(ancestor: HTMLElement, node: HTMLElement) {
  let child: HTMLElement = node
  while (child.parentElement && child.parentElement !== ancestor) {
    const parent = child.parentElement
    const before = parent.cloneNode(false) as HTMLElement
    const middle = parent.cloneNode(false) as HTMLElement
    const after = parent.cloneNode(false) as HTMLElement
    while (parent.firstChild && parent.firstChild !== child) {
      before.appendChild(parent.firstChild)
    }
    while (child.nextSibling) after.appendChild(child.nextSibling)
    middle.appendChild(child)
    if (before.firstChild) parent.parentNode?.insertBefore(before, parent)
    parent.parentNode?.insertBefore(middle, parent)
    if (after.firstChild) parent.parentNode?.insertBefore(after, parent)
    parent.remove()
    child = middle
  }

  const before = ancestor.cloneNode(false) as HTMLElement
  const after = ancestor.cloneNode(false) as HTMLElement
  while (ancestor.firstChild && ancestor.firstChild !== child) {
    before.appendChild(ancestor.firstChild)
  }
  while (child.nextSibling) after.appendChild(child.nextSibling)
  const moveBoundaryBreak = (
    source: HTMLElement,
    destination: HTMLElement,
    edge: "firstChild" | "lastChild",
    beforeNode: Node | null
  ) => {
    const candidate = source[edge]
    if (candidate?.nodeName === "BR") {
      destination.insertBefore(candidate, beforeNode)
    }
  }
  moveBoundaryBreak(before, child, "lastChild", child.firstChild)
  moveBoundaryBreak(after, child, "firstChild", null)
  if (before.firstChild) ancestor.parentNode?.insertBefore(before, ancestor)
  ancestor.parentNode?.insertBefore(child, ancestor)
  if (after.firstChild) ancestor.parentNode?.insertBefore(after, ancestor)
  ancestor.remove()
}

function normalizeInlineFormatResets(root: ParentNode) {
  normalizeSemanticFormatsAcrossBlocks(root)
  const resetElements = Array.from(
    root.querySelectorAll<HTMLElement>("[style]")
  )
    .map((node) => ({
      formats: inlineFormats.filter((format) =>
        resetsInheritedInlineFormat(node, format)
      ),
      node,
    }))
    .filter(({ formats }) => formats.length > 0)

  for (const { formats, node } of resetElements) {
    for (const format of formats) {
      const ancestor = semanticFormatAncestor(node, format, root)
      if (ancestor) splitAncestorAroundNode(ancestor, node)
    }
  }
}

function literalTextRuns(root: ParentNode) {
  const runs: Text[][] = []
  let run: Text[] = []
  const flush = () => {
    if (run.length > 0) runs.push(run)
    run = []
  }

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      run.push(node as Text)
      return
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) {
      flush()
      return
    }
    const element = node.nodeType === 1 ? (node as HTMLElement) : null
    if (
      element?.matches(
        `code, pre, [${placeholderAttribute}], [${placeholderAttribute}] *`
      )
    ) {
      flush()
      return
    }
    const boundary = Boolean(
      element && (blockTags.has(element.nodeName) || element.nodeName === "BR")
    )
    if (boundary) flush()
    for (const child of Array.from(node.childNodes)) visit(child)
    if (boundary) flush()
  }
  visit(root as Node)
  flush()
  return runs
}

function placeholderNode(ownerDocument: Document, value: string) {
  const placeholder = ownerDocument.createElement("a")
  placeholder.setAttribute(placeholderAttribute, value)
  placeholder.setAttribute("href", "#")
  placeholder.textContent = "x"
  return placeholder
}

function normalizeLiteralTagText(root: ParentNode, context: ConversionContext) {
  for (const nodes of literalTextRuns(root)) {
    const offsets: Array<{ readonly node: Text; readonly offset: number }> = []
    const source = nodes.map((node) => node.data).join("")
    for (const match of source.matchAll(htmlTagLikeText)) {
      let offset = match.index
      for (const node of nodes) {
        if (offset < node.data.length) {
          offsets.push({ node, offset })
          break
        }
        offset -= node.data.length
      }
    }
    for (const { node, offset } of offsets.reverse()) {
      const suffix = node.splitText(offset)
      suffix.parentNode?.insertBefore(
        placeholderNode(node.ownerDocument, context.literalPlaceholder),
        suffix
      )
    }
  }
}

function normalizedColumnSpan(cell: HTMLTableCellElement) {
  const value = Number.parseInt(cell.getAttribute("colspan") ?? "1", 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

function tableRows(table: HTMLTableElement) {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).filter(
    (row) => {
      for (
        let ancestor = row.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        if (ancestor.nodeName === "TABLE") return ancestor === table
      }
      return false
    }
  )
}

function tableCells(table: HTMLTableElement) {
  return tableRows(table).flatMap((row) =>
    Array.from(row.children).filter(
      (cell): cell is HTMLTableCellElement =>
        cell.nodeName === "TD" || cell.nodeName === "TH"
    )
  )
}

function rowCells(row: HTMLTableRowElement) {
  return Array.from(row.children).filter(
    (cell): cell is HTMLTableCellElement =>
      cell.nodeName === "TD" || cell.nodeName === "TH"
  )
}

function tableColumnCount(table: HTMLTableElement) {
  let maximum = 0
  for (const row of tableRows(table)) {
    maximum = Math.max(
      maximum,
      rowCells(row).reduce(
        (total, cell) => total + normalizedColumnSpan(cell),
        0
      )
    )
  }
  return maximum
}

function complexTableReason(table: HTMLTableElement) {
  if (table.querySelector("table")) return true
  if (
    Array.from(table.children).some((node) =>
      complexTableFeatures.has(node.nodeName)
    )
  ) {
    return true
  }
  const cells = tableCells(table)
  if (
    cells.some(
      (cell) =>
        Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) > 1 ||
        normalizedColumnSpan(cell as HTMLTableCellElement) > 1
    )
  ) {
    return true
  }
  if (table.tHead && table.tHead.rows.length > 1) return true
  if (
    tableRows(table).filter((row) =>
      rowCells(row).every((cell) => cell.nodeName === "TH")
    ).length > 1
  ) {
    return true
  }

  const columns = tableColumnCount(table)
  return (
    columns === 0 ||
    tableRows(table).some(
      (row) =>
        rowCells(row).reduce(
          (total, cell) => total + normalizedColumnSpan(cell),
          0
        ) !== columns
    )
  )
}

function markdownCellText(content: string) {
  return content
    .trim()
    .replace(/\n+/g, "<br>")
    .replace(/(?:<br>){2,}/g, "<br>")
    .replaceAll("|", "\\|")
}

function placeholderAwareText(node: Element, marker: string) {
  const clone = node.cloneNode(true) as Element
  for (const placeholder of Array.from(
    clone.querySelectorAll<HTMLElement>(`[${placeholderAttribute}]`)
  )) {
    placeholder.replaceWith(marker)
  }
  return (clone.textContent ?? "").trim()
}

function nestedCellText(cell: HTMLTableCellElement, marker: string) {
  return placeholderAwareText(cell, marker)
}

function appendVisibleTextLines(
  container: HTMLElement,
  lines: readonly string[]
) {
  for (const value of lines) {
    const line = container.ownerDocument.createElement("div")
    line.textContent = value.trim()
    container.appendChild(line)
  }
}

function nestedTableLines(table: HTMLTableElement, marker: string) {
  const lines: string[] = []
  const caption = Array.from(table.children).find(
    (node) => node.nodeName === "CAPTION"
  )
  if (caption) {
    const text = placeholderAwareText(caption, marker)
    if (text) lines.push(text)
  }
  for (const row of tableRows(table)) {
    lines.push(
      rowCells(row)
        .map((cell) => nestedCellText(cell, marker))
        .join(" | ")
    )
  }
  return lines
}

function separateFlattenedBlocks(root: ParentNode, separator: string) {
  for (const block of Array.from(root.querySelectorAll<HTMLElement>("div"))) {
    const previous = block.previousSibling
    const next = block.nextSibling
    if (previous?.nodeType === 3 && previous.textContent?.trim()) {
      previous.textContent = `${previous.textContent}${separator}`
    }
    if (next?.nodeType === 3 && next.textContent?.trim()) {
      next.textContent = `${separator}${next.textContent}`
    }
  }
}

function cellMarkdown(cell: HTMLTableCellElement, converter: TurndownService) {
  const wrapper = cell.cloneNode(true) as HTMLTableCellElement
  const nestedLiteralMarker = unusedMarker(wrapper, "NESTEDLITERAL")
  const nestedLineMarker = unusedMarker(wrapper, "NESTEDLINE")
  while (true) {
    const nestedTable = Array.from(wrapper.querySelectorAll("table")).at(-1) as
      HTMLTableElement | undefined
    if (!nestedTable) break
    const replacement = wrapper.ownerDocument.createElement("div")
    appendVisibleTextLines(
      replacement,
      nestedTableLines(nestedTable, nestedLiteralMarker)
    )
    nestedTable.replaceWith(replacement)
    const firstNestedLine = replacement.firstElementChild
    const followingNestedLine = firstNestedLine?.nextElementSibling
    if (firstNestedLine && followingNestedLine) {
      followingNestedLine.before(nestedLineMarker)
    }
    separateFlattenedBlocks(wrapper, nestedLineMarker)
  }
  for (const details of Array.from(
    wrapper.querySelectorAll("details")
  ).reverse()) {
    const summary = Array.from(details.children).find(
      (node) => node.nodeName === "SUMMARY"
    )
    const lines: string[] = []
    if (summary) {
      const text = placeholderAwareText(summary, nestedLiteralMarker)
      if (text) lines.push(text)
      summary.remove()
    }
    const body = placeholderAwareText(details, nestedLiteralMarker)
    if (body) lines.push(body)
    const replacement = wrapper.ownerDocument.createTextNode(
      `${details.previousSibling?.textContent?.trim() ? nestedLineMarker : ""}${lines.join(nestedLineMarker)}`
    )
    details.replaceWith(replacement)
  }
  const tag = wrapper.ownerDocument.createElement("div")
  while (wrapper.firstChild) tag.appendChild(wrapper.firstChild)
  return markdownCellText(
    converter
      .turndown(tag)
      .replaceAll(nestedLiteralMarker, "\\")
      .replaceAll(nestedLineMarker, "<br>")
      .replace(/(?:<br>){2,}/g, "<br>")
  )
}

function complexTableMarkdown(
  table: HTMLTableElement,
  converter: TurndownService
) {
  const parts: string[] = []
  const caption = Array.from(table.children).find(
    (node) => node.nodeName === "CAPTION"
  )
  if (caption) {
    const converted = converter
      .turndown(caption.cloneNode(true) as HTMLElement)
      .trim()
    if (converted) parts.push(converted)
  }

  const columnCount = tableColumnCount(table)
  const activeRowSpans = new Map<number, number>()
  const rows = tableRows(table)
    .map((row) => {
      const values: string[] = []
      let column = 0
      const occupySpannedColumns = () => {
        while ((activeRowSpans.get(column) ?? 0) > 0) {
          values[column] = " "
          column += 1
        }
      }

      for (const cell of rowCells(row)) {
        occupySpannedColumns()
        const columnSpan = normalizedColumnSpan(cell)
        const rowSpan = Math.max(
          1,
          Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1
        )
        values[column] = cellMarkdown(cell, converter) || " "
        for (let offset = 0; offset < columnSpan; offset += 1) {
          if (offset > 0) values[column + offset] = " "
          if (rowSpan > 1) activeRowSpans.set(column + offset, rowSpan)
        }
        column += columnSpan
      }
      occupySpannedColumns()
      while (values.length < columnCount) values.push(" ")

      for (const [index, remaining] of activeRowSpans) {
        if (remaining <= 1) activeRowSpans.delete(index)
        else activeRowSpans.set(index, remaining - 1)
      }
      return values.join(" | ")
    })
    .filter(Boolean)
  if (rows.length > 0) parts.push(rows.join("\n"))

  return parts.length > 0 ? `\n\n${parts.join("\n\n")}\n\n` : ""
}

function domContains(root: ParentNode, candidate: string) {
  if ((root.textContent ?? "").includes(candidate)) return true
  return Array.from(root.querySelectorAll("*")).some((element) =>
    Array.from(element.attributes).some((attribute) =>
      attribute.value.includes(candidate)
    )
  )
}

function unusedMarker(root: ParentNode, label: string) {
  let marker = `PULSEMD${label}`
  while (domContains(root, marker)) marker += "X"
  return marker
}

function conversionContext(root: ParentNode): ConversionContext {
  const placeholderRoot = unusedMarker(root, "PLACEHOLDER")
  return {
    literalPlaceholder: `${placeholderRoot}LITERAL`,
    placeholderRoot,
    tables: new Map(),
  }
}

function prepareConversionSource(source: TurndownService.Node) {
  const root = source.cloneNode(true) as TurndownService.Node
  const context = conversionContext(root)
  normalizeInlineFormatResets(root)
  normalizeLiteralTagText(root, context)
  return { context, root }
}

function replaceComplexTables(root: ParentNode, context: ConversionContext) {
  const tables = Array.from(
    root.querySelectorAll<HTMLTableElement>("table")
  ).filter((table) => complexTableReason(table) && !table.closest("td, th"))
  for (const [index, table] of tables.entries()) {
    const placeholder = `${context.placeholderRoot}TABLE${index}`
    context.tables.set(
      placeholder,
      complexTableMarkdown(table, createConverter(context))
    )
    table.replaceWith(placeholderNode(table.ownerDocument, placeholder))
  }
}

function createConverter(context?: ConversionContext) {
  const converter = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    fence: "```",
    headingStyle: "atx",
    hr: "---",
    linkStyle: "inlined",
    strongDelimiter: "**",
  })
  converter.use([tables, taskListItems])
  converter.remove([...discardedTags])
  converter.addRule("pulseMdConversionPlaceholder", {
    filter: (node) => {
      const placeholder = node.getAttribute(placeholderAttribute)
      return Boolean(
        context &&
        node.nodeName === "A" &&
        (placeholder === context.literalPlaceholder ||
          (placeholder && context.tables.has(placeholder)))
      )
    },
    replacement: (_content, node) => {
      const placeholder = node.getAttribute(placeholderAttribute) ?? ""
      if (placeholder === context?.literalPlaceholder) return "\\"
      return context?.tables.get(placeholder) ?? ""
    },
  })
  converter.addRule("pulseMdComplexTable", {
    filter: (node) =>
      node.nodeName === "TABLE" && complexTableReason(node as HTMLTableElement),
    replacement: (_content, node) =>
      complexTableMarkdown(node as HTMLTableElement, converter),
  })
  converter.addRule("pulseMdDetails", {
    filter: "details",
    replacement: (content) =>
      content.trim() ? `\n\n${content.trim()}\n\n` : "",
  })
  converter.addRule("pulseMdSummary", {
    filter: "summary",
    replacement: (content) => {
      const summary = content.trim()
      if (!summary) return ""
      return `\n\n${summary.includes("**") ? summary : `**${summary}**`}\n\n`
    },
  })
  converter.addRule("pulseMdStrikethrough", {
    filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
    replacement: (content, node) =>
      introducesInlineFormat(node, "strike")
        ? wrapInline(content, "~~")
        : content,
  })
  converter.addRule("pulseMdStrong", {
    filter: ["b", "strong"],
    replacement: (content, node) =>
      introducesInlineFormat(node, "bold")
        ? wrapInline(content, "**")
        : content,
  })
  converter.addRule("pulseMdEmphasis", {
    filter: ["em", "i"],
    replacement: (content, node) =>
      introducesInlineFormat(node, "italic")
        ? wrapInline(content, "*")
        : content,
  })
  converter.addRule("pulseMdStyledSpan", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      /(?:font-(?:style|weight)|text-decoration(?:-line)?)\s*:/i.test(
        node.getAttribute("style") ?? ""
      ),
    replacement: styledSpanMarkdown,
  })
  converter.addRule("pulseMdFencedCode", {
    filter: "pre",
    replacement: (_content, node) => {
      const source = (node.textContent ?? "").replace(/\n$/, "")
      const fence = "`".repeat(Math.max(3, longestBacktickRun(source) + 1))
      return `\n\n${fence}${codeLanguage(node)}\n${source}\n${fence}\n\n`
    },
  })
  return converter
}

export function renderedDomToMarkdown(source: TurndownService.Node) {
  const { context, root } = prepareConversionSource(source)
  replaceComplexTables(root, context)
  return createConverter(context).turndown(root).trim()
}

export function renderedDomContainsBlock(source: ParentNode) {
  return Array.from(source.querySelectorAll("*")).some((node) =>
    blockTags.has(node.nodeName)
  )
}

const semanticClipboardSelector =
  "a[href], blockquote, code, details, h1, h2, h3, h4, h5, h6, hr, img, li, ol, pre, table, ul"

/** Source editors and terminals also publish HTML, purely to carry their theme. */
export function renderedDomNeedsConversion(source: ParentNode) {
  if (source.querySelector(semanticClipboardSelector)) return true
  const elements = Array.from(source.querySelectorAll<HTMLElement>("*"))
  const text = (source as Node).textContent?.trim()
  if (
    elements.some((node) => {
      if (node.nodeName !== "DIV") return false
      const style = node.getAttribute("style") ?? ""
      // Source editors wrap the complete selection in a font/whitespace
      // container. Bold and italic child spans are syntax highlighting there.
      return (
        /(?:^|;)\s*white-space\s*:\s*(?:pre(?:-wrap)?|break-spaces)\s*(?:;|$)/i.test(
          style
        ) &&
        /(?:^|;)\s*font-family\s*:/i.test(style) &&
        node.textContent?.trim() === text
      )
    })
  )
    return false
  return elements.some((node) =>
    inlineFormats.some((format) => introducesInlineFormat(node, format))
  )
}

export async function renderedHtmlToMarkdown(
  ownerDocument: Document,
  source: string,
  plainText = ""
) {
  const fragment = await sanitizedFragment(ownerDocument, source, {
    FORBID_TAGS: [...discardedTags],
  })
  // The plain representation already preserves source newlines, indentation,
  // and Markdown punctuation. Running presentation-only HTML through Turndown
  // collapses CSS-preserved whitespace and escapes the user's source text.
  if (plainText && !renderedDomNeedsConversion(fragment)) {
    return { block: false, markdown: plainText }
  }
  return {
    block: renderedDomContainsBlock(fragment),
    markdown: renderedDomToMarkdown(fragment),
  }
}
