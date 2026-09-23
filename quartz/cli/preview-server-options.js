/**
 * Bind the two Quartz preview servers without opening real sockets in tests.
 * The desktop-only environment value is deliberately exact-match and all
 * other callers retain Quartz's original host-unspecified behavior.
 */
export function bindPreviewServers(
  server,
  WebSocketServerConstructor,
  httpPort,
  webSocketPort,
  environment = process.env,
) {
  const host = environment.QUARTZ_PREVIEW_LOOPBACK === "127.0.0.1" ? "127.0.0.1" : undefined
  if (host) {
    server.listen(httpPort, host)
    return new WebSocketServerConstructor({ port: webSocketPort, host })
  }

  server.listen(httpPort)
  return new WebSocketServerConstructor({ port: webSocketPort })
}
