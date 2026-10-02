/**
 * settings.ts — Settings design (§2 + deliverable #4).
 *
 * Vencord pattern: `definePluginSettings` with SettingType. We ALSO keep a
 * plain defaults object + validation so the plugin (and mock tests) work
 * without the Vencord runtime.
 */
export interface BridgeSettings {
  enable: boolean;
  host: string;               // default 127.0.0.1 — never change unless you know why
  port: number;               // default 8323
  token: string;              // secret — NEVER logged
  readOnly: boolean;          // local enforcement mirror (server authoritative)
  debugLogging: boolean;
  reconnectBaseMs: number;    // informational; backoff ladder is fixed per §11
  showConnectionStatus: boolean;
}

export const DEFAULT_SETTINGS: BridgeSettings = {
  enable: true,
  host: "127.0.0.1",
  port: 8323,
  token: "",
  readOnly: false,
  debugLogging: false,
  reconnectBaseMs: 1000,
  showConnectionStatus: true,
};

/** Backoff ladder §11: 1s → 2s → 5s → 10s → 30s max, jitter ±20%. */
export const BACKOFF_LADDER_MS = [1000, 2000, 5000, 10000, 30000];

export function backoffDelay(attempt: number): number {
  const base = BACKOFF_LADDER_MS[Math.min(attempt, BACKOFF_LADDER_MS.length - 1)];
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(250, Math.round(base + jitter));
}

export function sanitizeHost(host: string): string {
  const h = (host || "").trim();
  // Localhost only for v1. Refuse non-loopback with a clear fallback.
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") return h === "localhost" ? "127.0.0.1" : h;
  return DEFAULT_SETTINGS.host;
}

export function sanitizePort(port: unknown): number {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 8323;
  return p;
}

/**
 * Vencord settings descriptor (passed to definePluginSettings when available).
 * Kept as data so index.ts can build it lazily without hard-importing Vencord.
 */
export function settingsDescriptor() {
  return {
    enable: { type: "boolean", default: true, description: "Auto-connect to Macro Deck bridge" },
    host: { type: "string", default: "127.0.0.1", description: "Bridge host (localhost only)" },
    port: { type: "number", default: 8323, description: "Bridge port (default 8323)" },
    token: { type: "password", default: "", description: "Bridge token (from Macro Deck settings; never logged)" },
    readOnly: { type: "boolean", default: false, description: "Read-only: report state, reject mutating commands" },
    debugLogging: { type: "boolean", default: false, description: "Verbose debug logging (still never logs secrets)" },
    reconnectBaseMs: { type: "number", default: 1000, description: "Reconnect base delay ms (ladder 1s→30s)" },
  } as const;
}

/** Runtime status shown in settings panel (connection status, capabilities, last error). */
export interface RuntimeStatus {
  connected: boolean;
  authenticated: boolean;
  discordReady: boolean;
  sessionShort: string | null;
  lastError: string | null;
  capabilitiesTrue: string[];
  capabilitiesFalse: string[];
  reconnectAttempt: number;
}
