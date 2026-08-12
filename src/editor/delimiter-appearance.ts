import { syntaxTree } from "@codemirror/language"
import { type Range } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

const strikethroughDelimiter = Decoration.mark({
  class: "cm-md-strikethrough-delimiter",
})

function delimiterDecorations(view: EditorView) {
  const ranges: Range<Decoration>[] = []
  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (node.name === "StrikethroughMark") {
          ranges.push(strikethroughDelimiter.range(node.from, node.to))
        }
      },
    })
  }
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none
}

class DelimiterAppearancePlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = delimiterDecorations(view)
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.decorations = delimiterDecorations(update.view)
    }
  }
}

export const delimiterAppearanceExtension = ViewPlugin.fromClass(
  DelimiterAppearancePlugin,
  { decorations: (plugin) => plugin.decorations }
)
