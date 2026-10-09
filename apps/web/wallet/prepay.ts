// Prepaid credits at launch (plan C, owner decision 2026-10-09): the deposit step of the launch form.
// The launch transaction carries launch_agent, a tLINE deposit into the new compute vault and
// refresh_awake, so the agent wakes at once. Every figure here comes from Core's network config
// (`prepay`: minimum, default, the TEST dollar rate, the runtime's published compute prices) or from
// chain (wake_threshold, the wallet's tLINE, the frozen lookup table a v0 launch reads); none is
// invented. lineage_launch does not enforce the minimum, so this form refuses a smaller deposit and
// Core keeps an underfunded agent asleep (packages/core/src/prepay.ts).
import {
  baseToUsdCents,
  cmpDec,
  decodeLookupTable,
  firstRunBudget,
  launchTableAddresses,
  parsePrepayConfig,
  usdToBase,
  type LookupTable,
  type PrepayConfig,
} from "../../../packages/chain/src/browser/index.ts";
import { html, type Raw } from "../src/html.ts";
import { badge } from "../src/ui.ts";
import { rpc, units } from "./chain.ts";

export const P = {
  cfg: null as PrepayConfig | null,
  err: null as string | null,
  /** the frozen launch lookup table, checked against launchTableAddresses; null when absent or wrong */
  table: null as LookupTable | null,
  tableNote: "" as string,
};

/** Reads Core's prepay config and the launch lookup table (devnet.json `launch_lookup_table`), checking the table is frozen with the expected content. */
export async function loadPrepay(state: { line_mint: string; dbc_config: string; line_token_program: string; launch_lookup_table?: unknown }) {
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
    const want = launchTableAddresses({ lineMint: state.line_mint, dbcConfig: state.dbc_config, lineTokenProgram: state.line_token_program });
    if (t.authority !== null) throw new Error("not frozen");
    if (t.addresses.length !== want.length || t.addresses.some((a, i) => a !== want[i])) throw new Error("content differs from the expected launch accounts");
    P.table = { address: at, addresses: t.addresses };
    P.tableNote = "";
  } catch (e) {
    P.tableNote = `lookup table ${at} refused: ${(e as Error).message}`;
  }
}

export function prepayFieldset(): Raw {
  return html`<fieldset><legend class="eyebrow">Prepaid credits (plan C)</legend>
      <label><span class="eyebrow">Deposit (USD)</span><input name="l_deposit" inputmode="decimal" autocomplete="off" placeholder="10"><span class="wl-help" id="w-prepay">Reading the prepay config from Core…</span></label>
    </fieldset>`;
}

/** The USD typed in the form, or the default when empty. */
export function depositUsd(typed: string): string {
  const t = typed.trim().replace(/^\$/, "");
  return t === "" ? (P.cfg?.default_usd ?? "") : t;
}

/** Validates the typed deposit; returns its base units or throws a message for the form. */
export function depositBase(typed: string, decimals: number): bigint {
  if (!P.cfg) throw new Error(`Prepaid credits: Core's prepay config is not available (${P.err ?? "not loaded"}); a launch needs it for the minimum and the rate.`);
  const usd = depositUsd(typed);
  if (!/^\d+(\.\d{1,2})?$/.test(usd)) throw new Error("Deposit: a dollar amount such as 10 or 12.50.");
  if (cmpDec(usd, P.cfg.min_usd) < 0) throw new Error(`Deposit: at least ${P.cfg.min_usd} USD (prepay.min_usd in Core's config).`);
  return usdToBase(usd, P.cfg.line_per_usd, decimals);
}

/** The help line under the deposit input: amount, rate, first-run budget, and the checks that matter. */
export function prepayHelp(typed: string, o: { decimals: number; wake: bigint | null; balance: bigint | null }): Raw {
  if (!P.cfg) return html`<span class="mark warn">Prepay config TBA: ${P.err ?? "not loaded"}. Launch is disabled until Core answers.</span>`;
  const c = P.cfg;
  const rate = html`${c.line_per_usd} tLINE per USD ${c.rate_status === "test" ? badge("TEST rate", "warn") : ""}`;
  let amount: bigint;
  try {
    amount = depositBase(typed, o.decimals);
  } catch (e) {
    return html`<span class="mark warn">${(e as Error).message}</span> Rate ${rate}; minimum ${c.min_usd} USD.`;
  }
  const b = firstRunBudget(c, amount, o.decimals);
  const cents = baseToUsdCents(amount, c.line_per_usd, o.decimals);
  return html`<b class="num">${units(amount, o.decimals)}</b> tLINE (${(Number(cents) / 100).toFixed(2)} USD at ${rate}) into the agent's compute vault in the launch transaction; minimum ${c.min_usd} USD, editable upward.
    First-run budget at the runtime's published prices (${c.compute_price_line_per_usd} tLINE per USD of model spend, ${c.compute_price_line_per_sandbox_s} per sandbox second, ${c.sandbox_reserve_s} s held back): <b class="num">${b.usd.toFixed(2)}</b> USD of model spend, ${b.attempts} attempts at the ${c.attempt_max_usd} USD per-attempt cap.
    ${o.wake !== null ? (amount >= o.wake ? html`<span class="mark good">wakes at once (wake_threshold ${units(o.wake, o.decimals)} tLINE)</span>` : html`<span class="mark warn">below wake_threshold ${units(o.wake, o.decimals)} tLINE: the agent would stay asleep</span>`) : ""}
    ${o.balance !== null && o.balance < amount ? html`<span class="mark warn">your wallet holds ${units(o.balance, o.decimals)} tLINE</span>` : ""}`;
}

/** After a launch: waits for Core's chain sync to record the deposit, then shows Core's check and its awake flag. */
export async function showCorePrepay(agent: string, decimals: number, put: (r: Raw) => void, tries = 36, everyMs = 5000) {
  for (let i = 0; i < tries; i++) {
    try {
      const [p, a] = await Promise.all([
        fetch(`/api/agents/${agent}/prepay`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/agents/${agent}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (p?.checked) {
        put(html`<span data-prepay-core="${p.ok ? "ok" : "short"}">Core: deposit ${units(BigInt(p.deposit), decimals)} tLINE, minimum ${units(BigInt(p.min), decimals)}, ${p.ok ? html`<span class="mark good">meets the minimum</span>` : html`<span class="mark warn">below the minimum (asleep in Core until the vault holds it)</span>`}; refresh_awake ${p.woke_in_launch_tx ? "in" : "not in"} the launch transaction; awake in Core: <b data-core-awake="${String(!!a?.awake)}">${a?.awake ? "yes" : "no"}</b>.</span>`);
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
