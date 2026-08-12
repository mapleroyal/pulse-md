import { rm } from "node:fs/promises"
import { build } from "esbuild"

await rm("dist-electron", { force: true, recursive: true })

const shared = {
  bundle: true,
  logLevel: "info",
  minify: true,
  platform: "node",
  sourcemap: false,
  target: "node22",
}

await Promise.all([
  build({
    ...shared,
    entryPoints: ["electron/main.ts"],
    external: ["electron"],
    format: "cjs",
    outfile: "dist-electron/main.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["electron/preload.ts"],
    external: ["electron"],
    format: "cjs",
    outfile: "dist-electron/preload.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["electron/document-utility.ts"],
    format: "cjs",
    outfile: "dist-electron/document-utility.cjs",
  }),
])
