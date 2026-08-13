import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const helperPath = path.join(
  projectRoot,
  "dist-native",
  process.platform,
  "bin/pmd"
)
const platformSupported =
  process.platform === "darwin" || process.platform === "linux"
const cliTest = platformSupported
  ? test
  : (name, callback) =>
      test(name, { skip: "the native CLI helper is POSIX-only" }, callback)

let socketDirectory = ""
let socketPath = ""

before(async () => {
  if (!platformSupported) return
  socketDirectory = await mkdtemp("/tmp/pmd-cli-test-")
  await chmod(socketDirectory, 0o700)
  socketPath = path.join(socketDirectory, "cli-v3.sock")
})

after(async () => {
  if (!socketDirectory) {
    return
  }
  await rm(socketPath, { force: true })
  await rmdir(socketDirectory)
})

function frame(kind, exitCode, payload = "") {
  const payloadBuffer = Buffer.from(payload, "utf8")
  const result = Buffer.allocUnsafe(6 + payloadBuffer.length)
  result[0] = kind.charCodeAt(0)
  result[1] = exitCode
  result.writeUInt32BE(payloadBuffer.length, 2)
  payloadBuffer.copy(result, 6)
  return result
}

function decodeRequest(request) {
  if (request.length < 46) return null
  assert.deepEqual(request.subarray(0, 8), Buffer.from("PMDCLI3\0", "binary"))

  let offset = 8
  const protocolVersion = request.readUInt32BE(offset)
  offset += 4
  const argumentCount = request.readUInt32BE(offset)
  offset += 4
  const cwdLength = request.readUInt32BE(offset)
  offset += 4
  const stdinPresent = request[offset] === 1
  offset += 1
  const stdinLengthBigInt = request.readBigUInt64BE(offset)
  assert.ok(stdinLengthBigInt <= BigInt(Number.MAX_SAFE_INTEGER))
  const stdinLength = Number(stdinLengthBigInt)
  offset += 8
  const activeWindowPresent = request[offset] === 1
  offset += 1
  const rawActiveWindowBounds = {
    x: request.readInt32BE(offset),
    y: request.readInt32BE(offset + 4),
    width: request.readInt32BE(offset + 8),
    height: request.readInt32BE(offset + 12),
  }
  offset += 16
  const activeWindowBounds = activeWindowPresent ? rawActiveWindowBounds : null

  if (offset + cwdLength > request.length) return null
  const cwd = request.subarray(offset, offset + cwdLength).toString("utf8")
  offset += cwdLength

  const argumentsList = []
  for (let index = 0; index < argumentCount; index++) {
    if (offset + 4 > request.length) return null
    const argumentLength = request.readUInt32BE(offset)
    offset += 4
    if (offset + argumentLength > request.length) return null
    argumentsList.push(
      request.subarray(offset, offset + argumentLength).toString("utf8")
    )
    offset += argumentLength
  }

  if (offset + stdinLength > request.length) return null
  assert.equal(offset + stdinLength, request.length)

  return {
    protocolVersion,
    activeWindowBounds,
    arguments: argumentsList,
    cwd,
    stdinPresent,
    stdinLength,
    stdin: request.subarray(offset, offset + stdinLength),
  }
}

async function serveOnce(respond) {
  await rm(socketPath, { force: true })
  const activeSockets = new Set()

  let resolveRequest
  let rejectRequest
  const request = new Promise((resolve, reject) => {
    resolveRequest = resolve
    rejectRequest = reject
  })

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    activeSockets.add(socket)
    socket.once("close", () => activeSockets.delete(socket))
    let buffered = Buffer.alloc(0)
    let handled = false
    socket.on("data", (chunk) => {
      if (handled) {
        rejectRequest(
          new Error("CLI helper sent data after its framed request")
        )
        socket.destroy()
        return
      }
      try {
        buffered = Buffer.concat([buffered, chunk])
        const decoded = decodeRequest(buffered)
        if (!decoded) return
        handled = true
        resolveRequest(decoded)
        Promise.resolve(respond(socket, decoded)).catch((error) => {
          rejectRequest(error)
          socket.destroy()
        })
      } catch (error) {
        rejectRequest(error)
        socket.destroy()
      }
    })
    socket.on("error", rejectRequest)
    socket.on("end", () => {
      if (!handled) {
        rejectRequest(new Error("CLI helper closed an incomplete request"))
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)

  return {
    request,
    close: async () => {
      for (const socket of activeSockets) {
        socket.destroy()
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await rm(socketPath, { force: true })
    },
  }
}

function runHelper(
  argumentsList,
  { cwd, stdin = "", env = {}, helper = helperPath } = {}
) {
  const child = spawn(helper, argumentsList, {
    cwd,
    env: { ...process.env, PMD_CLI_ENDPOINT: socketPath, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout = []
  const stderr = []
  child.stdout.on("data", (chunk) => stdout.push(chunk))
  child.stderr.on("data", (chunk) => stderr.push(chunk))
  const result = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.stdin.on("error", (error) => {
      // An early validation failure can exit before Node finishes closing the
      // otherwise-empty stdin pipe. The process result is still authoritative.
      if (error.code !== "EPIPE") reject(error)
    })
    child.once("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    )
  })
  child.stdin.end(stdin)

  return {
    child,
    result,
  }
}

cliTest("rejects a non-absolute development endpoint", async () => {
  for (const endpoint of ["", "relative/cli-v3.sock"]) {
    const invocation = runHelper([], {
      cwd: projectRoot,
      env: {
        PMD_APP_EXECUTABLE: "/bin/false",
        PMD_CLI_ENDPOINT: endpoint,
      },
    })
    const result = await invocation.result
    assert.equal(result.code, 1)
    assert.match(
      result.stderr,
      /PMD_CLI_ENDPOINT must be an absolute Unix socket path/
    )
  }
})

cliTest("rejects an insecure development endpoint parent", async () => {
  const insecureDirectory = path.join(socketDirectory, "insecure")
  await mkdir(insecureDirectory, { mode: 0o755 })
  await chmod(insecureDirectory, 0o755)
  try {
    const invocation = runHelper([], {
      cwd: projectRoot,
      env: {
        PMD_APP_EXECUTABLE: "/bin/false",
        PMD_CLI_ENDPOINT: path.join(insecureDirectory, "cli-v3.sock"),
      },
    })
    const result = await invocation.result
    assert.equal(result.code, 1)
    assert.match(result.stderr, /refusing insecure CLI directory/)
  } finally {
    await rmdir(insecureDirectory)
  }
})

cliTest(
  "forwards cwd, arguments, and an explicitly requested open stdin source",
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pmd-cli-cwd-"))
    const service = await serveOnce(async (socket) => {
      socket.end(frame("o", 7, "server output\n"))
    })

    try {
      const invocation = runHelper(["--unknown", "-", "café.md"], {
        cwd,
        stdin: "piped markdown\n",
      })
      const [request, result] = await Promise.all([
        service.request,
        invocation.result,
      ])

      assert.equal(request.protocolVersion, 3)
      if (request.activeWindowBounds !== null) {
        assert.ok(request.activeWindowBounds.width > 0)
        assert.ok(request.activeWindowBounds.height > 0)
      }
      assert.deepEqual(request.arguments, ["--unknown", "-", "café.md"])
      assert.equal(request.cwd, await realpath(cwd))
      assert.equal(request.stdinPresent, true)
      assert.equal(request.stdinLength, Buffer.byteLength("piped markdown\n"))
      assert.equal(request.stdin.toString("utf8"), "piped markdown\n")
      assert.deepEqual(await readdir(socketDirectory), ["cli-v3.sock"])
      assert.deepEqual(result, {
        code: 7,
        signal: null,
        stdout: "server output\n",
        stderr: "",
      })
    } finally {
      await service.close()
      await rm(cwd, { recursive: true, force: true })
    }
  }
)

cliTest("writes chunked output until the terminal response", async () => {
  const service = await serveOnce(async (socket) => {
    socket.write(frame("c", 0, "first 😀\n"))
    socket.write(frame("c", 0, "second café\n"))
    socket.end(frame("o", 0))
  })

  try {
    const invocation = runHelper(["scratch", "export", "notes", "-"], {
      cwd: projectRoot,
    })
    const result = await invocation.result
    await service.request

    assert.deepEqual(result, {
      code: 0,
      signal: null,
      stdout: "first 😀\nsecond café\n",
      stderr: "",
    })
  } finally {
    await service.close()
  }
})

cliTest(
  "does not confuse profile export's stdout marker with an stdin source",
  async () => {
    const service = await serveOnce(async (socket) => {
      socket.end(frame("a", 0))
    })

    try {
      const invocation = runHelper(["profile", "export", "notes", "-"], {
        cwd: projectRoot,
        stdin: "redirected automation input",
      })
      const [request, result] = await Promise.all([
        service.request,
        invocation.result,
      ])
      assert.equal(request.stdinPresent, false)
      assert.equal(request.stdinLength, 0)
      assert.equal(result.code, 0)
    } finally {
      await service.close()
    }
  }
)

cliTest(
  "does not confuse scratch export's stdout marker with an stdin source",
  async () => {
    const service = await serveOnce(async (socket) => {
      socket.end(frame("a", 0))
    })

    try {
      const invocation = runHelper(["scratch", "export", "notes", "-"], {
        cwd: projectRoot,
        stdin: "redirected automation input",
      })
      const [request, result] = await Promise.all([
        service.request,
        invocation.result,
      ])
      assert.equal(request.stdinPresent, false)
      assert.equal(request.stdinLength, 0)
      assert.equal(result.code, 0)
    } finally {
      await service.close()
    }
  }
)

cliTest(
  "ignores inherited redirected stdin when no stdin operand is present",
  async () => {
    const service = await serveOnce(async (socket) => {
      socket.end(frame("a", 0))
    })

    try {
      const invocation = runHelper(["notes.md"], {
        cwd: projectRoot,
        stdin: "must not become an implicit document",
      })
      const [request, result] = await Promise.all([
        service.request,
        invocation.result,
      ])
      assert.equal(request.stdinPresent, false)
      assert.equal(request.stdinLength, 0)
      assert.equal(request.stdin.length, 0)
      assert.equal(result.code, 0)
    } finally {
      await service.close()
    }
  }
)

cliTest("stays connected after an accepted-and-waiting response", async () => {
  const service = await serveOnce(async (socket) => {
    socket.write(frame("w", 0, "accepted\n"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    socket.end(frame("d", 3, "closed\n"))
  })

  try {
    const invocation = runHelper(["--wait", "notes.md"], {
      cwd: projectRoot,
    })
    const result = await invocation.result
    await service.request

    assert.equal(result.code, 3)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, "accepted\nclosed\n")
    assert.equal(result.stderr, "")
  } finally {
    await service.close()
  }
})

cliTest(
  "launches the configured app detached and retries the socket",
  async () => {
    await rm(socketPath, { force: true })
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "pmd-cli-app-")
    )
    const appPath = path.join(temporaryDirectory, "fake-app.cjs")
    const appSource = `#!/usr/bin/env node
const fs = require("node:fs")
const net = require("node:net")
const endpoint = ${JSON.stringify(socketPath)}
const expectedArgument = process.argv[2] === "--pmd-cli-server"
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  let request = Buffer.alloc(0)
  socket.on("data", (chunk) => {
    request = Buffer.concat([request, chunk])
    if (request.length < 46) return
    const argumentCount = request.readUInt32BE(12)
    const cwdLength = request.readUInt32BE(16)
    const stdinLength = Number(request.readBigUInt64BE(21))
    let offset = 46 + cwdLength
    for (let index = 0; index < argumentCount; index += 1) {
      if (request.length < offset + 4) return
      const argumentLength = request.readUInt32BE(offset)
      offset += 4
      if (request.length < offset + argumentLength) return
      offset += argumentLength
    }
    if (request.length < offset + stdinLength) return
    const payload = Buffer.from(expectedArgument ? "launched\\n" : "bad launch argument\\n")
    const response = Buffer.alloc(6 + payload.length)
    response[0] = (expectedArgument ? "a" : "e").charCodeAt(0)
    response[1] = expectedArgument ? 0 : 9
    response.writeUInt32BE(payload.length, 2)
    payload.copy(response, 6)
    socket.end(response, () => server.close())
  })
})
server.listen(endpoint, () => fs.chmodSync(endpoint, 0o600))
`
    await writeFile(appPath, appSource, { mode: 0o755 })
    await chmod(appPath, 0o755)

    try {
      const invocation = runHelper(["new.md"], {
        cwd: projectRoot,
        env: { PMD_APP_EXECUTABLE: path.relative(projectRoot, appPath) },
      })
      const result = await invocation.result
      assert.deepEqual(result, {
        code: 0,
        signal: null,
        stdout: "launched\n",
        stderr: "",
      })
    } finally {
      await rm(socketPath, { force: true })
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
)

cliTest("returns 130 when interrupted while waiting for the app", async () => {
  const service = await serveOnce(async () => {
    // Keep the response side open until SIGINT closes the client socket.
  })

  try {
    const invocation = runHelper(["--wait", "notes.md"], {
      cwd: projectRoot,
    })
    await service.request
    invocation.child.kill("SIGINT")
    const result = await invocation.result
    assert.equal(result.code, 130)
    assert.equal(result.signal, null)
  } finally {
    await service.close()
  }
})

cliTest("the helper artifact is a standalone executable", async () => {
  const bytes = await readFile(helperPath)
  assert.ok(bytes.length > 0)
  assert.notEqual(bytes.subarray(0, 2).toString("utf8"), "#!")
})
