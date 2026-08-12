import { describe, expect, it } from "vitest"

import type { WindowProfile } from "../src/shared/contracts"
import { captureWindowProfileSeed } from "./profile-capture"

const NOTES_SCRATCH_ID = "10000000-0000-4000-8000-000000000001"
const OTHER_SCRATCH_ID = "10000000-0000-4000-8000-000000000002"

const launchProfile: WindowProfile = {
  version: 2,
  id: "writing",
  name: "Writing",
  activeTab: "notes",
  tabVisibility: "inherit",
  mode: "live",
  tabs: [
    {
      id: "notes",
      kind: "scratch",
      scratchId: NOTES_SCRATCH_ID,
      title: "Notes",
    },
    { id: "draft", kind: "file", path: "/tmp/draft.md", mode: "source" },
  ],
}

describe("captureWindowProfileSeed", () => {
  it("preserves launched tab ids, scratch references, and unchanged mode inheritance on update", () => {
    expect(
      captureWindowProfileSeed({
        activeRuntimeTabId: "runtime-notes",
        inheritedEditorMode: "source",
        kind: "update",
        originalProfile: launchProfile,
        tabModes: [
          { tabId: "runtime-draft", mode: "source" },
          { tabId: "runtime-notes", mode: "live" },
        ],
        tabs: [
          {
            backing: "file",
            displayName: "draft.md",
            filePath: "/tmp/draft.md",
            origin: { profileId: "writing", tabId: "draft" },
            runtimeTabId: "runtime-draft",
          },
          {
            backing: "scratch",
            displayName: "Notes",
            filePath: null,
            origin: { profileId: "writing", tabId: "notes" },
            runtimeTabId: "runtime-notes",
            scratch: { scratchId: NOTES_SCRATCH_ID },
            title: "Notes",
          },
        ],
      })
    ).toEqual({
      activeTab: "notes",
      tabs: [
        { id: "draft", kind: "file", path: "/tmp/draft.md", mode: "source" },
        {
          id: "notes",
          kind: "scratch",
          scratchId: NOTES_SCRATCH_ID,
          title: "Notes",
        },
      ],
    })
  })

  it("captures deliberate mode changes and assigns stable unique ids to new tabs", () => {
    expect(
      captureWindowProfileSeed({
        activeRuntimeTabId: "runtime-new",
        inheritedEditorMode: "source",
        kind: "update",
        originalProfile: launchProfile,
        tabModes: [
          { tabId: "runtime-notes", mode: "source" },
          { tabId: "runtime-new", mode: "live" },
        ],
        tabs: [
          {
            backing: "scratch",
            displayName: "Notes",
            filePath: null,
            origin: { profileId: "writing", tabId: "notes" },
            runtimeTabId: "runtime-notes",
            scratch: { scratchId: NOTES_SCRATCH_ID },
            title: "Notes",
          },
          {
            backing: "untitled",
            displayName: "Notes",
            filePath: null,
            runtimeTabId: "runtime-new",
            title: "Notes",
          },
        ],
      })
    ).toEqual({
      activeTab: "notes-2",
      tabs: [
        {
          id: "notes",
          kind: "scratch",
          mode: "source",
          scratchId: NOTES_SCRATCH_ID,
          title: "Notes",
        },
        { id: "notes-2", kind: "untitled", mode: "live", title: "Notes" },
      ],
    })
  })

  it("reserves original ids before assigning ids to reordered new tabs", () => {
    expect(
      captureWindowProfileSeed({
        activeRuntimeTabId: "runtime-original",
        inheritedEditorMode: "source",
        kind: "update",
        originalProfile: launchProfile,
        tabModes: [
          { tabId: "runtime-new", mode: "live" },
          { tabId: "runtime-original", mode: "live" },
        ],
        tabs: [
          {
            backing: "scratch",
            displayName: "notes",
            filePath: null,
            runtimeTabId: "runtime-new",
            scratch: { scratchId: OTHER_SCRATCH_ID },
            title: "notes",
          },
          {
            backing: "scratch",
            displayName: "Notes",
            filePath: null,
            origin: { profileId: "writing", tabId: "notes" },
            runtimeTabId: "runtime-original",
            scratch: { scratchId: NOTES_SCRATCH_ID },
            title: "Notes",
          },
        ],
      })
    ).toEqual({
      activeTab: "notes",
      tabs: [
        {
          id: "notes-2",
          kind: "scratch",
          mode: "live",
          scratchId: OTHER_SCRATCH_ID,
          title: "notes",
        },
        {
          id: "notes",
          kind: "scratch",
          scratchId: NOTES_SCRATCH_ID,
          title: "Notes",
        },
      ],
    })
  })

  it("preserves profile-mode inheritance against the effective launch setting", () => {
    const inheritedProfile: WindowProfile = {
      ...launchProfile,
      mode: undefined,
      tabs: [{ id: "notes", kind: "untitled", title: "Notes" }],
    }
    expect(
      captureWindowProfileSeed({
        activeRuntimeTabId: "runtime-notes",
        inheritedEditorMode: "source",
        kind: "update",
        originalProfile: inheritedProfile,
        tabModes: [{ tabId: "runtime-notes", mode: "source" }],
        tabs: [
          {
            backing: "untitled",
            displayName: "Notes",
            filePath: null,
            origin: { profileId: "writing", tabId: "notes" },
            runtimeTabId: "runtime-notes",
            title: "Notes",
          },
        ],
      })
    ).toEqual({
      activeTab: "notes",
      tabs: [{ id: "notes", kind: "untitled", title: "Notes" }],
    })
  })

  it("makes existing scratches explicit and snapshots every mode for a new profile", () => {
    expect(
      captureWindowProfileSeed({
        activeRuntimeTabId: "runtime-notes",
        inheritedEditorMode: "source",
        kind: "create",
        tabModes: [{ tabId: "runtime-notes", mode: "live" }],
        tabs: [
          {
            backing: "scratch",
            displayName: "Notes",
            filePath: null,
            origin: { profileId: "writing", tabId: "notes" },
            runtimeTabId: "runtime-notes",
            scratch: { scratchId: NOTES_SCRATCH_ID },
            title: "Notes",
          },
        ],
      })
    ).toEqual({
      activeTab: "notes",
      tabs: [
        {
          id: "notes",
          kind: "scratch",
          mode: "live",
          scratchId: NOTES_SCRATCH_ID,
          title: "Notes",
        },
      ],
    })
  })
})
