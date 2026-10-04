# docs/BUILD.md — build instructions (deliverable #13)

## Prerequisites

- .NET 10 SDK (`dotnet --version` → 10.x). Core builds offline.
- Node ≥22 (global `WebSocket` client, no npm deps) for mock/tests.
- Network once for NuGet restore of the Plugin project
  (`MacroDeck.* 3.0.0-preview.10`, pinned).

## Build

```powershell
cd macrodeck-plugin
dotnet build VesktopBridge.slnx        # Core + Plugin + both test hosts
```

- `VesktopBridge.Core`: BCL-only, always builds (even offline).
- `VesktopBridge.Plugin`: needs the SDK packages (restored automatically).
- Analyzers (`MacroDeck.Plugin.Analyzers`) run on every Plugin build.

## Run the plugin (dev)

```powershell
dotnet tool install --global MacroDeck.Plugin.Cli --prerelease
macrodeck-plugin run --project src/VesktopBridge.Plugin/VesktopBridge.Plugin.csproj --stub-host
# without a host (bridge only): BridgeService can be hosted standalone —
# see tests/BridgeInterop for the embed pattern.
```

## Package

```powershell
macrodeck-plugin build --output ../artifacts
macrodeck-plugin validate --artifact ../artifacts/com.kickfireice.vesktop-bridge-1.0.0.macroDeckPlugin
```

(Uses `src/VesktopBridge.Plugin/macrodeck-build.json`: framework-dependent
`win-x64`/`linux-x64`/`osx-arm64` targets. Never zip by hand.)

## Settings at runtime

Token + port live in `%AppData%/DeckBridge/settings.json`. First start
generates the token (logged as "generated", value never logged). Paste it
into the Vesktop plugin settings on the same machine. Both sides stay on
`127.0.0.1` — no firewall rules, no LAN exposure.

