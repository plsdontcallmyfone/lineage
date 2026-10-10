import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, findModel, routeEntry, routeFeeFactor, routeOf, validChoice, type ModelChoice, type ModelEntry, type ModelRegistry, type RouteVia } from "../../core/src/model-registry.ts";
import { AnthropicProposer } from "../../worker/src/proposers/anthropic.ts";
import type { EfficiencyOptions } from "../../worker/src/proposers/efficiency.ts";
import { OpenAICompatProposer } from "../../worker/src/proposers/openai-compat.ts";
import { PROVIDERS, type ProviderSpec } from "../../worker/src/proposers/providers.ts";
import type { Proposal, ProposeContext, Proposer } from "../../worker/src/proposers/types.ts";
import { addSecret } from "./state.ts";

// Provider routing for hosted agents (plan M). Before each attempt the runtime reads the agent's
// signed profile (its soul's `model`, picked at launch) and runs that model: Anthropic through the
// native proposer, the others through the OpenAI-compatible adapter. Prices come from Core's model
// registry (checked again here; a model without a positive price is never run, so a registry edit
// cannot switch metering off), endpoints and keys only from this host (providers.ts). A provider
// without a key is not substituted: the attempt does not start, and the log says why, because the
// provenance record must attest the model the owner picked, not another one. The global daily cap
// is in USD and counts every provider alike (runtime.ts).

export const LOCAL_REGISTRY = join(import.meta.dir, "../../../config/models.json");

export interface RoutingOptions {
  core: string;
  keys: Record<string, string>;
  attempt_max_usd: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_turns: number;
  max_evals: number;
  /** Attempt efficiency settings for the Anthropic proposer (docs/plans/AGENT-EFFICIENCY.md). */
  efficiency?: EfficiencyOptions;
  fetch?: typeof fetch;
  /** tests: model clients */
  anthropicClient?: Anthropic;
  providerFetch?: typeof fetch;
  registryTtlMs?: number;
  log?: (m: string) => void;
  /** tests: endpoints */
  providers?: Record<string, ProviderSpec>;
}

export class RegistrySource {
  private cached: { at: number; reg: ModelRegistry } | null = null;
  constructor(private o: Pick<RoutingOptions, "core" | "fetch" | "registryTtlMs" | "log">) {}

  async get(): Promise<ModelRegistry | null> {
    const ttl = this.o.registryTtlMs ?? 60_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.reg;
    let reg: ModelRegistry | null = null;
    try {
      const r = await (this.o.fetch ?? fetch)(`${this.o.core.replace(/\/+$/, "")}/v1/models`);
      const j = (await r.json()) as { registry?: unknown };
      if (r.ok && j.registry && checkRegistry(j.registry).length === 0) reg = j.registry as ModelRegistry;
      else if (r.ok && j.registry) this.o.log?.("Core's model registry does not validate; using the local copy");
    } catch (e) {
      this.o.log?.(`model registry not read from Core: ${(e as Error).message}`);
    }
    if (!reg && existsSync(LOCAL_REGISTRY)) {
      const raw = JSON.parse(readFileSync(LOCAL_REGISTRY, "utf8"));
      if (checkRegistry(raw).length === 0) reg = raw;
    }
    if (reg) this.cached = { at: Date.now(), reg };
    return reg;
  }
}

/** The agent's chosen model from its public soul, or null (then the registry default). */
export async function soulModel(core: string, agent: string, f: typeof fetch = fetch): Promise<ModelChoice | null> {
  try {
    const r = await f(`${core.replace(/\/+$/, "")}/v1/agents/${agent}/soul`);
    if (!r.ok) return null;
    const j = (await r.json()) as { doc?: { model?: unknown } };
    return validChoice(j.doc?.model) ? (j.doc!.model as ModelChoice) : null;
  } catch {
    return null;
  }
}

export type Route =
  | {
      ok: true;
      /** the endpoint that runs it: the model's own provider, or OpenRouter */
      provider: ProviderSpec;
      /** the entry the adapter requests and meters: the model's own, or its OpenRouter route (id and listed price) */
      model: ModelEntry;
      key: string;
      via: RouteVia;
      /** the model the soul names (registry entry), whatever the route */
      chosen: ModelEntry;
      /** funding fee on top of the charged cost (1 for direct) */
      fee_factor: number;
      /** per-model request fields of the route (OpenRouter: provider.max_price, require_parameters) */
      request_extra: Record<string, unknown>;
    }
  | { ok: false; why: string; choice: ModelChoice | null };

/** OpenRouter's provider preferences for a route: never a host priced above the listed rate, and one that supports tools. */
export function openrouterRequestExtra(m: ModelEntry): Record<string, unknown> {
  const rates = [m.rate!, ...(m.tiers ?? []).map((t) => t.rate)];
  return { provider: { max_price: { prompt: Math.max(...rates.map((r) => r.input)), completion: Math.max(...rates.map((r) => r.output)) }, require_parameters: true } };
}

/**
 * Resolves which model an agent runs and how this host reaches it (plan MODELS-AND-SELF-FUNDING):
 * the model's own provider when its key is here and its API runs the model, else OpenRouter when
 * that key is here and the model has a route (never Anthropic), else unavailable. The model is never
 * substituted; only the way to it.
 */
export function resolveRoute(reg: ModelRegistry | null, choice: ModelChoice | null, keys: Record<string, string>, providers: Record<string, ProviderSpec> = PROVIDERS): Route {
  if (!reg) return { ok: false, why: "no model registry (Core and config/models.json both unavailable)", choice };
  const want = choice ?? reg.default;
  const m = findModel(reg, want);
  if (!m) return { ok: false, why: `${want.provider}/${want.id} is not in the model registry`, choice: want };
  const have: Record<string, boolean> = {};
  for (const id of Object.keys(providers)) have[id] = !!keys[id];
  const r = routeOf(reg, m, have);
  if (!r.via) return { ok: false, why: `${m.name}: ${r.why}`, choice: want };
  const pid = r.via === "direct" ? m.provider : "openrouter";
  const spec = providers[pid];
  if (!spec) return { ok: false, why: `provider ${pid} has no adapter on this runtime`, choice: want };
  const entry = routeEntry(reg, m, r.via);
  return { ok: true, provider: spec, model: entry, key: keys[pid]!, via: r.via, chosen: m, fee_factor: routeFeeFactor(reg, r.via), request_extra: r.via === "openrouter" ? openrouterRequestExtra(entry) : {} };
}

/** Rates in the Anthropic proposer's shape (cache writes at 1.25x input when the registry has none). */
export function anthropicPrices(m: ModelEntry) {
  const r = m.rate!;
  return { input: r.input, output: r.output, cache_read: r.cached_input ?? r.input, cache_write: r.cache_write ?? r.input * 1.25 };
}

/** One per agent: routes each attempt to the agent's chosen model. */
export class RoutedProposer implements Proposer {
  readonly name = "routed";
  constructor(
    private agent: string,
    private o: RoutingOptions,
    private registry: RegistrySource,
  ) {}

  /** the last route resolved for this agent (the runtime's balance gate and spend report read it) */
  last: Route | null = null;

  async route(): Promise<Route> {
    const choice = await soulModel(this.o.core, this.agent, this.o.fetch);
    this.last = resolveRoute(await this.registry.get(), choice, this.o.keys, this.o.providers);
    return this.last;
  }

  async propose(ctx: ProposeContext): Promise<Proposal | null> {
    const r = await this.route();
    if (!r.ok) {
      ctx.log(`model route: ${r.why}; not authoring`);
      return null;
    }
    ctx.log(`model route: ${r.chosen.provider}/${r.chosen.id}${r.via === "openrouter" ? ` via OpenRouter (${r.model.id})` : ""}`);
    try {
      ctx.meter?.route?.({ via: r.via, model: { provider: r.chosen.provider, id: r.chosen.id }, requested: r.model.id });
    } catch {
      /* metering must not change the attempt */
    }
    const delegate: Proposer =
      r.provider.adapter === "anthropic"
        ? new AnthropicProposer(
            { max_usd: this.o.attempt_max_usd, model: r.model.id, effort: this.o.effort, max_turns: this.o.max_turns, max_evals: this.o.max_evals, prices: anthropicPrices(r.model), efficiency: this.o.efficiency },
            this.o.anthropicClient ?? new Anthropic({ apiKey: r.key }),
          )
        : new OpenAICompatProposer({ provider: r.provider, apiKey: r.key, model: r.model, max_usd: this.o.attempt_max_usd, max_turns: this.o.max_turns, max_evals: this.o.max_evals, fetch: this.o.providerFetch, fee_factor: r.fee_factor, request_extra: r.request_extra });
    return delegate.propose(ctx);
  }
}

/**
 * The proposer factory for the runtime: keys are registered for redaction and never printed. The
 * keys object is read at every route, so a key that lands in providers.env (reloadKeys) is used at
 * the next attempt without a restart.
 */
export function routedProposers(o: RoutingOptions): ((agent: string) => Proposer) & { routes: Map<string, RoutedProposer>; registry: RegistrySource } {
  for (const k of Object.values(o.keys)) addSecret(k);
  const reg = new RegistrySource(o);
  const routes = new Map<string, RoutedProposer>();
  const f = (agent: string) => {
    const p = new RoutedProposer(agent, o, reg);
    routes.set(agent, p);
    return p;
  };
  return Object.assign(f, { routes, registry: reg });
}

/**
 * Re-reads the provider keys into `keys` in place (added, changed and removed ones). Returns true
 * when which providers have a key changed (then the runtime reports availability to Core again).
 */
export function reloadKeys(keys: Record<string, string>, fresh: Record<string, string>): boolean {
  const before = JSON.stringify(Object.keys(keys).sort());
  for (const k of Object.keys(keys)) if (!(k in fresh)) delete keys[k];
  for (const [k, v] of Object.entries(fresh)) {
    addSecret(v);
    keys[k] = v;
  }
  return JSON.stringify(Object.keys(keys).sort()) !== before;
}
