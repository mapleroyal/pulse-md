import * as React from "react"
import {
  BlendIcon,
  BlocksIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  DownloadIcon,
  EllipsisIcon,
  FileTextIcon,
  FileJson2Icon,
  KeyboardIcon,
  MinusIcon,
  PaletteIcon,
  PanelTopIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  TypeIcon,
  UploadIcon,
} from "lucide-react"

import "@/app/settings-dialog.css"

import { AppearanceProfileControl } from "@/app/AppearanceProfileControl"
import { KeyboardShortcutsPanel } from "@/app/KeyboardShortcutsPanel"
import { settingsSaveErrorMessage } from "@/app/settings-transfer-errors"
import { ThemePreview } from "@/app/ThemePreview"
import { ThemeModeControl } from "@/app/ThemeModeControl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  BACKGROUND_BLUR_RADIUS_STEP,
  BACKGROUND_TRANSLUCENCY_STEP,
  cloneAppSettings,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SETTINGS_TRANSFER_OPTIONS,
  MAX_BACKGROUND_BLUR_RADIUS,
  MAX_BACKGROUND_TRANSLUCENCY,
  MAX_SOURCE_INDENT_SIZE,
  MAX_ZOOM_FACTOR,
  MIN_BACKGROUND_BLUR_RADIUS,
  MIN_BACKGROUND_TRANSLUCENCY,
  MIN_SOURCE_INDENT_SIZE,
  MIN_ZOOM_FACTOR,
  ZOOM_FACTOR_STEP,
  type AppPlatform,
  type AppSettings,
  type EditorMode,
  type FormattingBarPosition,
  type ResolvedAppearance,
  type SourceIndentation,
  type SettingsTransferOptions,
  type SettingsTransferProfileSummary,
  type TabVisibilityMode,
  type TabWheelScrollDirection,
  type TopRightControlKey,
  type WindowProfilesSnapshot,
} from "@/shared/contracts"

const MIN_CONTENT_WIDTH = 480
const MAX_CONTENT_WIDTH = 1_600
const CONTENT_WIDTH_STEP = 20
const NO_DEFAULT_PROFILE = "__no-default-profile__"
const ZOOM_PERCENT_STEP = ZOOM_FACTOR_STEP * 100
const MIN_BACKGROUND_BLUR_RADIUS_VALUE = MIN_BACKGROUND_BLUR_RADIUS
const MAX_BACKGROUND_BLUR_RADIUS_VALUE = MAX_BACKGROUND_BLUR_RADIUS
const MIN_BACKGROUND_TRANSLUCENCY_PERCENT = MIN_BACKGROUND_TRANSLUCENCY * 100
const MAX_BACKGROUND_TRANSLUCENCY_PERCENT = MAX_BACKGROUND_TRANSLUCENCY * 100
const BACKGROUND_TRANSLUCENCY_PERCENT_STEP = BACKGROUND_TRANSLUCENCY_STEP * 100
const tabVisibilityLabels: Record<TabVisibilityMode, string> = {
  always: "Always",
  "multiple-tabs": "With Multiple Tabs",
  mouseover: "On Mouseover",
  "formatting-bar": "With Formatting Toolbar",
  hidden: "Hidden",
}
const tabWheelScrollDirectionLabels: Record<TabWheelScrollDirection, string> = {
  "down-right": "Down Scrolls Right",
  "down-left": "Down Scrolls Left",
}
const formattingBarPositionLabels: Record<FormattingBarPosition, string> = {
  left: "Left",
  center: "Center",
  right: "Right",
}
const pathDisplayLabels = {
  path: "Full Path",
  filename: "Filename Only",
} as const
const editorModeLabels: Record<EditorMode, string> = {
  live: "Rendered",
  source: "Raw Markdown",
}
const sourceIndentationLabels: Record<SourceIndentation, string> = {
  spaces: "Spaces",
  tabs: "Tab Character",
}

interface SettingsDialogProps {
  activeScheme: ResolvedAppearance
  backgroundEffectSupported: boolean
  keyboardShortcutsOpen: boolean
  nestedDialog?: React.ReactNode
  settings: AppSettings
  open: boolean
  platform: AppPlatform
  onCancel: () => void
  onCustomizeActiveTabIndicator: (settings: AppSettings) => void
  onCustomizeLaunchTransition: (settings: AppSettings) => void
  onCustomizeTypography: (settings: AppSettings) => void
  onExternalZoomHandlerChange: (
    handler: ((zoomFactor: number) => void) | null
  ) => void
  onLaunchWindowProfile: (settings: AppSettings) => Promise<void> | void
  onManageScratches: (settings: AppSettings) => void
  onManageWindowProfiles: (settings: AppSettings) => void
  onNavigateBack: () => void
  onOpenKeyboardShortcuts: () => void
  onPreview: (settings: AppSettings) => void
  onSave: (
    settings: AppSettings,
    strategy?: "merge" | "replace",
    settingsImport?: {
      importId: string
      options: SettingsTransferOptions
    }
  ) => Promise<void>
  onSaveHandlerChange: (handler: (() => Promise<boolean>) | null) => void
}

type SettingsSection =
  | "theme"
  | "background"
  | "chrome"
  | "extensions"
  | "miscellaneous"
  | "importExport"
  | "windowProfiles"

type SettingsTransferOperation = "export" | "import"

interface SettingsTransferFeedback {
  message: string
  tone: "error" | "success"
}

interface StagedSettingsImport {
  importId: string
  importedDefaultProfileId: string | null
  profiles: readonly SettingsTransferProfileSummary[]
  scratchCount: number
}

const INITIAL_OPEN_SECTIONS: Record<SettingsSection, boolean> = {
  theme: false,
  background: false,
  chrome: false,
  extensions: false,
  miscellaneous: false,
  importExport: false,
  windowProfiles: false,
}

const markdownExtensionOptions = [
  {
    key: "superscriptAndSubscript",
    id: "extension-superscript-and-subscript",
    label: "Superscript and Subscript",
    description: "Render Pandoc-style ^superscript^ and ~subscript~ syntax.",
  },
  {
    key: "emojiRecognition",
    id: "extension-emoji-recognition",
    label: "Emoji Shortcode Recognition",
    description: "Recognize :shortcode: tokens in Markdown.",
  },
  {
    key: "emojiExpansion",
    id: "extension-emoji-expansion",
    label: "Emoji Shortcode Expansion",
    description:
      "Requires recognition. Display shortcodes as Unicode emoji without changing the source.",
  },
  {
    key: "footnotes",
    id: "extension-footnotes",
    label: "Footnotes",
    description: "Render [^label] references and definitions.",
  },
  {
    key: "definitionLists",
    id: "extension-definition-lists",
    label: "Definition Lists",
    description: "Render colon- and tilde-marked definition lists.",
  },
  {
    key: "latex",
    id: "extension-latex",
    label: "LaTeX Math",
    description: "Render LaTeX expressions with KaTeX.",
  },
  {
    key: "mermaid",
    id: "extension-mermaid",
    label: "Mermaid Diagrams",
    description: "Render static Mermaid fenced code blocks as diagrams.",
  },
  {
    key: "yamlFrontMatter",
    id: "extension-yaml-front-matter",
    label: "YAML Front Matter",
    description: "Recognize a YAML metadata block at the start of a document.",
  },
  {
    key: "sanitizedHtml",
    id: "extension-sanitized-html",
    label: "Sanitized HTML",
    description:
      "Render a conservative set of safe HTML without scripts or active content.",
  },
] as const satisfies ReadonlyArray<{
  key: keyof AppSettings["markdownExtensions"]
  id: string
  label: string
  description: string
}>

const topRightControlOptions = [
  {
    key: "navigation",
    id: "top-control-navigation",
    label: "Back and Forward",
  },
  {
    key: "viewMode",
    id: "top-control-view-mode",
    label: "View Mode",
  },
  {
    key: "find",
    id: "top-control-find",
    label: "Find",
  },
  {
    key: "outline",
    id: "top-control-outline",
    label: "Document Outline",
  },
  {
    key: "formattingToolbar",
    id: "top-control-formatting-toolbar",
    label: "Formatting Toolbar",
  },
  {
    key: "settings",
    id: "top-control-settings",
    label: "Settings",
  },
] as const satisfies ReadonlyArray<{
  key: TopRightControlKey
  id: string
  label: string
}>

interface ResetSettingButtonProps {
  className?: string
  disabled: boolean
  label: string
  onReset: () => void
}

function ResetSettingButton({
  className,
  disabled,
  label,
  onReset,
}: ResetSettingButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Reset ${label}`}
            className={cn("settings-reset-button", className)}
            disabled={disabled}
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={onReset}
          />
        }
      >
        <RotateCcwIcon />
      </TooltipTrigger>
      <TooltipContent>Reset {label}</TooltipContent>
    </Tooltip>
  )
}

function ResettableFieldLabel({
  children,
  defaultValue,
  disabled = false,
  htmlFor,
  label,
  onReset,
  value,
}: {
  children: React.ReactNode
  defaultValue: unknown
  disabled?: boolean
  htmlFor?: string
  label: string
  onReset: () => void
  value: unknown
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <FieldLabel className="min-w-0" htmlFor={htmlFor}>
        {children}
      </FieldLabel>
      <ResetSettingButton
        disabled={disabled || Object.is(value, defaultValue)}
        label={label}
        onReset={onReset}
      />
    </div>
  )
}

function appearanceProfilesMatch(
  left: AppSettings["themeByScheme"][ResolvedAppearance],
  right: AppSettings["themeByScheme"][ResolvedAppearance]
) {
  return (
    left.backgroundId === right.backgroundId &&
    left.syntaxThemeId === right.syntaxThemeId &&
    (left.backgroundId !== "custom" ||
      left.customBackgroundColor === right.customBackgroundColor)
  )
}

function resettableAppSettingsMatch(left: AppSettings, right: AppSettings) {
  return (
    JSON.stringify({ ...left, customThemePresets: [] }) ===
    JSON.stringify({ ...right, customThemePresets: [] })
  )
}

function clampContentWidth(value: number) {
  return Math.min(MAX_CONTENT_WIDTH, Math.max(MIN_CONTENT_WIDTH, value))
}

function clampSourceIndentSize(value: number) {
  return Math.min(
    MAX_SOURCE_INDENT_SIZE,
    Math.max(MIN_SOURCE_INDENT_SIZE, value)
  )
}

function clampZoomFactor(value: number) {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value))
}

function clampBackgroundTranslucency(value: number) {
  return Math.min(
    MAX_BACKGROUND_TRANSLUCENCY,
    Math.max(MIN_BACKGROUND_TRANSLUCENCY, value)
  )
}

function clampBackgroundBlurRadius(value: number) {
  return Math.min(
    MAX_BACKGROUND_BLUR_RADIUS,
    Math.max(MIN_BACKGROUND_BLUR_RADIUS, Math.round(value))
  )
}

function hasOpenNestedPopup() {
  return (
    document.querySelector(
      '[data-slot="select-content"][data-open], [data-slot="combobox-content"][data-open], [data-slot="dropdown-menu-content"][data-open], [data-slot="popover-content"][data-open]'
    ) !== null
  )
}

function formatZoomPercent(zoomFactor: number) {
  return String(Math.round(zoomFactor * 100))
}

function formatBackgroundTranslucencyPercent(translucency: number) {
  return String(Math.round(translucency * 100))
}

function formatBackgroundBlurRadius(radius: number) {
  return String(Math.round(radius))
}

function transferredSettingsFileName(filePath: string) {
  return filePath.split(/[\\/]/).at(-1) || "settings file"
}

function settingsTransferResourceSummary(
  profileCount: number,
  scratchCount: number
) {
  const resources = [
    profileCount > 0
      ? `${profileCount} ${profileCount === 1 ? "profile" : "profiles"}`
      : null,
    scratchCount > 0
      ? `${scratchCount} ${scratchCount === 1 ? "scratch" : "scratches"}`
      : null,
  ].filter((resource): resource is string => resource !== null)
  return resources.length > 0 ? ` with ${resources.join(" and ")}` : ""
}

function parsedInteger(value: string, fallback: number) {
  if (value.trim() === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

export default function SettingsDialog({
  activeScheme,
  backgroundEffectSupported,
  keyboardShortcutsOpen,
  nestedDialog,
  settings,
  open,
  platform,
  onCancel,
  onCustomizeActiveTabIndicator,
  onCustomizeLaunchTransition,
  onCustomizeTypography,
  onExternalZoomHandlerChange,
  onLaunchWindowProfile,
  onManageScratches,
  onManageWindowProfiles,
  onNavigateBack,
  onOpenKeyboardShortcuts,
  onPreview,
  onSave,
  onSaveHandlerChange,
}: SettingsDialogProps) {
  const [draftSettings, setDraftSettings] = React.useState(settings)
  const [syncedSettings, setSyncedSettings] = React.useState(settings)
  const [zoomPercentInput, setZoomPercentInput] = React.useState(
    formatZoomPercent(settings.zoomFactor)
  )
  const [backgroundTranslucencyInput, setBackgroundTranslucencyInput] =
    React.useState(
      formatBackgroundTranslucencyPercent(
        settings.backgroundEffect.translucency
      )
    )
  const [backgroundBlurRadiusInput, setBackgroundBlurRadiusInput] =
    React.useState(
      formatBackgroundBlurRadius(settings.backgroundEffect.blurRadius)
    )
  const [contentWidthInput, setContentWidthInput] = React.useState(
    String(settings.maxContentWidth)
  )
  const [sourceIndentSizeInput, setSourceIndentSizeInput] = React.useState(
    String(settings.sourceIndentSize)
  )
  const [previewSchemeOverride, setPreviewSchemeOverride] =
    React.useState<ResolvedAppearance | null>(null)
  const previewScheme = previewSchemeOverride ?? activeScheme
  const topControlsPosition = "top-right"
  const topControlsPositionLabel = "Top-Right"
  const backgroundEffectControlsEnabled =
    backgroundEffectSupported && draftSettings.backgroundEffect.enabled
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [settingsTransferOperation, setSettingsTransferOperation] =
    React.useState<SettingsTransferOperation | null>(null)
  const [settingsTransferFeedback, setSettingsTransferFeedback] =
    React.useState<SettingsTransferFeedback | null>(null)
  const [settingsTransferOptions, setSettingsTransferOptions] =
    React.useState<SettingsTransferOptions>(() => ({
      ...DEFAULT_SETTINGS_TRANSFER_OPTIONS,
    }))
  const [stagedSettingsImport, setStagedSettingsImport] =
    React.useState<StagedSettingsImport | null>(null)
  const [settingsSearchQuery, setSettingsSearchQuery] = React.useState("")
  const [openSections, setOpenSections] = React.useState(INITIAL_OPEN_SECTIONS)
  const [windowProfilesSnapshot, setWindowProfilesSnapshot] =
    React.useState<WindowProfilesSnapshot | null>(null)
  const [defaultWindowProfileDraft, setDefaultWindowProfileDraft] =
    React.useState<string | null>(settings.defaultWindowProfileId)
  const [windowProfilesPending, setWindowProfilesPending] = React.useState(true)
  const [windowProfilesError, setWindowProfilesError] = React.useState<
    string | null
  >(null)
  const currentWindowProfile = windowProfilesSnapshot?.profiles.find(
    ({ profile }) => profile.id === windowProfilesSnapshot.currentProfileId
  )?.profile
  const importedProfiles = React.useMemo(
    () =>
      settingsTransferOptions.profiles
        ? (stagedSettingsImport?.profiles.filter(
            ({ id }) =>
              !windowProfilesSnapshot?.profiles.some(
                ({ profile }) => profile.id === id
              )
          ) ?? [])
        : [],
    [
      settingsTransferOptions.profiles,
      stagedSettingsImport?.profiles,
      windowProfilesSnapshot?.profiles,
    ]
  )
  const settingsSearchTerms = React.useMemo(
    () =>
      settingsSearchQuery
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/u)
        .filter(Boolean),
    [settingsSearchQuery]
  )
  const settingsSearchActive = settingsSearchTerms.length > 0
  const savingRef = React.useRef(false)
  const settingsTransferOperationRef =
    React.useRef<SettingsTransferOperation | null>(null)
  const settingsTransferOptionsRef = React.useRef(settingsTransferOptions)
  const stagedSettingsImportRef = React.useRef(stagedSettingsImport)
  const replaceOnSaveRef = React.useRef(false)
  const savePromiseRef = React.useRef<Promise<boolean> | null>(null)
  const zoomInputEditedRef = React.useRef(false)
  const dialogContentRef = React.useRef<HTMLDivElement>(null)
  const settingsScrollRef = React.useRef<HTMLDivElement>(null)
  const settingsSearchInputRef = React.useRef<HTMLInputElement>(null)
  const settingsSearchStatusRef = React.useRef<HTMLParagraphElement>(null)
  const settingsSearchEmptyRef = React.useRef<HTMLParagraphElement>(null)
  const dialogScrollTopRef = React.useRef(0)
  const keyboardShortcutsTriggerRef = React.useRef<HTMLButtonElement>(null)
  const keyboardShortcutsWasOpenRef = React.useRef(keyboardShortcutsOpen)
  const restoreKeyboardShortcutsFocusRef = React.useRef(false)
  const defaultWindowProfileDirtyRef = React.useRef(false)
  const importedDefaultProfileUserEditedRef = React.useRef(false)
  const nestedPopupEscapePendingRef = React.useRef(false)

  const setNumericInputs = React.useCallback((nextSettings: AppSettings) => {
    setZoomPercentInput(formatZoomPercent(nextSettings.zoomFactor))
    setBackgroundTranslucencyInput(
      formatBackgroundTranslucencyPercent(
        nextSettings.backgroundEffect.translucency
      )
    )
    setBackgroundBlurRadiusInput(
      formatBackgroundBlurRadius(nextSettings.backgroundEffect.blurRadius)
    )
    setContentWidthInput(String(nextSettings.maxContentWidth))
    setSourceIndentSizeInput(String(nextSettings.sourceIndentSize))
  }, [])

  if (syncedSettings !== settings) {
    setSyncedSettings(settings)
    setDraftSettings(settings)
    setNumericInputs(settings)
  }

  const applyExternalZoom = React.useCallback((zoomFactor: number) => {
    zoomInputEditedRef.current = false
    setZoomPercentInput(formatZoomPercent(zoomFactor))
    setDraftSettings((current) =>
      Object.is(current.zoomFactor, zoomFactor)
        ? current
        : { ...current, zoomFactor }
    )
  }, [])

  const setSectionOpen = React.useCallback(
    (section: SettingsSection, sectionOpen: boolean) => {
      setOpenSections((current) =>
        current[section] === sectionOpen
          ? current
          : { ...current, [section]: sectionOpen }
      )
    },
    []
  )

  React.useLayoutEffect(() => {
    let restoreTimer: number | null = null
    const keyboardShortcutsWasOpen = keyboardShortcutsWasOpenRef.current
    keyboardShortcutsWasOpenRef.current = keyboardShortcutsOpen
    if (!open) {
      restoreKeyboardShortcutsFocusRef.current = false
      return
    }

    const settingsScroll = settingsScrollRef.current
    if (!settingsScroll) return

    if (keyboardShortcutsOpen) {
      if (!keyboardShortcutsWasOpen) {
        dialogScrollTopRef.current = settingsScroll.scrollTop
      }
    } else {
      if (keyboardShortcutsWasOpen) {
        restoreKeyboardShortcutsFocusRef.current = true
        const restoreScrollTop = dialogScrollTopRef.current
        settingsScroll.scrollTop = restoreScrollTop
        dialogContentRef.current?.focus({ preventScroll: true })
        settingsScroll.scrollTop = restoreScrollTop
        const restoreStartedAt = performance.now()
        const restoreTriggerFocus = () => {
          restoreTimer = null
          if (
            !open ||
            keyboardShortcutsWasOpenRef.current ||
            !settingsScroll.isConnected
          ) {
            restoreKeyboardShortcutsFocusRef.current = false
            return
          }

          const trigger = keyboardShortcutsTriggerRef.current
          const settingsSearchItem = trigger?.closest<HTMLElement>(
            "[data-settings-search-item]"
          )
          if (settingsSearchItem?.hidden) {
            restoreKeyboardShortcutsFocusRef.current = false
            return
          }
          const activeElement = document.activeElement
          settingsScroll.scrollTop = restoreScrollTop
          if (activeElement === trigger) {
            restoreKeyboardShortcutsFocusRef.current = false
            return
          }
          if (
            activeElement !== dialogContentRef.current &&
            activeElement !== document.body
          ) {
            restoreKeyboardShortcutsFocusRef.current = false
            return
          }

          const triggerStyle = trigger?.isConnected
            ? getComputedStyle(trigger)
            : null
          if (
            triggerStyle?.display !== "none" &&
            triggerStyle?.visibility === "visible" &&
            (trigger?.getClientRects().length ?? 0) > 0
          ) {
            trigger?.focus({ preventScroll: true })
            settingsScroll.scrollTop = restoreScrollTop
            if (document.activeElement === trigger) {
              restoreKeyboardShortcutsFocusRef.current = false
              return
            }
          }

          // On emulated Chromium the settings surface can remain hidden for
          // more than one frame after the route changes. Poll without making
          // animation-frame delivery the only path to restored focus.
          if (
            !keyboardShortcutsWasOpenRef.current &&
            settingsScroll.isConnected &&
            performance.now() - restoreStartedAt < 1_500
          ) {
            restoreTimer = window.setTimeout(restoreTriggerFocus, 16)
            return
          }
          restoreKeyboardShortcutsFocusRef.current = false
        }
        restoreTimer = window.setTimeout(restoreTriggerFocus, 0)
      } else {
        settingsScroll.scrollTop = dialogScrollTopRef.current
      }
    }
    return () => {
      if (restoreTimer !== null) window.clearTimeout(restoreTimer)
      restoreKeyboardShortcutsFocusRef.current = false
    }
  }, [keyboardShortcutsOpen, open])

  React.useLayoutEffect(() => {
    onExternalZoomHandlerChange(applyExternalZoom)
    return () => onExternalZoomHandlerChange(null)
  }, [applyExternalZoom, onExternalZoomHandlerChange])

  React.useLayoutEffect(() => {
    const root = settingsScrollRef.current
    if (!root || keyboardShortcutsOpen) return
    const sections = Array.from(
      root.querySelectorAll<HTMLElement>("[data-settings-search-section]")
    )
    const standaloneItems = Array.from(
      root.querySelectorAll<HTMLElement>("[data-settings-search-item]")
    ).filter((item) => item.closest("[data-settings-search-section]") === null)
    const matches = (element: HTMLElement, extraText = "") => {
      const searchableText = `${extraText} ${element.textContent ?? ""}`
        .toLocaleLowerCase()
        .replace(/\s+/gu, " ")
      return settingsSearchTerms.every((term) => searchableText.includes(term))
    }
    const sectionItems = (section: HTMLElement) => {
      const content = section.querySelector<HTMLElement>(
        "[data-settings-search-items]"
      )
      const itemsContainer =
        content?.firstElementChild instanceof HTMLElement
          ? content.firstElementChild
          : content
      const items = Array.from(itemsContainer?.children ?? []).filter(
        (item): item is HTMLElement => item instanceof HTMLElement
      )
      return items.flatMap((item) => {
        if (!item.hasAttribute("data-settings-search-group")) return [item]
        const nestedItems = Array.from(
          item.querySelectorAll<HTMLElement>("[data-settings-search-item]")
        )
        return nestedItems.length > 0 ? nestedItems : [item]
      })
    }
    const updateSectionGroups = (section: HTMLElement) => {
      for (const group of section.querySelectorAll<HTMLElement>(
        "[data-settings-search-group]"
      )) {
        const items = Array.from(
          group.querySelectorAll<HTMLElement>("[data-settings-search-item]")
        )
        group.hidden = items.length > 0 && items.every((item) => item.hidden)
      }
    }

    if (!settingsSearchActive) {
      for (const section of sections) {
        section.hidden = false
        for (const item of sectionItems(section)) item.hidden = false
        updateSectionGroups(section)
      }
      for (const item of standaloneItems) item.hidden = false
      if (settingsSearchStatusRef.current) {
        settingsSearchStatusRef.current.textContent = ""
      }
      if (settingsSearchEmptyRef.current) {
        settingsSearchEmptyRef.current.hidden = true
      }
      return
    }

    let matchCount = 0
    for (const section of sections) {
      const sectionLabel = section.dataset.settingsSearchSection ?? ""
      const sectionMatches = settingsSearchTerms.every((term) =>
        sectionLabel.toLocaleLowerCase().includes(term)
      )
      let sectionMatchCount = 0
      for (const item of sectionItems(section)) {
        const itemMatches =
          sectionMatches ||
          matches(
            item,
            `${sectionLabel} ${item.dataset.settingsSearchItem ?? ""}`
          )
        item.hidden = !itemMatches
        if (itemMatches) sectionMatchCount += 1
      }
      updateSectionGroups(section)
      section.hidden = sectionMatchCount === 0
      matchCount += sectionMatchCount
    }
    for (const item of standaloneItems) {
      const itemMatches = matches(item)
      item.hidden = !itemMatches
      if (itemMatches) matchCount += 1
    }
    if (settingsSearchStatusRef.current) {
      settingsSearchStatusRef.current.textContent = `${matchCount} ${matchCount === 1 ? "setting" : "settings"} found.`
    }
    if (settingsSearchEmptyRef.current) {
      settingsSearchEmptyRef.current.hidden = matchCount !== 0
    }
  }, [keyboardShortcutsOpen, settingsSearchActive, settingsSearchTerms])

  React.useEffect(() => {
    if (!open) return
    const captureNestedPopupEscape = (event: KeyboardEvent) => {
      nestedPopupEscapePendingRef.current =
        event.key === "Escape" && hasOpenNestedPopup()
    }
    window.addEventListener("keydown", captureNestedPopupEscape, true)
    return () => {
      window.removeEventListener("keydown", captureNestedPopupEscape, true)
      nestedPopupEscapePendingRef.current = false
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setWindowProfilesPending(true)
      setWindowProfilesError(null)
    })
    void window.pulseMd
      .getWindowProfiles()
      .then((snapshot) => {
        if (cancelled) return
        setWindowProfilesSnapshot(snapshot)
        setDefaultWindowProfileDraft((current) => {
          if (!defaultWindowProfileDirtyRef.current) {
            return snapshot.defaultProfileId
          }
          if (
            current !== null &&
            !snapshot.profiles.some(({ profile }) => profile.id === current) &&
            !(
              settingsTransferOptionsRef.current.profiles &&
              stagedSettingsImportRef.current?.profiles.some(
                ({ id }) => id === current
              )
            )
          ) {
            defaultWindowProfileDirtyRef.current =
              snapshot.defaultProfileId !== null
            return null
          }
          return current
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error("Unable to load window profiles", error)
        setWindowProfilesError("Window profiles could not be loaded.")
      })
      .finally(() => {
        if (!cancelled) setWindowProfilesPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const cancel = React.useCallback(() => {
    if (stagedSettingsImport) {
      window.pulseMd.discardSettingsImport(stagedSettingsImport.importId)
      setStagedSettingsImport(null)
      stagedSettingsImportRef.current = null
    }
    setSaveError(null)
    setSettingsTransferFeedback(null)
    setDraftSettings(settings)
    setNumericInputs(settings)
    defaultWindowProfileDirtyRef.current = false
    importedDefaultProfileUserEditedRef.current = false
    replaceOnSaveRef.current = false
    setDefaultWindowProfileDraft(settings.defaultWindowProfileId)
    zoomInputEditedRef.current = false
    onCancel()
  }, [onCancel, setNumericInputs, settings, stagedSettingsImport])

  const updateDraft = React.useCallback(
    (change: Partial<AppSettings>) => {
      const next = { ...draftSettings, ...change }
      setDraftSettings(next)
      onPreview(next)
    },
    [draftSettings, onPreview]
  )

  const updateChrome = React.useCallback(
    (change: Partial<AppSettings["chrome"]>) => {
      updateDraft({
        chrome: {
          ...draftSettings.chrome,
          ...change,
        },
      })
    },
    [draftSettings.chrome, updateDraft]
  )

  const updateBackgroundEffect = React.useCallback(
    (change: Partial<AppSettings["backgroundEffect"]>) => {
      updateDraft({
        backgroundEffect: {
          ...draftSettings.backgroundEffect,
          ...change,
        },
      })
    },
    [draftSettings.backgroundEffect, updateDraft]
  )

  const updateLaunchTransition = React.useCallback(
    (change: Partial<AppSettings["launchTransition"]>) => {
      updateDraft({
        launchTransition: {
          ...draftSettings.launchTransition,
          ...change,
        },
      })
    },
    [draftSettings.launchTransition, updateDraft]
  )

  const updateMarkdownExtension = React.useCallback(
    (extension: keyof AppSettings["markdownExtensions"], enabled: boolean) => {
      const markdownExtensions = {
        ...draftSettings.markdownExtensions,
        [extension]: enabled,
      }
      if (extension === "emojiRecognition" && !enabled) {
        markdownExtensions.emojiExpansion = false
      } else if (extension === "emojiExpansion" && enabled) {
        markdownExtensions.emojiRecognition = true
      }
      updateDraft({ markdownExtensions })
    },
    [draftSettings.markdownExtensions, updateDraft]
  )

  const updateAllMarkdownExtensions = React.useCallback(
    (enabled: boolean) => {
      const markdownExtensions = { ...draftSettings.markdownExtensions }
      for (const option of markdownExtensionOptions) {
        markdownExtensions[option.key] = enabled
      }
      updateDraft({ markdownExtensions })
    },
    [draftSettings.markdownExtensions, updateDraft]
  )

  const updateTopRightControl = React.useCallback(
    (control: TopRightControlKey, visible: boolean) => {
      updateChrome({
        topRightControls: {
          ...draftSettings.chrome.topRightControls,
          [control]: visible,
        },
      })
    },
    [draftSettings.chrome.topRightControls, updateChrome]
  )

  const updateAllTopRightControls = React.useCallback(
    (visible: boolean) => {
      const topRightControls = { ...draftSettings.chrome.topRightControls }
      for (const option of topRightControlOptions) {
        topRightControls[option.key] = visible
      }
      updateChrome({ topRightControls })
    },
    [draftSettings.chrome.topRightControls, updateChrome]
  )

  const updateSettingsTransferOption = React.useCallback(
    (option: keyof SettingsTransferOptions, included: boolean) => {
      const nextOptions = {
        ...settingsTransferOptionsRef.current,
        [option]: included,
      }
      settingsTransferOptionsRef.current = nextOptions
      setSettingsTransferOptions(nextOptions)
      if (option !== "profiles" || !stagedSettingsImport) return
      const importedDefaultProfileId =
        stagedSettingsImport.importedDefaultProfileId
      const importedDefaultComesFromTransfer =
        importedDefaultProfileId !== null &&
        stagedSettingsImport.profiles.some(
          ({ id }) => id === importedDefaultProfileId
        ) &&
        !windowProfilesSnapshot?.profiles.some(
          ({ profile }) => profile.id === importedDefaultProfileId
        )
      if (!importedDefaultComesFromTransfer) return

      if (
        included &&
        !importedDefaultProfileUserEditedRef.current &&
        defaultWindowProfileDraft === null
      ) {
        setDefaultWindowProfileDraft(importedDefaultProfileId)
        updateDraft({ defaultWindowProfileId: importedDefaultProfileId })
        defaultWindowProfileDirtyRef.current =
          importedDefaultProfileId !==
          (windowProfilesSnapshot?.defaultProfileId ?? null)
      } else if (
        !included &&
        defaultWindowProfileDraft === importedDefaultProfileId
      ) {
        setDefaultWindowProfileDraft(null)
        updateDraft({ defaultWindowProfileId: null })
        defaultWindowProfileDirtyRef.current =
          (windowProfilesSnapshot?.defaultProfileId ?? null) !== null
      }
    },
    [
      defaultWindowProfileDraft,
      stagedSettingsImport,
      updateDraft,
      windowProfilesSnapshot,
    ]
  )

  const updateStatusItem = React.useCallback(
    (item: keyof AppSettings["chrome"]["statusItems"], visible: boolean) => {
      updateChrome({
        statusItems: {
          ...draftSettings.chrome.statusItems,
          [item]: visible,
        },
      })
    },
    [draftSettings.chrome.statusItems, updateChrome]
  )

  const resetAll = React.useCallback(() => {
    const defaults = cloneAppSettings(DEFAULT_APP_SETTINGS)
    defaults.customThemePresets = draftSettings.customThemePresets.map(
      (preset) => ({ ...preset, profile: { ...preset.profile } })
    )
    setDraftSettings(defaults)
    setNumericInputs(defaults)
    setPreviewSchemeOverride(null)
    setDefaultWindowProfileDraft(null)
    importedDefaultProfileUserEditedRef.current =
      stagedSettingsImport?.importedDefaultProfileId != null
    defaultWindowProfileDirtyRef.current =
      (windowProfilesSnapshot?.defaultProfileId ?? null) !== null
    zoomInputEditedRef.current = false
    onPreview(defaults)
  }, [
    draftSettings.customThemePresets,
    onPreview,
    setNumericInputs,
    windowProfilesSnapshot,
    stagedSettingsImport?.importedDefaultProfileId,
  ])

  const adjustZoom = React.useCallback(
    (direction: -1 | 1) => {
      const currentPercent = parsedInteger(
        zoomPercentInput,
        Math.round(draftSettings.zoomFactor * 100)
      )
      const nextPercent = Math.min(
        MAX_ZOOM_FACTOR * 100,
        Math.max(
          MIN_ZOOM_FACTOR * 100,
          currentPercent + direction * ZOOM_PERCENT_STEP
        )
      )
      const zoomFactor = clampZoomFactor(nextPercent / 100)
      zoomInputEditedRef.current = true
      setZoomPercentInput(formatZoomPercent(zoomFactor))
      updateDraft({ zoomFactor })
    },
    [draftSettings.zoomFactor, updateDraft, zoomPercentInput]
  )

  const prepareDraftSettings = React.useCallback(() => {
    const normalizedSettings = {
      ...draftSettings,
      defaultWindowProfileId: defaultWindowProfileDraft,
      backgroundEffect: {
        ...draftSettings.backgroundEffect,
        blurRadius: clampBackgroundBlurRadius(
          parsedInteger(
            backgroundBlurRadiusInput,
            draftSettings.backgroundEffect.blurRadius
          )
        ),
        translucency: clampBackgroundTranslucency(
          parsedInteger(
            backgroundTranslucencyInput,
            Math.round(draftSettings.backgroundEffect.translucency * 100)
          ) / 100
        ),
      },
      zoomFactor: zoomInputEditedRef.current
        ? clampZoomFactor(
            parsedInteger(
              zoomPercentInput,
              Math.round(draftSettings.zoomFactor * 100)
            ) / 100
          )
        : draftSettings.zoomFactor,
      maxContentWidth: clampContentWidth(
        parsedInteger(contentWidthInput, draftSettings.maxContentWidth)
      ),
      sourceIndentSize: clampSourceIndentSize(
        parsedInteger(sourceIndentSizeInput, draftSettings.sourceIndentSize)
      ),
    }
    setDraftSettings(normalizedSettings)
    setNumericInputs(normalizedSettings)
    onPreview(normalizedSettings)
    return normalizedSettings
  }, [
    backgroundBlurRadiusInput,
    backgroundTranslucencyInput,
    contentWidthInput,
    defaultWindowProfileDraft,
    draftSettings,
    onPreview,
    setNumericInputs,
    sourceIndentSizeInput,
    zoomPercentInput,
  ])

  const save = React.useCallback((): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current

    const operation = (async () => {
      const normalizedSettings = prepareDraftSettings()
      savingRef.current = true
      setIsSaving(true)
      setSaveError(null)
      try {
        await onSave(
          normalizedSettings,
          replaceOnSaveRef.current ? "replace" : "merge",
          stagedSettingsImport
            ? {
                importId: stagedSettingsImport.importId,
                options: settingsTransferOptions,
              }
            : undefined
        )
        replaceOnSaveRef.current = false
        setStagedSettingsImport(null)
        stagedSettingsImportRef.current = null
        importedDefaultProfileUserEditedRef.current = false
        return true
      } catch (error) {
        console.error("Unable to save settings", error)
        setSaveError(settingsSaveErrorMessage(error))
        return false
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    })()

    savePromiseRef.current = operation
    void operation.finally(() => {
      if (savePromiseRef.current === operation) {
        savePromiseRef.current = null
      }
    })
    return operation
  }, [
    onSave,
    prepareDraftSettings,
    settingsTransferOptions,
    stagedSettingsImport,
  ])

  const exportSettings = React.useCallback(async () => {
    if (settingsTransferOperationRef.current || savingRef.current) return
    settingsTransferOperationRef.current = "export"
    setSettingsTransferOperation("export")
    setSettingsTransferFeedback(null)
    setSaveError(null)
    try {
      const result = await window.pulseMd.exportSettings(
        prepareDraftSettings(),
        settingsTransferOptions
      )
      if (result.status === "exported") {
        setSettingsTransferFeedback({
          message: `Exported ${transferredSettingsFileName(result.filePath)}${settingsTransferResourceSummary(result.profileCount, result.scratchCount)}.`,
          tone: "success",
        })
      }
    } catch (error) {
      console.error("Unable to export settings", error)
      setSettingsTransferFeedback({
        message:
          "Settings could not be exported. Check the destination and try again.",
        tone: "error",
      })
    } finally {
      settingsTransferOperationRef.current = null
      setSettingsTransferOperation(null)
    }
  }, [prepareDraftSettings, settingsTransferOptions])

  const importSettings = React.useCallback(async () => {
    if (settingsTransferOperationRef.current || savingRef.current) return
    settingsTransferOperationRef.current = "import"
    setSettingsTransferOperation("import")
    setSettingsTransferFeedback(null)
    setSaveError(null)
    try {
      const result = await window.pulseMd.importSettings()
      if (result.status !== "imported") return

      const importedSettings = cloneAppSettings(result.settings)
      const importedDefaultProfileId = importedSettings.defaultWindowProfileId
      let availableProfiles = windowProfilesSnapshot
      if (!availableProfiles && importedDefaultProfileId !== null) {
        try {
          availableProfiles = await window.pulseMd.getWindowProfiles()
          setWindowProfilesSnapshot(availableProfiles)
          setWindowProfilesError(null)
        } catch (error) {
          console.error(
            "Unable to verify the imported default window profile",
            error
          )
        }
      }
      const defaultProfileAvailable =
        importedDefaultProfileId === null ||
        availableProfiles?.profiles.some(
          ({ profile }) => profile.id === importedDefaultProfileId
        ) === true ||
        (settingsTransferOptions.profiles &&
          result.profiles.some(({ id }) => id === importedDefaultProfileId))
      if (!defaultProfileAvailable) {
        importedSettings.defaultWindowProfileId = null
      }

      replaceOnSaveRef.current = true
      const nextStagedImport: StagedSettingsImport = {
        importId: result.importId,
        importedDefaultProfileId,
        profiles: result.profiles,
        scratchCount: result.scratchCount,
      }
      stagedSettingsImportRef.current = nextStagedImport
      setStagedSettingsImport(nextStagedImport)
      importedDefaultProfileUserEditedRef.current = false
      zoomInputEditedRef.current = false
      setPreviewSchemeOverride(null)
      setDraftSettings(importedSettings)
      setNumericInputs(importedSettings)
      setDefaultWindowProfileDraft(importedSettings.defaultWindowProfileId)
      defaultWindowProfileDirtyRef.current =
        importedSettings.defaultWindowProfileId !==
        (availableProfiles?.defaultProfileId ?? null)
      onPreview(importedSettings)
      setSettingsTransferFeedback({
        message: defaultProfileAvailable
          ? `Imported ${transferredSettingsFileName(result.filePath)}${settingsTransferResourceSummary(result.profiles.length, result.scratchCount)}. Review the settings, then choose Done to save the transfer.`
          : `Imported ${transferredSettingsFileName(result.filePath)}. Its default window profile is not available here, so Standard Empty Window was selected. Choose Done to save.`,
        tone: "success",
      })
    } catch (error) {
      console.error("Unable to import settings", error)
      setSettingsTransferFeedback({
        message:
          "That file could not be imported. Choose a valid Pulse MD settings export and try again.",
        tone: "error",
      })
    } finally {
      settingsTransferOperationRef.current = null
      setSettingsTransferOperation(null)
    }
  }, [
    onPreview,
    setNumericInputs,
    settingsTransferOptions.profiles,
    windowProfilesSnapshot,
  ])

  React.useLayoutEffect(() => {
    onSaveHandlerChange(save)
    return () => onSaveHandlerChange(null)
  }, [onSaveHandlerChange, save])

  const commitZoomPercentInput = React.useCallback(() => {
    if (!zoomInputEditedRef.current) return
    const zoomFactor = clampZoomFactor(
      parsedInteger(
        zoomPercentInput,
        Math.round(draftSettings.zoomFactor * 100)
      ) / 100
    )
    setZoomPercentInput(formatZoomPercent(zoomFactor))
    updateDraft({ zoomFactor })
  }, [draftSettings.zoomFactor, updateDraft, zoomPercentInput])

  const commitBackgroundTranslucencyInput = React.useCallback(() => {
    const translucency = clampBackgroundTranslucency(
      parsedInteger(
        backgroundTranslucencyInput,
        Math.round(draftSettings.backgroundEffect.translucency * 100)
      ) / 100
    )
    setBackgroundTranslucencyInput(
      formatBackgroundTranslucencyPercent(translucency)
    )
    updateBackgroundEffect({ translucency })
  }, [
    backgroundTranslucencyInput,
    draftSettings.backgroundEffect.translucency,
    updateBackgroundEffect,
  ])

  const commitBackgroundBlurRadiusInput = React.useCallback(() => {
    const blurRadius = clampBackgroundBlurRadius(
      parsedInteger(
        backgroundBlurRadiusInput,
        draftSettings.backgroundEffect.blurRadius
      )
    )
    setBackgroundBlurRadiusInput(formatBackgroundBlurRadius(blurRadius))
    updateBackgroundEffect({ blurRadius })
  }, [
    backgroundBlurRadiusInput,
    draftSettings.backgroundEffect.blurRadius,
    updateBackgroundEffect,
  ])

  const commitContentWidthInput = React.useCallback(() => {
    const maxContentWidth = clampContentWidth(
      parsedInteger(contentWidthInput, draftSettings.maxContentWidth)
    )
    setContentWidthInput(String(maxContentWidth))
    updateDraft({ maxContentWidth })
  }, [contentWidthInput, draftSettings.maxContentWidth, updateDraft])

  const commitSourceIndentSizeInput = React.useCallback(() => {
    const sourceIndentSize = clampSourceIndentSize(
      parsedInteger(sourceIndentSizeInput, draftSettings.sourceIndentSize)
    )
    setSourceIndentSizeInput(String(sourceIndentSize))
    updateDraft({ sourceIndentSize })
  }, [draftSettings.sourceIndentSize, sourceIndentSizeInput, updateDraft])

  const openKeyboardShortcuts = React.useCallback(() => {
    onOpenKeyboardShortcuts()
  }, [onOpenKeyboardShortcuts])

  const returnToSettings = React.useCallback(() => {
    onNavigateBack()
  }, [onNavigateBack])

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (
          nextOpen ||
          savingRef.current ||
          settingsTransferOperationRef.current
        ) {
          return
        }
        if (
          details.reason === "escape-key" &&
          nestedPopupEscapePendingRef.current
        ) {
          nestedPopupEscapePendingRef.current = false
          return
        }
        if (details.reason === "escape-key" && keyboardShortcutsOpen) {
          returnToSettings()
          return
        }
        if (details.reason === "escape-key") {
          cancel()
          return
        }
        cancel()
      }}
    >
      <DialogContent
        ref={dialogContentRef}
        data-settings-dialog=""
        initialFocus={
          keyboardShortcutsOpen ? dialogContentRef : settingsSearchInputRef
        }
        className={cn(
          "max-h-[calc(100vh-var(--window-chrome-height)-var(--window-chrome-height))] min-h-0 grid-rows-[minmax(0,1fr)_auto] content-start gap-0 overflow-hidden p-0 sm:max-w-3xl",
          keyboardShortcutsOpen
            ? "h-[min(45rem,calc(100vh-var(--window-chrome-height)-var(--window-chrome-height)))]"
            : undefined
        )}
        overlayClassName="bg-transparent supports-backdrop-filter:backdrop-blur-none"
      >
        {keyboardShortcutsOpen ? (
          <KeyboardShortcutsPanel
            keepReadyInBackground={draftSettings.keepReadyInBackground}
            platform={platform}
            onBack={returnToSettings}
          />
        ) : null}
        <div
          ref={settingsScrollRef}
          className={cn(
            "grid min-h-0 grid-cols-[minmax(0,1fr)] gap-6 overflow-y-auto p-6",
            keyboardShortcutsOpen && "pointer-events-none invisible"
          )}
          data-settings-dialog-scroll=""
          onScroll={(event) => {
            if (
              !keyboardShortcutsOpen &&
              !restoreKeyboardShortcutsFocusRef.current
            ) {
              dialogScrollTopRef.current = event.currentTarget.scrollTop
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {keyboardShortcutsOpen ? "Keyboard Shortcuts" : "Settings"}
            </DialogTitle>
          </DialogHeader>

          <div>
            <InputGroup>
              <InputGroupInput
                ref={settingsSearchInputRef}
                aria-label="Search settings"
                autoComplete="off"
                placeholder="Search settings…"
                spellCheck={false}
                type="search"
                value={settingsSearchQuery}
                onChange={(event) =>
                  setSettingsSearchQuery(event.currentTarget.value)
                }
              />
              <InputGroupAddon>
                <SearchIcon className="size-4 shrink-0 opacity-50" />
              </InputGroupAddon>
            </InputGroup>
            <p
              ref={settingsSearchStatusRef}
              aria-live="polite"
              className="sr-only"
              role="status"
            />
          </div>

          <Collapsible
            className="rounded-3xl border border-border/70"
            data-settings-search-section="Theme"
            open={settingsSearchActive || openSections.theme}
            onOpenChange={(sectionOpen) => setSectionOpen("theme", sectionOpen)}
          >
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-3xl px-4 py-3 text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              <span className="inline-flex items-center gap-2">
                <PaletteIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span>Theme</span>
              </span>
              <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent
              className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 px-4 pb-4 md:grid-cols-2"
              data-settings-search-items
            >
              <div className="col-span-full min-w-0">
                <ThemeModeControl
                  action={
                    <ResetSettingButton
                      disabled={
                        draftSettings.appearanceMode ===
                        DEFAULT_APP_SETTINGS.appearanceMode
                      }
                      label="appearance"
                      onReset={() => {
                        setPreviewSchemeOverride(null)
                        updateDraft({
                          appearanceMode: DEFAULT_APP_SETTINGS.appearanceMode,
                        })
                      }}
                    />
                  }
                  value={draftSettings.appearanceMode}
                  onValueChange={(appearanceMode) => {
                    setPreviewSchemeOverride(null)
                    updateDraft({ appearanceMode })
                  }}
                />
              </div>
              {(["light", "dark"] as const).map((scheme) => (
                <AppearanceProfileControl
                  key={scheme}
                  action={
                    <ResetSettingButton
                      disabled={appearanceProfilesMatch(
                        draftSettings.themeByScheme[scheme],
                        DEFAULT_APP_SETTINGS.themeByScheme[scheme]
                      )}
                      label={`${scheme} appearance profile`}
                      onReset={() => {
                        setPreviewSchemeOverride(scheme)
                        updateDraft({
                          themeByScheme: {
                            ...draftSettings.themeByScheme,
                            [scheme]: {
                              ...DEFAULT_APP_SETTINGS.themeByScheme[scheme],
                            },
                          },
                        })
                      }}
                    />
                  }
                  customPresets={draftSettings.customThemePresets.filter(
                    (preset) => preset.scheme === scheme
                  )}
                  profile={draftSettings.themeByScheme[scheme]}
                  scheme={scheme}
                  onDeletePreset={(id) => {
                    updateDraft({
                      customThemePresets:
                        draftSettings.customThemePresets.filter(
                          (preset) => preset.id !== id
                        ),
                    })
                  }}
                  onSavePreset={(name) => {
                    updateDraft({
                      customThemePresets: [
                        ...draftSettings.customThemePresets,
                        {
                          id: crypto.randomUUID(),
                          name,
                          scheme,
                          profile: {
                            ...draftSettings.themeByScheme[scheme],
                          },
                        },
                      ],
                    })
                  }}
                  onValueChange={(profile) => {
                    setPreviewSchemeOverride(scheme)
                    updateDraft({
                      themeByScheme: {
                        ...draftSettings.themeByScheme,
                        [scheme]: profile,
                      },
                    })
                  }}
                />
              ))}
              <ThemePreview
                profile={draftSettings.themeByScheme[previewScheme]}
                scheme={previewScheme}
              />
            </CollapsibleContent>
          </Collapsible>

          {platform !== "linux" ? (
            <Collapsible
              className="rounded-3xl border border-border/70"
              data-settings-search-section="Transparency and Blur"
              open={settingsSearchActive || openSections.background}
              onOpenChange={(sectionOpen) =>
                setSectionOpen("background", sectionOpen)
              }
            >
              <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-3xl px-4 py-3 text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
                <span className="inline-flex items-center gap-2">
                  <BlendIcon
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                  />
                  <span>Transparency &amp; Blur</span>
                </span>
                <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent
                className="grid gap-4 px-4 pb-4"
                data-settings-search-items
              >
                <Field orientation="horizontal">
                  <FieldContent>
                    <ResettableFieldLabel
                      defaultValue={
                        DEFAULT_APP_SETTINGS.backgroundEffect.enabled
                      }
                      htmlFor="background-effect-enabled"
                      label="window transparency and blur"
                      value={draftSettings.backgroundEffect.enabled}
                      onReset={() =>
                        updateBackgroundEffect({
                          enabled:
                            DEFAULT_APP_SETTINGS.backgroundEffect.enabled,
                        })
                      }
                    >
                      Window Transparency &amp; Blur
                    </ResettableFieldLabel>
                  </FieldContent>
                  <Switch
                    id="background-effect-enabled"
                    aria-label="Window transparency & blur"
                    checked={draftSettings.backgroundEffect.enabled}
                    disabled={!backgroundEffectSupported}
                    onCheckedChange={(enabled) =>
                      updateBackgroundEffect({ enabled })
                    }
                  />
                </Field>

                {platform === "win32" && !backgroundEffectSupported ? (
                  <FieldDescription>
                    System backdrops are unavailable on this Windows release.
                    Pulse MD remains opaque; Windows 11 22H2 or later is
                    required.
                  </FieldDescription>
                ) : null}

                <div
                  className="grid gap-3 rounded-2xl border border-border/60 p-3"
                  data-disabled={!backgroundEffectControlsEnabled}
                >
                  <div>
                    <p className="text-sm font-medium">Translucent Surfaces</p>
                  </div>
                  {(
                    [
                      ["translucentCallouts", "Callouts"],
                      ["translucentCodeBlocks", "Code Blocks"],
                      ["translucentInlineCode", "Inline Code"],
                    ] as const
                  ).map(([setting, label]) => (
                    <Field key={setting} orientation="horizontal">
                      <ResettableFieldLabel
                        defaultValue={
                          DEFAULT_APP_SETTINGS.backgroundEffect[setting]
                        }
                        disabled={!backgroundEffectControlsEnabled}
                        htmlFor={`background-effect-${setting}`}
                        label={`${label.toLowerCase()} translucency`}
                        value={draftSettings.backgroundEffect[setting]}
                        onReset={() =>
                          updateBackgroundEffect({
                            [setting]:
                              DEFAULT_APP_SETTINGS.backgroundEffect[setting],
                          })
                        }
                      >
                        {label}
                      </ResettableFieldLabel>
                      <Switch
                        id={`background-effect-${setting}`}
                        aria-label={label}
                        checked={draftSettings.backgroundEffect[setting]}
                        disabled={!backgroundEffectControlsEnabled}
                        onCheckedChange={(enabled) =>
                          updateBackgroundEffect({ [setting]: enabled })
                        }
                      />
                    </Field>
                  ))}
                </div>

                <Field
                  data-disabled={!backgroundEffectControlsEnabled}
                  orientation="vertical"
                >
                  <ResettableFieldLabel
                    defaultValue={
                      DEFAULT_APP_SETTINGS.backgroundEffect.translucency
                    }
                    disabled={!backgroundEffectControlsEnabled}
                    htmlFor="background-translucency"
                    label="background translucency"
                    value={draftSettings.backgroundEffect.translucency}
                    onReset={() => {
                      const translucency =
                        DEFAULT_APP_SETTINGS.backgroundEffect.translucency
                      setBackgroundTranslucencyInput(
                        formatBackgroundTranslucencyPercent(translucency)
                      )
                      updateBackgroundEffect({ translucency })
                    }}
                  >
                    Background Translucency
                  </ResettableFieldLabel>
                  <FieldContent>
                    <div className="settings-input-pair grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3">
                      <Slider
                        id="background-translucency"
                        aria-label="Background translucency"
                        disabled={!backgroundEffectControlsEnabled}
                        max={MAX_BACKGROUND_TRANSLUCENCY_PERCENT}
                        min={MIN_BACKGROUND_TRANSLUCENCY_PERCENT}
                        step={BACKGROUND_TRANSLUCENCY_PERCENT_STEP}
                        value={[
                          Math.round(
                            draftSettings.backgroundEffect.translucency * 100
                          ),
                        ]}
                        onValueChange={(value) => {
                          const percentage = Math.round(
                            typeof value === "number"
                              ? value
                              : (value[0] ??
                                  draftSettings.backgroundEffect.translucency *
                                    100)
                          )
                          const translucency = clampBackgroundTranslucency(
                            percentage / 100
                          )
                          setBackgroundTranslucencyInput(String(percentage))
                          updateBackgroundEffect({ translucency })
                        }}
                      />
                      <div className="relative">
                        <Input
                          aria-label="Background translucency percentage"
                          className="pr-7 text-right tabular-nums"
                          disabled={!backgroundEffectControlsEnabled}
                          inputMode="numeric"
                          max={MAX_BACKGROUND_TRANSLUCENCY_PERCENT}
                          min={MIN_BACKGROUND_TRANSLUCENCY_PERCENT}
                          step={BACKGROUND_TRANSLUCENCY_PERCENT_STEP}
                          type="number"
                          value={backgroundTranslucencyInput}
                          onBlur={commitBackgroundTranslucencyInput}
                          onChange={(event) => {
                            const value = event.currentTarget.value
                            setBackgroundTranslucencyInput(value)
                            const parsed = Number(value)
                            if (
                              value.trim() !== "" &&
                              Number.isFinite(parsed) &&
                              parsed >= MIN_BACKGROUND_TRANSLUCENCY_PERCENT &&
                              parsed <= MAX_BACKGROUND_TRANSLUCENCY_PERCENT
                            ) {
                              updateBackgroundEffect({
                                translucency: clampBackgroundTranslucency(
                                  Math.round(parsed) / 100
                                ),
                              })
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              event.currentTarget.blur()
                          }}
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                          %
                        </span>
                      </div>
                    </div>
                  </FieldContent>
                </Field>

                {platform === "darwin" ? (
                  <Field
                    data-disabled={!backgroundEffectControlsEnabled}
                    orientation="vertical"
                  >
                    <ResettableFieldLabel
                      defaultValue={
                        DEFAULT_APP_SETTINGS.backgroundEffect.blurRadius
                      }
                      disabled={!backgroundEffectControlsEnabled}
                      htmlFor="background-blur-radius"
                      label="background blur radius"
                      value={draftSettings.backgroundEffect.blurRadius}
                      onReset={() => {
                        const blurRadius =
                          DEFAULT_APP_SETTINGS.backgroundEffect.blurRadius
                        setBackgroundBlurRadiusInput(
                          formatBackgroundBlurRadius(blurRadius)
                        )
                        updateBackgroundEffect({ blurRadius })
                      }}
                    >
                      Blur Radius
                    </ResettableFieldLabel>
                    <FieldContent>
                      <div className="settings-input-pair grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3">
                        <Slider
                          id="background-blur-radius"
                          aria-label="Background blur radius"
                          disabled={!backgroundEffectControlsEnabled}
                          max={MAX_BACKGROUND_BLUR_RADIUS_VALUE}
                          min={MIN_BACKGROUND_BLUR_RADIUS_VALUE}
                          step={BACKGROUND_BLUR_RADIUS_STEP}
                          value={[draftSettings.backgroundEffect.blurRadius]}
                          onValueChange={(value) => {
                            const blurRadius = clampBackgroundBlurRadius(
                              typeof value === "number"
                                ? value
                                : (value[0] ??
                                    draftSettings.backgroundEffect.blurRadius)
                            )
                            setBackgroundBlurRadiusInput(String(blurRadius))
                            updateBackgroundEffect({ blurRadius })
                          }}
                        />
                        <div className="relative">
                          <Input
                            aria-label="Background blur radius value"
                            className="pr-7 text-right tabular-nums"
                            disabled={!backgroundEffectControlsEnabled}
                            inputMode="numeric"
                            max={MAX_BACKGROUND_BLUR_RADIUS_VALUE}
                            min={MIN_BACKGROUND_BLUR_RADIUS_VALUE}
                            step={BACKGROUND_BLUR_RADIUS_STEP}
                            type="number"
                            value={backgroundBlurRadiusInput}
                            onBlur={commitBackgroundBlurRadiusInput}
                            onChange={(event) => {
                              const value = event.currentTarget.value
                              setBackgroundBlurRadiusInput(value)
                              const parsed = Number(value)
                              if (
                                value.trim() !== "" &&
                                Number.isInteger(parsed) &&
                                parsed >= MIN_BACKGROUND_BLUR_RADIUS_VALUE &&
                                parsed <= MAX_BACKGROUND_BLUR_RADIUS_VALUE
                              ) {
                                updateBackgroundEffect({ blurRadius: parsed })
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter")
                                event.currentTarget.blur()
                            }}
                          />
                          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                            px
                          </span>
                        </div>
                      </div>
                    </FieldContent>
                  </Field>
                ) : (
                  <Field orientation="vertical">
                    <FieldLabel>Blur Radius</FieldLabel>
                    <FieldDescription>
                      Windows manages blur strength for the system backdrop, so
                      it is not adjustable in Pulse MD. System backdrops require
                      Windows 11 22H2 or later; older releases remain opaque.
                    </FieldDescription>
                  </Field>
                )}

                <Field
                  className="items-center! rounded-2xl border border-border/60 p-3"
                  orientation="horizontal"
                >
                  <FieldContent>
                    <ResettableFieldLabel
                      defaultValue={
                        DEFAULT_APP_SETTINGS.launchTransition.enabled
                      }
                      disabled={!backgroundEffectSupported}
                      htmlFor="launch-transition-enabled"
                      label="launch transition"
                      value={draftSettings.launchTransition.enabled}
                      onReset={() =>
                        updateLaunchTransition({
                          enabled:
                            DEFAULT_APP_SETTINGS.launchTransition.enabled,
                        })
                      }
                    >
                      Launch Transition
                    </ResettableFieldLabel>
                  </FieldContent>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="launch-transition-enabled"
                      aria-label="Launch transition"
                      checked={draftSettings.launchTransition.enabled}
                      disabled={!backgroundEffectSupported}
                      onCheckedChange={(enabled) =>
                        updateLaunchTransition({ enabled })
                      }
                    />
                    <Button
                      aria-label="Customize launch transition"
                      disabled={
                        !backgroundEffectSupported ||
                        !draftSettings.launchTransition.enabled ||
                        isSaving ||
                        settingsTransferOperation !== null ||
                        stagedSettingsImport !== null
                      }
                      type="button"
                      variant="outline"
                      onClick={() => onCustomizeLaunchTransition(draftSettings)}
                    >
                      Customize
                      <ChevronRightIcon data-icon="inline-end" />
                    </Button>
                  </div>
                </Field>
              </CollapsibleContent>
            </Collapsible>
          ) : null}

          <Collapsible
            className="rounded-3xl border border-border/70"
            data-settings-search-section="Window Chrome"
            open={settingsSearchActive || openSections.chrome}
            onOpenChange={(sectionOpen) =>
              setSectionOpen("chrome", sectionOpen)
            }
          >
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-3xl px-4 py-3 text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              <span className="inline-flex items-center gap-2">
                <PanelTopIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span>Window Chrome</span>
              </span>
              <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent
              className="grid gap-4 px-4 pb-4"
              data-settings-search-items
            >
              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={DEFAULT_APP_SETTINGS.chrome.tabVisibility}
                  htmlFor="tab-visibility"
                  label="tabs visibility"
                  value={draftSettings.chrome.tabVisibility}
                  onReset={() =>
                    updateChrome({
                      tabVisibility: DEFAULT_APP_SETTINGS.chrome.tabVisibility,
                    })
                  }
                >
                  Show Tabs
                </ResettableFieldLabel>
                <FieldContent>
                  <Select
                    value={draftSettings.chrome.tabVisibility}
                    onValueChange={(tabVisibility) =>
                      updateChrome({
                        tabVisibility: tabVisibility as TabVisibilityMode,
                      })
                    }
                  >
                    <SelectTrigger
                      id="tab-visibility"
                      aria-label="Show tabs"
                      className="w-48"
                    >
                      <SelectValue>
                        {
                          tabVisibilityLabels[
                            draftSettings.chrome.tabVisibility
                          ]
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="always">Always</SelectItem>
                        <SelectItem value="multiple-tabs">
                          With Multiple Tabs
                        </SelectItem>
                        <SelectItem value="mouseover">On Mouseover</SelectItem>
                        <SelectItem value="formatting-bar">
                          With Formatting Toolbar
                        </SelectItem>
                        <SelectItem value="hidden">Hidden</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FieldContent>
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <ResettableFieldLabel
                    defaultValue={
                      DEFAULT_APP_SETTINGS.chrome.alwaysShowTopControls
                    }
                    htmlFor="always-show-top-controls"
                    label={`always show ${topControlsPosition} controls`}
                    value={draftSettings.chrome.alwaysShowTopControls}
                    onReset={() =>
                      updateChrome({
                        alwaysShowTopControls:
                          DEFAULT_APP_SETTINGS.chrome.alwaysShowTopControls,
                      })
                    }
                  >
                    Always Show {topControlsPositionLabel} Controls
                  </ResettableFieldLabel>
                </FieldContent>
                <Switch
                  id="always-show-top-controls"
                  aria-label={`Always show ${topControlsPosition} controls`}
                  checked={draftSettings.chrome.alwaysShowTopControls}
                  onCheckedChange={(alwaysShowTopControls) =>
                    updateChrome({ alwaysShowTopControls })
                  }
                />
              </Field>

              <div className="grid gap-4" data-settings-search-group>
                <p className="text-sm font-medium">
                  {topControlsPositionLabel} Controls
                </p>
                <Field
                  className="rounded-2xl border border-border/60 p-3"
                  data-settings-search-item={`${topControlsPositionLabel} Controls`}
                  orientation="horizontal"
                >
                  <FieldContent>
                    <FieldLabel htmlFor="all-top-right-controls">
                      All Controls
                    </FieldLabel>
                  </FieldContent>
                  <Switch
                    id="all-top-right-controls"
                    aria-label={`All ${topControlsPosition} controls`}
                    checked={topRightControlOptions.every(
                      (option) =>
                        draftSettings.chrome.topRightControls[option.key]
                    )}
                    onCheckedChange={updateAllTopRightControls}
                  />
                </Field>
                {topRightControlOptions.map((option) => (
                  <Field
                    key={option.key}
                    data-settings-search-item={`${topControlsPositionLabel} Controls`}
                    orientation="horizontal"
                  >
                    <FieldContent>
                      <ResettableFieldLabel
                        defaultValue={
                          DEFAULT_APP_SETTINGS.chrome.topRightControls[
                            option.key
                          ]
                        }
                        htmlFor={option.id}
                        label={`${option.label.toLowerCase()} ${topControlsPosition} control`}
                        value={
                          draftSettings.chrome.topRightControls[option.key]
                        }
                        onReset={() =>
                          updateTopRightControl(
                            option.key,
                            DEFAULT_APP_SETTINGS.chrome.topRightControls[
                              option.key
                            ]
                          )
                        }
                      >
                        {option.label}
                      </ResettableFieldLabel>
                    </FieldContent>
                    <Switch
                      id={option.id}
                      aria-label={`Show ${option.label.toLowerCase()} ${topControlsPosition} control`}
                      checked={
                        draftSettings.chrome.topRightControls[option.key]
                      }
                      onCheckedChange={(visible) =>
                        updateTopRightControl(option.key, visible)
                      }
                    />
                  </Field>
                ))}
              </div>

              <Field orientation="horizontal">
                <FieldContent>
                  <ResettableFieldLabel
                    defaultValue={DEFAULT_APP_SETTINGS.chrome.showFormattingBar}
                    htmlFor="show-formatting-bar"
                    label="show formatting toolbar"
                    value={draftSettings.chrome.showFormattingBar}
                    onReset={() =>
                      updateChrome({
                        showFormattingBar:
                          DEFAULT_APP_SETTINGS.chrome.showFormattingBar,
                      })
                    }
                  >
                    Show Formatting Toolbar
                  </ResettableFieldLabel>
                </FieldContent>
                <Switch
                  id="show-formatting-bar"
                  aria-label="Show formatting toolbar"
                  checked={draftSettings.chrome.showFormattingBar}
                  onCheckedChange={(showFormattingBar) =>
                    updateChrome({ showFormattingBar })
                  }
                />
              </Field>

              <Field
                data-disabled={!draftSettings.chrome.showFormattingBar}
                orientation="vertical"
              >
                <ResettableFieldLabel
                  defaultValue={
                    DEFAULT_APP_SETTINGS.chrome.formattingBarPosition
                  }
                  htmlFor="formatting-bar-position"
                  label="formatting toolbar position"
                  value={draftSettings.chrome.formattingBarPosition}
                  onReset={() =>
                    updateChrome({
                      formattingBarPosition:
                        DEFAULT_APP_SETTINGS.chrome.formattingBarPosition,
                    })
                  }
                >
                  Formatting Toolbar Position
                </ResettableFieldLabel>
                <FieldContent>
                  <Select
                    disabled={!draftSettings.chrome.showFormattingBar}
                    value={draftSettings.chrome.formattingBarPosition}
                    onValueChange={(formattingBarPosition) =>
                      updateChrome({
                        formattingBarPosition:
                          formattingBarPosition as FormattingBarPosition,
                      })
                    }
                  >
                    <SelectTrigger
                      id="formatting-bar-position"
                      aria-label="Formatting toolbar position"
                      className="w-32"
                    >
                      <SelectValue>
                        {
                          formattingBarPositionLabels[
                            draftSettings.chrome.formattingBarPosition
                          ]
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="left">Left</SelectItem>
                        <SelectItem value="center">Center</SelectItem>
                        <SelectItem value="right">Right</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FieldContent>
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <ResettableFieldLabel
                    defaultValue={DEFAULT_APP_SETTINGS.chrome.showCenteredPath}
                    htmlFor="show-centered-path"
                    label="show centered path"
                    value={draftSettings.chrome.showCenteredPath}
                    onReset={() =>
                      updateChrome({
                        showCenteredPath:
                          DEFAULT_APP_SETTINGS.chrome.showCenteredPath,
                      })
                    }
                  >
                    Show Centered Path
                  </ResettableFieldLabel>
                  <FieldDescription>While tabs are hidden.</FieldDescription>
                </FieldContent>
                <Switch
                  id="show-centered-path"
                  aria-label="Show centered path"
                  checked={draftSettings.chrome.showCenteredPath}
                  onCheckedChange={(showCenteredPath) =>
                    updateChrome({ showCenteredPath })
                  }
                />
              </Field>

              <Field
                data-disabled={!draftSettings.chrome.showCenteredPath}
                orientation="vertical"
              >
                <ResettableFieldLabel
                  defaultValue={DEFAULT_APP_SETTINGS.chrome.centeredPathDisplay}
                  htmlFor="centered-path-display"
                  label="centered path display"
                  value={draftSettings.chrome.centeredPathDisplay}
                  onReset={() =>
                    updateChrome({
                      centeredPathDisplay:
                        DEFAULT_APP_SETTINGS.chrome.centeredPathDisplay,
                    })
                  }
                >
                  Centered Path Display
                </ResettableFieldLabel>
                <FieldContent>
                  <Select
                    disabled={!draftSettings.chrome.showCenteredPath}
                    value={draftSettings.chrome.centeredPathDisplay}
                    onValueChange={(centeredPathDisplay) =>
                      updateChrome({
                        centeredPathDisplay:
                          centeredPathDisplay as AppSettings["chrome"]["centeredPathDisplay"],
                      })
                    }
                  >
                    <SelectTrigger
                      id="centered-path-display"
                      aria-label="Centered path display"
                      className="min-w-40"
                    >
                      <SelectValue>
                        {
                          pathDisplayLabels[
                            draftSettings.chrome.centeredPathDisplay
                          ]
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="path">Full Path</SelectItem>
                        <SelectItem value="filename">Filename Only</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FieldContent>
              </Field>

              <Field
                className="rounded-2xl border border-border/60 p-3"
                orientation="horizontal"
              >
                <FieldContent>
                  <FieldLabel>Active Tab Indicator</FieldLabel>
                  <FieldDescription>
                    Configure its edges, corners, color, and thickness in a live
                    preview.
                  </FieldDescription>
                </FieldContent>
                <Button
                  aria-label="Customize active tab indicator"
                  disabled={
                    isSaving ||
                    settingsTransferOperation !== null ||
                    stagedSettingsImport !== null
                  }
                  type="button"
                  variant="outline"
                  onClick={() => onCustomizeActiveTabIndicator(draftSettings)}
                >
                  Customize
                  <ChevronRightIcon data-icon="inline-end" />
                </Button>
              </Field>

              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={DEFAULT_APP_SETTINGS.chrome.tabDisplay}
                  htmlFor="tab-path-display"
                  label="tab path display"
                  value={draftSettings.chrome.tabDisplay}
                  onReset={() =>
                    updateChrome({
                      tabDisplay: DEFAULT_APP_SETTINGS.chrome.tabDisplay,
                    })
                  }
                >
                  Tab Path Display
                </ResettableFieldLabel>
                <FieldContent>
                  <Select
                    value={draftSettings.chrome.tabDisplay}
                    onValueChange={(tabDisplay) =>
                      updateChrome({
                        tabDisplay:
                          tabDisplay as AppSettings["chrome"]["tabDisplay"],
                      })
                    }
                  >
                    <SelectTrigger
                      id="tab-path-display"
                      aria-label="Tab path display"
                      className="min-w-40"
                    >
                      <SelectValue>
                        {pathDisplayLabels[draftSettings.chrome.tabDisplay]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="path">Full Path</SelectItem>
                        <SelectItem value="filename">Filename Only</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FieldContent>
              </Field>

              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={
                    DEFAULT_APP_SETTINGS.chrome.tabWheelScrollDirection
                  }
                  htmlFor="tab-wheel-scroll-direction"
                  label="tabs and toolbar mouse-wheel direction"
                  value={draftSettings.chrome.tabWheelScrollDirection}
                  onReset={() =>
                    updateChrome({
                      tabWheelScrollDirection:
                        DEFAULT_APP_SETTINGS.chrome.tabWheelScrollDirection,
                    })
                  }
                >
                  Tabs and Toolbar Mouse-Wheel Direction
                </ResettableFieldLabel>
                <FieldContent>
                  <Select
                    value={draftSettings.chrome.tabWheelScrollDirection}
                    onValueChange={(tabWheelScrollDirection) =>
                      updateChrome({
                        tabWheelScrollDirection:
                          tabWheelScrollDirection as TabWheelScrollDirection,
                      })
                    }
                  >
                    <SelectTrigger
                      id="tab-wheel-scroll-direction"
                      aria-label="Tabs and toolbar mouse-wheel direction"
                      className="min-w-48"
                    >
                      <SelectValue>
                        {
                          tabWheelScrollDirectionLabels[
                            draftSettings.chrome.tabWheelScrollDirection
                          ]
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="down-right">
                          Down Scrolls Right
                        </SelectItem>
                        <SelectItem value="down-left">
                          Down Scrolls Left
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FieldContent>
              </Field>

              <div className="grid gap-4 rounded-2xl border border-border/60 p-3">
                <p className="text-sm font-medium">Status Bar</p>
                <Field orientation="horizontal">
                  <FieldContent>
                    <ResettableFieldLabel
                      defaultValue={
                        DEFAULT_APP_SETTINGS.chrome.alwaysShowStatusBar
                      }
                      htmlFor="always-show-status-bar"
                      label="always show status bar"
                      value={draftSettings.chrome.alwaysShowStatusBar}
                      onReset={() =>
                        updateChrome({
                          alwaysShowStatusBar:
                            DEFAULT_APP_SETTINGS.chrome.alwaysShowStatusBar,
                        })
                      }
                    >
                      Always Show Status Bar
                    </ResettableFieldLabel>
                    <FieldDescription>
                      Instead of only when mousing near the bottom edge.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="always-show-status-bar"
                    aria-label="Always show status bar"
                    checked={draftSettings.chrome.alwaysShowStatusBar}
                    onCheckedChange={(alwaysShowStatusBar) =>
                      updateChrome({ alwaysShowStatusBar })
                    }
                  />
                </Field>

                {(
                  [
                    ["words", "Words"],
                    ["lines", "Lines"],
                    ["characters", "Characters"],
                    ["cursorPosition", "Cursor Position"],
                    ["encoding", "Text Encoding"],
                    ["lineEnding", "Line Ending"],
                  ] as const
                ).map(([item, label]) => (
                  <Field key={item} orientation="horizontal">
                    <ResettableFieldLabel
                      defaultValue={
                        DEFAULT_APP_SETTINGS.chrome.statusItems[item]
                      }
                      htmlFor={`status-item-${item}`}
                      label={`${label.toLowerCase()} status item`}
                      value={draftSettings.chrome.statusItems[item]}
                      onReset={() =>
                        updateStatusItem(
                          item,
                          DEFAULT_APP_SETTINGS.chrome.statusItems[item]
                        )
                      }
                    >
                      {label}
                    </ResettableFieldLabel>
                    <Switch
                      id={`status-item-${item}`}
                      aria-label={`Show ${label.toLowerCase()}`}
                      checked={draftSettings.chrome.statusItems[item]}
                      onCheckedChange={(visible) =>
                        updateStatusItem(item, visible)
                      }
                    />
                  </Field>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible
            className="rounded-3xl border border-border/70"
            data-settings-search-section="Extensions"
            open={settingsSearchActive || openSections.extensions}
            onOpenChange={(sectionOpen) =>
              setSectionOpen("extensions", sectionOpen)
            }
          >
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-3xl px-4 py-3 text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              <span className="inline-flex items-center gap-2">
                <BlocksIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span>Extensions</span>
              </span>
              <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent
              className="grid gap-4 px-4 pb-4"
              data-settings-search-items
            >
              <Field
                className="rounded-2xl border border-border/60 p-3"
                orientation="horizontal"
              >
                <FieldContent>
                  <FieldLabel htmlFor="all-markdown-extensions">
                    All Extensions
                  </FieldLabel>
                </FieldContent>
                <Switch
                  id="all-markdown-extensions"
                  aria-label="All extensions"
                  checked={markdownExtensionOptions.every(
                    (option) => draftSettings.markdownExtensions[option.key]
                  )}
                  onCheckedChange={updateAllMarkdownExtensions}
                />
              </Field>
              {markdownExtensionOptions.map((option) => {
                const disabled =
                  option.key === "emojiExpansion" &&
                  !draftSettings.markdownExtensions.emojiRecognition
                return (
                  <Field key={option.key} orientation="horizontal">
                    <FieldContent>
                      <ResettableFieldLabel
                        defaultValue={
                          DEFAULT_APP_SETTINGS.markdownExtensions[option.key]
                        }
                        disabled={disabled}
                        htmlFor={option.id}
                        label={option.label.toLowerCase()}
                        value={draftSettings.markdownExtensions[option.key]}
                        onReset={() =>
                          updateMarkdownExtension(
                            option.key,
                            DEFAULT_APP_SETTINGS.markdownExtensions[option.key]
                          )
                        }
                      >
                        {option.label}
                      </ResettableFieldLabel>
                      <FieldDescription>{option.description}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id={option.id}
                      aria-label={option.label}
                      checked={draftSettings.markdownExtensions[option.key]}
                      disabled={disabled}
                      onCheckedChange={(enabled) =>
                        updateMarkdownExtension(option.key, enabled)
                      }
                    />
                  </Field>
                )
              })}
            </CollapsibleContent>
          </Collapsible>

          <Field
            className="rounded-2xl border border-border/60 p-3"
            data-settings-search-item
            orientation="horizontal"
          >
            <TypeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <FieldContent>
              <FieldLabel>Typography</FieldLabel>
            </FieldContent>
            <Button
              aria-label="Customize typography"
              disabled={
                isSaving ||
                settingsTransferOperation !== null ||
                stagedSettingsImport !== null
              }
              type="button"
              variant="outline"
              onClick={() => onCustomizeTypography(draftSettings)}
            >
              Customize
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </Field>

          <Field
            className="rounded-2xl border border-border/60 p-3"
            data-settings-search-item
            orientation="horizontal"
          >
            <KeyboardIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <FieldContent>
              <FieldLabel>Keyboard Shortcuts</FieldLabel>
            </FieldContent>
            <Button
              ref={keyboardShortcutsTriggerRef}
              aria-label="View keyboard shortcuts"
              type="button"
              variant="outline"
              onClick={openKeyboardShortcuts}
            >
              View
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </Field>

          <Collapsible
            className="rounded-3xl border border-border/70"
            data-settings-search-section="Miscellaneous"
            open={settingsSearchActive || openSections.miscellaneous}
            onOpenChange={(sectionOpen) =>
              setSectionOpen("miscellaneous", sectionOpen)
            }
          >
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-3xl px-4 py-3 text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              <span className="inline-flex items-center gap-2">
                <EllipsisIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span>Miscellaneous</span>
              </span>
              <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent
              className="grid gap-4 px-4 pb-4"
              data-settings-search-items
            >
              {platform === "darwin" ? (
                <Field orientation="horizontal">
                  <FieldContent>
                    <ResettableFieldLabel
                      defaultValue={DEFAULT_APP_SETTINGS.keepReadyInBackground}
                      htmlFor="keep-ready-in-background"
                      label="keep ready in background"
                      value={draftSettings.keepReadyInBackground}
                      onReset={() =>
                        updateDraft({
                          keepReadyInBackground:
                            DEFAULT_APP_SETTINGS.keepReadyInBackground,
                        })
                      }
                    >
                      Keep Ready in Background
                    </ResettableFieldLabel>
                    <FieldDescription>
                      Starts Pulse MD in the background at login and keeps it
                      ready after Command-Q so windows open faster. Use
                      Option-Command-Q to quit completely. macOS may require
                      login-item approval in System Settings.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="keep-ready-in-background"
                    aria-label="Keep ready in background"
                    checked={draftSettings.keepReadyInBackground}
                    onCheckedChange={(keepReadyInBackground) =>
                      updateDraft({ keepReadyInBackground })
                    }
                  />
                </Field>
              ) : null}

              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={DEFAULT_APP_SETTINGS.zoomFactor}
                  htmlFor="zoom-factor"
                  label="zoom"
                  value={draftSettings.zoomFactor}
                  onReset={() => {
                    zoomInputEditedRef.current = false
                    setZoomPercentInput(
                      formatZoomPercent(DEFAULT_APP_SETTINGS.zoomFactor)
                    )
                    updateDraft({ zoomFactor: DEFAULT_APP_SETTINGS.zoomFactor })
                  }}
                >
                  Zoom
                </ResettableFieldLabel>
                <FieldContent>
                  <div className="settings-zoom-row flex items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          aria-label="Decrease zoom by 5%"
                          disabled={
                            parsedInteger(
                              zoomPercentInput,
                              Math.round(draftSettings.zoomFactor * 100)
                            ) <=
                            MIN_ZOOM_FACTOR * 100
                          }
                          size="icon-sm"
                          type="button"
                          variant="outline"
                          onClick={() => adjustZoom(-1)}
                        >
                          <MinusIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Decrease zoom by 5%</TooltipContent>
                    </Tooltip>
                    <div className="relative w-[5.5rem] min-w-0">
                      <Input
                        id="zoom-factor"
                        aria-label="Zoom percentage"
                        className="pr-7 text-right tabular-nums"
                        inputMode="numeric"
                        max={MAX_ZOOM_FACTOR * 100}
                        min={MIN_ZOOM_FACTOR * 100}
                        step={ZOOM_PERCENT_STEP}
                        type="number"
                        value={zoomPercentInput}
                        onBlur={commitZoomPercentInput}
                        onChange={(event) => {
                          const value = event.currentTarget.value
                          zoomInputEditedRef.current = true
                          setZoomPercentInput(value)
                          const parsed = Number(value)
                          if (
                            value.trim() !== "" &&
                            Number.isFinite(parsed) &&
                            parsed >= MIN_ZOOM_FACTOR * 100 &&
                            parsed <= MAX_ZOOM_FACTOR * 100
                          ) {
                            updateDraft({
                              zoomFactor: clampZoomFactor(
                                Math.round(parsed) / 100
                              ),
                            })
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur()
                        }}
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                        %
                      </span>
                    </div>
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          aria-label="Increase zoom by 5%"
                          disabled={
                            parsedInteger(
                              zoomPercentInput,
                              Math.round(draftSettings.zoomFactor * 100)
                            ) >=
                            MAX_ZOOM_FACTOR * 100
                          }
                          size="icon-sm"
                          type="button"
                          variant="outline"
                          onClick={() => adjustZoom(1)}
                        >
                          <PlusIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Increase zoom by 5%</TooltipContent>
                    </Tooltip>
                  </div>
                </FieldContent>
              </Field>

              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={DEFAULT_APP_SETTINGS.initialEditorMode}
                  htmlFor="initial-editor-mode"
                  label="Markdown view on launch"
                  value={draftSettings.initialEditorMode}
                  onReset={() =>
                    updateDraft({
                      initialEditorMode: DEFAULT_APP_SETTINGS.initialEditorMode,
                    })
                  }
                >
                  Markdown View on Launch
                </ResettableFieldLabel>
                <FieldContent>
                  <Select
                    value={draftSettings.initialEditorMode}
                    onValueChange={(initialEditorMode) =>
                      updateDraft({
                        initialEditorMode: initialEditorMode as EditorMode,
                      })
                    }
                  >
                    <SelectTrigger
                      id="initial-editor-mode"
                      aria-label="Markdown view on launch"
                      className="w-36"
                    >
                      <SelectValue>
                        {editorModeLabels[draftSettings.initialEditorMode]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="live">Rendered</SelectItem>
                        <SelectItem value="source">Raw Markdown</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FieldContent>
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <ResettableFieldLabel
                    defaultValue={DEFAULT_APP_SETTINGS.spellCheck}
                    htmlFor="spell-check"
                    label="spell checking"
                    value={draftSettings.spellCheck}
                    onReset={() =>
                      updateDraft({
                        spellCheck: DEFAULT_APP_SETTINGS.spellCheck,
                      })
                    }
                  >
                    Spell Checking
                  </ResettableFieldLabel>
                  <FieldDescription>
                    Underline misspelled words and show suggested corrections in
                    the editor context menu.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="spell-check"
                  aria-label="Spell checking"
                  checked={draftSettings.spellCheck}
                  onCheckedChange={(spellCheck) => updateDraft({ spellCheck })}
                />
              </Field>

              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={true}
                  htmlFor="source-indentation"
                  label="Raw Markdown Tab key"
                  value={
                    draftSettings.sourceIndentation ===
                      DEFAULT_APP_SETTINGS.sourceIndentation &&
                    draftSettings.sourceIndentSize ===
                      DEFAULT_APP_SETTINGS.sourceIndentSize
                  }
                  onReset={() => {
                    setSourceIndentSizeInput(
                      String(DEFAULT_APP_SETTINGS.sourceIndentSize)
                    )
                    updateDraft({
                      sourceIndentation: DEFAULT_APP_SETTINGS.sourceIndentation,
                      sourceIndentSize: DEFAULT_APP_SETTINGS.sourceIndentSize,
                    })
                  }}
                >
                  Raw Markdown Tab Key
                </ResettableFieldLabel>
                <FieldContent>
                  <div className="settings-indent-row flex items-center justify-start gap-3">
                    <Select
                      value={draftSettings.sourceIndentation}
                      onValueChange={(sourceIndentation) =>
                        updateDraft({
                          sourceIndentation:
                            sourceIndentation as SourceIndentation,
                        })
                      }
                    >
                      <SelectTrigger
                        id="source-indentation"
                        aria-label="Raw Markdown Tab key"
                        className="w-36"
                      >
                        <SelectValue>
                          {
                            sourceIndentationLabels[
                              draftSettings.sourceIndentation
                            ]
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="spaces">Spaces</SelectItem>
                          <SelectItem value="tabs">Tab Character</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label="Spaces per Tab"
                      className="w-[5.5rem] text-right tabular-nums"
                      disabled={draftSettings.sourceIndentation === "tabs"}
                      inputMode="numeric"
                      max={MAX_SOURCE_INDENT_SIZE}
                      min={MIN_SOURCE_INDENT_SIZE}
                      step={1}
                      type="number"
                      value={sourceIndentSizeInput}
                      onBlur={commitSourceIndentSizeInput}
                      onChange={(event) => {
                        const value = event.currentTarget.value
                        setSourceIndentSizeInput(value)
                        const parsed = Number(value)
                        if (
                          value.trim() !== "" &&
                          Number.isInteger(parsed) &&
                          parsed >= MIN_SOURCE_INDENT_SIZE &&
                          parsed <= MAX_SOURCE_INDENT_SIZE
                        ) {
                          updateDraft({ sourceIndentSize: parsed })
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur()
                      }}
                    />
                  </div>
                </FieldContent>
              </Field>

              <Field orientation="vertical">
                <ResettableFieldLabel
                  defaultValue={DEFAULT_APP_SETTINGS.maxContentWidth}
                  htmlFor="max-content-width"
                  label="maximum content width"
                  value={draftSettings.maxContentWidth}
                  onReset={() => {
                    setContentWidthInput(
                      String(DEFAULT_APP_SETTINGS.maxContentWidth)
                    )
                    updateDraft({
                      maxContentWidth: DEFAULT_APP_SETTINGS.maxContentWidth,
                    })
                  }}
                >
                  Maximum Content Width
                </ResettableFieldLabel>
                <FieldContent>
                  <div className="settings-input-pair grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3">
                    <Slider
                      aria-label="Maximum content width"
                      max={MAX_CONTENT_WIDTH}
                      min={MIN_CONTENT_WIDTH}
                      step={CONTENT_WIDTH_STEP}
                      value={[draftSettings.maxContentWidth]}
                      onValueChange={(value) => {
                        const maxContentWidth = clampContentWidth(
                          Math.round(
                            typeof value === "number"
                              ? value
                              : (value[0] ?? draftSettings.maxContentWidth)
                          )
                        )
                        setContentWidthInput(String(maxContentWidth))
                        updateDraft({ maxContentWidth })
                      }}
                    />
                    <div className="relative">
                      <Input
                        id="max-content-width"
                        aria-label="Maximum content width in pixels"
                        className="pr-7 text-right tabular-nums"
                        inputMode="numeric"
                        max={MAX_CONTENT_WIDTH}
                        min={MIN_CONTENT_WIDTH}
                        step={CONTENT_WIDTH_STEP}
                        type="number"
                        value={contentWidthInput}
                        onBlur={commitContentWidthInput}
                        onChange={(event) => {
                          const value = event.currentTarget.value
                          setContentWidthInput(value)
                          const parsed = Number(value)
                          if (
                            value.trim() !== "" &&
                            Number.isFinite(parsed) &&
                            parsed >= MIN_CONTENT_WIDTH &&
                            parsed <= MAX_CONTENT_WIDTH
                          ) {
                            updateDraft({ maxContentWidth: Math.round(parsed) })
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur()
                        }}
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">
                        px
                      </span>
                    </div>
                  </div>
                </FieldContent>
              </Field>
            </CollapsibleContent>
          </Collapsible>

          <section
            aria-labelledby="settings-transfer-title"
            data-settings-search-item
          >
            <Collapsible
              className="rounded-2xl border border-border/60"
              open={settingsSearchActive || openSections.importExport}
              onOpenChange={(sectionOpen) =>
                setSectionOpen("importExport", sectionOpen)
              }
            >
              <div className="grid min-w-0 grid-cols-1 items-center gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <FileJson2Icon className="size-4 shrink-0 text-muted-foreground" />
                  <h2 id="settings-transfer-title" className="min-w-0 flex-1">
                    <CollapsibleTrigger className="group -m-1 flex w-[calc(100%+0.5rem)] items-center justify-between gap-2 rounded-xl p-1 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
                      <span>Import &amp; Export</span>
                      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
                    </CollapsibleTrigger>
                  </h2>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:flex-wrap sm:justify-end">
                  <Button
                    aria-label="Import settings"
                    disabled={isSaving || settingsTransferOperation !== null}
                    type="button"
                    variant="outline"
                    onClick={() => void importSettings()}
                  >
                    <UploadIcon data-icon="inline-start" />
                    Import…
                  </Button>
                  <Button
                    aria-label="Export settings"
                    disabled={
                      isSaving ||
                      settingsTransferOperation !== null ||
                      stagedSettingsImport !== null
                    }
                    type="button"
                    variant="outline"
                    onClick={() => void exportSettings()}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    Export…
                  </Button>
                </div>
              </div>
              <CollapsibleContent className="px-3 pb-3">
                <div
                  aria-label="Transfer contents"
                  className="grid gap-4"
                  role="group"
                >
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="transfer-window-profiles">
                        Window Profiles
                      </FieldLabel>
                    </FieldContent>
                    <Switch
                      id="transfer-window-profiles"
                      aria-label="Include window profiles in transfers"
                      checked={settingsTransferOptions.profiles}
                      onCheckedChange={(included) =>
                        updateSettingsTransferOption("profiles", included)
                      }
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="transfer-scratches">
                        Scratches
                      </FieldLabel>
                    </FieldContent>
                    <Switch
                      id="transfer-scratches"
                      aria-label="Include scratches in transfers"
                      checked={settingsTransferOptions.scratches}
                      onCheckedChange={(included) =>
                        updateSettingsTransferOption("scratches", included)
                      }
                    />
                  </Field>
                </div>
              </CollapsibleContent>
              {settingsTransferFeedback ? (
                <p
                  aria-live={
                    settingsTransferFeedback.tone === "success"
                      ? "polite"
                      : "assertive"
                  }
                  className={cn(
                    "mx-3 mb-3 flex items-start gap-2 text-sm",
                    settingsTransferFeedback.tone === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                  role={
                    settingsTransferFeedback.tone === "error"
                      ? "alert"
                      : "status"
                  }
                >
                  {settingsTransferFeedback.tone === "success" ? (
                    <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400" />
                  ) : null}
                  <span>{settingsTransferFeedback.message}</span>
                </p>
              ) : null}
            </Collapsible>
          </section>

          <section
            aria-labelledby="scratches-settings-title"
            className="flex items-start gap-3 rounded-2xl border border-border/60 p-3"
            data-settings-search-item
          >
            <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <h2
              id="scratches-settings-title"
              className="min-w-0 flex-1 text-sm font-medium"
            >
              Scratches
            </h2>
            <Button
              aria-label="Manage Scratches"
              disabled={
                isSaving ||
                settingsTransferOperation !== null ||
                stagedSettingsImport !== null
              }
              type="button"
              variant="outline"
              onClick={() =>
                onManageScratches({
                  ...draftSettings,
                  defaultWindowProfileId: defaultWindowProfileDraft,
                })
              }
            >
              Manage
            </Button>
          </section>

          <section
            aria-labelledby="window-profiles-settings-title"
            data-settings-search-item
          >
            <Collapsible
              className="rounded-2xl border border-border/60"
              open={
                settingsSearchActive ||
                openSections.windowProfiles ||
                windowProfilesError !== null
              }
              onOpenChange={(sectionOpen) =>
                setSectionOpen("windowProfiles", sectionOpen)
              }
            >
              <div className="grid min-w-0 grid-cols-1 items-start gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <PanelsTopLeftIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <h2 id="window-profiles-settings-title" className="min-w-0">
                      <CollapsibleTrigger className="group -m-1 flex w-[calc(100%+0.5rem)] items-center justify-between gap-2 rounded-xl p-1 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
                        <span>Window Profiles</span>
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
                      </CollapsibleTrigger>
                    </h2>
                    {currentWindowProfile ? (
                      <div
                        className="mt-2 flex min-w-0 items-center gap-2"
                        data-current-window-profile=""
                      >
                        <span className="relative inline-flex">
                          <Badge>Current Window</Badge>
                          <span
                            aria-hidden="true"
                            className="absolute -top-1 -left-1 size-2.5 rounded-full bg-green-500 ring-2 ring-background"
                          />
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {currentWindowProfile.name}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:items-center">
                  <Button
                    aria-label="Launch Window Profile"
                    disabled={
                      isSaving ||
                      settingsTransferOperation !== null ||
                      stagedSettingsImport !== null
                    }
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void onLaunchWindowProfile({
                        ...draftSettings,
                        defaultWindowProfileId: defaultWindowProfileDraft,
                      })
                    }
                  >
                    Launch…
                  </Button>
                  <Button
                    aria-label="Manage Window Profiles"
                    disabled={
                      isSaving ||
                      settingsTransferOperation !== null ||
                      stagedSettingsImport !== null
                    }
                    type="button"
                    variant="outline"
                    onClick={() =>
                      onManageWindowProfiles({
                        ...draftSettings,
                        defaultWindowProfileId: defaultWindowProfileDraft,
                      })
                    }
                  >
                    Manage
                  </Button>
                </div>
              </div>

              <CollapsibleContent className="px-3 pb-3">
                <Field
                  className="border-t border-border/60 pt-3"
                  orientation="horizontal"
                >
                  <FieldContent>
                    <FieldLabel htmlFor="default-window-profile">
                      Always Launch With
                    </FieldLabel>
                    <FieldDescription>
                      Choose a profile for ordinary app launches.
                    </FieldDescription>
                  </FieldContent>
                  <Select
                    disabled={
                      windowProfilesPending ||
                      (!windowProfilesSnapshot && importedProfiles.length === 0)
                    }
                    value={defaultWindowProfileDraft ?? NO_DEFAULT_PROFILE}
                    onValueChange={(value) => {
                      if (value === null) return
                      const profileId =
                        value === NO_DEFAULT_PROFILE ? null : value
                      importedDefaultProfileUserEditedRef.current =
                        stagedSettingsImport !== null &&
                        profileId !==
                          stagedSettingsImport.importedDefaultProfileId
                      setDefaultWindowProfileDraft(profileId)
                      updateDraft({ defaultWindowProfileId: profileId })
                      defaultWindowProfileDirtyRef.current =
                        profileId !== windowProfilesSnapshot?.defaultProfileId
                    }}
                  >
                    <SelectTrigger
                      id="default-window-profile"
                      aria-label="Always Launch With"
                      className="max-w-full min-w-56"
                    >
                      <SelectValue>
                        {defaultWindowProfileDraft === null
                          ? "Standard Empty Window"
                          : (windowProfilesSnapshot?.profiles.find(
                              ({ profile }) =>
                                profile.id === defaultWindowProfileDraft
                            )?.profile.name ??
                            importedProfiles.find(
                              ({ id }) => id === defaultWindowProfileDraft
                            )?.name ??
                            "Standard Empty Window")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={NO_DEFAULT_PROFILE}>
                          Standard Empty Window
                        </SelectItem>
                        {windowProfilesSnapshot?.profiles.map(({ profile }) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.name}
                          </SelectItem>
                        ))}
                        {importedProfiles.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </CollapsibleContent>
              {windowProfilesError ? (
                <p className="mx-3 mb-3 text-sm text-destructive" role="alert">
                  {windowProfilesError}
                </p>
              ) : null}
            </Collapsible>
          </section>

          <p
            ref={settingsSearchEmptyRef}
            className="py-10 text-center text-sm text-muted-foreground"
            hidden
          >
            No matching settings.
          </p>
        </div>

        <div
          className={cn(
            "grid shrink-0 gap-3 border-t border-border/70 bg-popover px-6 py-4",
            keyboardShortcutsOpen && "pointer-events-none invisible"
          )}
          data-settings-dialog-footer=""
        >
          {saveError ? (
            <p
              className="text-sm text-destructive max-[360px]:truncate max-[360px]:text-xs"
              role="alert"
              title={saveError}
            >
              {saveError}
            </p>
          ) : null}
          <DialogFooter className="flex-row flex-wrap items-center justify-between">
            <Button
              aria-label="Reset all settings"
              className="max-[360px]:size-8 max-[360px]:p-0"
              disabled={
                isSaving ||
                settingsTransferOperation !== null ||
                resettableAppSettingsMatch(draftSettings, DEFAULT_APP_SETTINGS)
              }
              size="sm"
              type="button"
              variant="ghost"
              onClick={resetAll}
            >
              <RotateCcwIcon data-icon="inline-start" />
              <span className="max-[360px]:sr-only">Reset all</span>
            </Button>
            <div className="flex flex-row items-center gap-2">
              {isSaving || settingsTransferOperation ? (
                <span
                  className="self-center text-xs text-muted-foreground max-[360px]:sr-only"
                  role="status"
                >
                  {isSaving
                    ? "Saving…"
                    : settingsTransferOperation === "import"
                      ? "Importing…"
                      : "Exporting…"}
                </span>
              ) : null}
              <Button
                disabled={isSaving || settingsTransferOperation !== null}
                size="sm"
                type="button"
                variant="outline"
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                disabled={isSaving || settingsTransferOperation !== null}
                size="sm"
                type="button"
                onClick={() => void save()}
              >
                Done
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
      {nestedDialog}
    </Dialog>
  )
}
