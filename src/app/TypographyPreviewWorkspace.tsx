import * as React from "react"
import { NumberField } from "@base-ui/react/number-field"
import { BoldIcon, RotateCcwIcon } from "lucide-react"

import { FontFamilyPicker } from "@/app/FontFamilyPicker"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  MAX_HEADING_FONT_SCALE,
  MAX_TYPOGRAPHY_FONT_SIZE,
  MIN_HEADING_FONT_SCALE,
  MIN_TYPOGRAPHY_FONT_SIZE,
  type AppSettings,
} from "@/shared/contracts"

const FONT_SIZE_STEP = 0.5
const HEADING_SCALE_STEP = 0.01
const NUMBER_INPUT_CLASS_NAME =
  "h-8 w-full min-w-0 rounded-3xl border border-transparent bg-input/50 py-1 pl-3 text-right text-xs tabular-nums transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

export interface TypographyPreviewWorkspaceProps {
  isSaving?: boolean
  settings: AppSettings
  onCancel: () => void
  onDockHeightChange?: (height: number) => void
  onDraftChange: (settings: AppSettings) => void
  onSave: (settings: AppSettings) => void | Promise<void>
}

interface FontSizeControlProps {
  defaultValue: number
  id: string
  label: string
  value: number
  onValueChange: (value: number) => void
}

interface HeadingScaleControlProps {
  bold: boolean
  defaultBold: boolean
  defaultValue: number
  id: string
  label: string
  value: number
  onBoldChange: (bold: boolean) => void
  onReset: () => void
  onValueChange: (value: number) => void
}

function normalizedFontSize(value: number) {
  const clamped = Math.min(
    MAX_TYPOGRAPHY_FONT_SIZE,
    Math.max(MIN_TYPOGRAPHY_FONT_SIZE, value)
  )
  return Number(
    (Math.round(clamped / FONT_SIZE_STEP) * FONT_SIZE_STEP).toFixed(1)
  )
}

function normalizedHeadingScale(value: number) {
  const clamped = Math.min(
    MAX_HEADING_FONT_SCALE,
    Math.max(MIN_HEADING_FONT_SCALE, value)
  )
  return Number(
    (Math.round(clamped / HEADING_SCALE_STEP) * HEADING_SCALE_STEP).toFixed(2)
  )
}

function typographySettingsMatch(left: AppSettings, right: AppSettings) {
  return (
    left.regularFontFamily === right.regularFontFamily &&
    left.monospaceFontFamily === right.monospaceFontFamily &&
    left.baseFontSize === right.baseFontSize &&
    left.codeFontSize === right.codeFontSize &&
    left.calloutTitleFontSize === right.calloutTitleFontSize &&
    left.fontLigatures === right.fontLigatures &&
    left.headingFontScales.every(
      (fontScale, index) => fontScale === right.headingFontScales[index]
    ) &&
    left.headingFontBold.every(
      (bold, index) => bold === right.headingFontBold[index]
    )
  )
}

function typographyDefaults(settings: AppSettings) {
  const next = cloneAppSettings(settings)
  next.regularFontFamily = DEFAULT_APP_SETTINGS.regularFontFamily
  next.monospaceFontFamily = DEFAULT_APP_SETTINGS.monospaceFontFamily
  next.baseFontSize = DEFAULT_APP_SETTINGS.baseFontSize
  next.codeFontSize = DEFAULT_APP_SETTINGS.codeFontSize
  next.headingFontScales = [...DEFAULT_APP_SETTINGS.headingFontScales]
  next.headingFontBold = [...DEFAULT_APP_SETTINGS.headingFontBold]
  next.calloutTitleFontSize = DEFAULT_APP_SETTINGS.calloutTitleFontSize
  next.fontLigatures = DEFAULT_APP_SETTINGS.fontLigatures
  return next
}

function FontSizeControl({
  defaultValue,
  id,
  label,
  value,
  onValueChange,
}: FontSizeControlProps) {
  return (
    <div className="settings-reset-row grid min-w-0 grid-cols-[auto_1fr_6rem] items-center gap-x-2 gap-y-1">
      <label
        className="col-span-2 truncate text-xs font-medium text-muted-foreground"
        htmlFor={id}
      >
        {label}
      </label>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Reset ${label.toLowerCase()} font size`}
              className="settings-reset-button justify-self-end"
              disabled={value === defaultValue}
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={() => onValueChange(defaultValue)}
            />
          }
        >
          <RotateCcwIcon />
        </TooltipTrigger>
        <TooltipContent>Reset {label.toLowerCase()} font size</TooltipContent>
      </Tooltip>
      <Slider
        aria-label={`${label} font size`}
        className="col-span-2"
        max={MAX_TYPOGRAPHY_FONT_SIZE}
        min={MIN_TYPOGRAPHY_FONT_SIZE}
        step={FONT_SIZE_STEP}
        value={[value]}
        onValueChange={(next) => {
          const raw = typeof next === "number" ? next : next[0]
          if (raw !== undefined) onValueChange(normalizedFontSize(raw))
        }}
      />
      <NumberField.Root
        id={id}
        className="relative"
        format={{ maximumFractionDigits: 1 }}
        max={MAX_TYPOGRAPHY_FONT_SIZE}
        min={MIN_TYPOGRAPHY_FONT_SIZE}
        step={FONT_SIZE_STEP}
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onValueChange(normalizedFontSize(nextValue))
          }
        }}
      >
        <NumberField.Input
          aria-label={`${label} font size in pixels`}
          aria-valuemax={MAX_TYPOGRAPHY_FONT_SIZE}
          aria-valuemin={MIN_TYPOGRAPHY_FONT_SIZE}
          aria-valuenow={value}
          className={`${NUMBER_INPUT_CLASS_NAME} pr-6`}
          role="spinbutton"
          onFocus={(event) => event.preventBaseUIHandler()}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey
            ) {
              return
            }
            event.preventDefault()
            event.currentTarget.blur()
          }}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">
          px
        </span>
      </NumberField.Root>
    </div>
  )
}

function HeadingScaleControl({
  bold,
  defaultBold,
  defaultValue,
  id,
  label,
  value,
  onBoldChange,
  onReset,
  onValueChange,
}: HeadingScaleControlProps) {
  return (
    <div className="settings-reset-row grid min-w-0 grid-cols-[auto_1fr_6rem] items-center gap-x-2 gap-y-1">
      <label
        className="col-span-2 truncate text-xs font-medium text-muted-foreground"
        htmlFor={id}
      >
        {label}
      </label>
      <div className="flex items-center gap-1 justify-self-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`${label} bold`}
                aria-pressed={bold}
                className="rounded-full"
                size="icon-xs"
                type="button"
                variant={bold ? "secondary" : "ghost"}
                onClick={() => onBoldChange(!bold)}
              />
            }
          >
            <BoldIcon />
          </TooltipTrigger>
          <TooltipContent>{label} bold</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Reset ${label} typography`}
                className="settings-reset-button"
                disabled={value === defaultValue && bold === defaultBold}
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={onReset}
              />
            }
          >
            <RotateCcwIcon />
          </TooltipTrigger>
          <TooltipContent>Reset {label} typography</TooltipContent>
        </Tooltip>
      </div>
      <Slider
        aria-label={`${label} scale relative to base`}
        className="col-span-2"
        max={MAX_HEADING_FONT_SCALE}
        min={MIN_HEADING_FONT_SCALE}
        step={HEADING_SCALE_STEP}
        value={[value]}
        onValueChange={(next) => {
          const raw = typeof next === "number" ? next : next[0]
          if (raw !== undefined) onValueChange(normalizedHeadingScale(raw))
        }}
      />
      <NumberField.Root
        id={id}
        className="relative"
        format={{ maximumFractionDigits: 2 }}
        max={MAX_HEADING_FONT_SCALE}
        min={MIN_HEADING_FONT_SCALE}
        step={HEADING_SCALE_STEP}
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onValueChange(normalizedHeadingScale(nextValue))
          }
        }}
      >
        <NumberField.Input
          aria-label={`${label} scale relative to base`}
          aria-valuemax={MAX_HEADING_FONT_SCALE}
          aria-valuemin={MIN_HEADING_FONT_SCALE}
          aria-valuenow={value}
          className={`${NUMBER_INPUT_CLASS_NAME} pr-5`}
          role="spinbutton"
          onFocus={(event) => event.preventBaseUIHandler()}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey
            ) {
              return
            }
            event.preventDefault()
            event.currentTarget.blur()
          }}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">
          ×
        </span>
      </NumberField.Root>
    </div>
  )
}

export function TypographyPreviewWorkspace({
  isSaving = false,
  settings,
  onCancel,
  onDockHeightChange,
  onDraftChange,
  onSave,
}: TypographyPreviewWorkspaceProps) {
  const [draft, setDraft] = React.useState(() => cloneAppSettings(settings))
  const draftRef = React.useRef(draft)
  const [submitting, setSubmitting] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const dockRef = React.useRef<HTMLElement>(null)
  const saving = isSaving || submitting

  const updateDraft = React.useCallback(
    (change: Partial<AppSettings>) => {
      const next = cloneAppSettings(draftRef.current)
      Object.assign(next, change)
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
      console.error("Unable to save typography settings", error)
      setSaveError("Typography settings could not be saved. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }, [onSave, saving])

  React.useLayoutEffect(() => {
    const dock = dockRef.current
    if (!dock || !onDockHeightChange) return
    const reportHeight = () =>
      onDockHeightChange(dock.getBoundingClientRect().height)
    reportHeight()
    const observer = new ResizeObserver(reportHeight)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      onDockHeightChange(0)
    }
  }, [onDockHeightChange])

  React.useLayoutEffect(() => {
    workspaceRef.current?.focus({ preventScroll: true })
  }, [])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === "Escape") {
        const expandedCombobox =
          event.target instanceof Element
            ? event.target.closest('[role="combobox"][aria-expanded="true"]')
            : null
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

  const updateHeadingScale = (index: number, value: number) => {
    const [h1, h2, h3, h4, h5, h6] = draftRef.current.headingFontScales
    const headingFontScales: AppSettings["headingFontScales"] = [
      index === 0 ? value : h1,
      index === 1 ? value : h2,
      index === 2 ? value : h3,
      index === 3 ? value : h4,
      index === 4 ? value : h5,
      index === 5 ? value : h6,
    ]
    updateDraft({ headingFontScales })
  }

  const updateHeadingBold = (index: number, value: boolean) => {
    const [h1, h2, h3, h4, h5, h6] = draftRef.current.headingFontBold
    const headingFontBold: AppSettings["headingFontBold"] = [
      index === 0 ? value : h1,
      index === 1 ? value : h2,
      index === 2 ? value : h3,
      index === 3 ? value : h4,
      index === 4 ? value : h5,
      index === 5 ? value : h6,
    ]
    updateDraft({ headingFontBold })
  }

  return (
    <div
      ref={workspaceRef}
      aria-label="Typography preview workspace"
      className="pointer-events-none absolute inset-0 z-50 flex min-h-0 flex-col outline-none"
      role="region"
      tabIndex={-1}
    >
      <div aria-hidden="true" className="min-h-0 flex-1" />

      <section
        ref={dockRef}
        aria-label="Typography controls"
        className="pointer-events-auto max-h-[48dvh] shrink-0 overflow-y-auto border-t border-border bg-popover text-popover-foreground"
      >
        <div className="mx-auto grid w-full max-w-[1180px] gap-4 px-5 py-4">
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

          <div className="grid gap-5 lg:grid-cols-[minmax(15rem,0.75fr)_minmax(0,2fr)]">
            <section
              aria-labelledby="typography-preview-fonts-title"
              className="grid content-start gap-3"
            >
              <h3 id="typography-preview-fonts-title" className="sr-only">
                Font Families
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                <FontFamilyPicker
                  id="typography-preview-regular-font"
                  label="Regular Font"
                  purpose="regular"
                  value={draft.regularFontFamily}
                  onValueChange={(regularFontFamily) =>
                    updateDraft({ regularFontFamily })
                  }
                />
                <FontFamilyPicker
                  id="typography-preview-monospace-font"
                  label="Monospace Font"
                  purpose="monospace"
                  value={draft.monospaceFontFamily}
                  onValueChange={(monospaceFontFamily) =>
                    updateDraft({ monospaceFontFamily })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 px-3 py-2">
                <label
                  className="text-xs font-medium"
                  htmlFor="typography-preview-ligatures"
                >
                  Code Ligatures
                </label>
                <Switch
                  id="typography-preview-ligatures"
                  aria-label="Code ligatures"
                  checked={draft.fontLigatures}
                  size="sm"
                  onCheckedChange={(fontLigatures) =>
                    updateDraft({ fontLigatures })
                  }
                />
              </div>
            </section>

            <section
              aria-labelledby="typography-preview-sizes-title"
              className="grid content-start gap-3"
            >
              <h3
                id="typography-preview-sizes-title"
                className="text-sm font-medium"
              >
                Font Sizes
              </h3>
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                <FontSizeControl
                  defaultValue={DEFAULT_APP_SETTINGS.baseFontSize}
                  id="typography-preview-base-size"
                  label="Base"
                  value={draft.baseFontSize}
                  onValueChange={(baseFontSize) =>
                    updateDraft({ baseFontSize })
                  }
                />
                <FontSizeControl
                  defaultValue={DEFAULT_APP_SETTINGS.codeFontSize}
                  id="typography-preview-code-size"
                  label="Monospace"
                  value={draft.codeFontSize}
                  onValueChange={(codeFontSize) =>
                    updateDraft({ codeFontSize })
                  }
                />
                <FontSizeControl
                  defaultValue={DEFAULT_APP_SETTINGS.calloutTitleFontSize}
                  id="typography-preview-callout-title-size"
                  label="Callout Title"
                  value={draft.calloutTitleFontSize}
                  onValueChange={(calloutTitleFontSize) =>
                    updateDraft({ calloutTitleFontSize })
                  }
                />
                {draft.headingFontScales.map((fontScale, index) => (
                  <HeadingScaleControl
                    key={index}
                    bold={draft.headingFontBold[index]!}
                    defaultBold={DEFAULT_APP_SETTINGS.headingFontBold[index]!}
                    defaultValue={
                      DEFAULT_APP_SETTINGS.headingFontScales[index]!
                    }
                    id={`typography-preview-heading-${index + 1}-scale`}
                    label={`H${index + 1}`}
                    value={fontScale}
                    onBoldChange={(bold) => updateHeadingBold(index, bold)}
                    onReset={() => {
                      updateHeadingScale(
                        index,
                        DEFAULT_APP_SETTINGS.headingFontScales[index]!
                      )
                      updateHeadingBold(
                        index,
                        DEFAULT_APP_SETTINGS.headingFontBold[index]!
                      )
                    }}
                    onValueChange={(value) => updateHeadingScale(index, value)}
                  />
                ))}
              </div>
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
              disabled={typographySettingsMatch(draft, DEFAULT_APP_SETTINGS)}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => updateDraft(typographyDefaults(draftRef.current))}
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

export default TypographyPreviewWorkspace
