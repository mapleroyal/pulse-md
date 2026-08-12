import { emojiLivePreviewExtension } from "./emoji-preview"
import { footnoteLivePreviewExtension } from "./footnotes"
import {
  invalidateSanitizedHtmlPreviewGeometry,
  sanitizedHtmlBlockAt,
  sanitizedHtmlLivePreviewExtension,
} from "./html-preview"
import {
  displayMathExpressionAt,
  invalidateMathPreviewGeometry,
  mathLivePreviewExtension,
} from "./math"
import {
  invalidateMermaidPreviewGeometry,
  mermaidLivePreviewExtension,
} from "./mermaid"
import { refreshOptionalPreviewGeometry } from "./optional-preview-geometry"
import type { OptionalLivePreviewSupport } from "./types"

export const optionalLivePreviewSupport: OptionalLivePreviewSupport = {
  blockAt(state, position, settings) {
    return (
      (settings.sanitizedHtml ? sanitizedHtmlBlockAt(state, position) : null) ??
      (settings.latex ? displayMathExpressionAt(state, position) : null)
    )
  },
  extensions({ onNavigate, selectionActive, settings, theme }) {
    return [
      ...(settings.latex
        ? [mathLivePreviewExtension({ selectionActive })]
        : []),
      ...(settings.emojiExpansion
        ? [emojiLivePreviewExtension({ selectionActive })]
        : []),
      ...(settings.footnotes
        ? [footnoteLivePreviewExtension({ onNavigate, selectionActive })]
        : []),
      ...(settings.mermaid
        ? [
            mermaidLivePreviewExtension({
              selectionActive,
              theme,
            }),
          ]
        : []),
      ...(settings.sanitizedHtml
        ? [sanitizedHtmlLivePreviewExtension({ selectionActive })]
        : []),
    ]
  },
  refreshContentGeometry(view, refreshRenders) {
    invalidateMathPreviewGeometry()
    invalidateMermaidPreviewGeometry(refreshRenders)
    invalidateSanitizedHtmlPreviewGeometry()
    view.dispatch({ effects: refreshOptionalPreviewGeometry.of(null) })
  },
}
