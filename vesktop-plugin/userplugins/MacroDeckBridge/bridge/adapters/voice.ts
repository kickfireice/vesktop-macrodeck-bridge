/**
 * adapters/voice.ts — VoiceAdapter: mute/deafen/speaker + join/leave/move voice.
 * Safe discovery; every method returns {ok} or {ok:false,code} — never throws.
 */
import { tryFind } from "./discovery";
import { log } from "../logger";

export interface OpResult { ok: boolean; code?: string; message?: string; patch?: Record<string, unknown>; }

function mediaEngine(): any | null {
  // Candidate prop sets across Discord builds (MediaEngineStore variants).
  return tryFind("MediaEngine",
    ["toggleSelfMute", "toggleSelfDeafen"],
    ["isSelfMuted", "isSelfDeafened", "toggleSelfMute"],
    ["toggleMute", "toggleDeafen"]);
}

function voiceActions(): any | null {
  return tryFind("VoiceActions",
    ["selectVoiceChannel"],
    ["joinVoiceChannel", "leaveVoiceChannel"],
    ["disconnect", "selectChannel"]);
}

export function voiceAvailability() {
  const me = mediaEngine();
  const va = voiceActions();
  return {
    mute: !!me, deafen: !!me, speakerMute: false, // speaker-mute rarely exposed; honest false until confirmed
    voiceJoin: !!va, voiceLeave: !!va, voiceMove: !!va,
    rejoinLastVoice: true, // implemented locally via lastVoiceChannelId memory
    cycleVoiceChannel: !!va,
    reasons: {
      ...(me ? {} : { mute: "INTERNAL_ERROR: MediaEngine", deafen: "INTERNAL_ERROR: MediaEngine" }),
      speakerMute: "UNSUPPORTED: output-mute action not found in this Discord build",
      ...(!va ? {
        voiceJoin: "INTERNAL_ERROR: VoiceActions", voiceLeave: "INTERNAL_ERROR: VoiceActions",
        voiceMove: "INTERNAL_ERROR: VoiceActions", cycleVoiceChannel: "INTERNAL_ERROR: VoiceActions",
      } : {}),
    } as Record<string, string>,
  };
}

function callSafe(fn: (() => unknown) | undefined, label: string): OpResult {
  if (!fn) return { ok: false, code: "UNSUPPORTED", message: `${label} not available in this build` };
  try { fn(); return { ok: true }; }
  catch (e: any) {
    log.warn("voice", `${label} failed: ${e?.message ?? e}`);
    return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) };
  }
}

export const VoiceAdapter = {
  isSelfMuted(): boolean | null {
    try {
      const me = mediaEngine(); if (!me) return null;
      if (typeof me.isSelfMuted === "function") return !!me.isSelfMuted();
      if (typeof me.isMute === "function") return !!me.isMute();
      return typeof me.selfMute === "boolean" ? me.selfMute : null;
    } catch { return null; }
  },
  isSelfDeafened(): boolean | null {
    try {
      const me = mediaEngine(); if (!me) return null;
      if (typeof me.isSelfDeafened === "function") return !!me.isSelfDeafened();
      if (typeof me.isDeaf === "function") return !!me.isDeaf();
      return typeof me.selfDeaf === "boolean" ? me.selfDeaf : null;
    } catch { return null; }
  },
  toggleMute(): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "mute unavailable" };
    const fn = me.toggleSelfMute ?? me.toggleMute;
    return callSafe(fn?.bind(me), "toggleMute");
  },
  setMute(muted: boolean): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "mute unavailable" };
    try {
      if (typeof me.setSelfMute === "function") { me.setSelfMute(muted); return { ok: true }; }
      const cur = VoiceAdapter.isSelfMuted();
      if (cur === null) return { ok: false, code: "INTERNAL_ERROR", message: "cannot read mute state" };
      if (cur !== muted) return VoiceAdapter.toggleMute();
      return { ok: true };
    } catch (e: any) { return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  toggleDeafen(): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "deafen unavailable" };
    const fn = me.toggleSelfDeafen ?? me.toggleDeafen;
    return callSafe(fn?.bind(me), "toggleDeafen");
  },
  setDeafen(deafened: boolean): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "deafen unavailable" };
    try {
      if (typeof me.setSelfDeafen === "function") { me.setSelfDeafen(deafened); return { ok: true }; }
      const cur = VoiceAdapter.isSelfDeafened();
      if (cur === null) return { ok: false, code: "INTERNAL_ERROR", message: "cannot read deafen state" };
      if (cur !== deafened) return VoiceAdapter.toggleDeafen();
      return { ok: true };
    } catch (e: any) { return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  joinChannel(channelId: string): OpResult {
    const va = voiceActions(); if (!va) return { ok: false, code: "UNSUPPORTED", message: "voice join unavailable" };
    try {
      if (typeof va.selectVoiceChannel === "function") { va.selectVoiceChannel(channelId); return { ok: true }; }
      if (typeof va.joinVoiceChannel === "function") { va.joinVoiceChannel(channelId); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no join action in this build" };
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (/full/i.test(m)) return { ok: false, code: "CHANNEL_FULL", message: "voice channel is full" };
      if (/permission/i.test(m)) return { ok: false, code: "PERMISSION_DENIED", message: "missing permission to join" };
      return { ok: false, code: "VOICE_ERROR", message: m.slice(0, 120) };
    }
  },
  leave(): OpResult {
    const va = voiceActions(); if (!va) return { ok: false, code: "UNSUPPORTED", message: "voice leave unavailable" };
    try {
      if (typeof va.selectVoiceChannel === "function") { va.selectVoiceChannel(null); return { ok: true }; }
      if (typeof va.leaveVoiceChannel === "function") { va.leaveVoiceChannel(); return { ok: true }; }
      if (typeof va.disconnect === "function") { va.disconnect(); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no leave action in this build" };
    } catch (e: any) { return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  currentVoiceChannelId(): string | null {
    try {
      const sel: any = tryFind("SelectedChannelStore", ["getVoiceChannelId"], ["getCurrentlySelectedChannel"]);
      if (sel?.getVoiceChannelId) return sel.getVoiceChannelId() ?? null;
      return null;
    } catch { return null; }
  },
};
