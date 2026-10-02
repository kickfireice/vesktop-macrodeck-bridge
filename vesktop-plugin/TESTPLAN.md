# TESTPLAN — Vesktop Macro Deck Bridge (protocol v1.0.0)

## 0. Build verification

```sh
cd vesktop-plugin
npm install
npm run typecheck
npm run build
```

Expect: zero TS errors, `dist/` emitted. Any error → fix source, never fork `PROTOCOL.md`.

## 1. Unit tests (no Discord needed)

| # | Target | Procedure | Expect |
|---|---|---|---|
| U1 | `protocol.ts` envelope | build `hello`, `command`, `command_result`; `validateInbound` each | round-trips ok |
| U2 | oversize | 64 KB + 1 byte message via `validateInbound` | `TOO_LARGE` |
| U3 | bad version | `v:"9.9.9"` message | `VERSION_MISMATCH` |
| U4 | unknown type | `type:"teleport"` | `UNKNOWN_TYPE` |
| U5 | missing id | `command` without `id` | `SCHEMA_INVALID` |
| U6 | clock skew | `ts` ±61 s | `SCHEMA_INVALID` |
| U7 | volume clamp | `clampVolume("io",150)`, `("user",250)`, `("attenuation",-5)` | `100`, `200`, `0` |
| U8 | backoff | `backoffDelay(0..9)` sampled | ≈1s,2s,5s,10s,30s ±20% |
| U9 | sanitize | host `"0.0.0.0"` → ?, port `99999` → ? | `127.0.0.1`, `8323` |
| U10 | caps | `buildCapabilities()` with no Discord stores | all flags `false` + reasons, no throw |
| U11 | commands | `handleCommand("bogus")`, readOnly `toggle_mute`, no-cap `join_voice_by_id` | `UNKNOWN_COMMAND`, `READ_ONLY`, `UNSUPPORTED`/`DISCORD_NOT_READY` |
| U12 | logger | log object containing `{token:"x", sid:"abcdefgh-1234"}` | `[redacted]`, 8-char sid |

## 2. Mock-bridge integration (needs `ws`)

Terminal A — server:

```sh
npm run mock-bridge -- --token test-token-123
# expect: listening on 127.0.0.1:8323
```

Terminal B — plugin under test: point any WS client (or the real plugin with
token `test-token-123`) at `ws://127.0.0.1:8323`, or run the automated pass:

```sh
npm run mock-bridge:test
```

| # | Scenario | Steps | Expect (§15 checklist) |
|---|---|---|---|
| I1 | handshake | connect → hello → welcome | `welcome(sid, hb 5000, requestSnapshot:true)`; client sends `capability_update` + `state_snapshot` |
| I2 | bad token | hello with wrong token | `error AUTH_FAILED` + close `4401`, one-line log |
| I3 | snapshot shape | inspect `state_snapshot` | ALL §7 fields present (`null` where unknown), no message bodies/tokens |
| I4 | commands | `toggle_mute`, `get_capabilities`, `refresh_state`, `bogus_command_xyz` | one `command_result` each; last is `UNKNOWN_COMMAND` |
| I5 | heartbeat | wait 12 s idle | `heartbeat`s every ~5 s; no timeout |
| I6 | reconnect | kill mock bridge, restart it | client backoff 1s→2s…→ re-hello → fresh snapshot, no crash/spam/leak |
| I7 | Discord mute path | (real Vesktop) toggle mute in Discord UI | immediate `state_update` patch `{selfMuted}`, bridge cache refreshes |
| I8 | readOnly | set readOnly true, send `toggle_mute` + `refresh_state` | `READ_ONLY` vs ok |
| I9 | lists | `get_channel_list`, `get_device_list` | `channel_list_update` (paths `G / C / Ch`), `device_list_update` |

## 3. Manual Vesktop pass

1. Copy plugin into Vesktop plugins, reload, set token, enable → status shows
   connected + session short-id.
2. From mock-bridge CLI run: `toggle_mute {}`, `set_input_volume {"volume":80}`,
   `join_voice_by_name {"name":"General"}`, `cycle_status {}` — each returns one
   `command_result`; failures carry the right code (`UNSUPPORTED` on builds
   without that store, `DISCORD_NOT_READY` before login, `NOT_FOUND`/`AMBIGUOUS`
   for bad names).
3. Restart Vesktop mid-session → bridge shows disconnect → client re-hellos →
   snapshot resyncs; CPU idle ≈ 0 (no polling loops).

## 4. Interop checklist (PROTOCOL.md §15)

- [ ] Server binds `127.0.0.1:8323` (fallback + display), rejects bad JSON/size/type/auth.
- [ ] `hello`→`welcome(sid)`→`snapshot`→`heartbeat`; bad token → `AUTH_FAILED` + close + rate-limit.
- [ ] Every `command` → one `command_result` (`replyTo` match) in timeout; unknown/unsupported/readonly codes correct.
- [ ] Discord-UI mute toggle → immediate `state_update`; peer cache refreshes.
- [ ] Reconnect either side → backoff → re-hello → fresh snapshot, no crash/spam/leak.
- [ ] No non-loopback traffic; no polling hot loops; idle CPU ~0.

## <a id="api-unknowns"></a>5. API unknowns / assumptions (safe stubs)

Vencord/Vesktop internals are version-dependent and undocumented for this use.
The plugin was built against these **assumptions**, each guarded: if the probe
fails, the feature reports `unsupported` (`false` flag + `UNSUPPORTED`) instead
of crashing.

| # | Unknown | Assumption (candidate probes) | Stub behaviour until confirmed |
|---|---|---|---|
| A1 | plugin API version | `definePlugin({name, start, stop})` + numeric `SettingType` | index.ts uses plain def + numeric setting kinds; works even if helper renamed |
| A2 | WS client allowed? | renderer has global `WebSocket` (Chromium/Electron) | `socket.ts` factory throws `INTERNAL_ERROR` (no crash) if missing |
| A3 | settings storage | host settings store, token field `isPassword` | in-memory mirror (`memSettings`) so logic/tests run standalone |
| A4 | store: mute/deafen | `MediaEngine.toggleSelfMute/toggleSelfDeafen` | `voiceAvailability.mute/deafen=false`, cmds → `UNSUPPORTED` |
| A5 | store: voice join/leave | `VoiceActions.selectVoiceChannel` | `voiceJoin/Leave/Move=false`, join cmds → `UNSUPPORTED` |
| A6 | store: channels/guilds | `ChannelStore.getChannel/getAllChannels`, `GuildStore.getGuilds` | `channelList=false`, lists `[]`, resolve → `NOT_FOUND` |
| A7 | store: text select/ack | `ChannelSelectActions.selectChannel`, `ChannelAck.ackChannel` | `textChannelSelect/markChannelRead=false` |
| A8 | store: presence | `PresenceActions.updateStatus`, `PresenceStore.getStatus` | `status=false`, status cmds → `UNSUPPORTED`, snapshot `userStatus:"unknown"` |
| A9 | store: custom status | `CustomStatusActions.updateCustomStatus` | `customStatus=false` |
| A10 | store: volumes | `MediaEngine.get/setInputVolume`, `UserVolumeStore.setUserVolume` | volume flags `false`, snapshot `null` |
| A11 | store: devices | `MediaDeviceStore.getInputDevices/setInputDevice` | device flags `false`, lists empty |
| A12 | store: audio-proc | `VoiceSettings.setNoiseSuppression…` | NS/EC/AGC/QoS/LL/attenuation `false`/`null` |
| A13 | store: speaker mute | no known action | **always `false`** + `set_speaker_mute` → `UNSUPPORTED` by design |
| A14 | store: stage | `StageActions.raiseHand/requestToSpeak` | stage flags `false`, cmds → `UNSUPPORTED` |
| A15 | events | `FluxDispatcher` + `SELF_MUTE_UPDATE/VOICE_STATE_UPDATES/CHANNEL_SELECT/…` | `subscribeAll` warns once, degrades to snapshot-on-demand |
| A16 | ready signal | `UserStore.getCurrentUser()` non-null ⇒ ready | else `discordReady:false`, mutating cmds → `DISCORD_NOT_READY` |
| A17 | Vesktop extras | unknown (same as Vencord for v1) | no Vesktop-only API used; parity assumed |
| A18 | advanced: per-user vol read-back, local-mute toggle, last-text memory | no reliable getter | toggle variants → `UNSUPPORTED` with `use set_*` hint; `select_last_text_channel` best-effort |

Confirm each A-item in a real Vesktop build (DevTools → `Vencord.Webpack.findByProps(...)`)
and tighten the candidate prop-sets; capability flags will flip to `true`
automatically once the store resolves — no protocol change needed.
