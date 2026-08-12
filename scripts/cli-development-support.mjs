import net from "node:net"
import path from "node:path"

export const ENDPOINT_CONNECT_TIMEOUT_MS = 250

export function developmentCliEnvironment(environment, endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new TypeError("The development CLI endpoint must be provided")
  }
  const result = { ...environment }
  // Development entry points own their endpoint, launch target, and renderer
  // URL. Inherited overrides must not redirect one checkout into another app
  // or development server.
  delete result.PMD_CLI_ENDPOINT
  delete result.PMD_APP_EXECUTABLE
  delete result.VITE_DEV_SERVER_URL
  result.PMD_CLI_ENDPOINT = endpoint
  return result
}

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

export function developmentEndpoint({
  cliIdentity,
  environment = process.env,
  getUserId = () => process.getuid?.(),
  platform = process.platform,
} = {}) {
  if (
    typeof cliIdentity !== "string" ||
    !/^pulse-md-development-[0-9a-f]{12}$/u.test(cliIdentity)
  ) {
    throw new TypeError("The development CLI identity must be checkout-scoped")
  }
  if (platform === "win32") {
    const seed =
      environment.APPDATA ||
      environment.USERPROFILE ||
      [environment.USERDOMAIN, environment.USERNAME]
        .filter(Boolean)
        .join("\\") ||
      "unknown-user"
    return `\\\\.\\pipe\\${cliIdentity}-${windowsIdentityHash(seed)}-cli-v3`
  }
  const uid = getUserId()
  if (uid === undefined) {
    throw new Error("The development CLI requires a numeric user id")
  }
  return path.join("/tmp", `${cliIdentity}-${uid}`, "cli-v3.sock")
}

export async function endpointIsReady(
  endpoint,
  {
    connect = (target) => net.createConnection(target),
    timeoutMs = ENDPOINT_CONNECT_TIMEOUT_MS,
  } = {}
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("The endpoint connection timeout must be positive")
  }

  return new Promise((resolve) => {
    let socket
    let timer
    let settled = false

    const finish = (ready) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket?.destroy()
      resolve(ready)
    }
    const connected = () => finish(true)
    const failed = () => finish(false)

    try {
      socket = connect(endpoint)
      socket.once("connect", connected)
      socket.once("error", failed)
      timer = setTimeout(() => finish(false), timeoutMs)
    } catch {
      finish(false)
    }
  })
}
