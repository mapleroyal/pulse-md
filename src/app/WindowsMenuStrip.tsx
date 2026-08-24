import * as React from "react"

import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar"
import type {
  WindowsMenuId,
  WindowsMenuItemSnapshot,
  WindowsMenuSnapshot,
} from "@/shared/contracts"
import {
  WINDOWS_MENU_DEFINITIONS,
  stepWindowsMenu,
  windowsMenuForMnemonic,
} from "@/app/windows-menu"

interface WindowsMenuStripProps {
  visible: boolean
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

const menuContentClassName = "windows-native-menu"
const menuItemClassName = "windows-native-menu-item"

function consumeMenuKey(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

function windowsAccelerator(accelerator: string | null): string | null {
  if (!accelerator) return null
  return accelerator
    .replaceAll("CommandOrControl", "Ctrl")
    .replaceAll("CmdOrCtrl", "Ctrl")
    .replaceAll("Command", "Ctrl")
    .replaceAll("Cmd", "Ctrl")
    .replaceAll("Control", "Ctrl")
}

function menuItemKey(item: WindowsMenuItemSnapshot, path: string): string {
  return item.actionToken ?? `${path}:${item.type}:${item.label}`
}

function WindowsSubmenuItem({
  item,
  onLeaveSubmenu,
  onInvoke,
  path,
}: {
  item: WindowsMenuItemSnapshot
  onLeaveSubmenu: () => void
  onInvoke: (item: WindowsMenuItemSnapshot) => void
  path: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <MenubarSub open={open} onOpenChange={setOpen}>
      <MenubarSubTrigger
        className={menuItemClassName}
        disabled={!item.enabled || item.submenu.length === 0}
        onKeyDownCapture={(event) => {
          if (event.key !== "ArrowLeft" || !open) return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          onLeaveSubmenu()
        }}
      >
        <span className="windows-native-menu-label">{item.label}</span>
      </MenubarSubTrigger>
      <MenubarSubContent className={menuContentClassName}>
        <WindowsMenuItems
          items={item.submenu}
          onLeaveSubmenu={onLeaveSubmenu}
          parentPath={path}
          onInvoke={onInvoke}
        />
      </MenubarSubContent>
    </MenubarSub>
  )
}

function WindowsMenuItems({
  items,
  onLeaveSubmenu,
  onInvoke,
  parentPath,
}: {
  items: readonly WindowsMenuItemSnapshot[]
  onLeaveSubmenu: () => void
  onInvoke: (item: WindowsMenuItemSnapshot) => void
  parentPath: string
}) {
  const rendered: React.ReactNode[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const path = `${parentPath}.${index}`
    const key = menuItemKey(item, path)
    const accelerator = windowsAccelerator(item.accelerator)
    const label = (
      <>
        <span className="windows-native-menu-label">{item.label}</span>
        {accelerator ? (
          <MenubarShortcut className="windows-native-menu-shortcut">
            {accelerator}
          </MenubarShortcut>
        ) : null}
      </>
    )

    if (item.type === "separator") {
      rendered.push(
        <MenubarSeparator key={key} className="windows-native-menu-separator" />
      )
      continue
    }
    if (item.type === "submenu") {
      rendered.push(
        <WindowsSubmenuItem
          key={key}
          item={item}
          onLeaveSubmenu={onLeaveSubmenu}
          onInvoke={onInvoke}
          path={path}
        />
      )
      continue
    }
    if (item.type === "checkbox") {
      rendered.push(
        <MenubarCheckboxItem
          key={key}
          checked={item.checked}
          className={menuItemClassName}
          disabled={!item.enabled || !item.actionToken}
          onClick={() => onInvoke(item)}
        >
          {label}
        </MenubarCheckboxItem>
      )
      continue
    }
    if (item.type === "radio") {
      const radioItems = [item]
      while (items[index + 1]?.type === "radio") {
        radioItems.push(items[(index += 1)]!)
      }
      const checkedIndex = radioItems.findIndex(
        (candidate) => candidate.checked
      )
      rendered.push(
        <MenubarRadioGroup
          key={`${key}:group`}
          value={checkedIndex < 0 ? "" : `${path}.radio.${checkedIndex}`}
        >
          {radioItems.map((radioItem, radioIndex) => {
            const radioPath = `${path}.radio.${radioIndex}`
            const radioAccelerator = windowsAccelerator(radioItem.accelerator)
            return (
              <MenubarRadioItem
                key={menuItemKey(radioItem, radioPath)}
                value={radioPath}
                className={menuItemClassName}
                disabled={!radioItem.enabled || !radioItem.actionToken}
                onClick={() => onInvoke(radioItem)}
              >
                <span className="windows-native-menu-label">
                  {radioItem.label}
                </span>
                {radioAccelerator ? (
                  <MenubarShortcut className="windows-native-menu-shortcut">
                    {radioAccelerator}
                  </MenubarShortcut>
                ) : null}
              </MenubarRadioItem>
            )
          })}
        </MenubarRadioGroup>
      )
      continue
    }
    rendered.push(
      <MenubarItem
        key={key}
        className={menuItemClassName}
        disabled={!item.enabled || !item.actionToken}
        onClick={() => onInvoke(item)}
      >
        {label}
      </MenubarItem>
    )
  }
  return rendered
}

export function WindowsMenuStrip({
  visible,
  onVisibleChange,
}: WindowsMenuStripProps) {
  const [activeMenu, setActiveMenuValue] = React.useState<WindowsMenuId>("file")
  const [openMenu, setOpenMenu] = React.useState<WindowsMenuId | null>(null)
  const [snapshot, setSnapshot] = React.useState<WindowsMenuSnapshot | null>(
    null
  )
  const stripRef = React.useRef<HTMLDivElement>(null)
  const buttonRefs = React.useRef(new Map<WindowsMenuId, HTMLButtonElement>())
  const activeMenuRef = React.useRef<WindowsMenuId>("file")
  const altArmedRef = React.useRef(false)
  const visibleRef = React.useRef(visible)
  const openMenuRef = React.useRef<WindowsMenuId | null>(null)
  const snapshotRef = React.useRef<WindowsMenuSnapshot | null>(null)
  const snapshotPromiseRef = React.useRef<Promise<WindowsMenuSnapshot> | null>(
    null
  )
  const previousFocusRef = React.useRef<HTMLElement | null>(null)
  const sessionGenerationRef = React.useRef(0)
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches

  const setActiveMenu = React.useCallback(
    (next: React.SetStateAction<WindowsMenuId>) => {
      const resolved =
        typeof next === "function" ? next(activeMenuRef.current) : next
      activeMenuRef.current = resolved
      setActiveMenuValue(resolved)
    },
    []
  )

  const setOpenMenuState = React.useCallback((menu: WindowsMenuId | null) => {
    openMenuRef.current = menu
    setOpenMenu(menu)
  }, [])

  const menuEnabled = React.useCallback(
    (menu: WindowsMenuId) => snapshotRef.current?.[menu].enabled ?? true,
    []
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

  const clearSession = React.useCallback(() => {
    sessionGenerationRef.current += 1
    snapshotPromiseRef.current = null
    snapshotRef.current = null
    setSnapshot(null)
    setOpenMenuState(null)
  }, [setOpenMenuState])

  const dismiss = React.useCallback(
    (restoreFocus: boolean) => {
      const previousFocus = restoreFocus ? previousFocusRef.current : null
      previousFocusRef.current = null
      altArmedRef.current = false
      visibleRef.current = false
      clearSession()
      onVisibleChange(false)
      if (previousFocus) {
        window.requestAnimationFrame(() => {
          if (previousFocus.isConnected) {
            previousFocus.focus({ preventScroll: true })
          }
        })
      }
    },
    [clearSession, onVisibleChange]
  )

  const ensureSnapshot = React.useCallback(() => {
    if (snapshotRef.current) return Promise.resolve(snapshotRef.current)
    if (snapshotPromiseRef.current) return snapshotPromiseRef.current

    const generation = sessionGenerationRef.current
    // Editor/input focus reporting is frame-batched. Let a focus change that
    // immediately precedes Alt/F10 reach the main process before it freezes
    // this session's semantic menu state.
    const pending = new Promise<void>((resolve) =>
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => resolve())
      )
    )
      .then(() => window.pulseMd.getWindowsMenuSnapshot())
      .then((nextSnapshot) => {
        if (generation === sessionGenerationRef.current && visibleRef.current) {
          snapshotRef.current = nextSnapshot
          setSnapshot(nextSnapshot)
          const currentActiveMenu = activeMenuRef.current
          if (!nextSnapshot[currentActiveMenu].enabled) {
            setActiveMenu(
              stepWindowsMenu(
                currentActiveMenu,
                1,
                (menu) => nextSnapshot[menu].enabled
              )
            )
          }
          const pendingOpenMenu = openMenuRef.current
          if (pendingOpenMenu && !nextSnapshot[pendingOpenMenu].enabled) {
            setOpenMenuState(null)
          } else if (pendingOpenMenu) {
            buttonRefs.current
              .get(pendingOpenMenu)
              ?.focus({ preventScroll: true })
          }
        }
        return nextSnapshot
      })
      .catch((error: unknown) => {
        if (generation === sessionGenerationRef.current) {
          snapshotPromiseRef.current = null
          console.error("Unable to load the Windows application menu", error)
          dismiss(true)
        }
        throw error
      })
    snapshotPromiseRef.current = pending
    return pending
  }, [dismiss, setActiveMenu, setOpenMenuState])

  const beginSession = React.useCallback(() => {
    if (!visibleRef.current) {
      visibleRef.current = true
      sessionGenerationRef.current += 1
      snapshotPromiseRef.current = null
      snapshotRef.current = null
      setSnapshot(null)
      setOpenMenuState(null)
      const focused = document.activeElement
      previousFocusRef.current =
        focused instanceof HTMLElement && !stripRef.current?.contains(focused)
          ? focused
          : null
    }
    onVisibleChange(true)
    void ensureSnapshot().catch(() => undefined)
  }, [ensureSnapshot, onVisibleChange, setOpenMenuState])

  const revealAndOpen = React.useCallback(
    (menu: WindowsMenuId) => {
      if (!menuEnabled(menu)) return
      beginSession()
      setActiveMenu(menu)
      if (snapshotRef.current) {
        buttonRefs.current.get(menu)?.focus({ preventScroll: true })
      }
      setOpenMenuState(menu)
    },
    [beginSession, menuEnabled, setActiveMenu, setOpenMenuState]
  )

  const invokeItem = React.useCallback(
    (item: WindowsMenuItemSnapshot) => {
      if (!item.enabled || !item.actionToken) return
      const actionToken = item.actionToken
      const previousFocus = previousFocusRef.current
      previousFocusRef.current = null
      visibleRef.current = false
      clearSession()
      onVisibleChange(false)
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) {
          previousFocus.focus({ preventScroll: true })
        }
        void window.pulseMd
          .activateWindowsMenuItem(actionToken)
          .catch((error: unknown) => {
            console.error("Unable to activate the Windows menu item", error)
          })
      })
    },
    [clearSession, onVisibleChange]
  )

  React.useEffect(() => {
    visibleRef.current = visible
    if (!visible) {
      sessionGenerationRef.current += 1
      snapshotPromiseRef.current = null
      snapshotRef.current = null
      openMenuRef.current = null
      previousFocusRef.current = null
    }
  }, [visible])

  React.useLayoutEffect(() => {
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

      if (
        event.key === "F10" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        consumeMenuKey(event)
        if (event.repeat) return
        if (visibleRef.current) dismiss(true)
        else {
          setActiveMenu("file")
          beginSession()
        }
        return
      }

      if (altArmedRef.current) altArmedRef.current = false

      if (event.altKey && event.code === "Space") {
        if (visibleRef.current) dismiss(false)
        return
      }

      const mnemonic = windowsMenuForMnemonic(event.key)
      if (
        mnemonic &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        consumeMenuKey(event)
        revealAndOpen(mnemonic)
        return
      }

      if (visibleRef.current && openMenuRef.current) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        const target = event.target instanceof Element ? event.target : null
        const insideSubmenu = Boolean(
          target?.closest('[data-slot="menubar-sub-content"]')
        )
        const openingSubmenu = Boolean(
          event.key === "ArrowRight" &&
          target?.closest('[data-slot="menubar-sub-trigger"]')
        )
        const closingSubmenu = Boolean(
          event.key === "ArrowLeft" &&
          target?.closest(
            '[data-slot="menubar-sub-trigger"][aria-expanded="true"]'
          )
        )
        if (insideSubmenu || openingSubmenu) return
        if (closingSubmenu) return

        consumeMenuKey(event)
        const nextMenu = stepWindowsMenu(
          openMenuRef.current,
          event.key === "ArrowLeft" ? -1 : 1,
          menuEnabled
        )
        setActiveMenu(nextMenu)
        buttonRefs.current.get(nextMenu)?.focus({ preventScroll: true })
        setOpenMenuState(nextMenu)
        return
      }

      if (!visibleRef.current) return

      if (event.key === "Escape") {
        consumeMenuKey(event)
        dismiss(true)
        return
      }
      if (event.key === "Tab") {
        dismiss(false)
        return
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return
      }
      if (mnemonic) {
        consumeMenuKey(event)
        revealAndOpen(mnemonic)
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
        revealAndOpen(activeMenu)
        return
      }

      // Access mode intentionally leaves the prior editor/input focused until
      // a dropdown opens. Suppress unrelated typing while that mode is active.
      consumeMenuKey(event)
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return
      if (!altArmedRef.current) return
      consumeMenuKey(event)
      altArmedRef.current = false
      if (visibleRef.current) dismiss(true)
      else {
        setActiveMenu("file")
        beginSession()
      }
    }

    const handleWindowBlur = () => {
      altArmedRef.current = false
      if (visibleRef.current) dismiss(false)
    }
    const handleWindowResize = () => {
      if (visibleRef.current) dismiss(false)
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
    beginSession,
    dismiss,
    menuEnabled,
    revealAndOpen,
    setActiveMenu,
    setOpenMenuState,
  ])

  React.useEffect(() => {
    if (!visible || openMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      if (stripRef.current?.contains(event.target as Node | null)) return
      dismiss(false)
    }
    window.addEventListener("pointerdown", handlePointerDown, true)
    return () =>
      window.removeEventListener("pointerdown", handlePointerDown, true)
  }, [dismiss, openMenu, visible])

  React.useLayoutEffect(() => {
    if (visible) revealMenuButton(activeMenu)
  }, [activeMenu, revealMenuButton, visible])

  return (
    <Menubar
      ref={stripRef}
      aria-hidden={!visible}
      aria-label="Application menu"
      className="windows-menu-strip"
      modal
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
      {WINDOWS_MENU_DEFINITIONS.map((definition) => {
        const mnemonicIndex = definition.label
          .toLowerCase()
          .indexOf(definition.mnemonic)
        const enabled = snapshot?.[definition.id].enabled ?? false
        const highlighted = activeMenu === definition.id
        return (
          <MenubarMenu
            key={definition.id}
            disabled={!enabled}
            open={
              visible &&
              openMenu === definition.id &&
              Boolean(snapshot?.[definition.id])
            }
            onOpenChange={(nextOpen, details) => {
              if (nextOpen) {
                if (!enabled) return
                beginSession()
                setActiveMenu(definition.id)
                setOpenMenuState(definition.id)
                return
              }
              if (
                details.reason === "sibling-open" ||
                details.reason === "list-navigation"
              ) {
                return
              }
              dismiss(details.reason !== "outside-press")
            }}
          >
            <MenubarTrigger
              ref={(button) => {
                if (button) buttonRefs.current.set(definition.id, button)
                else buttonRefs.current.delete(definition.id)
              }}
              aria-label={definition.label}
              className="windows-menu-item"
              data-active={highlighted || undefined}
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
              onPointerEnter={(event) => {
                if (!enabled) return
                setActiveMenu(definition.id)
                if (
                  openMenuRef.current &&
                  openMenuRef.current !== definition.id
                ) {
                  event.currentTarget.focus({ preventScroll: true })
                  setOpenMenuState(definition.id)
                }
              }}
            >
              {definition.label.slice(0, mnemonicIndex)}
              <span className="windows-menu-mnemonic" style={mnemonicStyle}>
                {definition.label[mnemonicIndex]}
              </span>
              {definition.label.slice(mnemonicIndex + 1)}
            </MenubarTrigger>
            <MenubarContent className={menuContentClassName} sideOffset={0}>
              {snapshot ? (
                <WindowsMenuItems
                  items={snapshot[definition.id].items}
                  onLeaveSubmenu={() =>
                    buttonRefs.current
                      .get(definition.id)
                      ?.focus({ preventScroll: true })
                  }
                  parentPath={definition.id}
                  onInvoke={invokeItem}
                />
              ) : null}
            </MenubarContent>
          </MenubarMenu>
        )
      })}
    </Menubar>
  )
}
