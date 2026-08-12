import * as React from "react"
import { RotateCcwIcon } from "lucide-react"

import { WindowProfileTabPreview } from "@/app/WindowProfileTabPreview"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  ACTIVE_TAB_INDICATOR_POSITIONS,
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  MAX_ACTIVE_TAB_INDICATOR_THICKNESS,
  MIN_ACTIVE_TAB_INDICATOR_THICKNESS,
  type ActiveTabIndicatorColorSource,
  type ActiveTabIndicatorPosition,
  type ActiveTabIndicatorSettings,
  type AppSettings,
} from "@/shared/contracts"

export interface ActiveTabIndicatorPreviewWorkspaceProps {
  isSaving?: boolean
  settings: AppSettings
  onCancel: () => void
  onDraftChange: (settings: AppSettings) => void
  onSave: (settings: AppSettings) => void | Promise<void>
}

const positionLabels: Record<ActiveTabIndicatorPosition, string> = {
  top: "Top edge",
  "top-right": "Top-right corner",
  right: "Right edge",
  "bottom-right": "Bottom-right corner",
  bottom: "Bottom edge",
  "bottom-left": "Bottom-left corner",
  left: "Left edge",
  "top-left": "Top-left corner",
}

const positionShortLabels: Record<ActiveTabIndicatorPosition, string> = {
  top: "Top",
  "top-right": "TR",
  right: "Right",
  "bottom-right": "BR",
  bottom: "Bottom",
  "bottom-left": "BL",
  left: "Left",
  "top-left": "TL",
}

const positionGridAreas: Record<ActiveTabIndicatorPosition, string> = {
  top: "col-start-2 row-start-1",
  "top-right": "col-start-3 row-start-1",
  right: "col-start-3 row-start-2",
  "bottom-right": "col-start-3 row-start-3",
  bottom: "col-start-2 row-start-3",
  "bottom-left": "col-start-1 row-start-3",
  left: "col-start-1 row-start-2",
  "top-left": "col-start-1 row-start-1",
}

const colorSourceLabels: Record<ActiveTabIndicatorColorSource, string> = {
  "theme-accent": "Theme Accent",
  foreground: "Foreground-Derived",
  "focus-ring": "Focus-Ring Color",
  custom: "Custom Color",
}

const colorSourceDescriptions: Record<ActiveTabIndicatorColorSource, string> = {
  "theme-accent": "Uses the current theme’s standard accent color.",
  foreground:
    "Derives a contrasting indicator from the theme’s foreground and tab surface.",
  "focus-ring":
    "Uses the same theme or platform token as focused-control outlines.",
  custom: "Uses the exact color selected below unless adaptation is enabled.",
}

function indicatorSettingsMatch(
  left: ActiveTabIndicatorSettings,
  right: ActiveTabIndicatorSettings
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeThickness(value: number) {
  return Math.min(
    MAX_ACTIVE_TAB_INDICATOR_THICKNESS,
    Math.max(MIN_ACTIVE_TAB_INDICATOR_THICKNESS, Math.round(value))
  )
}

export default function ActiveTabIndicatorPreviewWorkspace({
  isSaving = false,
  settings,
  onCancel,
  onDraftChange,
  onSave,
}: ActiveTabIndicatorPreviewWorkspaceProps) {
  const [draft, setDraft] = React.useState(() => cloneAppSettings(settings))
  const draftRef = React.useRef(draft)
  const [previewWindowState, setPreviewWindowState] = React.useState<
    "active" | "inactive"
  >("active")
  const [submitting, setSubmitting] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const saving = isSaving || submitting

  const updateIndicator = React.useCallback(
    (change: Partial<ActiveTabIndicatorSettings>) => {
      const next = cloneAppSettings(draftRef.current)
      next.chrome.activeTabIndicator = {
        ...next.chrome.activeTabIndicator,
        ...change,
      }
      draftRef.current = next
      setDraft(next)
      onDraftChange(cloneAppSettings(next))
    },
    [onDraftChange]
  )

  const save = React.useCallback(async () => {
    if (saving) return
    setSaveError(null)
    setSubmitting(true)
    try {
      await onSave(cloneAppSettings(draftRef.current))
    } catch (error) {
      console.error("Unable to save active tab indicator settings", error)
      setSaveError(
        "Active tab indicator settings could not be saved. Please try again."
      )
    } finally {
      setSubmitting(false)
    }
  }, [onSave, saving])

  React.useLayoutEffect(() => {
    workspaceRef.current?.focus({ preventScroll: true })
  }, [])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === "Escape") {
        const expandedCombobox = document.querySelector(
          '[role="combobox"][aria-expanded="true"]'
        )
        if (expandedCombobox) return
        event.preventDefault()
        event.stopPropagation()
        if (!saving) onCancel()
        return
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [onCancel, save, saving])

  const indicator = draft.chrome.activeTabIndicator
  const togglePosition = (position: ActiveTabIndicatorPosition) => {
    const selected = new Set(indicator.positions)
    if (selected.has(position)) selected.delete(position)
    else selected.add(position)
    updateIndicator({
      positions: ACTIVE_TAB_INDICATOR_POSITIONS.filter((candidate) =>
        selected.has(candidate)
      ),
    })
  }

  return (
    <div
      ref={workspaceRef}
      aria-label="Active tab indicator preview workspace"
      className="pointer-events-none absolute inset-0 z-50 flex min-h-0 flex-col pt-[var(--window-chrome-height)] outline-none"
      role="region"
      tabIndex={-1}
    >
      <section
        aria-label="Active tab indicator preview"
        className="active-tab-indicator-preview grid min-h-0 flex-1 place-items-center overflow-hidden px-5 py-8"
        data-preview-window-state={previewWindowState}
      >
        <div className="grid max-w-full gap-4 rounded-3xl border border-border/60 bg-[var(--document-background)] p-6 shadow-sm">
          <div className="flex max-w-full items-center gap-2 overflow-hidden">
            <WindowProfileTabPreview
              aria-label="Inactive tab preview: Notes.md"
              displayName="Notes.md"
              interactive={false}
            />
            <WindowProfileTabPreview
              active
              aria-label="Active tab preview: Current document.md"
              color="blue"
              displayName="Current document.md"
              interactive={false}
            />
            <WindowProfileTabPreview
              aria-label="Inactive tab preview: Scratch"
              displayName="Scratch"
              interactive={false}
            />
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {previewWindowState === "active"
              ? "Focused app window"
              : "Inactive app window"}
          </p>
        </div>
      </section>

      <section
        aria-label="Active tab indicator controls"
        className="pointer-events-auto max-h-[52dvh] shrink-0 overflow-y-auto border-t border-border bg-popover text-popover-foreground"
      >
        <div className="mx-auto grid w-full max-w-[1120px] gap-4 px-5 py-4">
          <div className="flex items-center justify-end gap-2">
            <Button
              disabled={saving}
              size="sm"
              type="button"
              variant="outline"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              disabled={saving}
              size="sm"
              type="button"
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>

          <div className="grid gap-5 md:grid-cols-[minmax(15rem,0.8fr)_minmax(16rem,1fr)_minmax(14rem,0.8fr)]">
            <section className="grid content-start gap-3">
              <h3 className="text-sm font-medium">Placement</h3>
              <div className="grid w-fit grid-cols-3 grid-rows-3 gap-1 rounded-2xl border border-border/60 p-2">
                {ACTIVE_TAB_INDICATOR_POSITIONS.map((position) => (
                  <Button
                    key={position}
                    aria-label={`${positionLabels[position]} indicator`}
                    aria-pressed={indicator.positions.includes(position)}
                    className={`${positionGridAreas[position]} min-w-14 px-2 text-[11px]`}
                    size="sm"
                    type="button"
                    variant={
                      indicator.positions.includes(position)
                        ? "secondary"
                        : "ghost"
                    }
                    onClick={() => togglePosition(position)}
                  >
                    {positionShortLabels[position]}
                  </Button>
                ))}
                <span className="col-start-2 row-start-2 grid place-items-center text-[10px] text-muted-foreground">
                  Tab
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Select any combination of edges and corners. A corner fills its
                rounded area with a straight diagonal inner boundary.
              </p>
            </section>

            <section className="grid content-start gap-4">
              <Field orientation="vertical">
                <label
                  className="text-sm font-medium"
                  htmlFor="active-tab-indicator-color-source"
                >
                  Indicator Color
                </label>
                <FieldContent>
                  <Select
                    value={indicator.colorSource}
                    onValueChange={(colorSource) =>
                      updateIndicator({
                        colorSource:
                          colorSource as ActiveTabIndicatorColorSource,
                      })
                    }
                  >
                    <SelectTrigger
                      id="active-tab-indicator-color-source"
                      aria-label="Active tab indicator color source"
                      className="w-full"
                    >
                      <SelectValue>
                        {colorSourceLabels[indicator.colorSource]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="theme-accent">
                          Theme Accent
                        </SelectItem>
                        <SelectItem value="foreground">
                          Foreground-Derived
                        </SelectItem>
                        <SelectItem value="focus-ring">
                          Focus-Ring Color
                        </SelectItem>
                        <SelectItem value="custom">Custom Color</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {colorSourceDescriptions[indicator.colorSource]}
                  </FieldDescription>
                </FieldContent>
              </Field>

              <Field
                data-disabled={indicator.colorSource !== "custom"}
                orientation="horizontal"
              >
                <FieldContent>
                  <label
                    className="text-sm font-medium"
                    htmlFor="active-tab-indicator-custom-color"
                  >
                    Custom Color
                  </label>
                  <FieldDescription className="font-mono uppercase">
                    {indicator.customColor}
                  </FieldDescription>
                </FieldContent>
                <input
                  id="active-tab-indicator-custom-color"
                  aria-label="Active tab indicator custom color"
                  className="h-9 w-14 cursor-pointer rounded-xl border border-border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={indicator.colorSource !== "custom"}
                  type="color"
                  value={indicator.customColor}
                  onChange={(event) =>
                    updateIndicator({ customColor: event.currentTarget.value })
                  }
                />
              </Field>

              <Field
                data-disabled={indicator.colorSource !== "custom"}
                orientation="horizontal"
              >
                <FieldContent>
                  <label
                    className="text-sm font-medium"
                    htmlFor="active-tab-indicator-adaptive-color"
                  >
                    Adaptive Custom Color
                  </label>
                  <FieldDescription>
                    Adjusts the selected color for light, dark, focused, and
                    inactive surfaces.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="active-tab-indicator-adaptive-color"
                  aria-label="Adaptive active tab indicator custom color"
                  checked={indicator.adaptCustomColor}
                  disabled={indicator.colorSource !== "custom"}
                  onCheckedChange={(adaptCustomColor) =>
                    updateIndicator({ adaptCustomColor })
                  }
                />
              </Field>
            </section>

            <section className="grid content-start gap-4">
              <Field orientation="vertical">
                <div className="flex items-center justify-between gap-3">
                  <label
                    className="text-sm font-medium"
                    htmlFor="active-tab-indicator-thickness"
                  >
                    Thickness
                  </label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {indicator.thickness} px
                  </span>
                </div>
                <Slider
                  id="active-tab-indicator-thickness"
                  aria-label="Active tab indicator thickness"
                  max={MAX_ACTIVE_TAB_INDICATOR_THICKNESS}
                  min={MIN_ACTIVE_TAB_INDICATOR_THICKNESS}
                  step={1}
                  value={[indicator.thickness]}
                  onValueChange={(next) => {
                    const value = typeof next === "number" ? next : next[0]
                    if (value !== undefined) {
                      updateIndicator({ thickness: normalizeThickness(value) })
                    }
                  }}
                />
              </Field>

              <Field orientation="vertical">
                <span className="text-sm font-medium">Window State</span>
                <div className="flex rounded-xl border border-border/60 p-1">
                  <Button
                    aria-pressed={previewWindowState === "active"}
                    className="flex-1"
                    size="sm"
                    type="button"
                    variant={
                      previewWindowState === "active" ? "secondary" : "ghost"
                    }
                    onClick={() => setPreviewWindowState("active")}
                  >
                    Focused
                  </Button>
                  <Button
                    aria-pressed={previewWindowState === "inactive"}
                    className="flex-1"
                    size="sm"
                    type="button"
                    variant={
                      previewWindowState === "inactive" ? "secondary" : "ghost"
                    }
                    onClick={() => setPreviewWindowState("inactive")}
                  >
                    Inactive
                  </Button>
                </div>
              </Field>
            </section>
          </div>

          <div className="flex min-h-8 items-center justify-between gap-3">
            {saveError ? (
              <p className="text-xs text-destructive" role="alert">
                {saveError}
              </p>
            ) : (
              <span />
            )}
            <Button
              disabled={indicatorSettingsMatch(
                indicator,
                DEFAULT_APP_SETTINGS.chrome.activeTabIndicator
              )}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                updateIndicator({
                  ...DEFAULT_APP_SETTINGS.chrome.activeTabIndicator,
                  positions: [
                    ...DEFAULT_APP_SETTINGS.chrome.activeTabIndicator.positions,
                  ],
                })
              }
            >
              <RotateCcwIcon data-icon="inline-start" />
              Reset all
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
