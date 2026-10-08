// Soul drafts for the Wallet page's launch step (SPEC 14.8), server side. The launcher types a short
// seed; this service expands it with Claude using the operator's model key, under a per-soul cap, a
// daily cap and a per-address rate limit, and returns the draft. It holds no user key and stores no
// soul: the page signs the document with the agent key it made and publishes it through
// `/souls/publish`, which forwards to Core's self-authenticating `PUT /v1/agents/:id/soul`.
// Every cap is a TEST value until the owner sets launch values (SPEC 20).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { anthropicClient, generateSoul, loadModelKey, type ModelClient, type SoulSeed } from "@lineage/souls";

export interface SoulDraftsOptions {
  /** USD cap of one soul (all calls) */
  perSoulUsd?: number;
  /** USD a UTC day may spend across all drafts */
  dailyUsd?: number;
  /** drafts per address per hour */
  perHour?: number;
  stateFile?: string;
  client?: ModelClient | null;
  now?: () => number;
}

export class SoulDrafts {
  readonly perSoulUsd: number;
  readonly dailyUsd: number;
  readonly perHour: number;
  private readonly stateFile: string;
  private client: ModelClient | null | undefined;
  private readonly now: () => number;
  private readonly recent = new Map<string, number[]>();
  private busy = 0;

  constructor(o: SoulDraftsOptions = {}) {
    this.perSoulUsd = o.perSoulUsd ?? 0.4;
    this.dailyUsd = o.dailyUsd ?? 2;
    this.perHour = o.perHour ?? 3;
    this.stateFile = o.stateFile ?? join(homedir(), ".lineage", "web", "soul-drafts.jsonl");
    this.client = o.client;
    this.now = o.now ?? (() => Date.now());
  }

  private async model(): Promise<ModelClient | null> {
    if (this.client === undefined) this.client = await loadModelKey().then(anthropicClient).catch(() => null);
    return this.client;
  }

  /** USD spent today (UTC), from the append-only log. */
  spentToday(): number {
    if (!existsSync(this.stateFile)) return 0;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return readFileSync(this.stateFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => String(e.at).startsWith(day)).reduce((a, e) => a + Number(e.usd ?? 0), 0);
  }

  async info() {
    const enabled = !!(await this.model());
    return { enabled, per_soul_usd: this.perSoulUsd, daily_usd: this.dailyUsd, spent_today_usd: Number(this.spentToday().toFixed(4)), per_hour: this.perHour, test_values: true };
  }

  async draft(body: unknown, who: string): Promise<{ status: number; body: unknown }> {
    const b = (body ?? {}) as { seed?: SoulSeed; agent?: string; repo?: string | null; avoid?: string[] };
    if (typeof b.agent !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.agent)) return { status: 400, body: { error: "bad_agent", message: "agent must be the base58 agent key made in the page" } };
    const client = await this.model();
    if (!client) return { status: 503, body: { error: "disabled", message: "soul generation is not configured on this server (no model key)" } };
    const t = this.now();
    const mine = (this.recent.get(who) ?? []).filter((x) => t - x < 3_600_000);
    if (mine.length >= this.perHour) return { status: 429, body: { error: "rate", message: `at most ${this.perHour} drafts per hour per address` } };
    if (this.spentToday() + this.perSoulUsd > this.dailyUsd) return { status: 429, body: { error: "daily_cap", message: "today's soul generation budget is spent; write the soul by hand or try tomorrow" } };
    if (this.busy >= 2) return { status: 429, body: { error: "busy", message: "two drafts are already running; try again in a minute" } };
    mine.push(t);
    this.recent.set(who, mine);
    this.busy++;
    try {
      const r = await generateSoul({ seed: b.seed as SoulSeed, agent: b.agent, repo: typeof b.repo === "string" ? b.repo : null, client, maxUsd: this.perSoulUsd, avoidNames: Array.isArray(b.avoid) ? b.avoid.slice(0, 20).map(String) : [] });
      mkdirSync(dirname(this.stateFile), { recursive: true });
      appendFileSync(this.stateFile, JSON.stringify({ at: new Date(this.now()).toISOString(), agent: b.agent, usd: r.usage.usd, calls: r.usage.calls, ok: !!r.doc }) + "\n");
      if (!r.doc) return { status: 422, body: { error: "no_soul", problems: r.problems, usd: r.usage.usd } };
      return { status: 200, body: { doc: r.doc, usd: Number(r.usage.usd.toFixed(4)), calls: r.usage.calls, model: r.usage.models.at(-1) ?? null } };
    } finally {
      this.busy--;
    }
  }
}

/** Forwards a signed soul version to Core (PUT /v1/agents/:id/soul needs no request signature). */
export async function publishSoul(core: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const b = (body ?? {}) as { doc?: { agent?: unknown } };
  const agent = typeof b.doc?.agent === "string" ? b.doc.agent : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent)) return { status: 400, body: { error: "bad_soul", message: "doc.agent missing" } };
  try {
    const r = await fetch(`${core}/v1/agents/${agent}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) {
    return { status: 502, body: { error: "core_unreachable", message: (e as Error).message } };
  }
}

