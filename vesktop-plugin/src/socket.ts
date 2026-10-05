/**
 * socket.ts — WS client design + reconnect (§2, §9, §11, deliverables #5/#6).
 *
 * - hello FIRST (protocolVersion/name/version/token/capabilities), store sid.
 * - capability_update + full state_snapshot after welcome; resync after reconnect.
 * - Heartbeats per welcome interval (default 5s); 15s silence → reconnect.
 * - Backoff 1s→2s→5s→10s→30s max + ±20% jitter. No tight loops.
 * - Token ONLY in hello, only to configured localhost bridge. Never logged.
 * - Queue max 32 pending commands; excess inbound dropped with RATE_LIMITED.
 */
import {
  PROTOCOL_VERSION, DEFAULT_HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS,
  SIMPLE_CMD_TIMEOUT_MS, VOICE_CMD_TIMEOUT_MS,
  makeEnvelope, validateInbound, uuidv4, utf8Size, MAX_MESSAGE_BYTES,
  type Envelope,
} from "./protocol";
import { backoffDelay } from "./settings";
import { commandResult } from "./errors";
import { log, shortSid, logCoalesced } from "./logger";

export interface SocketDeps {
  getUrl: () => string;
  getToken: () => string;
  isEnabled: () => boolean;
  isReadOnly: () => boolean;
  getCapabilities: () => { available: Record<string, boolean>; unavailableReasons: Record<string, string> };
  onWelcome: (welcome: Envelope) => void;
  onCommand: (command: string, args: any, id: string) => Promise<{ ok: boolean; code?: string; message?: string; statePatch?: Record<string, unknown>; candidates?: unknown; extra?: Record<string, unknown> }>;
  onGetState: (id: string) => void;
  onRequestCaps: () => void;
  onRequestChannels: () => void;
  onRequestDevices: () => void;
  onHeartbeatRequest: (id?: string) => void;
  onDisconnect: (reason: string) => void;
  onConnect: () => void;
  onError: (code: string, message: string) => void;
  isDiscordReady: () => boolean;
}

type WSFactory = (url: string) => any;

export class BridgeSocket {
  private ws: any = null;
  private deps: SocketDeps;
  private wsFactory: WSFactory;
  private sid: string | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private hbIntervalMs = DEFAULT_HEARTBEAT_MS;
  private lastInbound = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private pendingCmds = 0;
  private helloId: string | null = null;

  constructor(deps: SocketDeps, wsFactory?: WSFactory) {
    this.deps = deps;
    this.wsFactory = wsFactory ?? defaultFactory;
  }

  get sessionId() { return this.sid; }
  get connected() { return !!this.ws && this.ws.readyState === 1; }
  get reconnectAttempt() { return this.attempt; }

  start() { this.scheduleConnect(0); }
  stop() {
    this.closedByUs = true;
    this.clearTimers();
    try { this.ws?.close?.(1000, "plugin stop"); } catch { /* ignore */ }
    this.ws = null; this.sid = null;
  }

  private scheduleConnect(delayMs: number) {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.closedByUs) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectOnce();
    }, Math.max(0, delayMs));
  }

  private connectOnce() {
    if (this.closedByUs || !this.deps.isEnabled()) {
      // Stay parked; index.ts re-calls start()/poke() when settings change.
      this.scheduleConnect(5000);
      return;
    }
    const url = this.deps.getUrl();
    let ws: any;
    try { ws = this.wsFactory(url); }
    catch (e: any) {
      this.deps.onError("INTERNAL_ERROR", `ws create failed: ${String(e?.message ?? e).slice(0, 80)}`);
      this.retryLater();
      return;
    }
    this.ws = ws;
    this.lastInbound = Date.now();

    ws.onopen = () => {
      this.deps.onConnect();
      this.sendHello();
      this.startHeartbeat();
    };
    ws.onmessage = (ev: any) => {
      const raw = typeof ev?.data === "string" ? ev.data : String(ev?.data ?? "");
      this.handleInbound(raw);
    };
    ws.onerror = () => { /* onclose carries the signal; avoid double-log */ };
    ws.onclose = (ev: any) => {
      const code = ev?.code; const reason = String(ev?.reason ?? "");
      this.onWsClose(code, reason);
    };
    this.startWatchdog();
  }

  private sendHello() {
    const caps = this.deps.getCapabilities();
    const id = uuidv4();
    this.helloId = id;
    const env = makeEnvelope("hello", {
      protocolVersion: PROTOCOL_VERSION,
      name: "vesktop-bridge",
      version: "1.0.5",
      token: this.deps.getToken(), // ONLY place token is ever sent
      capabilities: caps.available,
    }, { id });
    this.sendRaw(env, true);
  }

  private handleInbound(raw: string) {
    this.lastInbound = Date.now();
    if (utf8Size(raw) > MAX_MESSAGE_BYTES) {
      log.warn("socket", "protocol_error TOO_LARGE (dropped)");
      return;
    }
    const v = validateInbound(raw);
    if (!v.ok) {
      if (v.code === "VERSION_MISMATCH") {
        this.deps.onError("VERSION_MISMATCH", v.message);
        try { this.ws?.close?.(4400, "version"); } catch { /* ignore */ }
      } else {
        logCoalesced("inbound-invalid", "warn", "socket", `protocol_error ${v.code}`);
      }
      return;
    }
    const env = v.env;
    switch (env.type) {
      case "welcome": {
        const sid = String(env.payload?.sessionId ?? env.sid ?? "");
        if (!sid) { this.deps.onError("SCHEMA_INVALID", "welcome without sessionId"); return; }
        this.sid = sid;
        this.attempt = 0; // reset backoff on success
        this.hbIntervalMs = Number(env.payload?.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_MS;
        log.info("socket", `welcome sid=${shortSid(sid)} hb=${this.hbIntervalMs}ms`);
        this.restartHeartbeat();
        this.deps.onWelcome(env);
        break;
      }
      case "command": {
        if (!this.sid) { log.warn("socket", "command before welcome (dropped)"); break; }
        if (this.pendingCmds >= 32) {
          this.sendRaw(commandResult(String(env.payload?.command ?? "?"), false, {
            replyTo: String(env.id ?? ""), sid: this.sid ?? undefined,
            error: { code: "RATE_LIMITED", message: "too many pending commands" },
          }));
          break;
        }
        const cmd = String(env.payload?.command ?? "");
        const args = (env.payload?.args ?? {}) as any;
        const id = String(env.id ?? "");
        const voice = /join|move|voice/i.test(cmd);
        this.pendingCmds += 1;
        const timer = setTimeout(() => {
          // Timeout guard: Macro Deck surfaces TIMEOUT; we still answer late if we finish.
          log.warn("socket", `command timeout cmd=${cmd}`);
        }, voice ? VOICE_CMD_TIMEOUT_MS : SIMPLE_CMD_TIMEOUT_MS);
        // Fire-and-forget with late-answer tolerance; never let handler throw.
        this.deps.onCommand(cmd, args, id).then(outcome => {
          clearTimeout(timer);
          this.pendingCmds = Math.max(0, this.pendingCmds - 1);
          this.sendRaw(commandResult(cmd, outcome.ok, {
            replyTo: id, sid: this.sid ?? undefined,
            statePatch: outcome.statePatch,
            error: outcome.ok ? undefined : { code: outcome.code ?? "INTERNAL_ERROR", message: outcome.message ?? "failed", candidates: outcome.candidates as any },
            extra: outcome.extra,
          }));
        }).catch(e => {
          clearTimeout(timer);
          this.pendingCmds = Math.max(0, this.pendingCmds - 1);
          log.error("socket", `command handler threw for ${cmd} (guarded)`);
          this.sendRaw(commandResult(cmd, false, {
            replyTo: id, sid: this.sid ?? undefined,
            error: { code: "INTERNAL_ERROR", message: "handler exception (guarded)" },
          }));
        });
        break;
      }
      case "get_state": this.deps.onGetState(String(env.id ?? "")); break;
      case "request_capabilities": this.deps.onRequestCaps(); break;
      case "request_channel_list": this.deps.onRequestChannels(); break;
      case "request_device_list": this.deps.onRequestDevices(); break;
      case "heartbeat_request": this.deps.onHeartbeatRequest(env.id ? String(env.id) : undefined); break;
      case "error": {
        const code = String(env.payload?.code ?? "UNKNOWN");
        log.warn("socket", `server error code=${code}`);
        if (code === "AUTH_FAILED") { this.deps.onError("AUTH_FAILED", "bridge rejected token"); try { this.ws?.close?.(4401, "auth"); } catch { /* ignore */ } }
        else if (code === "TOKEN_REVOKED" || code === "SESSION_REPLACED") { this.sid = null; this.retryLater(); }
        else this.deps.onError(code, String(env.payload?.message ?? code).slice(0, 120));
        break;
      }
    }
  }

  /** Public send (snapshot/update/caps/lists/heartbeat/error). Validates size. */
  send(type: string, payload: Record<string, any>, opts: { id?: string; replyTo?: string } = {}) {
    this.sendRaw(makeEnvelope(type, payload, { ...opts, sid: this.sid ?? undefined }));
  }

  sendHeartbeat() {
    if (!this.connected) return;
    this.send("heartbeat", { ok: true, discordReady: this.deps.isDiscordReady() });
  }

  private sendRaw(env: Envelope, isHello = false) {
    if (!this.ws || this.ws.readyState !== 1) return;
    let text: string;
    try { text = JSON.stringify(env); }
    catch { log.error("socket", "stringify failed (dropped)"); return; }
    if (utf8Size(text) > MAX_MESSAGE_BYTES) { log.warn("socket", "protocol_error TOO_LARGE on send (dropped)"); return; }
    try { this.ws.send(text); }
    catch (e) { log.debug("socket", "send failed (will retry on reconnect)"); }
    void isHello;
  }

  private startHeartbeat() {
    this.restartHeartbeat();
  }
  private restartHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    this.hbTimer = setInterval(() => this.sendHeartbeat(), this.hbIntervalMs);
  }
  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.ws) return;
      if (Date.now() - this.lastInbound > HEARTBEAT_TIMEOUT_MS && this.sid) {
        logCoalesced("hb-timeout", "warn", "socket", "heartbeat timeout (reconnecting)");
        try { this.ws.close?.(4000, "heartbeat timeout"); } catch { /* ignore */ }
      }
    }, 2000);
  }

  private onWsClose(code: number | undefined, reason: string) {
    this.clearSockTimers();
    const hadSession = !!this.sid;
    this.sid = null;
    this.ws = null;
    if (this.closedByUs) return;
    // AUTH_FAILED / VERSION_MISMATCH closes still back off (rate-limit friendly).
    if (code === 4401) log.warn("socket", "auth failed (check token + port)");
    else if (code === 4400) log.warn("socket", "version mismatch");
    else if (code === 4409) log.warn("socket", "already connected (another client holds the session)");
    else log.info("socket", `disconnected code=${code ?? "?"} ${reason}`.trim());
    this.deps.onDisconnect(`WS_CLOSE_${code ?? "?"}`);
    void hadSession;
    this.retryLater();
  }

  private retryLater() {
    this.clearSockTimers();
    if (this.closedByUs) return;
    const delay = backoffDelay(this.attempt);
    log.info("socket", `reconnect attempt #${this.attempt + 1} in ${delay}ms`);
    this.attempt += 1;
    this.scheduleConnect(delay);
  }

  /** External poke (settings changed / Discord ready). */
  poke() {
    if (!this.ws && !this.reconnectTimer && !this.closedByUs) this.scheduleConnect(0);
  }
  reconnectNow() {
    try { this.ws?.close?.(4000, "manual"); } catch { /* ignore */ }
    this.retryLater();
  }

  private clearSockTimers() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }
  private clearTimers() {
    this.clearSockTimers();
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

function defaultFactory(url: string): any {
  const W: any = (globalThis as any).WebSocket;
  if (typeof W !== "function") throw new Error("no WebSocket global (Vesktop renderer or ws package required)");
  return new W(url);
}
