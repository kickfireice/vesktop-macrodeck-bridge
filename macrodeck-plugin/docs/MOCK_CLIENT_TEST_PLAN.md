# docs/MOCK_CLIENT_TEST_PLAN.md — mock client test plan (deliverable #15)

`tests/mock-client/` (zero deps): `mockVesktopClient.js` (full Vesktop-side
contract), `fakeMacroDeckServer.js` (minimal RFC6455 server for self-test —
note: use WebSocket GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, verified by
interop against .NET strict client + reference server), `runProtocolTests.js`.

- `node runProtocolTests.js` — 12 checks, no C# needed (fake server).
- `node mockVesktopClient.js --port 8323 --token <secret>` — manual peer for
  the real Macro Deck plugin (or C# `BridgeServer`); token via env
  `BRIDGE_TOKEN` also accepted, never committed.
- The mock answers all 74 protocol commands, pushes debounced `state_update`s,
  serves twin-`General` voice channels (ambiguity path), honestly reports
  stage as unsupported, and reconnects with 1→2→5→10→30 s ±20 % backoff.
- For the Vesktop-plugin agent: mirror `mockVesktopClient.js#onCommand` per
  command (real Discord calls replace the scripted `set()`), keep the
  envelope/heartbeat/resync/backoff code as-is — it is already §15-conformant
  per the test run.

