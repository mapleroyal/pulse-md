import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const helperPath = path.join(
  projectRoot,
  "dist-native",
  "win32",
  "bin",
  "pmd.exe"
)
const endpoint = `\\\\.\\pipe\\pulse-md-cli-test-${process.pid}`
const platformSupported = process.platform === "win32"
const windowsTest = platformSupported
  ? test
  : (name, callback) =>
      test(
        name,
        { skip: "the native Windows CLI helper requires Windows" },
        callback
      )

function windowsIdentityHash(value) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    hash ^= BigInt(codeUnit & 0xff)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    hash ^= BigInt(codeUnit >>> 8)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

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

  if (offset + cwdLength > request.length) return null
  const cwd = request.subarray(offset, offset + cwdLength).toString("utf8")
  offset += cwdLength

  const argumentsList = []
  for (let index = 0; index < argumentCount; index += 1) {
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
    arguments: argumentsList,
    activeWindowBounds: activeWindowPresent ? rawActiveWindowBounds : null,
    cwd,
    protocolVersion,
    stdin: request.subarray(offset),
    stdinLength,
    stdinPresent,
  }
}

async function serveOnce(respond, pipeEndpoint = endpoint) {
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
      try {
        if (handled) throw new Error("CLI helper sent trailing request data")
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
      if (!handled)
        rejectRequest(new Error("CLI helper sent a partial request"))
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(pipeEndpoint, resolve)
  })

  return {
    request,
    close: async () => {
      for (const socket of activeSockets) socket.destroy()
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

function runHelper(
  argumentsList,
  { cwd = projectRoot, env = {}, pipeEndpoint = endpoint, stdin = "" } = {}
) {
  const childEnvironment = { ...process.env, ...env }
  if (pipeEndpoint === null) {
    delete childEnvironment.PMD_CLI_ENDPOINT
  } else {
    childEnvironment.PMD_CLI_ENDPOINT = pipeEndpoint
  }
  const child = spawn(helperPath, argumentsList, {
    cwd,
    env: childEnvironment,
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
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    })
  })
  child.stdin.end(stdin)
  return result
}

windowsTest(
  "Windows helper forwards UTF-8 argv, cwd, and explicitly requested stdin",
  async () => {
    const service = await serveOnce((socket) => {
      socket.end(frame("o", 7, "server café output\n"))
    })
    try {
      const [request, result] = await Promise.all([
        service.request,
        runHelper(["--unknown", "-", "café.md"], {
          stdin: "piped markdown\n",
        }),
      ])
      assert.equal(request.protocolVersion, 3)
      assert.deepEqual(request.arguments, ["--unknown", "-", "café.md"])
      assert.equal(request.cwd, projectRoot)
      assert.equal(request.stdinPresent, true)
      assert.equal(request.stdinLength, Buffer.byteLength("piped markdown\n"))
      assert.equal(request.stdin.toString("utf8"), "piped markdown\n")
      assert.deepEqual(result, {
        code: 7,
        signal: null,
        stderr: "",
        stdout: "server café output\n",
      })
    } finally {
      await service.close()
    }
  }
)

windowsTest(
  "Windows helper writes chunked output until completion",
  async () => {
    const service = await serveOnce((socket) => {
      socket.write(frame("c", 0, "first 😀\n"))
      socket.write(frame("c", 0, "second café\n"))
      socket.end(frame("o", 0))
    })
    try {
      const [request, result] = await Promise.all([
        service.request,
        runHelper(["scratch", "export", "notes", "-"]),
      ])
      assert.deepEqual(request.arguments, ["scratch", "export", "notes", "-"])
      assert.deepEqual(result, {
        code: 0,
        signal: null,
        stderr: "",
        stdout: "first 😀\nsecond café\n",
      })
    } finally {
      await service.close()
    }
  }
)

windowsTest(
  "Windows helper ignores redirected stdin without a - operand",
  async () => {
    const service = await serveOnce((socket) => socket.end(frame("a", 0)))
    try {
      const [request, result] = await Promise.all([
        service.request,
        runHelper(["notes.md"], { stdin: "not an implicit document" }),
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

windowsTest(
  "Windows helper does not treat profile export's stdout marker as stdin",
  async () => {
    const service = await serveOnce((socket) => socket.end(frame("a", 0)))
    try {
      const [request, result] = await Promise.all([
        service.request,
        runHelper(["profile", "export", "notes", "-"], {
          stdin: "redirected automation input",
        }),
      ])
      assert.equal(request.stdinPresent, false)
      assert.equal(request.stdinLength, 0)
      assert.equal(result.code, 0)
    } finally {
      await service.close()
    }
  }
)

windowsTest(
  "Windows helper does not treat scratch export's stdout marker as stdin",
  async () => {
    const service = await serveOnce((socket) => socket.end(frame("a", 0)))
    try {
      const [request, result] = await Promise.all([
        service.request,
        runHelper(["scratch", "export", "notes", "-"], {
          stdin: "redirected automation input",
        }),
      ])
      assert.equal(request.stdinPresent, false)
      assert.equal(request.stdinLength, 0)
      assert.equal(result.code, 0)
    } finally {
      await service.close()
    }
  }
)

windowsTest(
  "Windows helper derives the endpoint from the user profile",
  async () => {
    const appData = `C:\\Users\\pmd test:${process.pid}\\AppData\\Roaming`
    const identity = windowsIdentityHash(appData)
    const defaultEndpoint = `\\\\.\\pipe\\pulse-md-${identity}-cli-v3`
    const service = await serveOnce(
      (socket) => socket.end(frame("a", 0)),
      defaultEndpoint
    )
    try {
      const [request, result] = await Promise.all([
        service.request,
        runHelper([], {
          env: { APPDATA: appData },
          pipeEndpoint: null,
        }),
      ])
      assert.deepEqual(request.arguments, [])
      assert.equal(result.code, 0)
    } finally {
      await service.close()
    }
  }
)

windowsTest("Windows helper rejects an empty endpoint override", async () => {
  const result = await runHelper([], { pipeEndpoint: "" })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /PMD_CLI_ENDPOINT cannot be empty/)
})

windowsTest(
  "Windows helper preserves the waiting response sequence",
  async () => {
    const service = await serveOnce(async (socket) => {
      socket.write(frame("w", 0, "accepted\n"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      socket.end(frame("d", 3, "closed\n"))
    })
    try {
      const result = await runHelper(["--wait", "notes.md"])
      await service.request
      assert.deepEqual(result, {
        code: 3,
        signal: null,
        stderr: "",
        stdout: "accepted\nclosed\n",
      })
    } finally {
      await service.close()
    }
  }
)

windowsTest("Windows helper artifact is a native PE executable", async () => {
  const bytes = await readFile(helperPath)
  assert.ok(bytes.length > 2)
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "MZ")
})

test("Windows CLI packaging installs the helper and PATH integration", async () => {
  const [builderConfig, buildScript, installerInclude] = await Promise.all([
    readFile(path.join(projectRoot, "electron-builder.yml"), "utf8"),
    readFile(path.join(projectRoot, "scripts/build-cli.mjs"), "utf8"),
    readFile(path.join(projectRoot, "build/installer.nsh"), "utf8"),
  ])
  assert.match(builderConfig, /dist-native\/win32\/bin\/pmd\.exe/)
  assert.match(builderConfig, /include: build\/installer\.nsh/)
  assert.match(buildScript, /native\/pmd-cli-win\.c/)
  assert.match(buildScript, /PMD_MSVC_CL \|\| "cl\.exe"/)
  assert.match(buildScript, /"\/MT"/)
  assert.match(installerInclude, /customInstall/)
  assert.match(installerInclude, /customUnInstall/)
  assert.match(installerInclude, /\$INSTDIR\\resources\\bin/)
})
