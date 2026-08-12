import type { RecoveryAction } from "@/shared/contracts"

const parameters = new URLSearchParams(window.location.search)
const appearanceMode = parameters.get("appearanceMode")
const darkSlot =
  appearanceMode === "dark" ||
  (appearanceMode !== "light" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches)
const slot = darkSlot ? "dark" : "light"
const fallbackBackground = darkSlot ? "#181818" : "#ffffff"
const fallbackForeground = darkSlot ? "#f5f5f5" : "#171717"
const colorParameter = (name: string, fallback: string) => {
  const value = parameters.get(name)
  return /^#[\da-f]{6}$/i.test(value ?? "") ? value! : fallback
}

document.documentElement.style.colorScheme = darkSlot ? "dark" : "light"
document.documentElement.style.setProperty(
  "--recovery-background",
  colorParameter(`${slot}Background`, fallbackBackground)
)
document.documentElement.style.setProperty(
  "--recovery-foreground",
  colorParameter(`${slot}Foreground`, fallbackForeground)
)

const title = document.querySelector<HTMLElement>("#recovery-title")
const description = document.querySelector<HTMLElement>("#recovery-description")
const status = document.querySelector<HTMLElement>("#recovery-status")
const buttons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-action]"),
]
const bootstrapFailure = parameters.get("reason") === "bootstrap"

if (bootstrapFailure) {
  if (title) title.textContent = "The editor could not start"
  if (description) {
    description.textContent =
      "The document interface did not finish loading. Reload the window to try again. Files already saved to disk are safe."
  }
}

const setBusy = (busy: boolean) => {
  for (const button of buttons) button.disabled = busy
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    const action = button.dataset.action as RecoveryAction | undefined
    if (!action) return
    setBusy(true)
    if (status) {
      status.textContent =
        action === "reload"
          ? "Reloading the window…"
          : action === "reopen"
            ? "Reopening the app…"
            : "Quitting…"
    }
    void window.pulseMdRecovery.perform(action).catch((error: unknown) => {
      setBusy(false)
      if (status) {
        const detail = error instanceof Error ? error.message : String(error)
        status.textContent = `Recovery failed: ${detail}`
      }
    })
  })
}
