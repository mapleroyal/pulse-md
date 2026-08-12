import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Code2Icon,
  EyeIcon,
  ListTreeIcon,
  MoreHorizontalIcon,
  PanelTopIcon,
  SearchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { MarkdownEditorMode } from "@/editor/types"
import type { TopRightControls } from "@/shared/contracts"

interface CompactDocumentActionsProps {
  canNavigateBack: boolean
  canNavigateForward: boolean
  controls: TopRightControls
  editorMode: MarkdownEditorMode
  formattingBarVisible: boolean
  markdownControlsEnabled: boolean
  open: boolean
  onFind: () => void
  onNavigateBack: () => void
  onNavigateForward: () => void
  onOpenChange: (open: boolean) => void
  onOpenOutline: () => void
  onToggleFormattingToolbar: () => void
  onToggleMode: () => void
}

export default function CompactDocumentActions({
  canNavigateBack,
  canNavigateForward,
  controls,
  editorMode,
  formattingBarVisible,
  markdownControlsEnabled,
  open,
  onFind,
  onNavigateBack,
  onNavigateForward,
  onOpenChange,
  onOpenOutline,
  onToggleFormattingToolbar,
  onToggleMode,
}: CompactDocumentActionsProps) {
  const hasNavigation =
    controls.navigation && (canNavigateBack || canNavigateForward)
  const hasGeneralActions =
    controls.find || (markdownControlsEnabled && controls.viewMode)
  const hasMarkdownActions =
    markdownControlsEnabled && (controls.outline || controls.formattingToolbar)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Document actions"
            className="top-chrome-document-menu"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {hasNavigation && canNavigateBack ? (
          <DropdownMenuItem onClick={onNavigateBack}>
            <ArrowLeftIcon aria-hidden="true" />
            Back
          </DropdownMenuItem>
        ) : null}
        {hasNavigation && canNavigateForward ? (
          <DropdownMenuItem onClick={onNavigateForward}>
            <ArrowRightIcon aria-hidden="true" />
            Forward
          </DropdownMenuItem>
        ) : null}
        {hasNavigation && (hasGeneralActions || hasMarkdownActions) ? (
          <DropdownMenuSeparator />
        ) : null}
        {markdownControlsEnabled && controls.viewMode ? (
          <DropdownMenuItem onClick={onToggleMode}>
            {editorMode === "live" ? (
              <Code2Icon aria-hidden="true" />
            ) : (
              <EyeIcon aria-hidden="true" />
            )}
            {editorMode === "live"
              ? "Switch to Raw Markdown"
              : "Switch to Rendered Markdown"}
          </DropdownMenuItem>
        ) : null}
        {controls.find ? (
          <DropdownMenuItem onClick={onFind}>
            <SearchIcon aria-hidden="true" />
            Find
          </DropdownMenuItem>
        ) : null}
        {hasGeneralActions && hasMarkdownActions ? (
          <DropdownMenuSeparator />
        ) : null}
        {hasMarkdownActions && controls.outline ? (
          <DropdownMenuItem onClick={onOpenOutline}>
            <ListTreeIcon aria-hidden="true" />
            Document outline
          </DropdownMenuItem>
        ) : null}
        {hasMarkdownActions && controls.formattingToolbar ? (
          <DropdownMenuItem onClick={onToggleFormattingToolbar}>
            <PanelTopIcon aria-hidden="true" />
            {formattingBarVisible ? "Hide" : "Show"} formatting toolbar
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
