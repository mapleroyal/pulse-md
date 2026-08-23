import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { sameCanonicalPath } from "./canonical-path.mjs"

test("compares existing paths by their canonical filesystem location", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pmd-canonical-path-"))
  t.after(() => rm(root, { force: true, recursive: true }))

  const target = path.join(root, "target")
  const alias = path.join(root, "alias")
  await mkdir(target)
  await symlink(
    target,
    alias,
    process.platform === "win32" ? "junction" : "dir"
  )

  assert.equal(await sameCanonicalPath(alias, target), true)
  assert.equal(await sameCanonicalPath(alias, root), false)
  assert.equal(
    await sameCanonicalPath(alias, path.join(root, "missing")),
    false
  )
})

test(
  "recognizes the macOS /var filesystem alias",
  { skip: process.platform !== "darwin" },
  async () => {
    assert.equal(await sameCanonicalPath("/var", "/private/var"), true)
  }
)
