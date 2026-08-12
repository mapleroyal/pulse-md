import { WindowProfileTabPreview } from "@/app/WindowProfileTabPreview"
import {
  windowProfileTabDisplayName,
  windowProfileTabDisplayPath,
} from "@/app/window-profile-tabs"
import type { FilePathDisplayMode, WindowProfile } from "@/shared/contracts"

export function SavedProfileTabsPreview({
  display = "path",
  profile,
}: {
  display?: FilePathDisplayMode
  profile: WindowProfile
}) {
  return (
    <ol
      aria-label={`${profile.name} tabs`}
      className="grid w-fit max-w-full justify-items-start gap-2"
    >
      {profile.tabs.map((tab, index) => {
        const displayName = windowProfileTabDisplayName(tab)
        return (
          <li
            key={tab.id}
            className="grid min-w-0 grid-cols-[1.5rem_auto] items-center gap-2"
          >
            <span
              aria-hidden="true"
              className="text-left text-xs text-muted-foreground tabular-nums"
              data-saved-profile-tab-index=""
            >
              {index + 1}
            </span>
            <WindowProfileTabPreview
              active={tab.id === profile.activeTab}
              aria-label={`${index + 1}. ${displayName}${tab.id === profile.activeTab ? ", starting tab" : ""}`}
              color={tab.color}
              display={display}
              displayName={displayName}
              filePath={windowProfileTabDisplayPath(tab)}
              interactive={false}
            />
          </li>
        )
      })}
    </ol>
  )
}
