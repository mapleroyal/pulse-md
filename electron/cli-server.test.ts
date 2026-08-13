import { lstat, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CLI_PROTOCOL_VERSION,
  cliEndpointPath,
  startCliServer,
  windowsCliIdentityHash,
  type CliServer,
} from "./cli-server"

const REQUEST_MAGIC = Buffer.from("PMDCLI3\0", "ascii")
const STDIN_LENGTH_OFFSET = REQUEST_MAGIC.length + 4 + 4 + 4 + 1
const ACTIVE_WINDOW_FLAG_OFFSET = STDIN_LENGTH_OFFSET + 8
const ACTIVE_WINDOW_BOUNDS_OFFSET = ACTIVE_WINDOW_FLAG_OFFSET + 1

interface EncodedRequestOptions {
  activeWindowBounds?: {
    height: number
    width: number
    x: number
    y: number
  }
  argv?: string[]
  cwd: string
  declaredStdinLength?: bigint
  stdin?: Buffer
}

interface DecodedResponse {
  exitCode: number
  kind: string
  message: string
}

describe("Windows CLI endpoint identity", () => {
  it("hashes UTF-16 code units deterministically without username sanitization collisions", () => {
    expect(windowsCliIdentityHash("C:\\Users\\local\\AppData\\Roaming")).toBe(
      "0faf596641eea003"
    )
    expect(windowsCliIdentityHash("pmd test:one")).not.toBe(
      windowsCliIdentityHash("pmd_test_one")
    )
    expect(windowsCliIdentityHash("C:\\Users\\café")).toHaveLength(16)
  })
})

describe("CLI endpoint channel identity", () => {
  it.runIf(process.platform !== "win32")(
    "keeps installed and development sockets distinct",
    () => {
      const uid = process.getuid!()
      expect(cliEndpointPath("pulse-md")).toBe(
        path.join("/tmp", `pulse-md-${uid}`, "cli-v3.sock")
      )
      expect(cliEndpointPath("pulse-md-development-7315cb110cb8")).toBe(
        path.join(
          "/tmp",
          `pulse-md-development-7315cb110cb8-${uid}`,
          "cli-v3.sock"
        )
      )
    }
  )
})

function encodeRequest({
  argv = [],
  cwd,
  declaredStdinLength,
  stdin,
  activeWindowBounds,
}: EncodedRequestOptions): Buffer {
  const cwdBytes = Buffer.from(cwd, "utf8")
  const argumentBytes = argv.map((argument) => Buffer.from(argument, "utf8"))
  const hasStdin = stdin !== undefined || declaredStdinLength !== undefined
  const stdinBytes = stdin ?? Buffer.alloc(0)
  const header = Buffer.alloc(ACTIVE_WINDOW_BOUNDS_OFFSET + 16)
  REQUEST_MAGIC.copy(header, 0)
  header.writeUInt32BE(CLI_PROTOCOL_VERSION, REQUEST_MAGIC.length)
  header.writeUInt32BE(argv.length, REQUEST_MAGIC.length + 4)
  header.writeUInt32BE(cwdBytes.length, REQUEST_MAGIC.length + 8)
  header.writeUInt8(hasStdin ? 1 : 0, REQUEST_MAGIC.length + 12)
  header.writeBigUInt64BE(
    declaredStdinLength ?? BigInt(stdinBytes.length),
    STDIN_LENGTH_OFFSET
  )
  header.writeUInt8(activeWindowBounds ? 1 : 0, ACTIVE_WINDOW_FLAG_OFFSET)
  if (activeWindowBounds) {
    header.writeInt32BE(activeWindowBounds.x, ACTIVE_WINDOW_BOUNDS_OFFSET)
    header.writeInt32BE(activeWindowBounds.y, ACTIVE_WINDOW_BOUNDS_OFFSET + 4)
    header.writeInt32BE(
      activeWindowBounds.width,
      ACTIVE_WINDOW_BOUNDS_OFFSET + 8
    )
    header.writeInt32BE(
      activeWindowBounds.height,
      ACTIVE_WINDOW_BOUNDS_OFFSET + 12
    )
  }

  const encodedArguments = argumentBytes.flatMap((argument) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(argument.length)
    return [length, argument]
  })
  return Buffer.concat([header, cwdBytes, ...encodedArguments, stdinBytes])
}

function decodeResponses(buffer: Buffer): DecodedResponse[] {
  const responses: DecodedResponse[] = []
  let offset = 0
  while (offset < buffer.length) {
    expect(buffer.length - offset).toBeGreaterThanOrEqual(6)
    const messageLength = buffer.readUInt32BE(offset + 2)
    const payloadStart = offset + 6
    const nextOffset = payloadStart + messageLength
    expect(nextOffset).toBeLessThanOrEqual(buffer.length)
    responses.push({
      kind: String.fromCharCode(buffer.readUInt8(offset)),
      exitCode: buffer.readUInt8(offset + 1),
      message: buffer.toString("utf8", payloadStart, nextOffset),
    })
    offset = nextOffset
  }
  return responses
}

async function exchangeResponses(
  endpoint: string,
  request: Buffer,
  options: { halfClose?: boolean } = {}
): Promise<DecodedResponse[]> {
  const halfClose = options.halfClose ?? true
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.createConnection(endpoint)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error("Timed out waiting for the CLI server response"))
    }, 3_000)

    socket.once("connect", () => {
      if (halfClose) socket.end(request)
      else socket.write(request)
    })
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.once("end", () => {
      clearTimeout(timeout)
      resolve(decodeResponses(Buffer.concat(chunks)))
    })
  })
}

async function exchange(
  endpoint: string,
  request: Buffer,
  options: { halfClose?: boolean } = {}
): Promise<DecodedResponse> {
  const responses = await exchangeResponses(endpoint, request, options)
  expect(responses).toHaveLength(1)
  return responses[0]!
}

describe.sequential("CLI server protocol", () => {
  let runtimeDirectory: string
  let endpoint: string
  let server: CliServer | null

  beforeEach(async () => {
    runtimeDirectory = await mkdtemp(
      path.join(os.tmpdir(), "pmd-cli-server-test-")
    )
    endpoint = path.join(runtimeDirectory, "isolated-cli.sock")
    vi.stubEnv("PMD_CLI_ENDPOINT", endpoint)
    server = null
  })

  afterEach(async () => {
    await server?.close()
    server = null
    vi.unstubAllEnvs()
    await rm(runtimeDirectory, { force: true, recursive: true })
  })

  it("uses and cleans up the explicitly isolated endpoint", async () => {
    server = await startCliServer(runtimeDirectory, ({ responder }) => {
      responder.accepted()
    })

    expect(cliEndpointPath()).toBe(endpoint)
    expect(server.endpoint).toBe(endpoint)
    expect((await lstat(endpoint)).isSocket()).toBe(true)
    expect((await lstat(endpoint)).mode & 0o777).toBe(0o600)

    await server.close()
    server = null
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("closes an accepted socket that has not dispatched a complete request", async () => {
    const handler = vi.fn()
    server = await startCliServer(runtimeDirectory, handler)
    const socket = net.createConnection(endpoint)
    socket.on("error", () => undefined)
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    const closed = new Promise<void>((resolve) => socket.once("close", resolve))
    socket.write(REQUEST_MAGIC.subarray(0, 3))

    await server.close()
    server = null
    await closed

    expect(handler).not.toHaveBeenCalled()
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a relative configured endpoint", () => {
    vi.stubEnv("PMD_CLI_ENDPOINT", "relative-cli.sock")
    expect(() => cliEndpointPath()).toThrow(
      "PMD_CLI_ENDPOINT must be an absolute socket path"
    )
  })

  it("responds as soon as a complete request arrives without a peer half-close", async () => {
    const handler = vi.fn(
      ({ activeWindowBounds, argv, cwd, stdinPath, responder }) => {
        expect(activeWindowBounds).toEqual({
          x: -1440,
          y: 24,
          width: 900,
          height: 720,
        })
        expect(argv).toEqual(["open", "notes.md"])
        expect(cwd).toBe(runtimeDirectory)
        expect(stdinPath).toBeNull()
        responder.accepted("opened\n")
      }
    )
    server = await startCliServer(runtimeDirectory, handler)

    const response = await exchange(
      endpoint,
      encodeRequest({
        argv: ["open", "notes.md"],
        activeWindowBounds: {
          x: -1440,
          y: 24,
          width: 900,
          height: 720,
        },
        cwd: runtimeDirectory,
      }),
      { halfClose: false }
    )

    expect(response).toEqual({ kind: "a", exitCode: 0, message: "opened\n" })
    expect(handler).toHaveBeenCalledOnce()
  })

  it("notifies an interactive handler when the helper sends its interruption marker", async () => {
    let markHandlerStarted: (() => void) | undefined
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve
    })
    let markDisconnected: (() => void) | undefined
    const disconnected = new Promise<void>((resolve) => {
      markDisconnected = resolve
    })
    server = await startCliServer(runtimeDirectory, ({ responder }) => {
      responder.onDisconnect(() => markDisconnected?.())
      markHandlerStarted?.()
    })

    const socket = net.createConnection(endpoint)
    socket.on("error", () => undefined)
    const socketClosed = new Promise<void>((resolve) =>
      socket.once("close", resolve)
    )
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.write(encodeRequest({ cwd: runtimeDirectory }))
    await handlerStarted
    socket.write(Buffer.from([0]))

    await disconnected
    await socketClosed
  })

  it("streams multiple output chunks before one terminal response", async () => {
    server = await startCliServer(runtimeDirectory, async ({ responder }) => {
      await responder.outputChunks(
        (async function* () {
          yield "first 😀\n"
          yield "second café\n"
        })()
      )
    })

    const responses = await exchangeResponses(
      endpoint,
      encodeRequest({ cwd: runtimeDirectory }),
      { halfClose: false }
    )
    expect(responses).toEqual([
      { kind: "c", exitCode: 0, message: "first 😀\n" },
      { kind: "c", exitCode: 0, message: "second café\n" },
      { kind: "o", exitCode: 0, message: "" },
    ])
  })

  it("terminates a dispatched output stream stalled on client backpressure when the server closes", async () => {
    let markHandlerStarted: (() => void) | undefined
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve
    })
    let markHandlerSettled: (() => void) | undefined
    const handlerSettled = new Promise<void>((resolve) => {
      markHandlerSettled = resolve
    })
    server = await startCliServer(runtimeDirectory, async ({ responder }) => {
      markHandlerStarted?.()
      try {
        await responder.outputChunks(
          (async function* () {
            yield "x".repeat(16 * 1_048_576)
          })()
        )
      } finally {
        markHandlerSettled?.()
      }
    })

    const socket = net.createConnection(endpoint)
    socket.on("error", () => undefined)
    socket.pause()
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.write(encodeRequest({ cwd: runtimeDirectory }))
    await handlerStarted
    await new Promise<void>((resolve) => setImmediate(resolve))

    await Promise.all([server.close(), handlerSettled])
    server = null
    socket.destroy()
  })

  it("spools an explicitly declared empty stdin stream", async () => {
    let observedStdinPath: string | null = null
    server = await startCliServer(
      runtimeDirectory,
      async ({ stdinPath, responder }) => {
        expect(stdinPath).not.toBeNull()
        observedStdinPath = stdinPath
        expect(await readFile(stdinPath!)).toEqual(Buffer.alloc(0))
        await unlink(stdinPath!)
        responder.accepted()
      }
    )

    const request = encodeRequest({
      cwd: runtimeDirectory,
      declaredStdinLength: 0n,
      stdin: Buffer.alloc(0),
    })
    expect(request.readBigUInt64BE(STDIN_LENGTH_OFFSET)).toBe(0n)

    expect(
      await exchange(endpoint, request, { halfClose: false })
    ).toMatchObject({ kind: "a", exitCode: 0 })
    expect(observedStdinPath).not.toBeNull()
  })

  it("decodes the stdin length as an unsigned 64-bit big-endian value", async () => {
    const handler = vi.fn()
    server = await startCliServer(runtimeDirectory, handler)
    const declaredLength = 0x1_0000_0001n
    const request = encodeRequest({
      cwd: runtimeDirectory,
      declaredStdinLength: declaredLength,
      stdin: Buffer.from("x"),
    })

    expect(request.readBigUInt64BE(STDIN_LENGTH_OFFSET)).toBe(declaredLength)
    expect(await exchange(endpoint, request)).toEqual({
      kind: "e",
      exitCode: 1,
      message: "The CLI request is incomplete\n",
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects stdin larger than the declared uint64 length", async () => {
    const handler = vi.fn()
    server = await startCliServer(runtimeDirectory, handler)
    const request = encodeRequest({
      cwd: runtimeDirectory,
      declaredStdinLength: 2n,
      stdin: Buffer.from("abc"),
    })

    expect(await exchange(endpoint, request)).toEqual({
      kind: "e",
      exitCode: 1,
      message: "The CLI request included more stdin than declared\n",
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects a half-closed stdin stream shorter than declared and removes its spool", async () => {
    const handler = vi.fn()
    server = await startCliServer(runtimeDirectory, handler)
    const request = encodeRequest({
      cwd: runtimeDirectory,
      declaredStdinLength: 5n,
      stdin: Buffer.from("ab"),
    })

    expect(await exchange(endpoint, request)).toEqual({
      kind: "e",
      exitCode: 1,
      message: "The CLI request is incomplete\n",
    })
    expect(handler).not.toHaveBeenCalled()
    await expect(readdir(runtimeDirectory)).resolves.toEqual([
      "isolated-cli.sock",
    ])
  })

  it("drains a large framed stdin before reporting a spool failure", async () => {
    const handler = vi.fn()
    server = await startCliServer(
      path.join(runtimeDirectory, "missing-temp-directory"),
      handler
    )
    const stdin = Buffer.alloc(2 * 1_048_576, 0x61)

    const response = await exchange(
      endpoint,
      encodeRequest({ cwd: runtimeDirectory, stdin }),
      { halfClose: false }
    )

    expect(response.kind).toBe("e")
    expect(response.exitCode).toBe(1)
    expect(response.message).toMatch(/ENOENT|no such file or directory/i)
    expect(handler).not.toHaveBeenCalled()
  })

  it("terminates a stalled failure-drain socket when the server closes", async () => {
    const handler = vi.fn()
    server = await startCliServer(
      path.join(runtimeDirectory, "missing-temp-directory"),
      handler
    )
    const socket = net.createConnection(endpoint)
    socket.on("error", () => undefined)
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    const closed = new Promise<void>((resolve) => socket.once("close", resolve))
    socket.write(
      encodeRequest({
        cwd: runtimeDirectory,
        declaredStdinLength: 5n,
        stdin: Buffer.from("a"),
      })
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    await server.close()
    server = null
    await closed

    expect(handler).not.toHaveBeenCalled()
  })

  it("removes an incomplete stdin spool when the server closes", async () => {
    const handler = vi.fn()
    server = await startCliServer(runtimeDirectory, handler)
    const socket = net.createConnection(endpoint)
    socket.on("error", () => undefined)
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    const closed = new Promise<void>((resolve) => socket.once("close", resolve))
    socket.write(
      encodeRequest({
        cwd: runtimeDirectory,
        declaredStdinLength: 5n,
        stdin: Buffer.from("a"),
      })
    )
    await expect
      .poll(async () => (await readdir(runtimeDirectory)).length)
      .toBe(2)

    await server.close()
    server = null
    await closed

    expect(handler).not.toHaveBeenCalled()
    await expect(readdir(runtimeDirectory)).resolves.toEqual([])
  })
})
