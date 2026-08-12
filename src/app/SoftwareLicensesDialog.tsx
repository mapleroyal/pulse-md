import * as React from "react"
import { SearchIcon } from "lucide-react"

import "@/app/software-licenses.css"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { type SoftwareLicenseInventory } from "@/app/software-license-data"

interface SoftwareLicensesDialogProps {
  inventory: SoftwareLicenseInventory
  open: boolean
  onOpenChange(open: boolean): void
}

export default function SoftwareLicensesDialog({
  inventory,
  open,
  onOpenChange,
}: SoftwareLicensesDialogProps) {
  const [filter, setFilter] = React.useState("")
  const [selectedId, setSelectedId] = React.useState(
    () => inventory.entries[0]?.id ?? ""
  )
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const visibleEntries = React.useMemo(
    () =>
      normalizedFilter
        ? inventory.entries.filter((entry) =>
            [entry.name, entry.version, entry.license].some((value) =>
              value.toLocaleLowerCase().includes(normalizedFilter)
            )
          )
        : inventory.entries,
    [inventory.entries, normalizedFilter]
  )
  const selectedEntry =
    visibleEntries.find(({ id }) => id === selectedId) ?? visibleEntries[0]

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setFilter("")
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="software-licenses-dialog"
        data-software-licenses-dialog
      >
        <DialogHeader className="software-licenses-header">
          <DialogTitle>Software Licenses</DialogTitle>
          <DialogDescription>
            {inventory.developmentPreview
              ? "This development preview shows the app, runtime, and manually tracked licenses. Packaged builds also list directly used software packages."
              : "Pulse MD, Electron, and directly used software and assets. Complete transitive and Chromium notices are packaged with the app."}
          </DialogDescription>
        </DialogHeader>

        <div className="software-license-filter">
          <SearchIcon
            aria-hidden="true"
            className="software-license-filter-icon"
          />
          <Input
            aria-label="Filter software licenses"
            autoComplete="off"
            className="software-license-filter-input"
            placeholder="Filter licenses…"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </div>

        <div className="software-license-workspace">
          <div className="software-license-list">
            {visibleEntries.length > 0 ? (
              visibleEntries.map((entry) => (
                <button
                  key={entry.id}
                  data-license-entry={entry.id}
                  data-selected={
                    selectedEntry?.id === entry.id ? "true" : undefined
                  }
                  className="software-license-entry"
                  type="button"
                  onClick={() => {
                    setSelectedId(entry.id)
                  }}
                >
                  <span className="software-license-entry-name">
                    {entry.name}
                  </span>
                  <span className="software-license-entry-meta">
                    {entry.version} · {entry.license}
                  </span>
                </button>
              ))
            ) : (
              <p className="software-license-empty">No matching licenses.</p>
            )}
          </div>

          <section className="software-license-detail">
            {selectedEntry ? (
              <>
                <header className="software-license-detail-header">
                  <h2 className="software-license-detail-title">
                    {selectedEntry.name}
                  </h2>
                  <p className="software-license-detail-meta">
                    Version {selectedEntry.version} · {selectedEntry.license}
                  </p>
                </header>
                <div className="software-license-body">
                  <pre className="software-license-text">
                    {selectedEntry.text}
                  </pre>
                </div>
              </>
            ) : (
              <p className="software-license-message software-license-message-padded">
                Choose a license to view its text.
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
