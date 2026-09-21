import * as React from "react"
import { EditorView } from "@codemirror/view"
import {
  BoldIcon,
  BookPlusIcon,
  CircleAlertIcon,
  ClipboardPasteIcon,
  CodeIcon,
  CopyIcon,
  ExternalLinkIcon,
  ItalicIcon,
  LinkIcon,
  Redo2Icon,
  ScissorsIcon,
  SpellCheck2Icon,
  StrikethroughIcon,
  TextSelectIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react"

import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  MarkdownEditorController,
  type MarkdownFormattingCommand,
  type MarkdownLinkActivation,
} from "@/editor/MarkdownEditorController"
import type {
  AppPlatform,
  EditorContextMenuDetails,
  FocusedEditCommand,
} from "@/shared/contracts"
import { isInternalTextDocumentPath } from "@/shared/document-kind"

interface EditorMenuSnapshot {
  activation: MarkdownLinkActivation | null
  canRedo: boolean
  canUndo: boolean
  editable: boolean
  hasSelection: boolean
  hasText: boolean
  headingLink: boolean
  ownedPointerSelection: boolean
  showFormatting: boolean
  showOpenInNewTabOnly: boolean
  tableRange: boolean
}

interface ContextMenuAnchor {
  getBoundingClientRect(): DOMRect
}

interface PendingNativeContextMenu {
  formattingEligible: boolean
  x: number
  y: number
}

export interface EditorContextMenuHandoff {
  activate(ready?: boolean): {
    contextMenuEvent: MouseEvent | null
    keyDownEvent: KeyboardEvent | null
    nativeDetails: EditorContextMenuDetails | null
  }
  queue(
    ...request:
      | [type: "ready"]
      | [type: "contextmenu", event: MouseEvent]
      | [type: "keydown", event: KeyboardEvent]
      | [type: "native", details: EditorContextMenuDetails]
  ): boolean
}

function isPrimaryModifierOnly(event: MouseEvent, platform: AppPlatform) {
  return platform === "darwin"
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

function localDocumentLink(activation: MarkdownLinkActivation | null) {
  if (activation?.kind !== "local") return false
  const withoutQueryOrFragment = activation.destination.split(/[?#]/, 1)[0]!
  let decoded = withoutQueryOrFragment
  try {
    decoded = decodeURIComponent(withoutQueryOrFragment)
  } catch {
    // Extension checks remain useful even when unrelated URL escapes are bad.
  }
  return isInternalTextDocumentPath(decoded)
}

function shortcut(platform: AppPlatform, mac: string, other: string) {
  return platform === "darwin" ? mac : other
}

export function EditorContextMenu({
  handoff,
  getController,
  platform,
  onCopyLink,
  onOpenLink,
  onOpenLinkInNewTab,
}: {
  handoff: EditorContextMenuHandoff
  getController: () => MarkdownEditorController | null
  platform: AppPlatform
  onCopyLink: (activation: MarkdownLinkActivation) => Promise<void>
  onOpenLink: (activation: MarkdownLinkActivation) => void | Promise<void>
  onOpenLinkInNewTab: (
    activation: Extract<MarkdownLinkActivation, { kind: "local" }>
  ) => void | Promise<void>
}) {
  const [snapshot, setSnapshot] = React.useState<EditorMenuSnapshot | null>(
    null
  )
  const [copyFailure, setCopyFailure] = React.useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = React.useState<ContextMenuAnchor | null>(
    null
  )
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [spelling, setSpelling] =
    React.useState<EditorContextMenuDetails | null>(null)
  const menuContentRef = React.useRef<HTMLDivElement | null>(null)
  const pendingNativeContextMenuRef =
    React.useRef<PendingNativeContextMenu | null>(null)
  const pendingFocusedEditCommandRef = React.useRef<FocusedEditCommand | null>(
    null
  )
  const pendingSpellingReplacementRef = React.useRef<{
    replacement: string
    word: string
  } | null>(null)
  const focusRetainedControllerRef =
    React.useRef<MarkdownEditorController | null>(null)

  const openEditorContextMenu = React.useCallback(
    (controller: MarkdownEditorController) => {
      const previous = focusRetainedControllerRef.current
      if (previous !== controller) {
        previous?.setContextMenuFocusRetained(false)
        focusRetainedControllerRef.current = controller
      }
      controller.setContextMenuFocusRetained(true)
      setMenuOpen(true)
    },
    []
  )

  const handleNativeContextMenu = React.useCallback(
    (details: EditorContextMenuDetails) => {
      const pending = pendingNativeContextMenuRef.current
      if (
        !pending ||
        Math.abs(details.x - pending.x) > 1 ||
        Math.abs(details.y - pending.y) > 1
      ) {
        return
      }
      pendingNativeContextMenuRef.current = null
      const controller = getController()
      let effectiveDetails = details
      if (controller) {
        const candidate = controller.spellingAtCoordinates(details.x, details.y)
        if (candidate) {
          const nativeSuggestionsMatchCandidate =
            details.misspelledWord === candidate.word
          let dictionarySuggestions = details.dictionarySuggestions
          if (
            !nativeSuggestionsMatchCandidate ||
            dictionarySuggestions.length === 0
          ) {
            try {
              dictionarySuggestions = [
                ...window.pulseMd.getSpellingSuggestions(candidate.word),
              ]
            } catch {
              dictionarySuggestions = []
            }
          }
          effectiveDetails = {
            ...details,
            dictionarySuggestions,
            misspelledWord: candidate.word,
          }
        }
      }
      controller?.retargetContextMenuSelection(
        effectiveDetails.x,
        effectiveDetails.y,
        effectiveDetails.misspelledWord
      )
      const tableSelection = controller?.getTableCellRangeSelection() ?? null
      const selectedText = controller?.getSelectedText() ?? ""
      const ownedPointerSelection =
        controller?.getOwnedPointerSelection() != null
      const visibleSpelling =
        effectiveDetails.misspelledWord &&
        (tableSelection != null ||
          selectedText !== effectiveDetails.misspelledWord)
          ? {
              ...effectiveDetails,
              dictionarySuggestions: [],
              misspelledWord: "",
            }
          : effectiveDetails
      setSnapshot((current) =>
        current
          ? {
              ...current,
              hasSelection:
                tableSelection != null ||
                (controller?.getSelectedText().length ?? 0) > 0,
              ownedPointerSelection,
              showFormatting:
                pending.formattingEligible && tableSelection == null,
              tableRange: tableSelection != null,
            }
          : current
      )
      setSpelling(visibleSpelling)
      if (controller) openEditorContextMenu(controller)
    },
    [getController, openEditorContextMenu]
  )

  React.useEffect(() => {
    if (!menuOpen) return

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const menuContent = menuContentRef.current
      const target =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null
      if (!menuContent || !target || menuContent.contains(target)) return

      const rootOwnerId = menuContent.dataset.rootownerid
      const targetPopup = target.closest<HTMLElement>("[data-rootownerid]")
      if (rootOwnerId && targetPopup?.dataset.rootownerid === rootOwnerId) {
        return
      }
      const secondaryEditorClick =
        (event.button === 2 ||
          (platform === "darwin" && event.button === 0 && event.ctrlKey)) &&
        getController()?.view.dom.contains(target)
      if (secondaryEditorClick) return
      setMenuOpen(false)
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true)
    return () =>
      document.removeEventListener(
        "pointerdown",
        closeOnOutsidePointerDown,
        true
      )
  }, [getController, menuOpen, platform])

  const handleContextMenuCapture = React.useCallback(
    (event: MouseEvent) => {
      const controller = getController()
      if (!controller) return
      const tableSelection = controller.getTableCellRangeSelection()
      const targetsTableSelection =
        tableSelection != null &&
        controller.tableCellRangeSelectionContainsCoordinates(
          event.clientX,
          event.clientY
        )
      const target = event.target
      const element = target instanceof Element ? target : null
      const onHeadingAnchor = Boolean(element?.closest(".cm-md-heading-anchor"))
      const activation = onHeadingAnchor
        ? controller.linkActivationAtCoordinates(
            event.clientX,
            event.clientY,
            element
          )
        : event.detail === 0
          ? controller.linkActivationAtSelection()
          : controller.linkActivationAtCoordinates(
              event.clientX,
              event.clientY,
              element
            )
      const editable = controller.view.state.facet(EditorView.editable)
      const insideContent = Boolean(element?.closest(".cm-content"))
      const onInteractiveWidget = Boolean(
        element?.closest(
          "button, input, summary, .cm-md-task-checkbox, .cm-md-code-tool, .cm-md-heading-anchor"
        )
      )
      pendingFocusedEditCommandRef.current = null
      pendingSpellingReplacementRef.current = null
      const formattingEligible =
        controller.getDocumentKind() === "markdown" &&
        editable &&
        insideContent &&
        !onInteractiveWidget
      if (targetsTableSelection || onHeadingAnchor) event.preventDefault()
      pendingNativeContextMenuRef.current =
        event.isTrusted && !targetsTableSelection && !onHeadingAnchor
          ? {
              formattingEligible,
              x: Math.round(event.clientX),
              y: Math.round(event.clientY),
            }
          : null
      setMenuAnchor({
        getBoundingClientRect: () =>
          DOMRect.fromRect({
            height: 0,
            width: 0,
            x: event.clientX,
            y: event.clientY,
          }),
      })
      setSpelling(null)
      setSnapshot({
        activation,
        canRedo: controller.canRedo(),
        canUndo: controller.canUndo(),
        editable,
        hasSelection:
          tableSelection != null || controller.getSelectedText().length > 0,
        hasText: controller.view.state.doc.length > 0,
        headingLink: onHeadingAnchor,
        ownedPointerSelection: controller.getOwnedPointerSelection() != null,
        showFormatting: formattingEligible && !tableSelection,
        showOpenInNewTabOnly:
          isPrimaryModifierOnly(event, platform) &&
          localDocumentLink(activation),
        tableRange: tableSelection != null,
      })
      if (!event.isTrusted || targetsTableSelection || onHeadingAnchor) {
        openEditorContextMenu(controller)
      }
    },
    [getController, openEditorContextMenu, platform]
  )

  React.useEffect(
    () => () => {
      focusRetainedControllerRef.current?.setContextMenuFocusRetained(false)
      focusRetainedControllerRef.current = null
    },
    []
  )

  const handleContextMenuKeyDownCapture = React.useCallback(
    (event: KeyboardEvent) => {
      const requested =
        event.key === "ContextMenu" ||
        (event.key === "F10" &&
          event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey)
      if (!requested) return
      const controller = getController()
      if (!controller?.view.hasFocus) return

      event.preventDefault()
      event.stopPropagation()
      const ownerWindow = controller.view.dom.ownerDocument.defaultView
      const selectionPosition = controller.view.state.selection.main.head
      const caretBounds = controller.view.coordsAtPos(selectionPosition)
      const contentBounds = controller.view.contentDOM.getBoundingClientRect()
      const clientX =
        caretBounds?.left ??
        contentBounds.left + Math.min(24, contentBounds.width)
      const clientY =
        caretBounds?.bottom ??
        contentBounds.top + Math.min(24, contentBounds.height)
      controller.view.contentDOM.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX,
          clientY,
          detail: 0,
          view: ownerWindow ?? undefined,
        })
      )
    },
    [getController]
  )

  React.useLayoutEffect(() => {
    const editor = getController()?.view.dom
    if (!editor) return
    let disposed = false
    const stopNativeContextMenu = window.pulseMd.onEditorContextMenu(
      handleNativeContextMenu
    )
    editor.addEventListener("contextmenu", handleContextMenuCapture, true)
    editor.addEventListener("keydown", handleContextMenuKeyDownCapture, true)
    const { contextMenuEvent, keyDownEvent, nativeDetails } = handoff.activate()
    queueMicrotask(() => {
      if (disposed) return
      if (contextMenuEvent) handleContextMenuCapture(contextMenuEvent)
      if (nativeDetails) handleNativeContextMenu(nativeDetails)
      if (keyDownEvent) handleContextMenuKeyDownCapture(keyDownEvent)
    })
    return () => {
      disposed = true
      handoff.activate(false)
      stopNativeContextMenu()
      editor.removeEventListener("contextmenu", handleContextMenuCapture, true)
      editor.removeEventListener(
        "keydown",
        handleContextMenuKeyDownCapture,
        true
      )
    }
  }, [
    getController,
    handleContextMenuCapture,
    handleContextMenuKeyDownCapture,
    handleNativeContextMenu,
    handoff,
  ])

  const runEditCommand = React.useCallback(
    (command: FocusedEditCommand | "select-all") => {
      const controller = getController()
      if (!controller) return
      if (command === "undo") controller.undo()
      else if (command === "redo") controller.redo()
      else if (command === "select-all") controller.selectAll()
      else if (
        (command === "copy" || command === "cut") &&
        controller.getTableCellRangeSelection()
      ) {
        setCopyFailure(null)
        const action =
          command === "copy"
            ? controller.copyTableCellRange()
            : controller.cutTableCellRange()
        const showFailure = () =>
          setCopyFailure(`Unable to ${command} the table range.`)
        void action
          .then((completed) => {
            if (!completed) showFailure()
          })
          .catch(showFailure)
      } else if (
        (command === "copy" || command === "cut") &&
        controller.getOwnedPointerSelection() != null
      ) {
        // Rendered and delimiter-free disjoint math selections own only their
        // clipboard serialization. They intentionally have no delete/cut
        // semantics because mutating the retained Markdown would be unsafe.
        if (command === "cut") return
        setCopyFailure(null)
        const showFailure = () =>
          setCopyFailure("Unable to copy the rendered selection.")
        void controller
          .copyOwnedPointerSelection()
          .then((completed) => {
            if (!completed) showFailure()
          })
          .catch(showFailure)
      } else pendingFocusedEditCommandRef.current = command
    },
    [getController]
  )

  const applyFormatting = React.useCallback(
    (command: MarkdownFormattingCommand) => {
      const controller = getController()
      if (!controller) return
      controller.focus()
      controller.applyFormatting(command)
    },
    [getController]
  )

  const spellingItems =
    spelling?.misspelledWord && snapshot?.editable ? (
      <>
        {spelling.dictionarySuggestions.map((suggestion) => (
          <ContextMenuItem
            key={suggestion}
            onClick={() => {
              pendingSpellingReplacementRef.current = {
                replacement: suggestion,
                word: spelling.misspelledWord,
              }
            }}
          >
            <SpellCheck2Icon />
            {suggestion}
          </ContextMenuItem>
        ))}
        <ContextMenuItem
          onClick={() => {
            const word = spelling.misspelledWord
            void window.pulseMd
              .addWordToSpellCheckerDictionary(word)
              .then(() => {
                getController()?.refreshSpellCheck(word)
              })
              .catch((error) => {
                console.error("Unable to add spelling dictionary word", error)
              })
          }}
        >
          <BookPlusIcon />
          Add to Dictionary
        </ContextMenuItem>
        <ContextMenuSeparator />
      </>
    ) : null

  const activation = snapshot?.activation ?? null
  const linkActionItems = activation ? (
    <>
      <ContextMenuItem onClick={() => void onOpenLink(activation)}>
        <ExternalLinkIcon />
        Open Link
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          setCopyFailure(null)
          void onCopyLink(activation).catch((error) => {
            console.error("Unable to copy link", error)
            setCopyFailure("The link could not be copied. Please try again.")
          })
        }}
      >
        <CopyIcon />
        Copy Link
      </ContextMenuItem>
    </>
  ) : null
  const linkItems = linkActionItems ? (
    <>
      {linkActionItems}
      <ContextMenuSeparator />
    </>
  ) : null

  return (
    <>
      <ContextMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onOpenChangeComplete={(open) => {
          if (open) return
          pendingNativeContextMenuRef.current = null
          setSnapshot(null)
          setMenuAnchor(null)
          setSpelling(null)
          const controller =
            focusRetainedControllerRef.current ?? getController()
          const pendingCommand = pendingFocusedEditCommandRef.current
          const pendingSpellingReplacement =
            pendingSpellingReplacementRef.current
          pendingFocusedEditCommandRef.current = null
          pendingSpellingReplacementRef.current = null
          if (controller && pendingSpellingReplacement) {
            controller.focus()
            controller.replaceSpellingSelection(
              pendingSpellingReplacement.word,
              pendingSpellingReplacement.replacement
            )
          } else if (controller && pendingCommand) {
            controller.focus()
            window.pulseMd.editFocusedControl(pendingCommand)
          } else {
            controller?.restoreFocus()
          }
          const focusRetainedController = focusRetainedControllerRef.current
          focusRetainedControllerRef.current = null
          focusRetainedController?.setContextMenuFocusRetained(false)
        }}
      >
        {snapshot ? (
          <ContextMenuContent
            ref={menuContentRef}
            aria-label={
              snapshot.headingLink ? "Heading link menu" : "Editor context menu"
            }
            anchor={menuAnchor}
            className={snapshot.headingLink ? "min-w-40" : "min-w-56"}
            data-editor-context-menu={
              snapshot.headingLink
                ? "heading-link"
                : snapshot.showOpenInNewTabOnly
                  ? "link-new-tab"
                  : snapshot.tableRange
                    ? "table-range"
                    : "general"
            }
          >
            {snapshot.headingLink ? (
              linkActionItems
            ) : snapshot.showOpenInNewTabOnly &&
              activation?.kind === "local" ? (
              <ContextMenuItem
                onClick={() => void onOpenLinkInNewTab(activation)}
              >
                <ExternalLinkIcon />
                Open in New Tab
              </ContextMenuItem>
            ) : (
              <>
                {spellingItems}
                {linkItems}
                <ContextMenuItem
                  disabled={!snapshot.canUndo}
                  onClick={() => runEditCommand("undo")}
                >
                  <Undo2Icon />
                  Undo
                  <ContextMenuShortcut>
                    {shortcut(platform, "⌘Z", "Ctrl+Z")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!snapshot.canRedo}
                  onClick={() => runEditCommand("redo")}
                >
                  <Redo2Icon />
                  Redo
                  <ContextMenuShortcut>
                    {shortcut(platform, "⇧⌘Z", "Ctrl+Y")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={
                    !snapshot.editable ||
                    !snapshot.hasSelection ||
                    snapshot.ownedPointerSelection
                  }
                  onClick={() => runEditCommand("cut")}
                >
                  <ScissorsIcon />
                  Cut
                  <ContextMenuShortcut>
                    {shortcut(platform, "⌘X", "Ctrl+X")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!snapshot.hasSelection}
                  onClick={() => runEditCommand("copy")}
                >
                  <CopyIcon />
                  Copy
                  <ContextMenuShortcut>
                    {shortcut(platform, "⌘C", "Ctrl+C")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={
                    !snapshot.editable ||
                    (spelling != null && !spelling.editFlags.canPaste)
                  }
                  onClick={() => runEditCommand("paste")}
                >
                  <ClipboardPasteIcon />
                  Paste
                  <ContextMenuShortcut>
                    {shortcut(platform, "⌘V", "Ctrl+V")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={
                    !snapshot.editable ||
                    (spelling != null && !spelling.editFlags.canPaste)
                  }
                  onClick={() => runEditCommand("paste-plain")}
                >
                  <ClipboardPasteIcon />
                  {platform === "darwin"
                    ? "Paste and Match Style"
                    : "Paste Without Formatting"}
                  <ContextMenuShortcut>
                    {shortcut(platform, "⌥⇧⌘V", "Ctrl+Shift+V")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!snapshot.hasText}
                  onClick={() => runEditCommand("select-all")}
                >
                  <TextSelectIcon />
                  Select All
                  <ContextMenuShortcut>
                    {shortcut(platform, "⌘A", "Ctrl+A")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                {snapshot.showFormatting ? (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <BoldIcon />
                        Formatting
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent className="min-w-52">
                        <ContextMenuItem
                          onClick={() => applyFormatting({ type: "bold" })}
                        >
                          <BoldIcon />
                          Bold
                          <ContextMenuShortcut>
                            {shortcut(platform, "⌘B", "Ctrl+B")}
                          </ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => applyFormatting({ type: "italic" })}
                        >
                          <ItalicIcon />
                          Italic
                          <ContextMenuShortcut>
                            {shortcut(platform, "⌘I", "Ctrl+I")}
                          </ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() =>
                            applyFormatting({ type: "strikethrough" })
                          }
                        >
                          <StrikethroughIcon />
                          Strikethrough
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() =>
                            applyFormatting({ type: "inline-code" })
                          }
                        >
                          <CodeIcon />
                          Inline Code
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => applyFormatting({ type: "link" })}
                        >
                          <LinkIcon />
                          Link
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  </>
                ) : null}
              </>
            )}
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
      {copyFailure ? (
        <Alert
          aria-live="assertive"
          className="fixed top-12 left-1/2 z-50 flex w-[min(32rem,calc(100vw-1rem))] -translate-x-1/2 items-center gap-2 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-xl"
          role="alert"
        >
          <CircleAlertIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-destructive"
          />
          <span className="min-w-0 flex-1 text-sm">{copyFailure}</span>
          <Button
            aria-label="Dismiss"
            className="size-7"
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={() => setCopyFailure(null)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </Alert>
      ) : null}
    </>
  )
}
