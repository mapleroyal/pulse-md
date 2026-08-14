import assert from "node:assert/strict"
import { test } from "node:test"

import {
  windowsMsvcArchitecture,
  windowsMsvcComponent,
} from "./windows-msvc.mjs"

test("Windows MSVC discovery selects the native tool component", () => {
  assert.equal(
    windowsMsvcComponent("arm64"),
    "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
  )
  assert.equal(
    windowsMsvcComponent("x64"),
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  )
  assert.equal(
    windowsMsvcComponent("ia32"),
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  )
})

test("Windows MSVC environment selects the matching target architecture", () => {
  assert.equal(windowsMsvcArchitecture("arm64"), "arm64")
  assert.equal(windowsMsvcArchitecture("x64"), "x64")
  assert.equal(windowsMsvcArchitecture("ia32"), "x86")
})
