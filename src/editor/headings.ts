import { markdownLanguage } from "@codemirror/lang-markdown"
import { language } from "@codemirror/language"
import type { EditorState, Text } from "@codemirror/state"
import type { Parser, SyntaxNode, Tree } from "@lezer/common"

import { completeMarkdownSyntaxTree } from "./complete-markdown-tree"
import { resolveMarkdownLinkNode } from "./link-semantics"

export type MarkdownOutlineHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface MarkdownHeading {
  from: number
  to: number
  level: MarkdownOutlineHeadingLevel
  plainText: string
  slug: string
}

interface Replacement {
  from: number
  to: number
  value: string
}

const headingNodeName = /^(?:ATXHeading|SetextHeading)([1-6])$/
const hiddenHeadingNodeNames = new Set([
  "CodeMark",
  "EmphasisMark",
  "HeaderMark",
  "HTMLTag",
  "LinkMark",
  "StrikethroughMark",
])
const commonEntities: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
}

interface CachedHeadings {
  readonly headings: readonly MarkdownHeading[]
  readonly parser: Parser
}

const headingCache = new WeakMap<Text, CachedHeadings>()

function decodeEntity(source: string) {
  const body = source.slice(1, source.endsWith(";") ? -1 : undefined)
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const codePoint = Number.parseInt(body.slice(2), 16)
    if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      return String.fromCodePoint(codePoint)
    }
  } else if (body.startsWith("#")) {
    const codePoint = Number.parseInt(body.slice(1), 10)
    if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      return String.fromCodePoint(codePoint)
    }
  } else if (commonEntities[body]) {
    return commonEntities[body]
  }

  // The renderer has a complete HTML entity decoder. Keeping the small
  // fallback above makes this helper deterministic in node-based tests.
  const ownerDocument = globalThis.document
  if (ownerDocument) {
    const element = ownerDocument.createElement("textarea")
    element.innerHTML = source
    return element.value
  }
  return source
}

function collectHeadingReplacements(
  state: EditorState,
  node: SyntaxNode,
  replacements: Replacement[]
) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (
      (child.name === "Link" || child.name === "Image") &&
      !resolveMarkdownLinkNode(state, child)
    ) {
      // Unresolved reference syntax renders literally, including its brackets.
      continue
    }
    if (hiddenHeadingNodeNames.has(child.name)) {
      replacements.push({ from: child.from, to: child.to, value: "" })
      continue
    }

    if (child.name === "Escape") {
      replacements.push({
        from: child.from,
        to: child.to,
        value: state.sliceDoc(Math.min(child.from + 1, child.to), child.to),
      })
      continue
    }

    if (child.name === "Entity") {
      replacements.push({
        from: child.from,
        to: child.to,
        value: decodeEntity(state.sliceDoc(child.from, child.to)),
      })
      continue
    }

    if (
      (node.name === "Link" || node.name === "Image") &&
      (child.name === "LinkLabel" ||
        child.name === "LinkTitle" ||
        child.name === "URL")
    ) {
      replacements.push({ from: child.from, to: child.to, value: "" })
      continue
    }

    collectHeadingReplacements(state, child, replacements)
  }
}

function visibleHeadingText(state: EditorState, node: SyntaxNode) {
  const replacements: Replacement[] = []
  collectHeadingReplacements(state, node, replacements)
  replacements.sort((left, right) => left.from - right.from)

  let cursor = node.from
  let result = ""
  for (const replacement of replacements) {
    if (replacement.from < cursor) continue
    result += state.sliceDoc(cursor, replacement.from)
    result += replacement.value
    cursor = replacement.to
  }
  result += state.sliceDoc(cursor, node.to)
  return result.replace(/\s+/g, " ").trim()
}

/** GitHub-compatible base slug before duplicate disambiguation. */
export function githubHeadingSlug(text: string) {
  let slug = ""
  for (const character of text.trim().toLowerCase()) {
    if (/\s/u.test(character)) {
      slug += "-"
      continue
    }
    if (character === "-" || character === "_") {
      slug += character
      continue
    }
    if (
      /[\p{Cc}\p{Cf}\p{P}\p{Zl}\p{Zp}]/u.test(character) ||
      /[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/u.test(character)
    ) {
      continue
    }
    slug += character
  }
  return slug
}

function headingsFromTree(state: EditorState, tree: Tree) {
  const headings: MarkdownHeading[] = []
  const usedSlugs = new Set<string>()
  const nextSuffix = new Map<string, number>()

  tree.iterate({
    enter(node) {
      const match = headingNodeName.exec(node.name)
      if (!match) return
      const plainText = visibleHeadingText(state, node.node)
      const baseSlug = githubHeadingSlug(plainText)
      let slug = baseSlug
      let suffix = nextSuffix.get(baseSlug) ?? 1
      while (usedSlugs.has(slug)) slug = `${baseSlug}-${suffix++}`
      nextSuffix.set(baseSlug, suffix)
      usedSlugs.add(slug)
      headings.push({
        from: node.from,
        to: node.to,
        level: Number(match[1]) as MarkdownOutlineHeadingLevel,
        plainText,
        slug,
      })
    },
  })
  return headings
}

/**
 * Builds the full-document outline only on demand and caches it by CodeMirror's
 * immutable document value and active parser. Normal editing therefore does no
 * outline work, while parser-only reconfiguration cannot reuse a stale index.
 */
export function markdownHeadings(state: EditorState) {
  const parser = state.facet(language)?.parser ?? markdownLanguage.parser
  const cached = headingCache.get(state.doc)
  if (cached?.parser === parser) return cached.headings
  const tree = completeMarkdownSyntaxTree(state)
  const headings = headingsFromTree(state, tree)
  headingCache.set(state.doc, { headings, parser })
  return headings as readonly MarkdownHeading[]
}

export function decodedFragment(destination: string) {
  if (!destination.startsWith("#")) return null
  try {
    return decodeURIComponent(destination.slice(1))
  } catch {
    return destination.slice(1)
  }
}

export function headingForFragment(
  headings: readonly MarkdownHeading[],
  destination: string
) {
  const fragment = decodedFragment(destination)
  if (fragment === null || fragment.length === 0) return null
  return headings.find((heading) => heading.slug === fragment) ?? null
}
