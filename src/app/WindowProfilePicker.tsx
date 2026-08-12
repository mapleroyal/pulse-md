import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { WindowProfilesSnapshot } from "@/shared/contracts"

export interface WindowProfilePickerProps {
  initialError?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (profileId: string) => Promise<void> | void
}

function messageFromError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Window profiles could not be loaded."
}

export default function WindowProfilePicker({
  initialError,
  open,
  onOpenChange,
  onSelect,
}: WindowProfilePickerProps) {
  const [snapshot, setSnapshot] = React.useState<WindowProfilesSnapshot | null>(
    null
  )
  const [loading, setLoading] = React.useState(true)
  const [selectedProfileId, setSelectedProfileId] = React.useState<
    string | null
  >(null)
  const [error, setError] = React.useState<string | null>(initialError ?? null)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.pulseMd
      .getWindowProfiles()
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(messageFromError(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const selectProfile = async (profileId: string) => {
    if (selectedProfileId) return
    setSelectedProfileId(profileId)
    setError(null)
    try {
      await onSelect(profileId)
    } catch (selectError) {
      console.error("Unable to launch window profile", selectError)
      setError(messageFromError(selectError))
      setSelectedProfileId(null)
    }
  }

  return (
    <CommandDialog
      className="sm:max-w-lg"
      description="Search saved window profiles by name or id."
      open={open}
      title="Launch Window Profile"
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !selectedProfileId) onOpenChange(false)
      }}
    >
      <Command
        shouldFilter
        onKeyDown={(event) => {
          if (event.key !== "Escape" || selectedProfileId) return
          event.preventDefault()
          event.stopPropagation()
          onOpenChange(false)
        }}
      >
        <CommandInput
          autoFocus
          disabled={loading || selectedProfileId !== null}
          placeholder="Search window profiles…"
        />
        <CommandList>
          {loading ? (
            <div
              className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircleIcon className="size-4 animate-spin" />
              Loading profiles…
            </div>
          ) : error && !snapshot ? (
            <div
              className="px-4 py-8 text-center text-sm text-destructive"
              role="alert"
            >
              {error}
            </div>
          ) : (
            <>
              <CommandEmpty>No matching profiles.</CommandEmpty>
              <CommandGroup heading="Saved Profiles">
                {snapshot?.profiles.map(({ open: profileOpen, profile }) => (
                  <CommandItem
                    key={profile.id}
                    disabled={selectedProfileId !== null}
                    value={`${profile.name} ${profile.id}`}
                    onSelect={() => void selectProfile(profile.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{profile.name}</span>
                      <span className="block truncate text-xs font-normal text-muted-foreground group-data-selected/command-item:text-accent-foreground/75">
                        {profile.id} · {profile.tabs.length} tab
                        {profile.tabs.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    {selectedProfileId === profile.id ? (
                      <LoaderCircleIcon className="size-4 animate-spin" />
                    ) : snapshot.currentProfileId === profile.id ? (
                      <Badge>Current</Badge>
                    ) : profileOpen ? (
                      <Badge variant="secondary">Open</Badge>
                    ) : snapshot.defaultProfileId === profile.id ? (
                      <Badge variant="outline">Default</Badge>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
              {error ? (
                <div
                  className="px-4 py-3 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
