export const WINDOWS_NODE_ARCHITECTURE = "x64"

export function assertWindowsX64NodeArchitecture(nodeArchitecture) {
  if (nodeArchitecture !== WINDOWS_NODE_ARCHITECTURE) {
    throw new Error(
      `Pulse MD Windows builds require x64 Node.js (process.arch=x64); received process.arch=${String(nodeArchitecture)}`
    )
  }
}

export function windowsMsvcArchitecture(nodeArchitecture) {
  assertWindowsX64NodeArchitecture(nodeArchitecture)
  return "x64"
}

export function windowsMsvcComponent(nodeArchitecture) {
  assertWindowsX64NodeArchitecture(nodeArchitecture)
  return "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
}
