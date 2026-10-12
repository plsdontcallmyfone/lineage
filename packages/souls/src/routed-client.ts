// The model client of every small Claude call in the product that is not an authoring attempt: soul
// drafts in the launch wizard, agent posts, the follow step, voice text for commits. Owner decision
// 2026-10-12: every model call goes through OpenRouter. This client applies the same route rule as
// authoring (packages/core/src/model-registry.ts routeOf, registry routing.prefer): OpenRouter when
// its key is here and the model has a route, else the model's own provider when its key is here,
// else no call. Through OpenRouter it talks to the Anthropic Messages endpoint (POST /api/v1/messages)
// with the route's id and provider preferences, and the answer is metered at the cost OpenRouter
// reports times its funding fee (without a cost: the route's listed price). Direct answers are
// metered at the registry price. Either way `usage.usd` is set and `model` is the registry id, so
// callers price nothing themselves.
//
// A provider that answers "no credit" (402, or a 4xx whose message is about credit or billing) is
// marked unavailable for a while: calls for it fail at once without a request, so a loop that
// retries cannot spam a provider that has no money.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRegistry, openrouterPrefs, rateFor, routeEntry, routeFeeFactor, routeOf, usdFor, type ModelEntry, type ModelRegistry, type RouteVia } from "../../core/src/model-registry.ts";
import { loadProviderKeys, PROVIDERS, type ProviderSpec } from "../../worker/src/proposers/providers.ts";
import type { ModelClient } from "./generator.ts";

type Message = Awaited<ReturnType<ModelClient["create"]>>;

/** What a call needs from the SDK (tests pass a fake). */
export interface MessagesSdk {
  create(params: Record<string, unknown>): Promise<Message & { provider?: string }>;
}

export interface RoutedClientOptions {
  /** the registry in force (Core's, or the local seed) */
  registry: () => Promise<ModelRegistry | null> | ModelRegistry | null;
  /** provider id -> key; read at every call, so a reloaded key is used without a restart */
  keys: Record<string, string>;
  providers?: Record<string, ProviderSpec>;
  /** seconds a provider stays marked unavailable after a no-credit answer (default 900) */
  cooldown_s?: number;
  now?: () => number;
  log?: (m: string) => void;
  /** a provider answered that it has no credit (the runtime marks the OpenRouter balance empty) */
  onNoCredits?: (provider: string) => void;
  /** each answered call: the route it ran on (logs, tests) */
  onRoute?: (r: { model: string; via: RouteVia; provider: string; requested: string; upstream: string | null; usd: number }) => void;
  /** tests: the SDK for a route */
  sdk?: (r: { via: RouteVia; provider: ProviderSpec; key: string }) => MessagesSdk;
}

/** An error of this client; `noCredits` when the provider has no credit (or is still marked so). */
export class ModelRouteError extends Error {
  constructor(
    message: string,
    readonly provider: string | null,
    readonly noCredits: boolean,
    /** ms until the provider is tried again (a no-credit mark), else null */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Whether a provider's error says the account cannot pay (never retried at once). */
export function isCreditError(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  const msg = String((e as { message?: unknown })?.message ?? "");
  if (status === 402) return !(e as { headers?: { get?: (k: string) => string | null } }).headers?.get?.("retry-after");
  return typeof status === "number" && status >= 400 && status < 500 && /credit balance|insufficient credits|billing|payment required|out of credits/i.test(msg);
}

const costOf = (u: unknown): number | null => {
  const c = (u as { cost?: unknown } | null | undefined)?.cost;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null;
};

function realSdk(r: { via: RouteVia; provider: ProviderSpec; key: string }): MessagesSdk {
  const client =
    r.via === "openrouter"
      ? new Anthropic({ baseURL: r.provider.base_url.replace(/\/+$/, "").replace(/\/v1$/, ""), apiKey: null, authToken: r.key, defaultHeaders: r.provider.headers ?? {}, maxRetries: 2 })
      : new Anthropic({ apiKey: r.key, maxRetries: 2 });
  return {
    async create(params) {
      const stream = client.beta.messages.stream(params as never);
      // OpenRouter reports what it charged on the stream's message_delta event only; the SDK's final message drops it
      let cost: number | null = null;
      stream.on("streamEvent", (ev) => {
        if (ev.type === "message_delta") cost = costOf(ev.usage) ?? cost;
      });
      const m = (await stream.finalMessage()) as unknown as Message & { provider?: string };
      if (cost !== null && costOf(m.usage) === null) (m.usage as Record<string, unknown>).cost = cost;
      return m;
    },
  };
}

/** The registry's Claude model with this id (the id callers configure: claude-sonnet-5-5). */
function findClaude(reg: ModelRegistry, providers: Record<string, ProviderSpec>, id: string): ModelEntry | null {
  return reg.models.find((m) => m.id === id && providers[m.provider]?.adapter === "anthropic") ?? null;
}

export function routedModelClient(o: RoutedClientOptions): ModelClient & { unavailable(provider: string): number | null } {
  const providers = o.providers ?? PROVIDERS;
  const now = o.now ?? (() => Date.now());
  const until = new Map<string, number>();
  const sdks = new Map<string, MessagesSdk>();
  const unavailable = (pid: string) => {
    const t = until.get(pid);
    if (t === undefined) return null;
    if (t <= now()) return void until.delete(pid), null;
    return t - now();
  };
  return {
    unavailable,
    async create(params) {
      const reg = await o.registry();
      if (!reg) throw new ModelRouteError("no model registry: the model call has no route", null, false);
      const id = String(params.model ?? "");
      const m = findClaude(reg, providers, id);
      if (!m) throw new ModelRouteError(`${id} is not a Claude model in the model registry`, null, false);
      const have: Record<string, boolean> = {};
      for (const p of Object.keys(providers)) have[p] = !!o.keys[p];
      const r = routeOf(reg, m, have);
      if (!r.via) throw new ModelRouteError(`${m.name}: ${r.why}`, null, false);
      const pid = r.via === "direct" ? m.provider : "openrouter";
      const spec = providers[pid];
      if (!spec) throw new ModelRouteError(`provider ${pid} has no adapter here`, pid, false);
      const wait = unavailable(pid);
      if (wait !== null) throw new ModelRouteError(`${spec.id} has no credit: not called again for ${Math.ceil(wait / 1000)} s`, pid, true, wait);
      const entry = routeEntry(reg, m, r.via);
      const key = o.keys[pid]!;
      const sk = `${pid}\n${key}`;
      let sdk = sdks.get(sk);
      if (!sdk) sdks.set(sk, (sdk = (o.sdk ?? realSdk)({ via: r.via, provider: spec, key })));
      // through OpenRouter: its id and provider preferences; Anthropic's server-side fallback fields are refused there (400)
      const body: Record<string, unknown> = { ...params, model: entry.id };
      if (r.via === "openrouter") {
        delete body.betas;
        delete body.fallbacks;
        Object.assign(body, openrouterPrefs(entry, m));
      }
      let res: Message & { provider?: string };
      try {
        res = await sdk.create(body);
      } catch (e) {
        if (!isCreditError(e)) throw e;
        const ms = (o.cooldown_s ?? 900) * 1000;
        until.set(pid, now() + ms);
        o.log?.(`${spec.id} answered that it has no credit; not called again for ${Math.round(ms / 1000)} s`);
        try {
          o.onNoCredits?.(pid);
        } catch {
          /* a callback must not hide the error */
        }
        throw new ModelRouteError(`${spec.id} has no credit (${String((e as Error).message).slice(0, 160)})`, pid, true, ms);
      }
      const u = (res.usage ?? {}) as Record<string, number | null | undefined>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
      const tokens = { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_read_tokens: n(u.cache_read_input_tokens), cache_write_tokens: n(u.cache_creation_input_tokens) };
      const table = usdFor(rateFor(entry, new Date(now()), tokens.input_tokens + tokens.cache_read_tokens + tokens.cache_write_tokens)!, { ...tokens });
      const usd = ((r.via === "openrouter" && spec.reported_cost ? costOf(u) : null) ?? table) * routeFeeFactor(reg, r.via);
      // the answer named the id that was sent (or a dated snapshot of it): callers see the registry id
      const answered = String(res.model ?? entry.id);
      const same = answered === entry.id || answered.startsWith(`${entry.id}-`) || answered.replace(/-\d{8}$/, "") === entry.id;
      try {
        o.onRoute?.({ model: m.id, via: r.via, provider: pid, requested: entry.id, upstream: typeof res.provider === "string" ? res.provider : null, usd });
      } catch {
        /* reporting must not change the answer */
      }
      return { ...res, model: same ? m.id : answered, usage: { ...u, usd } };
    },
  };
}

const SEED = join(import.meta.dir, "../../../config/models.json");

/** The local registry seed (UNITS_MODELS or config/models.json), or null when missing or invalid. */
export function localRegistry(path = process.env.UNITS_MODELS ?? process.env.LINEAGE_MODELS ?? SEED): ModelRegistry | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return checkRegistry(raw).length === 0 ? (raw as ModelRegistry) : null;
}

/**
 * Provider keys for a process that is not the runtime (the web server's soul drafts, the CLI, scripts):
 * providers.env and model.env when this user has them, and the environment on top (a systemd
 * EnvironmentFile carries OPENROUTER_API_KEY and ANTHROPIC_API_KEY to the web service). Never printed.
 */
export function envProviderKeys(env: Record<string, string | undefined> = process.env, file: Record<string, string> = loadProviderKeys({ create: false })): Record<string, string> {
  const keys = { ...file };
  for (const p of Object.values(PROVIDERS)) if (env[p.key_env]) keys[p.id] = env[p.key_env]!;
  return keys;
}

/**
 * The product's model client outside the runtime: the local registry and this process's keys, routed
 * by the registry's rule. Throws when no key that can run a Claude model is here.
 */
export function defaultModelClient(o: Partial<RoutedClientOptions> = {}): ModelClient {
  const keys = o.keys ?? envProviderKeys();
  if (!keys.openrouter && !keys.anthropic) throw new Error("no model key: OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) in the environment, ~/.config/units/providers.env or model.env");
  const reg = localRegistry();
  return routedModelClient({ registry: () => reg, ...o, keys });
}
