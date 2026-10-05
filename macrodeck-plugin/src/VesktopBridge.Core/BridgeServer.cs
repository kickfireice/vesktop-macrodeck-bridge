// BridgeServer.cs — §1/§2/§9/§11: localhost-only WS server (HttpListener +
// System.Net.WebSockets, BCL only). Async, event-driven, never blocks UI.
// Bind 127.0.0.1:configuredPort, auto-fallback to next free port, expose ActualPort.
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace DeckBridge.Core;

public sealed class BridgeServerOptions
{
    public int ConfiguredPort { get; set; } = BridgeProtocol.DefaultPort;
    public bool AllowReplacement { get; set; }
    public bool ReadOnly { get; set; }
}

public sealed class BridgeServer : IDisposable
{
    private readonly BridgeServerOptions _opts;
    private readonly AuthManager _auth;
    private readonly SessionManager _sessions = new();
    private readonly BridgeStateCache _state = new();
    private readonly ChannelDeviceCache _lists = new();
    private readonly CapabilityStore _caps = new();
    private readonly PendingCommandStore _pending = new();
    private readonly MessageRateLimiter _inboundLimiter = new();

    private HttpListener? _listener;
    private CancellationTokenSource? _cts;
    private Task? _acceptLoop;
    private ClientConnection? _client;
    private bool _disposed;

    public int ActualPort { get; private set; }
    public bool Running { get; private set; }
    public string? LastAuthFailureAt { get; private set; }
    public event Action<string>? StatusChanged;

    public BridgeStateCache State => _state;
    public ChannelDeviceCache Lists => _lists;
    public CapabilityStore Capabilities => _caps;
    public AuthManager Auth => _auth;
    public bool ReadOnly { get => _opts.ReadOnly; set => _opts.ReadOnly = value; }
    public bool AllowReplacement { get => _sessions.AllowReplacement; set => _sessions.AllowReplacement = value; }
    public ClientSession? ActiveClient => _sessions.Active;

    public BridgeServer(BridgeServerOptions opts, AuthManager auth)
    {
        _opts = opts;
        _auth = auth;
        _sessions.AllowReplacement = opts.AllowReplacement;
    }

    // ---- lifecycle: clean start/stop with plugin (§11) ----
    public async Task StartAsync(CancellationToken ct = default)
    {
        if (Running) return;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        ActualPort = FindFreePort(_opts.ConfiguredPort);
        _listener = new HttpListener();
        // localhost-only: 127.0.0.1 only, NEVER 0.0.0.0 / + (§1, §12).
        _listener.Prefixes.Add($"http://127.0.0.1:{ActualPort}/ws/");
        _listener.Start();
        Running = true;
        BridgeLog.Info($"bridge server started on 127.0.0.1:{ActualPort}" +
            (ActualPort != _opts.ConfiguredPort ? $" (fallback, configured was {_opts.ConfiguredPort})" : ""));
        StatusChanged?.Invoke($"running:{ActualPort}");
        _acceptLoop = AcceptLoopAsync(_cts.Token);
        await Task.CompletedTask;
    }

    public async Task StopAsync()
    {
        if (!Running) return;
        Running = false;
        try { _cts?.Cancel(); } catch { }
        try
        {
            if (_client is not null) await _client.CloseAsync("server stopping");
            _client = null;
        }
        catch { }
        _sessions.Revoke();
        _pending.FailAll(BridgeProtocol.Errors.InternalError);
        try { _listener?.Stop(); } catch { }
        try { _listener?.Close(); } catch { }
        _state.MarkDisconnected("SERVER_STOPPED");
        BridgeLog.Info("bridge server stopped");
        StatusChanged?.Invoke("stopped");
        if (_acceptLoop is not null)
            try { await _acceptLoop.WaitAsync(TimeSpan.FromSeconds(3)); } catch { }
    }

    private static int FindFreePort(int preferred)
    {
        for (var p = preferred; p < preferred + 100; p++)
        {
            try
            {
                using var t = new TcpListener(IPAddress.Loopback, p);
                t.Start();
                t.Stop();
                return p;
            }
            catch { /* try next */ }
        }
        throw new InvalidOperationException("no free loopback port found");
    }

    // ---- accept loop: refuse new TCP accepts during auth block (§2.3) ----
    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _listener?.IsListening == true)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync().WaitAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch { continue; }
            _ = HandleHttpAsync(ctx, ct); // fire-and-forget per connection (async, non-blocking)
        }
    }

    private async Task HandleHttpAsync(HttpListenerContext ctx, CancellationToken ct)
    {
        // Non-loopback guard (defense in depth — listener is loopback-only already).
        if (ctx.Request.RemoteEndPoint?.Address is { } ip && !IPAddress.IsLoopback(ip))
        {
            ctx.Response.StatusCode = 403;
            ctx.Response.Close();
            BridgeLog.Warn("rejected non-loopback connection attempt");
            return;
        }
        if (_auth.IsBlocked)
        {
            ctx.Response.StatusCode = 429; // refuse new accepts during 60 s block
            ctx.Response.Close();
            return;
        }
        if (!ctx.Request.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = 426;
            ctx.Response.Close();
            return;
        }
        HttpListenerWebSocketContext wsCtx;
        try { wsCtx = await ctx.AcceptWebSocketAsync(null); }
        catch { return; }
        var conn = new ClientConnection(wsCtx.WebSocket, this);
        _ = conn.RunAsync(ct); // async pump; single-client policy enforced at hello
    }

    // ---- inbound dispatch (called by ClientConnection) ----
    internal async Task OnMessageAsync(ClientConnection conn, string text, int bytes)
    {
        var (env, parseErr) = EnvelopeCodec.TryParse(text, bytes);
        if (parseErr is not null)
        {
            if (conn.Authenticated)
                await conn.SendAsync(EnvelopeCodec.ErrorMessage(parseErr.Code, parseErr.Message, sid: conn.Sid));
            else if (parseErr.Code == BridgeProtocol.Errors.VersionMismatch)
            {
                // §10: error payload MUST carry code+message; supported versions as extra.
                var p = new JsonObject
                {
                    ["code"] = BridgeProtocol.Errors.VersionMismatch,
                    ["message"] = "unsupported protocol version",
                    ["supported"] = new JsonArray(
                        BridgeProtocol.SupportedVersions.Select(s => (JsonNode?)s).ToArray()),
                };
                await conn.SendAsync(EnvelopeCodec.Serialize(
                    EnvelopeCodec.Outgoing(BridgeProtocol.ServerMsg.Error, p, EnvelopeCodec.NewId())));
            }
            // unauthenticated + other errors → close silently per §4 (except AUTH_FAILED path)
            BridgeLog.Debug($"protocol_error {parseErr.Code}");
            if (parseErr.Code is BridgeProtocol.Errors.TooLarge or BridgeProtocol.Errors.VersionMismatch)
                await conn.CloseAsync($"protocol_error {parseErr.Code}");
            return;
        }

        // rate limit: 20/s sustained, burst 50; excess → RATE_LIMITED then drop;
        // sustained abuse → close 4408 (§11).
        if (!_inboundLimiter.TryTake())
        {
            conn.AbuseStrikes++;
            if (conn.Authenticated)
                await conn.SendAsync(EnvelopeCodec.ErrorMessage(BridgeProtocol.Errors.RateLimited, "rate limited"));
            if (conn.AbuseStrikes > 20)
                await conn.CloseAsync("sustained abuse", 4408);
            return;
        }
        conn.AbuseStrikes = 0;

        var e = env!;
        BridgeLog.Debug($"rx type={e.Type} sid={BridgeLog.Sid8(e.Sid)}");
        // hello MUST be first message (§2.2).
        if (!conn.HelloSeen)
        {
            if (e.Type != BridgeProtocol.ClientMsg.Hello) { await conn.CloseAsync("hello required first"); return; }
            await HandleHelloAsync(conn, e);
            return;
        }

        // session check on everything after hello.
        if (e.Sid is null || !_sessions.ValidateSid(e.Sid) || conn.Sid != e.Sid)
        {
            await conn.CloseAsync("bad session");
            return;
        }
        _sessions.Touch();
        conn.LastSeen = DateTimeOffset.UtcNow;

        switch (e.Type)
        {
            case BridgeProtocol.ClientMsg.Heartbeat:
                // liveness; discordReady echo updates cache.
                var dr = e.Payload["discordReady"]?.GetValue<bool>() ?? true;
                _state.ApplyStatePatch(new JsonObject { ["discordReady"] = dr });
                break;
            case BridgeProtocol.ClientMsg.StateSnapshot:
                _state.ApplySnapshot(e.Payload.Count > 0 && e.Payload.ContainsKey("pluginConnected")
                    ? e.Payload : UnwrapSnapshot(e.Payload));
                _ = RequestListsAsync(conn); // resync lists after snapshot (§9.1)
                break;
            case BridgeProtocol.ClientMsg.StateUpdate:
                var patch = e.Payload["patch"] as JsonObject ?? new JsonObject();
                var seq = e.Payload["seq"]?.GetValue<int>() ?? 0;
                _state.ApplyPatch(patch, seq);
                break;
            case BridgeProtocol.ClientMsg.CapabilityUpdate:
                ApplyCapabilities(e.Payload);
                break;
            case BridgeProtocol.ClientMsg.CommandResult:
                if (e.ReplyTo is not null)
                {
                    // Forward the RAW text: re-serializing env.Payload would throw
                    // (a parsed JsonNode already has a parent) and kill the pump.
                    _pending.TryComplete(e.ReplyTo, text);
                    InboundHook.TryComplete(e.ReplyTo, text); // dispatcher pump
                }
                var sp = e.Payload["statePatch"] as JsonObject;
                _state.ApplyStatePatch(sp);
                if (e.Payload["ok"]?.GetValue<bool>() == false)
                    BridgeLog.Info($"command failed cmd={BridgeLog.Trunc(e.Payload["command"]?.GetValue<string>())} " +
                        $"code={BridgeLog.Trunc(e.Payload["error"]?["code"]?.GetValue<string>())}");
                break;
            case BridgeProtocol.ClientMsg.ChannelListUpdate:
                _lists.UpdateChannels(ParseGuildList(e.Payload),
                    e.Payload["seq"]?.GetValue<int>() ?? 1);
                break;
            case BridgeProtocol.ClientMsg.DeviceListUpdate:
                _lists.UpdateDevices(ParseInputList(e.Payload), ParseOutputList(e.Payload));
                break;
            case BridgeProtocol.ClientMsg.Error:
                BridgeLog.Info($"client error code={BridgeLog.Trunc(e.Payload["code"]?.GetValue<string>())}");
                break;
            case BridgeProtocol.ClientMsg.Hello:
                await conn.SendAsync(EnvelopeCodec.ErrorMessage(
                    BridgeProtocol.Errors.SchemaInvalid, "hello already completed", sid: conn.Sid));
                break;
            default:
                await conn.SendAsync(EnvelopeCodec.ErrorMessage(
                    BridgeProtocol.Errors.UnknownType, $"unknown type {e.Type}", sid: conn.Sid));
                break;
        }
    }

    internal void OnConnectionLost(ClientConnection conn, string reason)
    {
        if (_client == conn) _client = null;
        // Only the ACTIVE authenticated session may flip global liveness.
        // Failed handshakes (bad token, duplicate, version mismatch) close with
        // Sid == null or a never-activated sid and MUST NOT clobber the
        // healthy session's cache, pending commands, or online flag.
        var wasActive = conn.Sid is not null && _sessions.RevokeSid(conn.Sid);
        if (!wasActive)
        {
            BridgeLog.Debug($"non-session connection lost ({reason}), healthy session untouched");
            return;
        }
        _pending.FailAll(BridgeProtocol.Errors.InternalError);
        _state.MarkDisconnected(reason);
        BridgeLog.Transition($"client disconnected sid={BridgeLog.Sid8(conn.Sid)} ({reason})");
        BridgeDiagnostics.Event($"lost {reason}");
        StatusChanged?.Invoke("client-lost");
    }

    private static JsonObject UnwrapSnapshot(JsonObject p) => p; // client sends full State as payload

    private void ApplyCapabilities(JsonObject p)
    {
        var avail = new Dictionary<string, bool>(StringComparer.Ordinal);
        var reasons = new Dictionary<string, string>(StringComparer.Ordinal);
        if (p["available"] is JsonObject a)
            foreach (var (k, v) in a)
                try { avail[k] = v?.GetValue<bool>() ?? false; } catch { avail[k] = false; }
        if (p["unavailableReasons"] is JsonObject r)
            foreach (var (k, v) in r)
                reasons[k] = BridgeLog.Trunc(v?.GetValue<string>(), 80);
        _caps.Update(avail, reasons);
        var echo = new JsonObject
        {
            ["availableCapabilities"] = JsonObject.Parse(System.Text.Json.JsonSerializer.Serialize(avail)),
            ["unavailableReasons"] = JsonObject.Parse(System.Text.Json.JsonSerializer.Serialize(reasons)),
        };
        _state.ApplyStatePatch(echo);
    }

    // ---- hello → welcome (§2.2 normative) ----
    private async Task HandleHelloAsync(ClientConnection conn, Envelope e)
    {
        conn.HelloSeen = true;
        if (!_auth.CheckRateLimit())
        {
            await conn.SendAsync(EnvelopeCodec.ErrorMessage(
                BridgeProtocol.Errors.RateLimited, "auth rate-limit engaged"));
            await conn.CloseAsync("auth blocked", 4408);
            return;
        }
        var pl = e.Payload;
        var token = pl["token"]?.GetValue<string>();
        var name = pl["name"]?.GetValue<string>() ?? "unknown";
        var version = pl["version"]?.GetValue<string>() ?? "?";
        // NOTE: token never logged (not even partially) per §2.1.

        if (!_auth.ValidateHelloToken(token))
        {
            LastAuthFailureAt = DateTimeOffset.UtcNow.ToString("o");
            StatusChanged?.Invoke("auth-failed");
            await conn.SendAsync(EnvelopeCodec.ErrorMessage(
                BridgeProtocol.Errors.AuthFailed, "invalid token", replyTo: e.Id));
            BridgeLog.Info($"auth failure from 127.0.0.1 at {LastAuthFailureAt}");
            await conn.CloseAsync("auth failed", 4401);
            return;
        }

        var caps = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (pl["capabilities"] is JsonObject c)
            foreach (var (k, v) in c)
                try { caps[k] = v?.GetValue<bool>() ?? false; } catch { caps[k] = false; }

        var (accepted, evicted, created) = _sessions.TryAccept(name, version, caps);
        if (!accepted)
        {
            await conn.SendAsync(EnvelopeCodec.ErrorMessage(
                BridgeProtocol.Errors.AlreadyConnected, "another client is connected", replyTo: e.Id));
            await conn.CloseAsync("already connected", 4409);
            return;
        }
        if (evicted is not null && _client is not null)
        {
            await _client.SendAsync(EnvelopeCodec.ErrorMessage(
                BridgeProtocol.Errors.SessionReplaced, "session replaced by new client", sid: evicted.Sid));
            await _client.CloseAsync("replaced", 4409);
        }
        conn.Authenticate(created.Sid);
        _client = conn;
        BridgeDiagnostics.SessionStart();
        _lists.ResetSequences(); // seq restarts per connection (§9.1)
        var welcome = new JsonObject
        {
            ["sessionId"] = created.Sid,
            ["protocolVersion"] = BridgeProtocol.Version,
            ["heartbeatIntervalMs"] = BridgeProtocol.HeartbeatIntervalMs,
            ["requestSnapshot"] = true,
            ["readOnly"] = _opts.ReadOnly,
        };
        await conn.SendAsync(EnvelopeCodec.Serialize(EnvelopeCodec.Outgoing(
            BridgeProtocol.ServerMsg.Welcome, welcome, EnvelopeCodec.NewId(), e.Id, created.Sid)));
        BridgeLog.Transition($"client connected sid={BridgeLog.Sid8(created.Sid)} name={BridgeLog.Trunc(name, 40)} v={BridgeLog.Trunc(version, 20)}");
        BridgeDiagnostics.Event($"hello {name}");
        StatusChanged?.Invoke("client-connected");
    }

    private static List<GuildInfo> ParseGuildList(JsonObject p)
    {
        var out_ = new List<GuildInfo>();
        if (p["guilds"] is not JsonArray gs) return out_;
        foreach (var g in gs.OfType<JsonObject>())
        {
            var chans = new List<ChannelNode>();
            if (g["channels"] is JsonArray cs)
                foreach (var c in cs.OfType<JsonObject>())
                    chans.Add(new ChannelNode(
                        c["id"]?.GetValue<string>() ?? "", c["name"]?.GetValue<string>() ?? "",
                        c["type"]?.GetValue<string>() ?? "text", c["path"]?.GetValue<string>() ?? "",
                        c["parentId"]?.GetValue<string>()));
            out_.Add(new GuildInfo(g["id"]?.GetValue<string>() ?? "",
                g["name"]?.GetValue<string>() ?? "", chans));
        }
        return out_;
    }

    private static List<DeviceInfo> ParseDeviceArray(JsonNode? n, string kind)
    {
        var out_ = new List<DeviceInfo>();
        if (n is not JsonArray arr) return out_;
        foreach (var d in arr.OfType<JsonObject>())
            out_.Add(new DeviceInfo(d["id"]?.GetValue<string>() ?? "",
                d["name"]?.GetValue<string>() ?? "", kind,
                d["isDefault"]?.GetValue<bool>() ?? false));
        return out_;
    }
    private static List<DeviceInfo> ParseInputList(JsonObject p) => ParseDeviceArray(p["inputs"], "input");
    private static List<DeviceInfo> ParseOutputList(JsonObject p) => ParseDeviceArray(p["outputs"], "output");

    private async Task RequestListsAsync(ClientConnection conn)
    {
        await conn.SendAsync(EnvelopeCodec.Serialize(EnvelopeCodec.Outgoing(
            BridgeProtocol.ServerMsg.RequestCapabilities, new JsonObject(), EnvelopeCodec.NewId(), sid: conn.Sid)));
        await conn.SendAsync(EnvelopeCodec.Serialize(EnvelopeCodec.Outgoing(
            BridgeProtocol.ServerMsg.RequestChannelList, new JsonObject(), EnvelopeCodec.NewId(), sid: conn.Sid)));
        await conn.SendAsync(EnvelopeCodec.Serialize(EnvelopeCodec.Outgoing(
            BridgeProtocol.ServerMsg.RequestDeviceList, new JsonObject(), EnvelopeCodec.NewId(), sid: conn.Sid)));
    }

    // ---- outbound: server→client (§5.2) ----
    public Task<bool> SendRawAsync(string text)
        => _client?.SendAsync(text) ?? Task.FromResult(false);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { StopAsync().GetAwaiter().GetResult(); } catch { }
        _pending.Dispose();
        _cts?.Dispose();
    }
}

/// One WS connection: size-guarded receive (64 KB), hello-timeout 5 s,
/// heartbeat timeout 15 s without ANY message (§9.2). Close codes per §2.3.
public sealed class ClientConnection
{
    private readonly WebSocket _ws;
    private readonly BridgeServer _server;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private bool _closed;

    public string? Sid { get; private set; }
    public bool Authenticated => Sid is not null;
    public bool HelloSeen { get; set; }
    public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
    public int AbuseStrikes { get; set; }

    public ClientConnection(WebSocket ws, BridgeServer server)
    {
        _ws = ws;
        _server = server;
    }

    public void Authenticate(string sid)
    {
        Sid = sid;
        LastSeen = DateTimeOffset.UtcNow;
    }

    public async Task<bool> SendAsync(string text)
    {
        if (_closed) return false;
        var bytes = Encoding.UTF8.GetBytes(text);
        await _sendGate.WaitAsync();
        try
        {
            await _ws.SendAsync(new ArraySegment<byte>(bytes),
                WebSocketMessageType.Text, true, CancellationToken.None);
            return true;
        }
        catch { return false; }
        finally { _sendGate.Release(); }
    }

    public async Task CloseAsync(string reason, int code = 1000)
    {
        if (_closed) return;
        _closed = true;
        try
        {
            await _ws.CloseOutputAsync((WebSocketCloseStatus)code, reason, CancellationToken.None);
        }
        catch { }
        _server.OnConnectionLost(this, code switch
        {
            4401 => "AUTH_FAILED",
            4409 => "REPLACED_OR_DUPLICATE",
            4000 => "HEARTBEAT_TIMEOUT",
            _ => "WS_DROP",
        });
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var buffer = new byte[BridgeProtocol.MaxMessageBytes + 1024];
        var sb = new StringBuilder();
        using var helloCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        helloCts.CancelAfter(BridgeProtocol.HelloTimeoutMs);
        try
        {
            while (!ct.IsCancellationRequested && !_closed &&
                   _ws.State == WebSocketState.Open)
            {
                // heartbeat timeout: 15 s without ANY message (§9.2).
                var remaining = BridgeProtocol.HeartbeatTimeoutMs -
                    (int)(DateTimeOffset.UtcNow - LastSeen).TotalMilliseconds;
                if (Authenticated && remaining <= 0)
                {
                    BridgeLog.Transition($"heartbeat timeout sid={BridgeLog.Sid8(Sid)}");
                    await CloseAsync("heartbeat timeout", 4000);
                    break;
                }
                using var msgCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                if (!HelloSeen) msgCts.CancelAfter(BridgeProtocol.HelloTimeoutMs);
                else if (Authenticated) msgCts.CancelAfter(Math.Max(remaining, 1000));
                else msgCts.CancelAfter(BridgeProtocol.HelloTimeoutMs);

                sb.Clear();
                int totalBytes = 0;
                bool tooLarge = false;
                WebSocketReceiveResult res;
                try
                {
                    do
                    {
                        res = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), msgCts.Token);
                        if (res.MessageType == WebSocketMessageType.Close)
                        {
                            await CloseAsync("client close");
                            return;
                        }
                        totalBytes += res.Count;
                        if (totalBytes > BridgeProtocol.MaxMessageBytes) { tooLarge = true; break; }
                        sb.Append(Encoding.UTF8.GetString(buffer, 0, res.Count));
                    } while (!res.EndOfMessage);
                }
                catch (OperationCanceledException)
                {
                    if (!HelloSeen) { await CloseAsync("hello timeout"); return; }
                    continue; // re-evaluate heartbeat timeout
                }
                catch { await CloseAsync("receive error"); return; }

                if (tooLarge)
                {
                    // drain remainder, then protocol_error TOO_LARGE (§1).
                    try
                    {
                        do { res = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct); }
                        while (!res.EndOfMessage);
                    }
                    catch { }
                    if (Authenticated)
                        await SendAsync(EnvelopeCodec.ErrorMessage(
                            BridgeProtocol.Errors.TooLarge, "message exceeds 64KB", sid: Sid));
                    BridgeLog.Debug("protocol_error TOO_LARGE");
                    continue;
                }

                if (res.MessageType != WebSocketMessageType.Text) continue; // text frames only (§1)
                LastSeen = DateTimeOffset.UtcNow;
                try
                {
                    await _server.OnMessageAsync(this, sb.ToString(), totalBytes);
                }
                catch (Exception ex)
                {
                    // One poison message must never kill a healthy session (§11).
                    BridgeLog.Debug($"inbound handler threw ({ex.GetType().Name}), connection kept");
                    if (Authenticated)
                        await SendAsync(EnvelopeCodec.ErrorMessage(
                            BridgeProtocol.Errors.InternalError, "internal error", sid: Sid));
                }
            }
        }
        catch { await CloseAsync("pump error"); }
    }
}
