import * as React from "react"
import { FilePlus2Icon, FolderOpenIcon } from "lucide-react"

import {
  type ScratchOpenDisposition,
  type ScratchPreviewDocument,
  type ScratchSort,
} from "@/app/scratch-picker-model"
import {
  ScratchPicker,
  type ScratchPreviewRenderState,
} from "@/app/ScratchPicker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  useScratchInventory,
  type GetScratchInventory,
} from "@/app/use-scratch-inventory"

import "@/app/scratch-browser.css"

export interface ScratchBrowserProps {
  open: boolean
  getScratches: GetScratchInventory
  getScratchPreview: (scratchId: string) => Promise<ScratchPreviewDocument>
  onOpenChange: (open: boolean) => void
  openScratch: (
    scratchId: string,
    disposition: ScratchOpenDisposition
  ) => Promise<unknown> | unknown
  initialSort?: ScratchSort
  renderPreview?: (state: ScratchPreviewRenderState) => React.ReactNode
}

function errorText(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The scratch could not be opened."
}

export function ScratchBrowser({
  open,
  getScratches,
  getScratchPreview,
  onOpenChange,
  openScratch,
  initialSort = "last-opened",
  renderPreview,
}: ScratchBrowserProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const actionRequestRef = React.useRef(0)
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState<ScratchSort>(initialSort)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inventory = useScratchInventory({
    active: open,
    getScratches,
    query,
    sort,
  })

  React.useEffect(
    () => () => {
      actionRequestRef.current += 1
    },
    []
  )

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        actionRequestRef.current += 1
        setPending(false)
        setError(null)
        setQuery("")
        setSort(initialSort)
      }
      onOpenChange(nextOpen)
    },
    [initialSort, onOpenChange]
  )

  const handleOpenScratch = React.useCallback(
    async (scratchId: string, disposition: ScratchOpenDisposition) => {
      if (pending) return
      const request = ++actionRequestRef.current
      setPending(true)
      setError(null)
      try {
        await openScratch(scratchId, disposition)
        if (request !== actionRequestRef.current) return
        handleOpenChange(false)
      } catch (nextError) {
        if (request !== actionRequestRef.current) return
        setError(errorText(nextError))
        window.requestAnimationFrame(() => {
          inputRef.current?.focus({ preventScroll: true })
        })
      } finally {
        if (request === actionRequestRef.current) setPending(false)
      }
    },
    [handleOpenChange, openScratch, pending]
  )

  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          aria-label="Open Scratch"
          className="h-[min(44rem,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-5 sm:max-w-5xl"
          data-scratch-browser=""
          initialFocus={inputRef}
        >
          <DialogHeader className="pr-10">
            <DialogTitle>Open Scratch</DialogTitle>
            <DialogDescription className="sr-only">
              Search, preview, and open a scratch.
            </DialogDescription>
          </DialogHeader>

          <ScratchPicker
            className="min-h-0"
            errorMessage={error}
            inputRef={inputRef}
            inventoryError={inventory.error}
            loadPreview={getScratchPreview}
            loading={inventory.loading}
            query={query}
            renderPreview={renderPreview}
            resultsCurrent={inventory.current}
            scratches={inventory.entries}
            selectedId={selectedId}
            sort={sort}
            onActivate={(scratch, disposition) =>
              void handleOpenScratch(scratch.scratchId, disposition)
            }
            onEscapeWhenEmpty={() => handleOpenChange(false)}
            onQueryChange={setQuery}
            onRetryInventory={() =>
              void inventory.refresh().catch(() => undefined)
            }
            onSelectedIdChange={setSelectedId}
            onSortChange={setSort}
            renderActions={(scratch, interactionDisabled) => (
              <>
                <Button
                  disabled={pending || interactionDisabled}
                  size="sm"
                  type="button"
                  onClick={() =>
                    void handleOpenScratch(scratch.scratchId, "default")
                  }
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  {pending ? "Opening…" : "Open"}
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Open Scratch in New Tab"
                        disabled={pending || interactionDisabled}
                        size="icon-sm"
                        type="button"
                        variant="outline"
                        onClick={() =>
                          void handleOpenScratch(scratch.scratchId, "new-tab")
                        }
                      />
                    }
                  >
                    <FilePlus2Icon />
                  </TooltipTrigger>
                  <TooltipContent>Open in New Tab</TooltipContent>
                </Tooltip>
              </>
            )}
          />
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

export default ScratchBrowser
