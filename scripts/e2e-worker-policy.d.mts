export const DEFAULT_PARALLEL_E2E_WORKERS: number
export const WINDOWS_X64_ON_ARM64_E2E_WORKERS: number

export function isWindowsX64OnArm64(
  platform?: string,
  architecture?: string,
  processorIdentifier?: string
): boolean

export function parallelE2eWorkers(
  platform?: string,
  architecture?: string,
  processorIdentifier?: string
): number
