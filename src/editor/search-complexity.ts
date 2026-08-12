import type { SearchQuery } from "@codemirror/search"
import type { EditorState, Text } from "@codemirror/state"

import {
  maximumContextPreservingRegexpDocumentLength,
  regexpMayCrossLines,
} from "./search-cursor"
import type { MarkdownSearchIssue } from "./types"

const maximumExplicitRegexpRepetition = 10_000
const maximumRegexpAlternations = 8
const maximumVariableRegexpQuantifiers = 32
export const maximumRepeatedRegexpPhysicalLineLength = 4 * 1024

const oversizedPhysicalLineCache = new WeakMap<Text, boolean>()

interface RegexpGroupComplexity {
  alternation: boolean
  variableRepetition: boolean
}

type RegexpAtom =
  | { kind: "ordinary"; signature: string }
  | ({
      kind: "group"
      signature: string
    } & RegexpGroupComplexity)

interface RegexpGroupContext extends RegexpGroupComplexity {
  lastAtom: RegexpAtom | null
  lookaround: boolean
}

function escapedRegexpLiteral(character: string) {
  return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
}

function regexpAtomsMayOverlap(
  left: RegexpAtom,
  right: RegexpAtom,
  caseSensitive: boolean
) {
  return (
    left.kind === "group" ||
    right.kind === "group" ||
    left.signature === right.signature ||
    left.signature === "unknown" ||
    right.signature === "unknown" ||
    (!caseSensitive &&
      left.signature.startsWith("literal:") &&
      right.signature.startsWith("literal:") &&
      // Delegate the exact Unicode simple-case-folding relation to the same
      // regexp engine that executes the search. String upper/lower casing
      // alone misses valid `iu` pairs such as sharp-s/uppercase-sharp-s.
      new RegExp(
        escapedRegexpLiteral(left.signature.slice("literal:".length)),
        "iu"
      ).test(right.signature.slice("literal:".length)))
  )
}

/**
 * Rejects JavaScript regexp shapes whose backtracking cost is not predictably
 * bounded by document length. This scan is deliberately linear and
 * conservative because a running regexp cannot be interrupted on the renderer
 * thread.
 */
interface RegexpContextCost {
  repeatedAtom: boolean
}

function regexpContextCost(
  source: string,
  caseSensitive: boolean
): RegexpContextCost | null {
  const groups: RegexpGroupContext[] = [
    {
      alternation: false,
      lastAtom: null,
      lookaround: false,
      variableRepetition: false,
    },
  ]
  let characterClass = false
  let alternationCount = 0
  let previousWasQuantifier = false
  let repeatedAtom = false
  let variableQuantifierCount = 0
  const repeatedVariableAtoms: RegexpAtom[] = []

  const beginAtom = (atom: RegexpAtom) => {
    const group = groups.at(-1)!
    group.lastAtom = atom
    previousWasQuantifier = false
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!

    if (character === "\\") {
      const escaped = source[index + 1]
      if (!characterClass && escaped) {
        if (
          /[1-9]/.test(escaped) ||
          (escaped === "k" && source[index + 2] === "<")
        ) {
          return null
        }
        beginAtom({
          kind: "ordinary",
          // Proving overlap among categories, Unicode properties, boundaries,
          // and escaped literals would make this safety gate its own regexp
          // engine. Treat an escaped variable atom as unknown instead.
          signature: "unknown",
        })
      }
      index += 1
      continue
    }

    if (characterClass) {
      if (character === "]") {
        characterClass = false
      }
      continue
    }
    if (character === "[") {
      characterClass = true
      beginAtom({
        kind: "ordinary",
        // Different classes may still overlap (`[ab]` and `[bc]`).
        signature: "unknown",
      })
      continue
    }

    if (character === "(") {
      beginAtom({
        kind: "ordinary",
        signature: "unknown",
      })
      const nestedGroup: RegexpGroupContext = {
        alternation: false,
        lastAtom: null,
        lookaround: false,
        variableRepetition: false,
      }
      groups.push(nestedGroup)
      if (source[index + 1] !== "?") continue
      const modifier = source[index + 2]
      if (modifier === ":" || modifier === "=" || modifier === "!") {
        nestedGroup.lookaround = modifier === "=" || modifier === "!"
        index += 2
      } else if (modifier === "<") {
        const lookbehind = source[index + 3]
        if (lookbehind === "=" || lookbehind === "!") {
          nestedGroup.lookaround = true
          index += 3
        } else {
          const prefixEnd = source.indexOf(">", index + 3)
          if (prefixEnd >= 0) index = prefixEnd
        }
      }
      continue
    }

    if (character === ")") {
      if (groups.length > 1) {
        const group = groups.pop()!
        // An unanchored lookaround is retried at every candidate position.
        // Letting it contain an unbounded scan turns an otherwise linear atom
        // such as `(?=a+$)` or `(?=.*z)` into quadratic work on one long line.
        // Determining whether surrounding anchors make every such shape safe
        // would require a full regexp parser, so reject all variable
        // repetition inside lookarounds.
        if (group.lookaround && group.variableRepetition) return null
        const parent = groups.at(-1)!
        parent.alternation ||= group.alternation
        parent.variableRepetition ||= group.variableRepetition
        const atom: RegexpAtom = {
          alternation: group.alternation,
          kind: "group",
          signature: "unknown",
          variableRepetition: group.variableRepetition,
        }
        parent.lastAtom = atom
      }
      previousWasQuantifier = false
      continue
    }

    if (character === "|") {
      if (++alternationCount > maximumRegexpAlternations) return null
      const group = groups.at(-1)!
      group.alternation = true
      group.lastAtom = null
      previousWasQuantifier = false
      continue
    }

    let repetition = character === "*" || character === "+" || character === "?"
    let minimum = character === "+" ? 1 : 0
    let maximum =
      character === "?" ? 1 : repetition ? Number.POSITIVE_INFINITY : 0
    if (character === "{") {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(index))
      if (match) {
        repetition = true
        minimum = Number(match[1])
        maximum =
          match[2] === undefined
            ? minimum
            : match[2] === ""
              ? Number.POSITIVE_INFINITY
              : Number(match[2])
        index += match[0].length - 1
      }
    }

    if (repetition) {
      // A lazy suffix (`+?`) does not add another repetition layer.
      if (character === "?" && previousWasQuantifier) {
        previousWasQuantifier = false
        continue
      }
      if (
        Number.isFinite(maximum) &&
        maximum > maximumExplicitRegexpRepetition
      ) {
        return null
      }
      const group = groups.at(-1)!
      const atom = group.lastAtom
      const variable = minimum !== maximum
      repeatedAtom ||= maximum > 1
      if (
        variable &&
        ++variableQuantifierCount > maximumVariableRegexpQuantifiers
      ) {
        return null
      }
      if (
        maximum > 1 &&
        atom?.kind === "group" &&
        (atom.variableRepetition || atom.alternation)
      ) {
        return null
      }
      if (
        variable &&
        atom &&
        // Optional atoms can compound just like unbounded repeats: a long
        // adjacent `a?a?...` chain has exponentially many ways to partition
        // the same input even though every individual maximum is one.
        repeatedVariableAtoms.some((previous) =>
          regexpAtomsMayOverlap(previous, atom, caseSensitive)
        )
      ) {
        return null
      }
      if (variable && atom) repeatedVariableAtoms.push(atom)
      group.variableRepetition ||= variable
      previousWasQuantifier = true
      continue
    }

    beginAtom({
      kind: "ordinary",
      signature: character === "." ? "unknown" : `literal:${character}`,
    })
  }

  return { repeatedAtom }
}

function hasOversizedPhysicalLine(doc: Text) {
  const cached = oversizedPhysicalLineCache.get(doc)
  if (cached != null) return cached

  let oversized = false
  const stride = maximumRepeatedRegexpPhysicalLineLength + 1
  // Every physical line longer than the limit spans at least `stride`
  // consecutive document positions, so it must contain a point on this
  // absolute lattice. This avoids walking millions of short lines in a
  // newline-dense document and never slices/materializes line content.
  for (let position = 0; position <= doc.length; position += stride) {
    if (doc.lineAt(position).length > maximumRepeatedRegexpPhysicalLineLength) {
      oversized = true
      break
    }
  }
  oversizedPhysicalLineCache.set(doc, oversized)
  return oversized
}

export function contextPreservingRegexpSearchIssue(
  state: EditorState,
  query: SearchQuery
): MarkdownSearchIssue | null {
  // Syntax validity owns the user-facing "Invalid" state. Do not reinterpret
  // malformed patterns whose partial token stream happens to resemble an
  // unsafe repetition as a complexity-limit failure.
  if (!query.regexp || !query.valid) return null
  const contextCost = regexpContextCost(query.search, query.caseSensitive)
  if (!contextCost) {
    return "multiline-regexp-complexity-limit"
  }
  if (contextCost.repeatedAtom && hasOversizedPhysicalLine(state.doc)) {
    // Even structurally predictable repetition can make V8 retry a long scan
    // at every candidate position (`a+z` and `a{10000}z`, for example). One
    // cursor.next() is synchronous, so the controller's cooperative scan
    // budget cannot interrupt that work.
    return "multiline-regexp-complexity-limit"
  }
  return regexpMayCrossLines(query.search) &&
    state.doc.length > maximumContextPreservingRegexpDocumentLength
    ? "multiline-regexp-document-limit"
    : null
}
