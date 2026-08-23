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
  WholeWordIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { insertSearchInputLineBreak } from "@/app/search-input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { MarkdownSearchStatus } from "@/editor/types"
import { maximumContextPreservingRegexpDocumentLength } from "@/editor/search-cursor"

type SearchActionButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "aria-label" | "title"
> & {
  label: string
}

function SearchActionButton({
  children,
  disabled,
  label,
  ...props
}: SearchActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-disabled={disabled || undefined}
            aria-label={disabled ? label : undefined}
            className="inline-flex shrink-0"
            data-search-action-tooltip={label}
            tabIndex={disabled ? 0 : -1}
          />
        }
      >
        <Button aria-label={label} disabled={disabled} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

interface SearchOptionButtonProps {
  active: boolean
  children: React.ReactNode
  label: string
  onChange: (active: boolean) => void
}

function SearchOptionButton({
  active,
  children,
  label,
  onChange,
}: SearchOptionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InputGroupButton
            aria-label={label}
            aria-pressed={active}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            size="icon-xs"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onChange(!active)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

interface SearchInputHandoff {
  focused: boolean
  selectionDirection: "backward" | "forward" | "none"
  selectionEnd: number
  selectionStart: number
}

interface SearchOverlayProps {
  caseSensitive: boolean
  expanded: boolean
  focusRequest: number
  open: boolean
  preserveCase: boolean
  query: string
  regexp: boolean
  replacement: string
  status: MarkdownSearchStatus
  wholeWord: boolean
  initialFindHandoff?: SearchInputHandoff
  onCaseSensitiveChange: (active: boolean) => void
  onClose: () => void
  onExpandedChange: (expanded: boolean) => void
  onFindNext: () => void
  onFindPrevious: () => void
  onPreserveCaseChange: (active: boolean) => void
  onQueryChange: (query: string) => void
  onRegexpChange: (active: boolean) => void
  onReplace: () => void
  onReplaceAll: () => void
  onReplacementChange: (replacement: string) => void
  onWholeWordChange: (active: boolean) => void
}

export default function SearchOverlay({
  caseSensitive,
  expanded,
  focusRequest,
  open,
  preserveCase,
  query,
  regexp,
  replacement,
  status,
  wholeWord,
  initialFindHandoff,
  onCaseSensitiveChange,
  onClose,
  onExpandedChange,
  onFindNext,
  onFindPrevious,
  onPreserveCaseChange,
  onQueryChange,
  onRegexpChange,
  onReplace,
  onReplaceAll,
  onReplacementChange,
  onWholeWordChange,
}: SearchOverlayProps) {
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const initialFindHandoffRef = React.useRef(initialFindHandoff)

  React.useLayoutEffect(() => {
    if (!open) return
    const input = inputRef.current
    if (!input) return
    const handoff = initialFindHandoffRef.current
    initialFindHandoffRef.current = undefined
    if (handoff) {
      if (!handoff.focused) return
      input.focus()
      input.setSelectionRange(
        Math.min(handoff.selectionStart, input.value.length),
        Math.min(handoff.selectionEnd, input.value.length),
        handoff.selectionDirection
      )
      return
    }
    input.focus()
    input.select()
  }, [focusRequest, open])

  if (!open) return null

  const multilineRegexpLimited =
    status.issue === "multiline-regexp-document-limit"
  const multilineRegexpComplex =
    status.issue === "multiline-regexp-complexity-limit"
  const invalidRegexp =
    query.length > 0 &&
    regexp &&
    !status.valid &&
    !multilineRegexpLimited &&
    !multilineRegexpComplex
  const hasMatches =
    status.valid && query.length > 0 && (status.pending || status.total > 0)
  const resultText =
    multilineRegexpLimited || multilineRegexpComplex
      ? multilineRegexpLimited
        ? "Too large"
        : "Too complex"
      : invalidRegexp
        ? "Invalid"
        : status.pending
          ? "…/…"
          : `${status.current ?? 0}/${status.total}`

  return (
    <TooltipProvider>
      <form
        aria-label="Find and replace in document"
        className="search-overlay fixed right-3 z-40 flex w-[min(32rem,calc(100vw-1.5rem))] items-start gap-1 rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-lg"
        data-expanded={expanded || undefined}
        data-search-overlay-state="ready"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          onClose()
        }}
        onSubmit={(event) => event.preventDefault()}
      >
        <SearchActionButton
          label={expanded ? "Hide replace" : "Show replace"}
          aria-expanded={expanded}
          className="search-disclosure mt-0.5 shrink-0"
          size="icon-xs"
          type="button"
          variant="ghost"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (expanded) {
              inputRef.current?.focus()
              inputRef.current?.select()
            }
            onExpandedChange(!expanded)
          }}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </SearchActionButton>

        <div className="search-content min-w-0 flex-1 space-y-1">
          <div className="search-find-row flex min-w-0 items-center gap-1">
            <InputGroup className="search-find-group h-auto min-h-8 min-w-0 flex-1 items-start rounded-xl bg-input/40 has-[textarea]:rounded-xl">
              <InputGroupTextarea
                ref={inputRef}
                aria-invalid={invalidRegexp || undefined}
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
                  if (event.shiftKey) onFindPrevious()
                  else onFindNext()
                }}
              />
              <InputGroupAddon
                align="inline-end"
                className="shrink-0 gap-0.5 py-1 pr-1"
              >
                <SearchOptionButton
                  active={caseSensitive}
                  label="Match case"
                  onChange={onCaseSensitiveChange}
                >
                  <CaseSensitiveIcon />
                </SearchOptionButton>
                <SearchOptionButton
                  active={wholeWord}
                  label="Match whole word"
                  onChange={onWholeWordChange}
                >
                  <WholeWordIcon />
                </SearchOptionButton>
                <SearchOptionButton
                  active={regexp}
                  label="Use regular expression"
                  onChange={onRegexpChange}
                >
                  <RegexIcon />
                </SearchOptionButton>
              </InputGroupAddon>
            </InputGroup>

            <Tooltip
              disabled={
                !invalidRegexp &&
                !multilineRegexpLimited &&
                !multilineRegexpComplex
              }
            >
              <TooltipTrigger
                render={
                  <output
                    aria-live="polite"
                    aria-busy={status.pending || undefined}
                    className="min-w-12 shrink-0 px-1 text-center font-mono text-[10px] text-muted-foreground"
                  />
                }
              >
                {resultText}
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {multilineRegexpLimited
                  ? `Multiline regular expressions are limited to documents up to ${maximumContextPreservingRegexpDocumentLength.toLocaleString()} characters`
                  : multilineRegexpComplex
                    ? "This multiline regular expression may require unbounded backtracking"
                    : "Invalid regular expression"}
              </TooltipContent>
            </Tooltip>
            <SearchActionButton
              label="Previous match"
              disabled={!hasMatches}
              size="icon-xs"
              type="button"
              variant="ghost"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onFindPrevious}
            >
              <ChevronUpIcon />
            </SearchActionButton>
            <SearchActionButton
              label="Next match"
              disabled={!hasMatches}
              size="icon-xs"
              type="button"
              variant="ghost"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onFindNext}
            >
              <ChevronDownIcon />
            </SearchActionButton>
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
                    if (
                      insertSearchInputLineBreak(event, onReplacementChange)
                    ) {
                      return
                    }
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      !event.altKey &&
                      !event.shiftKey
                    ) {
                      onReplaceAll()
                    } else if (
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.altKey
                    ) {
                      onReplace()
                    }
                  }}
                />
                <InputGroupAddon
                  align="inline-end"
                  className="shrink-0 py-1 pr-1"
                >
                  <SearchOptionButton
                    active={preserveCase}
                    label="Preserve case"
                    onChange={onPreserveCaseChange}
                  >
                    <CaseUpperIcon />
                  </SearchOptionButton>
                </InputGroupAddon>
              </InputGroup>
              <SearchActionButton
                label="Replace"
                disabled={!hasMatches}
                size="icon-xs"
                type="button"
                variant="ghost"
                onPointerDown={(event) => event.preventDefault()}
                onClick={onReplace}
              >
                <ReplaceIcon />
              </SearchActionButton>
              <SearchActionButton
                label="Replace all"
                disabled={!hasMatches}
                size="icon-xs"
                type="button"
                variant="ghost"
                onPointerDown={(event) => event.preventDefault()}
                onClick={onReplaceAll}
              >
                <ReplaceAllIcon />
              </SearchActionButton>
            </div>
          ) : null}
        </div>
      </form>
    </TooltipProvider>
  )
}
