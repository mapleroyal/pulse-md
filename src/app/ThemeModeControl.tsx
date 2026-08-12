import type { ReactNode } from "react"

import { AppearanceModeSelector } from "@/app/AppearanceModeSelector"
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import type { AppearanceMode } from "@/shared/contracts"

interface ThemeModeControlProps {
  action?: ReactNode
  value: AppearanceMode
  onValueChange: (value: AppearanceMode) => void
}

export function ThemeModeControl({
  action,
  value,
  onValueChange,
}: ThemeModeControlProps) {
  return (
    <FieldGroup className="gap-0">
      <Field
        className="has-[>[data-slot=field-content]]:items-center"
        orientation="responsive"
      >
        <FieldContent className="flex-row items-center justify-between">
          <FieldLabel>Appearance</FieldLabel>
          {action}
        </FieldContent>
        <AppearanceModeSelector value={value} onValueChange={onValueChange} />
      </Field>
    </FieldGroup>
  )
}
