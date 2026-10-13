// Prepaid credits at launch (plan C, owner decision 2026-10-09): the deposit step of the launch form.
// The launch transaction carries launch_agent, a UNITS deposit into the new compute vault and
// refresh_awake, so the agent wakes at once. Every figure here comes from Core's network config
// (`prepay`: minimum, default, the TEST dollar rate, the runtime's published compute prices) or from
// chain (wake_threshold, the wallet's UNITS, the frozen lookup table a v0 launch reads); none is
// invented. lineage_launch does not enforce the minimum, so this form refuses a smaller deposit and
// Core keeps an underfunded agent asleep (packages/core/src/prepay.ts).
// Owner direction 2026-10-11: the credits are typed in USD (at least Core's min_usd, more allowed) on
// every network, converted at prepay.line_per_usd, and paid in SOL with the launch (fronting.ts).
// Owner 2026-10-12: where Core's prepay.rate_source is "market" (the official deployment) the coin
// amount is the dollar figure at the coin's live market price, the page's one USD reading (src/usd.ts,
// GET /market/quote-usd), read again right before the launch is built; the rule is credits-rate.ts.
import { fmtUsd } from "../src/usd.ts";
import {
  cmpDec,
  decodeLookupTable,
  launchTableAddresses,
  parsePrepayConfig,
  usdToBase,
  type LookupTable,
  type PrepayConfig,
} from "../../../packages/chain/src/browser/index.ts";
import { html, type Raw } from "../src/html.ts";
import { rpc, units, usym } from "./chain.ts";
import { creditsFor, currentRate, marketMode, RateBlocked, rateLine, rereadRate } from "./credits-rate.ts";
import { marketRate } from "../../../packages/chain/src/browser/index.ts";

export const P = {
  cfg: null as PrepayConfig | null,
  err: null as string | null,
  /** the frozen launch lookup table, checked against launchTableAddresses; null when absent or wrong */
  table: null as LookupTable | null,
  tableNote: "" as string,
  /** market rate: the reading the built launch's deposit was computed from, and when this page took it (ms) */
  built: null as { usd: string; base: bigint; price: number; read_at: number; age_s: number; at: number } | null,
};

/** Reads Core's prepay config and the launch lookup table (devnet.json `launch_lookup_table`), checking the table is frozen with the expected content. */
export async function loadPrepay(state: { line_mint: string; line_token_program: string; launch_lookup_table?: unknown; line_pool?: { pool: string; baseVault: string; quoteVault: string } }) {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error(`Core /v1/config: HTTP ${r.status}`);
    const j = (await r.json()) as { network?: { prepay?: unknown } };
    if (!j.network?.prepay) throw new Error("Core's network config has no prepay block");
    P.cfg = parsePrepayConfig(j.network.prepay);
    P.err = null;
  } catch (e) {
    P.cfg = null;
    P.err = (e as Error).message;
  }
  P.table = null;
  const at = typeof state.launch_lookup_table === "string" ? state.launch_lookup_table : null;
  if (!at) {
    P.tableNote = "no launch lookup table on this server";
    return;
  }
  try {
    const acc = await rpc.getAccountInfo(at);
    if (!acc) throw new Error("not found on chain");
    const t = decodeLookupTable(acc.data);
    const want = launchTableAddresses({ lineMint: state.line_mint, lineTokenProgram: state.line_token_program, linePool: state.line_pool });
    if (t.authority !== null) throw new Error("not frozen");
    if (t.addresses.length !== want.length || t.addresses.some((a, i) => a !== want[i])) throw new Error("content differs from the expected launch accounts");
    P.table = { address: at, addresses: t.addresses };
    P.tableNote = "";
  } catch (e) {
    P.tableNote = `lookup table ${at} refused: ${(e as Error).message}`;
  }
}

/** Credits are typed in USD on every network (owner direction 2026-10-11) and converted at Core's prepay.line_per_usd. */
export const usdMode = () => true;

export function prepayFieldset(): Raw {
  return html`<fieldset><legend class="eyebrow">Model credits</legend>
      <label><span class="eyebrow">Credits (USD)</span><input name="l_deposit" inputmode="decimal" autocomplete="off" placeholder="10"><span class="wl-help" id="w-prepay">Reading the credits minimum from Core…</span></label>
    </fieldset>`;
}

/** The deposit as text for review rows. */
export function depositNote(typed: string): string {
  return fmtUsd(Number(depositUsd(typed)));
}

/**
 * How many agents the launch declares (swarm-step.ts; 1 unless swarms are on and a larger size is
 * picked). The credits minimum is Core's own minimum once per agent (docs/plans/SWARMS.md 4).
 */
export const SEATS = { n: 1 };

/** Core's credits minimum for the launch as filled: prepay.min_usd times the number of agents, as an exact decimal. */
export function minUsd(): string {
  const min = P.cfg?.min_usd ?? "";
  if (SEATS.n <= 1 || !/^\d+(\.\d+)?$/.test(min)) return min;
  const [i, f = ""] = min.split(".");
  const total = (BigInt(i! + f) * BigInt(SEATS.n)).toString().padStart(f.length + 1, "0");
  return f.length ? `${total.slice(0, -f.length)}.${total.slice(-f.length)}`.replace(/\.?0+$/, "") : total;
}

/** The credits in USD as typed (empty: Core's minimum). The launcher may enter more than the minimum. */
export function depositUsd(typed: string): string {
  return typed.trim() || (P.cfg ? minUsd() : "");
}

/** Validates the typed credits; returns the $UNITS base units the vault receives, or throws a message for the form. */
export function depositBase(typed: string, decimals: number): bigint {
  if (!P.cfg) throw new Error(`Model credits: Core's prepay config is not available (${P.err ?? "not loaded"}); a launch needs it for the minimum and the rate.`);
  const usd = depositUsd(typed);
  if (!/^\d+(\.\d{1,2})?$/.test(usd)) throw new Error("Model credits: a dollar amount such as 10 or 12.50.");
  if (cmpDec(usd, minUsd()) < 0) throw new Error(`Model credits: at least ${fmtUsd(Number(minUsd()))}${SEATS.n > 1 ? ` (${fmtUsd(Number(P.cfg.min_usd))} for each of the ${SEATS.n} agents)` : ""}.`);
  // the configured rate, or (market rate) the live reading: refused with "Launch disabled: <why>." while there is no usable one
  return marketMode(P.cfg) ? creditsFor(P.cfg, usd, decimals, usym()).base : usdToBase(usd, P.cfg.line_per_usd, decimals);
}

// ---------- the market rate (credits-rate.ts) ----------

let rateWasBlocked = false;
/** Market rate: asks the price again and says why a launch cannot be built now (one plain clause), or null. Null at the configured rate. */
export async function rateBlockedNow(): Promise<string | null> {
  if (!P.cfg || !marketMode(P.cfg)) return null;
  await rereadRate();
  const r = currentRate(P.cfg, usym());
  rateWasBlocked = !r.ok;
  return r.ok ? null : r.reason;
}
/** The same reason as the wizard's "cannot launch yet" line. */
export const rateBlockedBox = (why: string): Raw => html`<div class="panel-b"><div class="wl-fine" data-credits-blocked><span class="mark warn">Launch disabled: ${why}.</span></div></div>`;

/** The timer's read: true when a usable price is back after a refusal (the launch can be built again). */
export async function tickRate(): Promise<boolean> {
  const was = rateWasBlocked;
  return (await rateBlockedNow()) === null && was;
}

/**
 * The deposit for the launch being built. Market rate: the price is asked again first (a held reading
 * counts for a few seconds), so the amount signed is from the newest reading the indexer has, and the
 * reading is remembered with the built launch. Throws the bare reason when there is none.
 */
export async function depositForBuild(typed: string, decimals: number): Promise<bigint> {
  P.built = null;
  if (!P.cfg || !marketMode(P.cfg)) return depositBase(typed, decimals);
  depositBase(typed, decimals); // the typed amount's own refusals first
  await rereadRate();
  try {
    const usd = depositUsd(typed);
    const r = creditsFor(P.cfg, usd, decimals, usym());
    P.built = { usd, base: r.base, price: r.rate!.usd, read_at: r.rate!.read_at, age_s: r.rate!.age_s, at: Date.now() };
    return r.base;
  } catch (e) {
    throw e instanceof RateBlocked ? new Error(e.reason) : e;
  }
}

const builtAge = () => (P.built ? P.built.age_s + (Date.now() - P.built.at) / 1000 : null);
/** Market rate: whether the built launch's reading is now older than Core allows (the launch is then built again before anything is signed). */
export function builtRateStale(): boolean {
  const m = marketRate(P.cfg);
  if (!m) return false;
  const age = builtAge();
  return age === null || age > m.maxAgeS;
}
export const RATE_REBUILT = "The price was read again and the launch rebuilt at it. Check the amounts, then press Launch.";

const rateSpan = (text: string, d: { price: number; read_at: number; base: bigint }, built = false): Raw =>
  html`<span class="dim" ${built ? "data-credits-built" : "data-credits-rate"} data-usd="${String(d.price)}" data-read-at="${String(d.read_at)}" data-base="${d.base.toString()}">${text}</span>`;

/** Funding and Review, market rate: the rate and the reading's age for the typed credits ("" at the configured rate or while refused). */
export function rateNote(typed: string, decimals: number): Raw | string {
  if (!P.cfg || !marketMode(P.cfg)) return "";
  try {
    depositBase(typed, decimals);
    const usd = depositUsd(typed);
    const r = creditsFor(P.cfg, usd, decimals, usym());
    return rateSpan(rateLine({ usd, base: r.base, rate: r.rate!, symbol: usym(), amount: units(r.base, decimals) }), { price: r.rate!.usd, read_at: r.rate!.read_at, base: r.base });
  } catch {
    return "";
  }
}
/** Review, market rate: the same line for the amount in the built transactions. */
export function builtRateNote(decimals: number): Raw | string {
  const b = P.built;
  if (!b || !marketMode(P.cfg)) return "";
  return rateSpan(rateLine({ usd: b.usd, base: b.base, rate: { usd: b.price, age_s: builtAge()! }, symbol: usym(), amount: units(b.base, decimals) }), { price: b.price, read_at: b.read_at, base: b.base }, true);
}

/** The one help line under the credits input. */
export function prepayHelp(typed: string, o: { decimals: number }): Raw {
  if (!P.cfg) return html`<span class="mark warn">Launch disabled: Core's credits config is not available.</span>`;
  try {
    depositBase(typed, o.decimals);
  } catch (e) {
    return html`<span class="mark warn">${(e as Error).message}</span>`;
  }
  const rate = rateNote(typed, o.decimals);
  return html`At least ${fmtUsd(Number(minUsd()))}${SEATS.n > 1 ? ` (${fmtUsd(Number(P.cfg.min_usd))} for each of the ${SEATS.n} agents)` : ""}; you can add more. Paid in SOL with the launch.${rate ? html`<br>${rate}.` : ""}`;
}

/** After a launch: waits for Core's chain sync to record the deposit, then shows Core's check and its awake flag. */
export async function showCorePrepay(agent: string, decimals: number, put: (r: Raw) => void, tries = 36, everyMs = 5000) {
  for (let i = 0; i < tries; i++) {
    try {
      const [p, a] = await Promise.all([
        // ?optional=1: before Core's chain sync the agent is unknown (404), answered as a miss, not a failed request
        fetch(`/api/agents/${agent}/prepay?optional=1`).then((r) => (r.ok ? r.json() : null)).then((j) => (j?._miss ? null : j)),
        fetch(`/api/agents/${agent}?optional=1`).then((r) => (r.ok ? r.json() : null)).then((j) => (j?._miss ? null : j)),
      ]);
      // market rate: a launch Core has no price reading for yet is pending (no minimum to show); it is judged at its next reading
      if (p?.checked && !p.pending) {
        put(html`<span data-prepay-core="${p.ok ? "ok" : "short"}">Core: deposit ${units(BigInt(p.deposit), decimals)} ${usym()}, minimum ${units(BigInt(p.min), decimals)}, ${p.ok ? html`<span class="mark good">meets the minimum</span>` : html`<span class="mark warn">below the minimum (asleep in Core until the vault holds it)</span>`}; refresh_awake ${p.woke_in_launch_tx ? "in" : "not in"} the launch transaction; awake in Core: <b data-core-awake="${String(!!a?.awake)}">${a?.awake ? "yes" : "no"}</b>.</span>`);
        return;
      }
      put(html`<span class="dim">Waiting for Core's chain sync to read the launch transaction (${i + 1})…</span>`);
    } catch {
      put(html`<span class="dim">Core is not answering; its check is TBA.</span>`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  put(html`<span class="dim">Core has not recorded the deposit yet; look again on the agent's page.</span>`);
}
