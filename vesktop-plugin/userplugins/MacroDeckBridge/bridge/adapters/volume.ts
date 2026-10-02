/** adapters/volume.ts — VolumeAdapter: in/out + per-user + attenuation. Ranges per §6. */
import { tryFind } from "./discovery";
import { clampVolume } from "../errors";

function mediaEngine(): any | null {
  return tryFind("MediaEngine-volume",
    ["getInputVolume", "setInputVolume"],
    ["getOutputVolume", "setOutputVolume"]);
}
function userVolumeStore(): any | null {
  return tryFind("UserVolumeStore",
    ["getUserVolume", "setUserVolume"],
    ["getLocalVolume", "setLocalVolume"]);
}

export function volumeAvailability() {
  const me = mediaEngine(); const uv = userVolumeStore();
  const inputVolume = !!me; const outputVolume = !!me;
  const perUserVolume = !!uv; const userLocalMute = !!uv;
  // Attenuation settings live in UserSettingsProtoStore in most builds.
  const us: any = tryFind("UserSettings-attenuation", ["getAttenuation"]);
  const attenuation = !!(us || me);
  const reasons: Record<string, string> = {};
  if (!me) { reasons.inputVolume = "INTERNAL_ERROR: MediaEngine"; reasons.outputVolume = "INTERNAL_ERROR: MediaEngine"; }
  if (!uv) { reasons.perUserVolume = "INTERNAL_ERROR: UserVolumeStore"; reasons.userLocalMute = "INTERNAL_ERROR: UserVolumeStore"; }
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
      const uv = userVolumeStore();
      if (!uv) return { ok: false, code: "UNSUPPORTED", message: "per-user volume unavailable" };
      if (typeof uv.setUserVolume === "function") { uv.setUserVolume(userId, c); return { ok: true }; }
      if (typeof uv.setLocalVolume === "function") { uv.setLocalVolume(userId, c); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no per-user setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  resetUserVolume(userId: string) { return VolumeAdapter.setUserVolume(userId, 100); },
  setUserLocalMute(userId: string, muted: boolean) {
    try {
      const uv = userVolumeStore();
      if (!uv) return { ok: false, code: "UNSUPPORTED", message: "local mute unavailable" };
      if (typeof uv.setUserLocalMute === "function") { uv.setUserLocalMute(userId, muted); return { ok: true }; }
      if (typeof uv.toggleLocalMute === "function" && muted) { uv.toggleLocalMute(userId); return { ok: true }; }
      // Fallback: volume 0 ≈ muted (honest, still reported as mute attempt).
      if (muted) return VolumeAdapter.setUserVolume(userId, 0);
      return { ok: false, code: "UNSUPPORTED", message: "no local-mute setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
};
