// ConnectionActions.cs — Connection group (spec: 6 actions).
// check-vesktop-connection + show-bridge-status are LOCAL-ONLY (no wire
// command). refresh-state / request-full-resync / request-channel-list /
// request-device-list go through the dispatcher.
using MacroDeck.Localization;
using MacroDeck.Sdk.Actions;
using DeckBridge.Core;

namespace DeckBridge.Plugin.Actions;

internal sealed class CheckConnectionAction(BridgeService bridge) : IActionDefinition, IStateProviderActionDefinition
{
    public string Id => "check-vesktop-connection";
    public LocalizedText Name => L.T("Check Vesktop Connection");
    public LocalizedText Description => L.T("Verify the bridge can reach Vesktop (fails the action if offline). No Discord state is changed.");
    public IReadOnlyList<ActionParameter> Parameters => [];
    public IActionExecutor CreateExecutor() => new Exec(bridge);

    private sealed class Exec(BridgeService b) : IActionExecutor
    {
        public async Task<ActionResult> ExecuteAsync(ActionExecutionContext context)
        {
            var d = b.Dispatcher;
            if (d is null)
                return ActionResult.Failed(ActionErrorCodes.NotConnected, L.T("Bridge not running"));
            // Same forgiveness as commands: briefly await a reconnecting Vesktop.
            if (!await d.WaitForConnectionAsync(TimeSpan.FromSeconds(5), context.CancellationToken))
                return ActionResult.Failed(ActionErrorCodes.NotConnected, L.T("Vesktop not connected"));
            return ActionResult.Success();
        }
    }

    public Task<ActionStateSnapshot?> GetActionStateAsync(
        IReadOnlyDictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        var online = bridge.Dispatcher?.IsConnected == true;
        return Task.FromResult<ActionStateSnapshot?>(new ActionStateSnapshot(
            [new("offline", L.T("Offline")), new("online", L.T("Online"))],
            online ? "online" : "offline"));
    }
}

internal sealed class ShowBridgeStatusAction(BridgeService bridge) : IActionDefinition
{
    public string Id => "show-bridge-status";
    public LocalizedText Name => L.T("Show Bridge Status");
    public LocalizedText Description => L.T("Show server port, client, and Discord readiness (local only).");
    public IReadOnlyList<ActionParameter> Parameters => [];
    public IActionExecutor CreateExecutor() => new Exec(bridge);

    private sealed class Exec(BridgeService b) : IActionExecutor
    {
        public Task<ActionResult> ExecuteAsync(ActionExecutionContext context) =>
            // Message is shown to the user as-is; contains only port/client flags (no secrets).
            Task.FromResult(ActionResult.Accepted(L.T(b.StatusSummary())));
    }
}

internal static class ConnectionActions
{
    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        yield return new CheckConnectionAction(b);
        yield return new ShowBridgeStatusAction(b);
        yield return new BridgeCommandAction(b, "refresh-state", "Refresh State",
            "Ask Vesktop to re-read Discord stores and push fresh state.",
            BridgeProtocol.Commands.RefreshState);
        yield return new ResyncAction(b);
        yield return new BridgeCommandAction(b, "request-channel-list", "Request Channel List",
            "Ask Vesktop to push the guild/channel list (needs channelList capability).",
            BridgeProtocol.Commands.GetChannelList);
        yield return new BridgeCommandAction(b, "request-device-list", "Request Device List",
            "Ask Vesktop to push the audio device list (needs deviceList capability).",
            BridgeProtocol.Commands.GetDeviceList);
    }

    /// Request Full Resync: refresh_state + get_state + capability/channel/device
    /// requests (resync rule §11: full snapshot + capabilities + lists).
    private sealed class ResyncAction(BridgeService bridge) : IActionDefinition
    {
        public string Id => "request-full-resync";
        public LocalizedText Name => L.T("Request Full Resync");
        public LocalizedText Description => L.T("Full resync: refresh state, request snapshot, capabilities, channel and device lists.");
        public IReadOnlyList<ActionParameter> Parameters => [];
    public IActionExecutor CreateExecutor() => new Exec(bridge);

    public TimeSpan StatePollInterval => TimeSpan.FromSeconds(1);

    private sealed class Exec(BridgeService b) : IActionExecutor
        {
            public async Task<ActionResult> ExecuteAsync(ActionExecutionContext context)
            {
                var d = b.Dispatcher;
                var s = b.Server;
                if (d is null || s is null || !d.IsConnected)
                    return ActionResult.Failed(ActionErrorCodes.NotConnected, L.T("Vesktop not connected"));
                var r = await d.SendAsync(BridgeProtocol.Commands.RefreshState,
                    new System.Text.Json.Nodes.JsonObject(), context.CancellationToken);
                // Best-effort list/capability pulls; failures surface via their own paths.
                await s.SendRawAsync(EnvelopeCodec.Serialize(EnvelopeCodec.Outgoing(
                    BridgeProtocol.ServerMsg.GetState,
                    new System.Text.Json.Nodes.JsonObject { ["full"] = true },
                    EnvelopeCodec.NewId(), sid: s.ActiveClient?.Sid)));
                foreach (var t in new[]
                {
                    BridgeProtocol.ServerMsg.RequestCapabilities,
                    BridgeProtocol.ServerMsg.RequestChannelList,
                    BridgeProtocol.ServerMsg.RequestDeviceList,
                })
                    await s.SendRawAsync(EnvelopeCodec.Serialize(EnvelopeCodec.Outgoing(
                        t, new System.Text.Json.Nodes.JsonObject(),
                        EnvelopeCodec.NewId(), sid: s.ActiveClient?.Sid)));
                return OutcomeMap.ToActionResult(r);
            }
        }
    }
}
