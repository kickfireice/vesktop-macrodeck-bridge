// Envelope.cs — §4 message envelope: build, serialize, validate (normative order).
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DeckBridge.Core;

public sealed record Envelope(
    string V,
    string Type,
    string? Id,
    string? ReplyTo,
    long Ts,
    string? Sid,
    JsonObject Payload);

public sealed record EnvelopeError(string Code, string Message, JsonObject? Details = null);

public static class EnvelopeCodec
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = null,
        WriteIndented = false,
    };

    private static readonly HashSet<string> KnownTypes =
    [
        // client→server
        BridgeProtocol.ClientMsg.Hello, BridgeProtocol.ClientMsg.Heartbeat,
        BridgeProtocol.ClientMsg.StateSnapshot, BridgeProtocol.ClientMsg.StateUpdate,
        BridgeProtocol.ClientMsg.CapabilityUpdate, BridgeProtocol.ClientMsg.CommandResult,
        BridgeProtocol.ClientMsg.Error, BridgeProtocol.ClientMsg.DeviceListUpdate,
        BridgeProtocol.ClientMsg.ChannelListUpdate,
        // server→client
        BridgeProtocol.ServerMsg.Welcome, BridgeProtocol.ServerMsg.HeartbeatRequest,
        BridgeProtocol.ServerMsg.GetState, BridgeProtocol.ServerMsg.Command,
        BridgeProtocol.ServerMsg.RequestCapabilities, BridgeProtocol.ServerMsg.RequestChannelList,
        BridgeProtocol.ServerMsg.RequestDeviceList,
    ];

    private static readonly HashSet<string> IdRequired = new(StringComparer.Ordinal)
    {
        BridgeProtocol.ClientMsg.Hello,
        BridgeProtocol.ServerMsg.GetState, BridgeProtocol.ServerMsg.Command,
        BridgeProtocol.ServerMsg.RequestCapabilities, BridgeProtocol.ServerMsg.RequestChannelList,
        BridgeProtocol.ServerMsg.RequestDeviceList,
    };

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static string NewId() => Guid.NewGuid().ToString("N");

    public static string Serialize(Envelope env)
    {
        var o = new JsonObject
        {
            ["v"] = env.V,
            ["type"] = env.Type,
            ["ts"] = env.Ts,
            ["payload"] = env.Payload,
        };
        if (env.Id is not null) o["id"] = env.Id;
        if (env.ReplyTo is not null) o["replyTo"] = env.ReplyTo;
        if (env.Sid is not null) o["sid"] = env.Sid;
        return o.ToJsonString(JsonOpts);
    }

    public static Envelope Outgoing(string type, JsonObject payload, string? id = null,
        string? replyTo = null, string? sid = null) =>
        new(BridgeProtocol.Version, type, id, replyTo, NowMs(), sid, payload);

    /// Validation order (§4): valid JSON → size ≤64KB → required fields →
    /// known type → schema per type → (auth/session + rate limit done by server).
    public static (Envelope? env, EnvelopeError? err) TryParse(string text, int byteCount)
    {
        if (byteCount > BridgeProtocol.MaxMessageBytes)
            return (null, new(BridgeProtocol.Errors.TooLarge, "message exceeds 64KB"));
        JsonNode? node;
        try { node = JsonNode.Parse(text); }
        catch { return (null, new(BridgeProtocol.Errors.SchemaInvalid, "invalid JSON")); }
        if (node is not JsonObject o)
            return (null, new(BridgeProtocol.Errors.SchemaInvalid, "envelope must be an object"));

        var v = o["v"]?.GetValue<string>();
        var type = o["type"]?.GetValue<string>();
        var tsNode = o["ts"];
        var payload = o["payload"];
        if (v is null || type is null || tsNode is null || payload is null)
            return (null, new(BridgeProtocol.Errors.SchemaInvalid, "missing v/type/ts/payload"));
        if (!BridgeProtocol.SupportedVersions.Contains(v))
            return (null, new(BridgeProtocol.Errors.VersionMismatch, $"unsupported protocol v={Sanitize(v)}"));
        if (!KnownTypes.Contains(type))
            return (null, new(BridgeProtocol.Errors.UnknownType, $"unknown type {Sanitize(type)}"));
        long ts;
        try { ts = tsNode.GetValue<long>(); }
        catch { return (null, new(BridgeProtocol.Errors.SchemaInvalid, "ts must be epoch ms")); }
        if (Math.Abs(NowMs() - ts) > BridgeProtocol.MaxClockSkewMs)
            BridgeLog.Debug($"clock skew >60s on {type} (accepted, logged per §4)");
        if (IdRequired.Contains(type) && o["id"]?.GetValue<string>() is not { Length: > 0 })
            return (null, new(BridgeProtocol.Errors.SchemaInvalid, $"id required for {type}"));
        if (payload is not JsonObject p)
            return (null, new(BridgeProtocol.Errors.SchemaInvalid, "payload must be an object"));

        return (new(v, type, o["id"]?.GetValue<string>(), o["replyTo"]?.GetValue<string>(),
            ts, o["sid"]?.GetValue<string>(), p), null);
    }

    public static int Utf8Bytes(string s) => Encoding.UTF8.GetByteCount(s);

    private static string Sanitize(string s) =>
        s.Length > 64 ? s[..64] + "…" : s;

    public static string ErrorMessage(string code, string message,
        string? replyTo = null, string? sid = null, string? command = null)
    {
        var p = new JsonObject { ["code"] = code, ["message"] = message };
        if (command is not null) p["command"] = command;
        return Serialize(Outgoing(BridgeProtocol.ServerMsg.Error, p, NewId(), replyTo, sid));
    }

    public static string CommandResult(string replyTo, bool ok, string command,
        JsonObject? statePatch = null, string? errCode = null, string? errMsg = null, string? sid = null)
    {
        var p = new JsonObject { ["ok"] = ok, ["command"] = command };
        if (statePatch is not null) p["statePatch"] = statePatch;
        if (!ok) p["error"] = new JsonObject { ["code"] = errCode ?? "INTERNAL_ERROR", ["message"] = errMsg ?? "failed" };
        return Serialize(Outgoing(BridgeProtocol.ClientMsg.CommandResult, p, NewId(), replyTo, sid));
    }
}
