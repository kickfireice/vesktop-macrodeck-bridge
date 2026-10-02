// DeckBridgeIntegration.cs — the Macro Deck 3 integration.
// IPluginIntegration: Actions list complete + side-effect free from
// construction; bridge starts in InitializeAsync, stops in ShutdownAsync.
// IVariableProvider: live feedback states as eager variables (§7 + spec list).
using MacroDeck.Sdk;
using MacroDeck.Sdk.Variables;
using DeckBridge.Core;
using DeckBridge.Plugin.Actions;

namespace DeckBridge.Plugin;

public sealed class DeckBridgeIntegration : IPluginIntegration, IVariableProvider
{
    private readonly BridgeService _bridge;
    private IVariableSink? _sink;

    public DeckBridgeIntegration(BridgeService bridge)
    {
        _bridge = bridge;
        Actions =
        [
            .. ConnectionActions.All(bridge),
            .. MuteActions.All(bridge),
            .. AudioProcActions.All(bridge),
            .. VoiceActions.All(bridge),
            .. StageActions.All(bridge),
            .. TextActions.All(bridge),
            .. StatusActions.All(bridge),
            .. DeviceActions.All(bridge),
            .. VolumeActions.All(bridge),
        ];
        Variables = BridgeVariables.Definitions;
        _bridge.StateChanged += PushVariables;
    }

    public IReadOnlyList<MacroDeck.Sdk.Actions.IActionDefinition> Actions { get; }

    public async Task InitializeAsync(IIntegrationContext context)
    {
        await _bridge.StartAsync();
        BridgeLog.Info($"DeckBridge integration initialized ({Actions.Count} actions)");
    }

    public async Task ShutdownAsync()
    {
        await _bridge.StopAsync();
        BridgeLog.Info("DeckBridge integration shut down");
    }

    // ---- IVariableProvider: feedback states (deliverable #5) ----
    public IReadOnlyList<VariableDefinition> Variables { get; }
    public bool SupportsPush => true;

    public Task OnAttachedAsync(IVariableSink sink, CancellationToken cancellationToken = default)
    {
        _sink = sink;
        return Task.CompletedTask;
    }

    public ValueTask<VariableReading> ReadAsync(string localId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var server = _bridge.Server;
            if (server is null) return ValueTask.FromResult(VariableReading.Unavailable);
            var value = BridgeVariables.Read(server, localId);
            return ValueTask.FromResult(value is null
                ? VariableReading.Unavailable
                : VariableReading.Of(value));
        }
        catch { return ValueTask.FromResult(VariableReading.Unavailable); }
    }

    private void PushVariables()
    {
        var sink = _sink;
        var server = _bridge.Server;
        if (sink is null || server is null) return;
        try
        {
            var values = new List<VariableValue>();
            foreach (var id in BridgeVariables.Ids)
            {
                var v = BridgeVariables.Read(server, id);
                values.Add(v is null ? VariableValue.Unavailable(id) : VariableValue.Of(id, v));
            }
            // Fire-and-forget push; never throws, never blocks (event-driven, no polling).
            _ = sink.PublishAsync(values);
        }
        catch { /* never crash host */ }
    }
}
