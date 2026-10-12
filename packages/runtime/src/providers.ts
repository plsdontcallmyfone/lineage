import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, findModel, routeEntry, routeFeeFactor, routeOf, validChoice, type ModelChoice, type ModelEntry, type ModelRegistry, type RouteVia } from "../../core/src/model-registry.ts";
import { AnthropicProposer } from "../../worker/src/proposers/anthropic.ts";
import type { EfficiencyOptions } from "../../worker/src/proposers/efficiency.ts";
import { OpenAICompatProposer, ProviderError } from "../../worker/src/proposers/openai-compat.ts";
import { PROVIDERS, type ProviderSpec } from "../../worker/src/proposers/providers.ts";
import type { Proposal, ProposeContext, Proposer } from "../../worker/src/proposers/types.ts";
import { addSecret } from "./state.ts";

// Provider routing for hosted agents (plan M). Before each attempt the runtime reads the agent's
// signed profile (its soul's `model`, picked at launch) and runs that model. Owner decision
// 2026-10-12: every model goes through OpenRouter when it has a route there and the OpenRouter key is
// on this host (registry routing.prefer, default "openrouter"), Claude included; the model's own
// provider is the fallback. Claude models run in the native proposer on either route: through
// OpenRouter it talks to OpenRouter's Anthropic Messages endpoint (POST /api/v1/messages), so prompt
// caching, the cached static prefix, the keep-alive, pacing and effort are the same code. The other
// providers run through the OpenAI-compatible adapter. Prices come from Core's model
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
export function openrouterRequestExtra(m: ModelEntry, chosen?: ModelEntry): Record<string, unknown> {
  // the ceiling covers every rate the route can charge: its tiers and its peak windows too
  const rates = [m.rate!, ...(m.tiers ?? []).map((t) => t.rate), ...(m.peak ? [m.peak.rate] : [])];
  const max_price = { prompt: Math.max(...rates.map((r) => r.input)), completion: Math.max(...rates.map((r) => r.output)) };
  // Claude: Anthropic's own endpoint first, so every call of an attempt and the next attempt on the
  // unit read the same prompt cache (a cache lives at one host); OpenRouter may still fall back to
  // another host of the model under the same price ceiling when Anthropic is down
  if (chosen?.provider === "anthropic") return { provider: { order: ["anthropic"], max_price } };
  return { provider: { max_price, require_parameters: true } };
}

/** OpenRouter's Anthropic Messages endpoint as the Anthropic SDK wants it: the SDK appends /v1/messages. */
export const anthropicBaseOf = (spec: ProviderSpec) => spec.base_url.replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * Resolves which model an agent runs and how this host reaches it (plan MODELS-AND-SELF-FUNDING,
 * route rule of 2026-10-12): OpenRouter when its key is here and the model has a route (Claude
 * included), else the model's own provider when its key is here and its API runs the model, else
 * unavailable; registry routing.prefer "direct" swaps the two. The model is never substituted; only
 * the way to it.
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
  return { ok: true, provider: spec, model: entry, key: keys[pid]!, via: r.via, chosen: m, fee_factor: routeFeeFactor(reg, r.via), request_extra: r.via === "openrouter" ? openrouterRequestExtra(entry, m) : {} };
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
  /** the model proposer that ran this attempt; the session's journal entry goes to the same one */
  private delegate: Proposer | null = null;

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
    // a Claude model runs in the native proposer on either route: direct with Anthropic's key, or
    // against OpenRouter's Anthropic Messages endpoint with the OpenRouter key (bearer)
    const claude = findProviderAdapter(this.o.providers ?? PROVIDERS, r.chosen.provider) === "anthropic";
    const routed = r.via === "openrouter";
    const delegate: Proposer =
      claude
        ? new AnthropicProposer(
            {
              max_usd: this.o.attempt_max_usd, model: r.model.id, effort: this.o.effort, max_turns: this.o.max_turns, max_evals: this.o.max_evals, prices: anthropicPrices(r.model), efficiency: this.o.efficiency,
              ...(routed ? { gateway: { provider: r.provider.id, fee_factor: r.fee_factor, reported_cost: r.provider.reported_cost === true, request_extra: r.request_extra, model_as: r.chosen.id } } : {}),
            },
            this.o.anthropicClient ?? anthropicClientFor(r),
          )
        : new OpenAICompatProposer({ provider: r.provider, apiKey: r.key, model: r.model, max_usd: this.o.attempt_max_usd, max_turns: this.o.max_turns, max_evals: this.o.max_evals, fetch: this.o.providerFetch, fee_factor: r.fee_factor, request_extra: r.request_extra });
    this.delegate = delegate;
    try {
      return await delegate.propose(ctx);
    } catch (e) {
      throw routed ? routedError(r.provider.id, e) : e;
    }
  }

  /**
   * The session's journal entry (SPEC 17.6) in the agent's own model, inside what is left of the
   * attempt's cap. Without this the worker saw no journal method and no hosted agent ever wrote one.
   */
  async journal(ctx: ProposeContext, req: { system: string; user: string }): Promise<string | null> {
    const d = this.delegate;
    return d?.journal ? d.journal(ctx, req) : null;
  }
}

/** The Anthropic SDK client of a route: Anthropic's key direct, or OpenRouter's Anthropic Messages endpoint with its key as the bearer. */
export function anthropicClientFor(r: Extract<Route, { ok: true }>): Anthropic {
  return r.via === "openrouter" ? new Anthropic({ baseURL: anthropicBaseOf(r.provider), apiKey: null, authToken: r.key, defaultHeaders: r.provider.headers ?? {}, fetch: retryInFlight() }) : new Anthropic({ apiKey: r.key });
}

/**
 * OpenRouter's in-flight spending budget (docs "Limits", read 2026-10-12): with many requests running
 * at once a request can be refused with 402 and a Retry-After header although the balance is positive;
 * it is transient. The SDK retries 429 and 5xx but not 402, so this fetch waits and resends such a
 * request (at most twice, at most 30 s each), as the OpenAI-compatible adapter does. A 402 without
 * Retry-After (no credits) is returned as it is.
 */
export function retryInFlight(f: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let i = 0; ; i++) {
      const res = await f(input, init);
      const ra = res.status === 402 ? Number(res.headers.get("retry-after") ?? NaN) : NaN;
      if (!(Number.isFinite(ra) && ra >= 0) || i >= 2 || (init?.body != null && typeof init.body !== "string")) return res;
      await res.body?.cancel().catch(() => {});
      await sleep(Math.min(30, ra) * 1000);
    }
  }) as typeof fetch;
}

const findProviderAdapter = (providers: Record<string, ProviderSpec>, id: string) => providers[id]?.adapter ?? null;

/**
 * An error of the Anthropic SDK on a routed call, in the adapter's shape: the runtime reads
 * `noCredits` and `provider` from it to mark the OpenRouter balance empty (402), exactly as it does
 * for the OpenAI-compatible adapter. Only a 402 is converted; anything else passes through unchanged.
 */
export function routedError(provider: string, e: unknown): unknown {
  if (!(e instanceof Anthropic.APIError) || e.status !== 402) return e;
  const pe = new ProviderError(provider, e.status, null, String(e.message).slice(0, 300));
  const ra = Number((e.headers as { get?: (k: string) => string | null } | undefined)?.get?.("retry-after") ?? NaN);
  if (Number.isFinite(ra) && ra >= 0) pe.retryAfterS = ra;
  return pe;
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
