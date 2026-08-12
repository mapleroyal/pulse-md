// EditorState materialization is synchronous. Keep potentially multi-hundred-
// millisecond work out of opportunistic post-launch idle callbacks while still
// warming ordinary documents.
export const IDLE_TAB_HYDRATION_SIZE_BUDGET = 8 * 1024 * 1024

export function tabSizeAllowsIdleHydration(
  documentCodeUnits: number,
  fileBytes: number | null
): boolean {
  return (
    documentCodeUnits < IDLE_TAB_HYDRATION_SIZE_BUDGET &&
    (fileBytes === null || fileBytes < IDLE_TAB_HYDRATION_SIZE_BUDGET)
  )
}
