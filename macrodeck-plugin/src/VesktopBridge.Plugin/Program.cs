// Program.cs — plugin entrypoint. The hosting SDK owns the Macro Deck plugin
// protocol, sessions, reconnection, and dispatch. Our localhost WebSocket
// server (Core/BridgeServer) runs INSIDE this process on 127.0.0.1 and is
// started/stopped with the integration lifecycle (NOT on a reserved
// /_macrodeck/* route — plain loopback listener, see docs/WS_SERVER_DESIGN.md).
using MacroDeck.Plugin.Hosting;
using MacroDeck.Plugin.Serilog;
using Microsoft.Extensions.DependencyInjection;
using DeckBridge.Plugin;

var builder = MacroDeckPlugin.CreatePlugin(args)
    .UseMacroDeckLogging();

builder.Services.AddSingleton<BridgeService>();
builder.RegisterIntegration<DeckBridgeIntegration>(
    sp => new DeckBridgeIntegration(sp.GetRequiredService<BridgeService>()));

var plugin = builder.Build();
await plugin.RunAsync();
