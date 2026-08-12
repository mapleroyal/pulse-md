export interface BackgroundLaunchPolicyInput {
  readonly cliBootstrap: boolean
  readonly enabled: boolean
  readonly initialIntent:
    | { readonly kind: "new-window"; readonly filePaths: readonly string[] }
    | { readonly kind: "open-scratch" }
  readonly isPackaged: boolean
  readonly pendingActivationCount: number
  readonly pendingIntentCount: number
  readonly pendingOpenFileCount: number
  readonly platform: NodeJS.Platform
  readonly wasOpenedAtLogin: boolean
}

export function shouldKeepReadyAfterCommandQuit(
  platform: NodeJS.Platform,
  enabled: boolean
) {
  return platform === "darwin" && enabled
}

export function shouldQueueCliRequestDuringBackgroundClose(
  quiescing: boolean,
  closeKind: "background" | "quit" | null,
  completeQuitRequested: boolean
) {
  return quiescing && closeKind === "background" && !completeQuitRequested
}

/** A login warm-up is the only launch that may initialize without a window. */
export function shouldKeepReadyWithoutWindow({
  cliBootstrap,
  enabled,
  initialIntent,
  isPackaged,
  pendingActivationCount,
  pendingIntentCount,
  pendingOpenFileCount,
  platform,
  wasOpenedAtLogin,
}: BackgroundLaunchPolicyInput) {
  return (
    platform === "darwin" &&
    isPackaged &&
    enabled &&
    wasOpenedAtLogin &&
    !cliBootstrap &&
    initialIntent.kind === "new-window" &&
    initialIntent.filePaths.length === 0 &&
    pendingActivationCount === 0 &&
    pendingIntentCount === 0 &&
    pendingOpenFileCount === 0
  )
}

interface LoginItemApplication {
  readonly isPackaged: boolean
  setLoginItemSettings(settings: {
    openAtLogin: boolean
    type: "mainAppService"
  }): void
}

interface LoginItemInspectionApplication {
  readonly isPackaged: boolean
  getLoginItemSettings(settings: { type: "mainAppService" }): {
    openAtLogin: boolean
  }
}

export function currentKeepReadyLoginItemState(
  application: LoginItemInspectionApplication,
  platform: NodeJS.Platform,
  isolatedUserData: boolean
) {
  if (platform !== "darwin" || !application.isPackaged || isolatedUserData) {
    return null
  }
  return application.getLoginItemSettings({ type: "mainAppService" })
    .openAtLogin
}

/**
 * Applies the opt-in only for the installed macOS app. Isolated profiles used
 * by tests and launch benchmarks must never mutate the user's global login
 * items.
 */
export function applyKeepReadyLoginItem(
  application: LoginItemApplication,
  platform: NodeJS.Platform,
  isolatedUserData: boolean,
  enabled: boolean
) {
  if (platform !== "darwin" || !application.isPackaged || isolatedUserData) {
    return false
  }
  application.setLoginItemSettings({
    openAtLogin: enabled,
    type: "mainAppService",
  })
  return true
}
