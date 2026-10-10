// Model registry (plan M, SPEC 17.4): which providers and models a launched agent may pick, and the
// per-token prices its compute vault is metered at. Pure data and checks: no I/O, so Core, the hosted
// runtime, the worker's adapters and the Wallet page bundle all share it.
//
// Every price is USD per 1M tokens as read from the provider's own pricing page on `read_on`. The
// registry is admin-editable (Core: POST /v1/admin/models); `config/models.json` is the seed.
//
// What a price can and cannot be:
//   - DeepSeek publishes a UTC clock: `peak` holds the other rate and the UTC weekday windows it applies
//     in, and metering picks the rate by the response time. A single scalar would be wrong half the day.
//   - A provider's own discount label (MiniMax) stays on the entry as `note`; the rate is what is charged.
//   - Meta publishes no first-party per-token Llama price: `status: "no_price"`, never a host's price
//     dressed up as Meta's. Such an entry cannot be picked.
//   - Input-length tiers (Alibaba, Google): `tiers` by prompt tokens; the base price is the first tier.

export const REGISTRY_V = 1 as const;

/** USD per 1M tokens. `cached_input` is the cache-hit (read) rate; `cache_write` an explicit cache write rate. */
export interface Rate {
  input: number;
  output: number;
  cached_input?: number | null;
  cache_write?: number | null;
}

export interface PeakWindow {
  /** UTC days, 0 Sunday to 6 Saturday */
  days: number[];
  /** "HH:MM" UTC, start inclusive, end exclusive */
  start: string;
  end: string;
}

export interface ModelEntry {
  /** API model id sent to the provider */
  id: string;
  provider: string;
  /** display name */
  name: string;
  /** "verified": priced from the provider's page on read_on; "no_price": none published (cannot be picked) */
  status: "verified" | "no_price";
  rate: Rate | null;
  /** the rate in force inside the UTC windows (DeepSeek's peak) */
  peak?: { rate: Rate; windows: PeakWindow[] } | null;
  /** rates by prompt size: the first tier whose up_to_input_tokens >= the prompt applies; over all tiers, the last */
  tiers?: { up_to_input_tokens: number; rate: Rate }[] | null;
  /** caveat shown with the price, in the provider's terms */
  note?: string | null;
  /** off: listed but not offered at launch */
  enabled?: boolean;
}

export interface ProviderEntry {
  id: string;
  name: string;
  /** "anthropic": the native tool loop; "openai": the OpenAI-compatible chat completions adapter; "none": no API adapter */
  adapter: "anthropic" | "openai" | "none";
  /** where the prices were read, and the day */
  pricing_url: string;
  read_on: string;
  /** whether the page itself prints a last-updated date (and which) */
  page_dated?: string | null;
  note?: string | null;
}

export interface ModelRegistry {
  v: typeof REGISTRY_V;
  /** the model an agent without a choice in its profile runs */
  default: { provider: string; id: string };
  providers: ProviderEntry[];
  models: ModelEntry[];
}

/** What an agent's profile records (soul `model`), and what provenance attests. */
export interface ModelChoice {
  provider: string;
  id: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const PROV = /^[a-z][a-z0-9-]{1,31}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function validChoice(c: unknown): c is ModelChoice {
  return !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 2 && PROV.test((c as ModelChoice).provider) && typeof (c as ModelChoice).id === "string" && ID.test((c as ModelChoice).id);
}

function checkRate(errs: string[], path: string, r: unknown): void {
  if (!r || typeof r !== "object") return void errs.push(`${path}: an object`);
  const x = r as Record<string, unknown>;
  for (const k of ["input", "output"]) if (!(typeof x[k] === "number" && Number.isFinite(x[k]) && (x[k] as number) > 0 && (x[k] as number) < 10_000)) errs.push(`${path}.${k}: a positive number of USD per 1M tokens`);
  for (const k of ["cached_input", "cache_write"])
    if (x[k] !== undefined && x[k] !== null && !(typeof x[k] === "number" && Number.isFinite(x[k]) && (x[k] as number) > 0 && (x[k] as number) < 10_000)) errs.push(`${path}.${k}: a positive number or null`);
}

/** Structural problems of a registry; empty when it may be stored and used. */
export function checkRegistry(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") return ["registry: an object"];
  const r = raw as ModelRegistry;
  if (r.v !== REGISTRY_V) errs.push(`registry.v: must be ${REGISTRY_V}`);
  if (!Array.isArray(r.providers) || r.providers.length === 0 || r.providers.length > 32) return [...errs, "registry.providers: 1 to 32 entries"];
  if (!Array.isArray(r.models) || r.models.length === 0 || r.models.length > 200) return [...errs, "registry.models: 1 to 200 entries"];
  const provs = new Map<string, ProviderEntry>();
  r.providers.forEach((p, i) => {
    const path = `providers[${i}]`;
    if (!p || typeof p.id !== "string" || !PROV.test(p.id)) return void errs.push(`${path}.id: lowercase id`);
    if (provs.has(p.id)) errs.push(`${path}.id: duplicate ${p.id}`);
    provs.set(p.id, p);
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 40) errs.push(`${path}.name: 1 to 40 characters`);
    if (!["anthropic", "openai", "none"].includes(p.adapter)) errs.push(`${path}.adapter: anthropic, openai or none`);
    if (typeof p.pricing_url !== "string" || !/^https:\/\/\S{3,300}$/.test(p.pricing_url)) errs.push(`${path}.pricing_url: an https URL`);
    if (typeof p.read_on !== "string" || !DAY.test(p.read_on)) errs.push(`${path}.read_on: YYYY-MM-DD`);
  });
  const seen = new Set<string>();
  r.models.forEach((m, i) => {
    const path = `models[${i}]`;
    if (!m || typeof m.id !== "string" || !ID.test(m.id)) return void errs.push(`${path}.id: a model id`);
    if (!provs.has(m.provider)) errs.push(`${path}.provider: ${String(m.provider)} is not a listed provider`);
    const key = `${m.provider}/${m.id}`;
    if (seen.has(key)) errs.push(`${path}: duplicate ${key}`);
    seen.add(key);
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 60) errs.push(`${path}.name: 1 to 60 characters`);
    if (m.status === "verified") checkRate(errs, `${path}.rate`, m.rate);
    else if (m.status === "no_price") {
      if (m.rate !== null) errs.push(`${path}.rate: null when no price is published`);
    } else errs.push(`${path}.status: verified or no_price`);
    if (m.peak) {
      checkRate(errs, `${path}.peak.rate`, m.peak.rate);
      if (!Array.isArray(m.peak.windows) || m.peak.windows.length === 0) errs.push(`${path}.peak.windows: at least one`);
      else
        m.peak.windows.forEach((w, j) => {
          if (!Array.isArray(w.days) || !w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) errs.push(`${path}.peak.windows[${j}].days: 0..6`);
          if (!HHMM.test(w.start) || !HHMM.test(w.end) || w.start >= w.end) errs.push(`${path}.peak.windows[${j}]: start < end, HH:MM UTC`);
        });
    }
    if (m.tiers) {
      if (!Array.isArray(m.tiers) || m.tiers.length === 0) errs.push(`${path}.tiers: a non-empty list or null`);
      else {
        let prev = 0;
        m.tiers.forEach((t, j) => {
          if (!(Number.isInteger(t.up_to_input_tokens) && t.up_to_input_tokens > prev)) errs.push(`${path}.tiers[${j}].up_to_input_tokens: increasing integers`);
          prev = t.up_to_input_tokens;
          checkRate(errs, `${path}.tiers[${j}].rate`, t.rate);
        });
      }
    }
    if (m.note !== undefined && m.note !== null && (typeof m.note !== "string" || m.note.length > 400 || /\u2014/.test(m.note))) errs.push(`${path}.note: up to 400 characters, no em dashes`);
  });
  if (!validChoice(r.default)) errs.push("registry.default: { provider, id }");
  else {
    const d = findModel(r, r.default);
    if (!d || d.status !== "verified") errs.push("registry.default: a priced model in the registry");
  }
  return errs;
}

export function findModel(r: ModelRegistry, c: ModelChoice): ModelEntry | null {
  return r.models.find((m) => m.provider === c.provider && m.id === c.id) ?? null;
}

export function findProvider(r: ModelRegistry, id: string): ProviderEntry | null {
  return r.providers.find((p) => p.id === id) ?? null;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** True when `at` falls inside one of the UTC windows. */
export function inWindows(windows: PeakWindow[], at: Date): boolean {
  const day = at.getUTCDay();
  const m = at.getUTCHours() * 60 + at.getUTCMinutes();
  return windows.some((w) => w.days.includes(day) && m >= minutes(w.start) && m < minutes(w.end));
}

/** The rate a response is charged at: peak by the clock, then the input-length tier. Null: no price. */
export function rateFor(m: ModelEntry, at: Date, promptTokens: number): Rate | null {
  if (m.status !== "verified" || !m.rate) return null;
  if (m.peak && inWindows(m.peak.windows, at)) return m.peak.rate;
  if (m.tiers?.length) return (m.tiers.find((t) => promptTokens <= t.up_to_input_tokens) ?? m.tiers[m.tiers.length - 1]!).rate;
  return m.rate;
}

export interface TokenUsage {
  /** prompt tokens billed at the full input rate (cache misses) */
  input_tokens: number;
  output_tokens: number;
  /** prompt tokens served from the provider's cache */
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** USD for one response at `rate`; a cache read without a published cache rate is charged at the input rate. */
export function usdFor(rate: Rate, u: TokenUsage): number {
  return (
    (u.input_tokens * rate.input +
      u.output_tokens * rate.output +
      u.cache_read_tokens * (rate.cached_input ?? rate.input) +
      u.cache_write_tokens * (rate.cache_write ?? rate.input)) /
    1e6
  );
}

/** Availability as the runtime reports it: which providers have a key on the host (never the keys). */
export interface Availability {
  providers: Record<string, boolean>;
  reported_at: number | null;
  by: string | null;
}

/** Whether a model can be picked at launch, with the reason when not. */
export function pickable(r: ModelRegistry, m: ModelEntry, avail: Availability): { ok: boolean; why: string | null } {
  const p = findProvider(r, m.provider);
  if (!p || p.adapter === "none") return { ok: false, why: "no first-party API this network can call" };
  if (m.status !== "verified") return { ok: false, why: "no first-party per-token price published" };
  if (m.enabled === false) return { ok: false, why: "not offered" };
  if (!avail.providers[m.provider]) return { ok: false, why: "no key on the hosted runtime" };
  return { ok: true, why: null };
}
