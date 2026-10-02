/**
 * adapters/discovery.ts — Safe webpack-module discovery.
 *
 * RULES: cache every find; warn once per missing module; never throw; never
 * tight-loop a scan. All adapters use `tryFind()` / `cached()` helpers here.
 */
import { log } from "../logger";

type Finder = {
  findByProps?: (...props: string[]) => any;
  findByCode?: (...codes: string[]) => any;
  findStore?: (name: string) => any;
};

let webpackApi: Finder | null = null;
let webpackApiWarned = false;
const cache = new Map<string, any>();
const warnedMissing = new Set<string>();

/** Resolve Vencord/Vesktop webpack helpers if present (works across versions). */
export function getWebpack(): Finder | null {
  if (webpackApi) return webpackApi;
  try {
    const w: any = (window as any)?.webpackChunkdiscord_app
      ?? (window as any)?.Vencord?.Webpack
      ?? (window as any)?.Vesktop?.Webpack;
    // Vencord exposes `Vencord.Webpack.findByProps` etc. via `require("...")` internally.
    // We probe the two most common globals non-fatally.
    const cand: any =
      (window as any)?.Vencord?.Webpack ??
      (window as any)?.Vesktop?.Webpack ??
      null;
    if (cand && (cand.findByProps || cand.findStore)) {
      webpackApi = cand as Finder;
      return webpackApi;
    }
    // Fallback: try the classic `Webpack.findByProps` lazy chunk scan is NOT
    // attempted here (too version-fragile + CPU heavy). Adapters degrade to
    // unsupported instead — honest capability reporting per §8/§11.
    void w;
  } catch (e) {
    log.debug("discovery", "webpack probe failed (non-fatal)");
  }
  if (!webpackApiWarned) {
    webpackApiWarned = true;
    log.warn("discovery", "Vencord webpack API not found; all Discord-control adapters report unsupported until confirmed");
  }
  return null;
}

/**
 * Try a list of prop-sets; return first module that has ALL props in the set.
 * Example: tryFind("MediaEngineStore", ["isSelfMuted", "toggleSelfMute"], ["isMute", "toggleMute"])
 */
export function tryFind(debugName: string, ...propSets: string[][]): any | null {
  const key = `props:${debugName}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const wp = getWebpack();
  if (!wp?.findByProps) { markMissing(debugName); cache.set(key, null); return null; }
  for (const props of propSets) {
    try {
      const mod = wp.findByProps(...props);
      if (mod) { cache.set(key, mod); return mod; }
    } catch { /* try next candidate set */ }
  }
  markMissing(debugName);
  cache.set(key, null);
  return null;
}

/** Try lookup by store display name (some Vencord versions expose findStore). */
export function tryFindStore(debugName: string, ...names: string[]): any | null {
  const key = `store:${debugName}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const wp = getWebpack();
  if (!wp?.findStore) { markMissing(debugName); cache.set(key, null); return null; }
  for (const n of names) {
    try {
      const mod = wp.findStore(n);
      if (mod) { cache.set(key, mod); return mod; }
    } catch { /* next */ }
  }
  markMissing(debugName);
  cache.set(key, null);
  return null;
}

export function markMissing(name: string) {
  if (warnedMissing.has(name)) return;
  warnedMissing.add(name);
  // §11: log `missing internal module: <name>` once at warn, rest at debug.
  log.warn("discovery", `missing internal module: ${name}`);
}

/** FluxDispatcher access (event subscriptions, §9). Null-safe. */
export function getDispatcher(): any | null {
  const key = "dispatcher";
  if (cache.has(key)) return cache.get(key) ?? null;
  const wp = getWebpack();
  let d: any = null;
  try { d = (wp as any)?.findByProps?.("dispatch", "subscribe") ?? (window as any)?.__FLUX_DISPATCHER__ ?? null; }
  catch { d = null; }
  // Heuristic: a dispatcher has .subscribe + .dispatch functions.
  if (!d || typeof d.subscribe !== "function" || typeof d.dispatch !== "function") {
    markMissing("FluxDispatcher");
    cache.set(key, null);
    return null;
  }
  cache.set(key, d);
  return d;
}

/** Clear caches (used on Discord reload / plugin restart). */
export function clearDiscoveryCache() { cache.clear(); }
