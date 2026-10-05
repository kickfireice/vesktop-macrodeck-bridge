/**
 * commands.ts — Command handler (§6 + deliverable #9).
 * Every command gets exactly one command_result. Unknown → UNKNOWN_COMMAND,
 * missing capability → UNSUPPORTED, readOnly mutating → READ_ONLY.
 */
import { READONLY_SAFE_COMMANDS } from "./protocol";
import { buildCapabilities, isFlagSupported, COMMAND_FLAG } from "./capabilities";
import { VoiceAdapter } from "./adapters/voice";
import { ChannelAdapter } from "./adapters/channel";
import { debugMuteProbe } from "./adapters/voice";
import { StatusAdapter } from "./adapters/status";
import { VolumeAdapter } from "./adapters/volume";
import { DeviceAdapter } from "./adapters/device";
import { AudioProcessingAdapter } from "./adapters/audioProc";
import { StageAdapter } from "./adapters/stage";
import { buildSnapshot, currentGuilds, currentDevices, noteVoiceJoin, discordReady } from "./state";
import { clampVolume } from "./errors";
import { log } from "./logger";

export interface CmdCtx {
  readOnly: boolean;
  sid: string | null;
  caps: { available: Record<string, boolean>; unavailableReasons: Record<string, string> };
  emitSnapshot: () => void;
  emitChannels: () => void;
  emitDevices: () => void;
}

export interface CmdOutcome {
  ok: boolean; code?: string; message?: string;
  statePatch?: Record<string, unknown>;
  candidates?: { id: string; name: string; path: string }[];
  extra?: Record<string, unknown>;
}

function needArgs(args: any, keys: string[]): CmdOutcome | null {
  for (const k of keys) {
    if (args?.[k] === undefined || args?.[k] === null)
      return { ok: false, code: "SCHEMA_INVALID", message: `missing arg: ${k}` };
  }
  return null;
}

export async function handleCommand(command: string, args: any, ctx: CmdCtx): Promise<CmdOutcome> {
  const a = args ?? {};

  // Unknown name → UNKNOWN_COMMAND (never throw).
  if (!(command in COMMAND_FLAG))
    return { ok: false, code: "UNKNOWN_COMMAND", message: `unknown command ${command}` };

  // Read-only gate: mutating commands rejected; getters pass.
  if (ctx.readOnly && !READONLY_SAFE_COMMANDS.has(command))
    return { ok: false, code: "READ_ONLY", message: "bridge is read-only" };

  // Capability gate (refresh AFTER buildCapabilities each command? caller refreshes per command).
  if (!isFlagSupported(command, ctx.caps.available)) {
    const flag = (COMMAND_FLAG as Record<string, string | null>)[command];
    return { ok: false, code: "UNSUPPORTED", message: `${command} unsupported (flag ${flag})` };
  }

  // Discord-ready gate for Discord-touching commands (getters still answer with nulls).
  const needsDiscord = !READONLY_SAFE_COMMANDS.has(command);
  if (needsDiscord && !discordReady())
    return { ok: false, code: "DISCORD_NOT_READY", message: "Discord not ready" };

  try {
    switch (command) {
      // ---- connection / state getters ----
      case "refresh_state": ctx.emitSnapshot(); return { ok: true };
      case "get_capabilities": {
        const c = buildCapabilities();
        return { ok: true, extra: { capabilities: c } };
      }
      case "get_channel_list": ctx.emitChannels(); return { ok: true };
      case "get_device_list": ctx.emitDevices(); return { ok: true };
      case "debug_mute_probe": return { ok: true, extra: { probe: debugMuteProbe() } }; // TEMP-DIAG

      // ---- mute / deafen ----
      case "toggle_mute": { const r: any = await VoiceAdapter.toggleMute(); return toOutcome(r); }
      case "set_mute": {
        const m = needArgs(a, ["muted"]); if (m) return m;
        const r: any = await VoiceAdapter.setMute(!!a.muted);
        return toOutcome(r, { selfMuted: !!a.muted });
      }
      case "toggle_deafen": { const r: any = await VoiceAdapter.toggleDeafen(); return toOutcome(r); }
      case "set_deafen": {
        const m = needArgs(a, ["deafened"]); if (m) return m;
        const r: any = await VoiceAdapter.setDeafen(!!a.deafened);
        return toOutcome(r, { selfDeafened: !!a.deafened });
      }
      case "toggle_mute_and_deafen": {
        // Best-effort: toggle mute, then mirror deafen to match (common UX).
        const m: any = await VoiceAdapter.toggleMute();
        if (!m.ok) return toOutcome(m);
        const curM = VoiceAdapter.isSelfMuted();
        const d: any = await VoiceAdapter.setDeafen(!!curM);
        if (!d.ok) return toOutcome(m, { selfMuted: curM });
        return { ok: true, statePatch: { selfMuted: curM, selfDeafened: !!curM } };
      }
      case "toggle_speaker_mute":
      case "set_speaker_mute":
        return { ok: false, code: "UNSUPPORTED", message: "speaker mute not exposed in this build" };

      // ---- audio processing ----
      case "toggle_noise_suppression": return toggleAp(() => AudioProcessingAdapter.snapshot().noiseSuppressionEnabled, v => AudioProcessingAdapter.setNoiseSuppression(v));
      case "set_noise_suppression": { const m = needArgs(a, ["enabled"]); if (m) return m; return toOutcome(AudioProcessingAdapter.setNoiseSuppression(!!a.enabled)); }
      case "toggle_echo_cancellation": return toggleAp(() => AudioProcessingAdapter.snapshot().echoCancellationEnabled, v => AudioProcessingAdapter.setEchoCancellation(v));
      case "set_echo_cancellation": { const m = needArgs(a, ["enabled"]); if (m) return m; return toOutcome(AudioProcessingAdapter.setEchoCancellation(!!a.enabled)); }
      case "toggle_automatic_gain": return toggleAp(() => AudioProcessingAdapter.snapshot().automaticGainEnabled, v => AudioProcessingAdapter.setAutomaticGain(v));
      case "set_automatic_gain": { const m = needArgs(a, ["enabled"]); if (m) return m; return toOutcome(AudioProcessingAdapter.setAutomaticGain(!!a.enabled)); }
      case "toggle_qos_high_priority": return toggleAp(() => AudioProcessingAdapter.snapshot().qosHighPriorityEnabled, v => AudioProcessingAdapter.setQosHighPriority(v));
      case "set_qos_high_priority": { const m = needArgs(a, ["enabled"]); if (m) return m; return toOutcome(AudioProcessingAdapter.setQosHighPriority(!!a.enabled)); }
      case "toggle_low_latency": return toggleAp(() => AudioProcessingAdapter.snapshot().lowLatencyEnabled, v => AudioProcessingAdapter.setLowLatency(v));
      case "set_low_latency": { const m = needArgs(a, ["enabled"]); if (m) return m; return toOutcome(AudioProcessingAdapter.setLowLatency(!!a.enabled)); }

      // ---- voice channel ----
      case "join_voice_by_id": {
        const m = needArgs(a, ["channelId"]); if (m) return m;
        const r: any = VoiceAdapter.joinChannel(String(a.channelId));
        if (r.ok) noteVoiceJoin(String(a.channelId), null);
        return toOutcome(r, r.ok ? { voiceChannelId: String(a.channelId) } : undefined);
      }
      case "join_voice_by_name":
      case "move_voice_by_name": {
        const m = needArgs(a, ["name"]); if (m) return m;
        const res = ChannelAdapter.resolveByName(String(a.name), a.guildName ? String(a.guildName) : undefined, currentGuilds(), true, false);
        return joinResolved(command.startsWith("move"), res);
      }
      case "join_voice_by_path":
      case "move_voice_by_path": {
        const m = needArgs(a, ["path"]); if (m) return m;
        const res = ChannelAdapter.resolveByPath(String(a.path), currentGuilds(), true, false);
        return joinResolved(command.startsWith("move"), res);
      }
      case "move_voice_by_id": {
        const m = needArgs(a, ["channelId"]); if (m) return m;
        const r: any = VoiceAdapter.joinChannel(String(a.channelId));
        if (r.ok) noteVoiceJoin(String(a.channelId), null);
        return toOutcome(r, r.ok ? { voiceChannelId: String(a.channelId) } : undefined);
      }
      case "leave_voice":
      case "disconnect_voice": return toOutcome(VoiceAdapter.leave(), { voiceConnected: false, voiceChannelId: null });
      case "rejoin_last_voice": {
        const snap = buildSnapshot();
        const id = snap.lastVoiceChannelId;
        if (!id) return { ok: false, code: "NOT_FOUND", message: "no last voice channel" };
        const r: any = VoiceAdapter.joinChannel(id);
        return toOutcome(r, r.ok ? { voiceChannelId: id } : undefined);
      }
      case "cycle_voice_channel": {
        const dir = a.direction === "prev" ? "prev" : "next";
        const guilds = currentGuilds();
        const voices = guilds.flatMap(g => g.channels.filter(c => c.type === "voice" || c.type === "stage").map(c => ({ ...c, guildId: g.id })));
        if (voices.length === 0) return { ok: false, code: "NOT_FOUND", message: "no voice channels" };
        const cur = VoiceAdapter.currentVoiceChannelId();
        let idx = voices.findIndex(v => v.id === cur);
        idx = idx < 0 ? 0 : (idx + (dir === "next" ? 1 : -1) + voices.length) % voices.length;
        const t = voices[idx];
        const r: any = VoiceAdapter.joinChannel(t.id);
        if (r.ok) noteVoiceJoin(t.id, t.name);
        return toOutcome(r, r.ok ? { voiceChannelId: t.id, voiceChannelName: t.name } : undefined);
      }

      // ---- stage ----
      case "stage_raise_hand": return toOutcome(StageAdapter.raiseHand());
      case "stage_lower_hand": return toOutcome(StageAdapter.lowerHand());
      case "stage_toggle_hand": return toOutcome(StageAdapter.toggleHand());
      case "stage_request_to_speak": return toOutcome(StageAdapter.requestToSpeak());
      case "stage_cancel_speak_request": return toOutcome(StageAdapter.cancelSpeakRequest());

      // ---- text ----
      case "select_text_by_id": {
        const m = needArgs(a, ["channelId"]); if (m) return m;
        const r: any = ChannelAdapter.selectTextChannel(String(a.channelId));
        return toOutcome(r, r.ok ? { selectedTextChannelId: String(a.channelId) } : undefined);
      }
      case "select_text_by_name": {
        const m = needArgs(a, ["name"]); if (m) return m;
        const res = ChannelAdapter.resolveByName(String(a.name), a.guildName ? String(a.guildName) : undefined, currentGuilds(), false, true);
        if (res.kind !== "found") return resolveErr(res);
        const r: any = ChannelAdapter.selectTextChannel(res.node.id);
        return toOutcome(r, r.ok ? { selectedTextChannelId: res.node.id } : undefined);
      }
      case "select_text_by_path": {
        const m = needArgs(a, ["path"]); if (m) return m;
        const res = ChannelAdapter.resolveByPath(String(a.path), currentGuilds(), false, true);
        if (res.kind !== "found") return resolveErr(res);
        const r: any = ChannelAdapter.selectTextChannel(res.node.id);
        return toOutcome(r, r.ok ? { selectedTextChannelId: res.node.id } : undefined);
      }
      case "select_last_text_channel": {
        const snap = buildSnapshot();
        // State keeps lastVoice only; track text via adapter memory is best-effort.
        const tid = (ChannelAdapter as any).lastTextId ?? snap.selectedTextChannelId;
        if (!tid) return { ok: false, code: "NOT_FOUND", message: "no last text channel" };
        const r: any = ChannelAdapter.selectTextChannel(String(tid));
        return toOutcome(r);
      }
      case "cycle_text_channel": {
        const dir = a.direction === "prev" ? "prev" : "next";
        const texts = currentGuilds().flatMap(g => g.channels.filter(c => c.type === "text"));
        if (texts.length === 0) return { ok: false, code: "NOT_FOUND", message: "no text channels" };
        const cur = ChannelAdapter.selectedTextChannelId();
        let idx = texts.findIndex(t => t.id === cur);
        idx = idx < 0 ? 0 : (idx + (dir === "next" ? 1 : -1) + texts.length) % texts.length;
        const r: any = ChannelAdapter.selectTextChannel(texts[idx].id);
        return toOutcome(r, r.ok ? { selectedTextChannelId: texts[idx].id } : undefined);
      }
      case "mark_selected_channel_read": return toOutcome(ChannelAdapter.markSelectedRead());

      // ---- status ----
      case "set_status_online": return toOutcome(StatusAdapter.setStatus("online"), { userStatus: "online" });
      case "set_status_idle": return toOutcome(StatusAdapter.setStatus("idle"), { userStatus: "idle" });
      case "set_status_dnd": return toOutcome(StatusAdapter.setStatus("dnd"), { userStatus: "dnd" });
      case "set_status_invisible": return toOutcome(StatusAdapter.setStatus("invisible"), { userStatus: "invisible" });
      case "cycle_status": {
        const r: any = StatusAdapter.cycleStatus();
        return toOutcome(r, r.ok ? { userStatus: r.next } : undefined);
      }
      case "toggle_dnd": return toOutcome(StatusAdapter.toggleDnd());
      case "toggle_invisible": return toOutcome(StatusAdapter.toggleInvisible());
      case "set_custom_status": return toOutcome(StatusAdapter.setCustomStatus(a ?? {}), { customStatusText: a?.text ?? null });
      case "append_custom_status": {
        const m = needArgs(a, ["text"]); if (m) return m;
        return toOutcome(StatusAdapter.appendCustomStatus(String(a.text)));
      }
      case "clear_custom_status": return toOutcome(StatusAdapter.clearCustomStatus(), { customStatusText: null });

      // ---- devices ----
      case "set_input_device_by_id": {
        const m = needArgs(a, ["deviceId"]); if (m) return m;
        return toOutcome(DeviceAdapter.setInputById(String(a.deviceId)));
      }
      case "set_input_device_by_name": {
        const m = needArgs(a, ["name"]); if (m) return m;
        const r: any = DeviceAdapter.setInputByName(String(a.name));
        return ambigAware(r);
      }
      case "cycle_input_device": return toOutcome(DeviceAdapter.cycle("input", a.direction === "prev" ? "prev" : "next"));
      case "set_output_device_by_id": {
        const m = needArgs(a, ["deviceId"]); if (m) return m;
        return toOutcome(DeviceAdapter.setOutputById(String(a.deviceId)));
      }
      case "set_output_device_by_name": {
        const m = needArgs(a, ["name"]); if (m) return m;
        const r: any = DeviceAdapter.setOutputByName(String(a.name));
        return ambigAware(r);
      }
      case "cycle_output_device": return toOutcome(DeviceAdapter.cycle("output", a.direction === "prev" ? "prev" : "next"));
      case "refresh_audio_devices": {
        const r: any = DeviceAdapter.refresh();
        if (r.ok) ctx.emitDevices();
        return toOutcome(r);
      }

      // ---- volumes ----
      case "set_input_volume": {
        const m = needArgs(a, ["volume"]); if (m) return m;
        if (clampVolume("io", Number(a.volume)) === null) return { ok: false, code: "SCHEMA_INVALID", message: "volume 0-100" };
        return toOutcome(VolumeAdapter.setInputVolume(Number(a.volume)));
      }
      case "increase_input_volume": return toOutcome(VolumeAdapter.bumpInput(Number(a.step ?? 5), 1));
      case "decrease_input_volume": return toOutcome(VolumeAdapter.bumpInput(Number(a.step ?? 5), -1));
      case "set_output_volume": {
        const m = needArgs(a, ["volume"]); if (m) return m;
        if (clampVolume("io", Number(a.volume)) === null) return { ok: false, code: "SCHEMA_INVALID", message: "volume 0-100" };
        return toOutcome(VolumeAdapter.setOutputVolume(Number(a.volume)));
      }
      case "increase_output_volume": return toOutcome(VolumeAdapter.bumpOutput(Number(a.step ?? 5), 1));
      case "decrease_output_volume": return toOutcome(VolumeAdapter.bumpOutput(Number(a.step ?? 5), -1));
      case "set_user_volume": {
        const m = needArgs(a, ["userId", "volume"]); if (m) return m;
        return toOutcome(VolumeAdapter.setUserVolume(String(a.userId), Number(a.volume)));
      }
      case "increase_user_volume": {
        const m = needArgs(a, ["userId"]); if (m) return m;
        const cur = VolumeAdapter.getUserVolume(String(a.userId));
        if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "user volume read-back unavailable" };
        const step = Number(a.step ?? 10);
        return toOutcome(VolumeAdapter.setUserVolume(String(a.userId), cur + (Number.isFinite(step) ? step : 10)));
      }
      case "decrease_user_volume": {
        const m = needArgs(a, ["userId"]); if (m) return m;
        const cur = VolumeAdapter.getUserVolume(String(a.userId));
        if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "user volume read-back unavailable" };
        const step = Number(a.step ?? 10);
        return toOutcome(VolumeAdapter.setUserVolume(String(a.userId), cur - (Number.isFinite(step) ? step : 10)));
      }
      case "reset_user_volume": {
        const m = needArgs(a, ["userId"]); if (m) return m;
        return toOutcome(VolumeAdapter.resetUserVolume(String(a.userId)));
      }
      case "toggle_user_local_mute": {
        const m = needArgs(a, ["userId"]); if (m) return m;
        return toOutcome(VolumeAdapter.toggleUserLocalMute(String(a.userId)));
      }
      case "set_user_local_mute": {
        const m = needArgs(a, ["userId", "muted"]); if (m) return m;
        return toOutcome(VolumeAdapter.setUserLocalMute(String(a.userId), !!a.muted));
      }
      case "set_attenuation_volume": {
        const m = needArgs(a, ["volume"]); if (m) return m;
        return toOutcome(AudioProcessingAdapter.setAttenuationVolume(Number(a.volume)));
      }
      case "toggle_attenuation_while_speaking": {
        const cur = AudioProcessingAdapter.snapshot().attenuationWhileSpeakingEnabled;
        if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "attenuation state unknown" };
        return toOutcome(AudioProcessingAdapter.setAttenuationWhileSpeaking(!cur));
      }
      case "set_attenuation_while_speaking": {
        const m = needArgs(a, ["enabled"]); if (m) return m;
        return toOutcome(AudioProcessingAdapter.setAttenuationWhileSpeaking(!!a.enabled));
      }
    }
  } catch (e: any) {
    log.error("commands", `handler crashed for ${command} (guarded)`, e?.message ?? e);
    return { ok: false, code: "INTERNAL_ERROR", message: "handler exception (guarded)" };
  }
  return { ok: false, code: "UNKNOWN_COMMAND", message: `unhandled ${command}` };
}

function toOutcome(r: any, patch?: Record<string, unknown>): CmdOutcome {
  if (r?.ok) return { ok: true, ...(patch ?? r?.patch ? { statePatch: { ...(r?.patch ?? {}), ...(patch ?? {}) } } : {}) };
  return { ok: false, code: r?.code ?? "INTERNAL_ERROR", message: r?.message ?? "failed" };
}
function ambigAware(r: any): CmdOutcome {
  if (r?.code === "AMBIGUOUS") return { ok: false, code: "AMBIGUOUS", message: r.message, candidates: (r.candidates ?? []).slice(0, 10) };
  return toOutcome(r);
}
function toggleAp(get: () => boolean | null, set: (b: boolean) => { ok: boolean; code?: string; message?: string }): CmdOutcome {
  const cur = get();
  if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "state unknown in this build" };
  return toOutcome(set(!cur));
}
function resolveErr(res: { kind: "not_found" } | { kind: "ambiguous"; candidates: { id: string; name: string; path: string }[] }): CmdOutcome {
  if ((res as any).kind === "ambiguous")
    return { ok: false, code: "AMBIGUOUS", message: "multiple channels match", candidates: (res as any).candidates.slice(0, 10) };
  return { ok: false, code: "NOT_FOUND", message: "channel not found" };
}
function joinResolved(isMove: boolean, res: any): CmdOutcome {
  void isMove; // join vs move is the same underlying select in current Discord builds
  if (res?.kind !== "found") return resolveErr(res);
  const r: any = VoiceAdapter.joinChannel(res.node.id);
  if (r?.ok) noteVoiceJoin(res.node.id, res.node.name);
  return toOutcome(r, r?.ok ? { voiceChannelId: res.node.id, voiceChannelName: res.node.name, voiceChannelPath: res.node.path } : undefined);
}
