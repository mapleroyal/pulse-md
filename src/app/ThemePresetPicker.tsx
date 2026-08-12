import * as React from "react"

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox"

export interface ThemePresetPickerOption {
  label: string
  value: string
}

interface ThemePresetPickerGroup {
  label: string
  items: readonly ThemePresetPickerOption[]
}

interface ThemePresetPickerProps {
  builtInOptions: readonly ThemePresetPickerOption[]
  customOptions?: readonly ThemePresetPickerOption[]
  id: string
  value: string
  onValueChange: (value: string) => void
}

export function ThemePresetPicker({
  builtInOptions,
  customOptions = [],
  id,
  value,
  onValueChange,
}: ThemePresetPickerProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [filterQuery, setFilterQuery] = React.useState("")
  const groups = React.useMemo<readonly ThemePresetPickerGroup[]>(
    () => [
      { label: "Built-in Themes", items: builtInOptions },
      ...(customOptions.length > 0
        ? [{ label: "Custom Presets", items: customOptions }]
        : []),
    ],
    [builtInOptions, customOptions]
  )
  const options = React.useMemo(
    () => groups.flatMap((group) => group.items),
    [groups]
  )
  const selectedOption =
    options.find((option) => option.value === value) ?? null
  const filteredGroups = React.useMemo<
    readonly ThemePresetPickerGroup[]
  >(() => {
    const query = filterQuery.trim().toLocaleLowerCase()
    if (!query) return groups

    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((option) =>
          option.label.toLocaleLowerCase().includes(query)
        ),
      }))
      .filter((group) => group.items.length > 0)
  }, [filterQuery, groups])
  const inputGroupAnchor = React.useCallback(
    () => inputRef.current?.closest('[data-slot="input-group"]') ?? null,
    []
  )

  return (
    <Combobox<ThemePresetPickerOption>
      filteredItems={filteredGroups}
      isItemEqualToValue={(left, right) => left.value === right.value}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      items={groups}
      value={selectedOption}
      onInputValueChange={(inputValue, { reason }) => {
        // Ignore Base UI filling the input after a live keyboard preview so the
        // result set remains stable while ArrowUp/ArrowDown continues through it.
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
      onOpenChange={() => setFilterQuery("")}
      onValueChange={(option) => {
        if (option) onValueChange(option.value)
      }}
    >
      <ComboboxInput
        ref={inputRef}
        id={id}
        className="w-72 max-w-full"
        placeholder="Select a theme"
      />
      <ComboboxContent
        anchor={inputGroupAnchor}
        aria-label="Theme preset choices"
      >
        <ComboboxEmpty>No themes found.</ComboboxEmpty>
        <ComboboxList>
          {(group: ThemePresetPickerGroup, groupIndex: number) => (
            <React.Fragment key={group.label}>
              {groupIndex > 0 ? <ComboboxSeparator /> : null}
              <ComboboxGroup items={group.items}>
                <ComboboxLabel>{group.label}</ComboboxLabel>
                <ComboboxCollection>
                  {(option: ThemePresetPickerOption) => (
                    <ComboboxItem key={option.value} value={option}>
                      {option.label}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            </React.Fragment>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
