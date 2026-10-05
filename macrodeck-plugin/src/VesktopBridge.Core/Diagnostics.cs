// Diagnostics.cs — lightweight in-memory counters for field debugging.
// Surfaced via BridgeService.StatusSummary (shown by the "Show Bridge Status"
// action), because the bridge's own logs go to the host console which users
// never see. All writes are lock-free; values are best-effort.
namespace DeckBridge.Core;

public static class BridgeDiagnostics
{
    private static long _variableReads;
    private static long _optionsRequests;
    private static string _lastVariableId = "-";
    private static string _lastOptionsParam = "-";
    private static string _lastSnapshotAt = "-";
    private static string _lastChannelListAt = "-";
    private static int _lastChannelCount;
    private static string _lastDeviceListAt = "-";
    private static int _lastDeviceCount;
    private static string _sessionSince = "-";

    public static void VariableRead(string id)
    {
        Interlocked.Increment(ref _variableReads);
        Interlocked.Exchange(ref _lastVariableId, BridgeLog.Trunc(id, 60));
    }

    public static void OptionsRequest(string param)
    {
        Interlocked.Increment(ref _optionsRequests);
        Interlocked.Exchange(ref _lastOptionsParam, BridgeLog.Trunc(param, 60));
    }

    public static void Snapshot() =>
        Interlocked.Exchange(ref _lastSnapshotAt, DateTimeOffset.UtcNow.ToLocalTime().ToString("HH:mm:ss"));

    public static void ChannelList(int channels)
    {
        Interlocked.Exchange(ref _lastChannelListAt, DateTimeOffset.UtcNow.ToLocalTime().ToString("HH:mm:ss"));
        Interlocked.Exchange(ref _lastChannelCount, channels);
    }

    public static void DeviceList(int devices)
    {
        Interlocked.Exchange(ref _lastDeviceListAt, DateTimeOffset.UtcNow.ToLocalTime().ToString("HH:mm:ss"));
        Interlocked.Exchange(ref _lastDeviceCount, devices);
    }

    public static void SessionStart() =>
        Interlocked.Exchange(ref _sessionSince, DateTimeOffset.UtcNow.ToLocalTime().ToString("HH:mm:ss"));

    private static readonly object _eventGate = new();
    private static readonly Queue<string> _events = new();
    private static string _lastCommand = "-";

    private static string Stamp() => DateTimeOffset.UtcNow.ToLocalTime().ToString("HH:mm:ss");

    /// Recent bridge events (connects, drops + reasons, command outcomes).
    /// Ring buffer, last 8 — surfaced in StatusSummary for field debugging.
    public static void Event(string what)
    {
        lock (_eventGate)
        {
            _events.Enqueue($"{Stamp()} {what}");
            while (_events.Count > 8) _events.Dequeue();
        }
    }

    public static void Command(string name, bool ok, string? code, bool connected)
    {
        Interlocked.Exchange(ref _lastCommand, $"{name} {(ok ? "OK" : "FAIL/" + code)} conn={connected}@{Stamp()}");
    }

    public static string Summary()
    {
        string evts;
        lock (_eventGate) evts = string.Join(" | ", _events);
        return
            $"vars={Interlocked.Read(ref _variableReads)}(last:{_lastVariableId}) " +
            $"opts={Interlocked.Read(ref _optionsRequests)}(last:{_lastOptionsParam}) " +
            $"snap={_lastSnapshotAt} chans={_lastChannelCount}@{_lastChannelListAt} " +
            $"devs={_lastDeviceCount}@{_lastDeviceListAt} sess={_sessionSince} " +
            $"lastcmd=[{_lastCommand}] events=[{evts}]";
    }
}
