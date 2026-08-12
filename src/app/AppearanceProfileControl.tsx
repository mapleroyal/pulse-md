import * as React from "react"
import { BookmarkPlusIcon, Trash2Icon } from "lucide-react"

import { ThemePresetPicker } from "@/app/ThemePresetPicker"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SYNTAX_THEMES } from "@/editor/syntax-theme"
import {
  BACKGROUND_COLORS,
  MAX_CUSTOM_THEME_PRESET_NAME_LENGTH,
  NEUTRAL_BACKGROUND_IDS,
  normalizeCustomThemePresetName,
  normalizeHexColor,
  type AppearanceProfile,
  type BackgroundId,
  type CustomThemePreset,
  type ResolvedAppearance,
  type SyntaxThemeId,
} from "@/shared/contracts"

const neutralBackgroundLabels = {
  light: "Light",
  dark: "Dark",
  black: "Black",
} as const

interface AppearanceProfileControlProps {
  action?: React.ReactNode
  customPresets: CustomThemePreset[]
  profile: AppearanceProfile
  scheme: ResolvedAppearance
  onDeletePreset: (id: string) => void
  onSavePreset: (name: string) => void
  onValueChange: (profile: AppearanceProfile) => void
}

function presetOptions(scheme: ResolvedAppearance) {
  const defaultId: SyntaxThemeId = scheme === "light" ? "default" : "one-dark"
  return [
    ...SYNTAX_THEMES.filter((theme) => theme.id === defaultId),
    ...SYNTAX_THEMES.filter((theme) => theme.id !== defaultId),
  ]
}

function presetLabel(themeId: SyntaxThemeId, scheme: ResolvedAppearance) {
  if (themeId === "one-dark" && scheme === "dark") {
    return "Default (One Dark)"
  }
  if (themeId === "default") {
    return scheme === "light" ? "Default (CodeMirror)" : "CodeMirror Light"
  }
  return SYNTAX_THEMES.find((theme) => theme.id === themeId)?.label ?? themeId
}

function backgroundLabel(backgroundId: BackgroundId) {
  if (backgroundId === "custom") return "Custom…"
  const syntaxTheme = SYNTAX_THEMES.find(
    (theme) => theme.backgroundId === backgroundId
  )
  const label =
    syntaxTheme?.label ??
    neutralBackgroundLabels[
      backgroundId as keyof typeof neutralBackgroundLabels
    ]
  return `${label} (${BACKGROUND_COLORS[backgroundId]})`
}

function profilesMatch(left: AppearanceProfile, right: AppearanceProfile) {
  return (
    left.backgroundId === right.backgroundId &&
    left.syntaxThemeId === right.syntaxThemeId &&
    (left.backgroundId !== "custom" ||
      left.customBackgroundColor === right.customBackgroundColor)
  )
}

function builtInProfile(
  themeId: SyntaxThemeId,
  scheme: ResolvedAppearance,
  customBackgroundColor: string
): AppearanceProfile {
  const preset = SYNTAX_THEMES.find((theme) => theme.id === themeId)!
  return {
    backgroundId:
      scheme === "dark" && preset.id === "one-dark"
        ? "dark"
        : preset.backgroundId,
    customBackgroundColor,
    syntaxThemeId: preset.id,
  }
}

export function AppearanceProfileControl({
  action,
  customPresets,
  profile,
  scheme,
  onDeletePreset,
  onSavePreset,
  onValueChange,
}: AppearanceProfileControlProps) {
  const prefix = `${scheme}-appearance`
  const [presetNameDraft, setPresetNameDraft] = React.useState<string | null>(
    null
  )
  const [showPresetNameError, setShowPresetNameError] = React.useState(false)
  const [customHexDraft, setCustomHexDraft] = React.useState({
    profileColor: profile.customBackgroundColor,
    value: profile.customBackgroundColor,
  })
  const customHexInput =
    customHexDraft.profileColor === profile.customBackgroundColor
      ? customHexDraft.value
      : profile.customBackgroundColor
  const selectedCustomPreset = customPresets.find((preset) =>
    profilesMatch(preset.profile, profile)
  )
  const matchesBuiltInPreset = presetOptions(scheme).some((preset) =>
    profilesMatch(
      builtInProfile(preset.id, scheme, profile.customBackgroundColor),
      profile
    )
  )
  const canSavePreset = !selectedCustomPreset && !matchesBuiltInPreset
  const presetSelectValue = selectedCustomPreset
    ? `custom:${selectedCustomPreset.id}`
    : profile.syntaxThemeId
  const builtInPresetOptions = presetOptions(scheme).map((theme) => ({
    label: presetLabel(theme.id, scheme),
    value: theme.id,
  }))
  const customPresetOptions = customPresets.map((preset) => ({
    label: preset.name,
    value: `custom:${preset.id}`,
  }))
  const normalizedPresetName =
    presetNameDraft === null
      ? null
      : normalizeCustomThemePresetName(presetNameDraft)
  const existingPresetNames = new Set([
    ...presetOptions(scheme).map((preset) =>
      presetLabel(preset.id, scheme).toLowerCase()
    ),
    ...customPresets.map((preset) => preset.name.toLowerCase()),
  ])
  const duplicatePresetName =
    normalizedPresetName !== null &&
    existingPresetNames.has(normalizedPresetName.toLowerCase())
  const presetNameError =
    presetNameDraft !== null && presetNameDraft.trim() === ""
      ? "Enter a name."
      : normalizedPresetName === null
        ? `Use ${MAX_CUSTOM_THEME_PRESET_NAME_LENGTH} characters or fewer.`
        : duplicatePresetName
          ? "A preset with that name already exists."
          : null

  const savePreset = React.useCallback(() => {
    if (!normalizedPresetName || duplicatePresetName) {
      setShowPresetNameError(true)
      return
    }
    onSavePreset(normalizedPresetName)
    setPresetNameDraft(null)
    setShowPresetNameError(false)
  }, [duplicatePresetName, normalizedPresetName, onSavePreset])

  const commitCustomHex = React.useCallback(() => {
    const normalized = normalizeHexColor(customHexInput)
    if (!normalized) {
      setCustomHexDraft({
        profileColor: profile.customBackgroundColor,
        value: profile.customBackgroundColor,
      })
      return
    }
    setCustomHexDraft({ profileColor: normalized, value: normalized })
    onValueChange({
      ...profile,
      backgroundId: "custom",
      customBackgroundColor: normalized,
    })
  }, [customHexInput, onValueChange, profile])

  return (
    <FieldSet className="relative min-w-0 gap-4 rounded-3xl border border-border/70 p-4">
      <FieldLegend variant="label">
        {scheme === "light" ? "Light Profile" : "Dark Profile"}
      </FieldLegend>
      {action ? <div className="absolute top-2 right-3">{action}</div> : null}

      <Field orientation="vertical">
        <FieldLabel htmlFor={`${prefix}-preset`}>Preset</FieldLabel>
        <FieldContent>
          <div className="flex items-center gap-2">
            <ThemePresetPicker
              id={`${prefix}-preset`}
              builtInOptions={builtInPresetOptions}
              customOptions={customPresetOptions}
              value={presetSelectValue}
              onValueChange={(value) => {
                if (value.startsWith("custom:")) {
                  const preset = customPresets.find(
                    (candidate) => `custom:${candidate.id}` === value
                  )
                  if (preset) onValueChange({ ...preset.profile })
                  return
                }

                const preset = SYNTAX_THEMES.find((theme) => theme.id === value)
                if (!preset) return
                onValueChange(
                  builtInProfile(
                    preset.id,
                    scheme,
                    profile.customBackgroundColor
                  )
                )
              }}
            />
            {selectedCustomPreset ? (
              <Button
                aria-label={`Delete ${selectedCustomPreset.name} preset`}
                size="icon-sm"
                type="button"
                variant="ghost"
                onClick={() => onDeletePreset(selectedCustomPreset.id)}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>

          {canSavePreset ? (
            presetNameDraft === null ? (
              <Button
                className="w-fit"
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  setPresetNameDraft("")
                  setShowPresetNameError(false)
                }}
              >
                <BookmarkPlusIcon data-icon="inline-start" />
                Save as preset
              </Button>
            ) : (
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    aria-label={`${scheme} preset name`}
                    aria-describedby={
                      showPresetNameError
                        ? `${prefix}-preset-name-error`
                        : undefined
                    }
                    aria-invalid={showPresetNameError || undefined}
                    maxLength={MAX_CUSTOM_THEME_PRESET_NAME_LENGTH}
                    placeholder="Preset name"
                    value={presetNameDraft}
                    onChange={(event) => {
                      setPresetNameDraft(event.currentTarget.value)
                      setShowPresetNameError(false)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        savePreset()
                      } else if (event.key === "Escape") {
                        event.preventDefault()
                        event.stopPropagation()
                        setPresetNameDraft(null)
                        setShowPresetNameError(false)
                      }
                    }}
                  />
                  <Button size="sm" type="button" onClick={savePreset}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setPresetNameDraft(null)
                      setShowPresetNameError(false)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {showPresetNameError ? (
                  <p
                    id={`${prefix}-preset-name-error`}
                    className="text-xs text-destructive"
                    role="alert"
                  >
                    {presetNameError}
                  </p>
                ) : null}
              </div>
            )
          ) : null}
        </FieldContent>
      </Field>

      <Field orientation="vertical">
        <FieldLabel htmlFor={`${prefix}-background`}>Background</FieldLabel>
        <FieldContent>
          <Select
            value={profile.backgroundId}
            onValueChange={(backgroundId) =>
              onValueChange({
                ...profile,
                backgroundId: backgroundId as BackgroundId,
              })
            }
          >
            <SelectTrigger
              id={`${prefix}-background`}
              className="w-full min-w-0 sm:min-w-64"
            >
              <SelectValue>{backgroundLabel(profile.backgroundId)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Theme Backgrounds</SelectLabel>
                {SYNTAX_THEMES.map((theme) => (
                  <SelectItem key={theme.id} value={theme.backgroundId}>
                    {theme.label} ({BACKGROUND_COLORS[theme.backgroundId]})
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Neutral Backgrounds</SelectLabel>
                {NEUTRAL_BACKGROUND_IDS.map((backgroundId) => (
                  <SelectItem key={backgroundId} value={backgroundId}>
                    {neutralBackgroundLabels[backgroundId]} (
                    {BACKGROUND_COLORS[backgroundId]})
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Custom Background</SelectLabel>
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          {profile.backgroundId === "custom" ? (
            <div className="grid grid-cols-[3rem_1fr] gap-2">
              <Input
                aria-label={`${scheme} custom background color`}
                className="cursor-default p-1"
                type="color"
                value={profile.customBackgroundColor}
                onChange={(event) => {
                  const customBackgroundColor = event.currentTarget.value
                  setCustomHexDraft({
                    profileColor: customBackgroundColor,
                    value: customBackgroundColor,
                  })
                  onValueChange({
                    ...profile,
                    backgroundId: "custom",
                    customBackgroundColor,
                  })
                }}
              />
              <Input
                id={`${prefix}-custom-background-hex`}
                aria-label={`${scheme} custom background hex`}
                inputMode="text"
                placeholder="#RRGGBB"
                spellCheck={false}
                value={customHexInput}
                onBlur={commitCustomHex}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setCustomHexDraft({
                    profileColor: profile.customBackgroundColor,
                    value,
                  })
                  if (!/^#?[\da-f]{6}$/i.test(value.trim())) return
                  const customBackgroundColor = normalizeHexColor(value)
                  if (!customBackgroundColor) return
                  onValueChange({
                    ...profile,
                    backgroundId: "custom",
                    customBackgroundColor,
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur()
                }}
              />
            </div>
          ) : null}
        </FieldContent>
      </Field>
    </FieldSet>
  )
}
