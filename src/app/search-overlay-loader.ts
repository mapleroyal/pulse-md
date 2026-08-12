import { createRetryableDeferredLoader } from "@/app/deferred-loader"
import { createRetryableDynamicImport } from "@/lib/retryable-dynamic-import"

const loadSearchOverlayModule = createRetryableDynamicImport(
  () => import("@/app/SearchOverlay")
)
const loadSearchSupportModule = createRetryableDynamicImport(
  () => import("@/editor/search-support")
)

export const searchOverlayLoader = createRetryableDeferredLoader(() =>
  Promise.all([loadSearchOverlayModule(), loadSearchSupportModule()]).then(
    ([overlayModule, supportModule]) => ({
      Overlay: overlayModule.default,
      support: supportModule.editorSearchSupport,
    })
  )
)

export function prepareSearchOverlay() {
  return searchOverlayLoader.load()
}
