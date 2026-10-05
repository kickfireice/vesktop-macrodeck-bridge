/**
 * state.ts — StateAdapter: snapshot + event subscriptions (§7, §9, deliverable #8).
 *
 * - Snapshot includes ALL State fields from PROTOCOL.md §7 (null where unknown).
 * - Event-driven via FluxDispatcher; NO polling. (No unavoidable poller exists;
 *   heartbeat freshness is handled by socket.ts heartbeats, not state polls.)
 * - Debounce 100–250 ms for coalescable changes; immediate for mute/deafen/
 *   join/leave/select/auth (discrete events).
 */
import { emptyState, type State, type Guild, type Device } from "./protocol";
import { buildCapabilities } from "./capabilities";
import { VoiceAdapter } from "./adapters/voice";
import { ChannelAdapter, getGuilds } from "./adapters/channel";
import { getVoiceUsers } from "./adapters/voiceUsers";
import { StatusAdapter } from "./adapters/status";
import { VolumeAdapter } from "./adapters/volume";
import { DeviceAdapter } from "./adapters/device";
import { AudioProcessingAdapter } from "./adapters/audioProc";
import { StageAdapter } from "./adapters/stage";
import { getDispatcher, tryFind } from "./adapters/discovery";
import { log } from "./logger";

export const PLUGIN_VERSION = "1.0.0";
const DEBOUNCE_MS = 150;
const IMMEDIATE_KEYS = new Set([
  "selfMuted", "selfDeafened", "voiceChannelId", "voiceConnected",
  "selectedTextChannelId", "authenticated", "discordReady", "voiceUsers",
]);

export type PushSnapshot = (s: State) => void;
export type PushPatch = (patch: Partial<State>, opts?: { immediate?: boolean }) => void;

interface Ctx {
  lastVoiceChannelId: string | null;
  lastVoiceChannelName: string | null;
  lastTextChannelId: string | null;
  seq: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingPatch: Partial<State>;
  emit: ((patch: Partial<State>, seq: number) => void) | null;
  lastError: string | null;
  readOnly: boolean;
  authenticated: boolean;
  bridgeRunning: boolean;
}

const ctx: Ctx = {
  lastVoiceChannelId: null, lastVoiceChannelName: null, lastTextChannelId: null,
  seq: 0, debounceTimer: null, pendingPatch: {}, emit: null,
  lastError: null, readOnly: false, authenticated: false, bridgeRunning: false,
};

let fluxUnsubs: (() => void)[] = [];

export function setSessionFlags(flags: { authenticated?: boolean; bridgeRunning?: boolean; readOnly?: boolean; lastError?: string | null }) {
  if (flags.authenticated !== undefined) ctx.authenticated = flags.authenticated;
  if (flags.bridgeRunning !== undefined) ctx.bridgeRunning = flags.bridgeRunning;
  if (flags.readOnly !== undefined) ctx.readOnly = flags.readOnly;
  if (flags.lastError !== undefined) ctx.lastError = flags.lastError;
}

export function noteVoiceJoin(id: string, name: string | null) {
  ctx.lastVoiceChannelId = id;
  ctx.lastVoiceChannelName = name;
}

/** Cheap Discord-ready probe: current user resolvable. */
export function discordReady(): boolean {
  try {
    const us: any = tryFind("UserStore-ready", ["getCurrentUser"]);
    if (us?.getCurrentUser) return !!us.getCurrentUser();
    // If stores are unreachable we still consider Discord "not ready" (DISCORD_NOT_READY path).
    return false;
  } catch { return false; }
}

/** Build FULL snapshot — every §7 field present. */
export function buildSnapshot(): State {
  const s = emptyState(PLUGIN_VERSION);
  const caps = buildCapabilities();
  const ready = discordReady();

  s.authenticated = ctx.authenticated;
  s.bridgeRunning = ctx.bridgeRunning;
  s.discordReady = ready;
  s.readOnly = ctx.readOnly;
  s.lastError = ctx.lastError;

  if (!ready) return { ...s, availableCapabilities: caps.available, unavailableReasons: caps.unavailableReasons };

  try {
    s.selfMuted = VoiceAdapter.isSelfMuted();
    s.selfDeafened = VoiceAdapter.isSelfDeafened();
  } catch { /* nulls */ }

  try {
    const voiceId = VoiceAdapter.currentVoiceChannelId();
    s.voiceChannelId = voiceId;
    s.voiceConnected = !!voiceId;
    s.voiceConnecting = false; // no reliable connecting flag; false until confirmed
    if (voiceId) {
      const guilds = getGuilds();
      outer: for (const g of guilds) for (const c of g.channels) {
        if (c.id === voiceId) {
          s.voiceChannelName = c.name; s.voiceChannelPath = c.path;
          s.voiceGuildId = g.id; s.voiceGuildName = g.name;
          noteVoiceJoin(voiceId, c.name);
          break outer;
        }
      }
    }
  } catch { /* nulls */ }
  s.lastVoiceChannelId = ctx.lastVoiceChannelId;
  s.lastVoiceChannelName = ctx.lastVoiceChannelName;

  try {
    const tid = ChannelAdapter.selectedTextChannelId();
    s.selectedTextChannelId = tid;
    if (tid) {
      ctx.lastTextChannelId = tid;
      const guilds = getGuilds();
      outer2: for (const g of guilds) for (const c of g.channels) {
        if (c.id === tid) {
          s.selectedTextChannelName = c.name; s.selectedTextChannelPath = c.path;
          s.selectedGuildId = g.id; s.selectedGuildName = g.name;
          break outer2;
        }
      }
    } else {
      s.selectedGuildId = ChannelAdapter.selectedGuildId();
    }
  } catch { /* nulls */ }

  try {
    s.userStatus = StatusAdapter.getStatus();
    const cs = StatusAdapter.getCustomStatus();
    s.customStatusText = cs.text; s.customStatusEmojiName = cs.emojiName;
  } catch { /* unknowns */ }

  try {
    s.inputVolume = VolumeAdapter.getInputVolume();
    s.outputVolume = VolumeAdapter.getOutputVolume();
  } catch { /* nulls */ }
  try {
    s.voiceUsers = getVoiceUsers();
  } catch { s.voiceUsers = []; }
  try {
    const cur = DeviceAdapter.current();
    s.inputDeviceId = cur.inputId; s.inputDeviceName = cur.inputName;
    s.outputDeviceId = cur.outputId; s.outputDeviceName = cur.outputName;
  } catch { /* nulls */ }
  try { Object.assign(s, AudioProcessingAdapter.snapshot()); } catch { /* nulls */ }
  try { Object.assign(s, StageAdapter.snapshot()); } catch { /* nulls */ }

  s.availableCapabilities = caps.available;
  s.unavailableReasons = caps.unavailableReasons;
  return s;
}

/** Incremental patch queue with debounce; immediate for discrete keys. */
export function queuePatch(patch: Partial<State>) {
  const immediate = Object.keys(patch).some(k => IMMEDIATE_KEYS.has(k));
  if (!ctx.emit) return;
  if (immediate) {
    flushPending();
    ctx.seq += 1;
    ctx.emit({ ...patch }, ctx.seq);
    return;
  }
  Object.assign(ctx.pendingPatch, patch);
  if (ctx.debounceTimer) return;
  ctx.debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
}

function flushPending() {
  if (ctx.debounceTimer) { clearTimeout(ctx.debounceTimer); ctx.debounceTimer = null; }
  const keys = Object.keys(ctx.pendingPatch);
  if (keys.length === 0 || !ctx.emit) return;
  const patch = { ...ctx.pendingPatch };
  ctx.pendingPatch = {};
  ctx.seq += 1;
  ctx.emit(patch, ctx.seq);
}

export function resetSeq() { ctx.seq = 0; ctx.pendingPatch = {}; }

/** Subscribe to FluxDispatcher events (best-effort, per-build event names). */
export function subscribeAll(onPatch: (patch: Partial<State>, seq: number) => void) {
  ctx.emit = onPatch;
  unsubscribeAll();
  const d = getDispatcher();
  if (!d) {
    log.warn("state", "FluxDispatcher unavailable; live updates degraded until Discord internals resolve");
    return;
  }
  // Candidate event names across Discord builds (current builds use the AUDIO_*
  // actions; the SELF_*_UPDATE names are kept for older builds). Missing ones are skipped silently.
  const handlers: [string, () => Partial<State>][] = [
    ["AUDIO_TOGGLE_SELF_MUTE", () => ({ selfMuted: VoiceAdapter.isSelfMuted() })],
    ["AUDIO_SET_SELF_MUTE", () => ({ selfMuted: VoiceAdapter.isSelfMuted() })],
    ["AUDIO_SET_TEMPORARY_SELF_MUTE", () => ({ selfMuted: VoiceAdapter.isSelfMuted() })],
    ["AUDIO_TOGGLE_SELF_DEAF", () => ({ selfDeafened: VoiceAdapter.isSelfDeafened() })],
    ["SELF_MUTE_UPDATE", () => ({ selfMuted: VoiceAdapter.isSelfMuted() })],
    ["SELF_DEAF_UPDATE", () => ({ selfDeafened: VoiceAdapter.isSelfDeafened() })],
    ["VOICE_STATE_UPDATES", () => {
      const id = VoiceAdapter.currentVoiceChannelId();
      return { voiceChannelId: id, voiceConnected: !!id, selfMuted: VoiceAdapter.isSelfMuted(), selfDeafened: VoiceAdapter.isSelfDeafened(), voiceUsers: getVoiceUsers() };
    }],
    ["VOICE_CHANNEL_SELECT", () => {
      const id = VoiceAdapter.currentVoiceChannelId();
      return { voiceChannelId: id, voiceConnected: !!id, voiceUsers: getVoiceUsers() };
    }],
    ["CHANNEL_SELECT", () => ({ selectedTextChannelId: ChannelAdapter.selectedTextChannelId() })],
    ["PRESENCE_UPDATES", () => ({ userStatus: StatusAdapter.getStatus() })],
    ["USER_SETTINGS_PROTO_UPDATE", () => {
      const cs = StatusAdapter.getCustomStatus();
      return { customStatusText: cs.text, customStatusEmojiName: cs.emojiName };
    }],
    ["AUDIO_VOLUME_CHANGE", () => ({ inputVolume: VolumeAdapter.getInputVolume(), outputVolume: VolumeAdapter.getOutputVolume() })],
    ["MEDIA_ENGINE_STATE", () => ({ selfMuted: VoiceAdapter.isSelfMuted(), selfDeafened: VoiceAdapter.isSelfDeafened() })],
  ];
  for (const [evt, fn] of handlers) {
    try {
      const wrapped = () => {
        try { queuePatch(fn()); }
        catch (e) { log.debug("state", `handler ${evt} failed (non-fatal)`); }
      };
      d.subscribe(evt, wrapped);
      fluxUnsubs.push(() => { try { d.unsubscribe(evt, wrapped); } catch { /* ignore */ } });
    } catch { /* event not supported in this build — skip */ }
  }
  log.info("state", `subscribed to ${fluxUnsubs.length} dispatcher events`);
}

export function unsubscribeAll() {
  for (const u of fluxUnsubs) { try { u(); } catch { /* ignore */ } }
  fluxUnsubs = [];
  if (ctx.debounceTimer) { clearTimeout(ctx.debounceTimer); ctx.debounceTimer = null; }
  ctx.pendingPatch = {};
}

export function currentGuilds(): Guild[] { return getGuilds(); }
export function currentDevices(): { inputs: Device[]; outputs: Device[] } { return DeviceAdapter.list(); }
