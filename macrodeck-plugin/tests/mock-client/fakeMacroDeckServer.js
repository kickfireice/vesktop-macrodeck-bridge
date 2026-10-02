// fakeMacroDeckServer.js — minimal Macro Deck (server) for self-testing the
// mock Vesktop client. Implements ONLY the handshake + framing needed by
// PROTOCOL v1.0.0 §2–§5: hello→welcome→snapshot→heartbeat, commands with
// replyTo matching, and auth-failure paths. Localhost only. Zero deps.
import net from 'node:net';
import crypto from 'node:crypto';

const PROTOCOL = '1.0.0';
const MAX_BYTES = 65536;

const nowMs = () => Date.now();
const newId = () => crypto.randomUUID().replace(/-/g, '');

function frame(text) {
  const body = Buffer.from(text, 'utf8');
  const head = [0x81];
  if (body.length < 126) head.push(body.length);
  else if (body.length < 65536) head.push(126, body.length >> 8, body.length & 0xff);
  else head.push(127, 0, 0, 0, 0, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff);
  return Buffer.concat([Buffer.from(head), body]);
}

function parseFrames(state, chunk) {
  // returns array of { text } complete messages; handles client masking
  state.buf = Buffer.concat([state.buf, chunk]);
  const out = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) break;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const mask = masked ? b.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (b.length < off + len) {
      if (off + len > MAX_BYTES + 1024) { out.push({ tooLarge: true }); state.buf = Buffer.alloc(0); break; }
      break;
    }
    let payload = b.subarray(off, off + len);
    if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
    state.buf = b.subarray(off + len);
    if (opcode === 0x8) { out.push({ close: true }); break; }
    if (opcode === 0x1) out.push({ text: payload.toString('utf8'), bytes: len });
  }
  return out;
}

export class FakeMacroDeckServer {
  constructor({ token, onLog = () => {}, allowReplacement = true }) {
    this.token = token;
    this.onLog = onLog;
    this.allowReplacement = allowReplacement;
    this.server = null;
    this.port = 0;
    this.activeSid = null;
    this.activeSocket = null;
    this.seen = []; // every parsed inbound envelope (for assertions)
    this.waiters = []; // { match, resolve }
  }

  async start(port = 0) {
    this.server = net.createServer((sock) => this.#http(sock));
    await new Promise((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this.port;
  }

  async stop() {
    try { this.activeSocket?.destroy(); } catch { /* ignore */ }
    await new Promise((r) => this.server?.close(r));
  }

  #http(sock) {
    const st = { buf: Buffer.alloc(0), upgraded: false, helloSeen: false, authed: false, sid: null };
    sock.on('data', (chunk) => {
      if (!st.upgraded) {
        st.buf = Buffer.concat([st.buf, chunk]);
        const head = st.buf.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = head.slice(0, end);
        const keyLine = headers.split('\r\n').find((l) => l.toLowerCase().startsWith('sec-websocket-key:'));
        const key = keyLine?.slice(keyLine.indexOf(':') + 1).trim();
        if (!key) { sock.destroy(); return; }
        // RFC 6455 §4.2.2 magic GUID (verified by interop: .NET strict client
        // ↔ reference server opens OK with this value).
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        st.buf = st.buf.subarray(end + 4);
        st.upgraded = true;
        // hello must arrive within 5s (§2.2)
        st.helloTimer = setTimeout(() => { if (!st.helloSeen) this.#close(sock, 4400, 'hello timeout'); }, 5000);
        if (st.buf.length > 0) this.#frames(sock, st, st.buf);
        st.buf = Buffer.alloc(0);
        return;
      }
      for (const m of parseFrames(st, chunk)) this.#message(sock, st, m);
    });
    sock.on('error', () => {});
  }

  #frames(sock, st, chunk) {
    for (const m of parseFrames(st, chunk)) this.#message(sock, st, m);
  }

  send(sock, type, payload, opts = {}) {
    const o = { v: PROTOCOL, type, ts: nowMs(), payload };
    if (opts.id) o.id = opts.id;
    if (opts.replyTo) o.replyTo = opts.replyTo;
    if (opts.sid) o.sid = opts.sid;
    sock.write(frame(JSON.stringify(o)));
  }

  #err(sock, st, code, message, replyTo) {
    this.send(sock, 'error', { code, message }, { id: newId(), replyTo, sid: st.sid ?? undefined });
  }

  #close(sock, code, reason) {
    const body = Buffer.from(reason, 'utf8');
    const pay = Buffer.alloc(2 + body.length);
    pay.writeUInt16BE(code, 0); body.copy(pay, 2);
    const head = Buffer.from([0x88, pay.length]);
    try { sock.write(Buffer.concat([head, pay])); } catch { /* ignore */ }
    setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } }, 100);
  }

  #message(sock, st, m) {
    if (m.close) {
      if (st.sid && st.sid === this.activeSid) { this.activeSid = null; this.activeSocket = null; }
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }
    if (m.tooLarge) { this.#err(sock, st, 'TOO_LARGE', 'message exceeds 64KB'); return; }
    let env;
    try { env = JSON.parse(m.text); } catch { /* unauthenticated: close silently (§4) */ if (st.authed) this.#err(sock, st, 'SCHEMA_INVALID', 'invalid JSON'); return; }
    if (m.bytes > MAX_BYTES) { this.#err(sock, st, 'TOO_LARGE', 'message exceeds 64KB'); return; }
    if (!env.v || !env.type || !env.ts || !env.payload) { if (st.authed) this.#err(sock, st, 'SCHEMA_INVALID', 'missing v/type/ts/payload'); return; }
    if (env.v !== PROTOCOL) {
      this.send(sock, 'error', { code: 'VERSION_MISMATCH', message: 'unsupported protocol version', supported: [PROTOCOL] }, { id: newId() });
      this.#close(sock, 4400, 'version');
      return;
    }

    if (!st.helloSeen) {
      if (env.type !== 'hello') { this.#close(sock, 4400, 'hello required first'); return; }
      clearTimeout(st.helloTimer);
      st.helloSeen = true;
      const presented = env.payload?.token ?? '';
      const a = Buffer.from(this.token, 'utf8'), b = Buffer.from(String(presented), 'utf8');
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) {
        this.send(sock, 'error', { code: 'AUTH_FAILED', message: 'invalid token' }, { id: newId(), replyTo: env.id });
        this.#close(sock, 4401, 'auth');
        return;
      }
      if (this.activeSid && !this.allowReplacement) {
        this.send(sock, 'error', { code: 'ALREADY_CONNECTED', message: 'another client is connected' }, { id: newId(), replyTo: env.id });
        this.#close(sock, 4409, 'duplicate');
        return;
      }
      if (this.activeSid && this.activeSocket) {
        this.send(this.activeSocket, 'error', { code: 'SESSION_REPLACED', message: 'session replaced' }, { id: newId(), sid: this.activeSid });
        try { this.activeSocket.destroy(); } catch { /* ignore */ }
      }
      st.authed = true;
      st.sid = newId();
      st.lastSeen = Date.now();
      this.activeSid = st.sid;
      this.activeSocket = sock;
      this.send(sock, 'welcome', {
        sessionId: st.sid, protocolVersion: PROTOCOL,
        heartbeatIntervalMs: 5000, requestSnapshot: true, readOnly: false,
      }, { id: newId(), replyTo: env.id, sid: st.sid });
      return;
    }

    if (!st.authed || env.sid !== st.sid || env.sid !== this.activeSid) { this.#close(sock, 4400, 'bad session'); return; }
    st.lastSeen = Date.now();
    this.seen.push(env);
    for (const w of [...this.waiters]) {
      try { if (w.match(env)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(env); } } catch { /* ignore */ }
    }
    if (env.type === 'heartbeat_request' || env.type === 'heartbeat') return; // liveness only
    const known = ['hello', 'heartbeat', 'state_snapshot', 'state_update', 'capability_update',
      'command_result', 'error', 'device_list_update', 'channel_list_update'];
    if (!known.includes(env.type)) this.#err(sock, st, 'UNKNOWN_TYPE', `unknown type ${env.type}`);
  }

  waitFor(match, timeoutMs = 8000) {
    const found = this.seen.find((e) => { try { return match(e); } catch { return false; } });
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('waitFor timeout'));
      }, timeoutMs);
    });
  }

  sendCommand(command, args = {}) {
    const id = newId();
    this.send(this.activeSocket, 'command', { command, args }, { id, sid: this.activeSid });
    return this.waitFor((e) => e.type === 'command_result' && e.replyTo === id, 10000);
  }
}
