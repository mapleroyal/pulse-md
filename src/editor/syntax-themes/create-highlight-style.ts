import { HighlightStyle, type TagStyle } from "@codemirror/language"
import { tags } from "@lezer/highlight"

export interface SyntaxPalette {
  readonly atom: string
  readonly comment: string
  readonly constant: string
  readonly definition?: string
  readonly function: string
  readonly heading: string
  readonly invalid: string
  readonly keyword: string
  readonly link: string
  readonly name: string
  readonly number: string
  readonly operator: string
  readonly property: string
  readonly punctuation?: string
  readonly regexp: string
  readonly specialVariable?: string
  readonly string: string
  readonly tag: string
  readonly type: string
  readonly commentFontStyle?: "italic"
}

/**
 * Build only a Lezer token highlighter. Surfaces, prose text, gutters,
 * selections, and other editor chrome intentionally remain app-owned.
 */
export function createHighlightStyle(
  palette: SyntaxPalette,
  transformColor: (color: string) => string = (color) => color
): HighlightStyle {
  const color = (value: string) => transformColor(value)
  const definition = color(palette.definition ?? palette.name)
  const specialVariable = color(palette.specialVariable ?? palette.atom)
  const specs: TagStyle[] = [
    { tag: tags.keyword, color: color(palette.keyword) },
    {
      tag: [tags.name, tags.deleted, tags.character, tags.macroName],
      color: color(palette.name),
    },
    { tag: tags.propertyName, color: color(palette.property) },
    {
      tag: [
        tags.processingInstruction,
        tags.string,
        tags.inserted,
        tags.special(tags.string),
      ],
      color: color(palette.string),
    },
    {
      tag: [tags.function(tags.variableName), tags.labelName],
      color: color(palette.function),
    },
    {
      tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
      color: color(palette.constant),
    },
    {
      tag: [tags.definition(tags.name), tags.separator],
      color: definition,
    },
    { tag: tags.className, color: color(palette.type) },
    {
      tag: [
        tags.number,
        tags.changed,
        tags.annotation,
        tags.modifier,
        tags.self,
        tags.namespace,
      ],
      color: color(palette.number),
    },
    { tag: tags.typeName, color: color(palette.type) },
    {
      tag: [tags.operator, tags.operatorKeyword],
      color: color(palette.operator),
    },
    {
      tag: [tags.url, tags.escape, tags.regexp],
      color: color(palette.regexp),
    },
    {
      tag: [tags.meta, tags.comment, tags.quote],
      color: color(palette.comment),
      ...(palette.commentFontStyle
        ? { fontStyle: palette.commentFontStyle }
        : {}),
    },
    { tag: tags.tagName, color: color(palette.tag) },
    {
      tag: tags.heading,
      color: color(palette.heading),
      fontWeight: "normal",
    },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    {
      tag: tags.link,
      color: color(palette.link),
      textDecoration: "underline",
    },
    { tag: [tags.atom, tags.bool], color: color(palette.atom) },
    { tag: tags.special(tags.variableName), color: specialVariable },
    { tag: tags.invalid, color: color(palette.invalid) },
  ]

  if (palette.punctuation) {
    specs.push({ tag: tags.punctuation, color: color(palette.punctuation) })
  }

  return HighlightStyle.define(specs)
}
