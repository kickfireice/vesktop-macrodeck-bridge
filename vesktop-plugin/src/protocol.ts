/**
 * protocol.ts — Shared protocol v1.0.0 implementation (client side).
 * Mirrors vesktop-plugin/PROTOCOL.md (identical copy in macrodeck-plugin/PROTOCOL.md).
 * Do NOT invent message names / state fields / capability flags outside this file.
 */

// ---------------------------------------------------------------- normative consts
export const PROTOCOL_VERSION = "1.0.0";
export const SUPPORTED_VERSIONS = ["1.0.0"];
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8323;
export const MAX_MESSAGE_BYTES = 65536; // 64 KB
export const HELLO_TIMEOUT_MS = 5000;
export const DEFAULT_HEARTBEAT_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 15000;
export const SIMPLE_CMD_TIMEOUT_MS = 3000;
export const VOICE_CMD_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------- envelope types
export type EnvelopeTypeClientOut =
  | "hello" | "heartbeat" | "state_snapshot" | "state_update"
  | "capability_update" | "command_result"
  | "error" | "device_list_update" | "channel_list_update";

export type EnvelopeTypeServerIn =
  | "welcome" | "heartbeat_request" | "get_state" | "command"
  | "request_capabilities" | "request_channel_list" | "request_device_list"
  | "error";

export interface Envelope {
  v: string;
  type: string;
  id?: string;
  replyTo?: string;
  ts: number;
  sid?: string;
  payload: Record<string, any>;
}

export function nowMs(): number { return Date.now(); }

export function uuidv4(): string {
  // RFC4122 v4 — no external dep; Math.random is fine for ids (NOT for tokens/sids).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function utf8Size(s: string): number {
  // Accurate UTF-8 byte length without Node Buffer (works in Vesktop renderer).
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export function makeEnvelope(
  type: string, payload: Record<string, any>,
  opts: { id?: string; replyTo?: string; sid?: string } = {}
): Envelope {
  const env: Envelope = { v: PROTOCOL_VERSION, type, ts: nowMs(), payload };
  if (opts.id) env.id = opts.id;
  if (opts.replyTo) env.replyTo = opts.replyTo;
  if (opts.sid) env.sid = opts.sid;
  return env;
}

// ---------------------------------------------------------------- validation (receive path)
export interface ValidationOk { ok: true; env: Envelope; }
export interface ValidationErr { ok: false; code: string; message: string; }
export type Validation = ValidationOk | ValidationErr;

const KNOWN_SERVER_TYPES = new Set<string>([
  "welcome", "heartbeat_request", "get_state", "command",
  "request_capabilities", "request_channel_list", "request_device_list", "error",
]);

export function validateInbound(raw: string): Validation {
  if (utf8Size(raw) > MAX_MESSAGE_BYTES)
    return { ok: false, code: "TOO_LARGE", message: "message exceeds 64KB" };
  let obj: any;
  try { obj = JSON.parse(raw); }
  catch { return { ok: false, code: "SCHEMA_INVALID", message: "invalid JSON" }; }
  if (typeof obj !== "object" || obj === null)
    return { ok: false, code: "SCHEMA_INVALID", message: "envelope must be object" };
  if (obj.v !== PROTOCOL_VERSION)
    return { ok: false, code: "VERSION_MISMATCH", message: `unsupported protocol v=${String(obj.v)}` };
  if (typeof obj.type !== "string" || !KNOWN_SERVER_TYPES.has(obj.type))
    return { ok: false, code: "UNKNOWN_TYPE", message: `unknown type ${String(obj.type)}` };
  if (typeof obj.ts !== "number")
    return { ok: false, code: "SCHEMA_INVALID", message: "missing/invalid ts" };
  if (Math.abs(Date.now() - obj.ts) > 60000)
    return { ok: false, code: "SCHEMA_INVALID", message: "clock skew >60s" };
  if (typeof obj.payload !== "object" || obj.payload === null)
    return { ok: false, code: "SCHEMA_INVALID", message: "missing/invalid payload" };
  if ((obj.type === "command" || obj.type === "get_state") && typeof obj.id !== "string")
    return { ok: false, code: "SCHEMA_INVALID", message: "id required for command/get_state" };
  return { ok: true, env: obj as Envelope };
}

// ---------------------------------------------------------------- §7 State model (ALL fields, null where unknown)
export type UserStatus = "online" | "idle" | "dnd" | "invisible" | "unknown";

export interface State {
  pluginConnected: boolean; authenticated: boolean; discordReady: boolean;
  bridgeRunning: boolean; lastError: string | null;
  protocolVersion: "1.0.0"; vesktopPluginVersion: string | null;
  readOnly: boolean;
  selfMuted: boolean | null; selfDeafened: boolean | null;
  serverMuted: boolean | null; serverDeafened: boolean | null;
  voiceConnected: boolean; voiceConnecting: boolean;
  voiceChannelId: string | null; voiceChannelName: string | null;
  voiceChannelPath: string | null; voiceGuildId: string | null; voiceGuildName: string | null;
  lastVoiceChannelId: string | null; lastVoiceChannelName: string | null;
  selectedTextChannelId: string | null; selectedTextChannelName: string | null;
  selectedTextChannelPath: string | null; selectedGuildId: string | null; selectedGuildName: string | null;
  userStatus: UserStatus;
  customStatusText: string | null; customStatusEmojiName: string | null;
  inputVolume: number | null; outputVolume: number | null;
  inputDeviceId: string | null; inputDeviceName: string | null;
  outputDeviceId: string | null; outputDeviceName: string | null;
  noiseSuppressionEnabled: boolean | null; echoCancellationEnabled: boolean | null;
  automaticGainEnabled: boolean | null; qosHighPriorityEnabled: boolean | null;
  lowLatencyEnabled: boolean | null; speakerMuted: boolean | null;
  attenuationVolume: number | null; attenuationWhileSpeakingEnabled: boolean | null;
  stageHandRaised: boolean | null; stageSpeakRequested: boolean | null;
  stageIsSpeaker: boolean | null; stageChannelActive: boolean;
  availableCapabilities: Record<string, boolean>;
  unavailableReasons: Record<string, string>;
}

export function emptyState(pluginVersion: string): State {
  return {
    pluginConnected: true, authenticated: false, discordReady: false,
    bridgeRunning: false, lastError: null,
    protocolVersion: "1.0.0", vesktopPluginVersion: pluginVersion,
    readOnly: false,
    selfMuted: null, selfDeafened: null, serverMuted: null, serverDeafened: null,
    voiceConnected: false, voiceConnecting: false,
    voiceChannelId: null, voiceChannelName: null, voiceChannelPath: null,
    voiceGuildId: null, voiceGuildName: null,
    lastVoiceChannelId: null, lastVoiceChannelName: null,
    selectedTextChannelId: null, selectedTextChannelName: null,
    selectedTextChannelPath: null, selectedGuildId: null, selectedGuildName: null,
    userStatus: "unknown", customStatusText: null, customStatusEmojiName: null,
    inputVolume: null, outputVolume: null,
    inputDeviceId: null, inputDeviceName: null, outputDeviceId: null, outputDeviceName: null,
    noiseSuppressionEnabled: null, echoCancellationEnabled: null,
    automaticGainEnabled: null, qosHighPriorityEnabled: null,
    lowLatencyEnabled: null, speakerMuted: null,
    attenuationVolume: null, attenuationWhileSpeakingEnabled: null,
    stageHandRaised: null, stageSpeakRequested: null, stageIsSpeaker: null, stageChannelActive: false,
    availableCapabilities: {}, unavailableReasons: {},
  };
}

export interface Device { id: string; name: string; kind: "input" | "output"; isDefault: boolean; }
export interface ChannelNode {
  id: string; name: string;
  type: "text" | "voice" | "stage" | "category"; parentId?: string; path: string;
}
export interface Guild { id: string; name: string; channels: ChannelNode[]; }

// ---------------------------------------------------------------- §8 capability flags (normative, exact strings)
export const CAPABILITY_FLAGS = [
  "mute", "deafen", "speakerMute",
  "noiseSuppression", "echoCancellation", "automaticGain", "qosHighPriority", "lowLatency",
  "voiceJoin", "voiceLeave", "voiceMove", "rejoinLastVoice", "cycleVoiceChannel",
  "stageRaiseHand", "stageRequestToSpeak",
  "textChannelSelect", "cycleTextChannel", "markChannelRead",
  "status", "customStatus",
  "inputDeviceSelect", "outputDeviceSelect",
  "inputVolume", "outputVolume", "perUserVolume", "userLocalMute", "attenuation",
  "channelList", "deviceList",
] as const;
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];

// ---------------------------------------------------------------- §6 command names (normative, exact strings)
export const COMMANDS = [
  "refresh_state", "get_capabilities", "get_channel_list", "get_device_list",
  "toggle_mute", "set_mute", "toggle_deafen", "set_deafen",
  "toggle_mute_and_deafen", "toggle_speaker_mute", "set_speaker_mute",
  "toggle_noise_suppression", "set_noise_suppression",
  "toggle_echo_cancellation", "set_echo_cancellation",
  "toggle_automatic_gain", "set_automatic_gain",
  "toggle_qos_high_priority", "set_qos_high_priority",
  "toggle_low_latency", "set_low_latency",
  "join_voice_by_id", "join_voice_by_name", "join_voice_by_path",
  "leave_voice", "disconnect_voice",
  "move_voice_by_id", "move_voice_by_name", "move_voice_by_path",
  "rejoin_last_voice", "cycle_voice_channel",
  "stage_raise_hand", "stage_lower_hand", "stage_toggle_hand",
  "stage_request_to_speak", "stage_cancel_speak_request",
  "select_text_by_id", "select_text_by_name", "select_text_by_path",
  "select_last_text_channel", "cycle_text_channel", "mark_selected_channel_read",
  "set_status_online", "set_status_idle", "set_status_dnd", "set_status_invisible",
  "cycle_status", "toggle_dnd", "toggle_invisible",
  "set_custom_status", "append_custom_status", "clear_custom_status",
  "set_input_device_by_id", "set_input_device_by_name", "cycle_input_device",
  "set_output_device_by_id", "set_output_device_by_name", "cycle_output_device",
  "refresh_audio_devices",
  "set_input_volume", "increase_input_volume", "decrease_input_volume",
  "set_output_volume", "increase_output_volume", "decrease_output_volume",
  "set_user_volume", "increase_user_volume", "decrease_user_volume", "reset_user_volume",
  "toggle_user_local_mute", "set_user_local_mute",
  "set_attenuation_volume", "toggle_attenuation_while_speaking", "set_attenuation_while_speaking",
] as const;

// Commands that are pure getters (allowed in readOnly mode).
export const READONLY_SAFE_COMMANDS = new Set<string>([
  "refresh_state", "get_capabilities", "get_channel_list", "get_device_list",
]);
