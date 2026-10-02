# MacroDeckBridge — Vesktop / Vencord client plugin

This folder is a ready-to-drop **[Vencord userplugin](https://docs.vencord.dev/installing/custom-plugins/)**.
You do **not** copy it into Discord directly — Vencord plugins are compiled into
Vencord at build time, so the steps are:

```
1. Clone Vencord at the tag Vesktop currently ships (see repo README).
2. Copy this whole folder into   <vencord>/src/userplugins/MacroDeckBridge
3. pnpm install && pnpm build --standalone
4. Point Vesktop at the resulting build (vencords custom "Vencord Location").
```

`bridge/` is a copy of the protocol implementation from `../src/` adapted to run
inside Vencord. One file genuinely differs and it is marked in-source:

| File | Difference |
|---|---|
| `bridge/adapters/discovery.ts` | The standalone scaffold probed a `window.Vencord` global, which does not exist in Vencord. This copy imports the real `@webpack` API instead. |

`authorIcon.png` (256×256) is inlined into the bundle at build time via Vencord's
`file://` import and shown on the plugin's settings page.

Licensed GPL-3.0-or-later (see `../LICENSE`) to match Vencord, which is itself
GPL-3.0-or-later.
