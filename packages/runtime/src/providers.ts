import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, findModel, validChoice, type ModelChoice, type ModelEntry, type ModelRegistry } from "../../core/src/model-registry.ts";
import { AnthropicProposer } from "../../worker/src/proposers/anthropic.ts";
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

export type Route = { ok: true; provider: ProviderSpec; model: ModelEntry; key: string } | { ok: false; why: string; choice: ModelChoice | null };

/** Resolves which model an agent runs and whether this host can run it. */
export function resolveRoute(reg: ModelRegistry | null, choice: ModelChoice | null, keys: Record<string, string>, providers: Record<string, ProviderSpec> = PROVIDERS): Route {
  if (!reg) return { ok: false, why: "no model registry (Core and config/models.json both unavailable)", choice };
  const want = choice ?? reg.default;
  const m = findModel(reg, want);
  if (!m) return { ok: false, why: `${want.provider}/${want.id} is not in the model registry`, choice: want };
  if (m.status !== "verified" || !m.rate) return { ok: false, why: `${m.name} has no published price`, choice: want };
  if (m.enabled === false) return { ok: false, why: `${m.name} is not offered (${m.note ?? "disabled in the registry"})`, choice: want };
  const spec = providers[m.provider];
  if (!spec) return { ok: false, why: `provider ${m.provider} has no adapter on this runtime`, choice: want };
  const key = keys[m.provider];
  if (!key) return { ok: false, why: `no ${spec.key_env} in providers.env: provider ${m.provider} is unavailable`, choice: want };
  return { ok: true, provider: spec, model: m, key };
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

  async route(): Promise<Route> {
    const choice = await soulModel(this.o.core, this.agent, this.o.fetch);
    return resolveRoute(await this.registry.get(), choice, this.o.keys, this.o.providers);
  }

  async propose(ctx: ProposeContext): Promise<Proposal | null> {
    const r = await this.route();
    if (!r.ok) {
      ctx.log(`model route: ${r.why}; not authoring`);
      return null;
    }
    ctx.log(`model route: ${r.provider.id}/${r.model.id}`);
    const delegate: Proposer =
      r.provider.adapter === "anthropic"
        ? new AnthropicProposer(
            { max_usd: this.o.attempt_max_usd, model: r.model.id, effort: this.o.effort, max_turns: this.o.max_turns, max_evals: this.o.max_evals, prices: anthropicPrices(r.model) },
            this.o.anthropicClient ?? new Anthropic({ apiKey: r.key }),
          )
        : new OpenAICompatProposer({ provider: r.provider, apiKey: r.key, model: r.model, max_usd: this.o.attempt_max_usd, max_turns: this.o.max_turns, max_evals: this.o.max_evals, fetch: this.o.providerFetch });
    return delegate.propose(ctx);
  }
}

/** The proposer factory for the runtime: keys are registered for redaction and never printed. */
export function routedProposers(o: RoutingOptions): (agent: string) => Proposer {
  for (const k of Object.values(o.keys)) addSecret(k);
  const reg = new RegistrySource(o);
  return (agent) => new RoutedProposer(agent, o, reg);
}
