import * as React from "react"
import { ArrowLeftIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DialogDescription, DialogHeader } from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import type { AppPlatform } from "@/shared/contracts"

type KeyStep = readonly string[]
type KeySequence = readonly KeyStep[]

interface ShortcutItem {
  description?: string
  keys: readonly KeySequence[]
  label: string
}

interface ShortcutSection {
  items: readonly ShortcutItem[]
  title: string
}

interface SearchableShortcutSection {
  items: readonly {
    item: ShortcutItem
    searchText: string
  }[]
  title: string
}

interface KeyboardShortcutsPanelProps {
  keepReadyInBackground: boolean
  platform: AppPlatform
  onBack: () => void
}

const SPOKEN_KEY_NAMES: Record<string, string> = {
  "⌘": "Command",
  "⌥": "Option",
  "⇧": "Shift",
  "⌃": "Control",
  "←": "Left Arrow",
  "↑": "Up Arrow",
  "→": "Right Arrow",
  "↓": "Down Arrow",
  "1–6": "1 through 6",
  "1–9": "1 through 9",
  Esc: "Escape",
}

function spokenSequence(sequence: KeySequence) {
  return sequence
    .map((step) =>
      step.map((key) => SPOKEN_KEY_NAMES[key] ?? key).join(" plus ")
    )
    .join(", then ")
}

function normalizedSearchText(value: string) {
  return value.trim().toLocaleLowerCase()
}

function displayedSequence(sequence: KeySequence) {
  return sequence.map((step) => step.join(" ")).join(" then ")
}

function searchableShortcutSections(
  sections: readonly ShortcutSection[]
): readonly SearchableShortcutSection[] {
  return sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({
      item,
      searchText: normalizedSearchText(
        [
          section.title,
          item.label,
          item.description,
          ...item.keys.flatMap((sequence) => [
            spokenSequence(sequence),
            displayedSequence(sequence),
          ]),
        ]
          .filter(Boolean)
          .join(" ")
      ),
    })),
  }))
}

function ShortcutKeys({ keys }: { keys: readonly KeySequence[] }) {
  return (
    <div className="flex flex-wrap items-center justify-start gap-x-2 gap-y-1.5 sm:justify-end">
      <span className="sr-only">{keys.map(spokenSequence).join(" or ")}</span>
      {keys.map((sequence, sequenceIndex) => (
        <React.Fragment key={`${spokenSequence(sequence)}-${sequenceIndex}`}>
          {sequenceIndex > 0 ? (
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              or
            </span>
          ) : null}
          <span
            aria-hidden="true"
            className="inline-flex flex-wrap items-center gap-1"
          >
            {sequence.map((step, stepIndex) => (
              <React.Fragment key={`${step.join("-")}-${stepIndex}`}>
                {stepIndex > 0 ? (
                  <span className="px-0.5 text-[10px] text-muted-foreground">
                    then
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  {step.map((key) => (
                    <Kbd
                      key={key}
                      className="h-8 min-w-8 px-2 text-lg leading-none"
                    >
                      {key}
                    </Kbd>
                  ))}
                </span>
              </React.Fragment>
            ))}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

function ShortcutSectionView({ items, title }: ShortcutSection) {
  return (
    <section
      aria-labelledby={`shortcut-section-${title.toLowerCase().replaceAll(" ", "-")}`}
      className="overflow-hidden rounded-2xl border border-border/60"
    >
      <h2
        id={`shortcut-section-${title.toLowerCase().replaceAll(" ", "-")}`}
        className="border-b border-border/60 bg-muted/30 px-3.5 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h2>
      <dl className="divide-y divide-border/50 px-3.5">
        {items.map(({ description, keys, label }, itemIndex) => (
          <div
            key={`${label}-${itemIndex}`}
            className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
          >
            <dt className="min-w-0 text-sm font-medium">
              <span>{label}</span>
              {description ? (
                <span className="mt-0.5 block text-xs leading-relaxed font-normal text-muted-foreground">
                  {description}
                </span>
              ) : null}
            </dt>
            <dd>
              <ShortcutKeys keys={keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function platformShortcuts(
  platform: AppPlatform,
  keepReadyInBackground: boolean
): readonly ShortcutSection[] {
  const mac = platform === "darwin"
  const primary = mac ? "⌘" : "Ctrl"
  const control = mac ? "⌃" : "Ctrl"
  const alt = mac ? "⌥" : "Alt"
  const shift = mac ? "⇧" : "Shift"
  const shiftedPrimary = mac ? [shift, primary] : [primary, shift]
  const headingChordModifier = mac ? primary : alt

  return [
    {
      title: "Heading navigation",
      items: [
        {
          label: "Open Outline / Go to Heading",
          description: "Opens the searchable heading list.",
          keys: [[[...shiftedPrimary, "O"]]],
        },
        {
          label: "Next heading at level 1–6",
          description:
            "Use the corresponding number for H1 through H6; navigation wraps within that level.",
          keys: [[[primary, alt, "1–6"]]],
        },
        {
          label: "Next heading, any level",
          keys: [[[control, headingChordModifier, "N"], ["H"]]],
        },
        {
          label: "Previous heading, any level",
          keys: [[[control, headingChordModifier, "P"], ["H"]]],
        },
        {
          label: "Next heading at level 1–6",
          description:
            "Google Docs-style sequence; finish with the heading level.",
          keys: [[[control, headingChordModifier, "N"], ["1–6"]]],
        },
        {
          label: "Previous heading at level 1–6",
          description:
            "Google Docs-style sequence; finish with the heading level.",
          keys: [[[control, headingChordModifier, "P"], ["1–6"]]],
        },
      ],
    },
    {
      title: "Inside the Outline",
      items: [
        {
          label: "Previous / next item",
          keys: [[["↑"]], [["↓"]]],
        },
        {
          label: "First item",
          keys: mac ? [[[primary, "↑"]], [["Home"]]] : [[["Home"]]],
        },
        {
          label: "Last item",
          keys: mac ? [[[primary, "↓"]], [["End"]]] : [[["End"]]],
        },
        {
          label: "Previous / next heading at the selected level",
          keys: [[["←"]], [["→"]]],
        },
        {
          label: "Cycle headings at level 1–6",
          description: "Uses the corresponding number for the level.",
          keys: [[["1–6"]]],
        },
        {
          label: "Open selected heading",
          keys: [[["Enter"]]],
        },
        {
          label: "Close Outline",
          keys: [[["Esc"]]],
        },
      ],
    },
    {
      title: "Files and tabs",
      items: [
        { label: "New window", keys: [[[primary, "N"]]] },
        { label: "New tab", keys: [[[primary, "T"]]] },
        {
          label: "Reopen closed document",
          keys: [[[...shiftedPrimary, "T"]]],
        },
        { label: "Open…", keys: [[[primary, "O"]]] },
        { label: "Open Scratch…", keys: [[[primary, "P"]]] },
        { label: "Save", keys: [[[primary, "S"]]] },
        { label: "Save as…", keys: [[[...shiftedPrimary, "S"]]] },
        { label: "Close tab", keys: [[[primary, "W"]]] },
        { label: "Close window", keys: [[[...shiftedPrimary, "W"]]] },
        {
          label: "Select tab 1–10",
          description: mac
            ? "Command or Control selects tabs 1–9; Control-0 selects the tenth tab."
            : platform === "linux"
              ? "0 selects the tenth tab. Super shortcuts work when your desktop passes them to Pulse MD; reassign conflicting desktop shortcuts to use them."
              : "0 selects the tenth tab.",
          keys: mac
            ? [[[primary, "1–9"]], [[control, "1–9"]], [[control, "0"]]]
            : platform === "linux"
              ? [
                  [[control, "1–9"]],
                  [[control, "0"]],
                  [["Super", "1–9"]],
                  [["Super", "0"]],
                ]
              : [[[control, "1–9"]], [[control, "0"]]],
        },
        { label: "Next tab", keys: [[[control, "Tab"]]] },
        {
          label: "Previous tab",
          keys: [[[control, shift, "Tab"]]],
        },
        {
          label: "Move between tabs when the tab strip is focused",
          keys: [[["←"]], [["→"]]],
        },
        {
          label: "Activate a focused tab",
          keys: [[["Enter"]], [["Space"]]],
        },
        {
          label: "First / last tab when the tab strip is focused",
          keys: [[["Home"]], [["End"]]],
        },
        {
          label: "Cancel a tab drag",
          keys: [[["Esc"]]],
        },
      ],
    },
    {
      title: "Inside Open Scratch",
      items: [
        { label: "Previous / next scratch", keys: [[["↑"]], [["↓"]]] },
        { label: "Open selected scratch", keys: [[["Enter"]]] },
        {
          label: "Open selected scratch in a new tab",
          keys: [[[primary, "Enter"]]],
        },
        {
          label: "Clear search / close",
          keys: [[["Esc"]]],
        },
      ],
    },
    {
      title: "Find",
      items: [
        { label: "Open Find", keys: [[[primary, "F"]]] },
        {
          label: "Find next",
          keys: mac ? [[[primary, "G"]]] : [[["F3"]]],
        },
        {
          label: "Find previous",
          keys: mac ? [[[...shiftedPrimary, "G"]]] : [[[shift, "F3"]]],
        },
        ...(mac
          ? ([
              {
                label: "Use selection for Find",
                keys: [[[primary, "E"]]],
              },
            ] satisfies ShortcutItem[])
          : []),
        {
          label: "Open Find and Replace",
          keys: [mac ? [[primary, alt, "F"]] : [[primary, "H"]]],
        },
        {
          label: "Next result",
          description: "When the search field is focused.",
          keys: [[["Enter"]]],
        },
        { label: "Previous result", keys: [[[shift, "Enter"]]] },
        {
          label: "Insert line break",
          description: "When the Find or Replace field is focused.",
          keys: [[[alt, "Enter"]]],
        },
        {
          label: "Replace current result",
          description: "When the replacement field is focused.",
          keys: [[["Enter"]]],
        },
        {
          label: "Replace all results",
          description: "When the replacement field is focused.",
          keys: [[[primary, "Enter"]]],
        },
        { label: "Close Find", keys: [[["Esc"]]] },
      ],
    },
    {
      title: "Editing",
      items: [
        { label: "Undo", keys: [[[primary, "Z"]]] },
        {
          label: "Redo",
          keys: [mac ? [[...shiftedPrimary, "Z"]] : [[primary, "Y"]]],
        },
        { label: "Cut", keys: [[[primary, "X"]]] },
        { label: "Copy", keys: [[[primary, "C"]]] },
        { label: "Paste", keys: [[[primary, "V"]]] },
        {
          label: mac ? "Paste and Match Style" : "Paste Without Formatting",
          keys: [mac ? [[primary, alt, shift, "V"]] : [[primary, shift, "V"]]],
        },
        { label: "Select all", keys: [[[primary, "A"]]] },
        { label: "Bold", keys: [[[primary, "B"]]] },
        { label: "Italic", keys: [[[primary, "I"]]] },
        {
          label: "Continue or exit a Markdown list",
          description: "At the end of a list item.",
          keys: [[["Enter"]]],
        },
        {
          label: "Remove Markdown list structure",
          description: "At an empty item or its content boundary.",
          keys: [[["Backspace"]]],
        },
        {
          label: "Move to a link destination or indent",
          description:
            "From link text, selects its destination; otherwise indents using the current editor mode.",
          keys: [[["Tab"]]],
        },
        { label: "Outdent", keys: [[[shift, "Tab"]]] },
        { label: "Hide / show text cursor", keys: [[["Esc"]]] },
      ],
    },
    {
      title: "View and settings",
      items: [
        {
          label: "Toggle Rendered / Raw Markdown",
          keys: [mac ? [[...shiftedPrimary, "V"]] : [[primary, alt, "V"]]],
        },
        { label: "Toggle line wrapping", keys: [[[alt, "Z"]]] },
        {
          label: "Toggle formatting toolbar",
          keys: [[[...shiftedPrimary, "B"]]],
        },
        {
          label: "Zoom in",
          keys: [[[primary, "+"]], [[primary, "="]]],
        },
        { label: "Zoom out", keys: [[[primary, "-"]]] },
        {
          label: "Reset zoom",
          keys: [mac ? [[primary, "0"]] : [[...shiftedPrimary, "0"]]],
        },
        { label: "Open Settings", keys: [[[primary, ","]]] },
        ...(!mac
          ? ([
              { label: "Minimize window", keys: [[[primary, "M"]]] },
            ] satisfies ShortcutItem[])
          : []),
      ],
    },
    ...(mac
      ? ([
          {
            title: "Application",
            items: [
              { label: "Minimize window", keys: [[[primary, "M"]]] },
              { label: "Hide application", keys: [[[primary, "H"]]] },
              {
                label: "Hide other applications",
                keys: [[[alt, primary, "H"]]],
              },
              ...(keepReadyInBackground
                ? [
                    {
                      label: "Close and keep ready",
                      keys: [[[primary, "Q"]]],
                    },
                    {
                      label: "Quit application completely",
                      keys: [[[alt, primary, "Q"]]],
                    },
                  ]
                : [{ label: "Quit application", keys: [[[primary, "Q"]]] }]),
            ],
          },
        ] satisfies ShortcutSection[])
      : []),
  ]
}

export function KeyboardShortcutsPanel({
  keepReadyInBackground,
  platform,
  onBack,
}: KeyboardShortcutsPanelProps) {
  const sections = React.useMemo(
    () => platformShortcuts(platform, keepReadyInBackground),
    [keepReadyInBackground, platform]
  )
  const searchableSections = React.useMemo(
    () => searchableShortcutSections(sections),
    [sections]
  )
  const [query, setQuery] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)
  const queryTerms = React.useMemo(
    () => normalizedSearchText(query).split(/\s+/).filter(Boolean),
    [query]
  )
  const filteredSections = React.useMemo<readonly ShortcutSection[]>(
    () =>
      queryTerms.length === 0
        ? sections
        : searchableSections
            .map((section) => ({
              title: section.title,
              items: section.items
                .filter(({ searchText }) =>
                  queryTerms.every((term) => searchText.includes(term))
                )
                .map(({ item }) => item),
            }))
            .filter((section) => section.items.length > 0),
    [queryTerms, searchableSections, sections]
  )
  const filteredShortcutCount = React.useMemo(
    () =>
      filteredSections.reduce(
        (itemCount, section) => itemCount + section.items.length,
        0
      ),
    [filteredSections]
  )

  React.useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      data-keyboard-shortcuts-detail
      className="absolute inset-6 grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-6 bg-popover"
    >
      <DialogHeader>
        <div className="flex min-w-0 items-center gap-3 pr-8">
          <Button
            aria-label="Back to Settings"
            className="-ml-2"
            size="sm"
            type="button"
            variant="ghost"
            onClick={onBack}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          <h2 className="font-heading text-base leading-none font-medium">
            Keyboard Shortcuts
          </h2>
        </div>
        <DialogDescription>
          For a sequence, press the first keys, release them, then press the
          final key.
        </DialogDescription>
      </DialogHeader>

      <div>
        <InputGroup>
          <InputGroupInput
            ref={inputRef}
            aria-controls="keyboard-shortcuts-list"
            aria-label="Search keyboard shortcuts"
            autoComplete="off"
            placeholder="Search shortcuts…"
            spellCheck={false}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <InputGroupAddon>
            <SearchIcon className="size-4 shrink-0 opacity-50" />
          </InputGroupAddon>
        </InputGroup>
        <p aria-live="polite" className="sr-only" role="status">
          {queryTerms.length > 0
            ? `${filteredShortcutCount} ${filteredShortcutCount === 1 ? "shortcut" : "shortcuts"} found.`
            : ""}
        </p>
      </div>

      <div
        id="keyboard-shortcuts-list"
        aria-label="Keyboard shortcuts list"
        className="min-h-0 space-y-4 overflow-y-auto pr-1"
        role="region"
      >
        {filteredSections.length > 0 ? (
          filteredSections.map((section) => (
            <ShortcutSectionView key={section.title} {...section} />
          ))
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No matching shortcuts.
          </p>
        )}
      </div>
    </div>
  )
}
