// VoiceTextStageActions.cs — voice / text / stage groups.
// Dropdowns via IDynamicOptionsActionDefinition (optionsSourceIds
// "voice-channels" / "text-channels"); plain ID/name/path text params always
// available as fallback. Names are passed through verbatim — ambiguous names
// are the client's AMBIGUOUS error, never a local guess (§6.1).
using MacroDeck.Localization;
using MacroDeck.Sdk.Actions;
using DeckBridge.Core;

namespace DeckBridge.Plugin.Actions;

internal sealed class VoiceJoinOptions(BridgeService b, string id, string name, string command,
    Func<IReadOnlyDictionary<string, object>, System.Text.Json.Nodes.JsonObject?> args)
    : BridgeCommandAction(b, id, name, "Join a voice channel. Prefer the dropdown (ID); name/path on ambiguity → error with candidates.",
        command, [P.VoiceChannel(), P.Text("name", "Name", false), P.Text("guildName", "Guild name", false), P.Text("path", "Path (Guild / Category / Channel)", false)], args),
    IDynamicOptionsActionDefinition
{
    public Task<DynamicOptionsResult> GetDynamicOptionsAsync(
        DynamicOptionsContext context, CancellationToken cancellationToken)
        => Task.FromResult(ChannelOptions.Voice(BridgeSvc));
}

internal sealed class VoiceMoveOptions(BridgeService b, string id, string name, string command,
    Func<IReadOnlyDictionary<string, object>, System.Text.Json.Nodes.JsonObject?> args)
    : BridgeCommandAction(b, id, name, "Move to another voice channel. Prefer the dropdown (ID).",
        command, [P.VoiceChannel(), P.Text("name", "Name", false), P.Text("guildName", "Guild name", false), P.Text("path", "Path", false)], args),
    IDynamicOptionsActionDefinition
{
    public Task<DynamicOptionsResult> GetDynamicOptionsAsync(
        DynamicOptionsContext context, CancellationToken cancellationToken)
        => Task.FromResult(ChannelOptions.Voice(BridgeSvc));
}

internal sealed class TextSelectOptions(BridgeService b, string id, string name, string command,
    Func<IReadOnlyDictionary<string, object>, System.Text.Json.Nodes.JsonObject?> args)
    : BridgeCommandAction(b, id, name, "Select a text channel. Prefer the dropdown (ID).",
        command, [P.TextChannel(), P.Text("name", "Name", false), P.Text("guildName", "Guild name", false), P.Text("path", "Path", false)], args),
    IDynamicOptionsActionDefinition
{
    public Task<DynamicOptionsResult> GetDynamicOptionsAsync(
        DynamicOptionsContext context, CancellationToken cancellationToken)
        => Task.FromResult(ChannelOptions.Text(BridgeSvc));
}

internal static class ChannelOptions
{
    public static DynamicOptionsResult Voice(BridgeService b)
    {
        var list = b.Server?.Lists;
        if (list is null)
            return new DynamicOptionsResult
            { Error = L.T("Bridge not running"), Options = [], AllowsCustomValue = true };
        var opts = list.Guilds
            .SelectMany(g => g.Channels.Where(c => c.Type is "voice" or "stage")
                .Select(c => new ActionParameterOption
                { Value = c.Id, Label = L.T($"{g.Name} / {c.Name}") }))
            .Take(200).ToList();
        return new DynamicOptionsResult
        { Options = opts, AllowsCustomValue = true, CacheSeconds = 5 };
    }

    public static DynamicOptionsResult Text(BridgeService b)
    {
        var list = b.Server?.Lists;
        if (list is null)
            return new DynamicOptionsResult
            { Error = L.T("Bridge not running"), Options = [], AllowsCustomValue = true };
        var opts = list.Guilds
            .SelectMany(g => g.Channels.Where(c => c.Type == "text")
                .Select(c => new ActionParameterOption
                { Value = c.Id, Label = L.T($"{g.Name} / #{c.Name}") }))
            .Take(200).ToList();
        return new DynamicOptionsResult
        { Options = opts, AllowsCustomValue = true, CacheSeconds = 5 };
    }
}

internal static class VoiceActions
{
    private static StateSpec VoiceState() => new(["disconnected", "connected"], ["Disconnected", "Connected"],
        c => c.GetValue("voiceConnected", false) ? "connected" : "disconnected");

    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        yield return new VoiceJoinOptions(b, "join-voice-by-id", "Join Voice by ID",
            BridgeProtocol.Commands.JoinVoiceById,
            p => Req(p, "channelId", "channel ID",
                P.Args(("channelId", P.V(ParamRead.Str(p, "channelId"))), ("guildId", Opt(p, "guildId")))));
        yield return new VoiceJoinOptions(b, "join-voice-by-name", "Join Voice by Name",
            BridgeProtocol.Commands.JoinVoiceByName,
            p => Req(p, "name", "channel name",
                P.Args(("name", P.V(ParamRead.Str(p, "name"))), ("guildName", Opt(p, "guildName")))));
        yield return new VoiceJoinOptions(b, "join-voice-by-path", "Join Voice by Path",
            BridgeProtocol.Commands.JoinVoiceByPath,
            p => Req(p, "path", "channel path",
                P.Args(("path", P.V(ParamRead.Str(p, "path"))))));
        yield return new BridgeCommandAction(b, "leave-voice", "Leave Voice", "Leave the current voice channel.",
            BridgeProtocol.Commands.LeaveVoice, state: VoiceState());
        yield return new BridgeCommandAction(b, "disconnect-voice", "Disconnect Voice",
            "Force-disconnect voice (alias of leave).",
            BridgeProtocol.Commands.DisconnectVoice, state: VoiceState());
        yield return new VoiceMoveOptions(b, "move-voice-by-id", "Move Voice by ID",
            BridgeProtocol.Commands.MoveVoiceById,
            p => Req(p, "channelId", "channel ID", P.Args(("channelId", P.V(ParamRead.Str(p, "channelId"))))));
        yield return new VoiceMoveOptions(b, "move-voice-by-name", "Move Voice by Name",
            BridgeProtocol.Commands.MoveVoiceByName,
            p => Req(p, "name", "channel name",
                P.Args(("name", P.V(ParamRead.Str(p, "name"))), ("guildName", Opt(p, "guildName")))));
        yield return new VoiceMoveOptions(b, "move-voice-by-path", "Move Voice by Path",
            BridgeProtocol.Commands.MoveVoiceByPath,
            p => Req(p, "path", "channel path", P.Args(("path", P.V(ParamRead.Str(p, "path"))))));
        yield return new BridgeCommandAction(b, "rejoin-last-voice", "Rejoin Last Voice",
            "Rejoin the last voice channel (needs rejoinLastVoice).",
            BridgeProtocol.Commands.RejoinLastVoice, state: VoiceState());
        yield return new BridgeCommandAction(b, "cycle-voice-channel", "Cycle Voice Channel",
            "Cycle to next/previous voice channel.",
            BridgeProtocol.Commands.CycleVoiceChannel,
            [P.Choice("direction", "Direction", [("next", "Next"), ("prev", "Previous")], "next")],
            p => P.Args(("direction", P.V(ParamRead.Str(p, "direction", "next")))), VoiceState());
    }

    private static System.Text.Json.Nodes.JsonObject Req(
        IReadOnlyDictionary<string, object> p, string field, string what,
        System.Text.Json.Nodes.JsonObject args)
    {
        if (string.IsNullOrEmpty(ParamRead.Str(p, field)) && string.IsNullOrEmpty(ParamRead.Str(p, "channelId"))
            && string.IsNullOrEmpty(ParamRead.Str(p, "name")) && string.IsNullOrEmpty(ParamRead.Str(p, "path")))
            throw new ArgumentException($"Provide a {what} (dropdown, ID, name, or path).");
        return args;
    }

    private static System.Text.Json.Nodes.JsonNode? Opt(IReadOnlyDictionary<string, object> p, string field)
    {
        var s = ParamRead.Str(p, field);
        return string.IsNullOrEmpty(s) ? null : P.V(s);
    }
}

internal static class TextActions
{
    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        yield return new TextSelectOptions(b, "select-text-by-id", "Select Text by ID",
            BridgeProtocol.Commands.SelectTextById,
            p => Need(p, P.Args(("channelId", P.V(ParamRead.Str(p, "channelId"))))));
        yield return new TextSelectOptions(b, "select-text-by-name", "Select Text by Name",
            BridgeProtocol.Commands.SelectTextByName,
            p => Need(p, P.Args(("name", P.V(ParamRead.Str(p, "name"))), ("guildName", OptN(p, "guildName")))));
        yield return new TextSelectOptions(b, "select-text-by-path", "Select Text by Path",
            BridgeProtocol.Commands.SelectTextByPath,
            p => Need(p, P.Args(("path", P.V(ParamRead.Str(p, "path"))))));
        yield return new BridgeCommandAction(b, "select-last-text-channel", "Select Last Text Channel",
            "Go back to the previously selected text channel.",
            BridgeProtocol.Commands.SelectLastTextChannel);
        yield return new BridgeCommandAction(b, "cycle-text-channel", "Cycle Text Channel",
            "Cycle to next/previous text channel.",
            BridgeProtocol.Commands.CycleTextChannel,
            [P.Choice("direction", "Direction", [("next", "Next"), ("prev", "Previous")], "next")],
            p => P.Args(("direction", P.V(ParamRead.Str(p, "direction", "next")))));
        yield return new BridgeCommandAction(b, "mark-selected-channel-read", "Mark Selected Read",
            "Mark the selected text channel as read.",
            BridgeProtocol.Commands.MarkSelectedChannelRead);
    }

    private static System.Text.Json.Nodes.JsonObject Need(
        IReadOnlyDictionary<string, object> p, System.Text.Json.Nodes.JsonObject args)
    {
        foreach (var f in new[] { "channelId", "name", "path" })
            if (!string.IsNullOrEmpty(ParamRead.Str(p, f))) return args;
        throw new ArgumentException("Provide a channel (dropdown, ID, name, or path).");
    }

    private static System.Text.Json.Nodes.JsonNode? OptN(IReadOnlyDictionary<string, object> p, string f)
    {
        var s = ParamRead.Str(p, f);
        return string.IsNullOrEmpty(s) ? null : P.V(s);
    }
}

internal static class StageActions
{
    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        StateSpec Hand() => new(["lowered", "raised"], ["Hand lowered", "Hand raised"],
            c => c.GetValue<bool?>("stageHandRaised", null) == true ? "raised" : "lowered");
        StateSpec Speak() => new(["not-requested", "requested"], ["Not requested", "Speak requested"],
            c => c.GetValue<bool?>("stageSpeakRequested", null) == true ? "requested" : "not-requested");
        // Stage is best-effort; missing capability → UNSUPPORTED surfaced, never silent (§6.1).
        yield return new BridgeCommandAction(b, "stage-raise-hand", "Raise Hand", "Raise stage hand.",
            BridgeProtocol.Commands.StageRaiseHand, state: Hand());
        yield return new BridgeCommandAction(b, "stage-lower-hand", "Lower Hand", "Lower stage hand.",
            BridgeProtocol.Commands.StageLowerHand, state: Hand());
        yield return new BridgeCommandAction(b, "stage-toggle-hand", "Toggle Hand", "Toggle stage hand.",
            BridgeProtocol.Commands.StageToggleHand, state: Hand());
        yield return new BridgeCommandAction(b, "stage-request-to-speak", "Request to Speak", "Request to speak on stage.",
            BridgeProtocol.Commands.StageRequestToSpeak, state: Speak());
        yield return new BridgeCommandAction(b, "stage-cancel-speak-request", "Cancel Speak Request", "Cancel the speak request.",
            BridgeProtocol.Commands.StageCancelSpeakRequest, state: Speak());
    }
}

