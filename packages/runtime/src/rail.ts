import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_PRICES } from "../../worker/src/proposers/anthropic.ts";
import { addSecret } from "./state.ts";

// Runtime credit rails (plan C, owner decision 2026-10-09). A rail is who sells the runtime its model
// tokens and how they are paid for:
//   anthropic   (default) our Anthropic key; the treasury pays Anthropic in fiat.
//   openrouter  OpenRouter as the model endpoint (its Anthropic-compatible POST /api/v1/messages,
//               bearer key), a balance monitor on GET /api/v1/credits (management key) with a floor
//               alert, and a pluggable top-up job. OFF by config until the owner has OpenRouter's
//               written OK (their terms may restrict resale).
//
// The top-up method OpenRouter documented for crypto, POST /api/v1/credits/coinbase (returns
// calldata to send on Ethereum, Polygon or Base, amount up to 2000 USD), was REMOVED: it answers
// 410 Gone since Coinbase deprecated the Commerce APIs it used
// (https://openrouter.ai/docs/cookbook/administration/crypto-api.md, read 2026-10-09). The job keeps
// that request shape behind a pluggable purchaser, tested against a mock only, and treats 410 as
// "purchase unavailable: top up on the web credits page" (one alert, no retry until the config
// changes or a day passes). No real purchase is ever made by tests, and no real key is in the repo.

export type RailName = "anthropic" | "openrouter";

export interface OpenRouterRailConfig {
  /** Master switch: false (default) refuses the rail entirely. */
  enabled: boolean;
  /** API base; the Anthropic SDK appends /v1/messages. Default https://openrouter.ai/api */
  base_url?: string;
  /** OpenRouter model id the proposer requests (for example "anthropic/claude-opus-4.5"). */
  model: string;
  /** The Anthropic model whose published per-token prices meter this model (a MODEL_PRICES key), so spend caps hold. */
  price_as: string;
  /** Environment variable names holding the keys (read from ~/.config/lineage/model.env; never printed). */
  key_env?: string;
  management_key_env?: string;
  /** Alert (and top up, when enabled) when total_credits - total_usage falls below this, USD. */
  floor_usd: number;
  /** Seconds between balance checks. Default 600. */
  check_s?: number;
  topup?: {
    enabled: boolean;
    /** Only "coinbase" exists (and is gone upstream, see the header). */
    method: "coinbase";
    /** USD per purchase, 1 to 2000 (OpenRouter's documented ceiling). */
    amount_usd: number;
    /** Most USD bought per UTC day across purchases. */
    max_daily_usd: number;
    /** EVM chain the treasury pays on: 1 Ethereum, 137 Polygon, 8453 Base. */
    chain_id: 1 | 137 | 8453;
    /** Treasury wallet address that sends the payment (public). */
    sender: string;
  };
}

export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api";
export const COINBASE_MAX_USD = 2000;
const CHAINS = new Set([1, 137, 8453]);

export function parseRail(raw: { rail?: unknown; openrouter?: unknown }): { rail: RailName; openrouter: OpenRouterRailConfig | null } {
  const rail = (raw.rail ?? "anthropic") as RailName;
  if (rail !== "anthropic" && rail !== "openrouter") throw new Error('runtime config: rail is "anthropic" or "openrouter"');
  const o = raw.openrouter as OpenRouterRailConfig | undefined;
  if (o !== undefined && o !== null) {
    if (typeof o.enabled !== "boolean") throw new Error("runtime config: openrouter.enabled must be true or false");
    if (typeof o.model !== "string" || !o.model) throw new Error("runtime config: openrouter.model is required");
    if (typeof o.price_as !== "string" || !MODEL_PRICES[o.price_as]) throw new Error(`runtime config: openrouter.price_as is one of ${Object.keys(MODEL_PRICES).join(", ")}`);
    if (!(typeof o.floor_usd === "number" && o.floor_usd >= 0)) throw new Error("runtime config: openrouter.floor_usd must be a non-negative number");
    if (o.base_url !== undefined && !/^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(o.base_url)) throw new Error("runtime config: openrouter.base_url must be https (or http://127.0.0.1 for a mock)");
    const t = o.topup;
    if (t) {
      if (typeof t.enabled !== "boolean" || t.method !== "coinbase") throw new Error('runtime config: openrouter.topup needs enabled and method "coinbase"');
      if (!(t.amount_usd >= 1 && t.amount_usd <= COINBASE_MAX_USD)) throw new Error(`runtime config: openrouter.topup.amount_usd is 1 to ${COINBASE_MAX_USD}`);
      if (!(t.max_daily_usd >= t.amount_usd)) throw new Error("runtime config: openrouter.topup.max_daily_usd must be at least amount_usd");
      if (!CHAINS.has(t.chain_id)) throw new Error("runtime config: openrouter.topup.chain_id is 1 (Ethereum), 137 (Polygon) or 8453 (Base)");
      if (!/^0x[0-9a-fA-F]{40}$/.test(t.sender)) throw new Error("runtime config: openrouter.topup.sender is an EVM address");
    }
  }
  if (rail === "openrouter" && !o?.enabled) throw new Error("runtime config: rail openrouter is OFF (openrouter.enabled is false) until the owner has OpenRouter's written OK");
  return { rail, openrouter: o ?? null };
}

const keyFrom = (env: string | undefined, def: string, env_: Record<string, string | undefined>) => {
  const v = env_[env ?? def];
  if (!v) throw new Error(`no ${env ?? def} in the environment (~/.config/lineage/model.env)`);
  addSecret(v);
  return v;
};

/**
 * The model client of the configured rail for the Claude proposer. anthropic: the SDK's defaults
 * (ANTHROPIC_API_KEY). openrouter: the same SDK against OpenRouter's Anthropic-compatible endpoint.
 */
export function railClient(r: { rail: RailName; openrouter: OpenRouterRailConfig | null }, env = process.env): Anthropic | undefined {
  if (r.rail === "anthropic") return undefined;
  const o = r.openrouter!;
  if (!o.enabled) throw new Error("rail openrouter is OFF");
  return new Anthropic({ baseURL: o.base_url ?? DEFAULT_OPENROUTER_BASE, apiKey: null, authToken: keyFrom(o.key_env, "OPENROUTER_API_KEY", env) });
}

/** The per-token prices that meter this rail's model (undefined: the proposer's default). */
export const railPrices = (r: { rail: RailName; openrouter: OpenRouterRailConfig | null }) => (r.rail === "openrouter" ? MODEL_PRICES[r.openrouter!.price_as] : undefined);

/** The model the proposer asks for on this rail. */
export const railModel = (r: { rail: RailName; openrouter: OpenRouterRailConfig | null }, anthropicModel: string) =>
  r.rail === "openrouter" ? r.openrouter!.model : anthropicModel;

// ---------- balance monitor and top-up ----------

/** What OpenRouter's legacy coinbase charge returned (the shape the mock serves). */
export interface CoinbaseCharge {
  id: string;
  created_at?: string;
  expires_at?: string;
  web3_data: { transfer_intent: { metadata: { chain_id: number; contract_address: string; sender: string }; call_data: Record<string, unknown> } };
}

/**
 * Sends a charge's calldata from the treasury wallet on its chain (native token) and returns the
 * transaction hash. Not implemented against a real chain in this repository; tests use a mock.
 */
export interface TreasuryPayer {
  pay(charge: CoinbaseCharge, amountUsd: number): Promise<{ tx_hash: string }>;
}

export interface MonitorState {
  last_check_at: number | null;
  last_balance_usd: number | null;
  below_floor: boolean;
  /** set when the purchase endpoint answered 410 (gone); cleared after `retry_unavailable_ms` */
  unavailable_at: number | null;
  last_error: string | null;
  purchases: { at: number; amount_usd: number; charge_id: string; tx_hash: string | null; chain_id: number; status: "sent" | "failed"; error?: string }[];
  alerts: { at: number; msg: string }[];
}

const emptyState = (): MonitorState => ({ last_check_at: null, last_balance_usd: null, below_floor: false, unavailable_at: null, last_error: null, purchases: [], alerts: [] });

export class CreditMonitor {
  state: MonitorState;
  private readonly base: string;
  private inflight = false;
  constructor(
    private o: OpenRouterRailConfig,
    private deps: {
      statePath: string;
      env?: Record<string, string | undefined>;
      fetch?: typeof fetch;
      payer?: TreasuryPayer | null;
      now?: () => number;
      log?: (m: string) => void;
      alert?: (m: string) => void;
      /** how long a 410 keeps purchases off; default one day */
      retryUnavailableMs?: number;
    },
  ) {
    this.base = (o.base_url ?? DEFAULT_OPENROUTER_BASE).replace(/\/+$/, "");
    this.state = existsSync(deps.statePath) ? { ...emptyState(), ...JSON.parse(readFileSync(deps.statePath, "utf8")) } : emptyState();
  }

  private now = () => (this.deps.now ?? Date.now)();
  private log = (m: string) => this.deps.log?.(m);
  private save() {
    mkdirSync(dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.deps.statePath);
  }
  private raise(msg: string) {
    this.state.alerts.push({ at: this.now(), msg });
    if (this.state.alerts.length > 50) this.state.alerts.splice(0, this.state.alerts.length - 50);
    this.log(`ALERT ${msg}`);
    this.deps.alert?.(msg);
  }
  private f() {
    return this.deps.fetch ?? fetch;
  }
  private mgmt() {
    return keyFrom(this.o.management_key_env, "OPENROUTER_MANAGEMENT_KEY", this.deps.env ?? process.env);
  }

  /** GET /v1/credits: total_credits - total_usage, USD. */
  async balance(): Promise<number> {
    const r = await this.f()(`${this.base}/v1/credits`, { headers: { authorization: `Bearer ${this.mgmt()}` } });
    if (!r.ok) throw new Error(`GET /credits: HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } };
    const c = j.data?.total_credits, u = j.data?.total_usage;
    if (typeof c !== "number" || typeof u !== "number" || !Number.isFinite(c) || !Number.isFinite(u)) throw new Error("GET /credits: unexpected body");
    return c - u;
  }

  private boughtToday(): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.state.purchases.filter((p) => p.status === "sent" && new Date(p.at).toISOString().slice(0, 10) === day).reduce((s, p) => s + p.amount_usd, 0);
  }

  /** One check: reads the balance, alerts on crossing the floor, and buys when the top-up is enabled and allowed. */
  async tick(): Promise<{ balance: number | null; action: "none" | "alert" | "purchased" | "unavailable" | "capped" | "error" | "disabled" }> {
    if (this.inflight) return { balance: this.state.last_balance_usd, action: "none" };
    this.inflight = true;
    try {
      let bal: number;
      try {
        bal = await this.balance();
      } catch (e) {
        this.state.last_error = (e as Error).message;
        this.save();
        return { balance: null, action: "error" };
      }
      this.state.last_check_at = this.now();
      this.state.last_balance_usd = bal;
      this.state.last_error = null;
      const below = bal < this.o.floor_usd;
      const crossed = below && !this.state.below_floor;
      this.state.below_floor = below;
      if (!below) {
        this.save();
        return { balance: bal, action: "none" };
      }
      if (crossed) this.raise(`OpenRouter balance ${bal.toFixed(2)} USD is below the floor ${this.o.floor_usd} USD`);
      const t = this.o.topup;
      if (!t?.enabled) {
        this.save();
        return { balance: bal, action: crossed ? "alert" : "disabled" };
      }
      const retry = this.deps.retryUnavailableMs ?? 86_400_000;
      if (this.state.unavailable_at !== null && this.now() - this.state.unavailable_at < retry) {
        this.save();
        return { balance: bal, action: "unavailable" };
      }
      if (this.boughtToday() + t.amount_usd > t.max_daily_usd) {
        if (crossed) this.raise(`top-up skipped: today's purchases would exceed max_daily_usd ${t.max_daily_usd}`);
        this.save();
        return { balance: bal, action: "capped" };
      }
      return { balance: bal, action: await this.purchase(t) };
    } finally {
      this.inflight = false;
    }
  }

  private async purchase(t: NonNullable<OpenRouterRailConfig["topup"]>): Promise<"purchased" | "unavailable" | "error"> {
    const r = await this.f()(`${this.base}/v1/credits/coinbase`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.mgmt()}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: t.amount_usd, sender: t.sender, chain_id: t.chain_id }),
    });
    if (r.status === 410) {
      this.state.unavailable_at = this.now();
      this.raise("OpenRouter's crypto purchase API is gone (HTTP 410: Coinbase Commerce deprecated); top up on the web credits page, https://openrouter.ai/settings/credits");
      this.save();
      return "unavailable";
    }
    if (!r.ok) {
      this.state.last_error = `POST /credits/coinbase: HTTP ${r.status}`;
      this.save();
      return "error";
    }
    const j = (await r.json()) as { data?: CoinbaseCharge };
    const charge = j.data;
    const meta = charge?.web3_data?.transfer_intent?.metadata;
    if (!charge?.id || !meta || meta.chain_id !== t.chain_id || String(meta.sender).toLowerCase() !== t.sender.toLowerCase() || !charge.web3_data.transfer_intent.call_data) {
      this.state.last_error = "coinbase charge does not match the request (chain, sender or calldata)";
      this.raise(this.state.last_error);
      this.save();
      return "error";
    }
    if (!this.deps.payer) {
      this.state.purchases.push({ at: this.now(), amount_usd: t.amount_usd, charge_id: charge.id, tx_hash: null, chain_id: t.chain_id, status: "failed", error: "no treasury payer configured" });
      this.raise(`charge ${charge.id} created but no treasury payer is configured; nothing was sent`);
      this.save();
      return "error";
    }
    try {
      const { tx_hash } = await this.deps.payer.pay(charge, t.amount_usd);
      this.state.purchases.push({ at: this.now(), amount_usd: t.amount_usd, charge_id: charge.id, tx_hash, chain_id: t.chain_id, status: "sent" });
      this.log(`top-up ${t.amount_usd} USD: charge ${charge.id}, tx ${tx_hash} on chain ${t.chain_id}`);
      this.save();
      return "purchased";
    } catch (e) {
      this.state.purchases.push({ at: this.now(), amount_usd: t.amount_usd, charge_id: charge.id, tx_hash: null, chain_id: t.chain_id, status: "failed", error: (e as Error).message });
      this.raise(`payment for charge ${charge.id} failed: ${(e as Error).message}`);
      this.save();
      return "error";
    }
  }

  /** Runs `tick` every `check_s` until the returned stop function is called. */
  start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (stopped) return;
      await this.tick().catch((e) => this.log(`credit monitor: ${(e as Error).message}`));
      if (!stopped) timer = setTimeout(loop, (this.o.check_s ?? 600) * 1000);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}

export const monitorStatePath = (stateDir: string) => join(stateDir, "credit-rail.json");

/** Logs a warning when Core's published prepay prices differ from this runtime's (plan C: the launch form budgets with Core's). */
export async function checkCorePrices(core: string, cfg: { compute_price_line_per_usd: string; compute_price_line_per_sandbox_s: string; sandbox_reserve_s: number; attempt_max_usd: number },
  log: (m: string) => void, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${core.replace(/\/+$/, "")}/v1/config`);
    const p = ((await r.json()) as { network?: { prepay?: Record<string, unknown> | null } }).network?.prepay;
    if (!p) return true;
    const diff = (["compute_price_line_per_usd", "compute_price_line_per_sandbox_s", "sandbox_reserve_s", "attempt_max_usd"] as const).filter((k) => String(p[k]) !== String(cfg[k]));
    if (diff.length) log(`WARNING Core's prepay config publishes ${diff.map((k) => `${k} ${String(p[k])}`).join(", ")} but this runtime uses ${diff.map((k) => String(cfg[k])).join(", ")}: the launch form's first-run budget is off`);
    return diff.length === 0;
  } catch (e) {
    log(`Core's prepay config not read: ${(e as Error).message}`);
    return false;
  }
}
