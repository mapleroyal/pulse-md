export const DEFAULT_PARALLEL_E2E_WORKERS = 4
export const WINDOWS_X64_ON_ARM64_E2E_WORKERS = 1

export function isWindowsX64OnArm64(
  platform = process.platform,
  architecture = process.arch,
  processorIdentifier = process.env.PROCESSOR_IDENTIFIER ?? ""
) {
  return (
    platform === "win32" &&
    architecture === "x64" &&
    /\bARM(?:64|v8)\b/i.test(processorIdentifier)
  )
}

export function parallelE2eWorkers(
  platform = process.platform,
  architecture = process.arch,
  processorIdentifier = process.env.PROCESSOR_IDENTIFIER ?? ""
) {
  return isWindowsX64OnArm64(platform, architecture, processorIdentifier)
    ? WINDOWS_X64_ON_ARM64_E2E_WORKERS
    : DEFAULT_PARALLEL_E2E_WORKERS
}
