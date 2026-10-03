import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view"

// Chrome must leave the native horizontal scrollbar in its fixed bottom lane.
// Reuse CodeMirror's measured geometry cycle instead of watching every DOM edit.
export const scrollbarGeometry = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.measure(view)
    }

    update(update: ViewUpdate) {
      if (update.geometryChanged) this.measure(update.view)
    }

    private measure(view: EditorView) {
      view.requestMeasure({
        key: this,
        read: (editor) =>
          editor.scrollDOM.offsetHeight > editor.scrollDOM.clientHeight,
        write: (visible, editor) => {
          if (
            editor.dom.hasAttribute("data-horizontal-scrollbar") !== visible
          ) {
            editor.dom.toggleAttribute("data-horizontal-scrollbar", visible)
          }
        },
      })
    }
  }
)
