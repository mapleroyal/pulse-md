import * as React from "react"
import { NumberField } from "@base-ui/react/number-field"
import { PlayIcon, RotateCcwIcon } from "lucide-react"

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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  LAUNCH_TRANSITION_EASINGS,
  LAUNCH_TRANSITION_STRATEGIES,
  LAUNCH_TRANSITION_TIME_STEP_MS,
  launchTransitionCssEasing,
  MAX_LAUNCH_TRANSITION_DELAY_MS,
  MAX_LAUNCH_TRANSITION_DURATION_MS,
  MIN_LAUNCH_TRANSITION_DELAY_MS,
  MIN_LAUNCH_TRANSITION_DURATION_MS,
  parseLaunchTransitionCubicBezier,
  type AppPlatform,
  type AppSettings,
  type LaunchTransitionEasing,
  type LaunchTransitionSettings,
  type LaunchTransitionStrategy,
} from "@/shared/contracts"

const DEMO_WINDOW_APPEARANCE_DELAY_MS = 450
const DEMO_TRANSLUCENCY = 0.8
const DEMO_BLUR_RADIUS_PX = 8
const NUMBER_INPUT_CLASS_NAME =
  "h-8 w-full min-w-0 rounded-3xl border border-transparent bg-input/50 py-1 pl-3 text-right text-xs tabular-nums transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

const easingLabels: Record<LaunchTransitionEasing, string> = {
  "gentle-ease-out": "Gentle Ease-Out",
  "material-ease-out": "Material Ease-Out",
  "ease-out": "CSS Ease-Out",
  "ease-in-out": "Ease-In-Out",
  ease: "CSS Ease",
  linear: "Linear",
  custom: "Custom Cubic-Bezier",
}

const strategyLabels: Record<LaunchTransitionStrategy, string> = {
  tint: "Tint Reveal · Blur Preloaded",
  "tint-blur": "Tint and Blur Together",
  cover: "Opaque Cover Crossfade",
}

export interface LaunchTransitionPreviewWorkspaceProps {
  isSaving?: boolean
  platform: AppPlatform
  settings: AppSettings
  onCancel: () => void
  onSave: (settings: AppSettings) => void | Promise<void>
}

interface TimeControlProps {
  defaultValue: number
  id: string
  label: string
  max: number
  min: number
  value: number
  onValueChange: (value: number) => void
}

function normalizedTime(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function TimeControl({
  defaultValue,
  id,
  label,
  max,
  min,
  value,
  onValueChange,
}: TimeControlProps) {
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
              aria-label={`Reset ${label.toLowerCase()}`}
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
        <TooltipContent>Reset {label.toLowerCase()}</TooltipContent>
      </Tooltip>
      <Slider
        aria-label={label}
        className="col-span-2"
        max={max}
        min={min}
        step={LAUNCH_TRANSITION_TIME_STEP_MS}
        value={[value]}
        onValueChange={(next) => {
          const raw = typeof next === "number" ? next : next[0]
          if (raw !== undefined) {
            onValueChange(normalizedTime(raw, min, max))
          }
        }}
      />
      <NumberField.Root
        id={id}
        className="relative"
        max={max}
        min={min}
        step={LAUNCH_TRANSITION_TIME_STEP_MS}
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onValueChange(normalizedTime(nextValue, min, max))
          }
        }}
      >
        <NumberField.Input
          aria-label={`${label} in milliseconds`}
          aria-valuemax={max}
          aria-valuemin={min}
          aria-valuenow={value}
          className={`${NUMBER_INPUT_CLASS_NAME} pr-8`}
          role="spinbutton"
          onFocus={(event) => event.preventBaseUIHandler()}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey
            ) {
              event.currentTarget.blur()
            }
          }}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">
          ms
        </span>
      </NumberField.Root>
    </div>
  )
}

function transitionSettingsMatch(
  left: LaunchTransitionSettings,
  right: LaunchTransitionSettings
) {
  return (
    left.customEasing === right.customEasing &&
    left.delayMs === right.delayMs &&
    left.durationMs === right.durationMs &&
    left.easing === right.easing &&
    left.strategy === right.strategy
  )
}

function cloneLaunchTransition(
  transition: LaunchTransitionSettings
): LaunchTransitionSettings {
  return { ...transition }
}

export function LaunchTransitionPreviewWorkspace({
  isSaving = false,
  platform,
  settings,
  onCancel,
  onSave,
}: LaunchTransitionPreviewWorkspaceProps) {
  const [draft, setDraft] = React.useState(() => {
    const initialDraft = cloneAppSettings(settings)
    initialDraft.launchTransition = cloneLaunchTransition(
      initialDraft.launchTransition
    )
    return initialDraft
  })
  const draftRef = React.useRef(draft)
  const [customEasingInput, setCustomEasingInput] = React.useState(
    settings.launchTransition.customEasing
  )
  const [run, setRun] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const windowRef = React.useRef<HTMLDivElement>(null)
  const coverRef = React.useRef<HTMLDivElement>(null)
  const saving = isSaving || submitting
  const customEasingValid =
    draft.launchTransition.easing !== "custom" ||
    parseLaunchTransitionCubicBezier(customEasingInput) !== null
  const defaultLaunchTransition = cloneLaunchTransition(
    DEFAULT_APP_SETTINGS.launchTransition
  )

  const updateTransition = React.useCallback(
    (change: Partial<LaunchTransitionSettings>) => {
      const next = cloneAppSettings(draftRef.current)
      next.launchTransition = { ...next.launchTransition, ...change }
      draftRef.current = next
      setDraft(next)
      setRun((current) => current + 1)
    },
    []
  )

  const save = React.useCallback(async () => {
    if (saving || !customEasingValid) return
    setSaveError(null)
    setSubmitting(true)
    try {
      await onSave(cloneAppSettings(draftRef.current))
    } catch (error) {
      console.error("Unable to save launch transition settings", error)
      setSaveError(
        "Launch transition settings could not be saved. Please try again."
      )
    } finally {
      setSubmitting(false)
    }
  }, [customEasingValid, onSave, saving])

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

  React.useEffect(() => {
    const mockWindow = windowRef.current
    const cover = coverRef.current
    if (!mockWindow || !cover) return
    const transition = draftRef.current.launchTransition
    const previewStrategy =
      platform === "linux" && transition.strategy === "tint-blur"
        ? "cover"
        : transition.strategy
    const easing = launchTransitionCssEasing(transition)
    const transitionDisabled =
      !transition.enabled || transition.durationMs === 0
    const timers: number[] = []
    const schedule = (callback: () => void, delay: number) => {
      timers.push(window.setTimeout(callback, delay))
    }
    const finalBackground = `color-mix(in srgb, var(--document-background) ${(1 - DEMO_TRANSLUCENCY) * 100}%, transparent)`

    mockWindow.style.transition = "none"
    mockWindow.style.opacity = "0"
    mockWindow.style.transform = "scale(0.992)"
    mockWindow.style.background = "var(--document-background)"
    mockWindow.style.backdropFilter =
      previewStrategy === "tint"
        ? `blur(${DEMO_BLUR_RADIUS_PX}px)`
        : "blur(0px)"
    mockWindow.style.setProperty(
      "-webkit-backdrop-filter",
      mockWindow.style.backdropFilter
    )
    cover.style.display = previewStrategy === "cover" ? "block" : "none"
    cover.style.transition = "none"
    cover.style.opacity = "1"
    if (previewStrategy === "cover") {
      mockWindow.style.background = finalBackground
      mockWindow.style.backdropFilter = `blur(${DEMO_BLUR_RADIUS_PX}px)`
      mockWindow.style.setProperty(
        "-webkit-backdrop-filter",
        mockWindow.style.backdropFilter
      )
    }
    schedule(() => {
      mockWindow.style.opacity = "1"
      mockWindow.style.transform = "scale(1)"
      mockWindow.getBoundingClientRect()
      if (transitionDisabled) {
        cover.style.display = "none"
        cover.style.opacity = "0"
        mockWindow.style.background = finalBackground
        mockWindow.style.backdropFilter = `blur(${DEMO_BLUR_RADIUS_PX}px)`
        mockWindow.style.setProperty(
          "-webkit-backdrop-filter",
          mockWindow.style.backdropFilter
        )
        return
      }
      schedule(() => {
        if (previewStrategy === "cover") {
          cover.style.transition = `opacity ${transition.durationMs}ms ${easing}`
          cover.style.opacity = "0"
        } else {
          mockWindow.style.transition =
            previewStrategy === "tint-blur"
              ? `background-color ${transition.durationMs}ms ${easing}, backdrop-filter ${transition.durationMs}ms ${easing}, -webkit-backdrop-filter ${transition.durationMs}ms ${easing}`
              : `background-color ${transition.durationMs}ms ${easing}`
          mockWindow.style.background = finalBackground
          if (previewStrategy === "tint-blur") {
            mockWindow.style.backdropFilter = `blur(${DEMO_BLUR_RADIUS_PX}px)`
            mockWindow.style.setProperty(
              "-webkit-backdrop-filter",
              mockWindow.style.backdropFilter
            )
          }
        }
      }, transition.delayMs)
    }, DEMO_WINDOW_APPEARANCE_DELAY_MS)

    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [platform, run])

  const resetAll = () => {
    const launchTransition = {
      ...defaultLaunchTransition,
      enabled: draftRef.current.launchTransition.enabled,
    }
    setCustomEasingInput(launchTransition.customEasing)
    updateTransition(launchTransition)
  }

  return (
    <div
      ref={workspaceRef}
      aria-label="Launch transition preview workspace"
      className="pointer-events-none absolute inset-0 z-30 flex min-h-0 flex-col pt-[var(--window-chrome-height)] outline-none"
      role="region"
      tabIndex={-1}
    >
      <div className="launch-transition-preview pointer-events-auto relative min-h-0 flex-1 overflow-hidden bg-[var(--document-background)] p-5">
        <div className="launch-transition-preview-stage relative mx-auto h-full min-h-64 w-full max-w-5xl overflow-hidden rounded-3xl border border-border/70">
          <div className="launch-preview-shape launch-preview-shape-a">A</div>
          <div className="launch-preview-shape launch-preview-shape-b">B</div>
          <div className="launch-preview-line launch-preview-line-a" />
          <div className="launch-preview-line launch-preview-line-b" />

          <div
            ref={windowRef}
            className="launch-preview-window absolute inset-[10%] overflow-hidden rounded-2xl border border-border/70 text-[var(--document-foreground)] shadow-2xl"
          >
            <div
              ref={coverRef}
              className="absolute inset-0 z-10 bg-[var(--document-background)]"
            />
            <div className="relative z-20 grid h-11 grid-cols-[4.5rem_1fr_4.5rem] items-center border-b border-border/70">
              <div className="flex gap-1.5 pl-4" aria-hidden="true">
                <span
                  className="size-2.5 rounded-full bg-foreground/25"
                  data-corner-shape="round"
                />
                <span
                  className="size-2.5 rounded-full bg-foreground/25"
                  data-corner-shape="round"
                />
                <span
                  className="size-2.5 rounded-full bg-foreground/25"
                  data-corner-shape="round"
                />
              </div>
              <span className="truncate text-center text-xs text-foreground/70">
                markdown-test.md
              </span>
            </div>
            <div className="relative z-20 mx-auto grid max-w-2xl gap-3 px-[10%] py-[7%]">
              <span className="h-4 w-2/5 rounded-full bg-foreground/65" />
              <span className="mt-2 h-2 w-full rounded-full bg-foreground/30" />
              <span className="h-2 w-4/5 rounded-full bg-foreground/30" />
              <span className="h-2 w-3/5 rounded-full bg-foreground/30" />
              <div className="my-3 grid gap-2 rounded-xl bg-foreground/7 p-4">
                <span className="h-2 w-3/4 rounded-full bg-[var(--syntax-function-color)]/60" />
                <span className="h-2 w-1/2 rounded-full bg-[var(--syntax-function-color)]/60" />
                <span className="h-2 w-2/3 rounded-full bg-[var(--syntax-function-color)]/60" />
              </div>
              <span className="h-2 w-2/3 rounded-full bg-foreground/30" />
              <span className="h-2 w-4/5 rounded-full bg-foreground/30" />
            </div>
          </div>
        </div>
      </div>

      <section
        aria-label="Launch transition controls"
        className="pointer-events-auto z-50 max-h-[48dvh] shrink-0 overflow-y-auto border-t border-border bg-popover text-popover-foreground"
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
              disabled={saving || !customEasingValid}
              size="sm"
              type="button"
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>

          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
            <TimeControl
              defaultValue={DEFAULT_APP_SETTINGS.launchTransition.durationMs}
              id="launch-transition-duration"
              label="Duration"
              max={MAX_LAUNCH_TRANSITION_DURATION_MS}
              min={MIN_LAUNCH_TRANSITION_DURATION_MS}
              value={draft.launchTransition.durationMs}
              onValueChange={(durationMs) => updateTransition({ durationMs })}
            />
            <TimeControl
              defaultValue={DEFAULT_APP_SETTINGS.launchTransition.delayMs}
              id="launch-transition-delay"
              label="Delay"
              max={MAX_LAUNCH_TRANSITION_DELAY_MS}
              min={MIN_LAUNCH_TRANSITION_DELAY_MS}
              value={draft.launchTransition.delayMs}
              onValueChange={(delayMs) => updateTransition({ delayMs })}
            />
            <Field className="content-start gap-1.5" orientation="vertical">
              <FieldLabel
                htmlFor="launch-transition-easing"
                className="text-xs text-muted-foreground"
              >
                Easing
              </FieldLabel>
              <FieldContent>
                <Select
                  value={draft.launchTransition.easing}
                  onValueChange={(easing) =>
                    updateTransition({
                      easing: easing as LaunchTransitionEasing,
                    })
                  }
                >
                  <SelectTrigger
                    id="launch-transition-easing"
                    aria-label="Launch transition easing"
                    className="min-w-44"
                  >
                    <SelectValue>
                      {easingLabels[draft.launchTransition.easing]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {LAUNCH_TRANSITION_EASINGS.map((easing) => (
                        <SelectItem key={easing} value={easing}>
                          {easingLabels[easing]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FieldContent>
            </Field>
            <Field className="content-start gap-1.5" orientation="vertical">
              <FieldLabel
                htmlFor="launch-transition-strategy"
                className="text-xs text-muted-foreground"
              >
                Transition Strategy
              </FieldLabel>
              <FieldContent>
                <Select
                  value={draft.launchTransition.strategy}
                  onValueChange={(strategy) =>
                    updateTransition({
                      strategy: strategy as LaunchTransitionStrategy,
                    })
                  }
                >
                  <SelectTrigger
                    id="launch-transition-strategy"
                    aria-label="Launch transition strategy"
                    className="min-w-56"
                  >
                    <SelectValue>
                      {strategyLabels[draft.launchTransition.strategy]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {LAUNCH_TRANSITION_STRATEGIES.map((strategy) => (
                        <SelectItem key={strategy} value={strategy}>
                          {strategyLabels[strategy]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {platform === "win32" ? (
                  <FieldDescription>
                    Tint and Blur Together animates the native blur radius with
                    the same timing as the renderer tint reveal.
                  </FieldDescription>
                ) : null}
                {platform === "linux" ? (
                  <FieldDescription>
                    Linux compositor blur is already settled when Pulse MD
                    appears, so Tint and Blur Together uses the opaque-cover
                    reveal on this platform.
                  </FieldDescription>
                ) : null}
              </FieldContent>
            </Field>
          </div>

          {draft.launchTransition.easing === "custom" ? (
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Custom Easing
              <Input
                aria-invalid={!customEasingValid}
                aria-label="Custom launch transition easing"
                className="max-w-md font-mono"
                spellCheck={false}
                value={customEasingInput}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setCustomEasingInput(value)
                  if (parseLaunchTransitionCubicBezier(value)) {
                    updateTransition({ customEasing: value })
                  }
                }}
              />
              {!customEasingValid ? (
                <span className="text-xs text-destructive" role="alert">
                  Enter cubic-bezier(x1, y1, x2, y2) with values from 0 to 1.
                </span>
              ) : null}
            </label>
          ) : null}

          <div className="flex min-h-8 items-center justify-between gap-3">
            {saveError ? (
              <p className="text-xs text-destructive" role="alert">
                {saveError}
              </p>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setRun((current) => current + 1)}
              >
                <PlayIcon data-icon="inline-start" />
                Replay
              </Button>
              <Button
                disabled={transitionSettingsMatch(
                  draft.launchTransition,
                  defaultLaunchTransition
                )}
                size="sm"
                type="button"
                variant="ghost"
                onClick={resetAll}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Reset all
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

export default LaunchTransitionPreviewWorkspace
