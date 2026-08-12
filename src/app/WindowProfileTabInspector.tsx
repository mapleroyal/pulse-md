import * as React from "react"

import { PathLabel } from "@/app/PathLabel"
import { WindowProfileTabMark } from "@/app/WindowProfileTabPreview"
import {
  fileNameFromPath,
  resolvedWindowProfileScratchIdentity,
  windowProfileScratchIdentityKey,
  windowProfileTabDisplayName,
} from "@/app/window-profile-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  TAB_COLORS,
  type ScratchDocumentIdentity,
  type ScratchEntry,
  type EditorMode,
  type TabColor,
  type WindowProfileTab,
  type WindowProfileTabKind,
} from "@/shared/contracts"

const NO_SELECTION = "__no-selection__"
const NO_TAB_COLOR = "__no-tab-color__"
const INHERIT_MODE = "__inherit-mode__"
const MAX_PROFILE_TAB_TITLE_LENGTH = 128

const tabKindLabels: Record<WindowProfileTabKind, string> = {
  ephemeral: "Temporary",
  file: "File",
  scratch: "Scratch",
  untitled: "Untitled",
}

const editorModeLabels: Record<EditorMode, string> = {
  live: "Rendered",
  source: "Raw Markdown",
}

function scratchValue(identity: ScratchDocumentIdentity) {
  return identity.scratchId
}

function scratchEntryLabel(entry: ScratchEntry) {
  return entry.displayTitle
}

function tabWithKind(
  tab: WindowProfileTab,
  kind: Exclude<WindowProfileTabKind, "file">,
  scratchId?: string
): WindowProfileTab {
  const presentation = {
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.color === undefined ? {} : { color: tab.color }),
    ...(tab.mode === undefined ? {} : { mode: tab.mode }),
  }
  if (kind === "scratch") {
    const identity = tab.kind === "scratch" ? tab.scratchId : scratchId
    if (!identity) throw new Error("A profile scratch tab requires a scratch")
    return { id: tab.id, kind, scratchId: identity, ...presentation }
  }
  return { id: tab.id, kind, ...presentation }
}

function useInspectorSelectFocus() {
  const suppressFocusRestoreRef = React.useRef(false)
  const onOpenChange = React.useCallback(
    (open: boolean, eventDetails: { reason: string }) => {
      if (open) {
        suppressFocusRestoreRef.current = false
      } else if (eventDetails.reason === "outside-press") {
        suppressFocusRestoreRef.current = true
      }
    },
    []
  )
  const finalFocus = React.useCallback(() => {
    const suppressFocusRestore = suppressFocusRestoreRef.current
    suppressFocusRestoreRef.current = false
    return !suppressFocusRestore
  }, [])

  return { finalFocus, onOpenChange }
}

export function WindowProfileTabInspector({
  disabled = false,
  profileId,
  scratches,
  selectedTab,
  usedScratchIdentityKeys,
  onChange,
  onSelectFile,
}: {
  disabled?: boolean
  profileId: string
  scratches: readonly ScratchEntry[]
  selectedTab: WindowProfileTab | null
  usedScratchIdentityKeys: ReadonlySet<string>
  onChange: (tab: WindowProfileTab) => void
  onSelectFile: () => void
}) {
  const titleId = React.useId()
  const typeId = React.useId()
  const modeId = React.useId()
  const colorId = React.useId()
  const scratchId = React.useId()
  const typeSelectFocus = useInspectorSelectFocus()
  const scratchSelectFocus = useInspectorSelectFocus()
  const modeSelectFocus = useInspectorSelectFocus()
  const colorSelectFocus = useInspectorSelectFocus()
  const inactive = disabled || selectedTab === null
  const selectedIdentity = selectedTab
    ? resolvedWindowProfileScratchIdentity(profileId, selectedTab)
    : null
  const availableScratches = scratches.filter((entry) => {
    return (
      entry.scratchId === selectedIdentity?.scratchId ||
      !usedScratchIdentityKeys.has(entry.scratchId)
    )
  })
  const selectedScratchValue =
    selectedTab?.kind === "scratch" ? selectedTab.scratchId : NO_SELECTION
  const selectedScratchEntry = availableScratches.find(
    (entry) => entry.scratchId === selectedScratchValue
  )

  const updateSelected = (
    updater: (tab: WindowProfileTab) => WindowProfileTab
  ) => {
    if (selectedTab) onChange(updater(selectedTab))
  }
  return (
    <section
      aria-labelledby="tab-inspector-title"
      className="grid min-w-0 content-start gap-4"
      data-inactive={inactive || undefined}
      data-tab-inspector=""
    >
      <h2
        id="tab-inspector-title"
        className="font-heading text-base font-medium"
      >
        Tab Inspector
      </h2>

      <fieldset
        className="grid gap-4 transition-opacity data-[inactive=true]:opacity-55"
        disabled={inactive}
        data-inactive={inactive || undefined}
      >
        <label className="grid gap-1.5 text-sm font-medium" htmlFor={titleId}>
          Title
          <Input
            id={titleId}
            maxLength={MAX_PROFILE_TAB_TITLE_LENGTH}
            placeholder={
              selectedTab
                ? windowProfileTabDisplayName({
                    ...selectedTab,
                    title: undefined,
                  })
                : "Select a tab"
            }
            value={selectedTab?.title ?? ""}
            onChange={(event) => {
              const title = event.currentTarget.value
              updateSelected((tab) => ({ ...tab, title: title || undefined }))
            }}
          />
        </label>

        <label className="grid gap-1.5 text-sm font-medium" htmlFor={typeId}>
          Type
          <Select
            disabled={inactive}
            value={selectedTab?.kind ?? NO_SELECTION}
            onOpenChange={typeSelectFocus.onOpenChange}
            onValueChange={(value) => {
              if (value === null || !selectedTab) return
              const kind = value as WindowProfileTabKind
              if (kind === "file") {
                onSelectFile()
                return
              }
              if (kind === "scratch") {
                const first = availableScratches[0]
                if (first)
                  onChange(tabWithKind(selectedTab, kind, first.scratchId))
                return
              }
              onChange(tabWithKind(selectedTab, kind))
            }}
          >
            <SelectTrigger id={typeId} className="w-full">
              <SelectValue>
                {selectedTab ? tabKindLabels[selectedTab.kind] : "—"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent finalFocus={typeSelectFocus.finalFocus}>
              <SelectGroup>
                {(["file", "untitled", "ephemeral", "scratch"] as const).map(
                  (kind) => (
                    <SelectItem
                      key={kind}
                      disabled={
                        kind === "scratch" && availableScratches.length === 0
                      }
                      value={kind}
                    >
                      {tabKindLabels[kind]}
                    </SelectItem>
                  )
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>

        {selectedTab?.kind === "file" ? (
          <div className="grid min-w-0 gap-2">
            <div
              aria-label={selectedTab.path}
              className="min-w-0 rounded-xl bg-muted/35 px-3 py-2"
            >
              <PathLabel
                className="file-label-content window-profile-inspector-path-label font-mono"
                display="path"
                displayName={fileNameFromPath(selectedTab.path)}
                filePath={selectedTab.path}
              />
            </div>
            <Button
              disabled={disabled}
              size="sm"
              type="button"
              variant="outline"
              onClick={onSelectFile}
            >
              Change File
            </Button>
          </div>
        ) : null}

        {selectedTab?.kind === "scratch" && availableScratches.length > 0 ? (
          <label
            className="grid gap-1.5 text-sm font-medium"
            htmlFor={scratchId}
          >
            Scratch Content
            <Select
              disabled={inactive}
              value={selectedScratchValue}
              onOpenChange={scratchSelectFocus.onOpenChange}
              onValueChange={(value) => {
                if (value === null || !selectedTab) return
                const scratch = availableScratches.find(
                  (entry) => entry.scratchId === value
                )
                if (scratch) {
                  onChange({ ...selectedTab, scratchId: scratch.scratchId })
                }
              }}
            >
              <SelectTrigger id={scratchId} className="w-full min-w-0">
                <SelectValue>
                  {selectedScratchEntry
                    ? scratchEntryLabel(selectedScratchEntry)
                    : selectedTab.scratchId}
                </SelectValue>
              </SelectTrigger>
              <SelectContent finalFocus={scratchSelectFocus.finalFocus}>
                <SelectGroup>
                  {availableScratches.map((entry) => {
                    const identity = { scratchId: entry.scratchId }
                    const value = scratchValue(identity)
                    const current = value === selectedScratchValue
                    return (
                      <SelectItem
                        key={value}
                        disabled={
                          !current &&
                          usedScratchIdentityKeys.has(
                            windowProfileScratchIdentityKey(identity)
                          )
                        }
                        value={value}
                      >
                        {scratchEntryLabel(entry)}
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
        ) : null}

        <label className="grid gap-1.5 text-sm font-medium" htmlFor={modeId}>
          Mode
          <Select
            disabled={inactive}
            value={selectedTab?.mode ?? INHERIT_MODE}
            onOpenChange={modeSelectFocus.onOpenChange}
            onValueChange={(value) => {
              if (value === null) return
              updateSelected((tab) => ({
                ...tab,
                mode:
                  value === INHERIT_MODE ? undefined : (value as EditorMode),
              }))
            }}
          >
            <SelectTrigger id={modeId} className="w-full">
              <SelectValue>
                {selectedTab?.mode
                  ? editorModeLabels[selectedTab.mode]
                  : selectedTab
                    ? "Inherit"
                    : "—"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent finalFocus={modeSelectFocus.finalFocus}>
              <SelectGroup>
                <SelectItem value={INHERIT_MODE}>Inherit</SelectItem>
                <SelectItem value="live">Rendered</SelectItem>
                <SelectItem value="source">Raw Markdown</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>

        <label className="grid gap-1.5 text-sm font-medium" htmlFor={colorId}>
          Color
          <Select
            disabled={inactive}
            value={selectedTab?.color ?? NO_TAB_COLOR}
            onOpenChange={colorSelectFocus.onOpenChange}
            onValueChange={(value) => {
              if (value === null) return
              updateSelected((tab) => ({
                ...tab,
                color: value === NO_TAB_COLOR ? undefined : (value as TabColor),
              }))
            }}
          >
            <SelectTrigger id={colorId} className="w-full">
              <SelectValue>
                {selectedTab ? (
                  <span
                    className="flex min-w-0 items-center gap-2"
                    data-profile-color-value=""
                  >
                    {selectedTab.color ? (
                      <WindowProfileTabMark color={selectedTab.color} />
                    ) : null}
                    <span className="capitalize">
                      {selectedTab.color ?? "Normal"}
                    </span>
                  </span>
                ) : (
                  "—"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent finalFocus={colorSelectFocus.finalFocus}>
              <SelectGroup>
                <SelectItem value={NO_TAB_COLOR}>Normal</SelectItem>
                {TAB_COLORS.map((color) => (
                  <SelectItem key={color} value={color}>
                    <WindowProfileTabMark color={color} />
                    <span className="capitalize">{color}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
      </fieldset>
    </section>
  )
}
