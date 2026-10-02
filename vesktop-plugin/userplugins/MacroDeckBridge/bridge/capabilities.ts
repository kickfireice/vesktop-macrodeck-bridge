/**
 * capabilities.ts — Capability reporting (§8 + deliverable #10).
 * Macro Deck MUST NOT show an action unless its flag is true here.
 */
import { CAPABILITY_FLAGS, type CapabilityFlag } from "./protocol";
import { voiceAvailability } from "./adapters/voice";
import { channelListAvailability } from "./adapters/channel";
import { statusAvailability } from "./adapters/status";
import { volumeAvailability } from "./adapters/volume";
import { deviceAvailability } from "./adapters/device";
import { audioProcAvailability } from "./adapters/audioProc";
import { stageAvailability } from "./adapters/stage";

/** refresh_state / get_capabilities are always available when bridge is online. */
export function buildCapabilities(): { available: Record<string, boolean>; unavailableReasons: Record<string, string> } {
  const available: Record<string, boolean> = {};
  const unavailableReasons: Record<string, string> = {};
  for (const f of CAPABILITY_FLAGS) { available[f] = false; }

  const apply = (flags: Record<string, boolean>, reasons: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(flags)) {
      if (!(CAPABILITY_FLAGS as readonly string[]).includes(k)) continue;
      available[k] = !!v;
      if (!v && reasons[k]) unavailableReasons[k] = String(reasons[k]).slice(0, 80);
      else if (!v && !(k in unavailableReasons)) unavailableReasons[k] = "UNSUPPORTED";
      if (v) delete unavailableReasons[k];
    }
  };

  const voice = voiceAvailability();
  apply({
    mute: voice.mute, deafen: voice.deafen, speakerMute: voice.speakerMute,
    voiceJoin: voice.voiceJoin, voiceLeave: voice.voiceLeave, voiceMove: voice.voiceMove,
    rejoinLastVoice: voice.rejoinLastVoice, cycleVoiceChannel: voice.cycleVoiceChannel,
  }, voice.reasons);

  const ch = channelListAvailability();
  apply({
    channelList: ch.channelList, textChannelSelect: ch.textChannelSelect,
    cycleTextChannel: ch.cycleTextChannel, markChannelRead: ch.markChannelRead,
  }, ch.reason ? { channelList: ch.reason, textChannelSelect: ch.reason, cycleTextChannel: ch.reason, markChannelRead: ch.reason } : {});

  const st = statusAvailability();
  apply({ status: st.status, customStatus: st.customStatus }, st.reasons);

  const vol = volumeAvailability();
  apply({
    inputVolume: vol.inputVolume, outputVolume: vol.outputVolume,
    perUserVolume: vol.perUserVolume, userLocalMute: vol.userLocalMute, attenuation: vol.attenuation,
  }, vol.reasons);

  const dev = deviceAvailability();
  apply({ inputDeviceSelect: dev.inputDeviceSelect, outputDeviceSelect: dev.outputDeviceSelect, deviceList: dev.deviceList }, dev.reasons);

  const ap = audioProcAvailability();
  // speakerMute from audioProc is authoritative false; do not let voice override.
  apply({
    noiseSuppression: ap.noiseSuppression, echoCancellation: ap.echoCancellation,
    automaticGain: ap.automaticGain, qosHighPriority: ap.qosHighPriority,
    lowLatency: ap.lowLatency, attenuation: available.attenuation || ap.attenuation,
  }, ap.reasons);
  if (!ap.speakerMute) { available.speakerMute = false; unavailableReasons.speakerMute = ap.reasons.speakerMute ?? "UNSUPPORTED"; }

  const sg = stageAvailability();
  apply({ stageRaiseHand: sg.stageRaiseHand, stageRequestToSpeak: sg.stageRequestToSpeak }, sg.reasons);

  return { available, unavailableReasons };
}

/** command → required capability flag (§8 mapping hint). Undefined = always allowed. */
export const COMMAND_FLAG: Record<string, CapabilityFlag | null> = {
  refresh_state: null, get_capabilities: null, get_channel_list: null, get_device_list: null,
  toggle_mute: "mute", set_mute: "mute",
  toggle_deafen: "deafen", set_deafen: "deafen",
  toggle_mute_and_deafen: "mute",
  toggle_speaker_mute: "speakerMute", set_speaker_mute: "speakerMute",
  toggle_noise_suppression: "noiseSuppression", set_noise_suppression: "noiseSuppression",
  toggle_echo_cancellation: "echoCancellation", set_echo_cancellation: "echoCancellation",
  toggle_automatic_gain: "automaticGain", set_automatic_gain: "automaticGain",
  toggle_qos_high_priority: "qosHighPriority", set_qos_high_priority: "qosHighPriority",
  toggle_low_latency: "lowLatency", set_low_latency: "lowLatency",
  join_voice_by_id: "voiceJoin", join_voice_by_name: "voiceJoin", join_voice_by_path: "voiceJoin",
  leave_voice: "voiceLeave", disconnect_voice: "voiceLeave",
  move_voice_by_id: "voiceMove", move_voice_by_name: "voiceMove", move_voice_by_path: "voiceMove",
  rejoin_last_voice: "rejoinLastVoice", cycle_voice_channel: "cycleVoiceChannel",
  stage_raise_hand: "stageRaiseHand", stage_lower_hand: "stageRaiseHand", stage_toggle_hand: "stageRaiseHand",
  stage_request_to_speak: "stageRequestToSpeak", stage_cancel_speak_request: "stageRequestToSpeak",
  select_text_by_id: "textChannelSelect", select_text_by_name: "textChannelSelect",
  select_text_by_path: "textChannelSelect", select_last_text_channel: "textChannelSelect",
  cycle_text_channel: "cycleTextChannel", mark_selected_channel_read: "markChannelRead",
  set_status_online: "status", set_status_idle: "status", set_status_dnd: "status",
  set_status_invisible: "status", cycle_status: "status", toggle_dnd: "status", toggle_invisible: "status",
  set_custom_status: "customStatus", append_custom_status: "customStatus", clear_custom_status: "customStatus",
  set_input_device_by_id: "inputDeviceSelect", set_input_device_by_name: "inputDeviceSelect",
  cycle_input_device: "inputDeviceSelect",
  set_output_device_by_id: "outputDeviceSelect", set_output_device_by_name: "outputDeviceSelect",
  cycle_output_device: "outputDeviceSelect", refresh_audio_devices: "deviceList",
  set_input_volume: "inputVolume", increase_input_volume: "inputVolume", decrease_input_volume: "inputVolume",
  set_output_volume: "outputVolume", increase_output_volume: "outputVolume", decrease_output_volume: "outputVolume",
  set_user_volume: "perUserVolume", increase_user_volume: "perUserVolume",
  decrease_user_volume: "perUserVolume", reset_user_volume: "perUserVolume",
  toggle_user_local_mute: "userLocalMute", set_user_local_mute: "userLocalMute",
  set_attenuation_volume: "attenuation", toggle_attenuation_while_speaking: "attenuation",
  set_attenuation_while_speaking: "attenuation",
};

export function isFlagSupported(command: string, available: Record<string, boolean>): boolean {
  const flag = COMMAND_FLAG[command];
  if (flag === undefined) return false; // unknown command — caller maps to UNKNOWN_COMMAND
  if (flag === null) return true;
  return available[flag] === true;
}
