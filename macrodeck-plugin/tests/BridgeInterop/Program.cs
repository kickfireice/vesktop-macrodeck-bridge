// BridgeInterop — REAL C# BridgeServer ↔ Node MockVesktopClient end-to-end test.
// Proves the two agents' implementations interop per PROTOCOL.md:
// handshake → snapshot → command roundtrips (ok/ambiguous/unsupported/unknown)
// → resync after client restart. Also asserts log sanitization (no token,
// no full sid in any log line). Exit 0 = all pass.
using System.Diagnostics;
using System.Text.Json.Nodes;
using DeckBridge.Core;

return await Interop.RunAsync();

static class Interop
{
    static int _fail;
    static readonly List<string> LogLines = [];
    static void Check(bool ok, string name, string extra = "")
    {
        Console.WriteLine((ok ? "  [PASS] " : "  [FAIL] ") + name + (ok || extra == "" ? "" : " — " + extra));
        if (!ok) _fail++;
    }

    static string FindMockClient()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var cand = Path.Combine(dir.FullName, "mock-client", "mockVesktopClient.js");
            if (File.Exists(cand)) return cand;
            var cand2 = Path.Combine(dir.FullName, "tests", "mock-client", "mockVesktopClient.js");
            if (File.Exists(cand2)) return cand2;
        }
        throw new FileNotFoundException("mockVesktopClient.js not found");
    }

    static async Task<bool> WaitFor(Func<bool> cond, int timeoutMs = 15000)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (cond()) return true;
            await Task.Delay(200);
        }
        return cond();
    }

    public static async Task<int> RunAsync()
    {
        BridgeLog.Level = BridgeLogLevel.Debug;
        BridgeLog.OnLine += line => { lock (LogLines) LogLines.Add(line); };
        var token = AuthManager.GenerateToken();
        var auth = new AuthManager(token);
        var server = new BridgeServer(new BridgeServerOptions { ConfiguredPort = 8401 }, auth);
        await server.StartAsync();
        var port = server.ActualPort;
        var mockJs = FindMockClient();
        Console.WriteLine($"real C# server on 127.0.0.1:{port}, mock={mockJs}");

        Process StartMock()
        {
            var psi = new ProcessStartInfo("node", $"\"{mockJs}\" --port {port} --token {token}")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            var p = Process.Start(psi)!;
            p.OutputDataReceived += (_, e) => { if (e.Data is not null) Console.WriteLine("  [mock] " + e.Data); };
            p.ErrorDataReceived += (_, e) => { if (e.Data is not null) Console.WriteLine("  [mock:ERR] " + e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        var mock = StartMock();
        Check(await WaitFor(() => server.State.IsLive), "mock hello→welcome→snapshot (server cache live)");
        Check(await WaitFor(() => server.State.GetValue("discordReady", false)),
            "heartbeat flowing (discordReady=true)");
        Check(server.Capabilities.IsAvailable(BridgeProtocol.Caps.Mute)
            && !server.Capabilities.IsAvailable(BridgeProtocol.Caps.StageRaiseHand),
            "capabilities cached (mute=true, stage=false)");

        var disp = new CommandDispatcher(server);

        // toggle_mute → ok + statePatch applied to cache
        var r1 = await disp.SendAsync(BridgeProtocol.Commands.ToggleMute);
        Check(r1.Ok && r1.ErrorCode is null, "toggle_mute → ok");
        Check(server.State.Get("selfMuted")?.GetValue<bool>() == true,
            "statePatch applied (selfMuted=true)");

        // ambiguous name → AMBIGUOUS (mock has twin 'General' voice channels)
        var r2 = await disp.SendAsync(BridgeProtocol.Commands.JoinVoiceByName,
            new JsonObject { ["name"] = "General" });
        Check(!r2.Ok && r2.ErrorCode == BridgeProtocol.Errors.Ambiguous,
            "join_voice_by_name 'General' → AMBIGUOUS", r2.ErrorCode ?? "?");

        // unsupported → UNSUPPORTED, never silent
        var r3 = await disp.SendAsync(BridgeProtocol.Commands.StageRaiseHand);
        Check(!r3.Ok && r3.ErrorCode == BridgeProtocol.Errors.Unsupported,
            "stage_raise_hand → UNSUPPORTED", r3.ErrorCode ?? "?");

        // unknown command → UNKNOWN_COMMAND from client
        var r4 = await disp.SendAsync("frobnicate_the_discord");
        Check(!r4.Ok && r4.ErrorCode == BridgeProtocol.Errors.UnknownCommand,
            "unknown command → UNKNOWN_COMMAND", r4.ErrorCode ?? "?");

        // readOnly gate (local pre-check, no wire)
        server.ReadOnly = true;
        var r5 = await disp.SendAsync(BridgeProtocol.Commands.ToggleMute);
        Check(!r5.Ok && r5.ErrorCode == BridgeProtocol.Errors.ReadOnly,
            "readOnly → mutating command rejected locally", r5.ErrorCode ?? "?");
        server.ReadOnly = false;

        // reconnect: kill mock → server marks offline, keeps last-known → restart → resync
        try { mock.Kill(entireProcessTree: true); } catch { }
        await mock.WaitForExitAsync();
        Check(await WaitFor(() => !server.State.IsLive, 10000), "client kill → marked offline");
        Check(server.State.Get("selfMuted")?.GetValue<bool>() == true,
            "last-known state kept while offline");
        mock = StartMock();
        Check(await WaitFor(() => server.State.IsLive, 20000), "mock restart → re-hello → live again");
        var r6 = await disp.SendAsync(BridgeProtocol.Commands.SetMute,
            new JsonObject { ["muted"] = false });
        Check(r6.Ok, "post-reconnect command roundtrip ok");

        // log sanitization: token and full sid must NEVER appear
        var sid = server.ActiveClient?.Sid ?? "";
        List<string> lines;
        lock (LogLines) lines = [.. LogLines];
        Check(!lines.Any(l => l.Contains(token)), "token never logged");
        Check(string.IsNullOrEmpty(sid) || !lines.Any(l => l.Contains(sid)),
            "full sid never logged (first-8 only)");

        try { mock.Kill(entireProcessTree: true); } catch { }
        await server.StopAsync();
        server.Dispose();
        Console.WriteLine(_fail == 0 ? "INTEROP ALL PASS" : $"INTEROP {_fail} FAILURES");
        return _fail == 0 ? 0 : 1;
    }
}
