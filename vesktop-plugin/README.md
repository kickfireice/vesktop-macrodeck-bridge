# Vesktop Macro Deck Bridge (client) — protocol v1.0.0

Vencord/Vesktop plugin that connects to the **Macro Deck bridge** (`127.0.0.1:8323`),
authenticates with a local token, receives commands, controls Discord via internal
stores/actions (never UI clicking), and pushes live state updates. The shared
contract is [`PROTOCOL.md`](./PROTOCOL.md) — the single source of truth
(identical copy in `macrodeck-plugin/PROTOCOL.md`).

> Local-only. No cloud, no telemetry, no remote control. Token only ever goes
> client → server inside `hello` on localhost, and is never logged.

## 1. File layout

```
vesktop-plugin/
  PROTOCOL.md            # shared contract (DO NOT fork)
  README.md              # this file (setup + designs)
  TESTPLAN.md            # build verification + mock-bridge test plan
  package.json           # scripts: typecheck / build / mock-bridge / mock-bridge:test
  tsconfig.json
  src/
    protocol.ts          # §1–§8: envelope, State type, flags, commands, validation
    errors.ts            # §10 codes + command_result builder + volume clamps
    logger.ts            # §13 sanitized logging (redacts token/sid/secrets)
    settings.ts          # settings defaults + host/port sanitize + backoff ladder
    socket.ts            # §2/§9/§11 WS client: hello→welcome, heartbeat, reconnect
    state.ts             # §7/§9 snapshot + FluxDispatcher subscriptions + debounce
    commands.ts          # §6 command dispatch (every normative command)
    capabilities.ts      # §8 capability report + command→flag map
    index.ts             # Vencord plugin entry (start/stop, wiring, status)
    adapters/
      discovery.ts       # safe webpack discovery (cached, warn-once, never throws)
      voice.ts           # mute/deafen/join/leave/move
      channel.ts         # guild/channel lists, resolve by id/name/path, text select
      status.ts          # presence + custom status
      volume.ts          # input/output/per-user/attenuation volumes
      device.ts          # input/output device select/cycle/refresh
      audioProc.ts       # NS/EC/AGC/QoS/low-latency/speaker/attenuation
      stage.ts           # raise hand / request-to-speak (best-effort)
  mock-bridge/
    mockBridge.js        # mock Macro Deck SERVER for local protocol testing
```

## 2. Setup

1. Install Macro Deck plugin (server) — it binds `127.0.0.1:8323` and shows a
   generated token in its settings (behind Show/Copy + Regenerate).
2. Copy that token into this plugin's settings → **Token** field.
3. Enable this plugin. It auto-connects (`hello` first, stores `sid` from
   `welcome`, sends `capability_update` + full `state_snapshot`, then heartbeats
   every `heartbeatIntervalMs`, default 5 s).
4. Mismatch? Check settings panel: connection status, capabilities
   (true/false lists), last error (`AUTH_FAILED` = wrong token, `ALREADY_CONNECTED`
   = another client holds the session, `VERSION_MISMATCH` = protocol drift).

### Settings reference

| Key | Default | Notes |
|---|---|---|
| enable | true | auto-connect when on |
| host | `127.0.0.1` | localhost only (v1); other values fall back to `127.0.0.1` |
| port | `8323` | must match server's actual bound port |
| token | `""` | secret — never logged, only sent inside `hello` |
| readOnly | false | local mirror (server authoritative); mutating commands → `READ_ONLY` |
| debugLogging | false | verbose logs (secrets still never logged) |
| reconnectBaseMs | 1000 | informational; ladder is fixed 1s→2s→5s→10s→30s + ±20% jitter |

## 3. Protocol implementation (matches PROTOCOL.md)

- `src/protocol.ts`: `PROTOCOL_VERSION="1.0.0"`, envelope builder/validator
  (JSON → 64 KB → required fields → known type → schema → sid check),
  full `State` type (§7, `null` where unknown), `CAPABILITY_FLAGS` (§8 exact
  strings), `COMMANDS` (§6 exact names), `READONLY_SAFE_COMMANDS`.
- Handshake order (`socket.ts`): connect → `hello` (first msg, ≤5 s) →
  `welcome{sid, heartbeatIntervalMs, requestSnapshot}` → store `sid` →
  `capability_update` + `state_snapshot` (with `sid`, no token replay) →
  steady-state heartbeats/commands. Bad token → server `AUTH_FAILED` + close
  `4401`; version drift → `VERSION_MISMATCH` + close `4400`.
- `sid` logged first-8-chars only; token never logged (see `logger.ts`).

## 4. Settings design — see `src/settings.ts` + `src/index.ts`

Vencord `definePlugin`-compatible descriptor + plain-defaults fallback so logic
and tests run without the Vencord runtime. Host/port sanitized; token kept in
the host settings store (OS user permissions). Runtime status
(`getRuntimeStatus()`): connected/authenticated/discordReady/session-short/
lastError/capabilities-true/false/reconnect-attempt — rendered in settings.

## 5. WS client design — `src/socket.ts`

Native `WebSocket` in the Vesktop renderer (injectable factory for tests).
Sends `hello` on open; validates every inbound (`validateInbound`); routes
`welcome/command/get_state/request_*/heartbeat_request/error`; ACKs **every**
command exactly once via `command_result` (`replyTo` = command `id`) with
3 s (simple) / 10 s (voice) timeout awareness; outbound size-checked (64 KB);
queue guard 32 pending → `RATE_LIMITED`. Heartbeat push on server interval;
2 s watchdog → 15 s silence triggers reconnect.

## 6. Reconnect design — `src/socket.ts` + `src/settings.ts`

Backoff ladder `1s→2s→5s→10s→30s max`, `±20%` jitter, no tight loops
(`scheduleConnect`, parked when disabled). Attempt counter resets on `welcome`.
After every (re)connect: full resync (`capability_update` + `state_snapshot` +
`channel_list_update` + `device_list_update`, `seq` reset). Transitions logged
at info, retries at debug after the first; heartbeat-timeout coalesced.

## 7. Adapter design — `src/adapters/`

Each adapter: **safe discovery** (`discovery.ts`: cached `findByProps` probes
with multiple candidate prop-sets, warn-once `missing internal module: <name>`,
never throws) → availability report (flag + ≤80-char reason) → guarded actions
returning `{ok} | {ok:false, code, message}`. No fragile hardcodes: every store
access is `try/catch` with null-fallback; repeated scans cached.

| Adapter | Covers | Key probes |
|---|---|---|
| voice | mute/deafen/join/leave/move | MediaEngine (`toggleSelfMute`), VoiceActions (`selectVoiceChannel`) |
| channel | lists, resolve id/name/path, text select, ack-read | ChannelStore, GuildStore, ChannelSelectActions |
| status | presence, custom status | PresenceActions, PresenceStore, CustomStatus |
| volume | in/out 0–100, per-user 0–200, local mute | MediaEngine volumes, UserVolumeStore |
| device | device lists, select by id/name, cycle, refresh | MediaDeviceStore |
| audioProc | NS/EC/AGC/QoS/LL/attenuation; speakerMute=false | VoiceSettings |
| stage | hand/speak (best-effort) | StageActions/Store |

## 8. State subscription design — `src/state.ts`

`subscribeAll()` hooks `FluxDispatcher` events (`SELF_MUTE_UPDATE`,
`VOICE_STATE_UPDATES`, `CHANNEL_SELECT`, `PRESENCE_UPDATES`, …) with per-build
name tolerance — missing events skipped silently. **No polling.** Debounce
150 ms (within the 100–250 ms window) for coalescable changes (volumes);
**immediate** for mute/deafen/join/leave/select/auth. `seq` starts at 1 per
connection; Macro Deck ignores out-of-order `seq`. Snapshot builder covers
**all** §7 fields (booleans strict `true/false/null`, volumes numeric).

Channel/device lists use IDs + `path` (`"Guild / Category / Channel"`).

## 9. Command handler — `src/commands.ts`

`handleCommand(cmd, args, ctx)`: unknown → `UNKNOWN_COMMAND`; readOnly
mutating → `READ_ONLY`; capability-missing → `UNSUPPORTED`; Discord-not-ready
→ `DISCORD_NOT_READY`; arg validation → `SCHEMA_INVALID`; volume clamps
(io 0–100, user 0–200, attenuation 0–100); ambiguous name/path → `AMBIGUOUS` +
candidates (max 10); not found → `NOT_FOUND`; voice failures → `VOICE_ERROR` /
`CHANNEL_FULL` / `PERMISSION_DENIED`. Never throws — guarded catch →
`INTERNAL_ERROR`.

## 10. Capability reporting — `src/capabilities.ts`

`buildCapabilities()` merges per-adapter availability into the 29 normative
flags + `unavailableReasons` (codes or ≤80-char reasons). `COMMAND_FLAG` maps
each command → required flag (`null` = always allowed: the four getters).
`get_capabilities` also echoes the report inside `command_result.extra`.

## 11. Error handling — `src/errors.ts` + handlers

Standard codes (§10) used verbatim. Full-channel → `CHANNEL_FULL`,
permissions → `PERMISSION_DENIED`, timeouts noted (3 s/10 s), missing module →
flag `false` + `INTERNAL_ERROR: <module>` + commands → `UNSUPPORTED`,
malformed/oversized → `protocol_error` + drop. Never crashes Vesktop: every
adapter/handler/socket callback is guarded.

## 12. Logging — `src/logger.ts`

Default `info`, opt-in `debug`. Allowed at info: connects/disconnects, auth
result (no secret), command failures (cmd + code), unsupported caps, protocol
error codes, reconnect attempts, missing modules (name only). **Forbidden
always:** token, full `sid`, Discord tokens/cookies, message/DM content, full
list dumps (debug-only, truncated ≤10). Repeats coalesced (one info per
transition, rest debug).

## 13. Build instructions

```sh
cd vesktop-plugin
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
```

Copy `src/` (or `dist/`) into your Vesktop/Vencord plugin folder as plugin
`macro-deck-bridge`, reload Vesktop (`Ctrl+R`), set host/port/token, enable.

## 14. Test plan — see [`TESTPLAN.md`](./TESTPLAN.md)

Unit (protocol/validation/caps/commands) + integration (mock bridge handshake,
snapshot, commands incl. error codes, reconnect/resync, heartbeat timeout).

## 15. Mock bridge test plan — see [`TESTPLAN.md`](./TESTPLAN.md) + `mock-bridge/`

```sh
npm run mock-bridge            # interactive CLI (send commands to the plugin)
npm run mock-bridge:test       # automated: handshake→snapshot→caps→sample commands
```

## Appendix — Vencord/Vesktop API limitations & unknowns

See [`TESTPLAN.md` §API unknowns](./TESTPLAN.md#api-unknowns). Every unknown
has a safe stub marking the feature `unsupported` until confirmed in a real
Discord build — capability flags stay `false`, commands answer `UNSUPPORTED`.
