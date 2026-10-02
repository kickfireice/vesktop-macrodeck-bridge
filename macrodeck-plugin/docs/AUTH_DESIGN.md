# docs/AUTH_DESIGN.md — authentication design (deliverable #8, PROTOCOL §2–§3)

## Token (`AuthManager`)

- Generation: 32 bytes from `RandomNumberGenerator` → base64url, no padding
  (≥43 chars → ≥256 bits, §2.1). `AuthManager.GenerateToken()`.
- Storage: `%AppData%/DeckBridge/settings.json`, OS user permissions only.
  Generated on first start; shown in settings behind a Show toggle (host
  config-flow seam), copyable, regeneratable.
- Comparison: `CryptographicOperations.FixedTimeEquals` (cheap, correct).
- **Never logged** — not even partially. Interop test asserts no log line
  contains the token.

## Handshake (`BridgeServer.HandleHelloAsync`, normative §2.2)

1. First message must be `hello` (else close).
2. Auth-block check → token check → `AUTH_FAILED` + close 4401 on mismatch
   (no token echo; logs only `auth failure from 127.0.0.1 at <time>`).
3. Version check happens earlier in `TryParse`: unsupported `v` →
   `VERSION_MISMATCH` with `payload.supported: ["1.0.0"]`, close 4400.
   (Payload includes `code`+`message` per §10 — a bug here was caught by tests.)
4. Single-client policy (`SessionManager`): second `hello` while one session
   is active → `ALREADY_CONNECTED` + close 4409 — unless `allowReplacement`
   (default false) is on, in which case the old socket gets `SESSION_REPLACED`
   and is closed before the new `welcome` is sent.
5. Success → `welcome {sessionId==sid, heartbeatIntervalMs:5000,
   requestSnapshot:true, readOnly}` with `replyTo` = hello id. `sid` is
   UUIDv4 (`Guid.NewGuid("N")`), logged first-8-chars only (asserted by test).

## Sessions

- Token re-auth on **every** new WS connection; token regeneration =
  settings rewrite + server restart (all sessions invalidated, §2.1).
- Server tracks `clientName/clientVersion/connectedAt/lastSeen/capabilities`;
  `Touch()` on every validated message; `sid` required on all post-hello
  messages, mismatch → close.
- `allowReplacement` and `readOnly` are live-settable (no restart needed for
  the flags themselves; token regen restarts the listener by design).
