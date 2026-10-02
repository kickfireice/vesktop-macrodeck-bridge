# Vesktop Bridge — Macro Deck 3 plugin (server side)

Localhost-only bridge that drives Discord (via Vesktop) from Macro Deck
buttons. Implements shared protocol **v1.0.0** (`PROTOCOL.md`, the single
source of truth — identical copy in `vesktop-plugin/PROTOCOL.md`).

- **Macro Deck plugin = WebSocket server** on `127.0.0.1` (default `8323`,
  auto-fallback, actual port displayed). **Vesktop plugin = client.**
- Token auth (≥256-bit, show/copy/regenerate, never logged) + session handoff.
- Handshake: `hello` → `welcome(sid)` → `snapshot` → `heartbeat` (5 s / 15 s).
- 76 actions, live button states, 48 `vesktop_*` variables, sanitized logs.

## File layout (deliverable #1)

```text
macrodeck-plugin/
  PROTOCOL.md                     shared contract (DO NOT DIVERGE)
  README.md                       this file
  VesktopBridge.slnx
  src/
    VesktopBridge.Core/           BCL-only: protocol, envelope, auth, sessions,
      Protocol.cs                   rate limits, WS server, dispatcher, caches, log
      Envelope.cs
      Auth.cs
      BridgeServer.cs
      CommandDispatcher.cs
      StateCache.cs
      BridgeLog.cs
    VesktopBridge.Plugin/         Macro Deck 3 SDK adapters (real, compiles)
      manifest.json                 id com.example.vesktop-bridge, v1.0.0
      macrodeck-build.json
      Program.cs                  hosting bootstrap
      BridgeService.cs            lifecycle + settings + token mgmt
      PluginSettings.cs
      DeckBridgeIntegration.cs IPluginIntegration + IVariableProvider
      Actions/                    76 action defs (connection/mute/audio/voice/
        BridgeAction.cs             stage/text/status/devices/volumes)
        ConnectionActions.cs
        MuteAudioActions.cs
        VoiceTextStageActions.cs
        StatusDeviceVolumeActions.cs
      States/BridgeVariables.cs   48 feedback variables
      Assets/icon.svg
  tests/
    BridgeSmoke/                  C# server self-test (13 checks, port 8399)
    BridgeInterop/                REAL C# server ↔ Node mock (13 checks, 8401)
    mock-client/                  zero-dep Node: mock Vesktop client, fake
      mockVesktopClient.js          Macro Deck server, 12 protocol checks
      fakeMacroDeckServer.js
      runProtocolTests.js
  docs/                           deliverables #7–#15
```

## Setup

1. `dotnet build VesktopBridge.slnx` (see `docs/BUILD.md`).
2. Run/pack the plugin (`macrodeck-plugin run --stub-host` for dev).
3. First start generates the token (`%AppData%/DeckBridge/settings.json`).
   Copy it into the Vesktop plugin's Bridge settings (same machine only).
4. In Macro Deck, add e.g. **Toggle Mute** / **Join Voice by ID** buttons.
   If a capability is missing the button reports unavailable — never silent.

## Protocol implementation (deliverable #3)

`src/VesktopBridge.Core` mirrors `PROTOCOL.md` 1:1 — envelope fields, message
names (`hello/welcome/state_snapshot/state_update/capability_update/
command/command_result/get_state/request_*/heartbeat/error/device_list_update/
channel_list_update`), all 74 command names, all 30 capability flags, all 22
error codes, state fields, timeouts, limits. Verified by three suites:

```powershell
dotnet run --project tests/BridgeSmoke/BridgeSmoke.csproj
node tests/mock-client/runProtocolTests.js
dotnet run --project tests/BridgeInterop/BridgeInterop.csproj
```

Details: `docs/WS_SERVER_DESIGN.md`, `docs/AUTH_DESIGN.md`,
`docs/STATE_CACHE_DESIGN.md`, `docs/CHANNEL_DEVICE_CACHE.md`,
`docs/ERROR_HANDLING.md`, `docs/LOGGING.md`, `docs/ACTIONS_FEEDBACK_SETTINGS.md`,
`docs/SDK_ASSUMPTIONS.md`, `docs/TEST_PLAN.md`, `docs/MOCK_CLIENT_TEST_PLAN.md`.
