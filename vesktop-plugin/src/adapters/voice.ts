/**
 * adapters/voice.ts — VoiceAdapter: mute/deafen/speaker + join/leave/move voice.
 * Safe discovery; every method returns {ok} or {ok:false,code} — never throws.
 */
import { getDispatcher, tryFind, tryFindStore, tryStore } from "./discovery";
import { log } from "../logger";

export interface OpResult { ok: boolean; code?: string; message?: string; patch?: Record<string, unknown>; }

function mediaEngine(): any | null {
  // Primary: resolve the store by its display name — Vencord itself resolves
  // MediaEngineStore this way (`findStore`), and only the store instance has
  // the reader methods (`isSelfMute`/`isSelfDeaf`/...) on current builds.
  const store = tryFindStore("MediaEngineStore", "MediaEngineStore");
  if (store) return store;
  // Fallbacks: prop-scans across the method-name families seen in older builds.
  return tryFind("MediaEngine",
    ["isSelfMute", "isSelfDeaf"],
    ["isMute", "isDeaf"],
    ["isSelfMuted", "isSelfDeafened", "toggleSelfMute"],
    ["toggleSelfMute", "toggleSelfDeafen"],
    ["toggleMute", "toggleDeafen"]);
}

/** Bind the first method that exists on `obj` (Discord renames these across builds). */
function pickFn(obj: any, names: string[]): ((...args: any[]) => unknown) | null {
  for (const n of names) {
    if (obj && typeof obj[n] === "function") return (obj[n] as (...args: any[]) => unknown).bind(obj);
  }
  return null;
}

/**
 * Dispatch one of Discord's own Flux actions — the exact path the Discord UI
 * uses (payload shapes match the mute/deafen action creators).
 */
function dispatchSafe(action: Record<string, unknown>, label: string): OpResult {
  const d = getDispatcher();
  if (!d) return { ok: false, code: "UNSUPPORTED", message: `${label}: FluxDispatcher unavailable` };
  try { d.dispatch(action); return { ok: true }; }
  catch (e: any) {
    log.warn("voice", `${label} dispatch failed: ${e?.message ?? e}`);
    return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) };
  }
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
      const fn = pickFn(me, ["isSelfMute", "isSelfMuted", "isMute"]);
      if (fn) return !!fn();
      return typeof me.selfMute === "boolean" ? me.selfMute : null;
    } catch { return null; }
  },
  isSelfDeafened(): boolean | null {
    try {
      const me = mediaEngine(); if (!me) return null;
      const fn = pickFn(me, ["isSelfDeaf", "isSelfDeafened", "isDeaf"]);
      if (fn) return !!fn();
      return typeof me.selfDeaf === "boolean" ? me.selfDeaf : null;
    } catch { return null; }
  },
  toggleMute(): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "mute unavailable" };
    // Older builds expose a store toggle; current builds only react to the action.
    const fn = pickFn(me, ["toggleSelfMute", "toggleMute"]);
    if (fn) return callSafe(fn, "toggleMute");
    return dispatchSafe({ type: "AUDIO_TOGGLE_SELF_MUTE", context: "default", syncRemote: true, playSoundEffect: true }, "toggleMute");
  },
  setMute(muted: boolean): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "mute unavailable" };
    // Older builds expose a direct setter.
    const set = pickFn(me, ["setSelfMute", "setMute"]);
    if (set) {
      try { set(muted); return { ok: true }; }
      catch (e: any) { return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
    }
    // Current builds: read first, then toggle only when the state differs
    // (the same route the Discord UI's mute button takes).
    const cur = VoiceAdapter.isSelfMuted();
    if (cur === null) return { ok: false, code: "INTERNAL_ERROR", message: "cannot read mute state" };
    if (cur !== muted) return VoiceAdapter.toggleMute();
    return { ok: true };
  },
  toggleDeafen(): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "deafen unavailable" };
    const fn = pickFn(me, ["toggleSelfDeafen", "toggleDeafen"]);
    if (fn) return callSafe(fn, "toggleDeafen");
    return dispatchSafe({ type: "AUDIO_TOGGLE_SELF_DEAF", context: "default", syncRemote: true }, "toggleDeafen");
  },
  setDeafen(deafened: boolean): OpResult {
    const me = mediaEngine(); if (!me) return { ok: false, code: "UNSUPPORTED", message: "deafen unavailable" };
    const set = pickFn(me, ["setSelfDeafen", "setDeafen"]);
    if (set) {
      try { set(deafened); return { ok: true }; }
      catch (e: any) { return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
    }
    // Current builds expose no set-deafen action — read then toggle if needed.
    const cur = VoiceAdapter.isSelfDeafened();
    if (cur === null) return { ok: false, code: "INTERNAL_ERROR", message: "cannot read deafen state" };
    if (cur !== deafened) return VoiceAdapter.toggleDeafen();
    return { ok: true };
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
      const sel: any = tryStore("SelectedChannelStore", ["SelectedChannelStore"], ["getVoiceChannelId"], ["getCurrentlySelectedChannel"]);
      if (sel?.getVoiceChannelId) return sel.getVoiceChannelId() ?? null;
      return null;
    } catch { return null; }
  },
};
