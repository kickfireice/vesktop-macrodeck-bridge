/** errors.ts — normative error codes (§10) + sanitized helpers. */
import { makeEnvelope } from "./protocol";

export const ERROR_CODES = [
  "AUTH_FAILED", "ALREADY_CONNECTED", "SESSION_REPLACED", "TOKEN_REVOKED",
  "VERSION_MISMATCH", "UNKNOWN_TYPE", "SCHEMA_INVALID", "TOO_LARGE",
  "RATE_LIMITED", "UNKNOWN_COMMAND", "UNSUPPORTED", "AMBIGUOUS", "NOT_FOUND",
  "READ_ONLY", "TIMEOUT", "VOICE_ERROR", "PERMISSION_DENIED",
  "DISCORD_NOT_READY", "INTERNAL_ERROR", "CHANNEL_FULL", "ALREADY_IN_CHANNEL",
] as const;

export interface CommandError { code: string; message: string; candidates?: unknown; details?: Record<string, unknown>; }

/** Build a command_result envelope (ok true/false). Never includes secrets. */
export function commandResult(
  command: string, ok: boolean,
  opts: { replyTo: string; sid?: string; statePatch?: Record<string, unknown>; error?: CommandError; extra?: Record<string, unknown> }
) {
  const payload: Record<string, any> = { ok, command, ...(opts.statePatch ? { statePatch: opts.statePatch } : {}) };
  if (!ok && opts.error) payload.error = { code: opts.error.code, message: opts.error.message };
  if (!ok && opts.error?.candidates) (payload.error as any).candidates = opts.error.candidates;
  if (opts.extra) Object.assign(payload, opts.extra);
  return makeEnvelope("command_result", payload, { replyTo: opts.replyTo, sid: opts.sid });
}

export const err = (code: string, message: string, extra?: Partial<CommandError>): CommandError =>
  ({ code, message, ...extra });

/** Clamp helper for volume ranges (§6: in/out 0-100, per-user 0-200, attenuation 0-100). */
export function clampVolume(kind: "io" | "user" | "attenuation", v: number): number | null {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  if (kind === "io") return Math.min(100, Math.max(0, Math.round(v)));
  if (kind === "user") return Math.min(200, Math.max(0, Math.round(v)));
  return Math.min(100, Math.max(0, Math.round(v)));
}
