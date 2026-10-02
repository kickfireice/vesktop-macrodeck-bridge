# docs/WS_SERVER_DESIGN.md — WebSocket server design (deliverable #7)

## Choice: HttpListener + System.Net.WebSockets (BCL only)

The bridge server lives **inside the plugin process** (`VesktopBridge.Plugin.exe`,
an out-of-process Macro Deck 3 plugin) and is owned by `BridgeService`
(start in `InitializeAsync`, stop in `ShutdownAsync`).

- Transport: `HttpListener` with prefix `http://127.0.0.1:{port}/ws/` +
  `AcceptWebSocketAsync`. No ASP.NET Core routing is used for the bridge, so
  there is **zero conflict** with the SDK's reserved `/_macrodeck/*` routes
  (mapping one of those fails plugin startup — we never touch them).
- Zero external dependencies: `VesktopBridge.Core` is BCL-only
  (`System.Net`, `System.Net.WebSockets`, `System.Text.Json`) so it builds
  offline and adds no load to the Macro Deck host.

## Bind rules (PROTOCOL §1)

- `HttpListener` prefix is hardcoded to `127.0.0.1` — never `0.0.0.0`/`+`.
- Defense in depth: `HandleHttpAsync` rejects any non-loopback
  `RemoteEndPoint` with 403 (unreachable in practice, cheap insurance).
- Port: `ConfiguredPort` (default 8323); `FindFreePort` probes with a
  loopback `TcpListener` and walks up max +100. `ActualPort` is exposed via
  settings/variables/status so the user always sees the real port.
- One text message = one JSON envelope; binary frames ignored; max **64 KB**
  UTF-8 — oversize is drained then answered `TOO_LARGE` (§1, §4).

## Connection lifecycle

- Accept loop is fire-and-forget per connection (`HandleHttpAsync` → `ClientConnection.RunAsync`); all async, never blocks any UI thread.
- `hello` must arrive within 5 s, else close. After auth, **any** message
  resets the 15 s heartbeat watchdog (§9.2); timeout → one `Transition` log,
  mark offline, keep last-known state.
- `OnConnectionLost` is scoped: only the **active authenticated session**
  flips global liveness / fails pending commands. Failed handshakes (bad
  token, duplicate, version mismatch) close with `Sid == null` and leave the
  healthy session untouched (regression-tested).
- The receive pump wraps `OnMessageAsync` in try/catch: a poison message
  yields `INTERNAL_ERROR`, never a dropped healthy session (§11).

## Validation order (§4, in `EnvelopeCodec.TryParse` + `OnMessageAsync`)

valid JSON → size ≤64 KB → required fields → supported `v` → known `type` →
per-type schema → hello-first → session check → rate limit. First failure →
`error` (authenticated) or silent close (unauthenticated), except `AUTH_FAILED`
and `VERSION_MISMATCH` which answer before closing with 4401/4400.

## Rate limits (§11)

- Inbound: token-bucket 20 msg/s sustained, burst 50 per listener
  (`MessageRateLimiter`); excess → `RATE_LIMITED` + drop; >20 consecutive
  excesses → close 4408.
- Outbound commands: max 32 pending (`PendingCommandStore`); beyond →
  `RATE_LIMITED` locally. Timeouts 3 s (10 s voice join/move, §6.1); late
  `command_result`s are ignored by `replyTo`.
- Auth: 5 fails / 60 s → refuse new TCP accepts (429) for 60 s (§2.3).
