# docs/LOGGING.md — logging (deliverable #12, PROTOCOL §12–§13)

`BridgeLog` (`src/VesktopBridge.Core/BridgeLog.cs`): level `info` default,
`debug` opt-in via settings (`BridgeLog.Level`, live-switchable).

- Allowed at info: server started/stopped (+actual port), client
  connected/disconnected (sid-8 only), auth success/failure (no secret),
  command failed (cmd + code), unsupported capability, protocol error (code
  only), reconnect attempt (# + delay), missing internal module (name only).
- Forbidden always: token (even partial), full sid, Discord tokens/cookies/
  credentials, message/DM content, full channel/device/user dumps (debug-only
  and truncated to ≤10 entries).
- Sanitizers: `BridgeLog.Sid8()`, `BridgeLog.Trunc()`, `Transition()` (one
  info line per state change, repeats swallowed — §9.2/§13).
- The interop test captures every log line and asserts the token and the full
  session id never appear.
