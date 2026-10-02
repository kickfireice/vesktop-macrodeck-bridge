/**
 * adapters/audioProc.ts — AudioProcessingAdapter: NS/EC/AGC/QoS/low-latency/speaker/attenuation.
 * All best-effort with honest UNSUPPORTED until the Discord build exposes them.
 */
import { tryFind } from "./discovery";

function voiceSettings(): any | null {
  return tryFind("VoiceSettings",
    ["getNoiseSuppression", "setNoiseSuppression"],
    ["getEchoCancellation", "setEchoCancellation"],
    ["getVoiceSettings", "setVoiceSettings"]);
}
function mediaEngineSettings(): any | null {
  return tryFind("MediaEngineSettings",
    ["getAttenuation", "setAttenuation"],
    ["isNoiseSuppressionEnabled"]);
}

export function audioProcAvailability() {
  const vs = voiceSettings(); const me = mediaEngineSettings();
  const any = !!(vs || me);
  const flag = (ok: boolean, mod: string) => ok ? true : false;
  const reasons: Record<string, string> = {};
  const f = {
    noiseSuppression: flag(any, "vs"), echoCancellation: flag(any, "vs"),
    automaticGain: flag(any, "vs"), qosHighPriority: flag(any, "vs"),
    lowLatency: flag(any, "vs"), speakerMute: false, attenuation: flag(any, "vs"),
  };
  if (!any) {
    reasons.noiseSuppression = "INTERNAL_ERROR: VoiceSettings";
    reasons.echoCancellation = "INTERNAL_ERROR: VoiceSettings";
    reasons.automaticGain = "INTERNAL_ERROR: VoiceSettings";
    reasons.qosHighPriority = "INTERNAL_ERROR: VoiceSettings";
    reasons.lowLatency = "INTERNAL_ERROR: VoiceSettings";
    reasons.attenuation = "INTERNAL_ERROR: VoiceSettings";
  }
  reasons.speakerMute = "UNSUPPORTED: output-mute action not found in this Discord build";
  return { ...f, reasons };
}

function readBool(getters: (() => unknown)[]): boolean | null {
  for (const g of getters) {
    try { const v = g(); if (typeof v === "boolean") return v; } catch { /* next */ }
  }
  return null;
}
function writeBool(setters: (() => void)[], label: string) {
  for (const s of setters) {
    try { s(); return { ok: true }; } catch { /* next */ }
  }
  return { ok: false, code: "UNSUPPORTED", message: `${label} unavailable in this build` };
}

export const AudioProcessingAdapter = {
  snapshot() {
    const vs: any = voiceSettings(); const me: any = mediaEngineSettings();
    const pick = (obj: any, names: string[]) => {
      for (const n of names) {
        try {
          if (obj && typeof obj[n] === "function") { const v = obj[n](); if (typeof v === "boolean") return v; }
          else if (obj && typeof obj[n] === "boolean") return obj[n];
        } catch { /* next */ }
      }
      return null;
    };
    return {
      noiseSuppressionEnabled: pick(vs ?? me, ["getNoiseSuppression", "noiseSuppression", "isNoiseSuppressionEnabled"]),
      echoCancellationEnabled: pick(vs ?? me, ["getEchoCancellation", "echoCancellation", "isEchoCancellationEnabled"]),
      automaticGainEnabled: pick(vs ?? me, ["getAutomaticGain", "automaticGainControl", "isAutomaticGainEnabled"]),
      qosHighPriorityEnabled: pick(vs ?? me, ["getQosHighPriority", "qosHighPriority"]),
      lowLatencyEnabled: pick(vs ?? me, ["getLowLatency", "lowLatency"]),
      speakerMuted: null as boolean | null, // no reliable store; stays null until confirmed
      attenuationVolume: (() => {
        try {
          const v = vs?.getAttenuation?.() ?? me?.getAttenuation?.() ?? null;
          return typeof v === "number" ? v : (typeof v?.volume === "number" ? v.volume : null);
        } catch { return null; }
      })(),
      attenuationWhileSpeakingEnabled: pick(vs ?? me, ["getAttenuationWhileSpeaking", "attenuateWhileSpeaking"]),
    };
  },
  setNoiseSuppression(enabled: boolean) {
    const vs: any = voiceSettings();
    if (!vs) return { ok: false, code: "UNSUPPORTED", message: "noise suppression unavailable" };
    return writeBool([() => vs.setNoiseSuppression?.(enabled), () => vs.setVoiceSettings?.({ noiseSuppression: enabled })], "noiseSuppression");
  },
  setEchoCancellation(enabled: boolean) {
    const vs: any = voiceSettings();
    if (!vs) return { ok: false, code: "UNSUPPORTED", message: "echo cancellation unavailable" };
    return writeBool([() => vs.setEchoCancellation?.(enabled)], "echoCancellation");
  },
  setAutomaticGain(enabled: boolean) {
    const vs: any = voiceSettings();
    if (!vs) return { ok: false, code: "UNSUPPORTED", message: "automatic gain unavailable" };
    return writeBool([() => vs.setAutomaticGain?.(enabled), () => vs.setVoiceSettings?.({ automaticGain: enabled })], "automaticGain");
  },
  setQosHighPriority(enabled: boolean) {
    const vs: any = voiceSettings();
    if (!vs) return { ok: false, code: "UNSUPPORTED", message: "QoS unavailable" };
    return writeBool([() => vs.setQosHighPriority?.(enabled)], "qosHighPriority");
  },
  setLowLatency(enabled: boolean) {
    const vs: any = voiceSettings();
    if (!vs) return { ok: false, code: "UNSUPPORTED", message: "low latency unavailable" };
    return writeBool([() => vs.setLowLatency?.(enabled)], "lowLatency");
  },
  toggleCurrent(getter: () => boolean | null, setter: (b: boolean) => { ok: boolean; code?: string; message?: string }) {
    const cur = getter();
    if (cur === null) return { ok: false, code: "UNSUPPORTED", message: "state unknown in this build" };
    return setter(!cur);
  },
  setAttenuationVolume(volume: number) {
    if (typeof volume !== "number" || volume < 0 || volume > 100)
      return { ok: false, code: "SCHEMA_INVALID", message: "volume 0-100" };
    const vs: any = voiceSettings(); const me: any = mediaEngineSettings();
    if (!vs && !me) return { ok: false, code: "UNSUPPORTED", message: "attenuation unavailable" };
    try {
      if (typeof vs?.setAttenuation === "function") { vs.setAttenuation(volume); return { ok: true, patch: { attenuationVolume: volume } }; }
      if (typeof me?.setAttenuation === "function") { me.setAttenuation(volume); return { ok: true, patch: { attenuationVolume: volume } }; }
      return { ok: false, code: "UNSUPPORTED", message: "no attenuation setter in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  setAttenuationWhileSpeaking(enabled: boolean) {
    const vs: any = voiceSettings();
    if (!vs) return { ok: false, code: "UNSUPPORTED", message: "attenuation toggle unavailable" };
    return writeBool([() => vs.setAttenuationWhileSpeaking?.(enabled)], "attenuationWhileSpeaking");
  },
  // Speaker mute: no reliable internal action — honest UNSUPPORTED (flag stays false).
  getSpeakerMuted(): boolean | null { void readBool; return null; },
  setSpeakerMuted(_muted: boolean) {
    return { ok: false, code: "UNSUPPORTED", message: "speaker mute not exposed in this Discord build" };
  },
};
