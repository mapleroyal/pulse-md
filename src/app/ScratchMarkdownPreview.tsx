import * as React from "react"

import {
  ScratchSourcePreview,
  type ScratchPreviewRenderState,
} from "@/app/ScratchPicker"
import type {
  MarkdownEditorHandle,
  MarkdownLinkActivation,
} from "@/editor/MarkdownEditorController"
import type { OptionalLivePreviewSupport } from "@/editor/types"
import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"
import type { AppPlatform, AppSettings } from "@/shared/contracts"

const MAX_RENDERED_PREVIEW_LENGTH = 1024 * 1024
const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"

const optionalSupportRequests = new WeakSet<MarkdownEditorHandle>()
const loadControllerModule = createRetryableDynamicImport(
  () => import("@/editor/MarkdownEditorController")
)
const loadOptionalPreviewSupport = createRetryableDynamicImport(
  () => import("@/editor/optional-live-preview")
)

function subscribeToSystemScheme(onChange: () => void) {
  const query = window.matchMedia(COLOR_SCHEME_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function systemUsesDarkScheme() {
  return window.matchMedia(COLOR_SCHEME_QUERY).matches
}

function extensionsNeedOptionalPreview(
  extensions: AppSettings["markdownExtensions"]
) {
  return (
    extensions.latex ||
    extensions.emojiExpansion ||
    extensions.footnotes ||
    extensions.mermaid ||
    extensions.sanitizedHtml
  )
}

function requestOptionalPreviewSupport(
  controller: MarkdownEditorHandle,
  extensions: AppSettings["markdownExtensions"]
) {
  if (
    !extensionsNeedOptionalPreview(extensions) ||
    optionalSupportRequests.has(controller)
  ) {
    return
  }
  optionalSupportRequests.add(controller)
  void loadOptionalPreviewSupport()
    .then((module) => {
      controller.setOptionalLivePreviewSupport(
        module.optionalLivePreviewSupport as OptionalLivePreviewSupport
      )
    })
    .catch((error: unknown) => {
      optionalSupportRequests.delete(controller)
      console.error("Unable to load optional scratch previews", error)
    })
}

interface PreviewControllerConfig {
  platform: AppPlatform
  preview: NonNullable<ScratchPreviewRenderState["preview"]>
  scheme: "dark" | "light"
  settings: AppSettings
}

interface AppliedPreviewDocument {
  content: string
  modifiedAt: number
  scratchId: string
}

function applyControllerConfig(
  controller: MarkdownEditorHandle,
  config: PreviewControllerConfig,
  appliedDocument: React.MutableRefObject<AppliedPreviewDocument | null>
) {
  const { platform, preview, scheme, settings } = config
  const previous = appliedDocument.current
  const documentChanged =
    previous?.scratchId !== preview.scratchId ||
    previous.modifiedAt !== preview.modifiedAt ||
    previous.content !== preview.content
  const activeTextControl =
    documentChanged && platform === "darwin"
      ? controller.view.dom.ownerDocument.activeElement
      : null
  if (documentChanged) {
    controller.setDocumentIdentity(null, "markdown")
    controller.setDocument(preview.content, {
      addToHistory: false,
      notify: false,
    })
    controller.view.scrollDOM.scrollLeft = 0
    controller.view.scrollDOM.scrollTop = 0
    appliedDocument.current = {
      content: preview.content,
      modifiedAt: preview.modifiedAt,
      scratchId: preview.scratchId,
    }
  }

  controller.setMode("live")
  controller.setReadOnly(true)
  controller.setLineWrapping(settings.lineWrapping)
  controller.setMaxContentWidth(settings.maxContentWidth)
  controller.setMarkdownExtensions(settings.markdownExtensions)
  controller.setSourceIndentation(
    settings.sourceIndentation,
    settings.sourceIndentSize
  )
  controller.setAppearanceProfile(settings.themeByScheme[scheme])
  controller.setSpellCheck(false)
  controller.setRemoteImagesEnabled(false)
  controller.view.contentDOM.tabIndex = -1
  controller.view.dom.dataset.scratchPreviewId = preview.scratchId
  requestOptionalPreviewSupport(controller, settings.markdownExtensions)
  controller.refreshContentGeometry(true)
  if (
    (activeTextControl instanceof HTMLInputElement ||
      activeTextControl instanceof HTMLTextAreaElement) &&
    activeTextControl.isConnected &&
    activeTextControl.ownerDocument.activeElement === activeTextControl
  ) {
    // Updating a secondary CodeMirror view can invalidate Chromium's macOS
    // text client without changing document.activeElement. Restore the same
    // control synchronously so the caret and native text input stay live.
    activeTextControl.blur()
    activeTextControl.focus({ preventScroll: true })
  }
}

export interface ScratchMarkdownPreviewProps {
  state: ScratchPreviewRenderState
  settings: AppSettings
  platform: AppPlatform
  openLink?: (activation: MarkdownLinkActivation) => Promise<void> | void
}

export function ScratchMarkdownPreview({
  state,
  settings,
  platform,
  openLink,
}: ScratchMarkdownPreviewProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const controllerRef = React.useRef<MarkdownEditorHandle | null>(null)
  const appliedDocumentRef = React.useRef<AppliedPreviewDocument | null>(null)
  const openLinkRef = React.useRef(openLink)
  const latestConfigRef = React.useRef<PreviewControllerConfig | null>(null)
  const [controllerError, setControllerError] = React.useState<{
    message: string
    scratchId: string
  } | null>(null)
  const systemDark = React.useSyncExternalStore(
    subscribeToSystemScheme,
    systemUsesDarkScheme,
    () => false
  )
  const scheme =
    settings.appearanceMode === "system"
      ? systemDark
        ? "dark"
        : "light"
      : settings.appearanceMode
  const preview = state.preview
  const eligible =
    !state.error &&
    !state.loading &&
    preview !== null &&
    !preview.truncated &&
    preview.content.length <= MAX_RENDERED_PREVIEW_LENGTH
  const matchingControllerError =
    preview && controllerError?.scratchId === preview.scratchId
      ? controllerError
      : null
  const shouldRender = eligible && matchingControllerError === null
  const config = React.useMemo<PreviewControllerConfig | null>(
    () =>
      preview && eligible ? { platform, preview, scheme, settings } : null,
    [eligible, platform, preview, scheme, settings]
  )

  React.useLayoutEffect(() => {
    openLinkRef.current = openLink
  }, [openLink])

  React.useLayoutEffect(() => {
    latestConfigRef.current = config
    const controller = controllerRef.current
    if (controller && config) {
      applyControllerConfig(controller, config, appliedDocumentRef)
    }
  }, [config])

  React.useEffect(() => {
    if (!config || matchingControllerError || controllerRef.current) return
    let disposed = false

    void loadControllerModule()
      .then(({ MarkdownEditorController }) => {
        const host = hostRef.current
        const latestConfig = latestConfigRef.current
        if (disposed || !host || !latestConfig || controllerRef.current) {
          return
        }

        const controller = new MarkdownEditorController({
          ariaLabel: "Scratch Markdown preview",
          appearanceProfile:
            latestConfig.settings.themeByScheme[latestConfig.scheme],
          autofocus: false,
          focusWhenEmpty: false,
          content: latestConfig.preview.content,
          documentKind: "markdown",
          lineWrapping: latestConfig.settings.lineWrapping,
          markdownExtensions: latestConfig.settings.markdownExtensions,
          maxContentWidth: latestConfig.settings.maxContentWidth,
          mode: "live",
          openLink: (activation) => openLinkRef.current?.(activation),
          parent: host,
          platform,
          readOnly: true,
          sourceIndentation: latestConfig.settings.sourceIndentation,
          sourceIndentSize: latestConfig.settings.sourceIndentSize,
          spellCheck: false,
          windowActive: true,
        })
        controllerRef.current = controller
        appliedDocumentRef.current = {
          content: latestConfig.preview.content,
          modifiedAt: latestConfig.preview.modifiedAt,
          scratchId: latestConfig.preview.scratchId,
        }
        applyControllerConfig(controller, latestConfig, appliedDocumentRef)
      })
      .catch((error: unknown) => {
        if (disposed) return
        setControllerError({
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "Rendered preview is unavailable.",
          scratchId: config.preview.scratchId,
        })
      })

    return () => {
      disposed = true
    }
  }, [config, matchingControllerError, platform])

  React.useEffect(
    () => () => {
      controllerRef.current?.destroy()
      controllerRef.current = null
      appliedDocumentRef.current = null
    },
    []
  )

  return (
    <div className="h-full min-h-0">
      <div
        ref={hostRef}
        aria-label={
          state.scratch
            ? `Rendered preview of ${state.scratch.displayTitle}`
            : "Rendered scratch preview"
        }
        className="h-full min-h-0 overflow-hidden [--editor-content-top-padding:1.25rem] [--window-chrome-height:0px]"
        data-scratch-markdown-preview={state.scratch?.scratchId}
        hidden={!shouldRender}
        role="region"
      />
      {!shouldRender ? (
        matchingControllerError ? (
          <div className="min-h-full">
            <p className="border-b border-border/70 px-5 py-3 text-xs text-muted-foreground">
              {matchingControllerError.message} Showing source instead.
            </p>
            <ScratchSourcePreview {...state} />
          </div>
        ) : (
          <ScratchSourcePreview {...state} />
        )
      ) : null}
    </div>
  )
}

export default ScratchMarkdownPreview
