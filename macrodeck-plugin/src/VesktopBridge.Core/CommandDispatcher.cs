// CommandDispatcher.cs — §6/§8/§11 command flow (async, never blocks UI):
// check connected → check capability → check readOnly → send command with id →
// await command_result (3 s, 10 s voice) → update cache → feedback.
// Unknown → UNKNOWN_COMMAND handled client-side; here unknown names are sent
// and the client's command_result is authoritative.
using System.Text.Json.Nodes;

namespace DeckBridge.Core;

public sealed record CommandOutcome(bool Ok, string Command, JsonObject? StatePatch,
    string? ErrorCode, string? ErrorMessage, bool FromCache = false);

public sealed class CommandDispatcher
{
    private readonly BridgeServer _server;
    private readonly CapabilityStore _caps;
    private readonly BridgeStateCache _state;
    private readonly PendingCommandStore _pending = new();

    private static readonly HashSet<string> AlwaysAllowed = new(StringComparer.Ordinal)
    {
        BridgeProtocol.Commands.RefreshState, BridgeProtocol.Commands.GetCapabilities,
        BridgeProtocol.Commands.GetChannelList, BridgeProtocol.Commands.GetDeviceList,
    };

    private static readonly HashSet<string> StateGetters = new(StringComparer.Ordinal)
    {
        BridgeProtocol.Commands.RefreshState, BridgeProtocol.Commands.GetCapabilities,
        BridgeProtocol.Commands.GetChannelList, BridgeProtocol.Commands.GetDeviceList,
    };

    public CommandDispatcher(BridgeServer server)
    {
        _server = server;
        _caps = server.Capabilities;
        _state = server.State;
        _server.State.Changed += _ => { }; // feedback hook wired by plugin layer
    }

    public bool IsConnected => _state.IsLive && _server.ActiveClient is not null;

    /// Local pre-checks only (never fail silently — every path returns a
    /// CommandOutcome with a normative error code). Returns null if the
    /// command may be sent.
    public CommandOutcome? PreCheck(string command)
    {
        if (!IsConnected)
            return new(false, command, null, BridgeProtocol.Errors.NotConnected,
                "Vesktop not connected", FromCache: true);
        // §6.2: Macro Deck setting is authoritative; client echo also honored.
        if ((_server.ReadOnly || _state.GetValue("readOnly", false)) && !StateGetters.Contains(command))
            return new(false, command, null, BridgeProtocol.Errors.ReadOnly,
                "bridge is read-only", FromCache: true);
        var flag = BridgeProtocol.Caps.RequiredFlag(command);
        if (flag is not null && !_caps.IsAvailable(flag))
            return new(false, command, null, BridgeProtocol.Errors.Unsupported,
                $"capability '{flag}' unavailable", FromCache: true);
        if (command is BridgeProtocol.Commands.ToggleMuteAndDeafen && !_caps.IsAvailable(BridgeProtocol.Caps.Deafen))
            return new(false, command, null, BridgeProtocol.Errors.Unsupported,
                "capability 'deafen' unavailable", FromCache: true);
        return null;
    }

    public async Task<CommandOutcome> SendAsync(string command,
        JsonObject? args = null, CancellationToken ct = default)
    {
        var blocked = PreCheck(command);
        if (blocked is not null)
        {
            _state.SetLastError(blocked.ErrorCode);
            return blocked;
        }
        var id = EnvelopeCodec.NewId();
        var payload = new JsonObject
        {
            ["command"] = command,
            ["args"] = args is null ? new JsonObject() : (JsonNode)args.DeepClone(),
        };
        var sid = _server.ActiveClient?.Sid;
        var wire = EnvelopeCodec.Serialize(new Envelope(BridgeProtocol.Version,
            BridgeProtocol.ServerMsg.Command, id, null, EnvelopeCodec.NowMs(), sid, payload));

        // NOTE: server→client command has no local echo of token/sid-full in logs.
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(id, tcs))
        {
            _state.SetLastError(BridgeProtocol.Errors.RateLimited);
            return new(false, command, null, BridgeProtocol.Errors.RateLimited,
                "pending queue full (32)", FromCache: true);
        }
        // wire pending completion from inbound command_result pump:
        _server.State.Changed += OnAnyState; // no-op keepalive; real completion via CompleteInbound
        HookInbound(id, tcs);
        if (!await _server.SendRawAsync(wire))
        {
            _pending.Fail(id, BridgeProtocol.Errors.NotConnected);
            return new(false, command, null, BridgeProtocol.Errors.NotConnected, "send failed");
        }
        var timeout = BridgeProtocol.Commands.TimeoutFor(command);
        using var timeoutCts = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        try
        {
            var raw = await tcs.Task.WaitAsync(linked.Token);
            return ParseResult(command, raw);
        }
        catch (TimeoutException)
        {
            _pending.Fail(id, BridgeProtocol.Errors.Timeout);
            _state.SetLastError(BridgeProtocol.Errors.Timeout);
            BridgeLog.Info($"command timeout cmd={command}");
            return new(false, command, null, BridgeProtocol.Errors.Timeout, "timeout");
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
        {
            _pending.Fail(id, BridgeProtocol.Errors.Timeout);
            _state.SetLastError(BridgeProtocol.Errors.Timeout);
            return new(false, command, null, BridgeProtocol.Errors.Timeout, "timeout");
        }
        catch (BridgeCommandException bce)
        {
            return new(false, command, null, bce.Code, bce.Message);
        }
        catch (OperationCanceledException)
        {
            _pending.Fail(id, BridgeProtocol.Errors.InternalError);
            return new(false, command, null, BridgeProtocol.Errors.InternalError, "cancelled");
        }
    }

    // Called by the server inbound pump when a command_result arrives.
    // (Wired in BridgeServer integration — see DeckBridgeIntegration.)
    public bool CompleteInbound(string replyTo, string raw)
    {
        var ok = _pending.TryComplete(replyTo, raw);
        return ok;
    }

    private void HookInbound(string id, TaskCompletionSource<string> tcs)
    {
        InboundHook.Hook(id, tcs, _pending);
    }

    private void OnAnyState(IReadOnlyList<string> _) { }

    private CommandOutcome ParseResult(string command, string raw)
    {
        try
        {
            var (env, _) = EnvelopeCodec.TryParse(raw, EnvelopeCodec.Utf8Bytes(raw));
            var p = env?.Payload;
            var ok = p?["ok"]?.GetValue<bool>() ?? false;
            var patch = p?["statePatch"] as JsonObject;
            if (patch is not null) _state.ApplyStatePatch(patch);
            if (ok) { _state.SetLastError(null); return new(true, command, patch, null, null); }
            var code = p?["error"]?["code"]?.GetValue<string>() ?? BridgeProtocol.Errors.InternalError;
            var msg = p?["error"]?["message"]?.GetValue<string>() ?? "failed";
            _state.SetLastError(code);
            return new(false, command, patch, code, BridgeLog.Trunc(msg));
        }
        catch (Exception ex)
        {
            return new(false, command, null, BridgeProtocol.Errors.InternalError, BridgeLog.Trunc(ex.Message));
        }
    }

    /// Fire-and-forget variant for button handlers: never blocks UI thread.
    public void SendNoWait(string command, JsonObject? args = null)
        => _ = SendAsync(command, args);
}

/// Process-wide hook table so BridgeServer's inbound pump can complete the
/// dispatcher's pending tasks without a hard reference cycle.
public static class InboundHook
{
    private static readonly object Gate = new();
    private static readonly Dictionary<string, TaskCompletionSource<string>> Hooks = new();

    public static void Hook(string id, TaskCompletionSource<string> tcs, PendingCommandStore store)
    {
        lock (Gate) Hooks[id] = tcs;
        tcs.Task.ContinueWith(_ => { lock (Gate) Hooks.Remove(id); });
        // bridge server store also tracks for queue-limit accounting
    }

    public static bool TryComplete(string replyTo, string raw)
    {
        TaskCompletionSource<string>? tcs;
        lock (Gate) Hooks.TryGetValue(replyTo, out tcs);
        if (tcs is null) return false; // already timed out → ignore per §6.1
        return tcs.TrySetResult(raw);
    }
}
