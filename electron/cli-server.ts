import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises"
import net, { type Server, type Socket } from "node:net"
import path from "node:path"

import type { CliIdentity } from "./distribution-identity"

export const CLI_PROTOCOL_VERSION = 3

const REQUEST_MAGIC = Buffer.from("PMDCLI3\0", "ascii")
const REQUEST_HEADER_BYTES =
  REQUEST_MAGIC.length + 4 + 4 + 4 + 1 + 8 + 1 + 4 * 4
const MAX_ARGUMENT_COUNT = 4_096
const MAX_ARGUMENT_BYTES = 1_048_576
const MAX_CWD_BYTES = 32_768
const MAX_METADATA_BYTES = 8 * 1_048_576

export interface CliRawRequest {
  activeWindowBounds: CliActiveWindowBounds | null
  argv: string[]
  cwd: string
  responder: CliResponder
  stdinPath: string | null
}

export interface CliActiveWindowBounds {
  height: number
  width: number
  x: number
  y: number
}

export type CliRequestHandler = (request: CliRawRequest) => Promise<void> | void

export interface CliServer {
  close(): Promise<void>
  endpoint: string
}

type ResponseKind = "a" | "c" | "d" | "e" | "o" | "w"

const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_64_PRIME = 0x100000001b3n
const UINT64_MASK = 0xffffffffffffffffn

/**
 * Returns the same FNV-1a digest as the native Windows helper. Hashing the
 * UTF-16 code units byte-by-byte avoids locale-dependent username/path
 * normalization while still giving each Windows profile a compact pipe name.
 */
export function windowsCliIdentityHash(value: string): string {
  let hash = FNV_64_OFFSET_BASIS
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    hash ^= BigInt(codeUnit & 0xff)
    hash = (hash * FNV_64_PRIME) & UINT64_MASK
    hash ^= BigInt(codeUnit >>> 8)
    hash = (hash * FNV_64_PRIME) & UINT64_MASK
  }
  return hash.toString(16).padStart(16, "0")
}

function windowsCliIdentitySeed(): string {
  return (
    process.env.APPDATA ||
    process.env.USERPROFILE ||
    [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\") ||
    "unknown-user"
  )
}

function responseFrame(
  kind: ResponseKind,
  exitCode: number,
  message: string
): Buffer {
  const payload = Buffer.from(message, "utf8")
  const header = Buffer.allocUnsafe(6)
  header.writeUInt8(kind.charCodeAt(0), 0)
  header.writeUInt8(Math.max(0, Math.min(255, exitCode)), 1)
  header.writeUInt32BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

export class CliResponder {
  readonly #socket: Socket
  #waiting = false
  #finished = false
  #disconnectListeners = new Set<() => void>()

  constructor(socket: Socket) {
    this.#socket = socket
    const disconnected = () => {
      if (this.#finished) return
      this.#finished = true
      for (const listener of this.#disconnectListeners) listener()
      this.#disconnectListeners.clear()
    }
    socket.once("close", disconnected)
    socket.once("error", disconnected)
  }

  get connected(): boolean {
    return !this.#finished && !this.#socket.destroyed
  }

  onDisconnect(listener: () => void): () => void {
    if (!this.connected) {
      listener()
      return () => undefined
    }
    this.#disconnectListeners.add(listener)
    return () => this.#disconnectListeners.delete(listener)
  }

  accepted(message = ""): void {
    this.#finish("a", 0, message)
  }

  waiting(message = ""): void {
    if (!this.connected || this.#waiting) return
    this.#waiting = true
    this.#socket.write(responseFrame("w", 0, message))
  }

  complete(message = ""): void {
    if (!this.#waiting) return
    this.#finish("d", 0, message)
  }

  fail(message: string, exitCode = 1): void {
    this.#finish("e", exitCode, message)
  }

  output(message: string): void {
    this.#finish("o", 0, message)
  }

  async outputChunks(chunks: AsyncIterable<string>): Promise<void> {
    if (!this.connected) return
    for await (const chunk of chunks) {
      if (!this.connected) return
      await this.#writeFrame("c", 0, chunk)
    }
    this.#finish("o", 0, "")
  }

  async #writeFrame(
    kind: ResponseKind,
    exitCode: number,
    message: string
  ): Promise<void> {
    if (!this.connected) throw new Error("The CLI connection is closed")
    if (this.#socket.write(responseFrame(kind, exitCode, message))) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.#socket.off("drain", drained)
        this.#socket.off("close", closed)
        this.#socket.off("error", failed)
      }
      const drained = () => {
        cleanup()
        resolve()
      }
      const closed = () => {
        cleanup()
        reject(new Error("The CLI connection closed during output"))
      }
      const failed = (error: Error) => {
        cleanup()
        reject(error)
      }
      this.#socket.once("drain", drained)
      this.#socket.once("close", closed)
      this.#socket.once("error", failed)
    })
  }

  #finish(kind: ResponseKind, exitCode: number, message: string): void {
    if (!this.connected) return
    this.#finished = true
    this.#disconnectListeners.clear()
    this.#socket.end(responseFrame(kind, exitCode, message))
  }
}

export function cliEndpointPath(cliIdentity: CliIdentity = "pulse-md"): string {
  const configuredEndpoint = process.env.PMD_CLI_ENDPOINT
  if (configuredEndpoint !== undefined) {
    if (configuredEndpoint.length === 0) {
      throw new Error("PMD_CLI_ENDPOINT cannot be empty")
    }
    if (process.platform === "win32") {
      if (!configuredEndpoint.startsWith("\\\\.\\pipe\\")) {
        throw new Error("PMD_CLI_ENDPOINT must name a local Windows pipe")
      }
    } else if (!path.isAbsolute(configuredEndpoint)) {
      throw new Error("PMD_CLI_ENDPOINT must be an absolute socket path")
    }
    return configuredEndpoint
  }
  if (process.platform === "win32") {
    const identity = windowsCliIdentityHash(windowsCliIdentitySeed())
    return `\\\\.\\pipe\\${cliIdentity}-${identity}-cli-v3`
  }
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error("The CLI endpoint requires a numeric user id")
  }
  return path.join("/tmp", `${cliIdentity}-${uid}`, "cli-v3.sock")
}

async function prepareEndpoint(endpoint: string): Promise<void> {
  if (process.platform === "win32") return
  const directory = path.dirname(endpoint)
  const uid = process.getuid!()
  await mkdir(directory, { mode: 0o700, recursive: true })
  const directoryStats = await lstat(directory)
  if (
    !directoryStats.isDirectory() ||
    directoryStats.uid !== uid ||
    (directoryStats.mode & 0o077) !== 0
  ) {
    throw new Error(`Refusing insecure CLI runtime directory ${directory}`)
  }
  await chmod(directory, 0o700)

  try {
    const socketStats = await lstat(endpoint)
    if (!socketStats.isSocket() || socketStats.uid !== uid) {
      throw new Error(`Refusing to replace insecure CLI endpoint ${endpoint}`)
    }
    const endpointIsLive = await new Promise<boolean>((resolve, reject) => {
      const probe = net.createConnection(endpoint)
      probe.setTimeout(500)
      probe.once("connect", () => {
        probe.destroy()
        resolve(true)
      })
      probe.once("timeout", () => {
        probe.destroy()
        resolve(true)
      })
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.destroy()
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
          resolve(false)
        } else {
          reject(error)
        }
      })
    })
    if (endpointIsLive) {
      throw new Error(`The CLI endpoint is already in use: ${endpoint}`)
    }
    await unlink(endpoint)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function removeEndpoint(endpoint: string): Promise<void> {
  if (process.platform === "win32") return
  await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

interface DecodedMetadata {
  activeWindowBounds: CliActiveWindowBounds | null
  argv: string[]
  bytesConsumed: number
  cwd: string
  hasStdin: boolean
  stdinLength: bigint
}

function decodeMetadata(buffer: Buffer): DecodedMetadata | null {
  if (buffer.length < REQUEST_HEADER_BYTES) return null
  if (!buffer.subarray(0, REQUEST_MAGIC.length).equals(REQUEST_MAGIC)) {
    throw new TypeError("The CLI request has an invalid protocol signature")
  }
  let offset = REQUEST_MAGIC.length
  const version = buffer.readUInt32BE(offset)
  offset += 4
  if (version !== CLI_PROTOCOL_VERSION) {
    throw new TypeError(
      `Unsupported CLI protocol version ${version}; expected ${CLI_PROTOCOL_VERSION}`
    )
  }
  const argumentCount = buffer.readUInt32BE(offset)
  offset += 4
  if (argumentCount > MAX_ARGUMENT_COUNT) {
    throw new TypeError("The CLI request has too many arguments")
  }
  const cwdLength = buffer.readUInt32BE(offset)
  offset += 4
  if (cwdLength === 0 || cwdLength > MAX_CWD_BYTES) {
    throw new TypeError("The CLI request has an invalid working directory")
  }
  const stdinFlag = buffer.readUInt8(offset)
  offset += 1
  if (stdinFlag !== 0 && stdinFlag !== 1) {
    throw new TypeError("The CLI request has an invalid stdin flag")
  }
  const stdinLength = buffer.readBigUInt64BE(offset)
  offset += 8
  if (stdinFlag === 0 && stdinLength !== 0n) {
    throw new TypeError("The CLI request declared stdin bytes without stdin")
  }
  const activeWindowFlag = buffer.readUInt8(offset)
  offset += 1
  if (activeWindowFlag !== 0 && activeWindowFlag !== 1) {
    throw new TypeError("The CLI request has an invalid active-window flag")
  }
  const activeWindowBounds: CliActiveWindowBounds = {
    x: buffer.readInt32BE(offset),
    y: buffer.readInt32BE(offset + 4),
    width: buffer.readInt32BE(offset + 8),
    height: buffer.readInt32BE(offset + 12),
  }
  offset += 16
  if (
    activeWindowFlag === 1 &&
    (activeWindowBounds.width <= 0 || activeWindowBounds.height <= 0)
  ) {
    throw new TypeError("The CLI request has invalid active-window bounds")
  }
  if (
    activeWindowFlag === 0 &&
    Object.values(activeWindowBounds).some((value) => value !== 0)
  ) {
    throw new TypeError(
      "The CLI request declared active-window bounds without an active window"
    )
  }
  if (buffer.length < offset + cwdLength) return null
  const cwd = buffer.toString("utf8", offset, offset + cwdLength)
  offset += cwdLength
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("The CLI working directory must be absolute")
  }

  const argv: string[] = []
  for (let index = 0; index < argumentCount; index += 1) {
    if (buffer.length < offset + 4) return null
    const argumentLength = buffer.readUInt32BE(offset)
    offset += 4
    if (argumentLength > MAX_ARGUMENT_BYTES) {
      throw new TypeError("A CLI argument is too long")
    }
    if (offset + argumentLength > MAX_METADATA_BYTES) {
      throw new TypeError("The CLI request metadata is too large")
    }
    if (buffer.length < offset + argumentLength) return null
    const argument = buffer.toString("utf8", offset, offset + argumentLength)
    if (argument.includes("\0")) {
      throw new TypeError("CLI arguments cannot contain null bytes")
    }
    argv.push(argument)
    offset += argumentLength
  }
  return {
    activeWindowBounds: activeWindowFlag === 1 ? activeWindowBounds : null,
    argv,
    bytesConsumed: offset,
    cwd,
    hasStdin: stdinFlag === 1,
    stdinLength,
  }
}

async function createStdinFile(tempDirectory: string): Promise<{
  filePath: string
  handle: Awaited<ReturnType<typeof open>>
}> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const filePath = path.join(
      tempDirectory,
      `.pmd-stdin-${process.pid}-${randomUUID()}`
    )
    try {
      return {
        filePath,
        handle: await open(filePath, "wx", 0o600),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  throw new Error("Unable to create a private stdin spool file")
}

async function receiveRequest(
  socket: Socket,
  tempDirectory: string,
  handler: CliRequestHandler,
  shutdownSignal: AbortSignal
): Promise<void> {
  let buffered = Buffer.alloc(0)
  let metadata: DecodedMetadata | null = null
  let stdinFilePath: string | null = null
  let stdinHandle: Awaited<ReturnType<typeof open>> | null = null
  let stdinBytesReceived = 0n
  let writeQueue: Promise<void> = Promise.resolve()
  let dispatchStarted = false
  let failed = false
  let drainingFailure: { cleanup: Promise<void>; message: string } | null = null

  const cleanupStdin = async () => {
    await stdinHandle?.close().catch(() => undefined)
    stdinHandle = null
    if (stdinFilePath) await unlink(stdinFilePath).catch(() => undefined)
  }

  const fail = (error: unknown, waitForWrites = true) => {
    if (failed || dispatchStarted) return
    failed = true
    const message = `${error instanceof Error ? error.message : String(error)}\n`
    if (
      !waitForWrites &&
      metadata?.hasStdin &&
      stdinBytesReceived < metadata.stdinLength
    ) {
      drainingFailure = { cleanup: cleanupStdin(), message }
      socket.resume()
      return
    }
    socket.pause()
    void (async () => {
      if (waitForWrites) await writeQueue.catch(() => undefined)
      await cleanupStdin()
      new CliResponder(socket).fail(message, 1)
    })()
  }

  const shutdown = () => {
    if (dispatchStarted) return
    failed = true
    const pendingCleanup = drainingFailure?.cleanup
    drainingFailure = null
    socket.pause()
    void (async () => {
      await writeQueue.catch(() => undefined)
      await pendingCleanup?.catch(() => undefined)
      // A queued write may have created the spool after shutdown began and
      // after an earlier failure cleanup observed no path.
      await cleanupStdin()
      socket.destroy()
    })()
  }
  shutdownSignal.addEventListener("abort", shutdown, { once: true })
  socket.once("close", () => {
    shutdownSignal.removeEventListener("abort", shutdown)
  })
  if (shutdownSignal.aborted) shutdown()

  const finishDrainingFailure = () => {
    const pending = drainingFailure
    if (!pending) return
    drainingFailure = null
    socket.pause()
    void pending.cleanup.then(() => {
      new CliResponder(socket).fail(pending.message, 1)
    })
  }

  const dispatch = () => {
    if (dispatchStarted || failed || !metadata) return
    dispatchStarted = true
    // A dispatched request has no more client payload. Keep reading so the
    // native helper's interruption marker can tear down an interactive wait;
    // an ordinary TCP half-close remains valid and can still receive output.
    socket.resume()
    void (async () => {
      try {
        await writeQueue
        await stdinHandle?.close()
        stdinHandle = null
        const responder = new CliResponder(socket)
        await handler({
          activeWindowBounds: metadata.activeWindowBounds,
          argv: metadata.argv,
          cwd: metadata.cwd,
          responder,
          stdinPath: stdinFilePath,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        new CliResponder(socket).fail(`${message}\n`, 1)
        await cleanupStdin()
      }
    })()
  }

  const queueStdinWrite = (data: Buffer) => {
    if (!metadata?.hasStdin) {
      throw new TypeError("The CLI request included unexpected stdin data")
    }
    const nextTotal = stdinBytesReceived + BigInt(data.length)
    if (nextTotal > metadata.stdinLength) {
      throw new TypeError("The CLI request included more stdin than declared")
    }
    stdinBytesReceived = nextTotal
    socket.pause()
    const operation = writeQueue.then(async () => {
      if (!stdinHandle) {
        const created = await createStdinFile(tempDirectory)
        stdinFilePath = created.filePath
        stdinHandle = created.handle
      }
      if (data.length > 0) await stdinHandle.write(data)
    })
    writeQueue = operation
    void operation.then(
      () => {
        if (failed) return
        if (stdinBytesReceived === metadata?.stdinLength) dispatch()
        else socket.resume()
      },
      (error: unknown) => fail(error, false)
    )
  }

  socket.on("data", (chunk) => {
    if (dispatchStarted) {
      socket.destroy()
      return
    }
    if (drainingFailure && metadata) {
      stdinBytesReceived += BigInt(chunk.length)
      if (stdinBytesReceived >= metadata.stdinLength) finishDrainingFailure()
      return
    }
    if (failed) return
    try {
      if (!metadata) {
        buffered = Buffer.concat([buffered, chunk])
        metadata = decodeMetadata(buffered)
        if (!metadata) {
          if (buffered.length > MAX_METADATA_BYTES) {
            throw new TypeError("The CLI request metadata is too large")
          }
          return
        }
        const remainder = buffered.subarray(metadata.bytesConsumed)
        buffered = Buffer.alloc(0)
        if (metadata.hasStdin) {
          queueStdinWrite(remainder)
        } else {
          if (remainder.length > 0) {
            throw new TypeError(
              "The CLI request included unexpected stdin data"
            )
          }
          dispatch()
        }
        return
      }
      queueStdinWrite(chunk)
    } catch (error) {
      fail(error)
    }
  })

  socket.once("end", () => {
    if (drainingFailure) {
      finishDrainingFailure()
      return
    }
    if (!dispatchStarted && !failed) {
      fail(new TypeError("The CLI request is incomplete"))
    }
  })

  socket.once("error", () => {
    if (drainingFailure) {
      const pending = drainingFailure
      drainingFailure = null
      void pending.cleanup
      return
    }
    if (!dispatchStarted && !failed) {
      fail(new Error("The CLI connection closed unexpectedly"))
    }
  })
}

export async function startCliServer(
  tempDirectory: string,
  handler: CliRequestHandler,
  cliIdentity: CliIdentity = "pulse-md"
): Promise<CliServer> {
  const endpoint = cliEndpointPath(cliIdentity)
  await prepareEndpoint(endpoint)
  const shutdownController = new AbortController()

  const server: Server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setNoDelay(true)
    void receiveRequest(
      socket,
      tempDirectory,
      handler,
      shutdownController.signal
    )
  })
  server.on("error", (error) => {
    console.error("CLI server error", error)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => {
      server.off("error", reject)
      resolve()
    })
  })
  if (process.platform !== "win32") await chmod(endpoint, 0o600)

  return {
    endpoint,
    close: async () => {
      shutdownController.abort()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await removeEndpoint(endpoint)
    },
  }
}
