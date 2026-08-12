import path from "node:path"
import { pathToFileURL } from "node:url"

import type {
  CopiedHeadingLinkMetadata,
  ScratchDocumentIdentity,
  TabId,
} from "../src/shared/contracts"
import { isScratchIdentifier } from "../src/shared/scratch-identifiers"
import {
  scratchLinkAddress,
  type ScratchLinkScheme,
} from "../src/shared/scratch-links"

export const COPIED_HEADING_LINK_VERSION = 3 as const
export const COPIED_HEADING_LINK_MARKER = "data-pulse-md-heading-link"

function validClipboardString(
  value: unknown,
  maximumLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

export function normalizeCopiedHeadingLinkMetadata(
  value: unknown
): CopiedHeadingLinkMetadata {
  if (!value || typeof value !== "object") {
    throw new TypeError("Copied heading link metadata is invalid")
  }
  const candidate = value as Partial<CopiedHeadingLinkMetadata>
  const sourceScratch = candidate.sourceScratch
  if (
    candidate.version !== COPIED_HEADING_LINK_VERSION ||
    !validClipboardString(candidate.fragment, 32_768) ||
    !validClipboardString(candidate.sourceTabId, 256) ||
    (candidate.sourcePath !== null &&
      (!validClipboardString(candidate.sourcePath, 32_768) ||
        !path.isAbsolute(candidate.sourcePath))) ||
    (sourceScratch !== null &&
      (!sourceScratch ||
        typeof sourceScratch !== "object" ||
        !isScratchIdentifier(sourceScratch.scratchId))) ||
    (candidate.sourcePath !== null && sourceScratch !== null)
  ) {
    throw new TypeError("Copied heading link metadata is invalid")
  }
  return {
    fragment: candidate.fragment,
    sourcePath: candidate.sourcePath,
    sourceScratch:
      sourceScratch === null ? null : { scratchId: sourceScratch.scratchId },
    sourceTabId: candidate.sourceTabId,
    version: COPIED_HEADING_LINK_VERSION,
  }
}

function encodedFragment(fragment: string) {
  return encodeURIComponent(fragment)
}

function encodedPathSegment(segment: string) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function encodedRelativePath(relativePath: string) {
  return relativePath.split(/[\\/]/).map(encodedPathSegment).join("/")
}

export function externalHeadingLinkAddress(
  sourcePath: string | null,
  sourceScratch: ScratchDocumentIdentity | null,
  fragment: string,
  scratchLinkScheme: ScratchLinkScheme = "pulse-md"
) {
  const suffix = `#${encodedFragment(fragment)}`
  if (sourcePath) return `${pathToFileURL(sourcePath).href}${suffix}`
  return sourceScratch
    ? scratchLinkAddress(sourceScratch, fragment, scratchLinkScheme)
    : suffix
}

function escapeHtmlAttribute(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "'": "&#39;",
        '"': "&quot;",
        "<": "&lt;",
        ">": "&gt;",
      })[character]!
  )
}

export function copiedHeadingLinkHtml(
  metadata: CopiedHeadingLinkMetadata,
  address: string
) {
  return `<a href="${escapeHtmlAttribute(address)}" ${COPIED_HEADING_LINK_MARKER}="${COPIED_HEADING_LINK_VERSION}" data-pulse-md-heading-fragment="${escapeHtmlAttribute(metadata.fragment)}" data-pulse-md-heading-source-path="${escapeHtmlAttribute(metadata.sourcePath ?? "")}" data-pulse-md-heading-source-scratch="${escapeHtmlAttribute(metadata.sourceScratch?.scratchId ?? "")}" data-pulse-md-heading-source-tab="${escapeHtmlAttribute(metadata.sourceTabId)}">${escapeHtmlAttribute(address)}</a>`
}

function sameScratchIdentity(
  left: ScratchDocumentIdentity | null,
  right: ScratchDocumentIdentity | null
) {
  return left !== null && right !== null && left.scratchId === right.scratchId
}

export function headingLinkForPaste(
  targetPath: string | null,
  targetScratch: ScratchDocumentIdentity | null,
  targetTabId: TabId,
  metadata: CopiedHeadingLinkMetadata,
  scratchLinkScheme: ScratchLinkScheme = "pulse-md"
) {
  const fragment = `#${encodedFragment(metadata.fragment)}`
  if (
    metadata.sourceTabId === targetTabId ||
    sameScratchIdentity(metadata.sourceScratch, targetScratch) ||
    (targetPath !== null &&
      metadata.sourcePath !== null &&
      path.resolve(targetPath) === path.resolve(metadata.sourcePath))
  ) {
    return fragment
  }
  if (metadata.sourceScratch !== null) {
    return scratchLinkAddress(
      metadata.sourceScratch,
      metadata.fragment,
      scratchLinkScheme
    )
  }
  if (metadata.sourcePath === null || targetPath === null) {
    return externalHeadingLinkAddress(
      metadata.sourcePath,
      metadata.sourceScratch,
      metadata.fragment,
      scratchLinkScheme
    )
  }
  const relativePath = path.relative(
    path.dirname(targetPath),
    metadata.sourcePath
  )
  return `${encodedRelativePath(relativePath)}${fragment}`
}
