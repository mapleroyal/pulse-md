import * as React from "react"

import {
  getSystemFontCatalogSnapshot,
  subscribeToSystemFontCatalog,
} from "@/app/font-catalog"

/** React binding for the renderer-session system font catalog. */
export function useSystemFontCatalog() {
  return React.useSyncExternalStore(
    subscribeToSystemFontCatalog,
    getSystemFontCatalogSnapshot,
    getSystemFontCatalogSnapshot
  )
}
