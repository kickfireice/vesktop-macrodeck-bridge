// StateCache.cs — §7 state model + §9 patch/seq handling, last-known retention.
using System.Text.Json.Nodes;

namespace DeckBridge.Core;

public sealed class CapabilityStore
{
    private readonly object _gate = new();
    private Dictionary<string, bool> _available = new();
    private Dictionary<string, string> _reasons = new();

    public void Update(Dictionary<string, bool> available, Dictionary<string, string>? reasons)
    {
        lock (_gate)
        {
            _available = new(available, StringComparer.Ordinal);
            _reasons = reasons is null ? new() : new(reasons, StringComparer.Ordinal);
        }
    }

    public bool IsAvailable(string flag)
    {
        lock (_gate) return _available.TryGetValue(flag, out var v) && v;
    }

    public IReadOnlyDictionary<string, bool> Available
    { get { lock (_gate) return new Dictionary<string, bool>(_available); } }

    public IReadOnlyDictionary<string, string> Reasons
    { get { lock (_gate) return new Dictionary<string, string>(_reasons); } }
}

/// In-memory Discord state cache (§7). Updated on state_snapshot (full replace),
/// state_update (patch + seq ordering), command_result statePatch. Offline →
/// mark disconnected but KEEP last-known non-live (§9.2/§11). Thread-safe.
/// All values stored as JsonNode so unknown/additive minor-version fields survive.
public sealed class BridgeStateCache
{
    private readonly object _gate = new();
    private JsonObject _state = InitialState();
    private int _lastSeq;
    private bool _live;

    public event Action<IReadOnlyList<string>>? Changed; // changed field names → UI refresh

    public static JsonObject InitialState() => new()
    {
        ["pluginConnected"] = false, ["authenticated"] = false, ["discordReady"] = false,
        ["bridgeRunning"] = true, ["lastError"] = null,
        ["protocolVersion"] = BridgeProtocol.Version, ["vesktopPluginVersion"] = null,
        ["readOnly"] = false,
        ["selfMuted"] = null, ["selfDeafened"] = null,
        ["serverMuted"] = null, ["serverDeafened"] = null,
        ["voiceConnected"] = false, ["voiceConnecting"] = false,
        ["voiceChannelId"] = null, ["voiceChannelName"] = null, ["voiceChannelPath"] = null,
        ["voiceGuildId"] = null, ["voiceGuildName"] = null,
        ["lastVoiceChannelId"] = null, ["lastVoiceChannelName"] = null,
        ["selectedTextChannelId"] = null, ["selectedTextChannelName"] = null,
        ["selectedTextChannelPath"] = null, ["selectedGuildId"] = null, ["selectedGuildName"] = null,
        ["userStatus"] = "unknown", ["customStatusText"] = null, ["customStatusEmojiName"] = null,
        ["inputVolume"] = null, ["outputVolume"] = null,
        ["inputDeviceId"] = null, ["inputDeviceName"] = null,
        ["outputDeviceId"] = null, ["outputDeviceName"] = null,
        ["noiseSuppressionEnabled"] = null, ["echoCancellationEnabled"] = null,
        ["automaticGainEnabled"] = null, ["qosHighPriorityEnabled"] = null,
        ["lowLatencyEnabled"] = null, ["speakerMuted"] = null,
        ["attenuationVolume"] = null, ["attenuationWhileSpeakingEnabled"] = null,
        ["stageHandRaised"] = null, ["stageSpeakRequested"] = null,
        ["stageIsSpeaker"] = null, ["stageChannelActive"] = false,
        ["availableCapabilities"] = new JsonObject(), ["unavailableReasons"] = new JsonObject(),
    };

    public bool IsLive { get { lock (_gate) return _live; } }

    public void ApplySnapshot(JsonObject full)
    {
        List<string> changed;
        lock (_gate)
        {
            changed = DiffKeys(_state, full);
            _state = (JsonObject)full.DeepClone();
            _state["pluginConnected"] = true;
            _state["authenticated"] = true;
            _lastSeq = 0;
            _live = true;
        }
        BridgeDiagnostics.Snapshot();
        Notify(changed);
    }

    /// Returns false if out-of-order (ignored + debug log per §9.1).
    public bool ApplyPatch(JsonObject patch, int seq)
    {
        List<string> changed;
        lock (_gate)
        {
            if (seq <= _lastSeq)
            {
                BridgeLog.Debug($"out-of-order state_update seq={seq} (last={_lastSeq}), ignored");
                return false;
            }
            _lastSeq = seq;
            changed = [.. patch.Select(kv => kv.Key)];
            foreach (var (k, v) in patch) _state[k] = v?.DeepClone();
            _live = true;
        }
        Notify(changed);
        return true;
    }

    public void ApplyStatePatch(JsonObject? patch)
    {
        if (patch is null) return;
        List<string> changed;
        lock (_gate)
        {
            changed = [.. patch.Select(kv => kv.Key)];
            foreach (var (k, v) in patch) _state[k] = v?.DeepClone();
        }
        Notify(changed);
    }

    public void MarkDisconnected(string? lastError = null)
    {
        List<string> changed;
        lock (_gate)
        {
            _live = false;
            changed = ["pluginConnected", "authenticated", "discordReady"];
            _state["pluginConnected"] = false;
            _state["authenticated"] = false;
            _state["discordReady"] = false;
            // keep last-known non-live values (§9.2); only liveness flags flip.
            if (lastError is not null) { _state["lastError"] = lastError; changed.Add("lastError"); }
        }
        Notify(changed);
    }

    public void SetLastError(string? code)
    {
        lock (_gate) _state["lastError"] = code;
        Notify(["lastError"]);
    }

    public JsonObject Snapshot()
    {
        lock (_gate) return (JsonObject)_state.DeepClone();
    }

    public JsonNode? Get(string field)
    {
        lock (_gate) return _state[field]?.DeepClone();
    }

    public T GetValue<T>(string field, T fallback)
    {
        try
        {
            lock (_gate)
            {
                var n = _state[field];
                if (n is null) return fallback;
                return n.GetValue<T>();
            }
        }
        catch { return fallback; }
    }

    private static List<string> DiffKeys(JsonObject old, JsonObject @new)
    {
        var changed = new List<string>();
        foreach (var (k, v) in @new)
            if (!JsonNode.DeepEquals(old[k], v)) changed.Add(k);
        foreach (var (k, _) in old)
            if (!@new.ContainsKey(k)) changed.Add(k);
        return changed;
    }

    private void Notify(List<string> changed)
    {
        try { Changed?.Invoke(changed); } catch { /* never crash host */ }
    }
}

public sealed record DeviceInfo(string Id, string Name, string Kind, bool IsDefault);
public sealed record ChannelNode(string Id, string Name, string Type, string Path, string? ParentId);
public sealed record GuildInfo(string Id, string Name, List<ChannelNode> Channels);

/// Channel/device caches (§7 types + §11 lists). Prefer IDs internally, names
/// for display. Ambiguous name → AMBIGUOUS with candidates (max 10), never guess.
public sealed class ChannelDeviceCache
{
    private readonly object _gate = new();
    private List<GuildInfo> _guilds = [];
    private List<DeviceInfo> _inputs = [];
    private List<DeviceInfo> _outputs = [];
    private int _lastChannelSeq;

    public event Action? ListsChanged;

    public void UpdateChannels(List<GuildInfo> guilds, int seq)
    {
        lock (_gate)
        {
            // seq is per-connection (§9.1); equal seq = duplicate push, accept
            // idempotently. ResetSequences() is called on every new session.
            if (seq < _lastChannelSeq)
            {
                BridgeLog.Debug($"out-of-order channel_list seq={seq} ignored");
                return;
            }
            _lastChannelSeq = seq;
            _guilds = guilds;
        }
        BridgeDiagnostics.ChannelList(guilds.SelectMany(g => g.Channels).Count());
        Notify();
    }

    /// Called when a new session authenticates (seq restarts per connection).
    public void ResetSequences()
    {
        lock (_gate) _lastChannelSeq = 0;
    }

    public void UpdateDevices(List<DeviceInfo> inputs, List<DeviceInfo> outputs)
    {
        lock (_gate) { _inputs = inputs; _outputs = outputs; }
        BridgeDiagnostics.DeviceList(inputs.Count + outputs.Count);
        Notify();
    }

    public IReadOnlyList<GuildInfo> Guilds { get { lock (_gate) return [.. _guilds]; } }
    public IReadOnlyList<DeviceInfo> Inputs { get { lock (_gate) return [.. _inputs]; } }
    public IReadOnlyList<DeviceInfo> Outputs { get { lock (_gate) return [.. _outputs]; } }

    public (ChannelNode? node, List<ChannelNode>? candidates) ResolveVoice(string? id, string? name, string? path, string? guildName)
    {
        lock (_gate)
        {
            var voices = _guilds
                .Where(g => guildName is null || g.Name.Equals(guildName, StringComparison.OrdinalIgnoreCase))
                .SelectMany(g => g.Channels, (g, c) => (g, c))
                .Where(t => t.c.Type is "voice" or "stage").ToList();
            if (id is not null)
                return (voices.Select(t => t.c).FirstOrDefault(c => c.Id == id), null);
            List<ChannelNode> matches = path is not null
                ? voices.Select(t => t.c).Where(c => c.Path.Equals(path, StringComparison.OrdinalIgnoreCase)).ToList()
                : voices.Select(t => t.c).Where(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            return matches.Count == 1 ? (matches[0], null) : (null, matches.Count == 0 ? null : matches.Take(10).ToList());
        }
    }

    public (ChannelNode? node, List<ChannelNode>? candidates) ResolveText(string? id, string? name, string? path, string? guildName)
    {
        lock (_gate)
        {
            var texts = _guilds
                .Where(g => guildName is null || g.Name.Equals(guildName, StringComparison.OrdinalIgnoreCase))
                .SelectMany(g => g.Channels, (g, c) => (g, c))
                .Where(t => t.c.Type == "text").ToList();
            if (id is not null)
                return (texts.Select(t => t.c).FirstOrDefault(c => c.Id == id), null);
            List<ChannelNode> matches = path is not null
                ? texts.Select(t => t.c).Where(c => c.Path.Equals(path, StringComparison.OrdinalIgnoreCase)).ToList()
                : texts.Select(t => t.c).Where(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            return matches.Count == 1 ? (matches[0], null) : (null, matches.Count == 0 ? null : matches.Take(10).ToList());
        }
    }

    private void Notify()
    {
        try { ListsChanged?.Invoke(); } catch { /* never crash host */ }
    }

    // Parse helpers for inbound list payloads (tolerant: missing → empty).
    public static List<GuildInfo> ParseGuilds(JsonObject payload) => [];
    public static (List<DeviceInfo> inputs, List<DeviceInfo> outputs) ParseDevices(JsonObject payload) =>
        ([], []);
}
