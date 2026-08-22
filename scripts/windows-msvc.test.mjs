import assert from "node:assert/strict"
import { test } from "node:test"

import {
  assertWindowsX64NodeArchitecture,
  WINDOWS_NODE_ARCHITECTURE,
  windowsMsvcArchitecture,
  windowsMsvcComponent,
} from "./windows-msvc.mjs"

test("Windows builds require x64 Node and select the x64 MSVC toolchain", () => {
  assert.equal(WINDOWS_NODE_ARCHITECTURE, "x64")
  assert.doesNotThrow(() => assertWindowsX64NodeArchitecture("x64"))
  assert.equal(
    windowsMsvcComponent("x64"),
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  )
  assert.equal(windowsMsvcArchitecture("x64"), "x64")

  for (const architecture of ["arm64", "ia32"]) {
    assert.throws(
      () => assertWindowsX64NodeArchitecture(architecture),
      /Windows builds require x64 Node\.js/
    )
    assert.throws(
      () => windowsMsvcComponent(architecture),
      /Windows builds require x64 Node\.js/
    )
    assert.throws(
      () => windowsMsvcArchitecture(architecture),
      /Windows builds require x64 Node\.js/
    )
  }
})
