import * as React from "react"

import type {
  EditorStatus,
  MarkdownEditorMode,
} from "@/editor/MarkdownEditorController"
import type {
  ChromeSettings,
  DocumentFormat,
  DocumentKind,
} from "@/shared/contracts"

export interface StatusOverlayHandle {
  update(
    status: EditorStatus,
    format: DocumentFormat,
    mode: MarkdownEditorMode,
    documentKind: DocumentKind
  ): void
}

interface StatusOverlayProps {
  chrome: ChromeSettings
}

const numberFormatter = new Intl.NumberFormat()

export const StatusOverlay = React.forwardRef<
  StatusOverlayHandle,
  StatusOverlayProps
>(function StatusOverlay({ chrome }, forwardedRef) {
  const wordsRef = React.useRef<HTMLSpanElement>(null)
  const linesRef = React.useRef<HTMLSpanElement>(null)
  const charactersRef = React.useRef<HTMLSpanElement>(null)
  const cursorRef = React.useRef<HTMLSpanElement>(null)
  const modeRef = React.useRef<HTMLSpanElement>(null)
  const encodingRef = React.useRef<HTMLSpanElement>(null)
  const lineEndingRef = React.useRef<HTMLSpanElement>(null)
  const frameRef = React.useRef<number | null>(null)
  const pendingRef = React.useRef<{
    format: DocumentFormat
    documentKind: DocumentKind
    mode: MarkdownEditorMode
    status: EditorStatus
  } | null>(null)

  const flush = React.useCallback(() => {
    frameRef.current = null
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    const { documentKind, format, mode, status } = pending
    if (wordsRef.current)
      wordsRef.current.textContent =
        status.words === null
          ? "Counting words…"
          : `${numberFormatter.format(status.words)} ${status.words === 1 ? "word" : "words"}`
    if (linesRef.current)
      linesRef.current.textContent = `${numberFormatter.format(status.lines)} ${status.lines === 1 ? "line" : "lines"}`
    if (charactersRef.current)
      charactersRef.current.textContent = `${numberFormatter.format(status.characters)} ${status.characters === 1 ? "character" : "characters"}`
    if (cursorRef.current)
      cursorRef.current.textContent = `Ln ${numberFormatter.format(status.line)}, Col ${numberFormatter.format(status.column)}`
    if (modeRef.current)
      modeRef.current.textContent =
        documentKind === "plain-text"
          ? "Plain Text"
          : mode === "live"
            ? "Rendered"
            : "Raw Markdown"
    if (encodingRef.current)
      encodingRef.current.textContent = format.hasUtf8Bom
        ? "UTF-8 BOM"
        : "UTF-8"
    if (lineEndingRef.current)
      lineEndingRef.current.textContent =
        format.lineEnding === "\r\n" ? "CRLF" : "LF"
  }, [])

  React.useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  React.useImperativeHandle(
    forwardedRef,
    () => ({
      update(status, format, mode, documentKind) {
        pendingRef.current = { documentKind, format, mode, status }
        frameRef.current ??= requestAnimationFrame(flush)
      },
    }),
    [flush]
  )

  const items = chrome.statusItems
  return (
    <div
      className="status-overlay-reveal-region"
      data-always-visible={chrome.alwaysShowStatusBar || undefined}
    >
      <aside aria-label="Document status" className="status-overlay">
        {items.words ? (
          <span ref={wordsRef} data-status-item="words">
            0 words
          </span>
        ) : null}
        {items.lines ? (
          <span ref={linesRef} data-status-item="lines">
            1 line
          </span>
        ) : null}
        {items.characters ? (
          <span ref={charactersRef} data-status-item="characters">
            0 characters
          </span>
        ) : null}
        {items.cursorPosition ? (
          <span ref={cursorRef} data-status-item="cursor">
            Ln 1, Col 1
          </span>
        ) : null}
        <span className="status-overlay-spacer" />
        <span ref={modeRef} data-status-item="mode">
          Rendered
        </span>
        {items.encoding ? (
          <span ref={encodingRef} data-status-item="encoding">
            UTF-8
          </span>
        ) : null}
        {items.lineEnding ? (
          <span ref={lineEndingRef} data-status-item="line-ending">
            LF
          </span>
        ) : null}
      </aside>
    </div>
  )
})
