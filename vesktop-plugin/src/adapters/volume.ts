/** adapters/volume.ts — VolumeAdapter: in/out + per-user + attenuation. Ranges per §6. */
import { tryFind, tryStore } from "./discovery";
import { clampVolume } from "../errors";

function mediaEngine(): any | null {
  return tryStore("MediaEngine-volume", ["MediaEngineStore"],
    ["getInputVolume", "setInputVolume"],
    ["getOutputVolume", "setOutputVolume"]);
}
function userVolumeStore(): any | null {
  return tryStore("UserVolumeStore", ["UserVolumeStore"],
    ["getUserVolume", "setUserVolume"],
    ["getLocalVolume", "setLocalVolume"]);
}

/** MediaEngineStore holds per-user local volumes/mutes (localVolumes/localMutes maps). */
function engineStore(): any | null {
  return tryStore("MediaEngineStore-volumes", ["MediaEngineStore"]);
}

function pickFn(obj: any, names: string[]): ((...a: any[]) => unknown) | null {
  for (const n of names) {
    if (obj && typeof obj[n] === "function") return obj[n].bind(obj);
  }
  return null;
}

function readLocalVolume(userId: string): number | null {
  try {
    const me = engineStore() ?? mediaEngine();
    const entry = me?.localVolumes?.[userId];
    const v = entry?.volume ?? entry;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
  } catch { /* fall through */ }
  return null;
}

function readLocalMute(userId: string): boolean | null {
  try {
    const me = engineStore() ?? mediaEngine();
    const lm = me?.localMutes;
    if (lm && userId in lm) return !!lm[userId];
    const fn = pickFn(me, ["isLocalMute"]);
    if (fn) { try { return !!fn(userId); } catch { /* fall through */ } }
  } catch { /* fall through */ }
  return null;
}

export function volumeAvailability() {
  const me = mediaEngine(); const uv = userVolumeStore();
  const inputVolume = !!me; const outputVolume = !!me;
  const eng = engineStore() ?? me;
  const canLocalVol = !!(eng && (typeof eng.setLocalVolume === "function" || eng.localVolumes)) || !!uv;
  const canLocalMute = !!(eng && (typeof eng.setLocalMute === "function" ||
    typeof eng.toggleLocalMute === "function" || eng.localMutes)) || !!uv;
  const perUserVolume = canLocalVol; const userLocalMute = canLocalMute;
  // Attenuation settings live in UserSettingsProtoStore in most builds.
  const us: any = tryStore("UserSettings-attenuation", ["UserSettingsProtoStore"], ["getAttenuation"]);
  const attenuation = !!(us || me);
  const reasons: Record<string, string> = {};
  if (!me) { reasons.inputVolume = "INTERNAL_ERROR: MediaEngine"; reasons.outputVolume = "INTERNAL_ERROR: MediaEngine"; }
  if (!perUserVolume) { reasons.perUserVolume = "INTERNAL_ERROR: per-user volume"; reasons.userLocalMute = "INTERNAL_ERROR: per-user volume"; }
  if (!userLocalMute) { reasons.userLocalMute = "INTERNAL_ERROR: local mute"; }
  if (!attenuation) reasons.attenuation = "INTERNAL_ERROR: attenuation settings";
  return { inputVolume, outputVolume, perUserVolume, userLocalMute, attenuation, reasons };
}

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

export const VolumeAdapter = {
  getInputVolume(): number | null {
    try { const me = mediaEngine(); if (!me) return null; if (typeof me.getInputVolume === "function") return num(me.getInputVolume()); return num(me.inputVolume); }
    catch { return null; }
  },
  getOutputVolume(): number | null {
    try { const me = mediaEngine(); if (!me) return null; if (typeof me.getOutputVolume === "function") return num(me.getOutputVolume()); return num(me.outputVolume); }
    catch { return null; }
  },
  setInputVolume(v: number) {
    const c = clampVolume("io", v); if (c === null) return { ok: false, code: "SCHEMA_INVALID", message: "volume 0-100" };
    try {
      const me = mediaEngine(); if (!me || typeof me.setInputVolume !== "function") return { ok: false, code: "UNSUPPORTED", message: "input volume unavailable" };
      me.setInputVolume(c); return { ok: true, patch: { inputVolume: c } };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  setOutputVolume(v: number) {
    const c = clampVolume("io", v); if (c === null) return { ok: false, code: "SCHEMA_INVALID", message: "volume 0-100" };
    try {
      const me = mediaEngine(); if (!me || typeof me.setOutputVolume !== "function") return { ok: false, code: "UNSUPPORTED", message: "output volume unavailable" };
      me.setOutputVolume(c); return { ok: true, patch: { outputVolume: c } };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  bumpInput(step = 5, dir: 1 | -1 = 1) {
    const cur = VolumeAdapter.getInputVolume();
    if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "input volume unavailable" };
    return VolumeAdapter.setInputVolume(cur + dir * (step || 5));
  },
  bumpOutput(step = 5, dir: 1 | -1 = 1) {
    const cur = VolumeAdapter.getOutputVolume();
    if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "output volume unavailable" };
    return VolumeAdapter.setOutputVolume(cur + dir * (step || 5));
  },
  setUserVolume(userId: string, v: number) {
    const c = clampVolume("user", v); if (c === null) return { ok: false, code: "SCHEMA_INVALID", message: "volume 0-200" };
    try {
      const me = engineStore() ?? mediaEngine();
      const set = pickFn(me, ["setLocalVolume"]);
      if (set) { set(userId, c); return { ok: true }; }
      const uv = userVolumeStore();
      if (!uv && !me) return { ok: false, code: "UNSUPPORTED", message: "per-user volume unavailable" };
      if (uv && typeof uv.setUserVolume === "function") { uv.setUserVolume(userId, c); return { ok: true }; }
      if (uv && typeof uv.setLocalVolume === "function") { uv.setLocalVolume(userId, c); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no per-user setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  resetUserVolume(userId: string) { return VolumeAdapter.setUserVolume(userId, 100); },
  getUserVolume(userId: string): number | null {
    const v = readLocalVolume(userId);
    if (v !== null) return v;
    try {
      const uv = userVolumeStore();
      for (const n of ["getUserVolume", "getLocalVolume"]) {
        try {
          if (uv && typeof uv[n] === "function") {
            const r = uv[n](userId);
            if (typeof r === "number" && !Number.isNaN(r)) return r;
          }
        } catch { /* next */ }
      }
    } catch { /* fall through */ }
    return null;
  },
  setUserLocalMute(userId: string, muted: boolean) {
    try {
      const me = engineStore() ?? mediaEngine();
      const set = pickFn(me, ["setLocalMute", "setLocalMuted", "toggleLocalMute"]);
      if (set) {
        // toggle-style setters take only the user: call only when a change is needed.
        if (/toggle/i.test(String((set as any).name ?? ""))) {
          if (muted !== (readLocalMute(userId) ?? !muted)) set(userId);
          return { ok: true };
        }
        set(userId, muted); return { ok: true };
      }
      const uv = userVolumeStore();
      if (!uv && !me) return { ok: false, code: "UNSUPPORTED", message: "local mute unavailable" };
      if (uv && typeof uv.setUserLocalMute === "function") { uv.setUserLocalMute(userId, muted); return { ok: true }; }
      if (uv && typeof uv.toggleLocalMute === "function" && muted) { uv.toggleLocalMute(userId); return { ok: true }; }
      // Fallback: volume 0 ≈ muted (honest, still reported as mute attempt).
      if (muted) return VolumeAdapter.setUserVolume(userId, 0);
      return { ok: false, code: "UNSUPPORTED", message: "no local-mute setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  toggleUserLocalMute(userId: string) {
    const cur = readLocalMute(userId);
    if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "local-mute read-back unavailable" };
    return VolumeAdapter.setUserLocalMute(userId, !cur);
  },
};
