/**
 * adapters/channel.ts — ChannelAdapter: guild/channel lists + text/voice select.
 * Path format: "Guild / Category / Channel" (§7). Ambiguous → candidates(max 10).
 */
import { tryFind, tryStore } from "./discovery";
import type { Guild, ChannelNode } from "../protocol";
import { log } from "../logger";

function channelStore(): any | null {
  return tryStore("ChannelStore", ["ChannelStore"], ["getChannel", "getAllChannels"], ["getDMChannels"]);
}
function guildChannelStore(): any | null {
  return tryStore("GuildChannelStore", ["GuildChannelStore"], ["getChannels", "getDefaultChannel"]);
}
function guildStore(): any | null {
  return tryStore("GuildStore", ["GuildStore"], ["getGuild", "getGuilds"], ["getGuildCount"]);
}
function selectActions(): any | null {
  return tryFind("ChannelSelectActions", ["selectChannel"], ["selectVoiceChannel"]);
}

function norm(s: string) { return (s || "").trim().toLowerCase(); }

export function channelListAvailability(): { channelList: boolean; textChannelSelect: boolean; cycleTextChannel: boolean; markChannelRead: boolean; reason?: string } {
  const cs = channelStore(); const gs = guildStore(); const gcs = guildChannelStore();
  const ok = !!(gs && (gcs || cs));
  return {
    channelList: ok, textChannelSelect: !!selectActions(),
    cycleTextChannel: !!selectActions(), markChannelRead: !!cs,
    reason: ok ? undefined : "INTERNAL_ERROR: ChannelStore/GuildStore",
  };
}

/**
 * Channels of one guild. Preferred: GuildChannelStore.getChannels(gid) ->
 * { SELECTABLE: [...], VOCAL: [...] } (shape Vencord's own plugins use).
 * Legacy fallbacks: ChannelStore.getAllChannels / getChannels.
 */
function channelsForGuild(cs: any, gcs: any, gid: string): any[] {
  // GuildChannelStore entries are sorted-collection wrappers {channel, comparator}.
  const unwrap = (x: any) => (x && typeof x === "object" && "channel" in x ? x.channel : x);
  try {
    if (gcs && typeof gcs.getChannels === "function") {
      const grouped: any = gcs.getChannels(gid);
      if (grouped) {
        const sel = Array.isArray(grouped.SELECTABLE) ? grouped.SELECTABLE : [];
        const voc = Array.isArray(grouped.VOCAL) ? grouped.VOCAL : [];
        if (sel.length || voc.length) return [...sel, ...voc].map(unwrap);
        const flat = Object.values(grouped).filter(Array.isArray).flat();
        if (flat.length) return (flat as any[]).map(unwrap);
      }
    }
  } catch { /* fall through to legacy */ }
  try {
    if (cs && typeof cs.getAllChannels === "function") {
      const all = cs.getAllChannels();
      const arr = Array.isArray(all) ? all.filter((c: any) => String(c?.guild_id ?? c?.guildId ?? "") === gid)
        : Object.values(all?.[gid]?.channels ?? all?.[gid] ?? {});
      if (arr.length) return arr;
    }
    if (cs && typeof cs.getChannels === "function") {
      const arr = Object.values(cs.getChannels(gid) ?? {});
      if (arr.length) return arr;
    }
  } catch { /* fall through */ }
  return [];
}

/** Best-effort guild/channel dump. Returns [] (not throw) when stores missing. */
export function getGuilds(): Guild[] {
  try {
    const cs = channelStore(); const gs = guildStore(); const gcs = guildChannelStore();
    if (!gs) return [];
    const guilds: any = typeof gs.getGuilds === "function" ? gs.getGuilds() : gs.getGuilds;
    const guildArray: any[] = Array.isArray(guilds) ? guilds : Object.values(guilds ?? {});
    const out: Guild[] = [];
    for (const g of guildArray.slice(0, 200)) {
      const gid = String(g?.id ?? ""); const gname = String(g?.name ?? "Unknown Guild");
      const channels: any[] = channelsForGuild(cs, gcs, gid);
      const nodes: ChannelNode[] = [];
      const cats = new Map<string, string>();
      for (const c of channels) {
        const t = Number(c?.type);
        // Discord channel types: 0 text, 2 voice, 4 category, 13 stage, 15 forum …
        if (t === 4) cats.set(String(c.id), String(c.name ?? "Category"));
      }
      for (const c of channels.slice(0, 500)) {
        const t = Number(c?.type);
        let kind: ChannelNode["type"] | null = null;
        if (t === 0 || t === 5 || t === 15) kind = "text";
        else if (t === 2) kind = "voice";
        else if (t === 13) kind = "stage";
        else if (t === 4) kind = "category";
        if (!kind) continue;
        const parentRaw = c?.parent_id ?? c?.parentId;
        const catName = parentRaw ? cats.get(String(parentRaw)) : undefined;
        const path = catName ? `${gname} / ${catName} / ${c.name}` : `${gname} / ${c.name}`;
        const node: ChannelNode = { id: String(c.id), name: String(c.name ?? c.id), type: kind, path };
        if (parentRaw) node.parentId = String(parentRaw);
        nodes.push(node);
      }
      out.push({ id: gid, name: gname, channels: nodes });
    }
    return out;
  } catch (e) {
    log.debug("channel", "getGuilds failed (non-fatal)");
    return [];
  }
}

export type ResolveResult = { kind: "found"; node: ChannelNode; guild: Guild }
  | { kind: "not_found" } | { kind: "ambiguous"; candidates: { id: string; name: string; path: string }[] };

function allNodes(guilds: Guild[], voiceOnly: boolean, textOnly: boolean) {
  const out: { node: ChannelNode; guild: Guild }[] = [];
  for (const g of guilds) for (const n of g.channels) {
    if (voiceOnly && !(n.type === "voice" || n.type === "stage")) continue;
    if (textOnly && n.type !== "text") continue;
    if (n.type === "category") continue;
    out.push({ node: n, guild: g });
  }
  return out;
}

export function resolveById(channelId: string, guilds: Guild[], voiceOnly = false, textOnly = false) {
  const all = allNodes(guilds, voiceOnly, textOnly);
  const hit = all.find(x => x.node.id === channelId);
  if (!hit) return { kind: "not_found" } as ResolveResult;
  return { kind: "found", node: hit.node, guild: hit.guild } as ResolveResult;
}

export function resolveByName(name: string, guildName: string | undefined, guilds: Guild[], voiceOnly = false, textOnly = false): ResolveResult {
  const all = allNodes(guilds, voiceOnly, textOnly).filter(x =>
    (!guildName || norm(x.guild.name) === norm(guildName)) && norm(x.node.name) === norm(name));
  if (all.length === 0) return { kind: "not_found" };
  if (all.length > 1) return {
    kind: "ambiguous",
    candidates: all.slice(0, 10).map(x => ({ id: x.node.id, name: x.node.name, path: x.node.path })),
  };
  return { kind: "found", node: all[0].node, guild: all[0].guild };
}

export function resolveByPath(path: string, guilds: Guild[], voiceOnly = false, textOnly = false): ResolveResult {
  const p = norm(path);
  const all = allNodes(guilds, voiceOnly, textOnly).filter(x => norm(x.node.path) === p);
  if (all.length === 0) {
    // Fallback: suffix match on "… / Channel" when caller omits category.
    const tail = p.split("/").map(s => s.trim()).filter(Boolean).pop() ?? p;
    const loose = allNodes(guilds, voiceOnly, textOnly).filter(x => norm(x.node.name) === tail);
    if (loose.length === 0) return { kind: "not_found" };
    if (loose.length > 1) return { kind: "ambiguous", candidates: loose.slice(0, 10).map(x => ({ id: x.node.id, name: x.node.name, path: x.node.path })) };
    return { kind: "found", node: loose[0].node, guild: loose[0].guild };
  }
  if (all.length > 1) return { kind: "ambiguous", candidates: all.slice(0, 10).map(x => ({ id: x.node.id, name: x.node.name, path: x.node.path })) };
  return { kind: "found", node: all[0].node, guild: all[0].guild };
}

export const ChannelAdapter = {
  getGuilds, resolveById, resolveByName, resolveByPath, channelListAvailability,
  selectedTextChannelId(): string | null {
    try {
      const sel: any = tryStore("SelectedChannelStore", ["SelectedChannelStore"], ["getCurrentlySelectedChannelId"]);
      if (sel?.getCurrentlySelectedChannelId) return sel.getCurrentlySelectedChannelId() ?? null;
      return null;
    } catch { return null; }
  },
  selectedGuildId(): string | null {
    try {
      const sel: any = tryStore("SelectedGuildStore", ["SelectedGuildStore"], ["getGuildId"]);
      if (sel?.getGuildId) return sel.getGuildId() ?? null;
      return null;
    } catch { return null; }
  },
  selectTextChannel(channelId: string): { ok: boolean; code?: string; message?: string } {
    const acts = selectActions();
    if (!acts) return { ok: false, code: "UNSUPPORTED", message: "text select unavailable" };
    try {
      if (typeof acts.selectChannel === "function") { acts.selectChannel(channelId); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no selectChannel action" };
    } catch (e: any) { return { ok: false, code: "VOICE_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
  markSelectedRead(): { ok: boolean; code?: string; message?: string } {
    try {
      const ack: any = tryFind("ChannelAck", ["ackChannel"], ["markChannelAsRead"]);
      if (!ack) return { ok: false, code: "UNSUPPORTED", message: "ack action unavailable" };
      const id = ChannelAdapter.selectedTextChannelId();
      if (!id) return { ok: false, code: "NOT_FOUND", message: "no text channel selected" };
      if (typeof ack.ackChannel === "function") { ack.ackChannel(id); return { ok: true }; }
      if (typeof ack.markChannelAsRead === "function") { ack.markChannelAsRead(id); return { ok: true }; }
      return { ok: false, code: "UNSUPPORTED", message: "no ack action in this build" };
    } catch (e: any) { return { ok: false, code: "INTERNAL_ERROR", message: String(e?.message ?? e).slice(0, 120) }; }
  },
};
