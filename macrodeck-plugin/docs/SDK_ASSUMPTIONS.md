# docs/SDK_ASSUMPTIONS.md — Macro Deck 3 SDK limitations & unknowns (STEP 0.2)

Researched 2026-10-02 against live docs (docs.macro-deck.app) + NuGet
(`MacroDeck.Plugin.Hosting` 3.0.0-preview.10, latest at build time) + API
probes (reflection over `MacroDeck.Sdk`). All plugin code compiles against
the real SDK (0 warnings).

## Confirmed (no assumption needed)

- **Out-of-process plugin model**: plain `net10.0` console +
  `MacroDeckPlugin.CreatePlugin(args).RegisterIntegration<T>().Build()` +
  `RunAsync()`. Manifest (`manifestVersion/id/name/version/entrypoints`)
  is the only identity source.
- **Actions**: `IPluginIntegration.Actions` (`IActionDefinition`: stable
  kebab-case `Id`, `Name`/`Description` (`LocalizedText.FromLiteral`),
  `Parameters`, `CreateExecutor()` → `IActionExecutor.ExecuteAsync(ctx)` →
  `Task<ActionResult>`). `Actions` read before `InitializeAsync` — ours are
  side-effect free (verified: `BridgeService` does no I/O in ctor).
- **Dynamic dropdowns: SUPPORTED** via `IDynamicOptionsActionDefinition`
  (`DynamicChoice` param + `GetDynamicOptionsAsync` → `DynamicOptionsResult`
  `{Options, AllowsCustomValue, CacheSeconds, Error}`). Used for
  voice/text channels + input/output devices, with manual ID/name/path
  fallback (`AllowsCustomValue = true`).
- **Button states: SUPPORTED** via `IStateProviderActionDefinition`
  (`GetActionStateAsync` → `ActionStateSnapshot(states, activeStateId)`,
  side-effect free). Used on all toggle-ish actions.
- **Variables: SUPPORTED** via `IVariableProvider` (`VariableDefinition.Eager`
  + `ReadAsync` + `IVariableSink.PublishAsync` push; `SupportsPush = true`).
- **Result codes**: `ActionResult.Success/Failed(code,message)/Accepted` +
  `ActionErrorCodes` (NotConnected/Timeout/InvalidParameter/Unavailable/
  NotFound/PermissionDenied/ProviderError). Ours map protocol codes onto these.
- **Reserved routes**: `/_macrodeck/*` must not be mapped — we don't (plain
  `HttpListener` on loopback, no ASP.NET routing for the bridge).

## Unknowns + assumptions (safest lightweight choice each)

1. **Can a plugin listen on a socket?** Unknown in docs. The hosting SDK is
   ASP.NET Core-based with DI escape hatches; nothing forbids extra
   listeners. ASSUMPTION: allowed (it's a normal OS process). CHOICE:
   BCL `HttpListener` on 127.0.0.1 (no new deps, no host-port conflicts,
   localhost-only by construction). If a future host policy forbids it, the
   seam is `BridgeService` (swap transport, keep protocol/cache/actions).
2. **SDK version stability.** Pinned `3.0.0-preview.10` (reproducible);
   `3.0.0-*` floats per docs. Preview APIs may shift — our SDK surface is
   small (actions/states/variables/hosting) and covered by Analyzers.
3. **Host connection availability.** README notes host endpoints "not in a
   released Macro Deck yet" (issue #411). ASSUMPTION: dev against
   `macrodeck-plugin run --stub-host` (CLI) until host support lands.
   Our bridge tests don't need the host at all (C#/Node harnesses).
4. **Settings UI.** `IConfigFlowProvider` is the setup-flow contract, but
   field-type APIs weren't fully probed. ASSUMPTION: config flow is the
   right binding. CHOICE: ship `PluginSettings` + `BridgeService` mutators
   now (documented seam), add the flow later. No placeholder flow shipped.
5. **Lifecycle re-init.** Hosting re-runs `ShutdownAsync`/`InitializeAsync`
   on reconnect/config change. Our start/stop is idempotent (guard +
   clean `StopAsync`), so this is safe.
6. **Concurrent capability dispatch** (new behavior): executors share
   `CommandDispatcher` (thread-safe) and the cache (locked) — safe.
7. **Plugin lifecycle start/stop.** `InitializeAsync` → `StartAsync`;
   `ShutdownAsync` → `StopAsync` (listener closed, sessions revoked,
   pendings failed, cache marked offline). Verified in tests.
