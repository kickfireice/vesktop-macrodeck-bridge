// PluginSettings.cs — settings definitions (deliverable #6).
// Persisted as JSON under %AppData%/DeckBridge/ (OS user permissions only).
// Token handled per PROTOCOL §2.1: shown behind Show toggle, copyable,
// regeneratable, NEVER logged.
using System.Text.Json;

namespace DeckBridge.Plugin;

public sealed class PluginSettings
{
    public int ConfiguredPort { get; set; } = Core.BridgeProtocol.DefaultPort;
    public string AuthToken { get; set; } = "";
    public bool ReadOnly { get; set; }
    public bool AllowReplacement { get; set; } // default false (§3)
    public string LogLevel { get; set; } = "info"; // info | debug

    public static string SettingsPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "DeckBridge", "settings.json");

    public static PluginSettings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var json = File.ReadAllText(SettingsPath);
                var s = JsonSerializer.Deserialize<PluginSettings>(json);
                if (s is not null)
                {
                    if (s.ConfiguredPort is < 1 or > 65535)
                        s.ConfiguredPort = Core.BridgeProtocol.DefaultPort;
                    return s;
                }
            }
        }
        catch { /* corrupt file → fresh defaults, never crash host */ }
        return new PluginSettings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            File.WriteAllText(SettingsPath,
                JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            Core.BridgeLog.Warn($"settings save failed: {ex.GetType().Name}");
        }
    }
}
