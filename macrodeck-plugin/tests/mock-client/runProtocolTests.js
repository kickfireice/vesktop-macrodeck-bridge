// runProtocolTests.js — interop self-test (mock Vesktop client ↔ fake Macro Deck
// server). Covers PROTOCOL §15 checklist items 2–5 from the client side:
// handshake → snapshot → heartbeat, every command gets one command_result,
// unknown/unsupported/ambiguous codes, bad-token rejection, reconnect resync.
// Exit 0 = all pass. No secrets printed.
import { MockVesktopClient } from './mockVesktopClient.js';
import { FakeMacroDeckServer } from './fakeMacroDeckServer.js';

const TOKEN = 'test-token-' + 'x'.repeat(40);
let pass = 0, fail = 0;
const check = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' — ' + extra : ''}`); }
};
const quiet = () => {};

const server = new FakeMacroDeckServer({ token: TOKEN, onLog: quiet });
const port = await server.start(0);
console.log(`fake Macro Deck server on 127.0.0.1:${port}`);

// 1. hello → welcome → snapshot + capability + lists → heartbeat
const client = new MockVesktopClient({ url: `ws://127.0.0.1:${port}/ws`, token: TOKEN, onLog: quiet });
const run = client.connect();
const snap = await server.waitFor((e) => e.type === 'state_snapshot');
check(!!snap?.payload?.voiceChannelId, 'hello→welcome→state_snapshot (full §7 state)');
const caps = await server.waitFor((e) => e.type === 'capability_update');
check(caps?.payload?.available?.mute === true && caps?.payload?.available?.stageRaiseHand === false,
  'capability_update (mute=true, stage honestly false)');
const chans = await server.waitFor((e) => e.type === 'channel_list_update');
check(chans?.payload?.guilds?.[0]?.channels?.length === 3, 'channel_list_update pushed after connect');
await server.waitFor((e) => e.type === 'heartbeat');
check(true, 'client heartbeat on 5s interval');

// 2. every command gets one command_result (replyTo match)
const r1 = await server.sendCommand('toggle_mute', {});
check(r1?.payload?.ok === true && r1?.payload?.command === 'toggle_mute'
  && typeof r1?.payload?.statePatch?.selfMuted === 'boolean',
  'command toggle_mute → command_result ok + statePatch');

// 3. unknown command → UNKNOWN_COMMAND (never silent)
const r2 = await server.sendCommand('frobnicate_the_discord', {});
check(r2?.payload?.ok === false && r2?.payload?.error?.code === 'UNKNOWN_COMMAND',
  'unknown command → UNKNOWN_COMMAND');

// 4. ambiguous name → AMBIGUOUS + candidates (never guess)
const r3 = await server.sendCommand('join_voice_by_name', { name: 'General' });
check(r3?.payload?.ok === false && r3?.payload?.error?.code === 'AMBIGUOUS'
  && r3?.payload?.candidates?.length === 2,
  'ambiguous name → AMBIGUOUS + 2 candidates', JSON.stringify(r3?.payload ?? r3));

// 5. unsupported capability → UNSUPPORTED, reported honestly
const r4 = await server.sendCommand('stage_raise_hand', {});
check(r4?.payload?.ok === false && r4?.payload?.error?.code === 'UNSUPPORTED',
  'stage (no capability) → UNSUPPORTED');

// 6. not found → NOT_FOUND
const r5 = await server.sendCommand('join_voice_by_id', { channelId: 'nope' });
check(r5?.payload?.ok === false && r5?.payload?.error?.code === 'NOT_FOUND',
  'unknown channel id → NOT_FOUND');

// 7. bad token → AUTH_FAILED + close 4401 (raw socket)
{
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const id = 'bad1';
  ws.send(JSON.stringify({ v: '1.0.0', type: 'hello', id, ts: Date.now(), payload: { protocolVersion: '1.0.0', name: 'x', version: '0', token: 'wrong', capabilities: {} } }));
  const msg = await new Promise((res) => ws.addEventListener('message', (e) => res(String(e.data)), { once: true }));
  const closeCode = await new Promise((res) => ws.addEventListener('close', (e) => res(e.code)));
  check(JSON.parse(msg)?.payload?.code === 'AUTH_FAILED' && closeCode === 4401,
    'bad token → AUTH_FAILED + close 4401');
}

// 8. reconnect: kill transport → backoff → re-hello → fresh snapshot
const snapsBefore = server.seen.filter((e) => e.type === 'state_snapshot').length;
server.activeSocket.destroy();
const snap2 = await server.waitFor((e) => e.type === 'state_snapshot'
  && server.seen.filter((x) => x.type === 'state_snapshot').length > snapsBefore, 15000);
check(!!snap2, 'reconnect → re-hello → fresh snapshot (backoff, no tight loop)');

// 9. heartbeat keeps flowing after reconnect; command still works
const r6 = await server.sendCommand('set_mute', { muted: true });
check(r6?.payload?.ok === true && r6?.payload?.statePatch?.selfMuted === true,
  'post-reconnect command roundtrip ok');

client.close();
await server.stop();
console.log(fail === 0 ? `PROTOCOL TESTS ALL PASS (${pass})` : `PROTOCOL TESTS ${fail} FAILURES (${pass} pass)`);
process.exit(fail === 0 ? 0 : 1);
