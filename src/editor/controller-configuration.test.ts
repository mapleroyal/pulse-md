import {
  LanguageDescription,
  syntaxTree,
  type LanguageSupport,
} from "@codemirror/language"
import { yaml } from "@codemirror/lang-yaml"
import {
  Compartment,
  EditorState,
  type Extension,
  type StateEffect,
  type TransactionSpec,
} from "@codemirror/state"
import { describe, expect, test } from "vitest"

import { DEFAULT_APP_SETTINGS, type DocumentKind } from "../shared/contracts"
import { MarkdownEditorController } from "./controller"
import { editorSearchSupport, type EditorSearchSupport } from "./search-support"
import type { MarkdownEditorMode } from "./types"

interface ConfigurationControllerInternals {
  codeLanguages: readonly LanguageDescription[]
  codeLanguageSupportEnabled: boolean
  currentMarkdownLanguageExtension: Extension
  currentPresentationExtensions: Record<MarkdownEditorMode, Extension>
  currentSearchExtension: Extension
  currentSpellCheckExtension: Extension
  destroyed: boolean
  documentBehaviorConfiguration: Compartment
  documentKind: DocumentKind
  documentPath: string | null
  enableCodeLanguageSupport(codeLanguages: readonly LanguageDescription[]): void
  enableSearchSupport(support: EditorSearchSupport): void
  documentConfigurationEffects(
    state: EditorState,
    mode: MarkdownEditorMode,
    documentKind: DocumentKind,
    documentPath: string | null
  ): readonly StateEffect<unknown>[]
  markdownBehaviorExtension: Extension
  markdownExtensions: typeof DEFAULT_APP_SETTINGS.markdownExtensions
  markdownLanguageConfiguration: Compartment
  markdownLanguageExtensionCache: Map<string, Extension>
  memoizedMarkdownLanguageExtension(): Extension
  currentPathCompletionExtension: Extension
  pathCompletionConfiguration: Compartment
  plainTextBehaviorExtension: Extension
  plainTextLanguageFallback: Extension
  presentation: Compartment
  refreshActiveTopLevelLanguage(): void
  searchConfiguration: Compartment
  searchSupport: EditorSearchSupport | null
  sourcePresentationExtension: Extension
  spellCheckConfiguration: Compartment
  topLevelLanguageRequest: number
  view: {
    dispatch(spec: TransactionSpec): void
    requestMeasure(): void
    readonly state: EditorState
    viewState: { mustMeasureContent: unknown }
  }
}

function configurationHarness() {
  const language = new Compartment()
  const presentation = new Compartment()
  const behavior = new Compartment()
  const searchConfiguration = new Compartment()
  const spellCheckConfiguration = new Compartment()
  const pathCompletionConfiguration = new Compartment()
  const currentLanguage: Extension = []
  const currentLivePresentation: Extension = []
  const currentSourcePresentation: Extension = []
  const markdownBehavior: Extension = []
  const plainTextBehavior: Extension = []
  const plainTextLanguage: Extension = []
  const currentSearchExtension: Extension = []
  const currentSpellCheckExtension: Extension = []
  const controller = Object.create(
    MarkdownEditorController.prototype
  ) as ConfigurationControllerInternals

  controller.codeLanguages = []
  controller.codeLanguageSupportEnabled = false
  controller.currentMarkdownLanguageExtension = currentLanguage
  controller.currentPresentationExtensions = {
    live: currentLivePresentation,
    source: currentSourcePresentation,
  }
  controller.currentSearchExtension = currentSearchExtension
  controller.currentSpellCheckExtension = currentSpellCheckExtension
  controller.currentPathCompletionExtension = []
  controller.destroyed = false
  controller.documentBehaviorConfiguration = behavior
  controller.documentKind = "markdown"
  controller.documentPath = null
  controller.markdownBehaviorExtension = markdownBehavior
  controller.markdownExtensions = DEFAULT_APP_SETTINGS.markdownExtensions
  controller.markdownLanguageConfiguration = language
  controller.markdownLanguageExtensionCache = new Map()
  controller.pathCompletionConfiguration = pathCompletionConfiguration
  controller.plainTextBehaviorExtension = plainTextBehavior
  controller.plainTextLanguageFallback = plainTextLanguage
  controller.presentation = presentation
  controller.searchConfiguration = searchConfiguration
  controller.sourcePresentationExtension = currentSourcePresentation
  controller.spellCheckConfiguration = spellCheckConfiguration
  controller.topLevelLanguageRequest = 0

  return {
    behavior,
    controller,
    currentLanguage,
    currentLivePresentation,
    currentSearchExtension,
    currentSourcePresentation,
    currentSpellCheckExtension,
    language,
    markdownBehavior,
    plainTextBehavior,
    plainTextLanguage,
    pathCompletionConfiguration,
    presentation,
    searchConfiguration,
    spellCheckConfiguration,
  }
}

function configuredState(
  harness: ReturnType<typeof configurationHarness>,
  doc = "",
  languageExtension: Extension = harness.currentLanguage
) {
  return EditorState.create({
    doc,
    extensions: [
      harness.language.of(languageExtension),
      harness.presentation.of(harness.currentLivePresentation),
      harness.behavior.of(harness.markdownBehavior),
      harness.searchConfiguration.of(harness.currentSearchExtension),
      harness.spellCheckConfiguration.of(harness.currentSpellCheckExtension),
      harness.pathCompletionConfiguration.of(
        harness.controller.currentPathCompletionExtension
      ),
    ],
  })
}

function mountHarness(
  harness: ReturnType<typeof configurationHarness>,
  initialState: EditorState
) {
  let state = initialState
  harness.controller.view = {
    dispatch(spec) {
      state = state.update(spec).state
    },
    requestMeasure() {},
    get state() {
      return state
    },
    viewState: { mustMeasureContent: false },
  }
  return () => state
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

describe("editor session document configuration", () => {
  test("uses the language catalog for Markdown fences in active and retained sessions", async () => {
    const harness = configurationHarness()
    const { controller } = harness
    controller.markdownExtensions = DEFAULT_APP_SETTINGS.markdownExtensions
    controller.markdownLanguageExtensionCache = new Map()
    const oldLanguage = controller.memoizedMarkdownLanguageExtension()
    controller.currentMarkdownLanguageExtension = oldLanguage

    const doc = "```js\nconst answer = 42\n```"
    const activeState = configuredState(harness, doc, oldLanguage)
    const retainedState = configuredState(harness, doc, oldLanguage)
    const active = mountHarness(harness, activeState)

    const { languages } = await import("@codemirror/language-data")
    const javascript = languages.find(
      (description) => description.name === "JavaScript"
    )
    expect(javascript).toBeDefined()
    await javascript!.load()
    controller.enableCodeLanguageSupport([javascript!])

    const enabledLanguage = controller.currentMarkdownLanguageExtension
    expect(enabledLanguage).not.toBe(oldLanguage)
    expect(harness.language.get(active())).toBe(enabledLanguage)
    expect(
      syntaxTree(active()).resolveInner(doc.indexOf("answer"), 1).name
    ).toBe("VariableDefinition")

    const retainedEffects = controller.documentConfigurationEffects(
      retainedState,
      "live",
      "markdown",
      "/documents/example.md"
    )
    expect(retainedEffects).toHaveLength(1)
    const reconfiguredRetained = retainedState.update({
      effects: retainedEffects,
    }).state
    expect(harness.language.get(reconfiguredRetained)).toBe(enabledLanguage)
    expect(
      syntaxTree(reconfiguredRetained).resolveInner(doc.indexOf("answer"), 1)
        .name
    ).toBe("VariableDefinition")

    controller.enableCodeLanguageSupport([])
    expect(controller.currentMarkdownLanguageExtension).toBe(enabledLanguage)
  })

  test("lazily loads a matching top-level plain-text language and ignores a stale path result", async () => {
    const harness = configurationHarness()
    const { controller } = harness
    controller.documentKind = "plain-text"
    controller.documentPath = "/documents/first.json"
    let state = configuredState(harness)
    state = state.update({
      effects: [
        harness.language.reconfigure(harness.plainTextLanguage),
        harness.presentation.reconfigure(harness.currentSourcePresentation),
        harness.behavior.reconfigure(harness.plainTextBehavior),
      ],
    }).state
    const active = mountHarness(harness, state)

    const jsonDeferred = deferred<LanguageSupport>()
    const htmlDeferred = deferred<LanguageSupport>()
    const jsonSupport = yaml()
    const htmlSupport = yaml()
    let jsonLoads = 0
    let htmlLoads = 0
    const json = LanguageDescription.of({
      name: "Test JSON",
      extensions: ["json"],
      load: () => {
        jsonLoads += 1
        return jsonDeferred.promise
      },
    })
    const html = LanguageDescription.of({
      name: "Test HTML",
      extensions: ["html"],
      load: () => {
        htmlLoads += 1
        return htmlDeferred.promise
      },
    })

    expect(jsonLoads).toBe(0)
    controller.enableCodeLanguageSupport([json, html])
    expect(jsonLoads).toBe(1)
    expect(harness.language.get(active())).toBe(harness.plainTextLanguage)

    controller.documentPath = "/documents/second.html"
    controller.refreshActiveTopLevelLanguage()
    expect(htmlLoads).toBe(1)

    jsonDeferred.resolve(jsonSupport)
    await json.load()
    await Promise.resolve()
    expect(harness.language.get(active())).toBe(harness.plainTextLanguage)

    htmlDeferred.resolve(htmlSupport)
    await html.load()
    await Promise.resolve()
    expect(harness.language.get(active())).toBe(htmlSupport)
  })

  test("switches Markdown parser, live presentation, and authoring behavior off for plain text", () => {
    const harness = configurationHarness()
    let state = configuredState(harness, "# not a Markdown heading")

    const effects = harness.controller.documentConfigurationEffects(
      state,
      "live",
      "plain-text",
      "/documents/data.json"
    )
    expect(effects).toHaveLength(3)
    state = state.update({ effects }).state

    expect(harness.language.get(state)).toBe(harness.plainTextLanguage)
    expect(harness.presentation.get(state)).toBe(
      harness.currentSourcePresentation
    )
    expect(harness.behavior.get(state)).toBe(harness.plainTextBehavior)
    expect(
      harness.controller.documentConfigurationEffects(
        state,
        "source",
        "plain-text",
        "/documents/data.json"
      )
    ).toEqual([])
  })

  test("enables generic search for active and retained sessions", () => {
    const harness = configurationHarness()
    const { controller } = harness
    controller.searchSupport = null
    const retainedState = configuredState(harness, "one two one")
    const active = mountHarness(harness, retainedState)

    controller.enableSearchSupport(editorSearchSupport)
    expect(harness.searchConfiguration.get(active())).toBe(
      editorSearchSupport.extension
    )

    const retainedEffects = controller.documentConfigurationEffects(
      retainedState,
      "live",
      "markdown",
      null
    )
    expect(retainedEffects).toHaveLength(1)
    const reconfiguredRetained = retainedState.update({
      effects: retainedEffects,
    }).state
    expect(harness.searchConfiguration.get(reconfiguredRetained)).toBe(
      editorSearchSupport.extension
    )

    const enabledExtension = controller.currentSearchExtension
    controller.enableSearchSupport({
      ...editorSearchSupport,
      extension: [],
    })
    expect(controller.currentSearchExtension).toBe(enabledExtension)
  })

  test("does no reconfiguration work for an already-current Markdown session", () => {
    const harness = configurationHarness()
    const state = configuredState(harness)
    expect(
      harness.controller.documentConfigurationEffects(
        state,
        "live",
        "markdown",
        null
      )
    ).toEqual([])
  })

  test("reconfigures only a Markdown session's stale presentation", () => {
    const harness = configurationHarness()
    let state = configuredState(harness)

    const effects = harness.controller.documentConfigurationEffects(
      state,
      "source",
      "markdown",
      null
    )
    expect(effects).toHaveLength(1)
    state = state.update({ effects }).state

    expect(harness.presentation.get(state)).toBe(
      harness.currentSourcePresentation
    )
  })
})
