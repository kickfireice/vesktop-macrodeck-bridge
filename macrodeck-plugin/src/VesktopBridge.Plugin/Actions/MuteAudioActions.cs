// MuteActions.cs + AudioProcActions.cs — mute/deafen + audio processing groups.
// If a capability is missing the dispatcher reports UNAVAILABLE (never silent).
using MacroDeck.Sdk.Actions;
using DeckBridge.Core;

namespace DeckBridge.Plugin.Actions;

internal static class MuteActions
{
    private static StateSpec MuteState() => new(["unmuted", "muted"], ["Unmuted", "Muted"],
        c => c.GetValue<bool?>("selfMuted", null) == true ? "muted" : "unmuted");
    private static StateSpec DeafenState() => new(["undeafened", "deafened"], ["Undeafened", "Deafened"],
        c => c.GetValue<bool?>("selfDeafened", null) == true ? "deafened" : "undeafened");
    private static StateSpec SpeakerState() => new(["speaker-on", "speaker-off"], ["Speaker on", "Speaker off"],
        c => c.GetValue<bool?>("speakerMuted", null) == true ? "speaker-off" : "speaker-on");

    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        yield return new BridgeCommandAction(b, "toggle-mute", "Toggle Mute", "Toggle self mute.",
            BridgeProtocol.Commands.ToggleMute, state: MuteState());
        yield return new BridgeCommandAction(b, "set-mute", "Set Mute", "Set self mute explicitly.",
            BridgeProtocol.Commands.SetMute,
            [P.Toggle("muted", "Muted", false)],
            p => P.Args(("muted", P.V(ParamRead.Bool(p, "muted")))), MuteState());
        yield return new BridgeCommandAction(b, "toggle-deafen", "Toggle Deafen", "Toggle self deafen.",
            BridgeProtocol.Commands.ToggleDeafen, state: DeafenState());
        yield return new BridgeCommandAction(b, "set-deafen", "Set Deafen", "Set self deafen explicitly.",
            BridgeProtocol.Commands.SetDeafen,
            [P.Toggle("deafened", "Deafened", false)],
            p => P.Args(("deafened", P.V(ParamRead.Bool(p, "deafened")))), DeafenState());
        yield return new BridgeCommandAction(b, "toggle-mute-and-deafen", "Toggle Mute and Deafen",
            "Toggle mute and deafen together.",
            BridgeProtocol.Commands.ToggleMuteAndDeafen, state: MuteState());
        yield return new BridgeCommandAction(b, "toggle-speaker-mute", "Toggle Speaker Mute",
            "Toggle output/speaker mute (speakerMute capability; else UNSUPPORTED).",
            BridgeProtocol.Commands.ToggleSpeakerMute, state: SpeakerState());
        yield return new BridgeCommandAction(b, "set-speaker-mute", "Set Speaker Mute",
            "Set output/speaker mute explicitly.",
            BridgeProtocol.Commands.SetSpeakerMute,
            [P.Toggle("muted", "Muted", false)],
            p => P.Args(("muted", P.V(ParamRead.Bool(p, "muted")))), SpeakerState());
    }
}

internal static class AudioProcActions
{
    private static StateSpec Flag(string field, string on, string off) =>
        new(["disabled", "enabled"], ["Disabled", "Enabled"],
            c => c.GetValue<bool?>(field, null) == true ? "enabled" : "disabled");

    public static IEnumerable<IActionDefinition> All(BridgeService b)
    {
        foreach (var a in ToggleSet(b, "noise-suppression", "Noise Suppression",
            BridgeProtocol.Commands.ToggleNoiseSuppression, BridgeProtocol.Commands.SetNoiseSuppression,
            "noiseSuppressionEnabled")) yield return a;
        foreach (var a in ToggleSet(b, "echo-cancellation", "Echo Cancellation",
            BridgeProtocol.Commands.ToggleEchoCancellation, BridgeProtocol.Commands.SetEchoCancellation,
            "echoCancellationEnabled")) yield return a;
        foreach (var a in ToggleSet(b, "automatic-gain", "Automatic Gain",
            BridgeProtocol.Commands.ToggleAutomaticGain, BridgeProtocol.Commands.SetAutomaticGain,
            "automaticGainEnabled")) yield return a;
        foreach (var a in ToggleSet(b, "qos-high-priority", "QoS High Priority",
            BridgeProtocol.Commands.ToggleQosHighPriority, BridgeProtocol.Commands.SetQosHighPriority,
            "qosHighPriorityEnabled")) yield return a;
        foreach (var a in ToggleSet(b, "low-latency", "Low Latency",
            BridgeProtocol.Commands.ToggleLowLatency, BridgeProtocol.Commands.SetLowLatency,
            "lowLatencyEnabled")) yield return a;
    }

    private static IEnumerable<IActionDefinition> ToggleSet(BridgeService b, string slug,
        string label, string toggleCmd, string setCmd, string stateField)
    {
        yield return new BridgeCommandAction(b, $"toggle-{slug}", $"Toggle {label}",
            $"Toggle {label}.", toggleCmd, state: Flag(stateField, label, label));
        yield return new BridgeCommandAction(b, $"set-{slug}", $"Set {label}",
            $"Set {label} explicitly.", setCmd,
            [P.Toggle("enabled", "Enabled", false)],
            p => P.Args(("enabled", P.V(ParamRead.Bool(p, "enabled")))), Flag(stateField, label, label));
    }
}

