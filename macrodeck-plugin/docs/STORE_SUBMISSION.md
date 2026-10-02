# Store submission checklist (Macro Deck Store guidelines)

Status: publisher identity + repository are now filled in. Remaining items are
screenshots and an end-to-end button test on a healthy install.

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
- [x] Package ID is developer-scoped (`com.example.vesktop-bridge` placeholder,
      must be replaced with your domain — see TODOs). No `MacroDeck*` or
      third-party namespaces anywhere in code (`DeckBridge.Core/Plugin`).
- [x] Display name "Vesktop Bridge" only describes the integration (allowed,
      cf. "Discord Integration"); description explicitly states no affiliation
      with Vesktop, Vencord, Discord, or Macro Deck.
- [x] Dependencies: NuGet-only (`MacroDeck.* 3.0.0-preview.10`, pinned). No
      precompiled third-party DLLs bundled. Core has zero external deps.
- [x] Privacy (§8): fully local — binds `127.0.0.1` only, token auth, no cloud,
      no telemetry, no external traffic. State this in the store listing.
- [x] Conformance suite: `macrodeck-plugin test` → Conformant: yes
      (31 pass, 0 fail).

## TODO (publisher)

1. **Create the public GitHub repo** and replace in `manifest.json`:
   - `id`: `com.example.vesktop-bridge` → your reverse-domain
     (e.g. `com.<yourhandle>.vesktop-bridge`)
   - `publisher.name`: `TODO: Your publisher name` → your name
   - `repository`: `https://github.com/TODO/vesktop-macrodeck-bridge` → real URL
   - `LICENSE`: `Copyright (c) 2026 TODO: Your Name` → your name
   - Search the repo for remaining `TODO` markers before submitting.
2. **Icon rights (§3):** confirm you own or may redistribute `Assets/icon.png`.
   If it is AI-generated, keep this note and declare it in the Creator Portal
   (§9). If it is third-party art, replace it with your own.
3. **AI declaration (§9):** this project was developed with AI assistance
   (code written with AI agents; see git history). There is currently no
   `ai` field in the manifest schema/template — declare AI assistance in the
   Creator Portal submission form, and keep this file as the in-repo record.
   The plugin itself uses no AI at runtime and sends no data anywhere.
4. **Functionality (§6):** verify a healthy install in Macro Deck 3 + one
   end-to-end button press (e.g. Toggle Mute) before submitting.
5. **Store listing (§10):** add real screenshots, install/usage steps, and
   document limitations: requires the companion Vesktop plugin (token pairing),
   localhost-only, some Discord features report `unsupported` depending on the
   Vesktop build.

## Notes for review

- `Assets/icon.svg` ships unpacked in the source tree as a fallback; only
  `Assets/icon.png` (the manifest-declared icon) is packed. The
  `file-not-packaged` build warning refers to the unused fallback.
- `%AppData%/DeckBridge/settings.json` holds only the random local auth token
  and port — no user data, no credentials.
