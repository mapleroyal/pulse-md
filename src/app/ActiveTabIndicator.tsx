import { ACTIVE_TAB_INDICATOR_POSITIONS } from "@/shared/contracts"

export function ActiveTabIndicator() {
  return (
    <span aria-hidden="true" className="active-tab-indicator">
      {ACTIVE_TAB_INDICATOR_POSITIONS.map((position) => (
        <span
          key={position}
          className="active-tab-indicator-part"
          data-position={position}
        />
      ))}
    </span>
  )
}
