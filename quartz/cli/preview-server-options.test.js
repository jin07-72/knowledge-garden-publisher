import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { bindPreviewServers } from "./preview-server-options.js"

function binding(environment) {
  const listenCalls = []
  const webSocketOptions = []
  const server = {
    listen(...args) {
      listenCalls.push(args)
    },
  }
  class FakeWebSocketServer {
    constructor(options) {
      webSocketOptions.push(options)
    }
  }

  bindPreviewServers(server, FakeWebSocketServer, 43120, 43121, environment)
  return { listenCalls, webSocketOptions }
}

describe("bindPreviewServers", () => {
  test("preserves baseline bindings when the integration variable is absent", () => {
    assert.deepEqual(binding({}), {
      listenCalls: [[43120]],
      webSocketOptions: [{ port: 43121 }],
    })
  })

  test("preserves baseline bindings for a nonmatching integration value", () => {
    assert.deepEqual(binding({ QUARTZ_PREVIEW_LOOPBACK: "0.0.0.0" }), {
      listenCalls: [[43120]],
      webSocketOptions: [{ port: 43121 }],
    })
  })

  test("binds both preview servers to IPv4 loopback for the exact integration value", () => {
    assert.deepEqual(binding({ QUARTZ_PREVIEW_LOOPBACK: "127.0.0.1" }), {
      listenCalls: [[43120, "127.0.0.1"]],
      webSocketOptions: [{ port: 43121, host: "127.0.0.1" }],
    })
  })
})
