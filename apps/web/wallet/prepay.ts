// Prepaid credits at launch (plan C, owner decision 2026-10-09): the deposit step of the launch form.
// The launch transaction carries launch_agent, a UNITS deposit into the new compute vault and
// refresh_awake, so the agent wakes at once. Every figure here comes from Core's network config
// (`prepay`: minimum, default, the TEST dollar rate, the runtime's published compute prices) or from
// chain (wake_threshold, the wallet's UNITS, the frozen lookup table a v0 launch reads); none is
// invented. lineage_launch does not enforce the minimum, so this form refuses a smaller deposit and
// Core keeps an underfunded agent asleep (packages/core/src/prepay.ts).
// Owner direction 2026-10-11: the credits are typed in USD (at least Core's min_usd, more allowed) on
// every network, converted at prepay.line_per_usd, and paid in SOL with the launch (fronting.ts).
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

export const P = {
  cfg: null as PrepayConfig | null,
  err: null as string | null,
  /** the frozen launch lookup table, checked against launchTableAddresses; null when absent or wrong */
  table: null as LookupTable | null,
  tableNote: "" as string,
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
  return `${depositUsd(typed)} USD`;
}

/** The credits in USD as typed (empty: Core's minimum). The launcher may enter more than the minimum. */
export function depositUsd(typed: string): string {
  return typed.trim() || P.cfg?.min_usd || "";
}

/** Validates the typed credits; returns the $UNITS base units the vault receives, or throws a message for the form. */
export function depositBase(typed: string, decimals: number): bigint {
  if (!P.cfg) throw new Error(`Model credits: Core's prepay config is not available (${P.err ?? "not loaded"}); a launch needs it for the minimum and the rate.`);
  const usd = depositUsd(typed);
  if (!/^\d+(\.\d{1,2})?$/.test(usd)) throw new Error("Model credits: a dollar amount such as 10 or 12.50.");
  if (cmpDec(usd, P.cfg.min_usd) < 0) throw new Error(`Model credits: at least ${P.cfg.min_usd} USD.`);
  return usdToBase(usd, P.cfg.line_per_usd, decimals);
}

/** The one help line under the credits input. */
export function prepayHelp(typed: string, o: { decimals: number }): Raw {
  if (!P.cfg) return html`<span class="mark warn">Launch disabled: Core's credits config is not available.</span>`;
  try {
    depositBase(typed, o.decimals);
  } catch (e) {
    return html`<span class="mark warn">${(e as Error).message}</span>`;
  }
  return html`At least ${P.cfg.min_usd} USD; you can add more. Paid in SOL with the launch.`;
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
      if (p?.checked) {
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
