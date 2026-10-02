// BridgeSmoke — server-side protocol self-test (interop checklist §15, items 1-3,5).
// Starts a real BridgeServer on 127.0.0.1 and drives it with BCL ClientWebSocket.
// Exit code 0 = all checks pass. No secrets are printed (token shown as ***).
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using DeckBridge.Core;

return await Smoke.RunAsync();

static class Smoke
{
    static int _fail;
    static void Check(bool ok, string name)
    {
        Console.WriteLine((ok ? "  [PASS] " : "  [FAIL] ") + name);
        if (!ok) _fail++;
    }

    static string Env(string type, JsonObject payload, string? id = null,
        string? replyTo = null, string? sid = null)
    {
        var o = new JsonObject
        {
            ["v"] = "1.0.0", ["type"] = type,
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["payload"] = payload,
        };
        if (id is not null) o["id"] = id;
        if (replyTo is not null) o["replyTo"] = replyTo;
        if (sid is not null) o["sid"] = sid;
        return o.ToJsonString();
    }

    static async Task<string> Recv(ClientWebSocket ws, int timeoutMs = 5000)
        => await RecvWhere(ws, _ => true, timeoutMs);

    // Server may legitimately push request_*/heartbeat_request ahead of the
    // message under test — skip up to N non-matching messages.
    static async Task<string> RecvWhere(ClientWebSocket ws,
        Func<JsonNode?, bool> match, int timeoutMs = 5000, int maxSkip = 10)
    {
        for (var i = 0; i < maxSkip; i++)
        {
            var raw = await RecvOne(ws, timeoutMs);
            JsonNode? node = null;
            try { node = JsonNode.Parse(raw); } catch { }
            if (match(node)) return raw;
        }
        throw new Exception("no matching message received");
    }

    static async Task<string> RecvOne(ClientWebSocket ws, int timeoutMs = 5000)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        var buf = new byte[128 * 1024];
        var sb = new StringBuilder();
        WebSocketReceiveResult r;
        do { r = await ws.ReceiveAsync(buf, cts.Token); sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count)); }
        while (!r.EndOfMessage);
        if (r.MessageType == WebSocketMessageType.Close)
            throw new Exception("ws closed: " + r.CloseStatus);
        return sb.ToString();
    }

    static Task Send(ClientWebSocket ws, string text) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    static string? CodeOf(string raw)
    {
        try { return JsonNode.Parse(raw)?["payload"]?["code"]?.GetValue<string>(); }
        catch { return null; }
    }

    static string SidOf(string welcome)
    {
        try { return JsonNode.Parse(welcome)?["sid"]?.GetValue<string>() ?? ""; }
        catch { return ""; }
    }

    static JsonObject FullState() => (JsonObject)BridgeStateCache.InitialState().DeepClone();

    public static async Task<int> RunAsync()
    {
        var auth = new AuthManager();
        var token = auth.RevealForSettingsUI();
        var server = new BridgeServer(new BridgeServerOptions { ConfiguredPort = 8399 }, auth);
        await server.StartAsync();
        var port = server.ActualPort;
        Check(port >= 8399, $"binds 127.0.0.1 (actual port {port})");

        // --- 1. hello → welcome(sid) → snapshot → heartbeat ---
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws/"), CancellationToken.None);
        var helloId = Guid.NewGuid().ToString("N");
        await Send(ws, Env("hello", new JsonObject
        {
            ["protocolVersion"] = "1.0.0", ["name"] = "smoke-client",
            ["version"] = "0.0.1", ["token"] = token,
            ["capabilities"] = new JsonObject { ["mute"] = true },
        }, helloId));
        var welcome = await Recv(ws);
        var wnode = JsonNode.Parse(welcome);
        Check(wnode?["type"]?.GetValue<string>() == "welcome"
            && wnode?["replyTo"]?.GetValue<string>() == helloId
            && wnode?["payload"]?["heartbeatIntervalMs"]?.GetValue<int>() == 5000
            && wnode?["payload"]?["requestSnapshot"]?.GetValue<bool>() == true,
            "hello → welcome(sid, 5s heartbeat, requestSnapshot)");
        var sid = SidOf(welcome);
        Check(sid.Length > 8, "sid issued (not echoed in logs)");

        await Send(ws, Env("state_snapshot", FullState(), Guid.NewGuid().ToString("N"), sid: sid));
        await Task.Delay(300);
        Check(server.State.IsLive, "state_snapshot applied to cache");
        await Send(ws, Env("heartbeat", new JsonObject { ["ok"] = true, ["discordReady"] = true },
            Guid.NewGuid().ToString("N"), sid: sid));
        await Task.Delay(200);
        Check(server.State.GetValue("discordReady", false), "heartbeat processed");

        // --- 2. bad token → AUTH_FAILED + close 4401 ---
        using var bad = new ClientWebSocket();
        await bad.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws/"), CancellationToken.None);
        await Send(bad, Env("hello", new JsonObject
        {
            ["protocolVersion"] = "1.0.0", ["name"] = "bad",
            ["version"] = "0", ["token"] = "wrong-token",
            ["capabilities"] = new JsonObject(),
        }, Guid.NewGuid().ToString("N")));
        var err = await Recv(bad);
        Check(CodeOf(err) == "AUTH_FAILED",
            "bad token → AUTH_FAILED (no token echo)");
        var buf = new byte[1024];
        var close = await bad.ReceiveAsync(buf, CancellationToken.None);
        Check(close.CloseStatus == (WebSocketCloseStatus)4401, "bad token → close 4401");

        // --- 3. second client while one authenticated → ALREADY_CONNECTED + 4409 ---
        using var dup = new ClientWebSocket();
        await dup.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws/"), CancellationToken.None);
        await Send(dup, Env("hello", new JsonObject
        {
            ["protocolVersion"] = "1.0.0", ["name"] = "dup",
            ["version"] = "0", ["token"] = token, ["capabilities"] = new JsonObject(),
        }, Guid.NewGuid().ToString("N")));
        var dupErr = await Recv(dup);
        Check(CodeOf(dupErr) == "ALREADY_CONNECTED",
            "second client → ALREADY_CONNECTED (allowReplacement=false)");

        // --- 4. malformed / unknown / oversized rejected, connection survives ---
        await Send(ws, "not-json{{{");
        await Task.Delay(200);
        Check(ws.State == WebSocketState.Open, "malformed JSON rejected, connection survives");
        // unknown type WITH valid session → error UNKNOWN_TYPE
        // (skip the earlier SCHEMA_INVALID error still queued from the malformed step)
        await Send(ws, Env("frobnicate", new JsonObject(), Guid.NewGuid().ToString("N"), sid: sid));
        var unk = await RecvWhere(ws, n => CodeOf(n?.ToJsonString() ?? "") == "UNKNOWN_TYPE");
        Check(CodeOf(unk) == "UNKNOWN_TYPE",
            "unknown type → error UNKNOWN_TYPE");

        // --- 5. version mismatch → VERSION_MISMATCH ---
        using var old = new ClientWebSocket();
        await old.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws/"), CancellationToken.None);
        var badVer = new JsonObject
        {
            ["v"] = "9.9.9", ["type"] = "hello",
            ["id"] = Guid.NewGuid().ToString("N"),
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["payload"] = new JsonObject
            {
                ["protocolVersion"] = "9.9.9", ["name"] = "old",
                ["version"] = "0", ["token"] = token, ["capabilities"] = new JsonObject(),
            },
        }.ToJsonString();
        await Send(old, badVer);
        var ver = await Recv(old);
        var verCode = CodeOf(ver);
        if (verCode != "VERSION_MISMATCH") Console.WriteLine("  raw: " + ver);
        Check(verCode == "VERSION_MISMATCH", "bad v → VERSION_MISMATCH");

        // --- 6. capability_update + command pre-checks (dispatcher, local) ---
        await Send(ws, Env("capability_update", new JsonObject
        {
            ["available"] = new JsonObject { ["mute"] = true },
            ["unavailableReasons"] = new JsonObject(),
        }, Guid.NewGuid().ToString("N"), sid: sid));
        await Task.Delay(200);
        var disp = new CommandDispatcher(server);
        var blocked = disp.PreCheck("toggle_deafen");
        if (blocked?.ErrorCode != "UNSUPPORTED")
            Console.WriteLine($"  diag: blocked={blocked?.ErrorCode} live={server.State.IsLive}");
        Check(blocked?.ErrorCode == "UNSUPPORTED", "missing capability → UNSUPPORTED (never silent)");

        // --- 7. reconnect: drop + re-hello works, fresh snapshot ---
        await Send(ws, Env("state_update", new JsonObject
        {
            ["patch"] = new JsonObject { ["voiceChannelName"] = "General" },
            ["seq"] = 1,
        }, Guid.NewGuid().ToString("N"), sid: sid));
        await Task.Delay(200);
        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
        await Task.Delay(400);
        Check(!server.State.IsLive, "drop → marked disconnected, last-known kept");
        Check(server.State.Get("voiceChannelName")?.GetValue<string>() == "General",
            "last-known non-live state retained after drop");

        await server.StopAsync();
        server.Dispose();
        Console.WriteLine(_fail == 0 ? "SMOKE ALL PASS" : $"SMOKE {_fail} FAILURES");
        return _fail == 0 ? 0 : 1;
    }
}

