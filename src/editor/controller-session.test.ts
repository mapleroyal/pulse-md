import {
  Compartment,
  EditorState,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state"
import { history } from "@codemirror/commands"
import { describe, expect, test } from "vitest"

import type { DocumentKind, SerializedEditorSession } from "../shared/contracts"
import { MarkdownEditorController } from "./controller"
import { markdownDocumentPath, markdownRemoteImagesEnabled } from "./media"
import type { MarkdownEditorSession } from "./types"

interface SessionControllerInternals {
  configureSessionForActivation(session: MarkdownEditorSession): void
  destroyed: boolean
  documentKind: DocumentKind
  documentPath: string | null
  documentPathConfiguration: Compartment
  remoteImagesConfiguration: Compartment
  remoteImagesEnabled: boolean
  setRemoteImagesEnabled(enabled: boolean): void
  serializeSession(
    session: MarkdownEditorSession,
    baselineContent?: string
  ): SerializedEditorSession
  deserializeSession(
    session: SerializedEditorSession,
    documentPath?: string | null,
    documentKind?: DocumentKind
  ): MarkdownEditorSession
  editorExtensions(
    mode: "live" | "source",
    lineWrapping: boolean,
    caretVisible: boolean,
    documentPath: string | null,
    documentKind: DocumentKind
  ): Extension[]
  view: {
    dispatch(spec: TransactionSpec): void
    state: EditorState
  }
}

function sessionController(
  documentPath: string | null,
  remoteImagesEnabled = false
) {
  const documentPathConfiguration = new Compartment()
  const remoteImagesConfiguration = new Compartment()
  let state = EditorState.create({
    extensions: [
      documentPathConfiguration.of(markdownDocumentPath.of(documentPath)),
      remoteImagesConfiguration.of(
        markdownRemoteImagesEnabled.of(remoteImagesEnabled)
      ),
    ],
  })
  const controller = Object.create(
    MarkdownEditorController.prototype
  ) as SessionControllerInternals
  controller.destroyed = false
  controller.documentKind = "markdown"
  controller.documentPath = documentPath
  controller.documentPathConfiguration = documentPathConfiguration
  controller.remoteImagesConfiguration = remoteImagesConfiguration
  controller.remoteImagesEnabled = remoteImagesEnabled
  controller.view = {
    get state() {
      return state
    },
    dispatch(spec) {
      state = state.update(spec).state
    },
  }
  return controller
}

function session(
  controller: SessionControllerInternals,
  documentPath: string | null
): MarkdownEditorSession {
  return {
    state: controller.view.state,
    documentKind: "markdown",
    documentPath,
    mode: "live",
    lineWrapping: true,
    caretVisible: false,
    viewport: { pos: 0, screenOffset: 0, scrollLeft: 0, scrollTop: 0 },
    viewportInitialized: false,
    revision: 0,
  }
}

describe("editor session media configuration", () => {
  test("keeps remote images disabled until the readiness signal enables them", () => {
    const controller = sessionController("/documents/one.md")

    expect(controller.view.state.facet(markdownRemoteImagesEnabled)).toBe(false)
    controller.setRemoteImagesEnabled(true)
    expect(controller.view.state.facet(markdownRemoteImagesEnabled)).toBe(true)
  })

  test("configures an inactive session's path before it is mounted", () => {
    const controller = sessionController("/documents/outgoing.md")
    const incoming = session(controller, "/other/incoming.md")
    controller.remoteImagesEnabled = true

    controller.configureSessionForActivation(incoming)

    expect(incoming.state.facet(markdownDocumentPath)).toBe(
      "/other/incoming.md"
    )
    expect(incoming.state.facet(markdownRemoteImagesEnabled)).toBe(true)
    expect(controller.documentPath).toBe("/other/incoming.md")
  })

  test("carries kind into activation and forces plain text to source mode", () => {
    const controller = sessionController("/documents/outgoing.md")
    const incoming = session(controller, "/other/incoming.json")
    incoming.documentKind = "plain-text"

    controller.configureSessionForActivation(incoming)

    expect(incoming.mode).toBe("source")
    expect(controller.documentKind).toBe("plain-text")
    expect(controller.documentPath).toBe("/other/incoming.json")
  })

  test("round-trips kind and normalizes a plain-text serialized mode", () => {
    const controller = sessionController("/documents/data.json")
    const plainSession = session(controller, "/documents/data.json")
    plainSession.documentKind = "plain-text"
    plainSession.mode = "live"
    plainSession.state = EditorState.create({
      doc: '{"answer":42}',
      extensions: history(),
    })

    const serialized = controller.serializeSession(plainSession)
    expect(serialized.documentKind).toBe("plain-text")
    expect(serialized.mode).toBe("source")

    controller.editorExtensions = () => [history()]
    const restored = controller.deserializeSession(
      serialized,
      "/documents/data.json",
      "plain-text"
    )
    expect(restored.documentKind).toBe("plain-text")
    expect(restored.mode).toBe("source")
    expect(restored.state.doc.toString()).toBe('{"answer":42}')
  })
})
