/** adapters/status.ts — StatusAdapter: presence + custom status. */
import { tryFind } from "./discovery";
import { log } from "../logger";

export type StatusValue = "online" | "idle" | "dnd" | "invisible" | "unknown";

function presenceActions(): any | null {
  return tryFind("PresenceActions", ["updateStatus"], ["setStatus"]);
}
function customStatusActions(): any | null {
  return tryFind("CustomStatusActions",
    ["updateCustomStatus"], ["setCustomStatus"], ["saveCustomStatus"]);
}

export function statusAvailability() {
  const p = presenceActions(); const c = customStatusActions();
  return {
    status: !!p, customStatus: !!c,
    reasons: {
      ...(p ? {} : { status: "INTERNAL_ERROR: PresenceActions" }),
      ...(c ? {} : { customStatus: "INTERNAL_ERROR: CustomStatusActions" }),
    } as Record<string, string>,
  };
}

function setStatusRaw(status: Exclude<StatusValue, "unknown">) {
  const p = presenceActions();
  if (!p) return { ok: false, code: "UNSUPPORTED", message: "status unavailable" };
  try {
    if (typeof p.updateStatus === "function") { p.updateStatus(status); return { ok: true }; }
    if (typeof p.setStatus === "function") { p.setStatus(status); return { ok: true }; }
    return { ok: false, code: "UNSUPPORTED", message: "no status setter in this build" };
  } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
}

export const StatusAdapter = {
  getStatus(): StatusValue {
    try {
      const pres: any = tryFind("PresenceStore", ["getStatus", "getState"]);
      if (pres?.getStatus) {
        const s = String(pres.getStatus() ?? "unknown").toLowerCase();
        if (s === "online" || s === "idle" || s === "dnd" || s === "invisible") return s;
      }
      return "unknown";
    } catch { return "unknown"; }
  },
  getCustomStatus(): { text: string | null; emojiName: string | null } {
    try {
      const us: any = tryFind("UserSettingsProtoStore",
        ["getCustomStatus"], ["getLocalStatus"]);
      if (us?.getCustomStatus) {
        const c = us.getCustomStatus();
        return { text: c?.text ?? null, emojiName: c?.emojiName ?? c?.emoji_name ?? null };
      }
      return { text: null, emojiName: null };
    } catch { return { text: null, emojiName: null }; }
  },
  setStatus(s: Exclude<StatusValue, "unknown">) { return setStatusRaw(s); },
  cycleStatus(): { ok: boolean; code?: string; message?: string; next?: string } {
    const order = ["online", "idle", "dnd", "invisible"] as const;
    const cur = StatusAdapter.getStatus();
    const idx = order.indexOf(cur as any);
    const next = order[(idx + 1 + order.length) % order.length] ?? "online";
    const r: any = setStatusRaw(next);
    return { ...r, next };
  },
  toggleDnd() {
    const cur = StatusAdapter.getStatus();
    return setStatusRaw(cur === "dnd" ? "online" : "dnd");
  },
  toggleInvisible() {
    const cur = StatusAdapter.getStatus();
    return setStatusRaw(cur === "invisible" ? "online" : "invisible");
  },
  setCustomStatus(args: { text?: string; emojiName?: string; emojiId?: string; expiresAt?: number }) {
    const c = customStatusActions();
    if (!c) return { ok: false, code: "UNSUPPORTED", message: "custom status unavailable" };
    try {
      if (typeof c.updateCustomStatus === "function") { c.updateCustomStatus(args); return { ok: true }; }
      if (typeof c.setCustomStatus === "function") { c.setCustomStatus(args); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no custom-status setter in this build" };
    } catch (e: any) {
      log.warn("status", `setCustomStatus failed: ${e?.message ?? e}`);
      return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) };
    }
  },
  appendCustomStatus(text: string) {
    const cur = StatusAdapter.getCustomStatus();
    const joined = ((cur.text ?? "") + text).slice(0, 128);
    return StatusAdapter.setCustomStatus({ text: joined });
  },
  clearCustomStatus() {
    return StatusAdapter.setCustomStatus({ text: "" });
  },
};
