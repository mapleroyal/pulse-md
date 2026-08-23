import * as React from "react"
import {
  CaseSensitiveIcon,
  CaseUpperIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  RegexIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  RotateCwIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { insertSearchInputLineBreak } from "@/app/search-input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group"

export interface SearchLoadingOverlayProps {
  error?: boolean
  expanded: boolean
  focusRequest: number
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  query: string
  replacement: string
  onClose: () => void
  onNavigate: (direction: "next" | "previous") => void
  onQueryChange: (query: string) => void
  onReplacementChange: (replacement: string) => void
  onRetry?: () => void
}

export function SearchLoadingOverlay({
  error = false,
  expanded,
  focusRequest,
  inputRef,
  query,
  replacement,
  onClose,
  onNavigate,
  onQueryChange,
  onReplacementChange,
  onRetry,
}: SearchLoadingOverlayProps) {
  React.useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest, inputRef])

  return (
    <form
      aria-label="Find and replace in document"
      className="search-overlay fixed right-3 z-40 flex w-[min(32rem,calc(100vw-1.5rem))] items-start gap-1 rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-lg"
      data-search-overlay-state={error ? "error" : "loading"}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        onClose()
      }}
      onSubmit={(event) => event.preventDefault()}
    >
      <Button
        aria-hidden="true"
        className="search-disclosure mt-0.5 shrink-0"
        disabled
        size="icon-xs"
        tabIndex={-1}
        type="button"
        variant="ghost"
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      </Button>

      <div className="search-content min-w-0 flex-1 space-y-1">
        <div className="search-find-row flex min-w-0 items-center gap-1">
          <InputGroup className="search-find-group h-auto min-h-8 min-w-0 flex-1 items-start rounded-xl bg-input/40 has-[textarea]:rounded-xl">
            <InputGroupTextarea
              ref={inputRef}
              aria-label="Find"
              className="max-h-24 min-h-8 min-w-[5rem] overflow-y-auto px-2.5 py-1.5 leading-5"
              placeholder="Find"
              rows={1}
              spellCheck={false}
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (insertSearchInputLineBreak(event, onQueryChange)) return
                if (event.key !== "Enter") return
                event.preventDefault()
                onNavigate(event.shiftKey ? "previous" : "next")
              }}
            />
            <InputGroupAddon
              align="inline-end"
              className="shrink-0 gap-0.5 py-1 pr-1"
            >
              {[CaseSensitiveIcon, WholeWordIcon, RegexIcon].map(
                (Icon, index) => (
                  <span
                    key={index}
                    aria-hidden="true"
                    className="grid size-6 place-items-center text-muted-foreground/45"
                    data-slot="button"
                    data-search-loading-control=""
                  >
                    <Icon className="size-3.5" />
                  </span>
                )
              )}
            </InputGroupAddon>
          </InputGroup>

          <output
            aria-live="polite"
            className="min-w-12 shrink-0 px-1 text-center font-mono text-[10px] text-muted-foreground"
          >
            {error ? "Failed" : "…/…"}
          </output>
          {error ? (
            <Button
              aria-label="Retry loading search"
              className="text-destructive"
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={onRetry}
            >
              <RotateCwIcon />
            </Button>
          ) : (
            <Button
              aria-hidden="true"
              disabled
              size="icon-xs"
              tabIndex={-1}
              type="button"
              variant="ghost"
            >
              <ChevronUpIcon />
            </Button>
          )}
          <Button
            aria-hidden="true"
            disabled
            size="icon-xs"
            tabIndex={-1}
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
          <Button
            aria-label="Close find"
            className="close-icon-button"
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>

        {expanded ? (
          <div className="search-replace-row flex min-w-0 items-center gap-1 pr-14">
            <InputGroup className="search-replace-group h-auto min-h-8 min-w-0 flex-1 items-start rounded-xl bg-input/40 has-[textarea]:rounded-xl">
              <InputGroupTextarea
                aria-label="Replace"
                className="max-h-24 min-h-8 min-w-[5rem] overflow-y-auto px-2.5 py-1.5 leading-5"
                placeholder="Replace"
                rows={1}
                spellCheck={false}
                value={replacement}
                onChange={(event) =>
                  onReplacementChange(event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (insertSearchInputLineBreak(event, onReplacementChange)) {
                    return
                  }
                  if (event.key !== "Enter") return
                  event.preventDefault()
                }}
              />
              <InputGroupAddon
                align="inline-end"
                className="shrink-0 py-1 pr-1"
              >
                <span
                  aria-hidden="true"
                  className="grid size-6 place-items-center text-muted-foreground/45"
                  data-slot="button"
                  data-search-loading-control=""
                >
                  <CaseUpperIcon className="size-3.5" />
                </span>
              </InputGroupAddon>
            </InputGroup>
            {[ReplaceIcon, ReplaceAllIcon].map((Icon, index) => (
              <Button
                key={index}
                aria-hidden="true"
                disabled
                size="icon-xs"
                tabIndex={-1}
                type="button"
                variant="ghost"
              >
                <Icon />
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <span className="sr-only" role={error ? "alert" : "status"}>
        {error ? "Search tools could not be loaded." : "Loading search tools…"}
      </span>
    </form>
  )
}
