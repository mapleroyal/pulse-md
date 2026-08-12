import type { ElectronApplication, Page } from "@playwright/test"

export async function openSettingsSection(
  page: Page,
  name: "Theme" | "Miscellaneous" | "Import & Export" | "Window Profiles"
): Promise<void> {
  const trigger = page.getByRole("button", { name, exact: true })
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click()
  }
}

export function waitForApplicationClose(
  application: ElectronApplication
): Promise<void> {
  return new Promise((resolve) => application.once("close", () => resolve()))
}

export async function exitApplication(
  application: ElectronApplication
): Promise<void> {
  const closed = waitForApplicationClose(application)
  await application.evaluate(({ app, BrowserWindow }) => {
    // Test profiles are disposable, so skip product save prompts while still
    // ending the process through Electron's orderly quit lifecycle. app.exit()
    // bypasses before-quit/will-quit and macOS can report that as an unexpected
    // termination on the next launch.
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit()
  })
  await closed
}
