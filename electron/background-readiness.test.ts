import { describe, expect, it, vi } from "vitest"

import {
  applyKeepReadyLoginItem,
  currentKeepReadyLoginItemState,
  shouldQueueCliRequestDuringBackgroundClose,
  shouldKeepReadyAfterCommandQuit,
  shouldKeepReadyWithoutWindow,
  type BackgroundLaunchPolicyInput,
} from "./background-readiness"

const basePolicy: BackgroundLaunchPolicyInput = {
  cliBootstrap: false,
  enabled: true,
  initialIntent: { kind: "new-window", filePaths: [] },
  isPackaged: true,
  pendingActivationCount: 0,
  pendingIntentCount: 0,
  pendingOpenFileCount: 0,
  platform: "darwin",
  wasOpenedAtLogin: true,
}

describe("background readiness launch policy", () => {
  it("keeps only an enabled, idle macOS login launch windowless", () => {
    expect(shouldKeepReadyWithoutWindow(basePolicy)).toBe(true)
  })

  it.each([
    { enabled: false },
    { isPackaged: false },
    { platform: "win32" as const },
    { wasOpenedAtLogin: false },
    { cliBootstrap: true },
    { initialIntent: { kind: "new-window" as const, filePaths: ["/note.md"] } },
    { initialIntent: { kind: "open-scratch" as const } },
    { pendingActivationCount: 1 },
    { pendingIntentCount: 1 },
    { pendingOpenFileCount: 1 },
  ])("opens normally when launch work is present: %j", (override) => {
    expect(shouldKeepReadyWithoutWindow({ ...basePolicy, ...override })).toBe(
      false
    )
  })
})

describe("background readiness Command-Q policy", () => {
  it("keeps the macOS process ready only after the user opts in", () => {
    expect(shouldKeepReadyAfterCommandQuit("darwin", true)).toBe(true)
    expect(shouldKeepReadyAfterCommandQuit("darwin", false)).toBe(false)
    expect(shouldKeepReadyAfterCommandQuit("win32", true)).toBe(false)
    expect(shouldKeepReadyAfterCommandQuit("linux", true)).toBe(false)
  })

  it("queues CLI work only while a background close can still resume", () => {
    expect(
      shouldQueueCliRequestDuringBackgroundClose(true, "background", false)
    ).toBe(true)
    expect(
      shouldQueueCliRequestDuringBackgroundClose(true, "background", true)
    ).toBe(false)
    expect(
      shouldQueueCliRequestDuringBackgroundClose(true, "quit", false)
    ).toBe(false)
    expect(
      shouldQueueCliRequestDuringBackgroundClose(false, "background", false)
    ).toBe(false)
  })
})

describe("background readiness login item", () => {
  it("registers and unregisters the installed macOS main app service", () => {
    const setLoginItemSettings = vi.fn()
    const application = { isPackaged: true, setLoginItemSettings }

    expect(applyKeepReadyLoginItem(application, "darwin", false, true)).toBe(
      true
    )
    expect(applyKeepReadyLoginItem(application, "darwin", false, false)).toBe(
      true
    )
    expect(setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, type: "mainAppService" }],
      [{ openAtLogin: false, type: "mainAppService" }],
    ])
  })

  it("reads the installed main app service state for transactional recovery", () => {
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true }))
    expect(
      currentKeepReadyLoginItemState(
        { isPackaged: true, getLoginItemSettings },
        "darwin",
        false
      )
    ).toBe(true)
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      type: "mainAppService",
    })
  })

  it.each([
    ["development app", { isPackaged: false }, "darwin", false],
    ["isolated profile", { isPackaged: true }, "darwin", true],
    ["other platform", { isPackaged: true }, "linux", false],
  ] as const)(
    "does not alter login items for a %s",
    (_name, app, platform, isolated) => {
      const application = { ...app, setLoginItemSettings: vi.fn() }
      expect(
        applyKeepReadyLoginItem(application, platform, isolated, true)
      ).toBe(false)
      expect(application.setLoginItemSettings).not.toHaveBeenCalled()
      expect(
        currentKeepReadyLoginItemState(
          {
            ...app,
            getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
          },
          platform,
          isolated
        )
      ).toBeNull()
    }
  )
})
