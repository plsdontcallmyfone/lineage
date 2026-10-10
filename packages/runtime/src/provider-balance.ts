// OpenRouter balance monitor for routed models (plan MODELS-AND-SELF-FUNDING). OpenRouter is
// prepaid: when its credits cannot cover a request it answers 402. The runtime reads the balance at
// an interval and lets an attempt, post or analysis on an OpenRouter-routed model start only when
// the known balance covers its reserve plus every running OpenRouter reserve, so nothing fails
// mid-attempt for lack of credits. Read 2026-10-10:
//   GET https://openrouter.ai/api/v1/credits   (management key) -> { data: { total_credits, total_usage } }
//   GET https://openrouter.ai/api/v1/key       (inference key)  -> { data: { limit_remaining (null: no limit), usage, ... } }
// When /credits refuses the inference key and the key has no credit limit, the balance is unknown: attempts run and a
// 402 marks the balance low at once. Treasury top-ups are manual (USDC or card on the credits page,
// or card auto top-up); there is no crypto top-up API.

export interface BalanceState {
  usd: number | null;
  source: "credits" | "key_limit" | "unknown" | "402" | null;
  read_at: number | null;
  error: string | null;
  floor_usd: number;
}

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

export class OpenRouterBalance {
  state: BalanceState;
  private readAt = 0;
  constructor(
    private o: { keys: Record<string, string>; floor_usd: number; check_s?: number; base?: string; fetch?: typeof fetch; now?: () => number; log?: (m: string) => void },
  ) {
    this.state = { usd: null, source: null, read_at: null, error: null, floor_usd: o.floor_usd };
  }

  private now = () => (this.o.now ?? Date.now)();

  /** True when an inference key is configured (the route exists at all). */
  get configured(): boolean {
    return !!this.o.keys.openrouter;
  }

  private async get(path: string, key: string): Promise<Record<string, unknown>> {
    const r = await (this.o.fetch ?? fetch)(`${(this.o.base ?? OPENROUTER_API).replace(/\/+$/, "")}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    const j = (await r.json()) as { data?: Record<string, unknown> };
    if (!j?.data || typeof j.data !== "object") throw new Error(`GET ${path}: unexpected body`);
    return j.data;
  }

  /** One reading (at most every check_s unless forced). Never throws. */
  async refresh(force = false): Promise<BalanceState> {
    const now = this.now();
    if (!this.configured) return this.state;
    if (!force && now - this.readAt < (this.o.check_s ?? 300) * 1000) return this.state;
    this.readAt = now;
    const before = this.state.usd;
    try {
      // /credits is documented for management keys; on 2026-10-10 it also answered the inference key, so
      // that is tried first and /key (the key's own limit) is the fallback
      const mgmt = this.o.keys["openrouter-management"];
      const credits = await this.get("/credits", mgmt ?? this.o.keys.openrouter!).then(
        (d) => {
          const c = d.total_credits, u = d.total_usage;
          if (typeof c !== "number" || typeof u !== "number" || !Number.isFinite(c) || !Number.isFinite(u)) throw new Error("GET /credits: unexpected body");
          return c - u;
        },
      ).catch((e) => {
        if (mgmt) throw e;
        return null;
      });
      if (credits !== null) this.state = { ...this.state, usd: credits, source: "credits", read_at: now, error: null };
      else {
        const d = await this.get("/key", this.o.keys.openrouter!);
        const rem = d.limit_remaining;
        if (rem === null || rem === undefined) this.state = { ...this.state, usd: null, source: "unknown", read_at: now, error: null };
        else if (typeof rem === "number" && Number.isFinite(rem)) this.state = { ...this.state, usd: rem, source: "key_limit", read_at: now, error: null };
        else throw new Error("GET /key: unexpected limit_remaining");
      }
    } catch (e) {
      this.state = { ...this.state, error: (e as Error).message };
    }
    const after = this.state.usd;
    if (after !== null && after < this.o.floor_usd && (before === null || before >= this.o.floor_usd)) this.o.log?.(`OpenRouter balance ${after.toFixed(2)} USD is below the floor ${this.o.floor_usd} USD (top up by USDC or card on openrouter.ai/settings/credits)`);
    return this.state;
  }

  /** OpenRouter answered 402 (credits cannot cover a request): treat the balance as empty until the next good reading. */
  markNoCredits(): void {
    this.state = { ...this.state, usd: 0, source: "402", read_at: this.now(), error: "OpenRouter answered 402: credits cannot cover the request" };
    this.readAt = 0; // read again at the next refresh
    this.o.log?.("OpenRouter answered 402: OpenRouter-routed attempts wait until its balance is topped up");
  }

  /** USD the balance can cover now, or null when unknown (no reading, or a key without a limit). */
  room(): number | null {
    return this.configured && typeof this.state.usd === "number" ? this.state.usd : null;
  }
}
