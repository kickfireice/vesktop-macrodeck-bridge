# Vesktop Bridge for Macro Deck

Drive Discord from your Macro Deck (or any Stream Deck compatible surface): mute,
deafen, join/leave/move voice channels, set volumes, change status and pick devices -
with live state pushed back so button labels and icons stay in sync.

> **Unofficial community plugin.** Not affiliated with, endorsed by, or maintained by
> Macro Deck, Vesktop, Vencord, or Discord. Those names are used only to describe what
> this plugin integrates with.

---

## What it is

Two halves that talk to each other over **localhost only**:

| Half | Runs inside | Language | Distributed via |
|---|---|---|---|
| **Macro Deck plugin** | Macro Deck 3 (hosted integration) | C# / .NET 10 | Macro Deck Store / this repo |
| **Vesktop client plugin** | Vesktop, as a Vencord userplugin | TypeScript | this repo (you build it) |

The Macro Deck plugin is the **WebSocket server** bound to `127.0.0.1`. The Vesktop
plugin is the **client**. Nothing leaves your machine.

## Features

- **76 actions**: connection helpers, mute/deafen (self and server), voice
  join/leave/move, audio processing (noise suppression, echo cancellation, AGC, QoS,
  low latency), text channel select, presence and custom status, input/output device
  select/cycle/refresh, per-user and per-application volumes, stage controls.
- **48 live `vesktop-*` variables** (mute state, current voice channel, volumes, ...).
- **Live button states** so your deck reflects reality instead of guessing.
- **Honest capability reporting**: if your Vesktop/Discord build cannot do something,
  the button reports *unavailable* instead of silently doing nothing.

## Setup (read this first)

You need **both halves** on the **same PC** (everything is localhost-only).
The fastest path is the setup script (Windows PowerShell):

```powershell
# from the repository root:
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

What it does: checks prerequisites (Git, Node, pnpm, .NET 10 SDK),
builds the Macro Deck plugin, clones Vencord at the matching rev (if needed),
copies in the `MacroDeckBridge` userplugin, builds it, deploys it to Vesktop,
points Vesktop at the build, and restarts Vesktop. Re-run
`.\setup.ps1 -CheckOnly` any time to verify the install without changing anything.

Prefer manual steps? They are below. Either way, finish with **pairing**
(step 3) — without it, buttons report `NOT_CONNECTED`.

### Prerequisites

| Tool | Needed for | Check |
|---|---|---|
| Git | cloning Vencord | `git --version` |
| Node.js ≥ 22 | protocol tests | `node --version` |
| pnpm | building Vencord | `pnpm --version` (`corepack enable` then `corepack prepare pnpm --activate` if missing) |
| .NET 10 SDK | building the Macro Deck plugin | `dotnet --version` → `10.x` |
| Vesktop (desktop) | the client half | installed and logged into Discord |
| Macro Deck 3 | the server half | installed |

### 1. Macro Deck plugin (server)

1. Install from the Macro Deck Store, **or** build it yourself:

   ```powershell
   cd macrodeck-plugin
   dotnet build VesktopBridge.slnx
   ```

2. Open its settings and **Copy** the generated token. The plugin listens on
   `127.0.0.1` and shows the port it actually bound (`8323` by default; it steps up if
   that port is unavailable).
3. Add buttons in Macro Deck, e.g. *Toggle Mute* or *Join Voice by ID*.

### 2. Vesktop client plugin (client)

Vencord plugins are compiled into Vencord at build time, so this half is built rather
than installed. **The Vencord rev must match the one Vesktop ships**
(Vesktop 1.6.6 = `b52ed36`). A mismatched build is silently replaced by the stock
release on every Vesktop launch, and the plugin vanishes from the list.

```bash
git clone https://github.com/Vendicated/Vencord Vencord
cd Vencord
git checkout b52ed36                # match Vesktop's shipped rev — if in doubt, check the header of %APPDATA%\Vesktop\vencord\vencordDesktopRenderer.js after a clean launch
cp -r ../vesktop-plugin/userplugins/MacroDeckBridge src/userplugins/
pnpm install
pnpm build --standalone
```

Then point Vesktop at that build: **Vesktop Settings -> Developer Options -> Vencord
Location** (this sets `vencordDir` in Vesktop's `state.json` — `setup.ps1` does this
for you). Restart Vesktop and enable `MacroDeckBridge` in the plugin list.

> Never use Vesktop's **Force Update Vencord** (or `vesktop --repair`) with a custom
> build — it re-downloads stock Vencord over your directory by design. After any
> Vesktop update, re-run `.\setup.ps1` to rebuild against the new rev.

### 3. Pair the two halves (required)

1. Macro Deck plugin settings → **Copy** the token (and note the port).
2. Vesktop → Vencord plugin settings → `MacroDeckBridge` → paste the **same**
   token, set the **same** port (`8323` unless Macro Deck shows a fallback).
3. In Macro Deck, run **Check Vesktop Connection**: success means the handshake
   (`hello` → `welcome` → snapshot → heartbeat) completed. `AUTH_FAILED` = wrong
   token; `ALREADY_CONNECTED` = another client holds the single session;
   `NOT_CONNECTED` = Vesktop side not reaching Macro Deck (check host/port and
   that the Vesktop plugin is enabled).

### 4. Verify it works

1. Join a voice channel in Discord.
2. Press a **Toggle Mute** button. Discord should mute/unmute.
3. Run **Show Bridge Status**: it shows port, connected client, and Discord readiness.
4. If a button reports `UNSUPPORTED`, your Vesktop/Discord build lacks that Discord
   internal — the capability list in the plugin's settings page shows what is
   available. `DISCORD_NOT_READY` means Discord is still booting — wait for login.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| Enable | on | auto-connect while the plugin is enabled |
| Host | `127.0.0.1` | localhost only; other values fall back to `127.0.0.1` |
| Port | `8323` | must match the port the Macro Deck plugin reports |
| Token | (empty) | from the Macro Deck plugin; stored in your Vencord settings |
| Read-only | off | report state but reject all mutating commands |
| Debug logging | off | verbose logs; secrets are redacted even then |

## Privacy and data handling

- **Localhost only.** The server rejects any non-loopback connection.
- **No cloud, no telemetry, no analytics, no update pings.**
- **No outbound network traffic** of any kind.
- The only credential involved is a **randomly generated local token** (>= 256-bit,
  created on first run). It is sent once, client -> server, inside the `hello` message
  over loopback. It is **never logged**, and is stored in plain JSON at
  `%AppData%/DeckBridge/settings.json` under your OS user permissions.
- No Discord credentials, cookies, message content, or personal data are read, stored,
  or transmitted. Logs are redacted by design (token and session id are replaced before
  anything is written).

## Known limitations

- **v1 is localhost-only** - you cannot drive Discord on another machine.
- **The Vesktop half is required.** Without it the Macro Deck plugin has nothing to
  talk to, and buttons will report offline / `NOT_FOUND`.
- Because the client half is a Vencord plugin, it must be **rebuilt whenever Vesktop
  ships a new Vencord version**. This is a limitation of Vencord's plugin model, not of
  this project. If the revs mismatch, Vesktop's startup updater silently replaces
  the custom build with the stock release on every launch (plugin vanishes from
  the list) — rebuild against the rev Vesktop ships (see install step 2).
- Some capabilities depend on Discord internals that change between builds. Where a
  feature cannot be reached it is reported as **unavailable** rather than faked.
- Commands that target a channel accept an id, a name, or a `Guild / Category / Channel`
  path. Ambiguous names return `AMBIGUOUS` together with the candidates.
- Voice-related buttons require you to already be in (or join) a voice channel, and
  Discord permissions still apply as normal.

## Repository layout

```
macrodeck-plugin/                 Macro Deck 3 plugin (C#/.NET) - the store package
  src/VesktopBridge.Core/         protocol, WS server, auth, sessions, caches (zero deps)
  src/VesktopBridge.Plugin/       Macro Deck SDK adapters: 76 actions, 48 variables
  tests/                          smoke + interop + Node protocol suites
  docs/                           design docs and store submission notes
vesktop-plugin/                   Vesktop/Vencord client plugin (TypeScript)
  userplugins/MacroDeckBridge/    drop-in Vencord userplugin (build tested)
  src/                            standalone scaffold the userplugin is derived from
  mock-bridge/                    mock Macro Deck server for local testing
PROTOCOL.md                       the shared wire contract (identical in both halves)
```

A Vencord checkout is a **build dependency, not part of this repository** -
`.gitignore` excludes `/Vencord/` and it is cloned at build time (see above).

## Building

### Macro Deck plugin

```bash
cd macrodeck-plugin
dotnet build VesktopBridge.slnx
dotnet run --project tests/BridgeSmoke/BridgeSmoke.csproj
node tests/mock-client/runProtocolTests.js
dotnet run --project tests/BridgeInterop/BridgeInterop.csproj
```

Dependencies are **NuGet packages only** (`MacroDeck.*`, pinned). No third-party DLLs
are bundled, and `VesktopBridge.Core` has zero external dependencies.

### Vesktop client plugin

```bash
cd vesktop-plugin
npm install
npm run typecheck
```

See `vesktop-plugin/README.md` and
`vesktop-plugin/userplugins/MacroDeckBridge/README.md` for the Vencord build.

## Licensing

- `macrodeck-plugin/` - **MIT** (see `LICENSE`).
- `vesktop-plugin/` - **GPL-3.0-or-later** (see `vesktop-plugin/LICENSE`), because it is
  a plugin for [Vencord](https://github.com/Vendicated/Vencord), which is itself
  GPL-3.0-or-later. Vencord is **not** redistributed here - it is fetched from its own
  public repository at build time.

All graphics in this repository (`Icon.png`, `AuthorIco.png` and the plugin icon) were
created by the author.

## AI disclosure

This project was developed with AI assistance (code written with AI agents). The plugin
contains **no AI functionality at runtime**, sends nothing to any AI service, and makes
no network connections other than loopback. Declared here and in the Macro Deck Creator
Portal submission, per store guidelines section 9.

## Issues and contributions

Bug reports and pull requests are welcome. When reporting a problem, please include:

- your Macro Deck version and Vesktop version,
- the plugin's connection status (shown at the top of the plugin's settings page),
- whether the affected button reports `UNSUPPORTED` (a capability your build lacks) or
  another error code.

