# docs/TEST_PLAN.md — test plan (deliverable #14)

## Automated (run in order)

```powershell
cd macrodeck-plugin
dotnet run --project tests/BridgeSmoke/BridgeSmoke.csproj      # server: §15 items 1-3,5 (13 checks)
node tests/mock-client/runProtocolTests.js                     # client: handshake/cmds/reconnect (12 checks)
dotnet run --project tests/BridgeInterop/BridgeInterop.csproj  # real C# server ↔ Node mock (13 checks)
```

Expected: `SMOKE ALL PASS`, `PROTOCOL TESTS ALL PASS (12)`, `INTEROP ALL PASS`.
All suites bind loopback only (ports 8399/8401/ephemeral) and print no secrets.

## What each covers (→ §15 checklist)

1. Bind 127.0.0.1 + fallback display; bad JSON/size/type/auth rejected.
2. `hello`→`welcome(sid)`→`snapshot`→`heartbeat`; bad token → `AUTH_FAILED`+4401+rate-limit; dup → `ALREADY_CONNECTED`+4409 (or `SESSION_REPLACED` with replacement on); version → `VERSION_MISMATCH`+`supported`.
3. Every `command` → one `command_result` (`replyTo` match) in timeout; unknown→`UNKNOWN_COMMAND`, unsupported→`UNSUPPORTED`, ambiguous→`AMBIGUOUS`+candidates, not-found→`NOT_FOUND`, readonly→`READ_ONLY`.
4. Live push: mock Discord-side toggle → immediate `state_update` → cache + (in host) button refresh; volume drags debounced 150 ms.
5. Reconnect either side → backoff → re-hello → fresh snapshot; no crash, no spam, no secret leak (asserted on captured logs).
6. Localhost-only (prefix + 403 guard); async everywhere (no polling; idle CPU ~0 — verify with 5-min idle run + wall-clock check that no heartbeat-timeout flaps).

## Manual (needs Macro Deck 3 host + Vesktop)

- Install `.macroDeckPlugin`, add Toggle Mute + Join Voice by ID buttons,
  flip mute in Discord UI → button state follows ≤1 s.
- Kill Vesktop → buttons show offline; restart → resync without replug.
- Wrong token → status shows auth failure; fix token → connects.
- Port clash (run two instances) → second shows fallback port.
- Read-only on → mutating buttons report unavailable; getters still work.

