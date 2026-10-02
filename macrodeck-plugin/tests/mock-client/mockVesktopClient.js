// mockVesktopClient.js — mock Vesktop plugin (client side of PROTOCOL v1.0.0).
// Zero dependencies (Node >=22 global WebSocket). Localhost only.
//
// Usage:
//   node mockVesktopClient.js --port 8323 --token <secret> [--self-test]
//   --self-test: run against the in-process fake Macro Deck server below
//                (validates THIS client: hello→welcome→snapshot→heartbeat,
//                 command→command_result, reconnect backoff).
//
// The mock answers every `command` with a `command_result` (replyTo match),
// pushes debounced `state_update`s, and serves channel/device lists — the same
// contract the real Vesktop plugin must honor, so the Macro Deck side can be
// developed/tested without Discord.

const PROTOCOL = '1.0.0';
const HEARTBEAT_FALLBACK_MS = 5000;

const nowMs = () => Date.now();
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '');

function envelope(type, payload, { id = undefined, replyTo = undefined, sid = undefined } = {}) {
  const o = { v: PROTOCOL, type, ts: nowMs(), payload };
  if (id) o.id = id;
  if (replyTo) o.replyTo = replyTo;
  if (sid) o.sid = sid;
  return JSON.stringify(o);
}

// --- scripted Discord state (mirrors §7 State; null = unknown) ---
function fullState() {
  return {
    pluginConnected: true, authenticated: true, discordReady: true,
    bridgeRunning: true, lastError: null,
    protocolVersion: PROTOCOL, vesktopPluginVersion: '1.0.0-mock',
    readOnly: false,
    selfMuted: false, selfDeafened: false, serverMuted: false, serverDeafened: false,
    voiceConnected: true, voiceConnecting: false,
    voiceChannelId: 'vc-1', voiceChannelName: 'General', voiceChannelPath: 'Guild / Voice / General',
    voiceGuildId: 'g-1', voiceGuildName: 'Guild',
    lastVoiceChannelId: 'vc-1', lastVoiceChannelName: 'General',
    selectedTextChannelId: 'tc-1', selectedTextChannelName: 'general',
    selectedTextChannelPath: 'Guild / Text / general', selectedGuildId: 'g-1', selectedGuildName: 'Guild',
    userStatus: 'online', customStatusText: null, customStatusEmojiName: null,
    inputVolume: 80, outputVolume: 70,
    inputDeviceId: 'in-1', inputDeviceName: 'Microphone',
    outputDeviceId: 'out-1', outputDeviceName: 'Speakers',
    noiseSuppressionEnabled: true, echoCancellationEnabled: true,
    automaticGainEnabled: false, qosHighPriorityEnabled: true,
    lowLatencyEnabled: false, speakerMuted: false,
    attenuationVolume: 50, attenuationWhileSpeakingEnabled: true,
    stageHandRaised: false, stageSpeakRequested: false, stageIsSpeaker: false, stageChannelActive: false,
    availableCapabilities: {},
    unavailableReasons: {},
  };
}

const CAPS = {
  mute: true, deafen: true, speakerMute: true,
  noiseSuppression: true, echoCancellation: true, automaticGain: true, qosHighPriority: true, lowLatency: true,
  voiceJoin: true, voiceLeave: true, voiceMove: true, rejoinLastVoice: true, cycleVoiceChannel: true,
  stageRaiseHand: false, stageRequestToSpeak: false, // best-effort: honestly unsupported here
  textChannelSelect: true, cycleTextChannel: true, markChannelRead: true,
  status: true, customStatus: true,
  inputDeviceSelect: true, outputDeviceSelect: true,
  inputVolume: true, outputVolume: true, perUserVolume: true, userLocalMute: true, attenuation: true,
  channelList: true, deviceList: true,
};

const GUILDS = [
  {
    id: 'g-1', name: 'Guild',
    channels: [
      { id: 'tc-1', name: 'general', type: 'text', path: 'Guild / Text / general' },
      { id: 'vc-1', name: 'General', type: 'voice', path: 'Guild / Voice / General' },
      { id: 'vc-2', name: 'General', type: 'voice', path: 'Guild / Gaming / General' }, // ambiguous twin
    ],
  },
];
const DEVICES = {
  inputs: [{ id: 'in-1', name: 'Microphone', kind: 'input', isDefault: true }],
  outputs: [{ id: 'out-1', name: 'Speakers', kind: 'output', isDefault: true }],
};

export class MockVesktopClient {
  constructor({ url, token, onLog = console.log }) {
    this.url = url;
    this.token = token;
    this.onLog = onLog;
    this.ws = null;
    this.sid = null;
    this.state = fullState();
    this.seq = 0;
    this.debounceTimer = null;
    this.pendingPatch = {};
    this.hbTimer = null;
    this.backoffAttempt = 0;
    this.shouldRun = true;
    this.connected = false;
    this.commandLog = [];
  }

  log(m) { try { this.onLog(`[mock] ${m}`); } catch { /* ignore */ } }

  async connect() {
    this.shouldRun = true;
    await this.#loop();
  }

  close() {
    this.shouldRun = false;
    clearInterval(this.hbTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  async #loop() {
    while (this.shouldRun) {
      try {
        await this.#once();
        this.backoffAttempt = 0; // reset after a clean session ends
      } catch (e) {
        this.log(`connection failed (${e?.message ?? e}), backing off`);
      }
      if (!this.shouldRun) break;
      // exponential backoff 1s → 2s → 5s → 10s → 30s max, jitter ±20% (§11)
      const steps = [1000, 2000, 5000, 10000, 30000];
      const base = steps[Math.min(this.backoffAttempt, steps.length - 1)];
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      this.log(`reconnect attempt #${this.backoffAttempt + 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      this.backoffAttempt++;
    }
  }

  #once() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      ws.addEventListener('open', () => {
        this.log('ws open → sending hello');
        // hello MUST be first message within 5s; carries token ONLY here (§2.2)
        ws.send(envelope('hello', {
          protocolVersion: PROTOCOL, name: 'vesktop-bridge-mock',
          version: '1.0.0-mock', token: this.token, capabilities: CAPS,
        }, { id: newId() }));
      });
      ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)).catch((e) => this.log(`handler: ${e}`)));
      ws.addEventListener('close', (ev) => {
        this.connected = false;
        clearInterval(this.hbTimer);
        this.log(`ws closed code=${ev.code}`);
        done(resolve);
      });
      ws.addEventListener('error', () => done(reject, new Error('ws error')));
      setTimeout(() => done(reject, new Error('connect timeout')), 8000);
    });
  }

  async #onMessage(raw) {
    let env;
    try { env = JSON.parse(raw); } catch { this.log('protocol_error SCHEMA_INVALID'); return; }
    if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > 65536) return; // TOO_LARGE: drop
    switch (env.type) {
      case 'welcome':
        this.sid = env.sid ?? env.payload?.sessionId;
        this.log(`welcome sid=${String(this.sid).slice(0, 8)}… hb=${env.payload?.heartbeatIntervalMs}`);
        this.connected = true;
        // snapshot + capability + lists after every (re)connect (§9.1, §11)
        this.#send(envelope('capability_update',
          { available: CAPS, unavailableReasons: { stageRaiseHand: 'UNSUPPORTED: no stage in mock', stageRequestToSpeak: 'UNSUPPORTED: no stage in mock' } },
          { id: newId(), sid: this.sid }));
        this.#send(envelope('state_snapshot', { ...this.state, availableCapabilities: CAPS }, { id: newId(), sid: this.sid }));
        this.#send(envelope('channel_list_update', { guilds: GUILDS, seq: 1 }, { id: newId(), sid: this.sid }));
        this.#send(envelope('device_list_update', DEVICES, { id: newId(), sid: this.sid }));
        this.#startHeartbeat(env.payload?.heartbeatIntervalMs ?? HEARTBEAT_FALLBACK_MS);
        break;
      case 'heartbeat_request':
        this.#send(envelope('heartbeat', { ok: true, discordReady: this.state.discordReady }, { id: newId(), sid: this.sid }));
        break;
      case 'get_state':
        this.#send(envelope('state_snapshot', { ...this.state, availableCapabilities: CAPS }, { id: newId(), replyTo: env.id, sid: this.sid }));
        break;
      case 'request_capabilities':
        this.#send(envelope('capability_update', { available: CAPS, unavailableReasons: {} }, { id: newId(), replyTo: env.id, sid: this.sid }));
        break;
      case 'request_channel_list':
        this.#send(envelope('channel_list_update', { guilds: GUILDS, seq: 1 }, { id: newId(), replyTo: env.id, sid: this.sid }));
        break;
      case 'request_device_list':
        this.#send(envelope('device_list_update', DEVICES, { id: newId(), replyTo: env.id, sid: this.sid }));
        break;
      case 'command':
        await this.#onCommand(env);
        break;
      case 'error':
        this.log(`server error code=${env.payload?.code}`);
        break;
      default:
        this.#send(envelope('error', { code: 'UNKNOWN_TYPE', message: `unknown type ${env.type}` }, { sid: this.sid }));
    }
  }

  #startHeartbeat(ms) {
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      this.#send(envelope('heartbeat', { ok: true, discordReady: this.state.discordReady }, { id: newId(), sid: this.sid }));
    }, ms);
  }

  #send(text) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  // Every command gets exactly one command_result (replyTo match) — §11.
  async #onCommand(env) {
    const cmd = env.payload?.command;
    const args = env.payload?.args ?? {};
    this.commandLog.push(cmd);
    const fail = (code, message, extra = {}) =>
      this.#send(envelope('command_result',
        { ok: false, command: cmd, error: { code, message }, ...extra },
        { replyTo: env.id, sid: this.sid }));
    const okResult = (statePatch = {}) =>
      this.#send(envelope('command_result',
        { ok: true, command: cmd, statePatch },
        { replyTo: env.id, sid: this.sid }));

    if (this.state.readOnly && !['refresh_state', 'get_capabilities', 'get_channel_list', 'get_device_list'].includes(cmd)) {
      // note: get_state/request_* arrive as their own types, not commands
      fail('READ_ONLY', 'bridge is read-only'); return;
    }
    const need = (flag) => {
      if (!CAPS[flag]) { fail('UNSUPPORTED', `capability '${flag}' unavailable`); return false; }
      return true;
    };

    const set = (patch) => { Object.assign(this.state, patch); this.#emit(patch); };
    switch (cmd) {
      case 'refresh_state': okResult(); this.#send(envelope('state_snapshot', this.state, { id: newId(), sid: this.sid })); break;
      case 'get_capabilities':
        this.#send(envelope('command_result', { ok: true, command: cmd, capabilities: CAPS }, { replyTo: env.id, sid: this.sid }));
        break;
      case 'get_channel_list': okResult(); this.#send(envelope('channel_list_update', { guilds: GUILDS, seq: 1 }, { id: newId(), sid: this.sid })); break;
      case 'get_device_list': okResult(); this.#send(envelope('device_list_update', DEVICES, { id: newId(), sid: this.sid })); break;
      case 'toggle_mute': if (need('mute')) { const v = !this.state.selfMuted; set({ selfMuted: v }); okResult({ selfMuted: v }); } break;
      case 'set_mute': if (need('mute')) { set({ selfMuted: !!args.muted }); okResult({ selfMuted: !!args.muted }); } break;
      case 'toggle_deafen': if (need('deafen')) { const v = !this.state.selfDeafened; set({ selfDeafened: v }); okResult({ selfDeafened: v }); } break;
      case 'set_deafen': if (need('deafen')) { set({ selfDeafened: !!args.deafened }); okResult({ selfDeafened: !!args.deafened }); } break;
      case 'toggle_mute_and_deafen':
        if (need('mute') && need('deafen')) {
          const m = !(this.state.selfMuted && this.state.selfDeafened);
          set({ selfMuted: m, selfDeafened: m }); okResult({ selfMuted: m, selfDeafened: m });
        } break;
      case 'toggle_speaker_mute': if (need('speakerMute')) { const v = !this.state.speakerMuted; set({ speakerMuted: v }); okResult({ speakerMuted: v }); } break;
      case 'set_speaker_mute': if (need('speakerMute')) { set({ speakerMuted: !!args.muted }); okResult({ speakerMuted: !!args.muted }); } break;
      case 'toggle_noise_suppression': if (need('noiseSuppression')) { const v = !this.state.noiseSuppressionEnabled; set({ noiseSuppressionEnabled: v }); okResult({ noiseSuppressionEnabled: v }); } break;
      case 'set_noise_suppression': if (need('noiseSuppression')) { set({ noiseSuppressionEnabled: !!args.enabled }); okResult({ noiseSuppressionEnabled: !!args.enabled }); } break;
      case 'toggle_echo_cancellation': if (need('echoCancellation')) { const v = !this.state.echoCancellationEnabled; set({ echoCancellationEnabled: v }); okResult({ echoCancellationEnabled: v }); } break;
      case 'set_echo_cancellation': if (need('echoCancellation')) { set({ echoCancellationEnabled: !!args.enabled }); okResult({ echoCancellationEnabled: !!args.enabled }); } break;
      case 'toggle_automatic_gain': if (need('automaticGain')) { const v = !this.state.automaticGainEnabled; set({ automaticGainEnabled: v }); okResult({ automaticGainEnabled: v }); } break;
      case 'set_automatic_gain': if (need('automaticGain')) { set({ automaticGainEnabled: !!args.enabled }); okResult({ automaticGainEnabled: !!args.enabled }); } break;
      case 'toggle_qos_high_priority': if (need('qosHighPriority')) { const v = !this.state.qosHighPriorityEnabled; set({ qosHighPriorityEnabled: v }); okResult({ qosHighPriorityEnabled: v }); } break;
      case 'set_qos_high_priority': if (need('qosHighPriority')) { set({ qosHighPriorityEnabled: !!args.enabled }); okResult({ qosHighPriorityEnabled: !!args.enabled }); } break;
      case 'toggle_low_latency': if (need('lowLatency')) { const v = !this.state.lowLatencyEnabled; set({ lowLatencyEnabled: v }); okResult({ lowLatencyEnabled: v }); } break;
      case 'set_low_latency': if (need('lowLatency')) { set({ lowLatencyEnabled: !!args.enabled }); okResult({ lowLatencyEnabled: !!args.enabled }); } break;
      case 'join_voice_by_id': case 'move_voice_by_id': {
        if (!need(cmd.startsWith('join') ? 'voiceJoin' : 'voiceMove')) break;
        const ch = GUILDS.flatMap((g) => g.channels).find((c) => c.id === args.channelId);
        if (!ch) { fail('NOT_FOUND', 'channel not found'); break; }
        const p = { voiceConnected: true, voiceConnecting: false, voiceChannelId: ch.id, voiceChannelName: ch.name, voiceChannelPath: ch.path, lastVoiceChannelId: ch.id, lastVoiceChannelName: ch.name };
        set(p); okResult(p); break;
      }
      case 'join_voice_by_name': case 'move_voice_by_name': {
        if (!need(cmd.startsWith('join') ? 'voiceJoin' : 'voiceMove')) break;
        const all = GUILDS.flatMap((g) => g.channels.map((c) => ({ ...c, guild: g.name })))
          .filter((c) => c.type === 'voice' && c.name.toLowerCase() === String(args.name ?? '').toLowerCase()
            && (!args.guildName || c.guild.toLowerCase() === String(args.guildName).toLowerCase()));
        if (all.length === 0) { fail('NOT_FOUND', 'channel not found'); break; }
        if (all.length > 1) {
          fail('AMBIGUOUS', 'multiple channels match', { candidates: all.slice(0, 10).map((c) => ({ id: c.id, name: c.name, path: c.path })) });
          break;
        }
        const p = { voiceConnected: true, voiceChannelId: all[0].id, voiceChannelName: all[0].name, voiceChannelPath: all[0].path };
        set(p); okResult(p); break;
      }
      case 'join_voice_by_path': case 'move_voice_by_path': {
        if (!need(cmd.startsWith('join') ? 'voiceJoin' : 'voiceMove')) break;
        const all = GUILDS.flatMap((g) => g.channels).filter((c) => c.path.toLowerCase() === String(args.path ?? '').toLowerCase());
        if (all.length === 0) { fail('NOT_FOUND', 'channel not found'); break; }
        if (all.length > 1) { fail('AMBIGUOUS', 'multiple channels match', { candidates: all.slice(0, 10) }); break; }
        const p = { voiceConnected: true, voiceChannelId: all[0].id, voiceChannelName: all[0].name, voiceChannelPath: all[0].path };
        set(p); okResult(p); break;
      }
      case 'leave_voice': case 'disconnect_voice':
        if (need('voiceLeave')) { const p = { voiceConnected: false }; set(p); okResult(p); } break;
      case 'rejoin_last_voice':
        if (need('rejoinLastVoice')) {
          const p = { voiceConnected: true, voiceChannelId: this.state.lastVoiceChannelId, voiceChannelName: this.state.lastVoiceChannelName };
          set(p); okResult(p);
        } break;
      case 'cycle_voice_channel': if (need('cycleVoiceChannel')) { okResult({}); } break;
      case 'stage_raise_hand': case 'stage_lower_hand': case 'stage_toggle_hand':
        if (need('stageRaiseHand')) { const v = cmd !== 'stage_lower_hand'; set({ stageHandRaised: v }); okResult({ stageHandRaised: v }); } break;
      case 'stage_request_to_speak': case 'stage_cancel_speak_request':
        if (need('stageRequestToSpeak')) { const v = cmd === 'stage_request_to_speak'; set({ stageSpeakRequested: v }); okResult({ stageSpeakRequested: v }); } break;
      case 'select_text_by_id': {
        if (!need('textChannelSelect')) break;
        const ch = GUILDS.flatMap((g) => g.channels).find((c) => c.id === args.channelId && c.type === 'text');
        if (!ch) { fail('NOT_FOUND', 'channel not found'); break; }
        const p = { selectedTextChannelId: ch.id, selectedTextChannelName: ch.name, selectedTextChannelPath: ch.path };
        set(p); okResult(p); break;
      }
      case 'select_text_by_name': case 'select_text_by_path': case 'select_last_text_channel':
        if (need('textChannelSelect')) { okResult({}); } break;
      case 'cycle_text_channel':
        if (need('cycleTextChannel')) { okResult({}); } break;
      case 'mark_selected_channel_read': if (need('markChannelRead')) okResult({}); break;
      case 'set_status_online': case 'set_status_idle': case 'set_status_dnd': case 'set_status_invisible':
        if (need('status')) { const s = cmd.replace('set_status_', ''); set({ userStatus: s }); okResult({ userStatus: s }); } break;
      case 'cycle_status': case 'toggle_dnd': case 'toggle_invisible':
        if (need('status')) { const order = ['online', 'idle', 'dnd', 'invisible']; const n = order[(order.indexOf(this.state.userStatus) + 1) % 4]; set({ userStatus: n }); okResult({ userStatus: n }); } break;
      case 'set_custom_status':
        if (need('customStatus')) { set({ customStatusText: args.text ?? null, customStatusEmojiName: args.emojiName ?? null }); okResult({ customStatusText: args.text ?? null }); } break;
      case 'append_custom_status':
        if (need('customStatus')) { const t = `${this.state.customStatusText ?? ''}${args.text}`; set({ customStatusText: t }); okResult({ customStatusText: t }); } break;
      case 'clear_custom_status': if (need('customStatus')) { set({ customStatusText: null }); okResult({ customStatusText: null }); } break;
      case 'set_input_device_by_id': case 'set_input_device_by_name':
        if (need('inputDeviceSelect')) { set({ inputDeviceId: args.deviceId ?? 'in-1', inputDeviceName: args.name ?? 'Microphone' }); okResult({}); } break;
      case 'cycle_input_device': if (need('inputDeviceSelect')) okResult({}); break;
      case 'set_output_device_by_id': case 'set_output_device_by_name':
        if (need('outputDeviceSelect')) { set({ outputDeviceId: args.deviceId ?? 'out-1', outputDeviceName: args.name ?? 'Speakers' }); okResult({}); } break;
      case 'cycle_output_device': if (need('outputDeviceSelect')) okResult({}); break;
      case 'refresh_audio_devices': okResult({}); this.#send(envelope('device_list_update', DEVICES, { id: newId(), sid: this.sid })); break;
      case 'set_input_volume': case 'increase_input_volume': case 'decrease_input_volume':
        if (need('inputVolume')) {
          const d = cmd === 'set_input_volume' ? 0 : (cmd === 'increase_input_volume' ? 1 : -1) * (args.step ?? 5);
          const v = Math.min(100, Math.max(0, cmd === 'set_input_volume' ? args.volume : this.state.inputVolume + d));
          set({ inputVolume: v }); okResult({ inputVolume: v }); // volume drags debounced (§9.1)
        } break;
      case 'set_output_volume': case 'increase_output_volume': case 'decrease_output_volume':
        if (need('outputVolume')) {
          const d = cmd === 'set_output_volume' ? 0 : (cmd === 'increase_output_volume' ? 1 : -1) * (args.step ?? 5);
          const v = Math.min(100, Math.max(0, cmd === 'set_output_volume' ? args.volume : this.state.outputVolume + d));
          set({ outputVolume: v }); okResult({ outputVolume: v });
        } break;
      case 'set_user_volume': case 'increase_user_volume': case 'decrease_user_volume': case 'reset_user_volume':
        if (need('perUserVolume')) okResult({}); break;
      case 'toggle_user_local_mute': case 'set_user_local_mute':
        if (need('userLocalMute')) okResult({}); break;
      case 'set_attenuation_volume':
        if (need('attenuation')) { set({ attenuationVolume: args.volume }); okResult({ attenuationVolume: args.volume }); } break;
      case 'toggle_attenuation_while_speaking': case 'set_attenuation_while_speaking':
        if (need('attenuation')) { const v = cmd.endsWith('toggle_attenuation_while_speaking') ? !this.state.attenuationWhileSpeakingEnabled : !!args.enabled; set({ attenuationWhileSpeakingEnabled: v }); okResult({ attenuationWhileSpeakingEnabled: v }); } break;
      default:
        fail('UNKNOWN_COMMAND', `unknown command ${cmd}`);
    }
  }

  // Debounced live updates: 100–250ms coalescing for rapid changes (§9.1).
  // Discrete events (mute/join/leave/select) flush immediately.
  #emit(patch, immediateKeys = ['selfMuted', 'selfDeafened', 'voiceConnected', 'voiceChannelId', 'selectedTextChannelId']) {
    Object.assign(this.pendingPatch, patch);
    const immediate = Object.keys(patch).some((k) => immediateKeys.includes(k));
    if (immediate) { this.#flush(); return; }
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.#flush(), 150);
  }

  #flush() {
    clearTimeout(this.debounceTimer);
    const patch = this.pendingPatch;
    this.pendingPatch = {};
    if (Object.keys(patch).length === 0) return;
    this.seq += 1;
    this.#send(envelope('state_update', { patch, seq: this.seq }, { id: newId(), sid: this.sid }));
  }
}

// --- CLI: connect to a real bridge (supports --k=v and --k v forms) ---
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = 'true';
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (process.argv[1]?.endsWith('mockVesktopClient.js')) {
  const port = Number(args.port ?? 8323);
  const token = args.token ?? process.env.BRIDGE_TOKEN;
  if (!token) {
    console.error('missing --token (or BRIDGE_TOKEN env). The token lives in Macro Deck settings; never commit it.');
    process.exit(2);
  }
  const client = new MockVesktopClient({ url: `ws://127.0.0.1:${port}/ws`, token });
  process.on('SIGINT', () => { client.close(); process.exit(0); });
  await client.connect();
}
