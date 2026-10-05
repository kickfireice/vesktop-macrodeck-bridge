// BridgeAction.cs — shared action infrastructure.
// Pattern per Macro Deck 3 SDK: IActionDefinition (stable kebab-case Id,
// Parameters) + IActionExecutor (async, honours CancellationToken, never
// blocks UI). All executors delegate to CommandDispatcher (async command
// flow: connected → capability → readOnly → send → await result).
using System.Globalization;
using System.Text.Json.Nodes;
using MacroDeck.Localization;
using MacroDeck.Sdk.Actions;
using DeckBridge.Core;

namespace DeckBridge.Plugin.Actions;

internal static class L
{
    public static LocalizedText T(string s) => LocalizedText.FromLiteral(s);
}

internal static class ParamRead
{
    public static string Str(IReadOnlyDictionary<string, object> p, string name, string dflt = "")
    {
        if (p.TryGetValue(name, out var v) && v is not null)
        {
            var s = v.ToString();
            if (!string.IsNullOrEmpty(s)) return s;
        }
        return dflt;
    }

    public static bool Bool(IReadOnlyDictionary<string, object> p, string name, bool dflt = false)
    {
        if (p.TryGetValue(name, out var v) && v is not null)
        {
            if (v is bool b) return b;
            if (bool.TryParse(v.ToString(), out var parsed)) return parsed;
        }
        return dflt;
    }

    public static double Num(IReadOnlyDictionary<string, object> p, string name, double dflt = 0)
    {
        if (p.TryGetValue(name, out var v) && v is not null &&
            double.TryParse(v.ToString(), CultureInfo.InvariantCulture, out var n)) return n;
        return dflt;
    }
}

internal static class OutcomeMap
{
    /// Every failure surfaces a user-visible reason — never fail silently.
    public static ActionResult ToActionResult(CommandOutcome o)
    {
        if (o.Ok) return ActionResult.Success();
        return (o.ErrorCode switch
        {
            BridgeProtocol.Errors.NotConnected or BridgeProtocol.Errors.NotAuthenticated
                => ActionResult.Failed(ActionErrorCodes.NotConnected, L.T("Vesktop not connected")),
            BridgeProtocol.Errors.Timeout => ActionResult.Failed(ActionErrorCodes.Timeout, L.T("Command timed out")),
            BridgeProtocol.Errors.Unsupported or BridgeProtocol.Errors.ReadOnly
                => ActionResult.Failed(ActionErrorCodes.Unavailable, L.T(o.ErrorMessage ?? "Unavailable")),
            BridgeProtocol.Errors.NotFound or BridgeProtocol.Errors.Ambiguous
                => ActionResult.Failed(ActionErrorCodes.NotFound, L.T(o.ErrorMessage ?? "Not found")),
            BridgeProtocol.Errors.PermissionDenied
                => ActionResult.Failed(ActionErrorCodes.PermissionDenied, L.T(o.ErrorMessage ?? "Denied")),
            _ => ActionResult.Failed(ActionErrorCodes.ProviderError,
                    L.T($"{o.Command} failed: {o.ErrorCode}")),
        });
    }
}

/// Generic wire-command action: one SDK action per protocol command.
/// Optional stateSpec adds IStateProviderActionDefinition (live button state).
internal sealed class StateSpec(
    string[] stateIds, string[] stateLabels,
    Func<BridgeStateCache, string> activeState)
{
    public string[] StateIds = stateIds;
    public string[] StateLabels = stateLabels;
    public Func<BridgeStateCache, string> ActiveState = activeState;
}

internal class BridgeCommandAction : IActionDefinition, IStateProviderActionDefinition
{
    private readonly BridgeService _bridge;
    private readonly string _command;
    private readonly Func<IReadOnlyDictionary<string, object>, JsonObject?> _args;
    private readonly StateSpec? _state;

    public string Id { get; }
    public LocalizedText Name { get; }
    public LocalizedText Description { get; }
    public IReadOnlyList<ActionParameter> Parameters { get; }

    public BridgeCommandAction(BridgeService bridge, string id, string name,
        string description, string command,
        IReadOnlyList<ActionParameter>? parameters = null,
        Func<IReadOnlyDictionary<string, object>, JsonObject?>? args = null,
        StateSpec? state = null)
    {
        _bridge = bridge;
        Id = id;
        Name = L.T(name);
        Description = L.T(description);
        _command = command;
        Parameters = parameters ?? [];
        _args = args ?? (_ => new JsonObject());
        _state = state;
    }

    public IActionExecutor CreateExecutor() => new Exec(this);

    /// Poll fast: buttons must reflect Discord within ~a second, not the host default.
    public TimeSpan StatePollInterval => TimeSpan.FromSeconds(1);

    protected BridgeService BridgeSvc => _bridge;

    private sealed class Exec(BridgeCommandAction a) : IActionExecutor
    {
        public async Task<ActionResult> ExecuteAsync(ActionExecutionContext context)
        {
            var d = a._bridge.Dispatcher;
            if (d is null)
                return ActionResult.Failed(ActionErrorCodes.NotConnected, L.T("Bridge not running"));
            JsonObject args;
            try { args = a._args(context.Parameters) ?? new JsonObject(); }
            catch (ArgumentException ex)
            {
                return ActionResult.Failed(ActionErrorCodes.InvalidParameter, L.T(ex.Message));
            }
            var outcome = await d.SendAsync(a._command, args, context.CancellationToken);
            return OutcomeMap.ToActionResult(outcome);
        }
    }

    // IStateProviderActionDefinition: side-effect free, tolerates partial params.
    public Task<ActionStateSnapshot?> GetActionStateAsync(
        IReadOnlyDictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        if (_state is null) return Task.FromResult<ActionStateSnapshot?>(null);
        try
        {
            var server = _bridge.Server;
            if (server is null) return Task.FromResult<ActionStateSnapshot?>(null);
            var defs = _state.StateIds.Zip(_state.StateLabels,
                (id, label) => new ActionStateDefinition(id, L.T(label))).ToList();
            return Task.FromResult<ActionStateSnapshot?>(
                new ActionStateSnapshot(defs, _state.ActiveState(server.State)));
        }
        catch { return Task.FromResult<ActionStateSnapshot?>(null); } // never crash host
    }
}

// Parameter factories (labels match spec terminology; IDs preferred internally).
internal static class P
{
    public static ActionParameter Text(string name, string label, bool required = false, string dflt = "") =>
        ActionParameter.Text(name, L.T(label), required: required, defaultValue: dflt);
    public static ActionParameter Toggle(string name, string label, bool dflt = false) =>
        ActionParameter.Toggle(name, L.T(label), defaultValue: dflt);
    public static ActionParameter Num(string name, string label, double? min, double? max, double? dflt, bool required = false) =>
        ActionParameter.Number(name, L.T(label), min: min, max: max, defaultValue: dflt, required: required);
    public static ActionParameter Slider(string name, string label, double min, double max, double dflt, double step = 1) =>
        ActionParameter.Slider(name, min, max, L.T(label), step: step, defaultValue: dflt);
    public static ActionParameter Choice(string name, string label, (string v, string l)[] opts, string dflt) =>
        ActionParameter.Choice(name, opts.Select(o =>
            new ActionParameterOption { Value = o.v, Label = L.T(o.l) }).ToList(),
            L.T(label), defaultValue: dflt);
    // NOTE: no optionsSourceId on purpose. The host routes DynamicChoice params
    // WITHOUT a source id to this action's IDynamicOptionsActionDefinition
    // provider by parameter name (see SDK docs sample). Passing a source id
    // makes the host resolve it through a registry instead and fail with
    // "Unknown options source".
    public static ActionParameter VoiceChannel(string param = "channelId") =>
        Dyn(ActionParameter.DynamicChoice(param, L.T("Voice channel"),
            L.T("Pick a voice/stage channel (ID preferred)."), required: false));
    public static ActionParameter TextChannel(string param = "channelId") =>
        Dyn(ActionParameter.DynamicChoice(param, L.T("Text channel"),
            L.T("Pick a text channel (ID preferred)."), required: false));
    public static ActionParameter Device(string param, string label, string source) =>
        Dyn(ActionParameter.DynamicChoice(param, L.T(label),
            L.T("Pick a device (ID preferred)."), required: false));
    public static ActionParameter Guild(string param = "guildId") =>
        Dyn(ActionParameter.DynamicChoice(param, L.T("Server"),
            L.T("Pick the Discord server first - the channel list follows it."), required: false));
    public static ActionParameter User(string param = "userId", bool required = true) =>
        Dyn(ActionParameter.DynamicChoice(param, L.T("User"),
            L.T("Pick a user in your voice call (or type an ID)."), required: required));

    /// The DynamicChoice factory leaves DynamicOptions=false, and the host
    /// only calls the action's IDynamicOptionsActionDefinition provider when
    /// the flag is set - otherwise it reports "Unknown options source".
    private static ActionParameter Dyn(ActionParameter p) => new()
    {
        Name = p.Name,
        Type = p.Type,
        Label = p.Label,
        Description = p.Description,
        Placeholder = p.Placeholder,
        Required = p.Required,
        AllowSelf = p.AllowSelf,
        WidgetTypes = p.WidgetTypes,
        DynamicOptions = true,
        OptionsSourceId = p.OptionsSourceId,
    };

    public static JsonObject Args(params (string k, JsonNode? v)[] pairs)
    {
        var o = new JsonObject();
        foreach (var (k, v) in pairs) o[k] = v?.DeepClone();
        return o;
    }
    public static JsonNode? V(string? s) => s is null ? null : JsonValue.Create(s);
    public static JsonNode? V(bool b) => JsonValue.Create(b);
    public static JsonNode? V(double n) => JsonValue.Create(n);
}
