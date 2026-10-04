/**
 * index.ts — Vencord-style plugin entry (client side).
 *
 * Wires: settings → socket (hello/auth/heartbeat/reconnect) → adapters →
 * state snapshot/subscriptions → command handler → capability reporting.
 *
 * Runs inside Vesktop/Vencord renderer. All Discord access is best-effort via
 * adapters/discovery; missing internals degrade to UNSUPPORTED, never crash.
 */
import { PROTOCOL_VERSION, DEFAULT_PORT, DEFAULT_HOST } from "./protocol";
import { DEFAULT_SETTINGS, sanitizeHost, sanitizePort, type RuntimeStatus } from "./settings";
import { log, setDebugEnabled, shortSid } from "./logger";
import { BridgeSocket } from "./socket";
import { buildCapabilities } from "./capabilities";
import {
  buildSnapshot, subscribeAll, unsubscribeAll, resetSeq,
  setSessionFlags, discordReady, currentGuilds, currentDevices,
} from "./state";
import { handleCommand } from "./commands";
import { clearDiscoveryCache } from "./adapters/discovery";

const PLUGIN_NAME = "MacroDeckBridge";
const PLUGIN_VERSION = "1.0.0";

// Settings backing: Vencord store when available, else in-memory defaults.
type S = typeof DEFAULT_SETTINGS;
let memSettings: S = { ...DEFAULT_SETTINGS };
let vencordSettings: any = null;

function loadVencordSettings(): any | null {
  try {
    const req: any = (window as any)?.require;
    if (typeof req !== "function") return null;
    // Exact module path varies by Vencord version — probe, never hard-require at top level.
    const candidates = ["@vencord/types", "vencord/settings"];
    void candidates;
    return null; // scaffold uses in-memory settings; host wires real store in Vesktop
  } catch { return null; }
}

export function getSettings(): S {
  try {
    if (vencordSettings) {
      return {
        enable: vencordSettings.enable ?? memSettings.enable,
        host: sanitizeHost(String(vencordSettings.host ?? memSettings.host)),
        port: sanitizePort(vencordSettings.port ?? memSettings.port),
        token: String(vencordSettings.token ?? memSettings.token ?? ""),
        readOnly: !!(vencordSettings.readOnly ?? memSettings.readOnly),
        debugLogging: !!(vencordSettings.debugLogging ?? memSettings.debugLogging),
        reconnectBaseMs: Number(vencordSettings.reconnectBaseMs ?? memSettings.reconnectBaseMs ?? 1000),
        showConnectionStatus: true,
      };
    }
  } catch { /* fall through to memory */ }
  return { ...memSettings, host: sanitizeHost(memSettings.host), port: sanitizePort(memSettings.port) };
}

export function updateSettings(patch: Partial<S>) {
  memSettings = { ...memSettings, ...patch };
  if (vencordSettings) Object.assign(vencordSettings, patch);
  setDebugEnabled(getSettings().debugLogging);
  socket?.poke();
}

// Runtime status for settings panel (status display, capabilities display, last error).
const runtime: RuntimeStatus = {
  connected: false, authenticated: false, discordReady: false,
  sessionShort: null, lastError: null,
  capabilitiesTrue: [], capabilitiesFalse: [], reconnectAttempt: 0,
};
export function getRuntimeStatus(): RuntimeStatus { return { ...runtime }; }
function refreshRuntimeCaps() {
  try {
    const c = buildCapabilities();
    runtime.capabilitiesTrue = Object.keys(c.available).filter(k => c.available[k]);
    runtime.capabilitiesFalse = Object.keys(c.available).filter(k => !c.available[k]);
  } catch { /* ignore */ }
}

let socket: BridgeSocket | null = null;
let started = false;

function wsUrl(): string {
  const s = getSettings();
  // MUST include /ws/ — the server's HttpListener prefix is http://127.0.0.1:{port}/ws/
  // (bare ws://host:port/ gets a 404 from http.sys and the socket never opens).
  return `ws://${s.host}:${s.port}/ws/`;
}

function sendSnapshotWithReply(replyTo?: string) {
  if (!socket) return;
  try {
    const snap = buildSnapshot();
    if (replyTo) socket.send("state_snapshot", snap as any, { id: replyTo, replyTo });
    else socket.send("state_snapshot", snap as any);
  } catch (e) { log.error("plugin", "snapshot failed (guarded)"); }
}
function sendCaps() {
  if (!socket) return;
  try {
    const c = buildCapabilities();
    socket.send("capability_update", { available: c.available, unavailableReasons: c.unavailableReasons });
    refreshRuntimeCaps();
  } catch { /* ignore */ }
}
function sendChannels() {
  if (!socket) return;
  try {
    const guilds = currentGuilds();
    socket.send("channel_list_update", { guilds, seq: 1 });
  } catch { /* ignore */ }
}
function sendDevices() {
  if (!socket) return;
  try {
    const { inputs, outputs } = currentDevices();
    socket.send("device_list_update", { inputs, outputs });
  } catch { /* ignore */ }
}

function buildSocket(): BridgeSocket {
  return new BridgeSocket({
    getUrl: wsUrl,
    getToken: () => getSettings().token,
    isEnabled: () => getSettings().enable,
    isReadOnly: () => getSettings().readOnly,
    getCapabilities: () => buildCapabilities(),
    isDiscordReady: () => { try { return discordReady(); } catch { return false; } },
    onConnect: () => { runtime.connected = true; runtime.lastError = null; },
    onDisconnect: (reason) => {
      runtime.connected = false; runtime.authenticated = false; runtime.sessionShort = null;
      setSessionFlags({ authenticated: false, bridgeRunning: false, lastError: reason });
    },
    onError: (code, message) => {
      runtime.lastError = code;
      setSessionFlags({ lastError: code });
      log.warn("plugin", `bridge error code=${code} msg=${message}`);
    },
    onWelcome: (welcome) => {
      const sid = String((welcome.payload as any)?.sessionId ?? "");
      const readOnlyServer = !!(welcome.payload as any)?.readOnly;
      const hb = Number((welcome.payload as any)?.heartbeatIntervalMs) || 5000;
      void hb;
      runtime.authenticated = true;
      runtime.sessionShort = shortSid(sid);
      const localRO = getSettings().readOnly;
      setSessionFlags({ authenticated: true, bridgeRunning: true, readOnly: localRO || readOnlyServer, lastError: null });
      resetSeq();
      sendCaps();
      sendSnapshotWithReply();
      if ((welcome.payload as any)?.requestSnapshot !== false) { /* snapshot already sent */ }
      sendChannels();
      sendDevices();
      runtime.discordReady = discordReady();
      log.info("plugin", `session sid=${shortSid(sid)} readOnly=${localRO || readOnlyServer}`);
    },
    onCommand: async (command, args, id) => {
      const caps = buildCapabilities();
      const out = await handleCommand(command, args ?? {}, {
        readOnly: getSettings().readOnly,
        sid: socket?.sessionId ?? null,
        caps,
        emitSnapshot: () => sendSnapshotWithReply(),
        emitChannels: () => sendChannels(),
        emitDevices: () => sendDevices(),
      });
      if (!out.ok) log.info("plugin", `command failed cmd=${command} code=${out.code}`);
      return out;
    },
    onGetState: (id) => sendSnapshotWithReply(id),
    onRequestCaps: () => sendCaps(),
    onRequestChannels: () => sendChannels(),
    onRequestDevices: () => sendDevices(),
    onHeartbeatRequest: (id) => {
      try { socket?.send("heartbeat", { ok: true, discordReady: discordReady() }, id ? { replyTo: id } : {}); }
      catch { /* ignore */ }
    },
  });
}

// ---------------------------------------------------------------- Vencord plugin definition
// Compatible with `definePlugin({ name, description, authors, start, stop })`.
// If the Vencord helper is unavailable (plain test env), we still export start/stop.

export function start() {
  if (started) return;
  started = true;
  vencordSettings = loadVencordSettings();
  setDebugEnabled(getSettings().debugLogging);
  clearDiscoveryCache();
  refreshRuntimeCaps();
  log.info("plugin", `${PLUGIN_NAME} v${PLUGIN_VERSION} starting (protocol v${PROTOCOL_VERSION}, bridge ${DEFAULT_HOST}:${DEFAULT_PORT} default)`);
  try {
    subscribeAll((patch, seq) => {
      try { socket?.send("state_update", { patch, seq }); }
      catch { /* guarded */ }
    });
  } catch (e) { log.warn("plugin", "state subscribe failed (degraded, snapshot-on-demand still works)"); }
  socket = buildSocket();
  socket.start();
}

export function stop() {
  started = false;
  try { unsubscribeAll(); } catch { /* ignore */ }
  try { socket?.stop(); } catch { /* ignore */ }
  socket = null;
  runtime.connected = false; runtime.authenticated = false; runtime.sessionShort = null;
  log.info("plugin", "stopped");
}

// Default export for Vencord loader.
const pluginDef: any = {
  name: PLUGIN_NAME,
  description: "Local bridge client for Macro Deck (localhost only, token auth, protocol v1.0.0).",
  authors: [{ name: "MacroDeckBridge", id: 0n }],
  version: PLUGIN_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  start,
  stop,
  settings: {
    enable: { type: 1, default: true, description: "Auto-connect to Macro Deck bridge" },
    host: { type: 0, default: "127.0.0.1", description: "Bridge host (localhost only)" },
    port: { type: 2, default: 8323, description: "Bridge port (default 8323)" },
    token: { type: 0, default: "", description: "Bridge token (never logged)", isPassword: true },
    readOnly: { type: 1, default: false, description: "Read-only: report state, reject mutating commands" },
    debugLogging: { type: 1, default: false, description: "Verbose debug logging (secrets still never logged)" },
  },
  getRuntimeStatus,
  getSettings,
  updateSettings,
};

export default pluginDef;
