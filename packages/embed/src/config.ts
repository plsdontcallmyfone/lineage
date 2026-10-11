import { UnitsClient, resolveBases, type BaseOverrides } from "./client.ts";

// Where the kit reads from: the script tag's data-* attributes (data-api, data-core, data-market,
// data-events, data-site, data-ours), else window.UnitsConfig, else the origin the script was
// loaded from. units.configure({...}) replaces it at runtime.

declare global {
  interface Window {
    UnitsConfig?: BaseOverrides & { ours?: string[] | string };
    /** the pre-rebrand name, still read when UnitsConfig is not set */
    LineageConfig?: BaseOverrides & { ours?: string[] | string };
  }
}

// captured while the script runs (currentScript is null afterwards)
const SCRIPT: HTMLScriptElement | null =
  typeof document === "undefined"
    ? null
    : ((document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>('script[src*="units-embed"], script[src*="lineage-embed"]'));

/** The directory units-embed.js was loaded from (units-explorer.js sits next to it). */
export function scriptBase(): string {
  try {
    if (SCRIPT?.src) return new URL(".", new URL(SCRIPT.src, location.href)).href.replace(/\/$/, "");
  } catch {
    /* fall through */
  }
  return `${getClient().bases.site}/embed`;
}

function scriptOrigin(): string {
  try {
    if (SCRIPT?.src) return new URL(SCRIPT.src, location.href).origin;
  } catch {
    /* fall through */
  }
  return typeof location === "undefined" ? "http://127.0.0.1:9661" : location.origin;
}

const list = (v: string[] | string | null | undefined) => (Array.isArray(v) ? v : (v ?? "").split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);

function initial(): { bases: BaseOverrides; ours: string[] } {
  const d = SCRIPT?.dataset ?? {};
  const w = (typeof window !== "undefined" && (window.UnitsConfig ?? window.LineageConfig)) || {};
  return {
    bases: { api: d.api ?? w.api, core: d.core ?? w.core, market: d.market ?? w.market, events: d.events ?? w.events, site: d.site ?? w.site },
    ours: list(d.ours ?? w.ours),
  };
}

let cfg = initial();
let client: UnitsClient | null = null;
const listeners = new Set<() => void>();

export function getClient(): UnitsClient {
  if (!client) client = new UnitsClient(resolveBases(cfg.bases, scriptOrigin()));
  return client;
}

/** The project's own token mints: data-ours, else Core config `official_mints`, else none. */
export async function ourMints(): Promise<string[]> {
  if (cfg.ours.length) return cfg.ours;
  const c = await getClient().core<any>("config").catch(() => null);
  return list(c?.network?.official_mints ?? c?.official_mints ?? []);
}

export function configure(o: BaseOverrides & { ours?: string[] | string }) {
  cfg = { bases: { ...cfg.bases, ...o }, ours: o.ours !== undefined ? list(o.ours) : cfg.ours };
  client = null;
  for (const f of listeners) f();
}

export function onConfigure(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}
