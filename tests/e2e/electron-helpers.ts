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

export async function setWindowContentSize(
  application: ElectronApplication,
  width: number,
  height: number
): Promise<void> {
  const page = await application.firstWindow()
  await page.waitForFunction(
    () =>
      performance.getEntriesByName("pmd:launch-transition-settled").length > 0
  )
  await application.evaluate(
    ({ BrowserWindow }, target) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error("App window was not found")

      const minimumSize = window.getMinimumSize()
      if (target.width < minimumSize[0] || target.height < minimumSize[1]) {
        throw new Error(
          `Requested content size ${target.width}x${target.height} is below the window minimum ${minimumSize[0]}x${minimumSize[1]}`
        )
      }

      // BrowserWindow's minimum applies to outer bounds, while these tests
      // assert the renderer viewport. Windows x64 emulation can report a
      // one-DIP native inset even for this frameless window, so briefly relax
      // the outer minimum while setContentSize and a measured correction run.
      const history: unknown[] = []
      window.setMinimumSize(1, 1)
      try {
        window.setContentSize(target.width, target.height)
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const [actualWidth, actualHeight] = window.getContentSize()
          history.push({
            attempt,
            content: [actualWidth, actualHeight],
            outer: window.getSize(),
          })
          if (actualWidth === target.width && actualHeight === target.height) {
            break
          }
          const [outerWidth, outerHeight] = window.getSize()
          window.setSize(
            outerWidth + target.width - actualWidth,
            outerHeight + target.height - actualHeight
          )
        }
      } finally {
        window.setMinimumSize(minimumSize[0], minimumSize[1])
      }

      const [actualWidth, actualHeight] = window.getContentSize()
      if (actualWidth === target.width && actualHeight === target.height) return
      throw new Error(
        `Unable to size the renderer content to ${target.width}x${target.height}; received ${actualWidth}x${actualHeight}: ${JSON.stringify(history)}`
      )
    },
    { height, width }
  )
}
