const configuration = structuredClone(require("./electron-builder.config.cjs"))

configuration.appId = "io.github.mapleroyal.pulse-md.local"
configuration.productName = "Pulse MD Local"
configuration.extraMetadata = {
  ...(configuration.extraMetadata || {}),
  name: "pulse-md-local",
  productName: "Pulse MD Local",
  desktopName: "pulse-md-local.desktop",
  pmdDistributionChannel: "local",
}
configuration.protocols = [
  {
    name: "Pulse MD Local Scratch Link",
    schemes: ["pulse-md-local"],
  },
]
configuration.fileAssociations = []

configuration.mac.icon = "build/pulse-md.icns"
// Fuses patch Electron's Mach-O after its upstream signature was created.
// Ad-hoc signing makes that patched binary runnable without discovering or
// consuming a developer certificate.
configuration.mac.identity = "-"
configuration.mac.binaries = [
  "Contents/Resources/native/macos-window-blur.node",
  "Contents/Resources/bin/pmd-local",
]
configuration.mac.fileAssociations = []
configuration.mac.extraResources = [
  {
    from: "dist-native/macos-window-blur.node",
    to: "native/macos-window-blur.node",
  },
  {
    from: "dist-native/darwin/bin/pmd-local",
    to: "bin/pmd-local",
  },
]

configuration.win.extraResources = [
  {
    from: "dist-native/win32/bin/pmd-local.exe",
    to: "bin/pmd-local.exe",
  },
]

configuration.nsis.perMachine = false
configuration.nsis.include = "build/installer-local.nsh"
configuration.nsis.runAfterFinish = false

configuration.linux.extraResources = [
  {
    from: "build/icons/linux/512x512.png",
    to: "icons/pulse-md.png",
  },
  {
    from: "dist-native/linux/bin/pmd-local",
    to: "bin/pmd-local",
  },
]
configuration.linux.executableName = "pulse-md-local"
configuration.deb = {
  ...(configuration.deb || {}),
  packageName: "pulse-md-local",
}
configuration.linux.desktop = {
  ...(configuration.linux.desktop || {}),
  entry: {
    ...(configuration.linux.desktop?.entry || {}),
    Name: "Pulse MD Local",
    StartupWMClass: "pulse-md-local",
  },
}

module.exports = configuration
