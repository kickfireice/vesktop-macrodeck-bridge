/**
 * mock-bridge/mockBridge.js — Mock Macro Deck SERVER for local protocol testing.
 *
 * Implements the server side of PROTOCOL.md §1–§5 so the Vesktop plugin
 * (or any WS client) can be tested without Macro Deck installed:
 *  - binds 127.0.0.1:8323 (fallback next free port + prints actual port)
 *  - hello→welcome(sid) handshake, token check, single-client policy
 *  - heartbeat timeout (15s), get_state / request_* / command dispatch
 *  - CLI: send commands interactively; --selftest runs an automated sequence
 *
 * Usage:
 *   npm install            # installs `ws`
 *   node mock-bridge/mockBridge.js [--port 8323] [--token secret] [--selftest]
 *
 * Local-only. Token `test-token-123` default is FOR TESTS ONLY.
 */
"use strict";

const http = require("http");
let WebSocketServer = null;
try {
  ({ WebSocketServer } = require("ws"));
} catch (e) {
  console.error("[mock-bridge] missing dep `ws`. Run: npm install");
  process.exit(1);
}

const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_PORT = 8323;
const MAX_BYTES = 65536;
const HEARTBEAT_TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const SELFTEST = args.includes("--selftest");
const TOKEN = arg("--token", process.env.MOCK_BRIDGE_TOKEN || "test-token-123");
let PORT = parseInt(arg("--port", String(DEFAULT_PORT)), 10) || DEFAULT_PORT;

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

const send = (ws, obj) => {
  const text = JSON.stringify(obj);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    console.warn("[mock-bridge] send dropped: TOO_LARGE");
    return;
  }
  ws.send(text);
};
const err = (ws, code, message, replyTo, sid) =>
  send(ws, { v: PROTOCOL_VERSION, type: "error", ts: Date.now(), sid, replyTo, payload: { code, message } });

let activeSession = null; // { sid, ws }
let snapshot = null;
let caps = null;
let lastSeq = 0;
let cmdCounter = 0;

function validateHello(msg) {
  if (msg.v !== PROTOCOL_VERSION) return "VERSION_MISMATCH";
  const p = msg.payload || {};
  if (!p.protocolVersion || p.protocolVersion !== PROTOCOL_VERSION) return "VERSION_MISMATCH";
  if (p.token !== TOKEN) return "AUTH_FAILED";
  return null;
}

function listen(port, triesLeft = 10) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, maxPayload: MAX_BYTES });

  wss.on("connection", (ws) => {
    console.log("[mock-bridge] tcp connect from 127.0.0.1");
    let authed = false;
    let sid = null;
    let helloTimer = setTimeout(() => {
      if (!authed) { try { ws.close(4401, "hello timeout"); } catch {} }
    }, 5000);
    let lastSeen = Date.now();
    const wd = setInterval(() => {
      if (authed && Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        console.log("[mock-bridge] heartbeat timeout, closing");
        try { ws.close(4000, "heartbeat timeout"); } catch {}
      }
    }, 2000);

    ws.on("message", (buf) => {
      lastSeen = Date.now();
      const text = buf.toString("utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
        err(ws, "TOO_LARGE", "message exceeds 64KB"); return;
      }
      let msg;
      try { msg = JSON.parse(text); } catch { err(ws, "SCHEMA_INVALID", "invalid JSON"); return; }
      if (msg.v !== PROTOCOL_VERSION) { err(ws, "VERSION_MISMATCH", "unsupported version"); try { ws.close(4400); } catch {} return; }

      // ---- hello (first message, unauthenticated) ----
      if (!authed) {
        if (msg.type !== "hello") { try { ws.close(4401, "hello first"); } catch {} return; }
        const problem = validateHello(msg);
        if (problem === "AUTH_FAILED") {
          console.log(`[mock-bridge] auth failure from 127.0.0.1 at ${new Date().toISOString()}`);
          send(ws, { v: PROTOCOL_VERSION, type: "error", replyTo: msg.id, ts: Date.now(), payload: { code: "AUTH_FAILED", message: "bad token" } });
          try { ws.close(4401, "auth"); } catch {}
          return;
        }
        if (problem === "VERSION_MISMATCH") {
          send(ws, { v: PROTOCOL_VERSION, type: "error", replyTo: msg.id, ts: Date.now(), payload: { code: "VERSION_MISMATCH", message: "bad version", supported: [PROTOCOL_VERSION] } });
          try { ws.close(4400, "version"); } catch {}
          return;
        }
        if (activeSession) {
          send(ws, { v: PROTOCOL_VERSION, type: "error", replyTo: msg.id, ts: Date.now(), payload: { code: "ALREADY_CONNECTED", message: "another client holds the session" } });
          try { ws.close(4409, "busy"); } catch {}
          return;
        }
        clearTimeout(helloTimer);
        authed = true;
        sid = uuid();
        activeSession = { sid, ws };
        console.log(`[mock-bridge] auth ok sid=${sid.slice(0, 8)} client=${msg.payload.name}@${msg.payload.version}`);
        send(ws, {
          v: PROTOCOL_VERSION, type: "welcome", replyTo: msg.id, ts: Date.now(), sid,
          payload: { sessionId: sid, protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs: 5000, requestSnapshot: true, readOnly: false },
        });
        return;
      }

      // ---- authenticated messages ----
      if (msg.sid !== sid) { err(ws, "SCHEMA_INVALID", "bad sid", msg.id, sid); return; }
      switch (msg.type) {
        case "state_snapshot":
          snapshot = msg.payload;
          console.log(`[mock-bridge] snapshot (${Object.keys(snapshot).length} fields) selfMuted=${snapshot.selfMuted} voice=${snapshot.voiceChannelId} status=${snapshot.userStatus}`);
          break;
        case "state_update":
          if (typeof msg.payload?.seq === "number") {
            if (msg.payload.seq <= lastSeq) { console.log(`[mock-bridge] (debug) out-of-order seq ${msg.payload.seq}`); break; }
            lastSeq = msg.payload.seq;
          }
          console.log(`[mock-bridge] update seq=${msg.payload?.seq} patch=${JSON.stringify(msg.payload?.patch)}`);
          break;
        case "capability_update": {
          caps = msg.payload;
          const on = Object.keys(caps.available || {}).filter((k) => caps.available[k]);
          console.log(`[mock-bridge] capabilities: ${on.length} on: ${on.join(",")}`);
          break;
        }
        case "command_result":
          console.log(`[mock-bridge] result replyTo=${msg.replyTo} ok=${msg.payload?.ok} ${msg.payload?.ok ? "" : JSON.stringify(msg.payload?.error)}`);
          break;
        case "heartbeat":
          break;
        case "device_list_update":
          console.log(`[mock-bridge] devices in=${msg.payload?.inputs?.length ?? 0} out=${msg.payload?.outputs?.length ?? 0}`);
          break;
        case "channel_list_update":
          console.log(`[mock-bridge] guilds=${msg.payload?.guilds?.length ?? 0}`);
          break;
        case "error":
          console.log(`[mock-bridge] client error code=${msg.payload?.code}`);
          break;
        default:
          err(ws, "UNKNOWN_TYPE", `unknown type ${msg.type}`, msg.id, sid);
      }
    });

    ws.on("close", (code) => {
      clearTimeout(helloTimer); clearInterval(wd);
      if (activeSession && activeSession.ws === ws) { activeSession = null; lastSeq = 0; }
      console.log(`[mock-bridge] disconnect code=${code}`);
    });
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && triesLeft > 0) {
      console.log(`[mock-bridge] port ${port} busy, trying ${port + 1}`);
      listen(port + 1, triesLeft - 1);
    } else {
      console.error("[mock-bridge] listen failed:", e.message);
      process.exit(1);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    PORT = port;
    console.log(`[mock-bridge] listening on 127.0.0.1:${port} (protocol v${PROTOCOL_VERSION})`);
    console.log(`[mock-bridge] token: [hidden] (pass --token to override; default test token for local tests only)`);
    if (!SELFTEST) startCli();
    else runSelftest();
  });
}

function sendCommand(name, cmdArgs = {}) {
  if (!activeSession) { console.log("[mock-bridge] no client connected"); return; }
  const id = `cmd-${++cmdCounter}`;
  send(activeSession.ws, { v: PROTOCOL_VERSION, type: "command", id, ts: Date.now(), sid: activeSession.sid, payload: { command: name, args: cmdArgs } });
  console.log(`[mock-bridge] → command ${name} id=${id}`);
  // Timeout note per §6: simple 3s / voice 10s.
  const voice = /join|move|voice/i.test(name);
  setTimeout(() => console.log(`[mock-bridge] (note) ${id} timeout window elapsed (${voice ? 10 : 3}s)`), (voice ? 10000 : 3000));
}

function startCli() {
  const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout, prompt: "bridge> " });
  console.log("[mock-bridge] commands: <name> [json-args] | get_state | caps | channels | devices | hb | quit");
  rl.prompt();
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return rl.prompt();
    if (t === "quit" || t === "exit") process.exit(0);
    if (t === "get_state" && activeSession) {
      send(activeSession.ws, { v: PROTOCOL_VERSION, type: "get_state", id: uuid(), ts: Date.now(), sid: activeSession.sid, payload: { full: true } });
      return rl.prompt();
    }
    if (t === "caps" && activeSession) {
      send(activeSession.ws, { v: PROTOCOL_VERSION, type: "request_capabilities", id: uuid(), ts: Date.now(), sid: activeSession.sid, payload: {} });
      return rl.prompt();
    }
    if (t === "channels" && activeSession) {
      send(activeSession.ws, { v: PROTOCOL_VERSION, type: "request_channel_list", id: uuid(), ts: Date.now(), sid: activeSession.sid, payload: {} });
      return rl.prompt();
    }
    if (t === "devices" && activeSession) {
      send(activeSession.ws, { v: PROTOCOL_VERSION, type: "request_device_list", id: uuid(), ts: Date.now(), sid: activeSession.sid, payload: {} });
      return rl.prompt();
    }
    if (t === "hb" && activeSession) {
      send(activeSession.ws, { v: PROTOCOL_VERSION, type: "heartbeat_request", id: uuid(), ts: Date.now(), sid: activeSession.sid, payload: {} });
      return rl.prompt();
    }
    const sp = t.indexOf(" ");
    const name = sp < 0 ? t : t.slice(0, sp);
    let cmdArgs = {};
    if (sp >= 0) { try { cmdArgs = JSON.parse(t.slice(sp + 1)); } catch { console.log("bad JSON args"); return rl.prompt(); } }
    sendCommand(name, cmdArgs);
    rl.prompt();
  });
}

async function runSelftest() {
  console.log("[mock-bridge:selftest] waiting for client hello→welcome→snapshot…");
  const t0 = Date.now();
  const waitFor = (fn, timeout, label) => new Promise((res, rej) => {
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); clearTimeout(to); res(); }
    }, 200);
    const to = setTimeout(() => { clearInterval(iv); rej(new Error("timeout: " + label)); }, timeout);
  });
  try {
    await waitFor(() => !!activeSession, 15000, "client connect");
    await waitFor(() => !!snapshot, 10000, "state_snapshot");
    await waitFor(() => !!caps, 10000, "capability_update");
    const required = ["pluginConnected", "authenticated", "discordReady", "selfMuted", "voiceChannelId",
      "selectedTextChannelId", "userStatus", "inputVolume", "availableCapabilities"];
    const missing = required.filter((k) => !(k in snapshot));
    console.log(missing.length ? `[mock-bridge:selftest] FAIL missing state fields: ${missing.join(",")}` : "[mock-bridge:selftest] PASS snapshot has all probed fields");
    for (const c of ["toggle_mute", "get_capabilities", "refresh_state", "bogus_command_xyz"]) sendCommand(c, {});
    setTimeout(() => {
      console.log(`[mock-bridge:selftest] done in ${Date.now() - t0}ms — check command_results above (bogus → UNKNOWN_COMMAND).`);
      process.exit(0);
    }, 6000);
  } catch (e) {
    console.error("[mock-bridge:selftest] FAIL:", e.message);
    process.exit(1);
  }
}

listen(PORT);
