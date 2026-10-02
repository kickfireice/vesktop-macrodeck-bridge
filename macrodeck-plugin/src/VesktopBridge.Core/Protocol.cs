// Protocol.cs — normative constants from PROTOCOL.md v1.0.0.
// Single source of truth mirror: do NOT change names without updating PROTOCOL.md
// in BOTH macrodeck-plugin/ and vesktop-plugin/.
namespace DeckBridge.Core;

public static class BridgeProtocol
{
    public const string Version = "1.0.0";
    public static readonly string[] SupportedVersions = ["1.0.0"];
    public const string DefaultHost = "127.0.0.1";
    public const int DefaultPort = 8323;
    public const int MaxMessageBytes = 65536; // 64 KB UTF-8
    public const int HeartbeatIntervalMs = 5000;
    public const int HeartbeatTimeoutMs = 15000;
    public const int HelloTimeoutMs = 5000;
    public const long MaxClockSkewMs = 60_000;
    public const double SustainedMsgPerSec = 20.0;
    public const int BurstLimit = 50;
    public const int PendingQueueMax = 32;
    public const int CommandTimeoutMs = 3000;
    public const int VoiceCommandTimeoutMs = 10000;
    public const int AuthFailMax = 5;
    public const int AuthFailWindowSec = 60;
    public const int AuthBlockSec = 60;
    public const int DebounceMsMin = 100;
    public const int DebounceMsMax = 250;

    // §5.1 client→server
    public static class ClientMsg
    {
        public const string Hello = "hello";
        public const string Heartbeat = "heartbeat";
        public const string StateSnapshot = "state_snapshot";
        public const string StateUpdate = "state_update";
        public const string CapabilityUpdate = "capability_update";
        public const string CommandResult = "command_result";
        public const string Error = "error";
        public const string DeviceListUpdate = "device_list_update";
        public const string ChannelListUpdate = "channel_list_update";
    }

    // §5.2 server→client
    public static class ServerMsg
    {
        public const string Welcome = "welcome";
        public const string HeartbeatRequest = "heartbeat_request";
        public const string GetState = "get_state";
        public const string Command = "command";
        public const string RequestCapabilities = "request_capabilities";
        public const string RequestChannelList = "request_channel_list";
        public const string RequestDeviceList = "request_device_list";
        public const string Error = "error";
    }

    // §6.1 normative command names — use exactly.
    public static class Commands
    {
        public const string RefreshState = "refresh_state";
        public const string GetCapabilities = "get_capabilities";
        public const string GetChannelList = "get_channel_list";
        public const string GetDeviceList = "get_device_list";

        public const string ToggleMute = "toggle_mute";
        public const string SetMute = "set_mute";
        public const string ToggleDeafen = "toggle_deafen";
        public const string SetDeafen = "set_deafen";
        public const string ToggleMuteAndDeafen = "toggle_mute_and_deafen";
        public const string ToggleSpeakerMute = "toggle_speaker_mute";
        public const string SetSpeakerMute = "set_speaker_mute";

        public const string ToggleNoiseSuppression = "toggle_noise_suppression";
        public const string SetNoiseSuppression = "set_noise_suppression";
        public const string ToggleEchoCancellation = "toggle_echo_cancellation";
        public const string SetEchoCancellation = "set_echo_cancellation";
        public const string ToggleAutomaticGain = "toggle_automatic_gain";
        public const string SetAutomaticGain = "set_automatic_gain";
        public const string ToggleQosHighPriority = "toggle_qos_high_priority";
        public const string SetQosHighPriority = "set_qos_high_priority";
        public const string ToggleLowLatency = "toggle_low_latency";
        public const string SetLowLatency = "set_low_latency";

        public const string JoinVoiceById = "join_voice_by_id";
        public const string JoinVoiceByName = "join_voice_by_name";
        public const string JoinVoiceByPath = "join_voice_by_path";
        public const string LeaveVoice = "leave_voice";
        public const string DisconnectVoice = "disconnect_voice";
        public const string MoveVoiceById = "move_voice_by_id";
        public const string MoveVoiceByName = "move_voice_by_name";
        public const string MoveVoiceByPath = "move_voice_by_path";
        public const string RejoinLastVoice = "rejoin_last_voice";
        public const string CycleVoiceChannel = "cycle_voice_channel";

        public const string StageRaiseHand = "stage_raise_hand";
        public const string StageLowerHand = "stage_lower_hand";
        public const string StageToggleHand = "stage_toggle_hand";
        public const string StageRequestToSpeak = "stage_request_to_speak";
        public const string StageCancelSpeakRequest = "stage_cancel_speak_request";

        public const string SelectTextById = "select_text_by_id";
        public const string SelectTextByName = "select_text_by_name";
        public const string SelectTextByPath = "select_text_by_path";
        public const string SelectLastTextChannel = "select_last_text_channel";
        public const string CycleTextChannel = "cycle_text_channel";
        public const string MarkSelectedChannelRead = "mark_selected_channel_read";

        public const string SetStatusOnline = "set_status_online";
        public const string SetStatusIdle = "set_status_idle";
        public const string SetStatusDnd = "set_status_dnd";
        public const string SetStatusInvisible = "set_status_invisible";
        public const string CycleStatus = "cycle_status";
        public const string ToggleDnd = "toggle_dnd";
        public const string ToggleInvisible = "toggle_invisible";
        public const string SetCustomStatus = "set_custom_status";
        public const string AppendCustomStatus = "append_custom_status";
        public const string ClearCustomStatus = "clear_custom_status";

        public const string SetInputDeviceById = "set_input_device_by_id";
        public const string SetInputDeviceByName = "set_input_device_by_name";
        public const string CycleInputDevice = "cycle_input_device";
        public const string SetOutputDeviceById = "set_output_device_by_id";
        public const string SetOutputDeviceByName = "set_output_device_by_name";
        public const string CycleOutputDevice = "cycle_output_device";
        public const string RefreshAudioDevices = "refresh_audio_devices";

        public const string SetInputVolume = "set_input_volume";
        public const string IncreaseInputVolume = "increase_input_volume";
        public const string DecreaseInputVolume = "decrease_input_volume";
        public const string SetOutputVolume = "set_output_volume";
        public const string IncreaseOutputVolume = "increase_output_volume";
        public const string DecreaseOutputVolume = "decrease_output_volume";
        public const string SetUserVolume = "set_user_volume";
        public const string IncreaseUserVolume = "increase_user_volume";
        public const string DecreaseUserVolume = "decrease_user_volume";
        public const string ResetUserVolume = "reset_user_volume";
        public const string ToggleUserLocalMute = "toggle_user_local_mute";
        public const string SetUserLocalMute = "set_user_local_mute";
        public const string SetAttenuationVolume = "set_attenuation_volume";
        public const string ToggleAttenuationWhileSpeaking = "toggle_attenuation_while_speaking";
        public const string SetAttenuationWhileSpeaking = "set_attenuation_while_speaking";

        public static bool IsVoiceCommand(string cmd) =>
            cmd is JoinVoiceById or JoinVoiceByName or JoinVoiceByPath
                or MoveVoiceById or MoveVoiceByName or MoveVoiceByPath;

        public static int TimeoutFor(string cmd) =>
            IsVoiceCommand(cmd) ? VoiceCommandTimeoutMs : CommandTimeoutMs;
    }

    // §8 normative capability flags — use exactly.
    public static class Caps
    {
        public const string Mute = "mute";
        public const string Deafen = "deafen";
        public const string SpeakerMute = "speakerMute";
        public const string NoiseSuppression = "noiseSuppression";
        public const string EchoCancellation = "echoCancellation";
        public const string AutomaticGain = "automaticGain";
        public const string QosHighPriority = "qosHighPriority";
        public const string LowLatency = "lowLatency";
        public const string VoiceJoin = "voiceJoin";
        public const string VoiceLeave = "voiceLeave";
        public const string VoiceMove = "voiceMove";
        public const string RejoinLastVoice = "rejoinLastVoice";
        public const string CycleVoiceChannel = "cycleVoiceChannel";
        public const string StageRaiseHand = "stageRaiseHand";
        public const string StageRequestToSpeak = "stageRequestToSpeak";
        public const string TextChannelSelect = "textChannelSelect";
        public const string CycleTextChannel = "cycleTextChannel";
        public const string MarkChannelRead = "markChannelRead";
        public const string Status = "status";
        public const string CustomStatus = "customStatus";
        public const string InputDeviceSelect = "inputDeviceSelect";
        public const string OutputDeviceSelect = "outputDeviceSelect";
        public const string InputVolume = "inputVolume";
        public const string OutputVolume = "outputVolume";
        public const string PerUserVolume = "perUserVolume";
        public const string UserLocalMute = "userLocalMute";
        public const string Attenuation = "attenuation";
        public const string ChannelList = "channelList";
        public const string DeviceList = "deviceList";

        public static readonly string[] All =
        [
            Mute, Deafen, SpeakerMute, NoiseSuppression, EchoCancellation,
            AutomaticGain, QosHighPriority, LowLatency, VoiceJoin, VoiceLeave,
            VoiceMove, RejoinLastVoice, CycleVoiceChannel, StageRaiseHand,
            StageRequestToSpeak, TextChannelSelect, CycleTextChannel,
            MarkChannelRead, Status, CustomStatus, InputDeviceSelect,
            OutputDeviceSelect, InputVolume, OutputVolume, PerUserVolume,
            UserLocalMute, Attenuation, ChannelList, DeviceList,
        ];

        // command → required flag (null = always available). §8 mapping hint.
        public static string? RequiredFlag(string command) => command switch
        {
            Commands.ToggleMute or Commands.SetMute => Mute,
            Commands.ToggleDeafen or Commands.SetDeafen => Deafen,
            Commands.ToggleMuteAndDeafen => Mute, // needs mute; deafen checked too by dispatcher
            Commands.ToggleSpeakerMute or Commands.SetSpeakerMute => SpeakerMute,
            Commands.ToggleNoiseSuppression or Commands.SetNoiseSuppression => NoiseSuppression,
            Commands.ToggleEchoCancellation or Commands.SetEchoCancellation => EchoCancellation,
            Commands.ToggleAutomaticGain or Commands.SetAutomaticGain => AutomaticGain,
            Commands.ToggleQosHighPriority or Commands.SetQosHighPriority => QosHighPriority,
            Commands.ToggleLowLatency or Commands.SetLowLatency => LowLatency,
            Commands.JoinVoiceById or Commands.JoinVoiceByName or Commands.JoinVoiceByPath => VoiceJoin,
            Commands.LeaveVoice or Commands.DisconnectVoice => VoiceLeave,
            Commands.MoveVoiceById or Commands.MoveVoiceByName or Commands.MoveVoiceByPath => VoiceMove,
            Commands.RejoinLastVoice => RejoinLastVoice,
            Commands.CycleVoiceChannel => CycleVoiceChannel,
            Commands.StageRaiseHand or Commands.StageLowerHand or Commands.StageToggleHand => StageRaiseHand,
            Commands.StageRequestToSpeak or Commands.StageCancelSpeakRequest => StageRequestToSpeak,
            Commands.SelectTextById or Commands.SelectTextByName or Commands.SelectTextByPath
                or Commands.SelectLastTextChannel => TextChannelSelect,
            Commands.CycleTextChannel => CycleTextChannel,
            Commands.MarkSelectedChannelRead => MarkChannelRead,
            Commands.SetStatusOnline or Commands.SetStatusIdle or Commands.SetStatusDnd
                or Commands.SetStatusInvisible or Commands.CycleStatus
                or Commands.ToggleDnd or Commands.ToggleInvisible => Status,
            Commands.SetCustomStatus or Commands.AppendCustomStatus or Commands.ClearCustomStatus => CustomStatus,
            Commands.SetInputDeviceById or Commands.SetInputDeviceByName or Commands.CycleInputDevice => InputDeviceSelect,
            Commands.SetOutputDeviceById or Commands.SetOutputDeviceByName or Commands.CycleOutputDevice => OutputDeviceSelect,
            Commands.RefreshAudioDevices => DeviceList,
            Commands.SetInputVolume or Commands.IncreaseInputVolume or Commands.DecreaseInputVolume => InputVolume,
            Commands.SetOutputVolume or Commands.IncreaseOutputVolume or Commands.DecreaseOutputVolume => OutputVolume,
            Commands.SetUserVolume or Commands.IncreaseUserVolume or Commands.DecreaseUserVolume
                or Commands.ResetUserVolume => PerUserVolume,
            Commands.ToggleUserLocalMute or Commands.SetUserLocalMute => UserLocalMute,
            Commands.SetAttenuationVolume or Commands.ToggleAttenuationWhileSpeaking
                or Commands.SetAttenuationWhileSpeaking => Attenuation,
            Commands.GetChannelList => ChannelList,
            Commands.GetDeviceList => DeviceList,
            Commands.RefreshState or Commands.GetCapabilities => null, // always available
            _ => null, // unknown commands → UNKNOWN_COMMAND (not capability-gated)
        };
    }

    // §10 normative error codes — use exactly.
    public static class Errors
    {
        public const string AuthFailed = "AUTH_FAILED";
        public const string AlreadyConnected = "ALREADY_CONNECTED";
        public const string SessionReplaced = "SESSION_REPLACED";
        public const string TokenRevoked = "TOKEN_REVOKED";
        public const string VersionMismatch = "VERSION_MISMATCH";
        public const string UnknownType = "UNKNOWN_TYPE";
        public const string SchemaInvalid = "SCHEMA_INVALID";
        public const string TooLarge = "TOO_LARGE";
        public const string RateLimited = "RATE_LIMITED";
        public const string UnknownCommand = "UNKNOWN_COMMAND";
        public const string Unsupported = "UNSUPPORTED";
        public const string Ambiguous = "AMBIGUOUS";
        public const string NotFound = "NOT_FOUND";
        public const string ReadOnly = "READ_ONLY";
        public const string Timeout = "TIMEOUT";
        public const string VoiceError = "VOICE_ERROR";
        public const string PermissionDenied = "PERMISSION_DENIED";
        public const string DiscordNotReady = "DISCORD_NOT_READY";
        public const string InternalError = "INTERNAL_ERROR";
        public const string ChannelFull = "CHANNEL_FULL";
        public const string AlreadyInChannel = "ALREADY_IN_CHANNEL";
        // Local-only (never sent on wire as protocol errors, used for UI):
        public const string NotConnected = "NOT_CONNECTED";
        public const string NotAuthenticated = "NOT_AUTHENTICATED";
    }
}
