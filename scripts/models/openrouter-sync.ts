#!/usr/bin/env bun
// Keeps the registry's OpenRouter routes equal to what OpenRouter lists (plan MODELS-AND-SELF-FUNDING).
// Reads GET https://openrouter.ai/api/v1/models (no key) and, for every model in config/models.json:
//   - a model with a route: the id must be listed and support tools, and the route's rate, input-length
//     tiers and UTC peak windows are rewritten from OpenRouter's `pricing` (per token there, per 1M here);
//   - a Claude model without a route gets one: its OpenRouter id is derived (claude-opus-5-5 ->
//     anthropic/claude-opus-5.5) and must be listed, never guessed into existence.
// No figure is invented: a price OpenRouter does not list is left out, a missing id or a model
// without tool support fails the run.
//
//   bun scripts/models/openrouter-sync.ts            rewrite config/models.json (and read_on)
//   bun scripts/models/openrouter-sync.ts --check    exit 1 when the file differs from OpenRouter's list
//   ... --file <registry.json> --from <saved models API body> --json
//
// Run it before a deploy and after OpenRouter changes a price: the runtime sends provider.max_price
// from these figures with no tolerance, so a route priced above its registry figure is refused
// instead of charged at a price the launch form never showed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, type ModelEntry, type ModelRegistry, type OpenRouterRoute, type PeakWindow, type Rate } from "../../packages/core/src/model-registry.ts";

export const MODELS_API = "https://openrouter.ai/api/v1/models";

interface Pricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  overrides?: (Pricing & { min_prompt_tokens?: number; utc_days?: string[]; utc_start?: number; utc_end?: number })[];
}
export interface ListedModel {
  id: string;
  pricing: Pricing;
  supported_parameters?: string[];
}

/** USD per token as OpenRouter prints it, to USD per 1M tokens (six decimals: its own precision for the figures in use). */
const perM = (v: string | undefined): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Number((n * 1e6).toFixed(6)) : null;
};

function rateOf(p: Pricing, base?: Rate): Rate | null {
  const input = perM(p.prompt);
  const output = perM(p.completion);
  if (input === null || output === null) return null;
  const r: Rate = { input, output };
  const cr = perM(p.input_cache_read);
  const cw = perM(p.input_cache_write);
  if (cr !== null) r.cached_input = cr;
  // an override that lists no cache write keeps the base one (OpenRouter prints only what changes)
  if (cw !== null) r.cache_write = cw;
  else if (base?.cache_write != null) r.cache_write = base.cache_write;
  return r;
}

const sameRate = (a: Rate, b: Rate) => a.input === b.input && a.output === b.output && (a.cached_input ?? null) === (b.cached_input ?? null) && (a.cache_write ?? null) === (b.cache_write ?? null);
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const hhmm = (n: number) => `${String(Math.floor(n / 100)).padStart(2, "0")}:${String(n % 100).padStart(2, "0")}`;

/** The registry's Claude ids at OpenRouter: the trailing version's dash is a dot there. */
export function claudeRouteId(id: string): string {
  return `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

/** The route OpenRouter's listing gives for one model: rate, tiers by prompt size, peak by the UTC clock. */
export function routeFrom(listed: ListedModel, prev: OpenRouterRoute | null): { route: OpenRouterRoute } | { error: string } {
  if (!listed.supported_parameters?.includes("tools")) return { error: `${listed.id}: OpenRouter lists no tool support` };
  const rate = rateOf(listed.pricing);
  if (!rate) return { error: `${listed.id}: no prompt or completion price listed` };
  const route: OpenRouterRoute = { id: listed.id, rate };
  const sized = (listed.pricing.overrides ?? []).filter((o) => typeof o.min_prompt_tokens === "number").sort((a, b) => a.min_prompt_tokens! - b.min_prompt_tokens!);
  if (sized.length) {
    const tiers: NonNullable<OpenRouterRoute["tiers"]> = [];
    let cur = rate;
    for (const o of sized) {
      const next = rateOf(o, rate);
      if (!next) return { error: `${listed.id}: a size override without prices` };
      tiers.push({ up_to_input_tokens: o.min_prompt_tokens!, rate: cur });
      cur = next;
    }
    tiers.push({ up_to_input_tokens: 100_000_000, rate: cur });
    route.tiers = tiers;
  }
  // clock overrides: the windows whose price is not the base price are the peak (one peak rate only)
  const clock = (listed.pricing.overrides ?? []).filter((o) => Array.isArray(o.utc_days));
  let peak: Rate | null = null;
  const windows: PeakWindow[] = [];
  for (const o of clock) {
    const r = rateOf(o, rate);
    if (!r) return { error: `${listed.id}: a clock override without prices` };
    if (sameRate(r, rate)) continue;
    if (peak && !sameRate(peak, r)) return { error: `${listed.id}: more than one peak rate; the registry holds one` };
    peak = r;
    const start = hhmm(o.utc_start ?? 0);
    const end = (o.utc_end ?? 0) === 0 ? "23:59" : hhmm(o.utc_end!);
    windows.push({ days: o.utc_days!.map((d) => DAYS.indexOf(d.toLowerCase())).filter((d) => d >= 0).sort(), start, end });
  }
  if (peak) route.peak = { rate: peak, windows };
  if (prev?.enabled === false) route.enabled = false;
  if (prev?.note) route.note = prev.note;
  return { route };
}

export interface SyncResult {
  registry: ModelRegistry;
  changes: string[];
  errors: string[];
  /** soul model -> the id sent to OpenRouter, for every routed model */
  routes: { provider: string; id: string; openrouter: string }[];
}

const show = (o: OpenRouterRoute | null | undefined) => (o ? JSON.stringify({ id: o.id, rate: o.rate, tiers: o.tiers ?? null, peak: o.peak ?? null }) : "none");

/** The registry with every OpenRouter route rewritten from the listing. Pure: no I/O. */
export function syncRegistry(reg: ModelRegistry, listed: ListedModel[], today: string): SyncResult {
  const byId = new Map(listed.map((m) => [m.id, m]));
  const out = structuredClone(reg);
  const changes: string[] = [];
  const errors: string[] = [];
  const routes: SyncResult["routes"] = [];
  for (const m of out.models as ModelEntry[]) {
    const prev = m.routes?.openrouter ?? null;
    const id = prev?.id ?? (m.provider === "anthropic" ? claudeRouteId(m.id) : null);
    if (!id) continue;
    const l = byId.get(id);
    if (!l) {
      errors.push(`${m.provider}/${m.id}: OpenRouter does not list ${id}`);
      continue;
    }
    const r = routeFrom(l, prev);
    if ("error" in r) {
      errors.push(`${m.provider}/${m.id}: ${r.error}`);
      continue;
    }
    if (show(prev) !== show(r.route)) changes.push(`${m.provider}/${m.id}: ${show(prev)} -> ${show(r.route)}`);
    m.routes = { ...(m.routes ?? {}), openrouter: r.route };
    routes.push({ provider: m.provider, id: m.id, openrouter: r.route.id });
  }
  if (changes.length && out.routing?.openrouter) out.routing.openrouter.read_on = today;
  errors.push(...checkRegistry(out).map((e) => `registry after the sync: ${e}`));
  return { registry: out, changes, errors, routes };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const file = opt("file") ?? join(import.meta.dir, "../../config/models.json");
  const text = readFileSync(file, "utf8");
  const reg = JSON.parse(text) as ModelRegistry;
  const body = opt("from") ? JSON.parse(readFileSync(opt("from")!, "utf8")) : await (await fetch(MODELS_API)).json();
  const listed = (body as { data?: ListedModel[] }).data;
  if (!Array.isArray(listed) || listed.length === 0) throw new Error("the models API answered without a data list");
  const at = new Date().toISOString();
  const res = syncRegistry(reg, listed, at.slice(0, 10));
  if (argv.includes("--json")) console.log(JSON.stringify({ at, changes: res.changes, errors: res.errors, routes: res.routes }, null, 1));
  else {
    console.log(`OpenRouter models API read ${at}: ${listed.length} models listed, ${res.routes.length} registry routes checked`);
    for (const c of res.changes) console.log(`changed  ${c}`);
    for (const e of res.errors) console.log(`ERROR    ${e}`);
    if (!res.changes.length && !res.errors.length) console.log("every route equals OpenRouter's listing");
  }
  if (res.errors.length) process.exit(1);
  if (argv.includes("--check")) process.exit(res.changes.length ? 1 : 0);
  if (res.changes.length) {
    const indent = /^\{\n( +)/.exec(text)?.[1]?.length ?? 2;
    writeFileSync(file, JSON.stringify(res.registry, null, indent) + "\n");
    console.log(`wrote ${file}`);
  }
}
