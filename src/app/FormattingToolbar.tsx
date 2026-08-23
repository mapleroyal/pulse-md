import * as React from "react"
import {
  BoldIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  HeadingIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  QuoteIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TableIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  MarkdownFormattingCommand,
  MarkdownHeadingLevel,
} from "@/editor/formatting"
import {
  hasHorizontalOverflow,
  installHorizontalWheelScrolling,
} from "@/app/horizontal-wheel-scroll"
import { cn } from "@/lib/utils"
import type {
  FormattingBarPosition,
  TabWheelScrollDirection,
} from "@/shared/contracts"

const TABLE_PICKER_COLUMNS = 6
const TABLE_PICKER_ROWS = 6
const MAX_TABLE_SIZE = 20
const TOOLBAR_BUTTON_CLASS =
  "size-8 [&_svg:not([class*='size-'])]:size-[17.6px]"

interface FormattingToolbarProps {
  className?: string
  hoverLatched: boolean
  position: FormattingBarPosition
  responsiveControlsInset: number
  fallbackWheelScrollerRef: React.RefObject<HTMLDivElement | null>
  visible: boolean
  wheelScrollDirection: TabWheelScrollDirection
  onHoverLatchedChange: (latched: boolean) => void
  onFormat: (command: MarkdownFormattingCommand) => void
}

type FormattingToolbarPresence = "absent" | "entering" | "visible" | "exiting"

interface ToolbarOverflow {
  left: boolean
  right: boolean
  scrollable: boolean
}

interface ToolbarActionProps {
  icon: React.ReactNode
  label: string
  onSelect: () => void
}

function ToolbarAction({ icon, label, onSelect }: ToolbarActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={TOOLBAR_BUTTON_CLASS}
            data-toolbar-item=""
            size="icon-xs"
            tabIndex={-1}
            type="button"
            variant="ghost"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onSelect}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function FormattingToolbarContent({
  className,
  fallbackWheelScrollerRef,
  hoverLatched,
  position,
  responsiveControlsInset,
  visible,
  wheelScrollDirection,
  onHoverLatchedChange,
  onFormat,
  onTransitionEnd,
}: FormattingToolbarProps & {
  onTransitionEnd: React.TransitionEventHandler<HTMLDivElement>
}) {
  const [headingOpen, setHeadingOpen] = React.useState(false)
  const [tableOpen, setTableOpen] = React.useState(false)
  const [tableSize, setTableSize] = React.useState({ columns: 2, rows: 2 })
  const [tableFocus, setTableFocus] = React.useState({ columns: 2, rows: 2 })
  const [customTableSize, setCustomTableSize] = React.useState({
    columns: "",
    rows: "",
  })
  const [overflow, setOverflow] = React.useState<ToolbarOverflow>({
    left: false,
    right: false,
    scrollable: false,
  })
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const toolbarRef = React.useRef<HTMLDivElement>(null)
  const tableCellRefs = React.useRef<Array<HTMLButtonElement | null>>([])

  const toolbarItems = React.useCallback(() => {
    const toolbar = toolbarRef.current
    return toolbar
      ? [
          ...toolbar.querySelectorAll<HTMLButtonElement>(
            "button[data-toolbar-item]:not(:disabled)"
          ),
        ]
      : []
  }, [])

  const moveToolbarFocus = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      if (!(target instanceof HTMLButtonElement)) return
      const items = toolbarItems()
      const currentIndex = items.indexOf(target)
      if (currentIndex < 0 || items.length === 0) return

      let nextIndex: number
      switch (event.key) {
        case "ArrowLeft":
          nextIndex = (currentIndex - 1 + items.length) % items.length
          break
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % items.length
          break
        case "Home":
          nextIndex = 0
          break
        case "End":
          nextIndex = items.length - 1
          break
        default:
          return
      }

      event.preventDefault()
      for (const item of items)
        item.tabIndex = item === items[nextIndex] ? 0 : -1
      items[nextIndex]?.focus({ preventScroll: true })
      items[nextIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" })
    },
    [toolbarItems]
  )

  const retainToolbarFocusItem = React.useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof HTMLButtonElement)) return
      const items = toolbarItems()
      if (!items.includes(target)) return
      for (const item of items) item.tabIndex = item === target ? 0 : -1
    },
    [toolbarItems]
  )

  const updateOverflow = React.useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const maxScrollLeft = Math.max(
      0,
      scroller.scrollWidth - scroller.clientWidth
    )
    const next = {
      left: scroller.scrollLeft > 1,
      right: scroller.scrollLeft < maxScrollLeft - 1,
      scrollable: maxScrollLeft > 1,
    }
    setOverflow((current) =>
      current.left === next.left &&
      current.right === next.right &&
      current.scrollable === next.scrollable
        ? current
        : next
    )
  }, [])

  React.useLayoutEffect(() => {
    if (!visible) return
    const scroller = scrollRef.current
    const toolbar = toolbarRef.current
    if (!scroller || !toolbar) return
    updateOverflow()
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(scroller)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [updateOverflow, visible])

  React.useEffect(() => {
    const surface = surfaceRef.current
    const scroller = scrollRef.current
    if (!surface || !scroller) return
    const removeToolbarScrolling = installHorizontalWheelScrolling(
      surface,
      scroller,
      wheelScrollDirection
    )
    const removeFallbackScrolling = installHorizontalWheelScrolling(
      surface,
      () => fallbackWheelScrollerRef.current,
      wheelScrollDirection,
      () => !hasHorizontalOverflow(scroller)
    )
    return () => {
      removeToolbarScrolling()
      removeFallbackScrolling()
    }
  }, [fallbackWheelScrollerRef, wheelScrollDirection])

  const scrollToolbar = React.useCallback((direction: -1 | 1) => {
    const scroller = scrollRef.current
    if (!scroller) return
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    scroller.scrollBy({
      behavior: reduceMotion ? "auto" : "smooth",
      left: direction * Math.max(160, scroller.clientWidth * 0.65),
    })
  }, [])

  const format = React.useCallback(
    (command: MarkdownFormattingCommand) => onFormat(command),
    [onFormat]
  )

  const customColumns = Number(customTableSize.columns)
  const customRows = Number(customTableSize.rows)
  const customTableSizeValid =
    Number.isInteger(customColumns) &&
    customColumns >= 1 &&
    customColumns <= MAX_TABLE_SIZE &&
    Number.isInteger(customRows) &&
    customRows >= 1 &&
    customRows <= MAX_TABLE_SIZE

  const insertCustomTable = React.useCallback(() => {
    if (!customTableSizeValid) return
    format({ type: "table", columns: customColumns, rows: customRows })
    setTableOpen(false)
  }, [customColumns, customRows, customTableSizeValid, format])

  React.useEffect(() => {
    if (visible) return
    queueMicrotask(() => {
      setHeadingOpen(false)
      setTableOpen(false)
    })
  }, [visible])

  return (
    <TooltipProvider>
      <div
        ref={surfaceRef}
        aria-hidden={!visible || undefined}
        className={cn(
          "formatting-toolbar fixed top-[calc(var(--window-chrome-height)-var(--formatting-toolbar-overlap))] right-0 left-0 z-[41] h-[var(--formatting-toolbar-height)] overflow-hidden bg-transparent text-[var(--document-foreground)]",
          className
        )}
        data-visible={visible || undefined}
        inert={!visible || undefined}
        style={
          responsiveControlsInset > 0
            ? { right: `${responsiveControlsInset}px` }
            : undefined
        }
        onPointerEnter={() => onHoverLatchedChange(true)}
        onTransitionEnd={onTransitionEnd}
      >
        {!hoverLatched ? (
          <div
            aria-hidden="true"
            className="formatting-toolbar-hover-activation"
            onPointerEnter={() => onHoverLatchedChange(true)}
          />
        ) : null}
        <div
          ref={scrollRef}
          className="formatting-toolbar-scroll relative z-[1] h-full [scrollbar-width:none] overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
          data-scrollable={overflow.scrollable || undefined}
          onScroll={updateOverflow}
        >
          <div
            ref={toolbarRef}
            id="formatting-toolbar-actions"
            aria-hidden={!visible || undefined}
            aria-label="Formatting toolbar"
            aria-orientation="horizontal"
            className="flex h-full w-max min-w-full items-center gap-0.5 px-2 data-[position=center]:justify-center data-[position=right]:justify-end"
            data-position={position}
            role="toolbar"
            style={
              responsiveControlsInset > 0
                ? { justifyContent: "flex-start" }
                : undefined
            }
            onFocusCapture={retainToolbarFocusItem}
            onKeyDown={moveToolbarFocus}
          >
            <DropdownMenu
              open={visible && headingOpen}
              onOpenChange={setHeadingOpen}
            >
              <Tooltip>
                <DropdownMenuTrigger
                  render={
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Heading style"
                          className={TOOLBAR_BUTTON_CLASS}
                          data-toolbar-item=""
                          size="icon-xs"
                          tabIndex={0}
                          type="button"
                          variant="ghost"
                        />
                      }
                    />
                  }
                >
                  <HeadingIcon />
                </DropdownMenuTrigger>
                <TooltipContent side="bottom">Heading style</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-40 min-w-40">
                {(
                  [
                    [0, "Paragraph"],
                    [1, "Heading 1"],
                    [2, "Heading 2"],
                    [3, "Heading 3"],
                    [4, "Heading 4"],
                    [5, "Heading 5"],
                    [6, "Heading 6"],
                  ] as const satisfies readonly (readonly [
                    MarkdownHeadingLevel,
                    string,
                  ])[]
                ).map(([level, label]) => (
                  <DropdownMenuItem
                    key={level}
                    onClick={() => format({ type: "heading", level })}
                  >
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Separator
              aria-hidden="true"
              className="mx-1 data-vertical:h-6 data-vertical:self-center"
              orientation="vertical"
            />
            <ToolbarAction
              icon={<BoldIcon />}
              label="Bold"
              onSelect={() => format({ type: "bold" })}
            />
            <ToolbarAction
              icon={<ItalicIcon />}
              label="Italic"
              onSelect={() => format({ type: "italic" })}
            />
            <ToolbarAction
              icon={<StrikethroughIcon />}
              label="Strikethrough"
              onSelect={() => format({ type: "strikethrough" })}
            />
            <ToolbarAction
              icon={<CodeIcon />}
              label="Inline code"
              onSelect={() => format({ type: "inline-code" })}
            />
            <ToolbarAction
              icon={<LinkIcon />}
              label="Link"
              onSelect={() => format({ type: "link" })}
            />
            <ToolbarAction
              icon={<ImageIcon />}
              label="Image"
              onSelect={() => format({ type: "image" })}
            />

            <Separator
              aria-hidden="true"
              className="mx-1 data-vertical:h-6 data-vertical:self-center"
              orientation="vertical"
            />
            <ToolbarAction
              icon={<ListIcon />}
              label="Bulleted list"
              onSelect={() => format({ type: "bullet-list" })}
            />
            <ToolbarAction
              icon={<ListOrderedIcon />}
              label="Numbered list"
              onSelect={() => format({ type: "ordered-list" })}
            />
            <ToolbarAction
              icon={<ListChecksIcon />}
              label="Task list"
              onSelect={() => format({ type: "task-list" })}
            />
            <ToolbarAction
              icon={<QuoteIcon />}
              label="Blockquote"
              onSelect={() => format({ type: "blockquote" })}
            />
            <ToolbarAction
              icon={<SquareCodeIcon />}
              label="Code block"
              onSelect={() => format({ type: "code-block" })}
            />
            <ToolbarAction
              icon={<MinusIcon />}
              label="Horizontal rule"
              onSelect={() => format({ type: "horizontal-rule" })}
            />

            <Separator
              aria-hidden="true"
              className="mx-1 data-vertical:h-6 data-vertical:self-center"
              orientation="vertical"
            />
            <Popover
              open={visible && tableOpen}
              onOpenChange={(open) => {
                setTableOpen(open)
                if (!open) return
                setTableSize({ columns: 2, rows: 2 })
                setTableFocus({ columns: 2, rows: 2 })
                setCustomTableSize({ columns: "", rows: "" })
              }}
            >
              <Tooltip>
                <PopoverTrigger
                  render={
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Insert table"
                          className={cn(
                            TOOLBAR_BUTTON_CLASS,
                            "aria-expanded:bg-transparent!"
                          )}
                          data-toolbar-item=""
                          size="icon-xs"
                          tabIndex={-1}
                          type="button"
                          variant="ghost"
                          onPointerDown={(event) => event.preventDefault()}
                        />
                      }
                    />
                  }
                >
                  <TableIcon />
                </PopoverTrigger>
                <TooltipContent side="bottom">Insert table</TooltipContent>
              </Tooltip>
              <PopoverContent align="start" className="w-auto gap-2 p-3">
                <div className="text-center text-xs font-medium tabular-nums">
                  {tableSize.columns} × {tableSize.rows}
                </div>
                <div
                  aria-label="Table size"
                  aria-colcount={TABLE_PICKER_COLUMNS}
                  aria-rowcount={TABLE_PICKER_ROWS}
                  className="grid w-fit gap-1 self-center"
                  role="grid"
                  style={{
                    gridTemplateColumns: `repeat(${TABLE_PICKER_COLUMNS}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: TABLE_PICKER_ROWS }, (_, rowIndex) => {
                    const row = rowIndex + 1
                    return (
                      <div key={row} className="contents" role="row">
                        {Array.from(
                          { length: TABLE_PICKER_COLUMNS },
                          (_, columnIndex) => {
                            const column = columnIndex + 1
                            const index =
                              rowIndex * TABLE_PICKER_COLUMNS + columnIndex
                            const highlighted =
                              row <= tableSize.rows &&
                              column <= tableSize.columns
                            const focused =
                              row === tableFocus.rows &&
                              column === tableFocus.columns
                            return (
                              <button
                                key={`${column}:${row}`}
                                ref={(element) => {
                                  tableCellRefs.current[index] = element
                                }}
                                aria-colindex={column}
                                aria-label={`${column} columns by ${row} rows`}
                                aria-rowindex={row}
                                aria-selected={highlighted}
                                data-corner-shape="app"
                                className={cn(
                                  "size-5 rounded-[calc(4px*var(--app-corner-radius-scale))] border border-[color-mix(in_oklab,var(--document-foreground)_18%,transparent)] bg-transparent",
                                  highlighted &&
                                    "border-[color-mix(in_oklab,var(--document-foreground)_42%,transparent)] bg-[color-mix(in_oklab,var(--document-foreground)_16%,transparent)]"
                                )}
                                role="gridcell"
                                tabIndex={focused ? 0 : -1}
                                type="button"
                                onFocus={() => {
                                  setTableFocus({ columns: column, rows: row })
                                  setTableSize({ columns: column, rows: row })
                                }}
                                onKeyDown={(event) => {
                                  let nextColumn = column
                                  let nextRow = row
                                  switch (event.key) {
                                    case "ArrowLeft":
                                      nextColumn = Math.max(1, column - 1)
                                      break
                                    case "ArrowRight":
                                      nextColumn = Math.min(
                                        TABLE_PICKER_COLUMNS,
                                        column + 1
                                      )
                                      break
                                    case "ArrowUp":
                                      nextRow = Math.max(1, row - 1)
                                      break
                                    case "ArrowDown":
                                      nextRow = Math.min(
                                        TABLE_PICKER_ROWS,
                                        row + 1
                                      )
                                      break
                                    case "Home":
                                      if (event.ctrlKey || event.metaKey)
                                        nextRow = 1
                                      nextColumn = 1
                                      break
                                    case "End":
                                      if (event.ctrlKey || event.metaKey) {
                                        nextRow = TABLE_PICKER_ROWS
                                      }
                                      nextColumn = TABLE_PICKER_COLUMNS
                                      break
                                    default:
                                      return
                                  }
                                  event.preventDefault()
                                  setTableFocus({
                                    columns: nextColumn,
                                    rows: nextRow,
                                  })
                                  tableCellRefs.current[
                                    (nextRow - 1) * TABLE_PICKER_COLUMNS +
                                      nextColumn -
                                      1
                                  ]?.focus()
                                }}
                                onPointerEnter={() =>
                                  setTableSize({ columns: column, rows: row })
                                }
                                onClick={() => {
                                  format({
                                    type: "table",
                                    columns: column,
                                    rows: row,
                                  })
                                  setTableOpen(false)
                                }}
                              />
                            )
                          }
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="border-t border-border/70 pt-2">
                  <div className="mb-1.5 text-xs font-medium">Custom size</div>
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      insertCustomTable()
                    }}
                  >
                    <Input
                      aria-label="Columns"
                      className="h-8 w-20 rounded-xl px-2 text-center tabular-nums"
                      inputMode="numeric"
                      max={MAX_TABLE_SIZE}
                      min={1}
                      placeholder="Cols"
                      step={1}
                      type="number"
                      value={customTableSize.columns}
                      onChange={(event) => {
                        const columns = event.currentTarget.value
                        setCustomTableSize((size) => ({
                          ...size,
                          columns,
                        }))
                      }}
                    />
                    <span aria-hidden="true" className="text-muted-foreground">
                      ×
                    </span>
                    <Input
                      aria-label="Rows"
                      className="h-8 w-20 rounded-xl px-2 text-center tabular-nums"
                      inputMode="numeric"
                      max={MAX_TABLE_SIZE}
                      min={1}
                      placeholder="Rows"
                      step={1}
                      type="number"
                      value={customTableSize.rows}
                      onChange={(event) => {
                        const rows = event.currentTarget.value
                        setCustomTableSize((size) => ({
                          ...size,
                          rows,
                        }))
                      }}
                    />
                    <Button
                      className="h-8 rounded-xl px-3"
                      disabled={!customTableSizeValid}
                      size="sm"
                      type="submit"
                    >
                      Insert
                    </Button>
                  </form>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        {overflow.left ? (
          <Button
            aria-controls="formatting-toolbar-actions"
            aria-label="Scroll formatting toolbar left"
            className="formatting-toolbar-scroll-button absolute top-1.5 left-1 z-[2] border-border bg-popover shadow-sm"
            size="icon-xs"
            type="button"
            variant="secondary"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => scrollToolbar(-1)}
          >
            <ChevronLeftIcon />
          </Button>
        ) : null}
        {overflow.right ? (
          <Button
            aria-controls="formatting-toolbar-actions"
            aria-label="Scroll formatting toolbar right"
            className="formatting-toolbar-scroll-button absolute top-1.5 right-1 z-[2] border-border bg-popover shadow-sm"
            size="icon-xs"
            type="button"
            variant="secondary"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => scrollToolbar(1)}
          >
            <ChevronRightIcon />
          </Button>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

export function FormattingToolbar(props: FormattingToolbarProps) {
  const visibleRef = React.useRef(props.visible)
  const animationsReadyRef = React.useRef(false)
  const [presence, setPresence] = React.useState<FormattingToolbarPresence>(
    () => (props.visible ? "visible" : "absent")
  )

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      animationsReadyRef.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  React.useLayoutEffect(() => {
    visibleRef.current = props.visible
  }, [props.visible])

  React.useLayoutEffect(() => {
    if (props.visible) {
      setPresence((current) => {
        if (!animationsReadyRef.current) return "visible"
        return current === "absent" ? "entering" : "visible"
      })
      return
    }

    setPresence((current) => {
      if (current === "absent" || current === "entering") return "absent"
      return animationsReadyRef.current ? "exiting" : "absent"
    })
  }, [props.visible])

  React.useEffect(() => {
    if (presence !== "entering") return
    const frame = requestAnimationFrame(() => {
      if (visibleRef.current) setPresence("visible")
    })
    return () => cancelAnimationFrame(frame)
  }, [presence])

  const finishExit = React.useCallback<
    React.TransitionEventHandler<HTMLDivElement>
  >((event) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "opacity" ||
      visibleRef.current
    ) {
      return
    }
    setPresence((current) => (current === "exiting" ? "absent" : current))
  }, [])

  if (presence === "absent") return null

  return (
    <FormattingToolbarContent
      {...props}
      visible={presence === "visible"}
      onTransitionEnd={finishExit}
    />
  )
}
