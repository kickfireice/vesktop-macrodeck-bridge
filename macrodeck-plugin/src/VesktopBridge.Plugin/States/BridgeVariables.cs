// BridgeVariables.cs — feedback state defs (deliverable #5).
// Every spec feedback state is an eager variable reading the in-memory cache.
// Types: Text / Numeric / Boolean. Null (unknown) → Unavailable reading.
// NOTE: Macro Deck 3 SDK requires local ids lowercase + hyphen-separated
// (e.g. 'server-status'), so all ids below are kebab-case. The Core
// state-cache keys (camelCase, e.g. st.Get("selfMuted")) are untouched.
using MacroDeck.Localization;
using MacroDeck.Sdk.Variables;
using DeckBridge.Core;

namespace DeckBridge.Plugin;

internal static class BridgeVariables
{
    private static VariableDefinition TextVar(string id, string display) =>
        VariableDefinition.Eager($"vesktop-{id}", VariableType.Text) with
        { Id = id, DisplayName = LocalizedText.FromLiteral(display) };

    private static VariableDefinition BoolVar(string id, string display) =>
        VariableDefinition.Eager($"vesktop-{id}", VariableType.Boolean) with
        { Id = id, DisplayName = LocalizedText.FromLiteral(display) };

    private static VariableDefinition NumVar(string id, string display, string? unit = null) =>
        VariableDefinition.Eager($"vesktop-{id}", VariableType.Numeric) with
        { Id = id, DisplayName = LocalizedText.FromLiteral(display), Unit = unit ?? "" };

    public static IReadOnlyList<VariableDefinition> Definitions { get; } =
    [
        // bridge / connection
        TextVar("server-status", "Bridge server status"),
        NumVar("actual-port", "Bridge actual port"),
        BoolVar("bridge-running", "Bridge running"),
        BoolVar("vesktop-connected", "Vesktop connected"),
        BoolVar("authenticated", "Authenticated"),
        BoolVar("discord-ready", "Discord ready"),
        TextVar("last-error", "Last error"),
        TextVar("protocol-version", "Protocol version"),
        TextVar("vesktop-plugin-version", "Vesktop plugin version"),
        BoolVar("read-only", "Read-only mode"),
        TextVar("client-name", "Client name"),
        TextVar("client-version", "Client version"),
        // voice
        BoolVar("muted", "Self muted"),
        BoolVar("deafened", "Self deafened"),
        BoolVar("server-muted", "Server muted"),
        BoolVar("server-deafened", "Server deafened"),
        BoolVar("voice-connected", "Voice connected"),
        BoolVar("voice-connecting", "Voice connecting"),
        TextVar("voice-channel-id", "Voice channel ID"),
        TextVar("voice-channel-name", "Voice channel name"),
        TextVar("voice-channel-path", "Voice channel path"),
        TextVar("voice-guild-id", "Voice guild ID"),
        TextVar("voice-guild-name", "Voice guild name"),
        TextVar("last-voice-channel-name", "Last voice channel name"),
        // text
        TextVar("text-channel-id", "Selected text channel ID"),
        TextVar("text-channel-name", "Selected text channel name"),
        TextVar("text-channel-path", "Selected text channel path"),
        TextVar("text-guild-id", "Selected guild ID"),
        TextVar("text-guild-name", "Selected guild name"),
        // status
        TextVar("user-status", "User status"),
        TextVar("custom-status-text", "Custom status text"),
        TextVar("custom-status-emoji", "Custom status emoji"),
        // audio
        NumVar("input-volume", "Input volume", "%"),
        NumVar("output-volume", "Output volume", "%"),
        TextVar("input-device-name", "Input device name"),
        TextVar("output-device-name", "Output device name"),
        BoolVar("noise-suppression", "Noise suppression enabled"),
        BoolVar("echo-cancellation", "Echo cancellation enabled"),
        BoolVar("automatic-gain", "Automatic gain enabled"),
        BoolVar("qos-high-priority", "QoS high priority enabled"),
        BoolVar("low-latency", "Low latency enabled"),
        BoolVar("speaker-muted", "Speaker muted"),
        NumVar("attenuation-volume", "Attenuation volume", "%"),
        BoolVar("attenuation-while-speaking", "Attenuation while speaking"),
        // stage
        BoolVar("stage-hand-raised", "Stage hand raised"),
        BoolVar("stage-speak-requested", "Stage speak requested"),
        BoolVar("stage-is-speaker", "Stage is speaker"),
        BoolVar("stage-channel-active", "Stage channel active"),
    ];

    public static IReadOnlyList<string> Ids { get; } =
        Definitions.Select(d => d.Id ?? "").Where(s => s.Length > 0).ToList();

    /// Returns null when unknown (→ Unavailable). Never throws, never logs secrets.
    public static object? Read(BridgeServer server, string id)
    {
        var st = server.State;
        return id switch
        {
            "server-status" => server.Running
                ? $"running 127.0.0.1:{server.ActualPort}" : "stopped",
            "actual-port" => (double)server.ActualPort,
            "bridge-running" => server.Running,
            "vesktop-connected" => st.IsLive && server.ActiveClient is not null,
            "authenticated" => st.GetValue("authenticated", false),
            "discord-ready" => st.GetValue("discordReady", false),
            "last-error" => NeedStr(st.Get("lastError")?.GetValue<string>()),
            "protocol-version" => BridgeProtocol.Version,
            "vesktop-plugin-version" => NeedStr(st.Get("vesktopPluginVersion")?.GetValue<string>()),
            "read-only" => st.GetValue("readOnly", false),
            "client-name" => NeedStr(server.ActiveClient?.ClientName),
            "client-version" => NeedStr(server.ActiveClient?.ClientVersion),
            "muted" => NeedBool(st.Get("selfMuted")),
            "deafened" => NeedBool(st.Get("selfDeafened")),
            "server-muted" => NeedBool(st.Get("serverMuted")),
            "server-deafened" => NeedBool(st.Get("serverDeafened")),
            "voice-connected" => st.GetValue("voiceConnected", false),
            "voice-connecting" => st.GetValue("voiceConnecting", false),
            "voice-channel-id" => NeedStr(st.Get("voiceChannelId")?.GetValue<string>()),
            "voice-channel-name" => NeedStr(st.Get("voiceChannelName")?.GetValue<string>()),
            "voice-channel-path" => NeedStr(st.Get("voiceChannelPath")?.GetValue<string>()),
            "voice-guild-id" => NeedStr(st.Get("voiceGuildId")?.GetValue<string>()),
            "voice-guild-name" => NeedStr(st.Get("voiceGuildName")?.GetValue<string>()),
            "last-voice-channel-name" => NeedStr(st.Get("lastVoiceChannelName")?.GetValue<string>()),
            "text-channel-id" => NeedStr(st.Get("selectedTextChannelId")?.GetValue<string>()),
            "text-channel-name" => NeedStr(st.Get("selectedTextChannelName")?.GetValue<string>()),
            "text-channel-path" => NeedStr(st.Get("selectedTextChannelPath")?.GetValue<string>()),
            "text-guild-id" => NeedStr(st.Get("selectedGuildId")?.GetValue<string>()),
            "text-guild-name" => NeedStr(st.Get("selectedGuildName")?.GetValue<string>()),
            "user-status" => st.GetValue("userStatus", "unknown"),
            "custom-status-text" => NeedStr(st.Get("customStatusText")?.GetValue<string>()),
            "custom-status-emoji" => NeedStr(st.Get("customStatusEmojiName")?.GetValue<string>()),
            "input-volume" => NeedNum(st.Get("inputVolume")),
            "output-volume" => NeedNum(st.Get("outputVolume")),
            "input-device-name" => NeedStr(st.Get("inputDeviceName")?.GetValue<string>()),
            "output-device-name" => NeedStr(st.Get("outputDeviceName")?.GetValue<string>()),
            "noise-suppression" => NeedBool(st.Get("noiseSuppressionEnabled")),
            "echo-cancellation" => NeedBool(st.Get("echoCancellationEnabled")),
            "automatic-gain" => NeedBool(st.Get("automaticGainEnabled")),
            "qos-high-priority" => NeedBool(st.Get("qosHighPriorityEnabled")),
            "low-latency" => NeedBool(st.Get("lowLatencyEnabled")),
            "speaker-muted" => NeedBool(st.Get("speakerMuted")),
            "attenuation-volume" => NeedNum(st.Get("attenuationVolume")),
            "attenuation-while-speaking" => NeedBool(st.Get("attenuationWhileSpeakingEnabled")),
            "stage-hand-raised" => NeedBool(st.Get("stageHandRaised")),
            "stage-speak-requested" => NeedBool(st.Get("stageSpeakRequested")),
            "stage-is-speaker" => NeedBool(st.Get("stageIsSpeaker")),
            "stage-channel-active" => st.GetValue("stageChannelActive", false),
            _ => null,
        };
    }

    private static object? NeedStr(string? s) =>
        string.IsNullOrEmpty(s) ? null : s;

    private static object? NeedBool(System.Text.Json.Nodes.JsonNode? n)
    {
        try { return n is null ? null : (object?)n.GetValue<bool>(); }
        catch { return null; }
    }

    private static object? NeedNum(System.Text.Json.Nodes.JsonNode? n)
    {
        try
        {
            if (n is null) return null;
            return (object?)n.GetValue<double>();
        }
        catch { return null; }
    }
}
