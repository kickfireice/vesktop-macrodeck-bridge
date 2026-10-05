/**
 * adapters/voiceUsers.ts — Voice-call participants for user-targeting dropdowns.
 *
 * Users in the CURRENT voice channel (the call you are in): resolved through
 * VoiceStateStore.getVoiceStatesForChannel (the same API Vencord's own
 * userVoiceShow/vcNarrator plugins use), names via UserStore.getUser.
 * Empty (not throw) when stores are missing or you are in no call.
 */
import { tryStore } from "./discovery";
import { log } from "../logger";

export interface VoiceUser { id: string; name: string; }

function voiceStateStore(): any | null {
  return tryStore("VoiceStateStore", ["VoiceStateStore"], ["getVoiceStatesForChannel"], ["getVoiceStates"]);
}

function userStore(): any | null {
  return tryStore("UserStore", ["UserStore"], ["getUser", "getCurrentUser"]);
}

function selectedVoiceChannelId(): string | null {
  try {
    const sel: any = tryStore("SelectedChannelStore-voiceUsers", ["SelectedChannelStore"], ["getVoiceChannelId"]);
    if (sel?.getVoiceChannelId) return sel.getVoiceChannelId() ?? null;
    return null;
  } catch { return null; }
}

export function voiceUsersAvailability(): { voiceUsers: boolean; reasons: Record<string, string> } {
  const vs = voiceStateStore(); const us = userStore();
  const ok = !!(vs && us);
  return { voiceUsers: ok, reasons: ok ? {} : { voiceUsers: "INTERNAL_ERROR: VoiceStateStore/UserStore" } };
}

export function getVoiceUsers(): VoiceUser[] {
  try {
    const vs = voiceStateStore(); const us = userStore();
    const cid = selectedVoiceChannelId();
    if (!vs || !us || !cid) return [];
    // Exclude yourself: per-user volume/mute target other people by design
    // (your own volume/mute have dedicated controls).
    let selfId = "";
    try { selfId = String(us.getCurrentUser?.()?.id ?? ""); } catch { selfId = ""; }
    const rec = vs.getVoiceStatesForChannel(cid) ?? {};
    return Object.keys(rec).filter((id) => !selfId || id !== selfId).slice(0, 50).map((id) => {
      let name = String(id);
      try {
        const u = us.getUser?.(id);
        const n = u?.globalName ?? u?.username ?? u?.displayName ?? u?.name;
        if (n) name = String(n);
      } catch { /* keep id */ }
      return { id: String(id), name };
    });
  } catch (e) {
    log.debug("voiceUsers", "getVoiceUsers failed (non-fatal)");
    return [];
  }
}
