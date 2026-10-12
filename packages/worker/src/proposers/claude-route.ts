import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, openrouterPrefs, routeEntry, routeFeeFactor, routeOf, type ModelEntry, type ModelRegistry, type RouteVia } from "../../../core/src/model-registry.ts";
import type { GatewayOptions } from "./anthropic.ts";
import { loadProviderKeys, PROVIDERS, type ProviderSpec } from "./providers.ts";

// The route of a Claude model for a process that is not the hosted runtime (a self-hosted worker with
// --proposer anthropic, the discovery and recipe drafting tools, the local proof scripts). Owner
// decision 2026-10-12: every model call goes through OpenRouter. Same rule as the runtime
// (model-registry.ts routeOf, registry routing.prefer): OpenRouter's Anthropic Messages endpoint when
// OPENROUTER_API_KEY is here and the model has a route, else Anthropic with its own key. Keys come
// from providers.env, model.env and the environment; the registry is the local seed. Never printed.

const SEED = join(import.meta.dir, "../../../../config/models.json");

export interface ClaudeRoute {
  via: RouteVia;
  /** the registry id (claude-opus-5-5) */
  chosen: string;
  /** the id sent: the same direct, OpenRouter's through OpenRouter */
  model: string;
  prices: { input: number; output: number; cache_read: number; cache_write: number };
  client: Anthropic;
  /** set through OpenRouter: what the proposer needs to know about the router */
  gateway: GatewayOptions | null;
}

function localRegistry(): ModelRegistry | null {
  const path = process.env.UNITS_MODELS ?? process.env.LINEAGE_MODELS ?? SEED;
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return checkRegistry(raw).length === 0 ? (raw as ModelRegistry) : null;
}

/** Keys of this process: the key files when this user has them, the environment on top. */
export function processKeys(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const keys = loadProviderKeys({ create: false });
  for (const p of Object.values(PROVIDERS)) if (env[p.key_env]) keys[p.id] = env[p.key_env]!;
  return keys;
}

const pricesOf = (m: ModelEntry) => {
  const r = m.rate!;
  return { input: r.input, output: r.output, cache_read: r.cached_input ?? r.input, cache_write: r.cache_write ?? r.input * 1.25 };
};

/**
 * The route for the Claude model `id` (registry id), or null when the registry does not list it or
 * no key can run it (the caller then keeps its own client). `o` is for tests.
 */
export function claudeRoute(id: string, o: { registry?: ModelRegistry | null; keys?: Record<string, string>; providers?: Record<string, ProviderSpec> } = {}): ClaudeRoute | null {
  const reg = o.registry === undefined ? localRegistry() : o.registry;
  if (!reg) return null;
  const providers = o.providers ?? PROVIDERS;
  const keys = o.keys ?? processKeys();
  const m = reg.models.find((x) => x.id === id && providers[x.provider]?.adapter === "anthropic");
  if (!m) return null;
  const have: Record<string, boolean> = {};
  for (const p of Object.keys(providers)) have[p] = !!keys[p];
  const r = routeOf(reg, m, have);
  if (!r.via) return null;
  if (r.via === "direct") return { via: "direct", chosen: m.id, model: m.id, prices: pricesOf(m), client: new Anthropic({ apiKey: keys[m.provider]! }), gateway: null };
  const spec = providers.openrouter!;
  const entry = routeEntry(reg, m, "openrouter");
  return {
    via: "openrouter",
    chosen: m.id,
    model: entry.id,
    prices: pricesOf(entry),
    client: new Anthropic({ baseURL: spec.base_url.replace(/\/+$/, "").replace(/\/v1$/, ""), apiKey: null, authToken: keys.openrouter!, defaultHeaders: spec.headers ?? {} }),
    gateway: { provider: spec.id, fee_factor: routeFeeFactor(reg, "openrouter"), reported_cost: spec.reported_cost === true, request_extra: openrouterPrefs(entry, m), model_as: m.id },
  };
}

/**
 * An SDK-shaped client for tool loops that hold a registry model id and price by it (discovery.ts):
 * `beta.messages.stream(params).finalMessage()` sends the call on the model's route and answers with
 * the registry id as `model`, so the caller's price table applies (OpenRouter lists Claude at
 * Anthropic's prices; its 5.5% credit fee is not in such a ledger). Models without a route here go
 * to Anthropic's own API as before.
 */
export function routedSdk(o: Parameters<typeof claudeRoute>[1] = {}): Anthropic {
  const direct = new Anthropic();
  const stream = (params: Record<string, unknown>) => {
    const id = String(params.model ?? "");
    const r = claudeRoute(id, o);
    if (!r || r.via === "direct") return (r?.client ?? direct).beta.messages.stream(params as never);
    const { betas: _b, fallbacks: _f, ...rest } = params;
    const s = r.client.beta.messages.stream({ ...rest, model: r.model, ...(r.gateway!.request_extra ?? {}) } as never);
    return { finalMessage: async () => ({ ...(await s.finalMessage()), model: id }) };
  };
  return { beta: { messages: { stream } } } as unknown as Anthropic;
}
