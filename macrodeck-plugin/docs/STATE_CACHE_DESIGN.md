# docs/STATE_CACHE_DESIGN.md — state cache design (deliverable #9, PROTOCOL §7/§9)

`BridgeStateCache` (`src/VesktopBridge.Core/StateCache.cs`) is the single
in-memory Discord-state store. All values are `JsonNode`, so additive
minor-version fields (§14) survive without code changes.

## Updates

| Message | Handling |
|---|---|
| `state_snapshot` | Full replace (deep clone), `pluginConnected`/`authenticated` = true, `seq` reset, `live` = true |
| `state_update {patch, seq}` | Per-connection monotonic `seq`; `seq <= last` ignored + debug log (§9.1). Patch applied key-by-key (deep clone) |
| `command_result.statePatch` | Applied immediately (cache → feedback without waiting for a push) |
| `capability_update` | `CapabilityStore` + echoed into `availableCapabilities`/`unavailableReasons` |
| `heartbeat {discordReady}` | Liveness echo into cache |
| disconnect | `MarkDisconnected`: flips only `pluginConnected/authenticated/discordReady` (+ optional `lastError`); **all other fields keep last-known values** (§9.2) |

Every mutation computes the changed field list and fires `Changed` (debounced
upstream by the client 100–250 ms for volume drags; discrete events are
immediate — the mock mirrors this). `BridgeService` forwards it to
`StateChanged`, which drives variable pushes (`IVariableSink.PublishAsync`)
and button-state refresh (host polls `GetActionStateAsync`).

## Rules enforced

- Full snapshot shape = `InitialState()` (every §7 field present, `null`
  where unknown — never omitted).
- Booleans strict `true/false/null`; volumes numeric ranges enforced at the
  action layer (0–100 in/out, 0–200 per-user, 0–100 attenuation) before send.
- Thread-safe (`lock`); notification handlers wrapped so a host callback can
  never crash the bridge.
- `GetValue<T>(field, fallback)` and `Get(field)` serve actions/variables;
  unknown fields → fallback/`Unavailable`, never throw.
