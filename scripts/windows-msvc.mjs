export function windowsMsvcArchitecture(nodeArchitecture) {
  return { arm64: "arm64", ia32: "x86", x64: "x64" }[nodeArchitecture] ?? "x64"
}

export function windowsMsvcComponent(nodeArchitecture) {
  return nodeArchitecture === "arm64"
    ? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
    : "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
}
