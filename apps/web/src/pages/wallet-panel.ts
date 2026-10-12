import { get } from "../api.ts";
import { ago } from "../fmt.ts";
import { html, type Raw } from "../html.ts";
import { explorerAddr, market, QUOTE, shortAddr, type TokenSummary } from "../market.ts";
import { icon, panel } from "../ui.ts";

// Agent wallets on the social pages (docs/plans/AGENT-WALLET-SAFETY.md section 2). An agent's wallet
// is its treasury: the key its hosted runtime holds, which is its registry signing key. The compute
// vault is a separate address no key signs for. Core serves both and what they hold, read from chain
// (GET /v1/agents/:id/wallet); symbols come from the market indexer. Every figure is that reading:
// when it is missing the panel says so and why, and never shows a zero in its place.
//
// Mounted with one line each: walletPanel on the agent profile and the token page, walletSlot in a
// feed card (filled from GET /v1/wallets once per page, addresses only).

interface Holding { mint: string; agent: string; amount: string; decimals: number | null; own: boolean }
interface Wallet {
  agent: string;
  chain: boolean;
  network: string | null;
  read_at: number | null;
  slot: number | null;
  treasury: { address: string | null; is_agent_id: boolean; sol_lamports: string | null; quote: { mint: string; symbol: string | null; decimals: number | null; amount: string | null } | null; holdings: Holding[] | null };
  compute_vault: { address: string; amount: string | null } | null;
  error: string | null;
}

/** Base units to a figure with its exact value kept in `title`. At most 4 decimals shown, never rounded up to a different whole. */
function amount(base: string | null | undefined, decimals: number, unit: string): Raw {
  if (base === null || base === undefined) return html`<span class="wl-na">unavailable</span>`;
  const neg = base.startsWith("-");
  const digits = (neg ? base.slice(1) : base).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals ? digits.slice(digits.length - decimals) : "";
  const exact = `${neg ? "-" : ""}${BigInt(whole).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
  const shown = `${neg ? "-" : ""}${BigInt(whole).toLocaleString("en-US")}${frac && Number(`0.${frac}`) > 0 ? `.${frac.slice(0, 4).replace(/0+$/, "") || "0"}` : ""}`;
  return html`<span class="wl-fig" title="${exact} ${unit}" data-base="${base}"><b>${shown}</b></span>`;
}

function addressRow(label: string, hint: string, a: string | null, attr: string): Raw {
  if (!a) return html`<div class="wl-addr"><div class="wl-lab">${label}<span>${hint}</span></div><div class="wl-na">none: the signing key is revoked</div></div>`;
  return html`<div class="wl-addr" ${attr}="${a}">
    <div class="wl-lab">${label}<span>${hint}</span></div>
    <div class="wl-line"><span class="wl-full" title="${a}">${a}</span>
      <button type="button" class="wl-btn-s" data-copy="${a}" aria-label="Copy the ${label.toLowerCase()} address">Copy</button>
      <a class="wl-btn-s" href="${explorerAddr(a)}" target="_blank" rel="noopener" aria-label="Open the ${label.toLowerCase()} address in the explorer">Explorer ${icon.ext}</a></div>
  </div>`;
}

/** The Wallet panel of an agent. Never throws: when Core cannot be read the panel is left out. */
export async function walletPanel(agent: string): Promise<Raw> {
  const w = await get<Wallet>(`agents/${agent}/wallet`).catch(() => null);
  if (!w) return html``;
  ensureCss();
  const tokens = w.treasury.holdings?.length ? await market<{ tokens: TokenSummary[] }>("tokens?limit=500&hidden=1").then((r) => new Map(r.tokens.map((t) => [t.mint, t])), () => new Map<string, TokenSummary>()) : new Map<string, TokenSummary>();
  const q = w.treasury.quote;
  const unit = q?.symbol ?? QUOTE;
  const dec = q?.decimals ?? 6;
  const rows: Raw[] = [];
  if (w.chain) {
    rows.push(html`<li><span>SOL <em>for network fees</em></span>${amount(w.treasury.sol_lamports, 9, "SOL")}</li>`);
    rows.push(html`<li><span>${unit}</span>${amount(q?.amount, dec, unit)}</li>`);
    for (const h of w.treasury.holdings ?? []) {
      const t = tokens.get(h.mint);
      const sym = t?.symbol ? `$${t.symbol}` : shortAddr(h.mint);
      rows.push(html`<li data-holding="${h.mint}"><span><a class="link" href="/tokens/${h.mint}">${sym}</a> ${h.own ? html`<em>own token, held by the agent</em>` : html`<em>agent token</em>`}</span>${h.decimals === null ? amount(h.amount, 0, "base units") : amount(h.amount, h.decimals, sym)}</li>`);
    }
    if (w.treasury.holdings && !w.treasury.holdings.length) rows.push(html`<li class="wl-none"><span>Agent tokens</span><span class="wl-na">none held</span></li>`);
  }
  const read = w.read_at ? html`Read from chain <span data-ago="${w.read_at}">${ago(w.read_at)}</span> at slot ${w.slot?.toLocaleString("en-US") ?? "unknown"}${w.network ? `, ${w.network}` : ""}.` : w.chain ? html`Balances unavailable: ${w.error ?? "no reading"}.` : html`This Core runs without a chain: addresses only.`;
  const body = html`<div class="wl" data-wallet="${agent}">
    ${addressRow("Treasury", w.treasury.is_agent_id ? "the agent's own key" : "held by the hosted runtime; it can swap agent tokens and nothing else", w.treasury.address, "data-treasury")}
    ${rows.length ? html`<ul class="wl-bal">${rows}</ul>` : ""}
    ${w.compute_vault ? html`${addressRow("Compute vault", "pays the agent's model and sandbox; no key signs for it", w.compute_vault.address, "data-vault")}
      ${w.chain ? html`<ul class="wl-bal"><li><span>${unit}</span>${amount(w.compute_vault.amount, dec, unit)}</li></ul>` : ""}` : ""}
  </div>`;
  return panel("Wallet", body, { cls: "wl-panel", note: html`${read} The treasury can buy and sell agent tokens and nothing else: it cannot send funds to another wallet. Only the agent's owner can withdraw the compute vault.` });
}

// ------------------------------------------------------------------------------------------------
// the chip in feed and social cards

let all: Promise<Record<string, { treasury: string | null }>> | null = null;
let allAt = 0;
function wallets(): Promise<Record<string, { treasury: string | null }>> {
  if (!all || Date.now() - allAt > 60_000) {
    allAt = Date.now();
    all = get<{ wallets: Record<string, { treasury: string | null }> }>("wallets").then((r) => r.wallets, () => ({}));
  }
  return all;
}

async function fill(root: ParentNode) {
  const slots = [...root.querySelectorAll<HTMLElement>("[data-wallet-of]:not([data-filled])")];
  if (!slots.length) return;
  for (const s of slots) s.dataset.filled = "1";
  const map = await wallets();
  for (const s of slots) {
    const a = map[s.dataset.walletOf!]?.treasury;
    if (!a) continue;
    s.innerHTML = html`<button type="button" class="wl-chip" data-copy="${a}" title="Copy the agent's wallet address ${a}" aria-label="Copy the agent's wallet address">${shortAddr(a)}</button>`.s;
  }
}

let watching = false;
/** A place for the agent's wallet chip (short address, copies on click); filled once the page shows it. */
export function walletSlot(agent: string | null | undefined): Raw {
  if (!agent) return html``;
  if (!watching && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    watching = true;
    ensureCss();
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => ((queued = false), void fill(document)));
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  return html`<span class="wl-slot" data-wallet-of="${agent}"></span>`;
}

// ------------------------------------------------------------------------------------------------
// styles: injected once, on the app's own tokens (no new colours, no monospace)

const CSS = `
.wl{display:grid;grid-template-columns:minmax(0,1fr);min-width:0}
.wl-panel{min-width:0}
.wl-addr{padding:12px 16px 10px;display:grid;gap:7px;min-width:0}
.wl-addr+.wl-bal{border-top:0}
.wl-bal+.wl-addr{border-top:1px solid var(--border)}
.wl-lab{font:500 12.5px/1.3 var(--sans);letter-spacing:-.01em;color:var(--tp);display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline}
.wl-lab span{font-weight:400;font-size:12px;color:var(--tt)}
.wl-line{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.wl-full{flex:1 1 100%;min-width:0;box-sizing:border-box;font:500 12.5px/1.45 var(--sans);font-variant-numeric:tabular-nums;letter-spacing:.005em;color:var(--ts);background:var(--bg3);border-radius:10px;padding:7px 10px;overflow-wrap:anywhere;word-break:break-all;user-select:all}
.wl-btn-s{flex:none;display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;border:0;border-radius:10px;background:var(--bg3);color:var(--ts);font:500 12px/1 var(--sans);cursor:pointer;text-decoration:none;white-space:nowrap}
.wl-btn-s:hover{background:var(--pill-hover);color:var(--tp);text-decoration:none}
.wl-btn-s:focus-visible,.wl-chip:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.wl-btn-s svg{width:11px;height:11px}
.wl-bal{list-style:none;margin:0;padding:0 16px 6px}
.wl-bal li{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:8px 0;border-top:1px solid var(--border);min-width:0;font-size:12.5px;color:var(--ts)}
.wl-bal li>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wl-bal em{font-style:normal;color:var(--tt);font-size:12px;margin-left:4px}
.wl-fig{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}
.wl-fig b{font-family:var(--display);font-weight:500;font-size:14px;letter-spacing:-.02em;color:var(--tp)}
.wl-na{color:var(--tt);font-size:12.5px}
.wl-slot{display:inline-flex;vertical-align:1px;margin-left:6px}
.wl-slot:empty{display:none}
.wl-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border:0;border-radius:7px;background:var(--bg3);color:var(--tt);font:500 11px/1 var(--sans);font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap}
.wl-chip:hover{background:var(--pill-hover);color:var(--tp)}
`;
let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const s = document.createElement("style");
  s.dataset.wl = "1";
  s.textContent = CSS;
  document.head.appendChild(s);
}
