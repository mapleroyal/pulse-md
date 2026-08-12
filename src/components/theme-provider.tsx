/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import {
  APPEARANCE_MODES,
  type AppearanceMode,
  type ResolvedAppearance,
} from "@/shared/contracts"

type ResolvedTheme = ResolvedAppearance

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: AppearanceMode
  disableTransitionOnChange?: boolean
}

type ThemeProviderState = {
  resolvedTheme: ResolvedTheme
  theme: AppearanceMode
  applySurfaceTheme: (theme: ResolvedTheme) => void
  setTheme: (theme: AppearanceMode) => void
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"

const ThemeProviderContext = React.createContext<
  ThemeProviderState | undefined
>(undefined)

export function isAppearanceMode(
  value: string | null
): value is AppearanceMode {
  return APPEARANCE_MODES.includes(value as AppearanceMode)
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark"
  }

  return "light"
}

function subscribeToSystemTheme(onChange: () => void) {
  const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY)
  mediaQuery.addEventListener("change", onChange)
  return () => mediaQuery.removeEventListener("change", onChange)
}

interface TransitionGuard {
  firstFrame: number | null
  secondFrame: number | null
  readonly style: HTMLStyleElement
}

const transitionGuards = new WeakMap<Document, TransitionGuard>()

function disableTransitionsTemporarily(ownerDocument: Document) {
  const ownerWindow = ownerDocument.defaultView
  let guard = transitionGuards.get(ownerDocument)
  if (!guard) {
    const style = ownerDocument.createElement("style")
    style.dataset.themeTransitionGuard = ""
    style.appendChild(
      ownerDocument.createTextNode(
        '*:not([data-theme-transition="preserve"]),*:not([data-theme-transition="preserve"])::before,*:not([data-theme-transition="preserve"])::after{-webkit-transition:none!important;transition:none!important}'
      )
    )
    ownerDocument.head.appendChild(style)
    guard = { firstFrame: null, secondFrame: null, style }
    transitionGuards.set(ownerDocument, guard)
  } else if (ownerWindow) {
    if (guard.firstFrame != null) {
      ownerWindow.cancelAnimationFrame(guard.firstFrame)
      guard.firstFrame = null
    }
    if (guard.secondFrame != null) {
      ownerWindow.cancelAnimationFrame(guard.secondFrame)
      guard.secondFrame = null
    }
  }

  return () => {
    if (!ownerWindow) {
      guard.style.remove()
      transitionGuards.delete(ownerDocument)
      return
    }
    ownerWindow.getComputedStyle(ownerDocument.body)
    guard.firstFrame = ownerWindow.requestAnimationFrame(() => {
      guard.firstFrame = null
      guard.secondFrame = ownerWindow.requestAnimationFrame(() => {
        guard.secondFrame = null
        guard.style.remove()
        if (transitionGuards.get(ownerDocument) === guard) {
          transitionGuards.delete(ownerDocument)
        }
      })
    })
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  disableTransitionOnChange = true,
}: ThemeProviderProps) {
  const [theme, setTheme] = React.useState<AppearanceMode>(defaultTheme)
  const systemTheme = React.useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemTheme,
    getSystemTheme
  )
  const resolvedTheme = theme === "system" ? systemTheme : theme

  const applySurfaceTheme = React.useCallback(
    (nextTheme: ResolvedTheme) => {
      const root = document.documentElement
      const previousTheme = nextTheme === "dark" ? "light" : "dark"
      if (
        root.classList.contains(nextTheme) &&
        !root.classList.contains(previousTheme) &&
        root.style.colorScheme === nextTheme
      ) {
        return
      }
      const restoreTransitions = disableTransitionOnChange
        ? disableTransitionsTemporarily(root.ownerDocument)
        : null

      root.classList.remove("light", "dark")
      root.classList.add(nextTheme)
      root.style.colorScheme = nextTheme

      if (restoreTransitions) {
        restoreTransitions()
      }
    },
    [disableTransitionOnChange]
  )

  const value = React.useMemo(
    () => ({
      applySurfaceTheme,
      resolvedTheme,
      theme,
      setTheme,
    }),
    [applySurfaceTheme, resolvedTheme, theme, setTheme]
  )

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function initialAppearanceMode(): AppearanceMode {
  const value = new URLSearchParams(window.location.search).get(
    "appearanceMode"
  )
  return isAppearanceMode(value) ? value : "system"
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext)

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }

  return context
}
