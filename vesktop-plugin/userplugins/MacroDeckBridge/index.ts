/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 kickfireice
 *
 * MacroDeckBridge - Vesktop/Vencord client plugin for the Macro Deck bridge.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { definePluginSettings } from "@api/Settings";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";
import authorIconBase64 from "file://authorIcon.png?base64";

import {
    getRuntimeStatus,
    start as startBridge,
    stop as stopBridge,
    updateSettings as updateBridgeSettings,
} from "./bridge";

/**
 * Author avatar, inlined into the bundle at build time.
 * Vencord's `file://` imports read the file sitting next to this module and,
 * with `?base64`, hand back the raw base64 payload — so the data URI is built
 * here. (`declare module "file://*"` in src/modules.d.ts types it as string.)
 */
const AUTHOR_ICON = `data:image/png;base64,${authorIconBase64}`;

/**
 * MacroDeckBridge — Vesktop/Vencord client side of the Macro Deck bridge.
 *
 * Local-only (`127.0.0.1`) WebSocket client implementing protocol v1.0.0:
 * connects, authenticates with a token, executes commands against Discord's
 * internal stores/actions (never UI clicking) and pushes live state updates.
 *
 * The protocol/bridge implementation lives in `./bridge` (a copy of the
 * standalone `vesktop-plugin/src` sources); this file only adapts it to the
 * Vencord plugin + settings lifecycle.
 */

const settings = definePluginSettings({
    enable: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Auto-connect to the Macro Deck bridge while this plugin is enabled",
        onChange: () => syncSettings(),
    },
    host: {
        type: OptionType.STRING,
        default: "127.0.0.1",
        description: "Bridge host. v1 is localhost-only; other values fall back to 127.0.0.1",
        onChange: () => syncSettings(),
    },
    port: {
        type: OptionType.NUMBER,
        default: 8323,
        description: "Bridge port. Must match the actual port shown in the Macro Deck plugin settings",
        onChange: () => syncSettings(),
    },
    token: {
        type: OptionType.STRING,
        default: "",
        description: "Bridge token from the Macro Deck plugin settings. Stored locally and never logged",
        onChange: () => syncSettings(),
    },
    readOnly: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Read-only: report state but reject all mutating commands",
        onChange: () => syncSettings(),
    },
    debugLogging: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Verbose debug logging (secrets are still never logged)",
        onChange: () => syncSettings(),
    },
    reconnectBaseMs: {
        type: OptionType.NUMBER,
        default: 1000,
        description: "Informational reconnect base delay in ms (the ladder is fixed: 1s → 2s → 5s → 10s → 30s)",
        onChange: () => syncSettings(),
    },
});

/** Push the current Vencord settings into the bridge module, which owns the socket. */
function syncSettings() {
    const s = settings.store;
    updateBridgeSettings({
        enable: s.enable,
        host: s.host,
        port: s.port,
        token: s.token,
        readOnly: s.readOnly,
        debugLogging: s.debugLogging,
        reconnectBaseMs: s.reconnectBaseMs,
    });
}

/** Author card + live bridge status, shown at the top of the plugin's settings page. */
function BridgeAbout() {
    const {
        connected, authenticated, discordReady, sessionShort,
        lastError, capabilitiesTrue, capabilitiesFalse,
    } = getRuntimeStatus();

    return React.createElement(
        "div",
        null,
        React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" } },
            React.createElement("img", {
                src: AUTHOR_ICON,
                alt: "kickfireice",
                width: 56,
                height: 56,
                style: { borderRadius: "50%", objectFit: "cover", flexShrink: 0 }
            }),
            React.createElement(
                "div",
                null,
                React.createElement(Heading, { tag: "h3", style: { margin: 0 } }, "MacroDeckBridge"),
                React.createElement(Paragraph, null, "by kickfireice")
            )
        ),
        React.createElement(
            Paragraph,
            null,
            `Connected: ${connected} • Authenticated: ${authenticated} • Discord ready: ${discordReady} • Session: ${sessionShort ?? "—"}`
        ),
        React.createElement(Paragraph, null, `Last error: ${lastError ?? "none"}`),
        React.createElement(
            Paragraph,
            null,
            `Capabilities: ${capabilitiesTrue.length} available, ${capabilitiesFalse.length} unavailable`
        ),
        React.createElement(Paragraph, null, "Values are read when this settings page is opened.")
    );
}

export default definePlugin({
    name: "MacroDeckBridge",
    description: "Control Discord from a Macro Deck: connects to the local Macro Deck bridge (127.0.0.1, token auth, protocol v1.0.0) so deck buttons can mute, deafen, join/leave voice, set volumes and pick devices, with live state pushed back to the deck.",
    tags: ["Utility", "Voice"],
    searchTerms: ["Macro Deck", "macrodeck", "deck", "bridge", "stream deck"],
    authors: [{ name: "kickfireice", id: 0n }],
    settings,
    settingsAboutComponent: BridgeAbout,
    start() {
        syncSettings();
        startBridge();
    },
    stop() {
        stopBridge();
    },
});
