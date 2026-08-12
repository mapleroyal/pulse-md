import { Prec, type Extension } from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"

import type { CopiedHeadingLinkMetadata } from "../shared/contracts"
import { isScratchIdentifier } from "../shared/scratch-identifiers"
import {
  AsyncPasteTracker,
  asyncPasteFallbackTransaction,
  mapPendingAsyncPaste,
  type PendingAsyncPaste,
  resolvedAsyncPasteChanges,
  resolvedAsyncPasteTransaction,
} from "./async-paste"

const markerSelector = 'a[data-pulse-md-heading-link="3"]'

function validMetadataString(
  value: string | undefined,
  maximumLength: number
): value is string {
  return (
    value !== undefined &&
    value.length <= maximumLength &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

export function copiedHeadingLinkMetadata(
  data: DataTransfer,
  ownerDocument: Document
): CopiedHeadingLinkMetadata | null {
  const html = data.getData("text/html")
  if (!html || html.length > 262_144) return null
  const template = ownerDocument.createElement("template")
  template.innerHTML = html
  const marker = template.content.querySelector<HTMLElement>(markerSelector)
  if (!marker) return null

  const fragment = marker.dataset.pulseMdHeadingFragment
  const sourcePath = marker.dataset.pulseMdHeadingSourcePath
  const sourceScratch = marker.dataset.pulseMdHeadingSourceScratch
  const sourceTabId = marker.dataset.pulseMdHeadingSourceTab
  if (
    !validMetadataString(fragment, 32_768) ||
    !validMetadataString(sourcePath, 32_768) ||
    !validMetadataString(sourceScratch, 256) ||
    (sourceScratch.length > 0 && !isScratchIdentifier(sourceScratch)) ||
    !validMetadataString(sourceTabId, 256)
  ) {
    return null
  }
  return {
    fragment,
    sourcePath: sourcePath || null,
    sourceScratch:
      sourceScratch.length > 0 ? { scratchId: sourceScratch } : null,
    sourceTabId,
    version: 3,
  }
}

export type PendingHeadingLinkPaste = PendingAsyncPaste
export const headingLinkPasteFallbackTransaction = asyncPasteFallbackTransaction
export const mapPendingHeadingLinkPaste = mapPendingAsyncPaste
export const resolvedHeadingLinkPasteChanges = resolvedAsyncPasteChanges
export const resolvedHeadingLinkPasteTransaction = resolvedAsyncPasteTransaction

export function pastedHeadingLinkExtension(
  resolveDestination: (metadata: CopiedHeadingLinkMetadata) => Promise<string>
): Extension {
  const pendingPastes = ViewPlugin.define(() => new AsyncPasteTracker())
  return [
    pendingPastes,
    Prec.highest(
      EditorView.domEventHandlers({
        paste(event, view) {
          const data = event.clipboardData
          if (!data) return false
          const metadata = copiedHeadingLinkMetadata(
            data,
            view.dom.ownerDocument
          )
          if (!metadata) return false

          event.preventDefault()
          const fallback = data.getData("text/plain")
          const { pending, transaction } = headingLinkPasteFallbackTransaction(
            view.state,
            fallback
          )
          const token = {}
          view.dispatch(transaction)
          view.plugin(pendingPastes)?.pastes.set(token, pending)

          void resolveDestination(metadata).then(
            (destination) => {
              const tracker = view.plugin(pendingPastes)
              const current = tracker?.pastes.get(token)
              if (!tracker || !current) return
              tracker.pastes.delete(token)
              const transaction = resolvedHeadingLinkPasteTransaction(
                view.state,
                current,
                destination
              )
              if (transaction) view.dispatch(transaction)
            },
            (error: unknown) => {
              view.plugin(pendingPastes)?.pastes.delete(token)
              console.error("Unable to resolve copied heading link", error)
            }
          )
          return true
        },
      })
    ),
  ]
}
