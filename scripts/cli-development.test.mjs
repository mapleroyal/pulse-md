import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import path from "node:path"
import { test } from "node:test"

import {
  developmentCliEnvironment,
  developmentEndpoint,
  endpointIsReady,
} from "./cli-development-support.mjs"
import {
  developmentCheckoutIdentity,
  developmentServerPort,
} from "./development-checkout-identity.mjs"
import {
  developmentElectronEnvironment,
  developmentViteArguments,
} from "./run-development.mjs"

const CHECKOUT_ROOT =
  process.platform === "win32"
    ? "C:\\workspace\\pulse-md"
    : "/workspace/pulse-md"
const CHECKOUT_LINK =
  process.platform === "win32"
    ? "C:\\workspace\\pulse-md-link"
    : "/workspace/pulse-md-link"
const FORK_ROOT =
  process.platform === "win32"
    ? "C:\\workspace\\pulse-md-fork"
    : "/workspace/pulse-md-fork"
const EXPECTED_CHECKOUT_HASH =
  process.platform === "win32" ? "eb48ab84dd2a" : "7315cb110cb8"
const EXPECTED_SERVER_PORT = process.platform === "win32" ? 28_260 : 28_081

const CHECKOUT = developmentCheckoutIdentity(CHECKOUT_ROOT, {
  realpath: (value) => value,
})

test("development identity is deterministic and canonical-checkout scoped", () => {
  assert.deepEqual(CHECKOUT, {
    checkoutHash: EXPECTED_CHECKOUT_HASH,
    checkoutRoot: path.resolve(CHECKOUT_ROOT),
    cliIdentity: `pulse-md-development-${EXPECTED_CHECKOUT_HASH}`,
    userDataDirectoryName: `Pulse MD Development-${EXPECTED_CHECKOUT_HASH}`,
  })
  assert.deepEqual(
    developmentCheckoutIdentity(CHECKOUT_LINK, {
      realpath: () => CHECKOUT_ROOT,
    }),
    CHECKOUT
  )
  assert.notEqual(
    developmentCheckoutIdentity(FORK_ROOT, {
      realpath: (value) => value,
    }).checkoutHash,
    CHECKOUT.checkoutHash
  )
  assert.equal(
    developmentServerPort(CHECKOUT.checkoutHash),
    EXPECTED_SERVER_PORT
  )
  assert.notEqual(
    developmentServerPort(
      developmentCheckoutIdentity(FORK_ROOT, {
        realpath: (value) => value,
      }).checkoutHash
    ),
    developmentServerPort(CHECKOUT.checkoutHash)
  )
})

test("development CLI replaces an inherited endpoint without mutating its source", () => {
  const source = {
    APPDATA: "C:\\Users\\example\\AppData\\Roaming",
    PMD_APP_EXECUTABLE: "/tmp/foreign-app",
    PMD_CLI_ENDPOINT: "/tmp/foreign.sock",
    PATH: "/usr/bin",
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
  }
  const endpoint = "/tmp/pulse-md-development-checkout/cli-v3.sock"
  const environment = developmentCliEnvironment(source, endpoint)

  assert.equal(environment.PMD_CLI_ENDPOINT, endpoint)
  assert.equal(environment.PMD_APP_EXECUTABLE, undefined)
  assert.equal(environment.PATH, source.PATH)
  assert.equal(environment.VITE_DEV_SERVER_URL, undefined)
  assert.equal(source.PMD_APP_EXECUTABLE, "/tmp/foreign-app")
  assert.equal(source.PMD_CLI_ENDPOINT, "/tmp/foreign.sock")
  assert.equal(source.VITE_DEV_SERVER_URL, "http://127.0.0.1:5173")
})

test("development CLI derives only its isolated default endpoints", () => {
  assert.equal(
    developmentEndpoint({
      cliIdentity: CHECKOUT.cliIdentity,
      environment: { PMD_CLI_ENDPOINT: "/tmp/foreign.sock" },
      getUserId: () => 501,
      platform: "darwin",
    }),
    path.join("/tmp", `${CHECKOUT.cliIdentity}-501`, "cli-v3.sock")
  )
  assert.match(
    developmentEndpoint({
      cliIdentity: CHECKOUT.cliIdentity,
      environment: { APPDATA: "C:\\Users\\example\\AppData\\Roaming" },
      platform: "win32",
    }),
    new RegExp(
      `^\\\\\\\\\\.\\\\pipe\\\\${CHECKOUT.cliIdentity}-[0-9a-f]{16}-cli-v3$`,
      "u"
    )
  )
})

test("development endpoints reject an unscoped identity", () => {
  assert.throws(
    () =>
      developmentEndpoint({
        cliIdentity: "pulse-md-development",
        getUserId: () => 501,
        platform: "linux",
      }),
    /checkout-scoped/u
  )
})

test("development Vite startup owns its checkout port or fails closed", () => {
  const arguments_ = developmentViteArguments({
    executable: "/workspace/node_modules/vite/bin/vite.js",
    host: "127.0.0.1",
    port: developmentServerPort(CHECKOUT.checkoutHash),
  })
  assert.deepEqual(arguments_, [
    "/workspace/node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(EXPECTED_SERVER_PORT),
    "--strictPort",
    "--clearScreen",
    "false",
  ])

  const endpoint = developmentEndpoint({
    cliIdentity: CHECKOUT.cliIdentity,
    environment: {},
    getUserId: () => 501,
    platform: "linux",
  })
  const sanitizedEnvironment = developmentCliEnvironment(
    {
      PMD_APP_EXECUTABLE: "/tmp/foreign-app",
      PMD_CLI_ENDPOINT: "/tmp/foreign.sock",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
    endpoint
  )
  const electronEnvironment = developmentElectronEnvironment(
    sanitizedEnvironment,
    `http://127.0.0.1:${EXPECTED_SERVER_PORT}`
  )
  assert.equal(electronEnvironment.PMD_CLI_ENDPOINT, endpoint)
  assert.equal(electronEnvironment.PMD_APP_EXECUTABLE, undefined)
  assert.equal(
    electronEnvironment.VITE_DEV_SERVER_URL,
    `http://127.0.0.1:${EXPECTED_SERVER_PORT}`
  )
})

test("development endpoint probes stop at their connection timeout", async () => {
  const socket = new EventEmitter()
  let destroyed = false
  socket.destroy = () => {
    destroyed = true
  }

  const started = Date.now()
  const ready = await endpointIsReady("ignored", {
    connect: () => socket,
    timeoutMs: 20,
  })
  const elapsed = Date.now() - started

  assert.equal(ready, false)
  assert.equal(destroyed, true)
  assert.ok(elapsed >= 10, `probe returned too early after ${elapsed}ms`)
  assert.ok(elapsed < 500, `probe exceeded its bound after ${elapsed}ms`)
})

test("development endpoint probes recognize a connected service", async () => {
  const socket = new EventEmitter()
  let destroyed = false
  socket.destroy = () => {
    destroyed = true
  }

  const readyPromise = endpointIsReady("ignored", {
    connect: () => socket,
    timeoutMs: 100,
  })
  setImmediate(() => socket.emit("connect"))

  assert.equal(await readyPromise, true)
  assert.equal(destroyed, true)
})
