# docs/ERROR_HANDLING.md — error handling (deliverable #11, PROTOCOL §10–§11)

All codes are the normative strings in `BridgeProtocol.Errors` (mirrors §10
exactly). No invented codes on the wire.

## Command flow (`CommandDispatcher.SendAsync`, async, never blocks UI)

`PreCheck` (local, no wire) → send `command {command, args}` with fresh id →
await `command_result` by `replyTo` (3 s; 10 s voice join/move) → apply
`statePatch` → feedback. Every path returns a `CommandOutcome`:

| Situation | Code | Where decided |
|---|---|---|
| Vesktop offline | `NOT_CONNECTED` (local-only) | PreCheck |
| Capability flag false | `UNSUPPORTED` (+ `toggle_mute_and_deafen` also needs `deafen`) | PreCheck |
| Server or client read-only (server setting authoritative, §6.2) | `READ_ONLY` (getters still allowed) | PreCheck |
| Pending queue >32 | `RATE_LIMITED` | local |
| Timeout | `TIMEOUT` (late result ignored by `replyTo`) | local |
| Unknown/unsupported/ambiguous/… | client's `command_result.error.code` verbatim | client |
| Missing required param | SDK `InvalidParameter` before send | action |

`OutcomeMap` translates to `ActionResult.Failed` with the closest
`ActionErrorCodes` member — **never a silent success** (`ActionResult.Failed`
carries the protocol code in the user-visible message).

## Wire errors

`error {code, message, command?, details?}` — never tokens, full sids,
Discord tokens/cookies, or message content. `unavailableReasons` ≤80 chars.

## Reliability (§11 — must survive everything)

- Macro Deck / Vesktop restart, plugin disabled, Discord not ready, wrong
  token/port, port conflict (fallback + display), WS drop, malformed/oversized
  message, unknown command, missing internal module (→ flag false +
  `INTERNAL_ERROR` reason, one warn then debug), rate limits, command timeout,
  duplicate connections — all covered by smoke + interop tests.
- Reconnect uses client-side backoff 1→2→5→10→30 s ±20 % (mock implements;
  real Vesktop plugin must too). No tight loops, no log spam (one info line
  per transition, repeats coalesced).
- Resync rule: snapshot + capabilities + lists after every (re)connect
  (`Request Full Resync` action does all four explicitly).
