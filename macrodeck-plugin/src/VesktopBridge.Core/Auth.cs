// Auth.cs — §2/§3: ≥256-bit token, validation, auth rate-limit, sessions.
using System.Security.Cryptography;

namespace DeckBridge.Core;

public sealed class AuthManager
{
    private string _token;
    private readonly object _gate = new();
    private readonly Queue<DateTimeOffset> _failures = new();
    private DateTimeOffset _blockedUntil = DateTimeOffset.MinValue;

    public AuthManager(string? existing = null)
    {
        _token = string.IsNullOrEmpty(existing) ? GenerateToken() : existing;
    }

    /// ≥256-bit: 32 random bytes → base64url (43+ chars, no padding).
    public static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public bool CheckRateLimit()
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            if (now < _blockedUntil) return false;
            while (_failures.Count > 0 && (now - _failures.Peek()).TotalSeconds > BridgeProtocol.AuthFailWindowSec)
                _failures.Dequeue();
            return true;
        }
    }

    public bool ValidateHelloToken(string? presented)
    {
        string current;
        lock (_gate) current = _token;
        // constant-time compare to avoid timing oracle (localhost, cheap to do right)
        var a = System.Text.Encoding.UTF8.GetBytes(current);
        var b = System.Text.Encoding.UTF8.GetBytes(presented ?? "");
        var ok = a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
        lock (_gate)
        {
            if (ok) return true;
            _failures.Enqueue(DateTimeOffset.UtcNow);
            while (_failures.Count > 0 && (DateTimeOffset.UtcNow - _failures.Peek()).TotalSeconds > BridgeProtocol.AuthFailWindowSec)
                _failures.Dequeue();
            if (_failures.Count >= BridgeProtocol.AuthFailMax && _blockedUntil < DateTimeOffset.UtcNow)
            {
                _blockedUntil = DateTimeOffset.UtcNow.AddSeconds(BridgeProtocol.AuthBlockSec);
                BridgeLog.Warn("auth rate-limit engaged (5 fails/60s → 60s block)");
            }
            return false;
        }
    }

    public bool IsBlocked
    {
        get { lock (_gate) return DateTimeOffset.UtcNow < _blockedUntil; }
    }

    /// Regeneration invalidates all sessions immediately (§2.1).
    public string Regenerate()
    {
        lock (_gate) { _token = GenerateToken(); _failures.Clear(); _blockedUntil = DateTimeOffset.MinValue; return _token; }
    }

    // Token is exposed ONLY to settings UI (Show/Copy). NEVER log it.
    public string RevealForSettingsUI() { lock (_gate) return _token; }
}

public sealed record ClientSession(
    string Sid, string ClientName, string ClientVersion,
    DateTimeOffset ConnectedAt, DateTimeOffset LastSeen,
    Dictionary<string, bool> Capabilities);

public sealed class SessionManager
{
    private readonly object _gate = new();
    private ClientSession? _active;
    public bool AllowReplacement { get; set; }

    public bool HasActive { get { lock (_gate) return _active is not null; } }
    public ClientSession? Active { get { lock (_gate) return _active; } }

    public (bool accepted, ClientSession? evicted, ClientSession created) TryAccept(
        string name, string version, Dictionary<string, bool> caps)
    {
        lock (_gate)
        {
            var created = new ClientSession(Guid.NewGuid().ToString("N"), name, version,
                DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, caps);
            if (_active is null) { _active = created; return (true, null, created); }
            if (!AllowReplacement) return (false, null, created);
            var old = _active;
            _active = created;
            return (true, old, created);
        }
    }

    public bool ValidateSid(string? sid)
    {
        lock (_gate) return _active is not null && _active.Sid == sid;
    }

    public void Touch()
    {
        lock (_gate)
            if (_active is not null)
                _active = _active with { LastSeen = DateTimeOffset.UtcNow };
    }

    public ClientSession? Revoke()
    {
        lock (_gate) { var old = _active; _active = null; return old; }
    }

    public bool RevokeSid(string sid)
    {
        lock (_gate)
        {
            if (_active?.Sid == sid) { _active = null; return true; }
            return false;
        }
    }
}

/// Sliding-window per-connection rate limiter: 20 msg/s sustained, burst 50 (§11).
public sealed class MessageRateLimiter
{
    private readonly object _gate = new();
    private double _tokens = BridgeProtocol.BurstLimit;
    private long _lastMs = EnvelopeCodec.NowMs();

    public bool TryTake()
    {
        lock (_gate)
        {
            var now = EnvelopeCodec.NowMs();
            _tokens = Math.Min(BridgeProtocol.BurstLimit,
                _tokens + (now - _lastMs) / 1000.0 * BridgeProtocol.SustainedMsgPerSec);
            _lastMs = now;
            if (_tokens < 1.0) return false;
            _tokens -= 1.0;
            return true;
        }
    }
}

/// Pending outbound commands: id → TaskCompletionSource, queue max 32 (§11),
/// timeout 3 s (10 s voice). Thread-safe, never blocks UI (async only).
public sealed class PendingCommandStore : IDisposable
{
    private readonly object _gate = new();
    private readonly Dictionary<string, TaskCompletionSource<string>> _pending = new();
    private bool _disposed;

    public bool TryAdd(string id, TaskCompletionSource<string> tcs)
    {
        lock (_gate)
        {
            if (_pending.Count >= BridgeProtocol.PendingQueueMax) return false;
            _pending[id] = tcs;
            return true;
        }
    }

    public bool TryComplete(string replyTo, string rawResult)
    {
        TaskCompletionSource<string>? tcs;
        lock (_gate)
        {
            if (!_pending.TryGetValue(replyTo, out tcs)) return false; // late/duplicate → ignore
            _pending.Remove(replyTo);
        }
        tcs.TrySetResult(rawResult);
        return true;
    }

    public void Fail(string id, string code)
    {
        TaskCompletionSource<string>? tcs;
        lock (_gate)
        {
            if (!_pending.TryGetValue(id, out tcs)) return;
            _pending.Remove(id);
        }
        tcs.TrySetException(new BridgeCommandException(code, $"{code} for command {BridgeLog.Trunc(id)}"));
    }

    public void FailAll(string code)
    {
        List<TaskCompletionSource<string>> all;
        lock (_gate) { all = [.. _pending.Values]; _pending.Clear(); }
        foreach (var t in all) t.TrySetException(new BridgeCommandException(code, code));
    }

    public int Count { get { lock (_gate) return _pending.Count; } }
    public void Dispose() { if (!_disposed) { _disposed = true; FailAll(BridgeProtocol.Errors.InternalError); } }
}

public sealed class BridgeCommandException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
