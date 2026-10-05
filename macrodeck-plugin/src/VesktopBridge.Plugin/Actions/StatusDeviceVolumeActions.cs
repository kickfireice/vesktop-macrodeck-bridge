// StatusDeviceVolumeActions.cs — status / devices / volume groups.
using MacroDeck.Sdk.Actions;
using DeckBridge.Core;

namespace DeckBridge.Plugin.Actions;

internal static class StatusActions
{
    private static StateSpec StatusState() => new(
        ["online", "idle", "dnd", "invisible", "unknown"],
        ["Online", "Idle", "DND", "Invisible", "Unknown"],
        c => c.GetValue("userStatus", "unknown") is string s
            && (s is "online" or "idle" or "dnd" or "invisible") ? s : "unknown");

    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        yield return new BridgeCommandAction(b, "set-status-online", "Set Status Online", "Set status to Online.",
            BridgeProtocol.Commands.SetStatusOnline, state: StatusState());
        yield return new BridgeCommandAction(b, "set-status-idle", "Set Status Idle", "Set status to Idle.",
            BridgeProtocol.Commands.SetStatusIdle, state: StatusState());
        yield return new BridgeCommandAction(b, "set-status-dnd", "Set Status DND", "Set status to Do Not Disturb.",
            BridgeProtocol.Commands.SetStatusDnd, state: StatusState());
        yield return new BridgeCommandAction(b, "set-status-invisible", "Set Status Invisible", "Set status to Invisible.",
            BridgeProtocol.Commands.SetStatusInvisible, state: StatusState());
        yield return new BridgeCommandAction(b, "cycle-status", "Cycle Status", "Cycle online → idle → dnd → invisible.",
            BridgeProtocol.Commands.CycleStatus, state: StatusState());
        yield return new BridgeCommandAction(b, "toggle-dnd", "Toggle DND", "Toggle Do Not Disturb.",
            BridgeProtocol.Commands.ToggleDnd, state: StatusState());
        yield return new BridgeCommandAction(b, "toggle-invisible", "Toggle Invisible", "Toggle Invisible.",
            BridgeProtocol.Commands.ToggleInvisible, state: StatusState());
        yield return new BridgeCommandAction(b, "set-custom-status", "Set Custom Status", "Replace the custom status.",
            BridgeProtocol.Commands.SetCustomStatus,
            [P.Text("text", "Text", false), P.Text("emojiName", "Emoji name", false), P.Text("emojiId", "Emoji ID", false)],
            p => P.Args(("text", OptS(p, "text")), ("emojiName", OptS(p, "emojiName")), ("emojiId", OptS(p, "emojiId"))));
        yield return new BridgeCommandAction(b, "append-custom-status", "Append Custom Status", "Append text to the custom status.",
            BridgeProtocol.Commands.AppendCustomStatus,
            [P.Text("text", "Text", true)],
            p => ReqText(p, P.Args(("text", P.V(ParamRead.Str(p, "text"))))));
        yield return new BridgeCommandAction(b, "clear-custom-status", "Clear Custom Status", "Clear the custom status.",
            BridgeProtocol.Commands.ClearCustomStatus);
    }

    private static System.Text.Json.Nodes.JsonNode? OptS(
        IReadOnlyDictionary<string, object> p, string f)
    {
        var s = ParamRead.Str(p, f);
        return string.IsNullOrEmpty(s) ? null : P.V(s);
    }

    private static System.Text.Json.Nodes.JsonObject ReqText(
        IReadOnlyDictionary<string, object> p, System.Text.Json.Nodes.JsonObject args)
    {
        if (string.IsNullOrEmpty(ParamRead.Str(p, "text")))
            throw new ArgumentException("Custom status text is required.");
        return args;
    }
}

internal sealed class InputDeviceOptions(BridgeService b, string id, string name, string command,
    Func<IReadOnlyDictionary<string, object>, System.Text.Json.Nodes.JsonObject?> args,
    IReadOnlyList<ActionParameter> parameters)
    : BridgeCommandAction(b, id, name, "Set the input device. Prefer the dropdown (ID).", command, parameters, args),
    MacroDeck.Sdk.Actions.IDynamicOptionsActionDefinition
{
    public Task<DynamicOptionsResult> GetDynamicOptionsAsync(
        DynamicOptionsContext context, CancellationToken cancellationToken) =>
        Task.FromResult(DeviceOptions.Input(BridgeSvc, context));
}

internal sealed class OutputDeviceOptions(BridgeService b, string id, string name, string command,
    Func<IReadOnlyDictionary<string, object>, System.Text.Json.Nodes.JsonObject?> args,
    IReadOnlyList<ActionParameter> parameters)
    : BridgeCommandAction(b, id, name, "Set the output device. Prefer the dropdown (ID).", command, parameters, args),
    MacroDeck.Sdk.Actions.IDynamicOptionsActionDefinition
{
    public Task<DynamicOptionsResult> GetDynamicOptionsAsync(
        DynamicOptionsContext context, CancellationToken cancellationToken) =>
        Task.FromResult(DeviceOptions.Output(BridgeSvc, context));
}

internal static class DeviceOptions
{
    public static DynamicOptionsResult Input(BridgeService b, DynamicOptionsContext ctx) => For(b, "input", ctx);
    public static DynamicOptionsResult Output(BridgeService b, DynamicOptionsContext ctx) => For(b, "output", ctx);

    private static DynamicOptionsResult For(BridgeService b, string kind, DynamicOptionsContext ctx)
    {
        BridgeDiagnostics.OptionsRequest(ctx?.ParameterName ?? "-");
        var server = b.Server;
        if (server is null)
            return new DynamicOptionsResult
            { Error = L.T("Bridge not running"), Options = [], AllowsCustomValue = true };
        if (server.ActiveClient is null)
            return new DynamicOptionsResult
            { Error = L.T("Vesktop not connected - open Vesktop and wait for login"), Options = [], AllowsCustomValue = true };
        var devs = kind == "input" ? server.Lists.Inputs : server.Lists.Outputs;
        if (devs.Count == 0)
            return new DynamicOptionsResult
            { Error = L.T("No devices received yet - check the Vesktop connection, then reopen this list"), Options = [], AllowsCustomValue = true };
        return new DynamicOptionsResult
        {
            Options = devs.Select(d => new ActionParameterOption
            { Value = d.Id, Label = L.T(d.Name + (d.IsDefault ? " (default)" : "")) }).Take(100).ToList(),
            AllowsCustomValue = true,
            CacheSeconds = 5,
        };
    }
}

internal static class DeviceActions
{
    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        yield return new InputDeviceOptions(b, "set-input-device-by-id", "Set Input by ID",
            BridgeProtocol.Commands.SetInputDeviceById,
            p => NeedId(p, P.Args(("deviceId", P.V(ParamRead.Str(p, "deviceId"))))),
            [P.Device("deviceId", "Input device", "input-devices")]);
        yield return new BridgeCommandAction(b, "set-input-device-by-name", "Set Input by Name",
            "Set the input device by name (exact match).",
            BridgeProtocol.Commands.SetInputDeviceByName,
            [P.Text("name", "Device name", true)],
            p => NeedName(p, P.Args(("name", P.V(ParamRead.Str(p, "name"))))));
        yield return new BridgeCommandAction(b, "cycle-input-device", "Cycle Input Device",
            "Cycle to next/previous input device.",
            BridgeProtocol.Commands.CycleInputDevice,
            [P.Choice("direction", "Direction", [("next", "Next"), ("prev", "Previous")], "next")],
            p => P.Args(("direction", P.V(ParamRead.Str(p, "direction", "next")))));
        yield return new OutputDeviceOptions(b, "set-output-device-by-id", "Set Output by ID",
            BridgeProtocol.Commands.SetOutputDeviceById,
            p => NeedId(p, P.Args(("deviceId", P.V(ParamRead.Str(p, "deviceId"))))),
            [P.Device("deviceId", "Output device", "output-devices")]);
        yield return new BridgeCommandAction(b, "set-output-device-by-name", "Set Output by Name",
            "Set the output device by name (exact match).",
            BridgeProtocol.Commands.SetOutputDeviceByName,
            [P.Text("name", "Device name", true)],
            p => NeedName(p, P.Args(("name", P.V(ParamRead.Str(p, "name"))))));
        yield return new BridgeCommandAction(b, "cycle-output-device", "Cycle Output Device",
            "Cycle to next/previous output device.",
            BridgeProtocol.Commands.CycleOutputDevice,
            [P.Choice("direction", "Direction", [("next", "Next"), ("prev", "Previous")], "next")],
            p => P.Args(("direction", P.V(ParamRead.Str(p, "direction", "next")))));
        yield return new BridgeCommandAction(b, "refresh-audio-devices", "Refresh Audio Devices",
            "Ask Vesktop to re-enumerate audio devices.",
            BridgeProtocol.Commands.RefreshAudioDevices);
    }

    private static System.Text.Json.Nodes.JsonObject NeedId(
        IReadOnlyDictionary<string, object> p, System.Text.Json.Nodes.JsonObject a)
    {
        if (string.IsNullOrEmpty(ParamRead.Str(p, "deviceId")))
            throw new ArgumentException("Pick a device from the dropdown or enter a device ID.");
        return a;
    }

    private static System.Text.Json.Nodes.JsonObject NeedName(
        IReadOnlyDictionary<string, object> p, System.Text.Json.Nodes.JsonObject a)
    {
        if (string.IsNullOrEmpty(ParamRead.Str(p, "name")))
            throw new ArgumentException("Device name is required.");
        return a;
    }
}

/// User-targeting action with a live "users in your call" dropdown.
/// Same pattern as VoiceJoinOptions: DynamicChoice without source id, host
/// routes by parameter name ("userId") to this provider.
internal sealed class UserSelectOptions(BridgeService b, string id, string name,
    string description, string command,
    IReadOnlyList<ActionParameter> parameters,
    Func<IReadOnlyDictionary<string, object>, System.Text.Json.Nodes.JsonObject?> args)
    : BridgeCommandAction(b, id, name, description, command, parameters, args),
    IDynamicOptionsActionDefinition
{
    public Task<DynamicOptionsResult> GetDynamicOptionsAsync(
        DynamicOptionsContext context, CancellationToken cancellationToken)
        => Task.FromResult(UserOptions.For(BridgeSvc));
}

internal static class UserOptions
{
    public static DynamicOptionsResult For(BridgeService b)
    {
        var server = b.Server;
        if (server is null)
            return new DynamicOptionsResult
            { Error = L.T("Bridge not running"), Options = [], AllowsCustomValue = true };
        if (server.ActiveClient is null)
            return new DynamicOptionsResult
            { Error = L.T("Vesktop not connected - open Vesktop and wait for login"), Options = [], AllowsCustomValue = true };
        var users = new List<(string id, string name)>();
        try
        {
            if (server.State.Snapshot()["voiceUsers"] is System.Text.Json.Nodes.JsonArray arr)
                foreach (var u in arr.OfType<System.Text.Json.Nodes.JsonObject>())
                {
                    var id = u["id"]?.GetValue<string>() ?? "";
                    var name = u["name"]?.GetValue<string>() ?? "";
                    if (!string.IsNullOrEmpty(id)) users.Add((id, name));
                }
        }
        catch { /* fall through to empty */ }
        if (users.Count == 0)
            return new DynamicOptionsResult
            { Error = L.T("No users found - join a voice channel first"), Options = [], AllowsCustomValue = true };
        return new DynamicOptionsResult
        {
            Options = users.Select(u => new ActionParameterOption
                { Value = u.id, Label = L.T(string.IsNullOrEmpty(u.name) ? u.id : u.name) })
                .Take(50).ToList(),
            AllowsCustomValue = true,
            CacheSeconds = 5,
        };
    }
}

internal static class VolumeActions
{
    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        // Input volume 0–100 + output volume 0–100 (§6.1 ranges enforced locally).
        yield return Vol(b, "set-input-volume", "Set Input Volume", BridgeProtocol.Commands.SetInputVolume,
            "inputVolume", 100);
        yield return Step(b, "increase-input-volume", "Increase Input Volume",
            BridgeProtocol.Commands.IncreaseInputVolume, 5);
        yield return Step(b, "decrease-input-volume", "Decrease Input Volume",
            BridgeProtocol.Commands.DecreaseInputVolume, 5);
        yield return Vol(b, "set-output-volume", "Set Output Volume", BridgeProtocol.Commands.SetOutputVolume,
            "outputVolume", 100);
        yield return Step(b, "increase-output-volume", "Increase Output Volume",
            BridgeProtocol.Commands.IncreaseOutputVolume, 5);
        yield return Step(b, "decrease-output-volume", "Decrease Output Volume",
            BridgeProtocol.Commands.DecreaseOutputVolume, 5);
        // Per-user 0–200 (100 = normal). User picked from the live call dropdown.
        yield return new UserSelectOptions(b, "set-user-volume", "Set User Volume",
            "Set a user's local volume (0–200).",
            BridgeProtocol.Commands.SetUserVolume,
            [P.User(), P.Slider("volume", "Volume", 0, 200, 100)],
            p => P.Args(("userId", P.V(ReqUser(p))), ("volume", P.V(Clamp(ParamRead.Num(p, "volume", 100), 0, 200)))));
        yield return UserStep(b, "increase-user-volume", "Increase User Volume",
            BridgeProtocol.Commands.IncreaseUserVolume);
        yield return UserStep(b, "decrease-user-volume", "Decrease User Volume",
            BridgeProtocol.Commands.DecreaseUserVolume);
        yield return new UserSelectOptions(b, "reset-user-volume", "Reset User Volume",
            "Reset a user's local volume to 100.",
            BridgeProtocol.Commands.ResetUserVolume,
            [P.User()],
            p => P.Args(("userId", P.V(ReqUser(p)))));
        yield return new UserSelectOptions(b, "toggle-user-local-mute", "Toggle User Local Mute",
            "Toggle a user's local mute.",
            BridgeProtocol.Commands.ToggleUserLocalMute,
            [P.User()],
            p => P.Args(("userId", P.V(ReqUser(p)))));
        yield return new UserSelectOptions(b, "set-user-local-mute", "Set User Local Mute",
            "Set a user's local mute explicitly.",
            BridgeProtocol.Commands.SetUserLocalMute,
            [P.User(), P.Toggle("muted", "Muted", false)],
            p => P.Args(("userId", P.V(ReqUser(p))), ("muted", P.V(ParamRead.Bool(p, "muted")))));
        // Attenuation 0–100.
        yield return new BridgeCommandAction(b, "set-attenuation-volume", "Set Attenuation Volume",
            "Set attenuation volume (0–100).",
            BridgeProtocol.Commands.SetAttenuationVolume,
            [P.Slider("volume", "Attenuation volume", 0, 100, 50)],
            p => P.Args(("volume", P.V(Clamp(ParamRead.Num(p, "volume", 50), 0, 100)))));
        yield return new BridgeCommandAction(b, "toggle-attenuation-while-speaking",
            "Toggle Attenuation While Speaking", "Toggle attenuation while speaking.",
            BridgeProtocol.Commands.ToggleAttenuationWhileSpeaking);
        yield return new BridgeCommandAction(b, "set-attenuation-while-speaking",
            "Set Attenuation While Speaking", "Set attenuation while speaking explicitly.",
            BridgeProtocol.Commands.SetAttenuationWhileSpeaking,
            [P.Toggle("enabled", "Enabled", false)],
            p => P.Args(("enabled", P.V(ParamRead.Bool(p, "enabled")))));
    }

    private static BridgeCommandAction Vol(BridgeService b, string id, string label,
        string cmd, string stateField, double dflt)
    {
        StateSpec State() => new(["level"], ["Level"],
            c => "level"); // single-state: host shows value via variables
        return new BridgeCommandAction(b, id, label, $"{label} (0–100).", cmd,
            [P.Slider("volume", "Volume", 0, 100, dflt)],
            p => P.Args(("volume", P.V(Clamp(ParamRead.Num(p, "volume", dflt), 0, 100)))), State());
    }

    private static BridgeCommandAction Step(BridgeService b, string id, string label,
        string cmd, double step)
    {
        return new BridgeCommandAction(b, id, label, $"{label} (default step {step}).", cmd,
            [P.Num("step", "Step", 1, 50, step)],
            p => P.Args(("step", P.V(ParamRead.Num(p, "step", step)))));
    }

    private static BridgeCommandAction UserStep(BridgeService b, string id, string label, string cmd)
    {
        return new UserSelectOptions(b, id, label, $"{label} (default step 10).", cmd,
            [P.User(), P.Num("step", "Step", 1, 100, 10)],
            p => P.Args(("userId", P.V(ReqUser(p))), ("step", P.V(ParamRead.Num(p, "step", 10)))));
    }

    private static string ReqUser(IReadOnlyDictionary<string, object> p)
    {
        var s = ParamRead.Str(p, "userId");
        if (string.IsNullOrEmpty(s)) throw new ArgumentException("User ID is required.");
        return s;
    }

    private static double Clamp(double v, double lo, double hi) =>
        Math.Min(hi, Math.Max(lo, v));
}

