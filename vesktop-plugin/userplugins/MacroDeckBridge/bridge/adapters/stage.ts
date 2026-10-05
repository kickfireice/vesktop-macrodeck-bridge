/**
 * adapters/stage.ts — StageAdapter: raise/lower hand, request-to-speak.
 * Best-effort; often UNSUPPORTED — reported honestly (§6 stage).
 */
import { tryFind, tryStore } from "./discovery";
import { log } from "../logger";

function stageActions(): any | null {
  return tryFind("StageActions",
    ["raiseHand", "lowerHand"],
    ["requestToSpeak", "cancelSpeakRequest"],
    ["inviteToSpeak", "moveToSpeaker"]);
}
function stageStore(): any | null {
  return tryStore("StageStore", ["StageStore"],
    ["getStageChannel", "isSpeaker"],
    ["getHandRaised", "getSpeakRequested"]);
}

export function stageAvailability() {
  const acts = stageActions(); const st = stageStore();
  const hand = !!(acts || st); const speak = !!(acts || st);
  return {
    stageRaiseHand: hand, stageRequestToSpeak: speak,
    reasons: {
      ...(hand ? {} : { stageRaiseHand: "INTERNAL_ERROR: StageActions" }),
      ...(speak ? {} : { stageRequestToSpeak: "INTERNAL_ERROR: StageActions" }),
    } as Record<string, string>,
  };
}

function invoke(names: string[], label: string) {
  const acts: any = stageActions();
  if (!acts) return { ok: false, code: "UNSUPPORTED", message: `${label} unavailable (no StageActions)` };
  for (const n of names) {
    try {
      if (typeof acts[n] === "function") { acts[n](); return { ok: true }; }
    } catch (e: any) {
      log.warn("stage", `${label} ${n} failed: ${e?.message ?? e}`);
      return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) };
    }
  }
  return { ok: false, code: "UNSUPPORTED", message: `${label} not exposed in this build` };
}

export const StageAdapter = {
  snapshot() {
    try {
      const st: any = stageStore();
      if (!st) return { stageHandRaised: null, stageSpeakRequested: null, stageIsSpeaker: null, stageChannelActive: false };
      const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
      return {
        stageHandRaised: bool(st.getHandRaised?.() ?? st.handRaised),
        stageSpeakRequested: bool(st.getSpeakRequested?.() ?? st.speakRequested),
        stageIsSpeaker: bool(st.isSpeaker?.() ?? st.isCurrentUserSpeaker?.()),
        stageChannelActive: !!(st.getStageChannel?.() ?? st.stageChannelId ?? false),
      };
    } catch { return { stageHandRaised: null, stageSpeakRequested: null, stageIsSpeaker: null, stageChannelActive: false }; }
  },
  raiseHand() { return invoke(["raiseHand", "setHandRaised"], "raiseHand"); },
  lowerHand() { return invoke(["lowerHand", "clearHandRaised"], "lowerHand"); },
  toggleHand() {
    const s = StageAdapter.snapshot();
    if (s.stageHandRaised === null) return invoke(["raiseHand", "lowerHand"], "toggleHand");
    return s.stageHandRaised ? StageAdapter.lowerHand() : StageAdapter.raiseHand();
  },
  requestToSpeak() { return invoke(["requestToSpeak", "requestSpeak"], "requestToSpeak"); },
  cancelSpeakRequest() { return invoke(["cancelSpeakRequest", "cancelRequestToSpeak"], "cancelSpeakRequest"); },
};
