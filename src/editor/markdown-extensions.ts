import { commonmarkLanguage } from "@codemirror/lang-markdown"
import { ParseContext } from "@codemirror/language"
import {
  parseMixed,
  type Parser,
  type SyntaxNode,
  type Tree,
} from "@lezer/common"
import { tags as t } from "@lezer/highlight"
import {
  GFM,
  Subscript,
  Superscript,
  type BlockContext,
  type InlineContext,
  type LeafBlock,
  type LeafBlockParser,
  type Line,
  type MarkdownConfig,
  type MarkdownExtension,
} from "@lezer/markdown"

import { createRetryableDynamicImport } from "../lib/retryable-dynamic-import"

import { mathMarkdownExtension } from "./math"
import { fancyOrderedListMarkdownExtension } from "./list-markers"

/**
 * Stable node names shared by the parser and the live-preview analysis layer.
 *
 * Superscript and subscript keep the names defined by @lezer/pulse-md:
 * `Superscript`, `SuperscriptMark`, `Subscript`, and `SubscriptMark`.
 */
export const optionalMarkdownNodeNames = {
  definitionDescription: "DefinitionDescription",
  definitionList: "DefinitionList",
  definitionMark: "DefinitionMark",
  definitionTerm: "DefinitionTerm",
  emojiMark: "EmojiMark",
  emojiShortcode: "EmojiShortcode",
  emojiToken: "EmojiToken",
  footnoteDefinition: "FootnoteDefinition",
  footnoteLabel: "FootnoteLabel",
  footnoteMark: "FootnoteMark",
  footnoteReference: "FootnoteReference",
  yamlFrontMatter: "YAMLFrontMatter",
  yamlFrontMatterContent: "YAMLFrontMatterContent",
  yamlFrontMatterMark: "YAMLFrontMatterMark",
} as const

export interface MarkdownParserExtensionOptions {
  readonly definitionLists: boolean
  readonly emojiRecognition: boolean
  readonly footnotes: boolean
  readonly latex: boolean
  readonly superscriptAndSubscript: boolean
  readonly yamlFrontMatter: boolean
}

export const defaultMarkdownParserExtensionOptions: Readonly<MarkdownParserExtensionOptions> =
  Object.freeze({
    definitionLists: false,
    emojiRecognition: false,
    footnotes: false,
    latex: false,
    superscriptAndSubscript: false,
    yamlFrontMatter: false,
  })

/** Strict CommonMark is the base. GFM is added explicitly by the composer below. */
export const markdownBaseLanguage = commonmarkLanguage

function resolvedOptions(
  options: Readonly<Partial<MarkdownParserExtensionOptions>>
): MarkdownParserExtensionOptions {
  return { ...defaultMarkdownParserExtensionOptions, ...options }
}

/**
 * Compose the Markdown parser extensions used by the editor.
 *
 * GFM and authored alphabetic/Roman ordered lists are the application's
 * baseline. Every extension represented by a setting is omitted unless its
 * option is explicitly enabled.
 */
export function createMarkdownParserExtensions(
  options: Readonly<Partial<MarkdownParserExtensionOptions>> = {}
): MarkdownExtension {
  const enabled = resolvedOptions(options)
  const extensions: MarkdownExtension[] = [
    GFM,
    fancyOrderedListMarkdownExtension,
  ]

  if (enabled.latex) extensions.push(mathMarkdownExtension)
  if (enabled.superscriptAndSubscript) {
    extensions.push(Subscript, Superscript)
  }
  if (enabled.emojiRecognition) extensions.push(emojiMarkdownExtension)
  if (enabled.footnotes) extensions.push(footnoteMarkdownExtension)
  if (enabled.definitionLists) extensions.push(definitionListMarkdownExtension)
  if (enabled.yamlFrontMatter) {
    extensions.push(
      yamlFrontMatterMarkdownExtension,
      yamlFrontMatterHighlightingExtension()
    )
  }

  return extensions
}

function emojiAliasCharacter(character: number) {
  return (
    (character >= 48 && character <= 57) ||
    (character >= 65 && character <= 90) ||
    (character >= 97 && character <= 122) ||
    character === 43 ||
    character === 45 ||
    character === 95
  )
}

function emojiAliasClose(context: InlineContext, position: number) {
  let cursor = position + 1
  while (cursor < context.end && emojiAliasCharacter(context.char(cursor))) {
    cursor += 1
  }
  return cursor > position + 1 && context.char(cursor) === 58 ? cursor : -1
}

/**
 * Recognizes GitHub-style emoji tokens without validating or expanding them.
 * Validation deliberately belongs to the optional expansion layer, whose alias
 * database can remain out of the parser and the launch-critical bundle.
 */
export const emojiMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    { name: optionalMarkdownNodeNames.emojiToken, style: t.character },
    {
      name: optionalMarkdownNodeNames.emojiMark,
      style: t.processingInstruction,
    },
    { name: optionalMarkdownNodeNames.emojiShortcode, style: t.character },
  ],
  parseInline: [
    {
      name: "EmojiToken",
      after: "Escape",
      parse(context, next, position) {
        if (next !== 58) return -1
        const closeFrom = emojiAliasClose(context, position)
        if (closeFrom < 0) return -1
        const to = closeFrom + 1
        return context.addElement(
          context.elt(optionalMarkdownNodeNames.emojiToken, position, to, [
            context.elt(
              optionalMarkdownNodeNames.emojiMark,
              position,
              position + 1
            ),
            context.elt(
              optionalMarkdownNodeNames.emojiShortcode,
              position + 1,
              closeFrom
            ),
            context.elt(optionalMarkdownNodeNames.emojiMark, closeFrom, to),
          ])
        )
      },
    },
  ],
}

function labelEnd(text: string, from: number) {
  for (let position = from; position < text.length; position += 1) {
    const character = text.charCodeAt(position)
    if (character === 93) return position
    if (
      character === 10 ||
      character === 13 ||
      character === 32 ||
      character === 9 ||
      character === 91 ||
      character === 94
    ) {
      return -1
    }
  }
  return -1
}

interface FootnoteDefinitionStart {
  readonly closeBracket: number
  readonly contentFrom: number
  readonly labelFrom: number
  readonly labelTo: number
  readonly markerTo: number
}

function footnoteDefinitionStart(line: Line): FootnoteDefinitionStart | null {
  if (line.indent >= line.baseIndent + 4) return null
  const from = line.pos
  if (
    line.text.charCodeAt(from) !== 91 ||
    line.text.charCodeAt(from + 1) !== 94
  ) {
    return null
  }

  const closeBracket = labelEnd(line.text, from + 2)
  if (
    closeBracket <= from + 2 ||
    line.text.charCodeAt(closeBracket + 1) !== 58
  ) {
    return null
  }

  const markerTo = closeBracket + 2
  const afterMarker = line.text.charCodeAt(markerTo)
  if (markerTo < line.text.length && afterMarker !== 32 && afterMarker !== 9) {
    return null
  }

  return {
    closeBracket,
    contentFrom: line.skipSpace(markerTo),
    labelFrom: from + 2,
    labelTo: closeBracket,
    markerTo,
  }
}

const FOOTNOTE_CONTINUATION_INDENT = 4

/** Pandoc/GitHub-compatible `[^id]` references and `[^id]:` definitions. */
export const footnoteMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    {
      name: optionalMarkdownNodeNames.footnoteDefinition,
      block: true,
      composite(_context, line, continuationIndent) {
        if (line.pos === line.text.length) return true
        if (line.indent < line.baseIndent + continuationIndent) return false
        line.moveBaseColumn(line.baseIndent + continuationIndent)
        return true
      },
    },
    { name: optionalMarkdownNodeNames.footnoteReference, style: t.meta },
    { name: optionalMarkdownNodeNames.footnoteLabel, style: t.labelName },
    {
      name: optionalMarkdownNodeNames.footnoteMark,
      style: t.processingInstruction,
    },
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      before: "Link",
      parse(context, next, position) {
        if (next !== 91 || context.char(position + 1) !== 94) return -1
        const closeBracket = labelEnd(
          context.text,
          position + 2 - context.offset
        )
        if (closeBracket <= position + 2 - context.offset) return -1

        const absoluteClose = context.offset + closeBracket
        const to = absoluteClose + 1
        return context.addElement(
          context.elt(
            optionalMarkdownNodeNames.footnoteReference,
            position,
            to,
            [
              context.elt(
                optionalMarkdownNodeNames.footnoteMark,
                position,
                position + 2
              ),
              context.elt(
                optionalMarkdownNodeNames.footnoteLabel,
                position + 2,
                absoluteClose
              ),
              context.elt(
                optionalMarkdownNodeNames.footnoteMark,
                absoluteClose,
                to
              ),
            ]
          )
        )
      },
    },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      before: "LinkReference",
      endLeaf(_context, line) {
        return footnoteDefinitionStart(line) != null
      },
      parse(context, line) {
        const start = footnoteDefinitionStart(line)
        if (!start) return false

        const from = context.lineStart + line.pos
        context.startComposite(
          optionalMarkdownNodeNames.footnoteDefinition,
          line.pos,
          FOOTNOTE_CONTINUATION_INDENT
        )
        context.addElement(
          context.elt(
            optionalMarkdownNodeNames.footnoteMark,
            from,
            context.lineStart + start.labelFrom
          )
        )
        context.addElement(
          context.elt(
            optionalMarkdownNodeNames.footnoteLabel,
            context.lineStart + start.labelFrom,
            context.lineStart + start.labelTo
          )
        )
        context.addElement(
          context.elt(
            optionalMarkdownNodeNames.footnoteMark,
            context.lineStart + start.closeBracket,
            context.lineStart + start.markerTo
          )
        )
        line.moveBase(start.contentFrom)
        return null
      },
    },
  ],
}

interface DefinitionStart {
  readonly contentFrom: number
  readonly continuationIndent: number
  readonly markerFrom: number
}

function definitionStart(line: Line): DefinitionStart | null {
  const markerIndent = line.indent - line.baseIndent
  const marker = line.text.charCodeAt(line.pos)
  if (
    markerIndent < 0 ||
    markerIndent > 3 ||
    (marker !== 58 && marker !== 126)
  ) {
    return null
  }

  const afterMarker = line.text.charCodeAt(line.pos + 1)
  if (afterMarker !== 32 && afterMarker !== 9) return null
  const contentFrom = line.skipSpace(line.pos + 1)
  const contentIndent = line.countIndent(
    contentFrom,
    line.basePos,
    line.baseIndent
  )
  return {
    contentFrom,
    continuationIndent: contentIndent - line.baseIndent,
    markerFrom: line.pos,
  }
}

class DefinitionTermParser implements LeafBlockParser {
  confirmed = false

  nextLine() {
    return false
  }

  finish(context: BlockContext, leaf: LeafBlock) {
    if (!this.confirmed || leaf.content.includes("\n")) return false

    context.addLeafElement(
      leaf,
      context.elt(
        optionalMarkdownNodeNames.definitionTerm,
        leaf.start,
        leaf.start + leaf.content.length,
        context.parser.parseInline(leaf.content, leaf.start)
      )
    )
    return true
  }
}

/** Portable colon- and tilde-marked definition lists. */
export const definitionListMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    {
      name: optionalMarkdownNodeNames.definitionList,
      block: true,
      composite(_context, line, continuationIndent) {
        if (line.pos === line.text.length) return true
        return (
          definitionStart(line) != null ||
          line.indent >= line.baseIndent + continuationIndent
        )
      },
    },
    {
      name: optionalMarkdownNodeNames.definitionDescription,
      block: true,
      composite(_context, line, continuationIndent) {
        if (line.pos === line.text.length) return true
        if (definitionStart(line)) return false
        if (line.indent < line.baseIndent + continuationIndent) return false
        line.moveBaseColumn(line.baseIndent + continuationIndent)
        return true
      },
    },
    { name: optionalMarkdownNodeNames.definitionTerm, block: true },
    {
      name: optionalMarkdownNodeNames.definitionMark,
      style: t.processingInstruction,
    },
  ],
  parseBlock: [
    {
      name: "DefinitionList",
      before: "SetextHeading",
      leaf(_context, leaf) {
        if (
          _context.parentType().name ===
          optionalMarkdownNodeNames.definitionDescription
        ) {
          return null
        }
        return leaf.content.includes("\n") ? null : new DefinitionTermParser()
      },
      endLeaf(_context, line, leaf) {
        if (!definitionStart(line)) return false
        if (
          _context.parentType().name ===
          optionalMarkdownNodeNames.definitionDescription
        ) {
          return true
        }
        const parser = leaf.parsers.find(
          (candidate): candidate is DefinitionTermParser =>
            candidate instanceof DefinitionTermParser
        )
        if (!parser || leaf.content.includes("\n")) {
          return false
        }
        parser.confirmed = true
        return true
      },
      parse(context, line) {
        const start = definitionStart(line)
        if (!start) return false

        if (
          context.parentType().name !== optionalMarkdownNodeNames.definitionList
        ) {
          context.startComposite(
            optionalMarkdownNodeNames.definitionList,
            line.pos,
            start.continuationIndent
          )
        }
        context.startComposite(
          optionalMarkdownNodeNames.definitionDescription,
          line.pos,
          start.continuationIndent
        )
        context.addElement(
          context.elt(
            optionalMarkdownNodeNames.definitionMark,
            context.lineStart + start.markerFrom,
            context.lineStart + start.markerFrom + 1
          )
        )
        line.moveBase(start.contentFrom)
        return null
      },
    },
  ],
}

function frontMatterDelimiter(line: Line, opening: boolean) {
  if (line.pos !== 0 || line.indent !== 0) return null
  const text = line.text.replace(/[ \t]+$/, "")
  if (opening && text === "\uFEFF---") return { from: 0, to: 4 }
  if (text === "---" || (!opening && text === "...")) {
    return { from: 0, to: 3 }
  }
  return null
}

/** Start-of-document Jekyll-style YAML front matter. */
export const yamlFrontMatterMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    { name: optionalMarkdownNodeNames.yamlFrontMatter, block: true },
    { name: optionalMarkdownNodeNames.yamlFrontMatterContent, style: t.meta },
    {
      name: optionalMarkdownNodeNames.yamlFrontMatterMark,
      style: t.processingInstruction,
    },
  ],
  parseBlock: [
    {
      name: "YAMLFrontMatter",
      before: "HorizontalRule",
      parse(context, line) {
        if (context.lineStart !== 0) return false
        const opening = frontMatterDelimiter(line, true)
        if (!opening) return false

        const from = context.lineStart + opening.from
        const children = [
          context.elt(
            optionalMarkdownNodeNames.yamlFrontMatterMark,
            from,
            context.lineStart + opening.to
          ),
        ]
        let contentFrom = -1
        let contentTo = -1
        let to = context.lineStart + line.text.length

        while (context.nextLine()) {
          const closing = frontMatterDelimiter(line, false)
          if (closing) {
            const closingFrom = context.lineStart + closing.from
            if (contentFrom >= 0) contentTo = closingFrom - 1
            children.push(
              ...(contentFrom >= 0 && contentTo >= contentFrom
                ? [
                    context.elt(
                      optionalMarkdownNodeNames.yamlFrontMatterContent,
                      contentFrom,
                      contentTo
                    ),
                  ]
                : []),
              context.elt(
                optionalMarkdownNodeNames.yamlFrontMatterMark,
                closingFrom,
                context.lineStart + closing.to
              )
            )
            to = context.lineStart + closing.to
            context.nextLine()
            context.addElement(
              context.elt(
                optionalMarkdownNodeNames.yamlFrontMatter,
                from,
                to,
                children
              )
            )
            return true
          }

          if (contentFrom < 0) contentFrom = context.lineStart
          contentTo = context.lineStart + line.text.length
          to = contentTo
        }

        if (contentFrom >= 0 && contentTo >= contentFrom) {
          children.push(
            context.elt(
              optionalMarkdownNodeNames.yamlFrontMatterContent,
              contentFrom,
              contentTo
            )
          )
        }
        context.addElement(
          context.elt(
            optionalMarkdownNodeNames.yamlFrontMatter,
            from,
            to,
            children
          )
        )
        return true
      },
    },
  ],
}

export function createYamlParserLoader(
  loadModule: () => Promise<{ yamlLanguage: { parser: Parser } }>
) {
  const loadYamlModule = createRetryableDynamicImport(loadModule)
  let loadedParser: Parser | null = null

  return {
    load: () =>
      loadYamlModule().then((module) => {
        loadedParser ??= module.yamlLanguage.parser
        return loadedParser
      }),
    peek: () => loadedParser,
  }
}

const yamlParserLoader = createYamlParserLoader(
  () => import("@codemirror/lang-yaml")
)

function yamlParser() {
  return (
    yamlParserLoader.peek() ??
    ParseContext.getSkippingParser(yamlParserLoader.load())
  )
}

/**
 * Lazily mount the YAML parser only over front-matter content. The first parse
 * uses CodeMirror's skipping parser and schedules a reparse when the optional
 * language chunk is ready; subsequent parses use the loaded YAML parser.
 */
export function yamlFrontMatterHighlightingExtension(): MarkdownConfig {
  return {
    wrap: parseMixed((node) =>
      node.name === optionalMarkdownNodeNames.yamlFrontMatterContent
        ? { parser: yamlParser() }
        : null
    ),
  }
}

function childNamed(node: SyntaxNode, name: string) {
  return node.getChild(name)
}

/** Read the alias (without colons) from an EmojiToken node. */
export function emojiShortcode(source: string, node: SyntaxNode) {
  if (node.name !== optionalMarkdownNodeNames.emojiToken) return null
  const shortcode = childNamed(node, optionalMarkdownNodeNames.emojiShortcode)
  return shortcode ? source.slice(shortcode.from, shortcode.to) : null
}

/** Read the normalized identifier from a footnote definition or reference. */
export function footnoteIdentifier(source: string, node: SyntaxNode) {
  if (
    node.name !== optionalMarkdownNodeNames.footnoteDefinition &&
    node.name !== optionalMarkdownNodeNames.footnoteReference
  ) {
    return null
  }
  const label = childNamed(node, optionalMarkdownNodeNames.footnoteLabel)
  return label ? source.slice(label.from, label.to).toLowerCase() : null
}

export interface DefinitionListSyntax {
  readonly descriptions: readonly SyntaxNode[]
  readonly from: number
  readonly list: SyntaxNode
  readonly term: SyntaxNode
  readonly to: number
}

export type MarkdownSourceReader = (from: number, to: number) => string

function optionalBlankDefinitionTerm(
  term: SyntaxNode,
  list: SyntaxNode,
  readSource: MarkdownSourceReader | undefined
) {
  if (term.name !== "Paragraph" || !readSource) return false
  if (readSource(term.from, term.to).includes("\n")) return false
  const gapLines = readSource(term.to, list.from).split("\n")
  return (
    gapLines.length === 3 &&
    gapLines[0] === "" &&
    gapLines.slice(1).every((line) => /^[ \t]*(?:>[ \t]*)*$/.test(line))
  )
}

/** Resolve one raw DefinitionList wrapper only when it has a valid term. */
export function definitionListSyntaxForList(
  list: SyntaxNode,
  readSource?: MarkdownSourceReader
): DefinitionListSyntax | null {
  if (list.name !== optionalMarkdownNodeNames.definitionList) return null

  let term = list.prevSibling
  while (term && /Mark$/.test(term.name)) term = term.prevSibling
  if (
    !term ||
    (term.name !== optionalMarkdownNodeNames.definitionTerm &&
      !optionalBlankDefinitionTerm(term, list, readSource))
  ) {
    return null
  }

  const descriptions: SyntaxNode[] = []
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name === optionalMarkdownNodeNames.definitionDescription) {
      descriptions.push(child)
    }
  }
  return {
    descriptions,
    from: term.from,
    list,
    term,
    to: list.to,
  }
}

/**
 * Pair each DefinitionTerm with the following DefinitionList wrapper. A
 * single-line Paragraph separated by exactly one optional blank line is also
 * accepted when a source reader is provided. Keeping the term as a preceding
 * sibling lets Lezer preserve normal nested block parsing inside definitions.
 */
export function definitionListSyntax(
  tree: Tree | SyntaxNode,
  readSource?: MarkdownSourceReader
): readonly DefinitionListSyntax[] {
  const result: DefinitionListSyntax[] = []

  const visit = (parent: SyntaxNode) => {
    const children: SyntaxNode[] = []
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      children.push(child)
    }
    for (let index = 0; index < children.length; index += 1) {
      const term = children[index]!
      let listIndex = index + 1
      while (
        listIndex < children.length &&
        /Mark$/.test(children[listIndex]!.name)
      ) {
        listIndex += 1
      }
      const list = children[listIndex]
      const syntax = list ? definitionListSyntaxForList(list, readSource) : null
      if (syntax && syntax.term.from === term.from) result.push(syntax)
      visit(term)
    }
  }

  visit("topNode" in tree ? tree.topNode : tree)
  return result
}
