# Store submission checklist (Macro Deck Store guidelines)

Status: repository is public, package identity is developer-scoped, manifest
validates at Publication level with 0 errors, artifact
`com.kickfireice.vesktop-bridge-1.0.0.macroDeckPlugin` packed from this source.
Remaining publisher steps before submitting: install the packed artifact over
the old copy, take screenshots, and submit via the Creator Portal
(AI assistance declared in the portal form).

Repository: https://github.com/kickfireice/vesktop-macrodeck-bridge (public, MIT).

## Identified (§5 — naming and branding)

- Repository: `https://github.com/kickfireice/vesktop-macrodeck-bridge` (public).
- Package ID `com.kickfireice.vesktop-bridge` — developer-scoped, no `MacroDeck`
  and no third-party company namespace.
- `publisher.name`: `kickfireice`; `license`: MIT; `repository`: URL above.

## Done

- [x] `manifest.json`: `publisher`, `license` (MIT), `repository`,
      `compatibility` (`macroDeck >=3.0.0-0`) — `validate --level Publication`
      passes with 0 errors.
- [x] `LICENSE` (MIT) at repo root; `license: MIT` in manifest matches.
- [x] Package ID is developer-scoped (`com.kickfireice.vesktop-bridge`).
  No `MacroDeck*` or third-party namespaces anywhere in code
  (`DeckBridge.Core` / `DeckBridge.Plugin` namespaces).
- [x] Display name "Vesktop Bridge" only describes the integration (allowed,
      cf. "Discord Integration"); description explicitly states no affiliation
      with Vesktop, Vencord, Discord, or Macro Deck.
- [x] Dependencies: NuGet-only (`MacroDeck.* 3.0.0-preview.10`, pinned). No
      precompiled third-party DLLs bundled. Core has zero external deps.
- [x] Privacy (§8): fully local — binds `127.0.0.1` only, token auth, no cloud,
      no telemetry, no external traffic. State this in the store listing.
- [x] **Functionality (§6) verified live 2026-10-04:** Toggle Mute / Deafen
  buttons drive Discord for real (Macro Deck 3 + Vesktop 1.6.6 /
  Vencord b52ed36). (Conformance `test` run showed passes but was stopped
  early — its checks toggle live mute/deafen.)
- [x] Icon rights (§3): publisher confirms `Assets/icon.png` is fine to
  redistribute.

## TODO (publisher — before submitting to the store)

1. **Reinstall (§1 — source must match the distributed plugin):** install
   `artifacts/com.kickfireice.vesktop-bridge-1.0.0.macroDeckPlugin` in Macro
   Deck over the old copy (the running install still uses a legacy id).
   The token in `%AppData%/DeckBridge/settings.json` is id-independent and
   survives the reinstall — no re-pairing needed. Then restart Macro Deck.
2. **Store listing (§10):** add real screenshots. Install/usage steps are in
   the root README (Setup + Verify sections); limitations documented there
   (companion Vesktop plugin + token pairing required, localhost-only, some
   Discord features report `unsupported` per Vesktop build).

## AI declaration (§9)

This project was developed with AI assistance (code written with AI agents;
see git history). There is currently no `ai` field in the manifest
schema/template — declare AI assistance in the Creator Portal submission form,
and keep this file as the in-repo record. The plugin itself uses no AI at
runtime and sends no data anywhere.

## Notes for review

- `Assets/icon.svg` ships unpacked in the source tree as a fallback; only
  `Assets/icon.png` (the manifest-declared icon) is packed. The
  `file-not-packaged` build warning refers to the unused fallback.
- `%AppData%/DeckBridge/settings.json` holds only the random local auth token
  and port — no user data, no credentials.
