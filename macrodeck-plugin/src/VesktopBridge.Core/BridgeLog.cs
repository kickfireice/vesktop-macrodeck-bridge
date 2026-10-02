// BridgeLog.cs — §12/§13 sanitized logging. Default info, opt-in debug.
// FORBIDDEN always: token, full sid, Discord tokens/cookies/credentials,
// message/DM content, full channel/device/user dumps.
namespace DeckBridge.Core;

public enum BridgeLogLevel { Debug = 0, Info = 1, Warn = 2, Error = 3 }

public static class BridgeLog
{
    private static BridgeLogLevel _level = BridgeLogLevel.Info;
    private static readonly object _gate = new();
    private static string _lastMsg = "";
    private static int _repeatCount;

    public static BridgeLogLevel Level { get => _level; set => _level = value; }
    public static event Action<string>? OnLine;

    public static void Debug(string msg) => Emit(BridgeLogLevel.Debug, msg);
    public static void Info(string msg) => Emit(BridgeLogLevel.Info, msg);
    public static void Warn(string msg) => Emit(BridgeLogLevel.Warn, msg);
    public static void Error(string msg) => Emit(BridgeLogLevel.Error, msg);

    /// Log a state transition once at info; repeats coalesced (one info line
    /// per transition, rest debug) per §9.2/§13.
    public static void Transition(string msg) => Emit(BridgeLogLevel.Info, msg, coalesce: true);

    private static void Emit(BridgeLogLevel lvl, string msg, bool coalesce = false)
    {
        if (lvl < _level) return;
        lock (_gate)
        {
            if (coalesce && msg == _lastMsg) { _repeatCount++; return; } // swallow repeats
            if (_repeatCount > 0) { _repeatCount = 0; }
            _lastMsg = msg;
            var line = $"[{DateTimeOffset.UtcNow:HH:mm:ss}][{lvl}] {msg}";
            try { OnLine?.Invoke(line); } catch { /* never crash host */ }
            Console.WriteLine(line);
        }
    }

    // --- sanitizers: use everywhere before logging ---
    public static string Sid8(string? sid) =>
        string.IsNullOrEmpty(sid) ? "(none)" : sid.Length <= 8 ? sid + "…" : sid[..8] + "…";
    public static string Trunc(string? s, int max = 80) =>
        string.IsNullOrEmpty(s) ? "" : s.Length <= max ? s : s[..max] + "…";
}
