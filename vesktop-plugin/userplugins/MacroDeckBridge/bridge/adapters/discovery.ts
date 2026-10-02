/**
 * adapters/discovery.ts — Safe webpack-module discovery.
 *
 * RULES: cache every find; warn once per missing module; never throw; never
 * tight-loop a scan. All adapters use `tryFind()` / `cached()` helpers here.
 *
 * NOTE: the standalone `vesktop-plugin` scaffold probed a `window.Vencord`
 * global because it could not import Vencord modules. Inside a real
 * Vencord/Vesktop build there is no such global — Vencord v1.15.9 exposes its
 * webpack API only as ES modules. This adapted copy therefore binds directly to
 * `@webpack`; every other behaviour (caching, warn-once, never-throw) is
 * unchanged.
 */
import { findByProps, findStore } from "@webpack";

import { log } from "../logger";

type Finder = {
  findByProps?: (...props: string[]) => any;
  findByCode?: (...codes: string[]) => any;
  findStore?: (name: string) => any;
};

let webpackApi: Finder | null = null;
const cache = new Map<string, any>();
const warnedMissing = new Set<string>();

/** Resolve Vencord's real webpack helpers (always present inside a Vencord build). */
export function getWebpack(): Finder | null {
  if (webpackApi) return webpackApi;
  try {
    webpackApi = { findByProps, findStore };
    return webpackApi;
  } catch (e) {
    log.warn("discovery", "Vencord webpack API unavailable; all Discord-control adapters report unsupported");
    return null;
  }
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
  let d: any = null;
  // Vencord's own FluxDispatcher lives at `@webpack/common`, but importing that
  // pulls in every common store; a prop lookup is lighter and equivalent here.
  try { d = tryFind("FluxDispatcher", ["dispatch", "subscribe"]); }
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
