import type {
  DocumentFormat,
  SettingsScratchSnapshotEntry,
  TabId,
} from "@/shared/contracts"

interface SettingsScratchSnapshotDocument {
  readonly document: {
    readonly length: number
    toString(): string
  }
  readonly format: DocumentFormat
  readonly revision: number
}

export type SettingsScratchSnapshotCollection =
  | { readonly status: "too-large" }
  | {
      readonly status: "ok"
      readonly tabs: readonly SettingsScratchSnapshotEntry[]
    }

export function boundedEncodedDocumentByteLength(
  value: string,
  format: DocumentFormat,
  maximum: number
): number | null {
  let bytes = format.hasUtf8Bom ? 3 : 0
  if (bytes > maximum) return null
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) index += 1
      bytes += format.lineEnding.length
    } else if (codeUnit === 0x0a) {
      bytes += format.lineEnding.length
    } else if (codeUnit <= 0x7f) {
      bytes += 1
    } else if (codeUnit <= 0x7ff) {
      bytes += 2
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      bytes += 3
    } else {
      bytes += 3
    }
    if (bytes > maximum) return null
  }
  return bytes
}

export async function collectSettingsScratchSnapshot(
  tabIds: readonly TabId[],
  maximumContentBytes: number,
  resolve: (tabId: TabId) => Promise<SettingsScratchSnapshotDocument>
): Promise<SettingsScratchSnapshotCollection> {
  const tabs: SettingsScratchSnapshotEntry[] = []
  let remainingBytes = maximumContentBytes
  for (const tabId of tabIds) {
    const tab = await resolve(tabId)
    if (tab.document.length > remainingBytes) return { status: "too-large" }
    const content = tab.document.toString()
    const byteLength = boundedEncodedDocumentByteLength(
      content,
      tab.format,
      remainingBytes
    )
    if (byteLength === null) return { status: "too-large" }
    remainingBytes -= byteLength
    tabs.push({ content, revision: tab.revision, tabId })
  }
  return { status: "ok", tabs }
}
