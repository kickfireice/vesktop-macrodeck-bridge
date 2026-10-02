# docs/CHANNEL_DEVICE_CACHE.md — channel/device cache (deliverable #10)

`ChannelDeviceCache` (`src/VesktopBridge.Core/StateCache.cs`) stores
`GuildInfo → ChannelNode[]` (id, name, type, path, parentId) and input/output
`DeviceInfo` lists.

- Updated on `channel_list_update {guilds, seq}` / `device_list_update`.
  Channel `seq` is per-connection: duplicates (`<` last) ignored;
  `ResetSequences()` runs on every new authenticated session (§9.1).
- **IDs internally, names for display** (§11 reliability + spec): dropdowns
  (`IDynamicOptionsActionDefinition`, source ids `voice-channels`,
  `text-channels`, `input-devices`, `output-devices`) bind channel/device
  **IDs**; text params accept ID/name/path as fallback.
- Ambiguity is resolved **client-side**: we pass names/paths verbatim and
  surface the client's `AMBIGUOUS` (+ `payload.candidates`, max 10) or
  `NOT_FOUND`. `ResolveVoice/ResolveText` helpers exist for future
  client-assisted picking; the rule stands: **never guess**.
- `ListsChanged` event → dropdown caches refresh (`CacheSeconds = 5`,
  `AllowsCustomValue = true` so manual IDs always work even with empty lists).
- Debug logs truncate lists (≤10 entries, IDs only where needed, §12).
