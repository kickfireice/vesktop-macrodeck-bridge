/** logger.ts — sanitized logging (§13). Never logs tokens, full sids, Discord tokens. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = ["token", "discordtoken", "cookie", "password", "authorization"];
let level: LogLevel = "info";
let debugEnabled = false;

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setDebugEnabled(on: boolean) { debugEnabled = on; }
export function setLevel(l: LogLevel) { level = l; }

/** Redact secret-ish fields + truncate long dumps. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") {
    if (value.length > 400) return value.slice(0, 400) + "…[truncated]";
    return value;
  }
  if (Array.isArray(value)) {
    const cut = value.slice(0, 10);
    return cut.map(v => sanitize(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.includes(k.toLowerCase())) { out[k] = "[redacted]"; continue; }
      if (k.toLowerCase() === "sid" && typeof v === "string") { out[k] = shortSid(v); continue; }
      if (k.toLowerCase() === "sessionid" && typeof v === "string") { out[k] = shortSid(v); continue; }
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function shortSid(sid: string | undefined | null): string {
  if (!sid || typeof sid !== "string") return "?";
  return sid.slice(0, 8);
}

function emit(l: LogLevel, tag: string, msg: string, extra?: unknown) {
  if (order[l] < order[level]) return;
  if (l === "debug" && !debugEnabled) return;
  const line = `[MacroDeckBridge][${tag}][${l}] ${msg}`;
  if (l === "error") console.error(line, extra !== undefined ? sanitize(extra) : "");
  else if (l === "warn") console.warn(line, extra !== undefined ? sanitize(extra) : "");
  else console.log(line, extra !== undefined ? sanitize(extra) : "");
}

// Coalesce repeats: one info line per transition, rest debug.
const lastSeen = new Map<string, number>();
export function logCoalesced(key: string, l: LogLevel, tag: string, msg: string, windowMs = 10000) {
  const now = Date.now();
  const prev = lastSeen.get(key) ?? 0;
  if (now - prev < windowMs) {
    if (debugEnabled) emit("debug", tag, `(repeat) ${msg}`);
    return;
  }
  lastSeen.set(key, now);
  emit(l, tag, msg);
}

export const log = {
  debug: (tag: string, msg: string, extra?: unknown) => emit("debug", tag, msg, extra),
  info: (tag: string, msg: string, extra?: unknown) => emit("info", tag, msg, extra),
  warn: (tag: string, msg: string, extra?: unknown) => emit("warn", tag, msg, extra),
  error: (tag: string, msg: string, extra?: unknown) => emit("error", tag, msg, extra),
};
