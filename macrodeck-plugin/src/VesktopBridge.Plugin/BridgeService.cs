// BridgeService.cs — owns the bridge lifetime: settings → auth → server →
// dispatcher. Started in InitializeAsync, stopped in ShutdownAsync (clean
// start/stop with plugin, §11). All WS/IO async, never blocks UI thread.
using DeckBridge.Core;

namespace DeckBridge.Plugin;

public sealed class BridgeService : IDisposable
{
    private readonly object _gate = new();
    // NOTE: no I/O in constructor — the host reads Actions before
    // InitializeAsync, so construction must be side-effect free.
    // Settings are loaded in StartAsync.
    private PluginSettings _settings = new();
    private AuthManager? _auth;
    private BridgeServer? _server;
    private CommandDispatcher? _dispatcher;
    private bool _disposed;

    public event Action? StateChanged; // → variables/states refresh (host polls)

    public PluginSettings Settings
    {
        get { lock (_gate) return _settings; }
    }

    public bool IsRunning => _server?.Running == true;
    public int ActualPort => _server?.ActualPort ?? _settings.ConfiguredPort;
    public BridgeServer? Server => _server;
    public CommandDispatcher? Dispatcher => _dispatcher;

    public async Task StartAsync()
    {
        BridgeServer? server;
        lock (_gate)
        {
            if (_server?.Running == true) return;
            _settings = PluginSettings.Load();
            if (string.IsNullOrEmpty(_settings.AuthToken))
            {
                _settings.AuthToken = AuthManager.GenerateToken();
                _settings.Save();
                // Token value NEVER logged — only that one was generated.
                BridgeLog.Info("generated new local auth token (see settings to copy)");
            }
            BridgeLog.Level = _settings.LogLevel == "debug" ? BridgeLogLevel.Debug : BridgeLogLevel.Info;
            _auth = new AuthManager(_settings.AuthToken);
            var opts = new BridgeServerOptions
            {
                ConfiguredPort = _settings.ConfiguredPort,
                AllowReplacement = _settings.AllowReplacement,
                ReadOnly = _settings.ReadOnly,
            };
            _server = server = new BridgeServer(opts, _auth);
            server.State.Changed += _ => { try { StateChanged?.Invoke(); } catch { } };
            server.StatusChanged += _ => { try { StateChanged?.Invoke(); } catch { } };
            _dispatcher = new CommandDispatcher(server);
        }
        await server.StartAsync();
    }

    public async Task StopAsync()
    {
        BridgeServer? server;
        lock (_gate) server = _server;
        if (server is not null) await server.StopAsync();
    }

    // --- settings mutations (called from config-flow seam / actions) ---
    public void SetPorts(int port)
    {
        lock (_gate)
        {
            _settings.ConfiguredPort = port;
            _settings.Save();
        }
    }

    public void SetFlags(bool readOnly, bool allowReplacement, string logLevel)
    {
        lock (_gate)
        {
            _settings.ReadOnly = readOnly;
            _settings.AllowReplacement = allowReplacement;
            _settings.LogLevel = logLevel;
            _settings.Save();
            if (_server is not null)
            {
                _server.ReadOnly = readOnly;
                _server.AllowReplacement = allowReplacement;
                _server.State.ApplyStatePatch(new System.Text.Json.Nodes.JsonObject
                    { ["readOnly"] = readOnly });
            }
            BridgeLog.Level = logLevel == "debug" ? BridgeLogLevel.Debug : BridgeLogLevel.Info;
        }
    }

    /// Regenerate token: invalidates all sessions immediately (§2.1).
    public async Task RegenerateTokenAsync()
    {
        string next;
        BridgeServer? server;
        lock (_gate)
        {
            next = AuthManager.GenerateToken();
            _settings.AuthToken = next;
            _settings.Save();
            server = _server;
        }
        if (server is not null)
        {
            // Simplest correct invalidation: restart listener session state.
            await server.StopAsync();
            await StartAsync();
        }
        BridgeLog.Info("auth token regenerated; all sessions invalidated");
    }

    public string StatusSummary()
    {
        var s = _server;
        if (s is null || !s.Running) return "Bridge stopped.";
        var st = s.State;
        var c = s.ActiveClient;
        var capsOff = string.Join(",", s.Capabilities.Available
            .Where(kv => !kv.Value).Select(kv => kv.Key).OrderBy(k => k));
        var queue = _dispatcher?.PendingCount ?? -1;
        return $"Bridge running on 127.0.0.1:{s.ActualPort} | " +
               $"client={(c is null ? "none" : c.ClientName + " " + c.ClientVersion)} | " +
               $"discordReady={st.GetValue("discordReady", false)} | " +
               $"readOnly={st.GetValue("readOnly", false)} | " +
               $"proto={BridgeProtocol.Version} | " +
               $"capsOff=[{capsOff}] | " +
               $"diag=[{BridgeDiagnostics.Summary()} queue={queue}]";
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { StopAsync().GetAwaiter().GetResult(); } catch { }
        _server?.Dispose();
    }
}
