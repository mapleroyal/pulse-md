import type {
  Config as DOMPurifyConfig,
  DOMPurify,
  WindowLike,
} from "dompurify"

import { createRetryableDynamicImport } from "../lib/retryable-dynamic-import"

const purifiers = new WeakMap<Window, DOMPurify>()
const loadDOMPurify = createRetryableDynamicImport(() => import("dompurify"))

async function purifierFor(ownerDocument: Document) {
  const ownerWindow = ownerDocument.defaultView
  if (!ownerWindow) throw new Error("Sanitized previews require a window")

  const cached = purifiers.get(ownerWindow)
  if (cached) return cached

  const { default: createDOMPurify } = await loadDOMPurify()
  const purifier = createDOMPurify(
    ownerWindow as unknown as WindowLike
  ) as DOMPurify
  purifiers.set(ownerWindow, purifier)
  return purifier
}

/**
 * Sanitizes into an inert fragment owned by the editor document. DOMPurify is
 * intentionally loaded only after a supported preview widget reaches the DOM.
 */
export async function sanitizedFragment(
  ownerDocument: Document,
  source: string,
  config: DOMPurifyConfig
) {
  const purifier = await purifierFor(ownerDocument)
  const fragment = purifier.sanitize(source, {
    ...config,
    RETURN_DOM_FRAGMENT: true,
    RETURN_DOM: false,
    RETURN_TRUSTED_TYPE: false,
  }) as DocumentFragment
  return ownerDocument.importNode(fragment, true)
}
