import * as React from "react"

import type { WindowsMenuId } from "@/shared/contracts"
import {
  WINDOWS_MENU_DEFINITIONS,
  stepWindowsMenu,
  windowsMenuForMnemonic,
} from "@/app/windows-menu"

interface WindowsMenuStripProps {
  formatEnabled: boolean
  visible: boolean
  windowZoomFactor: number
  onVisibleChange: (visible: boolean) => void
}

const menuStripStyle = {
  WebkitAppRegion: "no-drag",
  alignItems: "center",
  display: "flex",
  height: "var(--window-chrome-height)",
  left: 8,
  maxWidth: "calc(100% - var(--windows-caption-controls-inset) - 16px)",
  overflowX: "auto",
  position: "absolute",
  scrollbarWidth: "none",
  top: 0,
  width: "max-content",
  zIndex: 6,
} as React.CSSProperties

const menuItemStyle = {
  WebkitAppRegion: "no-drag",
  border: 0,
  borderRadius: "calc(5px * var(--app-corner-radius-scale))",
  flex: "none",
  fontFamily: '"Segoe UI", var(--font-sans)',
  fontSize: 13,
  height: 30,
  lineHeight: 1,
  outline: "none",
  padding: "0 9px",
} as React.CSSProperties

const mnemonicStyle = {
  textDecoration: "underline",
  textUnderlineOffset: 2,
} as React.CSSProperties

function consumeMenuKey(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

export function WindowsMenuStrip({
  formatEnabled,
  visible,
  windowZoomFactor,
  onVisibleChange,
}: WindowsMenuStripProps) {
  const [activeMenu, setActiveMenu] = React.useState<WindowsMenuId>("file")
  const [popupMenu, setPopupMenu] = React.useState<WindowsMenuId | null>(null)
  const stripRef = React.useRef<HTMLElement>(null)
  const buttonRefs = React.useRef(new Map<WindowsMenuId, HTMLButtonElement>())
  const altArmedRef = React.useRef(false)
  const visibleRef = React.useRef(visible)
  const popupMenuRef = React.useRef<WindowsMenuId | null>(null)
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches

  React.useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  const menuEnabled = React.useCallback(
    (menu: WindowsMenuId) => menu !== "format" || formatEnabled,
    [formatEnabled]
  )

  const revealMenuButton = React.useCallback((menu: WindowsMenuId) => {
    const strip = stripRef.current
    const button = buttonRefs.current.get(menu)
    if (!strip || !button) return

    const stripBounds = strip.getBoundingClientRect()
    const buttonBounds = button.getBoundingClientRect()
    if (buttonBounds.left < stripBounds.left) {
      strip.scrollLeft -= stripBounds.left - buttonBounds.left
    } else if (buttonBounds.right > stripBounds.right) {
      strip.scrollLeft += buttonBounds.right - stripBounds.right
    }
  }, [])

  const dismiss = React.useCallback(() => {
    altArmedRef.current = false
    onVisibleChange(false)
  }, [onVisibleChange])

  const popupNativeMenu = React.useCallback(
    (menu: WindowsMenuId) => {
      if (popupMenuRef.current || !menuEnabled(menu)) return
      const button = buttonRefs.current.get(menu)
      if (!button) return

      revealMenuButton(menu)
      const bounds = button.getBoundingClientRect()
      const anchor = {
        x: Math.round(bounds.left * windowZoomFactor),
        y: Math.round(bounds.bottom * windowZoomFactor),
      }
      popupMenuRef.current = menu
      setPopupMenu(menu)
      setActiveMenu(menu)
      onVisibleChange(true)

      void window.pulseMd
        .popupWindowsMenu(menu, anchor)
        .catch((error: unknown) => {
          console.error("Unable to open the Windows application menu", error)
        })
        .finally(() => {
          popupMenuRef.current = null
          setPopupMenu(null)
          onVisibleChange(false)
        })
    },
    [menuEnabled, onVisibleChange, revealMenuButton, windowZoomFactor]
  )

  const revealAndPopup = React.useCallback(
    (menu: WindowsMenuId) => {
      if (!menuEnabled(menu)) return
      setActiveMenu(menu)
      onVisibleChange(true)
      // Let React paint the replacement strip before the native popup takes
      // over keyboard input. The buttons stay mounted while hidden, so their
      // geometry is already available and stable.
      window.requestAnimationFrame(() => popupNativeMenu(menu))
    },
    [menuEnabled, onVisibleChange, popupNativeMenu]
  )

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Alt" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        consumeMenuKey(event)
        if (!event.repeat) altArmedRef.current = true
        return
      }

      if (altArmedRef.current) altArmedRef.current = false

      const mnemonic = windowsMenuForMnemonic(event.key)
      if (
        mnemonic &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        consumeMenuKey(event)
        revealAndPopup(mnemonic)
        return
      }

      if (!visibleRef.current || popupMenuRef.current) return

      if (event.key === "Escape") {
        consumeMenuKey(event)
        dismiss()
        return
      }
      if (event.key === "Tab") {
        dismiss()
        return
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return
      }
      if (mnemonic) {
        consumeMenuKey(event)
        popupNativeMenu(mnemonic)
        return
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        consumeMenuKey(event)
        setActiveMenu((current) =>
          stepWindowsMenu(
            current,
            event.key === "ArrowLeft" ? -1 : 1,
            menuEnabled
          )
        )
        return
      }
      if (event.key === "Home" || event.key === "End") {
        consumeMenuKey(event)
        const ordered =
          event.key === "Home"
            ? WINDOWS_MENU_DEFINITIONS
            : [...WINDOWS_MENU_DEFINITIONS].reverse()
        const next = ordered.find((item) => menuEnabled(item.id))
        if (next) setActiveMenu(next.id)
        return
      }
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        consumeMenuKey(event)
        popupNativeMenu(activeMenu)
        return
      }

      // The editor deliberately keeps focus so native edit roles retain their
      // target after a submenu opens. While menu-access mode itself is active,
      // do not let unrelated typing or deletion mutate that focused document.
      consumeMenuKey(event)
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return
      consumeMenuKey(event)
      if (!altArmedRef.current || popupMenuRef.current) return
      altArmedRef.current = false
      if (visibleRef.current) {
        dismiss()
      } else {
        setActiveMenu("file")
        onVisibleChange(true)
      }
    }

    const handleWindowBlur = () => {
      altArmedRef.current = false
      if (!popupMenuRef.current) onVisibleChange(false)
    }
    const handleWindowResize = () => {
      if (visibleRef.current && !popupMenuRef.current) onVisibleChange(false)
    }

    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener("keyup", handleKeyUp, true)
    window.addEventListener("blur", handleWindowBlur)
    window.addEventListener("resize", handleWindowResize)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener("keyup", handleKeyUp, true)
      window.removeEventListener("blur", handleWindowBlur)
      window.removeEventListener("resize", handleWindowResize)
    }
  }, [
    activeMenu,
    dismiss,
    menuEnabled,
    onVisibleChange,
    popupNativeMenu,
    revealAndPopup,
  ])

  React.useEffect(() => {
    if (!visible || popupMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      if (stripRef.current?.contains(event.target as Node | null)) return
      dismiss()
    }
    window.addEventListener("pointerdown", handlePointerDown, true)
    return () =>
      window.removeEventListener("pointerdown", handlePointerDown, true)
  }, [dismiss, popupMenu, visible])

  React.useLayoutEffect(() => {
    if (visible && !popupMenu) revealMenuButton(activeMenu)
  }, [activeMenu, popupMenu, revealMenuButton, visible])

  return (
    <nav
      ref={stripRef}
      aria-hidden={!visible}
      aria-label="Application menu"
      className="windows-menu-strip"
      role="menubar"
      style={{
        ...menuStripStyle,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transform: reduceMotion
          ? "none"
          : visible
            ? "translateY(0)"
            : "translateY(-2px)",
        transition: reduceMotion
          ? "none"
          : `opacity 90ms ease, transform 120ms ease, visibility 0ms linear ${
              visible ? "0ms" : "120ms"
            }`,
        visibility: visible ? "visible" : "hidden",
      }}
    >
      {WINDOWS_MENU_DEFINITIONS.map((item) => {
        const mnemonicIndex = item.label.toLowerCase().indexOf(item.mnemonic)
        const enabled = menuEnabled(item.id)
        const highlighted = activeMenu === item.id || popupMenu === item.id
        return (
          <button
            key={item.id}
            ref={(button) => {
              if (button) buttonRefs.current.set(item.id, button)
              else buttonRefs.current.delete(item.id)
            }}
            aria-disabled={!enabled || undefined}
            aria-expanded={popupMenu === item.id}
            aria-haspopup="menu"
            className="windows-menu-item"
            data-active={activeMenu === item.id || undefined}
            disabled={!enabled}
            role="menuitem"
            style={{
              ...menuItemStyle,
              background: highlighted
                ? "color-mix(in oklab, var(--document-foreground) 10%, transparent)"
                : "transparent",
              color: !enabled
                ? "color-mix(in oklab, var(--document-foreground) 34%, transparent)"
                : highlighted
                  ? "var(--document-foreground)"
                  : "color-mix(in oklab, var(--document-foreground) 82%, transparent)",
            }}
            tabIndex={-1}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onPointerEnter={() => {
              if (enabled && !popupMenuRef.current) setActiveMenu(item.id)
            }}
            onClick={() => popupNativeMenu(item.id)}
          >
            {item.label.slice(0, mnemonicIndex)}
            <span className="windows-menu-mnemonic" style={mnemonicStyle}>
              {item.label[mnemonicIndex]}
            </span>
            {item.label.slice(mnemonicIndex + 1)}
          </button>
        )
      })}
    </nav>
  )
}
