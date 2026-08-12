import * as React from "react"
import { LibraryIcon, RotateCwIcon } from "lucide-react"

import {
  buildFontFamilyOptions,
  currentFontFamilyOption,
  fontFamilyOptionMatches,
  getSystemFontCatalogSnapshot,
  loadSystemFontCatalog,
  type FontFamilyOption,
  type FontFamilyOptionSource,
  type FontPickerPurpose,
} from "@/app/font-catalog"
import { useSystemFontCatalog } from "@/app/use-system-font-catalog"
import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

const sourceLabels: Record<FontFamilyOptionSource, string> = {
  included: "Included",
  generic: "Generic",
  system: "Installed",
  current: "Current",
}

export interface FontFamilyPickerProps {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
  /** Included before the app, generic, and discovered system choices. */
  options?: readonly FontFamilyOption[]
  purpose?: FontPickerPurpose
  className?: string
  description?: React.ReactNode
  disabled?: boolean
  includeSystemFonts?: boolean
}

function CatalogStatus({
  status,
  message,
  familyCount,
}: {
  status: ReturnType<typeof getSystemFontCatalogSnapshot>["status"]
  message: string | null
  familyCount: number
}) {
  if (status === "ready") {
    return (
      <div
        className="px-3 py-2 text-xs text-muted-foreground"
        aria-live="polite"
        role="status"
      >
        {familyCount} installed font {familyCount === 1 ? "family" : "families"}
      </div>
    )
  }

  if (status === "idle") return null

  if (status === "loading") {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />
        Loading installed fonts…
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span
        className="min-w-0 flex-1 text-xs text-muted-foreground"
        role="status"
      >
        {message}
      </span>
      {status !== "unsupported" && (
        <Button
          aria-label="Try loading installed fonts again"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => void loadSystemFontCatalog()}
        >
          <RotateCwIcon />
          Try again
        </Button>
      )}
    </div>
  )
}

export function FontFamilyPicker({
  id,
  label,
  value,
  onValueChange,
  options = [],
  purpose = "regular",
  className,
  description,
  disabled = false,
  includeSystemFonts = true,
}: FontFamilyPickerProps) {
  const catalog = useSystemFontCatalog()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [filterQuery, setFilterQuery] = React.useState("")
  const descriptionId = description ? `${id}-description` : undefined
  const availableOptions = React.useMemo(
    () =>
      buildFontFamilyOptions(
        includeSystemFonts ? catalog.families : [],
        purpose,
        options
      ),
    [catalog.families, includeSystemFonts, options, purpose]
  )
  const allOptions = React.useMemo(
    () =>
      availableOptions.some((option) => option.value === value)
        ? availableOptions
        : [currentFontFamilyOption(value), ...availableOptions],
    [availableOptions, value]
  )
  const selectedOption =
    allOptions.find((option) => option.value === value) ?? allOptions[0] ?? null
  const filteredOptions = React.useMemo(
    () =>
      filterQuery
        ? allOptions.filter((option) =>
            fontFamilyOptionMatches(option, filterQuery)
          )
        : allOptions,
    [allOptions, filterQuery]
  )

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      setFilterQuery("")
      if (!open || !includeSystemFonts || catalog.status !== "idle") return
      // Base UI invokes this during the opening click/key event, retaining the
      // transient user activation required by queryLocalFonts().
      void loadSystemFontCatalog()
    },
    [catalog.status, includeSystemFonts]
  )
  const inputGroupAnchor = React.useCallback(
    () => inputRef.current?.closest('[data-slot="input-group"]') ?? null,
    []
  )

  return (
    <Field orientation="vertical" className={cn("min-w-0", className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox<FontFamilyOption>
        disabled={disabled}
        filter={fontFamilyOptionMatches}
        isItemEqualToValue={(left, right) => left.value === right.value}
        itemToStringLabel={(option) => option.label}
        itemToStringValue={(option) => option.value}
        filteredItems={filteredOptions}
        items={allOptions}
        value={selectedOption}
        onInputValueChange={(inputValue, { reason }) => {
          // A live keyboard preview updates the controlled selected value, and
          // Base UI then fills the visible input with that option's label. Keep
          // filtering tied to actual typing so repeated arrows continue through
          // the same result set instead of collapsing it to that one label.
          if (reason === "input-change" || reason === "input-clear") {
            setFilterQuery(inputValue)
          }
        }}
        onItemHighlighted={(option, { reason }) => {
          if (
            reason === "keyboard" &&
            option !== undefined &&
            option.value !== value
          ) {
            onValueChange(option.value)
          }
        }}
        onOpenChange={handleOpenChange}
        onValueChange={(option) => {
          if (option) onValueChange(option.value)
        }}
      >
        <ComboboxInput
          ref={inputRef}
          id={id}
          aria-describedby={descriptionId}
          className="w-72 max-w-full"
          disabled={disabled}
          placeholder="Select a font"
          style={{ fontFamily: selectedOption?.cssFamily }}
        />
        <ComboboxContent
          anchor={inputGroupAnchor}
          aria-label={`${label} choices`}
        >
          <ComboboxEmpty>No fonts found.</ComboboxEmpty>
          <ComboboxList>
            {(option: FontFamilyOption) => (
              <ComboboxItem
                key={`${option.source}:${option.value}`}
                value={option}
              >
                <span
                  className="min-w-0 flex-1 truncate text-base font-normal"
                  style={{ fontFamily: option.cssFamily }}
                >
                  {option.label}
                </span>
                <span className="shrink-0 text-[0.625rem] font-normal tracking-wide text-muted-foreground uppercase">
                  {sourceLabels[option.source]}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <Separator />
          {includeSystemFonts ? (
            <CatalogStatus
              familyCount={catalog.families.length}
              message={catalog.message}
              status={catalog.status}
            />
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <LibraryIcon aria-hidden="true" />
              Included and Generic Fonts
            </div>
          )}
        </ComboboxContent>
      </Combobox>
      {description && (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
    </Field>
  )
}

export default FontFamilyPicker
