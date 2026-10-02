# docs/ACTIONS_FEEDBACK_SETTINGS.md — actions, feedback states, settings
(deliverables #4, #5, #6)

## Actions (76 total; ids are stable kebab-case — never rename)

Implemented in `src/VesktopBridge.Plugin/Actions/`. Most are
`BridgeCommandAction` (one SDK action per protocol command); connection
helpers and resync have custom executors. If a capability is missing the
action fails with `Unavailable` — reported, never silent.

- **Connection (6):** `check-vesktop-connection` (local-only + online/offline
  button state), `show-bridge-status` (local-only, status text),
  `refresh-state`, `request-full-resync` (refresh + get_state + caps + lists),
  `request-channel-list`, `request-device-list`.
- **Mute/deafen (7):** `toggle-mute`, `set-mute` (muted toggle), `toggle-deafen`,
  `set-deafen`, `toggle-mute-and-deafen`, `toggle-speaker-mute`, `set-speaker-mute`.
- **Audio processing (10):** toggle + set for `noise-suppression`,
  `echo-cancellation`, `automatic-gain`, `qos-high-priority`, `low-latency`.
- **Voice (10):** `join-voice-by-id/-by-name/-by-path`, `leave-voice`,
  `disconnect-voice`, `move-voice-by-id/-by-name/-by-path`, `rejoin-last-voice`,
  `cycle-voice-channel` (direction next/prev). Join/move-by-id and name/path
  variants expose dropdown + text params; required-field validation is local
  (`InvalidParameter`), ambiguity is the client's `AMBIGUOUS`.
- **Stage (5):** `stage-raise-hand/-lower-hand/-toggle-hand`,
  `stage-request-to-speak`, `stage-cancel-speak-request` (best-effort).
- **Text (6):** `select-text-by-id/-by-name/-by-path`,
  `select-last-text-channel`, `cycle-text-channel`, `mark-selected-channel-read`.
- **Status (10):** `set-status-online/-idle/-dnd/-invisible`, `cycle-status`,
  `toggle-dnd`, `toggle-invisible`, `set-custom-status` (text/emojiName/emojiId),
  `append-custom-status` (text required), `clear-custom-status`.
- **Devices (7):** `set-input-device-by-id` (dropdown) / `-by-name`,
  `cycle-input-device`, `set-output-device-by-id` (dropdown) / `-by-name`,
  `cycle-output-device`, `refresh-audio-devices`.
- **Volume (15):** `set-/increase-/decrease-input-volume`,
  `set-/increase-/decrease-output-volume` (0–100 clamped),
  `set-/increase-/decrease-/reset-user-volume` (userId required, 0–200),
  `toggle-/set-user-local-mute`, `set-attenuation-volume` (0–100),
  `toggle-/set-attenuation-while-speaking`.

## Feedback states (deliverable #5)

Two mechanisms, both reading the same cache (event-driven, no polling):

1. **Button states** (`IStateProviderActionDefinition` on toggle-ish actions):
   muted/unmuted, deafened/undeafened, speaker on/off, enabled/disabled (×5
   audio-proc), voice connected/disconnected, hand raised/lowered, speak
   requested/not, status online/idle/dnd/invisible/unknown, connection
   online/offline. Side-effect free, tolerates partial params.
2. **Variables** (`IVariableProvider`, `States/BridgeVariables.cs`, 48 eager
    `vesktop-*` variables + push via `IVariableSink` on every cache change):
    server-status, actual-port, bridge-running, vesktop-connected,
    authenticated, discord-ready, last-error, protocol-version,
    vesktop-plugin-version, read-only, client-name/version; muted, deafened,
    server-muted/deafened, voice-connected/connecting, voice-channel
    id/name/path, voice-guild id/name, last-voice-channel-name; text-channel
    id/name/path, text-guild id/name; user-status, custom-status text/emoji;
    input/output-volume, input/output-device-name, noise-suppression,
    echo-cancellation, automatic-gain, qos-high-priority, low-latency,
    speaker-muted, attenuation-volume/while-speaking; stage-hand-raised,
    stage-speak-requested, stage-is-speaker, stage-channel-active.
   Unknown (`null`) → `Unavailable` reading.

## Settings (deliverable #6, `PluginSettings.cs`)

Persisted JSON at `%AppData%/DeckBridge/settings.json`:

| Setting | Default | Notes |
|---|---|---|
| `ConfiguredPort` | 8323 | validated 1–65535; actual bind may differ (fallback) |
| `AuthToken` | generated | ≥256-bit; Show/Copy/Regenerate in UI; never logged |
| `ReadOnly` | false | authoritative; echoed to client in `welcome` + state |
| `AllowReplacement` | false | new hello evicts old session (§3) |
| `LogLevel` | info | info \| debug (live-switchable) |

Read-only/status derivatives (actual port, client name/version,
capabilities, last auth failure, last error) are exposed as variables +
`show-bridge-status`. **Seam:** host settings UI binding is via a Macro Deck
config flow (`IConfigFlowProvider`) — not yet implemented; `BridgeService`
(`SetFlags`/`SetPorts`/`RegenerateTokenAsync`) is the wiring point, and the
analyzers will validate the flow once added. Token/file handling already
follows §2.1 regardless of UI.
